/**
 * settings-backup — Yomitan settings backup / restore / reset.
 * ---------------------------------------------------------------------------
 * Port of Yomitan's own "Backup" section (extension Options page → Backup):
 * the user can export the full options tree to a `.json` file, import a file
 * exported by EITHER this app or the upstream Chrome extension, and reset the
 * tree to this host's defaults.
 *
 * IMPORT COMPATIBILITY: the upstream extension wraps its options in an
 * envelope `{ version, date, url, manifest, environment, permissions, options }`.
 * This module detects the `options` key and unwraps it; a bare `Options` object
 * (what this app's own export produces when passed through `normalizeOptions`,
 * or a hand-edited file) is accepted as-is. Both shapes go through
 * `normalizeOptions` → `withLockedOptions` so a foreign payload can never
 * override the host-locked paths (see `yomitan-preferences.ts`).
 *
 * EXPORT ENVELOPE: the file mirrors upstream's shape so a file exported here
 * can be imported back into the Chrome extension, not only into this app:
 * `{ version: 0, date, url, userAgent, options }`. This module BUILDS that file;
 * writing it is the settings page's job (native save dialog in the desktop app,
 * a browser download on the web).
 * ---------------------------------------------------------------------------
 */

import type { Options } from '@gorakudo/yomitan-headless/settings';
import {
  createHostDefaultOptions,
  normalizeOptions,
  readYomitanOptions,
  traceYomitan,
  writeYomitanOptions,
} from '@/modules/yomitan/yomitan-preferences';

/** Event dispatched on `window` after any backup operation completes. */
export const YOMITAN_OPTIONS_UPDATED_EVENT = 'entei:yomitan-options-updated';

/** Extract the `Options` tree from either the upstream envelope or a bare tree. */
function extractOptions(data: unknown): Options {
  if (typeof data !== 'object' || data === null) {
    throw new Error('Backup file is not a valid JSON object.');
  }
  const record = data as Record<string, unknown>;
  // Upstream envelope: `{ options: { profiles, … } }`
  if ('options' in record && typeof record.options === 'object' && record.options !== null) {
    return record.options as Options;
  }
  // Bare Options: `{ profiles, profileCurrent, global, … }`
  if ('profiles' in record && Array.isArray(record.profiles)) {
    return data as Options;
  }
  throw new Error('Backup file does not contain a recognisable Yomitan options tree.');
}

/**
 * A finished settings export, ready for whichever sink writes it.
 *
 * WHERE the file lands is the caller's decision, not this module's: the settings
 * page asks the OS for a path in the desktop app and falls back to a browser
 * download on the web (see `ModuleSettingsRenderer.downloadText`). Keeping the
 * payload separate from the download is what lets the desktop app use the native
 * save dialog at all — an `<a download>` inside the webview never asks.
 */
export interface SettingsExportPayload {
  /** `yomitan-settings-YYYY-MM-DD-HH-mm-ss.json`. */
  filename: string;
  /** Upstream-compatible envelope JSON, 4-space indented. */
  contents: string;
  /** Profiles in the exported tree (trace line; the toast does not use it). */
  profileCount: number;
}

/**
 * Build the export payload for the current Yomitan options.
 *
 * Produces an upstream-compatible envelope so the file is portable between
 * this app and the Chrome extension.
 */
export function buildSettingsExportPayload(): SettingsExportPayload {
  const options = readYomitanOptions();
  const now = new Date();
  const pad = (n: number): string => String(n).padStart(2, '0');
  const y = now.getFullYear();
  const mo = pad(now.getMonth() + 1);
  const d = pad(now.getDate());
  const h = pad(now.getHours());
  const mi = pad(now.getMinutes());
  const s = pad(now.getSeconds());
  const filename = `yomitan-settings-${y}-${mo}-${d}-${h}-${mi}-${s}.json`;
  const dateStr = `${y}-${mo}-${d} ${h}:${mi}:${s}`;

  const envelope = {
    version: 0,
    date: dateStr,
    url: typeof window !== 'undefined' ? window.location.origin : '',
    userAgent: typeof navigator !== 'undefined' ? navigator.userAgent : '',
    options,
  };

  return {
    filename,
    contents: JSON.stringify(envelope, null, 4),
    profileCount: options.profiles.length,
  };
}

/**
 * Record a completed export in the trace journal.
 *
 * Called by the sink AFTER the file was actually written, so a cancelled save
 * dialog leaves no "exported" line behind.
 */
export function traceSettingsExported(profileCount: number): void {
  traceYomitan('settings_exported', { profiles: profileCount });
}

/**
 * Import Yomitan options from a JSON string (file contents).
 *
 * Accepts both the upstream extension's envelope format and a bare `Options`
 * object. The imported tree is sanitised through `normalizeOptions` (which
 * applies `withLockedOptions`) before being persisted.
 *
 * @returns The number of profiles in the imported tree on success.
 * @throws If the JSON is malformed or does not contain a valid options tree.
 */
export async function importSettingsFromJson(jsonText: string): Promise<number> {
  let data: unknown;
  try {
    data = JSON.parse(jsonText);
  } catch {
    throw new Error('Backup file is not valid JSON.');
  }

  const rawOptions = extractOptions(data);
  const normalized = normalizeOptions(rawOptions);
  writeYomitanOptions(normalized);

  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent(YOMITAN_OPTIONS_UPDATED_EVENT));
  }

  traceYomitan('settings_imported', { profiles: normalized.profiles.length });
  return normalized.profiles.length;
}

/**
 * Reset Yomitan options to this host's defaults.
 *
 * Dispatches `YOMITAN_OPTIONS_UPDATED_EVENT` so open UI surfaces can refresh.
 */
export async function resetSettings(): Promise<void> {
  // Route the defaults through `normalizeOptions` so the persisted tree carries
  // the host-locked paths (`withLockedOptions`), matching the import path.
  const defaults = normalizeOptions(createHostDefaultOptions());
  writeYomitanOptions(defaults);

  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent(YOMITAN_OPTIONS_UPDATED_EVENT));
  }

  traceYomitan('settings_reset', { profiles: defaults.profiles.length });
}
