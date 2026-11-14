/**
 * text-scanner — app-wide "scan Japanese text under the pointer".
 * ---------------------------------------------------------------------------
 * Yomitan's own `TextScanner` is bound to its extension runtime (popup frames,
 * message passing, its own options store). This is the host's equivalent, and it
 * is deliberately small:
 *
 * - LISTEN: `pointermove` on `document`, gated by the scan modifier the user
 *   picked (`scanning.modifierKey`) and the middle-mouse option
 *   (`scanning.middleMouse`). No modifier held → no work at all, so a page of
 *   Japanese costs nothing until the user asks for it.
 * - LOCATE: `caretRangeFromPoint` turns the pointer position into a text node +
 *   offset, and up to `scanning.length` characters are taken from there — the
 *   same forward-only window Yomitan scans.
 * - LOOK UP: `features/yomitan/yomitan-engine` (deinflection + dictionary merge).
 * - ANNOUNCE: one `yomitan:scan-result` CustomEvent on `window`, plus a trace
 *   line. Drawing the result is a separate concern (a popup component), so this
 *   module has no UI and can run on every page.
 *
 * Two guards keep it cheap: a debounce (`scanning.delay`) and a repeat guard —
 * moving within the same word re-uses the last answer instead of asking the
 * engine again.
 * ---------------------------------------------------------------------------
 */

import {
  lookupKanji,
  lookupTerms,
  summarizeKanjiEntry,
  summarizeTermEntry,
  type KanjiSummary,
  type TermSummary,
} from '@/features/yomitan/yomitan-engine';
import {
  isScanModifierKey,
  readOptionPath,
  readYomitanOptions,
  traceYomitan,
  type ScanModifierKey,
} from '@/features/yomitan/yomitan-preferences';
import { isTauri } from '@/features/player/tauri-bridge';
import type { Options } from '@gorakudo/yomitan-headless/settings';

/* The knob's own type and guard live with the option paths that persist them
   (yomitan-preferences); re-exported so a scanner consumer needs one import. */
export { isScanModifierKey, type ScanModifierKey };

/** Event the scan result is published on (`window`), once per scanned word. */
export const YOMITAN_SCAN_RESULT_EVENT = 'yomitan:scan-result';

/** Payload of [`YOMITAN_SCAN_RESULT_EVENT`]. */
export interface YomitanScanResultDetail {
  /** The text that was looked up (already windowed to `scanning.length`). */
  text: string;
  /** Where `text` starts in the scanned element (caret offset of the window). */
  offset: number;
  /** Matched term entries, best first. Empty when nothing matched. */
  terms: TermSummary[];
  /** Kanji entries for the window's characters. */
  kanji: KanjiSummary[];
}

/** Scanning settings this module reads (all persisted Yomitan options). */
export interface ScanSettings {
  modifierKey: ScanModifierKey;
  middleMouse: boolean;
  /** Debounce window in milliseconds (`scanning.delay`). */
  delay: number;
  /** How many characters to take from the caret (`scanning.length`). */
  length: number;
}

/**
 * Read the scanning settings, defaulting every field independently.
 *
 * The fallbacks are Yomitan's own shipped values, so a hand-built options tree
 * (a test, a caller that has not hydrated yet) scans like a fresh install.
 */
export function readScanSettings(
  options: Options = readYomitanOptions(),
): ScanSettings {
  const read = (path: string): unknown => readOptionPath(options, path);
  const modifier = read('scanning.modifierKey');
  const delay = read('scanning.delay');
  const length = read('scanning.length');
  return {
    modifierKey: isScanModifierKey(modifier) ? modifier : 'shift',
    middleMouse: read('scanning.middleMouse') === true,
    delay: typeof delay === 'number' ? delay : 20,
    length: typeof length === 'number' ? length : 16,
  };
}

/** The pointer/keyboard state a scan decision is made from. */
export interface ScanInputState {
  shiftKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  metaKey: boolean;
  /** Held buttons as a bitmask (`PointerEvent.buttons`). */
  buttons: number;
}

/**
 * Whether one pointer event should produce a scan. Pure, so the rule is
 * testable without a DOM.
 *
 * Three conditions, in the order they cost:
 * - the chosen modifier must be held (holding nothing is not a scan unless the
 *   user picked "none"),
 * - the middle button must not be held unless the user allowed it (Yomitan's
 *   `preventMiddleMouse` default),
 * - the PRIMARY button must not be held: a drag is a text selection, and
 *   scanning while the user selects is what Yomitan's default `exclude: 'mouse0'`
 *   exists for.
 */
