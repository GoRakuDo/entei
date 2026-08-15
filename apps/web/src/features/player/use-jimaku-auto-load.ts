import { useCallback, useRef } from 'react';
import {
  readJimakuPreferences,
  shouldShowJimakuToast,
  incrementJimakuToastCount,
  setJimakuSearchAnime,
} from '@/features/player/jimaku-preferences';
import { parseMediaFileName } from '@/features/player/filename-parser';
import {
  searchJimakuEntries,
  getJimakuEntryFiles,
  downloadJimakuSubtitle,
  type JimakuFile,
} from '@/features/player/jimaku-client';

/** Lowercased romaji normalization for the exact-match check (§2.2-4). */
function normalizeTitle(t: string): string {
  return t.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

/** Non-Japanese when a language tag is present; untagged files are Japanese. */
function isNonJapanese(name: string): boolean {
  return /(?:\[(?:en|eng|english|spa|esp|es|fr|fra|chi|zho|kr|kor|ru)\])|\.(?:en|eng|es|fr|zh|ko)\./i.test(
    name,
  );
}

/** Only uncompressed subtitle files (.srt/.ass/.ssa/.vtt). */
function isUncompressed(name: string): boolean {
  return /\.(?:srt|ass|ssa|vtt)$/i.test(name);
}

export interface JimakuAutoLoadCallbacks {
  /** Replace the current subtitles (from auto-load). */
  onSubtitleLoaded: (text: string) => void;
  /** Fallback: open the search modal (P4 implements it; P3 only opens state). */
  onOpenSearch: (title: string, animeLastTried: boolean) => void;
  /** Toast for rate-limit / auth / key-missing. */
  onToast: (kind: 'rate-limit' | 'auth' | 'key-missing') => void;
}

/**
 * P3 auto-load (§2.2): when media is selected / Magnet handed off and the
 * auto-load switch is ON, parse the media name, run the two-stage search,
 * and replace the subtitles on an exact match. Non-exact / empty Japanese
 * falls back to the search modal (opened via onOpenSearch).
 */
export function useJimakuAutoLoad({
  onSubtitleLoaded,
  onOpenSearch,
  onToast,
}: JimakuAutoLoadCallbacks) {
  // Same media must not auto-load twice.
  const lastTriggerRef = useRef<string | null>(null);

  const runAutoLoad = useCallback(
    async (mediaName: string, triggerKey: string) => {
      const prefs = readJimakuPreferences();
      if (!prefs.autoLoadEnabled) return;
      if (!prefs.apiKey) {
        if (shouldShowJimakuToast()) {
          incrementJimakuToastCount();
          onToast('key-missing');
        }
        return;
      }
      const parsed = parseMediaFileName(mediaName);
      if (!parsed.title) return; // nothing to search — stay quiet
      const title = parsed.title;

      // Two-stage search: anime first, then drama (§2.2-4).
      let entries = await searchJimakuEntries(prefs.apiKey, title, true);
      let animeLastTried = true;
      // 'empty' (no anime result) falls through to the drama stage; the
      // other errors (rate-limit / auth / network / not-found) stop here.
      if (!entries.ok && entries.error !== 'empty') {
        if (entries.error === 'rate-limit') onToast('rate-limit');
        else if (entries.error === 'auth') onToast('auth');
        return;
      }
      if (!entries.ok || entries.data.length === 0) {
        entries = await searchJimakuEntries(prefs.apiKey, title, false);
        animeLastTried = false;
        setJimakuSearchAnime(false);
      } else {
        setJimakuSearchAnime(true);
      }
      if (!entries.ok) {
        if (entries.error === 'rate-limit') onToast('rate-limit');
        else if (entries.error === 'auth') onToast('auth');
        // network: stay silent
        return;
      }
      const top = entries.data[0];
      if (!top || normalizeTitle(top.name) !== normalizeTitle(title)) {
        onOpenSearch(title, animeLastTried);
        return;
      }
      const files = await getJimakuEntryFiles(
        prefs.apiKey,
        top.id,
        parsed.episode ?? undefined,
      );
      if (!files.ok) {
        if (files.error === 'rate-limit') onToast('rate-limit');
        else if (files.error === 'auth') onToast('auth');
        onOpenSearch(title, animeLastTried);
        return;
      }
      const jp = files.data.filter(
        (f: JimakuFile) => isUncompressed(f.name) && !isNonJapanese(f.name),
      );
      if (jp.length === 0) {
        // No Japanese subtitle — fall back to the search modal (all files).
        onOpenSearch(title, animeLastTried);
        return;
      }
      // Prefer .srt / .ass over .vtt, then largest file (§2.2-4 pick).
      jp.sort(
        (a, b) =>
          Number(/\.(?:srt|ass)$/i.test(b.name)) -
            Number(/\.(?:srt|ass)$/i.test(a.name)) ||
          b.size - a.size,
      );
      const best = jp[0];
      if (!best) return; // unreachable: jp.length > 0 checked above
      const dl = await downloadJimakuSubtitle(best.url);
      if (!dl.ok) {
        if (dl.error === 'rate-limit') onToast('rate-limit');
        return;
      }
      onSubtitleLoaded(dl.data);
      lastTriggerRef.current = triggerKey;
    },
    [onSubtitleLoaded, onOpenSearch, onToast],
  );

  return { runAutoLoad, lastTriggerRef };
}
