//! `tauri-plugin-mpv`
//!
//! Decoupled libmpv playback bridge for Entei. libmpv is **not** linked at
//! build time: it is resolved and opened at runtime through [`libloading`], so
//! a machine without mpv still starts the app and every command reports an
//! explicit error instead of aborting the process.
//!
//! Six commands are exposed:
//!
//! - `mpv_load(url)`          -> `loadfile <url> replace`
//! - `mpv_play()`             -> sets `pause = no`
//! - `mpv_pause()`            -> sets `pause = yes`
//! - `mpv_seek(seconds)`      -> `seek <seconds> absolute`
//! - `mpv_set_sub_delay(sec)` -> sets `sub-delay = <seconds>`
//! - `mpv_set_tracks(aid, sid)` -> sets `aid` / `sid` when provided
//!
//! Resolution order for the shared library is `EIZOUDEN_MPV_PATH`, then the
//! Tauri resource directory (`resources/windows/libmpv-2.dll`, then
//! `resources/libmpv-2.dll`), then next to the executable, then the platform
//! loader search path (bare library name).
//!
//! The player UI stays 100% Entei's: mpv is initialized headless (`vo = null`,
//! `ao = null`, `pause = yes`, `osc = no`, `osd-level = 0`), so mpv never opens
//! its own OS window, never makes sound and never paints its own controller on
//! top of the webview-driven HTML/CSS controls.
//!
//! Note: the mpv instance is created lazily on the first command and kept for
//! the lifetime of the process. A failed lookup is not cached, so dropping the
//! library next to the executable and retrying works without a restart.

use std::ffi::{c_char, c_int, c_void, CStr, CString};
use std::path::PathBuf;
use std::sync::{Arc, Mutex, OnceLock};

use libloading::Library;
use tauri::plugin::{Builder, TauriPlugin};
use tauri::{Manager, Runtime};

/// Opaque `mpv_handle *`.
type MpvHandle = *mut c_void;

type MpvCreate = unsafe extern "C" fn() -> MpvHandle;
type MpvInitialize = unsafe extern "C" fn(MpvHandle) -> c_int;
type MpvCommand = unsafe extern "C" fn(MpvHandle, *const *const c_char) -> c_int;
type MpvCommandString = unsafe extern "C" fn(MpvHandle, *const c_char) -> c_int;
type MpvSetString = unsafe extern "C" fn(MpvHandle, *const c_char, *const c_char) -> c_int;
type MpvGetPropertyString = unsafe extern "C" fn(MpvHandle, *const c_char) -> *mut c_char;
type MpvFree = unsafe extern "C" fn(*mut c_void);
type MpvTerminateDestroy = unsafe extern "C" fn(MpvHandle);
/// `const char *mpv_error_string(int error)`. The returned string is owned by
/// libmpv (static storage), so it is never freed here.
type MpvErrorString = unsafe extern "C" fn(c_int) -> *const c_char;

/// Shared library file names tried on each candidate directory.
#[cfg(windows)]
const LIB_NAMES: &[&str] = &["libmpv-2.dll"];
/// On Linux/Android the runtime package usually ships only the versioned
/// soname, so the plain `.so` dev symlink is tried first but not required.
#[cfg(not(windows))]
const LIB_NAMES: &[&str] = &["libmpv.so", "libmpv.so.2", "libmpv.so.1"];

/// mpv options applied once, right after `mpv_create` and before
/// `mpv_initialize`.
///
/// Entei's HTML/CSS player is the only surface that is allowed to be visible or
/// audible. mpv is a **headless** engine here: it holds the media, scans the
/// container and answers track/duration queries, but it must never open its own
/// window or make sound.
///
/// - `vo = null` / `ao = null`: no video output window and no audio output. A
///   real VO made mpv open a second, independent OS window that played the
///   video (and its audio) in parallel with the `<video>` element — the
///   "two windows / doubled audio" symptom.
/// - `pause = yes`: the engine starts held. `loadfile … replace` otherwise
///   starts its own clock immediately, so it would advance on its own while the
///   user has not pressed Play yet.
/// - `osc = no` / `osd-level = 0`: mpv must never paint its own controller or
///   OSD; Entei's HTML/CSS UI is the only control surface.
/// - `alang` / `slang`: prefer Japanese audio and subtitle tracks automatically.
/// - `idle = yes`: keep the playloop alive between files, so a second
///   `mpv_load` after the previous media reached EOF still starts playback.
const BASE_OPTIONS: &[(&str, &str)] = &[
    ("osc", "no"),
    ("osd-level", "0"),
    ("vo", "null"),
    ("ao", "null"),
    ("pause", "yes"),
    ("alang", "ja,jpn"),
    ("slang", "ja,jpn"),
    ("idle", "yes"),
];

