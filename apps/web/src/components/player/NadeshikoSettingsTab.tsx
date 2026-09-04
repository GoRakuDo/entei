/**
 * NadeshikoSettingsTab — Settings UI for Nadeshiko API key + quota.
 * ---------------------------------------------------------------------------
 * Design: docs/NADESHIKO_INTEGRATION.md §3.4.
 * - Password-style input with show/hide toggle (Lucide Eye / EyeOff).
 * - Save / clear buttons, validation (non-empty trimmed string).
 * - On save and on existing key, fetch /v1/user/me to display quota.
 * - Dispatches 'entei:nadeshiko-key-changed' so NadeshikoPanel re-reads.
 * ---------------------------------------------------------------------------
 */
'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import { Eye, EyeOff, Eraser } from 'lucide-react';
import { Button } from '@/components/player/ui/button';
import { ButtonGroup } from '@/components/player/ui/button-group';
import { Input } from '@/components/player/ui/input';
import { TypewriterLoading } from '@/components/player/TypewriterLoading';
import {
  readNadeshikoApiKey,
  writeNadeshikoApiKey,
  clearNadeshikoApiKey,
} from '@/features/nadeshiko/api-key';
import {
  getNadeshikoUserMe,
  type NadeshikoUserMe,
  type NadeshikoError,
} from '@/features/nadeshiko/nadeshiko-client';
import type { Dictionary } from '@i18n/types';

interface NadeshikoSettingsTabProps {
  dict: Dictionary['nadeshiko'];
}

type QuotaState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'ready'; data: NadeshikoUserMe }
  | { status: 'error'; kind: NadeshikoError['kind'] };

function announceKeyChanged(): void {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent('entei:nadeshiko-key-changed'));
}

