/**
 * Subtitle Parser — SRT and VTT formats.
 * ---------------------------------------------------------------------------
 * P1 scope: SRT and VTT only. ASS/SSA has a dependency gate (PLAYER_PHASES.md 5.128).
 *
 * Design:
 * - Returns validation errors instead of throwing to UI.
 * - Strips VTT headers, notes, and style blocks safely.
 * - Normalizes and sorts cues by start time.
 * - Handles malformed timing gracefully.
 * - Single shared tag-stripping helper (merged from duplicates).
 * --------------------------------------------------------------------------- */

/** A single normalized subtitle cue. */
export interface SubtitleCue {
  /** Unique identifier (index-based after normalization). */
  id: number;
  /** Start time in seconds. */
  start: number;
  /** End time in seconds. */
  end: number;
  /** Cue text content (HTML tags stripped, whitespace normalized). */
  text: string;
}

/** Validation error returned instead of throwing. */
export interface SubtitleError {
  /** Line number where the error occurred (1-based), or 0 if unknown. */
  line: number;
  /** Human-readable error message. */
  message: string;
}

/** Result of parsing a subtitle file. */
export interface SubtitleParseResult {
  /** Parsed cues, sorted by start time. Empty array if parsing failed. */
  cues: SubtitleCue[];
  /** Any validation errors encountered during parsing. */
  errors: SubtitleError[];
  /** Detected format. */
  format: 'srt' | 'vtt' | null;
}

/**
 * Parse a subtitle file (SRT or VTT).
 * Auto-detects format based on content.
 */
export function parseSubtitle(content: string): SubtitleParseResult {
  const trimmed = content.trim();
  if (trimmed.length === 0) {
    return {
      cues: [],
      errors: [{ line: 0, message: 'Empty file' }],
      format: null,
    };
  }

  if (trimmed.startsWith('WEBVTT')) {
    return parseVTT(trimmed);
  }

  return parseSRT(trimmed);
}

// ---------------------------------------------------------------------------
// SRT Parser
// ---------------------------------------------------------------------------

function parseSRT(content: string): SubtitleParseResult {
  const errors: SubtitleError[] = [];
  const cues: SubtitleCue[] = [];

  const lines = content.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');

  let i = 0;

  while (i < lines.length) {
    while (i < lines.length && (lines[i] ?? '').trim() === '') {
      i++;
    }
    if (i >= lines.length) break;

    const currentLine = lines[i];
    if (currentLine === undefined) break;
    const indexLine = currentLine.trim();
    if (!/^\d+$/.test(indexLine)) {
      errors.push({
        line: i + 1,
        message: `Expected cue index, got: "${indexLine}"`,
      });
      i++;
      continue;
    }
    i++;

    if (i >= lines.length) {
      errors.push({
        line: i + 1,
        message: 'Unexpected end of file, expected timing line',
      });
      break;
    }

    const timingLine = lines[i];
    if (timingLine === undefined) break;
    const timingResult = parseTimingLine(timingLine.trim(), i + 1);
    if (!timingResult) {
      errors.push({
        line: i + 1,
        message: `Invalid timing line: "${timingLine.trim()}"`,
      });
      i++;
      continue;
    }

    if (timingResult.errors.length > 0) {
      errors.push(...timingResult.errors);
    }

    i++;

    const textLines: string[] = [];
    while (i < lines.length && (lines[i] ?? '').trim() !== '') {
      const textLine = lines[i];
      if (textLine !== undefined) {
        textLines.push(textLine);
      }
      i++;
    }

    const text = textLines.join('\n').trim();
    if (text.length === 0) {
      errors.push({ line: i, message: 'Empty cue text' });
      continue;
    }

    cues.push({
      id: cues.length,
      start: timingResult.start,
      end: timingResult.end,
      text: stripTags(text),
    });
  }

  cues.sort((a, b) => a.start - b.start || a.end - b.end);
  cues.forEach((cue, idx) => {
    cue.id = idx;
  });

  return { cues, errors, format: 'srt' };
}

// ---------------------------------------------------------------------------
// VTT Parser
// ---------------------------------------------------------------------------

