const COMMANDS: &[&str] = &[
    "modules_jimaku_search_entries",
    "modules_jimaku_search_entries_combined",
    "modules_jimaku_entry_files",
    "modules_jimaku_download_subtitle",
    "modules_nadeshiko_search",
    "modules_nadeshiko_segment_context",
    "modules_nadeshiko_user_me",
    "yomitan_import_dictionary",
    "yomitan_list_dictionaries",
    "yomitan_toggle_dictionary",
    "yomitan_delete_dictionary",
    "yomitan_find_terms",
    "yomitan_find_kanji",
];

fn main() {
    tauri_plugin::Builder::new(COMMANDS).build();
}
