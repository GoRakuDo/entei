//! `tauri-plugin-ytdlp`
//!
//! Decoupled yt-dlp bridge for Entei. Exposes two commands:
//!
//! - `get_video_info(url)`  -> runs `yt-dlp --dump-json <url>` and returns the
//!   normalized metadata (title / duration / thumbnail / formats / subtitles).
//! - `stream_youtube(url, mode)` -> runs `yt-dlp -g -f <selector> <url>`, then
//!   registers every resolved URL with the loopback relay (see [`relay`]) and
//!   returns the local `http://127.0.0.1:<port>/stream/<id>` URL(s) that the
//!   webview can feed into a `<video>` element.
//!   `mode == "video"` prefers a progressive muxed stream at 720p or better;
//!   when yt-dlp has to fall back to separate streams, `urls` carries
//!   `[video, audio]` in that order and `url` is the video URL.
//!
//! Note: yt-dlp must be reachable. Resolution order is
//! `EIZOUDEN_YTDLP_PATH` env var, then the binary embedded in the Windows Entei
//! bundle via `bundle.resources` (see [`bundled_candidates`]), then the verified
//! helper EizouDendenshi installed under its companion install root (see
//! [`helper_candidates`]), then the platform default binary name on `PATH`.
//! The bundled step is what makes a fresh install self-contained: no Python, no
//! EizouDendenshi, no `PATH` entry required. The helper step remains as a
//! fallback for machines that already ran the companion. No downloads are
//! performed here; the caller owns the source URL.
//! The upstream `googlevideo.com` URLs carry short-lived tokens and stay inside
//! the process — only the local relay URLs are returned to the webview.

mod relay;

use std::path::PathBuf;
use std::process::Stdio;
use std::sync::OnceLock;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri::plugin::{Builder, TauriPlugin};
use tauri::{Manager, Runtime};
use tokio::process::Command;

/// Maximum bytes of yt-dlp stdout we accept before parsing. `--dump-json` on a
/// long video can be a few hundred KB; anything above this is treated as a
/// malformed invocation.
const MAX_STDOUT_BYTES: usize = 32 * 1024 * 1024;

/// Hard upper bound for a single yt-dlp invocation. A hung process must not
/// block a Tauri command forever, so every run is wrapped in this timeout.
const SUBPROCESS_TIMEOUT: Duration = Duration::from_secs(30);

/// YouTube client fallback chain handed to yt-dlp.
///
/// `web` alone intermittently yields signed URLs that answer `403 Forbidden` on
/// the first range request (the "confirm you're not a bot" throttling path).
/// Listing `mweb` and `android` first makes yt-dlp try the clients whose
/// formats are not throttled, and keeps `web` as the final fallback.
const YOUTUBE_EXTRACTOR_ARGS: &str = "youtube:player_client=mweb,android,web";

#[derive(Debug, thiserror::Error)]
pub enum YtdlpError {
    #[error("invalid url: {0}")]
    InvalidUrl(String),
    #[error("yt-dlp executable not found: {0}")]
    BinaryNotFound(String),
    #[error("yt-dlp failed: {0}")]
    Process(String),
    #[error("could not parse yt-dlp output: {0}")]
    Parse(String),
    #[error("unsupported mode: {0}")]
    UnsupportedMode(String),
    #[error("yt-dlp timed out after {0}s")]
    Timeout(u64),
}

