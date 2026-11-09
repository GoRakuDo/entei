//! AnkiConnect client core.
//!
//! The client speaks the AnkiConnect HTTP protocol straight from the Rust
//! process. The browser never opens a socket to the AnkiConnect endpoint, so
//! Private Network Access preflights and browser CORS checks do not apply.
//! A native request also skips the webview's network stack.
//!
//! Protocol facts, taken from the AnkiConnect sources (`plugin/web.py` and
//! `plugin/__init__.py`):
//!
//! - A request is a JSON `POST` body `{ action, version, params?, key? }`.
//! - From API version 5 onwards a success is answered with the envelope
//!   `{ "result": ..., "error": null }` and a failure with
//!   `{ "result": null, "error": "<message>" }`.
//! - API version 4 and below answer a success with the bare result value.
//!   Failures are still reported with the error envelope, because the
//!   exception reply is always enveloped.
//! - When an API key is configured, every action except `requestPermission`
//!   fails with `valid api key must be provided`.
//! - `requestPermission` answers `{ permission, requireApikey, version }`.
//!   A native client sends no `Origin` header, so AnkiConnect grants the
//!   permission without asking the user.
//! - Endpoint hosts are restricted to loopback, RFC 1918 private IPv4 and
//!   link-local addresses. Hostnames are resolved and pinned before the
//!   request, redirects and environment proxies are disabled, preventing
//!   public-host SSRF and redirect/DNS-rebinding bypasses.

use std::collections::HashMap;
use std::net::{IpAddr, SocketAddr};
use std::sync::OnceLock;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tokio::join;
use tokio::net::lookup_host;
use tokio::sync::Mutex;
use tokio::time::{timeout, timeout_at};

/// Default AnkiConnect endpoint (loopback).
pub const DEFAULT_ENDPOINT: &str = "http://127.0.0.1:8765";

/// AnkiConnect API version Entei speaks.
pub const DEFAULT_API_VERSION: u32 = 6;

/// Lowest request version whose AnkiConnect API is supported by Entei.
const MIN_API_VERSION: u32 = 4;

/// First API version that answers with the `{ result, error }` envelope.
const ENVELOPE_MIN_VERSION: u32 = 5;

/// Upper bound for a whole read/write action (connect + response).
const REQUEST_TIMEOUT: Duration = Duration::from_secs(30);

/// Connection checks are read-only and should return promptly when Anki stalls.
const CONNECTION_CHECK_TIMEOUT: Duration = Duration::from_secs(10);

/// Upper bound for the TCP/TLS handshake. AnkiConnect runs on loopback, so
/// a healthy connection is established in well under a millisecond; the
/// budget only matters when Anki is not running at all.
const CONNECT_TIMEOUT: Duration = Duration::from_secs(3);

/// Actions exposed to Entei's webview, limited to the existing typed clients.
const ALLOWED_ACTIONS: &[&str] = &[
    "version",
    "requestPermission",
    "deckNames",
    "modelNames",
    "modelFieldNames",
    "canAddNotes",
    "addNote",
    "storeMediaFile",
    "findNotes",
    "notesInfo",
    "updateNoteFields",
    "addTags",
    "cardsInfo",
    "findCards",
    "apiReflect",
];

/// The failure classes the web layer can branch on.
///
/// The names are stable and use kebab-case when serialized.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum AnkiErrorKind {
    /// AnkiConnect could not be reached (not running, wrong port, timeout).
    Network,
    /// AnkiConnect demands an API key, or the supplied one was rejected.
    ApiKeyRequired,
    /// AnkiConnect refused the request (origin / permission).
    PermissionDenied,
    /// AnkiConnect answered with an error message.
    ServerError,
    /// The answer was not a shape AnkiConnect is supposed to produce.
    InvalidResponse,
}

/// A classified AnkiConnect failure.
#[derive(Debug, Clone, thiserror::Error)]
#[error("{message}")]
pub struct AnkiError {
    kind: AnkiErrorKind,
    message: String,
}

impl AnkiError {
    fn new(kind: AnkiErrorKind, message: impl Into<String>) -> Self {
        Self {
            kind,
            message: message.into(),
        }
    }

    /// The failure class.
    pub fn kind(&self) -> AnkiErrorKind {
        self.kind
    }

    /// The human-readable reason. API key values are never included.
    pub fn message(&self) -> &str {
        &self.message
    }
}

/// A request body as AnkiConnect expects it.
#[derive(Debug, Clone, Serialize)]
pub struct AnkiRequest {
    /// The action name, e.g. `deckNames`.
    pub action: String,
    /// The API version. `6` is the current one.
    pub version: u32,
    /// Action parameters. Omitted when there are none.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub params: Option<Value>,
    /// The API key. Omitted when there is none.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub key: Option<String>,
}

impl AnkiRequest {
    /// A request without parameters and without a key.
    pub fn new(action: impl Into<String>, version: u32) -> Self {
        Self {
            action: action.into(),
            version,
            params: None,
            key: None,
        }
    }

    /// Attach the action parameters.
    ///
    /// AnkiConnect types `params` as an object, so a JSON `null` would fail
    /// its request schema. A `null` is therefore dropped instead of sent.
    pub fn with_params(mut self, params: Option<Value>) -> Self {
        self.params = params.filter(|value| !value.is_null());
        self
    }

    /// Attach the API key. An empty key is dropped: AnkiConnect compares the
    /// key against its own setting, and an empty string would be rejected
    /// like a wrong key instead of behaving like "no key configured".
    pub fn with_key(mut self, key: Option<String>) -> Self {
        self.key = key.filter(|value| !value.trim().is_empty());
        self
    }
}

