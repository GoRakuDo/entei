/**
 * yt-download-mode — YouTube download mode preference tests.
 * ---------------------------------------------------------------------------
 * Covers: default quality, persisted round-trip, corrupted / invalid values
 * falling back to quality, storage-failure safety.
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

  it('defaults to quality when nothing is stored', () => {
    expect(readYtDownloadMode()).toBe('quality');
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

  it('falls back to quality for corrupted JSON', () => {
    localStorage.setItem(YT_MODE_KEY, '{not-json');
    expect(readYtDownloadMode()).toBe(DEFAULT_YT_MODE);
  });

  it('falls back to quality for an invalid enum value', () => {
    localStorage.setItem(YT_MODE_KEY, '"ultra"');
    expect(readYtDownloadMode()).toBe('quality');
  });

  it('falls back to quality for a non-string value', () => {
    localStorage.setItem(YT_MODE_KEY, '42');
    expect(readYtDownloadMode()).toBe('quality');
  });
});