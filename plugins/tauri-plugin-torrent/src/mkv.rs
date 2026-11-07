//! Minimal Matroska (EBML) track-header inspection.
//!
//! Chromium never exposes MKV audio/subtitle tracks to JavaScript
//! (`HTMLMediaElement.audioTracks` is flag-gated, `video.textTracks` stays empty
//! for Matroska), so the player cannot pick the Japanese audio track on its own
//! — it is forced onto the first track, which is usually the English dub. The
//! native side therefore reads the container header itself, lists the tracks
//! and applies the `--alang=ja,jpn` / `--slang=ja,jpn` preference rules
//! (`docs/MODULE_ARCHITECTURE.md` §9.2).
//!
//! The parser is deliberately small and hermetic:
//!
//! - pure Rust, no dependencies, no allocation beyond the result;
//! - works on a caller-supplied byte slice, so the caller bounds the read
//!   (a few hundred KiB of header, never the whole file);
//! - only `EBML` → `Segment` → `Tracks` → `TrackEntry` is descended, every
//!   other element (notably the huge `Cluster`s) is skipped by size;
//! - truncation is reported as [`MkvError::Truncated`] so the caller can read
//!   more bytes and retry instead of guessing.

use serde::{Deserialize, Serialize};

/// `EBML` (top-level header).
const ID_EBML: u32 = 0x1A45_DFA3;
/// `Segment` (master element wrapping the whole document).
const ID_SEGMENT: u32 = 0x1853_8067;
/// `Tracks` (master element holding every `TrackEntry`).
const ID_TRACKS: u32 = 0x1654_AE6B;
/// `TrackEntry`.
const ID_TRACK_ENTRY: u32 = 0xAE;
const ID_TRACK_NUMBER: u32 = 0xD7;
const ID_TRACK_TYPE: u32 = 0x83;
const ID_LANGUAGE: u32 = 0x0022_B59C;
const ID_LANGUAGE_BCP47: u32 = 0x0022_B59D;
const ID_NAME: u32 = 0x536E;
const ID_CODEC_ID: u32 = 0x86;

/// Matroska `TrackType` values we care about.
const TRACK_TYPE_VIDEO: u64 = 1;
const TRACK_TYPE_AUDIO: u64 = 2;
const TRACK_TYPE_SUBTITLE: u64 = 0x11;

/// Maximum master-element nesting followed while looking for `Tracks`.
///
/// `Segment` → `Tracks` is the only path we ever need, so a small bound keeps
/// a maliciously nested file from turning the walk into unbounded recursion.
const MAX_DEPTH: usize = 4;

#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum MkvError {
    #[error("not a matroska document")]
    NotMatroska,
    #[error("matroska header truncated")]
    Truncated,
    #[error("matroska header malformed")]
    Malformed,
}

/// One track found in the container header.
///
/// `track_type` is one of `video`, `audio`, `subtitle`, `other`; `number` is the
/// Matroska `TrackNumber` the player/engine uses as `aid`/`sid`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct MkvTrackInfo {
    pub number: u32,
    pub track_type: String,
    /// Matroska `Language` (legacy ISO-639-2 form, e.g. `jpn`).
    pub language: Option<String>,
    /// Matroska `LanguageBCP47` (e.g. `ja-JP`).
    pub language_bcp47: Option<String>,
    /// Matroska `Name` (often carries "Japanese", "Signs & Songs", …).
    pub name: Option<String>,
    pub codec: Option<String>,
    /// `true` when any of the language/name fields reads as Japanese.
    pub is_japanese: bool,
}

/// Track listing plus the auto-selected Japanese audio/subtitle track numbers.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct MkvTrackReport {
    pub tracks: Vec<MkvTrackInfo>,
    /// Track number to use as `aid`; `None` → engine default (first audio).
    pub selected_audio: Option<u32>,
    /// Track number to use as `sid`; `None` → engine default (first subtitle).
    pub selected_subtitle: Option<u32>,
}

impl MkvTrackReport {
    /// Build a report and apply the Japanese preference rules.
    pub fn from_tracks(tracks: Vec<MkvTrackInfo>) -> Self {
        let selected_audio = preferred_track(&tracks, "audio");
        let selected_subtitle = preferred_track(&tracks, "subtitle");
        Self {
            tracks,
            selected_audio,
            selected_subtitle,
        }
    }

