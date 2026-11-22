/**
 * audio-resolver — turn a headword + a source into playing audio.
 * ---------------------------------------------------------------------------
 * WHAT THIS IS. The smallest engine that answers "play this word": given a term,
 * a reading and one of the user's audio sources, resolve a playable URL and hand
 * back an `HTMLAudioElement`. Both surfaces share it — `/search/` (a TS
 * controller) and the floating popup (which resolves the SAME way inside its own
 * document, because a sandboxed iframe cannot call out to this module).
 *
 * CLIENT-COMPLETE, WITH ONE SEAM. Today only the sources a browser resolves on
 * its own actually play:
 *   - `jpod101`  — a CDN direct link (`assets.languagepod101.com`), so
 *                  `new Audio(url)` plays it with NO CORS involved (playback is
 *                  not a CORS request).
 *   - `custom`   — the user's own URL template, `{term}` / `{reading}` /
 *                  `{language}` substituted locally.
 * The scraping sources (`jisho`, `language-pod-101`, `lingua-libre`,
 * `wiktionary`) need a server-side fetch the browser cannot make, and
 * `custom-json` needs a CORS-permitted endpoint — they resolve to `null` here and
 * the caller falls back to the click sound. THE SEAM is `resolveAudioUrl`: it is
 * the one async function to extend when a source gains a resolver (a Tauri Rust
 * -plugin fetch behind `tauri-plugin-modules`, since the old Go companion is
 * gone), without either surface changing.
 *
 * WHY NOT UPLPOAD'S AudioSystem WHOLESALE. Upstream validates the jpod101 payload
 * by duration and SHA-256 to detect the CDN's "no such word" placeholder; that
 * needs `crypto.subtle` on the bytes, which a plain `new Audio(url)` playback
 * never reads. We instead check the element's `error` flag (and race a late
 * `error` event) — the CDN answers a missing word with a response that fails to
 * decode — which is enough to fall back without pulling the audio into an
 * ArrayBuffer.
 *
 * LATENCY CONTRACT. `playUrl` never waits for `loadeddata`: it calls `play()` at
 * once so the browser streams while it plays, and it memoises one element per url
 * (`audioCache`) so a replayed word is instant. `preloadAudioUrl(url)` warms the
 * cache on a hover / draw-ahead without playing.
 * ---------------------------------------------------------------------------
 */

import { isStringEntirelyKana } from '@/modules/yomitan/vendor/js/language/ja/japanese.js';
import type { AudioSourceInfo } from '@/modules/yomitan/audio/audio-sources';
import { fetchTextDirect } from '@/features/player/tauri-bridge';

/** Language fed to custom-URL `{language}` substitution. Host-locked to Japanese. */
const LANGUAGE_ISO = 'ja';

/**
 * One PLAYABLE audio track, resolved for a specific word.
 *
 * A source expands into one or more of these: `jpod101` and `custom` each yield
 * exactly one (a direct media URL), while `custom-json` yields however many
 * tracks the word's JSON payload lists. `sourceIndex` is the configured source's
 * position (the menu group's `data-index`) and `subIndex` is the track's
 * position within that source's expansion (the sub-item's `data-sub-index`), so
 * the menu can address a track unambiguously and the Anki card-audio pin can
 * remember `{ sourceIndex, subIndex }` rather than a bare source number.
 *
 * `name` is the track's own label from the payload (`SMK8 キ\\レイ [1]`,
 * `Forvo (…)`), which the menu appends to the source's name.
 */
export interface AudioInfo {
  type: 'url';
  /** The direct media URL `new Audio(url)` plays. Playback is not a CORS request. */
  url: string;
  /** The track's own label from the payload, if it carries one. */
  name?: string;
  /** Position of the configured source this track came from. */
  sourceIndex: number;
  /** Position of this track within that source's expansion (0-based). */
  subIndex: number;
}

/**
 * One `HTMLAudioElement` per resolved url, for the life of the page.
 *
 * The point is latency, not memory: a cached element has ALREADY downloaded and
 * buffered its media, so the second play of a word is 0 ms instead of a fresh
 * network round trip. Bounded by how many distinct words the user actually plays
 * or hovers in a session (each element is a small media handle, and the browser
 * reuses its own network cache underneath), so no eviction is built in.
 */
