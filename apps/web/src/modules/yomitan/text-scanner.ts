/**
 * text-scanner — app-wide "scan Japanese text under the pointer".
 * ---------------------------------------------------------------------------
 * Faithful port of Yomitan's `text-scanner.js` input-group matching and pointer
 * event evaluation directly wired to `scanning.inputs[]`:
 *
 * - LISTEN: Pointer events (`pointerover`, `pointerdown`, `pointermove`,
 *   `pointerup`, `pointercancel`, `pointerout`, `touchmove`) on `document`,
 *   evaluated against the user's configured `scanning.inputs[]` cards via
 *   `getMatchingInputGroup` / `getMatchingInputGroupFromEvent`.
 * - EVALUATE: Matches `pointerType` (`mouse` | `touch` | `pen`), active
 *   modifiers (`ctrl`, `alt`, `shift`, `meta`), and mouse buttons
 *   (`mouse0`.. `mouse5`) against `include` and `exclude` token lists.
 *   Evaluates per-pointer-type triggers (`scanOnTouchPress`, `scanOnTouchMove`,
 *   `scanOnTouchRelease`, `scanOnTouchTap`, `minimumTouchTime`, `scanOnPenPress`,
 *   `scanOnPenRelease`, `scanOnPenMove`, `scanOnPenHover`,
 *   `scanOnPenReleaseHover`, and Mouse hover/press/release), `searchTerms` /
 *   `searchKanji`, and `preventTouchScrolling` / `preventPenScrolling`.
 * - LOCATE: `caretRangeFromPoint` turns the pointer position into a text node +
 *   offset, and up to `scanning.length` characters are taken from there.
 * - LOOK UP: `modules/yomitan/yomitan-engine` (loaded lazily on first scan).
 * - ANNOUNCE: one `yomitan:scan-result` CustomEvent on `window`, plus a trace
 *   line, and the scanned text selected when `scanning.selectText` is on.
 * ---------------------------------------------------------------------------
 */

import type {
  KanjiSummary,
  TermSummary,
} from '@/modules/yomitan/yomitan-engine';
import {
  createDefaultScanningInputs,
  isScanModifierKey,
  readOptionPath,
  readYomitanOptions,
  traceYomitan,
  type ScanModifierKey,
} from '@/modules/yomitan/yomitan-preferences';
import { isTauri } from '@/features/player/tauri-bridge';
import { readModuleState } from '@/features/modules/modules-store';
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
  /** Matched term entries, best first. Empty when nothing matched or `searchTerms` is off. */
  terms: TermSummary[];
  /** Kanji entries for the window's characters. Empty when nothing matched or `searchKanji` is off. */
  kanji: KanjiSummary[];
}

/** Scanning settings this module reads (all persisted Yomitan options). */
export interface ScanSettings {
  /** Raw `scanning.inputs[]` entries from the active profile. */
  inputs: ScanInputConfig[];
  modifierKey: ScanModifierKey;
  middleMouse: boolean;
  /** Debounce window in milliseconds (`scanning.delay`). */
  delay: number;
  /** How many characters to take from the caret (`scanning.length`). */
  length: number;
  /** Match headwords that START with the text instead of matching it whole. */
  matchTypePrefix: boolean;
  /** Look up one character at a time, or whole words. */
  scanResolution: 'character' | 'word';
  /** Re-scan while the pointer rests and the text under it changes. */
  scanWithoutMousemove: boolean;
  /** Highlight the scanned text (Yomitan's "Select text when scanning"). */
  selectText: boolean;
  /** Skip text that is covered by something else at that point. */
  layoutAwareScan: boolean;
  /**
   * Look through open shadow roots: Yomitan's `scanning.deepDomScan`.
   */
  deepContentScan: boolean;
}

/** Normalized single scanning input card (Yomitan's `InputConfig`). */
export interface ScanInputConfig {
  include: string[];
  exclude: string[];
  types: {
    mouse: boolean;
    touch: boolean;
    pen: boolean;
  };
  searchTerms: boolean;
  searchKanji: boolean;
  scanOnTouchTap: boolean;
  scanOnTouchMove: boolean;
  scanOnTouchPress: boolean;
  scanOnTouchRelease: boolean;
  scanOnPenMove: boolean;
  scanOnPenHover: boolean;
  scanOnPenReleaseHover: boolean;
  scanOnPenPress: boolean;
  scanOnPenRelease: boolean;
  preventTouchScrolling: boolean;
  preventPenScrolling: boolean;
  minimumTouchTime: number;
}

