//! Trace log — the user-action → system-reaction journal.
//! ---------------------------------------------------------------------------
//! The web layer records what the user did (which screen, which control) and
//! what the system answered (media events, IPC results, errors) as structured
//! entries; this module is the only thing that writes them to disk.
//!
//! Storage contract:
//!
//! - directory: `<app_log_dir>/traces/` (`app_log_dir` is Tauri's canonical
//!   log directory: `%LOCALAPPDATA%\org.gorakudo.entei\logs` on Windows,
//!   `~/Library/Logs/org.gorakudo.entei` on macOS,
//!   `$XDG_DATA_HOME/org.gorakudo.entei/logs` on Linux,
//!   `<app data>/logs` on Android);
//! - file per UTC day: `trace-YYYY-MM-DD.log`, one JSON object per line
//!   (JSONL) so a trace can be read with `Select-String` / `jq` / `grep`
//!   without a parser;
//! - retention: 24 hours. Every write sweeps the directory and deletes any
//!   `trace-*.log` whose modification time is older than 24h, which is exactly
//!   "keep one rolling day, drop yesterday's file". The sweep is throttled
//!   (once a minute) so a chatty session does not re-stat the directory on
//!   every batch.
//!
//! Safety:
//!
//! - every append is wrapped: a broken trace must never break playback, so the
//!   command reports an error to the caller but the frontend ignores it;
//! - each line is capped (`MAX_LINE_BYTES`) and an oversized entry keeps only
//!   its `area`/`event` plus a `truncated` marker, so a runaway payload cannot
//!   fill the disk or corrupt the JSONL framing;
//! - `area` / `event` are capped in characters (not bytes) so multi-byte text
//!   never splits mid-codepoint.
//! ---------------------------------------------------------------------------

use std::{
    fs::{self, OpenOptions},
    io::Write,
    path::{Path, PathBuf},
    sync::atomic::{AtomicU64, Ordering},
    time::{SystemTime, UNIX_EPOCH},
};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

/// Rolling retention window (24 hours, in milliseconds).
const RETENTION_MS: u64 = 24 * 60 * 60 * 1000;

/// Hard cap for one written line so a runaway payload cannot fill the disk.
const MAX_LINE_BYTES: usize = 8 * 1024;

/// Hard cap on entries accepted per IPC call (the frontend batches ~1s worth).
const MAX_BATCH: usize = 256;

/// Character cap for the `area` / `event` labels.
const MAX_LABEL_CHARS: usize = 96;

/// A retention sweep runs at most this often.
const PURGE_INTERVAL_MS: u64 = 60 * 1000;

/// Wall-clock time of the last sweep (0 = never), shared across IPC threads.
static LAST_PURGE_MS: AtomicU64 = AtomicU64::new(0);

/// One trace line. `ts` is the frontend's event time in epoch milliseconds;
/// when it is missing the write time is used instead, so a line is always
/// ordered.
#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct TraceEntry {
    /// Event time, epoch milliseconds (frontend clock).
    #[serde(default)]
    pub ts: Option<u64>,
    /// Which part of the app emitted it (`home`, `profile`, `player`, `ipc`…).
    pub area: String,
    /// What happened (`post_publish`, `seek`, `invoke_error`…).
    pub event: String,
    /// Optional structured payload (ids, durations, messages).
    #[serde(default)]
    pub data: Option<serde_json::Value>,
}

/// Current wall-clock time in epoch milliseconds.
fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// `<app_log_dir>/traces` — the only directory this module ever writes to.
fn trace_dir(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_log_dir()
        .map(|dir| dir.join("traces"))
        .map_err(|err| format!("trace dir unavailable: {err}"))
}

/// Days since 1970-01-01 → (year, month, day) in the proleptic Gregorian
/// calendar (Howard Hinnant's `civil_from_days`). Kept local so the trace log
/// needs no date crate: the only calendar fact it needs is "which day is it".
fn civil_from_days(days: i64) -> (i64, u32, u32) {
    let z = days + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = z - era * 146_097; // [0, 146096]
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365; // [0, 399]
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100); // [0, 365]
    let mp = (5 * doy + 2) / 153; // [0, 11]
    let d = doy - (153 * mp + 2) / 5 + 1; // [1, 31]
    let m = if mp < 10 { mp + 3 } else { mp - 9 }; // [1, 12]
    let year = if m <= 2 { y + 1 } else { y };
    (year, m as u32, d as u32)
}

/// `YYYY-MM-DD` in UTC for the given epoch milliseconds.
fn day_stamp(ms: u64) -> String {
    let (year, month, day) = civil_from_days((ms / 86_400_000) as i64);
    format!("{year:04}-{month:02}-{day:02}")
}