/// Options that keep the engine invisible and silent. Unlike the remaining
/// `BASE_OPTIONS`, a rejection here is fatal for the plugin's contract:
/// silently tolerating it would put mpv's own window (and audio) back on top of
/// Entei's player.
///
/// `pause` is deliberately *not* listed: its real guarantee is the
/// `set_property("pause", "yes")` asserted on the live handle after
/// `mpv_initialize` (and again after every `loadfile`), so a build that rejects
/// the start-time option must not take the whole engine down.
fn is_contract_option(name: &str) -> bool {
    matches!(name, "osc" | "osd-level" | "vo" | "ao")
}

/// Tauri bundle resource directory, resolved while the plugin initializes.
///
/// Mirrors the `resources/windows/*` entry in `tauri.windows.conf.json`, the
/// same layout the yt-dlp plugin uses for its bundled binary.
static RESOURCE_DIR: OnceLock<PathBuf> = OnceLock::new();

/// Lazily created singleton instance. `None` means "not created yet" or "the
/// last creation attempt failed" (the error is returned, never cached).
static INSTANCE: OnceLock<Mutex<Option<Arc<MpvInstance>>>> = OnceLock::new();

#[derive(Debug, thiserror::Error)]
pub enum MpvError {
    #[error("libmpv library not found (set EIZOUDEN_MPV_PATH or ship {names})")]
    LibraryNotFound { names: String },
    #[error("libmpv is missing the required symbol `{0}`")]
    MissingSymbol(String),
    #[error("libmpv could not be opened: {0}")]
    LibraryLoad(String),
    #[error("mpv {op} failed: {detail}")]
    Command { op: String, detail: String },
    #[error("invalid argument: {0}")]
    Invalid(String),
}

impl MpvError {
    fn message(&self) -> String {
        self.to_string()
    }
}

/// Human readable text for an `mpv_error` code, resolved through libmpv's own
/// `mpv_error_string` so the wording always matches the loaded build instead of
/// a hand-maintained table that can drift from the C API.
fn error_text(error_string: MpvErrorString, code: c_int) -> String {
    // Safety: `error_string` was bound from `mpv_error_string`, which returns a
    // NUL-terminated string with static storage duration (never freed by us).
    let ptr = unsafe { error_string(code) };
    if ptr.is_null() {
        return format!("unknown error ({code})");
    }
    // Safety: non-null NUL-terminated C string as documented by libmpv.
    let text = unsafe { CStr::from_ptr(ptr) }
        .to_string_lossy()
        .into_owned();
    if text.is_empty() {
        format!("unknown error ({code})")
    } else {
        text
    }
}

fn check_rc(error_string: MpvErrorString, op: &str, code: c_int) -> Result<(), MpvError> {
    if code < 0 {
        return Err(MpvError::Command {
            op: op.to_string(),
            detail: format!("{} ({code})", error_text(error_string, code)),
        });
    }
    Ok(())
}

/// One loaded libmpv plus the C entry points the plugin uses.
struct MpvInstance {
    /// Kept alive for as long as any symbol pointer below is called.
    _library: Library,
    handle: MpvHandle,
    command: MpvCommand,
    command_string: MpvCommandString,
    set_option_string: MpvSetString,
    set_property_string: MpvSetString,
    /// `mpv_error_string`, used to turn every negative return code into the
    /// message libmpv itself would print.
    error_string: MpvErrorString,
    /// Bound as part of the required C surface. No command reads a property
    /// back yet, so it stays unused until a state read is actually needed.
    #[allow(dead_code)]
    get_property_string: MpvGetPropertyString,
    /// Paired with `get_property_string` for the same reason.
    #[allow(dead_code)]
    free: MpvFree,
    terminate_destroy: MpvTerminateDestroy,
}

// Safety: the mpv client API is documented as thread-safe for the calls used
// here (`mpv_command*`, `mpv_set_*`) on a single `mpv_handle`; the handle is
// only ever touched through `&self`, and libloading `Library` is Send + Sync.
unsafe impl Send for MpvInstance {}
unsafe impl Sync for MpvInstance {}

impl Drop for MpvInstance {
    fn drop(&mut self) {
        // A null handle means `mpv_create` already failed; terminating it
        // would be undefined behaviour.
        if self.handle.is_null() {
            return;
        }
        // Safety: `handle` came from `mpv_create` and is terminated exactly
        // once, here.
        unsafe { (self.terminate_destroy)(self.handle) };
    }
}

