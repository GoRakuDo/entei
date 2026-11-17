/**
 * yomitan-preferences — persisted Yomitan `Options` for the Entei host.
 * ---------------------------------------------------------------------------
 * The settings tree (`@gorakudo/yomitan-headless/settings`) is pure data and
 * the store is pure logic; PERSISTENCE is the host's job. This is that job:
 *
 * - Desktop (Tauri): `entei.yomitan.options.v1` in the embedded SQLite
 *   `kv_store` is the durable source of truth. localStorage is the synchronous
 *   cache every read uses (same hybrid shape as every other settings feature,
 *   see features/settings/settings-store.ts) and is seeded from the DB by
 *   `initSettingsSync()`.
 * - Browser: localStorage only.
 *
 * Writes are debounced (one localStorage write per burst) because the settings
 * renderer autosaves on every keystroke; a burst of `a`, `ab`, `abc` persists
 * once instead of three times.
 *
 * Field access is DOT-PATH against the ACTIVE PROFILE (`general.enable`,
 * `anki.server`, …) so the renderer never needs to know where in the root
 * `Options` object a descriptor key points. Root-level keys (`profileCurrent`,
 * `global.*`) address the root directly.
 * ---------------------------------------------------------------------------
 */

import {
  createDefaultOptions,
  createDefaultProfileOptions,
  type Options,
  type ProfileOptions,
  type ScanningInput,
} from '@gorakudo/yomitan-headless/settings';
import { dbKvGet, dbKvSet, isTauri } from '@/features/player/tauri-bridge';
import { traceModule, type TraceData } from '@/features/trace/trace-logger';

/**
 * Host-locked option paths — never rendered, never user-editable.
 *
 * Yomitan lives as an Entei module: the switch on the Modules page is its
 * master switch (so `general.enable` is always on), dictionary lookups are
 * Japanese-only in this host (`general.language` is pinned to `ja`), the
 * Chrome-extension onboarding guide does not exist here (`general.showGuide`
 * stays off), and this host always runs with the advanced + debug surfaces
 * enabled (`general.showAdvanced` / `general.showDebug` are pinned on) while
 * their toggles are removed from the settings UI — there is nothing for the
 * user to decide there. Every read forces these values, so even a hand-edited
 * payload cannot smuggle a different one in.
 *
 * The last block is the two prevent families (Yomitan's middle-click autoscroll
 * and back/forward gesture suppression, which belong to a browser toolbar, not to
 * this app): they stay locked in the persisted tree — Yomitan's own shape — and
 * the scanning section never offers them.
 *
 * `scanning.deepDomScan` used to be locked with them. It is a real option now:
 * the host's text scanner pierces open shadow roots when it is on, because
 * `document.elementFromPoint` answers with the shadow HOST and would otherwise
 * report text inside a component as "covered" (see modules/yomitan/
 * text-scanner.ts). `scanning.normalizeCssZoom` is persisted for tree fidelity
 * only — the host locates text with the browser's own caret API, which already
 * resolves CSS `zoom`, so there is no second coordinate space to normalise here.
 */
export const LOCKED_OPTION_PATHS: Readonly<Record<string, unknown>> = {
  'general.enable': true,
  'general.language': 'ja',
  'general.showGuide': false,
  'general.showAdvanced': true,
  'general.showDebug': true,
  'scanning.preventMiddleMouse.onTextHover': false,
  'scanning.preventMiddleMouse.onWebPages': false,
  'scanning.preventMiddleMouse.onPopupPages': false,
  'scanning.preventMiddleMouse.onSearchPages': false,
  'scanning.preventMiddleMouse.onSearchQuery': false,
  'scanning.preventBackForward.onTextHover': false,
  'scanning.preventBackForward.onWebPages': false,
  'scanning.preventBackForward.onPopupPages': false,
  'scanning.preventBackForward.onSearchPages': false,
  'scanning.preventBackForward.onSearchQuery': false,
};

/** True for a path the host owns (renderer skips it, writes are refused). */
export function isLockedOptionPath(path: string): boolean {
  return Object.hasOwn(LOCKED_OPTION_PATHS, path);
}

