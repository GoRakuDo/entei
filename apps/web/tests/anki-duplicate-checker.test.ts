import { describe, expect, it, vi } from 'bun:test';
import {
  buildDuplicateQuery,
  checkForDuplicateNotes,
  type DuplicateCheckClient,
  type DuplicateCheckOptions,
} from '../src/modules/yomitan/anki/anki-duplicate-checker';

function makeOptions(
  overrides: Partial<DuplicateCheckOptions> = {},
): DuplicateCheckOptions {
  return {
    checkForDuplicates: true,
    duplicateScope: 'collection',
    firstFieldName: 'expression',
    deckName: 'Japanese::Core2k',
    ...overrides,
  };
}

function makeClient(noteIds: number[] | null = []) {
  const findNotes = vi.fn().mockResolvedValue(noteIds);
  const client: DuplicateCheckClient = { findNotes };
  return { client, findNotes };
}

describe('checkForDuplicateNotes', () => {
  it('skips the check entirely when disabled (no API call)', async () => {
    const { client, findNotes } = makeClient([1, 2, 3]);
    const result = await checkForDuplicateNotes(
      client,
      '猫',
      makeOptions({ checkForDuplicates: false }),
    );
    expect(result).toEqual({ checked: false, noteIds: [], query: '' });
    expect(findNotes).not.toHaveBeenCalled();
  });

  it('scopes the query to the whole collection when scope=collection', async () => {
    const { client, findNotes } = makeClient([10, 20]);
    const result = await checkForDuplicateNotes(
      client,
      '猫',
      makeOptions({ duplicateScope: 'collection' }),
    );
    expect(findNotes).toHaveBeenCalledWith('"expression:猫"', undefined);
    expect(result.checked).toBe(true);
    expect(result.noteIds).toEqual([10, 20]);
    expect(result.query).toBe('"expression:猫"');
  });

  it('scopes the query to the target deck when scope=deck', async () => {
    const { client, findNotes } = makeClient([]);
    const result = await checkForDuplicateNotes(
      client,
      '犬',
      makeOptions({ duplicateScope: 'deck', deckName: 'Japanese::Core2k' }),
    );
    expect(findNotes).toHaveBeenCalledWith(
      'deck:"Japanese::Core2k" "expression:犬"',
      undefined,
    );
    expect(result.noteIds).toEqual([]);
  });

  it('scopes the query to the deck ROOT when scope=deck-root', async () => {
    const { client, findNotes } = makeClient([42]);
    const result = await checkForDuplicateNotes(
      client,
      '鳥',
      makeOptions({ duplicateScope: 'deck-root', deckName: 'Japanese::Core2k' }),
    );
    expect(findNotes).toHaveBeenCalledWith(
      'deck:"Japanese" "expression:鳥"',
      undefined,
    );
    expect(result.noteIds).toEqual([42]);
  });

  it('treats a top-level deck as its own root for deck-root scope', async () => {
    const { client, findNotes } = makeClient([]);
    await checkForDuplicateNotes(
      client,
      '魚',
      makeOptions({ duplicateScope: 'deck-root', deckName: 'TopLevel' }),
    );
    expect(findNotes).toHaveBeenCalledWith(
      'deck:"TopLevel" "expression:魚"',
      undefined,
    );
  });

  it('normalizes a null findNotes result to an empty array', async () => {
    const { client } = makeClient(null);
    const result = await checkForDuplicateNotes(
      client,
      '猫',
      makeOptions({ duplicateScope: 'collection' }),
    );
    expect(result.checked).toBe(true);
    expect(result.noteIds).toEqual([]);
  });

  it('escapes double-quotes and backslashes in the search term', async () => {
    const { client, findNotes } = makeClient([]);
    await checkForDuplicateNotes(
      client,
      'he said "hi"\\there',
      makeOptions({ duplicateScope: 'collection' }),
    );
    expect(findNotes).toHaveBeenCalledWith(
      '"expression:he said \\"hi\\"\\\\there"',
      undefined,
    );
  });

  it('uses the caller-supplied first field name in the query', () => {
    const query = buildDuplicateQuery(
      '走る',
      makeOptions({ firstFieldName: 'word', duplicateScope: 'collection' }),
    );
    expect(query).toBe('"word:走る"');
  });

  it('searches the bare term without a field prefix when checkAllModels is on', async () => {
    const { client, findNotes } = makeClient([7]);
    const result = await checkForDuplicateNotes(
      client,
      '猫',
      makeOptions({ checkAllModels: true }),
    );
    expect(findNotes).toHaveBeenCalledWith('"猫"', undefined);
    expect(result.noteIds).toEqual([7]);
  });

  it('forwards an abort signal to findNotes', async () => {
    const findNotes = vi.fn().mockResolvedValue([]);
    const client: DuplicateCheckClient = { findNotes };
    const controller = new AbortController();
    await checkForDuplicateNotes(
      client,
      '猫',
      makeOptions({ duplicateScope: 'collection' }),
      controller.signal,
    );
    expect(findNotes).toHaveBeenCalledWith('"expression:猫"', controller.signal);
  });
});