/// True when this call should sweep the directory (throttled).
fn should_purge(now: u64) -> bool {
    let last = LAST_PURGE_MS.load(Ordering::Relaxed);
    if last != 0 && now.saturating_sub(last) < PURGE_INTERVAL_MS {
        return false;
    }
    // Best-effort claim: a concurrent writer may also sweep, which is harmless
    // (both only delete files that are already past retention).
    LAST_PURGE_MS.store(now, Ordering::Relaxed);
    true
}

/// Delete every `trace-*.log` older than the retention window.
///
/// Age is the file's modification time, not its name: the current day's file
/// is always fresh, and a file from yesterday stays until it is a full 24
/// hours old — exactly the documented "keep one rolling day" behaviour.
fn purge_expired(dir: &Path) {
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let name = entry.file_name();
        let name = name.to_string_lossy();
        if !name.starts_with("trace-") || !name.ends_with(".log") {
            continue;
        }
        let Ok(meta) = entry.metadata() else { continue };
        if !meta.is_file() {
            continue;
        }
        let Ok(modified) = meta.modified() else {
            continue;
        };
        let Ok(age) = SystemTime::now().duration_since(modified) else {
            continue;
        };
        if (age.as_millis() as u64) > RETENTION_MS {
            let _ = fs::remove_file(entry.path());
        }
    }
}

/// Character-safe label truncation (never splits a UTF-8 sequence).
fn clip_label(label: &str) -> String {
    if label.chars().count() <= MAX_LABEL_CHARS {
        return label.to_string();
    }
    let mut out: String = label.chars().take(MAX_LABEL_CHARS).collect();
    out.push('…');
    out
}

/// Serialize one entry into a single JSONL line, degrading oversized payloads.
fn encode_line(mut entry: TraceEntry, now: u64) -> Option<String> {
    if entry.ts.is_none() {
        entry.ts = Some(now);
    }
    entry.area = clip_label(&entry.area);
    entry.event = clip_label(&entry.event);

    let line = serde_json::to_string(&entry).ok()?;
    if line.len() <= MAX_LINE_BYTES {
        return Some(line);
    }
    // Too large: keep the identifying fields and drop the payload, so the
    // line stays valid JSON and the event is still visible in the trace.
    entry.data = Some(serde_json::json!({ "truncated": true }));
    serde_json::to_string(&entry).ok()
}

/// Append a batch of entries to today's trace file.
fn append(app: &AppHandle, entries: Vec<TraceEntry>) -> Result<(), String> {
    let dir = trace_dir(app)?;
    append_to_dir(&dir, entries)
}

/// The write path itself, split out from the `AppHandle` so it can be tested
/// against a real directory: create the folder, sweep expired files, append
/// one JSONL line per entry to `trace-<UTC day>.log`.
fn append_to_dir(dir: &Path, entries: Vec<TraceEntry>) -> Result<(), String> {
    if entries.is_empty() {
        return Ok(());
    }
    fs::create_dir_all(dir).map_err(|err| format!("trace dir create failed: {err}"))?;

    let now = now_ms();
    if should_purge(now) {
        purge_expired(dir);
    }

    let mut body = String::new();
    for entry in entries.into_iter().take(MAX_BATCH) {
        if let Some(line) = encode_line(entry, now) {
            body.push_str(&line);
            body.push('\n');
        }
    }
    if body.is_empty() {
        return Ok(());
    }

    let file = dir.join(format!("trace-{}.log", day_stamp(now)));
    let mut handle = OpenOptions::new()
        .create(true)
        .append(true)
        .open(&file)
        .map_err(|err| format!("trace file open failed: {err}"))?;
    handle
        .write_all(body.as_bytes())
        .map_err(|err| format!("trace write failed: {err}"))?;
    Ok(())
}

/// Sweep once at startup so yesterday's file disappears even when the first
/// thing the app does is not a trace write.
///
/// Errors are ignored on purpose: a trace directory that cannot be created or
/// read must never stop the app from starting.
pub fn purge_on_startup(app: &AppHandle) {
    let Ok(dir) = trace_dir(app) else { return };
    if fs::create_dir_all(&dir).is_err() {
        return;
    }
    let now = now_ms();
    LAST_PURGE_MS.store(now, Ordering::Relaxed);
    purge_expired(&dir);
}

/// Append trace entries (called by the web layer's trace logger).
///
/// Runs on the async runtime rather than the UI thread: the write is tiny but
/// it is still file IO, and the Player must never wait on it.
#[tauri::command]
pub async fn trace_log(app: AppHandle, entries: Vec<TraceEntry>) -> Result<(), String> {
    append(&app, entries)
}