    pub fn is_empty(&self) -> bool {
        self.tracks.is_empty()
    }
}

/// First Japanese track of `track_type`, if the header declares one.
///
/// Mirrors mpv's `--alang`/`--slang` behaviour: the first entry of the
/// preference list that exists wins. When nothing matches we return `None` so
/// the caller falls back to the engine default instead of failing playback.
fn preferred_track(tracks: &[MkvTrackInfo], track_type: &str) -> Option<u32> {
    tracks
        .iter()
        .find(|track| track.track_type == track_type && track.is_japanese)
        .map(|track| track.number)
}

/// Does this free-form tag (language code or track title) read as Japanese?
///
/// Accepts the ISO-639-1 (`ja`), ISO-639-2 (`jpn`) and spelled-out forms plus
/// BCP-47 variants (`ja-JP`, `ja_JP`), and the native-script title used by many
/// Japanese releases. Bare `jp` is not a language code (it is a country TLD), so
/// it is deliberately not accepted.
pub fn is_japanese_tag(value: &str) -> bool {
    let trimmed = value.trim().trim_matches('\0').trim();
    if trimmed.is_empty() {
        return false;
    }
    let lowered = trimmed.to_ascii_lowercase();
    let primary = lowered
        .split(['-', '_', ' ', '/', '('])
        .next()
        .unwrap_or(lowered.as_str());
    if matches!(primary, "ja" | "jpn" | "japanese" | "nihongo") {
        return true;
    }
    // Titles such as "Japanese Dub" / "日本語音声" only match on the full string.
    lowered.contains("japanese") || trimmed.contains("日本語") || trimmed.contains("にほんご")
}

/// Parse the `Tracks` element out of a Matroska header prefix.
///
/// `data` may be any prefix of the file: when the `Tracks` payload is not fully
/// present yet, [`MkvError::Truncated`] is returned and the caller should read
/// more bytes. A document with no `Tracks` element at all yields an empty list.
pub fn parse_tracks(data: &[u8]) -> Result<Vec<MkvTrackInfo>, MkvError> {
    let (id, _size, _payload_start) = element_at(data, 0).ok_or(MkvError::Truncated)?;
    if id != ID_EBML {
        return Err(MkvError::NotMatroska);
    }

    let mut tracks = Vec::new();
    walk(data, 0, data.len(), 0, &mut tracks)?;
    Ok(tracks)
}

/// Read an element ID (marker bits kept, as Matroska IDs are written that way).
fn read_id(data: &[u8], pos: usize) -> Option<(u32, usize)> {
    let first = *data.get(pos)?;
    if first == 0 {
        return None;
    }
    let len = first.leading_zeros() as usize + 1;
    if len > 4 || pos + len > data.len() {
        return None;
    }
    let mut value: u32 = 0;
    for index in 0..len {
        value = (value << 8) | data[pos + index] as u32;
    }
    Some((value, pos + len))
}

/// Read an element size VINT. `None` size means "unknown length" (all data bits
/// set), which is legal for `Segment` and live-streamed `Cluster`s.
fn read_size(data: &[u8], pos: usize) -> Option<(Option<u64>, usize)> {
    let first = *data.get(pos)?;
    if first == 0 {
        return None;
    }
    let len = first.leading_zeros() as usize + 1;
    if len > 8 || pos + len > data.len() {
        return None;
    }
    let mask = 0xFFu64 >> len;
    let mut value = (first as u64) & mask;
    let mut all_ones = value == mask;
    for index in 1..len {
        let byte = data[pos + index] as u64;
        value = (value << 8) | byte;
        if byte != 0xFF {
            all_ones = false;
        }
    }
    if all_ones {
        Some((None, pos + len))
    } else {
        Some((Some(value), pos + len))
    }
}

/// Resolve the element starting at `pos` into `(id, size, payload_start)`.
fn element_at(data: &[u8], pos: usize) -> Option<(u32, Option<u64>, usize)> {
    let (id, after_id) = read_id(data, pos)?;
    let (size, payload_start) = read_size(data, after_id)?;
    Some((id, size, payload_start))
}

