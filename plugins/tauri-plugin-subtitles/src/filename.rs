//! Media filename parsing.
//!
//! This is a line-by-line port of the TypeScript implementation that used to
//! run on the browser main thread:
//! `apps/web/src/features/player/filename-parser.ts`.
//!
//! The TypeScript file is defined by a set of regular expressions, so the
//! same expressions are used here — with two deliberate adjustments:
//!
//! - `\d` becomes `[0-9]`, because JavaScript's `\d` is ASCII-only while
//!   Rust's `\d` also matches Unicode digits;
//! - `\b` becomes an explicit ASCII word-boundary look-around
//!   (`(?<![A-Za-z0-9_])` / `(?![A-Za-z0-9_])`), because JavaScript's `\b`
//!   is ASCII-only while Rust's `\b` is Unicode-aware.
//!
//! `fancy-regex` is used instead of `regex` because two expressions need
//! look-around, which the linear-time `regex` crate does not support.

use fancy_regex::Regex;
use serde::{Deserialize, Serialize};
use std::sync::OnceLock;

/// Title and episode extracted from a media file name.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
pub struct ParsedMediaName {
    /// Cleaned title, or an empty string when the name carries no title.
    pub title: String,
    /// Episode number, or `None` when the name carries no episode marker.
    pub episode: Option<u32>,
}

/// The release-tag vocabulary shared by the bare quality tags and the whole
/// release-info parentheses, so the two cleanup steps cannot drift apart.
const QUALITY_TAGS: &str = concat!(
    r"1080p?|720p?|480p?|2160p?|4k|HEVC|WEB-?DL|WEBRip|Blu-?Ray|BDRip|BRRip|BD|UHD|",
    r"Remux|HDR(?:10)?|DV|SDR|x26[45]|H\.?26[45]|10-?bit|8-?bit|Ma10p|AVC|AAC|FLAC|",
    r"DVD(?:Rip)?|HDTV"
);

/// JavaScript `\b` → ASCII word boundary.
const WORD_BEFORE: &str = r"(?<![A-Za-z0-9_])";
/// JavaScript `\b` → ASCII word boundary.
const WORD_AFTER: &str = r"(?![A-Za-z0-9_])";

fn extension_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"(?i)\.[a-z0-9]{2,4}$").expect("extension regex"))
}

fn bracket_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"\[[^\]]*\]").expect("bracket regex"))
}

fn paren_year_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"\([0-9]{4}\)|（[0-9]{4}）|\([0-9]{4}-\)").expect("year regex"))
}

fn quality_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        Regex::new(&format!(
            r"(?i){WORD_BEFORE}(?:{QUALITY_TAGS}){WORD_AFTER}"
        ))
        .expect("quality regex")
    })
}

fn paren_tag_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        Regex::new(&format!(
            r"(?i)\((?:[^()]*{WORD_BEFORE}(?:{QUALITY_TAGS}){WORD_AFTER}[^()]*)\)|（(?:[^（）]*{WORD_BEFORE}(?:{QUALITY_TAGS}){WORD_AFTER}[^（）]*)）"
        ))
        .expect("paren tag regex")
    })
}

fn empty_paren_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        Regex::new(r"\([^()\p{L}\p{N}]*\)|（[^（）\p{L}\p{N}]*）").expect("empty paren regex")
    })
}

fn separator_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"[._]+").expect("separator regex"))
}

fn whitespace_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"\s+").expect("whitespace regex"))
}

fn trailing_separator_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    // The dash is escaped: in JavaScript `/[\s-–]+$/` keeps the dash literal,
    // while the Rust regex crate would read it as a character range.
    RE.get_or_init(|| Regex::new(r"[\s\-–]+$").expect("trailing separator regex"))
}

fn context_folder_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        Regex::new(r"(?i)^(?:s(?:eason|eries)?[\s._-]*[0-9]+|the[\s._-]+movie|movie)$")
            .expect("context folder regex")
    })
}

/// Episode markers, in priority order (first match wins).
fn episode_patterns() -> &'static [Regex] {
    static RE: OnceLock<Vec<Regex>> = OnceLock::new();
    RE.get_or_init(|| {
        vec![
            // EP01 / E01 / S01E01
            //   ^ negative lookbehind: the marker must NOT sit right after a
            //     letter, so "Movie 2024" no longer yields "e 202".
            Regex::new(r"(?i)(?<![A-Za-z])(?:S[0-9]{1,2})?[Ee][Pp]?\s*([0-9]{1,3})")
                .expect("episode pattern 1"),
            // 1x01 → group 2 is the episode
            Regex::new(r"(?i)([0-9]{1,2})x([0-9]{1,3})").expect("episode pattern 2"),
            // 第1話
            Regex::new(r"第\s*([0-9]{1,3})\s*話").expect("episode pattern 3"),
        ]
    })
}

/// Bare standalone number ("Title 01", "One Piece - 1099"). The 1–4 digit cap
/// keeps "1099" while `is_year` below drops real years like "2024".
fn bare_number_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"(?<=\s|-|–)([0-9]{1,4})(?=\s|$)").expect("bare number regex"))
}

