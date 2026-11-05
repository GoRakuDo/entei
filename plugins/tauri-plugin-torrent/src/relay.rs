//! Loopback HTTP relay for selected torrent files.
//!
//! A `<video>` element cannot read from the librqbit session directly: the
//! bytes live inside the torrent engine and must be served over HTTP with
//! `Range` support so the player can seek. This module keeps the torrent
//! handle inside the Rust process and exposes a stable
//! `http://127.0.0.1:<port>/stream/<session>` endpoint per selected file.
//!
//! Each request creates a fresh [`librqbit`] `FileStream` (a seekable
//! `AsyncRead` over the torrent's pieces), seeks it to the requested offset
//! and streams exactly the requested window back. Piece availability is
//! handled by the stream itself: a read on a missing piece parks the task and
//! wakes it when the piece arrives, so a seek into an undownloaded region
//! simply waits instead of failing.
//!
//! Only loopback traffic is accepted: the listener binds `127.0.0.1` with an
//! ephemeral port, so nothing is reachable from the network and no torrent
//! metadata (infohash, tracker, peer) is ever exposed to the webview.

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

use axum::body::Body;
use axum::extract::{Path, State};
use axum::http::{header, HeaderMap, HeaderValue, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::Router;
use librqbit::ManagedTorrent;
use tokio::io::{AsyncReadExt, AsyncSeekExt};
use tokio::net::TcpListener;
use tokio::sync::OnceCell;
use tokio_util::io::ReaderStream;

/// Upper bound on registered sessions. Each selected video/subtitle registers
/// one; a user who opens many torrents would otherwise grow the map forever.
/// The oldest session is evicted first.
const MAX_SESSIONS: usize = 16;

/// Read chunk size handed to the response body stream.
const CHUNK_SIZE: usize = 64 * 1024;

static RELAY: OnceCell<Arc<Relay>> = OnceCell::const_new();

/// Get the process-wide relay, starting the listener on first use.
///
/// Binding happens exactly once; later calls reuse the same port so previously
/// handed-out local URLs stay valid for the lifetime of the process.
pub(crate) async fn ensure() -> Result<Arc<Relay>, String> {
    RELAY.get_or_try_init(Relay::start).await.map(Arc::clone)
}

/// Get the relay only if it was already started.
///
/// Cancel paths must not spin up the listener as a side effect of cleanup.
pub(crate) fn existing() -> Option<Arc<Relay>> {
    RELAY.get().cloned()
}

struct Session {
    handle: Arc<ManagedTorrent>,
    /// Plugin-level torrent id (`add_torrent`'s `id`). Kept so a cancelled
    /// torrent can unregister every relay URL it produced instead of leaving
    /// dead sessions in the map until eviction.
    torrent_id: String,
    file_id: usize,
    mime: String,
    /// Monotonic registration order, used for oldest-first eviction.
    seq: u64,
}

pub(crate) struct Relay {
    base_url: String,
    sessions: Mutex<HashMap<String, Session>>,
    counter: AtomicU64,
}

impl Relay {
    async fn start() -> Result<Arc<Relay>, String> {
        let listener = TcpListener::bind(("127.0.0.1", 0))
            .await
            .map_err(|err| format!("failed to bind torrent relay listener: {err}"))?;
        let addr = listener
            .local_addr()
            .map_err(|err| format!("failed to read torrent relay address: {err}"))?;

        let relay = Arc::new(Relay {
            base_url: format!("http://{addr}"),
            sessions: Mutex::new(HashMap::new()),
            counter: AtomicU64::new(0),
        });

        let router = Router::new()
            .route("/stream/{id}", get(handle_stream))
            .with_state(Arc::clone(&relay));

        tokio::spawn(async move {
            if let Err(err) = axum::serve(listener, router).await {
                eprintln!("torrent relay stopped: {err}");
            }
        });

        Ok(relay)
    }

    /// Register one torrent file and return the local URL that serves it.
    pub(crate) fn register(
        &self,
        torrent_id: &str,
        handle: Arc<ManagedTorrent>,
        file_id: usize,
        mime: &str,
    ) -> String {
        let (id, seq) = self.next_id();
        let mut sessions = self.lock_sessions();

        if sessions.len() >= MAX_SESSIONS {
            if let Some(oldest) = sessions
                .iter()
                .min_by_key(|(_, session)| session.seq)
                .map(|(key, _)| key.clone())
            {
                sessions.remove(&oldest);
            }
        }

        sessions.insert(
            id.clone(),
            Session {
                torrent_id: torrent_id.to_string(),
                handle,
                file_id,
                mime: mime.to_string(),
                seq,
            },
        );
        drop(sessions);

        format!("{}/stream/{}", self.base_url, id)
    }

    /// Drop every relay session belonging to a torrent.
    ///
    /// Called when the torrent is cancelled: the handles are gone, so the URLs
    /// would only answer `503` while still counting against [`MAX_SESSIONS`].
    pub(crate) fn unregister_torrent(&self, torrent_id: &str) {
        let mut sessions = self.lock_sessions();
        sessions.retain(|_, session| session.torrent_id != torrent_id);
    }

    fn lookup(&self, id: &str) -> Option<(Arc<ManagedTorrent>, usize, String)> {
        self.lock_sessions().get(id).map(|session| {
            (
                session.handle.clone(),
                session.file_id,
                session.mime.clone(),
            )
        })
    }

    fn lock_sessions(&self) -> std::sync::MutexGuard<'_, HashMap<String, Session>> {
        // A poisoned lock means another task panicked while holding it; the map
        // itself is still structurally sound, so recover instead of panicking
        // the whole playback path.
        self.sessions
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    fn next_id(&self) -> (String, u64) {
        let seq = self.counter.fetch_add(1, Ordering::Relaxed);
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|elapsed| elapsed.as_nanos())
            .unwrap_or(0);
        (format!("{nanos:x}{seq:x}"), seq)
    }
}

