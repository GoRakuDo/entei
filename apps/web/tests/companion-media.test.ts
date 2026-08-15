// SPDX-License-Identifier: Apache-2.0
// Unit tests for the companion media helpers (mock fetch; no real network).

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  CompanionBufferingError,
  dlProgressPercent,
  fetchMagnetPcm,
  fetchMagnetSubtitle,
  fetchMediaStatus,
  waitForPlayable,
} from '../src/features/player/companion-media';

const ORIGIN = 'http://127.0.0.1:4322';

afterEach(() => {
  vi.unstubAllGlobals();
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('dlProgressPercent', () => {
  it('returns 0 when total is unknown or zero', () => {
    expect(dlProgressPercent({ state: 'buffering', available: 0, total: 0 })).toBe(0);
    expect(dlProgressPercent({ state: 'buffering', available: 5, total: 0 })).toBe(0);
  });

  it('computes percent and clamps to 0..100', () => {
    expect(dlProgressPercent({ state: 'buffering', available: 25, total: 100 })).toBe(25);
    expect(dlProgressPercent({ state: 'complete', available: 100, total: 100 })).toBe(100);
    expect(dlProgressPercent({ state: 'buffering', available: -1, total: 100 })).toBe(0);
    expect(dlProgressPercent({ state: 'buffering', available: 999, total: 100 })).toBe(100);
  });
});

describe('fetchMagnetSubtitle', () => {
  it('fetches the torrent subtitle with the token (no file id in the URL)', async () => {
    const spy = vi.fn().mockResolvedValue(
      new Response('WEBVTT\n\n00:00:01 --> 00:00:03\nhello', {
        status: 200,
        headers: { 'content-type': 'text/vtt' },
      }),
    );
    vi.stubGlobal('fetch', spy);

    const out = await fetchMagnetSubtitle('tok', 'job-1', 'file-2');
    expect(out.text).toContain('WEBVTT');
    expect(out.format).toBe('vtt');
    const url = spy.mock.calls[0]![0] as string;
    expect(url).toContain(`${ORIGIN}/v1/source/torrents/job-1/subtitle`);
    expect(url).toContain('token=tok');
    // The selection state lives server-side; the client never sends a
    // `file=` query parameter (the companion serves the selected subtitle
    // or auto-detects the embedded one).
    expect(url).not.toContain('file=');
  });

  it('throws on non-ok response', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response('nope', { status: 404 })),
    );
    await expect(fetchMagnetSubtitle('tok', 'job-1', 'f')).rejects.toThrow(
      'companion subtitle fetch failed (404)',
    );
  });
});

describe('fetchMagnetPcm', () => {
  it('decodes f32le body and reads the sample-rate header', async () => {
    const bytes = new Float32Array([0.1, 0.2, -0.3]).buffer;
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(bytes, {
          status: 200,
          headers: { 'x-sample-rate': '16000' },
        }),
      ),
    );
    const out = await fetchMagnetPcm('tok');
    expect(out.sampleRate).toBe(16000);
    const got = Array.from(out.samples);
    expect(got).toHaveLength(3);
    expect(Math.abs(got[0]! - 0.1)).toBeLessThan(1e-6);
    expect(Math.abs(got[1]! - 0.2)).toBeLessThan(1e-6);
    expect(Math.abs(got[2]! - -0.3)).toBeLessThan(1e-6);
  });

  it('throws CompanionBufferingError with totals on 503', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        jsonResponse({ error: 'buffering', available: 30, total: 100 }, 503),
      ),
    );
    const p = fetchMagnetPcm('tok');
    await expect(p).rejects.toBeInstanceOf(CompanionBufferingError);
    await p.catch((e: CompanionBufferingError) => {
      expect(e.available).toBe(30);
      expect(e.total).toBe(100);
    });
  });

  it('maps a 404 to a user-facing unavailable message', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response('nope', { status: 404 })),
    );
    await expect(fetchMagnetPcm('tok')).rejects.toThrow(
      'voice-based sync is unavailable: no active media',
    );
  });
});

describe('fetchMediaStatus', () => {
  it('parses the status JSON', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        jsonResponse({ state: 'buffering', available: 40, total: 100, headReady: true }),
      ),
    );
    const out = await fetchMediaStatus('tok');
    expect(out.state).toBe('buffering');
    expect(out.available).toBe(40);
    expect(out.total).toBe(100);
    expect(dlProgressPercent(out)).toBe(40);
  });
});

describe('waitForPlayable', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns ok immediately on a playable status', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        jsonResponse({ state: 'playable', available: 50, total: 100 }),
      ),
    );
    expect(await waitForPlayable('tok')).toEqual({ ok: true, reason: 'playable' });
  });

  it('treats the complete state as playable', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        jsonResponse({ state: 'complete', available: 100, total: 100 }),
      ),
    );
    expect(await waitForPlayable('tok')).toEqual({ ok: true, reason: 'playable' });
  });

  it('polls until playable and reports intermediate states via onState', async () => {
    vi.useFakeTimers();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({ state: 'buffering', available: 10, total: 100 }),
      )
      .mockResolvedValueOnce(
        jsonResponse({ state: 'buffering', available: 40, total: 100 }),
      )
      .mockResolvedValueOnce(
        jsonResponse({ state: 'playable', available: 60, total: 100 }),
      );
    vi.stubGlobal('fetch', fetchMock);
    const seen: string[] = [];
    const pending = waitForPlayable('tok', {
      intervalMs: 1000,
      onState: (s) => seen.push(s.state),
    });
    await vi.advanceTimersByTimeAsync(2500);
    expect(await pending).toEqual({ ok: true, reason: 'playable' });
    // First poll is immediate; each subsequent poll follows one interval.
    expect(seen).toEqual(['buffering', 'buffering', 'playable']);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('returns an error result on the error state', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        jsonResponse({ state: 'error', available: 0, total: 0 }),
      ),
    );
    expect(await waitForPlayable('tok')).toEqual({ ok: false, reason: 'error' });
  });

  it('returns network after 5 consecutive fetch failures', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('down')));
    const pending = waitForPlayable('tok', { intervalMs: 100 });
    await vi.advanceTimersByTimeAsync(500);
    expect(await pending).toEqual({ ok: false, reason: 'network' });
  });

  it('returns timeout when the deadline passes', async () => {
    vi.useFakeTimers();
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        jsonResponse({ state: 'buffering', available: 0, total: 100 }),
      ),
    );
    const pending = waitForPlayable('tok', { intervalMs: 1000, timeoutMs: 2500 });
    await vi.advanceTimersByTimeAsync(3000);
    expect(await pending).toEqual({ ok: false, reason: 'timeout' });
  });

  it('returns aborted when the signal aborts during the wait', async () => {
    vi.useFakeTimers();
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        jsonResponse({ state: 'buffering', available: 0, total: 100 }),
      ),
    );
    const ac = new AbortController();
    const pending = waitForPlayable('tok', { intervalMs: 1000, signal: ac.signal });
    ac.abort();
    await vi.advanceTimersByTimeAsync(0);
    expect(await pending).toEqual({ ok: false, reason: 'aborted' });
  });
});
