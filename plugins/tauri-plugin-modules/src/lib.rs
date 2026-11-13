//! Unified native Entei Modules plugin.
//!
//! Consolidates all external communication and media/dictionary modules under
//! a single Tauri plugin (`tauri-plugin-modules`):
//!
//! - `jimaku` (`modules_jimaku_*`)
//! - `nadeshiko` (`modules_nadeshiko_*`)
//! - `yomitan` (`yomitan_*`)
//! - `torrent` (`add_torrent`, `get_torrent_status`, `select_torrent_files`, `inspect_torrent_tracks`, `cancel_torrent`)
//! - `ytdlp` (`get_video_info`, `stream_youtube`)

pub mod jimaku;
pub mod nadeshiko;
pub mod torrent;
pub mod yomitan;
pub mod ytdlp;

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use tauri::plugin::{Builder, TauriPlugin};
use tauri::{Manager, Runtime, State};

pub use jimaku::{JimakuEntry, JimakuError, JimakuErrorKind, JimakuFile, JimakuResult};
pub use nadeshiko::{
    NadeshikoContextOptions, NadeshikoError, NadeshikoErrorKind, NadeshikoQuota,
    NadeshikoSearchOptions, NadeshikoSearchPage, NadeshikoSegment, NadeshikoSegmentContextResponse,
    NadeshikoSegmentUrls, NadeshikoUser, NadeshikoUserMe,
};
pub use torrent::{AddTorrentResult, SelectedTorrentFiles, TorrentFile, TorrentStatus};
pub use yomitan::{DictionarySummary, KanjiEntry, TermEntry};
pub use ytdlp::{StreamSource, VideoInfo};

#[tauri::command]
async fn modules_jimaku_search_entries(
    api_key: String,
    query: String,
    anime: bool,
) -> JimakuResult<Vec<JimakuEntry>> {
    jimaku::JimakuClient::new()
        .search_entries(&api_key, &query, anime)
        .await
}

#[tauri::command]
async fn modules_jimaku_search_entries_combined(
    api_key: String,
    query: String,
) -> JimakuResult<Vec<JimakuEntry>> {
    jimaku::JimakuClient::new()
        .search_entries_combined(&api_key, &query)
        .await
}

#[tauri::command]
async fn modules_jimaku_entry_files(
    api_key: String,
    entry_id: i64,
    episode: Option<u32>,
) -> JimakuResult<Vec<JimakuFile>> {
    jimaku::JimakuClient::new()
        .entry_files(&api_key, entry_id, episode)
        .await
}

#[tauri::command]
async fn modules_jimaku_download_subtitle(url: String) -> JimakuResult<String> {
    jimaku::JimakuClient::new().download_subtitle(&url).await
}

#[tauri::command]
async fn modules_nadeshiko_search(
    api_key: String,
    query: String,
    options: Option<NadeshikoSearchOptions>,
) -> Result<NadeshikoSearchPage, NadeshikoError> {
    nadeshiko::NadeshikoClient::new()
        .search(&api_key, &query, options.unwrap_or_default())
        .await
}

#[tauri::command]
async fn modules_nadeshiko_segment_context(
    api_key: String,
    segment_id: String,
    options: Option<nadeshiko::NadeshikoContextOptions>,
) -> Result<NadeshikoSegmentContextResponse, NadeshikoError> {
    nadeshiko::NadeshikoClient::new()
        .segment_context(&api_key, &segment_id, options.unwrap_or_default())
        .await
}

#[tauri::command]
async fn modules_nadeshiko_user_me(api_key: String) -> Result<NadeshikoUserMe, NadeshikoError> {
    nadeshiko::NadeshikoClient::new().user_me(&api_key).await
}

/// Shared, lock-guarded handle to the dictionary-only database connection.
///
/// This is a *separate* SQLite file from `entei.db`: no dictionary byte is ever
/// written into the user database.
pub struct YomitanDbState(Arc<Mutex<rusqlite::Connection>>);

impl YomitanDbState {
    /// Open (creating if needed) the dictionary database at `path`.
    pub fn open(path: &Path) -> Result<Self, String> {
        Ok(Self(Arc::new(Mutex::new(yomitan::open(path)?))))
    }
}

