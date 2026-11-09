//! Subtitle parser tests.
//!
//! Ported one-to-one from the TypeScript suite that guarded the browser
//! implementation: `apps/web/tests/subtitle-reader.test.ts`. Every
//! expectation below is the same one the TypeScript test asserts, so the two
//! implementations are proven to behave identically.

use tauri_plugin_subtitles::{detect_format, parse_subtitles, SubtitleParseResult};

const ASS_HEADER: &str = concat!(
    "[Script Info]\n",
    "Title: Test\n",
    "ScriptType: v4.00+\n",
    "PlayResX: 1920\n",
    "PlayResY: 1080\n",
    "\n",
    "[V4+ Styles]\n",
    "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, \
BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, \
Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\n",
    "Style: Default,Arial,48,&H00FFFFFF,&H000000FF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,\
1,2,2,2,10,10,10,1\n",
    "\n",
    "[Events]\n",
    "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n",
);

fn parse(content: &str) -> SubtitleParseResult {
    parse_subtitles(content, None)
}

// ---------------------------------------------------------------------------
// SRT Parsing
// ---------------------------------------------------------------------------

#[test]
fn parses_a_valid_srt_file_with_multiple_cues() {
    let srt = "1\n00:00:01,000 --> 00:00:04,000\nHello world\n\n2\n00:00:05,000 --> 00:00:08,000\nSecond cue\n\n3\n00:00:09,500 --> 00:00:12,000\nThird cue";

    let result = parse(srt);
    assert_eq!(result.format.as_deref(), Some("srt"));
    assert_eq!(result.cues.len(), 3);
    assert_eq!(result.errors.len(), 0);

    assert_eq!(result.cues[0].id, 0);
    assert_eq!(result.cues[0].start, 1.0);
    assert_eq!(result.cues[0].end, 4.0);
    assert_eq!(result.cues[0].text, "Hello world");
    assert_eq!(result.cues[1].id, 1);
    assert_eq!(result.cues[1].start, 5.0);
    assert_eq!(result.cues[1].end, 8.0);
    assert_eq!(result.cues[1].text, "Second cue");
    assert_eq!(result.cues[2].id, 2);
    assert_eq!(result.cues[2].start, 9.5);
    assert_eq!(result.cues[2].end, 12.0);
    assert_eq!(result.cues[2].text, "Third cue");
}

#[test]
fn handles_crlf_line_endings() {
    let srt = "1\r\n00:00:01,000 --> 00:00:04,000\r\nHello\r\n\r\n2\r\n00:00:05,000 --> 00:00:08,000\r\nWorld";
    let result = parse(srt);
    assert_eq!(result.cues.len(), 2);
    assert_eq!(result.cues[0].text, "Hello");
    assert_eq!(result.cues[1].text, "World");
}

#[test]
fn sorts_cues_by_start_time() {
    let srt = "2\n00:00:05,000 --> 00:00:08,000\nSecond\n\n1\n00:00:01,000 --> 00:00:04,000\nFirst";

    let result = parse(srt);
    assert_eq!(result.cues.len(), 2);
    assert_eq!(result.cues[0].text, "First");
    assert_eq!(result.cues[1].text, "Second");
    // IDs reassigned after sort.
    assert_eq!(result.cues[0].id, 0);
    assert_eq!(result.cues[1].id, 1);
}

#[test]
fn strips_html_tags_from_srt_text() {
    let srt = "1\n00:00:01,000 --> 00:00:04,000\n<b>Bold</b> and <i>italic</i> text";

    let result = parse(srt);
    assert_eq!(result.cues[0].text, "Bold and italic text");
}

#[test]
fn reports_error_for_invalid_timing_line() {
    let srt = "1\ninvalid timing\nHello";

    let result = parse(srt);
    assert_eq!(result.cues.len(), 0);
    assert!(!result.errors.is_empty());
    assert!(result.errors[0].message.contains("Invalid timing"));
}

#[test]
fn silently_drops_a_zero_or_negative_length_srt_cue() {
    let srt = "1\n00:00:05,000 --> 00:00:01,000\nEnd before start";

    let result = parse(srt);
    assert_eq!(result.errors.len(), 0);
    assert_eq!(result.cues.len(), 0);
}

#[test]
fn silently_drops_a_zero_or_negative_length_vtt_cue() {
    let vtt = "WEBVTT\n\n00:00:00.000 --> 00:00:00.000\nZero cue\n\n00:00:02.000 --> 00:00:04.000\nValid cue\n";
    let result = parse(vtt);
    assert_eq!(result.errors.len(), 0);
    assert_eq!(result.cues.len(), 1);
    assert!(result.cues[0].text.contains("Valid cue"));
}

#[test]
fn vtt_with_only_zero_length_cues_yields_no_errors() {
    let vtt = "WEBVTT\n\n00:00:01.000 --> 00:00:00.000\nBackwards cue\n";
    let result = parse(vtt);
    assert_eq!(result.errors.len(), 0);
    assert_eq!(result.cues.len(), 0);
}

