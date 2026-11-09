//! Subtitle parsing — SRT, VTT and ASS.
//!
//! This is a line-by-line port of the TypeScript implementation that used to
//! run on the browser main thread:
//! `apps/web/src/features/player/subtitle-reader.ts` (Entei P1.3a).
//!
//! Every behaviour below is deliberately identical to that file, including
//! its quirks, because the two implementations must keep producing the same
//! cue list for the same input:
//!
//! - validation errors are *returned*, never thrown;
//! - VTT `NOTE` / `STYLE` blocks are dropped, YouTube ASR rolling captions
//!   are de-duplicated;
//! - ASS override tags (`{\...}`) are stripped and `\N` / `\n` become spaces;
//! - cues that share a start time are merged into one, cues with an empty
//!   text or a non-positive length are dropped silently.
//!
//! The ASS branch replaces the `ass-compiler` npm package with a hand-written
//! parser. `ass-compiler` splits a dialogue line on commas, maps the fields
//! onto the `[Events]` `Format:` order, parses `h:mm:ss.cc` timings and
//! removes `{...}` override blocks from the text. That behaviour is
//! reproduced here, including the case where the `[Events]` section has no
//! `Format:` line at all (every dialogue then has an undefined start/end
//! and is reported as an invalid timing, exactly like the npm package).

use serde::{Deserialize, Serialize};

/// Detected subtitle format.
pub const FORMAT_SRT: &str = "srt";
pub const FORMAT_VTT: &str = "vtt";
pub const FORMAT_ASS: &str = "ass";

/// The ASS header section, compared case-insensitively.
const SCRIPT_INFO_HEADER: &str = "[script info]";

/// One subtitle cue.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct SubtitleCue {
    /// Unique identifier (index-based after normalization).
    pub id: usize,
    /// Start time in seconds.
    pub start: f64,
    /// End time in seconds.
    pub end: f64,
    /// Cue text content (HTML tags stripped, whitespace normalized).
    pub text: String,
}

/// Validation error returned instead of throwing.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct SubtitleError {
    /// Line number where the error occurred (1-based), or 0 if unknown.
    pub line: usize,
    /// Human-readable error message.
    pub message: String,
}

/// Result of parsing a subtitle file.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct SubtitleParseResult {
    /// Parsed cues, sorted by start time. Empty array if parsing failed.
    pub cues: Vec<SubtitleCue>,
    /// Any validation errors encountered during parsing.
    pub errors: Vec<SubtitleError>,
    /// Detected format (`srt` / `vtt` / `ass`), or `None` when the file was
    /// empty.
    pub format: Option<String>,
}

/// Parse a subtitle file (SRT, VTT or ASS).
///
/// `format_hint` overrides the auto-detection when it is `Some("srt")`,
/// `Some("vtt")` or `Some("ass")` (case-insensitive). Any other value — and
/// `None` — falls back to the same auto-detection the TypeScript
/// implementation uses: a `WEBVTT` header means VTT, a leading
/// `[Script Info]` section means ASS, everything else is parsed as SRT.
pub fn parse_subtitles(content: &str, format_hint: Option<&str>) -> SubtitleParseResult {
    let trimmed = js_trim(content);
    if trimmed.is_empty() {
        return SubtitleParseResult {
            cues: Vec::new(),
            errors: vec![SubtitleError {
                line: 0,
                message: "Empty file".to_string(),
            }],
            format: None,
        };
    }

    match resolve_format(trimmed, format_hint) {
        Format::Vtt => parse_vtt(trimmed),
        Format::Ass => parse_ass(trimmed),
        Format::Srt => parse_srt(trimmed),
    }
}

/// Detect the subtitle format of `content` without parsing it.
///
/// Mirrors the TypeScript `detectFormat`: VTT when the content starts with
/// `WEBVTT`, ASS when it starts with a `[Script Info]` section, SRT when it
/// starts with a cue index, and `None` when the format is unknown.
pub fn detect_format(content: &str) -> Option<&'static str> {
    let trimmed = js_trim(content);
    if trimmed.starts_with("WEBVTT") {
        return Some(FORMAT_VTT);
    }
    if starts_with_ci(trimmed, SCRIPT_INFO_HEADER) {
        return Some(FORMAT_ASS);
    }
    if starts_with_cue_index(trimmed) {
        return Some(FORMAT_SRT);
    }
    None
}

/// `/^\d+\s*\n/` — a cue index on the first line.
fn starts_with_cue_index(trimmed: &str) -> bool {
    let bytes = trimmed.as_bytes();
    let mut index = 0usize;
    while index < bytes.len() && bytes[index].is_ascii_digit() {
        index += 1;
    }
    if index == 0 {
        return false;
    }
    // The rest of the first line must be whitespace that contains a newline.
    for byte in &bytes[index..] {
        if *byte == b'\n' {
            return true;
        }
        if !js_whitespace(*byte as char) {
            return false;
        }
    }
    false
}

enum Format {
    Srt,
    Vtt,
    Ass,
}

fn resolve_format(trimmed: &str, format_hint: Option<&str>) -> Format {
    if let Some(hint) = format_hint {
        match hint.trim().to_ascii_lowercase().as_str() {
            "srt" | "subrip" => return Format::Srt,
            "vtt" | "webvtt" => return Format::Vtt,
            "ass" | "ssa" => return Format::Ass,
            _ => {}
        }
    }
    if trimmed.starts_with("WEBVTT") {
        return Format::Vtt;
    }
    // `/^\[Script Info\]/i` — the TypeScript check is case-insensitive.
    if starts_with_ci(trimmed, SCRIPT_INFO_HEADER) {
        return Format::Ass;
    }
    Format::Srt
}

