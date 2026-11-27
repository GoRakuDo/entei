//! AnkiDroid Connect module — the Android half of Entei's Anki integration.
//!
//! The web layer keeps speaking the AnkiConnect wire protocol
//! (`{ action, version, params, key }` in, `{ result, error }` out). Only the
//! transport changes: this module forwards the action to the Kotlin
//! [`AnkiDroidModule`], and the Kotlin side answers out of AnkiDroid's own
//! ContentProvider (`FlashCardsContract`) in-process — no HTTP server on the
//! phone and no second APK.
//!
//! The frontend does **not** reach this module yet: `apps/web`'s
//! `features/player/tauri-bridge.ts` still sends every AnkiConnect call to the
//! desktop loopback plugin (`plugin:anki|anki_request`), so today these two
//! commands are only reachable from Rust. Routing that bridge to
//! `plugin:modules|modules_ankidroid_request` on Android is phase 3 of
//! `docs/ANKIDROID_MODULE_ARCHITECTURE.md` §8, and it is the one gap left before
//! the Android export flow runs end to end.
//!
//! The whole action surface is live (phase 2):
//!
//! - [`init_android`] registers the Kotlin plugin under
//!   [`ANKIDROID_IDENTIFIER`] and returns the handle `lib.rs` manages as
//!   [`AnkiDroidHandle`].
//! - [`modules_ankidroid_request`] forwards one action and returns the Kotlin
//!   `{ result, error }` envelope untouched, so the TypeScript clients see the
//!   exact shape the desktop loopback plugin produces.
//! - [`modules_ankidroid_check_connection`] returns the same
//!   `AnkiNativeConnectionStatus` shape, so the web layer validates both with
//!   one guard.
//!
//! The Kotlin side routes each action to `DeckApi`, `ModelApi`, `NoteApi`,
//! `CardApi` or `MediaApi` (see §5 of `docs/ANKIDROID_MODULE_ARCHITECTURE.md`)
//! and answers unknown actions inside the envelope.
//!
//! Both commands are compiled on every target: a desktop build answers
//! [`UNSUPPORTED_PLATFORM`] rather than failing to resolve the command, so the
//! registered handler list is identical on both platforms.

use serde::Serialize;
use tauri::{AppHandle, Runtime};

/// Kotlin package of the AnkiDroid module.
///
/// Tauri resolves the plugin by this identifier plus the class name, so it must
/// match the `package` line of `AnkiDroidModule.kt` exactly (and therefore also
/// the `namespace` in `android/build.gradle.kts`).
pub const ANKIDROID_IDENTIFIER: &str = "org.gorakudo.entei.modules.ankidroid";

/// Kotlin class inside [`ANKIDROID_IDENTIFIER`] that Tauri instantiates.
pub const ANKIDROID_CLASS: &str = "AnkiDroidModule";

/// Mobile command names. Tauri's Android dispatcher looks a command up by the
/// Kotlin **method** name, so these must match the `@Command` methods verbatim.
pub const REQUEST_COMMAND: &str = "ankidroid_request";
pub const CHECK_CONNECTION_COMMAND: &str = "ankidroid_check_connection";

/// What both commands answer on a target with no AnkiDroid ContentProvider.
pub const UNSUPPORTED_PLATFORM: &str = "the ankidroid module is only available on Android";

/// The payload handed to the Kotlin `ankidroid_request` method.
///
/// Field names are the keys the Kotlin side reads out of `Invoke.getArgs()`
/// (`action`, `version`, `params`, `key`), so renaming a field is a wire
/// protocol change, not a refactor.
#[derive(Debug, Serialize)]
pub struct AnkiDroidRequestPayload<'a> {
    /// The AnkiConnect action (`version`, `deckNames`, `addNote`, ...).
    pub action: &'a str,
    /// The AnkiConnect API version the caller speaks (`6` from Entei).
    pub version: Option<u32>,
    /// The action's parameters, passed through untouched.
    pub params: Option<serde_json::Value>,
    /// The caller's AnkiConnect API key. Unused on Android — AnkiDroid
    /// authorises through the manifest permission, never a bearer token — but it
    /// travels so the wire shape stays identical to the desktop plugin's.
    pub key: Option<&'a str>,
}

/// The registered Kotlin plugin handle, managed at plugin setup on Android.
#[cfg(target_os = "android")]
pub struct AnkiDroidHandle<R: Runtime>(pub tauri::plugin::PluginHandle<R>);

/// Register the Kotlin [`ANKIDROID_CLASS`] inside [`ANKIDROID_IDENTIFIER`].
///
/// Must run while the Android webview exists: Tauri instantiates the Kotlin
/// plugin on the Android main thread and loads it into the `PluginManager`.
#[cfg(target_os = "android")]
pub fn init_android<R: Runtime, C: serde::de::DeserializeOwned>(
    _app: &AppHandle<R>,
    api: &tauri::plugin::PluginApi<R, C>,
) -> tauri::Result<tauri::plugin::PluginHandle<R>> {
    Ok(api.register_android_plugin(ANKIDROID_IDENTIFIER, ANKIDROID_CLASS)?)
}