/// Parse a media file name into `{ title, episode }`.
pub fn parse_filename(filename: &str) -> ParsedMediaName {
    if filename.trim().is_empty() {
        return ParsedMediaName {
            title: String::new(),
            episode: None,
        };
    }

    // Browser `File.name` is normally a basename, but Magnet handoffs and
    // tests may provide a full path. Parse the basename for the query while
    // leaving the original path available to the auto-loader as variant
    // context.
    let path_parts: Vec<&str> = filename
        .split(['/', '\\'])
        .filter(|part| !part.is_empty())
        .collect();
    let raw_name = path_parts.last().copied().unwrap_or(filename);
    let name = normalize_media_name(raw_name);
    if name.is_empty() {
        return ParsedMediaName {
            title: String::new(),
            episode: None,
        };
    }

    let episode_match = find_episode_match(&name);
    let episode = episode_match.as_ref().map(|found| found.episode);
    let mut title = extract_title(&name, episode_match.as_ref());

    // For paths such as `K-ON!/Season 2/01.mkv`, the episode-only basename
    // has no title. Use the nearest meaningful parent folder, but do not turn
    // `Season 2` / `The Movie` into the search query; the caller uses the
    // full path to disambiguate that variant.
    if title.is_empty() && path_parts.len() > 1 {
        for part in path_parts[..path_parts.len() - 1].iter().rev() {
            let parent = normalize_media_name(part);
            if !parent.is_empty() && !is_context_folder(&parent) {
                title = parent;
                break;
            }
        }
    }

    ParsedMediaName { title, episode }
}

/// A 4-digit number in 1900–2099 reads as a year, not an episode.
fn is_year(value: u32) -> bool {
    (1900..=2099).contains(&value)
}

fn strip_extension(name: &str) -> String {
    match extension_re().find(name) {
        Ok(Some(found)) => name[..found.start()].to_string(),
        _ => name.to_string(),
    }
}

fn normalize_media_name(raw_name: &str) -> String {
    let mut name = strip_extension(raw_name);
    name = replace_all(bracket_re(), &name, " "); // [SubGroup] [1080p] …
    name = replace_all(paren_year_re(), &name, " "); // (2024)
    name = replace_all(paren_tag_re(), &name, " "); // (BD 1080p) / (UHD Remux)
    name = replace_all(quality_re(), &name, " "); // bare 1080p / 720p / WEB-DL …
    name = replace_all(empty_paren_re(), &name, " "); // leftover ( )
    name = replace_all(separator_re(), &name, " "); // . _ → space
    replace_all(whitespace_re(), &name, " ").trim().to_string()
}

fn is_context_folder(name: &str) -> bool {
    context_folder_re()
        .is_match(name.trim())
        .unwrap_or(false)
}

struct EpisodeMatch {
    episode: u32,
    /// Byte offset of the marker inside the normalized name.
    index: usize,
}

/// Locate the episode number and its position in `name`.
///
/// E-marker / season+episode patterns win by first match (priority order); a
/// bare standalone number falls back to the LAST token so "Frieren Season 2
/// - 05" yields 05 (the episode), not 2 (the season).
///
/// Years (1900–2099) are never episodes.
fn find_episode_match(name: &str) -> Option<EpisodeMatch> {
    for pattern in episode_patterns() {
        let Ok(Some(captures)) = pattern.captures(name) else {
            continue;
        };
        // 1x01 style: group 2 (episode) wins over group 1 (season).
        let raw = captures
            .get(2)
            .or_else(|| captures.get(1))
            .map(|found| found.as_str().to_string())
            .or_else(|| captures.get(0).map(|found| found.as_str().to_string()))
            .unwrap_or_default();
        let Some(number) = parse_int(&raw) else {
            continue;
        };
        if is_year(number) {
            continue;
        }
        return Some(EpisodeMatch {
            episode: number,
            index: captures.get(0).map(|found| found.start()).unwrap_or(0),
        });
    }

    let mut last: Option<EpisodeMatch> = None;
    for found in bare_number_re().find_iter(name).flatten() {
        let Some(number) = parse_int(found.as_str()) else {
            continue;
        };
        if is_year(number) {
            continue;
        }
        last = Some(EpisodeMatch {
            episode: number,
            index: found.start(),
        });
    }
    last
}

/// Extract the title portion before the episode marker.
fn extract_title(name: &str, episode_match: Option<&EpisodeMatch>) -> String {
    let mut name = name.to_string();
    if let Some(found) = episode_match {
        // Cut before the matched episode marker (EP/E/第n話/SxxExx/1xnn/bare
        // number). Using the same match as `find_episode_match` keeps title
        // and episode consistent (e.g. "Frieren Season 2 - 05" → title keeps
        // "Season 2 -").
        if found.index > 0 {
            name = name[..found.index].to_string();
        }
    }
    // Trim trailing separators (dashes etc.) left by the episode cut.
    replace_all(trailing_separator_re(), &name, "")
        .trim()
        .to_string()
}

/// `Number.parseInt(text, 10)`.
fn parse_int(text: &str) -> Option<u32> {
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return None;
    }
    trimmed.parse::<u32>().ok()
}

/// `String.prototype.replace` with a global regular expression.
fn replace_all(regex: &Regex, text: &str, replacement: &str) -> String {
    match regex.try_replacen(text, 0, replacement) {
        Ok(replaced) => replaced.into_owned(),
        // A backtracking limit can only be hit by a pathological input; keep
        // the text unchanged instead of failing the whole parse.
        Err(_) => text.to_string(),
    }
}