#[test]
fn silently_drops_a_zero_length_ass_cue() {
    let ass = format!(
        "{ASS_HEADER}Dialogue: 0,0:00:00.00,0:00:00.00,Default,,0,0,0,,Zero cue\nDialogue: 0,0:00:02.00,0:00:04.00,Default,,0,0,0,,Valid cue\n"
    );
    let result = parse(&ass);
    assert_eq!(result.errors.len(), 0);
    assert_eq!(result.cues.len(), 1);
    assert!(result.cues[0].text.contains("Valid cue"));
}

#[test]
fn skips_empty_cue_text_without_errors() {
    let srt = "1\n00:00:01,000 --> 00:00:04,000\n\n2\n00:00:05,000 --> 00:00:08,000\nValid";

    let result = parse(srt);
    assert_eq!(result.cues.len(), 1);
    assert_eq!(result.cues[0].text, "Valid");
    assert_eq!(result.errors.len(), 0);
}

#[test]
fn handles_milliseconds_with_dot_separator() {
    let srt = "1\n00:00:01.500 --> 00:00:04.200\nDot separator";

    let result = parse(srt);
    assert_eq!(result.cues[0].start, 1.5);
    assert_eq!(result.cues[0].end, 4.2);
}

// ---------------------------------------------------------------------------
// VTT Parsing
// ---------------------------------------------------------------------------

#[test]
fn parses_a_valid_vtt_file() {
    let vtt = "WEBVTT\n\n00:00:01.000 --> 00:00:04.000\nHello world\n\n00:00:05.000 --> 00:00:08.000\nSecond cue";

    let result = parse(vtt);
    assert_eq!(result.format.as_deref(), Some("vtt"));
    assert_eq!(result.cues.len(), 2);
    assert_eq!(result.errors.len(), 0);
    assert_eq!(result.cues[0].start, 1.0);
    assert_eq!(result.cues[0].end, 4.0);
    assert_eq!(result.cues[0].text, "Hello world");
}

#[test]
fn strips_vtt_header_and_note_blocks() {
    let vtt = "WEBVTT\nKind: captions\nLanguage: en\n\nNOTE\nThis is a comment\n\n00:00:01.000 --> 00:00:04.000\nAfter notes";

    let result = parse(vtt);
    assert_eq!(result.cues.len(), 1);
    assert_eq!(result.cues[0].text, "After notes");
}

#[test]
fn strips_style_blocks() {
    let vtt = "WEBVTT\n\nSTYLE\n::cue { color: white; }\n\n00:00:01.000 --> 00:00:04.000\nStyled cue";

    let result = parse(vtt);
    assert_eq!(result.cues.len(), 1);
    assert_eq!(result.cues[0].text, "Styled cue");
}

#[test]
fn handles_cue_identifiers() {
    let vtt = "WEBVTT\n\ncue-1\n00:00:01.000 --> 00:00:04.000\nFirst cue\n\ncue-2\n00:00:05.000 --> 00:00:08.000\nSecond cue";

    let result = parse(vtt);
    assert_eq!(result.cues.len(), 2);
    assert_eq!(result.cues[0].text, "First cue");
    assert_eq!(result.cues[1].text, "Second cue");
}

#[test]
fn skips_a_trailing_cue_identifier_without_timing_line_silently() {
    let vtt = "WEBVTT\n\n00:00:01.000 --> 00:00:04.000\nValid cue\n\n1788";

    let result = parse(vtt);
    assert_eq!(result.cues.len(), 1);
    assert_eq!(result.cues[0].text, "Valid cue");
    assert_eq!(result.errors.len(), 0);
}

#[test]
fn skips_a_cue_identifier_whose_next_line_is_missing() {
    let vtt = "WEBVTT\n\ncue-1\n00:00:01.000 --> 00:00:04.000\nFirst cue\n\norphan-identifier";

    let result = parse(vtt);
    assert_eq!(result.cues.len(), 1);
    assert_eq!(result.cues[0].text, "First cue");
    assert_eq!(result.errors.len(), 0);
}

#[test]
fn reports_error_for_invalid_timing_in_vtt() {
    let vtt = "WEBVTT\n\nnot a timing line\nHello";

    let result = parse(vtt);
    assert_eq!(result.cues.len(), 0);
    assert!(!result.errors.is_empty());
}

#[test]
fn sorts_vtt_cues_by_start_time() {
    let vtt = "WEBVTT\n\n00:00:05.000 --> 00:00:08.000\nSecond\n\n00:00:01.000 --> 00:00:04.000\nFirst";

    let result = parse(vtt);
    assert_eq!(result.cues[0].text, "First");
    assert_eq!(result.cues[1].text, "Second");
}

