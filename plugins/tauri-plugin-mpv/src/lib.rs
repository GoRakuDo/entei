//! `tauri-plugin-mpv`
//!
//! Decoupled libmpv playback bridge for Entei. libmpv is **not** linked at
//! build time: it is resolved and opened at runtime through [`libloading`], so
//! a machine without mpv still starts the app and every command reports an
//! explicit error instead of aborting the process.
//!
//! Nine commands are exposed:
//!
//! - `mpv_load(url)`          -> `loadfile <url> replace`
//! - `mpv_play()`             -> sets `pause = no`
//! - `mpv_pause()`            -> sets `pause = yes`
//! - `mpv_seek(seconds)`      -> `seek <seconds> absolute`
//! - `mpv_set_sub_delay(sec)` -> sets `sub-delay = <seconds>`
//! - `mpv_set_tracks(aid, sid)` -> sets `aid` / `sid` when provided
//! - `mpv_set_bounds(x, y, w, h)` -> moves the native picture to the HTML
//!   media frame (physical pixels, relative to the window's client area)
//!
//! Resolution order for the shared library is `EIZOUDEN_MPV_PATH`, then the
//! Tauri resource directory (`resources/windows/libmpv-2.dll`, then
//! `resources/libmpv-2.dll`), then next to the executable, then the platform
//! loader search path (bare library name).
//!
//! mpv is the real media renderer: `vo = gpu-next` (falling back to `gpu`),
//! native audio output, and on Windows `wid = <surface HWND>` so libmpv
//! paints into a child of the Tauri window instead of opening a detached
//! top-level window. The HWND cannot be read during plugin `setup` (the window
//! from the Tauri config is created afterwards), so it is resolved lazily from
//! the stored app handle right before the instance is created. `osc = no` / `osd-level = 0` keep Entei's HTML/CSS
//! controls as the only control surface and `pause = yes` holds the engine
//! until Play.
//!
//! The `wid` parent is **not** the Tauri window itself but a plugin-owned
//! *surface window* (a plain child of the Tauri window). libmpv always
//! resizes its video window to fill the `wid` parent, so with the Tauri
//! window as the parent the picture would be letterboxed against the whole
//! window and the right panel would cover its right edge. The surface is
//! moved to the HTML media frame instead (`mpv_set_bounds`), so the native
//! picture and the HTML subtitles share one frame.
//!
//! Subtitles never come from mpv: `sid` / `sub-visibility` are switched off
//! because Entei draws every cue in HTML.
//!
//! Note: on Windows WebView2 owns a sibling child HWND covering the client
//! area. `wid` guarantees there is no extra OS window; the z-order/airspace
//! between that WebView2 surface and mpv's child is a separate composition
//! concern that must be verified on a real desktop build.
//!
//! Verified on a real desktop build (2026-11-09): the surface sits BELOW the
//! WebView2 in the z-order and the picture shows through exactly where the
//! page paints nothing — but only if the surface does NOT carry
//! `WS_CLIPSIBLINGS`. With that style the surface (and libmpv's video child
//! inside it) is clipped away by the WebView2 sibling that covers the whole
//! client area, the native picture never reaches the screen, and the page's
//! transparent media frame shows the desktop behind the transparent Tauri
//! window instead of the video.
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
///   is added separately, pointing at the plugin's own *surface window* — a
///   plain child of the Tauri window — which makes libmpv create its video
///   output as a CHILD of the app window: no second top-level window and no
///   extra taskbar entry. The video window lands at the BOTTOM of the
///   z-order, so the WebView2 keeps painting the HTML UI on top of it and the
///   native picture is only visible where the page is transparent.
/// - `force-window`: create the output window even when the file has no video
///   track (audio-only MKV). Without it libmpv creates no window at all for
///   such a file, and the transparent media surface of the native mode would
///   show the desktop through the app. It does NOT change the window
///   geometry: with `wid` the window still tracks the parent's client area.
/// - `pause = yes`: the engine starts held. `loadfile … replace` otherwise
///   starts its own clock immediately, so it would advance on its own while the
///   user has not pressed Play yet.
/// - `osc = no` / `osd-level = 0`: mpv must never paint its own controller or
///   OSD; Entei's HTML/CSS UI is the only control surface.
/// - `alang`: prefer Japanese audio automatically. Subtitles are never
///   auto-selected: Entei draws every cue in HTML.
/// - `sid = no` / `sub-visibility = no`: switch mpv's own subtitle
///   rendering off. `sid = no` keeps mpv from selecting (and decoding) a
///   track, `sub-visibility = no` is the hard guarantee that nothing is ever
///   painted over the video — even if a track is selected later.
/// - `idle = yes`: keep the playloop alive between files, so a second
///   `mpv_load` after the previous media reached EOF still starts playback.
const BASE_OPTIONS: &[(&str, &str)] = &[
    ("osc", "no"),
    ("osd-level", "0"),
    ("vo", VIDEO_OUTPUT),
    ("ao", AUDIO_OUTPUT),
    ("pause", "yes"),
    ("alang", "ja,jpn"),
    ("sid", "no"),
    ("sub-visibility", "no"),
    ("idle", "yes"),
    ("force-window", "yes"),
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

/// Rectangle of the native video surface, in physical pixels relative to the
/// Tauri window's client area.
#[cfg(windows)]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct SurfaceBounds {
    x: i32,
    y: i32,
    width: i32,
    height: i32,
}