/// The response envelope of AnkiConnect.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AnkiResponse {
    /// The action result. `null` when the action failed.
    pub result: Option<Value>,
    /// The error message. `null` when the action succeeded.
    #[serde(default)]
    pub error: Option<String>,
}

/// The connection states the web layer maps onto its UI.
///
/// The names match the states the TypeScript client used, so the web layer
/// can be switched over without touching the UI code.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum AnkiConnectionState {
    /// AnkiConnect answered and the deck / model listing worked.
    Connected,
    /// AnkiConnect could not be reached at all.
    Unavailable,
    /// An API key is required (or the supplied one was rejected).
    ApiKeyRequired,
    /// AnkiConnect refused the request.
    PermissionDenied,
    /// Something else went wrong (server error, malformed answer).
    UnknownError,
}

/// The outcome of a full connection check.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AnkiConnectionStatus {
    /// The connection state.
    pub state: AnkiConnectionState,
    /// The endpoint the check ran against.
    pub endpoint: String,
    /// The API version AnkiConnect reported.
    pub version: Option<u32>,
    /// Whether AnkiConnect has an API key configured.
    pub require_api_key: bool,
    /// The deck names. Empty when the listing failed.
    pub decks: Vec<String>,
    /// The note type names. Empty when the listing failed.
    pub models: Vec<String>,
    /// The reason for a failed check.
    pub message: Option<String>,
    /// The failure class of a failed check.
    pub error_kind: Option<AnkiErrorKind>,
}

impl AnkiConnectionStatus {
    fn new(endpoint: String) -> Self {
        Self {
            state: AnkiConnectionState::UnknownError,
            endpoint,
            version: None,
            require_api_key: false,
            decks: Vec::new(),
            models: Vec::new(),
            message: None,
            error_kind: None,
        }
    }

    fn failed(mut self, error: &AnkiError) -> Self {
        self.state = match error.kind() {
            AnkiErrorKind::Network => AnkiConnectionState::Unavailable,
            AnkiErrorKind::ApiKeyRequired => AnkiConnectionState::ApiKeyRequired,
            AnkiErrorKind::PermissionDenied => AnkiConnectionState::PermissionDenied,
            AnkiErrorKind::ServerError | AnkiErrorKind::InvalidResponse => {
                AnkiConnectionState::UnknownError
            }
        };
        self.message = Some(error.message().to_string());
        self.error_kind = Some(error.kind());
        self
    }
}

/// A native AnkiConnect client.
pub struct AnkiClient {
    endpoint: String,
    api_key: Option<String>,
}

impl AnkiClient {
    /// Build a client for an endpoint and an optional API key.
    ///
    /// An empty endpoint falls back to [`DEFAULT_ENDPOINT`]. An endpoint
    /// without a scheme is treated as `http://`.
    pub fn new(endpoint: Option<&str>, api_key: Option<String>) -> Result<Self, AnkiError> {
        let endpoint = normalize_endpoint(endpoint)?;
        Ok(Self {
            endpoint,
            api_key: api_key.filter(|value| !value.trim().is_empty()),
        })
    }

    /// The endpoint this client talks to.
    pub fn endpoint(&self) -> &str {
        &self.endpoint
    }

    /// Check one endpoint once; malformed and unreachable states are returned normally.
    pub async fn check_connection_once(
        endpoint: Option<&str>,
        api_key: Option<String>,
    ) -> AnkiConnectionStatus {
        let client = match Self::new(endpoint, api_key) {
            Ok(client) => client,
            Err(error) => {
                return AnkiConnectionStatus::new(endpoint.unwrap_or(DEFAULT_ENDPOINT).to_string())
                    .failed(&error);
            }
        };
        client.check_connection().await
    }

    /// Run an action and return its result.
    ///
    /// `version` defaults to [`DEFAULT_API_VERSION`].
    pub async fn request(
        &self,
        action: &str,
        version: Option<u32>,
        params: Option<Value>,
    ) -> Result<Value, AnkiError> {
        self.request_with_timeout(action, version, params, REQUEST_TIMEOUT)
            .await
    }

    async fn request_with_timeout(
        &self,
        action: &str,
        version: Option<u32>,
        params: Option<Value>,
        timeout: Duration,
    ) -> Result<Value, AnkiError> {
        validate_action(action, params.as_ref())?;
        let version = version.unwrap_or(DEFAULT_API_VERSION);
        if version < MIN_API_VERSION {
            return Err(AnkiError::new(
                AnkiErrorKind::PermissionDenied,
                "AnkiConnect API versions below 4 are not supported.",
            ));
        }
        let request = AnkiRequest::new(action, version)
            .with_params(params)
            .with_key(self.api_key.clone());
        self.send(&request, timeout).await
    }

    /// Run the full connection check. Connection failures are reported in the status.
    pub async fn check_connection(&self) -> AnkiConnectionStatus {
        let check = timeout(CONNECTION_CHECK_TIMEOUT, self.run_connection_check()).await;
        match check {
            Ok(Ok(status)) => status,
            Ok(Err(error)) => AnkiConnectionStatus::new(self.endpoint.clone()).failed(&error),
            Err(_) => AnkiConnectionStatus::new(self.endpoint.clone())
                .failed(&classify_request_timeout(CONNECTION_CHECK_TIMEOUT)),
        }
    }