const audioCache = new Map<string, HTMLAudioElement>();

/**
 * Resolved `custom-json` track lists, keyed by `requestUrl\u0000term\u0000reading`.
 *
 * The payload is a per-word lookup over the network, so a word whose menu is
 * opened twice (or whose audio is replayed) must not refetch. An EMPTY array is
 * cached too: it is a real answer ("this word has no tracks here") and caching
 * it is what keeps a missing word from re-hitting the server on every menu open.
 * A FAILED fetch is NOT cached — a transient network error should retry on the
 * next open rather than be pinned for the session.
 */
const customJsonCache = new Map<string, AudioInfo[]>();

/**
 * Build the element for `url`, start it loading, and remember it.
 *
 * The `Audio(url)` constructor sets `src` and kicks off the fetch on its own; we
 * only mark it cached here. No `play()` — that is the caller's call.
 */
function setCachedAudio(url: string): HTMLAudioElement {
  const audio = new Audio(url);
  audioCache.set(url, audio);
  return audio;
}

/**
 * The jpod101 CDN endpoint, verbatim from upstream's `_getInfoJpod101`.
 *
 * `kanji` is omitted when the term is entirely kana (upstream sends an empty
 * kanji then), which is what makes 「ありがとう」 resolve instead of 404-ing.
 */
const JPOD101_URL =
  'https://assets.languagepod101.com/dictionary/japanese/audiomp3.php';

/**
 * Resolve one source to a playable URL, or `null` when this client cannot.
 *
 * Async on purpose: the future scraping / Rust-plugin resolvers are async, and
 * keeping the signature stable means the callers never change when they land.
 */
export async function resolveAudioUrl(
  source: AudioSourceInfo,
  term: string,
  reading: string,
): Promise<string | null> {
  switch (source.type) {
    case 'jpod101':
      return buildJpod101Url(term, reading);
    case 'custom':
      return buildCustomUrl(source.url, term, reading);
    default:
      // Scraping sources + custom-json: not resolvable client-side yet (module
      // header). Listed in the menu, but resolve to "no audio" for now.
      return null;
  }
}

/**
 * The jpod101 CDN URL for a term/reading pair.
 *
 * Upstream's rule: when the "term" is entirely kana it is really the reading, so
 * it goes in `kana` and `kanji` is left empty — the CDN keys pronunciation audio
 * off the kanji form and refuses a kana string there.
 */
export function buildJpod101Url(term: string, reading: string): string {
  let kanji = term;
  let kana = reading;
  if (reading === term && isStringEntirelyKana(term)) {
    kanji = '';
    kana = term;
  }
  const params = new URLSearchParams();
  if (kanji.length > 0) params.set('kanji', kanji);
  if (kana.length > 0) params.set('kana', kana);
  return `${JPOD101_URL}?${params.toString()}`;
}

/**
 * The substitution placeholders a `custom` / `custom-json` template may carry.
 * Upstream replaces every `{...}` with the matching field and leaves unknown
 * ones untouched; an empty template resolves to nothing to request.
 */
function substituteTemplate(
  template: string,
  term: string,
  reading: string,
): string | null {
  if (template.length === 0) return null;
  const data: Record<string, string> = { term, reading, language: LANGUAGE_ISO };
  return template.replace(/\{([^}]*)\}/g, (match, key: string) => {
    const value = Object.prototype.hasOwnProperty.call(data, key)
      ? data[key]
      : undefined;
    return typeof value === 'string' ? value : match;
  });
}

/**
 * Fetch + parse a `custom-json` source's track list for one word.
 *
 * The configured URL is a template (`{term}` / `{reading}` / `{language}`
 * substituted); the response is upstream's `audioSourceList` payload:
 * `{ type: 'audioSourceList', audioSources: [{ name, url }, …] }`. Each entry
 * becomes an [`AudioInfo`] carrying the track's own `name` and its position
 * (`subIndex`) within this source.
 *
 * The FETCH goes through [`fetchTextDirect`] — a local audio server sends no
 * CORS headers, so the browser cannot read the payload itself and the native
 * plugin does the GET. A malformed payload, a non-2xx response, or a network
 * failure all resolve to `[]` ("no tracks"), never throw, so a broken source
 * degrades to the same "no audio" signal as an unresolvable scraping source.
 */
