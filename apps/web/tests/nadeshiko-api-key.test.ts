/**
 * Tests for the Nadeshiko API key localStorage helpers.
 * ---------------------------------------------------------------------------
 * - Read returns null when missing/corrupt/unavailable
 * - Write validates and returns success boolean
 * - Clear removes the entry
 * - SSR safety (no window) returns null without throwing
 * ---------------------------------------------------------------------------
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  readNadeshikoApiKey,
  writeNadeshikoApiKey,
  clearNadeshikoApiKey,
  NADESHIKO_API_KEY_STORAGE_KEY_NAME,
} from '../src/features/nadeshiko/api-key';

describe('nadeshiko api-key storage', () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it('read returns null when no key is stored', () => {
    expect(readNadeshikoApiKey()).toBeNull();
  });

  it('write + read roundtrip', () => {
    expect(writeNadeshikoApiKey('sk-test-1234')).toBe(true);
    expect(readNadeshikoApiKey()).toBe('sk-test-1234');
  });

  it('write trims whitespace before persisting', () => {
    writeNadeshikoApiKey('  sk-test-1234  ');
    expect(readNadeshikoApiKey()).toBe('sk-test-1234');
  });

  it('write rejects empty/whitespace-only key', () => {
    expect(writeNadeshikoApiKey('')).toBe(false);
    expect(writeNadeshikoApiKey('   ')).toBe(false);
    expect(readNadeshikoApiKey()).toBeNull();
  });

  it('read returns null for an empty string in storage (corrupt)', () => {
    window.localStorage.setItem(NADESHIKO_API_KEY_STORAGE_KEY_NAME, '   ');
    expect(readNadeshikoApiKey()).toBeNull();
  });

  it('clear removes the key', () => {
    writeNadeshikoApiKey('sk-test-1234');
    clearNadeshikoApiKey();
    expect(readNadeshikoApiKey()).toBeNull();
  });

  it('clear is a no-op when no key exists', () => {
    expect(() => clearNadeshikoApiKey()).not.toThrow();
  });

  it('storage key name matches the documented contract', () => {
    expect(NADESHIKO_API_KEY_STORAGE_KEY_NAME).toBe(
      'entei.nadeshiko.api-key.v1',
    );
  });
});