//! Generic cross-origin text fetch, native side.
//!
//! # Why this exists
//! The renderer's own `fetch` cannot read an arbitrary HTTP(S) endpoint: the
//! browser blocks the response unless the server sends CORS headers, and the
//! servers Yomitan's audio resolvers talk to (a user's local `localhost:5050`
//! audio server, for one) do not. Playback is NOT a CORS request, so once a
//! direct media URL is known `new Audio(url)` plays it fine — it is only the
//! *lookup* (fetching a `Custom URL (JSON)` payload that lists several tracks
//! for a word) that the webview cannot do on its own.
//!
//! This module is that lookup, done natively where the CORS rule does not apply.
//! It is deliberately tiny and content-agnostic: one GET, the response body as
//! text, nothing else. The caller (the TypeScript audio resolver) owns parsing
//! and validation, so this stays a dumb pipe and never has to know about audio.

use std::time::Duration;

use reqwest::Client;

/// Per-request timeout. A local audio server answers in milliseconds; a hung one
/// should fail the lookup (and fall back to "no audio") rather than pin the menu.
/// This is the FALLBACK applied when the caller supplies no explicit timeout.
const REQUEST_TIMEOUT: Duration = Duration::from_secs(15);

/// Resolve the per-request timeout for one lookup.
///
/// The caller (the TypeScript audio resolver) may pass the user's configured
/// `audio.downloadTimeout` in milliseconds. A `Some(ms)` above zero overrides the
/// default; `None` or a zero / non-positive value falls back to `REQUEST_TIMEOUT`,
/// so a stray `0` can never disable the timeout and pin the menu on a hung server.
fn request_timeout(timeout_ms: Option<u64>) -> Duration {
    match timeout_ms {
        Some(ms) if ms > 0 => Duration::from_millis(ms),
        _ => REQUEST_TIMEOUT,
    }
}

/// A shared client. `reqwest` pools connections, so reusing one client across
/// lookups keeps a subsequent word instant instead of re-establishing TLS.
///
/// The pooled client carries no per-request timeout — that is applied per call
/// via `RequestBuilder::timeout`, because the caller's configured timeout varies
/// per lookup while the connection pool is shared.
fn client() -> &'static Client {
    use std::sync::OnceLock;
    static CLIENT: OnceLock<Client> = OnceLock::new();
    CLIENT.get_or_init(|| {
        Client::builder()
            .build()
            .expect("the native fetch client builds with default settings")
    })
}

/// GET `url` and return the response body as text.
///
/// Only `http` and `https` are allowed — this is a network lookup, not a local
/// file reader, and letting a renderer-provided URL reach `file://` would be a
/// sandbox escape. A non-2xx status or a transport failure (a timeout included)
/// is an `Err` carrying the reason (never the body, which the caller has not
/// asked for and which the trace log must not record).
///
/// `timeout_ms` is the caller's configured per-request timeout in milliseconds;
/// `None` (or a zero value) uses the built-in `REQUEST_TIMEOUT` fallback.
pub async fn fetch_text(url: &str, timeout_ms: Option<u64>) -> Result<String, String> {
    let parsed = reqwest::Url::parse(url).map_err(|e| format!("invalid url: {e}"))?;
    if !matches!(parsed.scheme(), "http" | "https") {
        return Err(format!("unsupported url scheme: {}", parsed.scheme()));
    }
    let response = client()
        .get(parsed)
        .timeout(request_timeout(timeout_ms))
        .send()
        .await
        .map_err(|e| format!("request failed: {e}"))?;
    let status = response.status();
    if !status.is_success() {
        return Err(format!("http status {status}"));
    }
    response
        .text()
        .await
        .map_err(|e| format!("failed to read body: {e}"))
}

#[cfg(test)]
mod tests {
    use super::{fetch_text, request_timeout};
    use std::time::Duration;

    #[tokio::test]
    async fn rejects_non_http_scheme() {
        let err = fetch_text("file:///etc/passwd", None).await.unwrap_err();
        assert!(err.contains("unsupported url scheme"), "got: {err}");
    }

    #[tokio::test]
    async fn rejects_invalid_url() {
        let err = fetch_text("not a url", None).await.unwrap_err();
        assert!(err.contains("invalid url"), "got: {err}");
    }

    #[test]
    fn zero_and_none_fall_back_to_default_timeout() {
        assert_eq!(request_timeout(None), Duration::from_secs(15));
        assert_eq!(request_timeout(Some(0)), Duration::from_secs(15));
    }

    #[test]
    fn positive_timeout_is_honoured() {
        assert_eq!(request_timeout(Some(2500)), Duration::from_millis(2500));
    }
}