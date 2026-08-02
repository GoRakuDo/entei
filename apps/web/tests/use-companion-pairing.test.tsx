/**
 * useCompanionPairing — persistent pairing hook tests.
 * ---------------------------------------------------------------------------
 * Covers: mount re-validation of a stored token (200 → connected; 401/403
 * → clear + unpaired; network → keep + disconnected), pair-success
 * persistence (only the opaque token), the explicit reset contract
 * (companion DELETE first, browser clear regardless of network outcome),
 * and no token leakage into the DOM.
 * --------------------------------------------------------------------------- */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act, waitFor, cleanup } from '@testing-library/react';
import { useCompanionPairing } from '@/features/player/use-companion-pairing';
import {
  ENTEI_EIZOU_PAIRING_KEY,
  readStoredPairingToken,
  writeStoredPairingToken,
} from '@/features/player/companion-pairing-store';

const VALID_TOKEN = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
const OTHER_TOKEN = 'ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff';
const STATUS_URL = `http://127.0.0.1:4322/v1/pair/status?token=${VALID_TOKEN}`;
const DELETE_URL = `http://127.0.0.1:4322/v1/pair?token=${VALID_TOKEN}`;

function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

beforeEach(() => {
  window.localStorage.clear();
  vi.restoreAllMocks();
});