#[cfg(windows)]
impl SurfaceBounds {
    /// True when the rectangle has no area: the surface is hidden then.
    fn is_empty(&self) -> bool {
        self.width == 0 || self.height == 0
    }
}

/// Minimal Win32 helpers for the native video surface.
///
/// libmpv always resizes its video window to fill the `wid` parent (mpv's
/// `video/out/w32_common.c` re-fills the child whenever the parent changes
/// size). The parent is therefore a plugin-owned **surface window** — a plain
/// child of the Tauri window — and not the Tauri window itself: with the
/// Tauri window as the parent the picture would be letterboxed against the
/// whole window and the right panel would cover its right edge.
#[cfg(windows)]
mod win {
    use std::sync::OnceLock;

    use super::SurfaceBounds;

    /// Win32 window handle.
    pub type Hwnd = isize;

    /// `RECT` (winuser.h).
    #[repr(C)]
    #[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
    pub struct Rect {
        pub left: i32,
        pub top: i32,
        pub right: i32,
        pub bottom: i32,
    }

    /// `WNDCLASSW` (winuser.h) in its x64 layout.
    ///
    /// `style` is padded to the pointer alignment because `lpfnWndProc`
    /// follows it; `cbClsExtra` / `cbWndExtra` are the only 32-bit fields
    /// between pointer-sized ones.
    #[repr(C)]
    struct WndClassW {
        style: u32,
        wnd_proc: unsafe extern "system" fn(Hwnd, u32, isize, isize) -> isize,
        cb_cls_extra: i32,
        cb_wnd_extra: i32,
        h_instance: isize,
        h_icon: isize,
        h_cursor: isize,
        h_brush_background: isize,
        lpsz_menu_name: *const u16,
        lpsz_class_name: *const u16,
    }

    // Win32 constants (winuser.h / wingdi.h).
    const WS_CHILD: u32 = 0x4000_0000;
    /// `WS_CLIPSIBLINGS`. The surface must NOT carry it (see `create`), so
    /// only the regression test needs the value.
    #[cfg(test)]
    pub const WS_CLIPSIBLINGS: u32 = 0x0400_0000;
    pub const WS_CLIPCHILDREN: u32 = 0x0200_0000;
    const WS_VISIBLE: u32 = 0x1000_0000;
    const WS_EX_NOACTIVATE: u32 = 0x0800_0000;
    const WS_EX_TOOLWINDOW: u32 = 0x0000_0080;
    const SWP_NOZORDER: u32 = 0x0004;
    const SWP_NOACTIVATE: u32 = 0x0010;
    const SWP_NOOWNERZORDER: u32 = 0x0200;
    const HWND_TOP: Hwnd = 0;
    const HWND_BOTTOM: Hwnd = 1;
    const SW_SHOW: i32 = 5;
    const SW_HIDE: i32 = 0;
    /// `WS_OVERLAPPEDWINDOW`.
    #[cfg(test)]
    const WS_OVERLAPPEDWINDOW: u32 = 0x00CF_0000;
    /// `GetStockObject(BLACK_BRUSH)`.
    const BLACK_BRUSH: isize = 4;
    /// `GWL_STYLE`.
    #[cfg(test)]
    const GWL_STYLE: i32 = -16;