    async fn run_connection_check(&self) -> Result<AnkiConnectionStatus, AnkiError> {
        let mut status = AnkiConnectionStatus::new(self.endpoint.clone());

        // The order follows the protocol contract: version proves reachability,
        // requestPermission reports permission and API-key configuration, and
        // deck/model listings prove the collection can actually be read.
        // A failed permission probe is non-fatal unless it reports denial or a
        // missing API key; older builds may not implement requestPermission.
        let version = match self
            .request_with_timeout("version", None, None, REQUEST_TIMEOUT)
            .await
        {
            Ok(value) => value,
            Err(error) => return Ok(status.failed(&error)),
        };
        status.version = version.as_u64().and_then(|value| u32::try_from(value).ok());
        let permission = self
            .request_with_timeout("requestPermission", None, None, REQUEST_TIMEOUT)
            .await;
        if let Err(error) = &permission {
            if matches!(
                error.kind(),
                AnkiErrorKind::PermissionDenied | AnkiErrorKind::ApiKeyRequired
            ) {
                return Ok(status.failed(error));
            }
            if error.kind() == AnkiErrorKind::Network {
                return Ok(status.failed(error));
            }
        }
        match permission {
            Ok(value) => {
                if value.get("permission").and_then(Value::as_str) == Some("denied") {
                    let error = AnkiError::new(
                        AnkiErrorKind::PermissionDenied,
                        "AnkiConnect denied the permission request.",
                    );
                    return Ok(status.failed(&error));
                }
                // AnkiConnect spells the flag `requireApikey`; the
                // alternative spelling is accepted so a future rename does
                // not silently drop the hint.
                status.require_api_key = value
                    .get("requireApikey")
                    .or_else(|| value.get("requireApiKey"))
                    .and_then(Value::as_bool)
                    .unwrap_or(false);
            }
            Err(error) => match error.kind() {
                AnkiErrorKind::PermissionDenied | AnkiErrorKind::ApiKeyRequired => {
                    return Ok(status.failed(&error));
                }
                AnkiErrorKind::Network => return Ok(status.failed(&error)),
                AnkiErrorKind::ServerError | AnkiErrorKind::InvalidResponse => {}
            },
        }

        let (decks, models) = join!(
            self.request_with_timeout("deckNames", None, None, REQUEST_TIMEOUT),
            self.request_with_timeout("modelNames", None, None, REQUEST_TIMEOUT)
        );

        match decks.and_then(|value| string_list(&value)) {
            Ok(value) => status.decks = value,
            Err(error) => return Ok(status.failed(&error)),
        }
        match models.and_then(|value| string_list(&value)) {
            Ok(value) => status.models = value,
            Err(error) => return Ok(status.failed(&error)),
        }

        status.state = AnkiConnectionState::Connected;
        Ok(status)
    }

    /// Send a prepared request and unwrap the result.
    async fn send(
        &self,
        request: &AnkiRequest,
        request_timeout: Duration,
    ) -> Result<Value, AnkiError> {
        let body = serde_json::to_vec(request).map_err(|error| {
            AnkiError::new(
                AnkiErrorKind::InvalidResponse,
                format!("failed to serialize the AnkiConnect request: {error}"),
            )
        })?;
        if body.len() > MAX_RESPONSE_BYTES {
            return Err(AnkiError::new(
                AnkiErrorKind::InvalidResponse,
                "AnkiConnect request exceeded the 64 MiB safety limit.",
            ));
        }

        let http = shared_http_client(&self.endpoint, request_timeout).await?;
        let response = http
            .post(&self.endpoint)
            .header("Content-Type", "application/json")
            .body(body)
            .send()
            .await
            .map_err(|error| classify_transport_error(&error))?;

        let status = response.status();
        let bytes = read_limited_response(response, request_timeout).await?;

        if !status.is_success() {
            return Err(classify_status(status));
        }

        let parsed = parse_response(&bytes, request.version)?;
        if let Some(message) = parsed.error {
            return Err(AnkiError::new(classify_error_message(&message), message));
        }

        Ok(parsed.result.unwrap_or(Value::Null))
    }
}

fn has_explicit_port_in_input(endpoint: &str) -> bool {
    endpoint
        .split_once("://")
        .map(|(_, authority)| authority)
        .and_then(|authority| authority.split('/').next())
        .and_then(|authority| {
            let authority = authority
                .rsplit_once('@')
                .map_or(authority, |(_, host)| host);
            if authority.starts_with('[') {
                authority.split_once(']')?.1.strip_prefix(':')
            } else {
                authority.rsplit_once(':').map(|(_, port)| port)
            }
        })
        .is_some_and(|port| !port.is_empty() && port.parse::<u16>().is_ok())
}