/* ---------------------------------------------------------------------------
 * Scanning: the two knobs this host exposes as one value each
 * ---------------------------------------------------------------------------
 * Yomitan models a scan trigger as a LIST of inputs: `scanning.inputs[]`, each
 * an `{include, exclude}` pair of tokens (`shift`, `ctrl`, `mouse1`, …) plus
 * per-pointer-type flags. That is the right model for an extension that has to
 * serve mice, pens and touch at once; it is a poor fit for a settings ROW.
 *
 * So the host exposes two VIRTUAL paths over the first input —
 * `scanning.modifierKey` (`none` | `shift` | `ctrl` | `alt` | `meta`) and
 * `scanning.middleMouse` (is the middle button a trigger) — and translates them
 * into that one entry's `include` on the way in and out. Nothing else in the
 * input list is touched, and the persisted tree stays exactly what Yomitan's own
 * shape says, so a hand-edited `inputs` array still reads back correctly.
 *
 * Only the MODIFIER is a settings row (the Scanning section's simple one). The
 * middle-button path stays as the scanner's own read of `mouse2` in that same
 * `include` — the advanced scan-input cards are what writes it now, alongside
 * every other token, so the knob keeps working without a switch of its own.
 * ------------------------------------------------------------------------- */

/** The scan-modifier knob's values (also what the settings select offers). */
export type ScanModifierKey = 'none' | 'shift' | 'ctrl' | 'alt' | 'meta';

/** Type guard for a persisted / rendered modifier value (untrusted input). */
export function isScanModifierKey(value: unknown): value is ScanModifierKey {
  return (
    value === 'none' ||
    value === 'shift' ||
    value === 'ctrl' ||
    value === 'alt' ||
    value === 'meta'
  );
}

/** Dot-path of the real field the two virtual paths write into. */
const SCAN_INPUTS_PATH = 'scanning.inputs';
/** Virtual: the scan modifier as one value. */
export const SCAN_MODIFIER_KEY_PATH = 'scanning.modifierKey';
/** Virtual: whether the middle mouse button is a scan trigger. */
export const SCAN_MIDDLE_MOUSE_PATH = 'scanning.middleMouse';

/**
 * The scan-input cards this host ships with (its module defaults).
 *
 * Yomitan's own pair is one mouse-hover card plus one passive card serving touch
 * AND pen; this host ships two single-purpose cards instead, because the settings
 * editor writes exactly one pointer type per card:
 *
 * - Desktop: hold `shift`, ignore the left button, scan while the mouse MOVES.
 * - Android / touch: no modifier, scan when the finger LIFTS, and only after it
 *   has been down for 180 ms so a scroll gesture never scans.
 *
 * Both keep Yomitan's term+kanji search and stop a scan while a scroll gesture is
 * in flight (`preventTouchScrolling` / `preventPenScrolling`). The pen flags are
 * off on both: a card serves one pointer type, and the pen's own card is what the
 * user adds when they want one.
 *
 * A factory, not a constant: every profile gets its own copy, so a card edited in
 * one profile can never be seen through another.
 *
 * Note: `preventTouchScrolling` is read on the touch PRESS path only (faithful to
 * Yomitan), so the touch card above — release-only — does not act on it until the
 * user also turns on a press/move trigger.
 */
export function createDefaultScanningInputs(): ScanningInput[] {
  return [
    {
      include: 'shift',
      exclude: 'mouse0',
      types: { mouse: true, touch: false, pen: false },
      options: {
        showAdvanced: false,
        searchTerms: true,
        searchKanji: true,
        scanOnTouchTap: false,
        scanOnTouchMove: true,
        scanOnTouchPress: false,
        scanOnTouchRelease: false,
        scanOnPenMove: false,
        scanOnPenHover: false,
        scanOnPenReleaseHover: false,
        scanOnPenPress: false,
        scanOnPenRelease: false,
        preventTouchScrolling: true,
        preventPenScrolling: true,
        minimumTouchTime: 0,
      },
    },
    {
      include: '',
      exclude: '',
      types: { mouse: false, touch: true, pen: false },
      options: {
        showAdvanced: false,
        searchTerms: true,
        searchKanji: true,
        scanOnTouchTap: false,
        scanOnTouchMove: false,
        scanOnTouchPress: false,
        scanOnTouchRelease: true,
        scanOnPenMove: false,
        scanOnPenHover: false,
        scanOnPenReleaseHover: false,
        scanOnPenPress: false,
        scanOnPenRelease: false,
        preventTouchScrolling: true,
        preventPenScrolling: true,
        minimumTouchTime: 180,
      },
    },
  ];
}

