/**
 * popup-lookup — what the preview card is made of.
 * ---------------------------------------------------------------------------
 * The preview always looks up ONE term at a time: upstream's own example word
 * (`POPUP_PREVIEW_TERM`) until the user types another one into the preview's own
 * field. It is not a dictionary search box — one term, one entry — it is the seam
 * between the settings tree, the term field and that single lookup.
 *
 * Two exports, because the two costs are wildly different:
 *
 * - `popupLookupKey` is the cheap change key for the EXPENSIVE half. A dictionary
 *   lookup crosses the Tauri IPC boundary and rebuilds the translator whenever the
 *   dictionary set changed, so it must not re-run while the user drags the
 *   font-size field.
 * - `lookupPopupEntries` is that expensive half: the entries plus the dictionary
 *   summaries the generator prints on its tags.
 *
 * Failures are the caller's to render: outside the desktop app there is no engine
 * to answer (`listInstalledDictionaries` rejects), which is the same state as "no
 * dictionary installed" and lands on the placeholder.
 * ---------------------------------------------------------------------------
 */

import type { Options } from '@gorakudo/yomitan-headless/settings';
import { listInstalledDictionariesCached } from '@/modules/yomitan/dictionary-store';
import { lookupTerms } from '@/modules/yomitan/yomitan-engine';
import {
  activeProfileOptions,
} from '@/modules/yomitan/yomitan-preferences';
import {
  POPUP_PREVIEW_TERM,
} from '@/modules/yomitan/popup-preview/popup-document';
import {
  toPopupDictionaryInfo,
  type PopupDictionaryInfo,
} from '@/modules/yomitan/popup-preview/popup-entries';

/** What the preview card is drawn from. */
export interface PopupPreviewEntries {
  /** The translator's own dictionary entries (empty when nothing matched). */
  entries: readonly unknown[];
  /** Per-dictionary summaries the generator prints on its dictionary tags. */
  dictionaries: readonly PopupDictionaryInfo[];
}

/**
 * The substring of the options a LOOKUP depends on.
 *
 * Only what `lookupTerms` actually reads is listed: the dictionary set (which is
 * also the priority order), the output mode and sort choices, and the text
 * handling that decides what counts as a match. Anything else — appearance
 * included — is answered from the already-resolved entries.
 */
export function popupLookupKey(options: Options): string {
  const profile = activeProfileOptions(options);
  const { general, scanning, translation, parsing } = profile;
  return JSON.stringify([
    profile.dictionaries,
    general.mainDictionary,
    general.language,
    general.resultOutputMode,
    general.sortFrequencyDictionary,
    general.sortFrequencyDictionaryOrder,
    general.maxResults,
    scanning.alphanumeric,
    scanning.layoutAwareScan,
    translation.searchResolution,
    translation.textReplacements,
    parsing.useAllFrequencyDictionaries,
  ]);
}

/**
 * The term a lookup actually runs for what the field currently holds.
 *
 * PURE, because both callers need it: the field debounces on it (an unchanged
 * resolution is not worth a timer) and the lookup runs it. An empty field is a
 * half-cleared edit, not a request to search for nothing — it falls back to
 * upstream's example word, which is also what the field shows as its placeholder.
 */
export function resolvePreviewTerm(term?: string): string {
  const trimmed = term?.trim() ?? '';
  return trimmed === '' ? POPUP_PREVIEW_TERM : trimmed;
}

/**
 * Look the preview term up in the currently active dictionary set.
 *
 * ONE result, unlike a scan: the card shows a single dictionary entry, which is
 * what a popup looks like for the word that was scanned. The options tree is not
 * an argument either — the lookup is answered from the PERSISTED one (`lookupTerms`
 * reads it, and every settings write persists before the renderer re-renders),
 * which is what makes `popupLookupKey` the whole re-run signal for this half.
 *
 * Rejects when the engine cannot be reached at all (a browser pass, or the Rust
 * plugin failing to start) — distinct from an empty result, which is a normal
 * answer the caller renders as the placeholder.
 */
export async function lookupPopupEntries(
  term?: string,
): Promise<PopupPreviewEntries> {
  const [entries, installed] = await Promise.all([
    lookupTerms(resolvePreviewTerm(term), { maxResults: 1 }),
    listInstalledDictionariesCached(),
  ]);
  return { entries, dictionaries: toPopupDictionaryInfo(installed) };
}