/// Normalize the endpoint the caller configured.
///
/// An empty value falls back to the default endpoint, a missing scheme is
/// filled in with `http://`, and an omitted port defaults to 8765.
fn normalize_endpoint(raw: Option<&str>) -> Result<String, AnkiError> {
    let trimmed = raw
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or(DEFAULT_ENDPOINT);

    let with_scheme = if trimmed.contains("://") {
        trimmed.to_string()
    } else {
        format!("http://{trimmed}")
    };
    let mut url = reqwest::Url::parse(&with_scheme).map_err(|error| {
        AnkiError::new(
            AnkiErrorKind::Network,
            format!("invalid AnkiConnect endpoint: {error}"),
        )
    })?;

    if !matches!(url.scheme(), "http" | "https") {
        return Err(AnkiError::new(
            AnkiErrorKind::PermissionDenied,
            "AnkiConnect endpoint must use HTTP or HTTPS.",
        ));
    }
    if url.path() != "/" {
        return Err(AnkiError::new(
            AnkiErrorKind::PermissionDenied,
            "AnkiConnect endpoint must not contain a path.",
        ));
    }
    if !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err(AnkiError::new(
            AnkiErrorKind::PermissionDenied,
            "AnkiConnect endpoint must not contain credentials, a query, or a fragment.",
        ));
    }
    if let Some(host) = url.host_str() {
        let unbracketed_host = host
            .strip_prefix('[')
            .and_then(|host| host.strip_suffix(']'))
            .unwrap_or(host);
        if host.eq_ignore_ascii_case("localhost") {
            // The hostname is handled as a loopback literal during resolution.
        } else if let Ok(address) = unbracketed_host.parse::<IpAddr>() {
            if !is_allowed_ip(address) {
                return Err(AnkiError::new(
                    AnkiErrorKind::PermissionDenied,
                    "AnkiConnect endpoint must use a loopback, RFC 1918 private, or link-local address other than 169.254.169.254.",
                ));
            }
        }
    }
    let has_explicit_port = has_explicit_port_in_input(&with_scheme);
    let port = match url.port() {
        Some(port) => port,
        None if has_explicit_port => url.port_or_known_default().unwrap_or(8765),
        None => 8765,
    };
    if url.port().is_none() && !has_explicit_port {
        url.set_port(Some(port)).map_err(|_| {
            AnkiError::new(
                AnkiErrorKind::Network,
                "could not set the AnkiConnect port.",
            )
        })?;
    }

    let scheme = url.scheme().to_string();
    let host = url.host_str().ok_or_else(|| {
        AnkiError::new(AnkiErrorKind::Network, "AnkiConnect endpoint has no host.")
    })?;
    Ok(format!("{scheme}://{host}:{port}"))
}

/// Build a client only after resolving and validating the endpoint. DNS results
/// are pinned into reqwest, redirects are disabled and environment proxies are
/// ignored so none of those paths can bypass the private-network allowlist.
async fn build_validated_http_client(
    endpoint: &str,
    request_timeout: Duration,
) -> Result<reqwest::Client, AnkiError> {
    let url = reqwest::Url::parse(endpoint).map_err(|error| {
        AnkiError::new(
            AnkiErrorKind::Network,
            format!("invalid AnkiConnect endpoint: {error}"),
        )
    })?;
    let host = url.host_str().ok_or_else(|| {
        AnkiError::new(AnkiErrorKind::Network, "AnkiConnect endpoint has no host.")
    })?;
    let address_host = host
        .strip_prefix('[')
        .and_then(|host| host.strip_suffix(']'))
        .unwrap_or(host);
    let port = url.port_or_known_default().unwrap_or(8765);

    let addresses = if let Ok(address) = address_host.parse::<IpAddr>() {
        vec![SocketAddr::new(address, port)]
    } else if host.eq_ignore_ascii_case("localhost") {
        vec![SocketAddr::new(
            IpAddr::V4(std::net::Ipv4Addr::LOCALHOST),
            port,
        )]
    } else {
        let resolved = timeout(CONNECT_TIMEOUT, lookup_host((address_host, port)))
            .await
            .map_err(|_| {
                AnkiError::new(
                    AnkiErrorKind::Network,
                    "timed out resolving the AnkiConnect endpoint.",
                )
            })?
            .map_err(|error| {
                AnkiError::new(
                    AnkiErrorKind::Network,
                    format!("could not resolve the AnkiConnect endpoint: {error}"),
                )
            })?;
        resolved.collect::<Vec<_>>()
    };

    validate_resolved_addresses(&addresses)?;

    let mut builder = reqwest::Client::builder()
        .timeout(request_timeout)
        .connect_timeout(CONNECT_TIMEOUT)
        .redirect(reqwest::redirect::Policy::none())
        .no_proxy();

    if address_host.parse::<IpAddr>().is_err() {
        builder = builder.resolve_to_addrs(host, &addresses);
    }

    builder.build().map_err(|error| {
        AnkiError::new(
            AnkiErrorKind::Network,
            format!("failed to build the AnkiConnect http client: {error}"),
        )
    })
}

fn validate_resolved_addresses(addresses: &[SocketAddr]) -> Result<(), AnkiError> {
    if addresses.is_empty() || addresses.iter().any(|address| !is_allowed_ip(address.ip())) {
        return Err(AnkiError::new(
            AnkiErrorKind::PermissionDenied,
            "AnkiConnect endpoint must resolve only to loopback, RFC 1918 private, or link-local addresses other than 169.254.169.254.",
        ));
    }
    Ok(())
}

/// A small process-wide pool keeps native connections alive across separate
/// Tauri invokes. DNS validation is refreshed at least every minute; expired
/// entries are rebuilt and pinned to the newly validated private addresses.
async fn shared_http_client(
    endpoint: &str,
    request_timeout: Duration,
) -> Result<reqwest::Client, AnkiError> {
    const MAX_CACHED_ENDPOINTS: usize = 16;
    const DNS_VALIDATION_TTL: Duration = Duration::from_secs(60);

    struct CachedClient {
        client: reqwest::Client,
        expires_at: tokio::time::Instant,
    }

    static CLIENTS: OnceLock<Mutex<HashMap<(String, Duration), CachedClient>>> = OnceLock::new();

    let clients = CLIENTS.get_or_init(|| Mutex::new(HashMap::new()));
    let cache_key = (endpoint.to_string(), request_timeout);
    {
        let mut clients = clients.lock().await;
        if let Some(cached) = clients.get(&cache_key) {
            if cached.expires_at > tokio::time::Instant::now() {
                return Ok(cached.client.clone());
            }
            clients.remove(&cache_key);
        }
    }

    let client = build_validated_http_client(endpoint, request_timeout).await?;
    let mut clients = clients.lock().await;
    if let Some(cached) = clients.get(&cache_key) {
        if cached.expires_at > tokio::time::Instant::now() {
            return Ok(cached.client.clone());
        }
    }
    if clients.len() >= MAX_CACHED_ENDPOINTS {
        if let Some(evicted) = clients.keys().next().cloned() {
            clients.remove(&evicted);
        }
    }
    clients.insert(
        cache_key,
        CachedClient {
            client: client.clone(),
            expires_at: tokio::time::Instant::now() + DNS_VALIDATION_TTL,
        },
    );
    Ok(client)
}

