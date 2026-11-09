//! Integration tests for the native AnkiConnect client.

use std::sync::{Arc, Mutex};

use serde_json::{json, Value};
use tauri_plugin_anki::{AnkiClient, AnkiConnectionState, AnkiErrorKind};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};

type MockHandler = dyn Fn(&Value) -> (u16, String) + Send + Sync;
struct MockServer {
    endpoint: String,
    requests: Arc<Mutex<Vec<Value>>>,
    connections: Arc<Mutex<usize>>,
}

impl MockServer {
    async fn start<F>(handler: F) -> Self
    where
        F: Fn(&Value) -> (u16, String) + Send + Sync + 'static,
    {
        let listener = TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind mock AnkiConnect server");
        let address = listener.local_addr().expect("read mock server address");
        let requests = Arc::new(Mutex::new(Vec::new()));
        let recorded = Arc::clone(&requests);
        let connections = Arc::new(Mutex::new(0));
        let accepted_connections = Arc::clone(&connections);
        let handler: Arc<MockHandler> = Arc::new(handler);

        tokio::spawn(async move {
            while let Ok((mut stream, _)) = listener.accept().await {
                *accepted_connections.lock().expect("connection counter") += 1;
                let recorded = Arc::clone(&recorded);
                let handler = Arc::clone(&handler);
                tokio::spawn(async move {
                    let Some(body) = read_request_body(&mut stream).await else {
                        return;
                    };
                    let Ok(request) = serde_json::from_str::<Value>(&body) else {
                        return;
                    };
                    recorded
                        .lock()
                        .expect("request mutex")
                        .push(request.clone());
                    let (status, response_body) = handler(&request);
                    let reason = match status {
                        200 => "OK",
                        302 => "Found",
                        401 => "Unauthorized",
                        403 => "Forbidden",
                        500 => "Internal Server Error",
                        _ => "Mock Response",
                    };
                    let head = format!(
                        "HTTP/1.1 {status} {reason}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\nLocation: /redirect-target\r\n\r\n",
                        response_body.len()
                    );
                    let _ = stream.write_all(head.as_bytes()).await;
                    if !response_body.is_empty() {
                        let _ = stream.write_all(response_body.as_bytes()).await;
                    }
                    let _ = stream.flush().await;
                });
            }
        });

        Self {
            endpoint: format!("http://{address}"),
            requests,
            connections,
        }
    }

    fn requests(&self) -> Vec<Value> {
        self.requests.lock().expect("request mutex").clone()
    }

    fn connections(&self) -> usize {
        *self.connections.lock().expect("connection counter")
    }
}

async fn read_request_body(stream: &mut TcpStream) -> Option<String> {
    let mut bytes = Vec::new();
    let header_end = loop {
        if let Some(position) = find_bytes(&bytes, b"\r\n\r\n") {
            break position + 4;
        }
        let mut chunk = [0_u8; 1024];
        let read = stream.read(&mut chunk).await.ok()?;
        if read == 0 {
            return None;
        }
        bytes.extend_from_slice(&chunk[..read]);
    };

    let headers = String::from_utf8_lossy(&bytes[..header_end]);
    let content_length = headers
        .lines()
        .find_map(|line| {
            let (name, value) = line.split_once(':')?;
            name.trim()
                .eq_ignore_ascii_case("content-length")
                .then(|| value.trim().parse::<usize>().ok())
                .flatten()
        })
        .unwrap_or(0);

    while bytes.len() < header_end + content_length {
        let mut chunk = [0_u8; 1024];
        let read = stream.read(&mut chunk).await.ok()?;
        if read == 0 {
            return None;
        }
        bytes.extend_from_slice(&chunk[..read]);
    }

    Some(String::from_utf8_lossy(&bytes[header_end..header_end + content_length]).into_owned())
}

fn find_bytes(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    haystack
        .windows(needle.len())
        .position(|window| window == needle)
}

fn envelope(result: Value, error: Value) -> String {
    json!({ "result": result, "error": error }).to_string()
}