/// Absolute path of the trace directory (for diagnostics / QA).
#[tauri::command]
pub fn trace_dir_path(app: AppHandle) -> Result<String, String> {
    trace_dir(&app).map(|dir| dir.display().to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn day_stamp_matches_known_dates() {
        // 2024-02-29T00:00:00Z (leap day) and 1970-01-01T00:00:00Z.
        assert_eq!(day_stamp(1_709_164_800_000), "2024-02-29");
        assert_eq!(day_stamp(0), "1970-01-01");
        assert_eq!(day_stamp(1_700_000_000_000), "2023-11-14");
    }

    #[test]
    fn clip_label_is_char_safe() {
        let long = "あ".repeat(MAX_LABEL_CHARS + 10);
        let clipped = clip_label(&long);
        assert_eq!(clipped.chars().count(), MAX_LABEL_CHARS + 1);
        assert!(clipped.ends_with('…'));
        assert_eq!(clip_label("player"), "player");
    }

    #[test]
    fn encode_line_fills_missing_ts_and_truncates_huge_payload() {        let entry = TraceEntry {
            ts: None,
            area: "player".into(),
            event: "seek".into(),
            data: None,
        };
        let line = encode_line(entry, 1234).expect("line");
        assert!(line.contains("\"ts\":1234"));

        let huge = TraceEntry {
            ts: Some(1),
            area: "ipc".into(),
            event: "invoke".into(),
            data: Some(serde_json::Value::String("x".repeat(MAX_LINE_BYTES * 2))),
        };
        let line = encode_line(huge, 2).expect("line");
        assert!(line.len() <= MAX_LINE_BYTES);
        assert!(line.contains("truncated"));
    }

    #[test]
    fn purge_expired_removes_only_stale_trace_files() {
        let dir = std::env::temp_dir().join(format!(
            "entei-trace-test-{}-{}",
            std::process::id(),
            now_ms()
        ));
        fs::create_dir_all(&dir).expect("temp dir");

        let stale = dir.join("trace-2020-01-01.log");
        let fresh = dir.join("trace-today.log");
        let unrelated = dir.join("notes.log");
        for path in [&stale, &fresh, &unrelated] {
            fs::write(path, "{}\n").expect("write");
        }

        // Age the stale file past the 24h window.
        let old = SystemTime::now() - std::time::Duration::from_millis(RETENTION_MS + 60_000);
        let handle = OpenOptions::new().write(true).open(&stale).expect("open stale");
        handle.set_modified(old).expect("set mtime");
        drop(handle);

        purge_expired(&dir);

        assert!(!stale.exists(), "stale trace file must be deleted");
        assert!(fresh.exists(), "today's trace file must survive");
        assert!(unrelated.exists(), "non-trace files must never be touched");

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn append_writes_one_jsonl_line_per_entry_into_todays_file() {
        let dir = std::env::temp_dir().join(format!(
            "entei-trace-append-{}-{}",
            std::process::id(),
            now_ms()
        ));
        let entries = vec![
            TraceEntry {
                ts: Some(1_700_000_000_000),
                area: "player".into(),
                event: "media_select".into(),
                data: Some(serde_json::json!({ "name": "ep01.mkv" })),
            },
            TraceEntry {
                ts: None,
                area: "ui".into(),
                event: "click".into(),
                data: None,
            },
        ];

        append_to_dir(&dir, entries).expect("append");

        let file = dir.join(format!("trace-{}.log", day_stamp(now_ms())));
        assert!(file.exists(), "today's trace file must exist");
        let text = fs::read_to_string(&file).expect("read trace");
        let lines: Vec<&str> = text.lines().collect();
        assert_eq!(lines.len(), 2, "one JSONL line per entry");

        let first: serde_json::Value = serde_json::from_str(lines[0]).expect("json");
        assert_eq!(first["area"], "player");
        assert_eq!(first["event"], "media_select");
        assert_eq!(first["data"]["name"], "ep01.mkv");
        assert_eq!(first["ts"], 1_700_000_000_000u64);

        // A missing ts is filled with the write time so ordering is never lost.
        let second: serde_json::Value = serde_json::from_str(lines[1]).expect("json");
        assert!(second["ts"].as_u64().unwrap_or(0) > 0);

        // Appending again extends the same file instead of truncating it.
        append_to_dir(
            &dir,
            vec![TraceEntry {
                ts: None,
                area: "app".into(),
                event: "pagehide".into(),
                data: None,
            }],
        )
        .expect("append again");
        let text = fs::read_to_string(&file).expect("read trace again");
        assert_eq!(text.lines().count(), 3);

        let _ = fs::remove_dir_all(&dir);
    }
}