/// Loopback, RFC 1918 IPv4 and link-local IPv4/IPv6 only, excluding
/// 169.254.169.254. IPv4-mapped IPv6 addresses use the same IPv4 check.
fn is_allowed_ip(address: IpAddr) -> bool {
    match address {
        IpAddr::V4(ip) => {
            let octets = ip.octets();
            if octets[0] == 127 || octets[0] == 10 {
                return true;
            }
            if (octets[0] == 172 && (16..=31).contains(&octets[1]))
                || (octets[0] == 192 && octets[1] == 168)
            {
                return true;
            }
            octets[0] == 169 && octets[1] == 254 && !(octets[2] == 169 && octets[3] == 254)
        }
        IpAddr::V6(ip) => {
            ip.is_loopback()
                || ip.is_unicast_link_local()
                || ip
                    .to_ipv4_mapped()
                    .is_some_and(|mapped| is_allowed_ip(IpAddr::V4(mapped)))
        }
    }
}

/// Validate the action boundary exposed to the webview.
fn validate_action(action: &str, params: Option<&Value>) -> Result<(), AnkiError> {
    if !ALLOWED_ACTIONS.contains(&action) {
        return Err(AnkiError::new(
            AnkiErrorKind::PermissionDenied,
            format!("AnkiConnect action `{action}` is not enabled for Entei."),
        ));
    }

    if matches!(action, "addNote" | "updateNoteFields")
        && params.is_some_and(contains_external_media_source)
    {
        return Err(AnkiError::new(
            AnkiErrorKind::PermissionDenied,
            "Anki note picture, audio, and video sources must use storeMediaFile with base64 data; path and url sources are disabled.",
        ));
    }

    if action == "apiReflect"
        && params.is_some_and(|params| params != &serde_json::json!({ "scopes": ["actions"] }))
    {
        return Err(AnkiError::new(
            AnkiErrorKind::PermissionDenied,
            "apiReflect is limited to action-list discovery.",
        ));
    }

    if action == "storeMediaFile" {
        let Some(params) = params.and_then(Value::as_object) else {
            return Err(AnkiError::new(
                AnkiErrorKind::PermissionDenied,
                "storeMediaFile requires filename and base64 data fields.",
            ));
        };
        let filename = params.get("filename").and_then(Value::as_str);
        if params.contains_key("path")
            || params.contains_key("url")
            || !filename.is_some_and(is_safe_media_filename)
            || !params
                .get("data")
                .and_then(Value::as_str)
                .is_some_and(is_base64_data)
        {
            return Err(AnkiError::new(
                AnkiErrorKind::PermissionDenied,
                "storeMediaFile is limited to filename plus base64 data; path and url sources are disabled.",
            ));
        }
    }

    Ok(())
}

fn contains_external_media_source(params: &Value) -> bool {
    let Some(object) = params.as_object() else {
        return false;
    };
    let Some(note) = object.get("note").and_then(Value::as_object) else {
        return false;
    };

    ["picture", "audio", "video"].iter().any(|kind| {
        note.get(*kind)
            .is_some_and(contains_external_media_reference)
    })
}

fn contains_external_media_reference(value: &Value) -> bool {
    match value {
        Value::Object(object) => {
            object.contains_key("url")
                || object.contains_key("path")
                || object
                    .get("filename")
                    .and_then(Value::as_str)
                    .is_some_and(|filename| !is_safe_media_filename(filename))
                || object.values().any(contains_external_media_reference)
        }
        Value::Array(items) => items.iter().any(contains_external_media_reference),
        _ => false,
    }
}

fn is_safe_media_filename(filename: &str) -> bool {
    !filename.is_empty()
        && filename != "."
        && filename != ".."
        && !filename.contains(['/', '\\', ':'])
        && !filename.chars().any(char::is_control)
}

fn is_base64_data(data: &str) -> bool {
    use base64::Engine;

    !data.is_empty()
        && base64::engine::general_purpose::STANDARD
            .decode(data)
            .is_ok()
}

const MAX_RESPONSE_BYTES: usize = 64 * 1024 * 1024;

async fn read_limited_response(
    mut response: reqwest::Response,
    request_timeout: Duration,
) -> Result<Vec<u8>, AnkiError> {
    if response
        .content_length()
        .is_some_and(|length| length > MAX_RESPONSE_BYTES as u64)
    {
        return Err(AnkiError::new(
            AnkiErrorKind::InvalidResponse,
            "AnkiConnect response exceeded the 64 MiB safety limit.",
        ));
    }

    let deadline = tokio::time::Instant::now() + request_timeout;
    let mut bytes = Vec::new();
    loop {
        let next = timeout_at(deadline, response.chunk())
            .await
            .map_err(|_| classify_request_timeout(request_timeout))?
            .map_err(|error| classify_transport_error(&error))?;
        let Some(chunk) = next else { break };
        if bytes.len().saturating_add(chunk.len()) > MAX_RESPONSE_BYTES {
            return Err(AnkiError::new(
                AnkiErrorKind::InvalidResponse,
                "AnkiConnect response exceeded the 64 MiB safety limit.",
            ));
        }
        bytes.extend_from_slice(&chunk);
    }
    Ok(bytes)
}

