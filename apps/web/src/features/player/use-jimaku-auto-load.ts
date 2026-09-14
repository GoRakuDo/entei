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
  type JimakuEntry,
  type JimakuFile,
} from '@/features/player/jimaku-client';

/** Lowercased romaji normalization for the exact-match check (§2.2-4). */
export function normalizeTitle(t: string): string {
  return t.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

const SEASON_2_ENTRY_RE = /2|second|!!/i;
const MOVIE_ENTRY_RE = /movie/i;
const VARIANT_ENTRY_RE =
  /(?:\b(?:season|series)[\s._-]*\d+\b|\bs\d+\b|\b(?:\d+(?:st|nd|rd|th)|first|second|third|fourth|fifth)\s+season\b|\bmovie\b|!!)/i;
const MIN_ENTRY_SCORE = 50;

interface MediaPathHints {
  season2: boolean;
  movie: boolean;
}

function getMediaPathHints(mediaPath: string, query: string): MediaPathHints {
  const context = `${mediaPath} ${query}`;
  return {
    season2: /(?:\bseason[\s._-]*2\b|\bs2\b|\bsecond\b|!!)/i.test(context),
    movie: /\bmovie\b/i.test(context),
  };
}

/**
 * Pick the best entry without relying on the API's fuzzy-result ordering.
 * Exact/containment matching is scored first; explicit path hints then
 * distinguish K-ON! variants. A strict `>` comparison keeps server order as
 * the tie-break. Scores below MIN_ENTRY_SCORE are intentionally ambiguous.
 */
export function pickJimakuEntry(
  entries: readonly JimakuEntry[],
  query: string,
  mediaPath: string,
): JimakuEntry | null {
  const normalizedQuery = normalizeTitle(query);
  if (!normalizedQuery) return null;

  const hints = getMediaPathHints(mediaPath, query);
  const exactEntries = entries.filter(
    (entry) => normalizeTitle(entry.name) === normalizedQuery,
  );
  // Exact match remains the first preference. When punctuation normalization
  // makes several variants exact (K-ON! / K-ON!!), use explicit context to
  // choose the matching variant; otherwise server order breaks the tie.
  if (exactEntries.length > 0 && !hints.season2 && !hints.movie) {
    return exactEntries.find((entry) => !VARIANT_ENTRY_RE.test(entry.name)) ?? exactEntries[0] ?? null;
  }
  if (hints.season2) {
    const exactSeason2 = exactEntries.find((entry) => SEASON_2_ENTRY_RE.test(entry.name));
    if (exactSeason2) return exactSeason2;
  }
  if (hints.movie) {
    const exactMovie = exactEntries.find((entry) => MOVIE_ENTRY_RE.test(entry.name));
    if (exactMovie) return exactMovie;
  }
  // If a variant hint exists but has no exact variant, continue into the
  // containment scorer so a non-exact Movie/Season-2 entry can beat the exact
  // base entry. This is how a folder such as `The Movie/` remains useful.

  let best: JimakuEntry | null = null;
  let bestScore = 0;

  for (const entry of entries) {
    const normalizedName = normalizeTitle(entry.name);
    if (!normalizedName) continue;
    const contains =
      normalizedName.includes(normalizedQuery) || normalizedQuery.includes(normalizedName);
    if (!contains) continue;

    let score = 60;
    const isSeason2Entry = SEASON_2_ENTRY_RE.test(entry.name);
    const isMovieEntry = MOVIE_ENTRY_RE.test(entry.name);
    const isVariantEntry = VARIANT_ENTRY_RE.test(entry.name);

    if (hints.season2) {
      score += isSeason2Entry ? 50 : -30;
    } else if (hints.movie) {
      score += isMovieEntry ? 50 : -30;
    } else {
      // With no variant hint, only the ordinary Season-1/base entry is
      // acceptable — a lone season/movie variant is too ambiguous, so skip
      // it entirely (keeps e.g. bare "Frieren" from grabbing "2nd Season").
      if (isVariantEntry) continue;
      score += 40;
    }

    if (score > bestScore) {
      best = entry;
      bestScore = score;
    }
  }

  return bestScore > MIN_ENTRY_SCORE ? best : null;
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

export interface JimakuAutoLoadMatch {
  anilistId: number | null;
  tmdbId: string | null;
}

export interface JimakuAutoLoadCallbacks {
  /** Replace the current subtitles (from auto-load). */
  onSubtitleLoaded: (text: string) => void;
  /** Pass the selected jimaku catalog IDs to the record-time owner. */
  onMatchResolved?: (match: JimakuAutoLoadMatch) => void;
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
  onMatchResolved,
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

        // Two-stage search: anime first, then drama (§2.2-4). Each stage
        // considers every returned entry, not only the API's first result.
        let entries = await searchJimakuEntries(prefs.apiKey, title, true, signal);
        if (signal.aborted) return; // newer run took over — stay quiet
        let animeLastTried = true;
        let selectedEntry: JimakuEntry | null = entries.ok
          ? pickJimakuEntry(entries.data, title, mediaName)
          : null;
        // Empty anime results, or anime results with no sufficiently strong
        // candidate, fall through to the drama stage. Other errors stop.
        if (!entries.ok && entries.error !== 'empty') {
          if (entries.error === 'rate-limit') onToast('rate-limit');
          else if (entries.error === 'auth') onToast('auth');
          return;
        }
        if (!selectedEntry) {
          entries = await searchJimakuEntries(prefs.apiKey, title, false, signal);
          if (signal.aborted) return;
          animeLastTried = false;
          selectedEntry = entries.ok
            ? pickJimakuEntry(entries.data, title, mediaName)
            : null;
          // The last-tried mode is surfaced only via the onOpenSearch
          // prefill (animeLastTried) — we no longer mutate the user's
          // persisted manual toggle here (RISK 1).
        }
        if (!entries.ok && entries.error !== 'empty') {
          if (entries.error === 'rate-limit') onToast('rate-limit');
          else if (entries.error === 'auth') onToast('auth');
          // network: stay silent
          return;
        }
        if (!selectedEntry) {
          onOpenSearch(title, animeLastTried);
          return;
        }
        const movieHint = getMediaPathHints(mediaName, title).movie;
        // A selected movie has no episode marker, so fetch its full file list.
        // Other episode-less titles retain the existing modal fallback.
        if (parsed.episode === null && !movieHint) {
          onOpenSearch(title, animeLastTried);
          return;
        }
        const files = await getJimakuEntryFiles(
          prefs.apiKey,
          selectedEntry.id,
          movieHint ? undefined : parsed.episode ?? undefined,
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
        onMatchResolved?.({
          anilistId:
            typeof selectedEntry.anilist_id === 'number'
              ? selectedEntry.anilist_id
              : null,
          tmdbId:
            typeof selectedEntry.tmdb_id === 'string'
              ? selectedEntry.tmdb_id
              : null,
        });
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
    [onSubtitleLoaded, onMatchResolved, onOpenSearch, onToast],
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
