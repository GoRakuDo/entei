/**
 * NadeshikoSettingsTab — Settings UI for Nadeshiko API key.
 * ---------------------------------------------------------------------------
 * Design: docs/NADESHIKO_INTEGRATION.md §3.4.
 * - Password-style input with show/hide toggle (Lucide Eye / EyeOff).
 * - Auto-saves on every keystroke (jimaku-style) + Eraser shortcut clears.
 * - Dispatches 'entei:nadeshiko-key-changed' so NadeshikoPanel re-reads.
 * - Quota display was removed: GET /v1/user/me lacks ACAO and is CORS-blocked
 *   in the browser, so quota can only surface indirectly — NadeshikoPanel
 *   shows a banner when the API returns 429 + body code QUOTA_EXCEEDED.
 * ---------------------------------------------------------------------------
 */
'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import { Eye, EyeOff, Eraser } from 'lucide-react';
import { Button } from '@/components/player/ui/button';
import { ButtonGroup } from '@/components/player/ui/button-group';
import { Input } from '@/components/player/ui/input';
import {
  readNadeshikoApiKey,
  writeNadeshikoApiKey,
  clearNadeshikoApiKey,
} from '@/features/nadeshiko/api-key';
import type { Dictionary } from '@i18n/types';

interface NadeshikoSettingsTabProps {
  dict: Dictionary['nadeshiko'];
}

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
  const inputRef = useRef<HTMLInputElement | null>(null);
  // Track which key value the input already shows so the listener below
  // doesn't trigger a redundant setState when nothing changed.
  const lastSyncedDraftRef = useRef<string | null>(readNadeshikoApiKey());

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
        // User is editing — leave the draft alone. The onBlur handler
        // re-runs this sync once focus leaves so the input catches up with
        // whatever external change fired the event.
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

  // Auto-save on every keystroke (jimaku-style): the draft IS the live
  // value. Clearing the field wipes storage too. The Eraser button is
  // a shortcut for the same wipe.
  const handleDraftChange = useCallback((value: string) => {
    setDraft(value);
    const trimmed = value.trim();
    if (trimmed.length === 0) {
      clearNadeshikoApiKey();
      setSavedKey(null);
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
    lastSyncedDraftRef.current = null;
    announceKeyChanged();
  }, []);

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
    </div>
  );
}
