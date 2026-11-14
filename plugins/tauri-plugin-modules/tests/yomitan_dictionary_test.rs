//! Yomitan dictionary import/lookup engine, exercised against an in-memory
//! database (plus one on-disk round trip for the path-based import used by the
//! Tauri command).
//!
//! The fixture ZIP is built in memory with the `zip` writer, mirroring the layout
//! of a real Yomitan dictionary: nested folder, `index.json`, `term_bank_*.json`,
//! `kanji_bank_*.json`, `term_meta_bank_*.json`, `tag_bank_*.json`.

use std::io::{Cursor, Write};

use serde_json::json;
use tauri_plugin_modules::yomitan::{self, DATABASE_FILE_NAME};
use zip::write::SimpleFileOptions;
use zip::{CompressionMethod, ZipWriter};

/// A minimal but format-complete dictionary: two term banks (array and object
/// entry forms, a reading lookup, a null reading), one kanji bank, one meta bank
/// and one tag bank.
fn build_dictionary_zip() -> Vec<u8> {
    let mut zip = ZipWriter::new(Cursor::new(Vec::new()));
    let options = SimpleFileOptions::default().compression_method(CompressionMethod::Deflated);

    let index = json!({
        "title": "Test Dictionary",
        "format": 3,
        "revision": "test-1",
        "sequenced": true,
        "author": "GoRakuDo",
        "url": "https://example.invalid/dict",
        "description": "fixture dictionary",
    });
    // Multi-line so the reader has to skip whitespace before the first element.
    let term_bank_1 = json!([
        [
            "食べる",
            "たべる",
            "v1 vt",
            "v1",
            100,
            ["to eat"],
            1001,
            "common"
        ],
        ["食う", "くう", "", "v5u vt", 50, "to eat (rough)", 1002, ""],
    ]);
    let term_bank_2 = json!([
        {
            "type": "term",
            "expression": "食べ物",
            "reading": "たべもの",
            "definitionTags": "n",
            "rules": "n",
            "score": 80,
            "glossary": [{"type": "text", "text": "food"}],
            "sequence": 1003,
            "termTags": "",
        },
        // Same expression as the first bank, higher score: proves ORDER BY score.
        ["食べる", "たべる", "v1 vt", "v1", 200, ["to eat (polite)"], 2001],
        // No reading: `reading` must come back as null.
        ["行", null, "", "n", 10, ["to go"], 1004],
    ]);
    let kanji_bank_1 = json!([
        ["食", "ショク,ジキ", "た.べる,く.う", " ate1", ["eat", "food"], { "grade": 2 }],
        ["行", "コウ,ギョウ", "い.く,おこな.う", " gio1", ["to go"], 1],
    ]);
    let term_meta_bank_1 = json!([
        ["食べる", "freq", 12],
        ["食べる", "pitch", { "pitches": [{ "reading": "たべる", "deviation": 0, "tags": [] }] }],
    ]);
    let tag_bank_1 = json!([
        { "name": "v1", "category": "partOfSpeech", "order": 10, "notes": "Ichidan verb", "score": 0 },
        { "name": "common", "category": "frequency", "order": 0, "notes": "", "score": 100 },
    ]);

    let mut add = |name: &str, value: serde_json::Value| {
        zip.start_file(name, options).expect("start zip entry");
        zip.write_all(value.to_string().as_bytes())
            .expect("write zip entry");
    };
    add("test_dict/index.json", index);
    add("test_dict/term_bank_1.json", term_bank_1);
    add("test_dict/term_bank_2.json", term_bank_2);
    add("test_dict/kanji_bank_1.json", kanji_bank_1);
    add("test_dict/term_meta_bank_1.json", term_meta_bank_1);
    add("test_dict/tag_bank_1.json", tag_bank_1);

    zip.finish().expect("finish zip").into_inner()
}

/// A dictionary whose banks are pretty-printed across many lines, BOM-prefixed
/// and whose names are not zero padded: streaming must be whitespace, BOM and
/// file-name-order agnostic.
fn build_pretty_dictionary_zip() -> Vec<u8> {
    const BOM: &str = "\u{feff}";
    let mut zip = ZipWriter::new(Cursor::new(Vec::new()));
    let options = SimpleFileOptions::default().compression_method(CompressionMethod::Deflated);
    let mut index = String::from(BOM);
    index.push_str(
        "{\n  \"title\": \"Pretty Dict\",\n  \"format\": 3,\n  \"revision\": \"pretty-1\"\n}\n",
    );
    let mut term_bank = String::from(BOM);
    term_bank.push_str("[\n");
    for index in 0..5 {
        term_bank.push_str(&format!(
            "  [\"語{index}\", \"ご{index}\", \"\", \"n\", {index}, [\"word {index}\"], {index}],\n"
        ));
    }
    term_bank.push_str("  [\"最終\", \"さいしゅう\", \"\", \"n\", 9, [\"last\"], 99]\n]\n");

    zip.start_file("pretty/index.json", options)
        .expect("start index");
    zip.write_all(index.as_bytes()).expect("write index");
    zip.start_file("pretty/term_bank_10.json", options)
        .expect("start bank");
    zip.write_all(term_bank.as_bytes()).expect("write bank");
    zip.finish().expect("finish zip").into_inner()
}

