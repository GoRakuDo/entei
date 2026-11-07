//! `tauri-plugin-torrent`
//!
//! Decoupled BitTorrent bridge for Entei, backed by an in-process
//! [`librqbit::Session`]. Five commands are exposed:
//!
//! - `add_torrent(magnet_uri)` -> validates the magnet URI, resolves the
//!   metadata with `list_only` and returns the plugin torrent id plus the file
//!   list. **Nothing is written to disk and nothing is downloaded** except the
//!   info dictionary itself (a few KB): the torrent is never added to the
//!   session at this point, so a 67 GB multi-file torrent costs only its
//!   metadata while the user browses the file table.
//! - `get_torrent_status(id)` -> progress, download speed, peer count and a
//!   `playable` flag. A metadata-only entry reports state `metadata`.
//! - `select_torrent_files(id, video_index, subtitle_index)` -> *this* is where
//!   the download starts: the torrent is added to the session from the stored
//!   torrent bytes with `only_files` set to the chosen video (and subtitle), so
//!   every other file stays untouched. It then waits (bounded) for the video's
//!   first byte and returns loopback relay URLs for playback (see [`relay`]).
//!   The response also carries the Matroska track list and the auto-selected
//!   Japanese audio/subtitle track numbers.
//! - `inspect_torrent_tracks(id, file_index)` -> re-reads the container header
//!   on demand and returns the same track report on its own.
//! - `cancel_torrent(id)` -> removes the torrent from the session and deletes
//!   the files it wrote (they are streaming cache inside the app's own download
//!   folder, never user media), so a cancelled or finished session leaves no
//!   partial data behind.
//!
//! The session is created lazily on the first `add_torrent` call and lives for
//! the lifetime of the app. One session is shared by every torrent so the DHT
//! node, TCP listener and peer cache are reused.
//!
//! Cache lifecycle: the download folder (`app_cache_dir()/torrent`, i.e.
//! `<app data>/cache/torrent` on Android and `%LOCALAPPDATA%\<identifier>\torrent`
//! on Windows) only ever holds pieces this plugin wrote. It is emptied on app
//! startup, on app exit and on `cancel_torrent`, so no streaming artifact
//! survives a session. The startup sweep also reclaims the older
//! `app_local_data_dir()/torrent` location once, so an upgrade from a build that
//! cached there does not leave its partial pieces behind forever.

mod mkv;
mod relay;

pub use mkv::{MkvTrackInfo, MkvTrackReport};

use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex as StdMutex};
use std::time::Duration;

use bytes::Bytes;
use librqbit::api::TorrentIdOrHash;
use librqbit::{
    AddTorrent, AddTorrentOptions, AddTorrentResponse, ByteBufOwned, Session,
    TorrentMetaV1Info, TorrentStatsState,
};
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

/// Shared wall-clock budget for the "make the selected file playable" gate
/// (`wait_until_initialized` → streamable → first byte on disk).
///
/// The steps used to carry separate timeouts (20 s + 30 s + 20 s), so a stalled
/// torrent could keep the modal spinner alive for 80 s. They now share this one
/// deadline — the wait the user actually sits through has a single ceiling.
///
/// Why the gate exists: the relay answers `503` while the torrent is still
/// `Initializing` (its `stream()` bails with "invalid state"), a browser media
/// element does not retry a `503` (Chrome stops with error code 4 and never
/// recovers), and a `<video>` opened over a file whose container header is still
/// missing stalls until Chrome gives up (~30 s). The URL therefore must not
/// leave the plugin before the file is streamable and its first byte is on disk.
const STREAM_READY_TIMEOUT: Duration = Duration::from_secs(20);

/// Total wall-clock budget for `select_torrent_files`: the readiness gate above
/// plus the bounded MKV track inspection that follows it. The command never
/// takes longer than this, so the modal's loading state has a hard ceiling.
const SELECT_READY_TIMEOUT: Duration = Duration::from_secs(30);

/// Backoff between streamability probes (cheap: one `stream()` + immediate
/// drop, no piece is requested).
const STREAM_READY_POLL: Duration = Duration::from_millis(200);

/// Bytes of the container header read for track inspection.
///
/// Matroska puts `Tracks` before the first `Cluster`, so a few hundred KiB is
/// normally enough; the cap keeps the read bounded even on a malformed file.
const HEADER_READ_LIMIT: usize = 2 * 1024 * 1024;

