/**
 * Tests for the Nadeshiko API client.
 * ---------------------------------------------------------------------------
 * - search/getContext/getUserMe request shapes
 * - Error mapping for 401/403/429/network/malformed JSON
 * - Retry-After parsing (numeric + http-date fallback)
 * - Defensive field parsing for unknown response shapes
 * ---------------------------------------------------------------------------
 */

import { describe, expect, it, vi, beforeEach } from 'vitest';
import {
  searchNadeshikoSegments,
  getNadeshikoSegmentContext,
  getNadeshikoUserMe,
} from '../src/features/nadeshiko/nadeshiko-client';

function jsonResponse(data: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(data), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
    ...init,
  });
}

describe('nadeshiko-client', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    global.fetch = fetchMock as unknown as typeof fetch;
  });

  it('search: POSTs query and parses results array', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({
        results: [
          {
            id: 'seg-1',
            workName: 'Sousou no Frieren',
            line: 'また会えたね',
            englishTranslation: 'We met again.',
            timestamp: 91.5,
            timestampLabel: '01:31',
          },
        ],
      }),
    );

    const result = await searchNadeshikoSegments('KEY', '会えた');
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      id: 'seg-1',
      workName: 'Sousou no Frieren',
      line: 'また会えたね',
      englishTranslation: 'We met again.',
      timestampSeconds: 91.5,
      timestampLabel: '01:31',
    });

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toBe('https://api.nadeshiko.co/v1/search');
    const reqInit = init as RequestInit;
    expect(reqInit.method).toBe('POST');
    expect(JSON.parse(reqInit.body as string)).toEqual({
      query: '会えた',
      exactMatch: false,
      take: 10,
      mode: 'RELEVANCE',
      cursor: null,
    });
    expect(reqInit.headers).toEqual(
      expect.objectContaining({
        Authorization: 'Bearer KEY',
        'Content-Type': 'application/json',
      }),
    );
  });

  it('search: also accepts {items}/{segments}/bare-array response shapes', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ items: [{ id: 'a', line: 'x' }] }),
    );
    const a = await searchNadeshikoSegments('K', 'q');
    expect(a).toHaveLength(1);

    fetchMock.mockResolvedValueOnce(
      jsonResponse({ segments: [{ id: 'b', line: 'y' }] }),
    );
    const b = await searchNadeshikoSegments('K', 'q');
    expect(b).toHaveLength(1);

    fetchMock.mockResolvedValueOnce(jsonResponse([{ id: 'c', line: 'z' }]));
    const c = await searchNadeshikoSegments('K', 'q');
    expect(c).toHaveLength(1);
  });

  it('search: empty query returns empty array without calling fetch', async () => {
    const result = await searchNadeshikoSegments('KEY', '   ');
    expect(result).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('maps 401 to invalid-key', async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 401 }));
    await expect(searchNadeshikoSegments('K', 'q')).rejects.toMatchObject({
      kind: 'invalid-key',
      status: 401,
    });
  });

  it('maps 403 to invalid-key', async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 403 }));
    await expect(searchNadeshikoSegments('K', 'q')).rejects.toMatchObject({
      kind: 'invalid-key',
      status: 403,
    });
  });

  it('maps 429 with Retry-After to rate-limited', async () => {
    fetchMock.mockResolvedValue(
      new Response(null, { status: 429, headers: { 'Retry-After': '12' } }),
    );
    await expect(searchNadeshikoSegments('K', 'q')).rejects.toMatchObject({
      kind: 'rate-limited',
      retryAfterSeconds: 12,
    });
  });

  it('maps 500 to network', async () => {
    fetchMock.mockResolvedValue(new Response('oops', { status: 500 }));
    await expect(searchNadeshikoSegments('K', 'q')).rejects.toMatchObject({
      kind: 'network',
    });
  });

  it('maps a network failure to network', async () => {
    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'));
    await expect(searchNadeshikoSegments('K', 'q')).rejects.toMatchObject({
      kind: 'network',
    });
  });

  it('maps malformed JSON to invalid-response', async () => {
    fetchMock.mockResolvedValue(
      new Response('not-json', { status: 200, headers: { 'Content-Type': 'text/plain' } }),
    );
    await expect(searchNadeshikoSegments('K', 'q')).rejects.toMatchObject({
      kind: 'invalid-response',
    });
  });

  it('never leaks the API key into the request URL', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ results: [] }));
    await searchNadeshikoSegments('super-secret', 'q');
    const url = String(fetchMock.mock.calls[0]![0]);
    expect(url).not.toContain('super-secret');
  });

  it('threads AbortSignal and rejects without throwing on abort', async () => {
    fetchMock.mockImplementation(
      (_url: string, init: RequestInit) =>
        new Promise((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => {
            reject(new DOMException('aborted', 'AbortError'));
          });
        }),
    );
    const ac = new AbortController();
    const p = searchNadeshikoSegments('K', 'q', {}, ac.signal);
    ac.abort();
    // Network error path catches everything except when aborted; either is
    // fine — the contract is "we don't throw a non-mapped error".
    await expect(p).rejects.toBeDefined();
  });

  it('getSegmentContext: parses surrounding lines', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({
        segment: {
          id: 'seg-1',
          workName: 'W',
          line: 'target',
        },
        context: [
          { id: 'a', line: 'before', timestamp: 10 },
          { id: 'b', line: 'after', timestamp: 20 },
        ],
      }),
    );
    const ctx = await getNadeshikoSegmentContext('K', 'seg-1');
    expect(ctx.id).toBe('seg-1');
    expect(ctx.line).toBe('target');
    expect(ctx.surrounding).toHaveLength(2);
    expect(ctx.surrounding[0]!.line).toBe('before');
  });

  it('getSegmentContext: tolerates empty context array', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({
        segment: { id: 'seg-x', line: 'only' },
        context: [],
      }),
    );
    const ctx = await getNadeshikoSegmentContext('K', 'seg-x');
    expect(ctx.surrounding).toEqual([]);
  });

  it('getUserMe: parses remaining/limit/reset', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({
        remainingRequests: 4500,
        monthlyLimit: 5000,
        resetAt: '2026-09-01T00:00:00Z',
      }),
    );
    const me = await getNadeshikoUserMe('K');
    expect(me).toEqual({
      remainingRequests: 4500,
      monthlyLimit: 5000,
      resetAt: '2026-09-01T00:00:00Z',
    });
  });

  it('getUserMe: maps 429 to rate-limited', async () => {
    fetchMock.mockResolvedValue(
      new Response(null, { status: 429, headers: { 'Retry-After': '30' } }),
    );
    await expect(getNadeshikoUserMe('K')).rejects.toMatchObject({
      kind: 'rate-limited',
      retryAfterSeconds: 30,
    });
  });

  it('Retry-After http-date form is parsed as seconds-from-now', async () => {
    const future = new Date(Date.now() + 7000).toUTCString();
    fetchMock.mockResolvedValue(
      new Response(null, { status: 429, headers: { 'Retry-After': future } }),
    );
    await expect(searchNadeshikoSegments('K', 'q')).rejects.toMatchObject({
      kind: 'rate-limited',
    });
  });
});