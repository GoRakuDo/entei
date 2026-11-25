/**
Anki marker definitions (Yomitan-compatible).
---------------------------------------------------------------------------
Mirrors Yomitan's `getStandardFieldMarkers(type, 'ja')` from
`ext/js/data/anki-template-util.js`.

Used by /settings/ Anki Field Profiles card to render the marker
selection dropdown beside each Field Value input.

Entei extends Yomitan's Japanese set with the player-captured media
markers `sentence-audio` (subtitle cue audio) and `video` (mined video
clip), both resolved through the player's own inline templates.

Markers are Handlebars field markers: `{expression}`, `{reading}`,
`{glossary}`, etc. — inserted into field templates to tell AnkiConnect
which captured data goes into which note field.

Source: D:/GitHub/yomitan/ext/js/data/anki-template-util.js
(verified 2026-11-13).
---------------------------------------------------------------------------
 */

/** Note card kind. */
export type AnkiMarkerType = 'term' | 'kanji';

/** Term (word) card markers — sorted alphabetically. */
export const TERM_FIELD_MARKERS: readonly string[] = [
  'audio',
  'clipboard-image',
  'clipboard-text',
  'cloze-body',
  'cloze-body-kana',
  'cloze-prefix',
  'cloze-suffix',
  'conjugation',
  'dictionary',
  'dictionary-alias',
  'document-title',
  'expression',
  'frequencies',
  'frequency-average-occurrence',
  'frequency-average-rank',
  'frequency-harmonic-occurrence',
  'frequency-harmonic-rank',
  'furigana',
  'furigana-plain',
  'glossary',
  'glossary-brief',
  'glossary-first',
  'glossary-first-brief',
  'glossary-first-no-dictionary',
  'glossary-no-dictionary',
  'glossary-plain',
  'glossary-plain-no-dictionary',
  'part-of-speech',
  'phonetic-transcriptions',
  'pitch-accent-categories',
  'pitch-accent-graphs',
  'pitch-accent-graphs-jj',
  'pitch-accent-positions',
  'pitch-accents',
  'popup-selection-text',
  'reading',
  'screenshot',
  'search-query',
  'sentence',
  'sentence-audio',
  'sentence-furigana',
  'sentence-furigana-plain',
  'tags',
  'url',
  'url-plain',
  'video',
] as const;

/** Kanji (character) card markers — sorted alphabetically. */
export const KANJI_FIELD_MARKERS: readonly string[] = [
  'character',
  'clipboard-image',
  'clipboard-text',
  'cloze-body',
  'cloze-prefix',
  'cloze-suffix',
  'dictionary',
  'dictionary-alias',
  'document-title',
  'frequencies',
  'frequency-average-occurrence',
  'frequency-average-rank',
  'frequency-harmonic-occurrence',
  'frequency-harmonic-rank',
  'glossary',
  'kunyomi',
  'onyomi',
  'onyomi-hiragana',
  'popup-selection-text',
  'screenshot',
  'search-query',
  'sentence',
  'sentence-audio',
  'sentence-furigana',
  'sentence-furigana-plain',
  'stroke-count',
  'tags',
  'url',
  'url-plain',
  'video',
] as const;

/**
 * Returns all standard field markers for the given card kind.
 * Mirrors Yomitan `getStandardFieldMarkers(type, 'ja')`.
 *
 * @param type Card kind ('term' or 'kanji').
 * @returns Sorted marker name list (without braces).
 */
export function getStandardFieldMarkers(type: AnkiMarkerType): readonly string[] {
  return type === 'kanji' ? KANJI_FIELD_MARKERS : TERM_FIELD_MARKERS;
}

/**
 * Wraps a marker name in Handlebars braces: `'expression'` → `'{expression}'`.
 *
 * @param marker Marker name without braces.
 * @returns `{marker}` string.
 */
export function wrapMarker(marker: string): string {
  return `{${marker}}`;
}