    unsafe extern "system" {
        fn RegisterClassW(class: *const WndClassW) -> u16;
        fn CreateWindowExW(
            ex_style: u32,
            class_name: *const u16,
            window_name: *const u16,
            style: u32,
            x: i32,
            y: i32,
            width: i32,
            height: i32,
            parent: Hwnd,
            menu: isize,
            instance: isize,
            param: isize,
        ) -> Hwnd;
        fn DefWindowProcW(hwnd: Hwnd, message: u32, wparam: isize, lparam: isize) -> isize;
        fn SetWindowPos(
            hwnd: Hwnd,
            insert_after: Hwnd,
            x: i32,
            y: i32,
            width: i32,
            height: i32,
            flags: u32,
        ) -> i32;
        fn GetClientRect(hwnd: Hwnd, rect: *mut Rect) -> i32;
        #[cfg(test)]
        fn GetWindowLongW(hwnd: Hwnd, index: i32) -> i32;
        fn FindWindowExW(
            parent: Hwnd,
            after: Hwnd,
            class_name: *const u16,
            window_name: *const u16,
        ) -> Hwnd;
        fn GetModuleHandleW(module_name: *const u16) -> isize;
        fn GetCurrentThreadId() -> u32;
        fn GetWindowThreadProcessId(hwnd: Hwnd, process_id: *mut u32) -> u32;
        fn ShowWindow(hwnd: Hwnd, command: i32) -> i32;
        #[cfg(test)]
        fn DestroyWindow(hwnd: Hwnd) -> i32;
    }

    /// UTF-16, NUL-terminated copy of `text`.
    fn wide(text: &str) -> Vec<u16> {
        text.encode_utf16().chain(std::iter::once(0)).collect()
    }

    /// The surface window procedure: the surface has no behaviour of its own.
    unsafe extern "system" fn surface_wnd_proc(
        hwnd: Hwnd,
        message: u32,
        wparam: isize,
        lparam: isize,
    ) -> isize {
        // Safety: forwarding an unhandled message is DefWindowProcW's job.
        unsafe { DefWindowProcW(hwnd, message, wparam, lparam) }
    }

    /// Register the surface window class (once per process).
    fn surface_class() -> u16 {
        static CLASS: OnceLock<u16> = OnceLock::new();
        *CLASS.get_or_init(|| {
            let class_name = wide("EnteiMpvSurface");
            // Safety: a null module name resolves to the current module.
            let instance = unsafe { GetModuleHandleW(std::ptr::null()) };
            // Safety: `class_name` is NUL-terminated and outlives the call;
            // RegisterClassW copies the string.
            let class = WndClassW {
                style: 0,
                wnd_proc: surface_wnd_proc,
                cb_cls_extra: 0,
                cb_wnd_extra: 0,
                h_instance: instance,
                h_icon: 0,
                h_cursor: 0,
                // A black brush: the surface is fully covered by mpv's child,
                // but a defined colour avoids unpainted garbage between
                // creating the surface and mpv's child appearing.
                h_brush_background: BLACK_BRUSH,
                lpsz_menu_name: std::ptr::null(),
                lpsz_class_name: class_name.as_ptr(),
            };
            // Safety: `class` is a fully initialised WNDCLASSW.
            unsafe { RegisterClassW(&class) }
        })
    }

    /// Create the surface window as a child of `parent`.
    pub fn create(parent: Hwnd, bounds: SurfaceBounds) -> Result<Hwnd, String> {
        if surface_class() == 0 {
            return Err("RegisterClassW failed for the mpv surface class".to_string());
        }
        let class_name = wide("EnteiMpvSurface");
        // Safety: a null module name resolves to the current module.
        let instance = unsafe { GetModuleHandleW(std::ptr::null()) };
        // Safety: the class is registered above and the name buffer outlives
        // the call.
        let hwnd = unsafe {
            CreateWindowExW(
                WS_EX_NOACTIVATE | WS_EX_TOOLWINDOW,
                class_name.as_ptr(),
                std::ptr::null(),
                // `WS_CLIPSIBLINGS` is deliberately absent.
                //
                // The surface is a child of the Tauri window and lives BELOW
                // the WebView2 in the z-order; the WebView2 covers the whole
                // client area. `WS_CLIPSIBLINGS` tells Windows to clip a
                // window against the siblings that sit above it, so the
                // surface (and libmpv's video child inside it) was clipped
                // away entirely and the native picture never reached the
                // screen: the page's transparent media frame showed the
                // desktop behind the transparent Tauri window instead.
                //
                // Without it the picture composites under the WebView2 and
                // shows through exactly where the page paints nothing.
                WS_CHILD | WS_CLIPCHILDREN | WS_VISIBLE,
                bounds.x,
                bounds.y,
                bounds.width,
                bounds.height,
                parent,
                0,
                instance,
                0,
            )
        };
        if hwnd == 0 {
            return Err("CreateWindowExW failed for the mpv surface".to_string());
        }
        // The surface must stay at the bottom of the z-order: the WebView2
        // paints the HTML UI on top of it, and only the transparent part of
        // the page lets the native picture through. The z-order alone keeps
        // the UI above the picture — the surface must not clip itself
        // against that sibling (see the `WS_CLIPSIBLINGS` note above).
        set_bounds(hwnd, bounds);
        Ok(hwnd)
    }