fn classify_request_timeout(request_timeout: Duration) -> AnkiError {
    let kind = if request_timeout <= CONNECTION_CHECK_TIMEOUT {
        AnkiErrorKind::Network
    } else {
        AnkiErrorKind::ServerError
    };
    AnkiError::new(
        kind,
        format!(
            "AnkiConnect request timed out after {} seconds; the operation may have completed, so verify before retrying.",
            request_timeout.as_secs()
        ),
    )
}

/// Turn an AnkiConnect error message into a failure class.
///
/// Match the known authentication/permission diagnostics instead of broad
/// substrings: server messages can include user-controlled model or field
/// names, which must not accidentally become authorization failures.
fn classify_error_message(message: &str) -> AnkiErrorKind {
    let lower = message.to_ascii_lowercase();

    if lower.contains("valid api key must be provided")
        || lower.contains("api key required")
        || lower.contains("api key is required")
        || lower.contains("invalid api key")
        || lower == "unauthorized"
        || lower.starts_with("unauthorized:")
        || lower == "authentication required"
        || lower.starts_with("authentication required:")
    {
        AnkiErrorKind::ApiKeyRequired
    } else if lower == "permission denied"
        || lower.starts_with("permission denied:")
        || lower.starts_with("permission denied.")
        || (lower.contains("origin") && lower.contains("not permitted"))
        || (lower.starts_with("request ") && lower.contains("not permitted"))
        || lower.starts_with("origin not allowed")
        || lower.starts_with("origin is not allowed")
        || lower.starts_with("origin denied")
        || lower.starts_with("origin is denied")
        || lower == "permission request denied"
        || lower.starts_with("permission request denied:")
        || lower == "access denied"
        || lower.starts_with("access denied:")
    {
        AnkiErrorKind::PermissionDenied
    } else {
        AnkiErrorKind::ServerError
    }
}

/// Turn a transport failure into a failure class.
fn classify_transport_kind(
    is_connect: bool,
    is_body_or_decode: bool,
    is_timeout: bool,
) -> AnkiErrorKind {
    if is_connect {
        AnkiErrorKind::Network
    } else if is_body_or_decode {
        AnkiErrorKind::InvalidResponse
    } else if is_timeout {
        AnkiErrorKind::ServerError
    } else {
        AnkiErrorKind::Network
    }
}

fn classify_transport_error(error: &reqwest::Error) -> AnkiError {
    let kind = classify_transport_kind(
        error.is_connect(),
        error.is_body() || error.is_decode(),
        error.is_timeout(),
    );

    let message = if error.is_connect() {
        "AnkiConnect is not reachable. Ensure Anki is running with AnkiConnect installed."
            .to_string()
    } else if error.is_timeout() {
        "AnkiConnect transport timed out; the result is unknown, so verify before retrying."
            .to_string()
    } else {
        format!("the AnkiConnect request failed: {error}")
    };

    AnkiError::new(kind, message)
}

/// Turn a non-success HTTP status into a failure class.
fn classify_status(status: reqwest::StatusCode) -> AnkiError {
    match status {
        reqwest::StatusCode::UNAUTHORIZED => AnkiError::new(
            AnkiErrorKind::ApiKeyRequired,
            "AnkiConnect rejected the request as unauthorized (HTTP 401).",
        ),
        reqwest::StatusCode::FORBIDDEN => AnkiError::new(
            AnkiErrorKind::PermissionDenied,
            "AnkiConnect denied the request origin (HTTP 403).",
        ),
        _ => AnkiError::new(
            AnkiErrorKind::ServerError,
            format!("AnkiConnect answered with HTTP {status}."),
        ),
    }
}

/// Parse the answer of AnkiConnect.
///
/// From API version 5 onwards the answer is the `{ result, error }`
/// envelope. Older versions answer a success with the bare result value,
/// while a failure is still enveloped.
fn parse_response(body: &[u8], version: u32) -> Result<AnkiResponse, AnkiError> {
    let value: Value = serde_json::from_slice(body).map_err(|error| {
        AnkiError::new(
            AnkiErrorKind::InvalidResponse,
            format!("AnkiConnect answered with invalid JSON: {error}"),
        )
    })?;

    if version < ENVELOPE_MIN_VERSION {
        // Old AnkiConnect versions return successful object results verbatim,
        // including objects whose own fields happen to be called `result` or
        // `error`. Only a non-null error is the legacy exception envelope.
        let legacy_error = value
            .as_object()
            .filter(|object| object.get("result").is_some_and(Value::is_null))
            .and_then(|object| object.get("error"))
            .filter(|value| !value.is_null())
            .map(error_to_string);
        if let Some(error) = legacy_error {
            return Ok(AnkiResponse {
                result: None,
                error: Some(error),
            });
        }
        return Ok(AnkiResponse {
            result: Some(value),
            error: None,
        });
    }

    if let Some(object) = value.as_object() {
        if object.contains_key("result") && object.contains_key("error") {
            let result = object
                .get("result")
                .filter(|value| !value.is_null())
                .cloned();
            let error = object
                .get("error")
                .filter(|value| !value.is_null())
                .map(error_to_string);
            return Ok(AnkiResponse { result, error });
        }
    }

    Err(AnkiError::new(
        AnkiErrorKind::InvalidResponse,
        "malformed answer from AnkiConnect: the result and error fields are missing.",
    ))
}

