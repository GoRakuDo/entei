const COMMANDS: &[&str] = &["anki_request", "anki_check_connection"];

fn main() {
    tauri_plugin::Builder::new(COMMANDS).build();
}
