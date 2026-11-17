/**
 * query-parser — the furigana header above the search results (`/search/`).
 * ---------------------------------------------------------------------------
 * WHAT THIS IS. Upstream's search page does not only look a query up: it PARSES
 * the text in the box and draws it again underneath, word by word, with a reading
 * over every segment (`ext/search.html` → `#query-parser-container` /
 * `#query-parser-content`, drawn by `ext/js/display/query-parser.js` from what the
 * backend's `_textParseScanning` produced). Typing a sentence therefore shows the
 * sentence, segmented, and clicking a word there looks THAT word up.
 *
 * This module is that page element's two halves, kept out of the React island so
 * they can be asserted without one:
 *
 * - the SETTINGS read (`readQueryParserSettings`) — `parsing.enableScanningParser`,
 *   `parsing.termSpacing`, `parsing.readingMode` and the scan window
 *   (`scanning.length`, which upstream passes on as `scanLength`);
 * - the MARKUP (`renderQueryParser` / `renderQueryParserPreview`) and the one
 *   decision a click needs (`queryParserOffsetAt` + `queryParserQueryAt`).
 *
 * The PARSING itself is the engine's (`yomitan-engine.parseTextScanning`, the port
 * of `_textParseScanning`): this module never touches the dictionary database.
 *
 * UPSTREAM'S OWN CLASS NAMES, so `public/yomitan/css/display.css` styles the header
 * without a rule of ours: `#query-parser-container`, `#query-parser-content`,
 * `.query-parser-term`, `.query-parser-segment` (`<ruby>`),
 * `.query-parser-segment-text` and `.query-parser-segment-reading` (`<rt>`).
 * ---------------------------------------------------------------------------
 */

import {
  convertHiraganaToKatakana,
  convertKatakanaToHiragana,
  isStringEntirelyKana,
} from '@gorakudo/yomitan-headless';
import type { ProfileOptions, ReadingMode } from '@gorakudo/yomitan-headless/settings';
import { convertToRomaji } from '@/modules/yomitan/vendor/js/language/ja/japanese-wanakana.js';
import { caretPointAt } from '@/modules/yomitan/text-scanner';
import type { TermParseLine, TermParseSegment } from '@/modules/yomitan/yomitan-engine';

/**
 * What the header needs to know about the persisted options.
 *
 * Four fields, because four options decide what is drawn: the parser switch, the
 * gap between terms, the reading's alphabet, and how much text one dictionary
 * window covers (which is also how far a click looks ahead).
 */
export interface QueryParserSettings {
  /** `parsing.enableScanningParser` — parse at all, or only echo the text. */
  enabled: boolean;
  /** `parsing.termSpacing` — a small gap after every parsed term. */
  termSpacing: boolean;
  /** `parsing.readingMode` — what the ruby says. */
  readingMode: ReadingMode;
  /** `scanning.length` — characters per dictionary window. */
  scanLength: number;
}

/**
 * Upstream's own defaults for the four fields
 * (`createDefaultParsingOptions` / `createDefaultScanningOptions`).
 *
 * The fallback for a profile that cannot be read: the header still parses, in
 * hiragana, which is what a fresh install does. A scan length below one is the
 * same case — a zero-length window would parse nothing at all, so the shipped
 * default is used instead of the window the tree asks for.
 */
export const DEFAULT_QUERY_PARSER_SETTINGS: QueryParserSettings = {
  enabled: true,
  termSpacing: true,
  readingMode: 'hiragana',
  scanLength: 10,
};

/** The four options of one profile, coerced (a hand-built tree must not throw). */
export function readQueryParserSettings(
  profile: ProfileOptions,
): QueryParserSettings {
  const parsing = profile.parsing;
  const length = profile.scanning.length;
  return {
    enabled: parsing.enableScanningParser !== false,
    termSpacing: parsing.termSpacing !== false,
    readingMode: parsing.readingMode,
    scanLength:
      typeof length === 'number' && Number.isFinite(length) && length >= 1
        ? Math.floor(length)
        : DEFAULT_QUERY_PARSER_SETTINGS.scanLength,
  };
}

