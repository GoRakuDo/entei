//! `tauri-plugin-subtitles`
//!
//! Native subtitle parsing, media filename parsing and LazySync offset
//! estimation for Entei.
//!
//! The three commands are pure functions that used to run on the browser
//! main thread:
//!
//! - `subtitles_parse(content, format)` — SRT / VTT / ASS parsing.
//! - `subtitles_parse_filename(name)` — media filename → `{ title, episode }`.
//! - `subtitles_estimate_lazy_sync(ref_cues, drift_cues)` — prefix consensus
//!   offset estimation between a user subtitle track and an embedded
//!   reference track.
//!
//! Every command runs the CPU-bound work on the blocking thread pool through
//! `tauri::async_runtime::spawn_blocking`, so neither the webview's
//! JavaScript thread nor the Tauri event loop has to wait for the parse.
//!
//! The parsing logic is a direct port of the TypeScript implementation
//! (`apps/web/src/features/player/subtitle-reader.ts`,
//! `filename-parser.ts`, `lazy-sync.ts`) and produces identical results, so
//! the two implementations can be swapped without a behaviour change.

mod filename;
mod lazy_sync;
mod parser;

pub use filename::{parse_filename, ParsedMediaName};
pub use lazy_sync::{estimate_lazy_sync_offset, estimate_offset_ms, OffsetEstimate};
pub use parser::{
    detect_format, parse_subtitles, SubtitleCue, SubtitleError, SubtitleParseResult,
};

use tauri::plugin::{Builder, TauriPlugin};
use tauri::Runtime;

/// Parse a subtitle file (SRT, VTT or ASS).
///
/// `format` is optional: when it is `None` (or an unknown value) the format
/// is auto-detected from the content, exactly like the TypeScript
/// implementation.
#[tauri::command]
async fn subtitles_parse(
    content: String,
    format: Option<String>,
) -> Result<SubtitleParseResult, String> {
    tauri::async_runtime::spawn_blocking(move || parser::parse_subtitles(&content, format.as_deref()))
        .await
        .map_err(|err| format!("subtitle parse task failed: {err}"))
}

/// Extract `{ title, episode }` from a media file name.
#[tauri::command]
async fn subtitles_parse_filename(name: String) -> Result<ParsedMediaName, String> {
    tauri::async_runtime::spawn_blocking(move || filename::parse_filename(&name))
        .await
        .map_err(|err| format!("filename parse task failed: {err}"))
}

/// Estimate the constant offset (reference − drift) between two subtitle
/// tracks, in seconds.
///
/// Returns `None` when the estimator refuses (fail-closed). `Some(0.0)`
/// means "already in sync" — an offset below 100 ms is sub-frame noise and
/// is reported as zero.
#[tauri::command]
async fn subtitles_estimate_lazy_sync(
    ref_cues: Vec<SubtitleCue>,
    drift_cues: Vec<SubtitleCue>,
) -> Result<Option<f64>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        lazy_sync::estimate_lazy_sync_offset(&ref_cues, &drift_cues)
    })
    .await
    .map_err(|err| format!("lazy sync estimation task failed: {err}"))
}

pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("subtitles")
        .invoke_handler(tauri::generate_handler![
            subtitles_parse,
            subtitles_parse_filename,
            subtitles_estimate_lazy_sync
        ])
        .build()
}