/// A single-range `Range` request as understood by the relay.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum ByteRange {
    /// `bytes=start-end`
    FromTo(u64, u64),
    /// `bytes=start-`
    From(u64),
    /// `bytes=-suffix`
    Suffix(u64),
}

/// Parse a single-range `Range: bytes=...` header value.
///
/// Multi-range requests (`bytes=0-1,4-5`) and anything malformed return `None`.
/// Browsers only ever send a single range to media elements, so rejecting the
/// rest keeps the serving logic honest instead of guessing.
pub(crate) fn parse_range_header(value: &str) -> Option<ByteRange> {
    let value = value.trim();
    let (unit, spec) = value.split_once('=')?;
    if !unit.trim().eq_ignore_ascii_case("bytes") {
        return None;
    }
    if spec.contains(',') {
        return None;
    }
    let (start, end) = spec.split_once('-')?;
    let start = start.trim();
    let end = end.trim();

    match (start.is_empty(), end.is_empty()) {
        (true, true) => None,
        (true, false) => {
            let len = end.parse::<u64>().ok()?;
            if len == 0 {
                None
            } else {
                Some(ByteRange::Suffix(len))
            }
        }
        (false, true) => Some(ByteRange::From(start.parse::<u64>().ok()?)),
        (false, false) => {
            let start = start.parse::<u64>().ok()?;
            let end = end.parse::<u64>().ok()?;
            if end < start {
                None
            } else {
                Some(ByteRange::FromTo(start, end))
            }
        }
    }
}

/// Resolve a parsed range against the file length.
///
/// Returns `(start, length)` for a servable window, or `None` when the range
/// lies entirely outside the file (→ `416`).
pub(crate) fn resolve_range(range: ByteRange, file_len: u64) -> Option<(u64, u64)> {
    if file_len == 0 {
        return None;
    }
    match range {
        ByteRange::FromTo(start, end) => {
            if start >= file_len {
                return None;
            }
            let end = end.min(file_len - 1);
            Some((start, end - start + 1))
        }
        ByteRange::From(start) => {
            if start >= file_len {
                return None;
            }
            Some((start, file_len - start))
        }
        ByteRange::Suffix(len) => {
            let start = file_len.saturating_sub(len);
            Some((start, file_len - start))
        }
    }
}

