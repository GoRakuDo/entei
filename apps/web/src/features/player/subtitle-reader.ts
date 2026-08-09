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
      // Defensive: blank lines are consumed before this point, but guard
      // against edge cases. Empty timing lines are normal in YouTube
      // subtitles (music/silence gaps); skip silently. Non-empty malformed
      // lines are real errors.
      if (timingLine.trim() !== '') {
        errors.push({
          line: i + 1,
          message: `Invalid timing line: "${timingLine.trim()}"`,
        });
      }
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
      // Empty cue text (music/silence gaps in YouTube subtitles) — skip
      // silently instead of pushing a noisy warning.
      continue;
    }

    cues.push({
      id: cues.length,
      start: timingResult.start,
      end: timingResult.end,
      text: stripTags(text),
    });
  }

  cues.sort((a, b) => a.start - b.start);
  const normalized = normalizeCues(cues);

  return { cues: normalized, errors, format: 'srt' };
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
      // Advance i BEFORE the EOF/nextLine checks below: when the loop
      // breaks here the consumed identifier is simply dropped, and when
      // it proceeds the parseTimingLine(line, i+1) report line matches
      // the timing line's position. Do not reorder this increment.
      i++;
      // A cue identifier with NO following timing line: the file ends
      // before a timing line appears (YouTube VTT can end mid-cue).
      // This is a truncated tail, not a real error — skip silently, same
      // as the empty cue text handling below (2026-08-09: the warning
      // flooded the error box at ~1788 and occupied 449 px of the
      // screen).
      if (i >= lines.length) {
        break;
      }
      const nextLine = lines[i];
      if (nextLine === undefined) {
        break;
      }
      timingLine = nextLine;
    }

    const timingResult = parseTimingLine(timingLine.trim(), i + 1);
    if (!timingResult) {
      // Defensive: blank lines are consumed before this point, but guard
      // against edge cases. Empty timing lines are normal in YouTube VTT
      // (music/silence gaps); skip silently. Non-empty malformed lines are
      // real errors.
      if (timingLine.trim() !== '') {
        errors.push({
          line: i + 1,
          message: `Invalid timing line: "${timingLine.trim()}"`,
        });
      }
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
      // Empty cue text (music/silence gaps in YouTube subtitles) — skip
      // silently instead of pushing a noisy warning.
      continue;
    }

    cues.push({
      id: cues.length,
      start: timingResult.start,
      end: timingResult.end,
      text: stripTags(text),
    });
  }

  cues.sort((a, b) => a.start - b.start);
  const normalized = normalizeCues(cues);

  return { cues: normalized, errors, format: 'vtt' };
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
      // Empty dialogue text (music/silence gaps) — skip silently.
      continue;
    }

    cues.push({
      id: cues.length,
      start,
      end,
      text,
    });
  }

  cues.sort((a, b) => a.start - b.start);
  const normalized = normalizeCues(cues);

  return { cues: normalized, errors, format: 'ass' };
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

/**
 * Decode non-breaking space HTML entities that appear in subtitle files.
 * &nbsp; is the most common — it comes from ASS files and online subtitle
 * sources where the non-breaking space entity is used for formatting.
 * Numeric variants (&#160; / &#xA0;) are also covered.
 *
 * Only space-class entities are decoded. Standard XML escapes (&amp;,
 * &lt;, &gt;) are NOT decoded here because they would create ambiguity
 * with HTML tag stripping: decoded angle brackets would be incorrectly
 * treated as tags by the subsequent <...> regex.
 */
function decodeNBSPEntities(text: string): string {
  return text
    .replace(/&nbsp;/gi, ' ')
    .replace(/&#160;/g, ' ')
    .replace(/&#xA0;/gi, ' ');
}

/**
 * Strip HTML/VTT tags and normalize whitespace.
 * Used for both SRT and VTT.
 * &nbsp; entities are decoded first (non-breaking space → regular space)
 * to prevent literal "&nbsp;" text from reaching the display layer.
 * Literal <br>, <br/>, <br /> are normalized to a single space BEFORE
 * generic tag stripping, preventing words from gluing together.
 */
function stripTags(text: string): string {
  return decodeNBSPEntities(text)
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<[^>]*>/g, '')
    .replace(/\n/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Merge adjacent cues sharing the exact same start time into a single cue.
 * - Preserves source order for equal-start inputs (no sort-by-end).
 * - Joins nonempty text with a single space.
 * - Ends at max(end) of the group.
 * - Reindexes IDs after merge.
 * - Does NOT merge cues with different start times.
 */
function normalizeCues(cues: SubtitleCue[]): SubtitleCue[] {
  if (cues.length === 0) return [];

  const merged: SubtitleCue[] = [];
  let groupStart = cues[0]!.start;
  let groupEnd = cues[0]!.end;
  const groupTexts: string[] = [];
  if (cues[0]!.text.length > 0) groupTexts.push(cues[0]!.text);

  for (let i = 1; i < cues.length; i++) {
    const current = cues[i]!;
    if (current.start === groupStart) {
      // Same start time — merge into current group
      groupEnd = Math.max(groupEnd, current.end);
      if (current.text.length > 0) groupTexts.push(current.text);
    } else {
      // Different start — flush previous group
      merged.push({
        id: merged.length,
        start: groupStart,
        end: groupEnd,
        text: groupTexts.join(' '),
      });
      groupStart = current.start;
      groupEnd = current.end;
      groupTexts.length = 0;
      if (current.text.length > 0) groupTexts.push(current.text);
    }
  }

  // Flush last group
  merged.push({
    id: merged.length,
    start: groupStart,
    end: groupEnd,
    text: groupTexts.join(' '),
  });

  return merged;
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
