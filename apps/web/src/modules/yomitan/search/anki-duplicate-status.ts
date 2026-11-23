/**
 * anki-duplicate-status — shared duplicate-check for the Yomitan search page and
 * the floating popup.
 * ---------------------------------------------------------------------------
 * Both the `/search/` page and the floating popup draw Yomitan's own definition
 * cards, and both want the same thing: a small marker on each card saying
 * whether that headword ALREADY exists in the user's Anki collection (Yomitan's
 * Card Management duplicate detection), so the user does not mine a word they
 * already have.
 *
 * This is the ONE helper both surfaces call. It reads the user's own Anki
 * Connection + Anki Miner settings (the same settings the player mining flow
 * honours), runs `checkForDuplicateNotes` per unique headword over AnkiConnect,
 * and returns a `term → hasDuplicate` map the caller turns into card icons.
 *
 * FAIL-SOFT, ALWAYS. A duplicate check is a nice-to-have: Anki being closed, the
 * connection being down, a bad setting, or a slow query must never break card
 * rendering. Every failure path returns an empty map (no markers drawn) and
 * swallows the error — the caller draws the cards exactly as it would have
 * without this module. A per-term failure simply omits that term, so one bad
 * query never costs the others their marker.
 * --------------------------------------------------------------------------- */

import { AnkiConnectClient } from '@/features/player/anki-connect';
import { readAnkiConnectionPreferences } from '@/features/player/anki-connection-preferences';
import { readAnkiMinerPreferences } from '@/features/player/anki-miner-preferences';
import { checkForDuplicateNotes } from '@/modules/yomitan/anki/anki-duplicate-checker';

/**
 * Check each term for an existing Anki note and report which already exist.
 *
 * @param terms  The headwords to check (duplicates are de-duplicated; blank
 *               entries are ignored).
 * @param signal Optional abort signal — aborted checks resolve rather than
 *               reject, so a cancelled pass never throws at the caller.
 * @returns A map from each checked term to whether a duplicate exists. Empty
 *          when the check is disabled, no target deck is configured, or anything
 *          went wrong (fail-soft).
 */
export async function checkTermsForDuplicates(
  terms: readonly string[],
  signal?: AbortSignal,
): Promise<Map<string, boolean>> {
  /** Empty = "draw no markers". The single return shape for every skip / failure. */
  const statuses = new Map<string, boolean>();
  try {
    const connection = readAnkiConnectionPreferences();
    if (!connection.checkForDuplicates) return statuses;

    const miner = readAnkiMinerPreferences();
    const deckName = miner.deck;
    if (deckName === null || deckName.trim() === '') return statuses;

    // The searchable key is the note's expression/word field. The miner maps a
    // `word` field; fall back to Yomitan's own 'expression' convention when the
    // user has not mapped one.
    const firstFieldName =
      miner.fields.word !== null && miner.fields.word.trim() !== ''
        ? miner.fields.word
        : 'expression';

    const client = new AnkiConnectClient(
      connection.server,
      connection.apiKey.trim() !== '' ? connection.apiKey : undefined,
    );
    const options = {
      checkForDuplicates: true,
      duplicateScope: connection.duplicateScope,
      firstFieldName,
      checkAllModels: connection.checkAllModels,
      deckName,
    };

    const uniqueTerms = [...new Set(terms)].filter(
      (term) => term.trim() !== '',
    );
    await Promise.all(
      uniqueTerms.map(async (term) => {
        try {
          const result = await checkForDuplicateNotes(
            client,
            term,
            options,
            signal,
          );
          // Omit on a per-term failure so one bad query never costs the rest.
          statuses.set(term, result.noteIds.length > 0);
        } catch {
          /* fail-soft: this term gets no marker. */
        }
      }),
    );
  } catch {
    // Reading settings / building the client failed: no markers at all.
    return new Map<string, boolean>();
  }
  return statuses;
}