/// Serve `GET`/`HEAD /stream/<id>` from the registered torrent file.
///
/// The response is `206 Partial Content` whenever the client sent a usable
/// `Range`, with `Content-Range`/`Content-Length` describing exactly the bytes
/// that follow, which is what lets the `<video>` element seek natively.
async fn handle_stream(
    State(relay): State<Arc<Relay>>,
    Path(id): Path<String>,
    headers: HeaderMap,
) -> Response {
    let Some((handle, file_id, mime)) = relay.lookup(&id) else {
        return (StatusCode::NOT_FOUND, "unknown stream session").into_response();
    };

    let mut stream = match handle.stream(file_id) {
        Ok(stream) => stream,
        Err(_) => {
            // The torrent is not in a streamable state (still initializing,
            // paused without files, or removed). The message stays generic:
            // no torrent detail may reach the webview.
            return (
                StatusCode::SERVICE_UNAVAILABLE,
                "torrent stream unavailable",
            )
                .into_response();
        }
    };

    let file_len = stream.len();
    let mut status = StatusCode::OK;
    let mut start = 0_u64;
    let mut length = file_len;

    if let Some(raw) = headers
        .get(header::RANGE)
        .and_then(|value| value.to_str().ok())
    {
        let Some(range) = parse_range_header(raw) else {
            return (StatusCode::RANGE_NOT_SATISFIABLE, "unsupported range").into_response();
        };
        match resolve_range(range, file_len) {
            Some((range_start, range_len)) => {
                status = StatusCode::PARTIAL_CONTENT;
                start = range_start;
                length = range_len;
            }
            None => {
                return (StatusCode::RANGE_NOT_SATISFIABLE, "range not satisfiable")
                    .into_response();
            }
        }
    }

    if start > 0 && stream.seek(std::io::SeekFrom::Start(start)).await.is_err() {
        return (StatusCode::INTERNAL_SERVER_ERROR, "torrent seek failed").into_response();
    }

    let mut builder = Response::builder()
        .status(status)
        .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")
        .header(header::ACCEPT_RANGES, "bytes")
        .header(header::CACHE_CONTROL, "no-store")
        .header(header::CONTENT_LENGTH, length);

    if status == StatusCode::PARTIAL_CONTENT {
        builder = builder.header(
            header::CONTENT_RANGE,
            format!("bytes {start}-{}/{file_len}", start + length - 1),
        );
    }
    if let Ok(value) = HeaderValue::from_str(&mime) {
        builder = builder.header(header::CONTENT_TYPE, value);
    }

    // `take` bounds the body to the requested window: without it a closed
    // range (`bytes=0-1023`) would keep streaming to the end of the file.
    let limited = stream.take(length);
    let body = Body::from_stream(ReaderStream::with_capacity(limited, CHUNK_SIZE));

    builder.body(body).unwrap_or_else(|_| {
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            "failed to build relay response",
        )
            .into_response()
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_closed_range() {
        assert_eq!(
            parse_range_header("bytes=0-1023"),
            Some(ByteRange::FromTo(0, 1023))
        );
        assert_eq!(
            parse_range_header("  bytes=  500-600 "),
            Some(ByteRange::FromTo(500, 600))
        );
    }

    #[test]
    fn parses_open_and_suffix_ranges() {
        assert_eq!(
            parse_range_header("bytes=2048-"),
            Some(ByteRange::From(2048))
        );
        assert_eq!(
            parse_range_header("bytes=-512"),
            Some(ByteRange::Suffix(512))
        );
    }

    #[test]
    fn rejects_unsupported_ranges() {
        assert!(parse_range_header("bytes=0-1,4-5").is_none());
        assert!(parse_range_header("bytes=-0").is_none());
        assert!(parse_range_header("bytes=600-500").is_none());
        assert!(parse_range_header("bytes=-").is_none());
        assert!(parse_range_header("items=0-1").is_none());
        assert!(parse_range_header("garbage").is_none());
    }

    #[test]
    fn resolves_ranges_against_file_length() {
        assert_eq!(
            resolve_range(ByteRange::FromTo(0, 1023), 2048),
            Some((0, 1024))
        );
        // A closed range past the end is clamped to the last byte.
        assert_eq!(
            resolve_range(ByteRange::FromTo(2000, 9999), 2048),
            Some((2000, 48))
        );
        assert_eq!(resolve_range(ByteRange::From(2000), 2048), Some((2000, 48)));
        // A suffix longer than the file starts at zero.
        assert_eq!(
            resolve_range(ByteRange::Suffix(9999), 2048),
            Some((0, 2048))
        );
        // Out-of-file starts are unsatisfiable.
        assert_eq!(resolve_range(ByteRange::From(2048), 2048), None);
        assert_eq!(resolve_range(ByteRange::FromTo(4096, 8192), 2048), None);
        assert_eq!(resolve_range(ByteRange::From(0), 0), None);
    }
}
