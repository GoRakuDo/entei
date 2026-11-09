//! `tauri-plugin-anki`
//!
//! Native AnkiConnect access for Entei.
//!
//! The plugin moves the AnkiConnect traffic out of the browser and into the
//! Rust process. Two things are gained by doing so:
//!
//! - The browser's Private Network Access preflight and its CORS handshake
//!   never happen, so the AnkiConnect origin allow-list does not have to
//!   carry the app's webview origin.
//! - The request travels over a keep-alive loopback socket instead of
//!   going through the webview's network stack.
//!
//! The commands are deliberately thin: `anki_request` is the generic
//! passthrough for a single action and `anki_check_connection` runs the
//! whole connection flow (version, permission, deck and model listing) in
//! one round of calls.

mod client;

pub use client::{
    AnkiClient, AnkiConnectionState, AnkiConnectionStatus, AnkiError, AnkiErrorKind, AnkiRequest,
    AnkiResponse, DEFAULT_API_VERSION, DEFAULT_ENDPOINT,
};

use serde::Serialize;
use tauri::plugin::{Builder, TauriPlugin};
use tauri::Runtime;

/// The error payload of `anki_request`.
///
/// `kind` is the failure class (`network`, `api-key-required`,
/// `permission-denied`, `server-error`, `invalid-response`) and `message`
/// the human-readable reason.
#[derive(Debug, Clone, Serialize)]
pub struct AnkiCommandError {
    /// The failure class.
    pub kind: AnkiErrorKind,
    /// The human readable reason.
    pub message: String,
}

impl From<AnkiError> for AnkiCommandError {
    fn from(error: AnkiError) -> Self {
        Self {
            kind: error.kind(),
            message: error.message().to_string(),
        }
    }
}

/// Run one AnkiConnect action.
///
/// `endpoint` defaults to `http://127.0.0.1:8765`, `version` to `6`. The
/// API key is passed per call and is never stored by the plugin.
#[tauri::command]
async fn anki_request(
    endpoint: Option<String>,
    action: String,
    version: Option<u32>,
    params: Option<serde_json::Value>,
    key: Option<String>,
) -> Result<serde_json::Value, AnkiCommandError> {
    let client = AnkiClient::new(endpoint.as_deref(), key).map_err(AnkiCommandError::from)?;
    client
        .request(&action, version, params)
        .await
        .map_err(AnkiCommandError::from)
}

/// Check the AnkiConnect connection in one call.
///
/// The check runs version, permission and deck/model discovery, returning the
/// resulting state and classified error details in the status.
#[tauri::command]
async fn anki_check_connection(
    endpoint: Option<String>,
    key: Option<String>,
) -> Result<AnkiConnectionStatus, String> {
    Ok(AnkiClient::check_connection_once(endpoint.as_deref(), key).await)
}

pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("anki")
        .invoke_handler(tauri::generate_handler![
            anki_request,
            anki_check_connection
        ])
        .build()
}
