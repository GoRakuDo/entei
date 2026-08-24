import { describe, expect, it, vi, beforeEach } from 'vitest';
import {
  downloadJimakuSubtitle,
  getJimakuEntryFiles,
  searchJimakuEntries,
} from '../src/features/player/jimaku-client';

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('jimaku-client', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    global.fetch = fetchMock as unknown as typeof fetch;
  });

  it('search succeeds and parses entries', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse([
        { id: 729, name: 'Sousou no Frieren', flags: { anime: true } },
      ]),
    );
    const result = await searchJimakuEntries('key', 'Sousou no Frieren', true);
    expect(result).toEqual({
      ok: true,
      data: [{ id: 729, name: 'Sousou no Frieren', flags: { anime: true } }],
    });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toContain('/entries/search?query=Sousou%20no%20Frieren&anime=true');
    expect((init as RequestInit).headers).toEqual({ Authorization: 'key' });
  });

  it('maps 429 to rate-limit', async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 429 }));
    const result = await searchJimakuEntries('key', 'Anime', true);
    expect(result).toEqual({ ok: false, error: 'rate-limit' });
  });

  it('maps 401 to auth', async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 401 }));
    const result = await searchJimakuEntries('key', 'Anime', true);
    expect(result).toEqual({ ok: false, error: 'auth' });
  });

  it('maps an empty result array to empty', async () => {
    fetchMock.mockResolvedValue(jsonResponse([]));
    const result = await searchJimakuEntries('key', 'No Such', true);
    expect(result).toEqual({ ok: false, error: 'empty' });
  });

  it('maps a network failure to network', async () => {
    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'));
    const result = await searchJimakuEntries('key', 'Anime', true);
    expect(result).toEqual({ ok: false, error: 'network' });
  });

  it('getJimakuEntryFiles appends the episode param', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse([
        { url: 'https://jimaku.cc/entry/1/download/a.srt', name: 'a.srt', size: 1, last_modified: 'x' },
      ]),
    );
    const result = await getJimakuEntryFiles('key', 12426, 1);
    expect(result.ok).toBe(true);
    const [url] = fetchMock.mock.calls[0]!;
    expect(String(url)).toContain('/entries/12426/files?episode=1');
  });

  it('downloadJimakuSubtitle returns the text body', async () => {
    fetchMock.mockResolvedValue(
      new Response('1\n00:00:00,000 --> 00:00:01,000\nhi', {
        status: 200,
      }),
    );
    const result = await downloadJimakuSubtitle('https://jimaku.cc/entry/1/download/a.srt');
    expect(result).toEqual({
      ok: true,
      data: '1\n00:00:00,000 --> 00:00:01,000\nhi',
    });
  });

  it('downloadJimakuSubtitle maps 404 to not-found', async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 404 }));
    const result = await downloadJimakuSubtitle('https://jimaku.cc/entry/1/download/missing.srt');
    expect(result).toEqual({ ok: false, error: 'not-found' });
  });

  it('never puts the API key in any request URL', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse([{ id: 1, name: 'x', flags: { anime: true } }]),
    );
    await searchJimakuEntries('super-secret-key', 'Anime', true);
    await getJimakuEntryFiles('super-secret-key', 1, 1);
    await downloadJimakuSubtitle('https://jimaku.cc/entry/1/download/a.srt');
    for (const call of fetchMock.mock.calls) {
      const url = String(call[0]);
      expect(url).not.toContain('super-secret-key');
    }
  });

  it('maps 403 to auth', async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 403 }));
    const result = await searchJimakuEntries('key', 'Anime', true);
    expect(result).toEqual({ ok: false, error: 'auth' });
  });
});