/** Modifier tokens used to identify the dedicated modifier-key virtual card. */
const MODIFIER_TOKENS: Record<Exclude<ScanModifierKey, 'none'>, string> = {
  shift: 'shift',
  ctrl: 'ctrl',
  alt: 'alt',
  meta: 'meta',
};
const ALL_MODIFIER_NAMES = new Set(['shift', 'ctrl', 'control', 'alt', 'meta', 'os']);

/** Tokens in an `include`/`exclude` list that name a mouse button. */
const MOUSE_TOKENS: readonly string[] = ['mouse0', 'mouse1', 'mouse2', 'mouse3', 'mouse4', 'mouse5'];

/**
 * The token the `scanning.middleMouse` knob stands for.
 *
 * NOT an arbitrary choice: a mouse token names a bit of the `buttons` bitmask the
 * scanner matches against, not a DOM `MouseEvent.button` — upstream's own
 * `getActiveButtonsInternal` maps bit `i` to `mouse${i}`, so the middle button
 * (bit 2, value 4) is `mouse2` and the RIGHT one is `mouse1`. Writing `mouse1`
 * here therefore made the "middle mouse" row demand the right button: the knob
 * and the scanner disagreed about the same physical button, so the toggle never
 * did what its label said.
 */
const MIDDLE_MOUSE_TOKEN = 'mouse2';

/**
 * The token a build BEFORE the bit-index fix wrote for the same button.
 *
 * Kept only so a persisted tree from that build can be rewritten once (see
 * [`migrateLegacyScanInputTokens`]): the scanner matches an `include` against the
 * `buttons` BITMASK, so a card that asks for `mouse1` fires on the RIGHT button —
 * the knob and the card disagreeing about the same physical button.
 */
const LEGACY_MIDDLE_MOUSE_TOKEN = 'mouse1';

/** The persisted `scanning.inputs` array (empty when the tree has none). */
function scanInputsOf(options: Options): Record<string, unknown>[] {
  // Raw read: the virtual paths below sit ON TOP of this path, so going through
  // `readOptionPath` here would be a cycle.
  const slot = resolveSlot(options, SCAN_INPUTS_PATH);
  if (slot === null) return [];
  const inputs = getPathValue(slot.container, slot.key);
  if (!Array.isArray(inputs)) return [];
  return inputs.filter((input): input is Record<string, unknown> =>
    isPlainObject(input),
  );
}

/** Whitespace-separated token list of one input's `include` (or `exclude`). */
function tokensOf(
  input: Record<string, unknown> | undefined,
  key: string,
): string[] {
  const raw = input?.[key];
  if (typeof raw !== 'string') return [];
  return raw.split(/\s+/).filter((token) => token !== '');
}

/** The modifier one input's `include` asks for. */
function modifierOf(tokens: readonly string[]): ScanModifierKey {
  for (const token of tokens) {
    if (MOUSE_TOKENS.includes(token)) continue;
    if (token === 'ctrl' || token === 'control') return 'ctrl';
    if (token === 'meta' || token === 'os') return 'meta';
    if (token === 'shift' || token === 'alt') return token;
  }
  return 'none';
}

/**
 * Locate the dedicated modifier-key virtual input card without destroying other cards.
 */
function getOrCreateModifierInputIndex(
  inputs: Record<string, unknown>[],
): number {
  // 1. Look for a mouse card that holds a modifier or is empty (and has no non-modifier include tokens like custom mouse buttons)
  for (let i = 0; i < inputs.length; i++) {
    const entry = inputs[i];
    if (entry === undefined) continue;
    const types = isPlainObject(entry.types) ? entry.types : {};
    if (types.mouse !== true) continue;
    const include = tokensOf(entry, 'include');
    const nonMods = include.filter((t) => !ALL_MODIFIER_NAMES.has(t));
    if (nonMods.length === 0) {
      return i;
    }
  }
  // 2. Look for any mouse card whose include only has modifiers (plus the middle-mouse token)
  for (let i = 0; i < inputs.length; i++) {
    const entry = inputs[i];
    if (entry === undefined) continue;
    const include = tokensOf(entry, 'include');
    const nonMods = include.filter(
      (t) => !ALL_MODIFIER_NAMES.has(t) && t !== MIDDLE_MOUSE_TOKEN,
    );
    if (nonMods.length === 0 && modifierOf(include) !== 'none') {
      return i;
    }
  }
  if (inputs.length === 0) {
    // Nothing persisted yet: start from the host's own pair (see above), so the
    // knob lands on the desktop card exactly as a seeded tree would.
    inputs.push(...createDefaultScanningInputs());
    return 0;
  }
  const first = inputs[0] ?? {};
  const firstInclude = tokensOf(first, 'include');
  const firstMods = firstInclude.filter((t) => ALL_MODIFIER_NAMES.has(t));
  inputs.unshift({
    include: [...firstMods, 'shift'].join(' '),
    exclude: typeof first.exclude === 'string' ? first.exclude : '',
    types: { mouse: true, touch: false, pen: false },
    options: isPlainObject(first.options)
      ? { ...first.options }
      : { searchTerms: true, searchKanji: true },
  });
  return 0;
}