impl YtdlpError {
    fn message(&self) -> String {
        self.to_string()
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FormatInfo {
    pub format_id: String,
    pub ext: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub resolution: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub height: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub fps: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub vcodec: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub acodec: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub filesize: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VideoInfo {
    pub id: String,
    pub title: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub uploader: Option<String>,
    /// Duration in seconds. `None` for live streams.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub duration: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub thumbnail: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub webpage_url: Option<String>,
    pub is_live: bool,
    /// Available subtitle languages (manual + automatic).
    pub subtitles: Vec<String>,
    pub formats: Vec<FormatInfo>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StreamSource {
    /// Primary media URL. For `mode == "video"` this is the muxed stream when
    /// available, otherwise the video-only stream (see `urls`).
    pub url: String,
    /// Every URL yt-dlp printed, in output order.
    ///
    /// - length 1 -> single stream (muxed for video, audio-only for audio)
    /// - length 2 -> `[video, audio]`; the caller must attach the audio URL
    ///   separately because a `<video>` element pointed at `urls[0]` has no
    ///   audio track.
    pub urls: Vec<String>,
    /// `"audio"` or `"video"`.
    pub mode: String,
    /// The yt-dlp format selector that produced `url`.
    pub format_selector: String,
    /// `true` when `url`/`urls` point at the loopback relay, `false` when the
    /// relay could not start and the raw upstream URLs were returned instead.
    /// The player should treat both the same; this only exists so a degraded
    /// relay can be diagnosed instead of failing silently.
    #[serde(default)]
    pub relayed: bool,
}

/// File name of the yt-dlp binary inside the bundle resource directory.
const YTDLP_EXE_NAME: &str = if cfg!(windows) { "yt-dlp.exe" } else { "yt-dlp" };

/// Bundle resource directory resolved by Tauri while the plugin initializes.
///
/// This is the `resources/` sub-directory of the bundle resource root (i.e.
/// `app.path().resolve("resources", BaseDirectory::Resource)`), matching the
/// `resources/windows/*` entry in `tauri.windows.conf.json`.
/// Stored once because [`ytdlp_binary`] runs per command and must stay
/// synchronous; the path is fixed for the lifetime of the process.
static RESOURCE_DIR: OnceLock<PathBuf> = OnceLock::new();

/// yt-dlp shipped inside the Entei bundle, most likely location first.
///
/// Only Windows bundles an executable: `tauri.windows.conf.json` lists
/// `resources/windows/*` under `bundle.resources`, so the installer carries the
/// binary at `<resource dir>/resources/windows/`. The base `tauri.conf.json`
/// declares **no** resources at all, which is what keeps the 18MB Windows
/// `yt-dlp.exe` out of every other bundle (Android APK in particular).
///
/// `tauri dev` has no bundle yet, which is why the checked-in
/// `src-tauri/resources/windows/yt-dlp.exe` is probed by relative path — those
/// probes are debug-only so a stray `yt-dlp.exe` in the launch directory of a
/// shipped build can never win. The flat `resources/yt-dlp.exe` location is
/// kept as a second probe for bundles produced before the platform split.
fn bundled_candidates() -> Vec<PathBuf> {
    #[cfg(windows)]
    {
        let mut candidates = Vec::new();
        if let Some(dir) = RESOURCE_DIR.get() {
            candidates.push(dir.join("windows").join(YTDLP_EXE_NAME));
            candidates.push(dir.join(YTDLP_EXE_NAME));
        }
        if let Ok(exe) = std::env::current_exe() {
            if let Some(dir) = exe.parent() {
                let resources = dir.join("resources");
                candidates.push(resources.join("windows").join(YTDLP_EXE_NAME));
                candidates.push(resources.join(YTDLP_EXE_NAME));
            }
        }
        #[cfg(debug_assertions)]
        {
            // `tauri dev` runs with the working directory set to `src-tauri`.
            candidates.push(
                PathBuf::from("src-tauri")
                    .join("resources")
                    .join("windows")
                    .join(YTDLP_EXE_NAME),
            );
            candidates.push(
                PathBuf::from("resources")
                    .join("windows")
                    .join(YTDLP_EXE_NAME),
            );
        }
        candidates
    }
    // Android (APK) and every other non-Windows target bundle no executable:
    // Android 10+ app-private storage is W^X (`noexec`), so a spawned binary is
    // not an option there, and Termux manages yt-dlp through `pkg` on `PATH`.
    // Returning an empty list guarantees no Windows `.exe` is ever probed.
    #[cfg(not(windows))]
    {
        Vec::new()
    }
}

/// Verified yt-dlp helpers installed by EizouDendenshi, most specific first.
///
/// Windows install root is `%LOCALAPPDATA%\GoRakuDo\EizouDendenshi` and its
/// update plan drops the yt-dlp artifact under `helpers/` keeping the release
/// asset name (`yt-dlp-windows-amd64.exe`). `yt-dlp.exe` is listed as well so a
/// manually renamed helper keeps working. Termux manages yt-dlp through `pkg`
/// (it lives on `PATH`), so there are no candidates there.
fn helper_candidates() -> Vec<PathBuf> {
    #[cfg(windows)]
    {
        let mut candidates = Vec::new();
        if let Ok(local_app_data) = std::env::var("LOCALAPPDATA") {
            if !local_app_data.trim().is_empty() {
                let helpers = PathBuf::from(local_app_data)
                    .join("GoRakuDo")
                    .join("EizouDendenshi")
                    .join("helpers");
                candidates.push(helpers.join("yt-dlp-windows-amd64.exe"));
                candidates.push(helpers.join("yt-dlp.exe"));
            }
        }
        candidates
    }
    #[cfg(not(windows))]
    {
        Vec::new()
    }
}

/// Resolve the yt-dlp executable to spawn.
///
/// A path is only taken from the candidate lists when the file actually exists,
/// so a missing bundle resource or helper silently falls through to the next
/// step instead of failing to spawn.
fn ytdlp_binary() -> String {
    if let Ok(path) = std::env::var("EIZOUDEN_YTDLP_PATH") {
        let trimmed = path.trim();
        if !trimmed.is_empty() {
            return trimmed.to_string();
        }
    }
    let found = bundled_candidates()
        .into_iter()
        .chain(helper_candidates())
        .find(|path| path.is_file());
    if let Some(binary) = found {
        return binary.to_string_lossy().into_owned();
    }
    YTDLP_EXE_NAME.to_string()
}

fn validate_url(url: &str) -> Result<&str, YtdlpError> {
    let trimmed = url.trim();
    if trimmed.is_empty() {
        return Err(YtdlpError::InvalidUrl("empty url".into()));
    }
    if !(trimmed.starts_with("http://") || trimmed.starts_with("https://")) {
        return Err(YtdlpError::InvalidUrl(trimmed.to_string()));
    }
    Ok(trimmed)
}

async fn run_ytdlp(args: &[&str]) -> Result<String, YtdlpError> {
    let binary = ytdlp_binary();
    let spawn = Command::new(&binary)
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .output();

    let output = match tokio::time::timeout(SUBPROCESS_TIMEOUT, spawn).await {
        Ok(result) => result.map_err(|err| {
            if err.kind() == std::io::ErrorKind::NotFound {
                YtdlpError::BinaryNotFound(binary.clone())
            } else {
                YtdlpError::Process(format!("failed to spawn {binary}: {err}"))
            }
        })?,
        Err(_) => return Err(YtdlpError::Timeout(SUBPROCESS_TIMEOUT.as_secs())),
    };

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        let detail = stderr
            .lines()
            .rev()
            .find(|line| !line.trim().is_empty())
            .unwrap_or("no stderr output")
            .trim()
            .to_string();
        return Err(YtdlpError::Process(detail));
    }

    if output.stdout.len() > MAX_STDOUT_BYTES {
        return Err(YtdlpError::Parse("yt-dlp output too large".into()));
    }

    Ok(String::from_utf8_lossy(&output.stdout).into_owned())
}

fn opt_string(value: Option<&serde_json::Value>) -> Option<String> {
    value.and_then(|v| v.as_str()).map(|s| s.to_string())
}

fn parse_video_info(raw: &str) -> Result<VideoInfo, YtdlpError> {
    let root: serde_json::Value = serde_json::from_str(raw.trim())
        .map_err(|err| YtdlpError::Parse(format!("invalid JSON: {err}")))?;

    let title = opt_string(root.get("title"))
        .ok_or_else(|| YtdlpError::Parse("missing title".into()))?;

    let subtitles = collect_subtitle_languages(&root);

    let formats = root
        .get("formats")
        .and_then(|v| v.as_array())
        .map(|list| list.iter().filter_map(parse_format).collect())
        .unwrap_or_default();

    Ok(VideoInfo {
        id: opt_string(root.get("id")).unwrap_or_default(),
        title,
        uploader: opt_string(root.get("uploader")).or_else(|| opt_string(root.get("channel"))),
        duration: root.get("duration").and_then(|v| v.as_f64()),
        thumbnail: opt_string(root.get("thumbnail")),
        webpage_url: opt_string(root.get("webpage_url")),
        is_live: root.get("is_live").and_then(|v| v.as_bool()).unwrap_or(false),
        subtitles,
        formats,
    })
}

fn collect_subtitle_languages(root: &serde_json::Value) -> Vec<String> {
    let mut languages: Vec<String> = Vec::new();
    for key in ["subtitles", "automatic_captions"] {
        if let Some(map) = root.get(key).and_then(|v| v.as_object()) {
            for lang in map.keys() {
                if !languages.iter().any(|existing| existing == lang) {
                    languages.push(lang.clone());
                }
            }
        }
    }
    languages.sort();
    languages
}

fn parse_format(value: &serde_json::Value) -> Option<FormatInfo> {
    Some(FormatInfo {
        format_id: opt_string(value.get("format_id"))?,
        ext: opt_string(value.get("ext")).unwrap_or_default(),
        resolution: opt_string(value.get("resolution")),
        height: value.get("height").and_then(|v| v.as_u64()),
        fps: value.get("fps").and_then(|v| v.as_f64()),
        vcodec: opt_string(value.get("vcodec")),
        acodec: opt_string(value.get("acodec")),
        filesize: value
            .get("filesize")
            .and_then(|v| v.as_u64())
            .or_else(|| value.get("filesize_approx").and_then(|v| v.as_u64())),
    })
}

/// Format selectors.
///
/// `video` is built from three rules, in priority order:
///
/// 1. `best[height>=720][height<=1080]` — a progressive muxed stream (video and
///    audio in one file). This is what makes playback start instantly: the
///    `<video>` element needs a single URL and no client-side muxing.
/// 2. `best[height<=1080]` — any muxed stream, accepting sub-720p rather than
///    dropping to separate streams. YouTube only publishes muxed formats up to
///    720p (or 360p on newer uploads), so this is the common case.
/// 3. `bestvideo[height>=720][height<=1080]+bestaudio` — separate streams, which
///    yields two URLs. Video quality wins over instant start here because a
///    muxed stream simply does not exist for that video.
///
/// The 720p floor is deliberately only enforced where a muxed stream exists:
/// demanding 720p unconditionally would force the separate-stream fallback on
/// videos whose only muxed format is 360p, trading playback startup for pixels.
fn format_selector_for(mode: &str) -> Result<&'static str, YtdlpError> {
    match mode {
        "audio" => Ok("bestaudio/best"),
        "video" => Ok("best[height>=720][height<=1080]\
/best[height<=1080]\
/bestvideo[height>=720][height<=1080]+bestaudio\
/best"),
        other => Err(YtdlpError::UnsupportedMode(other.to_string())),
    }
}

/// Collect the non-empty lines yt-dlp printed for `-g`.
///
/// yt-dlp prints one URL per selected stream, so a muxed selection yields a
/// single line and a `video+audio` selection yields two. The order is
/// preserved: video first, audio second.
fn parse_stream_urls(raw: &str) -> Result<Vec<String>, YtdlpError> {
    let urls: Vec<String> = raw
        .lines()
        .map(|line| line.trim())
        .filter(|line| !line.is_empty())
        .map(|line| line.to_string())
        .collect();

    match urls.len() {
        0 => Err(YtdlpError::Parse("yt-dlp returned no stream url".into())),
        1 | 2 => Ok(urls),
        other => Err(YtdlpError::Parse(format!(
            "yt-dlp returned {other} stream urls, expected 1 or 2"
        ))),
    }
}

#[tauri::command]
async fn get_video_info(url: String) -> Result<VideoInfo, String> {
    let url = validate_url(&url).map_err(|err| err.message())?;
    let raw = run_ytdlp(&[
        "--dump-json",
        "--no-playlist",
        "--no-warnings",
        "--skip-download",
        "--extractor-args",
        YOUTUBE_EXTRACTOR_ARGS,
        url,
    ])
    .await
    .map_err(|err| err.message())?;

    parse_video_info(&raw).map_err(|err| err.message())
}

#[tauri::command]
async fn stream_youtube(url: String, mode: String) -> Result<StreamSource, String> {
    let url = validate_url(&url).map_err(|err| err.message())?;
    let selector = format_selector_for(mode.trim()).map_err(|err| err.message())?;

    let raw = run_ytdlp(&[
        "-g",
        "-f",
        selector,
        "--no-playlist",
        "--no-warnings",
        "--extractor-args",
        YOUTUBE_EXTRACTOR_ARGS,
        url,
    ])
    .await
    .map_err(|err| err.message())?;

    // `-g` prints one URL per selected stream. The primary URL is always the
    // first line: a muxed stream for video, or the only stream for audio.
    // Never take the last line — for separate streams that is the audio-only
    // URL and the player would show a black screen.
    let upstream_urls = parse_stream_urls(&raw).map_err(|err| err.message())?;

    // Hand the webview loopback URLs instead of the upstream ones. The relay
    // answers `Range` requests from a single persistent session, so seeking does
    // not re-hit YouTube with a fresh (and throttled) request.
    let (urls, relayed) = match relay::ensure().await {
        Ok(relay) => (
            upstream_urls
                .iter()
                .map(|upstream| relay.register(upstream))
                .collect::<Vec<_>>(),
            true,
        ),
        // Falling back keeps playback working when the listener cannot bind;
        // `relayed: false` tells the caller the proxy is unavailable.
        Err(_) => (upstream_urls, false),
    };

    let primary = urls
        .first()
        .cloned()
        .ok_or_else(|| YtdlpError::Parse("yt-dlp returned no stream url".into()).message())?;

    Ok(StreamSource {
        url: primary,
        urls,
        mode: mode.trim().to_string(),
        format_selector: selector.to_string(),
        relayed,
    })
}

pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("ytdlp")
        .setup(|app, _api| {
            // Resolve the bundle resource directory once so `ytdlp_binary` can
            // stay synchronous. Failure is not fatal: the dev-relative and
            // `PATH` fallbacks still apply.
            if let Ok(dir) = app.path().resolve("resources", tauri::path::BaseDirectory::Resource) {
                let _ = RESOURCE_DIR.set(dir);
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![get_video_info, stream_youtube])
        .build()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(windows)]
    #[test]
    fn helper_candidates_target_the_companion_helpers_dir() {
        // The install root is only known at runtime; assert the shape of every
        // candidate so a renamed helper directory cannot pass unnoticed.
        for candidate in helper_candidates() {
            assert!(candidate.ends_with("GoRakuDo\\EizouDendenshi\\helpers\\yt-dlp-windows-amd64.exe")
                || candidate.ends_with("GoRakuDo\\EizouDendenshi\\helpers\\yt-dlp.exe"),
                "unexpected helper candidate: {}",
                candidate.display());
        }
    }

    #[cfg(windows)]
    #[test]
    fn bundled_candidates_point_at_the_shipped_windows_resource_file() {
        let candidates = bundled_candidates();
        let expected = PathBuf::from("resources")
            .join("windows")
            .join(YTDLP_EXE_NAME);
        assert!(
            candidates
                .iter()
                .any(|candidate| candidate.ends_with(&expected)),
            "no bundled candidate points at {}",
            expected.display()
        );
        for candidate in &candidates {
            assert_eq!(
                candidate.file_name().and_then(|name| name.to_str()),
                Some(YTDLP_EXE_NAME)
            );
            // The flat layout is a legacy fallback, never `resources/resources/`.
            assert!(
                !candidate.to_string_lossy().contains("resources\\resources")
                    && !candidate.to_string_lossy().contains("resources/resources"),
                "duplicated resources segment: {}",
                candidate.display()
            );
        }
    }

    #[cfg(not(windows))]
    #[test]
    fn bundled_candidates_stay_empty_off_windows() {
        // Android APKs must never carry or probe a Windows executable.
        assert!(
            bundled_candidates().is_empty(),
            "non-Windows builds must not resolve a bundled executable"
        );
    }

    #[test]
    fn resolves_to_a_non_empty_binary_name() {
        assert!(!ytdlp_binary().trim().is_empty());
    }

    #[test]
    fn rejects_non_http_urls() {
        assert!(validate_url("").is_err());
        assert!(validate_url("magnet:?xt=urn:btih:abc").is_err());
        assert!(validate_url("https://www.youtube.com/watch?v=abc").is_ok());
    }

    #[test]
    fn maps_modes_to_selectors() {
        assert_eq!(format_selector_for("audio").unwrap(), "bestaudio/best");

        let video = format_selector_for("video").unwrap();
        // 1st choice: progressive muxed at 720p or better.
        assert!(video.starts_with("best[height>=720][height<=1080]/"));
        // 2nd choice: any muxed stream (YouTube only publishes 360p sometimes).
        assert!(video.contains("/best[height<=1080]/"));
        // 3rd choice: separate streams, still 720p floor, then last resort.
        assert!(video.contains("/bestvideo[height>=720][height<=1080]+bestaudio/"));
        assert!(video.ends_with("/best"));
        assert_eq!(video.matches('/').count(), 3);

        assert!(format_selector_for("4k").is_err());
    }

    #[test]
    fn youtube_requests_pin_the_client_fallback_chain() {
        assert_eq!(YOUTUBE_EXTRACTOR_ARGS, "youtube:player_client=mweb,android,web");
    }

    #[tokio::test]
    async fn relay_serves_loopback_urls_and_rejects_unknown_sessions() {
        let relay = relay::ensure().await.expect("relay starts");
        let local = relay.register("https://cdn.example/video.mp4");
        assert!(local.starts_with("http://127.0.0.1:"), "{local}");
        let (base, session) = local.split_once("/stream/").expect("session path");
        assert!(!session.is_empty());
        // Every registration gets its own session id, even for the same URL.
        assert_ne!(relay.register("https://cdn.example/video.mp4"), local);

        let response = reqwest::Client::new()
            .get(format!("{base}/stream/missing-session"))
            .send()
            .await
            .expect("relay answers");
        assert_eq!(response.status().as_u16(), 404);
    }

    #[test]
    fn parses_single_muxed_stream() {
        let urls = parse_stream_urls("https://cdn.example/muxed.mp4\n").expect("parses");
        assert_eq!(urls, vec!["https://cdn.example/muxed.mp4"]);
    }

    #[test]
    fn keeps_video_first_for_separate_streams() {
        let urls = parse_stream_urls("https://cdn.example/video.mp4\nhttps://cdn.example/audio.webm\n")
            .expect("parses");
        assert_eq!(urls.len(), 2);
        assert_eq!(urls[0], "https://cdn.example/video.mp4");
        assert_eq!(urls[1], "https://cdn.example/audio.webm");
    }

    #[test]
    fn rejects_empty_or_overlong_stream_output() {
        assert!(parse_stream_urls("\n\n").is_err());
        assert!(parse_stream_urls("a\nb\nc").is_err());
    }

    #[test]
    fn parses_metadata_and_subtitles() {
        let raw = r#"{
            "id": "abc123",
            "title": "テスト動画",
            "duration": 12.5,
            "thumbnail": "https://img.example/t.jpg",
            "webpage_url": "https://www.youtube.com/watch?v=abc123",
            "is_live": false,
            "subtitles": { "ja": [{"ext": "vtt"}], "en": [] },
            "automatic_captions": { "ja": [], "id": [] },
            "formats": [
                {"format_id": "137", "ext": "mp4", "height": 1080, "vcodec": "avc1", "acodec": "none", "filesize_approx": 1234},
                {"ext": "mp4"}
            ]
        }"#;

        let info = parse_video_info(raw).expect("parses");
        assert_eq!(info.title, "テスト動画");
        assert_eq!(info.duration, Some(12.5));
        assert_eq!(info.subtitles, vec!["en", "id", "ja"]);
        // The entry without a format_id is dropped.
        assert_eq!(info.formats.len(), 1);
        assert_eq!(info.formats[0].filesize, Some(1234));
    }

    #[test]
    fn requires_title() {
        assert!(parse_video_info(r#"{"id":"x"}"#).is_err());
        assert!(parse_video_info("not json").is_err());
    }
}