// ---------------------------------------------------------------------------
// SRT Parser
// ---------------------------------------------------------------------------

fn parse_srt(content: &str) -> SubtitleParseResult {
    let mut errors: Vec<SubtitleError> = Vec::new();
    let mut cues: Vec<SubtitleCue> = Vec::new();

    let lines = split_lines(content);
    let mut i = 0usize;

    while i < lines.len() {
        while i < lines.len() && js_trim(lines[i]).is_empty() {
            i += 1;
        }
        if i >= lines.len() {
            break;
        }

        let index_line = js_trim(lines[i]);
        if !is_ascii_digits(index_line) {
            errors.push(SubtitleError {
                line: i + 1,
                message: format!("Expected cue index, got: \"{index_line}\""),
            });
            i += 1;
            continue;
        }
        i += 1;

        if i >= lines.len() {
            errors.push(SubtitleError {
                line: i + 1,
                message: "Unexpected end of file, expected timing line".to_string(),
            });
            break;
        }

        let timing_line = lines[i];
        let Some(timing) = parse_timing_line(js_trim(timing_line), i + 1) else {
            // Defensive: blank lines are consumed before this point, but guard
            // against edge cases. Empty timing lines are normal in YouTube
            // subtitles (music/silence gaps); skip silently. Non-empty malformed
            // lines are real errors.
            if !js_trim(timing_line).is_empty() {
                errors.push(SubtitleError {
                    line: i + 1,
                    message: format!("Invalid timing line: \"{}\"", js_trim(timing_line)),
                });
            }
            i += 1;
            continue;
        };

        errors.extend(timing.errors);
        i += 1;

        let text = collect_cue_text(&lines, &mut i);
        if text.is_empty() {
            // Empty cue text (music/silence gaps in YouTube subtitles) — skip
            // silently instead of pushing a noisy warning.
            continue;
        }

        // Zero/negative-length cues (sync engine can clamp to 0 after a large
        // shift) are silently dropped — not errors, and not rendered.
        if timing.end <= timing.start {
            continue;
        }
        cues.push(SubtitleCue {
            id: cues.len(),
            start: timing.start,
            end: timing.end,
            text: strip_tags(&text),
        });
    }

    sort_by_start(&mut cues);
    let normalized = normalize_cues(cues);

    SubtitleParseResult {
        cues: normalized,
        errors,
        format: Some(FORMAT_SRT.to_string()),
    }
}

// ---------------------------------------------------------------------------
// VTT Parser
// ---------------------------------------------------------------------------

fn parse_vtt(content: &str) -> SubtitleParseResult {
    let mut errors: Vec<SubtitleError> = Vec::new();
    let mut cues: Vec<SubtitleCue> = Vec::new();
    let mut asr_flags: Vec<bool> = Vec::new();

    let cleaned = strip_vtt_headers(content);
    let lines = split_lines(&cleaned);

    let mut i = 0usize;

    while i < lines.len() {
        while i < lines.len() && js_trim(lines[i]).is_empty() {
            i += 1;
        }
        if i >= lines.len() {
            break;
        }

        let current_line = lines[i];

        if js_trim(current_line).eq_ignore_ascii_case("NOTE") {
            i += 1;
            while i < lines.len() && !js_trim(lines[i]).is_empty() {
                i += 1;
            }
            continue;
        }

        if js_trim(current_line).eq_ignore_ascii_case("STYLE") {
            i += 1;
            while i < lines.len() && !js_trim(lines[i]).is_empty() {
                i += 1;
            }
            continue;
        }

        let mut timing_line = current_line;

        if !current_line.contains("-->") {
            // A cue identifier line: the timing line is the next one.
            i += 1;
            // A cue identifier with NO following timing line: the file ends
            // before a timing line appears (YouTube VTT can end mid-cue).
            // This is a truncated tail, not a real error — skip silently.
            if i >= lines.len() {
                break;
            }
            timing_line = lines[i];
        }

        let Some(timing) = parse_timing_line(js_trim(timing_line), i + 1) else {
            if !js_trim(timing_line).is_empty() {
                errors.push(SubtitleError {
                    line: i + 1,
                    message: format!("Invalid timing line: \"{}\"", js_trim(timing_line)),
                });
            }
            i += 1;
            continue;
        };

        errors.extend(timing.errors);
        i += 1;

        let text = collect_cue_text(&lines, &mut i);
        if text.is_empty() {
            // Empty cue text (music/silence gaps in YouTube subtitles) — skip
            // silently instead of pushing a noisy warning.
            continue;
        }

        // Zero/negative-length cues are silently dropped (see SRT above).
        if timing.end <= timing.start {
            continue;
        }
        cues.push(SubtitleCue {
            id: cues.len(),
            start: timing.start,
            end: timing.end,
            text: strip_tags(&text),
        });
        asr_flags.push(timing.is_asr);
    }

    // --- YouTube ASR rolling-caption dedup (2026-08-21 live evidence) ---
    // ASR cues share the same sentence across 2-3 consecutive windows.
    // Deduplicate BEFORE sort+normalize so that same-start merging doesn't
    // accidentally re-join what we just collapsed.
    if asr_flags.iter().any(|flag| *flag) {
        let entries: Vec<(SubtitleCue, bool)> = cues.into_iter().zip(asr_flags).collect();
        cues = dedup_rolling_cues(entries);
    }

    sort_by_start(&mut cues);
    let normalized = normalize_cues(cues);

    SubtitleParseResult {
        cues: normalized,
        errors,
        format: Some(FORMAT_VTT.to_string()),
    }
}