fn import(conn: &rusqlite::Connection, bytes: Vec<u8>) -> yomitan::DictionarySummary {
    yomitan::import_dictionary(conn, Cursor::new(bytes)).expect("import dictionary")
}

#[test]
fn import_reports_progress_for_every_bank() {
    let conn = yomitan::open_in_memory().expect("open in-memory database");
    let mut seen: Vec<yomitan::ImportProgress> = Vec::new();

    let summary = yomitan::import_dictionary_with_progress(
        &conn,
        Cursor::new(build_dictionary_zip()),
        &mut |progress| seen.push(progress),
    )
    .expect("import dictionary");

    assert_eq!(summary.title, "Test Dictionary");
    // The fixture holds five banks, so the importer reports the start (0/5) and
    // then one tick per bank written, ending on the only 100%.
    let total = seen.last().map(|progress| progress.total);
    assert_eq!(total, Some(5), "progress reports the bank count");
    assert_eq!(
        seen.windows(2)
            .map(|pair| (pair[0].current, pair[1].current))
            .collect::<Vec<_>>(),
        [(0, 1), (1, 2), (2, 3), (3, 4), (4, 5)],
        "one report per bank, starting at zero: {seen:?}"
    );
    assert_eq!(
        seen.iter().map(|progress| progress.percent).collect::<Vec<_>>(),
        [0, 20, 40, 60, 80, 100],
        "percent is the written share of all banks"
    );
    assert!(
        seen.windows(2).all(|pair| pair[0].percent <= pair[1].percent),
        "percent never goes backwards"
    );
    assert_eq!(term_count(&conn), 5, "the import itself is unaffected");
}

fn term_count(conn: &rusqlite::Connection) -> i64 {
    conn.query_row("SELECT COUNT(*) FROM terms", [], |row| row.get(0))
        .expect("count terms")
}

#[test]
fn imports_a_dictionary_and_finds_terms_by_expression_and_reading() {
    let conn = yomitan::open_in_memory().expect("open in-memory database");
    let summary = import(&conn, build_dictionary_zip());

    assert_eq!(summary.title, "Test Dictionary");
    assert_eq!(summary.format, 3);
    assert_eq!(summary.revision, "test-1");
    assert!(summary.sequenced);
    assert!(summary.enabled);
    assert_eq!(summary.author.as_deref(), Some("GoRakuDo"));
    assert!(!summary.id.is_empty());
    // All five term entries (three array-form, one object-form, one null
    // reading) across two banks.
    assert_eq!(term_count(&conn), 5);

    let entries = yomitan::find_terms(&conn, "食べる", None).expect("find terms");
    assert_eq!(
        entries.len(),
        2,
        "both dictionaries banks match the expression"
    );
    // Highest score first: 200 (second bank) before 100 (first bank).
    assert_eq!(entries[0].score, 200);
    assert_eq!(entries[1].score, 100);
    let eating = &entries[1];
    assert_eq!(eating.reading.as_deref(), Some("たべる"));
    assert_eq!(eating.sequence, 1001);
    assert_eq!(eating.term_tags.as_deref(), Some("common"));
    assert_eq!(eating.definition_tags.as_deref(), Some("v1 vt"));
    assert_eq!(eating.rules.as_deref(), Some("v1"));
    assert_eq!(eating.glossary, json!(["to eat"]));

    // Lookup by reading finds the same headwords.
    let by_reading = yomitan::find_terms(&conn, "たべる", None).expect("find by reading");
    assert_eq!(by_reading.len(), 2);
    assert!(by_reading.iter().all(|entry| entry.expression == "食べる"));

    // Object-form entry and a null reading both round-trip.
    let food = yomitan::find_terms(&conn, "食べ物", None).expect("find 食べ物");
    assert_eq!(food.len(), 1);
    assert_eq!(
        food[0].glossary,
        json!([{ "type": "text", "text": "food" }])
    );
    let go = yomitan::find_terms(&conn, "行", None).expect("find 行");
    assert_eq!(go.len(), 1);
    assert_eq!(go[0].reading, None);
    assert_eq!(go[0].dictionary_id, summary.id);

    // A glossary given as a plain string (older JMdict-style banks) stays a JSON
    // string instead of being coerced into an array.
    let rough = yomitan::find_terms(&conn, "食う", None).expect("find 食う");
    assert_eq!(rough.len(), 1);
    assert_eq!(rough[0].glossary, json!("to eat (rough)"));
    assert_eq!(rough[0].sequence, 1002);
}

