//! `tauri-plugin-torrent`
//!
//! Decoupled BitTorrent bridge for Entei, backed by an in-process
//! [`librqbit::Session`]. Four commands are exposed:
//!
//! - `add_torrent(magnet_uri)` -> validates the magnet URI, adds it to the
//!   shared session, waits (bounded) for metadata resolution and returns the
//!   plugin torrent id plus the discovered file list.
//! - `get_torrent_status(id)` -> progress, download speed, peer count and a
//!   `playable` flag for a previously added torrent.
//! - `select_torrent_files(id, video_index, subtitle_index)` -> restricts the
//!   download to the chosen files (`only_files`), waits (bounded) for the
//!   video's first byte and returns loopback relay URLs for playback (see
//!   [`relay`]).
//! - `cancel_torrent(id)` -> removes the torrent from the session and drops the
//!   in-memory handle. Downloaded files are kept on disk.
//!
//! The session is created lazily on the first `add_torrent` call and lives for
//! the lifetime of the app. One session is shared by every torrent so the DHT
//! node, TCP listener and peer cache are reused.

mod relay;

use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::sync::{Arc, Mutex as StdMutex};
use std::time::Duration;

use librqbit::api::TorrentIdOrHash;
use librqbit::{AddTorrent, AddTorrentOptions, Session, TorrentStatsState};
use serde::{Deserialize, Serialize};
use tauri::plugin::{Builder, TauriPlugin};
use tauri::{Manager, Runtime};
use tokio::io::AsyncReadExt;
use tokio::sync::Mutex;

/// Upper bound on waiting for magnet metadata (peer discovery + info dict).
/// Metadata can take a while on a cold DHT; timing out is not an error, the
/// torrent keeps resolving in the background and the file list stays empty
/// until a later `get_torrent_status` call.
const METADATA_TIMEOUT: Duration = Duration::from_secs(30);

/// Upper bound on waiting for the selected video file's first byte before the
/// relay URL is handed to the player. Mirrors the companion handoff contract:
/// a `<video>` opened over a file whose container header is still missing
/// stalls (and Chrome gives up after ~30 s), so the wait stays inside the
/// modal's loading state instead.
const FIRST_BYTE_TIMEOUT: Duration = Duration::from_secs(20);

/// `librqbit` does not re-export its `ManagedTorrentHandle` alias, so the same
/// `Arc<ManagedTorrent>` is spelled out here.
type TorrentHandle = Arc<librqbit::ManagedTorrent>;

#[derive(Debug, thiserror::Error)]
pub enum TorrentError {
    #[error("invalid magnet uri: {0}")]
    InvalidMagnet(String),
    #[error("torrent session unavailable: {0}")]
    Session(String),
    #[error("unknown torrent id: {0}")]
    UnknownTorrent(String),
    #[error("torrent operation failed: {0}")]
    Operation(String),
}

