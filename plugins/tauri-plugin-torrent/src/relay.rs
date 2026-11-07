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
//! The torrent's *initialization* is waited for the same way. `stream()` refuses
//! a torrent whose storage is not open yet ("invalid state: initializing"), and a
//! 130 GB / 1372-file torrent stays in that state for minutes while librqbit
//! checksums the pieces. Answering `503` there is fatal: a browser media element
//! does not retry a `503`, it stops with error code 4 and never recovers. The
//! first request is therefore parked until initialization lands and answered with
//! `206` right after, so the player only ever sees a buffering wait.
//!
//! Only loopback traffic is accepted: the listener binds `127.0.0.1` with an
//! ephemeral port, so nothing is reachable from the network and no torrent
//! metadata (infohash, tracker, peer) is ever exposed to the webview.

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

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

/// How long a request may stay parked while the torrent finishes initializing.
///
/// librqbit opens a torrent's storage only after its initial piece check, and on
/// a 130 GB / 1372-file torrent that check runs for minutes. The browser's first
/// `Range` request is held open for that whole window instead of being answered
/// `503` — a media element never retries a `503`, so an early refusal is a
/// permanent playback failure, while a parked request is just a buffering wait
/// the player already shows a spinner for.
const STREAM_INIT_TIMEOUT: Duration = Duration::from_secs(300);

/// Poll interval between `stream()` probes after initialization resolved.
/// `wait_until_initialized` itself parks on the torrent's notify handle, so this
/// only bounds the re-probe of a torrent that is already past initializing.
const STREAM_INIT_RETRY: Duration = Duration::from_millis(500);

/// How many `stream()` re-probes are allowed once initialization resolved.
///
/// `wait_until_initialized` returns immediately on an already-initialized
/// torrent, so an unbounded retry loop would spin every [`STREAM_INIT_RETRY`]
/// for the whole [`STREAM_INIT_TIMEOUT`] whenever the file is genuinely
/// unaddressable (storage closed, file removed). Eight probes ≈ 4 s is enough
/// for the transient window right after the piece check and short enough that a
/// dead file fails fast.
const STREAM_INIT_MAX_RETRIES: u32 = 8;

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
            .route("/stream/{id}", get(handle_stream).options(handle_options))
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

// --- CORS -----------------------------------------------------------------
//
// The webview origin (`http://tauri.localhost` on Windows, `https://localhost`
// on Android) differs from the relay's `http://127.0.0.1:<port>`, so every
// request the `<video>` element makes is cross-origin. A missing
// `Access-Control-Allow-Origin` on *any* status — preflight, 404, 503, 500 —
// makes the browser reject the response and the media pipeline dies with a
// CORS error before a single byte is decoded.

const CORS_ORIGIN: &str = "*";
const CORS_METHODS: &str = "GET, HEAD, OPTIONS";
const CORS_HEADERS: &str = "Range, Content-Type, Accept";
const CORS_EXPOSE_HEADERS: &str = "Content-Length, Content-Range, Accept-Ranges";
const CORS_MAX_AGE: &str = "86400";

/// Attach the full CORS header set to a response.
///
/// Applied at the single exit point of every handler so success, error and
/// preflight responses are indistinguishable to the browser's CORS check.
fn with_cors(mut response: Response) -> Response {
    let headers = response.headers_mut();
    headers.insert(
        header::ACCESS_CONTROL_ALLOW_ORIGIN,
        HeaderValue::from_static(CORS_ORIGIN),
    );
    headers.insert(
        header::ACCESS_CONTROL_ALLOW_METHODS,
        HeaderValue::from_static(CORS_METHODS),
    );
    headers.insert(
        header::ACCESS_CONTROL_ALLOW_HEADERS,
        HeaderValue::from_static(CORS_HEADERS),
    );
    headers.insert(
        header::ACCESS_CONTROL_EXPOSE_HEADERS,
        HeaderValue::from_static(CORS_EXPOSE_HEADERS),
    );
    headers.insert(
        header::ACCESS_CONTROL_MAX_AGE,
        HeaderValue::from_static(CORS_MAX_AGE),
    );
    response
}

