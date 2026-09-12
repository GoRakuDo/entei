/**
 * Local device profile store.
 *
 * The profile is deliberately local-only: this store never sends profile data
 * outside the browser and follows the defensive localStorage pattern used by
 * the other Entei preference stores.
 */

export const PROFILE_STORAGE_KEY = 'entei.profile.v1';
export const PROFILE_SCHEMA_VERSION = 1 as const;
export const PROFILE_BIO_MAX_LENGTH = 360;
export const PROFILE_AVATAR_COUNT = 15;

export interface LocalProfile {
  schemaVersion: typeof PROFILE_SCHEMA_VERSION;
  name: string;
  bio: string;
  avatar: number;
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

export function createInitialProfile(): LocalProfile {
  return {
    schemaVersion: PROFILE_SCHEMA_VERSION,
    name: createRandomProfileName(),
    bio: '',
    avatar: randomInt(PROFILE_AVATAR_COUNT) + 1,
  };
}

export function truncateProfileBio(value: string): string {
  return value.slice(0, PROFILE_BIO_MAX_LENGTH);
}

function isProfileAvatar(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= 1 &&
    value <= PROFILE_AVATAR_COUNT
  );
}

function isLocalProfile(value: unknown): value is LocalProfile {
  if (typeof value !== 'object' || value === null) return false;
  const profile = value as Record<string, unknown>;
  return (
    profile.schemaVersion === PROFILE_SCHEMA_VERSION &&
    typeof profile.name === 'string' &&
    typeof profile.bio === 'string' &&
    profile.bio.length <= PROFILE_BIO_MAX_LENGTH &&
    isProfileAvatar(profile.avatar)
  );
}

/** Persist a profile; storage failures are safe for this local-only preference. */
export function writeLocalProfile(profile: LocalProfile): void {
  try {
    localStorage.setItem(PROFILE_STORAGE_KEY, JSON.stringify(profile));
  } catch {
    // Storage may be unavailable or full; keep the in-memory profile usable.
  }
}

/**
 * Read the profile, creating and persisting a fresh one on first use or after
 * any malformed value. This function is safe when localStorage is unavailable.
 */
export function readLocalProfile(): LocalProfile {
  try {
    const raw = localStorage.getItem(PROFILE_STORAGE_KEY);
    if (raw !== null) {
      const parsed = JSON.parse(raw) as unknown;
      if (isLocalProfile(parsed)) return parsed;
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

export function setLocalProfileAvatar(avatar: number): LocalProfile {
  const current = readLocalProfile();
  if (!isProfileAvatar(avatar)) return current;
  const next = { ...current, avatar };
  writeLocalProfile(next);
  return next;
}
