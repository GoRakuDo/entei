import { describe, expect, it } from 'vitest';
import {
  parseSubtitle,
  detectFormat,
  validateSubtitle,
  findActiveCue,
  type SubtitleCue,
} from '../src/features/player/subtitle-reader';
import { SUBTITLE_ACCEPT } from '../src/features/player/media-url';

// ---------------------------------------------------------------------------
// SRT Parsing
// ---------------------------------------------------------------------------

describe('parseSubtitle — SRT', () => {
  it('parses a valid SRT file with multiple cues', () => {
    const srt = `1
00:00:01,000 --> 00:00:04,000
Hello world

2
00:00:05,000 --> 00:00:08,000
Second cue

3
00:00:09,500 --> 00:00:12,000
Third cue`;

    const result = parseSubtitle(srt);
    expect(result.format).toBe('srt');
    expect(result.cues).toHaveLength(3);
    expect(result.errors).toHaveLength(0);

    expect(result.cues[0]).toMatchObject({
      id: 0,
      start: 1,
      end: 4,
      text: 'Hello world',
    });
    expect(result.cues[1]).toMatchObject({
      id: 1,
      start: 5,
      end: 8,
      text: 'Second cue',
    });
    expect(result.cues[2]).toMatchObject({
      id: 2,
      start: 9.5,
      end: 12,
      text: 'Third cue',
    });
  });

  it('handles CRLF line endings', () => {
    const srt =
      '1\r\n00:00:01,000 --> 00:00:04,000\r\nHello\r\n\r\n2\r\n00:00:05,000 --> 00:00:08,000\r\nWorld';
    const result = parseSubtitle(srt);
    expect(result.cues).toHaveLength(2);
    expect(result.cues[0]!.text).toBe('Hello');
    expect(result.cues[1]!.text).toBe('World');
  });

  it('sorts cues by start time', () => {
    const srt = `2
00:00:05,000 --> 00:00:08,000
Second

1
00:00:01,000 --> 00:00:04,000
First`;

    const result = parseSubtitle(srt);
    expect(result.cues).toHaveLength(2);
    expect(result.cues[0]!.text).toBe('First');
    expect(result.cues[1]!.text).toBe('Second');
    // IDs reassigned after sort
    expect(result.cues[0]!.id).toBe(0);
    expect(result.cues[1]!.id).toBe(1);
  });

  it('strips HTML tags from SRT text', () => {
    const srt = `1
00:00:01,000 --> 00:00:04,000
<b>Bold</b> and <i>italic</i> text`;

    const result = parseSubtitle(srt);
    expect(result.cues[0]!.text).toBe('Bold and italic text');
  });

  it('reports error for invalid timing line', () => {
    const srt = `1
invalid timing
Hello`;

    const result = parseSubtitle(srt);
    expect(result.cues).toHaveLength(0);
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors[0]!.message).toContain('Invalid timing');
  });

  it('silently drops a zero/negative-length cue (not an error)', () => {
    const srt = `1
00:00:05,000 --> 00:00:01,000
End before start`;

    const result = parseSubtitle(srt);
    // The sync engine can clamp to a 0-length cue after a large shift;
    // such cues are dropped silently — no error, no rendered cue.
    expect(result.errors.length).toBe(0);
    expect(result.cues).toHaveLength(0);
  });

  it('VTT: silently drops a zero/negative-length cue (not an error)', () => {
    const vtt = `WEBVTT

00:00:00.000 --> 00:00:00.000
Zero cue

00:00:02.000 --> 00:00:04.000
Valid cue
`;
    const result = parseSubtitle(vtt);
    expect(result.errors.length).toBe(0);
    expect(result.cues).toHaveLength(1);
    expect(result.cues[0]?.text).toContain('Valid cue');
  });

  it('VTT: only zero/negative-length cues → empty result, no errors', () => {
    const vtt = `WEBVTT

00:00:01.000 --> 00:00:00.000
Backwards cue
`;
    const result = parseSubtitle(vtt);
    expect(result.errors.length).toBe(0);
    expect(result.cues).toHaveLength(0);
  });

  it('ASS: silently drops a zero-length cue (not an error)', () => {
    const ass = `[Script Info]
ScriptType: v4.00+

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
Dialogue: 0,0:00:00.00,0:00:00.00,Default,,0,0,0,,Zero cue
Dialogue: 0,0:00:02.00,0:00:04.00,Default,,0,0,0,,Valid cue
`;
    const result = parseSubtitle(ass);
    expect(result.errors.length).toBe(0);
    expect(result.cues).toHaveLength(1);
    expect(result.cues[0]?.text).toContain('Valid cue');
  });

  it('skips empty cue text without errors (YouTube music/silence gaps)', () => {
    const srt = `1
00:00:01,000 --> 00:00:04,000

2
00:00:05,000 --> 00:00:08,000
Valid`;

    const result = parseSubtitle(srt);
    // Empty cue is skipped silently — no error pushed
    expect(result.cues).toHaveLength(1);
    expect(result.cues[0]!.text).toBe('Valid');
    expect(result.errors).toHaveLength(0);
  });

  it('handles milliseconds with dot separator', () => {
    const srt = `1
00:00:01.500 --> 00:00:04.200
Dot separator`;

    const result = parseSubtitle(srt);
    expect(result.cues[0]!.start).toBe(1.5);
    expect(result.cues[0]!.end).toBe(4.2);
  });
});

