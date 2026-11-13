//! `ytdlp` module inside `tauri-plugin-modules`.
//!
//! Decoupled yt-dlp bridge for Entei. Exposes two commands:
//!
//! - `get_video_info(url)`  -> runs `yt-dlp --dump-json <url>` and returns the
//!   normalized metadata (title / duration / thumbnail / formats / subtitles).
//! - `stream_youtube(url, mode)` -> runs `yt-dlp -g -f <selector> <url>`, then
//!   registers every resolved URL with the loopback relay (see [`relay`]) and
//!   returns the local `http://127.0.0.1:<port>/stream/<id>` URL(s) that the
//!   webview can feed into a `<video>` element.
//!
//! Note: yt-dlp must be reachable. Resolution order is
//! `EIZOUDEN_YTDLP_PATH` env var, then the binary embedded in the Windows Entei
//! bundle via `bundle.resources` (see [`bundled_candidates`]), then the verified
//! helper EizouDendenshi installed under its companion install root (see
//! [`helper_candidates`]), then the platform default binary name on `PATH`.

mod relay;

use std::path::PathBuf;
use std::process::Stdio;
use std::sync::OnceLock;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri::{Manager, Runtime};
use tokio::process::Command;

/// Maximum bytes of yt-dlp stdout we accept before parsing.
const MAX_STDOUT_BYTES: usize = 32 * 1024 * 1024;

/// Hard upper bound for a single yt-dlp invocation.
const SUBPROCESS_TIMEOUT: Duration = Duration::from_secs(30);

/// YouTube client fallback chain handed to yt-dlp.
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
    /// Direct WebVTT URL for the Japanese track, when YouTube published one.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub subtitle_vtt_url: Option<String>,
    pub formats: Vec<FormatInfo>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StreamSource {
    /// Primary media URL. For `mode == "video"` this is the muxed stream when
    /// available, otherwise the video-only stream (see `urls`).
    pub url: String,
    /// Every URL yt-dlp printed, in output order.
    pub urls: Vec<String>,
    /// `"audio"` or `"video"`.
    pub mode: String,
    /// The yt-dlp format selector that produced `url`.
    pub format_selector: String,
    /// `true` when `url`/`urls` point at the loopback relay, `false` when the
    /// relay could not start and the raw upstream URLs were returned instead.
    #[serde(default)]
    pub relayed: bool,
}

/// File name of the yt-dlp binary inside the bundle resource directory.
const YTDLP_EXE_NAME: &str = if cfg!(windows) { "yt-dlp.exe" } else { "yt-dlp" };

/// Bundle resource directory resolved by Tauri while the plugin initializes.
static RESOURCE_DIR: OnceLock<PathBuf> = OnceLock::new();

/// Scratch directory owned by this module.
static WORK_DIR: OnceLock<PathBuf> = OnceLock::new();

/// The module's scratch directory, when it could be resolved.
fn work_dir() -> Option<&'static PathBuf> {
    WORK_DIR.get()
}

/// Resolve the scratch directory through Tauri's `PathResolver`.
fn resolve_work_dir<R: Runtime>(app: &tauri::AppHandle<R>) -> Option<PathBuf> {
    if let Ok(dir) = app.path().app_cache_dir() {
        return Some(dir.join("ytdlp"));
    }
    if let Ok(dir) = app.path().app_local_data_dir() {
        return Some(dir.join("ytdlp"));
    }
    None
}

/// Delete everything inside the module's scratch directory, keeping the
/// directory itself.
fn purge_dir_contents(dir: &std::path::Path) {
    let entries = match std::fs::read_dir(dir) {
        Ok(entries) => entries,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => return,
        Err(_) => return,
    };
    for entry in entries.flatten() {
        let path = entry.path();
        let is_dir = entry.file_type().map(|kind| kind.is_dir()).unwrap_or(false);
        let _ = if is_dir {
            std::fs::remove_dir_all(&path)
        } else {
            std::fs::remove_file(&path)
        };
    }
}

/// yt-dlp shipped inside the Entei bundle, most likely location first.
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
    #[cfg(not(windows))]
    {
        Vec::new()
    }
}