#[test]
fn skips_empty_cue_text_silently_in_vtt() {
    let vtt = "WEBVTT\n\n00:00:01.000 --> 00:00:04.000\n\n00:00:05.000 --> 00:00:08.000\nValid";

    let result = parse(vtt);
    assert_eq!(result.cues.len(), 1);
    assert_eq!(result.cues[0].text, "Valid");
    assert_eq!(result.errors.len(), 0);
}

// ---------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------

#[test]
fn returns_error_for_empty_content() {
    let result = parse("");
    assert_eq!(result.cues.len(), 0);
    assert_eq!(result.format, None);
    assert!(result.errors[0].message.contains("Empty"));
}

#[test]
fn returns_error_for_whitespace_only_content() {
    let result = parse("   \n  \n  ");
    assert_eq!(result.cues.len(), 0);
    assert_eq!(result.format, None);
    assert!(result.errors[0].message.contains("Empty"));
}

#[test]
fn handles_cues_with_multi_line_text() {
    let srt = "1\n00:00:01,000 --> 00:00:04,000\nLine one\nLine two";

    let result = parse(srt);
    assert_eq!(result.cues.len(), 1);
    assert!(result.cues[0].text.contains("Line one"));
    assert!(result.cues[0].text.contains("Line two"));
}

#[test]
fn handles_very_large_timestamp_values() {
    let srt = "1\n01:00:00,000 --> 02:30:00,000\nOne hour to two and a half hours";

    let result = parse(srt);
    assert_eq!(result.cues[0].start, 3600.0);
    assert_eq!(result.cues[0].end, 9000.0);
}

// ---------------------------------------------------------------------------
// Same-start cue normalization
// ---------------------------------------------------------------------------

#[test]
fn merges_srt_cues_sharing_the_same_start_time() {
    let srt = "1\n00:02:30,000 --> 00:02:32,000\nお母さん 来てたんだ。\n\n2\n00:02:30,000 --> 00:02:33,500\nああ…。";

    let result = parse(srt);
    assert_eq!(result.cues.len(), 1);
    assert_eq!(result.cues[0].text, "お母さん 来てたんだ。 ああ…。");
    assert_eq!(result.cues[0].start, 150.0);
    assert_eq!(result.cues[0].end, 153.5);
    assert_eq!(result.cues[0].id, 0);
}

#[test]
fn uses_max_end_when_merging_same_start_cues() {
    let srt = "1\n00:00:05,000 --> 00:00:08,000\nFirst line\n\n2\n00:00:05,000 --> 00:00:10,000\nSecond line\n\n3\n00:00:05,000 --> 00:00:07,000\nThird line";

    let result = parse(srt);
    assert_eq!(result.cues.len(), 1);
    assert_eq!(result.cues[0].text, "First line Second line Third line");
    assert_eq!(result.cues[0].end, 10.0);
}

#[test]
fn preserves_source_order_for_equal_start_inputs() {
    let srt = "3\n00:00:01,000 --> 00:00:04,000\nThird\n\n1\n00:00:01,000 --> 00:00:03,000\nFirst\n\n2\n00:00:01,000 --> 00:00:05,000\nSecond";

    let result = parse(srt);
    assert_eq!(result.cues.len(), 1);
    assert_eq!(result.cues[0].text, "Third First Second");
}

#[test]
fn merges_vtt_cues_sharing_the_same_start_time() {
    let vtt = "WEBVTT\n\n00:02:30.000 --> 00:02:32.000\nお母さん 来てたんだ。\n\n00:02:30.000 --> 00:02:33.500\nああ…。";

    let result = parse(vtt);
    assert_eq!(result.cues.len(), 1);
    assert_eq!(result.cues[0].text, "お母さん 来てたんだ。 ああ…。");
    assert_eq!(result.cues[0].end, 153.5);
}

#[test]
fn merges_ass_cues_sharing_the_same_start_time() {
    let ass = format!(
        "{ASS_HEADER}Dialogue: 0,0:02:30.00,0:02:32.00,Default,,0,0,0,,お母さん 来てたんだ。\nDialogue: 0,0:02:30.00,0:02:33.50,Default,,0,0,0,,ああ…。"
    );

    let result = parse(&ass);
    assert_eq!(result.cues.len(), 1);
    assert_eq!(result.cues[0].text, "お母さん 来てたんだ。 ああ…。");
    assert_eq!(result.cues[0].end, 153.5);
}

#[test]
fn does_not_merge_cues_with_different_start_times() {
    let srt = "1\n00:00:01,000 --> 00:00:04,000\nFirst\n\n2\n00:00:05,000 --> 00:00:08,000\nSecond";

    let result = parse(srt);
    assert_eq!(result.cues.len(), 2);
    assert_eq!(result.cues[0].text, "First");
    assert_eq!(result.cues[1].text, "Second");
}

