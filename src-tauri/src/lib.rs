mod trace;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_ytdlp::init())
        .plugin(tauri_plugin_torrent::init())
        .plugin(tauri_plugin_mpv::init())
        // Trace log: the web layer's only way to write the action journal.
        // `trace_log` appends a batch, `trace_dir_path` reports where the
        // files live. Both are app commands (no plugin capability needed).
        .invoke_handler(tauri::generate_handler![
            trace::trace_log,
            trace::trace_dir_path
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
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