/**
 * Read one virtual scanning path out of the persisted input list.
 *
 * Note: an `include` token this host does not write (a pen- or touch-only input,
 * or a future modifier) reads as `shift` — the shipped default — rather than as
 * `none`, because `none` would silently re-write the list the first time the user
 * touched the row.
 */
function readVirtualScanPath(options: Options, path: string): unknown {
  const inputs = scanInputsOf(options);
  const idx = getOrCreateModifierInputIndex(inputs);
  const input = inputs[idx];
  const include = tokensOf(input, 'include');
  if (path === SCAN_MODIFIER_KEY_PATH) {
    const modifier = modifierOf(include);
    return modifier === 'none' && include.length > 0 ? 'shift' : modifier;
  }
  return include.includes(MIDDLE_MOUSE_TOKEN);
}

/**
 * Write one virtual scanning path non-destructively into the dedicated modifier-key input card.
 *
 * Returns `null` when `path` is not a virtual one, so the caller falls through to
 * the normal field write.
 */
function writeVirtualScanPath(
  options: Options,
  path: string,
  value: unknown,
): Options | null {
  if (path !== SCAN_MODIFIER_KEY_PATH && path !== SCAN_MIDDLE_MOUSE_PATH) {
    return null;
  }
  const inputs = scanInputsOf(options);
  const idx = getOrCreateModifierInputIndex(inputs);
  const input = inputs[idx] ?? {};
  const include = tokensOf(input, 'include');

  let nextModifier: ScanModifierKey;
  if (path === SCAN_MODIFIER_KEY_PATH) {
    nextModifier = isScanModifierKey(value) ? value : modifierOf(include);
  } else {
    nextModifier = modifierOf(include);
  }

  const nextMiddleMouse =
    path === SCAN_MIDDLE_MOUSE_PATH
      ? value === true
      : include.includes(MIDDLE_MOUSE_TOKEN);

  const nonModifierTokens = include.filter(
    (t) => !ALL_MODIFIER_NAMES.has(t) && t !== MIDDLE_MOUSE_TOKEN,
  );
  const nextInclude = [
    ...(nextModifier === 'none' ? [] : [MODIFIER_TOKENS[nextModifier]]),
    ...nonModifierTokens,
    ...(nextMiddleMouse ? [MIDDLE_MOUSE_TOKEN] : []),
  ]
    .filter((token, index, arr) => arr.indexOf(token) === index)
    .join(' ');

  const nextInputs = inputs.map((entry, i) =>
    i === idx ? { ...entry, include: nextInclude } : entry,
  );
  return writeOptionPath(options, SCAN_INPUTS_PATH, nextInputs);
}

/* ---------------------------------------------------------------------------
 * Module → 24h trace pipeline
 * ---------------------------------------------------------------------------
 * Yomitan's own diagnostics used to stop at the console, which is exactly where
 * nobody can read them after the fact. They now go through the same journal as
 * the UI events they belong to (features/trace/trace-logger.ts → the 24h
 * rolling JSONL file), tagged `area: 'module'` and `data.module: 'yomitan'`.
 *
 * The gate is `general.debugInfo` ("Show debug information", still a user
 * toggle — unlike showAdvanced/showDebug, which are pinned on and hidden).
 * Tracing off costs one boolean read, so a hot path stays free.
 * ------------------------------------------------------------------------- */

/** Cached `general.debugInfo`, re-read whenever options are read or written. */
let debugInfoEnabled = false;

/** Re-read the trace gate from an options tree (never parses storage). */
function syncDebugInfoCache(options: Options): void {
  debugInfoEnabled = readOptionPath(options, 'general.debugInfo') === true;
}

