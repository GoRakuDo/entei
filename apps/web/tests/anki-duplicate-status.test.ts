/**
 * anki-duplicate-status — unit tests.
 * ---------------------------------------------------------------------------
 * Covers the shared `checkTermsForDuplicates` helper the Yomitan search page and
 * the floating popup both call:
 *   - normal path: one term with an existing note → true, one without → false;
 *   - fail-soft: a failing AnkiConnect call degrades to an empty map (never
 *     throws), so card rendering is never broken by a duplicate check;
 *   - master switch off: `checkForDuplicates: false` → no API call at all;
 *   - no target deck configured → skipped.
 *
 * The helper reads the SAME localStorage settings the player mining flow honours
 * (`entei.player.anki-connection.v1` + `entei.player.anki-miner.v1`) and talks to
 * AnkiConnect over fetch, so the tests seed those keys and stub `global.fetch`
 * with AnkiConnect's `{ result, error }` envelope.
 * --------------------------------------------------------------------------- */

import { describe, it, expect, beforeEach, afterEach, vi } from 'bun:test';
import { checkTermsForDuplicates } from '../src/modules/yomitan/search/anki-duplicate-status';

const CONNECTION_KEY = 'entei.player.anki-connection.v1';
const MINER_KEY = 'entei.player.anki-miner.v1';

/** A valid Anki Connection row the reader's type guard accepts. */
const CONNECTION_PREFS = {
  server: 'http://127.0.0.1:8765',
  apiKey: '',
  forceSync: false,
  checkForDuplicates: true,
  checkAllModels: false,
  duplicateScope: 'collection',
  duplicateBehavior: 'allow',
  suspendNewCards: false,
  openNoteViewer: 'note-editor',
  cardTemplates: '',
};

/** A valid Anki Miner row with a deck and a `word` field mapped. */
const MINER_PREFS = {
  schemaVersion: 1,
  presetName: 'Default',
  ankiConnectUrl: 'http://127.0.0.1:8765',
  deck: 'Japanese',
  noteType: 'Japanese Vocab',
  fields: {
    sentence: 'Sentence',
    definition: 'Definition',
    image: null,
    audio: null,
    word: 'word',
    source: null,
  },
};

/** Seed both settings rows. Overrides let a test flip a single knob. */
function seedPreferences({
  connection = CONNECTION_PREFS,
  miner = MINER_PREFS,
}: {
  connection?: Record<string, unknown> | null;
  miner?: Record<string, unknown> | null;
} = {}): void {
  if (connection !== null) {
    localStorage.setItem(CONNECTION_KEY, JSON.stringify(connection));
  }
  if (miner !== null) {
    localStorage.setItem(MINER_KEY, JSON.stringify(miner));
  }
}

/** Build a Response in AnkiConnect's version-6 `{ result, error }` envelope. */
function ankiResponse(result: unknown): Response {
  return new Response(JSON.stringify({ result, error: null }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

beforeEach(() => {
  localStorage.clear();
  vi.restoreAllMocks();
});

afterEach(() => {
  localStorage.clear();
  vi.restoreAllMocks();
});

describe('checkTermsForDuplicates', () => {
  it('returns hasDuplicate true/false per term on the happy path', async () => {
    seedPreferences();
    // 猫 already has notes; 犬 does not. The query embeds the term.
    const fetchMock = vi.fn(async (_input: unknown, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? '{}'));
      const query = String(body.params?.query ?? '');
      return ankiResponse(query.includes('猫') ? [101, 102] : []);
    });
    global.fetch = fetchMock as unknown as typeof fetch;

    const statuses = await checkTermsForDuplicates(['猫', '犬']);

    expect(statuses.get('猫')).toBe(true);
    expect(statuses.get('犬')).toBe(false);
    // One round trip per unique term.
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('de-duplicates repeated terms into a single check', async () => {
    seedPreferences();
    const fetchMock = vi.fn(async () => ankiResponse([]));
    global.fetch = fetchMock as unknown as typeof fetch;

    const statuses = await checkTermsForDuplicates(['猫', '猫', '猫']);

    expect(statuses.size).toBe(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('is fail-soft: a failing AnkiConnect call yields an empty map, not a throw', async () => {
    seedPreferences();
    global.fetch = vi.fn(async () => {
      throw new Error('Anki is not running');
    }) as unknown as typeof fetch;

    const statuses = await checkTermsForDuplicates(['猫', '犬']);

    expect(statuses).toBeInstanceOf(Map);
    expect(statuses.size).toBe(0);
  });

  it('skips entirely (no API call) when checkForDuplicates is off', async () => {
    seedPreferences({
      connection: { ...CONNECTION_PREFS, checkForDuplicates: false },
    });
    const fetchMock = vi.fn(async () => ankiResponse([1]));
    global.fetch = fetchMock as unknown as typeof fetch;

    const statuses = await checkTermsForDuplicates(['猫']);

    expect(statuses.size).toBe(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('skips when no target deck is configured', async () => {
    seedPreferences({ miner: { ...MINER_PREFS, deck: null } });
    const fetchMock = vi.fn(async () => ankiResponse([1]));
    global.fetch = fetchMock as unknown as typeof fetch;

    const statuses = await checkTermsForDuplicates(['猫']);

    expect(statuses.size).toBe(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