function parseVTT(content: string): SubtitleParseResult {
  const errors: SubtitleError[] = [];
  const cues: SubtitleCue[] = [];

  const cleaned = stripVTTHeaders(content);
  const lines = cleaned.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');

  let i = 0;

  while (i < lines.length) {
    while (i < lines.length && (lines[i] ?? '').trim() === '') {
      i++;
    }
    if (i >= lines.length) break;

    const currentLine = lines[i];
    if (currentLine === undefined) break;

    if (currentLine.trim().toUpperCase() === 'NOTE') {
      i++;
      while (i < lines.length && (lines[i] ?? '').trim() !== '') {
        i++;
      }
      continue;
    }

    if (currentLine.trim().toUpperCase() === 'STYLE') {
      i++;
      while (i < lines.length && (lines[i] ?? '').trim() !== '') {
        i++;
      }
      continue;
    }

    let timingLine = currentLine;

    if (!currentLine.includes('-->')) {
      i++;
      if (i >= lines.length) {
        errors.push({
          line: i + 1,
          message: 'Unexpected end after cue identifier',
        });
        break;
      }
      const nextLine = lines[i];
      if (nextLine === undefined) {
        errors.push({
          line: i + 1,
          message: 'Unexpected end after cue identifier',
        });
        break;
      }
      timingLine = nextLine;
    }

    const timingResult = parseTimingLine(timingLine.trim(), i + 1);
    if (!timingResult) {
      errors.push({
        line: i + 1,
        message: `Invalid timing line: "${timingLine.trim()}"`,
      });
      i++;
      continue;
    }

    if (timingResult.errors.length > 0) {
      errors.push(...timingResult.errors);
    }

    i++;

    const textLines: string[] = [];
    while (i < lines.length && (lines[i] ?? '').trim() !== '') {
      const textLine = lines[i];
      if (textLine !== undefined) {
        textLines.push(textLine);
      }
      i++;
    }

    const text = textLines.join('\n').trim();
    if (text.length === 0) {
      errors.push({ line: i, message: 'Empty cue text' });
      continue;
    }

    cues.push({
      id: cues.length,
      start: timingResult.start,
      end: timingResult.end,
      text: stripTags(text),
    });
  }

  cues.sort((a, b) => a.start - b.start || a.end - b.end);
  cues.forEach((cue, idx) => {
    cue.id = idx;
  });

  return { cues, errors, format: 'vtt' };
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

interface TimingResult {
  start: number;
  end: number;
  errors: SubtitleError[];
}

function parseTimingLine(
  line: string,
  lineNumber: number,
): TimingResult | null {
  const errors: SubtitleError[] = [];

  const timingRegex =
    /^(\d{1,2}:\d{2}:\d{2}[,.:]\d{3})\s*-->\s*(\d{1,2}:\d{2}:\d{2}[,.:]\d{3})/;
  const match = line.match(timingRegex);

  if (!match) {
    return null;
  }

  const startStr = match[1];
  const endStr = match[2];
  if (startStr === undefined || endStr === undefined) {
    return null;
  }

  const start = parseTimestamp(startStr);
  const end = parseTimestamp(endStr);

  if (start === null) {
    errors.push({
      line: lineNumber,
      message: `Invalid start timestamp: "${startStr}"`,
    });
  }
  if (end === null) {
    errors.push({
      line: lineNumber,
      message: `Invalid end timestamp: "${endStr}"`,
    });
  }

  if (start === null || end === null) {
    return { start: start ?? 0, end: end ?? 0, errors };
  }

  if (end <= start) {
    errors.push({
      line: lineNumber,
      message: `End time (${end}s) is not after start time (${start}s)`,
    });
  }

  return { start, end, errors };
}

function parseTimestamp(timestamp: string): number | null {
  const normalized = timestamp.replace(',', '.').replace(':', '.');

  const parts = normalized.split(/[:.]/);
  if (parts.length !== 4) return null;

  const hours = Number(parts[0]);
  const minutes = Number(parts[1]);
  const seconds = Number(parts[2]);
  const milliseconds = Number(parts[3]);

  if (isNaN(hours) || isNaN(minutes) || isNaN(seconds) || isNaN(milliseconds)) {
    return null;
  }

  if (minutes >= 60 || seconds >= 60 || milliseconds >= 1000) {
    return null;
  }

  return hours * 3600 + minutes * 60 + seconds + milliseconds / 1000;
}

/** Strip HTML/VTT tags and normalize whitespace. Used for both SRT and VTT. */
function stripTags(text: string): string {
  return text
    .replace(/<[^>]*>/g, '')
    .replace(/\n/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Strip VTT file header. */
function stripVTTHeaders(content: string): string {
  const lines = content.split('\n');
  const result: string[] = [];
  let i = 0;

  const firstLine = lines[0];
  if (firstLine !== undefined && firstLine.trim().startsWith('WEBVTT')) {
    i = 1;
    while (i < lines.length && (lines[i] ?? '').trim() !== '') {
      i++;
    }
    if (i < lines.length && (lines[i] ?? '').trim() === '') {
      i++;
    }
  }

  while (i < lines.length) {
    const line = lines[i];
    if (line !== undefined) {
      result.push(line);
    }
    i++;
  }

  return result.join('\n');
}

export function detectFormat(content: string): 'srt' | 'vtt' | null {
  const trimmed = content.trim();
  if (trimmed.startsWith('WEBVTT')) return 'vtt';
  if (/^\d+\s*\n/.test(trimmed)) return 'srt';
  return null;
}

export function validateSubtitle(content: string): SubtitleError[] {
  const result = parseSubtitle(content);
  return result.errors;
}
