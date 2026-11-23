/**
 * Anki duplicate-check engine.
 * ---------------------------------------------------------------------------
 * Pure-logic helper that answers "does this term/expression already exist in
 * the collection?" before a new card is created. It mirrors Yomitan's
 * Card Management duplicate detection (duplicateScope + first-field query)
 * without any React / DOM dependency — the caller (e.g. the player mining
 * flow) supplies an AnkiConnect client that exposes `findNotes`.
 *
 * Scope semantics (matches Yomitan):
 *   - 'collection' → search every deck in the collection.
 *   - 'deck'       → constrain the search to the target deck.
 *   - 'deck-root'  → constrain the search to the target deck's ROOT (the
 *                    segment before the first '::'). A top-level deck is its
 *                    own root.
 *
 * The search field is the note's FIRST field (Yomitan's "expression"), which
 * callers pass in as `firstFieldName` (e.g. 'expression' | 'word'). Anki's
 * field-name search syntax is `"fieldName:value"`.
 * --------------------------------------------------------------------------- */

export type DuplicateScope = 'collection' | 'deck' | 'deck-root';

export interface DuplicateCheckOptions {
  /** Master switch: when false the check is skipped entirely. */
  checkForDuplicates: boolean;
  /** Which part of the collection the query is scoped to. */
  duplicateScope: DuplicateScope;
  /** Name of the note's first field (the searchable key), e.g. 'expression'. */
  firstFieldName: string;
  /** Target deck the new card would be added to. */
  deckName: string;
}

export interface DuplicateCheckResult {
  /** false when the check was skipped (checkForDuplicates === false). */
  checked: boolean;
  /** Existing note IDs already containing the term. Empty when none / skipped. */
  noteIds: number[];
  /** The generated AnkiConnect search query ('' when skipped). */
  query: string;
}

/** Minimal structural client the checker needs — keeps the helper testable. */
export interface DuplicateCheckClient {
  findNotes(query: string, signal?: AbortSignal): Promise<number[]>;
}

/**
 * Escape a term for safe embedding in an AnkiConnect search query. Anki's
 * query syntax treats double-quotes and backslashes specially, so both are
 * backslash-escaped.
 */
function escapeAnkiTerm(term: string): string {
  return term.replace(/["\\]/g, (ch) => `\\${ch}`);
}

/**
 * Reduce a full deck path to its root: the segment before the first '::'.
 * A top-level deck ('Japanese') is its own root. Deeper decks
 * ('Japanese::Core2k') reduce to 'Japanese'.
 */
function deckRoot(deckName: string): string {
  const idx = deckName.indexOf('::');
  return idx === -1 ? deckName : deckName.slice(0, idx);
}

/**
 * Build the AnkiConnect search query for the given scope + field + term.
 * Exported for tests so query construction can be asserted independently of
 * the network call.
 */
export function buildDuplicateQuery(
  term: string,
  options: DuplicateCheckOptions,
): string {
  const fieldQuery = `"${options.firstFieldName}:${escapeAnkiTerm(term)}"`;
  switch (options.duplicateScope) {
    case 'collection':
      return fieldQuery;
    case 'deck':
      return `deck:"${escapeAnkiTerm(options.deckName)}" ${fieldQuery}`;
    case 'deck-root':
      return `deck:"${escapeAnkiTerm(deckRoot(options.deckName))}" ${fieldQuery}`;
  }
}

/**
 * Check whether `term` already exists in Anki. Skips entirely (checked:false,
 * no API call) when duplicate checking is disabled. Empty results are
 * normalized to [] (findNotes must always yield an array — see the AnkiConnect
 * empty-result contract), never null.
 */
export async function checkForDuplicateNotes(
  client: DuplicateCheckClient,
  term: string,
  options: DuplicateCheckOptions,
  signal?: AbortSignal,
): Promise<DuplicateCheckResult> {
  if (!options.checkForDuplicates) {
    return { checked: false, noteIds: [], query: '' };
  }
  const query = buildDuplicateQuery(term, options);
  const result = await client.findNotes(query, signal);
  const noteIds = Array.isArray(result) ? result : [];
  return { checked: true, noteIds, query };
}