export async function resolveCustomJsonTracks(
  source: AudioSourceInfo,
  term: string,
  reading: string,
): Promise<AudioInfo[]> {
  const requestUrl = substituteTemplate(source.url, term, reading);
  if (requestUrl === null) return [];
  const cacheKey = `${requestUrl}\u0000${term}\u0000${reading}`;
  const cached = customJsonCache.get(cacheKey);
  if (cached !== undefined) return cached;
  let tracks: AudioInfo[];
  try {
    const body = await fetchTextDirect(requestUrl);
    tracks = parseAudioSourceList(body, source.index);
  } catch {
    // Network / CORS-proxy / HTTP failure: NOT cached, so the next menu open
    // retries. Return "no tracks" for this pass.
    return [];
  }
  customJsonCache.set(cacheKey, tracks);
  return tracks;
}

/**
 * Parse an `audioSourceList` JSON body into [`AudioInfo`] tracks.
 *
 * Tolerant by design: the payload comes off an arbitrary user-configured server,
 * so anything that is not the expected shape (bad JSON, a missing/empty
 * `audioSources` array, an entry with no `url`) contributes nothing rather than
 * throwing. Each surviving entry keeps its payload order as `subIndex`.
 */
function parseAudioSourceList(body: string, sourceIndex: number): AudioInfo[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return [];
  }
  if (typeof parsed !== 'object' || parsed === null) return [];
  const list = (parsed as { audioSources?: unknown }).audioSources;
  if (!Array.isArray(list)) return [];
  const tracks: AudioInfo[] = [];
  for (const entry of list) {
    if (typeof entry !== 'object' || entry === null) continue;
    const url = (entry as { url?: unknown }).url;
    if (typeof url !== 'string' || url.length === 0) continue;
    const name = (entry as { name?: unknown }).name;
    tracks.push({
      type: 'url',
      url,
      ...(typeof name === 'string' && name.length > 0 ? { name } : {}),
      sourceIndex,
      subIndex: tracks.length,
    });
  }
  return tracks;
}

/**
 * Resolve EVERY configured source for a word into its playable tracks.
 *
 * Returns one [`AudioInfo`] array PER input source, in the same order, so the
 * menu can render each source's group from its own slot: `jpod101` / `custom`
 * yield a single track, `custom-json` yields however many the payload lists
 * (fetched natively, cached per word), and the scraping sources yield none
 * (listed but not resolvable client-side). A source that resolves to no tracks
 * gets an empty array rather than being dropped, keeping the result index-aligned
 * with `sources`.
 */
export async function resolveAudioSourcesForTerm(
  sources: readonly AudioSourceInfo[],
  term: string,
  reading: string,
): Promise<AudioInfo[][]> {
  return Promise.all(
    sources.map(async (source): Promise<AudioInfo[]> => {
      switch (source.type) {
        case 'jpod101': {
          const url = buildJpod101Url(term, reading);
          return [{ type: 'url', url, name: source.name, sourceIndex: source.index, subIndex: 0 }];
        }
        case 'custom': {
          const url = substituteTemplate(source.url, term, reading);
          if (url === null) return [];
          return [{ type: 'url', url, name: source.name, sourceIndex: source.index, subIndex: 0 }];
        }
        case 'custom-json':
          return resolveCustomJsonTracks(source, term, reading);
        default:
          // Scraping sources: need a server-side fetch the browser cannot make.
          return [];
      }
    }),
  );
}

/**
 * The user's custom URL with `{term}` / `{reading}` / `{language}` substituted.
 *
 * Upstream replaces every `{...}` with the matching field and leaves unknown
 * placeholders untouched; an empty template resolves to `null` (nothing to play).
 */
export function buildCustomUrl(
  template: string,
  term: string,
  reading: string,
): string | null {
  return substituteTemplate(template, term, reading);
}

