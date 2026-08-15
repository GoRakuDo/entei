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
  /(?:S\d{1,2})?[Ee][Pp]?\s*(\d{1,3})/i, // EP01 / E01 / S01E01
  /(\d{1,2})x(\d{1,3})/i, // 1x01 → group 2 is the episode
  /第\s*(\d{1,3})\s*話/, // 第1話
  /(?<=\s|-|–)\d{1,2}(?=\s|$)/, // bare 01 as a standalone token (Title 01)
];

function stripExtension(name: string): string {
  return name.replace(EXTENSION_RE, '');
}

function findEpisode(name: string): number | null {
  for (const re of EPISODE_PATTERNS) {
    const m = re.exec(name);
    if (!m) continue;
    // 1x01 style: group 2 (episode) wins over group 1 (season).
    const num = m[2] ?? m[1] ?? m[0];
    const n = Number.parseInt(num, 10);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

/** Extract the title portion before the episode marker. */
function extractTitle(name: string, episode: number | null): string {
  if (episode !== null) {
    // Cut before the first episode marker (EP/E/第n話/SxxExx/nxxn/bare number).
    const cut = name.search(
      /\d{1,2}x\d{1,3}|(?:S\d{1,2})?[Ee][Pp]?\s*\d{1,3}|第\s*\d{1,3}\s*話|(?<=\s|-|–)\d{1,2}(?=\s|$)/i,
    );
    if (cut > 0) name = name.slice(0, cut);
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