export function NadeshikoSettingsTab({ dict }: NadeshikoSettingsTabProps) {
  const [savedKey, setSavedKey] = useState<string | null>(() =>
    readNadeshikoApiKey(),
  );
  // `draft` is the input's value. It is initialised from localStorage so the
  // field is populated when the dialog re-mounts (e.g. the user closes and
  // re-opens Settings, or visits the page later with a saved key), and a
  // listener below re-syncs it from the same source when key-changed /
  // storage events fire elsewhere. We only re-sync when the input is not
  // focused so we don't clobber the user mid-typing.
  const [draft, setDraft] = useState<string>(() => readNadeshikoApiKey() ?? '');
  const [showKey, setShowKey] = useState(false);
  const [quota, setQuota] = useState<QuotaState>({ status: 'idle' });
  const inputRef = useRef<HTMLInputElement | null>(null);
  // Track which key value the input already shows so the listener below
  // doesn't trigger a redundant setState when nothing changed.
  const lastSyncedDraftRef = useRef<string | null>(readNadeshikoApiKey());

  // Debounced view of savedKey used as the dependency for the quota fetch.
  // localStorage persistence (jimaku-style) still happens per keystroke; only
  // the network call is gated so that a 40-char paste doesn't fire ~40 GETs
  // against the 300 req / 60s quota. A null cleared key skips the timer and
  // returns to idle immediately.
  const [debouncedSavedKey, setDebouncedSavedKey] = useState<string | null>(
    savedKey,
  );
  const debounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (debounceTimerRef.current !== null) {
      clearTimeout(debounceTimerRef.current);
      debounceTimerRef.current = null;
    }
    if (savedKey === null) {
      setDebouncedSavedKey(null);
      return;
    }
    debounceTimerRef.current = setTimeout(() => {
      setDebouncedSavedKey(savedKey);
      debounceTimerRef.current = null;
    }, 500);
    return () => {
      if (debounceTimerRef.current !== null) {
        clearTimeout(debounceTimerRef.current);
        debounceTimerRef.current = null;
      }
    };
  }, [savedKey]);

  // Re-sync `draft` when the saved key changes from elsewhere (the panel's
  // inline form, a different tab via `storage`, or programmatic writes).
  // Skip the sync when the input has focus so we don't blow away the user's
  // in-progress typing — that case is re-synced on blur via
  // `syncFromStorageRef`. Keeping the function reachable via a ref means we
  // don't have to re-bind the listeners every render.
  const syncFromStorageRef = useRef<() => void>(() => {});
  useEffect(() => {
    const syncFromStorage = () => {
      const current = readNadeshikoApiKey();
      if (current === lastSyncedDraftRef.current) return;
      if (
        inputRef.current &&
        typeof document !== 'undefined' &&
        document.activeElement === inputRef.current
      ) {
        // User is editing — leave the draft alone; the local `savedKey`
        // will still pick up the new value for the quota refresh path.
        // The onBlur handler re-runs this sync once focus leaves so the
        // input catches up with whatever external change fired the event.
        lastSyncedDraftRef.current = current;
        return;
      }
      setDraft(current ?? '');
      lastSyncedDraftRef.current = current;
    };
    syncFromStorageRef.current = syncFromStorage;
    window.addEventListener('entei:nadeshiko-key-changed', syncFromStorage);
    window.addEventListener('storage', syncFromStorage);
    return () => {
      window.removeEventListener('entei:nadeshiko-key-changed', syncFromStorage);
      window.removeEventListener('storage', syncFromStorage);
    };
  }, []);

  // Refresh quota whenever the debounced (stable) saved key changes.
  // The debounce above collapses per-keystroke churn into a single fetch
  // once the user has paused typing for ~500ms.
  useEffect(() => {
    if (!debouncedSavedKey) {
      setQuota({ status: 'idle' });
      return;
    }
    const ac = new AbortController();
    setQuota({ status: 'loading' });
    getNadeshikoUserMe(debouncedSavedKey, ac.signal)
      .then((data) => setQuota({ status: 'ready', data }))
      .catch((raw: unknown) => {
        if (ac.signal.aborted) return;
        const err = raw as NadeshikoError;
        setQuota({
          status: 'error',
          kind: err?.kind ?? 'generic',
        });
      });
    return () => ac.abort();
  }, [debouncedSavedKey]);

  // Auto-save on every keystroke (jimaku-style): the draft IS the live
  // value. Clearing the field wipes storage too. The Eraser button is
  // a shortcut for the same wipe.
  const handleDraftChange = useCallback((value: string) => {
    setDraft(value);
    const trimmed = value.trim();
    if (trimmed.length === 0) {
      clearNadeshikoApiKey();
      setSavedKey(null);
      setQuota({ status: 'idle' });
    } else if (writeNadeshikoApiKey(trimmed)) {
      setSavedKey(readNadeshikoApiKey());
    }
    lastSyncedDraftRef.current = readNadeshikoApiKey();
    announceKeyChanged();
  }, []);

  const handleClear = useCallback(() => {
    clearNadeshikoApiKey();
    setSavedKey(null);
    setDraft('');
    setQuota({ status: 'idle' });
    lastSyncedDraftRef.current = null;
    announceKeyChanged();
  }, []);

  const quotaErrorLabel = (kind: NadeshikoError['kind']): string => {
    switch (kind) {
      case 'invalid-key':
        return dict.quotaErrorInvalidKey;
      case 'rate-limited':
        return dict.quotaErrorRateLimited;
      case 'quota-exceeded':
        return dict.quotaErrorQuotaExceeded;
      case 'network':
        return dict.quotaErrorNetwork;
      default:
        return dict.quotaErrorGeneric;
    }
  };

  return (
    <div className="entei-settings-section">
      <h3 className="entei-settings-label">{dict.heading}</h3>
      <p className="entei-settings-hint">{dict.description}</p>

      <div className="entei-settings-key-row">
        <div className="entei-settings-row-label" id="nadeshiko-api-key-label">
          {dict.apiKeyLabel}
        </div>
      </div>
      <ButtonGroup className="entei-nadeshiko-form-group">
        <Input
          id="nadeshiko-api-key"
          ref={inputRef}
          aria-labelledby="nadeshiko-api-key-label"
          type={showKey ? 'text' : 'password'}
          value={draft}
          onChange={(e) => handleDraftChange(e.target.value)}
          onBlur={() => syncFromStorageRef.current()}
          placeholder={dict.apiKeyPlaceholder}
          autoComplete="off"
          spellCheck={false}
        />
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="entei-nadeshiko-search-btn"
          onClick={() => setShowKey((v) => !v)}
          aria-label={showKey ? dict.apiKeyHide : dict.apiKeyShow}
          title={showKey ? dict.apiKeyHide : dict.apiKeyShow}
        >
          {showKey ? (
            <EyeOff size={16} aria-hidden="true" />
          ) : (
            <Eye size={16} aria-hidden="true" />
          )}
        </Button>
        {savedKey && (
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="entei-nadeshiko-search-btn"
            onClick={handleClear}
            aria-label={dict.apiKeyClear}
            title={dict.apiKeyClear}
          >
            <Eraser size={16} aria-hidden="true" />
          </Button>
        )}
      </ButtonGroup>

      <div className="entei-settings-section">
        <h4 className="entei-settings-label">{dict.quotaHeading}</h4>
        {quota.status === 'loading' && (
          <p>
            <TypewriterLoading
              text="…"
              aria-hidden="true"
              className="entei-typewriter--inline"
            />
            <span className="sr-only">{dict.quotaLoading}</span>
          </p>
        )}
        {quota.status === 'ready' && (
          <dl className="entei-settings-grid">
            {typeof quota.data.remaining === 'number' && (
              <div>
                <dt>{dict.quotaRemaining}</dt>
                <dd>{quota.data.remaining}</dd>
              </div>
            )}
            {typeof quota.data.monthlyLimit === 'number' && (
              <div>
                <dt>{dict.quotaLimit}</dt>
                <dd>{quota.data.monthlyLimit}</dd>
              </div>
            )}
            {quota.data.periodEnd && (
              <div>
                <dt>{dict.quotaReset}</dt>
                <dd>{quota.data.periodEnd}</dd>
              </div>
            )}
            {typeof quota.data.remaining !== 'number' &&
              typeof quota.data.monthlyLimit !== 'number' &&
              !quota.data.periodEnd && <p>{dict.quotaUnknown}</p>}
          </dl>
        )}
        {quota.status === 'error' && (
          <p role="alert">{quotaErrorLabel(quota.kind)}</p>
        )}
      </div>
    </div>
  );
}