fn client(endpoint: &str, key: Option<String>) -> AnkiClient {
    AnkiClient::new(Some(endpoint), key).expect("construct AnkiConnect client")
}

#[tokio::test]
async fn rejects_unresolvable_hostnames() {
    let endpoint = "http://anki-connect-host-that-does-not-exist.invalid:8765";
    let status = AnkiClient::check_connection_once(Some(endpoint), None).await;
    assert_eq!(status.state, AnkiConnectionState::Unavailable);
    assert_eq!(status.error_kind, Some(AnkiErrorKind::Network));
}

#[tokio::test]
async fn api_version_must_be_at_least_minimum_supported_version() {
    let client = AnkiClient::new(None, None).expect("construct default client");
    let error = client
        .request("version", Some(3), None)
        .await
        .expect_err("versions below v4 are rejected before opening a connection");
    assert_eq!(error.kind(), AnkiErrorKind::PermissionDenied);
}

#[tokio::test]
async fn connection_check_accepts_newer_compatible_anki_version() {
    let server = MockServer::start(|request| {
        let response = match request["action"].as_str().unwrap_or_default() {
            "version" => envelope(json!(7), Value::Null),
            "requestPermission" => envelope(json!({ "permission": "granted" }), Value::Null),
            "deckNames" => envelope(json!(["Default"]), Value::Null),
            "modelNames" => envelope(json!(["Basic"]), Value::Null),
            action => envelope(Value::Null, json!(format!("unsupported action: {action}"))),
        };
        (200, response)
    })
    .await;
    let status = client(&server.endpoint, None).check_connection().await;
    assert_eq!(status.state, AnkiConnectionState::Connected);
    assert_eq!(status.version, Some(7));
    assert_eq!(status.decks, ["Default"]);
    assert_eq!(status.models, ["Basic"]);
}

#[tokio::test]
async fn allows_version_four_bare_response_through_client() {
    let server = MockServer::start(|_| (200, json!(["Default", "Japanese"]).to_string())).await;
    let result = client(&server.endpoint, None)
        .request("deckNames", Some(4), None)
        .await
        .expect("legacy raw result is accepted");
    assert_eq!(result, json!(["Default", "Japanese"]));
}

#[tokio::test]
async fn allows_only_actions_from_typed_clients() {
    let client = AnkiClient::new(None, None).expect("construct default client");
    let error = client
        .request("deleteDecks", None, Some(json!({ "decks": ["Default"] })))
        .await
        .expect_err("unlisted destructive action must be blocked locally");
    assert_eq!(error.kind(), AnkiErrorKind::PermissionDenied);
}

#[tokio::test]
async fn blocks_path_and_url_media_sources_inside_notes() {
    let client = AnkiClient::new(None, None).expect("construct default client");
    for (action, params) in [
        (
            "addNote",
            json!({
                "note": { "deckName": "Default", "modelName": "Basic", "fields": {},
                    "audio": [{ "filename": "audio.mp3", "url": "http://169.254.169.254/latest/meta-data/" }] }
            }),
        ),
        (
            "addNote",
            json!({
                "note": { "deckName": "Default", "modelName": "Basic", "fields": {},
                    "picture": [{ "filename": "image.png", "path": "C:/private.png" }] }
            }),
        ),
        (
            "updateNoteFields",
            json!({
                "note": { "id": 123, "fields": {},
                    "video": [{ "filename": "video.mp4", "url": "http://127.0.0.1/private" }] }
            }),
        ),
    ] {
        let error = client
            .request(action, None, Some(params))
            .await
            .expect_err("Anki note media path/url bypass must be blocked");
        assert_eq!(error.kind(), AnkiErrorKind::PermissionDenied);
    }
}

#[tokio::test]
async fn allows_url_and_path_as_ordinary_note_field_names() {
    let server = MockServer::start(|request| {
        assert_eq!(request["action"], "addNote");
        (200, envelope(json!(123), Value::Null))
    })
    .await;
    let result = client(&server.endpoint, None)
        .request(
            "addNote",
            None,
            Some(json!({
                "note": {
                    "deckName": "Deck",
                    "modelName": "URL Path Notes",
                    "fields": { "url": "ordinary note content", "path": "literal text" },
                }
            })),
        )
        .await
        .expect("field names do not trigger media-source blocking");
    assert_eq!(result, json!(123));
}

