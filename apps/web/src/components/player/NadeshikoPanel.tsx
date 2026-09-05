/**
 * NadeshikoPanel — Nuance / context search tab in RightPanel.
 * ---------------------------------------------------------------------------
 * Design: docs/NADESHIKO_INTEGRATION.md §3.3.
 * - Search input + button → POST /v1/search (with include: ['media'])
 * - Result cards (NadeshikoCard below) render:
 *     1. 16:9 thumbnail + audio play/stop toggle + serif line + timestamp
 *     2. Surrounding context paragraph (auto-fetched once per card)
 *     3. Centered work name
 * - States: empty / no-results / loading / error×3 (key-missing / invalid-key /
 *   rate-limited with Retry-After countdown) + pagination states (loading
 *   more / pagination error / end of results)
 * - Loads the API key from localStorage; listens for key-change events.
 * - Key-missing shows an inline API-key form (ButtonGroup: password input
 *   + KeyRound icon button) that saves straight to localStorage.
 *
 * Pagination:
 * - First page is fetched on submit. Subsequent pages are appended when an
 *   IntersectionObserver sentinel near the bottom of the results list
 *   becomes visible (root: the actual scroll container — by default the
 *   right-panel-content panel; falls back to the viewport when the panel
 *   doesn't own scrolling, e.g. an unusually short page).
 * - The sentinel triggers a `loadMore` callback guarded by an in-flight ref
 *   so duplicate observer firings can't start parallel requests.
 * - Pagination stops on `hasMore=false`, missing cursor, repeated cursor
 *   (no progress), 429 rate-limit / quota-exceeded, or any error. Errors
 *   never auto-retry — the user clicks an inline Retry affordance.
 * - A generation counter is bumped on every fresh submit / retry; responses
 *   from older generations are ignored (the user may have already typed
 *   a new query). In-flight AbortControllers are aborted when state
 *   resets, so the network itself is also cancelled.
 *
 * Rate-limit math: each search is 1 request; per-card context fetch is
 * `take` requests (one per visible card). Spec allows 150 req / 60s and
 * defaults to take=10, so worst case per search = 1 + 10 = 11 requests,
 * well inside the budget. We fire context fetches in parallel (no stagger)
 * to keep perceived latency low.
 *
 * StrictMode burst guard: a panel-level `fetchedIds` set tracks which
 * segment ids have already kicked off a context fetch. The set is append-
 * only across paginated appends so a card from page 2 never re-fires the
 * context fetch for a card that already loaded from page 1. Cleared on
 * each new submit. This prevents React 18 StrictMode's double-mount from
 * firing duplicate fetches for the same cards (per-card refs reset on
 * remount, so they aren't enough on their own).
 * ---------------------------------------------------------------------------
 */
'use client';

import { useState, useCallback, useEffect, useRef } from 'react';
import {
  Search,
  DoorClosedLocked,
  KeyRound,
  Volume2,
  Square,
  Loader2,
} from 'lucide-react';
import { Input } from '@/components/player/ui/input';
import { Button } from '@/components/player/ui/button';
import { ButtonGroup } from '@/components/player/ui/button-group';
import {
  searchNadeshikoSegments,
  getNadeshikoSegmentContext,
  type NadeshikoSegment,
  type NadeshikoSegmentContextResponse,
  type NadeshikoError,
  type NadeshikoSearchPage,
} from '@/features/nadeshiko/nadeshiko-client';
import {
  readNadeshikoApiKey,
  writeNadeshikoApiKey,
} from '@/features/nadeshiko/api-key';
import type { Dictionary } from '@i18n/types';

interface NadeshikoPanelProps {
  dict: Dictionary['playerUI'];
}

/** How to format the Nadeshiko error into the user's dictionary. */
type ResolvedError =
  | { kind: 'key-missing' }
  | { kind: 'invalid-key' }
  | { kind: 'rate-limited'; retryAfterSeconds: number }
  | { kind: 'quota-exceeded' }
  | { kind: 'network' }
  | { kind: 'generic' };

function resolveError(err: NadeshikoError): ResolvedError {
  switch (err.kind) {
    case 'invalid-key':
      return { kind: 'invalid-key' };
    case 'rate-limited':
      return {
        kind: 'rate-limited',
        retryAfterSeconds: err.retryAfterSeconds ?? 0,
      };
    case 'quota-exceeded':
      return { kind: 'quota-exceeded' };
    case 'network':
      return { kind: 'network' };
    case 'invalid-response':
      return { kind: 'generic' };
  }
}

function formatTimestamp(
  seg: NadeshikoSegment,
  dict: Dictionary['playerUI'],
): string {
  if (seg.timestampLabel) return seg.timestampLabel;
  if (typeof seg.timestampSeconds === 'number') {
    const total = Math.max(0, Math.floor(seg.timestampSeconds));
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = total % 60;
    if (h > 0) {
      return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
    }
    return `${m}:${String(s).padStart(2, '0')}`;
  }
  return dict.contextNoTimestamp;
}

/**
 * Hooks a countdown into a rate-limit error so the message auto-updates
 * while we wait for the Retry-After to elapse.
 */
