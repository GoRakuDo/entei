//! Media filename parser tests.
//!
//! Ported one-to-one from the TypeScript suite that guarded the browser
//! implementation: `apps/web/tests/filename-parser.test.ts`.

use tauri_plugin_subtitles::parse_filename;

#[test]
fn parses_the_documented_magicstar_example() {
    let parsed = parse_filename(
        "[MagicStar] Meitantei no Mama de Ite EP01 [WEBDL] [1080p] [TELASA] [JPN_SUB]",
    );
    assert_eq!(parsed.title, "Meitantei no Mama de Ite");
    assert_eq!(parsed.episode, Some(1));
}

#[test]
fn parses_a_bare_title_without_episode() {
    let parsed = parse_filename("Sousou no Frieren 1080p.mkv");
    assert_eq!(parsed.title, "Sousou no Frieren");
    assert_eq!(parsed.episode, None);
}

#[test]
fn handles_s01e01_season_and_episode() {
    let parsed = parse_filename("Show Name S01E03 1080p.mkv");
    assert_eq!(parsed.title, "Show Name");
    assert_eq!(parsed.episode, Some(3));
}

#[test]
fn handles_1x01_season_and_episode() {
    let parsed = parse_filename("Title - 1x04 - WEB.mkv");
    assert_eq!(parsed.title, "Title");
    assert_eq!(parsed.episode, Some(4));
}

#[test]
fn handles_bare_e01() {
    let parsed = parse_filename("Anime E12.mkv");
    assert_eq!(parsed.title, "Anime");
    assert_eq!(parsed.episode, Some(12));
}

#[test]
fn handles_japanese_episode_marker() {
    let parsed = parse_filename("葬送のフリーレン 第2話.mkv");
    assert_eq!(parsed.title, "葬送のフリーレン");
    assert_eq!(parsed.episode, Some(2));
}

#[test]
fn removes_year_tags_and_normalizes_dots_and_underscores() {
    let parsed = parse_filename("Kekkon_Surutte_Masaka (2024) EP05.mkv");
    assert_eq!(parsed.title, "Kekkon Surutte Masaka");
    assert_eq!(parsed.episode, Some(5));
}

#[test]
fn strips_multiple_bracket_tags() {
    let parsed = parse_filename("[Sub] Title E07 [HEVC] [JPN_SUB].mp4");
    assert_eq!(parsed.title, "Title");
    assert_eq!(parsed.episode, Some(7));
}

#[test]
fn returns_empty_title_for_a_tag_only_name() {
    let parsed = parse_filename("[1080p] [HEVC].mkv");
    assert_eq!(parsed.title, "");
    assert_eq!(parsed.episode, None);
}

#[test]
fn returns_empty_for_an_empty_input() {
    let parsed = parse_filename("");
    assert_eq!(parsed.title, "");
    assert_eq!(parsed.episode, None);

    let parsed = parse_filename("   ");
    assert_eq!(parsed.title, "");
    assert_eq!(parsed.episode, None);
}

#[test]
fn a_year_is_not_an_episode() {
    let parsed = parse_filename("Movie 2024 The Beginning.mkv");
    assert_eq!(parsed.title, "Movie 2024 The Beginning");
    assert_eq!(parsed.episode, None);
}

#[test]
fn uses_the_last_standalone_token_as_the_episode() {
    let parsed = parse_filename("Frieren Season 2 - 05.mkv");
    assert_eq!(parsed.title, "Frieren Season 2");
    assert_eq!(parsed.episode, Some(5));
}

#[test]
fn keeps_a_four_digit_bare_number() {
    let parsed = parse_filename("One Piece - 1099.mp4");
    assert_eq!(parsed.title, "One Piece");
    assert_eq!(parsed.episode, Some(1099));
}

#[test]
fn parses_the_subsplease_example() {
    let parsed = parse_filename("[SubsPlease] Sousou no Frieren - 01 (1080p) [HEVC].mkv");
    assert_eq!(parsed.title, "Sousou no Frieren");
    assert_eq!(parsed.episode, Some(1));
}

#[test]
fn keeps_a_title_from_a_full_path() {
    let parsed = parse_filename("D:/Anime/K-ON!!/Season 2/K-ON!! - 01.mkv");
    assert_eq!(parsed.title, "K-ON!!");
    assert_eq!(parsed.episode, Some(1));
}

#[test]
fn parses_a_movie_title_from_a_full_path() {
    let parsed = parse_filename("D:/Anime/K-ON!/The Movie/K-ON! the Movie.mkv");
    assert_eq!(parsed.title, "K-ON! the Movie");
    assert_eq!(parsed.episode, None);
}

#[test]
fn strips_bd_1080p_release_tags() {
    let parsed = parse_filename("[MegaMT80] Kimi no Na wa. (2016) (BD 1080p) [0E49A996].mkv");
    assert_eq!(parsed.title, "Kimi no Na wa");
    assert_eq!(parsed.episode, None);
}

#[test]
fn strips_uhd_remux_bdrip_tags_and_separator_only_parentheses() {
    let parsed = parse_filename("Kimi no Na wa. (2016) (UHD BDRip Remux).mkv");
    assert_eq!(parsed.title, "Kimi no Na wa");
    assert_eq!(parsed.episode, None);

    let parsed = parse_filename("Title (BD-1080p x265).mkv");
    assert_eq!(parsed.title, "Title");
    assert_eq!(parsed.episode, None);
}

#[test]
fn drops_a_whole_release_info_paren_with_extra_tags() {
    let parsed = parse_filename("Kimi no Na wa. (2016) (BD 1080p JPN).mkv");
    assert_eq!(parsed.title, "Kimi no Na wa");
    assert_eq!(parsed.episode, None);
}

#[test]
fn strips_a_release_info_paren_that_only_holds_separators() {
    let parsed = parse_filename("Title ( ).mkv");
    assert_eq!(parsed.title, "Title");
    assert_eq!(parsed.episode, None);
}

#[test]
fn keeps_a_paren_without_a_known_quality_tag() {
    // A parenthesis group with no known release tag is title text.
    let parsed = parse_filename("Movie (Director Cut).mkv");
    assert_eq!(parsed.title, "Movie (Director Cut)");
    assert_eq!(parsed.episode, None);
}