#[test]
fn reindexes_ids_after_merge() {
    let srt = "1\n00:00:01,000 --> 00:00:04,000\nStandalone\n\n2\n00:00:05,000 --> 00:00:08,000\nA\n\n3\n00:00:05,000 --> 00:00:09,000\nB";

    let result = parse(srt);
    assert_eq!(result.cues.len(), 2);
    assert_eq!(result.cues[0].id, 0);
    assert_eq!(result.cues[1].id, 1);
}

#[test]
fn skips_empty_text_during_merge() {
    let srt = "1\n00:00:01,000 --> 00:00:04,000\nFirst\n\n2\n00:00:01,000 --> 00:00:03,000\nSecond";

    let result = parse(srt);
    assert_eq!(result.cues.len(), 1);
    assert_eq!(result.cues[0].text, "First Second");
}

#[test]
fn handles_three_same_start_cues() {
    let srt = "1\n00:00:10,000 --> 00:00:12,000\nA\n\n2\n00:00:10,000 --> 00:00:13,000\nB\n\n3\n00:00:10,000 --> 00:00:11,500\nC";

    let result = parse(srt);
    assert_eq!(result.cues.len(), 1);
    assert_eq!(result.cues[0].text, "A B C");
    assert_eq!(result.cues[0].end, 13.0);
}

// ---------------------------------------------------------------------------
// Literal <br> normalization
// ---------------------------------------------------------------------------

#[test]
fn converts_br_to_space_in_srt() {
    for markup in ["<br>", "<br/>", "<br />", "<BR>", "<Br>"] {
        let srt = format!("1\n00:00:01,000 --> 00:00:04,000\nHello{markup}world");
        let result = parse(&srt);
        assert_eq!(result.cues[0].text, "Hello world", "markup: {markup}");
    }
}

#[test]
fn converts_br_to_space_in_vtt() {
    for markup in ["<br>", "<br/>"] {
        let vtt = format!("WEBVTT\n\n00:00:01.000 --> 00:00:04.000\nHello{markup}world");
        let result = parse(&vtt);
        assert_eq!(result.cues[0].text, "Hello world", "markup: {markup}");
    }
}

#[test]
fn converts_ass_newline_escape_to_space() {
    let ass = format!("{ASS_HEADER}Dialogue: 0,0:00:01.00,0:00:04.00,Default,,0,0,0,,Line one\\NLine two");
    let result = parse(&ass);
    assert_eq!(result.cues[0].text, "Line one Line two");
}

#[test]
fn preserves_other_html_tags_while_normalizing_br() {
    let srt = "1\n00:00:01,000 --> 00:00:04,000\n<b>Bold</b><br><i>italic</i>";

    let result = parse(srt);
    assert_eq!(result.cues[0].text, "Bold italic");
}

// ---------------------------------------------------------------------------
// HTML entity decoding
// ---------------------------------------------------------------------------

#[test]
fn converts_nbsp_entities_to_space_in_srt() {
    for entity in ["&nbsp;", "&#160;", "&NBSP;", "&#xA0;", "&#XA0;"] {
        let srt = format!("1\n00:00:01,000 --> 00:00:04,000\nHello{entity}world");
        let result = parse(&srt);
        assert_eq!(result.cues[0].text, "Hello world", "entity: {entity}");
    }
}

#[test]
fn preserves_lt_and_gt_as_literal_text_in_srt() {
    let srt = "1\n00:00:01,000 --> 00:00:04,000\na &lt; b &gt; c";

    let result = parse(srt);
    assert_eq!(result.cues[0].text, "a &lt; b &gt; c");
}

#[test]
fn preserves_amp_as_literal_text_in_srt() {
    let srt = "1\n00:00:01,000 --> 00:00:04,000\nTom &amp; Jerry";

    let result = parse(srt);
    assert_eq!(result.cues[0].text, "Tom &amp; Jerry");
}

#[test]
fn converts_nbsp_to_space_in_vtt() {
    let vtt = "WEBVTT\n\n00:00:01.000 --> 00:00:04.000\nHello&nbsp;world";

    let result = parse(vtt);
    assert_eq!(result.cues[0].text, "Hello world");
}

#[test]
fn converts_nbsp_to_space_in_ass() {
    let ass = format!("{ASS_HEADER}Dialogue: 0,0:00:01.00,0:00:04.00,Default,,0,0,0,,Hello&nbsp;world");
    let result = parse(&ass);
    assert_eq!(result.cues[0].text, "Hello world");
}

#[test]
fn handles_multiple_nbsp_in_a_single_cue() {
    let srt = "1\n00:00:01,000 --> 00:00:04,000\nA&nbsp;&nbsp;&nbsp;B";

    let result = parse(srt);
    assert_eq!(result.cues[0].text, "A B");
}

#[test]
fn preserves_escaped_angle_brackets_as_literal_text() {
    let srt = "1\n00:00:01,000 --> 00:00:04,000\n&lt;b&gt;not bold&lt;/b&gt;";

    let result = parse(srt);
    assert_eq!(result.cues[0].text, "&lt;b&gt;not bold&lt;/b&gt;");
}

