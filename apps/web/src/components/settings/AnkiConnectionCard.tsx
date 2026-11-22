/**
 * AnkiConnectionCard — /settings/ Anki page, "Anki Connection" card.
 * ---------------------------------------------------------------------------
 * Faithful to the hand-drawn spec:
 *   Header : Lucide RadioTower + "Anki Connection"
 *   Row 1  : URL AnkiConnect Server — description is a LIVE connection status
 *            (Connected = green oklch(65% 0.17 145deg) + Lucide Radio /
 *             Disconnected = red oklch(60% 0.22 25deg) + Lucide RadioOff),
 *            control = text input (default http://127.0.0.1:8765).
 *   Row 2  : API Key — password-masked input, placeholder "Leave empty if no key".
 *   Row 3  : Idle download timeout (in ms) — number input, default 0.
 *   Row 4  : Force Anki sync on adding card — Switch.
 *
 * Rows 2-4 reuse the platform's STANDARD settings row (ModuleFieldRow) so they
 * align (15rem right-hand control column) with every other settings card.
 *
 * Connection health: AnkiConnectClient.version() on mount, on every
 * server/apiKey change (debounced), and every 15s while open. A successful
 * version() = connected; a throw = disconnected.
 *
 * Persistence: every change writes through anki-connection-preferences
 * (localStorage + desktop SQLite via the settings-store mirror) the moment it
 * happens — no Save button.
 * ---------------------------------------------------------------------------
 */

'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { Radio, RadioOff, RadioTower } from 'lucide-react';
import { ModuleFieldRow } from '@/components/settings/ModuleFieldRow';
import { Input } from '@/components/player/ui/input';
import { Switch } from '@/components/player/ui/switch';
import { AnkiConnectClient } from '@/features/player/anki-connect';
import {
  DEFAULT_ANKI_CONNECTION_PREFERENCES,
  DEFAULT_ANKI_SERVER,
  readAnkiConnectionPreferences,
  updateAnkiConnectionPreferences,
} from '@/features/player/anki-connection-preferences';
import type { Dictionary } from '@i18n/types';

/** Re-poll the connection while the card is open. */
const CONNECTION_POLL_MS = 15_000;
/** Debounce so typing a new URL doesn't fire a request per keystroke. */
const CONNECTION_DEBOUNCE_MS = 400;

/** Status line colors (hand-drawn spec, OKLCH per the Entei color contract). */
const STATUS_CONNECTED_COLOR = 'oklch(65% 0.17 145deg)';
const STATUS_DISCONNECTED_COLOR = 'oklch(60% 0.22 25deg)';

interface AnkiConnectionCardProps {
  dict: Dictionary['ankiConnection'];
  /** Copy for a row type this layout cannot edit (unused here; required by
      the shared ModuleFieldRow). Reuses the Yomitan settings' existing string. */
  notEditable: string;
}

