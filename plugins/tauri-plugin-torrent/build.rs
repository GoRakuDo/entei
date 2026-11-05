const COMMANDS: &[&str] = &["add_torrent", "get_torrent_status", "cancel_torrent"];

fn main() {
    tauri_plugin::Builder::new(COMMANDS).build();
}