/// Candidate locations for the shared library, most specific first.
fn library_candidates() -> Vec<PathBuf> {
    let mut candidates: Vec<PathBuf> = Vec::new();

    if let Ok(raw) = std::env::var("EIZOUDEN_MPV_PATH") {
        let trimmed = raw.trim();
        if !trimmed.is_empty() {
            candidates.push(PathBuf::from(trimmed));
        }
    }

    for name in LIB_NAMES {
        if let Some(dir) = RESOURCE_DIR.get() {
            candidates.push(dir.join("windows").join(name));
            candidates.push(dir.join(name));
        }
        if let Ok(exe) = std::env::current_exe() {
            if let Some(dir) = exe.parent() {
                candidates.push(dir.join(name));
                candidates.push(dir.join("resources").join(name));
                candidates.push(dir.join("resources").join("windows").join(name));
            }
        }
        #[cfg(debug_assertions)]
        {
            // `tauri dev` runs with the working directory set to `src-tauri`.
            candidates.push(
                PathBuf::from("src-tauri")
                    .join("resources")
                    .join("windows")
                    .join(name),
            );
            candidates.push(PathBuf::from("resources").join("windows").join(name));
        }
        // Bare file name: let the OS loader search PATH / its default paths.
        candidates.push(PathBuf::from(name));
    }

    candidates
}

fn load_library() -> Result<Library, MpvError> {
    let mut last_error: Option<String> = None;
    for path in library_candidates() {
        // Safety: opening a shared library runs its initializers. libmpv is
        // the expected payload of the resolved path.
        match unsafe { Library::new(&path) } {
            Ok(library) => return Ok(library),
            Err(err) => last_error = Some(format!("{}: {err}", path.display())),
        }
    }
    Err(MpvError::LibraryNotFound {
        names: format!(
            "{}{}",
            LIB_NAMES.join(" / "),
            last_error
                .map(|err| format!(" (last attempt {err})"))
                .unwrap_or_default()
        ),
    })
}

/// Bind one symbol from the library, keeping the C type at the call site.
unsafe fn load_symbol<T: Copy>(library: &Library, name: &[u8]) -> Result<T, MpvError> {
    let symbol = library.get::<T>(name).map_err(|_| {
        MpvError::MissingSymbol(
            String::from_utf8_lossy(name)
                .trim_end_matches('\0')
                .to_string(),
        )
    })?;
    Ok(*symbol)
}

fn c_string(value: &str, what: &str) -> Result<CString, MpvError> {
    CString::new(value).map_err(|_| MpvError::Invalid(format!("{what} contains a NUL byte")))
}

impl MpvInstance {
    fn create() -> Result<Self, MpvError> {
        let library = load_library()?;

        // Safety: symbol signatures mirror `client.h`.
        let (create, initialize): (MpvCreate, MpvInitialize) = unsafe {
            (
                load_symbol(&library, b"mpv_create\0")?,
                load_symbol(&library, b"mpv_initialize\0")?,
            )
        };
        let instance = unsafe {
            Self {
                command: load_symbol(&library, b"mpv_command\0")?,
                command_string: load_symbol(&library, b"mpv_command_string\0")?,
                set_option_string: load_symbol(&library, b"mpv_set_option_string\0")?,
                set_property_string: load_symbol(&library, b"mpv_set_property_string\0")?,
                error_string: load_symbol(&library, b"mpv_error_string\0")?,
                get_property_string: load_symbol(&library, b"mpv_get_property_string\0")?,
                free: load_symbol(&library, b"mpv_free\0")?,
                terminate_destroy: load_symbol(&library, b"mpv_terminate_destroy\0")?,
                handle: create(),
                _library: library,
            }
        };

        if instance.handle.is_null() {
            return Err(MpvError::Command {
                op: "mpv_create".to_string(),
                detail: "returned a null handle".to_string(),
            });
        }

        // Options must land before `mpv_initialize`; a rejected option is not
        // fatal (mpv may lack that backend) but a failed initialize is.
        // `apply_options` failing means mpv would draw its own UI over Entei's
        // controls, so that one is propagated instead of ignored.
        instance.apply_options()?;
        // Safety: `handle` is a live handle from `mpv_create`.
        check_rc(instance.error_string, "mpv_initialize", unsafe {
            initialize(instance.handle)
        })?;
        // `pause` is a property as well as a start option, so it is asserted a
        // second time on the live handle: the engine must never begin playing
        // on its own, whatever the option layer did with the start value.
        instance.set_property("pause", "yes")?;
        Ok(instance)
    }

