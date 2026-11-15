/**
 * popup-scanned — the floating popup's own inputs: the scan it came from.
 * ---------------------------------------------------------------------------
 * `popup-card` draws one history entry for ANY host. This is the other half: the
 * bits that are specific to the popup that opens beside a scanned word.
 *
 * Three of them, and only three:
 *
 * - `hasScannedEntries` decides whether a frame opens at all. A scan that found
 *   nothing must not open one — the document's own "no dictionaries" placeholder
 *   would be the wrong message for a miss.
 * - `createScannedPopupHistory` is the stack a scan starts: one entry, either the
 *   term the scanner matched or the single character it scanned. Everything after
 *   that (a kanji clicked in a headword, `<` and `>`) belongs to `popup-history`
 *   and is host-independent.
 * - `resolveScannedPopupFrame` is the frame ELEMENT's box and shadow, resolved from
 *   the same options tree the document's own appearance comes from, so the two can
 *   never disagree.
 * ---------------------------------------------------------------------------
 */

import type { Options } from '@gorakudo/yomitan-headless/settings';
import {
  resolvePopupAppearance,
  type ResolvedPopupOuterTheme,
} from '@/modules/yomitan/popup-preview';
import { createPopupHistory, type PopupHistoryState } from '@/modules/yomitan/popup-preview/popup-history';
import type { YomitanScanResultDetail } from '@/modules/yomitan/text-scanner';

/**
 * True when the scan found something a popup can draw.
 *
 * PURE and exported so the host can decide to open on the same condition that
 * decides to render — a popup frame with no entries would draw Yomitan's own
 * "no dictionaries" placeholder, which is the wrong message for a scan that
 * simply missed.
 */
export function hasScannedEntries(detail: YomitanScanResultDetail): boolean {
  return detail.entries.length > 0 || detail.kanjiEntries.length > 0;
}

/**
 * The history a scan starts: the one lookup the scanner already performed.
 *
 * The scanner runs BOTH lookups on the same window of text, so its first card is
 * the combined one (`scan`): the term entries with whatever kanji cards came back
 * underneath. A kanji-ONLY scan starts on the kanji card, because that character IS
 * what was matched. Nothing is looked up here: the entries travel with the scan.
 */
export function createScannedPopupHistory(
  detail: YomitanScanResultDetail,
): PopupHistoryState {
  const hasTerms = detail.entries.length > 0;
  const hasKanji = detail.kanjiEntries.length > 0;
  const mode = hasTerms ? (hasKanji ? 'scan' : 'term') : 'kanji';
  return createPopupHistory({ mode, query: detail.text.trim() });
}

/**
 * The popup FRAME's box and outer theme for the user's Position & Size +
 * Shadow settings.
 *
 * Resolved here (not read off `resolvePopupAppearance` by the host) so the frame
 * element and the document inside it come from one resolution: the element's box
 * and its `data-outer-theme` can never disagree with the document's own
 * `data-outer-theme`.
 */
export function resolveScannedPopupFrame(options: Options): {
  size: { width: number; height: number };
  outerTheme: ResolvedPopupOuterTheme;
} {
  const appearance = resolvePopupAppearance(options);
  return { size: appearance.size, outerTheme: appearance.resolvedOuterTheme };
}