    /// Move and resize the surface, keeping it at the bottom of the z-order.
    pub fn set_bounds(hwnd: Hwnd, bounds: SurfaceBounds) -> bool {
        // Safety: a valid handle and plain integers; the call reports failure
        // through its return value.
        unsafe {
            SetWindowPos(
                hwnd,
                HWND_BOTTOM,
                bounds.x,
                bounds.y,
                bounds.width,
                bounds.height,
                SWP_NOACTIVATE | SWP_NOOWNERZORDER,
            ) != 0
        }
    }

    /// Show or hide the surface.
    pub fn set_visible(hwnd: Hwnd, visible: bool) {
        // Safety: a valid handle.
        unsafe {
            ShowWindow(hwnd, if visible { SW_SHOW } else { SW_HIDE });
        }
    }

    /// Find libmpv's video window inside the surface.
    pub fn find_mpv_child(surface: Hwnd) -> Option<Hwnd> {
        let class = wide("mpv");
        // Safety: a NUL-terminated class name and a valid parent handle.
        let child = unsafe { FindWindowExW(surface, 0, class.as_ptr(), std::ptr::null()) };
        (child != 0).then_some(child)
    }

    /// Resize a child window so it fills its parent's client area.
    pub fn fill_parent(child: Hwnd, parent: Hwnd) -> bool {
        let mut rect = Rect::default();
        // Safety: `rect` is a valid, correctly sized RECT.
        if unsafe { GetClientRect(parent, &mut rect) } == 0 {
            return false;
        }
        // Safety: valid handles and plain integers.
        unsafe {
            SetWindowPos(
                child,
                HWND_TOP,
                0,
                0,
                rect.right - rect.left,
                rect.bottom - rect.top,
                SWP_NOZORDER | SWP_NOACTIVATE,
            ) != 0
        }
    }

    /// The client size of a window, in physical pixels.
    pub fn client_size(hwnd: Hwnd) -> Option<(i32, i32)> {
        let mut rect = Rect::default();
        // Safety: `rect` is a valid, correctly sized RECT.
        if unsafe { GetClientRect(hwnd, &mut rect) } == 0 {
            return None;
        }
        Some((rect.right - rect.left, rect.bottom - rect.top))
    }

    /// The window style (`GWL_STYLE`) of a window.
    #[cfg(test)]
    pub fn window_style(hwnd: Hwnd) -> u32 {
        // Safety: a valid handle; `GWL_STYLE` is a plain LONG.
        unsafe { GetWindowLongW(hwnd, GWL_STYLE) as u32 }
    }

    /// True when the calling thread owns `hwnd` — and therefore pumps its
    /// messages.
    pub fn owns_thread(hwnd: Hwnd) -> bool {
        // Safety: a null process-id pointer is allowed.
        let thread = unsafe { GetWindowThreadProcessId(hwnd, std::ptr::null_mut()) };
        thread != 0 && thread == unsafe { GetCurrentThreadId() }
    }

    /// Create a hidden top-level window, used by the tests as a parent.
    ///
    /// `WS_OVERLAPPEDWINDOW` does not include `WS_VISIBLE`, so the window
    /// never appears on screen.
    #[cfg(test)]
    pub fn create_test_parent() -> Option<Hwnd> {
        if surface_class() == 0 {
            return None;
        }
        let class_name = wide("EnteiMpvSurface");
        // Safety: a null module name resolves to the current module.
        let instance = unsafe { GetModuleHandleW(std::ptr::null()) };
        // Safety: the class is registered and the name buffer outlives the
        // call.
        let hwnd = unsafe {
            CreateWindowExW(
                WS_EX_NOACTIVATE | WS_EX_TOOLWINDOW,
                class_name.as_ptr(),
                std::ptr::null(),
                WS_OVERLAPPEDWINDOW,
                0,
                0,
                400,
                300,
                0,
                0,
                instance,
                0,
            )
        };
        if hwnd == 0 {
            return None;
        }
        Some(hwnd)
    }