/**
 * A decode failure, surfaced as the element's `error` event.
 *
 * `HTMLMediaElement` never throws on bad media — it fires `error` and sets its
 * `error` property. We resolve on that event so `playUrl` can re-read the flag
 * after `play()` settles: the flag is set synchronously with the event, and this
 * resolution is queued behind it, so by the time the caller checks, the flag is
 * already current.
 */
function onceDecodeError(audio: HTMLAudioElement): Promise<void> {
  return new Promise((resolve) => {
    audio.addEventListener('error', () => resolve(), { once: true });
  });
}

/**
 * The element we built for `url`, still playable, or `undefined`.
 *
 * A cached element is replayable: once its media has loaded it stays buffered in
 * the element (the browser keeps it for the document's lifetime), so a second
 * play of the SAME url seeks to 0 and plays with no network at all. `error`/`abort`
 * drop it so a failed download is retried on the next press rather than cached.
 */
function getReusable(url: string): HTMLAudioElement | undefined {
  const audio = audioCache.get(url);
  if (audio === undefined) return undefined;
  // A decode that already failed will only fail again; drop it and rebuild.
  if (audio.error !== null) {
    audioCache.delete(url);
    return undefined;
  }
  return audio;
}

/**
 * Build (or reuse) the element for `url` WITHOUT playing it.
 *
 * The constructor starts the network fetch, so a hovered / drawn-ahead word is
 * already downloading by the time it is clicked. Safe to call repeatedly: the
 * second call for an in-flight or loaded url reuses the element.
 */
export function preloadAudioUrl(url: string): HTMLAudioElement {
  return getReusable(url) ?? setCachedAudio(url);
}

/**
 * Drop every cached element and every resolved `custom-json` track list. For
 * tests and for the (not currently wired) case of a source list change
 * invalidating every resolved url at once.
 */
export function clearAudioCache(): void {
  for (const audio of audioCache.values()) {
    audio.pause();
    audio.removeAttribute('src');
    audio.load();
  }
  audioCache.clear();
  customJsonCache.clear();
}

/**
 * Play `url`, stopping `current` first, at `volume` (0–1).
 *
 * STARTS PLAYING IMMEDIATELY. It does NOT wait for the element's `loadeddata`:
 * `play()` resolves once playback has actually begun, which for a streaming
 * `<audio>` is as soon as the first frames are buffered — not after the whole
 * file has downloaded and decoded. Awaiting `loadeddata` here was the whole
 * latency: on a cold jpod101 link it held the press for the full download before
 * a single sample came out.
 *
 * The element is memoised per url (`audioCache`), so replaying a word the session
 * has already played is instant. Returns the element now playing (so the caller
 * keeps it to stop next time), or `null` on a decode error (the jpod101 "no such
 * word" placeholder, a network failure, an unsupported format) rather than
 * throwing, so the caller can fall back cleanly. Never rejects.
 */
export async function playUrl(
  url: string,
  volume: number,
  current: HTMLAudioElement | null,
): Promise<HTMLAudioElement | null> {
  const audio = getReusable(url) ?? setCachedAudio(url);
  // Stop what was playing BEFORE awaiting anything, so a double-press cannot
  // leave two elements sounding at once.
  if (current !== null && current !== audio) {
    current.pause();
  }
  audio.volume = clampVolume(volume);
  audio.currentTime = 0;
  const played = audio.play();
  if (typeof played !== 'undefined') {
    try {
      await played;
    } catch {
      // Autoplay policy / interrupted request: the element still counts as
      // "current" (matching upstream, which does not unwind on a failed play).
    }
  }
  // A decode error can land during or just after `play()` (the CDN's missing-word
  // placeholder fails to decode). Give a late `error` one microtask to set the
  // element's flag, then read the flag once: it is the single source of truth for
  // "this url would not play". On failure, drop the poisoned element from the
  // cache and return `null` so the caller falls back to the click sound.
  await Promise.race([onceDecodeError(audio), Promise.resolve()]);
  if (audio.error !== null) {
    audioCache.delete(url);
    return null;
  }
  return audio;
}

/** Clamp a 0–100 stored volume into the 0–1 range `HTMLAudioElement.volume` wants. */
export function clampVolume(volume: number): number {
  if (!Number.isFinite(volume)) return 1;
  return Math.max(0, Math.min(1, volume / 100));
}
