//! Native clients for the Jimaku and Nadeshiko APIs.
//!
//! API keys are supplied per request and are never persisted or included in
//! diagnostics. Yomitan and AnkiDroid remain outside this plugin's scope.

pub mod jimaku;
pub mod nadeshiko;

use tauri::plugin::{Builder, TauriPlugin};
use tauri::Runtime;

pub use jimaku::{JimakuEntry, JimakuError, JimakuErrorKind, JimakuFile, JimakuResult};
pub use nadeshiko::{
    NadeshikoContextOptions, NadeshikoError, NadeshikoErrorKind, NadeshikoQuota,
    NadeshikoSearchOptions, NadeshikoSearchPage, NadeshikoSegment, NadeshikoSegmentContextResponse,
    NadeshikoSegmentUrls, NadeshikoUser, NadeshikoUserMe,
};

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

pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("modules")
        .invoke_handler(tauri::generate_handler![
            modules_jimaku_search_entries,
            modules_jimaku_search_entries_combined,
            modules_jimaku_entry_files,
            modules_jimaku_download_subtitle,
            modules_nadeshiko_search,
            modules_nadeshiko_segment_context,
            modules_nadeshiko_user_me
        ])
        .build()
}