    /// Destroy a window created by this module.
    #[cfg(test)]
    pub fn destroy(hwnd: Hwnd) {
        // Safety: a valid handle.
        unsafe {
            DestroyWindow(hwnd);
        }
    }
}

/// State of the native video surface.
#[cfg(windows)]
struct SurfaceState {
    /// The rectangle the page last asked for.
    bounds: SurfaceBounds,
    /// True once the page sent a rectangle. An unset rectangle means "fill
    /// the whole window", which is the behaviour without `mpv_set_bounds`.
    requested: bool,
    /// The surface window handle, `0` until the surface exists.
    hwnd: i64,
}

#[cfg(windows)]
static SURFACE_STATE: OnceLock<Mutex<SurfaceState>> = OnceLock::new();

#[cfg(windows)]
fn surface_state() -> &'static Mutex<SurfaceState> {
    SURFACE_STATE.get_or_init(|| {
        Mutex::new(SurfaceState {
            bounds: SurfaceBounds {
                x: 0,
                y: 0,
                width: 0,
                height: 0,
            },
            requested: false,
            hwnd: 0,
        })
    })
}

/// Lock the surface state, mapping a poisoned mutex onto a command error.
#[cfg(windows)]
fn lock_surface() -> Result<std::sync::MutexGuard<'static, SurfaceState>, MpvError> {
    surface_state().lock().map_err(|_| MpvError::Command {
        op: "surface lock".to_string(),
        detail: "mutex poisoned by an earlier panic".to_string(),
    })
}

/// Runs a closure on the thread that owns the Tauri window.
#[cfg(windows)]
type MainThreadRunner =
    Box<dyn Fn(Box<dyn FnOnce() + Send + 'static>) -> Result<(), String> + Send + Sync>;

#[cfg(windows)]
static MAIN_THREAD_RUNNER: OnceLock<MainThreadRunner> = OnceLock::new();

/// Create the native surface window (once) and return its handle.
///
/// The surface has to live on the thread that owns the Tauri window: a Win32
/// window only reacts to `WM_SIZE` / `WM_WINDOWPOSCHANGED` on a thread that
/// pumps messages, and that is the window's own thread.
#[cfg(windows)]
fn ensure_surface() -> Result<i64, MpvError> {
    let parent = embedded_window_hwnd()?;
    {
        let guard = lock_surface()?;
        if guard.hwnd != 0 {
            return Ok(guard.hwnd);
        }
    }
    let bounds = {
        let guard = lock_surface()?;
        if guard.requested {
            guard.bounds
        } else {
            // No rectangle yet: fill the whole window, exactly like the
            // behaviour without `mpv_set_bounds`.
            let (width, height) = win::client_size(parent as win::Hwnd).unwrap_or((0, 0));
            SurfaceBounds {
                x: 0,
                y: 0,
                width,
                height,
            }
        }
    };
    let hwnd = create_surface(parent, bounds)?;
    let mut guard = lock_surface()?;
    if guard.hwnd == 0 {
        guard.hwnd = hwnd;
    }
    Ok(guard.hwnd)
}

/// Create the surface window on the thread that owns the Tauri window.
#[cfg(windows)]
fn create_surface(parent: i64, bounds: SurfaceBounds) -> Result<i64, MpvError> {
    let parent = parent as win::Hwnd;
    // Already on the window's thread: create it here. Posting a task to the
    // window's thread and waiting for it here would deadlock the UI thread.
    if win::owns_thread(parent) {
        return win::create(parent, bounds)
            .map(|hwnd| hwnd as i64)
            .map_err(MpvError::WindowHandle);
    }
    let runner = MAIN_THREAD_RUNNER.get().ok_or_else(|| {
        MpvError::WindowHandle(
            "main thread runner was not installed during plugin setup".to_string(),
        )
    })?;
    let (sender, receiver) = std::sync::mpsc::channel();
    let task: Box<dyn FnOnce() + Send + 'static> = Box::new(move || {
        let _ = sender.send(win::create(parent, bounds));
    });
    runner(task).map_err(MpvError::WindowHandle)?;
    let created = receiver
        .recv_timeout(std::time::Duration::from_secs(2))
        .map_err(|err| {
            MpvError::WindowHandle(format!(
                "timed out waiting for the window thread: {err}"
            ))
        })?;
    created
        .map(|hwnd| hwnd as i64)
        .map_err(MpvError::WindowHandle)
}