/** True while the user has Yomitan's "Show debug information" turned on. */
export function isYomitanDebugInfoEnabled(): boolean {
  return debugInfoEnabled;
}

/**
 * Append one Yomitan event to Entei's trace journal (no-op while the gate is
 * off). Payload goes through the journal's `sanitize()`, so an API key or a
 * tokenised URL passed in by mistake is redacted before it reaches the file.
 */
export function traceYomitan(event: string, data?: TraceData): void {
  if (!debugInfoEnabled) return;
  traceModule('yomitan', event, data);
}

/** localStorage key (versioned) — also the SQLite key suffix. */
export const YOMITAN_OPTIONS_KEY = 'entei.yomitan.options.v1';

/**
 * Persisted schema version.
 *
 * `2` is the payload that carries the corrected middle-mouse token: anything
 * below it was written while `scanning.middleMouse` still wrote the pre-fix one,
 * so its input cards are rewritten on the way out (see
 * [`migrateLegacyScanInputTokens`]).
 */
export const YOMITAN_OPTIONS_SCHEMA_VERSION = 2;

/**
 * The first payload version that already carries the corrected mouse token.
 */
const SCAN_MOUSE_TOKEN_FIX_VERSION = 2;

/** Debounce window for autosave (one write per burst of edits). */
const SAVE_DEBOUNCE_MS = 400;

