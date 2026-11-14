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

/// Entries in the single large bank [`build_single_large_bank_zip`] writes:
/// enough that the bank's uncompressed size clears
/// `yomitan::INTRA_BANK_PROGRESS_MIN_BYTES`-scale work (well over 1 MiB).
const LARGE_BANK_ENTRIES: u32 = 120_000;

/// A dictionary whose ONE bank is big enough to need progress of its own
/// (`INTRA_BANK_PROGRESS_MIN_BYTES`): the shape a frequency dictionary has, and
/// the case where reporting only at a bank's end would freeze the UI's percent.
fn build_single_large_bank_zip() -> Vec<u8> {
    let mut zip = ZipWriter::new(Cursor::new(Vec::new()));
    let options = SimpleFileOptions::default().compression_method(CompressionMethod::Deflated);

    zip.start_file("freq/index.json", options)
        .expect("start index");
    zip.write_all(b"{\"title\":\"Big Freq\",\"format\":3,\"revision\":\"freq-1\"}")
        .expect("write index");

    // Written out entry by entry rather than built as one `Value`: the point is
    // the byte size, and a 1 MiB+ bank must not cost the test a giant JSON tree.
    zip.start_file("freq/term_meta_bank_1.json", options)
        .expect("start bank");
    zip.write_all(b"[").expect("write bank head");
    for index in 0..LARGE_BANK_ENTRIES {
        if index > 0 {
            zip.write_all(b",").expect("write separator");
        }
        zip.write_all(format!("[\"w{index}\",\"freq\",{index}]").as_bytes())
            .expect("write bank entry");
    }
    zip.write_all(b"]").expect("write bank tail");

    zip.finish().expect("finish zip").into_inner()
}