/// Resolve the traversal window of a root container such as `Segment`.
///
/// A real `Segment` declares the size of the entire movie (gigabytes), while
/// the caller only ever hands us a few hundred KiB of header. Demanding the
/// full payload would report [`MkvError::Truncated`] for every real file, so a
/// root container is walked only as far as the bytes we currently hold. Leaf
/// elements (`Tracks`, `TrackEntry`) still use the strict [`payload_end`].
fn container_end(data: &[u8], size: Option<u64>, payload_start: usize, limit: usize) -> usize {
    let end = match size {
        // An unknown size runs to the end of what we currently hold.
        None => limit,
        Some(len) => u64::try_from(payload_start)
            .ok()
            .and_then(|start| start.checked_add(len))
            .and_then(|end| usize::try_from(end).ok())
            .unwrap_or(usize::MAX),
    };
    end.min(limit).min(data.len())
}

/// Resolve an element's payload window, erroring when the slice ends inside it.
fn payload_end(
    data: &[u8],
    size: Option<u64>,
    payload_start: usize,
    limit: usize,
) -> Result<usize, MkvError> {
    let end = match size {
        // An unknown size runs to the end of what we currently hold.
        None => limit,
        Some(len) => {
            let len = usize::try_from(len).map_err(|_| MkvError::Malformed)?;
            match payload_start.checked_add(len) {
                Some(end) if end <= limit => end,
                _ => return Err(MkvError::Truncated),
            }
        }
    };
    Ok(end.min(data.len()))
}

/// Walk master elements, descending into `Segment` and stopping at `Tracks`.
fn walk(
    data: &[u8],
    start: usize,
    end: usize,
    depth: usize,
    out: &mut Vec<MkvTrackInfo>,
) -> Result<(), MkvError> {
    if depth > MAX_DEPTH {
        return Err(MkvError::Malformed);
    }
    let mut pos = start;
    while pos < end {
        let (id, size, payload_start) = element_at(data, pos).ok_or(MkvError::Truncated)?;

        // `Segment` is the root container: its declared size covers the whole
        // file, so clamp the traversal to the buffer instead of asking for the
        // multi-gigabyte payload.
        if id == ID_SEGMENT {
            let stop = container_end(data, size, payload_start, end);
            if stop <= pos {
                return Err(MkvError::Malformed);
            }
            walk(data, payload_start, stop, depth + 1, out)?;
            pos = stop;
            continue;
        }

        let stop = payload_end(data, size, payload_start, end)?;
        if id == ID_TRACKS {
            parse_tracks_payload(data, payload_start, stop, out)?;
            return Ok(());
        }

        // A zero-length element still advances past its header, so progress is
        // guaranteed; the check only catches a malformed header that would not.
        let next = stop.max(payload_start);
        if next <= pos {
            return Err(MkvError::Malformed);
        }
        pos = next;
    }
    Ok(())
}

/// Parse every `TrackEntry` inside the `Tracks` payload.
fn parse_tracks_payload(
    data: &[u8],
    start: usize,
    end: usize,
    out: &mut Vec<MkvTrackInfo>,
) -> Result<(), MkvError> {
    let mut pos = start;
    while pos < end {
        let (id, size, payload_start) = element_at(data, pos).ok_or(MkvError::Truncated)?;
        let stop = payload_end(data, size, payload_start, end)?;
        if id == ID_TRACK_ENTRY {
            if let Some(track) = parse_track_entry(data, payload_start, stop)? {
                out.push(track);
            }
        }
        if stop <= pos {
            return Err(MkvError::Malformed);
        }
        pos = stop;
    }
    Ok(())
}