/**
 * The reading as it is drawn — upstream's `QueryParser._convertReading`.
 *
 * `romaji` needs the transliteration table, which is only worth importing for
 * itself, so it is the one branch that reaches for the vendored module (the same
 * one the search box's own romaji → kana conversion uses). `dictionary-reading`
 * is upstream's `default:` case: the reading as the dictionary wrote it.
 */
export function convertSegmentReading(
  term: string,
  reading: string,
  mode: ReadingMode,
): string {
  switch (mode) {
    case 'hiragana':
      return convertKatakanaToHiragana(reading);
    case 'katakana':
      return convertHiraganaToKatakana(reading);
    case 'romaji':
      if (reading.length > 0) return convertToRomaji(reading);
      return isStringEntirelyKana(term) ? convertToRomaji(term) : reading;
    case 'none':
      return '';
    default:
      return reading;
  }
}

/**
 * Trailing whitespace of one segment, trimmed and condensed — upstream's
 * `trimTrailingWhitespacePlusSpace` (`ext/js/data/string-util.js`).
 *
 * Not vendored here, and not `trimEnd()`: a segment that ends in whitespace keeps
 * ONE space (so words stay separated once the gap is trimmed away), while trailing
 * newlines collapse into one rather than into a space. Only the LAST segment of a
 * parse is trimmed with `trimEnd()` instead, which is upstream's own split.
 */
function trimTrailingWhitespacePlusSpace(text: string): string {
  return text.replaceAll(/(\n+$|^\n+)/g, '\n').replaceAll(/[^\S\n]+$/g, ' ');
}

/** The trimmed text of one segment (last segment of the parse: `trimEnd`). */
function segmentText(text: string, isLast: boolean): string {
  return isLast ? text.trimEnd() : trimTrailingWhitespacePlusSpace(text);
}

/** One `<ruby class="query-parser-segment">` with its reading. */
function createSegment(text: string, reading: string, offset: number): HTMLElement {
  const segment = document.createElement('ruby');
  segment.className = 'query-parser-segment';

  const textNode = document.createElement('span');
  textNode.className = 'query-parser-segment-text';
  // The offset is what a click is resolved against (see `queryParserOffsetAt`),
  // and upstream's own `_getSentenceOffset` reads it back off this element.
  textNode.dataset.offset = `${offset}`;

  const readingNode = document.createElement('rt');
  readingNode.className = 'query-parser-segment-reading';

  segment.append(textNode, readingNode);
  textNode.textContent = text;
  readingNode.textContent = reading;
  return segment;
}

/**
 * Parsed lines → the header's markup — upstream's `QueryParser._createParseResult`.
 *
 * Every term becomes a `.query-parser-term` span carrying the offset it starts at;
 * inside it, a segment with no reading is plain text and one with a reading is a
 * `<ruby>`. Offsets keep counting ACROSS terms, because a click anywhere in the
 * header is resolved against the whole text.
 */
export function renderQueryParser(
  lines: readonly TermParseLine[],
  settings: QueryParserSettings,
): DocumentFragment {
  let offset = 0;
  const fragment = document.createDocumentFragment();
  for (let i = 0; i < lines.length; i++) {
    const segments: readonly TermParseSegment[] = lines[i] ?? [];
    const termNode = document.createElement('span');
    termNode.className = 'query-parser-term';
    termNode.dataset.offset = `${offset}`;
    const isLastTerm = i === lines.length - 1;
    for (const segment of segments) {
      const text = segmentText(segment.text, isLastTerm);
      if (segment.reading.length === 0) {
        termNode.append(document.createTextNode(text));
      } else {
        termNode.append(
          createSegment(
            text,
            convertSegmentReading(text, segment.reading, settings.readingMode),
            offset,
          ),
        );
      }
      offset += text.length;
    }
    fragment.append(termNode);
  }
  return fragment;
}

/**
 * The text as typed, with no readings — upstream's `QueryParser._setPreview`.
 *
 * What is on screen from the first keystroke until the parse answers (and what
 * stays there while the scanning parser is switched off), so the header never
 * blinks empty mid-sentence.
 */