/// Verified yt-dlp helpers installed by EizouDendenshi, most specific first.
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
    let mut command = Command::new(&binary);
    command.args(["--no-cache-dir"]);
    let temp_paths = work_dir().map(|dir| format!("temp:{}", dir.display()));
    if let Some(temp_paths) = temp_paths.as_deref() {
        command.args(["--paths", temp_paths]);
    }
    let spawn = command
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
    let subtitle_vtt_url = japanese_vtt_url(&root);

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
        subtitle_vtt_url,
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

/// Japanese track keys in preference order, per yt-dlp's source map.
const JAPANESE_SUBTITLE_KEYS: [&str; 3] = ["ja", "ja-orig", "ja-JP"];

/// Pick the first usable WebVTT URL from a subtitle-track entry list.
fn vtt_entry_url(entries: Option<&serde_json::Value>) -> Option<String> {
    entries?
        .as_array()?
        .iter()
        .filter(|entry| entry.get("ext").and_then(|v| v.as_str()) == Some("vtt"))
        .filter_map(|entry| entry.get("url").and_then(|v| v.as_str()))
        .filter(|url| url.starts_with("https://") || url.starts_with("http://"))
        .find(|url| !url.contains("tlang="))
        .map(|url| url.to_string())
}

/// Resolve the Japanese WebVTT URL from `subtitles` then `automatic_captions`.
fn japanese_vtt_url(root: &serde_json::Value) -> Option<String> {
    for source in ["subtitles", "automatic_captions"] {
        let Some(map) = root.get(source).and_then(|v| v.as_object()) else {
            continue;
        };
        for key in JAPANESE_SUBTITLE_KEYS {
            if let Some(url) = vtt_entry_url(map.get(key)) {
                return Some(url);
            }
        }
    }
    None
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
pub async fn get_video_info(url: String) -> Result<VideoInfo, String> {
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

    let mut info = parse_video_info(&raw).map_err(|err| err.message())?;

    if let Some(upstream) = info.subtitle_vtt_url.clone() {
        if let Ok(relay) = relay::ensure().await {
            info.subtitle_vtt_url = Some(relay.register(&upstream));
        }
    }

    Ok(info)
}

#[tauri::command]
pub async fn stream_youtube(url: String, mode: String) -> Result<StreamSource, String> {
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

    let upstream_urls = parse_stream_urls(&raw).map_err(|err| err.message())?;

    let (urls, relayed) = match relay::ensure().await {
        Ok(relay) => (
            upstream_urls
                .iter()
                .map(|upstream| relay.register(upstream))
                .collect::<Vec<_>>(),
            true,
        ),
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

pub(crate) fn setup<R: Runtime>(app: &tauri::AppHandle<R>) {
    if let Ok(dir) = app
        .path()
        .resolve("resources", tauri::path::BaseDirectory::Resource)
    {
        let _ = RESOURCE_DIR.set(dir);
    }
    if let Some(dir) = resolve_work_dir(app) {
        let _ = std::fs::create_dir_all(&dir);
        purge_dir_contents(&dir);
        let _ = WORK_DIR.set(dir);
    }
}

pub(crate) fn on_exit() {
    if let Some(dir) = work_dir() {
        purge_dir_contents(dir);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The startup/exit sweep must empty the module's scratch dir and keep the
    /// dir itself, so a killed session leaves nothing behind.
    #[test]
    fn purges_work_dir_contents_and_keeps_the_directory() {
        let root = std::env::temp_dir().join(format!(
            "entei-ytdlp-purge-{}-{:?}",
            std::process::id(),
            std::thread::current().id()
        ));
        let _ = std::fs::remove_dir_all(&root);
        let nested = root.join("tmp").join("fragments");
        std::fs::create_dir_all(&nested).expect("nested dirs");
        std::fs::write(nested.join("video.f137.mp4.part"), b"partial").expect("nested file");
        std::fs::write(root.join("stray.tmp"), b"x").expect("root file");

        purge_dir_contents(&root);

        assert!(root.is_dir(), "the work directory itself must survive");
        assert_eq!(
            std::fs::read_dir(&root).expect("read dir").count(),
            0,
            "every leftover entry must be gone"
        );

        // A missing directory is not an error: cleanup runs before the dir is
        // created and on exit, where it may already be gone.
        let _ = std::fs::remove_dir_all(&root);
        purge_dir_contents(&root);
        assert!(!root.exists());
    }

    #[cfg(windows)]
    #[test]
    fn helper_candidates_target_the_companion_helpers_dir() {
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
            "subtitles": { "ja": [{"ext": "vtt", "url": "https://tt.example/ja.vtt"}], "en": [] },
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
        assert_eq!(
            info.subtitle_vtt_url.as_deref(),
            Some("https://tt.example/ja.vtt")
        );
        // The entry without a format_id is dropped.
        assert_eq!(info.formats.len(), 1);
        assert_eq!(info.formats[0].filesize, Some(1234));
    }

    #[test]
    fn prefers_manual_japanese_vtt_over_automatic_captions() {
        let raw = r#"{
            "title": "t",
            "subtitles": {"ja": [{"ext": "json3", "url": "https://tt.example/ja.json3"}]},
            "automatic_captions": {
                "ja": [
                    {"ext": "json3", "url": "https://tt.example/auto.json3"},
                    {"ext": "vtt", "url": "https://tt.example/auto.vtt"}
                ]
            }
        }"#;
        let info = parse_video_info(raw).expect("parses");
        // Manual `ja` has no vtt entry, so the automatic vtt wins.
        assert_eq!(
            info.subtitle_vtt_url.as_deref(),
            Some("https://tt.example/auto.vtt")
        );
    }

    #[test]
    fn skips_auto_translated_tlang_entries() {
        // Real shape from YouTube: the translated track is listed first and
        // answers HTTP 429, so the native `kind=asr` track must be chosen.
        let raw = r#"{
            "title": "t",
            "automatic_captions": {
                "ja": [
                    {"ext": "vtt", "url": "https://tt.example/api/timedtext?lang=en-US&tlang=ja&fmt=vtt"},
                    {"ext": "vtt", "url": "https://tt.example/api/timedtext?lang=ja&kind=asr&fmt=vtt"}
                ]
            }
        }"#;
        assert_eq!(
            parse_video_info(raw)
                .expect("parses")
                .subtitle_vtt_url
                .as_deref(),
            Some("https://tt.example/api/timedtext?lang=ja&kind=asr&fmt=vtt")
        );

        // A track with only translated entries yields no URL at all.
        let translated_only = r#"{"title":"t","automatic_captions":{"ja":[{"ext":"vtt","url":"https://tt.example/timedtext?lang=en-US&tlang=ja&fmt=vtt"}]}}"#;
        assert!(parse_video_info(translated_only)
            .expect("parses")
            .subtitle_vtt_url
            .is_none());
    }

    #[test]
    fn falls_back_to_ja_orig_and_ja_jp() {
        let both = r#"{"title":"t","automatic_captions":{"ja-orig":[{"ext":"vtt","url":"https://tt.example/orig.vtt"}],"ja":[{"ext":"vtt","url":"https://tt.example/ja.vtt"}]}}"#;
        assert_eq!(
            parse_video_info(both).expect("parses").subtitle_vtt_url.as_deref(),
            Some("https://tt.example/ja.vtt")
        );

        let orig_only = r#"{"title":"t","automatic_captions":{"ja-orig":[{"ext":"vtt","url":"https://tt.example/orig.vtt"}]}}"#;
        assert_eq!(
            parse_video_info(orig_only)
                .expect("parses")
                .subtitle_vtt_url
                .as_deref(),
            Some("https://tt.example/orig.vtt")
        );

        let regional = r#"{"title":"t","subtitles":{"ja-JP":[{"ext":"vtt","url":"https://tt.example/jp.vtt"}]}}"#;
        assert_eq!(
            parse_video_info(regional)
                .expect("parses")
                .subtitle_vtt_url
                .as_deref(),
            Some("https://tt.example/jp.vtt")
        );
    }

    #[test]
    fn omits_subtitle_url_without_japanese_track() {
        let raw = r#"{"title":"t","subtitles":{"en":[{"ext":"vtt",  "url":"https://tt.example/en.vtt"}]}}"#;
        assert!(parse_video_info(raw)
            .expect("parses")
            .subtitle_vtt_url
            .is_none());
        assert!(parse_video_info(r#"{"title":"t"}"#)
            .expect("parses")
            .subtitle_vtt_url
            .is_none());
    }

    #[test]
    fn requires_title() {
        assert!(parse_video_info(r#"{"id":"x"}"#).is_err());
        assert!(parse_video_info("not json").is_err());
    }
}