impl TorrentError {
    fn message(&self) -> String {
        self.to_string()
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TorrentFile {
    /// Index inside the torrent; this is what `only_files` expects.
    pub index: usize,
    /// Path relative to the torrent root.
    pub path: String,
    pub length: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AddTorrentResult {
    /// Plugin-level handle used by `get_torrent_status` / `cancel_torrent`.
    pub id: String,
    pub info_hash: String,
    pub name: String,
    /// Empty when metadata was not resolved within `METADATA_TIMEOUT`.
    pub files: Vec<TorrentFile>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TorrentStatus {
    pub id: String,
    pub info_hash: String,
    pub name: String,
    /// `initializing` | `live` | `paused` | `error`.
    pub state: String,
    pub progress_bytes: u64,
    pub total_bytes: u64,
    /// 0.0 - 100.0. `0.0` while total size is unknown.
    pub progress_percent: f64,
    /// MiB/s reported by librqbit.
    pub download_speed_mbps: f64,
    pub peers_live: usize,
    pub finished: bool,
    /// `true` once the torrent finished, or once it is live with at least some
    /// bytes on disk. Note: this is a coarse signal — it does not guarantee the
    /// first video file's header is present yet.
    pub playable: bool,
    pub error: Option<String>,
    pub files: Vec<TorrentFile>,
}

/// Result of `select_torrent_files`: the loopback URLs the player can mount.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SelectedTorrentFiles {
    /// `http://127.0.0.1:<port>/stream/<session>` for the selected video.
    pub video_url: String,
    /// Basename of the selected video (display name, never a full path).
    pub video_name: String,
    pub video_length: u64,
    /// Loopback URL for the selected subtitle file, when one was chosen.
    pub subtitle_url: Option<String>,
    pub subtitle_name: Option<String>,
}

struct Entry {
    torrent_id: usize,
    handle: TorrentHandle,
}

pub struct TorrentState {
    download_dir: PathBuf,
    session: Mutex<Option<Arc<Session>>>,
    entries: StdMutex<HashMap<String, Entry>>,
}

impl TorrentState {
    fn new(download_dir: PathBuf) -> Self {
        Self {
            download_dir,
            session: Mutex::new(None),
            entries: StdMutex::new(HashMap::new()),
        }
    }

    /// Current session handle, if the session was already started.
    async fn session_opt(&self) -> Option<Arc<Session>> {
        self.session.lock().await.clone()
    }

    /// Lazily start the shared librqbit session.
    async fn session(&self) -> Result<Arc<Session>, TorrentError> {
        let mut guard = self.session.lock().await;
        if let Some(session) = guard.as_ref() {
            return Ok(session.clone());
        }
        let session = Session::new(self.download_dir.clone())
            .await
            .map_err(|err| TorrentError::Session(format!("{err:#}")))?;
        *guard = Some(session.clone());
        Ok(session)
    }

    fn entry(&self, id: &str) -> Result<(usize, TorrentHandle), TorrentError> {
        let entries = self
            .entries
            .lock()
            .map_err(|_| TorrentError::Operation("torrent registry poisoned".into()))?;
        entries
            .get(id)
            .map(|entry| (entry.torrent_id, entry.handle.clone()))
            .ok_or_else(|| TorrentError::UnknownTorrent(id.to_string()))
    }
}

fn validate_magnet(uri: &str) -> Result<&str, TorrentError> {
    let trimmed = uri.trim();
    if trimmed.is_empty() {
        return Err(TorrentError::InvalidMagnet("empty uri".into()));
    }
    if !trimmed.starts_with("magnet:?") {
        return Err(TorrentError::InvalidMagnet(trimmed.to_string()));
    }
    if !trimmed.contains("xt=urn:btih:") {
        return Err(TorrentError::InvalidMagnet(
            "missing xt=urn:btih infohash".into(),
        ));
    }
    Ok(trimmed)
}

fn collect_files(handle: &TorrentHandle) -> Vec<TorrentFile> {
    let loaded = handle.metadata.load();
    let Some(metadata) = loaded.as_ref() else {
        return Vec::new();
    };
    metadata
        .file_infos
        .iter()
        .enumerate()
        .map(|(index, file)| TorrentFile {
            index,
            path: file.relative_filename.to_string_lossy().into_owned(),
            length: file.len,
        })
        .collect()
}

/// Last path segment of a torrent file path (display name only).
fn file_basename(path: &str) -> String {
    path.rsplit(['/', '\\']).next().unwrap_or(path).to_string()
}

/// Content type for the relay response, derived from the file extension.
fn mime_for_path(path: &str) -> &'static str {
    let extension = match path.rsplit_once('.') {
        Some((_, extension)) => extension.to_ascii_lowercase(),
        None => return "application/octet-stream",
    };
    match extension.as_str() {
        "mkv" => "video/x-matroska",
        "mp4" | "m4v" => "video/mp4",
        "webm" => "video/webm",
        "ts" | "m2ts" => "video/mp2t",
        "mov" => "video/quicktime",
        "avi" => "video/x-msvideo",
        "ogv" => "video/ogg",
        "mp3" => "audio/mpeg",
        "m4a" => "audio/mp4",
        "aac" => "audio/aac",
        "flac" => "audio/flac",
        "ogg" | "opus" => "audio/ogg",
        "wav" => "audio/wav",
        "vtt" => "text/vtt; charset=utf-8",
        "srt" | "ass" | "ssa" | "sub" | "txt" => "text/plain; charset=utf-8",
        _ => "application/octet-stream",
    }
}

/// Wait (bounded) until the file's first byte is on disk.
///
/// A `FileStream` read on a missing piece parks until the piece arrives, so a
/// one-byte read is the cheapest exact "container header is here" probe. A
/// timeout is not an error: the relay URL stays valid and the player simply
/// waits a little longer on its first range request.
async fn wait_first_byte(handle: &TorrentHandle, file_id: usize) {
    let Ok(mut stream) = handle.clone().stream(file_id) else {
        return;
    };
    if stream.len() == 0 {
        return;
    }
    let mut probe = [0u8; 1];
    let _ = tokio::time::timeout(FIRST_BYTE_TIMEOUT, stream.read(&mut probe)).await;
}

fn state_label(state: &TorrentStatsState) -> String {
    match state {
        TorrentStatsState::Initializing => "initializing",
        TorrentStatsState::Live => "live",
        TorrentStatsState::Paused => "paused",
        TorrentStatsState::Error => "error",
    }
    .to_string()
}

fn status_of(id: &str, handle: &TorrentHandle) -> TorrentStatus {
    let stats = handle.stats();
    let live = stats.live.as_ref();
    let download_speed_mbps = live.map(|l| l.download_speed.mbps).unwrap_or(0.0);
    let peers_live = live.map(|l| l.snapshot.peer_stats.live).unwrap_or(0);
    let progress_percent = if stats.total_bytes == 0 {
        0.0
    } else {
        stats.progress_bytes as f64 / stats.total_bytes as f64 * 100.0
    };
    let live_state = matches!(
        stats.state,
        TorrentStatsState::Live | TorrentStatsState::Paused
    );
    let playable = stats.finished || (live_state && stats.progress_bytes > 0);

    TorrentStatus {
        id: id.to_string(),
        info_hash: handle.info_hash().as_string(),
        name: handle.name().unwrap_or_default(),
        state: state_label(&stats.state),
        progress_bytes: stats.progress_bytes,
        total_bytes: stats.total_bytes,
        progress_percent,
        download_speed_mbps,
        peers_live,
        finished: stats.finished,
        playable,
        error: stats.error.clone(),
        files: collect_files(handle),
    }
}

#[tauri::command]
async fn add_torrent(
    state: tauri::State<'_, TorrentState>,
    magnet_uri: String,
) -> Result<AddTorrentResult, String> {
    let uri = validate_magnet(&magnet_uri).map_err(|err| err.message())?;
    let session = state.session().await.map_err(|err| err.message())?;

    let response = session
        .add_torrent(
            AddTorrent::from_url(uri.to_string()),
            Some(AddTorrentOptions {
                overwrite: true,
                ..Default::default()
            }),
        )
        .await
        .map_err(|err| TorrentError::Operation(format!("{err:#}")).message())?;

    let handle = response.into_handle().ok_or_else(|| {
        TorrentError::Operation("torrent was only listed, not started".into()).message()
    })?;

    // Best-effort metadata wait: a cold DHT may need longer than the timeout.
    let _ = tokio::time::timeout(METADATA_TIMEOUT, handle.wait_until_initialized()).await;

    let torrent_id = handle.id();
    let id = torrent_id.to_string();

    {
        let mut entries = state
            .entries
            .lock()
            .map_err(|_| TorrentError::Operation("torrent registry poisoned".into()).message())?;
        entries.insert(
            id.clone(),
            Entry {
                torrent_id,
                handle: handle.clone(),
            },
        );
    }

    Ok(AddTorrentResult {
        id,
        info_hash: handle.info_hash().as_string(),
        name: handle.name().unwrap_or_default(),
        files: collect_files(&handle),
    })
}

#[tauri::command]
async fn get_torrent_status(
    state: tauri::State<'_, TorrentState>,
    id: String,
) -> Result<TorrentStatus, String> {
    let (_, handle) = state.entry(&id).map_err(|err| err.message())?;
    Ok(status_of(&id, &handle))
}

#[tauri::command]
async fn cancel_torrent(state: tauri::State<'_, TorrentState>, id: String) -> Result<(), String> {
    let (torrent_id, handle) = state.entry(&id).map_err(|err| err.message())?;

    let session = {
        let guard = state.session.lock().await;
        guard.clone()
    };

    if let Some(session) = session {
        // Pause first so no new pieces are written while the torrent is removed.
        let _ = session.pause(&handle).await;
        // Keep the downloaded files; only the session state is cleaned up.
        session
            .delete(TorrentIdOrHash::Id(torrent_id), false)
            .await
            .map_err(|err| TorrentError::Operation(format!("{err:#}")).message())?;
    }

    let mut entries = state
        .entries
        .lock()
        .map_err(|_| TorrentError::Operation("torrent registry poisoned".into()).message())?;
    entries.remove(&id);
    drop(entries);

    // Drop the torrent's relay URLs too: the handles are gone, so they would
    // only answer 503 while still occupying a relay session slot.
    if let Some(relay) = relay::existing() {
        relay.unregister_torrent(&id);
    }

    Ok(())
}

/// Restrict the torrent to the chosen files and hand back loopback URLs.
///
/// `video_index`/`subtitle_index` are the `TorrentFile.index` values from
/// `add_torrent`/`get_torrent_status` (the metadata file index, which is what
/// librqbit's `only_files` expects). The command returns only when the video's
/// first byte is present (bounded by [`FIRST_BYTE_TIMEOUT`]) so the player
/// never opens a `<video>` over a file whose header is still missing.
#[tauri::command]
async fn select_torrent_files(
    state: tauri::State<'_, TorrentState>,
    id: String,
    video_index: usize,
    subtitle_index: Option<usize>,
) -> Result<SelectedTorrentFiles, String> {
    let (_, handle) = state.entry(&id).map_err(|err| err.message())?;
    let files = collect_files(&handle);

    let unknown = || TorrentError::Operation("unknown file index".into()).message();
    let video = files
        .iter()
        .find(|file| file.index == video_index)
        .cloned()
        .ok_or_else(unknown)?;
    let subtitle = match subtitle_index {
        Some(index) => Some(
            files
                .iter()
                .find(|file| file.index == index)
                .cloned()
                .ok_or_else(unknown)?,
        ),
        None => None,
    };

    // Restrict the download to the two selected files. Best effort: if the
    // update is rejected the stream still serves correctly, the torrent just
    // downloads more than the player needs.
    let mut only_files: HashSet<usize> = HashSet::new();
    only_files.insert(video.index);
    if let Some(subtitle) = &subtitle {
        only_files.insert(subtitle.index);
    }
    if let Some(session) = state.session_opt().await {
        let _ = session.update_only_files(&handle, &only_files).await;
    }

    wait_first_byte(&handle, video.index).await;

    let relay = relay::ensure().await?;
    // Re-selecting a file in the same torrent replaces its streams: drop the
    // previous relay sessions first, otherwise dead URLs keep occupying slots
    // and can trigger oldest-first eviction of the stream we are about to
    // hand back.
    relay.unregister_torrent(&id);
    let video_url = relay.register(&id, handle.clone(), video.index, mime_for_path(&video.path));
    let subtitle_url = subtitle
        .as_ref()
        .map(|file| relay.register(&id, handle.clone(), file.index, mime_for_path(&file.path)));

    Ok(SelectedTorrentFiles {
        video_url,
        video_name: file_basename(&video.path),
        video_length: video.length,
        subtitle_url,
        subtitle_name: subtitle.as_ref().map(|file| file_basename(&file.path)),
    })
}

/// Resolve the on-disk directory torrents are written to.
///
/// `librqbit` keeps a bbolt database next to the pieces and mmap on a Ramdisk
/// fails, which stalls the download completely, so the OS temp dir must never
/// be used as a fallback. On Windows we fall back to the same persistent
/// location the EizouDendenshi companion uses; on other platforms we return an
/// explicit error instead of silently degrading.
fn resolve_download_dir<R: Runtime>(
    app: &tauri::AppHandle<R>,
) -> Result<PathBuf, Box<dyn std::error::Error>> {
    if let Ok(dir) = app.path().app_local_data_dir() {
        return Ok(dir.join("torrent"));
    }

    if cfg!(windows) {
        if let Some(local_app_data) = std::env::var_os("LOCALAPPDATA") {
            let root = PathBuf::from(local_app_data);
            if !root.as_os_str().is_empty() {
                return Ok(root
                    .join("GoRakuDo")
                    .join("EizouDendenshi")
                    .join("torrents"));
            }
        }
    }

    Err(TorrentError::Session(
        "could not resolve a persistent download directory (app_local_data_dir failed)".into(),
    )
    .into())
}

pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("torrent")
        .invoke_handler(tauri::generate_handler![
            add_torrent,
            get_torrent_status,
            select_torrent_files,
            cancel_torrent
        ])
        .setup(|app, _api| {
            let download_dir = resolve_download_dir(app)?;
            std::fs::create_dir_all(&download_dir)?;
            app.manage(TorrentState::new(download_dir));
            Ok(())
        })
        .build()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_invalid_magnets() {
        assert!(validate_magnet("").is_err());
        assert!(validate_magnet("https://example.com/a.torrent").is_err());
        assert!(validate_magnet("magnet:?dn=no-infohash").is_err());
        assert!(
            validate_magnet("magnet:?xt=urn:btih:cab507494d02ebb1178b38f2e9d7be299c86b862").is_ok()
        );
    }

    #[test]
    fn maps_states_to_labels() {
        assert_eq!(
            state_label(&TorrentStatsState::Initializing),
            "initializing"
        );
        assert_eq!(state_label(&TorrentStatsState::Live), "live");
        assert_eq!(state_label(&TorrentStatsState::Paused), "paused");
        assert_eq!(state_label(&TorrentStatsState::Error), "error");
    }
}