/// Move the native picture to the HTML media frame.
#[cfg(windows)]
fn apply_surface_bounds(bounds: SurfaceBounds) -> Result<(), MpvError> {
    let surface = {
        let mut guard = lock_surface()?;
        if !bounds.is_empty() {
            // Only a real rectangle is remembered: an empty one means "hide",
            // not "the surface has no size".
            guard.bounds = bounds;
            guard.requested = true;
        }
        guard.hwnd as win::Hwnd
    };
    if surface == 0 {
        // The surface is created together with the mpv instance, which picks
        // the stored rectangle up.
        return Ok(());
    }
    if bounds.is_empty() {
        win::set_visible(surface, false);
        return Ok(());
    }
    win::set_visible(surface, true);
    win::set_bounds(surface, bounds);
    // libmpv's own hook resizes its child whenever the surface changes, but
    // the explicit call makes the new frame immediate instead of one tick
    // later.
    if let Some(child) = win::find_mpv_child(surface) {
        win::fill_parent(child, surface);
    }
    Ok(())
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
        // Subtitles belong to the HTML layer. The option layer already asked
        // for `sid = no` / `sub-visibility = no`; the properties are asserted
        // again on the live handle, because a build that rejected the option
        // would otherwise burn its own subtitles into the picture.
        instance.disable_native_subtitles()?;
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
        // Windows the surface window makes libmpv create its video output as
        // a child of the app window, so no second OS window is ever opened.
        #[cfg(windows)]
        {
            // libmpv always fills the `wid` parent, so the parent is the
            // plugin's own surface window: the picture then lands in the
            // HTML media frame instead of being letterboxed against the whole
            // window, where the right panel would cover it.
            let hwnd = match ensure_surface() {
                Ok(hwnd) => hwnd,
                Err(err) => {
                    // A missing surface must not take the engine down: the
                    // Tauri window is a working (if unaligned) fallback.
                    eprintln!(
                        "tauri-plugin-mpv: native surface unavailable ({err}); \
                         falling back to the window parent"
                    );
                    embedded_window_hwnd()?
                }
            };
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

    /// Switch mpv's own subtitle rendering off for good.
    ///
    /// `sub-visibility = no` is the guarantee (nothing is painted, whatever
    /// track is selected), `sid = no` additionally keeps mpv from decoding a
    /// track at all. Both are properties, so they also hold after a later
    /// `loadfile` or track switch.
    fn disable_native_subtitles(&self) -> Result<(), MpvError> {
        let mut failures = Vec::new();
        for (property, value) in [("sub-visibility", "no"), ("sid", "no")] {
            if let Err(err) = self.set_property(property, value) {
                failures.push(err);
            }
        }
        if failures.len() == 2 {
            // Neither property was accepted: mpv would paint subtitles over
            // the video, which Entei renders in HTML instead.
            return Err(failures
                .pop()
                .expect("two failures were collected before this point"));
        }
        Ok(())
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

/// Validate a surface rectangle coming from the page.
fn validate_bounds(width: i32, height: i32) -> Result<(), MpvError> {
    if width < 0 || height < 0 {
        return Err(MpvError::Invalid(
            "surface bounds must not be negative".to_string(),
        ));
    }
    Ok(())
}

/// Move and resize the native video surface so the picture matches the HTML
/// media frame.
///
/// The rectangle is in **physical pixels relative to the Tauri window's client
/// area** (the page multiplies its CSS-pixel rect by `devicePixelRatio`).
/// libmpv letterboxes the video inside that rectangle exactly like the page's
/// `object-fit: contain`, so the native picture and the HTML subtitles share
/// one frame.
///
/// A rectangle without area hides the surface: the media frame is gone (no
/// media, immersive mode exited), so no stale picture may stay on screen.
#[tauri::command]
fn mpv_set_bounds(x: i32, y: i32, width: i32, height: i32) -> Result<(), String> {
    validate_bounds(width, height).map_err(|err| err.message())?;
    #[cfg(windows)]
    {
        apply_surface_bounds(SurfaceBounds {
            x,
            y,
            width,
            height,
        })
        .map_err(|err| err.message())
    }
    #[cfg(not(windows))]
    {
        // The native surface is a Windows-only concern; other platforms keep
        // the mpv window filling its parent.
        let _ = (x, y);
        Ok(())
    }
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
                // The native surface window must be created on the thread
                // that owns the Tauri window: only that thread pumps its
                // messages, and a Win32 window that never gets its messages
                // never resizes. Commands normally run there already; the
                // runner is the fallback for the case where they do not.
                let app_handle = app.app_handle().clone();
                let _ = MAIN_THREAD_RUNNER.set(Box::new(move |task| {
                    app_handle
                        .run_on_main_thread(task)
                        .map_err(|err| err.to_string())
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
            mpv_set_tracks,
            mpv_set_bounds
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
        // The output window must exist even for a file without a video track,
        // otherwise the transparent native surface shows the desktop through
        // the app.
        assert_eq!(value_of("force-window"), Some("yes"));
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

    #[test]
    fn native_subtitles_are_disabled_by_the_engine() {
        let value_of = |wanted: &str| {
            BASE_OPTIONS
                .iter()
                .find(|(name, _)| *name == wanted)
                .map(|(_, value)| *value)
        };
        // `sid = no` keeps mpv from selecting a subtitle track, and
        // `sub-visibility = no` is the hard guarantee that nothing is painted
        // over the video — Entei draws every cue in HTML.
        assert_eq!(value_of("sid"), Some("no"));
        assert_eq!(value_of("sub-visibility"), Some("no"));
        // No language auto-selection either: a track would only be decoded
        // for nothing.
        assert_eq!(value_of("slang"), None);
    }

    #[test]
    fn surface_bounds_reject_negative_sizes() {
        assert!(validate_bounds(320, 180).is_ok());
        assert!(validate_bounds(0, 0).is_ok());
        assert!(validate_bounds(-1, 180).is_err());
        assert!(validate_bounds(320, -1).is_err());
    }

    /// The surface is the `wid` parent libmpv paints into, and it has to
    /// follow the rectangle the page asks for — that is what keeps the
    /// picture out of the right panel.
    #[cfg(windows)]
    #[test]
    fn surface_window_follows_the_requested_rectangle() {
        let Some(parent) = win::create_test_parent() else {
            panic!("could not create the test parent window");
        };
        let bounds = SurfaceBounds {
            x: 0,
            y: 0,
            width: 320,
            height: 180,
        };
        let surface = win::create(parent, bounds).expect("the surface window must be creatable");
        assert_eq!(win::client_size(surface), Some((320, 180)));
        // No mpv is running in a test, so the surface has no video child.
        assert!(win::find_mpv_child(surface).is_none());

        let moved = SurfaceBounds {
            x: 12,
            y: 8,
            width: 640,
            height: 360,
        };
        assert!(win::set_bounds(surface, moved));
        assert_eq!(win::client_size(surface), Some((640, 360)));

        win::destroy(surface);
        win::destroy(parent);
    }

    /// The surface must not clip itself against the WebView2 sibling.
    ///
    /// The WebView2 is a sibling that covers the whole client area and sits
    /// ABOVE the surface in the z-order. `WS_CLIPSIBLINGS` would clip the
    /// surface — and libmpv's video child inside it — away wherever that
    /// sibling covers it, so the native picture never reached the screen:
    /// the page's transparent media frame showed the desktop behind the
    /// transparent Tauri window instead of the video.
    #[cfg(windows)]
    #[test]
    fn surface_does_not_clip_against_the_webview_sibling() {
        let Some(parent) = win::create_test_parent() else {
            panic!("could not create the test parent window");
        };
        let bounds = SurfaceBounds {
            x: 0,
            y: 0,
            width: 320,
            height: 180,
        };
        let surface = win::create(parent, bounds).expect("the surface window must be creatable");
        let style = win::window_style(surface);
        assert_eq!(
            style & win::WS_CLIPSIBLINGS,
            0,
            "the surface must not carry WS_CLIPSIBLINGS: the WebView2 sibling covers the \
             whole client area and would clip the native picture away",
        );
        // The children (libmpv's video window) stay clipped to the surface's
        // own client area.
        assert_ne!(style & win::WS_CLIPCHILDREN, 0);
        win::destroy(surface);
        win::destroy(parent);
    }
}
