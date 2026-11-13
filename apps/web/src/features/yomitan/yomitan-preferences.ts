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

/**
 * Host-locked option paths — never rendered, never user-editable.
 *
 * Yomitan lives as an Entei module: the switch on the Modules page is its
 * master switch (so `general.enable` is always on), dictionary lookups are
 * Japanese-only in this host (`general.language` is pinned to `ja`), and the
 * Chrome-extension onboarding guide does not exist here (`general.showGuide`
 * stays off). Every read forces these values, so even a hand-edited payload
 * cannot smuggle a different one in.
 */
export const LOCKED_OPTION_PATHS: Readonly<Record<string, unknown>> = {
  'general.enable': true,
  'general.language': 'ja',
  'general.showGuide': false,
};

/** True for a path the host owns (renderer skips it, writes are refused). */
export function isLockedOptionPath(path: string): boolean {
  return Object.hasOwn(LOCKED_OPTION_PATHS, path);
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
export function readYomitanOptions(): Options {
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
  } catch {
    // storage unavailable or corrupted
    return withLockedOptions(createDefaultOptions());
  }
}

/** Seed the localStorage cache from the desktop DB (call once on mount). */
export async function hydrateYomitanOptions(): Promise<Options> {
  const cached = readYomitanOptions();
  if (!isTauri()) return cached;
  try {
    const stored = await dbKvGet(YOMITAN_OPTIONS_KEY);
    if (stored === null || stored === undefined || stored === '') return cached;
    const parsed = JSON.parse(stored) as unknown;
    if (!isRecord(parsed) || !('options' in parsed)) return cached;
    const options = normalizeOptions(parsed.options);
    writeCache(options);
    return options;
  } catch {
    return cached; // DB unavailable — keep the cache value
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
  } catch {
    // storage unavailable — the in-memory value still drives this session
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
  writeCache(options);
  if (!isTauri()) return;
  if (saveTimer !== null) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    saveTimer = null;
    const payload: PersistedPayload = {
      version: YOMITAN_OPTIONS_SCHEMA_VERSION,
      options,
    };
    void dbKvSet(YOMITAN_OPTIONS_KEY, JSON.stringify(payload)).catch(() => {
      // Mirroring is best-effort; localStorage stays authoritative.
    });
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
