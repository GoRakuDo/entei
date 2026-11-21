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
 * never reads. We instead listen for the element's `error` event — the CDN answers
 * a missing word with a response that fails to decode — which is enough to fall
 * back without pulling the audio into an ArrayBuffer.
 * ---------------------------------------------------------------------------
 */

import { isStringEntirelyKana } from '@/modules/yomitan/vendor/js/language/ja/japanese.js';
import type { AudioSourceInfo } from '@/modules/yomitan/audio/audio-sources';

/** Language fed to custom-URL `{language}` substitution. Host-locked to Japanese. */
const LANGUAGE_ISO = 'ja';

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
  if (template.length === 0) return null;
  const data: Record<string, string> = {
    term,
    reading,
    language: LANGUAGE_ISO,
  };
  return template.replace(/\{([^}]*)\}/g, (match, key: string) => {
    const value = Object.prototype.hasOwnProperty.call(data, key)
      ? data[key]
      : undefined;
    return typeof value === 'string' ? value : match;
  });
}

/**
 * Create and load an `HTMLAudioElement` for `url`, resolving when it is playable.
 *
 * Resolves `null` on a decode error (the jpod101 "no such word" placeholder, a
 * network failure, an unsupported format) rather than throwing, so the caller can
 * fall back cleanly. Never rejects.
 */
export function createPlayableAudio(url: string): Promise<HTMLAudioElement | null> {
  return new Promise((resolve) => {
    const audio = new Audio(url);
    const done = (value: HTMLAudioElement | null) => {
      audio.removeEventListener('loadeddata', onLoad);
      audio.removeEventListener('error', onError);
      resolve(value);
    };
    const onLoad = (): void => done(audio);
    const onError = (): void => done(null);
    audio.addEventListener('loadeddata', onLoad);
    audio.addEventListener('error', onError);
    // A missing `preload` would leave `loadeddata` never firing on some engines;
    // 'auto' asks the element to load enough to play.
    audio.preload = 'auto';
    audio.load();
  });
}

/**
 * Play `url`, stopping `current` first, at `volume` (0–1).
 *
 * Returns the element now playing (so the caller keeps it to stop next time), or
 * `null` if the URL would not load. A rejected `play()` (autoplay policy, a
 * interrupted request) is swallowed: the element still counts as "the current
 * one", matching upstream, which does not unwind on a failed `play()`.
 */
export async function playUrl(
  url: string,
  volume: number,
  current: HTMLAudioElement | null,
): Promise<HTMLAudioElement | null> {
  const audio = await createPlayableAudio(url);
  if (audio === null) return null;
  if (current !== null) {
    current.pause();
  }
  audio.currentTime = 0;
  audio.volume = clampVolume(volume);
  const played = audio.play();
  if (typeof played !== 'undefined') {
    try {
      await played;
    } catch {
      // Autoplay policy / interrupted: leave the element as "current" anyway.
    }
  }
  return audio;
}

/** Clamp a 0–100 stored volume into the 0–1 range `HTMLAudioElement.volume` wants. */
export function clampVolume(volume: number): number {
  if (!Number.isFinite(volume)) return 1;
  return Math.max(0, Math.min(1, volume / 100));
}
