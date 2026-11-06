const COMMANDS: &[&str] = &[
    "mpv_load",
    "mpv_play",
    "mpv_pause",
    "mpv_seek",
    "mpv_set_sub_delay",
    "mpv_set_tracks",
];

fn main() {
    tauri_plugin::Builder::new(COMMANDS).build();
}