/// Parse one `TrackEntry`. Returns `None` for entries without a usable
/// `TrackNumber` (e.g. a partially downloaded header).
fn parse_track_entry(
    data: &[u8],
    start: usize,
    end: usize,
) -> Result<Option<MkvTrackInfo>, MkvError> {
    let mut number: Option<u32> = None;
    let mut track_type: Option<u64> = None;
    let mut language: Option<String> = None;
    let mut language_bcp47: Option<String> = None;
    let mut name: Option<String> = None;
    let mut codec: Option<String> = None;

    let mut pos = start;
    while pos < end {
        let (id, size, payload_start) = element_at(data, pos).ok_or(MkvError::Truncated)?;
        let stop = payload_end(data, size, payload_start, end)?;
        let payload = data.get(payload_start..stop).unwrap_or(&[]);

        match id {
            ID_TRACK_NUMBER => number = read_uint(payload).map(|value| value as u32),
            ID_TRACK_TYPE => track_type = read_uint(payload),
            ID_LANGUAGE => language = read_string(payload),
            ID_LANGUAGE_BCP47 => language_bcp47 = read_string(payload),
            ID_NAME => name = read_string(payload),
            ID_CODEC_ID => codec = read_string(payload),
            _ => {}
        }

        if stop <= pos {
            return Err(MkvError::Malformed);
        }
        pos = stop;
    }

    let Some(number) = number.filter(|value| *value > 0) else {
        return Ok(None);
    };

    let track_type = match track_type {
        Some(TRACK_TYPE_AUDIO) => "audio",
        Some(TRACK_TYPE_SUBTITLE) => "subtitle",
        Some(TRACK_TYPE_VIDEO) => "video",
        _ => "other",
    }
    .to_string();

    let is_japanese = [
        language.as_deref(),
        language_bcp47.as_deref(),
        name.as_deref(),
    ]
    .into_iter()
    .flatten()
    .any(is_japanese_tag);

    Ok(Some(MkvTrackInfo {
        number,
        track_type,
        language,
        language_bcp47,
        name,
        codec,
        is_japanese,
    }))
}

/// Big-endian unsigned integer payload (Matroska `uint`, 1–8 bytes).
fn read_uint(payload: &[u8]) -> Option<u64> {
    if payload.is_empty() || payload.len() > 8 {
        return None;
    }
    let mut value: u64 = 0;
    for byte in payload {
        value = (value << 8) | *byte as u64;
    }
    Some(value)
}