function useRateLimitCountdown(
  error: ResolvedError | null,
): ResolvedError | null {
  const [displayed, setDisplayed] = useState<ResolvedError | null>(error);

  useEffect(() => {
    setDisplayed(error);
    if (!error || error.kind !== 'rate-limited') return;
    if (error.retryAfterSeconds <= 0) return;
    const tick = () => {
      setDisplayed((prev) => {
        if (!prev || prev.kind !== 'rate-limited') return prev;
        const next = prev.retryAfterSeconds - 1;
        if (next <= 0) return prev; // user must retry manually to clear
        return { kind: 'rate-limited', retryAfterSeconds: next };
      });
    };
    const id = window.setInterval(tick, 1000);
    return () => window.clearInterval(id);
  }, [error]);

  return displayed;
}

/* ------------------------------------------------------------------------ */
/* Audio manager                                                            */
/* ------------------------------------------------------------------------ */

/**
 * Per-card <audio> elements are registered here so a single playing card
 * can be paused when another card's play button is pressed. The contract:
 * - `play(id, audio, onEnded)` starts playback and registers `audio` for
 *   the given card id. If another card was playing, it's paused first.
 * - `stop(id)` pauses + rewinds the card's audio and clears its registration.
 * - `stopAll()` pauses every registered audio (used on unmount / new search).
 */
type AudioEndedHandler = () => void;

interface AudioRegistry {
  register(
    id: string,
    audio: HTMLAudioElement,
    onEnded: AudioEndedHandler,
  ): void;
  unregister(id: string): void;
  play(id: string): void;
  stop(id: string): void;
  stopAll(): void;
  /**
   * Called when an audio element finishes naturally (`ended` event).
   * Clears playingId so the button snaps back to play — unlike stop(),
   * no pause/rewind needed (already ended).
   */
  notifyEnded(id: string): void;
  /** Which id is currently considered "playing" (for aria-pressed sync). */
  playingId(): string | null;
}

function createAudioRegistry(): AudioRegistry {
  const audios = new Map<string, HTMLAudioElement>();
  const handlers = new Map<string, AudioEndedHandler>();
  let playingId: string | null = null;

  const setPlaying = (id: string | null) => {
    playingId = id;
    // Notify all registered cards so they can refresh `aria-pressed`.
    handlers.forEach((handler) => handler());
  };

  return {
    register(id, audio, onEnded) {
      audios.set(id, audio);
      handlers.set(id, onEnded);
    },
    unregister(id) {
      audios.delete(id);
      handlers.delete(id);
      if (playingId === id) playingId = null;
    },
    play(id) {
      const target = audios.get(id);
      if (!target) return;
      // Pause any other playing card first.
      if (playingId && playingId !== id) {
        const prev = audios.get(playingId);
        if (prev) {
          prev.pause();
          prev.currentTime = 0;
        }
      }
      // Rewind this card too so consecutive plays start fresh.
      target.currentTime = 0;
      void target.play().catch(() => {
        // Autoplay / decode errors: silently mark as not playing. The user
        // sees the icon snap back to play on the next render.
        if (playingId === id) setPlaying(null);
      });
      setPlaying(id);
    },
    stop(id) {
      const target = audios.get(id);
      if (!target) return;
      target.pause();
      target.currentTime = 0;
      if (playingId === id) setPlaying(null);
    },
    stopAll() {
      audios.forEach((a) => {
        a.pause();
        a.currentTime = 0;
      });
      setPlaying(null);
    },
    notifyEnded(id) {
      if (playingId === id) setPlaying(null);
    },
    playingId() {
      return playingId;
    },
  };
}

/* ------------------------------------------------------------------------ */
/* Per-result card                                                          */
/* ------------------------------------------------------------------------ */

interface NadeshikoCardProps {
  seg: NadeshikoSegment;
  dict: Dictionary['playerUI'];
  registry: AudioRegistry;
  /**
   * Panel-level set of segment ids that already have a context fetch
   * in-flight or completed. Survives card remounts (React StrictMode
   * double-invokes effects, so a per-card ref isn't enough on its own).
   * Cleared by the panel on every new search so a fresh result set gets
   * a fresh burst of fetches.
   */
  fetchedIds: Set<string>;
}

