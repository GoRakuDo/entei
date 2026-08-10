import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import {
  readAnkiMinerPreferences,
  writeAnkiMinerPreferences,
  isValidPreset,
  isFieldInModel,
  validateMappingAgainstModel,
  parseAnkiTags,
} from '../src/features/player/anki-miner-preferences';

const STORAGE_KEY = 'entei.player.anki-miner.v1';

// ---------------------------------------------------------------------------
// readAnkiMinerPreferences
// ---------------------------------------------------------------------------

describe('readAnkiMinerPreferences', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  afterEach(() => {
    localStorage.clear();
  });

  it('returns defaults when no data is stored', () => {
    const prefs = readAnkiMinerPreferences();
    expect(prefs.presetName).toBe('Default');
    expect(prefs.ankiConnectUrl).toBe('http://127.0.0.1:8765');
    expect(prefs.deck).toBeNull();
    expect(prefs.noteType).toBeNull();
    expect(prefs.fields.sentence).toBe('');
    expect(prefs.fields.definition).toBeNull();
    expect(prefs.fields.image).toBeNull();
    expect(prefs.fields.audio).toBeNull();
    expect(prefs.fields.word).toBeNull();
    expect(prefs.fields.source).toBeNull();
    expect(prefs.tags).toBe('');
  });

  it('reads valid stored preferences', () => {
    const data = {
      schemaVersion: 1,
      presetName: 'Default',
      ankiConnectUrl: 'http://localhost:8765',
      deck: 'Test Deck',
      noteType: 'Basic',
      fields: {
        sentence: 'Front',
        definition: 'Back',
        image: null,
        audio: null,
        word: null,
        source: null,
      },
    };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(data));

    const prefs = readAnkiMinerPreferences();
    expect(prefs.ankiConnectUrl).toBe('http://localhost:8765');
    expect(prefs.deck).toBe('Test Deck');
    expect(prefs.noteType).toBe('Basic');
    expect(prefs.fields.sentence).toBe('Front');
    expect(prefs.fields.definition).toBe('Back');
  });

  it('returns defaults for corrupted JSON', () => {
    localStorage.setItem(STORAGE_KEY, 'not-json');
    const prefs = readAnkiMinerPreferences();
    expect(prefs.deck).toBeNull();
    expect(prefs.fields.sentence).toBe('');
  });

  it('returns defaults for wrong schema version', () => {
    const data = {
      schemaVersion: 99,
      presetName: 'Default',
      ankiConnectUrl: 'http://127.0.0.1:8765',
      deck: 'Test',
      noteType: 'Basic',
      fields: {
        sentence: 'Front',
        definition: null,
        image: null,
        audio: null,
        word: null,
        source: null,
      },
    };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
    const prefs = readAnkiMinerPreferences();
    expect(prefs.deck).toBeNull();
  });

  it('returns defaults for invalid preset name', () => {
    const data = {
      schemaVersion: 1,
      presetName: 'Custom',
      ankiConnectUrl: 'http://127.0.0.1:8765',
      deck: 'Test',
      noteType: 'Basic',
      fields: {
        sentence: 'Front',
        definition: null,
        image: null,
        audio: null,
        word: null,
        source: null,
      },
    };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
    const prefs = readAnkiMinerPreferences();
    expect(prefs.deck).toBeNull();
  });

  it('returns defaults for missing sentence field', () => {
    const data = {
      schemaVersion: 1,
      presetName: 'Default',
      ankiConnectUrl: 'http://127.0.0.1:8765',
      deck: 'Test',
      noteType: 'Basic',
      fields: {
        definition: 'Back',
        image: null,
        audio: null,
        word: null,
        source: null,
      },
    };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
    const prefs = readAnkiMinerPreferences();
    expect(prefs.fields.sentence).toBe('');
    expect(prefs.deck).toBeNull(); // whole object invalid
  });

  it('returns defaults for invalid optional field type', () => {
    const data = {
      schemaVersion: 1,
      presetName: 'Default',
      ankiConnectUrl: 'http://127.0.0.1:8765',
      deck: 'Test',
      noteType: 'Basic',
      fields: {
        sentence: 'Front',
        definition: 123,
        image: null,
        audio: null,
        word: null,
        source: null,
      },
    };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
    const prefs = readAnkiMinerPreferences();
    expect(prefs.fields.sentence).toBe('');
  });

  it('sanitizes undefined optional fields to null', () => {
    const data = {
      schemaVersion: 1,
      presetName: 'Default',
      ankiConnectUrl: 'http://127.0.0.1:8765',
      deck: 'Test',
      noteType: 'Basic',
      fields: { sentence: 'Front' },
    };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
    const prefs = readAnkiMinerPreferences();
    expect(prefs.fields.sentence).toBe('Front');
    expect(prefs.fields.definition).toBeNull();
    expect(prefs.fields.image).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// writeAnkiMinerPreferences
// ---------------------------------------------------------------------------

describe('writeAnkiMinerPreferences', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  afterEach(() => {
    localStorage.clear();
  });

  it('persists preferences to localStorage', () => {
    writeAnkiMinerPreferences({
      presetName: 'Default',
      ankiConnectUrl: 'http://127.0.0.1:8765',
      deck: 'My Deck',
      noteType: 'Basic',
      fields: {
        sentence: 'Front',
        definition: 'Back',
        image: null,
        audio: null,
        word: null,
        source: null,
      },
    });

    const raw = localStorage.getItem(STORAGE_KEY);
    expect(raw).not.toBeNull();

    const data = JSON.parse(raw!);
    expect(data.schemaVersion).toBe(1);
    expect(data.presetName).toBe('Default');
    expect(data.ankiConnectUrl).toBe('http://127.0.0.1:8765');
    expect(data.deck).toBe('My Deck');
    expect(data.noteType).toBe('Basic');
    expect(data.fields.sentence).toBe('Front');
  });

  it('write payload contains only expected keys', () => {
    writeAnkiMinerPreferences({
      presetName: 'Default',
      ankiConnectUrl: 'http://127.0.0.1:8765',
      deck: 'Deck',
      noteType: 'Basic',
      fields: {
        sentence: 'Front',
        definition: null,
        image: null,
        audio: null,
        word: null,
        source: null,
      },
    });

    const raw = localStorage.getItem(STORAGE_KEY);
    const data = JSON.parse(raw!);
    const keys = Object.keys(data).sort();
    expect(keys).toEqual([
      'ankiConnectUrl',
      'deck',
      'fields',
      'noteType',
      'presetName',
      'schemaVersion',
      'tags',
    ]);
  });

  it('does not persist API key', () => {
    writeAnkiMinerPreferences({
      presetName: 'Default',
      ankiConnectUrl: 'http://127.0.0.1:8765',
      deck: 'Deck',
      noteType: 'Basic',
      fields: {
        sentence: 'Front',
        definition: null,
        image: null,
        audio: null,
        word: null,
        source: null,
      },
    });

    const raw = localStorage.getItem(STORAGE_KEY);
    expect(raw).not.toContain('apiKey');
    expect(raw).not.toContain('secret');
  });

  it('does not persist media/subtitle/file data', () => {
    writeAnkiMinerPreferences({
      presetName: 'Default',
      ankiConnectUrl: 'http://127.0.0.1:8765',
      deck: 'Deck',
      noteType: 'Basic',
      fields: {
        sentence: 'Front',
        definition: null,
        image: null,
        audio: null,
        word: null,
        source: null,
      },
    });

    const raw = localStorage.getItem(STORAGE_KEY);
    expect(raw).not.toContain('blob');
    expect(raw).not.toContain('path');
    expect(raw).not.toContain('subtitle');
    expect(raw).not.toContain('file');
  });

  it('does not throw when localStorage throws', () => {
    const originalSetItem = Storage.prototype.setItem;
    Storage.prototype.setItem = vi.fn(() => {
      throw new Error('QuotaExceededError');
    });

    expect(() =>
      writeAnkiMinerPreferences({
        presetName: 'Default',
        ankiConnectUrl: 'http://127.0.0.1:8765',
        deck: 'Deck',
        noteType: 'Basic',
        fields: {
          sentence: 'Front',
          definition: null,
          image: null,
          audio: null,
          word: null,
          source: null,
        },
      }),
    ).not.toThrow();

    Storage.prototype.setItem = originalSetItem;
  });
});

// ---------------------------------------------------------------------------
// isValidPreset
// ---------------------------------------------------------------------------

describe('isValidPreset', () => {
  it('returns true when deck, noteType, and sentence are set', () => {
    const result = isValidPreset({
      presetName: 'Default',
      ankiConnectUrl: 'http://127.0.0.1:8765',
      deck: 'My Deck',
      noteType: 'Basic',
      fields: {
        sentence: 'Front',
        definition: null,
        image: null,
        audio: null,
        word: null,
        source: null,
      },
    });
    expect(result).toBe(true);
  });

  it('returns false when deck is null', () => {
    const result = isValidPreset({
      presetName: 'Default',
      ankiConnectUrl: 'http://127.0.0.1:8765',
      deck: null,
      noteType: 'Basic',
      fields: {
        sentence: 'Front',
        definition: null,
        image: null,
        audio: null,
        word: null,
        source: null,
      },
    });
    expect(result).toBe(false);
  });

  it('returns false when noteType is null', () => {
    const result = isValidPreset({
      presetName: 'Default',
      ankiConnectUrl: 'http://127.0.0.1:8765',
      deck: 'My Deck',
      noteType: null,
      fields: {
        sentence: 'Front',
        definition: null,
        image: null,
        audio: null,
        word: null,
        source: null,
      },
    });
    expect(result).toBe(false);
  });

  it('returns false when sentence is empty', () => {
    const result = isValidPreset({
      presetName: 'Default',
      ankiConnectUrl: 'http://127.0.0.1:8765',
      deck: 'My Deck',
      noteType: 'Basic',
      fields: {
        sentence: '',
        definition: null,
        image: null,
        audio: null,
        word: null,
        source: null,
      },
    });
    expect(result).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// isFieldInModel
// ---------------------------------------------------------------------------

describe('isFieldInModel', () => {
  it('returns true for null field', () => {
    expect(isFieldInModel(null, ['Front', 'Back'])).toBe(true);
  });

  it('returns true for empty string field', () => {
    expect(isFieldInModel('', ['Front', 'Back'])).toBe(true);
  });

  it('returns true when field exists in model', () => {
    expect(isFieldInModel('Front', ['Front', 'Back'])).toBe(true);
  });

  it('returns false when field does not exist in model', () => {
    expect(isFieldInModel('Missing', ['Front', 'Back'])).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// validateMappingAgainstModel
// ---------------------------------------------------------------------------

describe('validateMappingAgainstModel', () => {
  it('returns empty array for valid mapping', () => {
    const fields = {
      sentence: 'Front',
      definition: 'Back',
      image: null,
      audio: null,
      word: null,
      source: null,
    };
    const result = validateMappingAgainstModel(fields, ['Front', 'Back']);
    expect(result).toEqual([]);
  });

  it('reports invalid sentence field', () => {
    const fields = {
      sentence: 'Missing',
      definition: null,
      image: null,
      audio: null,
      word: null,
      source: null,
    };
    const result = validateMappingAgainstModel(fields, ['Front', 'Back']);
    expect(result).toContain('sentence');
  });

  it('reports invalid optional fields', () => {
    const fields = {
      sentence: 'Front',
      definition: 'Missing',
      image: 'AlsoMissing',
      audio: null,
      word: null,
      source: null,
    };
    const result = validateMappingAgainstModel(fields, ['Front', 'Back']);
    expect(result).toContain('definition');
    expect(result).toContain('image');
    expect(result).not.toContain('sentence');
  });
});

// ---------------------------------------------------------------------------
// readAnkiMinerPreferences with throwing localStorage
// ---------------------------------------------------------------------------

describe('readAnkiMinerPreferences with throwing localStorage', () => {
  it('returns defaults when localStorage.getItem throws', () => {
    const originalGetItem = Storage.prototype.getItem;
    Storage.prototype.getItem = vi.fn(() => {
      throw new Error('SecurityError');
    });

    const prefs = readAnkiMinerPreferences();
    expect(prefs.deck).toBeNull();
    expect(prefs.fields.sentence).toBe('');

    Storage.prototype.getItem = originalGetItem;
  });
});

// ---------------------------------------------------------------------------
// exportMode persistence (Stage 2 UI preference)
// ---------------------------------------------------------------------------

describe('exportMode persistence', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  afterEach(() => {
    localStorage.clear();
  });

  it('defaults to "new" when no data stored', () => {
    const prefs = readAnkiMinerPreferences();
    expect(prefs.exportMode).toBe('new');
  });

  it('defaults to "new" when exportMode is missing from stored v1 data', () => {
    // Old stored data without exportMode field (backward compat)
    const oldData = {
      schemaVersion: 1,
      presetName: 'Default',
      ankiConnectUrl: 'http://localhost:8765',
      deck: 'Test',
      noteType: 'Basic',
      fields: {
        sentence: 'Front',
        definition: null,
        image: null,
        audio: null,
        word: null,
        source: null,
      },
    };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(oldData));

    const prefs = readAnkiMinerPreferences();
    expect(prefs.exportMode).toBe('new');
    // Other prefs preserved
    expect(prefs.deck).toBe('Test');
    expect(prefs.noteType).toBe('Basic');
  });

  it('defaults to "new" when exportMode is corrupted', () => {
    const data = {
      schemaVersion: 1,
      presetName: 'Default',
      ankiConnectUrl: 'http://localhost:8765',
      deck: 'Test',
      noteType: 'Basic',
      fields: {
        sentence: 'Front',
        definition: null,
        image: null,
        audio: null,
        word: null,
        source: null,
      },
      exportMode: 'invalid_mode',
    };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(data));

    const prefs = readAnkiMinerPreferences();
    expect(prefs.exportMode).toBe('new');
  });

  it('defaults to "new" when exportMode is null', () => {
    const data = {
      schemaVersion: 1,
      presetName: 'Default',
      ankiConnectUrl: 'http://localhost:8765',
      deck: 'Test',
      noteType: 'Basic',
      fields: {
        sentence: 'Front',
        definition: null,
        image: null,
        audio: null,
        word: null,
        source: null,
      },
      exportMode: null,
    };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(data));

    const prefs = readAnkiMinerPreferences();
    expect(prefs.exportMode).toBe('new');
  });

  it('reads "update" when stored', () => {
    const data = {
      schemaVersion: 1,
      presetName: 'Default',
      ankiConnectUrl: 'http://localhost:8765',
      deck: 'Test',
      noteType: 'Basic',
      fields: {
        sentence: 'Front',
        definition: null,
        image: null,
        audio: null,
        word: null,
        source: null,
      },
      exportMode: 'update',
    };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(data));

    const prefs = readAnkiMinerPreferences();
    expect(prefs.exportMode).toBe('update');
  });

  it('writes exportMode preserving other prefs', () => {
    // First write a full preset
    writeAnkiMinerPreferences({
      presetName: 'Default',
      ankiConnectUrl: 'http://localhost:8765',
      deck: 'Japanese',
      noteType: 'Basic',
      fields: {
        sentence: 'Front',
        definition: 'Back',
        image: null,
        audio: null,
        word: null,
        source: null,
      },
      exportMode: 'new',
    });

    // Now change only exportMode, preserving existing prefs
    const existing = readAnkiMinerPreferences();
    writeAnkiMinerPreferences({ ...existing, exportMode: 'update' });

    const prefs = readAnkiMinerPreferences();
    expect(prefs.exportMode).toBe('update');
    expect(prefs.deck).toBe('Japanese');
    expect(prefs.noteType).toBe('Basic');
    expect(prefs.fields.sentence).toBe('Front');
    expect(prefs.fields.definition).toBe('Back');
  });

  it('ignores legacy fields.tags; top-level tags defaults to empty string', () => {
    // Old schema: tags lived inside the field mapping. It must not
    // surface as a mapping entry nor migrate into top-level tags.
    const data = {
      schemaVersion: 1,
      presetName: 'Default',
      ankiConnectUrl: 'http://localhost:8765',
      deck: 'Legacy Deck',
      noteType: 'Basic',
      fields: {
        sentence: 'Front',
        definition: 'Back',
        image: null,
        audio: null,
        word: null,
        source: null,
        tags: 'anime legacy',
      },
    };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(data));

    const prefs = readAnkiMinerPreferences();
    // The legacy mapping entry is gone from the sanitized mapping…
    const mapping = prefs.fields as unknown as Record<string, unknown>;
    expect('tags' in mapping).toBe(false);
    // …and top-level tags defaults to '' (not migrated).
    expect(prefs.tags).toBe('');
  });

  it('reads top-level tags string from storage', () => {
    const data = {
      schemaVersion: 1,
      presetName: 'Default',
      ankiConnectUrl: 'http://localhost:8765',
      deck: 'Tags Deck',
      noteType: 'Basic',
      fields: {
        sentence: 'Front',
        definition: 'Back',
        image: null,
        audio: null,
        word: null,
        source: null,
      },
      tags: 'anime n5 eizou',
    };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(data));

    const prefs = readAnkiMinerPreferences();
    expect(prefs.tags).toBe('anime n5 eizou');
  });
});

// ---------------------------------------------------------------------------
// parseAnkiTags
// ---------------------------------------------------------------------------

describe('parseAnkiTags', () => {
  it('splits on whitespace, trims, and drops empties', () => {
    expect(parseAnkiTags('  anime   n5   eizou  ')).toEqual([
      'anime',
      'n5',
      'eizou',
    ]);
    expect(parseAnkiTags('\tanime\nn5\reizou\u3000misc')).toEqual([
      'anime',
      'n5',
      'eizou',
      'misc',
    ]);
  });

  it('deduplicates keeping first occurrence order', () => {
    expect(
      parseAnkiTags('anime anime n5 anime \u3000n5\u3000eizou'),
    ).toEqual(['anime', 'n5', 'eizou']);
  });

  it('preserves Japanese and emoji tags', () => {
    expect(parseAnkiTags('日本語 tシャツ 👀')).toEqual([
      '日本語',
      'tシャツ',
      '👀',
    ]);
  });

  it('returns [] for empty / whitespace-only / all-duplicate input', () => {
    expect(parseAnkiTags('')).toEqual([]);
    expect(parseAnkiTags('   \t \n ')).toEqual([]);
    expect(parseAnkiTags('dup dup dup')).toEqual(['dup']);
  });
});
