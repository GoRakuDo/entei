import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resolvePoster } from '../src/features/player/watch-history/poster-resolver';

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('watch-history poster resolver', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('searches dramas by title and skips results without a poster', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({
        results: [
          { id: 1, poster_path: null },
          { id: 2, poster_path: '/drama-poster.jpg' },
        ],
      }),
    );

    await expect(
      resolvePoster({ title: 'Meitantei', anilistId: null, tmdbId: null }),
    ).resolves.toEqual({
      posterUrl: 'https://image.tmdb.org/t/p/w185/drama-poster.jpg',
      posterStatus: 'ready',
    });
    expect(fetchMock).toHaveBeenCalledWith(
      'https://entei-tmdb-relay.yosiakefas-id.workers.dev/search?q=Meitantei&type=tv',
    );
  });

  it.each([
    ['tv:325021', '/tv/325021'],
    ['movie:987', '/movie/987'],
  ])('uses the %s TMDB route', async (tmdbId, route) => {
    fetchMock.mockResolvedValue(jsonResponse({ poster_path: '/poster.jpg' }));

    await expect(
      resolvePoster({ title: 'Drama', anilistId: null, tmdbId }),
    ).resolves.toEqual({
      posterUrl: 'https://image.tmdb.org/t/p/w185/poster.jpg',
      posterStatus: 'ready',
    });
    expect(fetchMock).toHaveBeenCalledWith(
      `https://entei-tmdb-relay.yosiakefas-id.workers.dev${route}`,
    );
  });
});