// ---------------------------------------------------------------------------
// detect_format
// ---------------------------------------------------------------------------

#[test]
fn detects_vtt_format() {
    assert_eq!(
        detect_format("WEBVTT\n\n00:00:01.000 --> 00:00:04.000\nHello"),
        Some("vtt")
    );
}

#[test]
fn detects_srt_format() {
    assert_eq!(
        detect_format("1\n00:00:01,000 --> 00:00:04,000\nHello"),
        Some("srt")
    );
}

#[test]
fn detects_unknown_format() {
    assert_eq!(detect_format("random text"), None);
}

#[test]
fn detects_ass_format() {
    assert_eq!(detect_format("[Script Info]\nTitle: Test"), Some("ass"));
}

#[test]
fn detects_ass_format_case_insensitive() {
    assert_eq!(detect_format("[script info]\nTitle: Test"), Some("ass"));
}

// ---------------------------------------------------------------------------
// ASS Parsing
// ---------------------------------------------------------------------------

#[test]
fn parses_valid_ass_dialogues_with_timing() {
    let ass = format!(
        "{ASS_HEADER}Dialogue: 0,0:00:01.00,0:00:04.00,Default,,0,0,0,,Hello world\nDialogue: 0,0:00:05.00,0:00:08.00,Default,,0,0,0,,Second cue"
    );

    let result = parse(&ass);
    assert_eq!(result.format.as_deref(), Some("ass"));
    assert_eq!(result.cues.len(), 2);
    assert_eq!(result.errors.len(), 0);
    assert_eq!(result.cues[0].start, 1.0);
    assert_eq!(result.cues[0].end, 4.0);
    assert_eq!(result.cues[0].text, "Hello world");
    assert_eq!(result.cues[1].start, 5.0);
    assert_eq!(result.cues[1].end, 8.0);
    assert_eq!(result.cues[1].text, "Second cue");
}

#[test]
fn converts_ass_uppercase_newline_escape_to_space() {
    let ass = format!("{ASS_HEADER}Dialogue: 0,0:00:01.00,0:00:04.00,Default,,0,0,0,,Line one\\NLine two");
    let result = parse(&ass);
    assert_eq!(result.cues[0].text, "Line one Line two");
}

#[test]
fn converts_ass_lowercase_newline_escape_to_space() {
    let ass = format!("{ASS_HEADER}Dialogue: 0,0:00:01.00,0:00:04.00,Default,,0,0,0,,Line one\\nLine two");
    let result = parse(&ass);
    assert_eq!(result.cues[0].text, "Line one Line two");
}

#[test]
fn strips_ass_override_tags_from_text() {
    let ass = format!(
        "{ASS_HEADER}Dialogue: 0,0:00:01.00,0:00:04.00,Default,,0,0,0,,{{\\b1}}Bold{{\\b0}} and {{\\i1}}italic{{\\i0}}"
    );
    let result = parse(&ass);
    assert_eq!(result.cues.len(), 1);
    assert_eq!(result.cues[0].text, "Bold and italic");
}

#[test]
fn strips_complex_ass_override_tags_including_pos() {
    let ass = format!(
        "{ASS_HEADER}Dialogue: 0,0:00:01.00,0:00:04.00,Default,,0,0,0,,{{\\pos(100,200)}}Positioned"
    );
    let result = parse(&ass);
    assert_eq!(result.cues.len(), 1);
    assert_eq!(result.cues[0].text, "Positioned");
}

#[test]
fn sorts_ass_cues_chronologically_and_reassigns_ids() {
    let ass = format!(
        "{ASS_HEADER}Dialogue: 0,0:00:05.00,0:00:08.00,Default,,0,0,0,,Second\nDialogue: 0,0:00:01.00,0:00:04.00,Default,,0,0,0,,First"
    );

    let result = parse(&ass);
    assert_eq!(result.cues.len(), 2);
    assert_eq!(result.cues[0].text, "First");
    assert_eq!(result.cues[1].text, "Second");
    assert_eq!(result.cues[0].id, 0);
    assert_eq!(result.cues[1].id, 1);
}

#[test]
fn reports_error_for_malformed_ass() {
    // No `Format:` line inside `[Events]` → every dialogue has an undefined
    // start/end, which is reported as an invalid timing.
    let ass = "[Script Info]\nTitle: Broken\nScriptType: v4.00+\n\n[V4+ Styles]\nBroken format line\n\n[Events]\nDialogue: 0,0:00:01.00,0:00:04.00,Default,,0,0,0,,Hello";
    let result = parse(ass);
    assert_eq!(result.format.as_deref(), Some("ass"));
    assert_eq!(result.cues.len(), 0);
    assert!(!result.errors.is_empty());
}

#[test]
fn does_not_panic_on_malformed_input() {
    let result = parse("not valid ASS at all");
    assert_eq!(result.format.as_deref(), Some("srt"));
    assert!(!result.errors.is_empty());
}