#[tokio::test]
async fn store_media_file_rejects_path_and_url_sources() {
    let client = AnkiClient::new(None, None).expect("construct default client");
    for params in [
        json!({ "filename": "clip.mp3", "path": "C:/secret.mp3" }),
        json!({ "filename": "clip.mp3", "url": "http://example.invalid/clip.mp3" }),
        json!({ "filename": "clip.mp3", "data": "YWJj", "path": "C:/secret.mp3" }),
        json!({ "filename": "../outside.mp3", "data": "YWJj" }),
        json!({ "filename": "C:\\outside.mp3", "data": "YWJj" }),
        json!({ "filename": "", "data": "YWJj" }),
        json!({ "filename": "clip.mp3", "data": "not-base64!!!" }),
    ] {
        let error = client
            .request("storeMediaFile", None, Some(params))
            .await
            .expect_err("only base64 data source is allowed");
        assert_eq!(error.kind(), AnkiErrorKind::PermissionDenied);
    }
}

#[tokio::test]
async fn blocks_api_reflect_except_action_discovery() {
    let client = AnkiClient::new(None, None).expect("construct default client");
    let error = client
        .request(
            "apiReflect",
            None,
            Some(json!({ "scopes": ["actions", "models"] })),
        )
        .await
        .expect_err("apiReflect scopes must be limited");
    assert_eq!(error.kind(), AnkiErrorKind::PermissionDenied);
}

#[tokio::test]
async fn allows_api_reflect_action_discovery() {
    let server = MockServer::start(|request| {
        assert_eq!(request["action"], "apiReflect");
        assert_eq!(request["params"], json!({ "scopes": ["actions"] }));
        (
            200,
            envelope(json!({ "actions": ["version"] }), Value::Null),
        )
    })
    .await;
    let result = client(&server.endpoint, None)
        .request("apiReflect", None, Some(json!({ "scopes": ["actions"] })))
        .await
        .expect("AnkiDroid detection probe remains available");
    assert_eq!(result["actions"][0], "version");
}

#[tokio::test]
async fn store_media_file_accepts_filename_and_base64_data() {
    let server = MockServer::start(|request| {
        assert_eq!(request["action"], "storeMediaFile");
        assert_eq!(request["params"]["filename"], "clip.mp3");
        assert_eq!(request["params"]["data"], "YWJj");
        (200, envelope(json!("clip.mp3"), Value::Null))
    })
    .await;
    let result = client(&server.endpoint, None)
        .request(
            "storeMediaFile",
            None,
            Some(json!({ "filename": "clip.mp3", "data": "YWJj" })),
        )
        .await
        .expect("base64 media data succeeds");
    assert_eq!(result, json!("clip.mp3"));
}

#[tokio::test]
async fn returns_result_from_success_envelope() {
    let server = MockServer::start(|_| (200, envelope(json!(6), Value::Null))).await;
    let result = client(&server.endpoint, None)
        .request("version", None, None)
        .await
        .expect("successful response");
    assert_eq!(result, json!(6));
}

#[tokio::test]
async fn classifies_anki_error_envelope_as_server_error() {
    let server =
        MockServer::start(|_| (200, envelope(Value::Null, json!("unsupported action")))).await;
    let error = client(&server.endpoint, None)
        .request("deckNames", None, None)
        .await
        .expect_err("server error must be returned");
    assert_eq!(error.kind(), AnkiErrorKind::ServerError);
    assert_eq!(error.message(), "unsupported action");
}

#[tokio::test]
async fn classifies_missing_or_wrong_api_key() {
    let server = MockServer::start(|_| {
        (
            200,
            envelope(Value::Null, json!("valid api key must be provided")),
        )
    })
    .await;
    let error = client(&server.endpoint, None)
        .request("version", None, None)
        .await
        .expect_err("API key error must be returned");
    assert_eq!(error.kind(), AnkiErrorKind::ApiKeyRequired);
}

