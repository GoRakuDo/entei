/**
 * trace-logger — payload safety + queue behaviour.
 * ---------------------------------------------------------------------------
 * The trace journal is the only place where user activity is written to disk,
 * so the two things that must never regress are:
 *
 * 1. secrets never reach the file (`token=…`, api keys, cookies), and
 * 2. a broken/slow writer never grows the queue without bound.
 *
 * These are pure-logic tests: no Tauri runtime, no disk, no DOM events.
 * ---------------------------------------------------------------------------
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import {
  getTraceDroppedCount,
  getTracePendingCount,
  getTraceRecent,
  resetTraceState,
  routeArea,
  sanitize,
  shouldTraceHttp,
  trace,
} from '@/features/trace/trace-logger';

beforeEach(() => {
  resetTraceState();
});

afterEach(() => {
  resetTraceState();
});

describe('sanitize', () => {
  it('redacts token-ish keys at any depth', () => {
    const clean = sanitize({
      token: 'abc123',
      nested: { apiKey: 'k', password: 'p', cookie: 'c' },
      safe: 'kept',
    }) as Record<string, unknown>;

    expect(clean.token).toBe('[redacted]');
    const nested = clean.nested as Record<string, unknown>;
    expect(nested.apiKey).toBe('[redacted]');
    expect(nested.password).toBe('[redacted]');
    expect(nested.cookie).toBe('[redacted]');
    expect(clean.safe).toBe('kept');
  });

  it('rewrites token=… inside URLs and messages', () => {
    expect(
      sanitize('http://127.0.0.1:4322/v1/source/jobs?token=deadbeef&x=1'),
    ).toBe('http://127.0.0.1:4322/v1/source/jobs?token=[redacted]&x=1');
  });

  it('masks magnet URIs down to a short infohash', () => {
    const magnet =
      'magnet:?xt=urn:btih:0123456789abcdef0123456789abcdef01234567&dn=Some.Release.1080p&tr=https%3A%2F%2Fuser%3APASSKEY%40tracker.example%2Fannounce&tr=udp%3A%2F%2Ftracker.example%3A1337&xs=http%3A%2F%2Fmirror.example%2Ffile';
    const clean = sanitize(magnet) as string;

    // Short infohash only (12 hex), never the full 40-character one.
    expect(clean).toContain('xt=urn:btih:0123456789ab');
    expect(clean).not.toContain('0123456789abcdef0123456789abcdef01234567');
    // Tracker passkey, display name and mirrors never reach the log.
    expect(clean).not.toContain('PASSKEY');
    expect(clean).not.toContain('tracker.example');
    expect(clean).not.toContain('Some.Release.1080p');
    expect(clean).not.toContain('mirror.example');
    expect(clean).toContain('dn=[redacted]');
    expect(clean).toContain('tr=[redacted]');
    expect(clean).toContain('xs=[redacted]');
  });

  it('masks a magnet URI nested inside a payload or an error message', () => {
    const magnet =
      'magnet:?xt=urn:btih:ffffffffffffffffffffffffffffffffffffffff&tr=https://u:p@private.example/a';
    const clean = sanitize({
      magnetUri: magnet,
      message: `failed to add ${magnet}`,
    }) as Record<string, unknown>;

    expect(clean.magnetUri).toBe('magnet:?xt=urn:btih:ffffffffffff&tr=[redacted]');
    expect(String(clean.message)).not.toContain('p@private.example');

    const fromError = sanitize(new Error(`bad ${magnet}`)) as Record<string, unknown>;
    expect(String(fromError.message)).not.toContain('private.example');
  });

  it('clips long strings and bounds arrays', () => {
    const clipped = sanitize('x'.repeat(1000)) as string;
    expect(clipped.length).toBeLessThanOrEqual(301);
    expect(clipped.endsWith('…')).toBe(true);

    const list = sanitize(Array.from({ length: 100 }, (_, i) => i)) as unknown[];
    expect(list.length).toBe(41);
    expect(list[40]).toBe('[+60]');
  });

  it('turns Error instances into name/message without throwing', () => {
    const clean = sanitize(new Error('boom token=secret')) as Record<string, unknown>;
    expect(clean.name).toBe('Error');
    expect(clean.message).toBe('boom token=[redacted]');
  });

  it('never throws on unserializable values', () => {
    expect(sanitize(Symbol('s'))).toBe('Symbol(s)');
    expect(sanitize(() => 1)).toBe('[function]');
    expect(sanitize(Number.NaN)).toBe('NaN');
  });
});

describe('trace queue', () => {
  it('records entries with a session id in the payload', () => {
    trace('player', 'seek', { to: 12.5 });
    const [record] = getTraceRecent();
    expect(record?.area).toBe('player');
    expect(record?.event).toBe('seek');
    expect(record?.data.to).toBe(12.5);
    expect(typeof record?.data.sid).toBe('string');
    expect(getTracePendingCount()).toBe(1);
  });

  it('drops the oldest entries instead of growing without bound', () => {
    for (let i = 0; i < 900; i += 1) trace('ui', 'click', { i });
    expect(getTracePendingCount()).toBeLessThanOrEqual(500);
    expect(getTraceDroppedCount()).toBeGreaterThan(0);
  });
});

describe('routeArea', () => {  it('maps the known routes', () => {
    const original = window.location.pathname;
    const setPath = (path: string) => {
      window.history.replaceState({}, '', path);
    };
    setPath('/player/');
    expect(routeArea()).toBe('player');
    setPath('/audio-player/');
    expect(routeArea()).toBe('audio');
    setPath('/profile/');
    expect(routeArea()).toBe('profile');
    setPath('/modules/');
    expect(routeArea()).toBe('modules');
    setPath('/');
    expect(routeArea()).toBe('home');
    setPath(original);
  });
});

describe('HTTP poll throttling', () => {
  it('logs the first response, then only changes and heartbeats', () => {
    const key = 'GET /v1/source/torrents/poll-test/status';
    const t0 = 1_000_000;
    expect(shouldTraceHttp(key, 200, t0)).toBe(true);
    // Same status inside the window: suppressed (polling must not flood).
    expect(shouldTraceHttp(key, 200, t0 + 1_000)).toBe(false);
    expect(shouldTraceHttp(key, 200, t0 + 4_999)).toBe(false);
    // A status change is always recorded.
    expect(shouldTraceHttp(key, 403, t0 + 5_000)).toBe(true);
    // Back to the previous status after the window: heartbeat line.
    expect(shouldTraceHttp(key, 403, t0 + 11_000)).toBe(true);
  });
});
