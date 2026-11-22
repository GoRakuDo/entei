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
const REQUEST_TIMEOUT: Duration = Duration::from_secs(15);

/// A shared client. `reqwest` pools connections, so reusing one client across
/// lookups keeps a subsequent word instant instead of re-establishing TLS.
fn client() -> &'static Client {
    use std::sync::OnceLock;
    static CLIENT: OnceLock<Client> = OnceLock::new();
    CLIENT.get_or_init(|| {
        Client::builder()
            .timeout(REQUEST_TIMEOUT)
            .build()
            .expect("the native fetch client builds with default settings")
    })
}

/// GET `url` and return the response body as text.
///
/// Only `http` and `https` are allowed — this is a network lookup, not a local
/// file reader, and letting a renderer-provided URL reach `file://` would be a
/// sandbox escape. A non-2xx status or a transport failure is an `Err` carrying
/// the reason (never the body, which the caller has not asked for and which the
/// trace log must not record).
pub async fn fetch_text(url: &str) -> Result<String, String> {
    let parsed = reqwest::Url::parse(url).map_err(|e| format!("invalid url: {e}"))?;
    if !matches!(parsed.scheme(), "http" | "https") {
        return Err(format!("unsupported url scheme: {}", parsed.scheme()));
    }
    let response = client()
        .get(parsed)
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
    use super::fetch_text;

    #[tokio::test]
    async fn rejects_non_http_scheme() {
        let err = fetch_text("file:///etc/passwd").await.unwrap_err();
        assert!(err.contains("unsupported url scheme"), "got: {err}");
    }

    #[tokio::test]
    async fn rejects_invalid_url() {
        let err = fetch_text("not a url").await.unwrap_err();
        assert!(err.contains("invalid url"), "got: {err}");
    }
}