#[test]
fn a_bank_too_large_to_finish_quickly_reports_progress_inside_itself() {
    let conn = yomitan::open_in_memory().expect("open in-memory database");
    let mut seen: Vec<yomitan::ImportProgress> = Vec::new();

    let summary = yomitan::import_dictionary_with_progress(
        &conn,
        Cursor::new(build_single_large_bank_zip()),
        &mut |progress| seen.push(progress),
    )
    .expect("import dictionary");

    assert_eq!(summary.title, "Big Freq");
    // One bank only, so a per-bank-only report would be exactly [0, 100]: the
    // percent the UI showed would not move for the whole import.
    assert_eq!(seen.last().map(|progress| progress.percent), Some(100));
    assert_eq!(seen.last().map(|progress| progress.current), Some(1));
    assert!(
        seen.iter()
            .any(|progress| progress.percent > 0 && progress.percent < 100),
        "the bank reports while it streams, not only when it ends"
    );
    assert!(
        seen.windows(2).all(|pair| pair[0].percent <= pair[1].percent),
        "percent never goes backwards"
    );
    // In-bank reports estimate progress from bytes, so `current` still counts
    // only FINISHED banks: nothing claims a bank is written before it is.
    assert!(
        seen.iter().all(|progress| progress.current <= 1),
        "no bank is reported as written before it is"
    );
    // The import itself is unaffected: every streamed entry landed.
    let meta: i64 = conn
        .query_row("SELECT COUNT(*) FROM term_meta", [], |row| row.get(0))
        .expect("count term_meta");
    assert_eq!(meta, i64::from(LARGE_BANK_ENTRIES));
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
    // The fixture's term_meta bank carries a `freq` row, so this dictionary is a
    // valid frequency-sorting choice (the flag the import reads back from the
    // committed row, not from index.json).
    assert!(summary.has_frequency_data);
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
    // Frequency metadata decides the frequency-sorter's choices, so the fixture
    // (which ships a `freq` row) is one and the meta-less dictionary is not.
    let flag = |listed: &[yomitan::DictionarySummary], id: &str| {
        listed
            .iter()
            .find(|dict| dict.id == id)
            .expect("dictionary listed")
            .has_frequency_data
    };
    assert!(flag(&listed, &first.id), "a freq bank is frequency data");
    assert!(
        !flag(&listed, &second.id),
        "a dictionary with no term_meta bank is not a frequency dictionary"
    );

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
    // No term_meta bank at all -> never offered as a frequency dictionary.
    assert!(!first.has_frequency_data);

    // Same identity (format+revision+title) -> same id, content replaced, and no
    // duplicate rows.
    let again = import(&conn, build_pretty_dictionary_zip());
    assert_eq!(again.id, first.id);
    assert!(!again.has_frequency_data);
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
fn measures_the_dictionary_database_and_its_wal_on_disk() {
    let dir = std::env::temp_dir().join(format!("entei-yomitan-usage-{}", std::process::id()));
    std::fs::create_dir_all(&dir).expect("create temp dir");

    // Nothing imported yet: 0 bytes, not a failure (the meter still draws).
    assert_eq!(yomitan::storage_usage(&dir).usage, 0);

    for (suffix, size) in [("", 4096usize), ("-wal", 1024), ("-shm", 512)] {
        std::fs::write(
            dir.join(format!("{DATABASE_FILE_NAME}{suffix}")),
            vec![0u8; size],
        )
        .expect("write database file");
    }

    let usage = yomitan::storage_usage(&dir);
    assert_eq!(
        usage.usage, 4096 + 1024 + 512,
        "the database and both sidecars are summed"
    );
    // The quota is the volume's own answer, and a real temp volume has room.
    assert!(
        usage.quota > 0,
        "the volume reports available bytes: {usage:?}"
    );

    // A foreign file in the same directory is not dictionary storage.
    std::fs::write(dir.join("entei.db"), vec![0u8; 8192]).expect("write foreign db");
    assert_eq!(
        yomitan::storage_usage(&dir).usage,
        4096 + 1024 + 512,
        "only the dictionary database is counted"
    );

    // Cleanup: this test owns the directory it created.
    std::fs::remove_dir_all(&dir).expect("remove temp dir");
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

    // Cleanup: the fixture files this test created must not survive. The
    // connection is closed first — Windows refuses to delete a file SQLite still
    // holds open, which is how this test used to leave one behind per run.
    drop(reopened);
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

/* --- Bulk (deinflection) lookups ------------------------------------------- */

#[test]
fn bulk_term_lookup_answers_each_candidate_with_its_own_index() {
    let conn = yomitan::open_in_memory().expect("open in-memory database");
    import(&conn, build_dictionary_zip());

    let rows = yomitan::find_terms_bulk(
        &conn,
        &[
            "食べる".to_string(),
            "食う".to_string(),
            "存在しない語".to_string(),
        ],
        yomitan::TermMatchType::Exact,
        None,
    )
    .expect("bulk term lookup");

    // `食べる` twice (two banks), `食う` once, and nothing for the absent term.
    let indexed: Vec<(usize, &str)> = rows
        .iter()
        .map(|row| (row.index, row.expression.as_str()))
        .collect();
    assert_eq!(
        indexed,
        [(0, "食べる"), (0, "食べる"), (1, "食う")],
        "every row carries the index of the candidate it answers: {rows:?}"
    );
    // Highest score first inside a candidate (the fixture's whole point).
    assert_eq!(rows[0].score, 200, "the higher-scored 食べる comes first");
    assert_eq!(rows[1].score, 100);

    // The translator keys its dictionary set by TITLE and de-duplicates by id.
    assert!(
        rows.iter().all(|row| row.dictionary == "Test Dictionary"),
        "dictionary is the title, not the id: {rows:?}"
    );
    let ids: std::collections::HashSet<i64> = rows.iter().map(|row| row.id).collect();
    assert_eq!(ids.len(), 3, "every row has its own id: {rows:?}");

    // Payload is decoded, not left as JSON text.
    assert_eq!(rows[0].glossary[0], json!("to eat (polite)"));

    // A single-candidate query is unaffected by the other candidates.
    let single = yomitan::find_terms_bulk(
        &conn,
        &["行".to_string()],
        yomitan::TermMatchType::Exact,
        None,
    )
    .expect("bulk term lookup");
    assert_eq!(single.len(), 1);
    assert_eq!(single[0].reading, None, "a null reading stays null");
    assert_eq!(single[0].glossary[0], json!("to go"));
}

#[test]
fn bulk_term_lookup_answers_prefix_and_refuses_suffix() {
    let conn = yomitan::open_in_memory().expect("open in-memory database");
    import(&conn, build_dictionary_zip());

    let prefix = yomitan::find_terms_bulk(
        &conn,
        &["食べ".to_string()],
        yomitan::TermMatchType::Prefix,
        None,
    )
    .expect("prefix lookup");
    let expressions: Vec<&str> = prefix.iter().map(|row| row.expression.as_str()).collect();
    assert_eq!(
        expressions,
        ["食べる", "食べる", "食べ物"],
        "prefix matching finds every headword starting with the query: {prefix:?}"
    );

    // A prefix bound must not spill into the next code point: 食べ < 食え.
    let bounded = yomitan::find_terms_bulk(
        &conn,
        &["食".to_string()],
        yomitan::TermMatchType::Prefix,
        None,
    )
    .expect("prefix lookup");
    assert!(
        bounded
            .iter()
            .all(|row| row.expression.starts_with('食')),
        "the upper bound keeps every row inside the prefix: {bounded:?}"
    );

    // Suffix is documented as unanswered (a leading-wildcard scan over the whole
    // bank), so it must be empty rather than a slow or wrong answer.
    let suffix = yomitan::find_terms_bulk(
        &conn,
        &["べる".to_string()],
        yomitan::TermMatchType::Suffix,
        None,
    )
    .expect("suffix lookup");
    assert!(suffix.is_empty(), "suffix matching answers nothing yet");
}

#[test]
fn bulk_term_lookup_skips_disabled_dictionaries_and_honours_the_limit() {
    let conn = yomitan::open_in_memory().expect("open in-memory database");
    let summary = import(&conn, build_dictionary_zip());

    let limited = yomitan::find_terms_bulk(
        &conn,
        &["食べる".to_string()],
        yomitan::TermMatchType::Exact,
        Some(1),
    )
    .expect("limited lookup");
    assert_eq!(limited.len(), 1, "the per-candidate limit applies");
    assert_eq!(limited[0].score, 200, "and the best row is the one kept");

    yomitan::toggle_dictionary(&conn, &summary.id, false).expect("disable dictionary");
    let disabled = yomitan::find_terms_bulk(
        &conn,
        &["食べる".to_string()],
        yomitan::TermMatchType::Exact,
        None,
    )
    .expect("lookup with the dictionary off");
    assert!(
        disabled.is_empty(),
        "a disabled dictionary answers no lookup: {disabled:?}"
    );

    // Empty requests are answered, not rejected: the translator batches whatever
    // a scan produced, including nothing.
    assert!(yomitan::find_terms_bulk(
        &conn,
        &[],
        yomitan::TermMatchType::Exact,
        None
    )
    .expect("empty term list")
    .is_empty());
    assert!(yomitan::find_term_meta_bulk(&conn, &[])
        .expect("empty meta list")
        .is_empty());
    assert!(yomitan::find_kanji_bulk(&conn, &[])
        .expect("empty kanji list")
        .is_empty());
    assert!(yomitan::find_tags_bulk(&conn, &[])
        .expect("empty tag list")
        .is_empty());
}

#[test]
fn bulk_term_meta_lookup_returns_mode_and_payload_per_candidate() {
    let conn = yomitan::open_in_memory().expect("open in-memory database");
    import(&conn, build_dictionary_zip());

    let metas = yomitan::find_term_meta_bulk(
        &conn,
        &["食べる".to_string(), "無い語".to_string()],
    )
    .expect("bulk term meta lookup");

    assert_eq!(metas.len(), 2, "the fixture ships freq and pitch: {metas:?}");
    assert!(
        metas.iter().all(|meta| meta.index == 0),
        "both belong to the first candidate"
    );
    assert!(
        metas.iter().all(|meta| meta.dictionary == "Test Dictionary"),
        "dictionary is the title: {metas:?}"
    );
    assert_eq!(metas[0].expression, "食べる");
    assert_eq!(metas[0].mode, "freq");
    assert_eq!(metas[0].data, json!(12));
    assert_eq!(metas[1].mode, "pitch");
    assert_eq!(
        metas[1].data["pitches"][0]["reading"],
        json!("たべる"),
        "a pitch payload stays structured"
    );
}

#[test]
fn bulk_kanji_lookup_returns_one_entry_per_character_with_its_index() {
    let conn = yomitan::open_in_memory().expect("open in-memory database");
    import(&conn, build_dictionary_zip());

    let entries = yomitan::find_kanji_bulk(
        &conn,
        &["食".to_string(), "行".to_string(), "猫".to_string()],
    )
    .expect("bulk kanji lookup");

    let indexed: Vec<(usize, &str)> = entries
        .iter()
        .map(|entry| (entry.index, entry.character.as_str()))
        .collect();
    assert_eq!(
        indexed,
        [(0, "食"), (1, "行")],
        "each row answers the character it was asked for: {entries:?}"
    );
    assert!(entries
        .iter()
        .all(|entry| entry.dictionary == "Test Dictionary"));
    assert_eq!(entries[0].onyomi.as_deref(), Some("ショク,ジキ"));
    assert_eq!(entries[0].meanings, ["eat", "food"]);
    assert_eq!(entries[0].stats, Some(json!({ "grade": 2 })));
}

#[test]
fn bulk_tag_lookup_is_positional_and_scoped_to_one_dictionary() {
    let conn = yomitan::open_in_memory().expect("open in-memory database");
    import(&conn, build_dictionary_zip());

    let tags = yomitan::find_tags_bulk(
        &conn,
        &[
            yomitan::TagQuery {
                query: "v1".to_string(),
                dictionary: "Test Dictionary".to_string(),
            },
            yomitan::TagQuery {
                query: "common".to_string(),
                dictionary: "Test Dictionary".to_string(),
            },
            // Unknown tag, and a tag in a dictionary that is not imported: both
            // are simply absent, so the caller's positional read stays aligned.
            yomitan::TagQuery {
                query: "vt".to_string(),
                dictionary: "Test Dictionary".to_string(),
            },
            yomitan::TagQuery {
                query: "v1".to_string(),
                dictionary: "Other Dictionary".to_string(),
            },
        ],
    )
    .expect("bulk tag lookup");

    let indexed: Vec<(usize, &str)> = tags
        .iter()
        .map(|tag| (tag.index, tag.name.as_str()))
        .collect();
    assert_eq!(
        indexed,
        [(0, "v1"), (1, "common")],
        "only the requests that matched contribute a row: {tags:?}"
    );
    assert_eq!(tags[0].category, "partOfSpeech");
    assert_eq!(tags[0].order, 10, "the bank's order is the tag's order");
    assert_eq!(tags[0].notes, "Ichidan verb");
    assert_eq!(tags[1].category, "frequency");
    assert_eq!(tags[1].score, 100);
}

#[test]
fn tag_lookup_is_answered_through_an_index_not_a_table_scan() {
    let conn = yomitan::open_in_memory().expect("open in-memory database");
    import(&conn, build_dictionary_zip());

    // `find_tags_bulk` filters on `tags.name`, which the dictionary_id index
    // cannot serve: without an index of its own SQLite reads the whole (in a real
    // tag bank, 100k-row) table per lookup batch.
    let mut statement = conn
        .prepare("EXPLAIN QUERY PLAN SELECT tags.name FROM tags WHERE tags.name = 'v1'")
        .expect("explain tag lookup");
    let plan: Vec<String> = statement
        .query_map([], |row| row.get::<_, String>(3))
        .expect("plan rows")
        .collect::<rusqlite::Result<Vec<_>>>()
        .expect("plan rows");
    assert!(
        plan.iter().all(|detail| !detail.contains("SCAN tags")),
        "the tag lookup must not scan the table: {plan:?}"
    );
    assert!(
        plan.iter().any(|detail| detail.contains("idx_tags_name")),
        "the name index is the one used: {plan:?}"
    );

    // And the lookup itself still answers positionally, by name and dictionary.
    let tags = yomitan::find_tags_bulk(
        &conn,
        &[
            yomitan::TagQuery {
                query: "v1".to_string(),
                dictionary: "Test Dictionary".to_string(),
            },
        ],
    )
    .expect("bulk tag lookup");
    assert_eq!(tags.len(), 1);
    assert_eq!(tags[0].name, "v1");
    assert_eq!(tags[0].index, 0);
}