// ---------------------------------------------------------------------------
// ASS Parser (P1.3a)
// ---------------------------------------------------------------------------

/// One `[Events]` dialogue, already reduced to the fields Entei needs.
struct AssDialogue {
    /// Start time in seconds (`NaN` when the field is missing or invalid).
    start: f64,
    /// End time in seconds (`NaN` when the field is missing or invalid).
    end: f64,
    /// Dialogue text with the override blocks removed.
    text: String,
    /// Set when the dialogue could not be mapped onto the `[Events]` field
    /// order. `ass-compiler` throws for such a dialogue, which aborts the
    /// whole file — the same happens here.
    unmappable: Option<String>,
}

fn parse_ass(content: &str) -> SubtitleParseResult {
    let mut errors: Vec<SubtitleError> = Vec::new();
    let mut events_format: Vec<String> = Vec::new();
    let mut dialogues: Vec<AssDialogue> = Vec::new();

    // Section scan — mirrors `ass-compiler`'s `parse()`:
    //  - `;` starts a comment line and is ignored;
    //  - a `[Section]` header switches the active section;
    //  - only `[Events]` carries the data Entei needs.
    let mut state = 0u8;
    for raw_line in split_lines(content) {
        let line = js_trim(raw_line);
        if line.starts_with(';') {
            continue;
        }

        if starts_with_ci(line, SCRIPT_INFO_HEADER) {
            state = 1;
        } else if starts_with_ci(line, "[V4+ Styles]") || starts_with_ci(line, "[V4 Styles]") {
            state = 2;
        } else if starts_with_ci(line, "[Events]") {
            state = 3;
        } else if line.starts_with('[') && line.contains(']') {
            state = 0;
        }

        if state != 3 {
            continue;
        }

        if is_ass_format_line(line) {
            events_format = parse_ass_format(line);
            continue;
        }
        if let Some((key, value)) = split_ass_event_line(line) {
            if key.eq_ignore_ascii_case("dialogue") {
                dialogues.push(parse_ass_dialogue(value, &events_format));
            }
            // `Comment:` events are not cues.
        }
    }

    // `compileDialogues` drops every dialogue whose end is not after its
    // start. `NaN` timings survive that filter (the comparison is false),
    // which is why an invalid timing is reported as an error below instead
    // of disappearing.
    #[allow(clippy::neg_cmp_op_on_partial_ord)]
    let mut compiled: Vec<AssDialogue> = dialogues
        .into_iter()
        .filter(|dialogue| !(dialogue.start >= dialogue.end))
        .collect();

    // `ass-compiler` throws while compiling a dialogue that has no `Text`
    // field — the whole file then fails to compile and no cue is produced.
    if let Some(failed) = compiled.iter().find(|dialogue| dialogue.unmappable.is_some()) {
        errors.push(SubtitleError {
            line: 0,
            message: format!(
                "ASS compiler error: {}",
                failed.unmappable.as_deref().unwrap_or("invalid dialogue")
            ),
        });
        return SubtitleParseResult {
            cues: Vec::new(),
            errors,
            format: Some(FORMAT_ASS.to_string()),
        };
    }

    // Sort by start, then by end — a stable sort, like the npm package.
    compiled.sort_by(|a, b| match a.start.partial_cmp(&b.start) {
        Some(std::cmp::Ordering::Equal) | None => {
            a.end.partial_cmp(&b.end).unwrap_or(std::cmp::Ordering::Equal)
        }
        Some(ordering) => ordering,
    });

    if compiled.is_empty() {
        errors.push(SubtitleError {
            line: 0,
            message: "No dialogue events found in ASS file".to_string(),
        });
        return SubtitleParseResult {
            cues: Vec::new(),
            errors,
            format: Some(FORMAT_ASS.to_string()),
        };
    }

    let mut cues: Vec<SubtitleCue> = Vec::new();
    for (index, dialogue) in compiled.iter().enumerate() {
        if dialogue.start.is_nan() || dialogue.end.is_nan() {
            errors.push(SubtitleError {
                line: 0,
                message: format!(
                    "Dialogue #{}: invalid timing (start={}, end={})",
                    index + 1,
                    js_number_to_string(dialogue.start),
                    js_number_to_string(dialogue.end)
                ),
            });
            continue;
        }

        // Strip ASS override tags and normalize linebreaks.
        let mut text = strip_ass_tags_and_linebreaks(&dialogue.text);
        // Apply shared whitespace normalization.
        text = strip_tags(&text);

        if text.is_empty() {
            // Empty dialogue text (music/silence gaps) — skip silently.
            continue;
        }

        // Zero/negative-length cues are silently dropped (see SRT above).
        if dialogue.end <= dialogue.start {
            continue;
        }
        cues.push(SubtitleCue {
            id: cues.len(),
            start: dialogue.start,
            end: dialogue.end,
            text,
        });
    }

    sort_by_start(&mut cues);
    let normalized = normalize_cues(cues);

    SubtitleParseResult {
        cues: normalized,
        errors,
        format: Some(FORMAT_ASS.to_string()),
    }
}

/// `Format:` line inside the `[Events]` section.
fn is_ass_format_line(line: &str) -> bool {
    if !line.to_ascii_lowercase().starts_with("format") {
        return false;
    }
    line[6..].trim_start().starts_with(':')
}