/// Read granularity while pulling the header. Each chunk is parsed again, so a
/// short header costs one read instead of a full 2 MiB.
const HEADER_READ_CHUNK: usize = 64 * 1024;

/// Upper bound on the whole header inspection. Pieces that have not arrived yet
/// park the read, so the wait is capped instead of blocking the command.
const HEADER_READ_TIMEOUT: Duration = Duration::from_secs(10);

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
    /// Matroska track list of the selected video, when its header was readable
    /// within [`HEADER_READ_TIMEOUT`]. Empty/`None` for non-Matroska files.
    pub mkv_tracks: Option<Vec<MkvTrackInfo>>,
    /// Japanese audio track number chosen by the `--alang=ja,jpn` rule.
    pub selected_audio_track: Option<u32>,
    /// Japanese subtitle track number chosen by the `--slang=ja,jpn` rule.
    pub selected_subtitle_track: Option<u32>,
}

/// Metadata resolved with `list_only`: nothing was written to disk yet.
#[derive(Clone)]
struct PendingTorrent {
    info_hash: String,
    name: String,
    files: Vec<TorrentFile>,
    /// The `.torrent` bytes rebuilt from the resolved info dictionary. Adding
    /// from these bytes starts the download without a second metadata fetch.
    torrent_bytes: Bytes,
}

/// What the plugin knows about one `add_torrent` call.
#[derive(Clone)]
enum Entry {
    /// Metadata resolved only: the torrent was never added to the session, so
    /// no file, folder or piece exists on disk yet.
    Pending(PendingTorrent),
    /// Added to the session and restricted to the files the user selected.
    Active {
        torrent_id: usize,
        handle: TorrentHandle,
    },
}

pub struct TorrentState {
    download_dir: PathBuf,
    session: Mutex<Option<Arc<Session>>>,
    entries: StdMutex<HashMap<String, Entry>>,
    /// Monotonic plugin-level id source. Kept separate from librqbit's torrent
    /// id because a metadata-only entry has no torrent id yet.
    next_id: AtomicU64,
}

impl TorrentState {
    fn new(download_dir: PathBuf) -> Self {
        Self {
            download_dir,
            session: Mutex::new(None),
            entries: StdMutex::new(HashMap::new()),
            next_id: AtomicU64::new(0),
        }
    }

    fn next_id(&self) -> String {
        format!("torrent-{}", self.next_id.fetch_add(1, Ordering::Relaxed))
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

    fn entries_lock(
        &self,
    ) -> Result<std::sync::MutexGuard<'_, HashMap<String, Entry>>, TorrentError> {
        self.entries
            .lock()
            .map_err(|_| TorrentError::Operation("torrent registry poisoned".into()))
    }

    /// Snapshot of one entry (both variants are cheap to clone).
    fn entry(&self, id: &str) -> Result<Entry, TorrentError> {
        self.entries_lock()?
            .get(id)
            .cloned()
            .ok_or_else(|| TorrentError::UnknownTorrent(id.to_string()))
    }

    /// Remove one entry, returning what it was.
    fn take_entry(&self, id: &str) -> Result<Entry, TorrentError> {
        self.entries_lock()?
            .remove(id)
            .ok_or_else(|| TorrentError::UnknownTorrent(id.to_string()))
    }

    fn insert_pending(&self, id: String, pending: PendingTorrent) -> Result<(), TorrentError> {
        self.entries_lock()?.insert(id, Entry::Pending(pending));
        Ok(())
    }