export function renderQueryParserPreview(text: string): DocumentFragment {
  const fragment = document.createDocumentFragment();
  const termNode = document.createElement('span');
  termNode.className = 'query-parser-term';
  termNode.dataset.offset = '0';
  termNode.textContent = text.trimEnd();
  fragment.append(termNode);
  return fragment;
}

/**
 * Whether one node belongs to a reading (`<rt>`) rather than to the header's text.
 *
 * An `<rt>` contributes its reading to `textContent` and NOTHING to the offsets, so
 * a caret inside one must not be counted — clicking a reading resolves to the
 * segment it is written over.
 */
function isReadingNode(node: Node): boolean {
  const element = node.nodeType === Node.ELEMENT_NODE ? (node as Element) : node.parentElement;
  return element !== null && element.closest('rt, .query-parser-segment-reading') !== null;
}

/**
 * How far into `holder`'s own text the caret landed, or `null` when it is not there.
 *
 * A `data-offset` names where its element's FIRST character sits, so the caret's
 * offset inside the text node under the pointer only becomes the header's offset
 * once the text in between is counted: a `.query-parser-term` carries the offset of
 * its first segment, and a term's plain text after a `<ruby>` is a text node of the
 * TERM rather than of a segment. Readings are skipped (see `isReadingNode`).
 *
 * `null` for a caret outside the holder's own text — on a reading, or on an element
 * with no text at all — which leaves the holder's offset as the answer.
 */
function caretOffsetWithin(holder: Element, node: Text, offset: number): number | null {
  let total = 0;
  const walk = (parent: Node): number | null => {
    for (const child of Array.from(parent.childNodes)) {
      if (child === node) return total + offset;
      if (isReadingNode(child)) continue;
      if (child.nodeType === Node.TEXT_NODE) {
        total += child.textContent?.length ?? 0;
        continue;
      }
      const found = walk(child);
      if (found !== null) return found;
    }
    return null;
  };
  return walk(holder);
}

/**
 * The offset the pointer landed on, or `null` for a click outside any term.
 *
 * Reads the NEAREST offset, which is upstream's own resolution: `.query-parser-term`
 * carries the offset its first segment starts at, and every `.query-parser-segment-text`
 * carries its own, so a click on the base text of a ruby word names that segment
 * while a click on the term's plain text names the term.
 *
 * `clientX` / `clientY` refine that by the CHARACTER the pointer is actually over
 * (`caretPointAt`, the same resolution the text scanner uses): the holder's offset
 * plus how far into its text the caret landed. Without them — a keyboard-generated
 * click, a test — the holder's own offset is the answer, which is upstream's
 * behaviour for a click that lands on padding rather than on a character.
 */
export function queryParserOffsetAt(
  container: Element,
  target: Element | null,
  clientX?: number,
  clientY?: number,
): number | null {
  if (target === null) return null;
  const holder = target.closest('[data-offset]');
  if (holder === null || !container.contains(holder)) return null;
  const start = Number.parseInt(holder.getAttribute('data-offset') ?? '', 10);
  if (!Number.isFinite(start)) return null;
  const base = Math.max(0, start);
  if (clientX === undefined || clientY === undefined) return base;
  const point = caretPointAt(clientX, clientY);
  if (point === null) return base;
  const within = caretOffsetWithin(holder, point.node, point.offset);
  return within === null ? base : base + within;
}

/**
 * The text a click looks up — upstream's scan window.
 *
 * Upstream hands the clicked position to its `TextScanner`, which looks up to
 * `scanning.length` characters FROM that position (so a click on the stem of an
 * inflected word still resolves through the deinflector). This is that slice, taken
 * from the text the header was parsed from — the search box is deliberately left
 * alone, so the sentence stays where the user typed it.
 */
export function queryParserQueryAt(
  text: string,
  offset: number,
  scanLength: number,
): string {
  return text.substring(offset, offset + Math.max(1, scanLength));
}