#[test]
fn imports_kanji_meta_and_tags_and_reads_kanji_back() {
    let conn = yomitan::open_in_memory().expect("open in-memory database");
    let summary = import(&conn, build_dictionary_zip());

    let kanji = yomitan::find_kanji(&conn, "食")
        .expect("find kanji")
        .expect("kanji present");
    assert_eq!(kanji.character, "食");
    assert_eq!(kanji.dictionary_id, summary.id);
    assert_eq!(kanji.onyomi.as_deref(), Some("ショク,ジキ"));
    assert_eq!(kanji.kunyomi.as_deref(), Some("た.べる,く.う"));
    assert_eq!(kanji.meanings, vec!["eat".to_string(), "food".to_string()]);
    assert_eq!(kanji.stats, Some(json!({ "grade": 2 })));
    assert!(yomitan::find_kanji(&conn, "無")
        .expect("lookup succeeds")
        .is_none());

    let meta: i64 = conn
        .query_row("SELECT COUNT(*) FROM term_meta", [], |row| row.get(0))
        .expect("count term_meta");
    assert_eq!(meta, 2);
    let pitch: String = conn
        .query_row(
            "SELECT data_json FROM term_meta WHERE mode = 'pitch'",
            [],
            |row| row.get(0),
        )
        .expect("pitch meta");
    assert!(pitch.contains("pitches"), "object data preserved: {pitch}");

    let tags: i64 = conn
        .query_row("SELECT COUNT(*) FROM tags", [], |row| row.get(0))
        .expect("count tags");
    assert_eq!(tags, 2);
    let sorting: i64 = conn
        .query_row("SELECT sorting FROM tags WHERE name = 'v1'", [], |row| {
            row.get(0)
        })
        .expect("tag sorting");
    assert_eq!(sorting, 10, "tag bank `order` maps to `sorting`");
}

#[test]
fn lists_toggles_and_deletes_dictionaries() {
    let conn = yomitan::open_in_memory().expect("open in-memory database");
    let first = import(&conn, build_dictionary_zip());
    let second = import(&conn, build_pretty_dictionary_zip());

    let listed = yomitan::list_dictionaries(&conn).expect("list dictionaries");
    assert_eq!(listed.len(), 2, "both dictionaries are listed");
    assert!(listed.iter().any(|dict| dict.id == first.id));
    assert!(listed.iter().any(|dict| dict.id == second.id));

    // Streaming: every pretty-printed line-terminated entry landed.
    assert_eq!(term_count(&conn), 11);
    let last = yomitan::find_terms(&conn, "最終", None).expect("find last entry");
    assert_eq!(last.len(), 1);
    assert_eq!(last[0].sequence, 99);

    // Disabling hides a dictionary from lookups but keeps its rows.
    yomitan::toggle_dictionary(&conn, &first.id, false).expect("disable dictionary");
    assert!(yomitan::find_terms(&conn, "食べる", None)
        .expect("find terms")
        .is_empty());
    assert_eq!(term_count(&conn), 11, "rows are kept when disabled");
    let listed = yomitan::list_dictionaries(&conn).expect("list dictionaries");
    assert!(
        !listed
            .iter()
            .find(|dict| dict.id == first.id)
            .unwrap()
            .enabled
    );

    // Re-enabling restores lookups.
    yomitan::toggle_dictionary(&conn, &first.id, true).expect("enable dictionary");
    assert_eq!(
        yomitan::find_terms(&conn, "食べる", None)
            .expect("find terms")
            .len(),
        2
    );

    // Unknown ids are reported, not silently ignored.
    assert!(yomitan::toggle_dictionary(&conn, "missing", true).is_err());
    assert!(yomitan::delete_dictionary(&conn, "missing").is_err());

    yomitan::delete_dictionary(&conn, &first.id).expect("delete dictionary");
    assert!(yomitan::find_terms(&conn, "食べる", None)
        .expect("find terms")
        .is_empty());
    assert!(yomitan::find_kanji(&conn, "食")
        .expect("find kanji")
        .is_none());
    let meta: i64 = conn
        .query_row("SELECT COUNT(*) FROM term_meta", [], |row| row.get(0))
        .expect("count term_meta");
    assert_eq!(meta, 0, "term_meta of the deleted dictionary is gone");
    let tags: i64 = conn
        .query_row("SELECT COUNT(*) FROM tags", [], |row| row.get(0))
        .expect("count tags");
    assert_eq!(tags, 0);
    let listed = yomitan::list_dictionaries(&conn).expect("list dictionaries");
    assert_eq!(listed.len(), 1);
    assert_eq!(listed[0].id, second.id, "the other dictionary is untouched");
}

