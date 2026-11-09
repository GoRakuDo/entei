use std::sync::Arc;

use tauri_plugin_modules::jimaku::{JimakuClient, JimakuErrorKind};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::Mutex;

struct MockServer {
    base_url: String,
    requests: Arc<Mutex<Vec<(String, String)>>>,
}

impl MockServer {
    async fn start<F>(handler: F) -> Self
    where
        F: Fn(&str) -> (u16, String) + Send + Sync + 'static,
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
                    if let Some((path, auth)) = read_request(&mut stream).await {
                        requests.lock().await.push((path.clone(), auth));
                        let (status, body) = handler(&path);
                        let reason = if status == 200 {
                            "OK"
                        } else if status == 401 {
                            "Unauthorized"
                        } else if status == 404 {
                            "Not Found"
                        } else if status == 429 {
                            "Too Many Requests"
                        } else {
                            "Server Error"
                        };
                        let response = format!("HTTP/1.1 {status} {reason}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len());
                        let _ = stream.write_all(response.as_bytes()).await;
                    }
                });
            }
        });
        Self {
            base_url: format!("http://{address}/api/"),
            requests,
        }
    }
    async fn requests(&self) -> Vec<(String, String)> {
        self.requests.lock().await.clone()
    }
}

async fn read_request(stream: &mut TcpStream) -> Option<(String, String)> {
    let mut bytes = Vec::new();
    loop {
        if bytes.windows(4).any(|part| part == b"\r\n\r\n") {
            break;
        }
        let mut chunk = [0; 1024];
        let count = stream.read(&mut chunk).await.ok()?;
        if count == 0 {
            return None;
        }
        bytes.extend_from_slice(&chunk[..count]);
    }
    let headers = String::from_utf8_lossy(&bytes);
    let mut lines = headers.lines();
    let path = lines.next()?.split_whitespace().nth(1)?.to_string();
    let auth = lines
        .find_map(|line| {
            let (name, value) = line.split_once(':')?;
            name.eq_ignore_ascii_case("authorization")
                .then(|| value.trim().to_string())
        })
        .unwrap_or_default();
    Some((path, auth))
}

#[tokio::test]
async fn search_encodes_query_and_sends_raw_authorization_header() {
    let server = MockServer::start(|_| {
        (
            200,
            serde_json::json!([{"id":9,"name":"Frieren","flags":{"anime":true}}]).to_string(),
        )
    })
    .await;
    let client = JimakuClient::with_base_url(&server.base_url).expect("client");
    let entries = client
        .search_entries("test-key", "Sousou no Frieren", true)
        .await
        .expect("search");
    assert_eq!(entries[0].id, 9);
    let requests = server.requests().await;
    let request_url =
        reqwest::Url::parse(&format!("http://localhost{}", requests[0].0)).expect("request URL");
    let query: Vec<(String, String)> = request_url
        .query_pairs()
        .map(|(key, value)| (key.into_owned(), value.into_owned()))
        .collect();
    assert!(query
        .iter()
        .any(|(key, value)| key == "query" && value == "Sousou no Frieren"));
    assert!(requests[0].0.contains("anime=true"));
    assert_eq!(requests[0].1, "test-key");
}

#[tokio::test]
async fn combined_search_keeps_successful_side_sorts_and_deduplicates() {
    let server = MockServer::start(|path| {
        if path.contains("anime=true") {
            (200, serde_json::json!([{"id":2,"name":"Season 10","flags":{"anime":true}},{"id":1,"name":"Alpha","flags":{"anime":true}},{"id":3,"name":"Season 2","flags":{"anime":true}}]).to_string())
        } else {
            (200, serde_json::json!([{"id":2,"name":"Season 10 (duplicate)","flags":{"anime":false}},{"id":4,"name":"beta","flags":{"anime":false}}]).to_string())
        }
    }).await;
    let client = JimakuClient::with_base_url(&server.base_url).expect("client");
    let result = client
        .search_entries_combined("key", "series")
        .await
        .expect("best effort result");
    assert_eq!(
        result
            .iter()
            .map(|entry| entry.name.as_str())
            .collect::<Vec<_>>(),
        ["Alpha", "beta", "Season 2", "Season 10"]
    );
    assert_eq!(result.iter().filter(|entry| entry.id == 2).count(), 1);
}

#[tokio::test]
async fn combined_search_returns_hard_error_when_other_side_is_empty() {
    let server = MockServer::start(|path| {
        if path.contains("anime=true") {
            (200, "[]".into())
        } else {
            (429, "{}".into())
        }
    })
    .await;
    let client = JimakuClient::with_base_url(&server.base_url).expect("client");
    let error = client
        .search_entries_combined("secret-key", "series")
        .await
        .expect_err("hard error is preserved");
    assert_eq!(error.kind, JimakuErrorKind::RateLimit);
}

#[tokio::test]
async fn combined_search_fails_only_when_both_sides_fail() {
    let server = MockServer::start(|_| (401, "{}".into())).await;
    let client = JimakuClient::with_base_url(&server.base_url).expect("client");
    let error = client
        .search_entries_combined("secret-key", "series")
        .await
        .expect_err("both searches fail");
    assert_eq!(error.kind, JimakuErrorKind::Auth);
    assert!(!error.message.contains("secret-key"));
}

#[tokio::test]
async fn entry_files_encodes_episode_and_classifies_empty_and_status_errors() {
    let server = MockServer::start(|path| {
        if path.contains("episode=2") { (200, serde_json::json!([{"url":"https://cdn.example/sub.srt","name":"sub.srt","size":3,"last_modified":"today"}]).to_string()) }
        else if path.contains("/entries/404/") { (404, "{}".into()) } else { (200, "[]".into()) }
    }).await;
    let client = JimakuClient::with_base_url(&server.base_url).expect("client");
    let files = client.entry_files("key", 7, Some(2)).await.expect("files");
    assert_eq!(files[0].name, "sub.srt");
    assert!(server.requests().await[0].0.contains("episode=2"));
    assert_eq!(
        client
            .entry_files("key", 404, None)
            .await
            .expect_err("404")
            .kind,
        JimakuErrorKind::NotFound
    );
    assert_eq!(
        client
            .entry_files("key", 8, None)
            .await
            .expect_err("empty")
            .kind,
        JimakuErrorKind::Empty
    );
    assert_eq!(
        client
            .entry_files("key", -1, None)
            .await
            .expect_err("negative id")
            .kind,
        JimakuErrorKind::NotFound
    );
}

#[tokio::test]
async fn download_rejects_insecure_and_private_urls_without_requesting_them() {
    let client = JimakuClient::new();
    for url in [
        "http://example.com/sub.srt",
        "https://127.0.0.1/sub.srt",
        "https://[::1]/sub.srt",
        "https://localhost/sub.srt",
    ] {
        assert_eq!(
            client
                .download_subtitle(url)
                .await
                .expect_err("unsafe URL rejected")
                .kind,
            JimakuErrorKind::Network
        );
    }
}

#[tokio::test]
async fn live_jimaku_search_and_files_when_credentials_are_supplied() {
    let Ok(api_key) = std::env::var("ENTEI_LIVE_JIMAKU_API_KEY") else {
        return;
    };
    let client = JimakuClient::new();
    let entries = client
        .search_entries(&api_key, "Sousou no Frieren", true)
        .await
        .expect("live Jimaku anime search");
    let entry = entries.first().expect("live search has an entry");
    let files = client
        .entry_files(&api_key, entry.id, None)
        .await
        .expect("live Jimaku entry files");
    assert!(!files.is_empty());
}
