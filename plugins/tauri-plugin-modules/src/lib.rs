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
use tauri::{AppHandle, Emitter, Manager, Runtime, State};

pub use jimaku::{JimakuEntry, JimakuError, JimakuErrorKind, JimakuFile, JimakuResult};
pub use nadeshiko::{
    NadeshikoContextOptions, NadeshikoError, NadeshikoErrorKind, NadeshikoQuota,
    NadeshikoSearchOptions, NadeshikoSearchPage, NadeshikoSegment, NadeshikoSegmentContextResponse,
    NadeshikoSegmentUrls, NadeshikoUser, NadeshikoUserMe,
};
pub use torrent::{AddTorrentResult, SelectedTorrentFiles, TorrentFile, TorrentStatus};
pub use yomitan::{
    BulkKanjiEntry, BulkTagEntry, BulkTermEntry, DictionarySummary, ImportProgress, KanjiEntry,
    StorageUsageSnapshot, TagQuery, TermEntry, TermMatchType, TermMetaEntry,
};
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

/// Event the dictionary import publishes its progress on, as an
/// [`ImportProgress`] payload (`{ percent, current, total }`).
///
/// A Tauri event, not the command's return value: the import is one long
/// blocking call whose only result is the finished dictionary, and the UI has to
/// show what is happening while it runs.
///
/// Note: the name carries ONE colon. A `scheme://name` shape is a URL, not the
/// plain event name Tauri's listener table is keyed by, and an event the webview
/// never subscribes to is an import that looks frozen.
pub const YOMITAN_IMPORT_PROGRESS_EVENT: &str = "yomitan:import-progress";

/// The window every progress event is addressed to as well as broadcast to.
///
/// Entei has exactly one window (`tauri.conf.json`, label `main`), so this is
/// the webview that draws the import.
const MAIN_WINDOW_LABEL: &str = "main";

/// Import a Yomitan dictionary ZIP from a path the user picked, publishing
/// [`YOMITAN_IMPORT_PROGRESS_EVENT`] as it writes. The ZIP is streamed straight
/// off disk, so a large dictionary is never held in memory.
#[tauri::command]
async fn yomitan_import_dictionary<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, YomitanDbState>,
    zip_path: String,
) -> Result<DictionarySummary, String> {
    with_yomitan_db!(state, |conn| yomitan::import_dictionary_from_path_with_progress(
        conn,
        &zip_path,
        // Emitted from the blocking pool, by BOTH routes Tauri offers: the
        // app-wide broadcast, and one addressed to the window that draws the
        // import. They are deliberately redundant — an import that appears to
        // sit at 0% until it jumps to done is what a single, silently undelivered
        // event stream looks like, and the second route is what makes that not
        // survivable. Neither may fail the import (a renderer that closed
        // mid-import makes both fail), and a repeated report is harmless on the
        // receiving end, which only ever moves its percent forward.
        &mut |report: ImportProgress| {
            let _ = app.emit(YOMITAN_IMPORT_PROGRESS_EVENT, report);
            let _ = app.emit_to(MAIN_WINDOW_LABEL, YOMITAN_IMPORT_PROGRESS_EVENT, report);
        },
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

/// Headwords matching MANY terms at once — the deinflection batch a scan produces.
///
/// One IPC crossing for the whole batch: a scan of 「食べた」 asks for a dozen
/// candidates, and one command per candidate would be a dozen crossings per
/// pointer move.
///
/// `matchType` defaults to `exact` (what a scan uses); see
/// [`yomitan::find_terms_bulk`] for what each mode answers.
#[tauri::command]
async fn yomitan_find_terms_bulk(
    state: State<'_, YomitanDbState>,
    terms: Vec<String>,
    match_type: Option<TermMatchType>,
    limit: Option<u32>,
) -> Result<Vec<BulkTermEntry>, String> {
    with_yomitan_db!(state, |conn| {
        yomitan::find_terms_bulk(conn, &terms, match_type.unwrap_or_default(), limit)
    })
}

/// Term metadata (frequency / pitch / IPA) for MANY terms at once.
#[tauri::command]
async fn yomitan_find_term_meta_bulk(
    state: State<'_, YomitanDbState>,
    terms: Vec<String>,
) -> Result<Vec<TermMetaEntry>, String> {
    with_yomitan_db!(state, |conn| yomitan::find_term_meta_bulk(conn, &terms))
}

/// Kanji entries for MANY characters at once.
#[tauri::command]
async fn yomitan_find_kanji_bulk(
    state: State<'_, YomitanDbState>,
    characters: Vec<String>,
) -> Result<Vec<BulkKanjiEntry>, String> {
    with_yomitan_db!(state, |conn| yomitan::find_kanji_bulk(conn, &characters))
}

/// Tag definitions for MANY `{query, dictionary}` requests at once (part-of-speech
/// names, frequency labels, kanji stat names).
#[tauri::command]
async fn yomitan_find_tags_bulk(
    state: State<'_, YomitanDbState>,
    items: Vec<TagQuery>,
) -> Result<Vec<BulkTagEntry>, String> {
    with_yomitan_db!(state, |conn| yomitan::find_tags_bulk(conn, &items))
}

#[tauri::command]
async fn yomitan_find_kanji(
    state: State<'_, YomitanDbState>,
    character: String,
) -> Result<Option<KanjiEntry>, String> {
    with_yomitan_db!(state, |conn| yomitan::find_kanji(conn, &character))
}

/// Bytes the dictionary database holds on disk, plus what its volume still has
/// available — the number the settings storage meter shows.
///
/// A command rather than something the renderer measures: the banks live in a
/// Rust-owned SQLite file, invisible to `navigator.storage.estimate()`, which
/// reports 0 for the origin however many gigabytes were imported.
#[tauri::command]
async fn yomitan_get_storage_usage<R: Runtime>(
    app: AppHandle<R>,
) -> Result<StorageUsageSnapshot, String> {
    let dir = resolve_dictionary_db_dir(&app)?;
    tauri::async_runtime::spawn_blocking(move || yomitan::storage_usage(&dir))
        .await
        .map_err(|err| format!("dictionary task failed: {err}"))
}

/// Resolve `app_data_dir/yomitan-dictionaries.db` and register state at startup.
fn resolve_dictionary_db_dir<R: Runtime>(app: &tauri::AppHandle<R>) -> Result<PathBuf, String> {
    app.path()
        .app_data_dir()
        .map_err(|e| format!("failed to resolve app_data_dir: {e}"))
}

fn resolve_dictionary_db_path<R: Runtime>(app: &tauri::AppHandle<R>) -> Result<PathBuf, String> {
    Ok(resolve_dictionary_db_dir(app)?.join(yomitan::DATABASE_FILE_NAME))
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
            yomitan_find_terms_bulk,
            yomitan_find_term_meta_bulk,
            yomitan_find_kanji_bulk,
            yomitan_find_tags_bulk,
            yomitan_find_kanji,
            yomitan_get_storage_usage,
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