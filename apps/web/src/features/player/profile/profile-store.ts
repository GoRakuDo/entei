/**
 * Local device profile store.
 *
 * The profile is deliberately local-only: this store never sends profile data
 * outside the browser and follows the defensive localStorage pattern used by
 * the other Entei preference stores.
 */

import {
  isTauri,
  dbGetProfile,
  dbUpsertProfile,
  type DbUserProfile,
  type DbUserProfileInput,
} from '@/features/player/tauri-bridge';
import { deriveHandle } from '@/features/timeline/timeline-store';
import { ensureDatabaseMigrated } from '@/features/database/migration';

export const PROFILE_STORAGE_KEY = 'entei.profile.v1';
export const PROFILE_SCHEMA_VERSION = 1 as const;
export const PROFILE_BIO_MAX_LENGTH = 360;
export const PROFILE_AVATAR_COUNT = 15;
export const PROFILE_AVATAR_MAX_BYTES = 200 * 1024;

export type LocalProfileAvatar = string;

export interface LocalProfile {
  schemaVersion: typeof PROFILE_SCHEMA_VERSION;
  name: string;
  bio: string;
  /** A bundled `/avatars/N.webp` path or a processed image data URL. */
  avatar: LocalProfileAvatar;
}

const RANDOM_NAME_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';

function randomInt(maxExclusive: number): number {
  return Math.min(maxExclusive - 1, Math.floor(Math.random() * maxExclusive));
}

export function createRandomProfileName(): string {
  let suffix = '';
  for (let index = 0; index < 4; index += 1) {
    suffix += RANDOM_NAME_ALPHABET[randomInt(RANDOM_NAME_ALPHABET.length)];
  }
  return `Kitsune-${suffix}`;
}

function bundledAvatarPath(avatar: number): string {
  return `/avatars/${avatar}.webp`;
}

export function createInitialProfile(): LocalProfile {
  return {
    schemaVersion: PROFILE_SCHEMA_VERSION,
    name: createRandomProfileName(),
    bio: '',
    avatar: bundledAvatarPath(randomInt(PROFILE_AVATAR_COUNT) + 1),
  };
}

export function truncateProfileBio(value: string): string {
  return value.slice(0, PROFILE_BIO_MAX_LENGTH);
}

