//! `tauri-plugin-database`
//!
//! Single embedded SQLite database (`entei.db`) that replaces the browser
//! IndexedDB / localStorage stores the web app used to rely on. All user data
//! (timeline, watch history + sessions, mining archive, profile, generic
//! key/value settings) lives in one local file under `app_data_dir`.
//!
//! Design notes:
//! - The connection lives in plugin state behind a `std::sync::Mutex`.
//! - Every command hops onto the blocking thread pool via
//!   `tauri::async_runtime::spawn_blocking` and moves an `Arc` clone of the
//!   state in, so the async runtime never blocks on a database call and the
//!   non-`Send`-friendly borrow never crosses an `.await`.
//! - All persistence logic is pure functions over `&Connection` in [`store`],
//!   which is fully unit-testable against an in-memory database.

mod models;
pub mod store;

pub use models::*;

use std::sync::{Arc, Mutex};

use tauri::plugin::{Builder, TauriPlugin};
use tauri::{Manager, Runtime, State};

/// Shared, lock-guarded handle to the embedded database connection.
pub struct DbState(Arc<Mutex<rusqlite::Connection>>);

impl DbState {
    /// Open (creating if needed) the database at `path`.
    pub fn open(path: &std::path::Path) -> Result<Self, String> {
        let conn = store::open(path).map_err(|e| e.to_string())?;
        Ok(Self(Arc::new(Mutex::new(conn))))
    }
}

/// Run a closure against the locked connection on the blocking pool.
macro_rules! with_db {
    ($state:expr, |$conn:ident| $body:expr) => {{
        let db = $state.0.clone();
        tauri::async_runtime::spawn_blocking(move || {
            let $conn = &mut *db.lock().map_err(|e| e.to_string())?;
            $body
        })
        .await
        .map_err(|err| format!("database task failed: {err}"))?
    }};
}

// --- Timeline --------------------------------------------------------------

#[tauri::command]
async fn db_get_timeline_posts(
    state: State<'_, DbState>,
    limit: Option<u32>,
    offset: Option<u32>,
    parent_id: Option<String>,
) -> Result<Vec<TimelinePost>, String> {
    with_db!(state, |conn| store::get_timeline_posts(
        conn, limit, offset, parent_id
    )
    .map_err(|e| e.to_string()))
}

#[tauri::command]
async fn db_create_timeline_post(
    state: State<'_, DbState>,
    post: TimelinePostInput,
) -> Result<TimelinePost, String> {
    with_db!(state, |conn| store::create_timeline_post(conn, post)
        .map_err(|e| e.to_string()))
}

#[tauri::command]
async fn db_toggle_like_post(state: State<'_, DbState>, id: String) -> Result<TimelinePost, String> {
    with_db!(state, |conn| store::toggle_like_post(conn, &id).map_err(|e| e.to_string()))
}

// --- Watch history / sessions ---------------------------------------------

#[tauri::command]
async fn db_get_watch_history(
    state: State<'_, DbState>,
    limit: Option<u32>,
    offset: Option<u32>,
) -> Result<Vec<WatchHistoryItem>, String> {
    with_db!(state, |conn| store::get_watch_history(conn, limit, offset)
        .map_err(|e| e.to_string()))
}

#[tauri::command]
async fn db_upsert_watch_history(
    state: State<'_, DbState>,
    item: WatchHistoryInput,
) -> Result<(), String> {
    with_db!(state, |conn| store::upsert_watch_history(conn, item).map_err(|e| e.to_string()))
}

#[tauri::command]
async fn db_get_watch_sessions(
    state: State<'_, DbState>,
    media_id: Option<String>,
) -> Result<Vec<WatchSessionItem>, String> {
    with_db!(state, |conn| store::get_watch_sessions(conn, media_id).map_err(|e| e.to_string()))
}

#[tauri::command]
async fn db_save_watch_session(
    state: State<'_, DbState>,
    session: WatchSessionInput,
) -> Result<(), String> {
    with_db!(state, |conn| store::save_watch_session(conn, session).map_err(|e| e.to_string()))
}

// --- Mining archive --------------------------------------------------------

#[tauri::command]
async fn db_get_mining_archive(
    state: State<'_, DbState>,
    limit: Option<u32>,
    offset: Option<u32>,
) -> Result<Vec<MiningArchiveItem>, String> {
    with_db!(state, |conn| store::get_mining_archive(conn, limit, offset).map_err(|e| e.to_string()))
}

#[tauri::command]
async fn db_save_mining_card(
    state: State<'_, DbState>,
    card: MiningArchiveInput,
) -> Result<(), String> {
    with_db!(state, |conn| store::save_mining_card(conn, card).map_err(|e| e.to_string()))
}

// --- Profile ---------------------------------------------------------------

#[tauri::command]
async fn db_get_profile(state: State<'_, DbState>) -> Result<Option<UserProfile>, String> {
    with_db!(state, |conn| store::get_profile(conn).map_err(|e| e.to_string()))
}

#[tauri::command]
async fn db_upsert_profile(
    state: State<'_, DbState>,
    profile: UserProfileInput,
) -> Result<UserProfile, String> {
    with_db!(state, |conn| store::upsert_profile(conn, profile).map_err(|e| e.to_string()))
}

// --- KV store --------------------------------------------------------------

#[tauri::command]
async fn db_kv_get(state: State<'_, DbState>, key: String) -> Result<Option<String>, String> {
    with_db!(state, |conn| store::kv_get(conn, &key).map_err(|e| e.to_string()))
}

#[tauri::command]
async fn db_kv_set(state: State<'_, DbState>, key: String, value: String) -> Result<(), String> {
    with_db!(state, |conn| store::kv_set(conn, &key, &value).map_err(|e| e.to_string()))
}

// --- Migration -------------------------------------------------------------

#[tauri::command]
async fn db_migrate_v1(state: State<'_, DbState>, payload: MigrationPayloadV1) -> Result<(), String> {
    with_db!(state, |conn| store::migrate_v1(conn, payload).map_err(|e| e.to_string()))
}

/// Resolve `app_data_dir/entei.db` and register plugin state at startup.
fn resolve_db_path<R: Runtime>(app: &tauri::AppHandle<R>) -> Result<std::path::PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("failed to resolve app_data_dir: {e}"))?;
    Ok(dir.join("entei.db"))
}

pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("database")
        .invoke_handler(tauri::generate_handler![
            db_get_timeline_posts,
            db_create_timeline_post,
            db_toggle_like_post,
            db_get_watch_history,
            db_upsert_watch_history,
            db_get_watch_sessions,
            db_save_watch_session,
            db_get_mining_archive,
            db_save_mining_card,
            db_get_profile,
            db_upsert_profile,
            db_kv_get,
            db_kv_set,
            db_migrate_v1
        ])
        .setup(|app, _api| {
            let path = resolve_db_path(app)?;
            let state = DbState::open(&path)?;
            app.manage(state);
            Ok(())
        })
        .build()
}
