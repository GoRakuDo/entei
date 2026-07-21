/**
 * Subtitle Parser — SRT, VTT, and ASS formats.
 * ---------------------------------------------------------------------------
 * P1 scope: SRT, VTT, and ASS (P1.3a).
 * NFVTT/XML/platform/PGS are P1.3b/P1.4 scope.
 *
 * Design:
 * - Returns validation errors instead of throwing to UI.
 * - Strips VTT headers, notes, and style blocks safely.
 * - Strips ASS override tags ({\\...}) from dialogue text.
 * - Converts ASS \\N and \\n linebreaks to spaces (single-line convention).
 * - Normalizes and sorts cues by start time.
 * - Handles malformed timing gracefully.
 * - Single shared tag-stripping helper (merged from duplicates).
 * --------------------------------------------------------------------------- */

import { compile as compileASS } from 'ass-compiler';
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
  format: 'srt' | 'vtt' | 'ass' | null;
}

/**
 * Parse a subtitle file (SRT, VTT, or ASS).
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

  // ASS detection: [Script Info] section header
  if (/^\[Script Info\]/i.test(trimmed)) {
    return parseASS(trimmed);
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
// ASS Parser (P1.3a — uses ass-compiler)
// ---------------------------------------------------------------------------

/**
 * Strip ASS override tags ({\...}) from text.
 * These are inline styling directives like {\b1}, {\i1}, {\pos(x,y)} etc.
 * Only strips brace-enclosed tags, not the text content.
 */
function stripASSTags(text: string): string {
  return text.replace(/\{[^}]*\}/g, '');
}

/**
 * Normalize ASS linebreaks (\N and \n) to spaces.
 * ASS uses \N for hard line breaks and \n for soft breaks.
 * Entei's panel convention is single-line (whitespace normalized).
 */
function normalizeASSLinebreaks(text: string): string {
  return text.replace(/\\N/g, ' ').replace(/\\n/g, ' ');
}

/**
 * Compile ASS content using ass-compiler, returning cues or errors.
 * Wraps the compiler call to catch any thrown exceptions.
 */
function compileASSContent(
  content: string,
): { compiled: ReturnType<typeof compileASS> } | { error: string } {
  try {
    const compiled = compileASS(content, {}); // empty options — default behavior
    return { compiled };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { error: `ASS compiler error: ${msg}` };
  }
}

function parseASS(content: string): SubtitleParseResult {
  const errors: SubtitleError[] = [];
  const cues: SubtitleCue[] = [];

  const result = compileASSContent(content);
  if ('error' in result) {
    errors.push({ line: 0, message: result.error });
    return { cues, errors, format: 'ass' };
  }

  const dialogues = result.compiled.dialogues;
  if (!Array.isArray(dialogues) || dialogues.length === 0) {
    errors.push({ line: 0, message: 'No dialogue events found in ASS file' });
    return { cues, errors, format: 'ass' };
  }

  for (let i = 0; i < dialogues.length; i++) {
    const d = dialogues[i];
    if (!d) continue;

    const start = typeof d.start === 'number' ? d.start : NaN;
    const end = typeof d.end === 'number' ? d.end : NaN;

    if (isNaN(start) || isNaN(end)) {
      errors.push({
        line: 0,
        message: `Dialogue #${i + 1}: invalid timing (start=${String(start)}, end=${String(end)})`,
      });
      continue;
    }

    if (end <= start) {
      errors.push({
        line: 0,
        message: `Dialogue #${i + 1}: end time (${end}s) is not after start time (${start}s)`,
      });
    }

    // Extract text from all slices/fragments
    const textParts: string[] = [];
    if (Array.isArray(d.slices)) {
      for (const slice of d.slices) {
        if (!slice || !Array.isArray(slice.fragments)) continue;
        for (const frag of slice.fragments) {
          if (frag && typeof frag.text === 'string') {
            textParts.push(frag.text);
          }
        }
      }
    }

    let text = textParts.join('');
    // Strip ASS override tags and normalize linebreaks
    text = stripASSTags(text);
    text = normalizeASSLinebreaks(text);
    // Apply shared whitespace normalization
    text = stripTags(text);

    if (text.length === 0) {
      errors.push({ line: 0, message: `Dialogue #${i + 1}: empty text` });
      continue;
    }

    cues.push({
      id: cues.length,
      start,
      end,
      text,
    });
  }

  cues.sort((a, b) => a.start - b.start || a.end - b.end);
  cues.forEach((cue, idx) => {
    cue.id = idx;
  });

  return { cues, errors, format: 'ass' };
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

export function detectFormat(content: string): 'srt' | 'vtt' | 'ass' | null {
  const trimmed = content.trim();
  if (trimmed.startsWith('WEBVTT')) return 'vtt';
  if (/^\[Script Info\]/i.test(trimmed)) return 'ass';
  if (/^\d+\s*\n/.test(trimmed)) return 'srt';
  return null;
}

export function validateSubtitle(content: string): SubtitleError[] {
  const result = parseSubtitle(content);
  return result.errors;
}

// --- P1.3a.1: Shared active-cue lookup --------------------------------------

/**
 * Find the active subtitle cue at a given time.
 * Inclusive start (time >= cue.start), exclusive end (time < cue.end).
 * Returns the matching cue, or null if no cue is active at `time`.
 *
 * This is the single source of truth for active-cue derivation, used by both
 * the subtitle panel (highlighting) and the overlay (text rendering).
 */
export function findActiveCue(
  cues: readonly SubtitleCue[],
  time: number,
): SubtitleCue | null {
  for (const cue of cues) {
    if (time >= cue.start && time < cue.end) return cue;
  }
  return null;
}
