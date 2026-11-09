use std::sync::Arc;

use serde_json::{json, Value};
use tauri_plugin_modules::nadeshiko::{
    NadeshikoClient, NadeshikoContextOptions, NadeshikoErrorKind, NadeshikoSearchOptions,
};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::Mutex;

struct MockServer {
    base_url: String,
    requests: Arc<Mutex<Vec<(String, String, String, String)>>>,
}

impl MockServer {
    async fn start<F>(handler: F) -> Self
    where
        F: Fn(&str, &str) -> (u16, String) + Send + Sync + 'static,
    {
        let listener = TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind mock server");
        let address = listener.local_addr().expect("read mock address");
        let requests = Arc::new(Mutex::new(Vec::new()));
        let saved = Arc::clone(&requests);
        let handler = Arc::new(handler);
        tokio::spawn(async move {
            loop {
                let Ok((mut stream, _)) = listener.accept().await else {
                    break;
                };
                let requests = Arc::clone(&saved);
                let handler = Arc::clone(&handler);
                tokio::spawn(async move {
                    if let Some((method, path, auth, body)) = read_request(&mut stream).await {
                        requests.lock().await.push((
                            method.clone(),
                            path.clone(),
                            auth,
                            body.clone(),
                        ));
                        let (status, response_body) = handler(&method, &path);
                        let reason = if status == 200 {
                            "OK"
                        } else if status == 401 {
                            "Unauthorized"
                        } else if status == 403 {
                            "Forbidden"
                        } else if status == 429 {
                            "Too Many Requests"
                        } else {
                            "Server Error"
                        };
                        let response = format!("HTTP/1.1 {status} {reason}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nRetry-After: 7\r\nConnection: close\r\n\r\n{response_body}", response_body.len());
                        let _ = stream.write_all(response.as_bytes()).await;
                    }
                });
            }
        });
        Self {
            base_url: format!("http://{address}/v1/"),
            requests,
        }
    }
    async fn requests(&self) -> Vec<(String, String, String, String)> {
        self.requests.lock().await.clone()
    }
}

async fn read_request(stream: &mut TcpStream) -> Option<(String, String, String, String)> {
    let mut bytes = Vec::new();
    let header_end = loop {
        if let Some(index) = bytes.windows(4).position(|part| part == b"\r\n\r\n") {
            break index + 4;
        }
        let mut chunk = [0; 1024];
        let count = stream.read(&mut chunk).await.ok()?;
        if count == 0 {
            return None;
        }
        bytes.extend_from_slice(&chunk[..count]);
    };
    let headers = String::from_utf8_lossy(&bytes[..header_end]);
    let mut lines = headers.lines();
    let mut first = lines.next()?.split_whitespace();
    let method = first.next()?.to_string();
    let path = first.next()?.to_string();
    let auth = lines
        .find_map(|line| {
            let (name, value) = line.split_once(':')?;
            name.eq_ignore_ascii_case("authorization")
                .then(|| value.trim().to_string())
        })
        .unwrap_or_default();
    let content_length = headers
        .lines()
        .find_map(|line| {
            let (name, value) = line.split_once(':')?;
            name.eq_ignore_ascii_case("content-length")
                .then(|| value.trim().parse::<usize>().ok())
                .flatten()
        })
        .unwrap_or(0);
    while bytes.len() < header_end + content_length {
        let mut chunk = [0; 1024];
        let count = stream.read(&mut chunk).await.ok()?;
        if count == 0 {
            return None;
        }
        bytes.extend_from_slice(&chunk[..count]);
    }
    let body =
        String::from_utf8_lossy(bytes.get(header_end..header_end + content_length)?).into_owned();
    Some((method, path, auth, body))
}

#[tokio::test]
async fn search_sends_spec_body_and_normalizes_segments_and_pagination() {
    let server = MockServer::start(|method, path| {
        if method == "POST" && path == "/v1/search" {
            (200, json!({"segments":[{"publicId":"s1","position":2,"startTimeMs":719343,"episode":5,"mediaPublicId":"m1","textJa":{"content":"猫","highlight":"<mark>猫</mark>"},"textEn":{"content":"cat"},"urls":{"imageUrl":"https://cdn.test/i.webp","audioUrl":"https://cdn.test/a.mp3"}}],"includes":{"media":{"m1":{"nameJa":"作品"}}},"pagination":{"hasMore":true,"estimatedTotalHits":12,"estimatedTotalHitsRelation":"EXACT","cursor":"next"}}).to_string())
        } else { (404, "{}".into()) }
    }).await;
    let client = NadeshikoClient::with_base_url(&server.base_url).expect("client");
    let page = client
        .search("test-key", " 猫 ", NadeshikoSearchOptions::default())
        .await
        .expect("search");
    assert_eq!(page.segments[0].work_name, "作品");
    assert_eq!(page.segments[0].timestamp_label.as_deref(), Some("11:59"));
    assert_eq!(
        page.segments[0].image_url.as_deref(),
        Some("https://cdn.test/i.webp")
    );
    assert_eq!(page.next_cursor.as_deref(), Some("next"));
    let requests = server.requests().await;
    assert_eq!(requests[0].2, "Bearer test-key");
    let body: Value = serde_json::from_str(&requests[0].3).expect("search JSON body");
    assert_eq!(body["query"]["search"], "猫");
    assert_eq!(body["take"], 10);
    assert_eq!(body["sort"]["mode"], "RELEVANCE");
}