#[tokio::test]
async fn classifies_http_403_as_permission_denied() {
    let server = MockServer::start(|_| (403, String::new())).await;
    let error = client(&server.endpoint, None)
        .request("deckNames", None, None)
        .await
        .expect_err("forbidden status must be returned");
    assert_eq!(error.kind(), AnkiErrorKind::PermissionDenied);
}

#[tokio::test]
async fn rejects_public_ip_endpoints_before_connecting() {
    let error = match AnkiClient::new(Some("http://8.8.8.8:8765"), None) {
        Ok(_) => panic!("public IP endpoint must be rejected during validation"),
        Err(error) => error,
    };
    assert_eq!(error.kind(), AnkiErrorKind::PermissionDenied);
}

#[tokio::test]
async fn does_not_follow_redirects_to_other_hosts() {
    let server = MockServer::start(|_| (302, String::new())).await;
    let error = client(&server.endpoint, None)
        .request("version", None, None)
        .await
        .expect_err("redirect must remain blocked");
    assert_eq!(error.kind(), AnkiErrorKind::ServerError);
    assert_eq!(server.connections(), 1);
}

#[tokio::test]
async fn accepts_explicit_localhost_endpoint() {
    let server = MockServer::start(|_| (200, envelope(json!(6), Value::Null))).await;
    let endpoint = server.endpoint.replace("127.0.0.1", "localhost");
    let result = client(&endpoint, None)
        .request("version", None, None)
        .await
        .expect("localhost resolves only to loopback");
    assert_eq!(result, json!(6));
}

#[tokio::test]
async fn classifies_connection_refused_as_network_error() {
    let listener = TcpListener::bind("127.0.0.1:0")
        .await
        .expect("reserve port");
    let address = listener.local_addr().expect("read reserved port");
    drop(listener);

    let error = client(&format!("http://{address}"), None)
        .request("version", None, None)
        .await
        .expect_err("closed port must fail");
    assert_eq!(error.kind(), AnkiErrorKind::Network);
}

#[tokio::test]
async fn classifies_non_json_body_as_invalid_response() {
    let server = MockServer::start(|_| (200, "not json".to_string())).await;
    let error = client(&server.endpoint, None)
        .request("version", None, None)
        .await
        .expect_err("invalid JSON must fail");
    assert_eq!(error.kind(), AnkiErrorKind::InvalidResponse);
}

#[tokio::test]
async fn classifies_wrong_json_shape_as_invalid_response() {
    let server = MockServer::start(|_| (200, json!({ "unexpected": true }).to_string())).await;
    let error = client(&server.endpoint, None)
        .request("version", None, None)
        .await
        .expect_err("unexpected JSON shape must fail");
    assert_eq!(error.kind(), AnkiErrorKind::InvalidResponse);
}

#[tokio::test]
async fn sends_key_and_omits_null_params() {
    let server = MockServer::start(|_| (200, envelope(json!(["Default"]), Value::Null))).await;
    client(&server.endpoint, Some("secret-key".to_string()))
        .request("deckNames", None, Some(Value::Null))
        .await
        .expect("request succeeds");

    let requests = server.requests();
    assert_eq!(requests.len(), 1);
    assert_eq!(requests[0]["action"], "deckNames");
    assert_eq!(requests[0]["version"], 6);
    assert_eq!(requests[0]["key"], "secret-key");
    assert!(requests[0].get("params").is_none());
}