export function shouldScanInput(
  state: ScanInputState,
  settings: ScanSettings,
): boolean {
  switch (settings.modifierKey) {
    case 'none':
      break;
    case 'shift':
      if (!state.shiftKey) return false;
      break;
    case 'ctrl':
      if (!state.ctrlKey) return false;
      break;
    case 'alt':
      if (!state.altKey) return false;
      break;
    case 'meta':
      if (!state.metaKey) return false;
      break;
  }
  if (!settings.middleMouse && (state.buttons & 4) !== 0) return false;
  if ((state.buttons & 1) !== 0) return false;
  return true;
}

/** Where the pointer is inside the page's text. */
export interface ScanPoint {
  /** Text node under the pointer. */
  node: Text;
  /** Caret offset inside `node`. */
  offset: number;
}

/**
 * The text node and offset under `(x, y)`, or `null` when the pointer is not
 * over text (an image, a gap, a scrollbar).
 *
 * `caretRangeFromPoint` is the Chromium/WebView2 answer; the Firefox-shaped
 * `caretPositionFromPoint` is tried second so the scanner is not silently dead on
 * a non-Chromium webview.
 */
export function caretPointAt(x: number, y: number): ScanPoint | null {
  const document = globalThis.document;
  if (document === undefined) return null;

  const asRange = (
    document as Document & {
      caretRangeFromPoint?: (x: number, y: number) => Range | null;
    }
  ).caretRangeFromPoint;
  if (typeof asRange === 'function') {
    const range = asRange.call(document, x, y);
    if (range === null || range.startContainer.nodeType !== Node.TEXT_NODE) {
      return null;
    }
    return { node: range.startContainer as Text, offset: range.startOffset };
  }

  const asPosition = (
    document as Document & {
      caretPositionFromPoint?: (
        x: number,
        y: number,
      ) => { offsetNode: Node; offset: number } | null;
    }
  ).caretPositionFromPoint;
  if (typeof asPosition === 'function') {
    const position = asPosition.call(document, x, y);
    if (
      position === null ||
      position.offsetNode === null ||
      position.offsetNode.nodeType !== Node.TEXT_NODE
    ) {
      return null;
    }
    return { node: position.offsetNode as Text, offset: position.offset };
  }

  return null;
}

/**
 * The Japanese window to look up: up to `length` characters from the caret.
 *
 * Only characters the dictionary can use are taken (kanji, kana, and the
 * iteration/part marks that inflect them), so a Latin UI label under the pointer
 * produces an empty string rather than a pointless lookup.
 */
export function scanWindowAt(
  node: Text,
  offset: number,
  length: number,
): { text: string; offset: number } | null {
  const full = node.data;
  const start = Math.max(0, Math.min(offset, full.length));
  let end = start;
  let taken = 0;
  for (const character of full.slice(start)) {
    if (taken >= length) break;
    if (!isScannableCharacter(character)) break;
    end += character.length;
    taken += 1;
  }
  if (end === start) return null;
  return { text: full.slice(start, end), offset: start };
}

/** Characters a Japanese dictionary can be asked about. */
export function isScannableCharacter(character: string): boolean {
  const codePoint = character.codePointAt(0);
  if (codePoint === undefined) return false;
  return (
    // CJK unified ideographs + extensions and compatibility ideographs
    (codePoint >= 0x3400 && codePoint <= 0x4dbf) ||
    (codePoint >= 0x4e00 && codePoint <= 0x9fff) ||
    (codePoint >= 0xf900 && codePoint <= 0xfaff) ||
    (codePoint >= 0x20000 && codePoint <= 0x2fa1f) ||
    // Hiragana, katakana, katakana phonetic extensions, half-width kana
    (codePoint >= 0x3040 && codePoint <= 0x30ff) ||
    (codePoint >= 0x31f0 && codePoint <= 0x31ff) ||
    (codePoint >= 0xff66 && codePoint <= 0xff9f) ||
    // 々 (iteration mark) and 〆 ヶ ヵ
    codePoint === 0x3005 ||
    codePoint === 0x3006 ||
    codePoint === 0x3007 ||
    (codePoint >= 0x3021 && codePoint <= 0x3029) ||
    // ー (prolonged sound mark)
    codePoint === 0x30fc
  );
}

/* ---------------------------------------------------------------------------
 * Settings read (short-lived cache)
 * ------------------------------------------------------------------------- */

/**
 * How long one settings read answers the pointer for.
 *
 * The gate is checked on EVERY pointer move, and the persisted options are a
 * JSON blob: re-parsing it per event is pure waste on the one path this module
 * has to keep cheap. A quarter second is below the time it takes to press a
 * modifier and move onto a word, so a settings edit still applies immediately in
 * practice.
 */