    fn apply_options(&self) -> Result<(), MpvError> {
        for (name, value) in BASE_OPTIONS {
            match self.set_option(name, value) {
                Ok(()) => {}
                // `vo` / `ao` / `osc` / `osd-level` are the contract that mpv
                // stays invisible and silent, so a rejection is reported
                // instead of silently tolerated.
                Err(err) if is_contract_option(name) => return Err(err),
                // Best effort: an unsupported option must not stop playback.
                Err(err) => eprintln!("tauri-plugin-mpv: optional option {name} rejected: {err}"),
            }
        }
        Ok(())
    }

    fn command(&self, args: &[&str]) -> Result<(), MpvError> {
        let owned = args
            .iter()
            .map(|arg| c_string(arg, "command argument"))
            .collect::<Result<Vec<_>, _>>()?;
        let mut pointers: Vec<*const c_char> = owned.iter().map(|arg| arg.as_ptr()).collect();
        pointers.push(std::ptr::null());
        // Safety: `pointers` is NULL-terminated and outlives the call.
        let code = unsafe { (self.command)(self.handle, pointers.as_ptr()) };
        check_rc(
            self.error_string,
            args.first().copied().unwrap_or("mpv_command"),
            code,
        )
    }

    fn command_string(&self, command: &str) -> Result<(), MpvError> {
        let command = c_string(command, "command string")?;
        // Safety: NUL-terminated string outlives the call.
        let code = unsafe { (self.command_string)(self.handle, command.as_ptr()) };
        check_rc(self.error_string, "mpv_command_string", code)
    }

    fn set_option(&self, name: &str, value: &str) -> Result<(), MpvError> {
        let name_c = c_string(name, "option name")?;
        let value_c = c_string(value, "option value")?;
        // Safety: both strings are NUL-terminated and outlive the call.
        let code =
            unsafe { (self.set_option_string)(self.handle, name_c.as_ptr(), value_c.as_ptr()) };
        check_rc(self.error_string, name, code)
    }

    fn set_property(&self, name: &str, value: &str) -> Result<(), MpvError> {
        let name_c = c_string(name, "property name")?;
        let value_c = c_string(value, "property value")?;
        // Safety: both strings are NUL-terminated and outlive the call.
        let code =
            unsafe { (self.set_property_string)(self.handle, name_c.as_ptr(), value_c.as_ptr()) };
        check_rc(self.error_string, name, code)
    }
}

/// The process-wide instance, created on first use.
fn instance() -> Result<Arc<MpvInstance>, MpvError> {
    let slot = INSTANCE.get_or_init(|| Mutex::new(None));
    let mut guard = slot.lock().map_err(|_| MpvError::Command {
        op: "instance lock".to_string(),
        detail: "mutex poisoned by an earlier panic".to_string(),
    })?;
    if let Some(existing) = guard.as_ref() {
        return Ok(Arc::clone(existing));
    }
    let created = Arc::new(MpvInstance::create()?);
    *guard = Some(Arc::clone(&created));
    Ok(created)
}

fn require_finite(seconds: f64, what: &str) -> Result<f64, MpvError> {
    if !seconds.is_finite() {
        return Err(MpvError::Invalid(format!("{what} must be a finite number")));
    }
    Ok(seconds)
}

#[tauri::command]
fn mpv_load(url: String) -> Result<(), String> {
    let url = url.trim();
    if url.is_empty() {
        return Err(MpvError::Invalid("empty url".to_string()).message());
    }
    let instance = instance().map_err(|err| err.message())?;
    instance
        .command(&["loadfile", url, "replace"])
        .map_err(|err| err.message())?;
    // Hold the freshly loaded file. `loadfile` starts the engine's own clock, so
    // the pause is re-asserted here instead of relying on the load not having
    // touched it.
    instance
        .set_property("pause", "yes")
        .map_err(|err| err.message())
}

#[tauri::command]
fn mpv_play() -> Result<(), String> {
    let instance = instance().map_err(|err| err.message())?;
    instance
        .set_property("pause", "no")
        .map_err(|err| err.message())
}

#[tauri::command]
fn mpv_pause() -> Result<(), String> {
    let instance = instance().map_err(|err| err.message())?;
    instance
        .set_property("pause", "yes")
        .map_err(|err| err.message())
}

#[tauri::command]
fn mpv_seek(seconds: f64) -> Result<(), String> {
    let seconds = require_finite(seconds, "seek target").map_err(|err| err.message())?;
    let instance = instance().map_err(|err| err.message())?;
    // The value is formatted here, so no quoting of user input reaches mpv.
    instance
        .command_string(&format!("seek {seconds:.3} absolute"))
        .map_err(|err| err.message())
}