#[test]
fn reports_error_for_dialogue_with_invalid_timing() {
    let ass = format!("{ASS_HEADER}Dialogue: 0,-1,-2,Default,,0,0,0,,Invalid timing");
    let result = parse(&ass);
    assert_eq!(result.format.as_deref(), Some("ass"));
    assert!(!result.cues.is_empty() || !result.errors.is_empty());
}

#[test]
fn handles_multi_line_ass_escapes_combined() {
    let ass = format!(
        "{ASS_HEADER}Dialogue: 0,0:00:01.00,0:00:04.00,Default,,0,0,0,,First\\NSecond\\NThird"
    );
    let result = parse(&ass);
    assert_eq!(result.cues.len(), 1);
    assert_eq!(result.cues[0].text, "First Second Third");
}

#[test]
fn skips_empty_ass_dialogue_text_silently() {
    let ass = format!(
        "{ASS_HEADER}Dialogue: 0,0:00:01.00,0:00:04.00,Default,,0,0,0,,{{\\pos(100,200)}}{{\\b1}}{{\\i1}}"
    );
    let result = parse(&ass);
    assert_eq!(result.errors.len(), 0);
    assert_eq!(result.cues.len(), 0);
}

#[test]
fn keeps_commas_inside_the_ass_text_field() {
    let ass = format!(
        "{ASS_HEADER}Dialogue: 0,0:00:01.00,0:00:04.00,Default,,0,0,0,,Hello, world"
    );
    let result = parse(&ass);
    assert_eq!(result.cues.len(), 1);
    assert_eq!(result.cues[0].text, "Hello, world");
}

#[test]
fn ignores_ass_comment_events() {
    let ass = format!(
        "{ASS_HEADER}Comment: 0,0:00:01.00,0:00:04.00,Default,,0,0,0,,Not a cue\nDialogue: 0,0:00:05.00,0:00:08.00,Default,,0,0,0,,Real cue"
    );
    let result = parse(&ass);
    assert_eq!(result.cues.len(), 1);
    assert_eq!(result.cues[0].text, "Real cue");
}

// ---------------------------------------------------------------------------
// YouTube ASR rolling-caption dedup
// ---------------------------------------------------------------------------

/// Build a YouTube VTT snippet with ASR timing lines.
fn asr_vtt(cues: &[(&str, &str, &str)]) -> String {
    let blocks: Vec<String> = cues
        .iter()
        .enumerate()
        .map(|(index, (start, end, text))| {
            format!("{}\n{} --> {} align:start position:0%\n{}", index + 1, start, end, text)
        })
        .collect();
    format!("WEBVTT\n\n{}", blocks.join("\n\n"))
}

#[test]
fn collapses_rolling_triple_to_one_cue_with_extended_end() {
    let vtt = asr_vtt(&[
        (
            "00:00:01.040",
            "00:00:01.299",
            "あいつら君が来るの楽しみにしてたんだぞ。…",
        ),
        (
            "00:00:01.299",
            "00:00:01.309",
            "あいつら君が来るの楽しみにしてたんだぞ。…",
        ),
        (
            "00:00:01.309",
            "00:00:07.269",
            "あいつら君が来るの楽しみにしてたんだぞ。…\n[音楽]",
        ),
    ]);

    let result = parse(&vtt);
    assert_eq!(result.cues.len(), 1);
    assert!(result.cues[0]
        .text
        .contains("あいつら君が来るの楽しみにしてたんだぞ。…"));
    assert!((result.cues[0].end - 7.269).abs() < 1e-6);
    assert!((result.cues[0].start - 1.040).abs() < 1e-6);
}

#[test]
fn merges_prefix_extension_pair_to_fuller_text() {
    let vtt = asr_vtt(&[
        ("00:00:02.000", "00:00:03.500", "こんにちは世界"),
        (
            "00:00:03.200",
            "00:00:06.000",
            "こんにちは世界！元気ですか？",
        ),
    ]);

    let result = parse(&vtt);
    assert_eq!(result.cues.len(), 1);
    assert_eq!(result.cues[0].text, "こんにちは世界！元気ですか？");
    assert!((result.cues[0].end - 6.0).abs() < 1e-6);
}

#[test]
fn keeps_different_sentences_intact() {
    let vtt = asr_vtt(&[
        ("00:00:01.000", "00:00:03.000", "最初の文です"),
        ("00:00:03.500", "00:00:06.000", "次の文です"),
    ]);

    let result = parse(&vtt);
    assert_eq!(result.cues.len(), 2);
    assert_eq!(result.cues[0].text, "最初の文です");
    assert_eq!(result.cues[1].text, "次の文です");
}

#[test]
fn non_asr_vtt_with_identical_adjacent_texts_stays_unchanged() {
    let vtt = "WEBVTT\n\n00:00:01.000 --> 00:00:03.000\nSame text here\n\n00:00:03.000 --> 00:00:06.000\nSame text here";

    let result = parse(vtt);
    assert_eq!(result.cues.len(), 2);
    assert_eq!(result.cues[0].text, "Same text here");
    assert_eq!(result.cues[1].text, "Same text here");
}

