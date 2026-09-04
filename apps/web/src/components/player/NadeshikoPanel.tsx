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
 *   rate-limited with Retry-After countdown)
 * - Loads the API key from localStorage; listens for key-change events.
 * - Key-missing shows an inline API-key form (ButtonGroup: password input
 *   + KeyRound icon button) that saves straight to localStorage.
 *
 * Rate-limit math: each search is 1 request; per-card context fetch is
 * `take` requests (one per visible card). Spec allows 150 req / 60s and
 * defaults to take=10, so worst case per search = 1 + 10 = 11 requests,
 * well inside the budget. We fire context fetches in parallel (no stagger)
 * to keep perceived latency low.
 *
 * StrictMode burst guard: a panel-level `fetchedIds` set tracks which
 * segment ids have already kicked off a context fetch. Cleared on each
 * new search. This prevents React 18 StrictMode's double-mount from
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
} from 'lucide-react';
import { Input } from '@/components/player/ui/input';
import { Button } from '@/components/player/ui/button';
import { ButtonGroup } from '@/components/player/ui/button-group';
import { TypewriterLoading } from '@/components/player/TypewriterLoading';
import {
  searchNadeshikoSegments,
  getNadeshikoSegmentContext,
  type NadeshikoSegment,
  type NadeshikoSegmentContextResponse,
  type NadeshikoError,
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

      {/* Context paragraph: italic / muted, always visible once loaded. */}
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

      <p className="entei-nadeshiko-card-work">{seg.workName || '—'}</p>
    </li>
  );
}

/* ------------------------------------------------------------------------ */
/* Panel                                                                    */
/* ------------------------------------------------------------------------ */

export function NadeshikoPanel({ dict }: NadeshikoPanelProps) {
  // `setApiKey` is a re-render-only trigger. We never read the value — the
  // handler below re-reads via readNadeshikoApiKey() and acts on the result.
  // Keeping the state (instead of using a plain ref) ensures the panel
  // re-renders when the key changes via the `storage` / key-changed events,
  // so all derived UI (banner, etc.) stays in sync.
  const [, setApiKey] = useState<string | null>(() => readNadeshikoApiKey());
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<NadeshikoSegment[]>([]);
  const [loading, setLoading] = useState(false);
  // Initial error reflects "no key set" so the empty state already nudges the
  // user toward Settings (docs/NADESHIKO_INTEGRATION.md §3.3 states table).
  const [error, setError] = useState<ResolvedError | null>(() =>
    readNadeshikoApiKey() === null ? { kind: 'key-missing' } : null,
  );
  const [hasSearched, setHasSearched] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  // Audio registry lives for the lifetime of the panel — one audio element
  // per card, only one playing at a time. We tear it down on unmount.
  const registryRef = useRef<AudioRegistry | null>(null);
  if (registryRef.current === null) {
    registryRef.current = createAudioRegistry();
  }
  // Panel-level set of segment ids whose context fetch has been kicked off
  // (or completed). Survives StrictMode double-mounts where the per-card
  // ref gets reset. Cleared on each new search via the assignments below.
  const fetchedIdsRef = useRef<Set<string>>(new Set());

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

  // Clear any in-flight search + audio on unmount.
  useEffect(() => {
    return () => {
      abortRef.current?.abort();
      registryRef.current?.stopAll();
    };
  }, []);

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

      // Fresh result set → fresh burst of context fetches. Clearing the
      // panel-level fetched-id set lets each new card fire its context
      // request (StrictMode remounts reuse the same seg.id, so without
      // this clear those would be silently skipped).
      fetchedIdsRef.current = new Set<string>();

      setLoading(true);
      setError(null);
      // Stop any currently-playing audio before swapping in new results so
      // a re-search doesn't leave the previous card's audio dangling.
      registryRef.current?.stopAll();

      try {
        // include: ['media'] so includes.media resolves workName (this is
        // the user-reported "作品名が見えない" fix — without this, the
        // segment's workName comes back as "" and the card shows "—").
        const data = await searchNadeshikoSegments(
          key,
          q,
          { include: ['media'] },
          ac.signal,
        );
        if (ac.signal.aborted) return;
        setResults(data);
        setHasSearched(true);
      } catch (raw) {
        if (ac.signal.aborted) return;
        const err = raw as NadeshikoError;
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
    [query],
  );

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
            {loading ? (
              <TypewriterLoading
                text="…"
                className="entei-typewriter--btn"
                aria-hidden="true"
              />
            ) : (
              <Search size={16} aria-hidden="true" />
            )}
          </Button>
        </ButtonGroup>
      </form>

      {errorBanner}

      {hasSearched && !loading && results.length === 0 && !error && (
        <p className="entei-nadeshiko-empty" role="status">
          {dict.contextEmpty}
        </p>
      )}

      {results.length > 0 && (
        <p className="entei-nadeshiko-count" aria-live="polite">
          {dict.contextResultsHeading(results.length)}
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
    </div>
  );
}