/// Answer the CORS preflight for a stream URL.
///
/// `OPTIONS` never touches the torrent: the browser only wants permission to
/// send the real ranged `GET`, so the answer is an empty `204` plus headers.
async fn handle_options() -> Response {
    with_cors(StatusCode::NO_CONTENT.into_response())
}

/// Serve `GET`/`HEAD /stream/<id>` from the registered torrent file.
///
/// Wraps [`stream_file`] so that every possible status leaves with the CORS
/// header set — there is no error path that can slip past the browser check.
async fn handle_stream(
    State(relay): State<Arc<Relay>>,
    Path(id): Path<String>,
    headers: HeaderMap,
) -> Response {
    with_cors(stream_file(relay, id, headers).await)
}

/// Why a stream could not be opened for a registered session.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum StreamWait {
    /// The torrent never left `Initializing` inside [`STREAM_INIT_TIMEOUT`].
    Timeout,
    /// The torrent is in an error state or the file is no longer addressable;
    /// no amount of waiting can make it streamable.
    Unavailable,
}

/// Status the relay answers when a stream cannot be opened at all.
///
/// Deliberately not `404`/`500`: the session exists and the request is valid, the
/// torrent just is not servable — and `503` is the honest signal for that.
fn unavailable_status() -> StatusCode {
    StatusCode::SERVICE_UNAVAILABLE
}

/// Wait until `file_id` can be streamed, parking on the torrent's own state.
///
/// The fast path is a single `stream()` probe: a live or paused torrent whose
/// storage is open returns `Ok` and the caller re-opens the stream itself. Every
/// other case waits for initialization to finish and then re-probes, so a
/// torrent that needs minutes to checksum never produces a `503` that the
/// browser would treat as fatal.
async fn wait_streamable(handle: &Arc<ManagedTorrent>, file_id: usize) -> Result<(), StreamWait> {
    // `stream()` only succeeds once the storage is open; the error text is
    // deliberately dropped because librqbit's message can carry cache paths and
    // no torrent detail may reach the webview.
    if handle.clone().stream(file_id).await.is_ok() {
        return Ok(());
    }

    let deadline = tokio::time::Instant::now() + STREAM_INIT_TIMEOUT;
    let budget = deadline.saturating_duration_since(tokio::time::Instant::now());
    // Parks until the state changes; an error state can never become
    // streamable, so it fails at once instead of burning the budget.
    match tokio::time::timeout(budget, handle.wait_until_initialized()).await {
        Ok(Ok(())) => {}
        Ok(Err(_)) => return Err(StreamWait::Unavailable),
        Err(_) => return Err(StreamWait::Timeout),
    }

    // Initialization is done. A handful of bounded re-probes covers the short
    // window where storage is still being opened; past that the file is not
    // servable and retrying cannot change it, so stop instead of spinning.
    for _ in 0..STREAM_INIT_MAX_RETRIES {
        if handle.clone().stream(file_id).await.is_ok() {
            return Ok(());
        }
        if tokio::time::Instant::now() >= deadline {
            return Err(StreamWait::Timeout);
        }
        tokio::time::sleep(STREAM_INIT_RETRY).await;
    }

    if handle.clone().stream(file_id).await.is_ok() {
        Ok(())
    } else {
        Err(StreamWait::Unavailable)
    }
}