#[test]
fn reimport_replaces_content_and_the_limit_caps_results() {
    let conn = yomitan::open_in_memory().expect("open in-memory database");
    let first = import(&conn, build_pretty_dictionary_zip());
    assert_eq!(term_count(&conn), 6);

    // Same identity (format+revision+title) -> same id, content replaced, and no
    // duplicate rows.
    let again = import(&conn, build_pretty_dictionary_zip());
    assert_eq!(again.id, first.id);
    assert_eq!(term_count(&conn), 6);
    assert_eq!(
        yomitan::list_dictionaries(&conn)
            .expect("list dictionaries")
            .len(),
        1
    );

    // Different revision -> separate dictionary, both searchable.
    let other = import(&conn, build_dictionary_zip());
    assert_ne!(other.id, first.id);
    assert_eq!(
        yomitan::find_terms(&conn, "食べる", Some(1))
            .expect("limited find")
            .len(),
        1
    );
    assert!(
        yomitan::find_terms(&conn, "食べる", Some(0))
            .expect("zero is clamped to one")
            .len()
            <= 1
    );
}

#[test]
fn imports_from_a_file_path_and_rejects_invalid_archives() {
    let path = std::env::temp_dir().join(format!(
        "entei-yomitan-{}-{DATABASE_FILE_NAME}",
        std::process::id()
    ));
    std::fs::write(&path, build_dictionary_zip()).expect("write fixture zip");

    // The on-disk connection also proves WAL and the schema apply to a real file.
    let db_path = path.with_extension("sqlite");
    let conn = yomitan::open(&db_path).expect("open on-disk database");
    let summary = yomitan::import_dictionary_from_path(&conn, &path).expect("import from path");
    assert_eq!(summary.title, "Test Dictionary");
    drop(conn);

    // Reopening the file shows the data was committed (not left in a WAL-only state).
    let reopened = yomitan::open(&db_path).expect("reopen database");
    assert_eq!(
        yomitan::find_terms(&reopened, "食う", None)
            .expect("find terms")
            .len(),
        1
    );

    // Not a ZIP at all.
    let garbage = yomitan::import_dictionary(&reopened, Cursor::new(b"not a zip".to_vec()));
    assert!(garbage.is_err(), "garbage input must be rejected");

    // A ZIP without index.json.
    let mut zip = ZipWriter::new(Cursor::new(Vec::new()));
    zip.start_file("dict/term_bank_1.json", SimpleFileOptions::default())
        .expect("start entry");
    zip.write_all("[[\"\u{732b}\",\"\u{306d}\u{3053}\",\"\",\"n\",5,[\"cat\"]]]".as_bytes())
        .expect("write entry");
    let no_index = zip.finish().expect("finish zip").into_inner();
    let error = yomitan::import_dictionary(&reopened, Cursor::new(no_index))
        .expect_err("missing index.json is rejected");
    assert!(error.contains("index.json"), "unexpected error: {error}");

    // Cleanup: the fixture files this test created must not survive.
    for file in [
        &path,
        &db_path,
        &db_path.with_extension("sqlite-wal"),
        &db_path.with_extension("sqlite-shm"),
    ] {
        let _ = std::fs::remove_file(file);
    }
}

#[test]
fn a_zip_without_any_bank_is_rejected() {
    let conn = yomitan::open_in_memory().expect("open in-memory database");
    let mut zip = ZipWriter::new(Cursor::new(Vec::new()));
    zip.start_file("index.json", SimpleFileOptions::default())
        .expect("start index");
    zip.write_all(br#"{"title":"Empty","format":3,"revision":"r1"}"#)
        .expect("write index");
    let bytes = zip.finish().expect("finish zip").into_inner();

    let error = yomitan::import_dictionary(&conn, Cursor::new(bytes))
        .expect_err("a dictionary with no bank is rejected");
    assert!(
        error.contains("no term/kanji/term_meta/tag bank"),
        "unexpected error: {error}"
    );
    assert!(yomitan::list_dictionaries(&conn)
        .expect("list dictionaries")
        .is_empty());
}
