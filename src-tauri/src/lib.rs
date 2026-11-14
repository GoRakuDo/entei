mod trace;

#[tauri::command]
fn open_external_url(url: String) -> Result<(), String> {
    if url.starts_with("http://") || url.starts_with("https://") {
        open::that(&url).map_err(|e| e.to_string())
    } else {
        Err("invalid url scheme".to_string())
    }
}

#[cfg(windows)]
fn install_console_ctrl_handler() {
    unsafe {
        #[link(name = "kernel32")]
        extern "system" {
            fn SetConsoleCtrlHandler(
                handler_routine: Option<unsafe extern "system" fn(u32) -> i32>,
                add: i32,
            ) -> i32;
        }
        unsafe extern "system" fn ctrl_handler(ctrl_type: u32) -> i32 {
            // CTRL_C_EVENT = 0, CTRL_BREAK_EVENT = 1, CTRL_CLOSE_EVENT = 2
            if ctrl_type <= 2 {
                std::process::exit(0);
            }
            0
        }
        let _ = SetConsoleCtrlHandler(Some(ctrl_handler), 1);
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    #[cfg(windows)]
    install_console_ctrl_handler();

    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_mpv::init())
        // Native subtitle parsing / media filename parsing / LazySync offset
        // estimation. The commands run their CPU-bound work on the blocking
        // thread pool, so the webview never waits for a 3 000-cue parse.
        .plugin(tauri_plugin_subtitles::init())
        // Unified native external modules: yt-dlp, torrent, Jimaku, Nadeshiko,
        // and Yomitan dictionary engine.
        .plugin(tauri_plugin_modules::init())
        // Native AnkiConnect transport: outside the webview PNA/CORS boundary.
        .plugin(tauri_plugin_anki::init())
        // Embedded SQLite (`entei.db`): single source of truth for user data.
        .plugin(tauri_plugin_database::init())
        // Native file dialog: the only way to obtain an absolute path for a
        // "choose media" click, because WebView2 never exposes `File.path`.
        .plugin(tauri_plugin_dialog::init())
        // External link guard: intercept any navigation to an external HTTP(S)
        // URL and open it in the user's default system browser, keeping the
        // internal WebView2 shell strictly inside the Entei app.
        .plugin(
            tauri::plugin::Builder::<tauri::Wry>::new("external-link-guard")
                .on_navigation(|_webview, url| {
                    let scheme = url.scheme();
                    if scheme == "http" || scheme == "https" {
                        let host = url.host_str().unwrap_or("");
                        if host != "tauri.localhost"
                            && host != "localhost"
                            && host != "127.0.0.1"
                            && host != "ipc.localhost"
                        {
                            let _ = open::that(url.as_str());
                            return false; // prevent navigating the app webview away
                        }
                    }
                    true
                })
                .build(),
        )
        // Trace log: the web layer's only way to write the action journal.
        // `trace_log` appends a batch, `trace_dir_path` reports where the
        // files live. Both are app commands (no plugin capability needed).
        .invoke_handler(tauri::generate_handler![
            trace::trace_log,
            trace::trace_dir_path,
            open_external_url
        ])
        // Retention runs at startup too, so a stale day file is removed even
        // if the session never writes a trace entry.
        .setup(|app| {
            trace::purge_on_startup(app.handle());
            Ok(())
        });

        // Debug-only developer bridge (MCP). Two guards:
    // - `debug_assertions`: the plugin is not compiled/registered in release builds.
    // - bind_address "127.0.0.1": the bridge WebSocket never listens on other interfaces.
    #[cfg(debug_assertions)]
    let builder = builder.plugin(
        tauri_plugin_mcp_bridge::Builder::new()
            .bind_address("127.0.0.1")
            .build(),
    );

    builder
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::Destroyed = event {
                // When the main window is closed/destroyed, terminate the process immediately
                // so background listener tasks (MCP server, relays, mpv) do not hang or zombie.
                if window.label() == "main" {
                    std::process::exit(0);
                }
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