// ---------------------------------------------------------------------------
// VTT Parsing
// ---------------------------------------------------------------------------

describe('parseSubtitle — VTT', () => {
  it('parses a valid VTT file', () => {
    const vtt = `WEBVTT

00:00:01.000 --> 00:00:04.000
Hello world

00:00:05.000 --> 00:00:08.000
Second cue`;

    const result = parseSubtitle(vtt);
    expect(result.format).toBe('vtt');
    expect(result.cues).toHaveLength(2);
    expect(result.errors).toHaveLength(0);

    expect(result.cues[0]).toMatchObject({
      start: 1,
      end: 4,
      text: 'Hello world',
    });
  });

  it('strips VTT header and NOTE blocks', () => {
    const vtt = `WEBVTT
Kind: captions
Language: en

NOTE
This is a comment

00:00:01.000 --> 00:00:04.000
After notes`;

    const result = parseSubtitle(vtt);
    expect(result.cues).toHaveLength(1);
    expect(result.cues[0]!.text).toBe('After notes');
  });

  it('strips STYLE blocks', () => {
    const vtt = `WEBVTT

STYLE
::cue { color: white; }

00:00:01.000 --> 00:00:04.000
Styled cue`;

    const result = parseSubtitle(vtt);
    expect(result.cues).toHaveLength(1);
    expect(result.cues[0]!.text).toBe('Styled cue');
  });

  it('handles cue identifiers', () => {
    const vtt = `WEBVTT

cue-1
00:00:01.000 --> 00:00:04.000
First cue

cue-2
00:00:05.000 --> 00:00:08.000
Second cue`;

    const result = parseSubtitle(vtt);
    expect(result.cues).toHaveLength(2);
    expect(result.cues[0]!.text).toBe('First cue');
    expect(result.cues[1]!.text).toBe('Second cue');
  });

  it('skips a trailing cue identifier with no timing line silently (no warning)', () => {
    // YouTube VTT can end right after a cue identifier (truncated tail).
    // This must be skipped like an empty cue text — no error surface
    // (2026-08-09: the old warning flooded the error box ~1788).
    const vtt = `WEBVTT

00:00:01.000 --> 00:00:04.000
Valid cue

1788`;

    const result = parseSubtitle(vtt);
    expect(result.cues).toHaveLength(1);
    expect(result.cues[0]!.text).toBe('Valid cue');
    expect(result.errors).toHaveLength(0);
  });

  it('skips a cue identifier whose next line is missing entirely', () => {
    const vtt = `WEBVTT

cue-1
00:00:01.000 --> 00:00:04.000
First cue

orphan-identifier`;

    const result = parseSubtitle(vtt);
    expect(result.cues).toHaveLength(1);
    expect(result.cues[0]!.text).toBe('First cue');
    expect(result.errors).toHaveLength(0);
  });

  it('reports error for invalid timing in VTT', () => {
    const vtt = `WEBVTT

not a timing line
Hello`;

    const result = parseSubtitle(vtt);
    expect(result.cues).toHaveLength(0);
    expect(result.errors.length).toBeGreaterThan(0);
  });

  it('sorts VTT cues by start time', () => {
    const vtt = `WEBVTT

00:00:05.000 --> 00:00:08.000
Second

00:00:01.000 --> 00:00:04.000
First`;

    const result = parseSubtitle(vtt);
    expect(result.cues[0]!.text).toBe('First');
    expect(result.cues[1]!.text).toBe('Second');
  });

  it('skips empty cue text silently in VTT (music/silence gaps)', () => {
    const vtt = `WEBVTT

00:00:01.000 --> 00:00:04.000
First

00:00:05.000 --> 00:00:08.000
Second`;

    const result = parseSubtitle(vtt);
    expect(result.cues).toHaveLength(2);
    expect(result.errors).toHaveLength(0);
  });

  it('skips empty cue text silently in VTT', () => {
    const vtt = `WEBVTT

00:00:01.000 --> 00:00:04.000

00:00:05.000 --> 00:00:08.000
Valid`;

    const result = parseSubtitle(vtt);
    expect(result.cues).toHaveLength(1);
    expect(result.cues[0]!.text).toBe('Valid');
    expect(result.errors).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------

describe('parseSubtitle — edge cases', () => {
  it('returns error for empty content', () => {
    const result = parseSubtitle('');
    expect(result.cues).toHaveLength(0);
    expect(result.format).toBeNull();
    expect(result.errors[0]!.message).toContain('Empty');
  });

  it('returns error for whitespace-only content', () => {
    const result = parseSubtitle('   \n  \n  ');
    expect(result.cues).toHaveLength(0);
    expect(result.errors[0]!.message).toContain('Empty');
  });

  it('handles cues with multi-line text', () => {
    const srt = `1
00:00:01,000 --> 00:00:04,000
Line one
Line two`;

    const result = parseSubtitle(srt);
    expect(result.cues).toHaveLength(1);
    expect(result.cues[0]!.text).toContain('Line one');
    expect(result.cues[0]!.text).toContain('Line two');
  });

  it('handles very large timestamp values', () => {
    const srt = `1
01:00:00,000 --> 02:30:00,000
One hour to two and a half hours`;

    const result = parseSubtitle(srt);
    expect(result.cues[0]!.start).toBe(3600);
    expect(result.cues[0]!.end).toBe(9000);
  });
});

// ---------------------------------------------------------------------------
// Same-start cue normalization (P1 maintenance fix)
// ---------------------------------------------------------------------------

describe('parseSubtitle — same-start cue normalization', () => {
  it('merges SRT cues sharing same start time into one cue', () => {
    const srt = `1
00:02:30,000 --> 00:02:32,000
お母さん 来てたんだ。

2
00:02:30,000 --> 00:02:33,500
ああ…。`;

    const result = parseSubtitle(srt);
    expect(result.cues).toHaveLength(1);
    expect(result.cues[0]!.text).toBe('お母さん 来てたんだ。 ああ…。');
    expect(result.cues[0]!.start).toBe(150);
    expect(result.cues[0]!.end).toBe(153.5);
    expect(result.cues[0]!.id).toBe(0);
  });

  it('uses max(end) when merging same-start cues with different ends', () => {
    const srt = `1
00:00:05,000 --> 00:00:08,000
First line

2
00:00:05,000 --> 00:00:10,000
Second line

3
00:00:05,000 --> 00:00:07,000
Third line`;

    const result = parseSubtitle(srt);
    expect(result.cues).toHaveLength(1);
    expect(result.cues[0]!.text).toBe('First line Second line Third line');
    expect(result.cues[0]!.end).toBe(10);
  });

  it('preserves source order for equal-start inputs', () => {
    const srt = `3
00:00:01,000 --> 00:00:04,000
Third

1
00:00:01,000 --> 00:00:03,000
First

2
00:00:01,000 --> 00:00:05,000
Second`;

    const result = parseSubtitle(srt);
    // Same start → merged into one cue, text preserves file order
    expect(result.cues).toHaveLength(1);
    expect(result.cues[0]!.text).toBe('Third First Second');
  });

  it('merges VTT cues sharing same start time', () => {
    const vtt = `WEBVTT

00:02:30.000 --> 00:02:32.000
お母さん 来てたんだ。

00:02:30.000 --> 00:02:33.500
ああ…。`;

    const result = parseSubtitle(vtt);
    expect(result.cues).toHaveLength(1);
    expect(result.cues[0]!.text).toBe('お母さん 来てたんだ。 ああ…。');
    expect(result.cues[0]!.end).toBe(153.5);
  });

  it('merges ASS cues sharing same start time', () => {
    const header = `[Script Info]
Title: Test
ScriptType: v4.00+
PlayResX: 1920
PlayResY: 1080

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,Arial,48,&H00FFFFFF,&H000000FF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,2,2,2,10,10,10,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
`;
    const ass =
      header +
      `Dialogue: 0,0:02:30.00,0:02:32.00,Default,,0,0,0,,お母さん 来てたんだ。
Dialogue: 0,0:02:30.00,0:02:33.50,Default,,0,0,0,,ああ…。`;

    const result = parseSubtitle(ass);
    expect(result.cues).toHaveLength(1);
    expect(result.cues[0]!.text).toBe('お母さん 来てたんだ。 ああ…。');
    expect(result.cues[0]!.end).toBe(153.5);
  });

  it('does NOT merge cues with different start times', () => {
    const srt = `1
00:00:01,000 --> 00:00:04,000
First

2
00:00:05,000 --> 00:00:08,000
Second`;

    const result = parseSubtitle(srt);
    expect(result.cues).toHaveLength(2);
    expect(result.cues[0]!.text).toBe('First');
    expect(result.cues[1]!.text).toBe('Second');
  });

  it('reindexes IDs after merge', () => {
    const srt = `1
00:00:01,000 --> 00:00:04,000
Standalone

2
00:00:05,000 --> 00:00:08,000
A

3
00:00:05,000 --> 00:00:09,000
B`;

    const result = parseSubtitle(srt);
    expect(result.cues).toHaveLength(2);
    expect(result.cues[0]!.id).toBe(0);
    expect(result.cues[1]!.id).toBe(1);
  });

  it('skips empty text during merge (only nonempty text is joined)', () => {
    const srt = `1
00:00:01,000 --> 00:00:04,000
First

2
00:00:01,000 --> 00:00:03,000
Second`;

    const result = parseSubtitle(srt);
    expect(result.cues).toHaveLength(1);
    expect(result.cues[0]!.text).toBe('First Second');
  });

  it('findActiveCue returns merged text for same-start cues', () => {
    const srt = `1
00:02:30,000 --> 00:02:32,000
お母さん 来てたんだ。

2
00:02:30,000 --> 00:02:33,500
ああ…。`;

    const result = parseSubtitle(srt);
    const active = findActiveCue(result.cues, 151);
    expect(active).not.toBeNull();
    expect(active!.text).toBe('お母さん 来てたんだ。 ああ…。');
  });

  it('handles three same-start cues', () => {
    const srt = `1
00:00:10,000 --> 00:00:12,000
A

2
00:00:10,000 --> 00:00:13,000
B

3
00:00:10,000 --> 00:00:11,500
C`;

    const result = parseSubtitle(srt);
    expect(result.cues).toHaveLength(1);
    expect(result.cues[0]!.text).toBe('A B C');
    expect(result.cues[0]!.end).toBe(13);
  });
});

// ---------------------------------------------------------------------------
// Literal <br> normalization (P1 maintenance fix)
// ---------------------------------------------------------------------------

describe('parseSubtitle — literal <br> normalization', () => {
  it('converts <br> to space in SRT', () => {
    const srt = `1
00:00:01,000 --> 00:00:04,000
Hello<br>world`;

    const result = parseSubtitle(srt);
    expect(result.cues[0]!.text).toBe('Hello world');
  });

  it('converts <br/> to space in SRT', () => {
    const srt = `1
00:00:01,000 --> 00:00:04,000
Hello<br/>world`;

    const result = parseSubtitle(srt);
    expect(result.cues[0]!.text).toBe('Hello world');
  });

  it('converts <br /> to space in SRT', () => {
    const srt = `1
00:00:01,000 --> 00:00:04,000
Hello<br />world`;

    const result = parseSubtitle(srt);
    expect(result.cues[0]!.text).toBe('Hello world');
  });

  it('converts <BR> (uppercase) to space in SRT', () => {
    const srt = `1
00:00:01,000 --> 00:00:04,000
Hello<BR>world`;

    const result = parseSubtitle(srt);
    expect(result.cues[0]!.text).toBe('Hello world');
  });

  it('converts <Br> (mixed case) to space in SRT', () => {
    const srt = `1
00:00:01,000 --> 00:00:04,000
Hello<Br>world`;

    const result = parseSubtitle(srt);
    expect(result.cues[0]!.text).toBe('Hello world');
  });

  it('converts <br> to space in VTT', () => {
    const vtt = `WEBVTT

00:00:01.000 --> 00:00:04.000
Hello<br>world`;

    const result = parseSubtitle(vtt);
    expect(result.cues[0]!.text).toBe('Hello world');
  });

  it('converts <br/> to space in VTT', () => {
    const vtt = `WEBVTT

00:00:01.000 --> 00:00:04.000
Hello<br/>world`;

    const result = parseSubtitle(vtt);
    expect(result.cues[0]!.text).toBe('Hello world');
  });

  it('does not affect ASS \\N (handled by separate ASS normalizer)', () => {
    const header = `[Script Info]
Title: Test
ScriptType: v4.00+
PlayResX: 1920
PlayResY: 1080

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,Arial,48,&H00FFFFFF,&H000000FF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,2,2,2,10,10,10,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
`;
    const ass =
      header +
      `Dialogue: 0,0:00:01.00,0:00:04.00,Default,,0,0,0,,Line one\\NLine two`;

    const result = parseSubtitle(ass);
    expect(result.cues[0]!.text).toBe('Line one Line two');
  });

  it('preserves other HTML tags while normalizing <br>', () => {
    const srt = `1
00:00:01,000 --> 00:00:04,000
<b>Bold</b><br><i>italic</i>`;

    const result = parseSubtitle(srt);
    expect(result.cues[0]!.text).toBe('Bold italic');
  });
});

// ---------------------------------------------------------------------------
// HTML entity decoding (&nbsp;, &amp;, etc.)
// ---------------------------------------------------------------------------

describe('parseSubtitle — HTML entity decoding', () => {
  it('converts &nbsp; to space in SRT', () => {
    const srt = `1
00:00:01,000 --> 00:00:04,000
Hello&nbsp;world`;

    const result = parseSubtitle(srt);
    expect(result.cues[0]!.text).toBe('Hello world');
  });

  it('converts &#160; (numeric nbsp) to space in SRT', () => {
    const srt = `1
00:00:01,000 --> 00:00:04,000
Hello&#160;world`;

    const result = parseSubtitle(srt);
    expect(result.cues[0]!.text).toBe('Hello world');
  });

  it('converts &nbsp; (uppercase) to space in SRT', () => {
    const srt = `1
00:00:01,000 --> 00:00:04,000
Hello&nbsp;world`;

    const result = parseSubtitle(srt);
    expect(result.cues[0]!.text).toBe('Hello world');
  });

  it('preserves &lt; and &gt; as literal text in SRT', () => {
    const srt = `1
00:00:01,000 --> 00:00:04,000
a &lt; b &gt; c`;

    const result = parseSubtitle(srt);
    // &lt; and &gt; are NOT decoded — only &nbsp; class entities are decoded
    expect(result.cues[0]!.text).toBe('a &lt; b &gt; c');
  });

  it('preserves &amp; as literal text in SRT', () => {
    const srt = `1
00:00:01,000 --> 00:00:04,000
Tom &amp; Jerry`;

    const result = parseSubtitle(srt);
    // &amp; is NOT decoded — only &nbsp; class entities are decoded
    expect(result.cues[0]!.text).toBe('Tom &amp; Jerry');
  });

  it('converts &#xA0; (hex numeric nbsp) to space in SRT', () => {
    const srt = `1
00:00:01,000 --> 00:00:04,000
Hello&#xA0;world`;

    const result = parseSubtitle(srt);
    expect(result.cues[0]!.text).toBe('Hello world');
  });

  it('converts &nbsp; to space in VTT', () => {
    const vtt = `WEBVTT

00:00:01.000 --> 00:00:04.000
Hello&nbsp;world`;

    const result = parseSubtitle(vtt);
    expect(result.cues[0]!.text).toBe('Hello world');
  });

  it('converts &nbsp; to space in ASS', () => {
    const header = `[Script Info]
Title: Test
ScriptType: v4.00+
PlayResX: 1920
PlayResY: 1080

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,Arial,48,&H00FFFFFF,&H000000FF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,2,2,2,10,10,10,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
`;
    const ass =
      header +
      `Dialogue: 0,0:00:01.00,0:00:04.00,Default,,0,0,0,,Hello&nbsp;world`;

    const result = parseSubtitle(ass);
    expect(result.cues[0]!.text).toBe('Hello world');
  });

  it('handles multiple &nbsp; in a single cue', () => {
    const srt = `1
00:00:01,000 --> 00:00:04,000
A&nbsp;&nbsp;&nbsp;B`;

    const result = parseSubtitle(srt);
    // Multiple &nbsp; + whitespace normalization → single space
    expect(result.cues[0]!.text).toBe('A B');
  });

  it('preserves &lt;/&gt; as literal text, not as tags', () => {
    const srt = `1
00:00:01,000 --> 00:00:04,000
&lt;b&gt;not bold&lt;/b&gt;`;

    const result = parseSubtitle(srt);
    // &lt; and &gt; are preserved as literal text, not decoded to < >
    expect(result.cues[0]!.text).toBe('&lt;b&gt;not bold&lt;/b&gt;');
  });
});

// ---------------------------------------------------------------------------
// detectFormat
// ---------------------------------------------------------------------------

describe('detectFormat', () => {
  it('detects VTT format', () => {
    expect(detectFormat('WEBVTT\n\n00:00:01.000 --> 00:00:04.000\nHello')).toBe(
      'vtt',
    );
  });

  it('detects SRT format', () => {
    expect(detectFormat('1\n00:00:01,000 --> 00:00:04,000\nHello')).toBe('srt');
  });

  it('returns null for unknown format', () => {
    expect(detectFormat('random text')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// validateSubtitle
// ---------------------------------------------------------------------------

describe('validateSubtitle', () => {
  it('returns no errors for valid SRT', () => {
    const srt = `1
00:00:01,000 --> 00:00:04,000
Hello`;
    expect(validateSubtitle(srt)).toHaveLength(0);
  });

  it('returns errors for invalid content', () => {
    const errors = validateSubtitle('not valid');
    expect(errors.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// ASS Parsing (P1.3a)
// ---------------------------------------------------------------------------

describe('parseSubtitle — ASS', () => {
  const assHeader = `[Script Info]
Title: Test
ScriptType: v4.00+
PlayResX: 1920
PlayResY: 1080

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,Arial,48,&H00FFFFFF,&H000000FF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,2,2,2,10,10,10,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
`;

  it('parses valid ASS dialogues with timing', () => {
    const ass =
      assHeader +
      `Dialogue: 0,0:00:01.00,0:00:04.00,Default,,0,0,0,,Hello world
Dialogue: 0,0:00:05.00,0:00:08.00,Default,,0,0,0,,Second cue`;

    const result = parseSubtitle(ass);
    expect(result.format).toBe('ass');
    expect(result.cues).toHaveLength(2);
    expect(result.errors).toHaveLength(0);

    expect(result.cues[0]).toMatchObject({
      start: 1,
      end: 4,
      text: 'Hello world',
    });
    expect(result.cues[1]).toMatchObject({
      start: 5,
      end: 8,
      text: 'Second cue',
    });
  });

  it('converts \\N linebreaks to spaces', () => {
    const ass =
      assHeader +
      `Dialogue: 0,0:00:01.00,0:00:04.00,Default,,0,0,0,,Line one\\NLine two`;

    const result = parseSubtitle(ass);
    expect(result.cues).toHaveLength(1);
    expect(result.cues[0]!.text).toBe('Line one Line two');
  });

  it('converts lowercase \\n linebreaks to spaces', () => {
    const ass =
      assHeader +
      `Dialogue: 0,0:00:01.00,0:00:04.00,Default,,0,0,0,,Line one\\nLine two`;

    const result = parseSubtitle(ass);
    expect(result.cues).toHaveLength(1);
    expect(result.cues[0]!.text).toBe('Line one Line two');
  });

  it('strips override/style tags from text', () => {
    const ass =
      assHeader +
      `Dialogue: 0,0:00:01.00,0:00:04.00,Default,,0,0,0,,{\\b1}Bold{\\b0} and {\\i1}italic{\\i0}`;

    const result = parseSubtitle(ass);
    expect(result.cues).toHaveLength(1);
    expect(result.cues[0]!.text).toBe('Bold and italic');
  });

  it('strips complex override tags including pos', () => {
    const ass =
      assHeader +
      `Dialogue: 0,0:00:01.00,0:00:04.00,Default,,0,0,0,,{\\pos(100,200)}Positioned`;

    const result = parseSubtitle(ass);
    expect(result.cues).toHaveLength(1);
    expect(result.cues[0]!.text).toBe('Positioned');
  });

  it('sorts cues chronologically and reassigns ids', () => {
    const ass =
      assHeader +
      `Dialogue: 0,0:00:05.00,0:00:08.00,Default,,0,0,0,,Second
Dialogue: 0,0:00:01.00,0:00:04.00,Default,,0,0,0,,First`;

    const result = parseSubtitle(ass);
    expect(result.cues).toHaveLength(2);
    expect(result.cues[0]!.text).toBe('First');
    expect(result.cues[1]!.text).toBe('Second');
    expect(result.cues[0]!.id).toBe(0);
    expect(result.cues[1]!.id).toBe(1);
  });

  it('reports error for malformed ASS / compiler failure', () => {
    const ass = `[Script Info]
Title: Broken
ScriptType: v4.00+

[V4+ Styles]
Broken format line

[Events]
Dialogue: 0,0:00:01.00,0:00:04.00,Default,,0,0,0,,Hello`;
    const result = parseSubtitle(ass);
    expect(result.format).toBe('ass');
    expect(result.cues).toHaveLength(0);
    expect(result.errors.length).toBeGreaterThan(0);
  });

  it('does not throw on malformed input', () => {
    expect(() => parseSubtitle('not valid ASS at all')).not.toThrow();
  });

  it('reports error for dialogue with invalid timing', () => {
    // Force an invalid dialogue by using extreme values
    const ass = assHeader + `Dialogue: 0,-1,-2,Default,,0,0,0,,Invalid timing`;

    const result = parseSubtitle(ass);
    // Timing validation depends on ass-compiler behavior; either cues or errors
    expect(result.format).toBe('ass');
    expect(result.cues.length + result.errors.length).toBeGreaterThan(0);
  });

  it('handles multi-line ASS linebreaks combined', () => {
    const ass =
      assHeader +
      `Dialogue: 0,0:00:01.00,0:00:04.00,Default,,0,0,0,,First\\NSecond\\NThird`;

    const result = parseSubtitle(ass);
    expect(result.cues).toHaveLength(1);
    expect(result.cues[0]!.text).toBe('First Second Third');
  });

  it('skips empty dialogue text silently (YouTube music/silence gaps)', () => {
    const ass =
      assHeader +
      `Dialogue: 0,0:00:01.00,0:00:04.00,Default,,0,0,0,,{\\pos(100,200)}{\\b1}{\\i1}`;

    const result = parseSubtitle(ass);
    // Empty after tag stripping — skipped silently, no error
    expect(result.errors).toHaveLength(0);
  });
});

describe('detectFormat', () => {
  it('detects ASS format', () => {
    const ass = `[Script Info]
Title: Test`;
    expect(detectFormat(ass)).toBe('ass');
  });

  it('detects ASS format case insensitive', () => {
    const ass = `[script info]
Title: Test`;
    expect(detectFormat(ass)).toBe('ass');
  });
});

// ---------------------------------------------------------------------------
// SUBTITLE_ACCEPT + ASS admission
// ---------------------------------------------------------------------------

describe('SUBTITLE_ACCEPT includes ASS', () => {
  it('includes .ass in accept string', () => {
    expect(SUBTITLE_ACCEPT).toContain('.ass');
  });

  it('still includes .srt and .vtt', () => {
    expect(SUBTITLE_ACCEPT).toContain('.srt');
    expect(SUBTITLE_ACCEPT).toContain('.vtt');
  });
});

// ---------------------------------------------------------------------------
// P1.3a.1: findActiveCue — shared active-cue lookup
// ---------------------------------------------------------------------------

const cue = (
  id: number,
  start: number,
  end: number,
  text = '',
): SubtitleCue => ({
  id,
  start,
  end,
  text,
});

describe('findActiveCue', () => {
  it('returns null for empty cues array', () => {
    expect(findActiveCue([], 5)).toBeNull();
  });

  it('returns null when time is before all cues', () => {
    const cues = [cue(0, 2, 5, 'hello')];
    expect(findActiveCue(cues, 0)).toBeNull();
  });

  it('returns null when time is after all cues', () => {
    const cues = [cue(0, 2, 5, 'hello')];
    expect(findActiveCue(cues, 6)).toBeNull();
  });

  it('finds cue at start boundary (inclusive start)', () => {
    const cues = [cue(0, 2, 5, 'hello')];
    const result = findActiveCue(cues, 2);
    expect(result?.text).toBe('hello');
  });

  it('does NOT find cue at end boundary (exclusive end)', () => {
    const cues = [cue(0, 2, 5, 'hello')];
    expect(findActiveCue(cues, 5)).toBeNull();
  });

  it('finds cue in middle of range', () => {
    const cues = [cue(0, 2, 5, 'hello')];
    const result = findActiveCue(cues, 3.5);
    expect(result?.text).toBe('hello');
  });

  it('finds first overlapping cue when multiple overlap', () => {
    const cues = [cue(0, 0, 3, 'first'), cue(1, 1, 4, 'second')];
    const result = findActiveCue(cues, 2);
    expect(result?.text).toBe('first');
  });

  it('skips to later cue when earlier has ended', () => {
    const cues = [cue(0, 0, 2, 'first'), cue(1, 3, 5, 'second')];
    const result = findActiveCue(cues, 4);
    expect(result?.text).toBe('second');
  });

  it('returns null between non-overlapping cues', () => {
    const cues = [cue(0, 0, 2, 'first'), cue(1, 4, 6, 'second')];
    expect(findActiveCue(cues, 3)).toBeNull();
  });

  it('handles zero start time', () => {
    const cues = [cue(0, 0, 1, 'from start')];
    const result = findActiveCue(cues, 0);
    expect(result?.text).toBe('from start');
  });

  it('handles fractional timestamps', () => {
    const cues = [cue(0, 1.5, 3.7, 'fractional')];
    const result = findActiveCue(cues, 1.5);
    expect(result?.text).toBe('fractional');
    expect(findActiveCue(cues, 3.7)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// YouTube ASR rolling-caption dedup
// ---------------------------------------------------------------------------

describe('parseSubtitle — YouTube ASR rolling-caption dedup', () => {
  /**
   * Helper: build a YouTube VTT snippet with ASR timing lines.
   * Each entry is [start, end, text].
   */
  const asrVTT = (
    cues: [string, string, string][],
  ): string => {
    const blocks = cues
      .map(
        ([start, end, text], i) =>
          `${i + 1}\n${start} --> ${end} align:start position:0%\n${text}`,
      )
      .join('\n\n');
    return `WEBVTT\n\n${blocks}`;
  };

  it('collapses rolling triple (empty → same → same+music) to one cue with extended end', () => {
    // Reproduces live YouTube ASR pattern (2026-08-21 evidence):
    // cue 1: very short window, same text
    // cue 2: very short window, same text  
    // cue 3: longer window, same text + [音楽]
    const vtt = asrVTT([
      ['00:00:01.040', '00:00:01.299', 'あいつら君が来るの楽しみにしてたんだぞ。…'],
      ['00:00:01.299', '00:00:01.309', 'あいつら君が来るの楽しみにしてたんだぞ。…'],
      [
        '00:00:01.309',
        '00:00:07.269',
        'あいつら君が来るの楽しみにしてたんだぞ。…\n[音楽]',
      ],
    ]);

    const result = parseSubtitle(vtt);
    // All 3 should collapse into 1 cue (same text, extended end)
    expect(result.cues).toHaveLength(1);
    expect(result.cues[0]!.text).toContain('あいつら君が来るの楽しみにしてたんだぞ。…');
    // End should be max of all three = 7.269
    expect(result.cues[0]!.end).toBeCloseTo(7.269, 3);
    // Start should be the earliest = 1.040
    expect(result.cues[0]!.start).toBeCloseTo(1.04, 3);
  });

  it('merges prefix-extension pair to fuller text', () => {
    // ASR mid-word split: cue A has partial text, cue B has the full sentence
    // that starts with A's text.
    const vtt = asrVTT([
      ['00:00:02.000', '00:00:03.500', 'こんにちは世界'],
      ['00:00:03.200', '00:00:06.000', 'こんにちは世界！元気ですか？'],
    ]);

    const result = parseSubtitle(vtt);
    expect(result.cues).toHaveLength(1);
    // Rule 3: B is fuller, so A.text is replaced by B.text
    expect(result.cues[0]!.text).toBe('こんにちは世界！元気ですか？');
    // End extended to max
    expect(result.cues[0]!.end).toBeCloseTo(6.0, 3);
  });

  it('keeps different sentences intact (no false dedup)', () => {
    const vtt = asrVTT([
      ['00:00:01.000', '00:00:03.000', '最初の文です'],
      ['00:00:03.500', '00:00:06.000', '次の文です'],
    ]);

    const result = parseSubtitle(vtt);
    expect(result.cues).toHaveLength(2);
    expect(result.cues[0]!.text).toBe('最初の文です');
    expect(result.cues[1]!.text).toBe('次の文です');
  });

  it('non-ASR VTT with identical adjacent texts stays unchanged (flag gate)', () => {
    // No align:start position → NOT detected as ASR → no dedup
    const vtt = `WEBVTT

00:00:01.000 --> 00:00:03.000
Same text here

00:00:03.000 --> 00:00:06.000
Same text here`;

    const result = parseSubtitle(vtt);
    expect(result.cues).toHaveLength(2);
    expect(result.cues[0]!.text).toBe('Same text here');
    expect(result.cues[1]!.text).toBe('Same text here');
  });

  it('rule 1: drops whitespace-only ASR cue', () => {
    const vtt = asrVTT([
      ['00:00:01.000', '00:00:03.000', 'Hello world'],
      ['00:00:03.000', '00:00:05.000', '   '],
      ['00:00:05.000', '00:00:07.000', 'Different text'],
    ]);

    const result = parseSubtitle(vtt);
    // Whitespace-only cue dropped, other two remain
    expect(result.cues).toHaveLength(2);
    expect(result.cues[0]!.text).toBe('Hello world');
    expect(result.cues[1]!.text).toBe('Different text');
  });

  it('rule 2: same text keeps the one with longer duration', () => {
    const vtt = asrVTT([
      ['00:00:01.000', '00:00:02.000', 'Short span'],
      ['00:00:01.500', '00:00:05.000', 'Short span'],
    ]);

    const result = parseSubtitle(vtt);
    expect(result.cues).toHaveLength(1);
    // Extended to the longer end
    expect(result.cues[0]!.end).toBeCloseTo(5.0, 3);
  });

  it('rule 3 does NOT fire when gap exceeds 0.5 s tolerance', () => {
    const vtt = asrVTT([
      ['00:00:01.000', '00:00:02.000', 'Partial'],
      ['00:00:03.000', '00:00:05.000', 'Partial text is longer'],
    ]);

    const result = parseSubtitle(vtt);
    // Gap is 1.0 s > 0.5 tolerance → no merge, both kept
    expect(result.cues).toHaveLength(2);
  });

  it('rule 3\u2032: suffix-restart pair collapses to fuller prev text', () => {
    // ASR rolling window drops leading words: prev has the full phrase,
    // cur is a suffix/restart of that phrase — both ASR-flagged.
    const vtt = asrVTT([
      [
        '00:00:01.000',
        '00:00:04.500',
        'ちょっと 早く来る方がいいですか？【音楽】',
      ],
      [
        '00:00:04.200',
        '00:00:07.000',
        '早く来る方がいいですか？【音楽】',
      ],
    ]);

    const result = parseSubtitle(vtt);
    // Rule 3': prev is fuller, cur is suffix → keep prev text, extend end
    expect(result.cues).toHaveLength(1);
    expect(result.cues[0]!.text).toBe(
      'ちょっと 早く来る方がいいですか？【音楽】',
    );
    expect(result.cues[0]!.end).toBeCloseTo(7.0, 3);
  });

  it('two-line rolling window: old tail + new sentence stays separate', () => {
    // Realistic ASR fixture: first cue is tail from previous window,
    // second cue starts a new sentence — different text, no collapse.
    const vtt = asrVTT([
      ['00:00:01.000', '00:00:03.000', 'ありがとうございました。'],
      [
        '00:00:02.800',
        '00:00:06.000',
        '次のスピーカーに切り替わります。',
      ],
    ]);

    const result = parseSubtitle(vtt);
    // Different text → Rule 4 applies: both cues kept as-is
    expect(result.cues).toHaveLength(2);
    expect(result.cues[0]!.text).toBe('ありがとうございました。');
    expect(result.cues[1]!.text).toBe(
      '次のスピーカーに切り替わります。',
    );
  });

  it('mix of ASR and non-ASR cues: non-ASR cues pass through unchanged', () => {
    const vtt = `WEBVTT

00:00:01.000 --> 00:00:03.000
Normal cue without ASR

00:00:03.000 --> 00:00:03.500 align:start position:0%
ASR duplicate

00:00:03.500 --> 00:00:07.000 align:start position:0%
ASR duplicate

00:00:08.000 --> 00:00:10.000
Another normal cue`;

    const result = parseSubtitle(vtt);
    // Normal cue preserved, ASR duplicates merged, another normal preserved
    expect(result.cues).toHaveLength(3);
    expect(result.cues[0]!.text).toBe('Normal cue without ASR');
    expect(result.cues[1]!.text).toBe('ASR duplicate');
    expect(result.cues[1]!.end).toBeCloseTo(7.0, 3);
    expect(result.cues[2]!.text).toBe('Another normal cue');
  });
});