interface PersistedPayload {
  version: number;
  options: Options;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/**
 * Re-impose the host's policy on one profile's options: the locked values, plus
 * the shipped scan-input cards while the profile carries none.
 *
 * Seeding here (the one choke point every read and normalize goes through) is
 * what makes the two cards the module default rather than one consumer's
 * fallback: the settings editor, the scanner and a hand-edited payload all see
 * the same list. A list the user has cards in is never touched — and the editor
 * cannot empty it, since the first card has no Remove button.
 */
function lockProfileOptions(options: ProfileOptions): ProfileOptions {
  let next: unknown = options;
  for (const [path, value] of Object.entries(LOCKED_OPTION_PATHS)) {
    if (getPathValue(next, path) === value) continue;
    next = setPathValue(next, path, value);
  }
  if (!hasScanInputCards(next)) {
    next = setPathValue(next, SCAN_INPUTS_PATH, createDefaultScanningInputs());
  }
  return next as ProfileOptions;
}

/** True when a profile already carries at least one scan-input card. */
function hasScanInputCards(options: unknown): boolean {
  const inputs = getPathValue(options, SCAN_INPUTS_PATH);
  if (!Array.isArray(inputs)) return false;
  return inputs.some((input) => isPlainObject(input));
}

/**
 * Rewrite the legacy middle-mouse token in one `include` / `exclude` string.
 *
 * Returns the value UNCHANGED (same reference) when it carries no legacy token,
 * so a caller can tell a rewritten card from an untouched one. The original
 * spacing survives: only the token itself is substituted.
 */
function migrateMouseTokenString(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  if (!value.includes(LEGACY_MIDDLE_MOUSE_TOKEN)) return value;
  const tokens = value.split(/\s+/);
  if (!tokens.includes(LEGACY_MIDDLE_MOUSE_TOKEN)) return value;
  return tokens
    .map((token) =>
      token === LEGACY_MIDDLE_MOUSE_TOKEN ? MIDDLE_MOUSE_TOKEN : token,
    )
    .join(' ');
}

/**
 * Rewrite the legacy middle-mouse token across every `scanning.inputs` card.
 *
 * One-shot compatibility for trees persisted before the bit-index fix, where the
 * `scanning.middleMouse` knob wrote `mouse1` for the wheel button while the
 * scanner read the same physical button as `mouse2` (see `MIDDLE_MOUSE_TOKEN`).
 * Such a card does not merely show the wrong knob state: it asks the matcher for
 * the RIGHT button, so the middle-click scan trigger fires on the wrong click.
 * Rewriting the token is what makes the card mean what its label said.
 *
 * Only the mouse tokens the HOST's own writer ever emitted are ambiguous, and a
 * user who deliberately recorded `mouse1` (right button) on a pre-fix build will
 * have that one card rebind once — re-recording it writes the right token from
 * then on. Everything else in the tree, including token spacing, is left alone,
 * and the same options reference is returned when there is nothing to do.
 */
export function migrateLegacyScanInputTokens(options: Options): Options {
  let changed = false;
  const profiles = options.profiles.map((profile) => {
    const inputs = getPathValue(profile.options, SCAN_INPUTS_PATH);
    if (!Array.isArray(inputs)) return profile;
    let cardChanged = false;
    const nextInputs = inputs.map((input) => {
      if (!isPlainObject(input)) return input;
      const include = migrateMouseTokenString(input.include);
      const exclude = migrateMouseTokenString(input.exclude);
      if (include === input.include && exclude === input.exclude) return input;
      cardChanged = true;
      return { ...input, include, exclude };
    });
    if (!cardChanged) return profile;
    changed = true;
    return {
      ...profile,
      options: setPathValue(
        profile.options,
        SCAN_INPUTS_PATH,
        nextInputs,
      ) as ProfileOptions,
    };
  });
  if (!changed) return options;
  traceYomitan('settings_scan_mouse_token_migrated', {
    version: YOMITAN_OPTIONS_SCHEMA_VERSION,
  });
  return { ...options, profiles } as Options;
}

/**
 * Apply the mouse-token migration to a payload written before the fix.
 *
 * Gated on the PERSISTED payload's own version, not on the tree: the same tokens
 * written by a current build are the user's deliberate choice (the recorder writes
 * `mouse1` for the right button on purpose), so only a pre-fix payload is
 * rewritten. A payload with no readable version is treated as pre-fix —
 * fail-safe, because a card left on the legacy token never scans on the middle
 * button at all.
 */
function migrateLegacyPayload(
  options: Options,
  payloadVersion: unknown,
): Options {
  if (
    typeof payloadVersion === 'number' &&
    payloadVersion >= SCAN_MOUSE_TOKEN_FIX_VERSION
  ) {
    return options;
  }
  return migrateLegacyScanInputTokens(options);
}

/**
 * Yomitan's default profile options with this host's own scan-input cards.
 *
 * The fallback for every field the host does not supply.
 */
function createHostProfileOptions(): ProfileOptions {
  let opts = setPathValue(
    createDefaultProfileOptions(),
    SCAN_INPUTS_PATH,
    createDefaultScanningInputs(),
  );
  opts = setPathValue(opts, 'scanning.autoHideResults', true);
  opts = setPathValue(opts, 'scanning.hideDelay', 2000);
  return opts as ProfileOptions;
}

/**
 * Yomitan's default tree with this host's own scan-input cards.
 *
 * What the host hands out when nothing is stored: a fresh install must start on
 * THIS host's two cards, not on Yomitan's extension-shaped pair.
 */
function createHostDefaultOptions(): Options {
  const defaults = createDefaultOptions();
  return {
    ...defaults,
    profiles: defaults.profiles.map((profile) => ({
      ...profile,
      options: createHostProfileOptions(),
    })),
  } as Options;
}

/** Re-impose the host-locked values on every profile of an options tree. */
function withLockedOptions(options: Options): Options {
  return {
    ...options,
    profiles: options.profiles.map((profile) => ({
      ...profile,
      options: lockProfileOptions(profile.options),
    })),
  } as Options;
}

/**
 * Coerce an untrusted stored payload into a valid `Options`.
 *
 * Fail-closed and non-throwing: a corrupted / partial / older payload falls
 * back to the defaults for every field it does not supply, so the settings page
 * always renders a complete tree. Host-locked paths are re-imposed on the way
 * out, so a stored value can never override them.
 */
export function normalizeOptions(input: unknown): Options {
  const defaults = createHostDefaultOptions();
  if (!isRecord(input)) return withLockedOptions(defaults);

  const profiles = Array.isArray(input.profiles)
    ? input.profiles
    : defaults.profiles;
  const normalizedProfiles = profiles.map((profile) => {
    if (!isRecord(profile)) {
      return {
        name: 'Default',
        conditionGroups: [],
        options: createHostProfileOptions(),
      };
    }
    return {
      name: typeof profile.name === 'string' ? profile.name : 'Default',
      conditionGroups: Array.isArray(profile.conditionGroups)
        ? profile.conditionGroups
        : [],
      options: isRecord(profile.options)
        ? (profile.options as ProfileOptions)
        : createHostProfileOptions(),
    };
  });

  return withLockedOptions({
    version:
      typeof input.version === 'number' ? input.version : defaults.version,
    profiles:
      normalizedProfiles.length > 0 ? normalizedProfiles : defaults.profiles,
    profileCurrent:
      typeof input.profileCurrent === 'number'
        ? input.profileCurrent
        : defaults.profileCurrent,
    global: isRecord(input.global)
      ? (input.global as Options['global'])
      : defaults.global,
  } as Options);
}

/** Read from the localStorage cache, falling back to defaults. */
function readPersistedOptions(): Options {
  if (typeof window === 'undefined') {
    return withLockedOptions(createHostDefaultOptions());
  }
  try {
    const raw = window.localStorage.getItem(YOMITAN_OPTIONS_KEY);
    if (raw === null) return withLockedOptions(createHostDefaultOptions());
    const parsed = JSON.parse(raw) as unknown;
    if (!isRecord(parsed) || !('options' in parsed)) {
      // Tolerate a bare Options object (older/hand-edited payloads).
      return normalizeOptions(parsed);
    }
    return migrateLegacyPayload(
      normalizeOptions(parsed.options),
      parsed.version,
    );
  } catch (error) {
    // storage unavailable or corrupted
    traceYomitan('settings_read_failed', { error });
    return withLockedOptions(createHostDefaultOptions());
  }
}

/**
 * Read the persisted options (cache first) and refresh the trace gate.
 *
 * Every read path funnels through here, so the gate always describes the tree
 * the caller is about to use.
 */
export function readYomitanOptions(): Options {
  const options = readPersistedOptions();
  syncDebugInfoCache(options);
  return options;
}

/** Seed the localStorage cache from the desktop DB (call once on mount). */
export async function hydrateYomitanOptions(): Promise<Options> {
  const cached = readYomitanOptions();
  const fromCache = { source: 'cache', profiles: cached.profiles.length };
  if (!isTauri()) {
    traceYomitan('settings_hydrated', fromCache);
    return cached;
  }
  try {
    const stored = await dbKvGet(YOMITAN_OPTIONS_KEY);
    const parsed =
      stored === null || stored === undefined || stored === ''
        ? null
        : (JSON.parse(stored) as unknown);
    if (!isRecord(parsed) || !('options' in parsed)) {
      traceYomitan('settings_hydrated', fromCache);
      return cached;
    }
    const options = migrateLegacyPayload(
      normalizeOptions(parsed.options),
      parsed.version,
    );
    // The DB is the durable source of truth: its gate wins over the cache's.
    syncDebugInfoCache(options);
    writeCache(options);
    traceYomitan('settings_hydrated', {
      source: 'db',
      profiles: options.profiles.length,
    });
    return options;
  } catch (error) {
    // DB unavailable — keep the cache value.
    traceYomitan('settings_hydrate_failed', { error });
    return cached;
  }
}

let saveTimer: ReturnType<typeof setTimeout> | null = null;

function writeCache(options: Options): void {
  try {
    const payload: PersistedPayload = {
      version: YOMITAN_OPTIONS_SCHEMA_VERSION,
      options,
    };
    window.localStorage.setItem(YOMITAN_OPTIONS_KEY, JSON.stringify(payload));
  } catch (error) {
    // storage unavailable — the in-memory value still drives this session
    traceYomitan('settings_cache_failed', { error });
  }
}

/**
 * Persist the full options object.
 *
 * localStorage is written immediately (so a same-session reload sees the
 * value); the desktop DB mirror is debounced so a burst of edits costs one
 * write. Fire-and-forget, never throws to the caller.
 */
export function writeYomitanOptions(options: Options): void {
  // The tree being persisted is now the live one, gate included.
  syncDebugInfoCache(options);
  writeCache(options);
  if (!isTauri()) return;
  if (saveTimer !== null) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    saveTimer = null;
    const payload: PersistedPayload = {
      version: YOMITAN_OPTIONS_SCHEMA_VERSION,
      options,
    };
    void dbKvSet(YOMITAN_OPTIONS_KEY, JSON.stringify(payload)).catch(
      (error: unknown) => {
        // Mirroring is best-effort; localStorage stays authoritative.
        traceYomitan('settings_mirror_failed', { error });
      },
    );
  }, SAVE_DEBOUNCE_MS);
}