/// Run a closure against the locked connection on the blocking pool, so an import
/// (hundreds of thousands of inserts) never blocks the async runtime.
macro_rules! with_yomitan_db {
    ($state:expr, |$conn:ident| $body:expr) => {{
        let db = $state.0.clone();
        tauri::async_runtime::spawn_blocking(move || {
            let $conn = &mut *db.lock().map_err(|e| e.to_string())?;
            $body
        })
        .await
        .map_err(|err| format!("dictionary task failed: {err}"))?
    }};
}

// --- Yomitan dictionaries --------------------------------------------------

/// Import a Yomitan dictionary ZIP from a path the user picked. The ZIP is
/// streamed straight off disk, so a large dictionary is never held in memory.
#[tauri::command]
async fn yomitan_import_dictionary(
    state: State<'_, YomitanDbState>,
    zip_path: String,
) -> Result<DictionarySummary, String> {
    with_yomitan_db!(state, |conn| yomitan::import_dictionary_from_path(
        conn, &zip_path
    ))
}

#[tauri::command]
async fn yomitan_list_dictionaries(
    state: State<'_, YomitanDbState>,
) -> Result<Vec<DictionarySummary>, String> {
    with_yomitan_db!(state, |conn| yomitan::list_dictionaries(conn))
}

#[tauri::command]
async fn yomitan_toggle_dictionary(
    state: State<'_, YomitanDbState>,
    id: String,
    enabled: bool,
) -> Result<(), String> {
    with_yomitan_db!(state, |conn| yomitan::toggle_dictionary(conn, &id, enabled))
}

#[tauri::command]
async fn yomitan_delete_dictionary(
    state: State<'_, YomitanDbState>,
    id: String,
) -> Result<(), String> {
    with_yomitan_db!(state, |conn| yomitan::delete_dictionary(conn, &id))
}

/// Headwords matching `term` exactly (expression or reading) across enabled
/// dictionaries, highest score first.
#[tauri::command]
async fn yomitan_find_terms(
    state: State<'_, YomitanDbState>,
    term: String,
    limit: Option<u32>,
) -> Result<Vec<TermEntry>, String> {
    with_yomitan_db!(state, |conn| yomitan::find_terms(conn, &term, limit))
}

#[tauri::command]
async fn yomitan_find_kanji(
    state: State<'_, YomitanDbState>,
    character: String,
) -> Result<Option<KanjiEntry>, String> {
    with_yomitan_db!(state, |conn| yomitan::find_kanji(conn, &character))
}

/// Resolve `app_data_dir/yomitan-dictionaries.db` and register state at startup.
fn resolve_dictionary_db_path<R: Runtime>(app: &tauri::AppHandle<R>) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("failed to resolve app_data_dir: {e}"))?;
    Ok(dir.join(yomitan::DATABASE_FILE_NAME))
}

pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("modules")
        .invoke_handler(tauri::generate_handler![
            modules_jimaku_search_entries,
            modules_jimaku_search_entries_combined,
            modules_jimaku_entry_files,
            modules_jimaku_download_subtitle,
            modules_nadeshiko_search,
            modules_nadeshiko_segment_context,
            modules_nadeshiko_user_me,
            yomitan_import_dictionary,
            yomitan_list_dictionaries,
            yomitan_toggle_dictionary,
            yomitan_delete_dictionary,
            yomitan_find_terms,
            yomitan_find_kanji,
            torrent::add_torrent,
            torrent::get_torrent_status,
            torrent::select_torrent_files,
            torrent::inspect_torrent_tracks,
            torrent::cancel_torrent,
            ytdlp::get_video_info,
            ytdlp::stream_youtube
        ])
        .setup(|app, _api| {
            let path = resolve_dictionary_db_path(app)?;
            app.manage(YomitanDbState::open(&path)?);
            ytdlp::setup(app);
            torrent::setup(app)?;
            Ok(())
        })
        .on_event(|app, event| {
            if matches!(event, tauri::RunEvent::Exit) {
                ytdlp::on_exit();
                torrent::on_exit(app);
            }
        })
        .build()
}