#[tauri::command]
fn mpv_set_sub_delay(seconds: f64) -> Result<(), String> {
    let seconds = require_finite(seconds, "sub-delay").map_err(|err| err.message())?;
    let instance = instance().map_err(|err| err.message())?;
    instance
        .set_property("sub-delay", &format!("{seconds:.3}"))
        .map_err(|err| err.message())
}

#[tauri::command]
fn mpv_set_tracks(aid: Option<String>, sid: Option<String>) -> Result<(), String> {
    let instance = instance().map_err(|err| err.message())?;
    for (property, value) in [("aid", aid), ("sid", sid)] {
        let Some(value) = value else { continue };
        let value = value.trim();
        // An empty string means "leave the current track alone"; `no` is what
        // mpv itself uses to disable a track.
        if value.is_empty() {
            continue;
        }
        instance
            .set_property(property, value)
            .map_err(|err| err.message())?;
    }
    Ok(())
}

pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("mpv")
        .setup(|app, _api| {
            // Resolve the bundle resource directory once so library discovery
            // can stay synchronous. Failure is not fatal: the executable-local
            // and loader-path fallbacks still apply.
            if let Ok(dir) = app
                .path()
                .resolve("resources", tauri::path::BaseDirectory::Resource)
            {
                let _ = RESOURCE_DIR.set(dir);
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            mpv_load,
            mpv_play,
            mpv_pause,
            mpv_seek,
            mpv_set_sub_delay,
            mpv_set_tracks
        ])
        .build()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Stand-in for libmpv's `mpv_error_string`, so the mapping can be tested
    /// without loading a real library.
    unsafe extern "C" fn stub_error_string(code: c_int) -> *const c_char {
        static SUCCESS: &[u8] = b"success\0";
        static COMMAND_FAILED: &[u8] = b"command failed\0";
        static UNKNOWN: &[u8] = b"unknown error\0";
        match code {
            0 => SUCCESS.as_ptr().cast(),
            -13 => COMMAND_FAILED.as_ptr().cast(),
            _ => UNKNOWN.as_ptr().cast(),
        }
    }

    unsafe extern "C" fn null_error_string(_code: c_int) -> *const c_char {
        std::ptr::null()
    }

    #[test]
    fn error_text_comes_from_libmpv_symbol() {
        assert_eq!(error_text(stub_error_string, 0), "success");
        assert_eq!(error_text(stub_error_string, -13), "command failed");
        assert_eq!(error_text(stub_error_string, -999), "unknown error");
    }

    #[test]
    fn null_error_string_falls_back_to_unknown() {
        assert_eq!(error_text(null_error_string, -13), "unknown error (-13)");
    }

    #[test]
    fn check_rc_accepts_success_and_rejects_negative_codes() {
        assert!(check_rc(stub_error_string, "loadfile", 0).is_ok());
        let err = check_rc(stub_error_string, "loadfile", -13).unwrap_err();
        assert_eq!(err.to_string(), "mpv loadfile failed: command failed (-13)");
    }

    #[test]
    fn contract_options_are_the_fatal_ones() {
        assert!(is_contract_option("osc"));
        assert!(is_contract_option("osd-level"));
        assert!(is_contract_option("vo"));
        assert!(is_contract_option("ao"));
        assert!(!is_contract_option("pause"));
        assert!(!is_contract_option("alang"));
    }

    #[test]
    fn base_options_keep_the_engine_headless_and_held() {
        let value_of = |wanted: &str| {
            BASE_OPTIONS
                .iter()
                .find(|(name, _)| *name == wanted)
                .map(|(_, value)| *value)
        };
        // No window, no sound, never self-starting: the engine is a mirror only.
        assert_eq!(value_of("vo"), Some("null"));
        assert_eq!(value_of("ao"), Some("null"));
        assert_eq!(value_of("pause"), Some("yes"));
    }

    #[test]
    fn non_finite_seconds_are_rejected() {
        assert!(require_finite(1.5, "seek").is_ok());
        assert!(require_finite(f64::NAN, "seek").is_err());
        assert!(require_finite(f64::INFINITY, "seek").is_err());
    }

    #[test]
    fn candidates_end_with_bare_loader_name() {
        let candidates = library_candidates();
        assert!(candidates
            .iter()
            .any(|path| path.file_name().and_then(|name| name.to_str()) == Some(LIB_NAMES[0])));
    }
}