/** Return the decoded payload size of an image data URL in bytes. */
export function getProfileAvatarDataUrlBytes(value: string): number {
  if (!value.startsWith('data:image/')) return Number.POSITIVE_INFINITY;
  const commaIndex = value.indexOf(',');
  if (commaIndex < 0) return Number.POSITIVE_INFINITY;

  const metadata = value.slice(0, commaIndex);
  const payload = value.slice(commaIndex + 1);
  if (/;base64/i.test(metadata)) {
    const normalized = payload.replace(/\s/g, '');
    if (!/^[A-Za-z0-9+/]*={0,2}$/.test(normalized)) {
      return Number.POSITIVE_INFINITY;
    }
    const padding = normalized.endsWith('==')
      ? 2
      : normalized.endsWith('=')
        ? 1
        : 0;
    return Math.max(0, Math.floor((normalized.length * 3) / 4) - padding);
  }

  try {
    return new TextEncoder().encode(decodeURIComponent(payload)).byteLength;
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

function isBundledAvatar(value: string): boolean {
  const match = /^\/avatars\/(\d+)\.webp$/.exec(value);
  if (!match) return false;
  const number = Number(match[1]);
  return Number.isInteger(number) && number >= 1 && number <= PROFILE_AVATAR_COUNT;
}

/** Validate the current avatar representation, including the upload cap. */
export function isProfileAvatar(value: unknown): value is LocalProfileAvatar {
  if (typeof value !== 'string') return false;
  if (isBundledAvatar(value)) return true;
  return (
    value.startsWith('data:image/') &&
    getProfileAvatarDataUrlBytes(value) <= PROFILE_AVATAR_MAX_BYTES
  );
}

/** Convert the v1 numeric avatar representation to its bundled path. */
function migrateProfileAvatar(value: unknown): LocalProfileAvatar | null {
  if (
    typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= 1 &&
    value <= PROFILE_AVATAR_COUNT
  ) {
    return bundledAvatarPath(value);
  }
  return isProfileAvatar(value) ? value : null;
}

function parseLocalProfile(value: unknown): LocalProfile | null {
  if (typeof value !== 'object' || value === null) return null;
  const profile = value as Record<string, unknown>;
  const avatar = migrateProfileAvatar(profile.avatar);
  if (
    profile.schemaVersion !== PROFILE_SCHEMA_VERSION ||
    typeof profile.name !== 'string' ||
    typeof profile.bio !== 'string' ||
    profile.bio.length > PROFILE_BIO_MAX_LENGTH ||
    avatar === null
  ) {
    return null;
  }
  return {
    schemaVersion: PROFILE_SCHEMA_VERSION,
    name: profile.name,
    bio: profile.bio,
    avatar,
  };
}

/** Persist a profile; storage failures are safe for this local-only preference. */
export function writeLocalProfile(profile: LocalProfile): void {
  if (parseLocalProfile(profile) === null) return;
  try {
    localStorage.setItem(PROFILE_STORAGE_KEY, JSON.stringify(profile));
  } catch {
    // Storage may be unavailable or full; keep the in-memory profile usable.
  }
  // Desktop: the embedded SQLite `user_profile` row is the durable store, and
  // the localStorage copy above is the synchronous cache the UI reads directly.
  // Both are written together so they never diverge on desktop. Profile data is
  // non-secret and non-blocking, so the DB write is fire-and-forget.
  if (isTauri()) {
    void dbUpsertProfile(profileToDb(profile)).catch(() => {});
  }
}

/* ------------------------------------------------------------------------ */
/* SQLite mapping (desktop Tauri)                                           */
/* ------------------------------------------------------------------------ */

/** Local profile → SQLite `user_profile` row. */
function profileToDb(profile: LocalProfile): DbUserProfileInput {
  return {
    handle: deriveHandle(profile.name),
    displayName: profile.name,
    bio: profile.bio.length > 0 ? profile.bio : null,
    avatarUrl: profile.avatar,
    updatedAt: Date.now(),
  };
}

/** SQLite `user_profile` row → local profile (falls back to a bundled avatar). */
function dbToProfile(row: DbUserProfile): LocalProfile {
  const avatar = row.avatarUrl !== null && isProfileAvatar(row.avatarUrl)
    ? row.avatarUrl
    : createInitialProfile().avatar;
  return {
    schemaVersion: PROFILE_SCHEMA_VERSION,
    name: row.displayName,
    bio: row.bio ?? '',
    avatar,
  };
}

/**
 * Read the profile with SQLite preferred on desktop.
 *
 * On desktop the DB row wins (it is the durable store); it is mirrored into the
 * synchronous localStorage cache so the rest of the UI — which reads the cache
 * directly — stays consistent. Outside Tauri (or on any DB error) this is the
 * plain localStorage read.
 */
export async function loadLocalProfile(): Promise<LocalProfile> {
  if (!isTauri()) return readLocalProfile();
  try {
    await ensureDatabaseMigrated();
    const row = await dbGetProfile();
    if (row) {
      const profile = dbToProfile(row);
      try {
        localStorage.setItem(PROFILE_STORAGE_KEY, JSON.stringify(profile));
      } catch {
        // Cache refresh is best-effort; the DB value is still authoritative.
      }
      return profile;
    }
  } catch {
    // DB unavailable — fall back to the synchronous cache below.
  }
  return readLocalProfile();
}

/**
 * Read the profile, creating and persisting a fresh one on first use or after
 * any malformed value. Numeric v1 avatars are migrated to their bundled path
 * while retaining schemaVersion 1 and the existing storage key.
 */
export function readLocalProfile(): LocalProfile {
  try {
    const raw = localStorage.getItem(PROFILE_STORAGE_KEY);
    if (raw !== null) {
      const parsed = JSON.parse(raw) as unknown;
      const profile = parseLocalProfile(parsed);
      if (profile !== null) {
        if (JSON.stringify(parsed) !== JSON.stringify(profile)) {
          writeLocalProfile(profile);
        }
        return profile;
      }
    }
  } catch {
    // Parse errors and unavailable storage both use the safe initialization path.
  }

  const initial = createInitialProfile();
  writeLocalProfile(initial);
  return initial;
}

export function setLocalProfileName(name: string): LocalProfile {
  const next = { ...readLocalProfile(), name };
  writeLocalProfile(next);
  return next;
}

export function setLocalProfileBio(bio: string): LocalProfile {
  const next = { ...readLocalProfile(), bio: truncateProfileBio(bio) };
  writeLocalProfile(next);
  return next;
}

export function setLocalProfileAvatar(avatar: LocalProfileAvatar): LocalProfile {
  const current = readLocalProfile();
  if (!isProfileAvatar(avatar)) return current;
  const next = { ...current, avatar };
  writeLocalProfile(next);
  return next;
}