/// UTF-8 string payload; Matroska pads with NUL bytes.
fn read_string(payload: &[u8]) -> Option<String> {
    let text = String::from_utf8_lossy(payload);
    let trimmed = text.trim_matches('\0').trim();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed.to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 8-byte VINT size encoding (always valid, keeps the fixtures simple).
    fn size_vint(value: usize) -> Vec<u8> {
        let mut bytes = vec![0x01u8];
        bytes.extend_from_slice(&(value as u64).to_be_bytes()[1..]);
        bytes
    }

    fn elem(id: &[u8], payload: &[u8]) -> Vec<u8> {
        let mut bytes = id.to_vec();
        bytes.extend_from_slice(&size_vint(payload.len()));
        bytes.extend_from_slice(payload);
        bytes
    }

    fn elem_unknown_size(id: &[u8], payload: &[u8]) -> Vec<u8> {
        let mut bytes = id.to_vec();
        bytes.extend_from_slice(&[0x01, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF]);
        bytes.extend_from_slice(payload);
        bytes
    }

    /// 8-byte VINT size encoding for an arbitrary `u64` (e.g. a movie's size).
    fn size_vint_u64(value: u64) -> Vec<u8> {
        let mut bytes = vec![0x01u8];
        bytes.extend_from_slice(&value.to_be_bytes()[1..]);
        bytes
    }

    fn uint_elem(id: &[u8], value: u8) -> Vec<u8> {
        elem(id, &[value])
    }

    fn str_elem(id: &[u8], value: &str) -> Vec<u8> {
        elem(id, value.as_bytes())
    }

    fn track_entry(number: u8, track_type: u8, language: &str, name: &str) -> Vec<u8> {
        let mut payload = Vec::new();
        payload.extend_from_slice(&uint_elem(&[0xD7], number));
        payload.extend_from_slice(&uint_elem(&[0x83], track_type));
        payload.extend_from_slice(&str_elem(&[0x22, 0xB5, 0x9C], language));
        payload.extend_from_slice(&str_elem(&[0x53, 0x6E], name));
        payload.extend_from_slice(&str_elem(&[0x86], "A_AAC"));
        elem(&[0xAE], &payload)
    }

    /// `EBML` header + `Segment` → `Tracks` with the given entries.
    fn matroska(entries: &[Vec<u8>]) -> Vec<u8> {
        let ebml = elem(
            &[0x1A, 0x45, 0xDF, 0xA3],
            &str_elem(&[0x42, 0x82], "matroska"),
        );
        let mut tracks_payload = Vec::new();
        for entry in entries {
            tracks_payload.extend_from_slice(entry);
        }
        let tracks = elem(&[0x16, 0x54, 0xAE, 0x6B], &tracks_payload);
        let segment = elem(&[0x18, 0x53, 0x80, 0x67], &tracks);
        let mut file = ebml;
        file.extend_from_slice(&segment);
        file
    }

    fn multi_track_file() -> Vec<u8> {
        matroska(&[
            track_entry(1, 1, "und", "Video"),
            track_entry(2, 2, "eng", "English Dub"),
            track_entry(3, 2, "jpn", "Japanese"),
            track_entry(4, 0x11, "eng", "Signs & Songs"),
            track_entry(5, 0x11, "jpn", "日本語字幕"),
        ])
    }

    #[test]
    fn parses_all_track_types_and_languages() {
        let tracks = parse_tracks(&multi_track_file()).expect("valid header");
        assert_eq!(tracks.len(), 5);
        assert_eq!(tracks[0].track_type, "video");
        assert_eq!(tracks[1].track_type, "audio");
        assert_eq!(tracks[1].language.as_deref(), Some("eng"));
        assert!(!tracks[1].is_japanese);
        assert_eq!(tracks[2].number, 3);
        assert!(tracks[2].is_japanese);
        assert_eq!(tracks[3].track_type, "subtitle");
        assert!(!tracks[3].is_japanese);
        assert_eq!(tracks[4].name.as_deref(), Some("日本語字幕"));
        assert!(tracks[4].is_japanese);
        assert_eq!(tracks[2].codec.as_deref(), Some("A_AAC"));
    }

    #[test]
    fn selects_japanese_audio_and_subtitle() {
        let report = MkvTrackReport::from_tracks(parse_tracks(&multi_track_file()).unwrap());
        assert_eq!(report.selected_audio, Some(3));
        assert_eq!(report.selected_subtitle, Some(5));
    }

    #[test]
    fn falls_back_to_none_without_japanese_tracks() {
        let file = matroska(&[
            track_entry(1, 1, "und", "Video"),
            track_entry(2, 2, "eng", "English"),
            track_entry(3, 0x11, "eng", "English SDH"),
        ]);
        let report = MkvTrackReport::from_tracks(parse_tracks(&file).unwrap());
        assert_eq!(report.selected_audio, None);
        assert_eq!(report.selected_subtitle, None);
        assert_eq!(report.tracks.len(), 3);
    }

    #[test]
    fn accepts_bcp47_and_spelled_out_japanese_tags() {
        let mut payload = Vec::new();
        payload.extend_from_slice(&uint_elem(&[0xD7], 1));
        payload.extend_from_slice(&uint_elem(&[0x83], 2));
        payload.extend_from_slice(&str_elem(&[0x22, 0xB5, 0x9D], "ja-JP"));
        let entry = elem(&[0xAE], &payload);
        let tracks = parse_tracks(&matroska(&[entry])).unwrap();
        assert_eq!(tracks.len(), 1);
        assert_eq!(tracks[0].language_bcp47.as_deref(), Some("ja-JP"));
        assert!(tracks[0].is_japanese);

        assert!(is_japanese_tag("ja"));
        assert!(is_japanese_tag("JPN"));
        assert!(is_japanese_tag("Japanese"));
        assert!(is_japanese_tag("ja_JP"));
        assert!(is_japanese_tag("Japanese Dub"));
        assert!(!is_japanese_tag(""));
        assert!(!is_japanese_tag("eng"));
        assert!(!is_japanese_tag("English Dub"));
        assert!(!is_japanese_tag("javanese"));
        // `jp` is a country TLD, not a language code; only ISO-639 / BCP-47
        // codes and spelled-out names are accepted.
        assert!(!is_japanese_tag("jp"));
        assert!(!is_japanese_tag("JP"));
    }

    #[test]
    fn parses_tracks_inside_multi_gigabyte_segment() {
        // A real `Segment` declares the size of the whole movie (here 10 GB),
        // while the caller only holds the first few KiB of header. The walker
        // must clamp the root container to the buffer instead of demanding the
        // full payload, otherwise every real file reports `Truncated`.
        let mut tracks_payload = Vec::new();
        tracks_payload.extend_from_slice(&track_entry(1, 1, "und", "Video"));
        tracks_payload.extend_from_slice(&track_entry(2, 2, "eng", "English Dub"));
        tracks_payload.extend_from_slice(&track_entry(3, 2, "jpn", "Japanese"));
        tracks_payload.extend_from_slice(&track_entry(4, 0x11, "jpn", "日本語字幕"));
        let tracks = elem(&[0x16, 0x54, 0xAE, 0x6B], &tracks_payload);

        let ebml = elem(
            &[0x1A, 0x45, 0xDF, 0xA3],
            &str_elem(&[0x42, 0x82], "matroska"),
        );
        let mut file = ebml;
        file.extend_from_slice(&[0x18, 0x53, 0x80, 0x67]);
        file.extend_from_slice(&size_vint_u64(10_000_000_000));
        file.extend_from_slice(&tracks);

        assert!(file.len() < 4096, "fixture must fit one small header read");

        let parsed = parse_tracks(&file).expect("huge segment size must not truncate");
        assert_eq!(parsed.len(), 4);
        assert_eq!(parsed[2].number, 3);
        assert!(parsed[2].is_japanese);
        assert!(parsed[3].is_japanese);

        let report = MkvTrackReport::from_tracks(parsed);
        assert_eq!(report.selected_audio, Some(3));
        assert_eq!(report.selected_subtitle, Some(4));
    }

    #[test]
    fn handles_unknown_size_segment() {
        let mut tracks_payload = Vec::new();
        tracks_payload.extend_from_slice(&track_entry(1, 2, "jpn", "Japanese"));
        let tracks = elem(&[0x16, 0x54, 0xAE, 0x6B], &tracks_payload);
        let segment = elem_unknown_size(&[0x18, 0x53, 0x80, 0x67], &tracks);
        let ebml = elem(&[0x1A, 0x45, 0xDF, 0xA3], &[]);
        let mut file = ebml;
        file.extend_from_slice(&segment);

        let parsed = parse_tracks(&file).unwrap();
        assert_eq!(parsed.len(), 1);
        assert!(parsed[0].is_japanese);
    }

    #[test]
    fn skips_clusters_before_tracks() {
        // Some muxers emit a Cluster before Tracks; the walker must skip it by
        // declared size instead of scanning its bytes for element IDs.
        let cluster = elem(&[0x1F, 0x43, 0xB6, 0x75], &[0xD7, 0x83, 0xAE, 0x00]);
        let mut tracks_payload = Vec::new();
        tracks_payload.extend_from_slice(&track_entry(7, 2, "jpn", "Japanese"));
        let tracks = elem(&[0x16, 0x54, 0xAE, 0x6B], &tracks_payload);
        let mut segment_payload = cluster;
        segment_payload.extend_from_slice(&tracks);
        let segment = elem(&[0x18, 0x53, 0x80, 0x67], &segment_payload);
        let ebml = elem(&[0x1A, 0x45, 0xDF, 0xA3], &[]);
        let mut file = ebml;
        file.extend_from_slice(&segment);

        let parsed = parse_tracks(&file).unwrap();
        assert_eq!(parsed.len(), 1);
        assert_eq!(parsed[0].number, 7);
    }

    #[test]
    fn rejects_non_matroska_and_truncated_input() {
        assert_eq!(parse_tracks(b""), Err(MkvError::Truncated));
        assert_eq!(parse_tracks(b"\x00\x00\x00\x00"), Err(MkvError::Truncated));
        assert_eq!(
            parse_tracks(b"RIFFxxxxWAVEfmt "),
            Err(MkvError::NotMatroska)
        );

        // Cutting inside the Tracks payload must ask for more bytes rather than
        // reporting a bogus (partial) track list.
        let file = multi_track_file();
        let cut = file.len() - 4;
        assert_eq!(parse_tracks(&file[..cut]), Err(MkvError::Truncated));
    }

    #[test]
    fn reports_empty_when_tracks_missing() {
        let ebml = elem(&[0x1A, 0x45, 0xDF, 0xA3], &[]);
        let info = elem(&[0x15, 0x49, 0xA9, 0x66], &str_elem(&[0x4D, 0x80], "title"));
        let segment = elem(&[0x18, 0x53, 0x80, 0x67], &info);
        let mut file = ebml;
        file.extend_from_slice(&segment);

        assert_eq!(parse_tracks(&file), Ok(Vec::new()));
    }
}
