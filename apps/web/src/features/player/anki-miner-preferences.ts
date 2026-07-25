/**
 * Anki Miner Preferences — Versioned localStorage for Default preset
 * ---------------------------------------------------------------------------
 * Key: `entei.player.anki-miner.v1`
 *
 * Persists ONLY:
 *   - endpoint (only after user explicitly saves)
 *   - deck, note type, field mapping
 *   - exportMode UI preference ('new' | 'update', optional, defaults to 'new')
 *
 * Does NOT persist:
 *   - API key
 *   - File / path / Blob URL
 *   - subtitle text, active cue, timestamp
 *   - screenshot / audio Blob
 *   - Anki response payload / card ID
 *   - export status, candidate note ID/details, draft values
 *
 * Exception-safe: never throws to caller; returns defaults on any failure.
 * --------------------------------------------------------------------------- */

/** Field mapping shape per ANKI_MINER.md §11. */
export interface AnkiFieldMapping {
  sentence: string;
  definition: string | null;
  image: string | null;
  audio: string | null;
  word: string | null;
  source: string | null;
  tags: string | null;
}

/** Persisted schema shape. exportMode is optional for backward compat. */
export interface AnkiMinerPreferencesV1 {
  schemaVersion: 1;
  presetName: 'Default';
  ankiConnectUrl: string;
  deck: string | null;
  noteType: string | null;
  fields: AnkiFieldMapping;
  exportMode?: 'new' | 'update';
  mediaMode?: 'image' | 'video';
}

/** Public read interface. exportMode defaults to 'new' when absent. */
export interface AnkiMinerPreferences {
  presetName: 'Default';
  ankiConnectUrl: string;
  deck: string | null;
  noteType: string | null;
  fields: AnkiFieldMapping;
  exportMode?: 'new' | 'update';
  mediaMode?: 'image' | 'video';
}

/** Read result always includes exportMode (defaults to 'new'). */
export interface AnkiMinerPreferencesRead extends AnkiMinerPreferences {
  exportMode: 'new' | 'update';
  mediaMode: 'image' | 'video';
}

/** localStorage key. */
const STORAGE_KEY = 'entei.player.anki-miner.v1';

/** Current schema version. */
const SCHEMA_VERSION = 1;

/** Default endpoint. */
const DEFAULT_ENDPOINT = 'http://127.0.0.1:8765';

/** Default empty mapping. */
const DEFAULT_MAPPING: AnkiFieldMapping = {
  sentence: '',
  definition: null,
  image: null,
  audio: null,
  word: null,
  source: null,
  tags: null,
};

/** Default preferences when nothing is stored or data is invalid. */
const DEFAULT_PREFERENCES: AnkiMinerPreferencesRead = {
  presetName: 'Default',
  ankiConnectUrl: DEFAULT_ENDPOINT,
  deck: null,
  noteType: null,
  fields: { ...DEFAULT_MAPPING },
  exportMode: 'new',
  mediaMode: 'image',
};

/** Read Anki miner preferences from localStorage. Always returns exportMode. */
export function readAnkiMinerPreferences(): AnkiMinerPreferencesRead {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw === null) {
      return { ...DEFAULT_PREFERENCES, fields: { ...DEFAULT_MAPPING } };
    }

    const parsed: unknown = JSON.parse(raw);

    if (!isValidPreferencesV1(parsed)) {
      return { ...DEFAULT_PREFERENCES, fields: { ...DEFAULT_MAPPING } };
    }

    return {
      presetName: 'Default',
      ankiConnectUrl:
        typeof parsed.ankiConnectUrl === 'string' &&
        parsed.ankiConnectUrl.length > 0
          ? parsed.ankiConnectUrl
          : DEFAULT_ENDPOINT,
      deck: typeof parsed.deck === 'string' ? parsed.deck : null,
      noteType: typeof parsed.noteType === 'string' ? parsed.noteType : null,
      fields: sanitizeFieldMapping(parsed.fields),
      exportMode: sanitizeExportMode(parsed.exportMode),
      mediaMode: sanitizeMediaMode(parsed.mediaMode),
    };
  } catch {
    return { ...DEFAULT_PREFERENCES, fields: { ...DEFAULT_MAPPING } };
  }
}

