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
//! mpv is the real media renderer: `vo = gpu-next` (falling back to `gpu`),
//! native audio output, and on Windows `wid = <main window HWND>` so libmpv
//! paints into a child of the Tauri window instead of opening a detached
//! top-level window. The HWND cannot be read during plugin `setup` (the window
//! from the Tauri config is created afterwards), so it is resolved lazily from
//! the stored app handle right before the instance is created. `osc = no` / `osd-level = 0` keep Entei's HTML/CSS
//! controls as the only control surface and `pause = yes` holds the engine
//! until Play.
//!
//! Note: on Windows WebView2 owns a sibling child HWND covering the client
//! area. `wid` guarantees there is no extra OS window; the z-order/airspace
//! between that WebView2 surface and mpv's child is a separate composition
//! concern that must be verified on a real desktop build.
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

/// Primary GPU video output. `gpu-next` needs libplacebo; builds that lack it
/// fall back to `gpu`, which is still a real GPU VO and still honours `wid`.
const VIDEO_OUTPUT: &str = "gpu-next";
const VIDEO_OUTPUT_FALLBACK: &str = "gpu";

/// WASAPI is the native Windows output and keeps FLAC bit-exact. Every other
/// platform (and any build without WASAPI) lets mpv pick its own backend.
#[cfg(windows)]
const AUDIO_OUTPUT: &str = "wasapi";
#[cfg(not(windows))]
const AUDIO_OUTPUT: &str = "auto";
const AUDIO_OUTPUT_FALLBACK: &str = "auto";

/// mpv options applied once, right after `mpv_create` and before
/// `mpv_initialize`.
///
/// mpv is the native renderer: it decodes and paints formats WebView2 cannot
/// (HEVC 4:4:4 10-bit, FLAC in MKV) and owns audio output. The HTML element
/// stays mounted as Entei's timing/transport shim and is muted by the web
/// layer, so the two engines never sing at once.
///
/// - `vo` / `ao`: real GPU video and native audio output. On Windows `wid`
///   is added separately from the main window's HWND, which makes libmpv
///   create its video output as a CHILD of the Tauri window — no second
///   top-level window and no extra taskbar entry.
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
    ("vo", VIDEO_OUTPUT),
    ("ao", AUDIO_OUTPUT),
    ("pause", "yes"),
    ("alang", "ja,jpn"),
    ("slang", "ja,jpn"),
    ("idle", "yes"),
];

/// Options whose rejection breaks the native-renderer contract. `vo` / `ao`
/// get one documented fallback first; `osc` / `osd-level` / `wid` must simply
/// work, otherwise mpv would paint its own UI or open a detached OS window.
///
/// `pause` is deliberately *not* listed: its real guarantee is the
/// `set_property("pause", "yes")` asserted on the live handle after
/// `mpv_initialize` (and again after every `loadfile`), so a build that rejects
/// the start-time option must not take the whole engine down.
fn is_contract_option(name: &str) -> bool {
    matches!(name, "osc" | "osd-level" | "vo" | "ao" | "wid")
}

/// Tauri bundle resource directory, resolved while the plugin initializes.
///
/// Mirrors the `resources/windows/*` entry in `tauri.windows.conf.json`, the
/// same layout the yt-dlp plugin uses for its bundled binary.
static RESOURCE_DIR: OnceLock<PathBuf> = OnceLock::new();

/// Lazy resolver for the native HWND of the Tauri main window.
///
/// The window declared in the Tauri config does **not** exist yet when plugin
/// `setup` runs: it is created afterwards, so `get_webview_window("main")`
/// returns `None` there. Resolving the HWND in `setup` would therefore pin
/// `0` forever and make every `mpv_initialize` fail. Instead `setup` stores the
/// `AppHandle` in this resolver and the HWND is read at the moment the mpv
/// instance is created — by then the window is guaranteed to exist.
///
/// A missing window is a hard error, never a fallback: without `wid` libmpv
/// would create its own detached OS window, which is exactly the extra taskbar
/// entry this plugin must never produce.
#[cfg(windows)]
static WINDOW_HWND_RESOLVER: OnceLock<Box<dyn Fn() -> Option<i64> + Send + Sync>> =
    OnceLock::new();