function NadeshikoCard({
  seg,
  dict,
  registry,
  fetchedIds,
}: NadeshikoCardProps) {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  // Force re-render when another card starts playing so our button icon /
  // aria-pressed reflect the registry's authoritative state.
  const [, force] = useState(0);
  // Context auto-fetch state. Firing once on mount is intentional — see
  // the rate-limit math in the panel header.
  const [context, setContext] =
    useState<NadeshikoSegmentContextResponse | null>(null);
  const [contextState, setContextState] = useState<
    'idle' | 'loading' | 'ready' | 'failed'
  >('idle');
  const ctxAbortRef = useRef<AbortController | null>(null);
  // Track the segment id we last fetched for, so that if the parent re-renders
  // this card with a different segment (shouldn't happen — keys are stable —
  // but defensive) we re-fetch.
  const fetchedForIdRef = useRef<string | null>(null);

  // Register audio element + listen for `ended` so the button snaps back
  // to play when playback finishes naturally.
  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;
    const onEnded = () => {
      // Reset currentTime so the next play restarts cleanly, and tell
      // the registry so playingId clears (button back to play icon).
      if (audioRef.current) audioRef.current.currentTime = 0;
      registry.notifyEnded(seg.id);
    };
    const onPause = () => force((n) => n + 1);
    audio.addEventListener('ended', onEnded);
    audio.addEventListener('pause', onPause);
    registry.register(seg.id, audio, () => force((n) => n + 1));
    return () => {
      audio.removeEventListener('ended', onEnded);
      audio.removeEventListener('pause', onPause);
      registry.unregister(seg.id);
    };
  }, [seg.id, registry]);

  // Auto-fetch context once per card. The panel-level `fetchedIds` set is
  // the authoritative "already done" guard — it survives StrictMode
  // remounts, which a per-card ref does not. We check it FIRST so a
  // fresh search (which replaces the set with an empty one) re-fires
  // even when the card instance reuses the same seg.id. The per-card
  // ref covers re-renders within the same instance (cheap, no DOM work).
  useEffect(() => {
    if (fetchedForIdRef.current === seg.id && fetchedIds.has(seg.id)) {
      // Same instance, same search — already done.
      return;
    }
    if (fetchedIds.has(seg.id)) {
      // Another card instance (or a StrictMode double-mount) already
      // fired this fetch — nothing more to do.
      fetchedForIdRef.current = seg.id;
      return;
    }
    fetchedForIdRef.current = seg.id;
    const key = readNadeshikoApiKey();
    if (!key) {
      setContextState('failed');
      return;
    }
    const ac = new AbortController();
    ctxAbortRef.current?.abort();
    ctxAbortRef.current = ac;
    fetchedIds.add(seg.id);
    setContextState('loading');
    getNadeshikoSegmentContext(key, seg.id, ac.signal)
      .then((ctx) => {
        if (ac.signal.aborted) return;
        setContext(ctx);
        setContextState('ready');
      })
      .catch((raw: unknown) => {
        if (ac.signal.aborted) return;
        const err = raw as NadeshikoError;
        if (
          err &&
          (err.kind === 'invalid-key' ||
            err.kind === 'rate-limited' ||
            err.kind === 'quota-exceeded')
        ) {
          // We surface these via the panel-level banner (it re-reads from
          // the search call); the card itself just shows the failed state.
          // network / invalid-response silently fall through to failed too.
        }
        setContextState('failed');
      });
    return () => {
      ac.abort();
    };
  }, [seg.id, fetchedIds]);

  const isPlaying = registry.playingId() === seg.id;
  const timestamp = formatTimestamp(seg, dict);

  // Build the context paragraph: render in temporal order as
  // [before-lines] + [centre] + [after-lines]. The API returns a flat
  // segments[] in temporal order; the client exposes `centerIdx` so we
  // know how many leading entries are "before". (Fallback centres also
  // carry centerIdx 0, so before+center+after stays temporal.)
  const contextParagraph = (() => {
    if (contextState === 'loading') return null;
    if (contextState === 'failed') return null;
    if (!context) return null;
    const lines: string[] = [];
    const beforeCount =
      context.centerIdx >= 0 ? context.centerIdx : context.surrounding.length;
    for (let i = 0; i < beforeCount && i < context.surrounding.length; i++) {
      lines.push(context.surrounding[i]!.line);
    }
    lines.push(context.center.line);
    for (let i = beforeCount; i < context.surrounding.length; i++) {
      lines.push(context.surrounding[i]!.line);
    }
    return lines.filter((l) => l.length > 0).join(' ');
  })();

  const onAudioToggle = () => {
    if (!seg.audioUrl) return;
    if (isPlaying) {
      registry.stop(seg.id);
    } else {
      registry.play(seg.id);
    }
  };

  return (
    <li className="entei-nadeshiko-card" role="listitem">
      {/* 16:9 thumbnail frame. The image is the background layer; the
          serif line + timestamp overlay it; the audio toggle is a
          positioned icon-button anchored top-left of the frame. */}
      <div className="entei-nadeshiko-card-media">
        {seg.imageUrl ? (
          <img
            className="entei-nadeshiko-card-image"
            src={seg.imageUrl}
            alt=""
            loading="lazy"
            decoding="async"
          />
        ) : (
          <div
            className="entei-nadeshiko-card-image-fallback"
            aria-hidden="true"
          />
        )}
        <div className="entei-nadeshiko-card-overlay">
          {seg.audioUrl && (
            <Button
              type="button"
              size="icon"
              variant="outline"
              className="entei-nadeshiko-card-audio"
              onClick={onAudioToggle}
              aria-pressed={isPlaying}
              aria-label={
                isPlaying ? dict.contextAudioStop : dict.contextAudioPlay
              }
              title={isPlaying ? dict.contextAudioStop : dict.contextAudioPlay}
            >
              {isPlaying ? (
                <Square aria-hidden="true" />
              ) : (
                <Volume2 aria-hidden="true" />
              )}
            </Button>
          )}
          {seg.audioUrl && (
            <audio
              ref={audioRef}
              src={seg.audioUrl}
              preload="none"
              // No controls — the icon-button is the only control surface.
            />
          )}
          <p className="entei-nadeshiko-card-line">{seg.line}</p>
          <span className="entei-nadeshiko-card-ts">{timestamp}</span>
        </div>
      </div>

      {/* Context + work block: dashed rounded frame per mock — the
          context paragraph sits inside, an HR divider separates it
          from the centered work name below. */}
      <div className="entei-nadeshiko-card-detail">
        {contextState === 'loading' && (
          <p className="entei-nadeshiko-card-context entei-nadeshiko-card-context--muted">
            {dict.contextContextLoading}
          </p>
        )}
        {contextState === 'failed' && (
          <p className="entei-nadeshiko-card-context entei-nadeshiko-card-context--muted">
            {dict.contextContextFailed}
          </p>
        )}
        {contextParagraph && (
          <p className="entei-nadeshiko-card-context">{contextParagraph}</p>
        )}

        <hr className="entei-nadeshiko-card-divider" aria-hidden="true" />
        <p className="entei-nadeshiko-card-work">{seg.workName || '—'}</p>
      </div>
    </li>
  );
}

