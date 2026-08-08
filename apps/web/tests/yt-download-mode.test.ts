/**
 * yt-download-mode — YouTube download mode preference tests.
 * ---------------------------------------------------------------------------
 * Covers: default speed (2026-08-08: default changed from quality),
 * persisted round-trip, corrupted / invalid values falling back to the
 * default, storage-failure safety.
 * --------------------------------------------------------------------------- */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  YT_MODE_KEY,
  readYtDownloadMode,
  writeYtDownloadMode,
  DEFAULT_YT_MODE,
} from '../src/features/player/yt-download-mode';

describe('yt-download-mode', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  afterEach(() => {
    localStorage.clear();
  });

  it('defaults to speed when nothing is stored', () => {
    expect(readYtDownloadMode()).toBe('speed');
  });

  it('persists and reads back the speed mode', () => {
    writeYtDownloadMode('speed');
    expect(localStorage.getItem(YT_MODE_KEY)).toBe('"speed"');
    expect(readYtDownloadMode()).toBe('speed');
  });

  it('persists and reads back the quality mode', () => {
    writeYtDownloadMode('quality');
    expect(readYtDownloadMode()).toBe('quality');
  });

  it('falls back to the default for corrupted JSON', () => {
    localStorage.setItem(YT_MODE_KEY, '{not-json');
    expect(readYtDownloadMode()).toBe(DEFAULT_YT_MODE);
    expect(readYtDownloadMode()).toBe('speed');
  });

  it('falls back to speed for an invalid enum value', () => {
    localStorage.setItem(YT_MODE_KEY, '"ultra"');
    expect(readYtDownloadMode()).toBe('speed');
  });

  it('falls back to speed for a non-string value', () => {
    localStorage.setItem(YT_MODE_KEY, '42');
    expect(readYtDownloadMode()).toBe('speed');
  });
});