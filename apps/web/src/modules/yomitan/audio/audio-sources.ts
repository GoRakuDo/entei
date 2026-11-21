/**
 * audio-sources — Yomitan's audio source list, host-side.
 * ---------------------------------------------------------------------------
 * WHAT THIS IS. The user's configured playback sources (`audio.sources[]`),
 * read out of the persisted Yomitan options and shaped for the two surfaces that
 * play audio: the `/search/` page (a TS controller binds the speaker buttons
 * directly) and the floating popup (an iframe, which cannot reach the host's
 * options and so is handed a plain JSON summary of the same list).
 *
 * WHY A MAP OF NAMES. Yomitan's own menu labels each source with a friendly
 * name (`JapanesePod101`, `Jisho.org`, …) rather than its raw type token. That
 * map is upstream's `DisplayAudio._audioSourceTypeNames`, kept word for word so
 * the menu reads exactly like the extension's. Two configured sources may share a
 * type (two Custom URLs); like upstream, a `nameIndex` disambiguates them in the
 * label ("Custom URL 1", "Custom URL 2").
 *
 * CLIENT-COMPLETE SCOPE. Only the sources a browser can resolve ON ITS OWN are
 * resolved here: `jpod101` (a CDN direct link, playable via `new Audio(url)` with
 * no CORS involved) and `custom` (the user's own URL template). The scraping
 * sources (`jisho`, `language-pod-101`, `lingua-libre`, `wiktionary`) need a
 * server-side fetch the browser cannot make, and `custom-json` needs a CORS
 * -permitted JSON endpoint. Those are listed in the menu (so the user sees what
 * is configured) but resolve to "no audio" for now; the design leaves a single
 * seam — an async resolver — where a Tauri Rust-plugin fetch can be dropped in
 * later without touching either surface (the old Go companion is gone; native
 * work goes through `tauri-plugin-modules`).
 * ---------------------------------------------------------------------------
 */

import type { AudioSource, AudioSourceType } from '@gorakudo/yomitan-headless/settings';

/**
 * One playback source, as the two surfaces consume it.
 *
 * `name` / `nameIndex` / `nameUnique` are upstream's menu-label fields: the
 * friendly name, which duplicate of a shared type this is, and whether the name
 * alone is enough to identify it.
 */
export interface AudioSourceInfo {
  /** Position in the resolved list — the menu item's `data-index`. */
  index: number;
  type: AudioSourceType;
  /** The user's URL template (`custom` / `custom-json`); '' for the rest. */
  url: string;
  /** A text-to-speech voice URI; '' for every non-TTS source. */
  voice: string;
  /** Upstream's friendly name (`JapanesePod101`, `Jisho.org`, …). */
  name: string;
  /** Which duplicate of a shared `type` this is (0-based). */
  nameIndex: number;
  /** `name` alone identifies this source (no sibling of the same type). */
  nameUnique: boolean;
  /**
   * Whether the source can be resolved to a downloadable/playable URL by THIS
   * client. False for the scraping sources and TTS, which the browser cannot
   * resolve on its own; the menu still lists them, greying the intent.
   */
  clientPlayable: boolean;
}

/** Upstream's `DisplayAudio._audioSourceTypeNames`, verbatim. */
const AUDIO_SOURCE_TYPE_NAMES: Readonly<Record<string, string>> = {
  jpod101: 'JapanesePod101',
  'language-pod-101': 'LanguagePod101',
  jisho: 'Jisho.org',
  'lingua-libre': 'Lingua Libre',
  wiktionary: 'Wiktionary',
  'text-to-speech': 'Text-to-speech',
  'text-to-speech-reading': 'Text-to-speech (Kana reading)',
  custom: 'Custom URL',
  'custom-json': 'Custom URL (JSON)',
};

/**
 * The source types THIS client can resolve to a playable URL on its own.
 *
 * `jpod101` is a CDN direct link (no CORS for playback); `custom` is the user's
 * own URL template, resolved locally. Everything else needs a fetch this surface
 * cannot make (scraping) or a CORS-permitted endpoint, and is listed but not
 * resolved — see the module header for the future Rust-plugin seam.
 */
const CLIENT_PLAYABLE_TYPES: ReadonlySet<string> = new Set(['jpod101', 'custom']);

/** Upstream's friendly name for one source type, or `Unknown`. */
export function audioSourceTypeName(type: string): string {
  return AUDIO_SOURCE_TYPE_NAMES[type] ?? 'Unknown';
}
/**
 * The menu label for one source: the friendly name alone when it uniquely
 * identifies the source, else the name with its 1-based duplicate number
 * ("Custom URL 1", "Custom URL 2"). Both surfaces (search + popup) use this so a
 * repeated type reads the same way everywhere.
 */
export function audioSourceLabel(source: AudioSourceInfo): string {
  return source.nameUnique ? source.name : `${source.name} ${source.nameIndex + 1}`;
}

/**
 * Shape the persisted `audio.sources[]` into the list both surfaces consume.
 *
 * Accepts the raw stored array (untrusted): entries that are not objects or
 * carry an unknown type are coerced the way `module-data-sources` coerces them,
 * so a hand-edited tree cannot break playback. Duplicate types get a `nameIndex`
 * so their menu labels disambiguate, exactly as upstream does.
 */
export function toAudioSourceInfos(
  sources: unknown,
): AudioSourceInfo[] {
  const list = Array.isArray(sources) ? sources : [];
  /** @type {Map<string, number>} how many of each type we have seen. */
  const seen = new Map<string, number>();
  const resolved: AudioSourceInfo[] = [];
  for (const raw of list) {
    if (typeof raw !== 'object' || raw === null) continue;
    const record = raw as Record<string, unknown>;
    const type = (
      typeof record.type === 'string' && record.type in AUDIO_SOURCE_TYPE_NAMES
        ? record.type
        : 'jpod101'
    ) as AudioSourceType;
    const url = typeof record.url === 'string' ? record.url : '';
    const voice = typeof record.voice === 'string' ? record.voice : '';
    const nameIndex = seen.get(type) ?? 0;
    seen.set(type, nameIndex + 1);
    resolved.push({
      index: resolved.length,
      type,
      url,
      voice,
      name: audioSourceTypeName(type),
      nameIndex,
      nameUnique: nameIndex === 0,
      clientPlayable: CLIENT_PLAYABLE_TYPES.has(type),
    });
  }
  // A second (or later) duplicate is only now known to be non-unique, so mark
  // the first of each shared type after the fact — upstream does the same pass.
  for (const source of resolved) {
    if ((seen.get(source.type) ?? 0) > 1) source.nameUnique = false;
  }
  return resolved;
}
