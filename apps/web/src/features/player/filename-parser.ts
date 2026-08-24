/**
 * filename-parser — extract a media file name into { title, episode }.
 * ---------------------------------------------------------------------------
 * Follows the SubMiner/jimaku conventions (docs/JIMAKU_SUBS.md §7.1):
 *  - strips bracket tags ([SubGroup], [1080p], [HEVC], [JPN_SUB]…)
 *  - strips year tags ((2024)…)
 *  - normalizes EP notation (EP01 / E01 / S01E01 / 1x01 / 第1話 / Title 01)
 *  - strips the extension, normalizes . _ - into spaces
 *  - title is the part before the episode marker, trimmed
 * ---------------------------------------------------------------------------
 */

export interface ParsedMediaName {
  title: string;
  episode: number | null;
}

const EXTENSION_RE = /\.[a-z0-9]{2,4}$/i;
const BRACKET_RE = /\[[^\]]*\]/g;
const PAREN_YEAR_RE = /\(\d{4}\)|（\d{4}）|\(\d{4}-\)/g;
const QUALITY_RE = /\b(?:1080p?|720p?|480p?|2160p?|4k|HEVC|WEB-?DL|WEBRip|BluRay|BDrip)\b/gi;
const SEPARATOR_RE = /[._]+/g;
const WHITESPACE_RE = /\s+/g;

/** Episode markers, in priority order (first match wins). */
const EPISODE_PATTERNS: RegExp[] = [
  /(?<![A-Za-z])(?:S\d{1,2})?[Ee][Pp]?\s*(\d{1,3})/i, // EP01 / E01 / S01E01
  //   ^ negative lookbehind: the marker must NOT sit right after a letter,
  //     so "Movie 2024" no longer yields "e 202" (the "e" in Movie is
  //     preceded by a letter). "Anime E12" / "S01E03" still match because
  //     the marker follows a space or a digit (the match starts at the
  //     optional S, so the digit before E in "S01E03" is fine).
  /(\d{1,2})x(\d{1,3})/i, // 1x01 → group 2 is the episode
  /第\s*(\d{1,3})\s*話/, // 第1話
];

// Bare standalone number ("Title 01", "One Piece - 1099"). Global so we can
// pick the LAST token; the 1–4 digit cap keeps "1099" while isYear() below
// drops real years like "2024".
const BARE_NUMBER_RE = /(?<=\s|-|–)\d{1,4}(?=\s|$)/g;

/** A 4-digit number in 1900–2099 reads as a year, not an episode. */
function isYear(n: number): boolean {
  return n >= 1900 && n <= 2099;
}

function stripExtension(name: string): string {
  return name.replace(EXTENSION_RE, '');
}

interface EpisodeMatch {
  episode: number;
  index: number;
}

/**
 * Locate the episode number and its position in `name`.
 * E-marker / season+episode patterns win by first match (priority order); a
 * bare standalone number falls back to the LAST token so "Frieren Season 2
 * - 05" yields 05 (the episode), not 2 (the season). Years (1900–2099) are
 * never episodes.
 */
function findEpisodeMatch(name: string): EpisodeMatch | null {
  for (const re of EPISODE_PATTERNS) {
    const m = re.exec(name);
    if (!m) continue;
    // 1x01 style: group 2 (episode) wins over group 1 (season).
    const num = m[2] ?? m[1] ?? m[0];
    const n = Number.parseInt(num, 10);
    if (Number.isFinite(n) && !isYear(n)) {
      return { episode: n, index: m.index ?? 0 };
    }
  }
  const matches = [...name.matchAll(BARE_NUMBER_RE)];
  for (let i = matches.length - 1; i >= 0; i--) {
    const m = matches[i]!;
    const n = Number.parseInt(m[0], 10);
    if (Number.isFinite(n) && !isYear(n)) {
      return { episode: n, index: m.index ?? 0 };
    }
  }
  return null;
}

function findEpisode(name: string): number | null {
  return findEpisodeMatch(name)?.episode ?? null;
}

/** Extract the title portion before the episode marker. */
function extractTitle(name: string, episode: number | null): string {
  if (episode !== null) {
    // Cut before the matched episode marker (EP/E/第n話/SxxExx/1xnn/bare
    // number). Using the same match as findEpisode keeps title + episode
    // consistent (e.g. "Frieren Season 2 - 05" → title keeps "Season 2 -").
    const match = findEpisodeMatch(name);
    if (match && match.index > 0) name = name.slice(0, match.index);
  }
  // Trim trailing separators (dashes etc.) left by the episode cut.
  return name.replace(/[\s-–]+$/g, '').trim();
}

/** Parse a media file name into { title, episode }. */
export function parseMediaFileName(filename: string): ParsedMediaName {
  if (typeof filename !== 'string' || filename.trim() === '') {
    return { title: '', episode: null };
  }
  let name = stripExtension(filename);
  name = name.replace(BRACKET_RE, ' '); // [SubGroup] [1080p] …
  name = name.replace(PAREN_YEAR_RE, ' '); // (2024)
  name = name.replace(QUALITY_RE, ' '); // bare 1080p / 720p / WEB-DL …
  name = name.replace(SEPARATOR_RE, ' '); // . _ → space
  name = name.replace(WHITESPACE_RE, ' ').trim();
  if (name === '') return { title: '', episode: null };
  const episode = findEpisode(name);
  const title = extractTitle(name, episode);
  return { title, episode };
}