#[test]
fn rule_1_drops_whitespace_only_asr_cue() {
    let vtt = asr_vtt(&[
        ("00:00:01.000", "00:00:03.000", "Hello world"),
        ("00:00:03.000", "00:00:05.000", "   "),
        ("00:00:05.000", "00:00:07.000", "Different text"),
    ]);

    let result = parse(&vtt);
    assert_eq!(result.cues.len(), 2);
    assert_eq!(result.cues[0].text, "Hello world");
    assert_eq!(result.cues[1].text, "Different text");
}

#[test]
fn rule_2_same_text_keeps_the_longer_duration() {
    let vtt = asr_vtt(&[
        ("00:00:01.000", "00:00:02.000", "Short span"),
        ("00:00:01.500", "00:00:05.000", "Short span"),
    ]);

    let result = parse(&vtt);
    assert_eq!(result.cues.len(), 1);
    assert!((result.cues[0].end - 5.0).abs() < 1e-6);
}

#[test]
fn rule_3_does_not_fire_when_the_gap_exceeds_the_tolerance() {
    let vtt = asr_vtt(&[
        ("00:00:01.000", "00:00:02.000", "Partial"),
        ("00:00:03.000", "00:00:05.000", "Partial text is longer"),
    ]);

    let result = parse(&vtt);
    assert_eq!(result.cues.len(), 2);
}

#[test]
fn rule_3_suffix_restart_pair_collapses_to_fuller_prev_text() {
    let vtt = asr_vtt(&[
        (
            "00:00:01.000",
            "00:00:04.500",
            "ちょっと 早く来る方がいいですか？【音楽】",
        ),
        (
            "00:00:04.200",
            "00:00:07.000",
            "早く来る方がいいですか？【音楽】",
        ),
    ]);

    let result = parse(&vtt);
    assert_eq!(result.cues.len(), 1);
    assert_eq!(result.cues[0].text, "ちょっと 早く来る方がいいですか？【音楽】");
    assert!((result.cues[0].end - 7.0).abs() < 1e-6);
}

#[test]
fn two_line_rolling_window_stays_separate() {
    let vtt = asr_vtt(&[
        ("00:00:01.000", "00:00:03.000", "ありがとうございました。"),
        (
            "00:00:02.800",
            "00:00:06.000",
            "次のスピーカーに切り替わります。",
        ),
    ]);

    let result = parse(&vtt);
    assert_eq!(result.cues.len(), 2);
    assert_eq!(result.cues[0].text, "ありがとうございました。");
    assert_eq!(result.cues[1].text, "次のスピーカーに切り替わります。");
}

#[test]
fn mix_of_asr_and_non_asr_cues_passes_non_asr_through() {
    let vtt = "WEBVTT\n\n00:00:01.000 --> 00:00:03.000\nNormal cue without ASR\n\n00:00:03.000 --> 00:00:03.500 align:start position:0%\nASR duplicate\n\n00:00:03.500 --> 00:00:07.000 align:start position:0%\nASR duplicate\n\n00:00:08.000 --> 00:00:10.000\nAnother normal cue";

    let result = parse(vtt);
    assert_eq!(result.cues.len(), 3);
    assert_eq!(result.cues[0].text, "Normal cue without ASR");
    assert_eq!(result.cues[1].text, "ASR duplicate");
    assert!((result.cues[1].end - 7.0).abs() < 1e-6);
    assert_eq!(result.cues[2].text, "Another normal cue");
}

// ---------------------------------------------------------------------------
// Format hint
// ---------------------------------------------------------------------------

#[test]
fn format_hint_overrides_auto_detection() {
    // An ASS file whose `[Script Info]` header was removed is parsed as ASS
    // when the caller says so.
    let ass = "[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\nDialogue: 0,0:00:01.00,0:00:04.00,Default,,0,0,0,,Hello";

    let detected = parse(ass);
    assert_eq!(detected.format.as_deref(), Some("srt"));
    assert_eq!(detected.cues.len(), 0);

    let hinted = parse_subtitles(ass, Some("ass"));
    assert_eq!(hinted.format.as_deref(), Some("ass"));
    assert_eq!(hinted.cues.len(), 1);
    assert_eq!(hinted.cues[0].text, "Hello");
}

#[test]
fn unknown_format_hint_falls_back_to_auto_detection() {
    let result = parse_subtitles("WEBVTT\n\n00:00:01.000 --> 00:00:04.000\nHello", Some("nope"));
    assert_eq!(result.format.as_deref(), Some("vtt"));
    assert_eq!(result.cues.len(), 1);
}