/// Desktop counterpart of the registration hook: nothing to register, because
/// the desktop transport is the loopback AnkiConnect plugin
/// (`plugin:anki|anki_request`).
#[cfg(not(target_os = "android"))]
pub fn init_android<R: Runtime, C: serde::de::DeserializeOwned>(
    _app: &AppHandle<R>,
    _api: &tauri::plugin::PluginApi<R, C>,
) -> tauri::Result<()> {
    Ok(())
}

/// Forward one AnkiConnect action to AnkiDroid.
///
/// Returns the Kotlin envelope (`{ "result": any, "error": null }`) verbatim: the
/// web layer's Anki clients already parse that shape from the desktop plugin, so
/// a success and an AnkiDroid-side failure need no translation here.
#[tauri::command]
pub async fn modules_ankidroid_request<R: Runtime>(
    app: AppHandle<R>,
    action: String,
    version: Option<u32>,
    params: Option<serde_json::Value>,
    key: Option<String>,
) -> Result<serde_json::Value, String> {
    #[cfg(target_os = "android")]
    {
        use tauri::Manager;

        let handle = app.state::<AnkiDroidHandle<R>>();
        let payload = AnkiDroidRequestPayload {
            action: &action,
            version,
            params,
            key: key.as_deref(),
        };
        handle
            .0
            .run_mobile_plugin_async(REQUEST_COMMAND, payload)
            .await
            .map_err(|err| err.to_string())
    }

    #[cfg(not(target_os = "android"))]
    {
        let _ = (app, action, version, params, key);
        Err(UNSUPPORTED_PLATFORM.to_string())
    }
}

/// Probe AnkiDroid and answer an `AnkiNativeConnectionStatus`.
///
/// The Kotlin side decides the state (`connected`, `unavailable`,
/// `permission-denied`, ...) and returns every key the TypeScript guard requires,
/// so this command stays a pass-through even when the answer is a failure.
#[tauri::command]
pub async fn modules_ankidroid_check_connection<R: Runtime>(
    app: AppHandle<R>,
) -> Result<serde_json::Value, String> {
    #[cfg(target_os = "android")]
    {
        use tauri::Manager;

        let handle = app.state::<AnkiDroidHandle<R>>();
        handle
            .0
            .run_mobile_plugin_async(CHECK_CONNECTION_COMMAND, serde_json::json!({}))
            .await
            .map_err(|err| err.to_string())
    }

    #[cfg(not(target_os = "android"))]
    {
        let _ = app;
        Err(UNSUPPORTED_PLATFORM.to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The Kotlin module source, read straight out of the repository. These
    /// tests guard the two name-based contracts Tauri resolves at runtime: a
    /// mismatch shows up as "Plugin ... not initialized" / "No command ... found"
    /// on a device only, so it has to fail here instead.
    fn kotlin_source() -> String {
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("android/src/main/java/org/gorakudo/entei/modules/ankidroid/AnkiDroidModule.kt");
        std::fs::read_to_string(&path)
            .unwrap_or_else(|err| panic!("could not read {}: {err}", path.display()))
    }

    #[test]
    fn the_plugin_identifier_is_the_kotlin_package() {
        let source = kotlin_source();
        assert!(
            source.contains(&format!("package {ANKIDROID_IDENTIFIER}")),
            "AnkiDroidModule.kt must declare `package {ANKIDROID_IDENTIFIER}`"
        );
        assert!(
            source.contains(&format!("class {ANKIDROID_CLASS}(")),
            "AnkiDroidModule.kt must declare `class {ANKIDROID_CLASS}(`"
        );
    }

    #[test]
    fn both_mobile_commands_exist_as_kotlin_methods() {
        let source = kotlin_source();
        for command in [REQUEST_COMMAND, CHECK_CONNECTION_COMMAND] {
            assert!(
                source.contains(&format!("fun {command}(invoke: Invoke)")),
                "AnkiDroidModule.kt must declare `fun {command}(invoke: Invoke)`"
            );
        }
    }

    #[test]
    fn the_request_payload_names_are_what_kotlin_reads() {
        let payload = AnkiDroidRequestPayload {
            action: "version",
            version: Some(6),
            params: Some(serde_json::json!({ "query": "nid:1" })),
            key: Some("secret"),
        };
        assert_eq!(
            serde_json::to_value(&payload).unwrap(),
            serde_json::json!({
                "action": "version",
                "version": 6,
                "params": { "query": "nid:1" },
                "key": "secret",
            })
        );
    }
}
