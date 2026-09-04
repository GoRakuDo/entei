/**
 * Tests for the Nadeshiko API client.
 * ---------------------------------------------------------------------------
 * Conforms to https://nadeshiko.co/docs/api/openapi.yaml v2.4.12. All mock
 * request/response shapes mirror the spec — including the nested `query`
 * object on POST /v1/search, the `Segment.publicId` identifier, the
 * `textJa.content` / `textEn.content` translation fields, and the deeply
 * nested `quota.{used, limit, remaining, periodEnd}` shape on
 * GET /v1/user/me. Defensive fallback parsing for older field names is
 * covered separately so we keep that insurance path tested.
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

  it('search: POSTs spec-conformant body and parses segments + includes.media', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({
        segments: [
          {
            publicId: 'wy1hTtMJg6Jf',
            position: 642,
            status: 'ACTIVE',
            startTimeMs: 719343,
            endTimeMs: 723055,
            contentRating: 'SAFE',
            episode: 5,
            mediaPublicId: 'izs1jikMfEFq',
            textJa: {
              content: '猫! 猫 猫 猫... 猫がぁ...',
              highlight: '<mark>猫</mark>!',
              tokens: [],
            },
            textEn: { content: 'Please get it off!', isMachineTranslated: false, highlight: null },
            textEs: { content: '¡Gato!', isMachineTranslated: false, highlight: null },
            urls: {
              imageUrl: 'https://cdn.nadeshiko.co/x.webp',
              audioUrl: 'https://cdn.nadeshiko.co/x.mp3',
              videoUrl: 'https://cdn.nadeshiko.co/x.mp4',
            },
          },
        ],
        includes: {
          media: {
            izs1jikMfEFq: {
              publicId: 'izs1jikMfEFq',
              nameJa: 'らんま1/2 (2024) 第2期',
              nameRomaji: 'Ranma 1/2 (2024) 2nd Season',
              nameEn: 'Ranma1/2 (2024) Season 2',
            },
          },
        },
        pagination: {
          hasMore: true,
          estimatedTotalHits: 1233,
          estimatedTotalHitsRelation: 'EXACT',
          cursor: 'eyJraW5kIjoia2V5c2V0In0',
        },
      }),
    );

    const result = await searchNadeshikoSegments('KEY', '猫');
    expect(result).toHaveLength(1);
    expect(result[0]!.id).toBe('wy1hTtMJg6Jf');
    expect(result[0]!.workName).toBe('らんま1/2 (2024) 第2期');
    expect(result[0]!.line).toBe('猫! 猫 猫 猫... 猫がぁ...');
    expect(result[0]!.englishTranslation).toBe('Please get it off!');
    // 719343 ms → 719 seconds → 11:59
    expect(result[0]!.timestampSeconds).toBe(719.343);
    expect(result[0]!.timestampLabel).toBe('11:59');
    expect(result[0]!.mediaPublicId).toBe('izs1jikMfEFq');
    expect(result[0]!.highlightJa).toBe('<mark>猫</mark>!');
    expect(result[0]!.urls?.imageUrl).toBe('https://cdn.nadeshiko.co/x.webp');

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toBe('https://api.nadeshiko.co/v1/search');
    const reqInit = init as RequestInit;
    expect(reqInit.method).toBe('POST');
    expect(JSON.parse(reqInit.body as string)).toEqual({
      query: { search: '猫' },
      take: 10,
      sort: { mode: 'RELEVANCE' },
    });
    expect(reqInit.headers).toEqual(
      expect.objectContaining({
        Authorization: 'Bearer KEY',
        'Content-Type': 'application/json',
      }),
    );
  });

  it('search: passes through spec options (take, mode, exactMatch, cursor, include, seed)', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ segments: [] }));
    await searchNadeshikoSegments(
      'KEY',
      '猫',
      {
        take: 25,
        mode: 'TIME_DESC',
        exactMatch: true,
        cursor: 'opaque-token',
        include: ['media'],
      },
    );
    expect(JSON.parse(fetchMock.mock.calls[0]![1]!.body as string)).toEqual({
      query: { search: '猫', exactMatch: true },
      take: 25,
      sort: { mode: 'TIME_DESC' },
      cursor: 'opaque-token',
      include: ['media'],
    });
  });

  it('search: omits exactMatch when not specified (spec default is false)', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ segments: [] }));
    await searchNadeshikoSegments('KEY', '猫');
    const body = JSON.parse(fetchMock.mock.calls[0]![1]!.body as string);
    // Spec marks exactMatch default as false. We omit the field rather than
    // send an explicit false — semantically equivalent, less wire noise.
    expect(body.query).toEqual({ search: '猫' });
    expect('exactMatch' in body.query).toBe(false);
  });

  it('search: passes RANDOM seed through to the request body', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ segments: [] }));
    await searchNadeshikoSegments('KEY', 'q', { mode: 'RANDOM', seed: 42 });
    const body = JSON.parse(fetchMock.mock.calls[0]![1]!.body as string);
    expect(body.sort).toEqual({ mode: 'RANDOM', seed: 42 });
  });

  it('search: returns empty array on missing segments field', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ pagination: { hasMore: false } }));
    const result = await searchNadeshikoSegments('KEY', 'q');
    expect(result).toEqual([]);
  });

  it('search: empty query returns empty array without calling fetch', async () => {
    const result = await searchNadeshikoSegments('KEY', '   ');
    expect(result).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('search: tolerates missing includes.media (workName stays empty)', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        segments: [
          {
            publicId: 'a',
            textJa: { content: 'x' },
            textEn: { content: 'x' },
            startTimeMs: 1000,
            mediaPublicId: 'missing-id',
          },
        ],
      }),
    );
    const r = await searchNadeshikoSegments('KEY', 'q');
    expect(r).toHaveLength(1);
    expect(r[0]!.workName).toBe('');
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

  it('maps 429 with QUOTA_EXCEEDED body to quota-exceeded', async () => {
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({ code: 'QUOTA_EXCEEDED', title: 'Monthly quota exceeded' }),
        { status: 429, headers: { 'Content-Type': 'application/json' } },
      ),
    );
    await expect(searchNadeshikoSegments('K', 'q')).rejects.toMatchObject({
      kind: 'quota-exceeded',
      status: 429,
    });
  });

  it('maps 429 with RATE_LIMIT_EXCEEDED body to rate-limited (not quota)', async () => {
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({ code: 'RATE_LIMIT_EXCEEDED' }),
        { status: 429, headers: { 'Content-Type': 'application/json' } },
      ),
    );
    await expect(searchNadeshikoSegments('K', 'q')).rejects.toMatchObject({
      kind: 'rate-limited',
      status: 429,
    });
  });

  it('maps 429 with empty-object body to rate-limited (default)', async () => {
    fetchMock.mockResolvedValue(
      new Response('{}', { status: 429, headers: { 'Content-Type': 'application/json' } }),
    );
    await expect(searchNadeshikoSegments('K', 'q')).rejects.toMatchObject({
      kind: 'rate-limited',
      status: 429,
    });
  });

  it('maps 429 with non-JSON body to rate-limited (parse failure defaults)', async () => {
    fetchMock.mockResolvedValue(
      new Response('not-json', { status: 429, headers: { 'Content-Type': 'text/plain' } }),
    );
    await expect(searchNadeshikoSegments('K', 'q')).rejects.toMatchObject({
      kind: 'rate-limited',
      status: 429,
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
    fetchMock.mockResolvedValue(jsonResponse({ segments: [] }));
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
    await expect(p).rejects.toBeDefined();
  });

  it('getSegmentContext: returns center + surrounding from flat segments[]', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({
        segments: [
          { publicId: 'before', textJa: { content: '前' }, startTimeMs: 1000, mediaPublicId: 'm' },
          { publicId: 'center', textJa: { content: '今' }, startTimeMs: 2000, mediaPublicId: 'm' },
          { publicId: 'after', textJa: { content: '後' }, startTimeMs: 3000, mediaPublicId: 'm' },
        ],
      }),
    );
    const ctx = await getNadeshikoSegmentContext('K', 'center');
    expect(ctx.center.id).toBe('center');
    expect(ctx.center.line).toBe('今');
    expect(ctx.surrounding).toHaveLength(2);
    expect(ctx.surrounding.map((s) => s.id)).toEqual(['before', 'after']);
  });

  it('getSegmentContext: places the center in surrounding list correctly when not first', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({
        segments: [
          { publicId: 'a', textJa: { content: 'A' }, startTimeMs: 1000 },
          { publicId: 'b', textJa: { content: 'B' }, startTimeMs: 2000 },
          { publicId: 'center', textJa: { content: 'C' }, startTimeMs: 3000 },
          { publicId: 'd', textJa: { content: 'D' }, startTimeMs: 4000 },
        ],
      }),
    );
    const ctx = await getNadeshikoSegmentContext('K', 'center');
    expect(ctx.center.line).toBe('C');
    expect(ctx.surrounding.map((s) => s.id)).toEqual(['a', 'b', 'd']);
  });

  it('getSegmentContext: tolerates empty segments list', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ segments: [] }));
    const ctx = await getNadeshikoSegmentContext('K', 'missing');
    expect(ctx.center.id).toBe('missing');
    expect(ctx.surrounding).toEqual([]);
  });

  it('getSegmentContext: appends take to the URL when provided', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ segments: [] }));
    await getNadeshikoSegmentContext('K', 'x', undefined, { take: 10 });
    expect(String(fetchMock.mock.calls[0]![0])).toContain('take=10');
  });

  it('getSegmentContext: omits take when not provided (spec default applies)', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ segments: [] }));
    await getNadeshikoSegmentContext('K', 'x');
    expect(String(fetchMock.mock.calls[0]![0])).not.toContain('take=');
  });

  it('getSegmentContext: uses workName from includes.media', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({
        segments: [
          { publicId: 'x', textJa: { content: 'x' }, startTimeMs: 1000, mediaPublicId: 'mid' },
        ],
        includes: {
          media: {
            mid: { publicId: 'mid', nameJa: 'タイトル', nameEn: 'Title' },
          },
        },
      }),
    );
    const ctx = await getNadeshikoSegmentContext('K', 'x');
    expect(ctx.center.workName).toBe('タイトル');
  });

  it('getUserMe: parses spec UserMe shape (quota.used/limit/remaining/periodEnd)', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({
        user: {
          username: 'tanaka_san',
          createdAt: '2024-03-15T10:00:00.000Z',
          role: 'USER',
        },
        quota: {
          used: 342,
          limit: 5000,
          remaining: 4658,
          periodYyyymm: 202602,
          periodStart: '2026-02-01T00:00:00.000Z',
          periodEnd: '2026-02-28T23:59:59.999Z',
          tier: { id: 'plus', displayName: 'Plus' },
          burst: { max: 150, windowMs: 60000 },
        },
      }),
    );
    const me = await getNadeshikoUserMe('K');
    expect(me).toEqual({
      username: 'tanaka_san',
      role: 'USER',
      createdAt: '2024-03-15T10:00:00.000Z',
      used: 342,
      monthlyLimit: 5000,
      remaining: 4658,
      periodYyyymm: 202602,
      periodStart: '2026-02-01T00:00:00.000Z',
      periodEnd: '2026-02-28T23:59:59.999Z',
      tierDisplayName: 'Plus',
      burstMax: 150,
      burstWindowMs: 60000,
    });
  });

  it('getUserMe: tolerates tier:null (un-tiered account)', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        user: { username: 'a', createdAt: '2024-01-01T00:00:00.000Z', role: 'USER' },
        quota: {
          used: 0,
          limit: 5000,
          remaining: 5000,
          periodYyyymm: 202609,
          periodStart: '2026-09-01T00:00:00.000Z',
          periodEnd: '2026-09-30T23:59:59.999Z',
          tier: null,
          burst: { max: 150, windowMs: 60000 },
        },
      }),
    );
    const me = await getNadeshikoUserMe('K');
    expect(me.tierDisplayName).toBeUndefined();
    expect(me.burstMax).toBe(150);
  });

  it('getUserMe: tolerates a quota wrapper that is missing (network error shape)', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({}));
    const me = await getNadeshikoUserMe('K');
    expect(me.monthlyLimit).toBeUndefined();
    expect(me.remaining).toBeUndefined();
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
