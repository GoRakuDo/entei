const COMMANDS: &[&str] = &["get_video_info", "stream_youtube"];

fn main() {
    tauri_plugin::Builder::new(COMMANDS).build();
}