/// Parse the `Format:` line into the field order used by the dialogues.
fn parse_ass_format(line: &str) -> Vec<String> {
    let bytes = line.as_bytes();
    let mut index = 6usize; // "Format"
    while index < bytes.len() && js_whitespace(bytes[index] as char) {
        index += 1;
    }
    if index >= bytes.len() || bytes[index] != b':' {
        return Vec::new();
    }
    index += 1;
    while index < bytes.len() && js_whitespace(bytes[index] as char) {
        index += 1;
    }
    split_csv(&line[index..])
}

/// Split a `Dialogue:` / `Comment:` line into its key and value.
///
/// Mirrors `/^(\w+?)\s*:\s*(.*)/i`: the key is the leading word characters,
/// followed by optional whitespace, a colon and optional whitespace.
fn split_ass_event_line(line: &str) -> Option<(String, &str)> {
    let colon = line.find(':')?;
    let head = &line[..colon];
    let key_len = head
        .find(|c: char| !is_word_char(c))
        .unwrap_or(head.len());
    let key = &head[..key_len];
    if key.is_empty() {
        return None;
    }
    if !head[key_len..].chars().all(js_whitespace) {
        return None;
    }
    Some((key.to_string(), line[colon + 1..].trim_start()))
}

/// Parse one `Dialogue:` value against the `[Events]` field order.
fn parse_ass_dialogue(value: &str, format: &[String]) -> AssDialogue {
    // The fields are kept as slices of `value` — only their byte offsets are
    // tracked, so splitting a dialogue line allocates nothing.
    let mut fields: Vec<(&str, usize)> = Vec::with_capacity(format.len().max(4));
    let mut offset = 0usize;
    for part in value.split(',') {
        fields.push((part, offset));
        offset += part.len() + 1;
    }

    // The text field is the last one and may contain commas: everything from
    // the last format slot onwards belongs to it.
    let merged = !format.is_empty() && fields.len() > format.len();
    let tail_start = if merged { fields[format.len() - 1].1 } else { 0 };
    let mapped = if format.is_empty() {
        0
    } else if merged {
        format.len()
    } else {
        fields.len().min(format.len())
    };

    let mut start = f64::NAN;
    let mut end = f64::NAN;
    let mut text = String::new();
    let mut has_text = false;

    for index in 0..mapped {
        let key = format[index].as_str();
        let raw = if merged && index == format.len() - 1 {
            &value[tail_start..]
        } else {
            fields[index].0
        };
        let field = js_trim(raw);
        match key {
            "Start" => start = parse_ass_time(field),
            "End" => end = parse_ass_time(field),
            "Text" => {
                text = extract_ass_text(field);
                has_text = true;
            }
            _ => {}
        }
    }

    // The `Text` column of the `[Events]` `Format:` line is what carries the
    // dialogue body. Without it there is nothing to render, and the npm
    // package aborts the whole file.
    let unmappable = if !has_text {
        Some(if format.is_empty() {
            "the [Events] section has no Format: line".to_string()
        } else if !format.iter().any(|key| key == "Text") {
            "the [Events] Format: line has no Text field".to_string()
        } else {
            "a dialogue has fewer fields than the [Events] Format: line".to_string()
        })
    } else {
        None
    };

    AssDialogue {
        start,
        end,
        text,
        unmappable,
    }
}

/// Parse an ASS timestamp (`h:mm:ss.cc`).
///
/// Mirrors `ass-compiler`'s `parseTime`: the parts are multiplied, so a
/// missing or malformed part yields `NaN` instead of an error.
fn parse_ass_time(time: &str) -> f64 {
    let parts: Vec<&str> = time.split(':').collect();
    let hours = js_number(parts.first().copied().unwrap_or(""));
    let minutes = js_number(parts.get(1).copied().unwrap_or(""));
    let seconds = js_number(parts.get(2).copied().unwrap_or(""));
    if parts.len() < 3 {
        // A missing part makes the whole timestamp NaN, like `undefined * 60`.
        return f64::NAN;
    }
    hours * 3600.0 + minutes * 60.0 + seconds
}

/// Extract the visible text of an ASS dialogue.
///
/// Mirrors `ass-compiler`'s `parseText` + the Entei TypeScript pipeline:
/// `{...}` override blocks are removed, and a drawing block (`{\p1}…{\p0}`)
/// contributes no text at all.
fn extract_ass_text(text: &str) -> String {
    let bytes = text.as_bytes();
    let mut out = String::with_capacity(text.len());
    let mut index = 0usize;
    let mut segment_start = 0usize;
    // The segment that follows the next override block is included unless
    // that block turns the text into a drawing.
    let mut include_next = true;

    while index < bytes.len() {
        if bytes[index] == b'{' {
            let mut cursor = index + 1;
            let mut closed = false;
            while cursor < bytes.len() {
                if bytes[cursor] == b'}' {
                    closed = true;
                    break;
                }
                if bytes[cursor] == b'{' {
                    break;
                }
                cursor += 1;
            }
            if closed {
                if include_next && index > segment_start {
                    out.push_str(&text[segment_start..index]);
                }
                include_next = !ass_tags_are_drawing(&text[index + 1..cursor]);
                index = cursor + 1;
                segment_start = index;
                continue;
            }
        }
        index += 1;
    }

    if include_next && segment_start < text.len() {
        out.push_str(&text[segment_start..]);
    }
    out
}