#[test]
fn strips_a_byte_order_mark() {
    // Windows exports carry a BOM; JavaScript's `trim()` removes it, and so
    // must the Rust port.
    let srt = "\u{FEFF}1\n00:00:01,000 --> 00:00:04,000\nHello BOM";
    let result = parse(srt);
    assert_eq!(result.format.as_deref(), Some("srt"));
    assert_eq!(result.cues.len(), 1);
    assert_eq!(result.cues[0].text, "Hello BOM");

    let vtt = "\u{FEFF}WEBVTT\n\n00:00:01.000 --> 00:00:04.000\nHello BOM";
    let result = parse(vtt);
    assert_eq!(result.format.as_deref(), Some("vtt"));
    assert_eq!(result.cues.len(), 1);
    assert_eq!(result.cues[0].text, "Hello BOM");
}

#[test]
fn a_malformed_ass_file_fails_as_a_whole() {
    // No `Format:` line inside `[Events]` → the dialogue cannot be mapped →
    // the whole file fails to compile, exactly like the `ass-compiler` based
    // TypeScript implementation.
    let ass = "[Script Info]\nTitle: Broken\n\n[Events]\nDialogue: 0,0:00:01.00,0:00:04.00,Default,,0,0,0,,Hello";
    let result = parse(ass);
    assert_eq!(result.format.as_deref(), Some("ass"));
    assert_eq!(result.cues.len(), 0);
    assert_eq!(result.errors.len(), 1);
    assert!(result.errors[0].message.starts_with("ASS compiler error:"));
}

#[test]
fn parses_a_three_thousand_cue_track() {
    let mut content = String::new();
    for index in 0..3000 {
        let start = index * 2;
        let end = start + 2;
        content.push_str(&format!(
            "{}\n{:02}:{:02}:{:02},000 --> {:02}:{:02}:{:02},000\nLine {}\n\n",
            index + 1,
            start / 3600,
            (start / 60) % 60,
            start % 60,
            end / 3600,
            (end / 60) % 60,
            end % 60,
            index
        ));
    }

    let result = parse(&content);
    assert_eq!(result.errors.len(), 0);
    assert_eq!(result.cues.len(), 3000);
    assert_eq!(result.cues[0].text, "Line 0");
    assert_eq!(result.cues[2999].text, "Line 2999");
}

// ---------------------------------------------------------------------------
// Multi-byte input — char boundary regression
//
// The format detection and the ASS section scan compared the head of the
// text against an ASCII header by slicing it at a fixed byte offset. A
// multi-byte character at that offset sliced the string in the middle of a
// character, which panicked with "byte index is not a char boundary".
// ---------------------------------------------------------------------------

#[test]
fn parses_an_ass_file_with_a_multibyte_comment_line_without_panicking() {
    // The section scan compares every line against the `[Script Info]`
    // header, so a line that starts with a multi-byte character used to
    // panic.
    let ass = concat!(
        "[Script Info]\n",
        "Title: 日本語タイトル\n",
        "日本語のコメント\n",
        "\n",
        "[Events]\n",
        "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n",
        "Dialogue: 0,0:00:01.00,0:00:04.00,Default,,0,0,0,,こんにちは\n",
    );

    let result = parse(ass);
    assert_eq!(result.format.as_deref(), Some("ass"));
    assert_eq!(result.cues.len(), 1);
    assert_eq!(result.cues[0].text, "こんにちは");
}

#[test]
fn parses_an_ass_file_with_a_multibyte_first_line_without_panicking() {
    // With a format hint the auto-detection is skipped, so the section scan
    // is the only place that can hit the multi-byte line.
    let ass = concat!(
        "日本語のコメント\n",
        "[Events]\n",
        "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n",
        "Dialogue: 0,0:00:01.00,0:00:04.00,Default,,0,0,0,,Hello\n",
    );

    let result = parse_subtitles(ass, Some("ass"));
    assert_eq!(result.format.as_deref(), Some("ass"));
    assert_eq!(result.cues.len(), 1);
    assert_eq!(result.cues[0].text, "Hello");
}

#[test]
fn parses_content_that_starts_with_a_multibyte_character_without_panicking() {
    // The auto-detection compared the first 13 bytes against
    // `[script info]`; a multi-byte first character used to panic.
    let result = parse("日本語のテキストです\n");
    assert_eq!(result.format.as_deref(), Some("srt"));
    assert_eq!(result.cues.len(), 0);
    assert!(!result.errors.is_empty());
}

#[test]
fn detects_no_format_for_multibyte_content_without_panicking() {
    assert_eq!(detect_format("日本語のテキストです"), None);
}

#[test]
fn detects_the_ass_format_for_a_multibyte_title_without_panicking() {
    let ass = concat!(
        "[Script Info]\n",
        "Title: 日本語タイトル\n",
        "\n",
        "[Events]\n",
        "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n",
        "Dialogue: 0,0:00:01.00,0:00:04.00,Default,,0,0,0,,Hello\n",
    );

    assert_eq!(detect_format(ass), Some("ass"));
}
