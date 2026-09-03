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

import { useState, useEffect, useCallback } from 'react';
import { Eye, EyeOff, KeyRound } from 'lucide-react';
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
  const [draft, setDraft] = useState('');
  const [showKey, setShowKey] = useState(false);
  const [savedFlash, setSavedFlash] = useState(false);
  const [quota, setQuota] = useState<QuotaState>({ status: 'idle' });

  // Refresh quota whenever the saved key changes.
  useEffect(() => {
    if (!savedKey) {
      setQuota({ status: 'idle' });
      return;
    }
    const ac = new AbortController();
    setQuota({ status: 'loading' });
    getNadeshikoUserMe(savedKey, ac.signal)
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
  }, [savedKey]);

  const handleSave = useCallback(() => {
    if (writeNadeshikoApiKey(draft)) {
      setSavedKey(readNadeshikoApiKey());
      setDraft('');
      setSavedFlash(true);
      announceKeyChanged();
      window.setTimeout(() => setSavedFlash(false), 1500);
    }
  }, [draft]);

  const handleClear = useCallback(() => {
    clearNadeshikoApiKey();
    setSavedKey(null);
    setDraft('');
    setQuota({ status: 'idle' });
    announceKeyChanged();
  }, []);

  const quotaErrorLabel = (kind: NadeshikoError['kind']): string => {
    switch (kind) {
      case 'invalid-key':
        return dict.quotaErrorInvalidKey;
      case 'rate-limited':
        return dict.quotaErrorRateLimited;
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

      {savedKey && (
        <p className="entei-settings-hint" data-testid="nadeshiko-key-present">
          {savedFlash ? dict.apiKeySaved : '••••••••'}
        </p>
      )}

      <form
        className="entei-nadeshiko-key-form"
        onSubmit={(e) => {
          e.preventDefault();
          handleSave();
        }}
      >
        <div className="entei-settings-row-label" id="nadeshiko-api-key-label">
          {dict.apiKeyLabel}
        </div>
        <ButtonGroup className="entei-nadeshiko-form-group">
          <Input
            id="nadeshiko-api-key"
            aria-labelledby="nadeshiko-api-key-label"
            type={showKey ? 'text' : 'password'}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
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
          <Button
            type="submit"
            variant="outline"
            size="sm"
            className="entei-nadeshiko-search-btn"
            disabled={draft.trim().length === 0}
            aria-label={dict.apiKeySave}
            title={dict.apiKeySave}
          >
            <KeyRound size={16} aria-hidden="true" />
          </Button>
        </ButtonGroup>
      </form>

      {savedKey && (
        <Button type="button" variant="ghost" size="sm" onClick={handleClear}>
          {dict.apiKeyClear}
        </Button>
      )}

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
            {typeof quota.data.remainingRequests === 'number' && (
              <div>
                <dt>{dict.quotaRemaining}</dt>
                <dd>{quota.data.remainingRequests}</dd>
              </div>
            )}
            {typeof quota.data.monthlyLimit === 'number' && (
              <div>
                <dt>{dict.quotaLimit}</dt>
                <dd>{quota.data.monthlyLimit}</dd>
              </div>
            )}
            {quota.data.resetAt && (
              <div>
                <dt>{dict.quotaReset}</dt>
                <dd>{quota.data.resetAt}</dd>
              </div>
            )}
            {typeof quota.data.remainingRequests !== 'number' &&
              typeof quota.data.monthlyLimit !== 'number' &&
              !quota.data.resetAt && <p>{dict.quotaUnknown}</p>}
          </dl>
        )}
        {quota.status === 'error' && (
          <p role="alert">{quotaErrorLabel(quota.kind)}</p>
        )}
      </div>
    </div>
  );
}
