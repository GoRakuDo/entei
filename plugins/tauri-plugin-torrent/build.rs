const COMMANDS: &[&str] = &[
    "add_torrent",
    "get_torrent_status",
    "select_torrent_files",
    "inspect_torrent_tracks",
    "cancel_torrent",
];

fn main() {
    tauri_plugin::Builder::new(COMMANDS).build();
}
