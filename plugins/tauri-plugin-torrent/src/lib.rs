//! `tauri-plugin-torrent`
//!
//! Decoupled BitTorrent bridge for Entei, backed by an in-process
//! [`librqbit::Session`]. Five commands are exposed:
//!
//! - `add_torrent(magnet_uri)` -> validates the magnet URI, starts resolving the
//!   metadata with `list_only` and returns the plugin torrent id plus the file
//!   list. **Nothing is written to disk and nothing is downloaded** except the
//!   info dictionary itself (a few KB): the torrent is never added to the
//!   session at this point, so a 67 GB multi-file torrent costs only its
//!   metadata while the user browses the file table. The fetch itself runs in
//!   its own task (see [`resolve_metadata`]), so a cold DHT that needs minutes
//!   to find the swarm cannot fail the command: `add_torrent` waits
//!   [`METADATA_INITIAL_WAIT`] for a warm swarm and otherwise answers with an
//!   empty file list, which `get_torrent_status` fills in once the info
//!   dictionary lands.
//! - `get_torrent_status(id)` -> progress, download speed, peer count and a
//!   `playable` flag. A metadata-only entry reports state `metadata` (with the
//!   file list once resolved), and a resolution that gave up reports state
//!   `error` with the reason.
//! - `select_torrent_files(id, video_index, subtitle_index)` -> *this* is where
//!   the download starts: the torrent is added to the session from the stored
//!   torrent bytes with `only_files` set to the chosen video (and subtitle), so
//!   every other file stays untouched. It then returns loopback relay URLs for
//!   playback (see [`relay`]) **without** gating on the file being streamable
//!   yet: a torrent stays `Initializing` for as long as librqbit's initial piece
//!   check runs, and the relay holds the browser's first range request until
//!   then. The response also carries the Matroska track list and the
//!   auto-selected Japanese audio/subtitle track numbers when the header could
//!   be read inside the scan budget.
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
    AddTorrent, AddTorrentOptions, AddTorrentResponse, ByteBufOwned, Session, TorrentStatsState,
    ValidatedTorrentMetaV1Info,
};
use serde::{Deserialize, Serialize};
use tauri::plugin::{Builder, TauriPlugin};
use tauri::{Manager, Runtime};
use tokio::io::AsyncReadExt;
use tokio::sync::{watch, Mutex};

/// Upper bound on one magnet's metadata resolution (peer discovery + info
/// dictionary fetch), enforced inside the background task.
///
/// A cold DHT routinely needs 30-60 s to find the swarm for a rare torrent, and
/// the previous 30 s ceiling turned those healthy magnets into a hard failure
/// (`metadata resolution timed out`, measured at 30009 ms in the trace log).
/// The fetch now outlives the command that started it, so this budget is the
/// real patience of the feature and the UI polls while it runs.
const METADATA_TIMEOUT: Duration = Duration::from_secs(120);

/// How long `add_torrent` itself waits for the info dictionary before replying.
///
/// A warm swarm answers in well under a second, so the common case still gets
/// the file table in the same reply. Anything slower is handed to
/// `get_torrent_status`: the dialog keeps its metadata skeleton and stays
/// cancellable instead of blocking one IPC call for the whole two minutes.
const METADATA_INITIAL_WAIT: Duration = Duration::from_secs(20);

/// Wall-clock budget for the *best-effort* container-header scan that follows
/// the add in `select_torrent_files`.
///
/// This is no longer a playback gate. It used to be one, and that was the bug:
/// a large torrent (130 GB over 1372 files) spends minutes in librqbit's
/// `Initializing` state while the initial piece check runs, `stream()` refuses
/// every file in that window ("invalid state: initializing"), the bounded wait
/// expired, and the command failed — the Magnet modal then showed a generic
/// "Terjadi kesalahan" toast for a torrent that streams fine 28 ms after
/// initialization lands.
///
/// The readiness gate now lives in [`relay`]: it parks the browser's first range
/// request until the file can be streamed and answers `206` then, so a `503`
/// (which Chrome never retries) can no longer reach the media element. This
/// budget therefore only decides whether the reply can *also* carry the Matroska
/// track list: a torrent that is still initializing gets its URL immediately and
/// the engine keeps its own track auto-selection.
const TRACK_SCAN_TIMEOUT: Duration = Duration::from_secs(20);

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
    /// Empty while the metadata is still resolving; `get_torrent_status` then
    /// carries the file list as soon as the info dictionary arrives.
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