    /// Promote a metadata-only entry to a live one after the download started.
    ///
    /// Any other plugin id that already pointed at the same librqbit torrent is
    /// dropped: one torrent must have exactly one owning entry, otherwise
    /// cancelling the stale id would delete the files the live one is streaming.
    fn set_active(
        &self,
        id: &str,
        torrent_id: usize,
        handle: TorrentHandle,
    ) -> Result<(), TorrentError> {
        let mut entries = self.entries_lock()?;
        entries.retain(|other_id, entry| {
            other_id == id
                || !matches!(entry, Entry::Active { torrent_id: other, .. } if *other == torrent_id)
        });
        entries.insert(
            id.to_string(),
            Entry::Active {
                torrent_id,
                handle,
            },
        );
        Ok(())
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

/// Flatten a resolved info dictionary into the file list the UI shows.
///
/// The enumeration order matches librqbit's own file indices, which is exactly
/// what `only_files` expects later, so the indices stay valid from the
/// metadata-only reply through `select_torrent_files`.
fn files_from_info(
    info: &TorrentMetaV1Info<ByteBufOwned>,
) -> Result<Vec<TorrentFile>, TorrentError> {
    let details = info
        .iter_file_details()
        .map_err(|err| TorrentError::Operation(format!("{err:#}")))?;
    let mut files = Vec::new();
    for (index, detail) in details.enumerate() {
        // Components are joined with `/` so the path shape is identical on
        // every platform; the UI normalizes both separators anyway.
        let path = detail
            .filename
            .to_vec()
            .map_err(|err| TorrentError::Operation(format!("{err:#}")))?
            .join("/");
        files.push(TorrentFile {
            index,
            path,
            length: detail.len,
        });
    }
    Ok(files)
}

/// Display name of a resolved torrent (never a full path).
fn name_from_info(info: &TorrentMetaV1Info<ByteBufOwned>) -> String {
    info.name
        .as_ref()
        .map(|name| String::from_utf8_lossy(name.as_ref()).into_owned())
        .unwrap_or_default()
}

/// Look up one file by its metadata index.
fn find_file(files: &[TorrentFile], index: usize) -> Result<TorrentFile, TorrentError> {
    files
        .iter()
        .find(|file| file.index == index)
        .cloned()
        .ok_or_else(|| TorrentError::Operation("unknown file index".into()))
}

/// Status of a torrent whose metadata is resolved but which was not started.
///
/// `total_bytes` stays 0 on purpose: nothing is scheduled for download yet, so
/// any progress figure would be a lie until the user picks files.
fn pending_status(id: &str, pending: &PendingTorrent) -> TorrentStatus {
    TorrentStatus {
        id: id.to_string(),
        info_hash: pending.info_hash.clone(),
        name: pending.name.clone(),
        state: "metadata".to_string(),
        progress_bytes: 0,
        total_bytes: 0,
        progress_percent: 0.0,
        download_speed_mbps: 0.0,
        peers_live: 0,
        finished: false,
        playable: false,
        error: None,
        files: pending.files.clone(),
    }
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

/// Time left before `deadline` (zero once it has passed).
///
/// Every wait in the selection path is bounded by a shared deadline instead of
/// its own timeout, so a slow step cannot hand the player a spinner that keeps
/// turning past [`SELECT_READY_TIMEOUT`].
fn remaining(deadline: tokio::time::Instant) -> Duration {
    deadline.saturating_duration_since(tokio::time::Instant::now())
}

/// Wait (bounded) until the file's first byte is on disk.
///
/// A `FileStream` read on a missing piece parks until the piece arrives, so a
/// one-byte read is the cheapest exact "container header is here" probe. A
/// timeout is not an error: the relay URL stays valid and the player simply
/// waits a little longer on its first range request.
async fn wait_first_byte(handle: &TorrentHandle, file_id: usize, deadline: tokio::time::Instant) {
    let Ok(mut stream) = handle.clone().stream(file_id) else {
        return;
    };
    if stream.len() == 0 {
        return;
    }
    let budget = remaining(deadline);
    if budget.is_zero() {
        return;
    }
    let mut probe = [0u8; 1];
    let _ = tokio::time::timeout(budget, stream.read(&mut probe)).await;
}

/// Wait (bounded) until `file_id` can actually be streamed.
///
/// `add_torrent` hands the handle back while the torrent is still
/// `Initializing`, and [`relay::stream_file`] answers `503` for every request in
/// that window because `stream()` refuses a torrent whose storage is not open
/// ("streams: invalid state"). A `<video>` element does not retry a `503` —
/// Chrome stops with error code 4 and stays dead — so the relay URL must not
/// leave the plugin before the file is streamable.
///
/// The wait is bounded by the caller's shared `deadline`: a torrent that never
/// becomes streamable (no peers, error state, removed while waiting) returns an
/// error instead of handing the player a URL that can only answer `503`. The
/// probe stream is dropped immediately, so it registers nothing with the piece
/// scheduler.
async fn wait_streamable(
    handle: &TorrentHandle,
    file_id: usize,
    deadline: tokio::time::Instant,
) -> Result<(), TorrentError> {
    loop {
        // `stream()` only succeeds once the storage is open and the torrent is
        // live or paused — exactly the state the relay needs. The error text is
        // deliberately dropped: librqbit's message can carry cache paths and no
        // torrent detail may reach the webview.
        if handle.clone().stream(file_id).is_ok() {
            return Ok(());
        }
        // A torrent that went into an error state never becomes streamable;
        // fail now instead of burning the whole budget.
        if handle.stats().error.is_some() {
            return Err(TorrentError::Operation(
                "torrent failed before it could be streamed".into(),
            ));
        }
        if tokio::time::Instant::now() >= deadline {
            return Err(TorrentError::Operation(
                "torrent file did not become streamable in time".into(),
            ));
        }
        tokio::time::sleep(STREAM_READY_POLL).await;
    }
}

/// Is this path a Matroska-family container whose header we can inspect?
fn is_matroska_path(path: &str) -> bool {
    let extension = match path.rsplit_once('.') {
        Some((_, extension)) => extension.to_ascii_lowercase(),
        None => return false,
    };
    matches!(extension.as_str(), "mkv" | "mk3d" | "webm" | "mka" | "mks")
}

/// Read just enough of the file header to list its tracks.
///
/// Every read is bounded twice: by [`HEADER_READ_LIMIT`] bytes and by
/// [`HEADER_READ_TIMEOUT`] wall clock, because a read on a missing piece parks
/// the task. Returns `None` when no `Tracks` element could be parsed in time;
/// playback then simply keeps the engine default track.
async fn read_mkv_track_report(
    handle: &TorrentHandle,
    file_id: usize,
    path: &str,
    deadline: tokio::time::Instant,
) -> Option<MkvTrackReport> {
    if !is_matroska_path(path) {
        return None;
    }
    let mut stream = handle.clone().stream(file_id).ok()?;
    if stream.len() == 0 {
        return None;
    }

    // Never outlive the caller's budget, and never spend more than
    // [`HEADER_READ_TIMEOUT`] on the header itself.
    let deadline = deadline.min(tokio::time::Instant::now() + HEADER_READ_TIMEOUT);
    let mut buffer: Vec<u8> = Vec::with_capacity(HEADER_READ_CHUNK);
    let mut chunk = vec![0u8; HEADER_READ_CHUNK];

    while buffer.len() < HEADER_READ_LIMIT {
        let budget = remaining(deadline);
        if budget.is_zero() {
            break;
        }
        let read = match tokio::time::timeout(budget, stream.read(&mut chunk)).await {
            Ok(Ok(read)) => read,
            _ => break,
        };
        if read == 0 {
            break;
        }
        buffer.extend_from_slice(&chunk[..read]);

        // `Truncated` just means the Tracks payload is not complete yet: keep
        // reading until the limit or the deadline is hit.
        if let Ok(tracks) = mkv::parse_tracks(&buffer) {
            if !tracks.is_empty() {
                return Some(MkvTrackReport::from_tracks(tracks));
            }
        }
    }

    None
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

    // `list_only` resolves the info dictionary and stops there: the torrent is
    // never added to the session, so no file, folder or piece is created on
    // disk. Only the few KB of metadata cross the wire here — a magnet pointing
    // at a 67 GB season must not start downloading while the user is still
    // reading the file table.
    let response = tokio::time::timeout(
        METADATA_TIMEOUT,
        session.add_torrent(
            AddTorrent::from_url(uri.to_string()),
            Some(AddTorrentOptions {
                list_only: true,
                ..Default::default()
            }),
        ),
    )
    .await
    .map_err(|_| {
        TorrentError::Operation("metadata resolution timed out".into()).message()
    })?
    .map_err(|err| TorrentError::Operation(format!("{err:#}")).message())?;

    let listed = match response {
        AddTorrentResponse::ListOnly(listed) => listed,
        // `list_only` returns before the session registers anything, so any
        // other variant means the download started — refuse instead of leaving
        // a running torrent the UI never asked for.
        AddTorrentResponse::Added(_, _) | AddTorrentResponse::AlreadyManaged(_, _) => {
            return Err(TorrentError::Operation(
                "torrent was started instead of listed".into(),
            )
            .message())
        }
    };

    let info_hash = listed.info_hash.as_string();
    let name = name_from_info(&listed.info);
    let files = files_from_info(&listed.info).map_err(|err| err.message())?;

    let id = state.next_id();
    state
        .insert_pending(
            id.clone(),
            PendingTorrent {
                info_hash: info_hash.clone(),
                name: name.clone(),
                files: files.clone(),
                torrent_bytes: listed.torrent_bytes,
            },
        )
        .map_err(|err| err.message())?;

    Ok(AddTorrentResult {
        id,
        info_hash,
        name,
        files,
    })
}

#[tauri::command]
async fn get_torrent_status(
    state: tauri::State<'_, TorrentState>,
    id: String,
) -> Result<TorrentStatus, String> {
    let entry = state.entry(&id).map_err(|err| err.message())?;
    Ok(match &entry {
        Entry::Pending(pending) => pending_status(&id, pending),
        Entry::Active { handle, .. } => status_of(&id, handle),
    })
}

#[tauri::command]
async fn cancel_torrent(state: tauri::State<'_, TorrentState>, id: String) -> Result<(), String> {
    // Take the entry first: whatever happens below, the plugin must not keep
    // pointing at a torrent it can no longer control.
    let entry = state.take_entry(&id).map_err(|err| err.message())?;

    // Drop the torrent's relay URLs too: the handles are going away, so they
    // would only answer 503 while still occupying a relay session slot.
    if let Some(relay) = relay::existing() {
        relay.unregister_torrent(&id);
    }

    let Entry::Active {
        torrent_id,
        handle,
    } = entry
    else {
        // Metadata-only entry: nothing was ever written to disk.
        return Ok(());
    };

    let Some(session) = state.session_opt().await else {
        return Ok(());
    };

    // Pause first so no new pieces are written while the torrent is removed.
    let _ = session.pause(&handle).await;
    // `delete_files: true` removes the streaming cache the plugin itself wrote
    // (inside the app's own download folder) and any folder it left empty. The
    // files are never user media — keeping them would leak tens of GB of
    // partial episodes after every cancel.
    session
        .delete(TorrentIdOrHash::Id(torrent_id), true)
        .await
        .map_err(|err| TorrentError::Operation(format!("{err:#}")).message())?;

    Ok(())
}

/// Start downloading the chosen files and hand back loopback URLs.
///
/// This is the only place a download begins. `video_index`/`subtitle_index` are
/// the `TorrentFile.index` values from `add_torrent` (the metadata file index,
/// which is what librqbit's `only_files` expects). Everything else in the
/// torrent — other episodes, extras, soundtracks — is excluded from the start,
/// so a 67 GB multi-file torrent only ever fetches the selected episode. The
/// command returns only when the video is actually streamable and its first byte
/// is present — all of it inside one shared budget ([`STREAM_READY_TIMEOUT`]),
/// so the relay can never answer `503` to the player's first request and the
/// modal spinner cannot run past [`SELECT_READY_TIMEOUT`] in total.
#[tauri::command]
async fn select_torrent_files(
    state: tauri::State<'_, TorrentState>,
    id: String,
    video_index: usize,
    subtitle_index: Option<usize>,
) -> Result<SelectedTorrentFiles, String> {
    let entry = state.entry(&id).map_err(|err| err.message())?;

    // Metadata-only entries carry the file list in memory; a live entry reads
    // it back from librqbit. Both enumerate in the same order, so the indices
    // the UI holds stay valid across the transition.
    let files = match &entry {
        Entry::Pending(pending) => pending.files.clone(),
        Entry::Active { handle, .. } => collect_files(handle),
    };

    let video = find_file(&files, video_index).map_err(|err| err.message())?;
    let subtitle = match subtitle_index {
        Some(index) => Some(find_file(&files, index).map_err(|err| err.message())?),
        None => None,
    };

    let mut only_files: HashSet<usize> = HashSet::new();
    only_files.insert(video.index);
    if let Some(subtitle) = &subtitle {
        only_files.insert(subtitle.index);
    }

    let session = state.session().await.map_err(|err| err.message())?;
    let handle = match &entry {
        Entry::Pending(pending) => {
            let only: Vec<usize> = only_files.iter().copied().collect();
            let response = session
                .add_torrent(
                    AddTorrent::TorrentFileBytes(pending.torrent_bytes.clone()),
                    Some(AddTorrentOptions {
                        overwrite: true,
                        only_files: Some(only),
                        ..Default::default()
                    }),
                )
                .await
                .map_err(|err| TorrentError::Operation(format!("{err:#}")).message())?;
            let handle = response.into_handle().ok_or_else(|| {
                TorrentError::Operation("torrent was only listed, not started".into()).message()
            })?;
            state
                .set_active(&id, handle.id(), handle.clone())
                .map_err(|err| err.message())?;
            handle
        }
        // Re-selecting files for a torrent that is already live keeps the same
        // handle; the restriction below is what changes.
        Entry::Active { handle, .. } => handle.clone(),
    };

    // `add_torrent` hands the handle back while it is still `Initializing`: the
    // storage is not open yet, so `update_only_files`, `stream()` (the
    // streamability gate and first-byte probe) and the MKV header read would all
    // bail out instantly. Wait for initialization to finish first. This wait is
    // only a shortcut (it resolves early on the usual path); the authoritative
    // gate is `wait_streamable` below.
    //
    // Every wait below shares one deadline: separate timeouts added up to 80 s of
    // spinner on a stalled torrent, which is exactly what the player showed.
    let start = tokio::time::Instant::now();
    let ready_deadline = start + STREAM_READY_TIMEOUT;
    let select_deadline = start + SELECT_READY_TIMEOUT;
    let _ = tokio::time::timeout(remaining(ready_deadline), handle.wait_until_initialized()).await;

    // Best effort: a fresh add already honours `only_files`, and an already
    // live torrent needs the restriction applied now. `unpause` is only worth
    // the tracker re-announce when the torrent really sits paused (librqbit
    // rejects `start` on a live torrent anyway).
    let _ = session.update_only_files(&handle, &only_files).await;
    if handle.is_paused() {
        let _ = session.unpause(&handle).await;
    }

    // The relay URL must not leave the plugin while the torrent is still
    // initializing: the relay would answer `503` and the browser would stop the
    // media element with error code 4 for good (it does not retry). Gate on a
    // streamable file first, and fail loudly instead of handing out a dead URL.
    wait_streamable(&handle, video.index, ready_deadline)
        .await
        .map_err(|err| err.message())?;

    // Now that the storage is open the probe below can actually read; a late
    // header is fine (the relay parks the read until the piece arrives).
    wait_first_byte(&handle, video.index, ready_deadline).await;

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

    // The header bytes are already here (first byte waited above), so listing
    // the container tracks costs no extra wait in the common case.
    let track_report =
        read_mkv_track_report(&handle, video.index, &video.path, select_deadline).await;

    Ok(SelectedTorrentFiles {
        video_url,
        video_name: file_basename(&video.path),
        video_length: video.length,
        subtitle_url,
        subtitle_name: subtitle.as_ref().map(|file| file_basename(&file.path)),
        mkv_tracks: track_report.as_ref().map(|report| report.tracks.clone()),
        selected_audio_track: track_report
            .as_ref()
            .and_then(|report| report.selected_audio),
        selected_subtitle_track: track_report
            .as_ref()
            .and_then(|report| report.selected_subtitle),
    })
}

/// List the Matroska tracks of a torrent file and the auto-selected Japanese
/// audio/subtitle track numbers.
///
/// Returns an empty report (no tracks, no selections) when the file is not a
/// Matroska container, its header did not arrive within the bounded read, or
/// the torrent is still metadata-only (nothing is on disk to inspect yet) —
/// the caller then keeps the engine default track. Only an unknown torrent id
/// or file index is an error.
#[tauri::command]
async fn inspect_torrent_tracks(
    state: tauri::State<'_, TorrentState>,
    id: String,
    file_index: usize,
) -> Result<MkvTrackReport, String> {
    let entry = state.entry(&id).map_err(|err| err.message())?;
    let files = match &entry {
        Entry::Pending(pending) => pending.files.clone(),
        Entry::Active { handle, .. } => collect_files(handle),
    };
    let file = find_file(&files, file_index).map_err(|err| err.message())?;

    let Entry::Active { handle, .. } = entry else {
        // Metadata-only: no bytes on disk, so there is no header to parse.
        return Ok(MkvTrackReport::default());
    };

    Ok(read_mkv_track_report(
        &handle,
        file.index,
        &file.path,
        tokio::time::Instant::now() + HEADER_READ_TIMEOUT,
    )
    .await
    .unwrap_or_default())
}

/// Resolve the on-disk directory torrents are written to.
///
/// This is pure streaming cache: every file in it is written by this plugin and
/// every file in it is deleted again (on cancel, on exit, and on the next
/// startup), so it belongs in the platform cache dir. The resolution stays on
/// Tauri's `PathResolver` so Android (`<app data>/cache`), Windows
/// (`%LOCALAPPDATA%\<identifier>\cache`) and macOS all land in an app-private,
/// writable location instead of a hard-coded Windows path.
///
/// `librqbit` keeps a bbolt database next to the pieces and mmap on a Ramdisk
/// fails, which stalls the download completely, so the OS temp dir must never
/// be used as a fallback. `app_local_data_dir` (and finally the Entei-namespaced
/// Windows directory) are only used when the cache dir cannot be resolved.
fn resolve_download_dir<R: Runtime>(
    app: &tauri::AppHandle<R>,
) -> Result<PathBuf, Box<dyn std::error::Error>> {
    if let Ok(dir) = app.path().app_cache_dir() {
        return Ok(dir.join("torrent"));
    }

    if let Ok(dir) = app.path().app_local_data_dir() {
        return Ok(dir.join("torrent"));
    }

    if cfg!(windows) {
        if let Some(local_app_data) = std::env::var_os("LOCALAPPDATA") {
            let root = PathBuf::from(local_app_data);
            if !root.as_os_str().is_empty() {
                return Ok(root.join("GoRakuDo").join("Entei").join("torrent"));
            }
        }
    }

    Err(TorrentError::Session(
        "could not resolve a writable download directory (cache and local data dirs failed)"
            .into(),
    )
    .into())
}

/// Delete everything inside the plugin's own download folder, keeping the
/// folder itself.
///
/// The folder never contains user media — only pieces this plugin wrote while
/// streaming — so wiping it is always safe. Symlinks are unlinked, not followed,
/// and per-entry errors are reported so one locked file cannot abort the sweep.
fn purge_download_dir(dir: &std::path::Path) -> std::io::Result<()> {
    let entries = match std::fs::read_dir(dir) {
        Ok(entries) => entries,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(err) => return Err(err),
    };
    for entry in entries {
        let entry = entry?;
        let path = entry.path();
        let is_dir = entry.file_type().map(|kind| kind.is_dir()).unwrap_or(false);
        let removed = if is_dir {
            std::fs::remove_dir_all(&path)
        } else {
            std::fs::remove_file(&path)
        };
        // A file still held open by the engine (or a delete-pending entry from
        // a previous pass) must not stop the rest of the cleanup.
        let _ = removed;
    }
    Ok(())
}

pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("torrent")
        .invoke_handler(tauri::generate_handler![
            add_torrent,
            get_torrent_status,
            select_torrent_files,
            inspect_torrent_tracks,
            cancel_torrent
        ])
        .setup(|app, _api| {
            let download_dir = resolve_download_dir(app)?;
            std::fs::create_dir_all(&download_dir)?;
            // Startup sweep: whatever a crash, a force quit or an OS kill left
            // behind is reclaimed before the first torrent can run. The
            // session is lazy, so no storage handle is open at this point.
            let _ = purge_download_dir(&download_dir);
            // Older builds kept the streaming cache under the local data dir.
            // Reclaim that folder once too, otherwise an upgrade leaves tens of
            // GB of partial pieces behind forever.
            if let Ok(legacy_root) = app.path().app_local_data_dir() {
                let legacy_dir = legacy_root.join("torrent");
                if legacy_dir != download_dir {
                    let _ = purge_download_dir(&legacy_dir);
                }
            }
            app.manage(TorrentState::new(download_dir));
            Ok(())
        })
        .on_event(|app, event| {
            if matches!(event, tauri::RunEvent::Exit) {
                // Exit sweep: the app is closing, so the streaming cache has no
                // further use. Best effort — the next startup sweeps again.
                if let Some(state) = app.try_state::<TorrentState>() {
                    let _ = purge_download_dir(&state.download_dir);
                }
            }
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
    fn recognizes_matroska_paths() {
        assert!(is_matroska_path("Show/Episode 01.mkv"));
        assert!(is_matroska_path("EP01.MKV"));
        assert!(is_matroska_path("clip.webm"));
        assert!(!is_matroska_path("Episode 01.mp4"));
        assert!(!is_matroska_path("Episode 01.srt"));
        assert!(!is_matroska_path("mkv"));
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

    fn byte_buf(value: &'static [u8]) -> ByteBufOwned {
        ByteBufOwned(Bytes::from_static(value))
    }

    fn multi_file_info() -> TorrentMetaV1Info<ByteBufOwned> {
        TorrentMetaV1Info {
            name: Some(byte_buf(b"Show")),
            pieces: byte_buf(&[0u8; 20]),
            piece_length: 16384,
            files: Some(vec![
                librqbit::TorrentMetaV1File {
                    length: 1024,
                    path: vec![byte_buf(b"Show"), byte_buf(b"Episode 01.mkv")],
                    attr: None,
                    sha1: None,
                    symlink_path: None,
                },
                librqbit::TorrentMetaV1File {
                    length: 2048,
                    path: vec![byte_buf(b"Show"), byte_buf(b"Episode 01.srt")],
                    attr: None,
                    sha1: None,
                    symlink_path: None,
                },
            ]),
            ..Default::default()
        }
    }

    /// The metadata-only file list must carry the same indices librqbit will
    /// later expect in `only_files`, so `select_torrent_files` can address the
    /// chosen file without ever starting the rest of the torrent.
    #[test]
    fn lists_metadata_files_with_librqbit_indices() {
        let info = multi_file_info();
        let files = files_from_info(&info).expect("file list");
        assert_eq!(files.len(), 2);
        assert_eq!(files[0].index, 0);
        assert_eq!(files[0].path, "Show/Episode 01.mkv");
        assert_eq!(files[0].length, 1024);
        assert_eq!(files[1].index, 1);
        assert_eq!(files[1].path, "Show/Episode 01.srt");
        assert_eq!(name_from_info(&info), "Show");
    }

    #[test]
    fn finds_files_by_index_only() {
        let files = files_from_info(&multi_file_info()).expect("file list");
        assert_eq!(find_file(&files, 1).expect("index 1").path, "Show/Episode 01.srt");
        assert!(find_file(&files, 2).is_err());
    }

    /// A metadata-only entry must never look like it is downloading: the whole
    /// point of the deferred add is that nothing is scheduled yet.
    #[test]
    fn pending_status_reports_no_download() {
        let pending = PendingTorrent {
            info_hash: "abc".into(),
            name: "Show".into(),
            files: files_from_info(&multi_file_info()).expect("file list"),
            torrent_bytes: Bytes::new(),
        };
        let status = pending_status("torrent-0", &pending);
        assert_eq!(status.state, "metadata");
        assert_eq!(status.progress_bytes, 0);
        assert_eq!(status.total_bytes, 0);
        assert_eq!(status.download_speed_mbps, 0.0);
        assert!(!status.playable);
        assert!(!status.finished);
        assert_eq!(status.files.len(), 2);
    }

    /// The startup/exit sweep must empty the plugin's cache dir and keep the dir
    /// itself, so the next session starts from a clean disk.
    #[test]
    fn purges_cache_contents_and_keeps_the_directory() {
        let root = std::env::temp_dir().join(format!(
            "entei-torrent-purge-{}-{:?}",
            std::process::id(),
            std::thread::current().id()
        ));
        let _ = std::fs::remove_dir_all(&root);
        let nested = root.join("Show").join("Season 1");
        std::fs::create_dir_all(&nested).expect("nested dirs");
        std::fs::write(nested.join("Episode 01.mkv"), b"partial").expect("nested file");
        std::fs::write(root.join("stray.part"), b"x").expect("root file");

        purge_download_dir(&root).expect("purge");

        assert!(root.is_dir(), "the cache directory itself must survive");
        assert_eq!(
            std::fs::read_dir(&root).expect("read dir").count(),
            0,
            "every leftover entry must be gone"
        );

        // A missing directory is not an error: cleanup runs before the first
        // torrent and on exit, where the dir may already be gone.
        let _ = std::fs::remove_dir_all(&root);
        assert!(purge_download_dir(&root).is_ok());
    }
}