#[cfg(windows)]
fn embedded_window_hwnd() -> Result<i64, MpvError> {
    let resolver = WINDOW_HWND_RESOLVER.get().ok_or_else(|| {
        MpvError::WindowHandle(
            "main window HWND resolver was not installed during plugin setup".to_string(),
        )
    })?;
    resolver().ok_or_else(|| {
        MpvError::WindowHandle(
            "main window HWND is not available yet; retry once the window exists".to_string(),
        )
    })
}

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
    #[error("native video window unavailable: {0}")]
    WindowHandle(String),
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
    /// `mpv_get_property_string`, paired with `mpv_free`. Reads `time-pos`
    /// and `duration` for the web layer's native-mode clock.
    get_property_string: MpvGetPropertyString,
    /// Releases the string `get_property_string` hands back.
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
                // `gpu-next` needs libplacebo; an older build still has `gpu`.
                Err(_) if *name == "vo" => {
                    self.set_option(name, VIDEO_OUTPUT_FALLBACK)?;
                }
                // A build without WASAPI still has `auto`. Losing native audio
                // entirely would be worse than falling back to mpv's own pick.
                Err(_) if *name == "ao" && *value != AUDIO_OUTPUT_FALLBACK => {
                    self.set_option(name, AUDIO_OUTPUT_FALLBACK)?;
                }
                // `osc` / `osd-level` / `wid` are the contract: silently
                // tolerating a rejection would put mpv's own UI or window back
                // on top of Entei's player.
                Err(err) if is_contract_option(name) => return Err(err),
                // Best effort: an unsupported option must not stop playback.
                Err(err) => eprintln!("tauri-plugin-mpv: optional option {name} rejected: {err}"),
            }
        }
        // `wid` must land before `mpv_initialize` like every other option. On
        // Windows the Tauri HWND makes libmpv create its video output as a
        // child of the app window, so no second OS window is ever opened.
        #[cfg(windows)]
        {
            let hwnd = embedded_window_hwnd()?;
            self.set_option("wid", &hwnd.to_string())?;
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

    /// Read a numeric property (time-pos, duration) as f64.
    ///
    /// None means "the engine has no value yet" (idle, file still opening),
    /// which is not an error: the web layer keeps its previous clock.
    fn get_number(&self, name: &str) -> Result<Option<f64>, MpvError> {
        let name_c = c_string(name, "property name")?;
        // Safety: name_c is NUL-terminated and outlives the call; the returned
        // string is owned by libmpv until mpv_free.
        let ptr = unsafe { (self.get_property_string)(self.handle, name_c.as_ptr()) };
        if ptr.is_null() {
            return Ok(None);
        }
        // Safety: non-null NUL-terminated string as documented by libmpv.
        let text = unsafe { CStr::from_ptr(ptr) }.to_string_lossy().into_owned();
        // Safety: ptr came from mpv_get_property_string, which pairs with
        // mpv_free; it is released exactly once here.
        unsafe { (self.free)(ptr.cast()) };
        Ok(parse_number_property(&text))
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

/// Parse a libmpv numeric property string. Non-finite values are rejected so
/// the web layer never receives NaN/Infinity from the engine.
fn parse_number_property(text: &str) -> Option<f64> {
    let value = text.trim().parse::<f64>().ok()?;
    value.is_finite().then_some(value)
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

/// Current playback position in seconds (time-pos), or None while the engine
/// has no file open.
///
/// Needed because WebView2 cannot decode every container/codec libmpv can
/// (HEVC 4:4:4 10-bit, FLAC in MKV): the HTML element never fires timeupdate
/// for those sources, so the native clock becomes the only position the web
/// layer can render subtitles and the seek bar from.
#[tauri::command]
fn mpv_get_time() -> Result<Option<f64>, String> {
    let instance = instance().map_err(|err| err.message())?;
    instance.get_number("time-pos").map_err(|err| err.message())
}

/// Media duration in seconds (duration), or None while unknown.
#[tauri::command]
fn mpv_get_duration() -> Result<Option<f64>, String> {
    let instance = instance().map_err(|err| err.message())?;
    instance.get_number("duration").map_err(|err| err.message())
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
            #[cfg(windows)]
            {
                // `WebviewWindow::hwnd()` is Windows-only and returns the
                // top-level HWND, but the window does not exist yet at this
                // point in the Tauri lifecycle — it is created after plugin
                // `setup`. Store the app handle instead and let the resolver
                // read the HWND when the mpv instance is created (options such
                // as `wid` can only be applied at creation time).
                let app_handle = app.clone();
                let _ = WINDOW_HWND_RESOLVER.set(Box::new(move || {
                    app_handle
                        .get_webview_window("main")
                        .and_then(|window| window.hwnd().ok())
                        .map(|handle| handle.0 as isize as i64)
                        .filter(|hwnd| *hwnd != 0)
                }));
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            mpv_load,
            mpv_play,
            mpv_pause,
            mpv_seek,
            mpv_get_time,
            mpv_get_duration,
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
        assert!(is_contract_option("wid"));
        assert!(!is_contract_option("pause"));
        assert!(!is_contract_option("alang"));
    }

    #[test]
    fn base_options_render_natively_and_start_held() {
        let value_of = |wanted: &str| {
            BASE_OPTIONS
                .iter()
                .find(|(name, _)| *name == wanted)
                .map(|(_, value)| *value)
        };
        // A real GPU VO, real audio output, never self-starting: mpv is the
        // renderer, not a silent headless mirror.
        assert_eq!(value_of("vo"), Some(VIDEO_OUTPUT));
        assert_eq!(value_of("vo"), Some("gpu-next"));
        assert_eq!(value_of("ao"), Some(AUDIO_OUTPUT));
        assert_ne!(value_of("vo"), Some("null"));
        assert_ne!(value_of("ao"), Some("null"));
        assert_eq!(value_of("pause"), Some("yes"));
    }

    #[test]
    fn fallback_backends_are_real_outputs_not_null() {
        assert_eq!(VIDEO_OUTPUT_FALLBACK, "gpu");
        assert_ne!(VIDEO_OUTPUT_FALLBACK, VIDEO_OUTPUT);
        assert_eq!(AUDIO_OUTPUT_FALLBACK, "auto");
        assert_ne!(AUDIO_OUTPUT_FALLBACK, "null");
    }

    #[test]
    fn number_properties_parse_finite_values_only() {
        assert_eq!(parse_number_property("12.5"), Some(12.5));
        assert_eq!(parse_number_property("  3.25 "), Some(3.25));
        assert_eq!(parse_number_property("0"), Some(0.0));
        assert_eq!(parse_number_property("nan"), None);
        assert_eq!(parse_number_property("inf"), None);
        assert_eq!(parse_number_property(""), None);
        assert_eq!(parse_number_property("no"), None);
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

    /// The main window from the Tauri config does not exist while plugin
    /// `setup` runs, so the HWND must be read lazily at instance creation.
    /// Resolving it once during `setup` pinned `0` and made every
    /// `mpv_initialize` fail.
    #[cfg(windows)]
    #[test]
    fn hwnd_is_resolved_lazily_so_a_late_window_is_seen() {
        use std::sync::atomic::{AtomicI64, Ordering};

        static HWND: AtomicI64 = AtomicI64::new(0);

        // Stands in for `get_webview_window("main")`: no window yet, exactly
        // the state `setup` observes.
        let _ = WINDOW_HWND_RESOLVER.set(Box::new(|| {
            let value = HWND.load(Ordering::Relaxed);
            (value != 0).then_some(value)
        }));

        // A missing window is an explicit error, never a silent `0`.
        assert!(embedded_window_hwnd().is_err());

        // The window appears later: the next call must see it, which is only
        // possible if the resolver is consulted on every instance creation.
        HWND.store(0x1234, Ordering::Relaxed);
        assert_eq!(embedded_window_hwnd().unwrap(), 0x1234);
    }
}
