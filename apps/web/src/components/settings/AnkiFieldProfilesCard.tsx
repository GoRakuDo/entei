'use client';

/**
 * AnkiFieldProfilesCard — /settings/ Anki page, "Anki Field Profiles & Formats"
 * card.
 * ---------------------------------------------------------------------------
 * Hand-drawn spec:
 *   Heading : Lucide FileStack + "Anki Field Profiles & Formats"
 *   Row 1   : Screenshot format — PNG / JPEG select.
 *   Row 2   : "Configure Anki flashcard deck profiles" toolbar with an
 *             Add Deck Profile (SquarePlus) action on the right.
 *   Deck Profiles list (accordion):
 *     - Each profile renders as a bordered card; the header (name + chevron)
 *       toggles the body. The first profile starts expanded.
 *     - Body: Name (text), Button (icon select), Deck (select of live
 *       deckNames), NoteType (select of live modelNames), a divider, then the
 *       Field / Value mapping table for the selected model's fields, and a
 *       full-width Remove button.
 *
 * Deck + model lists come from AnkiConnect (`deckNames` / `modelNames`) on
 * mount using the persisted server + apiKey. Each model's field list is
 * fetched on demand (`modelFieldNames`) and cached. When Anki is not running
 * the requests fail soft: the current deck / model value is kept and the
 * field table falls back to whatever the profile already persists.
 *
 * Persistence: every change writes through `updateAnkiConnectionPreferences`
 * (localStorage + desktop SQLite) the moment it happens — no Save button.
 * ---------------------------------------------------------------------------
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ChevronDown,
  ChevronUp,
  Circle,
  CircleDot,
  Diamond,
  FileStack,
  Square,
  SquarePlus,
  Trash2,
  type LucideIcon,
} from 'lucide-react';
import { Input } from '@/components/player/ui/input';
import { SettingsButton } from '@/components/settings/SettingsButton';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/player/ui/select';
import {
  DEFAULT_ANKI_CONNECTION_PREFERENCES,
  readAnkiConnectionPreferences,
  updateAnkiConnectionPreferences,
  type AnkiCardFormat,
  type AnkiCardFormatIcon,
  type ScreenshotFormat,
} from '@/features/player/anki-connection-preferences';
import { AnkiConnectClient } from '@/features/player/anki-connect';
import type { Dictionary } from '@i18n/types';

const SCREENSHOT_FORMAT_OPTIONS: readonly ScreenshotFormat[] = ['png', 'jpeg'];

/** Icon rendered per AnkiCardFormatIcon value (matches the drawn ⊕ glyphs). */
const ICON_GLYPHS: Record<AnkiCardFormatIcon, LucideIcon> = {
  'big-circle': CircleDot,
  'small-circle': Circle,
  'big-square': Square,
  'big-diamond': Diamond,
};

/** Common Yomitan markers offered as quick choices in the Value column. */
const MARKER_OPTIONS: readonly string[] = [
  '{expression}',
  '{reading}',
  '{glossary}',
  '{audio}',
  '{screenshot}',
  '{sentence}',
  '{sentence-furigana}',
  '{cloze-prefix}',
  '{cloze-body}',
  '{cloze-suffix}',
  '{frequencies}',
  '{pitch-accents}',
];

export interface AnkiFieldProfilesCardProps {
  /** Localized copy for this card (dict.ankiFieldProfiles). */
  dict: Dictionary['ankiFieldProfiles'];
}

