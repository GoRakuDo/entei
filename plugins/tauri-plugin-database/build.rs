const COMMANDS: &[&str] = &[
    "db_get_timeline_posts",
    "db_create_timeline_post",
    "db_toggle_like_post",
    "db_get_watch_history",
    "db_upsert_watch_history",
    "db_get_watch_sessions",
    "db_save_watch_session",
    "db_get_mining_archive",
    "db_save_mining_card",
    "db_get_profile",
    "db_upsert_profile",
    "db_kv_get",
    "db_kv_set",
    "db_migrate_v1",
];

fn main() {
    tauri_plugin::Builder::new(COMMANDS).build();
}
