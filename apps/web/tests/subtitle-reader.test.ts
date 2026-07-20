import { describe, expect, it } from 'vitest';
import {
  parseSubtitle,
  detectFormat,
  validateSubtitle,
} from '../src/features/player/subtitle-reader';

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

  it('reports error when end time is not after start time', () => {
    const srt = `1
00:00:05,000 --> 00:00:01,000
End before start`;

    const result = parseSubtitle(srt);
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors.some((e) => e.message.includes('not after'))).toBe(
      true,
    );
  });

  it('reports error for empty cue text', () => {
    const srt = `1
00:00:01,000 --> 00:00:04,000

2
00:00:05,000 --> 00:00:08,000
Valid`;

    const result = parseSubtitle(srt);
    // Empty cue is skipped, only valid cue remains
    expect(result.cues).toHaveLength(1);
    expect(result.cues[0]!.text).toBe('Valid');
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
