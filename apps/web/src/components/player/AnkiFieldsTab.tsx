/**
 * AnkiFieldsTab — AnkiConnect read-only setup + field mapping (AM-5)
 * ---------------------------------------------------------------------------
 * - Default endpoint `http://127.0.0.1:8765`
 * - Auto-connect on mount; continuous retry every 10s on failure until connected/unmount
 * - API key field shown proactively when requestPermission signals requireApiKey
 *   or when a request returns api-key-required
 * - API key type=password; session-only; cleared when modal closes
 * - After connection: deck + note type selects
 * - After note type selection: field mapping selects
 * - Selections auto-save as soon as the preset is valid (deck, note type,
 *   sentence field); intermediate states are never persisted, and the API
 *   key stays session-only.
 * - Rapid model-change race guarded by AbortController + epoch
 * --------------------------------------------------------------------------- */

'use client';

import { useState, useCallback, useRef, useEffect, useId } from 'react';
import {
  AnkiConnectClient,
  AnkiConnectError,
  runAnkiConnectionFlow,
  type AnkiConnectionState,
} from '@/features/player/anki-connect';
import {
  readAnkiMinerPreferences,
  writeAnkiMinerPreferences,
  isValidPreset,
  type AnkiFieldMapping,
  type AnkiMinerPreferences,
} from '@/features/player/anki-miner-preferences';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/player/ui/select';
import { Plug, PlugZap } from 'lucide-react';
import type { Dictionary } from '@i18n/types';

/** Retry interval in milliseconds. */
const RETRY_INTERVAL_MS = 10_000;

/** Session credentials bridge to PlayerApp for export. */
export interface AnkiSessionCredentials {
  endpoint: string;
  apiKey: string;
}

/** Empty field mapping (sentence required; optional fields unmapped). */
const EMPTY_MAPPING: AnkiFieldMapping = {
  sentence: '',
  definition: null,
  image: null,
  audio: null,
  word: null,
  source: null,
  tags: null,
};

/** Drop mapping entries that do not exist on the note type's field list. */
function sanitizeMappingForModel(
  mapping: AnkiFieldMapping,
  modelFieldsList: string[],
): AnkiFieldMapping {
  const next: AnkiFieldMapping = { ...mapping };
  if (!modelFieldsList.includes(next.sentence)) next.sentence = '';
  const optionalKeys: (keyof Omit<AnkiFieldMapping, 'sentence'>)[] = [
    'definition',
    'image',
    'audio',
    'word',
    'source',
    'tags',
  ];
  for (const key of optionalKeys) {
    const v = next[key];
    if (v !== null && !modelFieldsList.includes(v)) next[key] = null;
  }
  return next;
}

interface AnkiFieldsTabProps {
  dict: Dictionary['playerUI'];
  onSessionCredentials?: (creds: AnkiSessionCredentials | null) => void;
}

/** Return a localized error string for a given connection state. */
function getLocalizedError(
  state: AnkiConnectionState,
  rawMessage: string | null,
  dict: Dictionary['playerUI'],
): string {
  if (state === 'unknown-error' && rawMessage) return rawMessage;
  switch (state) {
    case 'unavailable':
      return dict.ankiErrorUnavailable;
    case 'permission-denied':
      return dict.ankiErrorPermission;
    case 'api-key-required':
      return dict.ankiErrorApiKey;
    case 'cors-error':
      return dict.ankiErrorCors;
    case 'unknown-error':
      return dict.ankiErrorUnknown;
    default:
      return '';
  }
}

