//! Loopback HTTP relay for resolved media streams.
//!
//! yt-dlp hands back short-lived `googlevideo.com` URLs that are tied to a
//! client/IP/token combination. Pointing a `<video>` element straight at them
//! works for the first bytes but degrades badly on seek: the player opens a
//! fresh connection per range and YouTube throttles or 403s the new request.
//!
//! This module keeps the upstream URL inside the Rust process and exposes a
//! stable `http://127.0.0.1:<port>/stream/<session>` endpoint instead. The
//! endpoint forwards the browser's `Range` header upstream with `reqwest` and
//! streams the response body back chunk by chunk, so seeking forwards and
//! backwards is served by the same proxy without re-resolving the URL.
//!
//! Only loopback traffic is accepted: the listener is bound to `127.0.0.1`
//! with an ephemeral port, so nothing is reachable from the network and the
//! upstream URL (which carries a token) never leaves the process.

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
use tokio::net::TcpListener;
use tokio::sync::OnceCell;

/// Upper bound on live sessions. Each `stream_youtube` call registers one
/// session per resolved URL; a player that switches sources repeatedly would
/// otherwise grow the map forever. The oldest session is evicted first.
const MAX_SESSIONS: usize = 32;

/// Time allowed for the TCP/TLS handshake with the upstream host. The body is
/// streamed without an overall deadline on purpose: a paused `<video>` keeps a
/// range request open and a hard timeout would kill playback.
const UPSTREAM_CONNECT_TIMEOUT: Duration = Duration::from_secs(10);

static RELAY: OnceCell<Arc<Relay>> = OnceCell::const_new();

/// Get the process-wide relay, starting the listener on first use.
///
/// Binding happens exactly once; later calls reuse the same port so previously
/// handed-out local URLs stay valid for the lifetime of the process.
pub(crate) async fn ensure() -> Result<Arc<Relay>, String> {
    RELAY
        .get_or_try_init(Relay::start)
        .await
        .map(Arc::clone)
}

struct Session {
    upstream: String,
    /// Monotonic registration order, used for oldest-first eviction.
    seq: u64,
}

pub(crate) struct Relay {
    base_url: String,
    client: reqwest::Client,
    sessions: Mutex<HashMap<String, Session>>,
    counter: AtomicU64,
}

impl Relay {
    async fn start() -> Result<Arc<Relay>, String> {
        let client = reqwest::Client::builder()
            .connect_timeout(UPSTREAM_CONNECT_TIMEOUT)
            .build()
            .map_err(|err| format!("failed to build relay http client: {err}"))?;

        let listener = TcpListener::bind(("127.0.0.1", 0))
            .await
            .map_err(|err| format!("failed to bind relay listener: {err}"))?;
        let addr = listener
            .local_addr()
            .map_err(|err| format!("failed to read relay address: {err}"))?;

        let relay = Arc::new(Relay {
            base_url: format!("http://{addr}"),
            client,
            sessions: Mutex::new(HashMap::new()),
            counter: AtomicU64::new(0),
        });

        let router = Router::new()
            .route("/stream/{id}", get(handle_stream))
            .with_state(Arc::clone(&relay));

        tokio::spawn(async move {
            if let Err(err) = axum::serve(listener, router).await {
                eprintln!("ytdlp relay stopped: {err}");
            }
        });

        Ok(relay)
    }

    /// Register an upstream URL and return the local URL that proxies it.
    pub(crate) fn register(&self, upstream: &str) -> String {
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
                upstream: upstream.to_string(),
                seq,
            },
        );
        drop(sessions);

        format!("{}/stream/{}", self.base_url, id)
    }

    fn lookup(&self, id: &str) -> Option<String> {
        self.lock_sessions()
            .get(id)
            .map(|session| session.upstream.clone())
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

impl ByteRange {
    fn to_header_value(self) -> String {
        match self {
            ByteRange::FromTo(start, end) => format!("bytes={start}-{end}"),
            ByteRange::From(start) => format!("bytes={start}-"),
            ByteRange::Suffix(len) => format!("bytes=-{len}"),
        }
    }
}

/// Parse a single-range `Range: bytes=...` header value.
///
/// Multi-range requests (`bytes=0-1,4-5`) and anything malformed return `None`.
/// Browsers only ever send a single range to media elements, so rejecting the
/// rest keeps the forwarding logic honest instead of guessing.
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

/// Proxy `GET`/`HEAD /stream/<id>` to the registered upstream URL.
///
/// The client's `Range` header is forwarded verbatim (after validation), so the
/// upstream decides the exact byte window and returns `206 Partial Content`
/// with its own `Content-Range`. That header and `Content-Length` are relayed
/// unchanged, which is what lets the `<video>` element seek natively.
///
/// Note: if an upstream ever ignores the forwarded range and answers `200` with
/// the full body, that response is passed through untouched rather than sliced
/// here. Media elements tolerate it (they fall back to a plain full download),
/// and every YouTube CDN host honours `Range`.
async fn handle_stream(
    State(relay): State<Arc<Relay>>,
    Path(id): Path<String>,
    headers: HeaderMap,
) -> Response {
    let Some(upstream) = relay.lookup(&id) else {
        return (StatusCode::NOT_FOUND, "unknown stream session").into_response();
    };

    let mut request = relay.client.get(&upstream);
    if let Some(raw) = headers.get(header::RANGE).and_then(|value| value.to_str().ok()) {
        match parse_range_header(raw) {
            Some(range) => request = request.header(header::RANGE, range.to_header_value()),
            None => {
                return (StatusCode::RANGE_NOT_SATISFIABLE, "unsupported range").into_response()
            }
        }
    }

    let upstream_response = match request.send().await {
        Ok(response) => response,
        Err(err) => {
            // Never interpolate `err` here: reqwest's Display renders
            // ` for url (<signed GoogleVideo URL>)`, which would leak the
            // tokenised upstream URL into the client-visible body.
            let reason = if err.is_timeout() {
                "upstream request timed out"
            } else if err.is_connect() {
                "upstream connection failed"
            } else {
                "upstream request failed"
            };
            return (StatusCode::BAD_GATEWAY, reason.to_string()).into_response();
        }
    };

    let mut builder = Response::builder()
        .status(StatusCode::from_u16(upstream_response.status().as_u16()).unwrap_or(
            StatusCode::BAD_GATEWAY,
        ))
        .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")
        .header(header::ACCEPT_RANGES, "bytes")
        .header(header::CACHE_CONTROL, "no-store");

    for name in [
        header::CONTENT_TYPE,
        header::CONTENT_LENGTH,
        header::CONTENT_RANGE,
    ] {
        if let Some(value) = upstream_response.headers().get(&name) {
            if let Ok(value) = HeaderValue::from_bytes(value.as_bytes()) {
                builder = builder.header(name, value);
            }
        }
    }

    builder
        .body(Body::from_stream(upstream_response.bytes_stream()))
        .unwrap_or_else(|err| {
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                format!("failed to build relay response: {err}"),
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
        assert_eq!(parse_range_header("bytes=2048-"), Some(ByteRange::From(2048)));
        assert_eq!(parse_range_header("bytes=-512"), Some(ByteRange::Suffix(512)));
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
    fn round_trips_range_header_values() {
        assert_eq!(ByteRange::FromTo(10, 20).to_header_value(), "bytes=10-20");
        assert_eq!(ByteRange::From(10).to_header_value(), "bytes=10-");
        assert_eq!(ByteRange::Suffix(10).to_header_value(), "bytes=-10");
    }
}