/// Split an override block into its tags and report whether it turns the
/// following text into a drawing.
///
/// Mirrors `parseTags` + the `isDrawing` reduce of `ass-compiler`: the tags
/// are separated by backslashes outside of parentheses, and the last tag that
/// carries a `p` value decides.
fn ass_tags_are_drawing(block: &str) -> bool {
    let mut drawing = false;
    for tag in parse_ass_tags(block) {
        if let Some(value) = ass_tag_p_value(&tag) {
            drawing = value != 0.0 && !value.is_nan();
        }
    }
    drawing
}

/// Split an override block into its individual tags.
fn parse_ass_tags(block: &str) -> Vec<String> {
    let mut tags: Vec<String> = Vec::new();
    let mut depth = 0i32;
    let mut current = String::new();

    for ch in block.chars() {
        match ch {
            '(' => {
                depth += 1;
                current.push(ch);
            }
            ')' => {
                depth -= 1;
                if depth < 0 {
                    depth = 0;
                }
                current.push(ch);
            }
            '\\' if depth == 0 => {
                if !current.is_empty() {
                    tags.push(std::mem::take(&mut current));
                } else {
                    current.clear();
                }
            }
            _ => current.push(ch),
        }
    }
    tags.push(current);
    tags
}

/// Read the `p` (drawing scale) value of an override tag, if it has one.
///
/// `ass-compiler` parses `\p1` / `\p0` through its numeric tag table, where
/// the value is the remainder of the tag text.
fn ass_tag_p_value(tag: &str) -> Option<f64> {
    let rest = tag.strip_prefix('p')?;
    let digits = rest.strip_prefix('-').unwrap_or(rest);
    if !digits.starts_with(|c: char| c.is_ascii_digit()) {
        return None;
    }
    Some(js_number(rest))
}