/* ------------------------------------------------------------------------ */
/* Panel                                                                    */
/* ------------------------------------------------------------------------ */

/** Status of an in-flight pagination request. */
type PaginationState =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'error'; retry: ResolvedError };

/**
 * Internal scroll-container discovery. We try the closest
 * `.entei-right-panel-content` first (the actual scroll container in this
 * product — desktop and mobile, see RightPanel.tsx). If absent (e.g. the
 * panel was rendered standalone in a test, or a future layout shift), we
 * fall back to the document scrollingElement so the observer still fires.
 *
 * Returning `null` from IntersectionObserver means "viewport" — fine for
 * both cases.
 */
function findScrollRoot(el: HTMLElement | null): Element | null {
  let node: HTMLElement | null = el;
  while (node) {
    if (node.classList?.contains('entei-right-panel-content')) return node;
    node = node.parentElement;
  }
  if (typeof document !== 'undefined') {
    return document.scrollingElement ?? document.documentElement;
  }
  return null;
}

export function NadeshikoPanel({ dict }: NadeshikoPanelProps) {
  // `setApiKey` is a re-render-only trigger. We never read the value — the
  // handler below re-reads via readNadeshikoApiKey() and acts on the result.
  // Keeping the state (instead of using a plain ref) ensures the panel
  // re-renders when the key changes via the `storage` / key-changed events,
  // so all derived UI (banner, etc.) stays in sync.
  const [, setApiKey] = useState<string | null>(() => readNadeshikoApiKey());
  const [query, setQuery] = useState('');
  // The submitted (immutable) search term. Editing the input after submit
  // must not affect the in-flight or paginating query — see loadMore.
  const [submittedQuery, setSubmittedQuery] = useState<string | null>(null);
  // Append-only results across all pages, deduped by segment id.
  const [results, setResults] = useState<NadeshikoSegment[]>([]);
  // Cursor for the *next* page. `null` ⇒ terminal (no more pages, or
  // never paginated). The new-query effect resets this alongside results.
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(false);
  // True only for the very first fetch (the initial submit). Subsequent
  // appends use `paginationState` instead so the form input stays usable
  // and the search button isn't replaced with the spinner.
  const [loading, setLoading] = useState(false);
  // Initial error reflects "no key set" so the empty state already nudges the
  // user toward Settings (docs/NADESHIKO_INTEGRATION.md §3.3 states table).
  const [error, setError] = useState<ResolvedError | null>(() =>
    readNadeshikoApiKey() === null ? { kind: 'key-missing' } : null,
  );
  const [hasSearched, setHasSearched] = useState(false);
  const [paginationState, setPaginationStateRaw] = useState<PaginationState>({
    kind: 'idle',
  });
  // Helper that updates both the visible state and the synchronous ref
  // `loadMore` reads. The two must stay in lockstep so a stale closure
  // inside the IO callback can't accidentally issue a request after an
  // error or while one is already in flight.
  const setPaginationState = useCallback((next: PaginationState) => {
    paginationStateRef.current = next;
    setPaginationStateRaw(next);
  }, []);
  // Monotonic counter; bumped on submit / retry. The visible `generation`
  // state drives the IO effect's re-attach (so the observer re-creates
  // after each new search) and is matched by `generationRef.current` for in-flight
  // race checks. See `handleSearch` for the canonical pattern.
  const [generation, setGeneration] = useState(0);
  const abortRef = useRef<AbortController | null>(null);
  // Synchronous in-flight guard for pagination. Without this, the
  // IntersectionObserver can fire multiple times in the same tick (e.g.
  // layout shifts between two adjacent elements, scroll restoration on
  // history navigation) and we'd kick off duplicate fetches. We flip it
  // to true the moment we start, and back to false in the same async
  // finally{} so the next observer tick can fire again normally.
  const paginationInFlightRef = useRef(false);
  // Tracks the last cursor we issued a request for, so we can detect a
  // "no progress" loop (server returns the same cursor we already used).
  const lastIssuedCursorRef = useRef<string | null>(null);
  // Mirror of `paginationState` so `loadMore` can short-circuit on
  // 'error' / 'loading' without reading stale state from a closure.
  // Updated alongside `setPaginationState` so the two never diverge.
  const paginationStateRef = useRef<PaginationState>({ kind: 'idle' });
  // Generation counter kept on a ref so async callbacks can read the
  // current value without being captured by stale closures. The matching
  // `generation` state is what the IO effect depends on to re-attach after
  // each new search. Each fetch snapshots `generationRef.current` at start
  // and the post-await check compares against the live value.
  const generationRef = useRef(0);
  // Audio registry lives for the lifetime of the panel — one audio element
  // per card, only one playing at a time. We tear it down on unmount.
  const registryRef = useRef<AudioRegistry | null>(null);
  if (registryRef.current === null) {
    registryRef.current = createAudioRegistry();
  }
  // Panel-level set of segment ids whose context fetch has been kicked off
  // (or completed). Survives StrictMode double-mounts where the per-card
  // ref gets reset. The set is **append-only across paginated appends**
  // (cleared only by a fresh submit / new query), so page-2 cards never
  // re-fetch context that page-1 already loaded.
  const fetchedIdsRef = useRef<Set<string>>(new Set());
  // The sentinel <div> that the IntersectionObserver watches. Ref'd so
  // we can attach the observer after mount and detach on unmount.
  const sentinelRef = useRef<HTMLDivElement | null>(null);
  // IntersectionObserver instance kept on a ref so the cleanup path can
  // disconnect it. We don't render it directly.
  const observerRef = useRef<IntersectionObserver | null>(null);
  // Last scroll-root we used to set up the observer. If the panel is
  // re-mounted into a different DOM (rare; mostly tests) we re-attach.
  const observerRootRef = useRef<Element | null>(null);

  // Live-update the API key from settings. Re-evaluate the key-missing
  // banner so it disappears as soon as a key is saved (and re-appears if
  // the user clears it again from settings).
  useEffect(() => {
    const handler = () => {
      const key = readNadeshikoApiKey();
      setApiKey(key);
      setError((prev) => {
        if (key) return null; // key restored → clear the key-missing banner
        if (prev?.kind === 'key-missing') return prev;
        return { kind: 'key-missing' };
      });
    };
    window.addEventListener('storage', handler);
    // Custom event from NadeshikoSettingsTab so changes within this tab too.
    window.addEventListener('entei:nadeshiko-key-changed', handler);
    return () => {
      window.removeEventListener('storage', handler);
      window.removeEventListener('entei:nadeshiko-key-changed', handler);
    };
  }, []);

  // Clear any in-flight search + audio + observer on unmount.
  useEffect(() => {
    return () => {
      abortRef.current?.abort();
      registryRef.current?.stopAll();
      observerRef.current?.disconnect();
      observerRef.current = null;
      observerRootRef.current = null;
    };
  }, []);

  /**
   * Core fetch primitive: takes a snapshot of (query, cursor, generation)
   * so the in-flight handler can't accidentally read the latest state and
   * route the response to a newer submit. Returns the raw page (or null
   * on abort) without touching component state — callers decide how to
   * merge it.
   */
  const runSearch = useCallback(
    async (params: {
      key: string;
      q: string;
      cursor: string | null;
      gen: number;
      signal: AbortSignal;
    }): Promise<NadeshikoSearchPage | null> => {
      // Errors propagate verbatim — `searchNadeshikoSegments` already
      // throws typed `NadeshikoError`s, and the submit / loadMore
      // wrappers rely on `err.kind` to choose the right banner.
      const page = await searchNadeshikoSegments(
        params.key,
        params.q,
        {
          include: ['media'],
          ...(params.cursor ? { cursor: params.cursor } : {}),
        },
        params.signal,
      );
      if (params.signal.aborted) return null;
      return page;
    },
    [],
  );

  /**
   * Append a page to the existing result list, preserving order, dedupe by
   * segment id. Returns the updated list (immutable update). Cards already
   * present from earlier pages stay where they are so the UI doesn't jump.
   */
  const appendPage = useCallback(
    (existing: NadeshikoSegment[], incoming: NadeshikoSegment[]) => {
      if (incoming.length === 0) return existing;
      const seen = new Set(existing.map((s) => s.id));
      const additions: NadeshikoSegment[] = [];
      for (const seg of incoming) {
        if (seen.has(seg.id)) continue;
        seen.add(seg.id);
        additions.push(seg);
      }
      if (additions.length === 0) return existing;
      return [...existing, ...additions];
    },
    [],
  );

  /**
   * Submit handler. Resets every pagination field, captures the immutable
   * query term, and fires the first-page fetch. Old fetches are aborted.
   */
  const handleSearch = useCallback(
    async (e?: React.SyntheticEvent<HTMLFormElement>) => {
      e?.preventDefault();
      const q = query.trim();
      if (q.length === 0) return;

      const key = readNadeshikoApiKey();
      if (!key) {
        setError({ kind: 'key-missing' });
        return;
      }

      abortRef.current?.abort();
      const ac = new AbortController();
      abortRef.current = ac;

      // Bump generation FIRST so any in-flight response from the previous
      // submit is recognised as stale by the post-await check below.
      // We update both the ref (read inside the async body) and the state
      // (so the IO effect re-attaches with a fresh loadMore closure).
      generationRef.current += 1;
      setGeneration(generationRef.current);
      const myGen = generationRef.current;

      // Fresh result set → fresh burst of context fetches. Clearing the
      // panel-level fetched-id set lets each new card fire its context
      // request (StrictMode remounts reuse the same seg.id, so without
      // this clear those would be silently skipped).
      fetchedIdsRef.current = new Set<string>();
      lastIssuedCursorRef.current = null;
      paginationInFlightRef.current = false;

      setLoading(true);
      setError(null);
      setResults([]);
      setNextCursor(null);
      setHasMore(false);
      setPaginationState({ kind: 'idle' });
      // Reset the "no-progress" tracker so the first pagination request
      // for the new query isn't mistakenly treated as a stuck loop. We
      // deliberately don't touch it inside the success branch below —
      // that's the responsibility of `loadMore`, which records the
      // cursor it actually issued a request for.
      lastIssuedCursorRef.current = null;
      setSubmittedQuery(q);
      // Stop any currently-playing audio before swapping in new results so
      // a re-search doesn't leave the previous card's audio dangling.
      registryRef.current?.stopAll();

      try {
        const page = await runSearch({
          key,
          q,
          cursor: null,
          gen: myGen,
          signal: ac.signal,
        });
        if (!page) return; // aborted
        if (myGen !== generationRef.current) {
          // Generation moved on while we were fetching (user already
          // submitted again). Drop this response on the
          // floor so old results don't bleed into the new state.
          return;
        }
        setResults(page.segments);
        // Defensive: the spec pairs hasMore with a non-null cursor; the
        // client already coerces the canonical pair, but a typed spy or
        // an upstream proxy could hand us `hasMore: true, nextCursor: null`
        // anyway. Treat that as terminal here so the sentinel can settle.
        if (page.hasMore && !page.nextCursor) {
          setHasMore(false);
          setNextCursor(null);
        } else {
          setHasMore(page.hasMore);
          setNextCursor(page.nextCursor);
        }
        setHasSearched(true);
      } catch (raw) {
        if (ac.signal.aborted) return;
        const err = raw as NadeshikoError;
        if (myGen !== generationRef.current) return;
        if (err && err.kind) {
          setError(resolveError(err));
        } else {
          setError({ kind: 'generic' });
        }
        setHasSearched(true);
      } finally {
        if (!ac.signal.aborted) setLoading(false);
      }
    },
    [query, runSearch],
  );

  /**
   * Append the next page. Synchronous in-flight guard prevents duplicate
   * observer triggers from issuing parallel fetches. The function is a
   * no-op when:
   *  - there's no submitted query (initial state)
   *  - pagination is already in flight
   *  - `hasMore` is false or there's no cursor
   *  - the cursor would repeat (server-side no-progress)
   *  - the API key isn't set
   *  - the generation has already moved on (race against a new submit)
   */
  const loadMore = useCallback(async () => {
    if (paginationInFlightRef.current) return;
    // Read the synchronous ref so an old closure / stale render doesn't
    // see 'idle' when we're already in 'error' or 'loading'.
    if (paginationStateRef.current.kind !== 'idle') return;
    if (!submittedQuery) return;
    if (!hasMore) return;
    if (!nextCursor) return;
    if (lastIssuedCursorRef.current === nextCursor) {
      // We already requested this cursor and the server is echoing it
      // back (e.g. an upstream bug). Stop here so we don't loop forever.
      setHasMore(false);
      return;
    }
    const key = readNadeshikoApiKey();
    if (!key) return;

    const ac = new AbortController();
    // If a first-page fetch is still in flight we abort it here — the
    // user clicked something (Retry) or the observer triggered a second
    // time, which means they want pagination, not the initial fetch.
    abortRef.current?.abort();
    abortRef.current = ac;
    const myGen = generationRef.current;
    paginationInFlightRef.current = true;
    lastIssuedCursorRef.current = nextCursor;
    setPaginationState({ kind: 'loading' });

    try {
      const page = await runSearch({
        key,
        q: submittedQuery,
        cursor: nextCursor,
        gen: myGen,
        signal: ac.signal,
      });
      if (!page) return;
      if (myGen !== generationRef.current) return;
      setResults((prev) => appendPage(prev, page.segments));
      if (page.hasMore && !page.nextCursor) {
        // Same defensive coerce as in handleSearch — see note there.
        setHasMore(false);
        setNextCursor(null);
      } else {
        setHasMore(page.hasMore);
        setNextCursor(page.nextCursor);
      }
      setPaginationState({ kind: 'idle' });
    } catch (raw) {
      if (ac.signal.aborted) return;
      if (myGen !== generationRef.current) return;
      const err = raw as NadeshikoError;
      // Clear the no-progress cursor tracker so the user's manual retry
      // with the same cursor isn't mistaken for a stuck loop. On the
      // success path the tracker is left as-is (or implicitly cleared
      // when the response advances).
      lastIssuedCursorRef.current = null;
      if (err && err.kind) {
        // For pagination errors we surface the same banner shape the
        // initial search uses, but inline next to the sentinel so users
        // see the existing results still rendered above. `loading` stays
        // false so the form input stays usable.
        setPaginationState({
          kind: 'error',
          retry: resolveError(err),
        });
      } else {
        setPaginationState({ kind: 'error', retry: { kind: 'generic' } });
      }
    } finally {
      paginationInFlightRef.current = false;
    }
  }, [submittedQuery, hasMore, nextCursor, runSearch, appendPage]);

  /**
   * Retry handler for pagination errors. Same effect as the observer
   * firing again, but user-initiated (so it doesn't have to wait for the
   * sentinel to come back into view). Re-uses `loadMore`'s guards.
   */
  const handleRetryPagination = useCallback(() => {
    setPaginationState({ kind: 'idle' });
    void loadMore();
  }, [loadMore]);

  /**
   * IntersectionObserver effect: watches the sentinel at the bottom of the
   * results. The root is the closest `.entei-right-panel-content` ancestor
   * (the panel's actual scroll container per RightPanel.tsx / player.css);
   * falls back to viewport scrolling when the panel doesn't own the
   * scroll. We re-attach when the sentinel element, root, or `loadMore`
   * callback changes — the callback change is the most frequent trigger
   * (every render with a new `loadMore` identity), so we keep the effect
   * cheap by using a stable `loadMoreRef`.
   */
  const loadMoreRef = useRef(loadMore);
  loadMoreRef.current = loadMore;

  useEffect(() => {
    const sentinel = sentinelRef.current;
    if (!sentinel || typeof IntersectionObserver === 'undefined') return;
    const root = findScrollRoot(sentinel);
    // If the root changed (e.g. the panel re-mounted into a different DOM
    // container), disconnect the previous observer so we don't leak it.
    if (observerRef.current && observerRootRef.current !== root) {
      observerRef.current.disconnect();
      observerRef.current = null;
    }
    if (observerRef.current) return; // already attached

    // `rootMargin` pulls the trigger line above the literal viewport edge
    // so pages that have ample content right at the bottom (e.g. a
    // precisely-fitting card) still get the sentinel to fire. We pick a
    // modest 200px so we don't load two pages ahead of the user.
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            void loadMoreRef.current();
            break;
          }
        }
      },
      {
        // `root: null` means the viewport, which is what we want when
        // there's no scrolling ancestor. When the sentinel has a scrolling
        // ancestor we pass that as the root so observers fire relative to
        // its scroll position, not the page's.
        ...(root ? { root } : {}),
        rootMargin: '200px 0px',
        threshold: 0,
      },
    );
    observer.observe(sentinel);
    observerRef.current = observer;
    observerRootRef.current = root;
    return () => {
      observer.disconnect();
      if (observerRef.current === observer) {
        observerRef.current = null;
        observerRootRef.current = null;
      }
    };
  }, [submittedQuery, results.length, hasMore, generation]);

  // Inline API-key form (key-missing state): draft + saving state. On save,
  // the key lands in localStorage and the panel re-reads via the same
  // entei:nadeshiko-key-changed broadcast the Settings tab uses.
  const [keyDraft, setKeyDraft] = useState('');
  const [keySaving, setKeySaving] = useState(false);
  const [keySaveFailed, setKeySaveFailed] = useState(false);

  const handleKeySave = useCallback(() => {
    const trimmed = keyDraft.trim();
    if (trimmed.length === 0) return;
    setKeySaving(true);
    const ok = writeNadeshikoApiKey(trimmed);
    setKeySaving(false);
    if (!ok) {
      setKeySaveFailed(true);
      return;
    }
    setKeySaveFailed(false);
    setKeyDraft('');
    if (typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent('entei:nadeshiko-key-changed'));
    }
  }, [keyDraft]);

  const countdown = useRateLimitCountdown(error);

  // Renders the error banner (or empty).
  const errorBanner = (() => {
    if (!countdown) return null;
    switch (countdown.kind) {
      case 'key-missing':
        return (
          <div className="entei-nadeshiko-error" role="status">
            <DoorClosedLocked
              aria-hidden="true"
              className="entei-nadeshiko-error-icon"
            />
            <p>{dict.contextKeyMissing}</p>
            <form
              className="entei-nadeshiko-key-form"
              onSubmit={(e) => {
                e.preventDefault();
                handleKeySave();
              }}
            >
              <ButtonGroup className="entei-nadeshiko-form-group">
                <Input
                  type="password"
                  value={keyDraft}
                  onChange={(e) => {
                    setKeyDraft(e.target.value);
                    setKeySaveFailed(false);
                  }}
                  placeholder={dict.contextKeyInputPlaceholder}
                  aria-label={dict.contextKeyInputPlaceholder}
                  disabled={keySaving}
                  autoComplete="off"
                />
                <Button
                  type="submit"
                  size="sm"
                  variant="outline"
                  className="entei-nadeshiko-search-btn"
                  disabled={keySaving || keyDraft.trim().length === 0}
                  aria-label={dict.contextKeySave}
                  title={dict.contextKeySave}
                >
                  <KeyRound size={16} aria-hidden="true" />
                </Button>
              </ButtonGroup>
            </form>
            {keySaveFailed && (
              <p className="entei-nadeshiko-key-error">
                {dict.contextKeySaveFailed}
              </p>
            )}
          </div>
        );
      case 'invalid-key':
        return (
          <div className="entei-nadeshiko-error" role="alert">
            <p>{dict.contextInvalidKey}</p>
          </div>
        );
      case 'rate-limited':
        return (
          <div className="entei-nadeshiko-error" role="alert">
            <p>{dict.contextRateLimited(countdown.retryAfterSeconds)}</p>
          </div>
        );
      case 'quota-exceeded':
        return (
          <div className="entei-nadeshiko-error" role="alert">
            <p>{dict.contextQuotaExceeded}</p>
          </div>
        );
      case 'network':
        return (
          <div className="entei-nadeshiko-error" role="alert">
            <p>{dict.contextNetworkError}</p>
          </div>
        );
      case 'generic':
        return (
          <div className="entei-nadeshiko-error" role="alert">
            <p>{dict.contextGenericError}</p>
          </div>
        );
    }
  })();

  return (
    <div className="entei-nadeshiko-root">
      <form
        className="entei-nadeshiko-form"
        onSubmit={handleSearch}
        aria-label={dict.contextSearchAriaLabel}
      >
        <ButtonGroup className="entei-nadeshiko-form-group">
          <Input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={dict.contextSearchPlaceholder}
            aria-label={dict.contextSearchPlaceholder}
            disabled={loading}
          />
          <Button
            type="submit"
            size="sm"
            variant="outline"
            className="entei-nadeshiko-search-btn"
            disabled={loading || query.trim().length === 0}
            aria-label={dict.contextSearchButton}
            title={dict.contextSearchButton}
          >
            <Search size={16} aria-hidden="true" />
          </Button>
        </ButtonGroup>
      </form>

      {errorBanner}

      {hasSearched && !loading && results.length === 0 && !error && (
        <p className="entei-nadeshiko-empty" role="status">
          {dict.contextEmpty}
        </p>
      )}

      <ul className="entei-nadeshiko-results" role="list">
        {results.map((seg) => (
          <NadeshikoCard
            key={seg.id}
            seg={seg}
            dict={dict}
            registry={registryRef.current!}
            fetchedIds={fetchedIdsRef.current}
          />
        ))}
      </ul>

      {/*
        Pagination sentinel + status row.

        The sentinel is always rendered when there are results, even when
        `hasMore` is false — we want the empty stub to be measured so the
        IntersectionObserver can confirm "no more pages needed" without us
        writing extra effect code. When hasMore is false the sentinel is
        only a visual placeholder (no observer trigger), and we show the
        end-of-list message in its place.

        Loading / error affordances render inline. Per the user-spec, the
        existing cards above stay visible during a pagination error — the
        user can read what they already have while deciding whether to
        retry, dismiss, or change the query.
      */}
      {results.length > 0 && (
        <div className="entei-nadeshiko-pagination" aria-live="polite">
          {paginationState.kind === 'loading' && (
            <p
              className="entei-nadeshiko-pagination-status entei-nadeshiko-pagination-status--loading"
              role="status"
            >
              <Loader2
                size={14}
                className="entei-nadeshiko-pagination-spinner"
                aria-hidden="true"
              />
              <span>{dict.contextLoadingMore}</span>
            </p>
          )}
          {paginationState.kind === 'error' && (
            <div className="entei-nadeshiko-pagination-error" role="alert">
              <p className="entei-nadeshiko-pagination-error-text">
                {paginationState.retry.kind === 'rate-limited'
                  ? dict.contextRateLimited(
                      paginationState.retry.retryAfterSeconds,
                    )
                  : paginationState.retry.kind === 'invalid-key'
                    ? dict.contextInvalidKey
                    : paginationState.retry.kind === 'quota-exceeded'
                      ? dict.contextQuotaExceeded
                      : paginationState.retry.kind === 'network'
                        ? dict.contextNetworkError
                        : dict.contextGenericError}
              </p>
              <Button
                type="button"
                size="sm"
                variant="outline"
                className="entei-nadeshiko-retry-btn"
                onClick={handleRetryPagination}
                aria-label={dict.contextRetry}
              >
                {dict.contextRetry}
              </Button>
            </div>
          )}
          {!hasMore && paginationState.kind === 'idle' && (
            <p className="entei-nadeshiko-pagination-end" role="status">
              {dict.contextEndOfResults}
            </p>
          )}
          {/*
            The actual IntersectionObserver sentinel. `aria-hidden` because
            it's purely a layout trigger, not user-facing content. We
            always mount it when results exist (even after hasMore flips
            to false) so the observer doesn't re-create on every render.
          */}
          <div
            ref={sentinelRef}
            className="entei-nadeshiko-sentinel"
            aria-hidden="true"
          />
        </div>
      )}
    </div>
  );
}