/** Write Anki miner preferences to localStorage. */
export function writeAnkiMinerPreferences(prefs: AnkiMinerPreferences): void {
  try {
    const data: AnkiMinerPreferencesV1 = {
      schemaVersion: SCHEMA_VERSION,
      presetName: 'Default',
      ankiConnectUrl: prefs.ankiConnectUrl,
      deck: prefs.deck,
      noteType: prefs.noteType,
      fields: sanitizeFieldMapping(prefs.fields),
      exportMode: prefs.exportMode,
      mediaMode: prefs.mediaMode,
    };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
  } catch {
    // Storage failure is non-fatal
  }
}

/** Type guard for the persisted shape. */
function isValidPreferencesV1(value: unknown): value is AnkiMinerPreferencesV1 {
  if (typeof value !== 'object' || value === null) return false;
  const obj = value as Record<string, unknown>;
  if (obj.schemaVersion !== SCHEMA_VERSION) return false;
  if (obj.presetName !== 'Default') return false;
  if (!isValidFieldMapping(obj.fields)) return false;
  return true;
}

/** Validate that a value is a valid AnkiFieldMapping shape. */
function isValidFieldMapping(value: unknown): value is AnkiFieldMapping {
  if (typeof value !== 'object' || value === null) return false;
  const obj = value as Record<string, unknown>;

  // sentence is required and must be a string
  if (typeof obj.sentence !== 'string') return false;

  // Optional fields must be string | null when present
  const optionalKeys = [
    'definition',
    'image',
    'audio',
    'word',
    'source',
    'tags',
  ] as const;
  for (const key of optionalKeys) {
    const v = obj[key];
    if (v !== undefined && v !== null && typeof v !== 'string') return false;
  }

  return true;
}

/** Sanitize field mapping: ensure required sentence is string, optional fields are string | null. */
function sanitizeFieldMapping(value: unknown): AnkiFieldMapping {
  if (!isValidFieldMapping(value)) {
    return { ...DEFAULT_MAPPING };
  }
  // value is AnkiFieldMapping per the type guard above
  return {
    sentence: value.sentence,
    definition: value.definition ?? null,
    image: value.image ?? null,
    audio: value.audio ?? null,
    word: value.word ?? null,
    source: value.source ?? null,
    tags: value.tags ?? null,
  };
}

/** Sanitize exportMode: only 'new' or 'update' allowed; default 'new'. */
function sanitizeExportMode(value: unknown): 'new' | 'update' {
  if (value === 'new' || value === 'update') return value;
  return 'new';
}

/** Sanitize mediaMode: only 'image' or 'video' allowed; default 'image'. */
function sanitizeMediaMode(value: unknown): 'image' | 'video' {
  if (value === 'image' || value === 'video') return value;
  return 'image';
}

/** Check whether a preset is valid for saving/export. */
export function isValidPreset(prefs: AnkiMinerPreferences): boolean {
  return (
    prefs.deck !== null &&
    prefs.deck.length > 0 &&
    prefs.noteType !== null &&
    prefs.noteType.length > 0 &&
    prefs.fields.sentence !== null &&
    prefs.fields.sentence.length > 0
  );
}

/** Check whether a field name exists in the current note type's field list. */
export function isFieldInModel(
  fieldName: string | null,
  modelFields: string[],
): boolean {
  if (fieldName === null || fieldName.length === 0) return true; // unmapped is always valid
  return modelFields.includes(fieldName);
}

/** Validate the full mapping against a note type's field list. Returns invalid field keys. */
export function validateMappingAgainstModel(
  fields: AnkiFieldMapping,
  modelFields: string[],
): string[] {
  const invalid: string[] = [];
  if (!modelFields.includes(fields.sentence)) {
    invalid.push('sentence');
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
    const v = fields[key];
    if (v !== null && !modelFields.includes(v)) {
      invalid.push(key);
    }
  }
  return invalid;
}