/// Strip ASS override tags (`{\...}`) and normalize the `\N` / `\n`
/// linebreaks to spaces.
///
/// Mirrors the TypeScript pipeline `stripASSTags` → `normalizeASSLinebreaks`
/// — the override span is removed first, so a `\N` inside a tag disappears
/// with it — but both steps run in a single pass.
fn strip_ass_tags_and_linebreaks(text: &str) -> String {
    let bytes = text.as_bytes();
    let mut out = String::with_capacity(text.len());
    let mut index = 0usize;

    while index < bytes.len() {
        if bytes[index] == b'{' {
            if let Some(close) = text[index + 1..].find('}').map(|position| position + index + 1) {
                index = close + 1;
                continue;
            }
        }
        if bytes[index] == b'\\' && index + 1 < bytes.len() {
            let next = bytes[index + 1];
            if next == b'N' || next == b'n' {
                out.push(' ');
                index += 2;
                continue;
            }
        }
        let ch = text[index..].chars().next().unwrap_or('\u{0}');
        out.push(ch);
        index += ch.len_utf8();
    }
    out
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

struct TimingResult {
    start: f64,
    end: f64,
    errors: Vec<SubtitleError>,
    /// True when the raw timing line contained `align:start position`
    /// (YouTube ASR).
    is_asr: bool,
}

/// Parse a timing line.
///
/// Returns `None` when the line is not a timing line at all. A timing line
/// whose timestamp is out of range (minutes ≥ 60, …) is still a timing line:
/// it reports an error and yields a zero-length cue, which the caller drops.
fn parse_timing_line(line: &str, line_number: usize) -> Option<TimingResult> {
    let (start_str, consumed) = scan_timestamp(line)?;
    let rest = &line[consumed..];
    let rest = rest.trim_start_matches(js_whitespace);
    let rest = rest.strip_prefix("-->")?;
    let rest = rest.trim_start_matches(js_whitespace);
    let (end_str, _) = scan_timestamp(rest)?;

    let mut errors: Vec<SubtitleError> = Vec::new();
    let start = parse_timestamp(start_str);
    let end = parse_timestamp(end_str);

    if start.is_none() {
        errors.push(SubtitleError {
            line: line_number,
            message: format!("Invalid start timestamp: \"{start_str}\""),
        });
    }
    if end.is_none() {
        errors.push(SubtitleError {
            line: line_number,
            message: format!("Invalid end timestamp: \"{end_str}\""),
        });
    }

    let (start, end) = match (start, end) {
        (Some(start), Some(end)) => (start, end),
        _ => {
            return Some(TimingResult {
                start: start.unwrap_or(0.0),
                end: end.unwrap_or(0.0),
                errors,
                is_asr: false,
            })
        }
    };

    // YouTube ASR subtitles include `align:start position:` in timing lines.
    let is_asr = line.contains("align:start position");

    Some(TimingResult {
        start,
        end,
        errors,
        is_asr,
    })
}

/// Scan `hh:mm:ss,mmm` (also `.` or `:` as the fraction separator) at the
/// beginning of `text`.
///
/// Mirrors `/^(\d{1,2}:\d{2}:\d{2}[,.:]\d{3})/`.
fn scan_timestamp(text: &str) -> Option<(&str, usize)> {
    let bytes = text.as_bytes();
    let mut index = 0usize;

    // Hours: one or two digits, greedy.
    let hours_start = index;
    while index < bytes.len() && index - hours_start < 2 && bytes[index].is_ascii_digit() {
        index += 1;
    }
    if index == hours_start {
        return None;
    }
    if index >= bytes.len() || bytes[index] != b':' {
        return None;
    }
    index += 1;

    // Minutes: exactly two digits.
    if index + 2 > bytes.len()
        || !bytes[index].is_ascii_digit()
        || !bytes[index + 1].is_ascii_digit()
    {
        return None;
    }
    index += 2;
    if index >= bytes.len() || bytes[index] != b':' {
        return None;
    }
    index += 1;

    // Seconds: exactly two digits.
    if index + 2 > bytes.len()
        || !bytes[index].is_ascii_digit()
        || !bytes[index + 1].is_ascii_digit()
    {
        return None;
    }
    index += 2;

    // Fraction separator.
    if index >= bytes.len() {
        return None;
    }
    let separator = bytes[index];
    if separator != b',' && separator != b'.' && separator != b':' {
        return None;
    }
    index += 1;

    // Milliseconds: exactly three digits.
    if index + 3 > bytes.len()
        || !bytes[index].is_ascii_digit()
        || !bytes[index + 1].is_ascii_digit()
        || !bytes[index + 2].is_ascii_digit()
    {
        return None;
    }
    index += 3;

    Some((&text[..index], index))
}

/// Convert a timestamp string to seconds.
///
/// Mirrors the TypeScript helper: the first comma and the first colon are
/// replaced by dots and the result is split on `:` and `.` — four parts are
/// required. The timestamp always has the `h:mm:ss<sep>mmm` shape (the
/// separator is `,`, `.` or `:`), so the four fields are read directly
/// instead of rebuilding the string.
fn parse_timestamp(timestamp: &str) -> Option<f64> {
    let first_colon = timestamp.find(':')?;
    let hours = js_number(&timestamp[..first_colon]);
    let after_hours = &timestamp[first_colon + 1..];
    let second_colon = after_hours.find(':')?;
    let minutes = js_number(&after_hours[..second_colon]);
    let after_minutes = &after_hours[second_colon + 1..];

    // `ss` + separator + `mmm`.
    let seconds = js_number(after_minutes.get(..2)?);
    let milliseconds = js_number(after_minutes.get(after_minutes.len().checked_sub(3)?..)?);

    if hours.is_nan() || minutes.is_nan() || seconds.is_nan() || milliseconds.is_nan() {
        return None;
    }

    if minutes >= 60.0 || seconds >= 60.0 || milliseconds >= 1000.0 {
        return None;
    }

    Some(hours * 3600.0 + minutes * 60.0 + seconds + milliseconds / 1000.0)
}

/// Match one of the non-breaking space entities at `index`.
///
/// Returns the number of bytes consumed when an entity matched.
fn match_nbsp_entity(text: &str, index: usize) -> Option<usize> {
    if let Some(rest) = text.get(index..index + 6) {
        if rest.eq_ignore_ascii_case("&nbsp;") {
            return Some(6);
        }
        if rest == "&#160;" {
            return Some(6);
        }
        if rest.eq_ignore_ascii_case("&#xa0;") {
            return Some(6);
        }
    }
    None
}

/// Match the tail of a `<br …>` tag, starting right after `<br`.
///
/// Returns the index just after the closing `>`.
fn match_br_tag(text: &str, after_br: usize) -> Option<usize> {
    let bytes = text.as_bytes();
    let mut whitespace_end = after_br;
    while whitespace_end < bytes.len() && js_whitespace(bytes[whitespace_end] as char) {
        whitespace_end += 1;
    }

    // The JavaScript regex is greedy: the longest whitespace run is tried
    // first, and `/` is optional after it.
    let mut candidates = vec![whitespace_end];
    let mut cursor = whitespace_end;
    while cursor > after_br {
        cursor -= 1;
        candidates.push(cursor);
    }

    for candidate in candidates {
        if candidate < bytes.len()
            && bytes[candidate] == b'/'
            && candidate + 1 < bytes.len()
            && bytes[candidate + 1] == b'>'
        {
            return Some(candidate + 2);
        }
        if candidate < bytes.len() && bytes[candidate] == b'>' {
            return Some(candidate + 1);
        }
    }
    None
}

/// Strip HTML/VTT tags and normalize whitespace.
///
/// Used for both SRT and VTT. `&nbsp;` entities are decoded first
/// (non-breaking space → regular space) to prevent literal "&nbsp;" text
/// from reaching the display layer. Literal `<br>`, `<br/>`, `<br />` are
/// normalized to a single space BEFORE generic tag stripping, preventing
/// words from gluing together.
///
/// The four TypeScript passes (decode entities → normalize `<br>` → strip
/// `<…>` spans → collapse whitespace) are fused into one pass here: the
/// order is preserved, but the intermediate strings are gone, which matters
/// for a 3 000-cue file.
fn strip_tags(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let bytes = text.as_bytes();
    let mut index = 0usize;
    // A collapsed whitespace run is pending: it is only written once the
    // next non-whitespace character arrives.
    let mut pending_space = false;

    while index < bytes.len() {
        // 1. Non-breaking space entities → a space.
        if bytes[index] == b'&' {
            if let Some(consumed) = match_nbsp_entity(text, index) {
                push_space(&mut out, &mut pending_space);
                index += consumed;
                continue;
            }
        }

        if bytes[index] == b'<' {
            // 2. `<br>`, `<br/>` and `<br />` → a space.
            let is_br = text
                .get(index..index + 3)
                .map(|head| head.eq_ignore_ascii_case("<br"))
                .unwrap_or(false);
            if is_br {
                if let Some(end) = match_br_tag(text, index + 3) {
                    push_space(&mut out, &mut pending_space);
                    index = end;
                    continue;
                }
            }
            // 3. Every other `<…>` span is removed.
            if let Some(close) = text[index + 1..].find('>').map(|position| position + index + 1) {
                index = close + 1;
                continue;
            }
        }

        let ch = text[index..].chars().next().unwrap_or('\u{0}');
        if js_whitespace(ch) {
            push_space(&mut out, &mut pending_space);
        } else {
            pending_space = false;
            out.push(ch);
        }
        index += ch.len_utf8();
    }

    // The trailing whitespace run is trimmed (`String.prototype.trim`).
    if pending_space {
        out.pop();
    }
    out
}

/// Write a collapsed whitespace run.
fn push_space(out: &mut String, pending_space: &mut bool) {
    if *pending_space {
        return;
    }
    *pending_space = true;
    if !out.is_empty() {
        out.push(' ');
    }
}

/// Collapse every whitespace run into a single space and trim the result.
fn collapse_whitespace(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut in_whitespace = false;
    for ch in text.chars() {
        if js_whitespace(ch) {
            if !in_whitespace {
                out.push(' ');
                in_whitespace = true;
            }
        } else {
            out.push(ch);
            in_whitespace = false;
        }
    }
    js_trim(&out).to_string()
}

/// Merge adjacent cues sharing the exact same start time into a single cue.
///
/// - Preserves source order for equal-start inputs (no sort-by-end).
/// - Joins nonempty text with a single space.
/// - Ends at max(end) of the group.
/// - Reindexes IDs after merge.
/// - Does NOT merge cues with different start times.
fn normalize_cues(cues: Vec<SubtitleCue>) -> Vec<SubtitleCue> {
    if cues.is_empty() {
        return Vec::new();
    }

    let mut merged: Vec<SubtitleCue> = Vec::new();
    let mut iter = cues.into_iter();
    let first = iter.next().expect("at least one cue");
    let mut group_start = first.start;
    let mut group_end = first.end;
    let mut group_texts: Vec<String> = Vec::new();
    if !first.text.is_empty() {
        group_texts.push(first.text);
    }

    for current in iter {
        if current.start == group_start {
            // Same start time — merge into current group.
            group_end = group_end.max(current.end);
            if !current.text.is_empty() {
                group_texts.push(current.text);
            }
        } else {
            // Different start — flush previous group.
            merged.push(SubtitleCue {
                id: merged.len(),
                start: group_start,
                end: group_end,
                text: join_group_texts(&mut group_texts),
            });
            group_start = current.start;
            group_end = current.end;
            group_texts.clear();
            if !current.text.is_empty() {
                group_texts.push(current.text);
            }
        }
    }

    // Flush last group.
    merged.push(SubtitleCue {
        id: merged.len(),
        start: group_start,
        end: group_end,
        text: join_group_texts(&mut group_texts),
    });

    merged
}

/// Join the texts of a merge group with a single space.
fn join_group_texts(group_texts: &mut Vec<String>) -> String {
    if group_texts.len() == 1 {
        return group_texts.pop().expect("one text");
    }
    group_texts.join(" ")
}

// ---------------------------------------------------------------------------
// YouTube ASR rolling-caption dedup
// ---------------------------------------------------------------------------

/// Remove duplicate cues produced by YouTube auto-generated subtitles (ASR).
///
/// YouTube ASR uses rolling windows: the same sentence appears in 2-3
/// consecutive cues with slightly shifted times and progressively more
/// complete text.
///
/// Non-ASR subtitles (torrent SRT/VTT/ASS) are passed through unchanged.
fn dedup_rolling_cues(entries: Vec<(SubtitleCue, bool)>) -> Vec<SubtitleCue> {
    let mut result: Vec<SubtitleCue> = Vec::new();
    let mut prev: Option<SubtitleCue> = None;

    for (cue, is_asr) in entries {
        // Non-ASR cues pass through completely unchanged.
        if !is_asr {
            if let Some(previous) = prev.take() {
                result.push(SubtitleCue {
                    id: result.len(),
                    ..previous
                });
            }
            result.push(SubtitleCue {
                id: result.len(),
                ..cue
            });
            continue;
        }

        // ASR cue — compare with previous.
        let Some(mut previous) = prev.take() else {
            prev = Some(cue);
            continue;
        };

        let prev_norm = collapse_whitespace(&previous.text);
        let cur_norm = collapse_whitespace(&cue.text);

        // Rule 1: whitespace-only or empty text → drop current.
        if cur_norm.is_empty() {
            prev = Some(previous);
            continue;
        }

        // Rule 2: same text after normalization → keep the longer time span.
        if prev_norm == cur_norm {
            previous.end = previous.end.max(cue.end);
            prev = Some(previous);
            continue;
        }

        // Rule 3: current is a prefix-extension of previous (ASR mid-word split)
        // — only when overlapping/adjacent (0.5 s tolerance).
        if cur_norm.starts_with(&prev_norm) && cue.start <= previous.end + 0.5 {
            previous.text = cue.text.clone();
            previous.end = previous.end.max(cue.end);
            prev = Some(previous);
            continue;
        }

        // Rule 3': previous is a prefix-extension of current (rolling window
        // drops leading words) — keep prev, extend end. Same 0.5 s guard.
        if prev_norm.ends_with(&cur_norm) && cue.start <= previous.end + 0.5 {
            previous.end = previous.end.max(cue.end);
            prev = Some(previous);
            continue;
        }

        // Rule 4: different text → flush previous, keep current as new prev.
        result.push(SubtitleCue {
            id: result.len(),
            ..previous
        });
        prev = Some(cue);
    }

    // Flush last pending cue.
    if let Some(previous) = prev.take() {
        result.push(SubtitleCue {
            id: result.len(),
            ..previous
        });
    }

    result
}

/// Strip the VTT file header.
fn strip_vtt_headers(content: &str) -> String {
    let lines: Vec<&str> = content.split('\n').collect();
    let mut result: Vec<&str> = Vec::new();
    let mut index = 0usize;

    if let Some(first_line) = lines.first() {
        if js_trim(first_line).starts_with("WEBVTT") {
            index = 1;
            while index < lines.len() && !js_trim(lines[index]).is_empty() {
                index += 1;
            }
            if index < lines.len() && js_trim(lines[index]).is_empty() {
                index += 1;
            }
        }
    }

    while index < lines.len() {
        result.push(lines[index]);
        index += 1;
    }

    result.join("\n")
}

// ---------------------------------------------------------------------------
// Low level helpers
// ---------------------------------------------------------------------------

/// Split `content` into lines, treating CRLF, LF and a lone CR as line
/// breaks.
///
/// Mirrors `content.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n')`.
fn split_lines(content: &str) -> Vec<&str> {
    let bytes = content.as_bytes();
    let mut lines: Vec<&str> = Vec::new();
    let mut start = 0usize;
    let mut index = 0usize;

    while index < bytes.len() {
        match bytes[index] {
            b'\n' => {
                lines.push(&content[start..index]);
                index += 1;
                start = index;
            }
            b'\r' => {
                lines.push(&content[start..index]);
                index += 1;
                // A CRLF pair is a single line break.
                if index < bytes.len() && bytes[index] == b'\n' {
                    index += 1;
                }
                start = index;
            }
            _ => index += 1,
        }
    }
    lines.push(&content[start..]);
    lines
}

/// Collect the text lines of a cue, advancing `index` past them.
fn collect_cue_text(lines: &[&str], index: &mut usize) -> String {
    let mut text = String::new();
    while *index < lines.len() && !js_trim(lines[*index]).is_empty() {
        if !text.is_empty() {
            text.push('\n');
        }
        text.push_str(lines[*index]);
        *index += 1;
    }
    // Trim in place, the way `textLines.join('\n').trim()` does.
    let leading = text.len() - text.trim_start_matches(js_whitespace).len();
    if leading > 0 {
        text.drain(..leading);
    }
    let trailing = text.trim_end_matches(js_whitespace).len();
    text.truncate(trailing);
    text
}

/// Sort cues by start time (stable).
fn sort_by_start(cues: &mut [SubtitleCue]) {
    cues.sort_by(|a, b| {
        a.start
            .partial_cmp(&b.start)
            .unwrap_or(std::cmp::Ordering::Equal)
    });
}

/// Split a comma separated list, trimming the whitespace around each comma.
///
/// Mirrors `split(/\s*,\s*/)`: the whitespace before a comma and after it is
/// consumed, but leading whitespace of the first entry and trailing
/// whitespace of the last entry are kept.
fn split_csv(value: &str) -> Vec<String> {
    let raw: Vec<&str> = value.split(',').collect();
    raw.iter()
        .enumerate()
        .map(|(index, part)| {
            let mut part = *part;
            if index > 0 {
                part = part.trim_start();
            }
            if index + 1 < raw.len() {
                part = part.trim_end();
            }
            part.to_string()
        })
        .collect()
}

/// `String.prototype.startsWith`, case-insensitive.
///
/// The prefix is compared byte-wise, like the JavaScript original, but the
/// slice is taken with `str::get`: a multi-byte character at the start of
/// the text would otherwise slice the string in the middle of a character
/// and panic.
fn starts_with_ci(text: &str, prefix: &str) -> bool {
    text.get(..prefix.len())
        .is_some_and(|head| head.eq_ignore_ascii_case(prefix))
}

/// JavaScript `Number(text)` semantics for the inputs used here.
fn js_number(text: &str) -> f64 {
    let trimmed = js_trim(text);
    if trimmed.is_empty() {
        return 0.0;
    }
    trimmed.parse::<f64>().unwrap_or(f64::NAN)
}

/// JavaScript `String(number)` semantics for the error messages.
fn js_number_to_string(value: f64) -> String {
    if value.is_nan() {
        return "NaN".to_string();
    }
    if value.is_infinite() {
        return if value > 0.0 { "Infinity" } else { "-Infinity" }.to_string();
    }
    if value == value.trunc() && value.abs() < 1e21 {
        return format!("{}", value as i64);
    }
    format!("{value}")
}

/// JavaScript's `String.prototype.trim` character set.
///
/// JavaScript treats U+FEFF (the byte order mark) as whitespace; Rust's
/// `char::is_whitespace` does not, because U+FEFF is a format character in
/// Unicode. Subtitle files exported on Windows regularly carry a BOM, so the
/// difference is not academic.
fn js_whitespace(ch: char) -> bool {
    ch.is_whitespace() || ch == '\u{FEFF}'
}

/// `String.prototype.trim`.
fn js_trim(text: &str) -> &str {
    text.trim_matches(js_whitespace)
}

/// JavaScript `Number.isFinite` / `isNaN` helpers.
fn is_ascii_digits(text: &str) -> bool {
    !text.is_empty() && text.bytes().all(|byte| byte.is_ascii_digit())
}

/// JavaScript `\w` (`[A-Za-z0-9_]`).
fn is_word_char(ch: char) -> bool {
    ch.is_ascii_alphanumeric() || ch == '_'
}
