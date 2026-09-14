import type { PosterResolution } from './types';

const ANILIST_ENDPOINT = 'https://graphql.anilist.co';
const TMDB_RELAY_ENDPOINT = 'https://entei-tmdb-relay.yosiakefas-id.workers.dev';
const TMDB_IMAGE_ENDPOINT = 'https://image.tmdb.org/t/p/w185';

const ANILIST_QUERY = `
  query ($id: Int) {
    Media(id: $id, type: ANIME) {
      coverImage { large }
    }
  }
`;

function none(): PosterResolution {
  return { posterUrl: null, posterStatus: 'none' };
}

function posterFromTmdb(payload: unknown): string | null {
  if (typeof payload !== 'object' || payload === null) return null;
  const path = (payload as { poster_path?: unknown }).poster_path;
  return typeof path === 'string' && path.length > 0
    ? `${TMDB_IMAGE_ENDPOINT}${path}`
    : null;
}

async function resolveAnime(anilistId: number): Promise<PosterResolution> {
  try {
    const response = await fetch(ANILIST_ENDPOINT, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ query: ANILIST_QUERY, variables: { id: anilistId } }),
    });
    if (!response.ok) return none();
    const payload = (await response.json()) as {
      data?: { Media?: { coverImage?: { large?: unknown } | null } | null };
    };
    const url = payload.data?.Media?.coverImage?.large;
    return typeof url === 'string' && url.length > 0
      ? { posterUrl: url, posterStatus: 'ready' }
      : none();
  } catch {
    return none();
  }
}

async function resolveDrama(
  title: string,
  tmdbId: string | null,
): Promise<PosterResolution> {
  try {
    let path: string;
    if (tmdbId !== null) {
      const [type, id] = tmdbId.split(':', 2);
      if ((type !== 'tv' && type !== 'movie') || !id) return none();
      path = `/${type}/${encodeURIComponent(id)}`;
    } else {
      path = `/search?q=${encodeURIComponent(title)}&type=tv`;
    }
    const response = await fetch(`${TMDB_RELAY_ENDPOINT}${path}`);
    if (!response.ok) return none();
    const payload = (await response.json()) as unknown;
    const first = Array.isArray((payload as { results?: unknown })?.results)
      ? (payload as { results: unknown[] }).results[0]
      : payload;
    const url = posterFromTmdb(first);
    return url === null
      ? none()
      : { posterUrl: url, posterStatus: 'ready' };
  } catch {
    return none();
  }
}

/** Resolve exactly once while a watch record is written; list rendering never calls this. */
export async function resolvePoster(input: {
  title: string;
  anilistId: number | null;
  tmdbId: string | null;
}): Promise<PosterResolution> {
  if (input.anilistId !== null) return resolveAnime(input.anilistId);
  return resolveDrama(input.title, input.tmdbId);
}