export function AnkiFieldsTab({
  dict,
  onSessionCredentials,
}: AnkiFieldsTabProps) {
  // --- Accessibility IDs ---
  const endpointLabelId = useId();
  const apiKeyLabelId = useId();
  const deckLabelId = useId();
  const noteTypeLabelId = useId();
  const fieldBaseId = useId();

  // --- Session state (never persisted) ---
  const [endpoint, setEndpoint] = useState('http://127.0.0.1:8765');
  const [apiKey, setApiKey] = useState('');
  const [showApiKeyInput, setShowApiKeyInput] = useState(false);

  // --- Connection state ---
  const [connectionState, setConnectionState] =
    useState<AnkiConnectionState>('idle');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [isConnecting, setIsConnecting] = useState(false);

  // --- Data from Anki ---
  const [decks, setDecks] = useState<string[]>([]);
  const [models, setModels] = useState<string[]>([]);
  const [modelFields, setModelFields] = useState<string[]>([]);

  // --- User selections ---
  const [selectedDeck, setSelectedDeck] = useState<string>('');
  const [selectedModel, setSelectedModel] = useState<string>('');
  const [fields, setFields] = useState<AnkiFieldMapping>({
    sentence: '',
    definition: null,
    image: null,
    audio: null,
    word: null,
    source: null,
    tags: null,
  });

  // --- Preferences-ready gate ---
  // Auto-connect and endpoint/API-key effects must not run until saved
  // preferences have been applied, so the first attempt uses the saved URL.
  const [prefsReady, setPrefsReady] = useState(false);

  // --- Abort controllers ---
  const connectAbortRef = useRef<AbortController | null>(null);
  const modelAbortRef = useRef<AbortController | null>(null);

  // --- Epoch for model-change race guard ---
  const modelEpochRef = useRef(0);
  // --- Authoritative latest-value refs for async save guards ---
  // State updates are async; these refs hold the current values so the
  // model fetch (and any concurrent deck/field change) never auto-saves
  // a stale combination (review P1/P2).
  const selectedDeckRef = useRef('');
  const selectedModelRef = useRef('');
  const endpointRef = useRef('http://127.0.0.1:8765');
  const fieldsRef = useRef<AnkiFieldMapping>({
    sentence: '', definition: null, image: null,
    audio: null, word: null, source: null, tags: null,
  });
  /** Non-empty once the field list has been fetched + sanitized for the
   *  model currently in selectedModelRef. Prevents field interactions
   *  during a pending model fetch from being persisted. */
  const resolvedModelRef = useRef('');

  // --- Retry timer ref (no overlapping timers) ---
  const retryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // --- Load saved preferences on mount ---
  useEffect(() => {
    const saved = readAnkiMinerPreferences();
    setEndpoint(saved.ankiConnectUrl);
    endpointRef.current = saved.ankiConnectUrl;
    if (saved.deck) setSelectedDeck(saved.deck);
    selectedDeckRef.current = saved.deck ?? '';
    if (saved.noteType) setSelectedModel(saved.noteType);
    selectedModelRef.current = saved.noteType ?? '';
    setFields({ ...saved.fields });
    fieldsRef.current = { ...saved.fields };
    // restoredModelGate: the saved preset is restored as-is; do NOT mark
    // it resolved here — the connect-time modelFieldNames reload decides.
    resolvedModelRef.current = '';
    setPrefsReady(true);
  }, []);

  // --- Cleanup: abort in-flight requests + clear retry timer on unmount ---
  useEffect(() => {
    return () => {
      connectAbortRef.current?.abort();
      modelAbortRef.current?.abort();
      if (retryTimerRef.current !== null) {
        clearTimeout(retryTimerRef.current);
        retryTimerRef.current = null;
      }
    };
  }, []);

  // --- Core connection flow (shared by auto-connect and retry) ---
  const attemptConnect = useCallback(async () => {
    connectAbortRef.current?.abort();
    const controller = new AbortController();
    connectAbortRef.current = controller;

    setIsConnecting(true);
    setConnectionState('connecting');
    setErrorMessage(null);
    // W14: Do NOT clear showApiKeyInput here — it must persist across
    // automated retries so the user can enter/correct the key.

    const client = new AnkiConnectClient(endpoint, apiKey || undefined);

    try {
      const result = await runAnkiConnectionFlow(client, controller.signal);

      if (controller.signal.aborted) return;

      setDecks(result.decks);
      setModels(result.models);
      setConnectionState('connected');

      // Stage 2: Export session credentials to PlayerApp
      onSessionCredentials?.({ endpoint, apiKey });

      if (result.requireApiKey) {
        setShowApiKeyInput(true);
      }

      // Reload the saved model's field list so a restored preset is
      // usable without auto-writing anything: sanitize + sync refs, and
      // only mark resolved when it matches the CURRENT model ref.
      const savedModel = selectedModelRef.current;
      if (savedModel && result.models.includes(savedModel)) {
        const fieldCtrl = new AbortController();
        modelAbortRef.current = fieldCtrl;
        const fieldsResult = await client.modelFieldNames(
          savedModel,
          fieldCtrl.signal,
        );
        if (!fieldCtrl.signal.aborted && !controller.signal.aborted) {
          setModelFields(fieldsResult);
          if (selectedModelRef.current === savedModel) {
            const next = sanitizeMappingForModel(
              fieldsRef.current,
              fieldsResult,
            );
            fieldsRef.current = next;
            setFields(next);
            resolvedModelRef.current = savedModel;
          }
        }
      }
    } catch (e) {
      if (controller.signal.aborted) return;

      let state: AnkiConnectionState;
      let message: string;
      if (e instanceof AnkiConnectError) {
        state = e.state;
        message = e.message;
        if (e.state === 'api-key-required') {
          setShowApiKeyInput(true);
        }
      } else {
        state = 'unknown-error';
        message = e instanceof Error ? e.message : String(e);
      }
      setConnectionState(state);
      setErrorMessage(message);
      // Clear session credentials on connection failure
      onSessionCredentials?.(null);
    } finally {
      if (!controller.signal.aborted) {
        setIsConnecting(false);
      }
    }
  }, [endpoint, apiKey, selectedModel, onSessionCredentials]);

  // --- Schedule continuous retry in 10s (no overlap) ---
  const scheduleRetry = useCallback(() => {
    if (retryTimerRef.current !== null) {
      clearTimeout(retryTimerRef.current);
    }
    retryTimerRef.current = setTimeout(() => {
      retryTimerRef.current = null;
      attemptConnect();
    }, RETRY_INTERVAL_MS);
  }, [attemptConnect]);

  // --- Auto-connect after preferences are loaded ---
  useEffect(() => {
    if (!prefsReady) return;
    attemptConnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- run once after prefsReady
  }, [prefsReady]);

  // --- Schedule continuous retry after any non-abort failure ---
  useEffect(() => {
    const isError =
      connectionState !== 'idle' &&
      connectionState !== 'connecting' &&
      connectionState !== 'connected';

    if (isError) {
      scheduleRetry();
    }

    return () => {
      if (retryTimerRef.current !== null) {
        clearTimeout(retryTimerRef.current);
        retryTimerRef.current = null;
      }
    };
  }, [connectionState, scheduleRetry]);

  // --- Reconnect immediately when endpoint changes ---
  // Always aborts in-flight request and starts fresh with the new endpoint.
  // prevEndpointRef + prefsReady gate prevent false positive from initial prefs load.
  const prevEndpointRef = useRef(endpoint);
  useEffect(() => {
    if (!prefsReady) return;
    if (prevEndpointRef.current !== endpoint) {
      prevEndpointRef.current = endpoint;
      // Clear any pending retry and attempt immediately
      if (retryTimerRef.current !== null) {
        clearTimeout(retryTimerRef.current);
        retryTimerRef.current = null;
      }
      attemptConnect();
    }
  }, [prefsReady, endpoint, attemptConnect]);

  // --- Reconnect immediately when API key changes ---
  // Same logic: always restart with the new key.
  const prevApiKeyRef = useRef(apiKey);
  useEffect(() => {
    if (!prefsReady) return;
    if (prevApiKeyRef.current !== apiKey) {
      prevApiKeyRef.current = apiKey;
      if (retryTimerRef.current !== null) {
        clearTimeout(retryTimerRef.current);
        retryTimerRef.current = null;
      }
      attemptConnect();
    }
  }, [prefsReady, apiKey, attemptConnect]);

  // --- Auto-save: persist only complete presets ---
  // Triggered by deck / note type / field mapping selection. Writes the
  // snapshot with the CURRENT endpoint; intermediate presets are never
  // persisted (isValidPreset gate), and the API key is never included.
  // Reads the AUTHORITATIVE refs internally (endpoint/deck/model/fields),
  // so callers never pass stale closure values (review P1/P2).
  const saveValidPreset = useCallback(() => {
    // A model switch is in flight: the new note type's field list has
    // not been fetched + sanitized yet, so suppress EVERY auto-save
    // (deck changes included) until it resolves (review P1/P2).
    if (resolvedModelRef.current !== selectedModelRef.current) return;
    const current = readAnkiMinerPreferences();
    const prefs: AnkiMinerPreferences = {
      presetName: 'Default',
      ankiConnectUrl: endpointRef.current,
      deck: selectedDeckRef.current || null,
      noteType: selectedModelRef.current || null,
      fields: { ...fieldsRef.current },
      exportMode: current.exportMode,
      mediaMode: current.mediaMode,
    };
    if (!isValidPreset(prefs)) return;
    writeAnkiMinerPreferences(prefs);
  }, []);

  // --- Handle note type change ---
  const handleModelChange = useCallback(
    async (modelName: string) => {
      setSelectedModel(modelName);
      selectedModelRef.current = modelName;
      // Field list for the new model is not yet verified/sanitized: no
      // field interaction may be persisted until it resolves.
      resolvedModelRef.current = '';
      // Cancel any in-flight modelFieldNames request
      modelAbortRef.current?.abort();
      const controller = new AbortController();
      modelAbortRef.current = controller;

      // Increment epoch; stale responses are dropped
      const epoch = ++modelEpochRef.current;

      const client = new AnkiConnectClient(endpoint, apiKey || undefined);
      try {
        const newFields = await client.modelFieldNames(
          modelName,
          controller.signal,
        );

        // Race guard: drop if a newer model was selected
        if (epoch !== modelEpochRef.current) return;
        if (controller.signal.aborted) return;

        setModelFields(newFields);

        // Sanitize against the new field list, then auto-save the next
        // snapshot ONLY when the epoch/abort checks above passed and the
        // sanitized preset is valid — a stale model response never saves.
        const next = sanitizeMappingForModel(fieldsRef.current, newFields);
        fieldsRef.current = next;
        setFields(next);
        resolvedModelRef.current = modelName;
        saveValidPreset();
      } catch {
        if (epoch !== modelEpochRef.current) return;
        if (controller.signal.aborted) return;
        setModelFields([]);
        fieldsRef.current = { ...EMPTY_MAPPING };
        setFields({ ...EMPTY_MAPPING });
        resolvedModelRef.current = '';
      }
    },
    [endpoint, apiKey, saveValidPreset],
  );

  // --- Handle field mapping change ---
  const handleFieldChange = useCallback(
    (key: keyof AnkiFieldMapping, value: string) => {
      // Model switch in progress: the old field list must not be treated
      // as the new model's mapping (review P1/P2 — "F" hole).
      if (resolvedModelRef.current !== selectedModelRef.current) return;
      const resolved = value === '' ? null : value;
      // Build the next snapshot from the latest ref (do not wait for the
      // state update), sync ref+state, then auto-save when valid.
      const next: AnkiFieldMapping = {
        ...fieldsRef.current,
        [key]: resolved,
      };
      fieldsRef.current = next;
      setFields(next);
      saveValidPreset();
    },
    [saveValidPreset],
  );

  // --- Determine error display text ---
  const errorDisplay = getLocalizedError(connectionState, errorMessage, dict);

  // --- Is there a non-connected error state? ---
  const isError =
    connectionState !== 'idle' &&
    connectionState !== 'connecting' &&
    connectionState !== 'connected';

  // --- Determine status badge text ---
  const statusBadgeText =
    connectionState === 'connected'
      ? dict.ankiStatusConnected
      : connectionState === 'connecting'
        ? dict.ankiConnecting
        : isError
          ? dict.ankiStatusRetrying
          : '';

  // --- Field mapping rows ---
  const fieldRows: {
    key: keyof AnkiFieldMapping;
    label: string;
    required: boolean;
  }[] = [
    { key: 'sentence', label: dict.ankiFieldSentence, required: true },
    { key: 'definition', label: dict.ankiFieldDefinition, required: false },
    { key: 'image', label: dict.ankiFieldImage, required: false },
    { key: 'audio', label: dict.ankiFieldAudio, required: false },
    { key: 'word', label: dict.ankiFieldWord, required: false },
    { key: 'source', label: dict.ankiFieldSource, required: false },
    { key: 'tags', label: dict.ankiFieldTags, required: false },
  ];

  return (
    <div className="entei-anki-fields-tab">
      {/* Connection section: heading + endpoint + status badge */}
      <div className="entei-anki-section">
        <h3 className="entei-anki-heading">{dict.ankiConnect}</h3>
        <p className="entei-anki-desc">{dict.ankiConnectDesc}</p>

        <div className="entei-anki-connect-row">
          <div className="entei-anki-section">
            <label
              id={endpointLabelId}
              className="entei-anki-label"
              htmlFor="anki-endpoint"
            >
              {dict.ankiEndpointLabel}
            </label>
            <input
              id="anki-endpoint"
              type="text"
              className="entei-anki-input"
              value={endpoint}
              onChange={(e) => {
                endpointRef.current = e.target.value;
                setEndpoint(e.target.value);
              }}
              disabled={isConnecting}
              autoComplete="off"
            />
          </div>

          {/* Status badge (non-clickable, accessible) */}
          <div className="entei-anki-status-badge" aria-live="polite">
            {connectionState === 'connected' ? (
              <Plug
                size={18}
                className="entei-anki-status-icon entei-anki-status-icon--connected"
                aria-hidden="true"
              />
            ) : (
              <PlugZap
                size={18}
                className="entei-anki-status-icon entei-anki-status-icon--disconnected"
                aria-hidden="true"
              />
            )}
            <span
              className={`entei-anki-status-text${connectionState === 'connected' ? ' entei-anki-status-text--connected' : ' entei-anki-status-text--disconnected'}`}
            >
              {statusBadgeText}
            </span>
          </div>
        </div>
      </div>

      {/* API key (shown proactively when required) */}
      {showApiKeyInput && (
        <div className="entei-anki-section">
          <label
            id={apiKeyLabelId}
            className="entei-anki-label"
            htmlFor="anki-api-key"
          >
            {dict.ankiApiKeyLabel}
          </label>
          <input
            id="anki-api-key"
            type="password"
            className="entei-anki-input"
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            placeholder={dict.ankiApiKeyPlaceholder}
            disabled={isConnecting}
            autoComplete="off"
          />
        </div>
      )}

      {/* Error surface (visible only while not connected) */}
      {isError && (
        <div className="entei-anki-error" role="alert">
          <p>{errorDisplay}</p>
          <p className="entei-anki-error-cors">{dict.ankiErrorCorsHint}</p>
        </div>
      )}

      {/* Deck + Note Type + Field Mapping (only when connected) */}
      {connectionState === 'connected' && (
        <div className="entei-anki-mapping">
          {/* Deck and Note Type */}
          <div className="entei-anki-section">
            <label id={deckLabelId} className="entei-anki-label">
              {dict.ankiDeckLabel}
            </label>
            <Select
              value={selectedDeck}
              onValueChange={(v) => {
                selectedDeckRef.current = v;
                setSelectedDeck(v);
                saveValidPreset();
              }}
            >
              <SelectTrigger
                className="entei-anki-select-trigger"
                aria-labelledby={deckLabelId}
              >
                <SelectValue placeholder={dict.ankiDeckPlaceholder} />
              </SelectTrigger>
              <SelectContent className="entei-anki-select-content">
                {decks.length === 0 && (
                  <SelectItem value="__none__" disabled>
                    {dict.ankiNoDecks}
                  </SelectItem>
                )}
                {decks.map((d) => (
                  <SelectItem key={d} value={d}>
                    {d}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="entei-anki-section">
            <label id={noteTypeLabelId} className="entei-anki-label">
              {dict.ankiNoteTypeLabel}
            </label>
            <Select value={selectedModel} onValueChange={handleModelChange}>
              <SelectTrigger
                className="entei-anki-select-trigger"
                aria-labelledby={noteTypeLabelId}
              >
                <SelectValue placeholder={dict.ankiNoteTypePlaceholder} />
              </SelectTrigger>
              <SelectContent className="entei-anki-select-content">
                {models.length === 0 && (
                  <SelectItem value="__none__" disabled>
                    {dict.ankiNoNoteTypes}
                  </SelectItem>
                )}
                {models.map((m) => (
                  <SelectItem key={m} value={m}>
                    {m}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {/* Field mapping grid */}
          {selectedModel && (
            <>
              {modelFields.length === 0 ? (
                <p className="entei-anki-status">{dict.ankiNoFields}</p>
              ) : (
                <>
                  <div className="entei-anki-mapping-header">
                    <h4 className="entei-anki-mapping-title">
                      {dict.ankiSelectNoteTypeFirst}
                    </h4>
                  </div>
                  <div className="entei-anki-mapping-grid">
                    {fieldRows.map((row) => {
                      const triggerId = `${fieldBaseId}-${row.key}`;
                      return (
                        <div key={row.key} className="entei-anki-field-row">
                          <label
                            id={triggerId}
                            className="entei-anki-field-label"
                          >
                            {row.label}
                            <span
                              className={`entei-anki-field-badge${row.required ? ' entei-anki-field-badge--required' : ''}`}
                            >
                              {row.required
                                ? dict.ankiFieldRequired
                                : dict.ankiFieldOptional}
                            </span>
                          </label>
                          <Select
                            value={fields[row.key] ?? '__none__'}
                            onValueChange={(v) =>
                              handleFieldChange(
                                row.key,
                                v === '__none__' ? '' : v,
                              )
                            }
                          >
                            <SelectTrigger
                              className="entei-anki-select-trigger"
                              aria-labelledby={triggerId}
                            >
                              <SelectValue placeholder="—" />
                            </SelectTrigger>
                            <SelectContent className="entei-anki-select-content">
                              <SelectItem value="__none__">—</SelectItem>
                              {modelFields.map((f) => (
                                <SelectItem key={f} value={f}>
                                  {f}
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        </div>
                      );
                    })}
                  </div>
                </>
              )}
            </>
          )}

        </div>
      )}
    </div>
  );
}
