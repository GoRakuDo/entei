const COMMANDS: &[&str] = &[
    "subtitles_parse",
    "subtitles_parse_filename",
    "subtitles_estimate_lazy_sync",
];

fn main() {
    tauri_plugin::Builder::new(COMMANDS).build();
}