#[tokio::test]
async fn connection_check_returns_version_permission_decks_and_models() {
    let server = MockServer::start(|request| {
        let response = match request["action"].as_str().unwrap_or_default() {
            "version" => envelope(json!(6), Value::Null),
            "requestPermission" => envelope(
                json!({ "permission": "granted", "requireApikey": true, "version": 6 }),
                Value::Null,
            ),
            "deckNames" => envelope(json!(["Default", "Mining"]), Value::Null),
            "modelNames" => envelope(json!(["Basic", "DenChou"]), Value::Null),
            action => envelope(Value::Null, json!(format!("unsupported action: {action}"))),
        };
        (200, response)
    })
    .await;

    let status = client(&server.endpoint, Some("secret-key".to_string()))
        .check_connection()
        .await;
    assert_eq!(status.state, AnkiConnectionState::Connected);
    assert_eq!(status.version, Some(6));
    assert!(status.require_api_key);
    assert_eq!(status.decks, ["Default", "Mining"]);
    assert_eq!(status.models, ["Basic", "DenChou"]);
    assert!(status.error_kind.is_none());
}

#[tokio::test]
async fn connection_check_reports_api_key_required_state() {
    let server = MockServer::start(|_| {
        (
            200,
            envelope(Value::Null, json!("valid api key must be provided")),
        )
    })
    .await;

    let status = client(&server.endpoint, None).check_connection().await;
    assert_eq!(status.state, AnkiConnectionState::ApiKeyRequired);
    assert_eq!(status.error_kind, Some(AnkiErrorKind::ApiKeyRequired));
}

#[tokio::test]
async fn connection_check_continues_when_permission_action_is_unsupported() {
    let server = MockServer::start(|request| {
        let response = match request["action"].as_str().unwrap_or_default() {
            "version" => envelope(json!(6), Value::Null),
            "requestPermission" => envelope(Value::Null, json!("unsupported action")),
            "deckNames" => envelope(json!(["Default"]), Value::Null),
            "modelNames" => envelope(json!(["Basic"]), Value::Null),
            action => envelope(Value::Null, json!(format!("unsupported action: {action}"))),
        };
        (200, response)
    })
    .await;

    let status = client(&server.endpoint, None).check_connection().await;
    assert_eq!(status.state, AnkiConnectionState::Connected);
    assert_eq!(status.decks, ["Default"]);
    assert_eq!(status.models, ["Basic"]);
}

#[tokio::test]
async fn connection_check_reports_permission_denied_result() {
    let server = MockServer::start(|request| {
        let response = match request["action"].as_str().unwrap_or_default() {
            "version" => envelope(json!(6), Value::Null),
            "requestPermission" => envelope(json!({ "permission": "denied" }), Value::Null),
            action => envelope(Value::Null, json!(format!("unexpected action: {action}"))),
        };
        (200, response)
    })
    .await;

    let status = client(&server.endpoint, None).check_connection().await;
    assert_eq!(status.state, AnkiConnectionState::PermissionDenied);
    assert_eq!(status.error_kind, Some(AnkiErrorKind::PermissionDenied));
}

#[tokio::test]
async fn connection_check_rejects_invalid_deck_model_shape() {
    let server = MockServer::start(|request| {
        let response = match request["action"].as_str().unwrap_or_default() {
            "version" => envelope(json!(6), Value::Null),
            "requestPermission" => envelope(
                json!({ "permission": "granted", "requireApikey": false }),
                Value::Null,
            ),
            "deckNames" => envelope(json!({ "not": "an array" }), Value::Null),
            "modelNames" => envelope(json!(["Basic"]), Value::Null),
            action => envelope(Value::Null, json!(format!("unsupported action: {action}"))),
        };
        (200, response)
    })
    .await;

    let status = client(&server.endpoint, None).check_connection().await;
    assert_eq!(status.state, AnkiConnectionState::UnknownError);
    assert_eq!(status.error_kind, Some(AnkiErrorKind::InvalidResponse));
}

#[tokio::test]
async fn connection_check_reports_unavailable_state() {
    let listener = TcpListener::bind("127.0.0.1:0")
        .await
        .expect("reserve port");
    let address = listener.local_addr().expect("read reserved port");
    drop(listener);

    let status = client(&format!("http://{address}"), None)
        .check_connection()
        .await;
    assert_eq!(status.state, AnkiConnectionState::Unavailable);
    assert_eq!(status.error_kind, Some(AnkiErrorKind::Network));
}
