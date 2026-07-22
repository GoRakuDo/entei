/**
 * AnkiFieldsTab — AnkiConnect read-only setup + field mapping (AM-5)
 * ---------------------------------------------------------------------------
 * - Default endpoint `http://127.0.0.1:8765`
 * - Explicit Connect / Retry; no automatic connection on mount
 * - API key field shown proactively when requestPermission signals requireApiKey
 *   or when a request returns api-key-required
 * - API key type=password; session-only; cleared when modal closes
 * - After connection: deck + note type selects
 * - After note type selection: field mapping selects
 * - Save Default preset disabled unless deck, note type, sentence mapping valid
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
import { Button } from '@/components/player/ui/button';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/player/ui/select';
import type { Dictionary } from '@i18n/types';

interface AnkiFieldsTabProps {
  dict: Dictionary['playerUI'];
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

export function AnkiFieldsTab({ dict }: AnkiFieldsTabProps) {
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

  // --- Preset state ---
  const [presetSaved, setPresetSaved] = useState(false);

  // --- Abort controllers ---
  const connectAbortRef = useRef<AbortController | null>(null);
  const modelAbortRef = useRef<AbortController | null>(null);

  // --- Epoch for model-change race guard ---
  const modelEpochRef = useRef(0);

  // --- Load saved preferences on mount ---
  useEffect(() => {
    const saved = readAnkiMinerPreferences();
    setEndpoint(saved.ankiConnectUrl);
    if (saved.deck) setSelectedDeck(saved.deck);
    if (saved.noteType) setSelectedModel(saved.noteType);
    setFields({ ...saved.fields });
    if (isValidPreset(saved)) {
      setPresetSaved(true);
    }
  }, []);

  // --- Cleanup abort controllers on unmount ---
  useEffect(() => {
    return () => {
      connectAbortRef.current?.abort();
      modelAbortRef.current?.abort();
    };
  }, []);

  // --- Connect / Retry handler ---
  const handleConnect = useCallback(async () => {
    connectAbortRef.current?.abort();
    const controller = new AbortController();
    connectAbortRef.current = controller;

    setIsConnecting(true);
    setConnectionState('connecting');
    setErrorMessage(null);
    setPresetSaved(false);
    setShowApiKeyInput(false);

    const client = new AnkiConnectClient(endpoint, apiKey || undefined);

    try {
      const result = await runAnkiConnectionFlow(client, controller.signal);

      if (controller.signal.aborted) return;

      setDecks(result.decks);
      setModels(result.models);
      setConnectionState('connected');

      if (result.requireApiKey) {
        setShowApiKeyInput(true);
      }

      // If we have a saved model selection that still exists, reload its fields
      if (selectedModel && result.models.includes(selectedModel)) {
        const fieldCtrl = new AbortController();
        modelAbortRef.current = fieldCtrl;
        const fieldsResult = await client.modelFieldNames(
          selectedModel,
          fieldCtrl.signal,
        );
        if (!fieldCtrl.signal.aborted && !controller.signal.aborted) {
          setModelFields(fieldsResult);
        }
      }
    } catch (e) {
      if (controller.signal.aborted) return;

      if (e instanceof AnkiConnectError) {
        setConnectionState(e.state);
        setErrorMessage(e.message);
        if (e.state === 'api-key-required') {
          setShowApiKeyInput(true);
        }
      } else {
        setConnectionState('unknown-error');
        setErrorMessage(e instanceof Error ? e.message : String(e));
      }
    } finally {
      if (!controller.signal.aborted) {
        setIsConnecting(false);
      }
    }
  }, [endpoint, apiKey, selectedModel]);

  // --- Handle note type change ---
  const handleModelChange = useCallback(
    async (modelName: string) => {
      setSelectedModel(modelName);
      setPresetSaved(false);

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

        setFields((prev) => {
          const next: AnkiFieldMapping = { ...prev };
          if (!newFields.includes(next.sentence)) {
            next.sentence = '';
          }
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
            if (v !== null && !newFields.includes(v)) {
              next[key] = null;
            }
          }
          return next;
        });
      } catch {
        if (epoch !== modelEpochRef.current) return;
        if (controller.signal.aborted) return;
        setModelFields([]);
        setFields({
          sentence: '',
          definition: null,
          image: null,
          audio: null,
          word: null,
          source: null,
          tags: null,
        });
      }
    },
    [endpoint, apiKey],
  );

  // --- Handle field mapping change ---
  const handleFieldChange = useCallback(
    (key: keyof AnkiFieldMapping, value: string) => {
      setFields((prev) => ({
        ...prev,
        [key]: value === '' ? null : value,
      }));
      setPresetSaved(false);
    },
    [],
  );

  // --- Save preset ---
  const handleSavePreset = useCallback(() => {
    const prefs: AnkiMinerPreferences = {
      presetName: 'Default',
      ankiConnectUrl: endpoint,
      deck: selectedDeck || null,
      noteType: selectedModel || null,
      fields: { ...fields },
    };

    if (!isValidPreset(prefs)) return;

    writeAnkiMinerPreferences(prefs);
    setPresetSaved(true);
  }, [endpoint, selectedDeck, selectedModel, fields]);

  // --- Determine if preset can be saved (reuse isValidPreset) ---
  const prefsForValidation: AnkiMinerPreferences = {
    presetName: 'Default',
    ankiConnectUrl: endpoint,
    deck: selectedDeck || null,
    noteType: selectedModel || null,
    fields,
  };
  const canSave =
    isValidPreset(prefsForValidation) &&
    modelFields.includes(fields.sentence);

  // --- Determine error display text ---
  const errorDisplay = getLocalizedError(
    connectionState,
    errorMessage,
    dict,
  );

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
      {/* Connection section: heading + endpoint + button */}
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
                setEndpoint(e.target.value);
                setPresetSaved(false);
              }}
              disabled={isConnecting}
              autoComplete="off"
            />
          </div>
          <Button
            type="button"
            variant="default"
            size="sm"
            onClick={handleConnect}
            disabled={isConnecting}
            className="entei-anki-connect-btn"
          >
            {connectionState === 'connected' || connectionState === 'idle'
              ? dict.ankiConnectButton
              : dict.ankiRetryButton}
          </Button>
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

      {/* Connection status */}
      {isConnecting && (
        <p className="entei-anki-status" role="status">
          {dict.ankiConnecting}
        </p>
      )}

      {connectionState !== 'idle' &&
        connectionState !== 'connecting' &&
        connectionState !== 'connected' && (
          <div className="entei-anki-error" role="alert">
            {errorDisplay}
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
                setSelectedDeck(v);
                setPresetSaved(false);
              }}
            >
              <SelectTrigger
                className="entei-anki-select-trigger"
                aria-labelledby={deckLabelId}
              >
                <SelectValue placeholder={dict.ankiDeckPlaceholder} />
              </SelectTrigger>
              <SelectContent>
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
            <Select
              value={selectedModel}
              onValueChange={handleModelChange}
            >
              <SelectTrigger
                className="entei-anki-select-trigger"
                aria-labelledby={noteTypeLabelId}
              >
                <SelectValue placeholder={dict.ankiNoteTypePlaceholder} />
              </SelectTrigger>
              <SelectContent>
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
                        <div
                          key={row.key}
                          className="entei-anki-field-row"
                        >
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
                            <SelectContent>
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

          {/* Save preset */}
          <div className="entei-anki-save-area">
            <Button
              type="button"
              variant="default"
              size="sm"
              onClick={handleSavePreset}
              disabled={!canSave}
              className="entei-anki-save-btn"
            >
              {dict.ankiSavePreset}
            </Button>
            {presetSaved && (
              <p className="entei-anki-saved" role="status">
                {dict.ankiPresetSaved}
              </p>
            )}
            {!canSave && !presetSaved && (
              <p className="entei-anki-hint">{dict.ankiPresetInvalid}</p>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