/// Render the error field of the envelope as a string.
///
/// AnkiConnect sends a string. A different type is rendered as JSON so the
/// message is never silently dropped.
fn error_to_string(value: &Value) -> String {
    match value {
        Value::String(text) => text.clone(),
        other => other.to_string(),
    }
}

/// Collect a JSON array of strings.
fn string_list(value: &Value) -> Result<Vec<String>, AnkiError> {
    let items = value.as_array().ok_or_else(|| {
        AnkiError::new(
            AnkiErrorKind::InvalidResponse,
            "AnkiConnect returned a non-array deck or model list.",
        )
    })?;
    items
        .iter()
        .map(|item| {
            item.as_str().map(str::to_string).ok_or_else(|| {
                AnkiError::new(
                    AnkiErrorKind::InvalidResponse,
                    "AnkiConnect returned a deck or model list with a non-string item.",
                )
            })
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn endpoint_falls_back_to_the_default() {
        assert_eq!(normalize_endpoint(None).unwrap(), DEFAULT_ENDPOINT);
        assert_eq!(normalize_endpoint(Some("  ")).unwrap(), DEFAULT_ENDPOINT);
    }

    #[test]
    fn endpoint_fills_in_the_scheme_and_default_port() {
        assert_eq!(
            normalize_endpoint(Some("127.0.0.1:8765")).unwrap(),
            "http://127.0.0.1:8765"
        );
        assert_eq!(
            normalize_endpoint(Some("http://127.0.0.1:8765/")).unwrap(),
            "http://127.0.0.1:8765"
        );
        assert_eq!(
            normalize_endpoint(Some("https://localhost")).unwrap(),
            "https://localhost:8765"
        );
        let canonical = normalize_endpoint(Some("http://localhost:80")).unwrap();
        assert_eq!(canonical, "http://localhost:80");
        assert_eq!(normalize_endpoint(Some(&canonical)).unwrap(), canonical);
        assert_eq!(
            normalize_endpoint(Some("http://8.8.8.8:8765"))
                .unwrap_err()
                .kind(),
            AnkiErrorKind::PermissionDenied
        );
        assert_eq!(
            normalize_endpoint(Some("http://[::1]")).unwrap(),
            "http://[::1]:8765"
        );
    }

    #[test]
    fn endpoint_rejects_garbage() {
        assert!(normalize_endpoint(Some("http://")).is_err());
    }

    #[test]
    fn endpoint_preserves_explicit_default_ports() {
        assert_eq!(
            normalize_endpoint(Some("http://127.0.0.1:80")).unwrap(),
            "http://127.0.0.1:80"
        );
        assert_eq!(
            normalize_endpoint(Some("https://[::1]:443")).unwrap(),
            "https://[::1]:443"
        );
    }

    #[test]
    fn endpoint_parser_rejects_noncanonical_ipv4_hosts() {
        let loopback = normalize_endpoint(Some("http://2130706433")).unwrap();
        assert_eq!(loopback, "http://127.0.0.1:8765");
        assert_eq!(normalize_endpoint(Some(&loopback)).unwrap(), loopback);
        assert_eq!(
            normalize_endpoint(Some("http://0x8080808"))
                .unwrap_err()
                .kind(),
            AnkiErrorKind::PermissionDenied
        );
    }

    #[test]
    fn endpoint_rejects_non_http_schemes_and_url_credentials() {
        assert_eq!(
            normalize_endpoint(Some("ftp://example.com/file"))
                .unwrap_err()
                .kind(),
            AnkiErrorKind::PermissionDenied
        );
        assert_eq!(
            normalize_endpoint(Some("https://8.8.8.8"))
                .unwrap_err()
                .kind(),
            AnkiErrorKind::PermissionDenied
        );
        assert_eq!(
            normalize_endpoint(Some("http://user:pass@127.0.0.1:8765"))
                .unwrap_err()
                .kind(),
            AnkiErrorKind::PermissionDenied
        );
    }

    #[test]
    fn endpoint_allows_only_loopback_private_and_link_local_addresses() {
        for address in [
            "127.0.0.1",
            "10.1.2.3",
            "172.16.0.1",
            "172.31.255.254",
            "192.168.1.1",
            "169.254.2.3",
            "::1",
            "fe80::1",
            "::ffff:192.168.1.1",
        ] {
            assert!(
                is_allowed_ip(address.parse().unwrap()),
                "expected {address} to be allowed"
            );
        }

        for address in [
            "8.8.8.8",
            "169.254.169.254",
            "::ffff:169.254.169.254",
            "172.15.255.255",
            "172.32.0.1",
            "192.167.1.1",
            "100.64.0.1",
            "2001:4860:4860::8888",
        ] {
            assert!(
                !is_allowed_ip(address.parse().unwrap()),
                "expected {address} to be blocked"
            );
        }
    }

    #[test]
    fn rejects_dns_answers_mixing_private_and_public_ips() {
        let addresses = [
            "192.168.1.2:8765".parse().unwrap(),
            "8.8.8.8:8765".parse().unwrap(),
        ];
        assert_eq!(
            validate_resolved_addresses(&addresses).unwrap_err().kind(),
            AnkiErrorKind::PermissionDenied
        );
    }

    #[test]
    fn accepts_dns_answers_that_are_all_local() {
        let addresses = [
            "127.0.0.1:8765".parse().unwrap(),
            "192.168.1.2:8765".parse().unwrap(),
        ];
        assert!(validate_resolved_addresses(&addresses).is_ok());
    }

    #[test]
    fn connect_timeouts_are_classified_as_unavailable_network_errors() {
        assert_eq!(
            classify_transport_kind(true, false, true),
            AnkiErrorKind::Network
        );
    }

    #[test]
    fn response_size_limit_uses_an_explicit_unit() {
        assert_eq!(MAX_RESPONSE_BYTES, 64 * 1024 * 1024);
    }

    #[test]
    fn response_body_failures_are_invalid_responses_before_timeout_classification() {
        assert_eq!(
            classify_transport_kind(false, true, true),
            AnkiErrorKind::InvalidResponse
        );
    }

    #[test]
    fn response_timeouts_are_server_errors_not_unavailable() {
        assert_eq!(
            classify_transport_kind(false, false, true),
            AnkiErrorKind::ServerError
        );
    }

    #[test]
    fn connection_check_timeout_is_bounded_to_ten_seconds() {
        assert_eq!(CONNECTION_CHECK_TIMEOUT, Duration::from_secs(10));
    }

    #[test]
    fn request_omits_empty_optional_fields() {
        let request = AnkiRequest::new("deckNames", DEFAULT_API_VERSION)
            .with_params(Some(Value::Null))
            .with_key(Some("  ".to_string()));
        let body = serde_json::to_value(&request).unwrap();
        assert_eq!(body, json!({ "action": "deckNames", "version": 6 }));
    }

    #[test]
    fn request_keeps_params_and_key() {
        let request = AnkiRequest::new("modelFieldNames", DEFAULT_API_VERSION)
            .with_params(Some(json!({ "modelName": "Basic" })))
            .with_key(Some("secret".to_string()));
        let body = serde_json::to_value(&request).unwrap();
        assert_eq!(
            body,
            json!({
                "action": "modelFieldNames",
                "version": 6,
                "params": { "modelName": "Basic" },
                "key": "secret",
            })
        );
    }

    #[test]
    fn envelope_is_parsed() {
        let parsed = parse_response(
            br#"{"result": ["Default"], "error": null}"#,
            DEFAULT_API_VERSION,
        )
        .unwrap();
        assert_eq!(parsed.result, Some(json!(["Default"])));
        assert!(parsed.error.is_none());
    }

    #[test]
    fn error_envelope_is_parsed() {
        let parsed = parse_response(
            br#"{"result": null, "error": "unsupported action"}"#,
            DEFAULT_API_VERSION,
        )
        .unwrap();
        assert!(parsed.result.is_none());
        assert_eq!(parsed.error.as_deref(), Some("unsupported action"));
    }

    #[test]
    fn legacy_version_answers_with_the_bare_result() {
        let parsed = parse_response(br#"["Default", "Japanese"]"#, 4).unwrap();
        assert_eq!(parsed.result, Some(json!(["Default", "Japanese"])));
        assert!(parsed.error.is_none());
    }

    #[test]
    fn legacy_version_still_reports_errors_with_the_envelope() {
        let parsed = parse_response(br#"{"result": null, "error": "boom"}"#, 4).unwrap();
        assert_eq!(parsed.error.as_deref(), Some("boom"));
    }

    #[test]
    fn legacy_success_objects_are_not_mistaken_for_envelopes() {
        for raw in [
            json!({ "result": "user-data", "error": null }),
            json!({ "result": "user-data", "error": "user-field" }),
        ] {
            let parsed = parse_response(&serde_json::to_vec(&raw).unwrap(), 4).unwrap();
            assert_eq!(parsed.result, Some(raw));
            assert!(parsed.error.is_none());
        }
    }

    #[test]
    fn a_missing_envelope_is_an_invalid_response() {
        let error = parse_response(br#"{"unexpected": true}"#, DEFAULT_API_VERSION).unwrap_err();
        assert_eq!(error.kind(), AnkiErrorKind::InvalidResponse);
    }

    #[test]
    fn broken_json_is_an_invalid_response() {
        let error = parse_response(b"<html>not json</html>", DEFAULT_API_VERSION).unwrap_err();
        assert_eq!(error.kind(), AnkiErrorKind::InvalidResponse);
    }

    #[test]
    fn error_messages_are_classified() {
        assert_eq!(
            classify_error_message("valid api key must be provided"),
            AnkiErrorKind::ApiKeyRequired
        );
        assert_eq!(
            classify_error_message("permission error: model named Permission"),
            AnkiErrorKind::ServerError
        );
        assert_eq!(
            classify_error_message("request URL resource not permitted"),
            AnkiErrorKind::PermissionDenied
        );
        assert_eq!(
            classify_error_message("unauthorized"),
            AnkiErrorKind::ApiKeyRequired
        );
        assert_eq!(
            classify_error_message("permission denied"),
            AnkiErrorKind::PermissionDenied
        );
        assert_eq!(
            serde_json::to_value(AnkiErrorKind::ApiKeyRequired).unwrap(),
            json!("api-key-required")
        );
        assert_eq!(
            classify_error_message("unknown field: origin"),
            AnkiErrorKind::ServerError
        );
        assert_eq!(
            classify_error_message("AnkiConnect error: Permission is required in a field name"),
            AnkiErrorKind::ServerError
        );
        assert_eq!(
            classify_error_message("invalid model: Permission Vocabulary"),
            AnkiErrorKind::ServerError
        );
        assert_eq!(
            classify_error_message("unsupported action"),
            AnkiErrorKind::ServerError
        );
    }
}