/** The active profile's options (what descriptor dot-paths address). */
export function activeProfileOptions(options: Options): ProfileOptions {
  const profile = options.profiles[options.profileCurrent];
  return profile ? profile.options : createHostProfileOptions();
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Read one dot-path against a profile-options subtree. */
export function getPathValue(source: unknown, path: string): unknown {
  let cursor: unknown = source;
  for (const segment of path.split('.')) {
    if (!isPlainObject(cursor)) return undefined;
    cursor = cursor[segment];
  }
  return cursor;
}

/** True when every segment of `path` already exists in `source`. */
function hasPathValue(source: unknown, path: string): boolean {
  let cursor: unknown = source;
  for (const segment of path.split('.')) {
    if (!isPlainObject(cursor) || !(segment in cursor)) return false;
    cursor = cursor[segment];
  }
  return true;
}

/** Write one dot-path into a profile-options subtree (immutable). */
export function setPathValue(
  source: unknown,
  path: string,
  value: unknown,
): unknown {
  const segments = path.split('.');
  const [head, ...rest] = segments;
  if (head === undefined) return source;
  const base = isPlainObject(source) ? source : {};
  if (rest.length === 0) return { ...base, [head]: value };
  return {
    ...base,
    [head]: setPathValue(base[head], rest.join('.'), value),
  };
}

/**
 * Resolve a descriptor dot-path to `{ container, key }` inside an `Options`.
 *
 * `general.*`, `anki.*`, … address the active profile; `global.*` and the
 * root scalars (`version`, `profileCurrent`) address the root. Returns null
 * for a path that cannot exist, so the caller can skip it rather than write to
 * the wrong place.
 */
function resolveSlot(
  options: Options,
  path: string,
): { container: Record<string, unknown>; key: string } | null {
  const segments = path.split('.');
  const [head, ...rest] = segments;
  if (head === undefined || head === '') return null;
  const root = options as unknown as Record<string, unknown>;
  if (head === 'global') {
    const globalValue = root.global;
    if (!isPlainObject(globalValue)) return null;
    return { container: globalValue, key: rest.join('.') };
  }
  if (head === 'version' || head === 'profileCurrent') {
    if (rest.length > 0) return null;
    return { container: root, key: head };
  }
  const profile = activeProfileOptions(options) as unknown as Record<
    string,
    unknown
  >;
  if (!(head in profile)) return null;
  if (rest.length === 0) return { container: profile, key: head };
  const nested = profile[head];
  if (!isPlainObject(nested)) return null;
  return { container: nested, key: rest.join('.') };
}

/** Read a settings-tree dot-path from the persisted options. */
export function readOptionPath(options: Options, path: string): unknown {
  if (path === SCAN_MODIFIER_KEY_PATH || path === SCAN_MIDDLE_MOUSE_PATH) {
    return readVirtualScanPath(options, path);
  }
  const slot = resolveSlot(options, path);
  if (slot === null) return undefined;
  return getPathValue(slot.container, slot.key);
}

/**
 * Update one dot-path and persist.
 *
 * Returns the next options object (or the SAME reference when the path is not
 * addressable), so callers can skip a re-render on a no-op.
 */
export function writeOptionPath(
  options: Options,
  path: string,
  value: unknown,
): Options {
  // Host-locked paths have no editor; a write to one is a no-op.
  if (isLockedOptionPath(path)) return options;
  // Virtual scanning knobs write the real input list they stand for.
  const virtual = writeVirtualScanPath(options, path, value);
  if (virtual !== null) return virtual;
  const slot = resolveSlot(options, path);
  if (slot === null) return options;
  // A stale descriptor must not invent a brand-new key in the settings tree,
  // so only a path that already exists is addressable.
  if (!hasPathValue(slot.container, slot.key)) return options;

  const next = { ...(options as unknown as Record<string, unknown>) };
  const head = path.split('.')[0] ?? '';
  if (head === 'version' || head === 'profileCurrent') {
    next[head] = value;
  } else if (head === 'global') {
    next.global = setPathValue(slot.container, slot.key, value);
  } else {
    // `resolveSlot` hands back the NESTED SECTION (`general`, `anki`, …) as the
    // container. Writing its result straight into `profile.options` would
    // replace the whole tree with that one section and silently drop every
    // sibling, so the write goes through the FULL path instead.
    const nextProfileOptions = setPathValue(
      activeProfileOptions(options),
      path,
      value,
    );
    next.profiles = options.profiles.map((profile, index) =>
      index === options.profileCurrent
        ? { ...profile, options: nextProfileOptions as ProfileOptions }
        : profile,
    );
  }

  const result = next as unknown as Options;
  writeYomitanOptions(result);
  return result;
}
