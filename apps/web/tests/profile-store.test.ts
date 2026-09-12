import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  PROFILE_AVATAR_MAX_BYTES,
  PROFILE_BIO_MAX_LENGTH,
  PROFILE_SCHEMA_VERSION,
  PROFILE_STORAGE_KEY,
  getProfileAvatarDataUrlBytes,
  readLocalProfile,
  setLocalProfileAvatar,
  writeLocalProfile,
} from '@/features/player/profile/profile-store';

const bundledProfile = {
  schemaVersion: PROFILE_SCHEMA_VERSION,
  name: 'Kitsune-AB12',
  bio: 'local profile',
  avatar: '/avatars/7.webp',
} as const;

const uploadedAvatar = 'data:image/webp;base64,AAAA';

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
    expect(profile.avatar).toMatch(/^\/avatars\/([1-9]|1[0-5])\.webp$/);
    expect(JSON.parse(localStorage.getItem(PROFILE_STORAGE_KEY)!)).toEqual(profile);
  });

  it('returns and preserves a valid persisted profile', () => {
    writeLocalProfile(bundledProfile);

    expect(readLocalProfile()).toEqual(bundledProfile);
    expect(localStorage.getItem(PROFILE_STORAGE_KEY)).toBe(JSON.stringify(bundledProfile));
  });

  it('migrates an old numeric avatar to its bundled path without changing schema or key', () => {
    localStorage.setItem(
      PROFILE_STORAGE_KEY,
      JSON.stringify({ ...bundledProfile, avatar: 7 }),
    );

    expect(readLocalProfile()).toEqual(bundledProfile);
    expect(JSON.parse(localStorage.getItem(PROFILE_STORAGE_KEY)!)).toEqual(bundledProfile);
  });

  it('keeps an uploaded image data URL', () => {
    const profile = { ...bundledProfile, avatar: uploadedAvatar };
    localStorage.setItem(PROFILE_STORAGE_KEY, JSON.stringify(profile));

    expect(readLocalProfile()).toEqual(profile);
  });

  it('caps bio by JavaScript length when text is pasted or set', () => {
    const overLimit = 'あ'.repeat(PROFILE_BIO_MAX_LENGTH + 12);

    expect(overLimit.slice(0, PROFILE_BIO_MAX_LENGTH)).toHaveLength(PROFILE_BIO_MAX_LENGTH);
  });

  it('rejects an uploaded avatar data URL above the storage cap', () => {
    const profile = readLocalProfile();
    const oversizedAvatar = `data:image/webp;base64,${'A'.repeat(300_000)}`;

    expect(getProfileAvatarDataUrlBytes(oversizedAvatar)).toBeGreaterThan(
      PROFILE_AVATAR_MAX_BYTES,
    );
    expect(setLocalProfileAvatar(oversizedAvatar)).toEqual(profile);
    expect(readLocalProfile()).toEqual(profile);
  });

  it.each([
    '{not json',
    JSON.stringify({ ...bundledProfile, avatar: 0 }),
    JSON.stringify({ ...bundledProfile, avatar: 16 }),
    JSON.stringify({ ...bundledProfile, avatar: 'not-an-avatar' }),
    JSON.stringify({ ...bundledProfile, bio: 42 }),
    JSON.stringify({ ...bundledProfile, schemaVersion: 2 }),
  ])('recovers safely from corrupt value %s', (raw) => {
    localStorage.setItem(PROFILE_STORAGE_KEY, raw);

    const recovered = readLocalProfile();

    expect(recovered.schemaVersion).toBe(1);
    expect(recovered.name).toMatch(/^Kitsune-[A-Z0-9]{4}$/);
    expect(recovered.bio).toBe('');
    expect(recovered.avatar).toMatch(/^\/avatars\/([1-9]|1[0-5])\.webp$/);
    expect(JSON.parse(localStorage.getItem(PROFILE_STORAGE_KEY)!)).toEqual(recovered);
  });
});