afterEach(() => {
  cleanup();
  window.localStorage.clear();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('mount re-validation of a stored token', () => {
  it('no stored token → unpaired, no network call', () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const { result } = renderHook(() => useCompanionPairing());
    expect(result.current.connected).toBe(false);
    expect(result.current.token).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('stored token accepted (200) → connected without re-pairing', async () => {
    writeStoredPairingToken(VALID_TOKEN);
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ status: 'paired' }, 200)));
    const { result } = renderHook(() => useCompanionPairing());
    await waitFor(() => expect(result.current.connected).toBe(true));
    expect(result.current.token).toBe(VALID_TOKEN);
    expect(result.current.validating).toBe(false);
    // Reload validation never re-pairs: the only request is the read-only
    // status query (no POST /v1/pair).
    const calls = vi.mocked(fetch).mock.calls.map((c) => String(c[0]));
    expect(calls).toEqual([STATUS_URL]);
  });

  it('stored token rejected (401) → stored value cleared, unpaired (no false connected)', async () => {
    writeStoredPairingToken(VALID_TOKEN);
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ error: 'unauthorized' }, 401)));
    const { result } = renderHook(() => useCompanionPairing());
    await waitFor(() => expect(result.current.validating).toBe(false));
    expect(result.current.connected).toBe(false);
    expect(result.current.token).toBeNull();
    expect(window.localStorage.getItem(ENTEI_EIZOU_PAIRING_KEY)).toBeNull();
  });

  it('stored token rejected (403) → cleared, unpaired', async () => {
    writeStoredPairingToken(VALID_TOKEN);
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ error: 'origin not allowed' }, 403)));
    const { result } = renderHook(() => useCompanionPairing());
    await waitFor(() => expect(result.current.validating).toBe(false));
    expect(result.current.connected).toBe(false);
    expect(window.localStorage.getItem(ENTEI_EIZOU_PAIRING_KEY)).toBeNull();
  });

  it('companion unreachable (network error) → token KEPT, disconnected', async () => {
    writeStoredPairingToken(VALID_TOKEN);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('Failed to fetch');
      }),
    );
    const { result } = renderHook(() => useCompanionPairing());
    await waitFor(() => expect(result.current.validating).toBe(false));
    expect(result.current.connected).toBe(false);
    // Do not destroy a possibly-valid stored token just because the
    // companion is momentarily down.
    expect(readStoredPairingToken()).toBe(VALID_TOKEN);
  });

  it('unexpected server status (500) → token kept, disconnected', async () => {
    writeStoredPairingToken(VALID_TOKEN);
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ error: 'boom' }, 500)));
    const { result } = renderHook(() => useCompanionPairing());
    await waitFor(() => expect(result.current.validating).toBe(false));
    expect(result.current.connected).toBe(false);
    expect(readStoredPairingToken()).toBe(VALID_TOKEN);
  });

  it('malformed stored value → unpaired without any network call', () => {
    window.localStorage.setItem(ENTEI_EIZOU_PAIRING_KEY, 'garbage');
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const { result } = renderHook(() => useCompanionPairing());
    expect(result.current.connected).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('pair success', () => {
  it('persists ONLY the opaque token and connects', async () => {
    const { result } = renderHook(() => useCompanionPairing());
    act(() => {
      result.current.handlePairSuccess(VALID_TOKEN);
    });
    expect(result.current.connected).toBe(true);
    expect(result.current.token).toBe(VALID_TOKEN);
    expect(result.current.tokenRef.current).toBe(VALID_TOKEN);
    const raw = window.localStorage.getItem(ENTEI_EIZOU_PAIRING_KEY);
    expect(raw).not.toBeNull();
    expect(raw).toContain(VALID_TOKEN);
    expect(raw).not.toContain('code');
  });

  it('refuses invalid tokens (fail closed: no persist, no connect)', () => {
    const { result } = renderHook(() => useCompanionPairing());
    act(() => {
      result.current.handlePairSuccess('not-a-token');
    });
    expect(result.current.connected).toBe(false);
    expect(result.current.token).toBeNull();
    expect(window.localStorage.getItem(ENTEI_EIZOU_PAIRING_KEY)).toBeNull();
  });

  it('never leaks the token into the DOM', async () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    try {
      const { result } = renderHook(() => useCompanionPairing());
      act(() => {
        result.current.handlePairSuccess(VALID_TOKEN);
      });
      expect(document.body.textContent ?? '').not.toContain(VALID_TOKEN);
    } finally {
      container.remove();
    }
  });
});

describe('explicit reset (destructive)', () => {
  it('calls companion DELETE with the token, then clears browser storage', async () => {
    writeStoredPairingToken(VALID_TOKEN);
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ status: 'paired' }, 200)));
    const { result } = renderHook(() => useCompanionPairing());
    await waitFor(() => expect(result.current.connected).toBe(true));

    const deleteMock = vi.fn(async () => jsonResponse({ status: 'unpaired' }, 200));
    vi.stubGlobal('fetch', deleteMock);
    await act(async () => {
      await result.current.resetPairing();
    });

    expect(deleteMock).toHaveBeenCalledWith(
      DELETE_URL,
      expect.objectContaining({ method: 'DELETE' }),
    );
    expect(result.current.connected).toBe(false);
    expect(result.current.token).toBeNull();
    expect(result.current.tokenRef.current).toBeNull();
    expect(window.localStorage.getItem(ENTEI_EIZOU_PAIRING_KEY)).toBeNull();
  });

  it('clears browser storage even when the companion is unreachable (graceful divergence)', async () => {
    writeStoredPairingToken(VALID_TOKEN);
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ status: 'paired' }, 200)));
    const { result } = renderHook(() => useCompanionPairing());
    await waitFor(() => expect(result.current.connected).toBe(true));

    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('Failed to fetch');
      }),
    );
    await act(async () => {
      await result.current.resetPairing();
    });

    // The browser ALWAYS ends unpaired — the delete attempt's failure
    // must not leave a stale "connected" or a stored token behind.
    expect(result.current.connected).toBe(false);
    expect(result.current.token).toBeNull();
    expect(window.localStorage.getItem(ENTEI_EIZOU_PAIRING_KEY)).toBeNull();
  });

  it('resets without a token (unpaired state) → no DELETE call, storage already clean', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const { result } = renderHook(() => useCompanionPairing());
    await act(async () => {
      await result.current.resetPairing();
    });
    expect(result.current.connected).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('after reset, pairing works again from a fresh code (state fully unpaired)', async () => {
    writeStoredPairingToken(VALID_TOKEN);
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ status: 'paired' }, 200)));
    const { result } = renderHook(() => useCompanionPairing());
    await waitFor(() => expect(result.current.connected).toBe(true));

    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ status: 'unpaired' }, 200)));
    await act(async () => {
      await result.current.resetPairing();
    });

    // A brand-new pair token (different from the reset one) reconnects.
    act(() => {
      result.current.handlePairSuccess(OTHER_TOKEN);
    });
    expect(result.current.connected).toBe(true);
    expect(result.current.token).toBe(OTHER_TOKEN);
    expect(result.current.tokenRef.current).toBe(OTHER_TOKEN);
  });
});