/** Generate a unique profile id (crypto.randomUUID when available). */
function newProfileId(): string {
  try {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
      return crypto.randomUUID();
    }
  } catch {
    // fall through to the manual fallback
  }
  return `profile-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

export function AnkiFieldProfilesCard({
  dict,
}: AnkiFieldProfilesCardProps) {
  const [screenshotFormat, setScreenshotFormat] = useState<ScreenshotFormat>(
    DEFAULT_ANKI_CONNECTION_PREFERENCES.screenshotFormat,
  );
  const [cardFormats, setCardFormats] = useState<AnkiCardFormat[]>(
    DEFAULT_ANKI_CONNECTION_PREFERENCES.cardFormats,
  );
  /** Which profile accordion is expanded (profile id); first one by default. */
  const [expandedId, setExpandedId] = useState<string | null>(null);

  /** Live deck / model lists from AnkiConnect (empty until connected). */
  const [decks, setDecks] = useState<string[]>([]);
  const [models, setModels] = useState<string[]>([]);
  /** Cache of modelName -> field names fetched on demand. */
  const fieldCacheRef = useRef<Map<string, string[]>>(new Map());

  /* Seed from the persisted preferences on mount, then fetch deck/model lists. */
  useEffect(() => {
    const saved = readAnkiConnectionPreferences();
    setScreenshotFormat(saved.screenshotFormat);
    setCardFormats(saved.cardFormats);
    setExpandedId(saved.cardFormats[0]?.id ?? null);

    const controller = new AbortController();
    const client = new AnkiConnectClient(
      saved.server,
      saved.apiKey || undefined,
    );
    void (async () => {
      try {
        const [deckList, modelList] = await Promise.all([
          client.deckNames(controller.signal),
          client.modelNames(controller.signal),
        ]);
        if (controller.signal.aborted) return;
        setDecks(deckList);
        setModels(modelList);
      } catch {
        // fail-soft: Anki not running — keep current deck/model values
      }
    })();
    return () => controller.abort();
  }, []);

  /** Fetch (and cache) the field names for a model; [] on failure. */
  const resolveFields = useCallback(
    async (client: AnkiConnectClient, modelName: string): Promise<string[]> => {
      if (!modelName) return [];
      const cached = fieldCacheRef.current.get(modelName);
      if (cached) return cached;
      try {
        const fields = await client.modelFieldNames(modelName);
        fieldCacheRef.current.set(modelName, fields);
        return fields;
      } catch {
        return [];
      }
    },
    [],
  );

  /** Update one profile by id and persist the whole cardFormats list. */
  const updateFormat = useCallback(
    (id: string, change: Partial<AnkiCardFormat>) => {
      const next = cardFormats.map((format) =>
        format.id === id ? { ...format, ...change } : format,
      );
      setCardFormats(next);
      updateAnkiConnectionPreferences({ cardFormats: next });
    },
    [cardFormats],
  );

  const handleScreenshotFormatChange = useCallback((value: ScreenshotFormat) => {
    setScreenshotFormat(value);
    updateAnkiConnectionPreferences({ screenshotFormat: value });
  }, []);

  const handleAddProfile = useCallback(() => {
    setCardFormats((prev) => {
      const profile: AnkiCardFormat = {
        id: newProfileId(),
        name: 'New Profile',
        type: 'term',
        icon: 'big-square',
        deck: 'Default',
        model: 'Basic',
        fields: {},
      };
      const next = [...prev, profile];
      updateAnkiConnectionPreferences({ cardFormats: next });
      setExpandedId(profile.id);
      return next;
    });
  }, []);

  const handleRemoveProfile = useCallback(
    (id: string) => {
      setCardFormats((prev) => {
        // Guard: always keep at least one profile.
        if (prev.length <= 1) return prev;
        const next = prev.filter((format) => format.id !== id);
        updateAnkiConnectionPreferences({ cardFormats: next });
        setExpandedId((current) => (current === id ? null : current));
        return next;
      });
    },
    [],
  );

  /** NoteType change: swap model and refresh the field list for it. */
  const handleModelChange = useCallback(
    async (format: AnkiCardFormat, modelName: string) => {
      updateFormat(format.id, { model: modelName });
      const saved = readAnkiConnectionPreferences();
      const client = new AnkiConnectClient(saved.server, saved.apiKey || undefined);
      const fields = await resolveFields(client, modelName);
      if (fields.length === 0) return; // fail-soft: keep existing mapping
      setCardFormats((prev) => {
        const next = prev.map((f) => {
          if (f.id !== format.id) return f;
          // Preserve values for fields that still exist on the new model.
          const carried: Record<string, string> = {};
          for (const field of fields) {
            if (f.fields[field]) carried[field] = f.fields[field];
          }
          return { ...f, model: modelName, fields: carried };
        });
        updateAnkiConnectionPreferences({ cardFormats: next });
        return next;
      });
    },
    [resolveFields, updateFormat],
  );

  return (
    <section className="entei-settings-section-card entei-anki-field-profiles-card">
      <h3 className="entei-settings-label">
        <FileStack size={16} aria-hidden="true" />
        <span>{dict.title}</span>
      </h3>

      {/* Row 1 — Screenshot format */}
      <div className="entei-module-field">
        <div className="entei-module-field-text">
          <span className="entei-module-field-label">
            {dict.screenshotFormatLabel}
          </span>
          <p className="entei-module-field-description">
            {dict.screenshotFormatDescription}
          </p>
        </div>
        <div className="entei-module-field-control">
          <Select
            value={screenshotFormat}
            onValueChange={(next) =>
              handleScreenshotFormatChange(next as ScreenshotFormat)
            }
          >
            <SelectTrigger
              size="sm"
              className="entei-module-select"
              aria-label={dict.screenshotFormatLabel}
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {SCREENSHOT_FORMAT_OPTIONS.map((format) => (
                <SelectItem key={format} value={format}>
                  {format === 'png'
                    ? dict.screenshotFormatPng
                    : dict.screenshotFormatJpeg}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      {/* Row 2 — deck profiles toolbar */}
      <div className="entei-module-field entei-anki-profiles-toolbar">
        <div className="entei-module-field-text">
          <span className="entei-module-field-label">
            {dict.profilesLabel}
          </span>
          <p className="entei-module-field-description">
            {dict.profilesDescription}
          </p>
        </div>
        <div className="entei-module-field-control">
          <SettingsButton icon={SquarePlus} onClick={handleAddProfile}>
            {dict.addProfileLabel}
          </SettingsButton>
        </div>
      </div>

      {/* Deck Profiles accordion list */}
      <div className="entei-anki-profile-list">
        {cardFormats.map((format) => {
          const expanded = expandedId === format.id;
          const IconGlyph = ICON_GLYPHS[format.icon];
          return (
            <div
              className="entei-anki-profile-card"
              key={format.id}
              data-expanded={expanded || undefined}
            >
              <button
                type="button"
                className="entei-anki-profile-header"
                aria-expanded={expanded}
                onClick={() => setExpandedId(expanded ? null : format.id)}
              >
                <span className="entei-anki-profile-name">{format.name}</span>
                {expanded ? (
                  <ChevronUp size={16} aria-hidden="true" />
                ) : (
                  <ChevronDown size={16} aria-hidden="true" />
                )}
              </button>

              {expanded && (
                <div className="entei-anki-profile-body">
                  {/* Name */}
                  <div className="entei-module-field">
                    <div className="entei-module-field-text">
                      <span className="entei-module-field-label">
                        {dict.nameFieldLabel}
                      </span>
                    </div>
                    <div className="entei-module-field-control">
                      <Input
                        type="text"
                        className="entei-module-input"
                        value={format.name}
                        aria-label={dict.nameFieldLabel}
                        onChange={(event) =>
                          updateFormat(format.id, { name: event.target.value })
                        }
                      />
                    </div>
                  </div>

                  {/* Button (icon) */}
                  <div className="entei-module-field">
                    <div className="entei-module-field-text">
                      <span className="entei-module-field-label">
                        {dict.buttonFieldLabel}
                      </span>
                    </div>
                    <div className="entei-module-field-control">
                      <Select
                        value={format.icon}
                        onValueChange={(next) =>
                          updateFormat(format.id, { icon: next as AnkiCardFormatIcon })
                        }
                      >
                        <SelectTrigger
                          size="sm"
                          className="entei-module-select"
                          aria-label={dict.buttonFieldLabel}
                        >
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {(
                            [
                              ['big-circle', dict.iconBigCircle],
                              ['small-circle', dict.iconSmallCircle],
                              ['big-square', dict.iconBigSquare],
                              ['big-diamond', dict.iconBigDiamond],
                            ] as readonly [AnkiCardFormatIcon, string][]
                          ).map(([icon, label]) => {
                            const Glyph = ICON_GLYPHS[icon];
                            return (
                              <SelectItem key={icon} value={icon}>
                                <span className="entei-anki-profile-icon-option">
                                  <Glyph size={14} aria-hidden="true" />
                                  <span>{label}</span>
                                </span>
                              </SelectItem>
                            );
                          })}
                        </SelectContent>
                      </Select>
                    </div>
                  </div>

                  {/* Deck */}
                  <div className="entei-module-field">
                    <div className="entei-module-field-text">
                      <span className="entei-module-field-label">
                        {dict.deckFieldLabel}
                      </span>
                    </div>
                    <div className="entei-module-field-control">
                      <Select
                        value={format.deck}
                        onValueChange={(next) =>
                          updateFormat(format.id, { deck: next })
                        }
                      >
                        <SelectTrigger
                          size="sm"
                          className="entei-module-select"
                          aria-label={dict.deckFieldLabel}
                        >
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {(decks.includes(format.deck)
                            ? decks
                            : [format.deck, ...decks]
                          )
                            .filter((deck) => deck !== '')
                            .map((deck) => (
                              <SelectItem key={deck} value={deck}>
                                {deck}
                              </SelectItem>
                            ))}
                        </SelectContent>
                      </Select>
                    </div>
                  </div>

                  {/* NoteType */}
                  <ProfileModelSelect
                    format={format}
                    models={models}
                    dict={dict}
                    onSelect={(modelName) => void handleModelChange(format, modelName)}
                  />

                  <hr className="entei-settings-divider" />

                  {/* Field / Value mapping table */}
                  <ProfileFieldTable
                    format={format}
                    dict={dict}
                    resolveFields={resolveFields}
                    onFieldChange={(field, value) =>
                      updateFormat(format.id, {
                        fields: { ...format.fields, [field]: value },
                      })
                    }
                  />

                  {/* Remove profile */}
                  <button
                    type="button"
                    className="entei-action-btn entei-action-btn--full entei-anki-profile-remove"
                    onClick={() => handleRemoveProfile(format.id)}
                    disabled={cardFormats.length <= 1}
                  >
                    <Trash2 size={16} aria-hidden="true" />
                    <span>{dict.removeProfileLabel}</span>
                  </button>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </section>
  );
}

/* --- NoteType select: shows the current model plus any live model list --- */
function ProfileModelSelect({
  format,
  models,
  dict,
  onSelect,
}: {
  format: AnkiCardFormat;
  models: string[];
  dict: Dictionary['ankiFieldProfiles'];
  onSelect: (modelName: string) => void;
}) {
  const options = useMemo(
    () =>
      models.includes(format.model) || format.model === ''
        ? models
        : [format.model, ...models],
    [models, format.model],
  );
  return (
    <div className="entei-module-field">
      <div className="entei-module-field-text">
        <span className="entei-module-field-label">
          {dict.noteTypeFieldLabel}
        </span>
      </div>
      <div className="entei-module-field-control">
        <Select value={format.model} onValueChange={onSelect}>
          <SelectTrigger
            size="sm"
            className="entei-module-select"
            aria-label={dict.noteTypeFieldLabel}
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {options
              .filter((model) => model !== '')
              .map((model) => (
                <SelectItem key={model} value={model}>
                  {model}
                </SelectItem>
              ))}
          </SelectContent>
        </Select>
      </div>
    </div>
  );
}

/* --- Field / Value mapping table --------------------------------------- */
function ProfileFieldTable({
  format,
  dict,
  resolveFields,
  onFieldChange,
}: {
  format: AnkiCardFormat;
  dict: Dictionary['ankiFieldProfiles'];
  resolveFields: (
    client: AnkiConnectClient,
    modelName: string,
  ) => Promise<string[]>;
  onFieldChange: (field: string, value: string) => void;
}) {
  /** Live field names for the model; falls back to the persisted field keys. */
  const [fields, setFields] = useState<string[]>(() =>
    Object.keys(format.fields),
  );

  useEffect(() => {
    let cancelled = false;
    const saved = readAnkiConnectionPreferences();
    const client = new AnkiConnectClient(saved.server, saved.apiKey || undefined);
    void resolveFields(client, format.model).then((live) => {
      if (cancelled) return;
      // Merge live fields with any persisted ones so nothing is lost.
      const merged = Array.from(new Set([...live, ...Object.keys(format.fields)]));
      setFields(merged);
    });
    return () => {
      cancelled = true;
    };
  }, [format.model, format.fields, resolveFields]);

  return (
    <div className="entei-anki-profile-fields">
      <div className="entei-anki-profile-fields-header">
        <span>{dict.fieldColumnHeader}</span>
        <span>{dict.valueColumnHeader}</span>
      </div>
      <div className="entei-anki-profile-fields-rows">
        {fields.map((field) => (
          <div className="entei-anki-profile-field-row" key={field}>
            <span className="entei-anki-profile-field-name">{field}</span>
            <Input
              type="text"
              className="entei-module-input entei-anki-profile-field-value"
              value={format.fields[field] ?? ''}
              placeholder={MARKER_OPTIONS[0]}
              aria-label={`${field} ${dict.valueColumnHeader}`}
              list={`entei-anki-markers-${format.id}`}
              onChange={(event) => onFieldChange(field, event.target.value)}
            />
          </div>
        ))}
      </div>
      {/* Shared marker suggestions for free-text value inputs. */}
      <datalist id={`entei-anki-markers-${format.id}`}>
        {MARKER_OPTIONS.map((marker) => (
          <option key={marker} value={marker} />
        ))}
      </datalist>
    </div>
  );
}