export function AnkiConnectionCard({ dict, notEditable }: AnkiConnectionCardProps) {
  const [server, setServer] = useState(DEFAULT_ANKI_SERVER);
  const [apiKey, setApiKey] = useState('');
  const [downloadTimeout, setDownloadTimeout] = useState(
    DEFAULT_ANKI_CONNECTION_PREFERENCES.downloadTimeout,
  );
  const [forceSync, setForceSync] = useState(
    DEFAULT_ANKI_CONNECTION_PREFERENCES.forceSync,
  );
  /** Binary live status (spec: Connected / Disconnected only). */
  const [connected, setConnected] = useState(false);

  const abortRef = useRef<AbortController | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  /* Seed from the persisted preferences on mount. */
  useEffect(() => {
    const saved = readAnkiConnectionPreferences();
    setServer(saved.server || DEFAULT_ANKI_SERVER);
    setApiKey(saved.apiKey);
    setDownloadTimeout(saved.downloadTimeout);
    setForceSync(saved.forceSync);
  }, []);

  /* One health check (version = reachability probe). */
  const check = useCallback(
    async (serverUrl: string, key: string) => {
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;
      try {
        const client = new AnkiConnectClient(serverUrl, key || undefined);
        await client.version(controller.signal);
        if (!controller.signal.aborted) setConnected(true);
      } catch {
        if (!controller.signal.aborted) setConnected(false);
      }
    },
    [],
  );

  /* Live status: on mount, on server/apiKey change (debounced), and poll. */
  useEffect(() => {
    if (debounceRef.current !== null) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      debounceRef.current = null;
      void check(server, apiKey);
    }, CONNECTION_DEBOUNCE_MS);
    if (pollRef.current !== null) clearInterval(pollRef.current);
    pollRef.current = setInterval(() => {
      void check(server, apiKey);
    }, CONNECTION_POLL_MS);
    return () => {
      if (debounceRef.current !== null) {
        clearTimeout(debounceRef.current);
        debounceRef.current = null;
      }
      if (pollRef.current !== null) {
        clearInterval(pollRef.current);
        pollRef.current = null;
      }
    };
  }, [check, server, apiKey]);

  /* Abort any in-flight probe on unmount. */
  useEffect(
    () => () => {
      abortRef.current?.abort();
    },
    [],
  );

  const handleServerChange = (value: string) => {
    setServer(value);
    updateAnkiConnectionPreferences({ server: value });
  };
  const handleApiKeyChange = (value: string) => {
    setApiKey(value);
    updateAnkiConnectionPreferences({ apiKey: value });
  };
  const handleTimeoutChange = (value: number) => {
    setDownloadTimeout(value);
    updateAnkiConnectionPreferences({ downloadTimeout: value });
  };
  const handleForceSyncChange = (value: boolean) => {
    setForceSync(value);
    updateAnkiConnectionPreferences({ forceSync: value });
  };

  const statusText = connected ? dict.statusConnected : dict.statusDisconnected;
  const statusColor = connected
    ? STATUS_CONNECTED_COLOR
    : STATUS_DISCONNECTED_COLOR;
  const StatusIcon = connected ? Radio : RadioOff;

  return (
    <section className="entei-settings-section-card entei-anki-connection-card">
      <h3 className="entei-settings-label">
        <RadioTower aria-hidden="true" />
        <span>{dict.title}</span>
      </h3>

      {/* Row 1 — server URL + live connection status */}
      <div className="entei-module-field">
        <div className="entei-module-field-text">
          <span className="entei-module-field-label">{dict.serverLabel}</span>
          <p
            className="entei-anki-connection-status"
            style={{ color: statusColor }}
            aria-label={dict.connectionStatusLabel}
            aria-live="polite"
          >
            <StatusIcon className="entei-anki-connection-status-icon" aria-hidden="true" />
            <span>{statusText}</span>
          </p>
        </div>
        <div className="entei-module-field-control">
          <Input
            type="text"
            className="entei-module-input"
            value={server}
            placeholder={dict.serverPlaceholder}
            autoComplete="off"
            spellCheck={false}
            aria-label={dict.serverLabel}
            onChange={(event) => handleServerChange(event.target.value)}
          />
        </div>
      </div>

      {/* Row 2 — API key */}
      <ModuleFieldRow
        field={{
          type: 'password',
          key: 'apiKey',
          label: dict.apiKeyLabel,
          placeholder: dict.apiKeyPlaceholder,
          default: '',
        }}
        label={dict.apiKeyLabel}
        description={dict.apiKeyDescription}
        value={apiKey}
        onChange={(value) => handleApiKeyChange(String(value))}
        notEditable={notEditable}
      />

      {/* Row 3 — idle download timeout (ms) */}
      <ModuleFieldRow
        field={{
          type: 'number',
          key: 'downloadTimeout',
          label: dict.downloadTimeoutLabel,
          min: 0,
          step: 1,
          default: 0,
        }}
        label={dict.downloadTimeoutLabel}
        description={dict.downloadTimeoutDescription}
        value={downloadTimeout}
        onChange={(value) => {
          const parsed = Number(value);
          if (!Number.isFinite(parsed) || parsed < 0) return;
          handleTimeoutChange(parsed);
        }}
        notEditable={notEditable}
      />

      {/* Row 4 — force Anki sync on adding card */}
      <div className="entei-module-field entei-module-field--switch entei-anki-connection-switch">
        <div className="entei-module-field-text">
          <span className="entei-module-field-label">{dict.forceSyncLabel}</span>
          <p className="entei-module-field-description">
            {dict.forceSyncDescription}
          </p>
        </div>
        <div className="entei-module-field-control">
          <Switch
            checked={forceSync}
            onCheckedChange={handleForceSyncChange}
            aria-label={dict.forceSyncLabel}
          />
        </div>
      </div>
    </section>
  );
}
