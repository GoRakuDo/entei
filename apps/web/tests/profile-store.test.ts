import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  PROFILE_AVATAR_COUNT,
  PROFILE_BIO_MAX_LENGTH,
  PROFILE_SCHEMA_VERSION,
  PROFILE_STORAGE_KEY,
  readLocalProfile,
  truncateProfileBio,
  writeLocalProfile,
} from '@/features/player/profile/profile-store';

const validProfile = {
  schemaVersion: PROFILE_SCHEMA_VERSION,
  name: 'Kitsune-AB12',
  bio: 'local profile',
  avatar: 7,
} as const;

afterEach(() => {
  localStorage.clear();
  vi.restoreAllMocks();
});

describe('local profile store', () => {
  it('creates a random initial profile and persists it on first read', () => {
    vi.spyOn(Math, 'random')
      .mockReturnValueOnce(0)
      .mockReturnValueOnce(0.1)
      .mockReturnValueOnce(0.2)
      .mockReturnValueOnce(0.3)
      .mockReturnValueOnce(0.4);

    const profile = readLocalProfile();

    expect(profile.schemaVersion).toBe(1);
    expect(profile.name).toMatch(/^Kitsune-[A-Z0-9]{4}$/);
    expect(profile.bio).toBe('');
    expect(profile.avatar).toBeGreaterThanOrEqual(1);
    expect(profile.avatar).toBeLessThanOrEqual(PROFILE_AVATAR_COUNT);
    expect(JSON.parse(localStorage.getItem(PROFILE_STORAGE_KEY)!)).toEqual(profile);
  });

  it('returns and preserves a valid persisted profile', () => {
    writeLocalProfile(validProfile);

    expect(readLocalProfile()).toEqual(validProfile);
    expect(localStorage.getItem(PROFILE_STORAGE_KEY)).toBe(JSON.stringify(validProfile));
  });

  it('caps bio by JavaScript length when text is pasted or set', () => {
    const overLimit = 'あ'.repeat(PROFILE_BIO_MAX_LENGTH + 12);

    expect(truncateProfileBio(overLimit)).toHaveLength(PROFILE_BIO_MAX_LENGTH);
  });

  it.each([
    '{not json',
    JSON.stringify({ ...validProfile, avatar: 0 }),
    JSON.stringify({ ...validProfile, avatar: 16 }),
    JSON.stringify({ ...validProfile, bio: 42 }),
    JSON.stringify({ ...validProfile, schemaVersion: 2 }),
  ])('recovers safely from corrupt value %s', (raw) => {
    localStorage.setItem(PROFILE_STORAGE_KEY, raw);

    const recovered = readLocalProfile();

    expect(recovered.schemaVersion).toBe(1);
    expect(recovered.name).toMatch(/^Kitsune-[A-Z0-9]{4}$/);
    expect(recovered.bio).toBe('');
    expect(recovered.avatar).toBeGreaterThanOrEqual(1);
    expect(recovered.avatar).toBeLessThanOrEqual(PROFILE_AVATAR_COUNT);
    expect(JSON.parse(localStorage.getItem(PROFILE_STORAGE_KEY)!)).toEqual(recovered);
  });
});
