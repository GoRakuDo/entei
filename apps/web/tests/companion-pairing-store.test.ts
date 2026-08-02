/**
 * companion-pairing-store — localStorage persistence module tests.
 * ---------------------------------------------------------------------------
 * Covers: token read/write round trip, schema-versioned envelope,
 * fail-closed behavior for malformed/unavailable storage and invalid
 * tokens, and the "only the opaque token is persisted" contract.
 * --------------------------------------------------------------------------- */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  ENTEI_EIZOU_PAIRING_KEY,
  PAIRING_SCHEMA_VERSION,
  clearStoredPairingToken,
  isValidPairingToken,
  readStoredPairingToken,
  writeStoredPairingToken,
} from '@/features/player/companion-pairing-store';

const VALID_TOKEN =
  '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

beforeEach(() => {
  window.localStorage.clear();
});

afterEach(() => {
  window.localStorage.clear();
});

describe('token shape validation', () => {
  it('accepts the 64-lowercase-hex capability shape', () => {
    expect(isValidPairingToken(VALID_TOKEN)).toBe(true);
    expect(isValidPairingToken('ab'.repeat(32))).toBe(true);
  });

  it('rejects everything else (fail closed)', () => {
    for (const bad of [
      '',
      'tok-abc',
      VALID_TOKEN.toUpperCase(),
      'g'.repeat(64),
      VALID_TOKEN.slice(1), // 63 chars
      VALID_TOKEN + '0', // 65 chars
    ]) {
      expect(isValidPairingToken(bad)).toBe(false);
    }
  });
});

describe('read/write round trip', () => {
  it('returns null when nothing was ever stored', () => {
    expect(readStoredPairingToken()).toBeNull();
  });

  it('round-trips a valid token in the versioned envelope', () => {
    writeStoredPairingToken(VALID_TOKEN);
    expect(readStoredPairingToken()).toBe(VALID_TOKEN);

    // The persisted form is the schema-versioned envelope.
    const raw = window.localStorage.getItem(ENTEI_EIZOU_PAIRING_KEY);
    expect(raw).not.toBeNull();
    const env = JSON.parse(raw as string) as { v: number; token: string };
    expect(env.v).toBe(PAIRING_SCHEMA_VERSION);
    expect(env.token).toBe(VALID_TOKEN);
  });

  it('persists ONLY the opaque token — the code is never stored', () => {
    writeStoredPairingToken(VALID_TOKEN);
    const raw = window.localStorage.getItem(ENTEI_EIZOU_PAIRING_KEY) as string;
    // The envelope contains exactly the schema version + token keys.
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    expect(Object.keys(parsed).sort()).toEqual(['token', 'v']);
    expect(raw).not.toContain('magnet');
    expect(raw).not.toContain('url');
    expect(raw).not.toContain('source');
    expect(raw).not.toContain('cookie');
  });

  it('clear removes the entry', () => {
    writeStoredPairingToken(VALID_TOKEN);
    expect(readStoredPairingToken()).toBe(VALID_TOKEN);
    clearStoredPairingToken();
    expect(readStoredPairingToken()).toBeNull();
    // Clearing an absent entry is harmless.
    clearStoredPairingToken();
  });

  it('refuses to persist an invalid token (nothing written)', () => {
    writeStoredPairingToken('not-a-token');
    expect(window.localStorage.getItem(ENTEI_EIZOU_PAIRING_KEY)).toBeNull();
    expect(readStoredPairingToken()).toBeNull();
  });
});

describe('fail-closed reads (behave unpaired, safely)', () => {
  it('malformed JSON → null', () => {
    window.localStorage.setItem(ENTEI_EIZOU_PAIRING_KEY, '{not json');
    expect(readStoredPairingToken()).toBeNull();
  });

  it('unknown schema version → null', () => {
    window.localStorage.setItem(
      ENTEI_EIZOU_PAIRING_KEY,
      JSON.stringify({ v: 99, token: VALID_TOKEN }),
    );
    expect(readStoredPairingToken()).toBeNull();
  });

  it('missing version → null', () => {
    window.localStorage.setItem(
      ENTEI_EIZOU_PAIRING_KEY,
      JSON.stringify({ token: VALID_TOKEN }),
    );
    expect(readStoredPairingToken()).toBeNull();
  });

  it('invalid stored token shape → null', () => {
    window.localStorage.setItem(
      ENTEI_EIZOU_PAIRING_KEY,
      JSON.stringify({ v: 1, token: 'short' }),
    );
    expect(readStoredPairingToken()).toBeNull();
  });

  it('empty string value → null', () => {
    window.localStorage.setItem(ENTEI_EIZOU_PAIRING_KEY, '');
    expect(readStoredPairingToken()).toBeNull();
  });

  it('non-object JSON → null', () => {
    window.localStorage.setItem(ENTEI_EIZOU_PAIRING_KEY, '"token"');
    expect(readStoredPairingToken()).toBeNull();
  });

  it('throwing localStorage (unavailable storage) → null and never throws', () => {
    const getItemSpy = vi
      .spyOn(Storage.prototype, 'getItem')
      .mockImplementation(() => {
        throw new DOMException('denied', 'SecurityError');
      });
    expect(() => readStoredPairingToken()).not.toThrow();
    expect(readStoredPairingToken()).toBeNull();
    getItemSpy.mockRestore();
  });

  it('throwing localStorage on write → swallowed, read stays null', () => {
    const setItemSpy = vi
      .spyOn(Storage.prototype, 'setItem')
      .mockImplementation(() => {
        throw new DOMException('quota', 'QuotaExceededError');
      });
    expect(() => writeStoredPairingToken(VALID_TOKEN)).not.toThrow();
    expect(readStoredPairingToken()).toBeNull();
    setItemSpy.mockRestore();
  });

  it('throwing localStorage on clear → swallowed', () => {
    writeStoredPairingToken(VALID_TOKEN);
    const removeSpy = vi
      .spyOn(Storage.prototype, 'removeItem')
      .mockImplementation(() => {
        throw new DOMException('denied', 'SecurityError');
      });
    expect(() => clearStoredPairingToken()).not.toThrow();
    removeSpy.mockRestore();
  });
});