/// Resolution state of one magnet's info dictionary.
///
/// Published through a `watch` channel so the fetch task can hand its outcome
/// to whoever asks next: the command that started it, a later
/// `get_torrent_status` poll, or `select_torrent_files`. The value is read
/// without a lock, and a resolved entry costs one clone.
#[derive(Clone)]
enum Metadata {
    /// Peer discovery / info dictionary fetch is still running.
    Resolving,
    /// Info dictionary resolved; nothing is scheduled for download yet.
    Ready(PendingTorrent),
    /// Resolution gave up (timeout or engine error).
    Failed(String),
}

/// What the plugin knows about one `add_torrent` call.
#[derive(Clone)]
enum Entry {
    /// Metadata only: the torrent was never added to the session, so no file,
    /// folder or piece exists on disk yet. `info_hash` comes from the magnet so
    /// the status reply is useful before the engine reports its own.
    Metadata {
        info_hash: String,
        state: watch::Receiver<Metadata>,
    },
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

    /// Register a metadata entry before its fetch task starts, so the id is
    /// usable (pollable, cancellable) from the first millisecond.
    fn insert_metadata(
        &self,
        id: String,
        info_hash: String,
        state: watch::Receiver<Metadata>,
    ) -> Result<(), TorrentError> {
        self.entries_lock()?
            .insert(id, Entry::Metadata { info_hash, state });
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

/// Infohash carried by the magnet URI itself.
///
/// Used until the engine reports its own spelling, so a torrent that is still
/// resolving already has a stable identity in the status reply and the trace
/// log. Lowercased to match the hex form librqbit returns.
fn magnet_info_hash(uri: &str) -> String {
    uri.split(['?', '&'])
        .find_map(|part| part.strip_prefix("xt=urn:btih:"))
        .unwrap_or_default()
        .to_ascii_lowercase()
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
///
/// librqbit 9 hands back an already validated info dictionary, so the file
/// iterator is infallible here: the paths were checked for traversal and empty
/// components when the torrent was parsed.
fn files_from_info(info: &ValidatedTorrentMetaV1Info<ByteBufOwned>) -> Vec<TorrentFile> {
    let mut files = Vec::new();
    for (index, detail) in info.iter_file_details().enumerate() {
        // Components are joined with `/` so the path shape is identical on
        // every platform; the UI normalizes both separators anyway.
        let path = detail.filename.to_vec().join("/");
        files.push(TorrentFile {
            index,
            path,
            length: detail.len,
        });
    }
    files
}

/// Display name of a resolved torrent (never a full path).
fn name_from_info(info: &ValidatedTorrentMetaV1Info<ByteBufOwned>) -> String {
    info.name().map(|name| name.into_owned()).unwrap_or_default()
}

/// Look up one file by its metadata index.
fn find_file(files: &[TorrentFile], index: usize) -> Result<TorrentFile, TorrentError> {
    files
        .iter()
        .find(|file| file.index == index)
        .cloned()
        .ok_or_else(|| TorrentError::Operation("unknown file index".into()))
}

/// Status of a torrent that has not started downloading: still resolving its
/// metadata, resolved but not scheduled, or given up on.
///
/// `total_bytes` stays 0 on purpose: nothing is scheduled for download yet, so
/// any progress figure would be a lie until the user picks files. `error` is
/// the only non-empty field of a `Failed` entry, which is how the UI learns
/// that a magnet never found its swarm instead of polling forever.
fn metadata_status(id: &str, magnet_info_hash: &str, metadata: &Metadata) -> TorrentStatus {
    let (info_hash, state, name, files, error) = match metadata {
        Metadata::Resolving => (
            magnet_info_hash.to_string(),
            "metadata",
            String::new(),
            Vec::new(),
            None,
        ),
        Metadata::Ready(pending) => (
            pending.info_hash.clone(),
            "metadata",
            pending.name.clone(),
            pending.files.clone(),
            None,
        ),
        Metadata::Failed(message) => (
            magnet_info_hash.to_string(),
            "error",
            String::new(),
            Vec::new(),
            Some(message.clone()),
        ),
    };

    TorrentStatus {
        id: id.to_string(),
        info_hash,
        name,
        state: state.to_string(),
        progress_bytes: 0,
        total_bytes: 0,
        progress_percent: 0.0,
        download_speed_mbps: 0.0,
        peers_live: 0,
        finished: false,
        playable: false,
        error,
        files,
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
/// its own timeout, so a slow step cannot stack onto the next one.
fn remaining(deadline: tokio::time::Instant) -> Duration {
    deadline.saturating_duration_since(tokio::time::Instant::now())
}

/// Wait (bounded) until the file's first byte is on disk.
///
/// A `FileStream` read on a missing piece parks until the piece arrives, so a
/// one-byte read is the cheapest exact "container header is here" probe. A
/// timeout is not an error: the relay URL stays valid and the relay parks the
/// browser's first range request until the piece arrives.
async fn wait_first_byte(handle: &TorrentHandle, file_id: usize, deadline: tokio::time::Instant) {
    let Ok(mut stream) = handle.clone().stream(file_id).await else {
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
    let mut stream = handle.clone().stream(file_id).await.ok()?;
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
        TorrentStatsState::Initializing { .. } => "initializing",
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
    let peers_live = live
        .map(|l| l.snapshot.peer_stats.live as usize)
        .unwrap_or(0);
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

    // The id exists before the fetch starts, so the entry is pollable and
    // cancellable from the first millisecond.
    let id = state.next_id();
    let info_hash = magnet_info_hash(uri);
    let (sender, receiver) = watch::channel(Metadata::Resolving);
    state
        .insert_metadata(id.clone(), info_hash.clone(), receiver.clone())
        .map_err(|err| err.message())?;

    // `list_only` resolves the info dictionary and stops there: the torrent is
    // never added to the session, so no file, folder or piece is created on
    // disk. Only the few KB of metadata cross the wire here — a magnet pointing
    // at a 67 GB season must not start downloading while the user is still
    // reading the file table.
    //
    // The fetch owns the session handle in its own task, so a cold DHT that
    // needs a minute of peer discovery keeps going after this command returns
    // instead of being cancelled with the future that started it.
    let uri_owned = uri.to_string();
    tauri::async_runtime::spawn(async move {
        let outcome = resolve_metadata(&session, &uri_owned).await;
        // A dropped receiver means the dialog was cancelled; nothing was
        // written to disk, so there is nothing else to undo.
        let _ = sender.send(outcome);
    });

    // Short wait so a warm swarm still answers with the file table inline.
    let mut receiver = receiver;
    let _ = tokio::time::timeout(METADATA_INITIAL_WAIT, async {
        loop {
            let resolved = !matches!(&*receiver.borrow(), Metadata::Resolving);
            if resolved {
                break;
            }
            if receiver.changed().await.is_err() {
                break;
            }
        }
    })
    .await;

    let outcome = receiver.borrow().clone();
    match outcome {
        Metadata::Ready(pending) => Ok(AddTorrentResult {
            id,
            info_hash: pending.info_hash,
            name: pending.name,
            files: pending.files,
        }),
        // A failure that arrived inside the wait is still reported as a
        // rejection: the UI shows the reason instead of a polling skeleton.
        Metadata::Failed(error) => {
            let _ = state.take_entry(&id);
            Err(TorrentError::Operation(error).message())
        }
        // Still resolving: hand the id back and let `get_torrent_status` carry
        // the file list when the info dictionary lands.
        Metadata::Resolving => Ok(AddTorrentResult {
            id,
            info_hash,
            name: String::new(),
            files: Vec::new(),
        }),
    }
}

/// Resolve one magnet's info dictionary without starting a download.
///
/// `list_only` keeps the torrent out of the session, so nothing is written to
/// disk while the user is still reading the file table. The whole fetch is
/// bounded by [`METADATA_TIMEOUT`]; exceeding it reports `Failed` so the UI can
/// stop its skeleton instead of polling a torrent that will never resolve.
async fn resolve_metadata(session: &Arc<Session>, uri: &str) -> Metadata {
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
    .await;

    let listed = match response {
        Err(_) => {
            return Metadata::Failed(format!(
                "metadata resolution timed out after {}s",
                METADATA_TIMEOUT.as_secs()
            ))
        }
        Ok(Err(err)) => return Metadata::Failed(format!("{err:#}")),
        Ok(Ok(AddTorrentResponse::ListOnly(listed))) => listed,
        // `list_only` returns before the session registers anything, so any
        // other variant means the download started — refuse instead of leaving
        // a running torrent the UI never asked for.
        Ok(Ok(AddTorrentResponse::Added(_, _) | AddTorrentResponse::AlreadyManaged(_, _))) => {
            return Metadata::Failed("torrent was started instead of listed".into())
        }
    };

    Metadata::Ready(PendingTorrent {
        info_hash: listed.info_hash.as_string(),
        name: name_from_info(&listed.info),
        files: files_from_info(&listed.info),
        torrent_bytes: listed.torrent_bytes,
    })
}

#[tauri::command]
async fn get_torrent_status(
    state: tauri::State<'_, TorrentState>,
    id: String,
) -> Result<TorrentStatus, String> {
    let entry = state.entry(&id).map_err(|err| err.message())?;
    Ok(match &entry {
        Entry::Metadata {
            info_hash,
            state: metadata,
        } => metadata_status(&id, info_hash, &metadata.borrow()),
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

/// What one entry can offer for a file selection: resolved metadata (nothing on
/// disk yet) or a live handle.
enum SelectionSource {
    Metadata(PendingTorrent),
    Active(TorrentHandle),
}

/// Read the entry as a selection source.
///
/// A torrent whose metadata is still resolving has no file list, so selecting a
/// file for it is a caller bug; a failed resolution carries the reason.
fn selection_source(entry: &Entry) -> Result<SelectionSource, TorrentError> {
    match entry {
        Entry::Metadata { state, .. } => match state.borrow().clone() {
            Metadata::Ready(pending) => Ok(SelectionSource::Metadata(pending)),
            Metadata::Resolving => Err(TorrentError::Operation(
                "metadata is still resolving".into(),
            )),
            Metadata::Failed(error) => Err(TorrentError::Operation(error)),
        },
        Entry::Active { handle, .. } => Ok(SelectionSource::Active(handle.clone())),
    }
}

/// Start downloading the chosen files and hand back loopback URLs.
///
/// This is the only place a download begins. `video_index`/`subtitle_index` are
/// the `TorrentFile.index` values from `add_torrent` (the metadata file index,
/// which is what librqbit's `only_files` expects). Everything else in the
/// torrent — other episodes, extras, soundtracks — is excluded from the start,
/// so a 67 GB multi-file torrent only ever fetches the selected episode.
///
/// The command never fails because the torrent is still `Initializing`. librqbit
/// opens the storage only after its initial piece check, which on a 130 GB /
/// 1372-file torrent runs for minutes; waiting for that here is what used to
/// abort the modal with a generic error. The relay sessions are registered first
/// — the URLs are final as soon as the handle exists — and every long
/// initialization wait is left to the relay's `wait_streamable`, which parks the
/// browser's first range request instead of refusing it. Only the best-effort
/// Matroska header scan below stays bounded here, by [`TRACK_SCAN_TIMEOUT`].
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
    let source = selection_source(&entry).map_err(|err| err.message())?;
    let files = match &source {
        SelectionSource::Metadata(pending) => pending.files.clone(),
        SelectionSource::Active(handle) => collect_files(handle),
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
    let handle = match &source {
        SelectionSource::Metadata(pending) => {
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
        SelectionSource::Active(handle) => handle.clone(),
    };

    // Register the relay sessions before anything can wait: the URLs are
    // deterministic once the handle exists, so the reply's playback surface is
    // final immediately and no initialization delay can hold it back.
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

    // Best effort: a fresh add already honours `only_files`, and an already
    // live torrent needs the restriction applied now. Neither call blocks on
    // initialization — on a torrent that is still `Initializing` librqbit
    // rejects them and the add above already carries the file restriction.
    let _ = session.update_only_files(&handle, &only_files).await;
    if handle.is_paused() {
        let _ = session.unpause(&handle).await;
    }

    let scan_deadline = tokio::time::Instant::now() + TRACK_SCAN_TIMEOUT;
    // Both probes below are opportunistic: they warm the first piece and let the
    // reply carry the track list. When the torrent is still initializing they
    // return at once and the relay keeps the browser parked instead.
    wait_first_byte(&handle, video.index, scan_deadline).await;
    let track_report =
        read_mkv_track_report(&handle, video.index, &video.path, scan_deadline).await;

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
    let (files, handle) = match &entry {
        Entry::Metadata { state, .. } => match state.borrow().clone() {
            Metadata::Ready(pending) => (pending.files.clone(), None),
            // Still resolving or already failed: no bytes on disk, so there is
            // no header to parse.
            Metadata::Resolving | Metadata::Failed(_) => return Ok(MkvTrackReport::default()),
        },
        Entry::Active { handle, .. } => (collect_files(handle), Some(handle.clone())),
    };
    let file = find_file(&files, file_index).map_err(|err| err.message())?;

    let Some(handle) = handle else {
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
    use librqbit::TorrentMetaV1Info;

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
            state_label(&TorrentStatsState::Initializing { paused: false }),
            "initializing"
        );
        assert_eq!(state_label(&TorrentStatsState::Live), "live");
        assert_eq!(state_label(&TorrentStatsState::Paused), "paused");
        assert_eq!(state_label(&TorrentStatsState::Error), "error");
    }

    fn byte_buf(value: &'static [u8]) -> ByteBufOwned {
        ByteBufOwned(Bytes::from_static(value))
    }

    /// The info dictionary librqbit hands back from `list_only` is already
    /// validated, so the tests build it the same way.
    fn multi_file_info() -> ValidatedTorrentMetaV1Info<ByteBufOwned> {
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
        .validate()
        .expect("validated info")
    }

    /// The metadata-only file list must carry the same indices librqbit will
    /// later expect in `only_files`, so `select_torrent_files` can address the
    /// chosen file without ever starting the rest of the torrent.
    #[test]
    fn lists_metadata_files_with_librqbit_indices() {
        let info = multi_file_info();
        let files = files_from_info(&info);
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
        let files = files_from_info(&multi_file_info());
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
            files: files_from_info(&multi_file_info()),
            torrent_bytes: Bytes::new(),
        };
        let status = metadata_status("torrent-0", "magnet-hash", &Metadata::Ready(pending));
        assert_eq!(status.state, "metadata");
        assert_eq!(status.info_hash, "abc");
        assert_eq!(status.progress_bytes, 0);
        assert_eq!(status.total_bytes, 0);
        assert_eq!(status.download_speed_mbps, 0.0);
        assert!(!status.playable);
        assert!(!status.finished);
        assert!(status.error.is_none());
        assert_eq!(status.files.len(), 2);
    }

    /// While the info dictionary is still in flight the poll must keep the
    /// skeleton alive: no files, no error, and the magnet's own infohash so the
    /// entry has an identity before the engine answers.
    #[test]
    fn resolving_status_has_no_files_and_no_error() {
        let status = metadata_status("torrent-1", "abcdef", &Metadata::Resolving);
        assert_eq!(status.state, "metadata");
        assert_eq!(status.info_hash, "abcdef");
        assert!(status.files.is_empty());
        assert!(status.error.is_none());
    }

    /// A resolution that gave up must reach the UI as an error, otherwise the
    /// dialog would poll a torrent that will never resolve.
    #[test]
    fn failed_resolution_reports_the_reason() {
        let status = metadata_status(
            "torrent-2",
            "abcdef",
            &Metadata::Failed("metadata resolution timed out after 120s".into()),
        );
        assert_eq!(status.state, "error");
        assert_eq!(
            status.error.as_deref(),
            Some("metadata resolution timed out after 120s")
        );
        assert!(status.files.is_empty());
    }

    /// The magnet already names the infohash; the status reply must not be
    /// blank while the engine is still resolving it.
    #[test]
    fn reads_the_infohash_from_the_magnet() {
        assert_eq!(
            magnet_info_hash("magnet:?xt=urn:btih:CAB507494D02EBB1178B38F2E9D7BE299C86B862&dn=x"),
            "cab507494d02ebb1178b38f2e9d7be299c86b862"
        );
        assert_eq!(
            magnet_info_hash("magnet:?dn=x&xt=urn:btih:abc123&tr=udp%3A%2F%2Fy"),
            "abc123"
        );
    }

    /// A torrent that is still resolving has no file list, so selecting a file
    /// for it must fail instead of silently picking index 0.
    #[test]
    fn selection_requires_resolved_metadata() {
        let (_sender, receiver) = watch::channel(Metadata::Resolving);
        let entry = Entry::Metadata {
            info_hash: "abc".into(),
            state: receiver,
        };
        assert!(matches!(
            selection_source(&entry),
            Err(TorrentError::Operation(_))
        ));
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