#[tokio::test]
async fn context_preserves_center_position_and_encodes_segment_id() {
    let server = MockServer::start(|_, path| {
        if path.contains("/media/segments/a%2Fb/context") {
            (200, json!({"segments":[{"publicId":"before","textJa":{"content":"前"}},{"publicId":"a/b","textJa":{"content":"中"}},{"publicId":"after","textJa":{"content":"後"}}]}).to_string())
        } else { (404, "{}".into()) }
    }).await;
    let client = NadeshikoClient::with_base_url(&server.base_url).expect("client");
    let context = client
        .segment_context("key", "a/b", NadeshikoContextOptions { take: Some(10) })
        .await
        .expect("context");
    assert_eq!(context.center.line, "中");
    assert_eq!(
        context
            .surrounding
            .iter()
            .map(|s| s.id.as_str())
            .collect::<Vec<_>>(),
        ["before", "after"]
    );
    assert_eq!(context.center_idx, 1);
    let request = server.requests().await.remove(0);
    assert!(request.1.contains("include=media"));
    assert!(request.1.contains("take=10"));
}

#[tokio::test]
async fn user_me_parses_profile_and_quota() {
    let server = MockServer::start(|_, _| (200, json!({"user":{"username":"learner","createdAt":"2026-01-01","role":"USER"},"quota":{"used":12,"limit":5000,"remaining":4988,"periodYyyymm":202611,"periodEnd":"2026-11-30T23:59:59.999Z"}}).to_string())).await;
    let client = NadeshikoClient::with_base_url(&server.base_url).expect("client");
    let user = client.user_me("key").await.expect("user me");
    assert_eq!(
        user.user.and_then(|u| u.username).as_deref(),
        Some("learner")
    );
    assert_eq!(user.quota.and_then(|q| q.remaining), Some(4988));
    assert_eq!(server.requests().await[0].2, "Bearer key");
}

#[tokio::test]
async fn errors_classify_invalid_key_quota_rate_limit_network_and_invalid_json() {
    for (status, body, expected) in [
        (401, "{}", NadeshikoErrorKind::InvalidKey),
        (403, "{}", NadeshikoErrorKind::InvalidKey),
        (
            429,
            r#"{"code":"QUOTA_EXCEEDED"}"#,
            NadeshikoErrorKind::QuotaExceeded,
        ),
        (
            429,
            r#"{"code":"RATE_LIMIT_EXCEEDED"}"#,
            NadeshikoErrorKind::RateLimited,
        ),
        (500, "{}", NadeshikoErrorKind::Network),
        (200, "not-json", NadeshikoErrorKind::InvalidResponse),
    ] {
        let body = body.to_string();
        let server = MockServer::start(move |_, _| (status, body.clone())).await;
        let client = NadeshikoClient::with_base_url(&server.base_url).expect("client");
        let error = client
            .user_me("secret-key")
            .await
            .expect_err("request failure");
        assert_eq!(error.kind, expected);
        assert!(!error.message.contains("secret-key"));
        if status == 429 && expected == NadeshikoErrorKind::RateLimited {
            assert_eq!(error.retry_after_seconds, Some(7));
        }
    }
}

#[tokio::test]
async fn empty_search_short_circuits_without_network_request() {
    let server = MockServer::start(|_, _| (500, "{}".into())).await;
    let client = NadeshikoClient::with_base_url(&server.base_url).expect("client");
    let page = client
        .search("key", "  ", NadeshikoSearchOptions::default())
        .await
        .expect("empty query");
    assert!(page.segments.is_empty());
    assert!(server.requests().await.is_empty());
}

#[tokio::test]
async fn live_nadeshiko_search_context_and_user_me_when_credentials_are_supplied() {
    let Ok(api_key) = std::env::var("ENTEI_LIVE_NADESHIKO_API_KEY") else {
        return;
    };
    let client = NadeshikoClient::new();
    let page = client
        .search(&api_key, "猫", NadeshikoSearchOptions::default())
        .await
        .expect("live Nadeshiko search");
    let segment = page.segments.first().expect("live search has a segment");
    let context = client
        .segment_context(&api_key, &segment.id, NadeshikoContextOptions::default())
        .await
        .expect("live segment context");
    assert!(!context.center.id.is_empty());
    let user = client
        .user_me(&api_key)
        .await
        .expect("live Nadeshiko user/me");
    assert!(user.user.is_some() || user.quota.is_some());
}