/// The response is `206 Partial Content` whenever the client sent a usable
/// `Range`, with `Content-Range`/`Content-Length` describing exactly the bytes
/// that follow, which is what lets the `<video>` element seek natively.
async fn stream_file(relay: Arc<Relay>, id: String, headers: HeaderMap) -> Response {
    let Some((handle, file_id, mime)) = relay.lookup(&id) else {
        return (StatusCode::NOT_FOUND, "unknown stream session").into_response();
    };

    // Hold the request until the torrent can actually serve bytes. Returning
    // `503` here instead is what used to kill playback outright: Chrome stops a
    // media element on the first `503` and never retries it.
    if let Err(wait) = wait_streamable(&handle, file_id).await {
        // The message stays generic: no torrent detail may reach the webview.
        return match wait {
            StreamWait::Timeout => {
                (unavailable_status(), "torrent stream still initializing").into_response()
            }
            StreamWait::Unavailable => {
                (unavailable_status(), "torrent stream unavailable").into_response()
            }
        };
    }

    let mut stream = match handle.clone().stream(file_id).await {
        Ok(stream) => stream,
        Err(_) => {
            // The torrent stopped being streamable between the wait and this
            // call (cancelled, removed). The message stays generic.
            return (unavailable_status(), "torrent stream unavailable").into_response();
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

    // CORS headers are added by `with_cors` at the handler exit point so the
    // error paths carry exactly the same set as this success path.
    let mut builder = Response::builder()
        .status(status)
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
    fn cors_headers_survive_every_status() {
        // The webview rejects a response with no `Access-Control-Allow-Origin`
        // even when the status is an error, so every relay exit path must
        // carry the same header set.
        for status in [
            StatusCode::OK,
            StatusCode::PARTIAL_CONTENT,
            StatusCode::NO_CONTENT,
            StatusCode::NOT_FOUND,
            StatusCode::SERVICE_UNAVAILABLE,
            StatusCode::RANGE_NOT_SATISFIABLE,
            StatusCode::INTERNAL_SERVER_ERROR,
        ] {
            let response = with_cors(status.into_response());
            let headers = response.headers();
            assert_eq!(
                headers
                    .get(header::ACCESS_CONTROL_ALLOW_ORIGIN)
                    .and_then(|value| value.to_str().ok()),
                Some("*"),
                "missing allow-origin for {status}"
            );
            let allow_methods = headers
                .get(header::ACCESS_CONTROL_ALLOW_METHODS)
                .and_then(|value| value.to_str().ok())
                .unwrap_or_default();
            assert!(allow_methods.contains("GET"));
            assert!(allow_methods.contains("HEAD"));
            assert!(allow_methods.contains("OPTIONS"));
            let allow_headers = headers
                .get(header::ACCESS_CONTROL_ALLOW_HEADERS)
                .and_then(|value| value.to_str().ok())
                .unwrap_or_default()
                .to_ascii_lowercase();
            // `Range` is what the `<video>` element needs to seek at all.
            assert!(allow_headers.contains("range"));
            assert!(headers.contains_key(header::ACCESS_CONTROL_MAX_AGE));
        }
    }

    #[tokio::test]
    async fn preflight_is_an_empty_204_with_cors() {
        let response = handle_options().await;
        assert_eq!(response.status(), StatusCode::NO_CONTENT);
        assert_eq!(
            response
                .headers()
                .get(header::ACCESS_CONTROL_ALLOW_ORIGIN)
                .and_then(|value| value.to_str().ok()),
            Some("*")
        );
    }

    #[test]
    fn both_wait_outcomes_answer_service_unavailable() {
        // Whatever the reason a stream cannot be opened, the browser must get the
        // same retryable status. Anything else (`404`/`500`) would be read as a
        // different failure class, and the message must not leak torrent detail.
        for wait in [StreamWait::Timeout, StreamWait::Unavailable] {
            assert_eq!(unavailable_status(), StatusCode::SERVICE_UNAVAILABLE);
            let response = match wait {
                StreamWait::Timeout => {
                    (unavailable_status(), "torrent stream still initializing").into_response()
                }
                StreamWait::Unavailable => {
                    (unavailable_status(), "torrent stream unavailable").into_response()
                }
            };
            assert_eq!(response.status(), StatusCode::SERVICE_UNAVAILABLE);
        }
    }

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
