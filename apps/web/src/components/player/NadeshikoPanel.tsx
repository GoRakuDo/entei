/**
 * NadeshikoPanel — Nuance / context search tab in RightPanel.
 * ---------------------------------------------------------------------------
 * Design: docs/NADESHIKO_INTEGRATION.md §3.3.
 * - Search input + button → POST /v1/search
 * - Click result → expand inline (GET /v1/media/segments/{id}/context)
 * - States: empty / no-results / loading / error×3 (key-missing / invalid-key /
 *   rate-limited with Retry-After countdown)
 * - Loads the API key from localStorage; listens for key-change events.
 * - Opens the settings dialog via dispatchOpenSettings().
 * ---------------------------------------------------------------------------
 */
'use client';

import { useState, useCallback, useEffect, useRef } from 'react';
import { Search, ChevronDown, ChevronUp } from 'lucide-react';
import { Input } from '@/components/player/ui/input';
import { Button } from '@/components/player/ui/button';
import { TypewriterLoading } from '@/components/player/TypewriterLoading';
import {
  searchNadeshikoSegments,
  getNadeshikoSegmentContext,
  type NadeshikoSegment,
  type NadeshikoSegmentContext,
  type NadeshikoError,
} from '@/features/nadeshiko/nadeshiko-client';
import { readNadeshikoApiKey } from '@/features/nadeshiko/api-key';
import { dispatchOpenSettings } from '@/features/player/settings-bridge';
import type { Dictionary } from '@i18n/types';

interface NadeshikoPanelProps {
  dict: Dictionary['playerUI'];
}

/** How to format the Nadeshiko error into the user's dictionary. */
type ResolvedError =
  | { kind: 'key-missing' }
  | { kind: 'invalid-key' }
  | { kind: 'rate-limited'; retryAfterSeconds: number }
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
    case 'network':
      return { kind: 'network' };
    case 'invalid-response':
      return { kind: 'generic' };
  }
}