const SETTINGS_CACHE_MS = 250;

let settingsCache: { at: number; settings: ScanSettings } | null = null;

/** Scanning settings for a pointer event (cached, see `SETTINGS_CACHE_MS`). */
function readScanSettingsCached(): ScanSettings {
  const now = Date.now();
  if (settingsCache !== null && now - settingsCache.at < SETTINGS_CACHE_MS) {
    return settingsCache.settings;
  }
  const settings = readScanSettings();
  settingsCache = { at: now, settings };
  return settings;
}

/* ---------------------------------------------------------------------------
 * Installation
 * ------------------------------------------------------------------------- */

/** How long a scan result stays valid for the repeat guard below. */
let lastKey = '';
let lastAt = 0;
let debounce: ReturnType<typeof setTimeout> | null = null;
let epoch = 0;

/**
 * Install the pointer scanner. Returns a disposer.
 *
 * A no-op outside the desktop app: the dictionary banks live in the Tauri plugin,
 * so a browser build has nothing to look up and must not attach listeners that
 * can only fail.
 */
export function initTextScanner(): () => void {
  if (typeof window === 'undefined' || !isTauri()) return () => {};
  const document = globalThis.document;
  if (document === undefined) return () => {};

  const onPointerMove = (event: PointerEvent): void => {
    const settings = readScanSettingsCached();
    if (!shouldScanInput(event, settings)) return;
    if (debounce !== null) clearTimeout(debounce);
    // The position is captured now: the debounced run must scan where the
    // pointer WAS, and `event` is not safe to read later.
    const { clientX: x, clientY: y } = event;
    debounce = setTimeout(() => {
      debounce = null;
      void scanAt(x, y, settings);
    }, Math.max(0, settings.delay));
  };

  const onPointerDown = (event: PointerEvent): void => {
    // Middle mouse is a scan trigger only when the user asked for it: with the
    // option off the button belongs to the browser (autoscroll) and to the page.
    if (event.button !== 1) return;
    const settings = readScanSettingsCached();
    if (!settings.middleMouse) return;
    void scanAt(event.clientX, event.clientY, settings);
  };

  document.addEventListener('pointermove', onPointerMove, { passive: true });
  document.addEventListener('pointerdown', onPointerDown, { passive: true });
  return () => {
    document.removeEventListener('pointermove', onPointerMove);
    document.removeEventListener('pointerdown', onPointerDown);
    if (debounce !== null) clearTimeout(debounce);
    debounce = null;
  };
}

/**
 * Look up whatever Japanese text sits under `(x, y)` and announce it.
 *
 * Exported so an explicit "scan here" gesture (a click, a keyboard cursor) can
 * reuse the same pipeline instead of a second copy of it.
 */
export async function scanAt(
  x: number,
  y: number,
  settings: ScanSettings = readScanSettings(),
): Promise<YomitanScanResultDetail | null> {
  const point = caretPointAt(x, y);
  if (point === null) return null;
  const windowed = scanWindowAt(point.node, point.offset, settings.length);
  if (windowed === null) return null;

  // Same window as the last answer: nothing new to ask. `offset` is part of the
  // key because the same word hit at another caret yields another window.
  const key = `${windowed.offset}:${windowed.text}`;
  const now = Date.now();
  if (key === lastKey && now - lastAt < 1000) return null;
  lastKey = key;
  lastAt = now;

  const current = ++epoch;
  try {
    const [terms, kanji] = await Promise.all([
      lookupTerms(windowed.text, { matchType: 'exact' }),
      lookupKanji(windowed.text),
    ]);
    // A newer scan started while these were in flight: its answer supersedes.
    if (current !== epoch) return null;

    const detail: YomitanScanResultDetail = {
      text: windowed.text,
      offset: windowed.offset,
      terms: terms
        .map(summarizeTermEntry)
        .filter((entry): entry is TermSummary => entry !== null),
      kanji: kanji
        .map(summarizeKanjiEntry)
        .filter((entry): entry is KanjiSummary => entry !== null),
    };
    if (detail.terms.length === 0 && detail.kanji.length === 0) {
      traceYomitan('scan_miss', { text: detail.text });
      return detail;
    }
    traceYomitan('scan_hit', {
      text: detail.text,
      terms: detail.terms.length,
      kanji: detail.kanji.length,
    });
    window.dispatchEvent(
      new CustomEvent<YomitanScanResultDetail>(YOMITAN_SCAN_RESULT_EVENT, {
        detail,
      }),
    );
    return detail;
  } catch (error) {
    traceYomitan('scan_failed', { text: windowed.text, error });
    return null;
  }
}