/** Resolved input group match result (`InputInfo`). */
export interface InputInfo {
  input: ScanInputConfig;
  pointerType: 'mouse' | 'touch' | 'pen';
  eventType: string;
  passive: boolean;
  modifiers: string[];
  modifierKeys: string[];
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



/** Extract active modifier tokens (`ctrl`, `alt`, `shift`, `meta`). */
export function getActiveModifiers(event: {
  altKey?: boolean;
  ctrlKey?: boolean;
  metaKey?: boolean;
  shiftKey?: boolean;
  key?: string;
  code?: string;
}): string[] {
  const modifiers: string[] = [];
  if (event.altKey) modifiers.push('alt');
  if (event.ctrlKey) modifiers.push('ctrl');
  if (event.metaKey) modifiers.push('meta');
  if (event.shiftKey) modifiers.push('shift');

  if (typeof event.key === 'string' || typeof event.code === 'string') {
    const key = event.key ?? '';
    const code = event.code ?? '';
    if (
      (code === 'AltLeft' || code === 'AltRight' || key === 'Alt') &&
      !modifiers.includes('alt')
    ) {
      modifiers.push('alt');
    }
    if (
      (code === 'ControlLeft' || code === 'ControlRight' || key === 'Control') &&
      !modifiers.includes('ctrl')
    ) {
      modifiers.push('ctrl');
    }
    if (
      (code === 'MetaLeft' || code === 'MetaRight' || key === 'Meta' || key === 'OS') &&
      !modifiers.includes('meta')
    ) {
      modifiers.push('meta');
    }
    if (
      (code === 'ShiftLeft' || code === 'ShiftRight' || key === 'Shift') &&
      !modifiers.includes('shift')
    ) {
      modifiers.push('shift');
    }
  }
  return modifiers;
}

/** Extract active buttons from a mouse/pointer bitmask (0..5 -> mouse0..mouse5). */
export function getActiveButtons(buttons: number): string[] {
  const result: string[] = [];
  if (typeof buttons === 'number' && buttons > 0) {
    for (let i = 0; i < 6; ++i) {
      const flag = 1 << i;
      if ((buttons & flag) !== 0) {
        result.push(`mouse${i}`);
      }
    }
  }
  return result;
}

/** Combine active modifier keys and mouse button tokens (Yomitan's `getActiveModifiersAndButtons`). */
export function getActiveModifiersAndButtons(event: {
  altKey?: boolean;
  ctrlKey?: boolean;
  metaKey?: boolean;
  shiftKey?: boolean;
  buttons?: number;
  key?: string;
  code?: string;
}): string[] {
  const modifiers = getActiveModifiers(event);
  if (typeof event.buttons === 'number') {
    modifiers.push(...getActiveButtons(event.buttons));
  }
  return modifiers;
}

/** Split whitespace/comma/semicolon-separated string into lowercase tokens. */
export function parseInputTokens(value: unknown): string[] {
  if (typeof value === 'string') {
    return value
      .split(/[,;\s]+/)
      .map((v) => v.trim().toLowerCase())
      .filter((v) => v.length > 0);
  }
  if (Array.isArray(value)) {
    return value
      .filter((v): v is string => typeof v === 'string')
      .map((v) => v.trim().toLowerCase())
      .filter((v) => v.length > 0);
  }
  return [];
}

/** Coerce one persisted `scanning.inputs[]` entry into `ScanInputConfig`. */
export function normalizeScanInputConfig(raw: unknown): ScanInputConfig {
  const obj =
    typeof raw === 'object' && raw !== null && !Array.isArray(raw)
      ? (raw as Record<string, unknown>)
      : {};
  const rawTypes =
    typeof obj.types === 'object' && obj.types !== null && !Array.isArray(obj.types)
      ? (obj.types as Record<string, unknown>)
      : {};
  const rawOpts =
    typeof obj.options === 'object' && obj.options !== null && !Array.isArray(obj.options)
      ? (obj.options as Record<string, unknown>)
      : {};

  const mouse = rawTypes.mouse === true;
  const touch = rawTypes.touch === true;
  const pen = rawTypes.pen === true;

  const minTouchRaw = rawOpts.minimumTouchTime;
  const minimumTouchTime =
    typeof minTouchRaw === 'number' && Number.isFinite(minTouchRaw)
      ? Math.max(0, minTouchRaw)
      : -1;

  const scanOnTouchTap = rawOpts.scanOnTouchTap === true;
  const scanOnTouchPress = rawOpts.scanOnTouchPress === true;
  const scanOnTouchRelease = rawOpts.scanOnTouchRelease === true;
  const scanOnTouchMove = rawOpts.scanOnTouchMove === true;

  return {
    include: parseInputTokens(obj.include),
    exclude: parseInputTokens(obj.exclude),
    types: {
      mouse,
      touch,
      pen,
    },
    searchTerms: rawOpts.searchTerms === true,
    searchKanji: rawOpts.searchKanji === true,
    scanOnTouchTap,
    scanOnTouchMove,
    scanOnTouchPress,
    scanOnTouchRelease,
    scanOnPenMove: rawOpts.scanOnPenMove === true,
    scanOnPenHover: rawOpts.scanOnPenHover === true,
    scanOnPenReleaseHover: rawOpts.scanOnPenReleaseHover === true,
    scanOnPenPress: rawOpts.scanOnPenPress === true,
    scanOnPenRelease: rawOpts.scanOnPenRelease === true,
    preventTouchScrolling: rawOpts.preventTouchScrolling === true,
    preventPenScrolling: rawOpts.preventPenScrolling === true,
    minimumTouchTime,
  };
}

/**
 * The cards to scan with when `scanning.inputs` is empty.
 *
 * The same pair the settings editor shows on a fresh profile
 * (`createDefaultScanningInputs` in yomitan-preferences): the host seeds them on
 * every read, so this is the fallback for a hand-built or hand-edited tree rather
 * than a second default of its own.
 */
function defaultScanInputConfigs(): ScanInputConfig[] {
  return createDefaultScanningInputs().map(normalizeScanInputConfig);
}

function setHasAll(set: Set<string>, values: string[]): boolean {
  for (const v of values) {
    if (!set.has(v)) return false;
  }
  return true;
}

/**
 * Port of Yomitan's `_getMatchingInputGroup`.
 *
 * Matches `pointerType`, required `include` tokens, and excluded `exclude` tokens.
 * Explicit `include` matches take precedence; the first card with empty `include`
 * serves as the passive fallback.
 */
export function getMatchingInputGroup(
  inputs: ScanInputConfig[],
  pointerType: 'mouse' | 'touch' | 'pen',
  eventType: string,
  modifiers: string[],
  modifierKeys: string[],
): InputInfo | null {
  let fallbackIndex = -1;
  const modifiersSet = new Set(modifiers);

  for (let i = 0; i < inputs.length; ++i) {
    const input = inputs[i];
    if (input === undefined) continue;
    const { include, exclude, types } = input;
    if (!types[pointerType]) continue;

    if (
      setHasAll(modifiersSet, include) &&
      (exclude.length === 0 || !setHasAll(modifiersSet, exclude))
    ) {
      if (include.length > 0) {
        return {
          input,
          pointerType,
          eventType,
          passive: false,
          modifiers,
          modifierKeys,
        };
      } else if (fallbackIndex < 0) {
        fallbackIndex = i;
      }
    }
  }

  if (fallbackIndex >= 0) {
    const fallbackInput = inputs[fallbackIndex];
    if (fallbackInput !== undefined) {
      return {
        input: fallbackInput,
        pointerType,
        eventType,
        passive: true,
        modifiers,
        modifierKeys,
      };
    }
  }

  return null;
}

/**
 * Resolve `InputInfo` from a Pointer/Mouse/Keyboard-like event.
 */
export function getMatchingInputGroupFromEvent(
  inputs: ScanInputConfig[],
  pointerType: 'mouse' | 'touch' | 'pen',
  eventType: string,
  event: {
    altKey?: boolean;
    ctrlKey?: boolean;
    metaKey?: boolean;
    shiftKey?: boolean;
    buttons?: number;
    key?: string;
    code?: string;
  },
): InputInfo | null {
  const modifiers = getActiveModifiersAndButtons(event);
  const modifierKeys = getActiveModifiers(event);
  return getMatchingInputGroup(inputs, pointerType, eventType, modifiers, modifierKeys);
}

/**
 * Read the scanning settings, defaulting every field independently.
 */
export function readScanSettings(
  options: Options = readYomitanOptions(),
): ScanSettings {
  const read = (path: string): unknown => readOptionPath(options, path);
  const rawInputs = read('scanning.inputs');
  const inputs: ScanInputConfig[] = Array.isArray(rawInputs)
    ? rawInputs.map(normalizeScanInputConfig)
    : [];
  if (inputs.length === 0) {
    inputs.push(...defaultScanInputConfigs());
  }

  const modifier = read('scanning.modifierKey');
  const delay = read('scanning.delay');
  const length = read('scanning.length');
  const resolution = read('scanning.scanResolution');
  return {
    inputs,
    modifierKey: isScanModifierKey(modifier) ? modifier : 'shift',
    middleMouse: read('scanning.middleMouse') === true,
    delay: typeof delay === 'number' ? delay : 20,
    length: typeof length === 'number' ? length : 16,
    matchTypePrefix: read('scanning.matchTypePrefix') === true,
    scanResolution: resolution === 'word' ? 'word' : 'character',
    scanWithoutMousemove: read('scanning.scanWithoutMousemove') === true,
    selectText: read('scanning.selectText') === true,
    layoutAwareScan: read('scanning.layoutAwareScan') !== false,
    deepContentScan: read('scanning.deepDomScan') === true,
  };
}

/**
 * Legacy modifier-only check (kept for compatibility with any direct callers).
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
 */
export function scanWindowAt(
  node: Text,
  offset: number,
  length: number,
): { text: string; offset: number; end: number } | null {
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
  return { text: full.slice(start, end), offset: start, end };
}

/** Characters a Japanese dictionary can be asked about. */
export function isScannableCharacter(character: string): boolean {
  const codePoint = character.codePointAt(0);
  if (codePoint === undefined) return false;
  return (
    (codePoint >= 0x3400 && codePoint <= 0x4dbf) ||
    (codePoint >= 0x4e00 && codePoint <= 0x9fff) ||
    (codePoint >= 0xf900 && codePoint <= 0xfaff) ||
    (codePoint >= 0x20000 && codePoint <= 0x2fa1f) ||
    (codePoint >= 0x3040 && codePoint <= 0x30ff) ||
    (codePoint >= 0x31f0 && codePoint <= 0x31ff) ||
    (codePoint >= 0xff66 && codePoint <= 0xff9f) ||
    codePoint === 0x3005 ||
    codePoint === 0x3006 ||
    codePoint === 0x3007 ||
    (codePoint >= 0x3021 && codePoint <= 0x3029) ||
    codePoint === 0x30fc
  );
}

/* ---------------------------------------------------------------------------
 * Settings read (short-lived cache)
 * ------------------------------------------------------------------------- */

interface ScanSnapshot {
  settings: ScanSettings;
  moduleEnabled: boolean;
}

const SETTINGS_CACHE_MS = 250;

let snapshotCache: { at: number; snapshot: ScanSnapshot } | null = null;

export function isYomitanModuleEnabled(): boolean {
  return readModuleState().yomitan !== false;
}

function readScanSnapshot(): ScanSnapshot {
  const now = Date.now();
  if (snapshotCache !== null && now - snapshotCache.at < SETTINGS_CACHE_MS) {
    return snapshotCache.snapshot;
  }
  const snapshot: ScanSnapshot = {
    settings: readScanSettings(),
    moduleEnabled: isYomitanModuleEnabled(),
  };
  snapshotCache = { at: now, snapshot };
  return snapshot;
}

/* ---------------------------------------------------------------------------
 * Selection (the scanning option that highlights what it read)
 * ------------------------------------------------------------------------- */

export function selectScanWindow(
  node: Text,
  offset: number,
  end: number,
): void {
  const document = globalThis.document;
  const selection = document?.getSelection();
  if (document === undefined || selection === null) return;
  const range = document.createRange();
  range.setStart(node, Math.max(0, Math.min(offset, node.data.length)));
  range.setEnd(node, Math.max(0, Math.min(end, node.data.length)));
  selection.removeAllRanges();
  selection.addRange(range);
}

/* ---------------------------------------------------------------------------
 * Layout-aware scan (skip text that is covered)
 * ------------------------------------------------------------------------- */

interface PointHitTester {
  elementFromPoint(x: number, y: number): Element | null;
}

function topmostElementAt(
  root: PointHitTester,
  x: number,
  y: number,
  deep: boolean,
): Element | null {
  let hit = root.elementFromPoint(x, y);
  while (deep && hit !== null) {
    const inner = hit.shadowRoot;
    if (inner === null || inner === undefined) break;
    const nested = inner.elementFromPoint(x, y);
    if (nested === null || nested === hit) break;
    hit = nested;
  }
  return hit;
}

export function isTopmostTextAt(
  node: Text,
  x: number,
  y: number,
  deep = false,
): boolean {
  const document = globalThis.document;
  if (typeof document?.elementFromPoint !== 'function') return true;
  const hit = topmostElementAt(document, x, y, deep);
  if (hit === null) return true;
  const owner = node.parentElement;
  if (owner === null) return true;
  return owner === hit || owner.contains(hit);
}

/* ---------------------------------------------------------------------------
 * Engine chunk (loaded on demand)
 * ------------------------------------------------------------------------- */

type YomitanEngine = typeof import('@/modules/yomitan/yomitan-engine');

let engineLoad: Promise<YomitanEngine> | null = null;

function loadEngine(): Promise<YomitanEngine> {
  if (engineLoad === null) {
    engineLoad = import('@/modules/yomitan/yomitan-engine').catch((error) => {
      engineLoad = null;
      throw error;
    });
  }
  return engineLoad;
}

/* ---------------------------------------------------------------------------
 * Installation
 * ------------------------------------------------------------------------- */

let lastKey = '';
let lastAt = 0;
let debounce: ReturnType<typeof setTimeout> | null = null;
let epoch = 0;
let lastPointer: { x: number; y: number } | null = null;
let stillFrame = 0;

/** Touch / Pen state tracking across pointer events (faithful to Yomitan). */
let touchTapValid = false;
let touchPressTime = 0;
let primaryTouchIdentifier: number | null = null;
let preventScroll = false;
let penPointerState: 0 | 1 | 2 | 3 = 0;
const pointerIdTypeMap = new Map<number, 'mouse' | 'touch' | 'pen'>();
let scanTimerResolve: ((val: boolean) => void) | null = null;
let scanTimerTimeout: ReturnType<typeof setTimeout> | null = null;
let pendingLookup = false;

function scanTimerClear(): void {
  if (scanTimerResolve !== null) {
    const resolve = scanTimerResolve;
    scanTimerResolve = null;
    if (scanTimerTimeout !== null) {
      clearTimeout(scanTimerTimeout);
      scanTimerTimeout = null;
    }
    resolve(false);
  }
}

async function scanTimerWait(delayMs: number): Promise<boolean> {
  scanTimerClear();
  return new Promise<boolean>((resolve) => {
    const timeout = setTimeout(() => {
      scanTimerTimeout = null;
      scanTimerResolve = null;
      resolve(true);
    }, Math.max(0, delayMs));
    scanTimerTimeout = timeout;
    scanTimerResolve = (val: boolean) => {
      if (scanTimerTimeout !== null) {
        clearTimeout(timeout);
        scanTimerTimeout = null;
      }
      scanTimerResolve = null;
      resolve(val);
    };
  });
}

function getPointerEventType(e: PointerEvent): 'mouse' | 'touch' | 'pen' {
  const cached = pointerIdTypeMap.get(e.pointerId);
  if (cached !== undefined) return cached;
  if (e.pointerType === 'touch' || e.pointerType === 'pen' || e.pointerType === 'mouse') {
    return e.pointerType;
  }
  return 'mouse';
}

async function runSearchAt(
  x: number,
  y: number,
  inputInfo: InputInfo,
  settings: ScanSettings,
): Promise<void> {
  if (pendingLookup) return;
  pendingLookup = true;
  try {
    await scanAt(x, y, settings, inputInfo);
  } finally {
    pendingLookup = false;
  }
}

async function runSearchAtFromMouseMove(
  x: number,
  y: number,
  inputInfo: InputInfo,
  settings: ScanSettings,
): Promise<void> {
  if (pendingLookup) return;
  if (inputInfo.passive && !(await scanTimerWait(settings.delay))) {
    return;
  }
  await runSearchAt(x, y, inputInfo, settings);
}

function isPenEventSupported(
  eventType: string,
  input: ScanInputConfig,
  currentPenState: 0 | 1 | 2 | 3,
): boolean {
  switch (eventType) {
    case 'pointerDown':
      return input.scanOnPenPress;
    case 'pointerUp':
      return input.scanOnPenRelease;
  }
  switch (currentPenState) {
    case 1:
      return input.scanOnPenHover;
    case 2:
      return input.scanOnPenMove;
    case 3:
      return input.scanOnPenReleaseHover;
    case 0:
      return false;
  }
}

/**
 * Install the pointer scanner. Returns a disposer.
 */
export function initTextScanner(): () => void {
  if (typeof window === 'undefined' || !isTauri()) return () => {};
  const document = globalThis.document;
  if (document === undefined) return () => {};

  const onPointerOver = (event: PointerEvent): void => {
    const pType = getPointerEventType(event);
    if (pType === 'pen') {
      pointerIdTypeMap.set(event.pointerId, 'pen');
    }
    if (!event.isPrimary) return;
    if (pType === 'pen') {
      penPointerState = 1;
      void handlePenEvent(event, 'pointerOver', false);
    }
  };

  const onPointerDown = (event: PointerEvent): void => {
    const pType = getPointerEventType(event);
    if (pType === 'mouse' && event.button === 0) {
      scanTimerClear();
    }
    if (!event.isPrimary) return;
    const snapshot = readScanSnapshot();
    if (!snapshot.moduleEnabled) return;

    if (pType === 'mouse') {
      const match = getMatchingInputGroupFromEvent(
        snapshot.settings.inputs,
        'mouse',
        'mouseDown',
        event,
      );
      if (match !== null && (match.input.scanOnTouchPress || event.button === 1)) {
        void runSearchAt(event.clientX, event.clientY, match, snapshot.settings);
      }
    } else if (pType === 'touch') {
      handleTouchStart(event, snapshot.settings);
    } else if (pType === 'pen') {
      penPointerState = 2;
      void handlePenEvent(event, 'pointerDown', true);
    }
  };

  const onPointerMove = (event: PointerEvent): void => {
    if (!event.isPrimary) return;
    const pType = getPointerEventType(event);
    const snapshot = readScanSnapshot();
    if (!snapshot.moduleEnabled) return;

    if (pType === 'mouse') {
      scanTimerClear();
      lastPointer = { x: event.clientX, y: event.clientY };
      const match = getMatchingInputGroupFromEvent(
        snapshot.settings.inputs,
        'mouse',
        'mouseMove',
        event,
      );
      if (match === null) return;
      void runSearchAtFromMouseMove(
        event.clientX,
        event.clientY,
        match,
        snapshot.settings,
      );
    } else if (pType === 'touch') {
      if (!preventScroll || !event.cancelable) {
        return;
      }
      touchTapValid = false;
      const match = getMatchingInputGroupFromEvent(
        snapshot.settings.inputs,
        'touch',
        'touchMove',
        event,
      );
      if (
        match === null ||
        !match.input.scanOnTouchMove
      ) {
        return;
      }
      void runSearchAt(event.clientX, event.clientY, match, snapshot.settings);
    } else if (pType === 'pen') {
      if (penPointerState === 2 && (!preventScroll || !event.cancelable)) {
        return;
      }
      void handlePenEvent(event, 'pointerMove', true);
    }
  };

  const onPointerUp = (event: PointerEvent): void => {
    if (!event.isPrimary) return;
    const pType = getPointerEventType(event);
    const snapshot = readScanSnapshot();
    if (!snapshot.moduleEnabled) return;

    if (pType === 'mouse') {
      const match = getMatchingInputGroupFromEvent(
        snapshot.settings.inputs,
        'mouse',
        'mouseUp',
        event,
      );
      if (match !== null && match.input.scanOnTouchRelease) {
        void runSearchAt(event.clientX, event.clientY, match, snapshot.settings);
      }
    } else if (pType === 'touch') {
      handleTouchEnd(event);
    } else if (pType === 'pen') {
      penPointerState = 3;
      preventScroll = false;
      void handlePenEvent(event, 'pointerUp', false);
    }
  };

  const onPointerCancel = (event: PointerEvent): void => {
    pointerIdTypeMap.delete(event.pointerId);
    if (!event.isPrimary) return;
    const pType = getPointerEventType(event);
    if (pType === 'mouse') {
      scanTimerClear();
    } else if (pType === 'touch') {
      handleTouchEnd(event, false);
    } else if (pType === 'pen') {
      penPointerState = 0;
      preventScroll = false;
    }
  };

  const onPointerOut = (event: PointerEvent): void => {
    pointerIdTypeMap.delete(event.pointerId);
    if (!event.isPrimary) return;
    const pType = getPointerEventType(event);
    if (pType === 'mouse') {
      scanTimerClear();
    } else if (pType === 'pen') {
      penPointerState = 0;
      preventScroll = false;
    }
  };

  const onTouchMove = (event: TouchEvent): void => {
    touchTapValid = false;
    if (!preventScroll) return;
    if (event.cancelable) {
      event.preventDefault();
    } else {
      preventScroll = false;
    }
  };

  const onViewportChange = (): void => {
    if (stillFrame !== 0) return;
    const snapshot = readScanSnapshot();
    if (!snapshot.moduleEnabled || !snapshot.settings.scanWithoutMousemove) return;
    stillFrame = requestAnimationFrame(() => {
      stillFrame = 0;
      if (lastPointer === null) return;
      void scanAt(lastPointer.x, lastPointer.y);
    });
  };

  document.addEventListener('pointerover', onPointerOver, { passive: true, capture: true });
  document.addEventListener('pointerdown', onPointerDown, { passive: true, capture: true });
  document.addEventListener('pointermove', onPointerMove, { passive: true, capture: true });
  document.addEventListener('pointerup', onPointerUp, { passive: true, capture: true });
  document.addEventListener('pointercancel', onPointerCancel, { passive: true, capture: true });
  document.addEventListener('pointerout', onPointerOut, { passive: true, capture: true });
  document.addEventListener('touchmove', onTouchMove, { passive: false, capture: true });
  window.addEventListener('scroll', onViewportChange, {
    passive: true,
    capture: true,
  });
  window.addEventListener('resize', onViewportChange, { passive: true });

  return () => {
    document.removeEventListener('pointerover', onPointerOver, { capture: true });
    document.removeEventListener('pointerdown', onPointerDown, { capture: true });
    document.removeEventListener('pointermove', onPointerMove, { capture: true });
    document.removeEventListener('pointerup', onPointerUp, { capture: true });
    document.removeEventListener('pointercancel', onPointerCancel, { capture: true });
    document.removeEventListener('pointerout', onPointerOut, { capture: true });
    document.removeEventListener('touchmove', onTouchMove, { capture: true });
    window.removeEventListener('scroll', onViewportChange, { capture: true });
    window.removeEventListener('resize', onViewportChange);
    if (debounce !== null) clearTimeout(debounce);
    debounce = null;
    scanTimerClear();
    if (stillFrame !== 0) cancelAnimationFrame(stillFrame);
    stillFrame = 0;
  };
}

function handleTouchStart(
  event: PointerEvent,
  settings: ScanSettings,
): void {
  preventScroll = false;
  touchTapValid = true;
  touchPressTime = Date.now();
  primaryTouchIdentifier = event.pointerId;

  if (pendingLookup) return;

  const match = getMatchingInputGroupFromEvent(
    settings.inputs,
    'touch',
    'touchStart',
    event,
  );
  if (match === null || !match.input.scanOnTouchPress) return;

  void runSearchAtFromTouchStart(
    event.clientX,
    event.clientY,
    match,
    settings,
  );
}

async function runSearchAtFromTouchStart(
  x: number,
  y: number,
  inputInfo: InputInfo,
  settings: ScanSettings,
): Promise<void> {
  const shouldPrevent = inputInfo.input.preventTouchScrolling;
  await runSearchAt(x, y, inputInfo, settings);
  preventScroll = shouldPrevent;
}

function handleTouchEnd(event: PointerEvent, allowSearch = true): void {
  if (primaryTouchIdentifier === null) return;
  primaryTouchIdentifier = null;
  preventScroll = false;
  if (!allowSearch) return;

  const releaseTime = Date.now();
  const snapshot = readScanSnapshot();
  if (!snapshot.moduleEnabled) return;

  const match = getMatchingInputGroupFromEvent(
    snapshot.settings.inputs,
    'touch',
    'touchEnd',
    event,
  );
  if (match === null) return;

  const minTime = match.input.minimumTouchTime >= 0 ? match.input.minimumTouchTime : 0;
  if (releaseTime - touchPressTime < minTime) {
    return;
  }

  if (
    match.input.scanOnTouchRelease ||
    (match.input.scanOnTouchTap && touchTapValid)
  ) {
    void runSearchAt(event.clientX, event.clientY, match, snapshot.settings);
  }
}

async function handlePenEvent(
  event: PointerEvent,
  eventType: string,
  prevent: boolean,
): Promise<void> {
  if (pendingLookup) return;
  const snapshot = readScanSnapshot();
  if (!snapshot.moduleEnabled) return;

  const match = getMatchingInputGroupFromEvent(
    snapshot.settings.inputs,
    'pen',
    eventType,
    event,
  );
  if (match === null || !isPenEventSupported(eventType, match.input, penPointerState)) {
    return;
  }

  const shouldPrevent = match.input.preventPenScrolling;
  await runSearchAt(event.clientX, event.clientY, match, snapshot.settings);
  if (prevent) {
    preventScroll = shouldPrevent;
  }
}

/**
 * Look up whatever Japanese text sits under `(x, y)` and announce it.
 */
export async function scanAt(
  x: number,
  y: number,
  settings: ScanSettings = readScanSettings(),
  explicitInputInfo?: InputInfo,
): Promise<YomitanScanResultDetail | null> {
  const snap = readScanSnapshot();
  if (!snap.moduleEnabled) return null;

  let searchTerms = true;
  let searchKanji = true;

  if (explicitInputInfo !== undefined) {
    searchTerms = explicitInputInfo.input.searchTerms;
    searchKanji = explicitInputInfo.input.searchKanji;
  } else {
    const fallbackMatch = getMatchingInputGroupFromEvent(
      settings.inputs,
      'mouse',
      'mouseMove',
      { buttons: 0 },
    );
    if (fallbackMatch !== null) {
      searchTerms = fallbackMatch.input.searchTerms;
      searchKanji = fallbackMatch.input.searchKanji;
    }
  }

  if (!searchTerms && !searchKanji) {
    return null;
  }

  const point = caretPointAt(x, y);
  if (point === null) return null;

  if (
    settings.layoutAwareScan &&
    !isTopmostTextAt(point.node, x, y, settings.deepContentScan)
  ) {
    return null;
  }

  const windowed = scanWindowAt(point.node, point.offset, settings.length);
  if (windowed === null) return null;

  const key = `${windowed.offset}:${windowed.text}`;
  const now = Date.now();
  if (key === lastKey && now - lastAt < 1000) return null;
  lastKey = key;
  lastAt = now;

  const current = ++epoch;
  try {
    const { lookupKanji, lookupTerms, summarizeKanjiEntry, summarizeTermEntry } =
      await loadEngine();
    if (current !== epoch) return null;

    const [terms, kanji] = await Promise.all([
      searchTerms
        ? lookupTerms(windowed.text, {
            matchType: settings.matchTypePrefix ? 'prefix' : 'exact',
            searchResolution: settings.scanResolution === 'word' ? 'word' : 'letter',
          })
        : Promise.resolve([]),
      searchKanji ? lookupKanji(windowed.text) : Promise.resolve([]),
    ]);
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
      traceYomitan('scan_miss', {
        text: detail.text,
        matchType: settings.matchTypePrefix ? 'prefix' : 'exact',
      });
      return detail;
    }
    if (settings.selectText) {
      selectScanWindow(point.node, windowed.offset, windowed.end);
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