function formatTimestamp(seg: NadeshikoSegment, dict: Dictionary['playerUI']): string {
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

export function NadeshikoPanel({ dict }: NadeshikoPanelProps) {
  // `setApiKey` is a re-render-only trigger. We never read the value — the
  // handler below re-reads via readNadeshikoApiKey() and acts on the result.
  // Keeping the state (instead of using a plain ref) ensures the panel
  // re-renders when the key changes via the `storage` / key-changed events,
  // so all derived UI (banner, etc.) stays in sync.
  const [, setApiKey] = useState<string | null>(() => readNadeshikoApiKey());
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<NadeshikoSegment[]>([]);
  const [expanded, setExpanded] = useState<Map<string, NadeshikoSegmentContext>>(
    new Map(),
  );
  const [loading, setLoading] = useState(false);
  // Track per-segment in-flight context fetches explicitly. The old inference
  // (`surrounding.length === 0`) broke when the API returned a legitimate
  // empty surrounding list, leaving the card stuck on "Loading…".
  const [ctxLoadingIds, setCtxLoadingIds] = useState<Set<string>>(new Set());
  // Initial error reflects "no key set" so the empty state already nudges the
  // user toward Settings (docs/NADESHIKO_INTEGRATION.md §3.3 states table).
  const [error, setError] = useState<ResolvedError | null>(() =>
    readNadeshikoApiKey() === null ? { kind: 'key-missing' } : null,
  );
  const [hasSearched, setHasSearched] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  // Per-card AbortControllers for in-flight context fetches. Keyed by
    // segment id so we can cancel an individual card's fetch (e.g. when the
    // user collapses it) without affecting other cards.
  const ctxAbortRef = useRef<Map<string, AbortController>>(new Map());

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

  // Clear any in-flight request on unmount.
  useEffect(() => {
    return () => {
      abortRef.current?.abort();
      ctxAbortRef.current.forEach((ac) => ac.abort());
      ctxAbortRef.current.clear();
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

      setLoading(true);
      setError(null);
      setExpanded(new Map());
      // Cancel any in-flight per-card context fetches and clear their ids.
      ctxAbortRef.current.forEach((inner) => inner.abort());
      ctxAbortRef.current.clear();
      setCtxLoadingIds(new Set());

      try {
        const data = await searchNadeshikoSegments(
          key,
          q,
          {},
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

  const handleExpand = useCallback(
    async (seg: NadeshikoSegment) => {
      if (expanded.has(seg.id)) {
        // Collapsing — cancel any in-flight context fetch for this card.
        ctxAbortRef.current.get(seg.id)?.abort();
        ctxAbortRef.current.delete(seg.id);
        setExpanded((prev) => {
          const next = new Map(prev);
          next.delete(seg.id);
          return next;
        });
        setCtxLoadingIds((prev) => {
          if (!prev.has(seg.id)) return prev;
          const next = new Set(prev);
          next.delete(seg.id);
          return next;
        });
        return;
      }

      const key = readNadeshikoApiKey();
      if (!key) return;

      const ac = new AbortController();
      ctxAbortRef.current.set(seg.id, ac);

      // Mark this card as in-flight before placing the placeholder.
      setCtxLoadingIds((prev) => {
        const next = new Set(prev);
        next.add(seg.id);
        return next;
      });

      // Placeholder for loading state.
      setExpanded((prev) => {
        const next = new Map(prev);
        next.set(seg.id, {
          ...seg,
          surrounding: [],
        });
        return next;
      });

      try {
        const ctx = await getNadeshikoSegmentContext(key, seg.id, ac.signal);
        if (ac.signal.aborted) return;
        setExpanded((prev) => {
          const next = new Map(prev);
          next.set(seg.id, ctx);
          return next;
        });
      } catch (raw) {
        if (ac.signal.aborted) return;
        const err = raw as NadeshikoError;
        setExpanded((prev) => {
          const next = new Map(prev);
          next.set(seg.id, { ...seg, surrounding: [] });
          return next;
        });
        if (err && err.kind) {
          setError(resolveError(err));
        } else {
          setError({ kind: 'generic' });
        }
      } finally {
        ctxAbortRef.current.delete(seg.id);
        if (!ac.signal.aborted) {
          setCtxLoadingIds((prev) => {
            if (!prev.has(seg.id)) return prev;
            const next = new Set(prev);
            next.delete(seg.id);
            return next;
          });
        }
      }
    },
    [expanded],
  );

  const countdown = useRateLimitCountdown(error);

  // Renders the error banner (or empty).
  const errorBanner = (() => {
    if (!countdown) return null;
    switch (countdown.kind) {
      case 'key-missing':
        return (
          <div className="entei-nadeshiko-error" role="status">
            <p>{dict.contextKeyMissing}</p>
            <Button
              type="button"
              size="sm"
              variant="default"
              onClick={() => dispatchOpenSettings()}
            >
              {dict.contextKeyMissingAction}
            </Button>
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
          disabled={loading || query.trim().length === 0}
          aria-label={dict.contextSearchButton}
        >
          {loading ? (
            <TypewriterLoading
              text="…"
              className="entei-typewriter--btn"
              aria-hidden="true"
            />
          ) : (
            <>
              <Search size={16} aria-hidden="true" />
              <span>{dict.contextSearchButton}</span>
            </>
          )}
        </Button>
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
        {results.map((seg) => {
          const ctx = expanded.get(seg.id);
          const isOpen = expanded.has(seg.id);
          const isCtxLoading = isOpen && ctxLoadingIds.has(seg.id);
          return (
            <li key={seg.id} className="entei-nadeshiko-card" role="listitem">
              <button
                type="button"
                className="entei-nadeshiko-card-toggle"
                onClick={() => handleExpand(seg)}
                aria-expanded={isOpen}
              >
                <div className="entei-nadeshiko-card-row">
                  <span className="entei-nadeshiko-card-label">
                    {dict.contextResultWorkLabel}:
                  </span>{' '}
                  <span className="entei-nadeshiko-card-value">
                    {seg.workName || '—'}
                  </span>
                  <span className="entei-nadeshiko-card-ts">
                    {formatTimestamp(seg, dict)}
                  </span>
                </div>
                <div className="entei-nadeshiko-card-row">
                  <span className="entei-nadeshiko-card-label">
                    {dict.contextResultLineLabel}:
                  </span>{' '}
                  <span className="entei-nadeshiko-card-line">{seg.line}</span>
                </div>
                <div className="entei-nadeshiko-card-row">
                  <span className="entei-nadeshiko-card-label">
                    {dict.contextResultEnglishLabel}:
                  </span>{' '}
                  <span className="entei-nadeshiko-card-value">
                    {seg.englishTranslation ?? dict.contextNoEnglishTranslation}
                  </span>
                </div>
                {isOpen ? (
                  <ChevronUp size={14} aria-hidden="true" />
                ) : (
                  <ChevronDown size={14} aria-hidden="true" />
                )}
              </button>
              {isOpen && (
                <div className="entei-nadeshiko-context" role="region">
                  {isCtxLoading ? (
                    <p>{dict.contextContextLoading}</p>
                  ) : ctx && ctx.surrounding.length > 0 ? (
                    <ul>
                      {ctx.surrounding.map((line) => (
                        <li
                          key={`${line.id}-${line.timestampSeconds ?? line.timestampLabel ?? ''}`}
                          className="entei-nadeshiko-context-line"
                        >
                          <span className="entei-nadeshiko-card-ts">
                            {formatTimestamp(line, dict)}
                          </span>
                          <span>{line.line}</span>
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p>{dict.contextContextFailed}</p>
                  )}
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}