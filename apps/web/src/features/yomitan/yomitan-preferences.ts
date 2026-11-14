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
 * The last block is DOM-scan detail this host does not implement: deep scan
 * (shadow DOM / iframe boundaries), CSS-zoom normalisation, and the two
 * prevent families (Yomitan's middle-click autoscroll and back/forward gesture
 * suppression, which belong to a browser toolbar, not to this app). They stay in
 * the persisted tree — Yomitan's own shape — but the scanning section never
 * offers them.
 */
export const LOCKED_OPTION_PATHS: Readonly<Record<string, unknown>> = {
  'general.enable': true,
  'general.language': 'ja',
  'general.showGuide': false,
  'general.showAdvanced': true,
  'general.showDebug': true,
  'scanning.deepDomScan': false,
  'scanning.normalizeCssZoom': true,
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

/** Tokens in an `include`/`exclude` list that name a mouse button. */
const MOUSE_TOKENS: readonly string[] = ['mouse0', 'mouse1', 'mouse2'];

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
 * Read one virtual scanning path out of the persisted input list.
 *
 * Note: an `include` token this host does not write (a pen- or touch-only input,
 * or a future modifier) reads as `shift` — the shipped default — rather than as
 * `none`, because `none` would silently re-write the list the first time the user
 * touched the row.
 */
function readVirtualScanPath(options: Options, path: string): unknown {
  const input = scanInputsOf(options)[0];
  const include = tokensOf(input, 'include');
  if (path === SCAN_MODIFIER_KEY_PATH) {
    const modifier = modifierOf(include);
    return modifier === 'none' && include.length > 0 ? 'shift' : modifier;
  }
  return include.includes('mouse1');
}

/**
 * Write one virtual scanning path into the first persisted input.
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
  const input = inputs[0];
  // No input to write into: the tree cannot hold the value, so this is a no-op
  // rather than an invented array Yomitan's own scan code would have to accept.
  if (input === undefined) return options;

  const include = tokensOf(input, 'include');
  const modifier =
    path === SCAN_MODIFIER_KEY_PATH && isScanModifierKey(value)
      ? value
      : modifierOf(include);
  const middleMouse =
    path === SCAN_MIDDLE_MOUSE_PATH
      ? value === true
      : include.includes('mouse1');

  const nextInclude = [
    modifier === 'none' ? '' : modifier,
    middleMouse ? 'mouse1' : '',
  ]
    .filter((token) => token !== '')
    .join(' ');
  // The middle button must not stay excluded while it is a trigger; and while it
  // is not, leaving it excluded would block a hover scan for no visible reason.
  const nextExclude = tokensOf(input, 'exclude')
    .filter((token) => middleMouse || token !== 'mouse1')
    .join(' ');

  const nextInputs = inputs.map((entry, index) =>
    index === 0
      ? { ...entry, include: nextInclude, exclude: nextExclude }
      : entry,
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

/** Persisted schema version. */
export const YOMITAN_OPTIONS_SCHEMA_VERSION = 1;

/** Debounce window for autosave (one write per burst of edits). */
const SAVE_DEBOUNCE_MS = 400;

interface PersistedPayload {
  version: number;
  options: Options;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/** Re-impose the host-locked values on one profile's options. */
function lockProfileOptions(options: ProfileOptions): ProfileOptions {
  let next: unknown = options;
  for (const [path, value] of Object.entries(LOCKED_OPTION_PATHS)) {
    if (getPathValue(next, path) === value) continue;
    next = setPathValue(next, path, value);
  }
  return next as ProfileOptions;
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
  const defaults = createDefaultOptions();
  if (!isRecord(input)) return withLockedOptions(defaults);

  const profiles = Array.isArray(input.profiles)
    ? input.profiles
    : defaults.profiles;
  const normalizedProfiles = profiles.map((profile) => {
    if (!isRecord(profile)) {
      return {
        name: 'Default',
        conditionGroups: [],
        options: createDefaultProfileOptions(),
      };
    }
    return {
      name: typeof profile.name === 'string' ? profile.name : 'Default',
      conditionGroups: Array.isArray(profile.conditionGroups)
        ? profile.conditionGroups
        : [],
      options: isRecord(profile.options)
        ? (profile.options as ProfileOptions)
        : createDefaultProfileOptions(),
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
    return withLockedOptions(createDefaultOptions());
  }
  try {
    const raw = window.localStorage.getItem(YOMITAN_OPTIONS_KEY);
    if (raw === null) return withLockedOptions(createDefaultOptions());
    const parsed = JSON.parse(raw) as unknown;
    if (!isRecord(parsed) || !('options' in parsed)) {
      // Tolerate a bare Options object (older/hand-edited payloads).
      return normalizeOptions(parsed);
    }
    return normalizeOptions(parsed.options);
  } catch (error) {
    // storage unavailable or corrupted
    traceYomitan('settings_read_failed', { error });
    return withLockedOptions(createDefaultOptions());
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
    const options = normalizeOptions(parsed.options);
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
  return profile ? profile.options : createDefaultProfileOptions();
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
