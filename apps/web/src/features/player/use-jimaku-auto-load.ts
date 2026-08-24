import { useCallback, useEffect, useRef, useState } from 'react';
import {
  readJimakuPreferences,
  shouldShowJimakuToast,
  incrementJimakuToastCount,
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

/**
 * Non-Japanese when a language tag is present; untagged files are Japanese.
 * `ja` / `jpn` / `[JP]` tags are intentionally NOT matched here — they fall
 * through as Japanese (§2.3-3).
 * Shared with the P4 search dialog (JimakuSearchDialog).
 */
export function isNonJapanese(name: string): boolean {
  return /(?:\[(?:en|eng|english|spa|esp|es|fr|fra|chi|zho|kr|kor|ru)\])|\.(?:en|eng|es|fr|zh|ko)\./i.test(
    name,
  );
}

/** Only uncompressed subtitle files (.srt/.ass/.ssa/.vtt). */
export function isUncompressed(name: string): boolean {
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
  // Latest-trigger-wins guard: a newer runAutoLoad supersedes an in-flight
  // one, so a stale download can never replace newer subtitles.
  const lastTriggerRef = useRef<string | null>(null);
  // Aborts the previous run's in-flight requests on a media switch (MED):
  // an aborted fetch maps to 'network' in jimaku-client, so the
  // `signal.aborted` checks below keep those paths silent.
  const abortRef = useRef<AbortController | null>(null);
  // P4-1: spinner state — true while an actual search is in flight, cleared
  // on every terminal path (success / fallback / error / abort). Only the
  // latest run may clear it (see the finally guard below).
  const [isLoading, setIsLoading] = useState(false);

  const runAutoLoad = useCallback(
    async (mediaName: string, triggerKey: string) => {
      // Claim this trigger before any await — a newer run overwrites the ref,
      // and the stale-DL check below aborts this run if it lost the race.
      lastTriggerRef.current = triggerKey;
      // Cancel the previous run's in-flight requests (media switch) and take
      // over with a fresh controller.
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;
      const { signal } = controller;
      try {
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
        // An actual search is starting — surface the subtitle-panel spinner.
        setIsLoading(true);

        // Two-stage search: anime first, then drama (§2.2-4).
        let entries = await searchJimakuEntries(prefs.apiKey, title, true, signal);
        if (signal.aborted) return; // newer run took over — stay quiet
        let animeLastTried = true;
        // Non-empty anime results settle here; 'empty' falls to the drama
        // stage; other errors (rate-limit / auth / network / not-found) stop.
        if (!entries.ok && entries.error !== 'empty') {
          if (entries.error === 'rate-limit') onToast('rate-limit');
          else if (entries.error === 'auth') onToast('auth');
          return;
        }
        if (!(entries.ok && entries.data.length > 0)) {
          entries = await searchJimakuEntries(prefs.apiKey, title, false, signal);
          if (signal.aborted) return;
          animeLastTried = false;
          // The last-tried mode is surfaced only via the onOpenSearch
          // prefill (animeLastTried) — we no longer mutate the user's
          // persisted manual toggle here (RISK 1).
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
        // §2.2-4: EP extraction failure (or a movie file with no episode)
        // must open the search modal, NOT auto-apply all files. A null
        // episode means we can't target a specific file, so the user picks.
        if (parsed.episode === null) {
          onOpenSearch(title, animeLastTried);
          return;
        }
        const files = await getJimakuEntryFiles(
          prefs.apiKey,
          top.id,
          parsed.episode ?? undefined,
          signal,
        );
        if (signal.aborted) return;
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
        const dl = await downloadJimakuSubtitle(best.url, signal);
        if (signal.aborted) return; // silent — newer run took over
        if (!dl.ok) {
          if (dl.error === 'rate-limit') onToast('rate-limit');
          // Any download failure falls back to the search modal (§2.2).
          onOpenSearch(title, animeLastTried);
          return;
        }
        if (lastTriggerRef.current !== triggerKey) return; // newer load took over
        onSubtitleLoaded(dl.data);
        lastTriggerRef.current = triggerKey;
      } finally {
        // Only the latest run may clear its own controller: a superseded
        // (older) run must not null the NEWER run's controller, or >=3 rapid
        // switches leak parallel requests (BUG 3).
        if (lastTriggerRef.current === triggerKey) {
          abortRef.current = null;
        }
        // Only the latest run clears the spinner: a superseded run's finally
        // must not switch it off while a newer run is still loading.
        if (lastTriggerRef.current === triggerKey) setIsLoading(false);
      }
    },
    [onSubtitleLoaded, onOpenSearch, onToast],
  );

  const cancel = useCallback(() => {
    // Abort any in-flight requests and drop ownership so a pending fetch
    // that resolves later can never clobber a manual subtitle selection
    // (BLOCKER 1). Mirrors the JimakuSearchDialog unmount pattern.
    abortRef.current?.abort();
    lastTriggerRef.current = null;
    setIsLoading(false);
  }, []);

  // BUG 4: abort in-flight requests on unmount so a pending fetch can't
  // resolve into a side effect after the component is gone.
  useEffect(
    () => () => {
      abortRef.current?.abort();
    },
    [],
  );

  return { runAutoLoad, cancel, lastTriggerRef, isLoading };
}
