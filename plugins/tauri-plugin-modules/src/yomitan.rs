//! Yomitan dictionary engine: ZIP import into a **dedicated** SQLite database.
//!
//! # Separation of data
//! Dictionary content never touches `entei.db`. It lives in its own file
//! (`yomitan-dictionaries.db` under `app_data_dir`) so dropping, re-importing
//! or corrupting a dictionary can never damage user data, and so the (potentially
//! hundreds of megabytes) term/kanji banks stay out of the app database.
//!
//! # Format coverage
//! A Yomitan dictionary ZIP is read entry by entry from its central directory:
//! `index.json`, `term_bank_*.json`, `kanji_bank_*.json`,
//! `term_meta_bank_*.json` and `tag_bank_*.json` (any directory depth, matched
//! case-insensitively on the file name).
//!
//! Banks are **streamed**, never buffered whole: the array is entered, then one
//! element at a time is deserialized off a `BufRead` and inserted through a
//! prepared statement inside a single transaction. A 200 MB `term_bank` needs a
//! few kilobytes of resident memory instead of a `Vec<Value>` of the whole file.
//!
//! Note: element streaming relies on every bank element being self-delimiting
//! (an array or an object), which every Yomitan term/kanji/meta/tag entry is.
//! A bank that mixed bare numbers at the top level would lose a separator byte;
//! such banks do not exist in the wild, and a bare top-level value is still
//! imported (parsed whole) rather than rejected.

use std::cell::Cell;
use std::collections::HashMap;
use std::fs::File;
use std::io::{self, BufRead, BufReader, BufWriter, Read, Seek, Write};
use std::path::{Path, PathBuf};
use std::rc::Rc;
use std::time::{SystemTime, UNIX_EPOCH};

use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use serde::de::IgnoredAny;
use serde::Deserializer as _;
use serde_json::{json, Map, Value};
use zip::ZipArchive;

/// File name of the dictionary-only database inside `app_data_dir`.
pub const DATABASE_FILE_NAME: &str = "yomitan-dictionaries.db";

/// Result cap for term lookups (the web layer pages/limits explicitly).
const DEFAULT_TERM_LIMIT: u32 = 100;
const MAX_TERM_LIMIT: u32 = 500;

/// Schema for the dictionary database. `IF NOT EXISTS` keeps every open
/// idempotent; no table here is ever created in `entei.db`.
const SCHEMA_SQL: &str = r#"
CREATE TABLE IF NOT EXISTS dictionaries (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    format INTEGER NOT NULL,
    revision TEXT NOT NULL,
    sequenced INTEGER NOT NULL,
    author TEXT,
    url TEXT,
    description TEXT,
    created_at INTEGER NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS terms (
    id INTEGER PRIMARY KEY,
    dictionary_id TEXT NOT NULL,
    expression TEXT NOT NULL,
    reading TEXT,
    definition_tags TEXT,
    rules TEXT,
    score INTEGER NOT NULL,
    sequence INTEGER NOT NULL,
    term_tags TEXT,
    glossary_json TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_terms_expression ON terms(expression);
CREATE INDEX IF NOT EXISTS idx_terms_reading ON terms(reading);
CREATE INDEX IF NOT EXISTS idx_terms_dictionary ON terms(dictionary_id);

CREATE TABLE IF NOT EXISTS kanjis (
    character TEXT PRIMARY KEY,
    dictionary_id TEXT NOT NULL,
    onyomi TEXT,
    kunyomi TEXT,
    tags TEXT,
    meanings_json TEXT,
    stats_json TEXT
);
CREATE INDEX IF NOT EXISTS idx_kanjis_dictionary ON kanjis(dictionary_id);

CREATE TABLE IF NOT EXISTS term_meta (
    expression TEXT NOT NULL,
    mode TEXT NOT NULL,
    data_json TEXT NOT NULL,
    dictionary_id TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_term_meta_expression ON term_meta(expression);
CREATE INDEX IF NOT EXISTS idx_term_meta_dictionary ON term_meta(dictionary_id);

CREATE TABLE IF NOT EXISTS tags (
    name TEXT NOT NULL,
    category TEXT NOT NULL,
    sorting INTEGER NOT NULL,
    notes TEXT NOT NULL,
    score INTEGER NOT NULL,
    dictionary_id TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_tags_dictionary ON tags(dictionary_id);
-- Tag lookups are BY NAME within one dictionary (`find_tags_bulk`), which the
-- dictionary_id index above cannot serve: without this one SQLite reads the
-- whole (potentially 100k-row) tag table per lookup batch.
CREATE INDEX IF NOT EXISTS idx_tags_name ON tags(name);
"#;

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/// One imported dictionary. `created_at` is the first-import timestamp and is
/// preserved when the same dictionary is imported again.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DictionarySummary {
    pub id: String,
    pub title: String,
    pub format: i64,
    pub revision: String,
    pub sequenced: bool,
    pub author: Option<String>,
    pub url: Option<String>,
    pub description: Option<String>,
    pub created_at: i64,
    pub enabled: bool,
    /// True when this dictionary carries frequency metadata (`term_meta` rows in
    /// the `freq` mode), which is the only thing the frequency sorter can sort
    /// by. A plain word dictionary (JMdict) is not a frequency dictionary, and
    /// Yomitan's own settings list offers only the dictionaries that are.
    pub has_frequency_data: bool,
}

/// Progress of one dictionary import, reported after each bank is written — and,
/// for a bank large enough to take noticeable time, while it is being written
/// (see `INTRA_BANK_PROGRESS_MIN_BYTES`).
///
/// Banks are the unit because they are the only whole-file boundaries the
/// importer has: it streams elements off a `BufRead` and cannot know an entry
/// count without a first pass over a file that may be hundreds of megabytes.
///
/// Not `Copy`: the Dexie JSON importer carries a `current_file` label (the store
/// it is streaming), and a `String` field cannot be copied.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportProgress {
    /// Whole-percent share of the banks written so far (0–100).
    pub percent: u32,
    /// Banks written so far.
    pub current: u32,
    /// Banks the archive holds (never 0: an archive with no bank is rejected).
    pub total: u32,
    /// What the import is currently writing. Set only by the Dexie JSON importer
    /// (one huge file streams table by table, so the UI names the store it is
    /// on); omitted from the payload for the ZIP importer, whose banks already
    /// say where it is, so its JSON stays exactly as it was.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub current_file: Option<String>,
}

impl ImportProgress {
    fn new(current: u32, total: u32) -> Self {
        Self {
            percent: percent_of(current, total),
            current,
            total,
            current_file: None,
        }
    }

    /// Progress INSIDE the bank at `index` (0-based, not finished yet), where
    /// `fraction` (0–1) of its uncompressed bytes are written.
    ///
    /// `current` still counts only the banks that are DONE, so the counters keep
    /// their meaning while `percent` moves in steps finer than one bank. The
    /// fraction is clamped and can never reach the bank's own completion value:
    /// that is reported by [`ImportProgress::new`] once the bank is in.
    fn within_bank(index: u32, total: u32, fraction: f64) -> Self {
        if total == 0 {
            return Self::new(0, 0);
        }
        let share = (index as f64 + fraction.clamp(0.0, 1.0)) / total as f64;
        Self {
            percent: ((share * 100.0) as u32).min(100),
            current: index,
            total,
            current_file: None,
        }
    }
}

/// `current / total` as a whole percent. An archive with no bank reports 0
/// rather than dividing by zero (the import itself fails on that archive).
fn percent_of(current: u32, total: u32) -> u32 {
    if total == 0 {
        return 0;
    }
    ((u64::from(current) * 100) / u64::from(total)).min(100) as u32
}

/// Uncompressed size a bank must reach before it reports progress *while* it is
/// being written.
///
/// A bank is otherwise the smallest unit the importer can report (it streams
/// elements off a `BufRead` and cannot know an element count without reading the
/// file first). Most Yomitan banks are small enough that this is exact, but a
/// frequency dictionary can ship ONE `term_meta_bank` of several hundred
/// thousand entries: reporting only at its end would pin the UI to the previous
/// percent for as long as that bank takes.
const INTRA_BANK_PROGRESS_MIN_BYTES: u64 = 1024 * 1024;

/// Bytes of one bank's uncompressed stream the JSON reader has taken.
///
/// Shared between the counting reader and the entry visitor (the visitor cannot
/// borrow the reader it is being read from). `Rc<Cell>` rather than an atomic:
/// an import is one call on one thread.
type ConsumedBytes = Rc<Cell<u64>>;

/// A `BufRead` that counts the uncompressed bytes taken out of it.
///
/// Both halves count, because both are how bytes leave the stream: `read` is
/// what `serde_json`'s reader takes one element with, `consume` is what the bank
/// reader skips separators, whitespace and the array brackets with. The two never
/// overlap — a `BufReader`'s own refill consumes from its *inner* reader, not
/// through this type.
struct CountingReader<R> {
    inner: R,
    consumed: ConsumedBytes,
}

impl<R: BufRead> CountingReader<R> {
    fn new(inner: R, consumed: ConsumedBytes) -> Self {
        Self { inner, consumed }
    }
}

impl<R: BufRead> Read for CountingReader<R> {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        let read = self.inner.read(buf)?;
        self.consumed.set(self.consumed.get() + read as u64);
        Ok(read)
    }
}

impl<R: BufRead> BufRead for CountingReader<R> {
    fn fill_buf(&mut self) -> io::Result<&[u8]> {
        self.inner.fill_buf()
    }

    fn consume(&mut self, amount: usize) {
        self.consumed.set(self.consumed.get() + amount as u64);
        self.inner.consume(amount);
    }
}

/// Publish the percent of the bank being written, but only when it has moved.
///
/// Runs per bank ENTRY, so it stays a comparison plus (at most) one callback:
/// the importer's hot loop must not pay for the progress it reports.
fn report_bank_progress(
    on_progress: &mut dyn FnMut(ImportProgress),
    reported: &mut u32,
    index: u32,
    total: u32,
    bank_bytes: u64,
    consumed: u64,
) {
    if bank_bytes < INTRA_BANK_PROGRESS_MIN_BYTES {
        return;
    }
    let progress =
        ImportProgress::within_bank(index, total, consumed as f64 / bank_bytes as f64);
    if progress.percent <= *reported {
        return;
    }
    *reported = progress.percent;
    on_progress(progress);
}

/// A dictionary headword plus its glossary payload (already parsed, so the web
/// layer does not re-decode JSON per row).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TermEntry {
    pub id: i64,
    pub dictionary_id: String,
    pub expression: String,
    pub reading: Option<String>,
    pub definition_tags: Option<String>,
    pub rules: Option<String>,
    pub score: i64,
    pub sequence: i64,
    pub term_tags: Option<String>,
    pub glossary: Value,
}

/// A single kanji entry.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KanjiEntry {
    pub character: String,
    pub dictionary_id: String,
    pub onyomi: Option<String>,
    pub kunyomi: Option<String>,
    pub tags: Option<String>,
    pub meanings: Vec<String>,
    pub stats: Option<Value>,
}

// ---------------------------------------------------------------------------
// Connection handling
// ---------------------------------------------------------------------------

/// Open (creating if needed) the dictionary database at `path`.
pub fn open(path: &Path) -> Result<Connection, String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("failed to create {}: {e}", parent.display()))?;
    }
    let conn =
        Connection::open(path).map_err(|e| format!("failed to open {}: {e}", path.display()))?;
    configure(&conn)?;
    Ok(conn)
}

/// Open an in-memory dictionary database (tests, ephemeral use).
pub fn open_in_memory() -> Result<Connection, String> {
    let conn = Connection::open_in_memory().map_err(|e| e.to_string())?;
    configure(&conn)?;
    Ok(conn)
}

fn configure(conn: &Connection) -> Result<(), String> {
    // WAL keeps the reader (lookup) from blocking on the writer (import).
    // `synchronous = NORMAL` is safe with WAL and much faster on bulk import.
    // Note: SQLite silently reports `memory` for in-memory databases; that is
    // not an error and both pragmas are simply inapplicable there.
    conn.pragma_update(None, "journal_mode", "WAL")
        .map_err(|e| format!("failed to enable WAL: {e}"))?;
    conn.pragma_update(None, "synchronous", "NORMAL")
        .map_err(|e| format!("failed to set synchronous=NORMAL: {e}"))?;
    conn.execute_batch(SCHEMA_SQL).map_err(|e| e.to_string())?;
    Ok(())
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// FNV-1a (64 bit) over the dictionary identity, hex encoded. Hand-rolled so the
/// id is stable across runs and platforms without adding a hashing dependency.
fn dictionary_id(format: i64, revision: &str, title: &str) -> String {
    let mut identity = Vec::new();
    identity.extend_from_slice(&format.to_le_bytes());
    identity.extend_from_slice(revision.as_bytes());
    identity.push(b'|');
    identity.extend_from_slice(title.as_bytes());

    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for byte in identity {
        hash ^= u64::from(byte);
        hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
    }
    format!("{hash:016x}")
}

// ---------------------------------------------------------------------------
// Dictionary management
// ---------------------------------------------------------------------------

/// Every column [`row_to_summary`] reads: the dictionary's own columns plus the
/// derived frequency flag, computed as a correlated `EXISTS` so listing stays
/// one statement and stops at the first frequency row it finds.
///
/// `freq` is the only `term_meta` mode the frequency sorter reads — a dictionary
/// that ships pitch or IPA metadata only is still not a frequency dictionary.
const DICTIONARY_COLS: &str = "id, title, format, revision, sequenced, author, url, description, created_at, enabled, \
     EXISTS (SELECT 1 FROM term_meta WHERE term_meta.dictionary_id = dictionaries.id AND term_meta.mode = 'freq')";

fn row_to_summary(row: &rusqlite::Row<'_>) -> rusqlite::Result<DictionarySummary> {
    Ok(DictionarySummary {
        id: row.get(0)?,
        title: row.get(1)?,
        format: row.get(2)?,
        revision: row.get(3)?,
        sequenced: row.get::<_, i64>(4)? != 0,
        author: row.get(5)?,
        url: row.get(6)?,
        description: row.get(7)?,
        created_at: row.get(8)?,
        enabled: row.get::<_, i64>(9)? != 0,
        has_frequency_data: row.get::<_, i64>(10)? != 0,
    })
}

/// All imported dictionaries, newest import first.
pub fn list_dictionaries(conn: &Connection) -> Result<Vec<DictionarySummary>, String> {
    let sql = format!("SELECT {DICTIONARY_COLS} FROM dictionaries ORDER BY created_at DESC, id");
    let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], row_to_summary)
        .map_err(|e| e.to_string())?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|e| e.to_string())?;
    Ok(rows)
}

/// One dictionary by id, with the same derived fields [`list_dictionaries`]
/// reports.
///
/// A missing id is an error rather than an `Option`: every caller either just
/// committed the row (the importer) or is acting on a row the user selected.
pub fn dictionary_by_id(conn: &Connection, id: &str) -> Result<DictionarySummary, String> {
    let sql = format!("SELECT {DICTIONARY_COLS} FROM dictionaries WHERE id = ?1 LIMIT 1");
    let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
    let mut rows = stmt
        .query_map(params![id], row_to_summary)
        .map_err(|e| e.to_string())?;
    match rows.next() {
        Some(row) => row.map_err(|e| e.to_string()),
        None => Err(format!("dictionary not found: {id}")),
    }
}

/// Enable or disable a dictionary. Lookups skip disabled dictionaries.
pub fn toggle_dictionary(conn: &Connection, id: &str, enabled: bool) -> Result<(), String> {
    let changed = conn
        .execute(
            "UPDATE dictionaries SET enabled = ?1 WHERE id = ?2",
            params![enabled as i64, id],
        )
        .map_err(|e| e.to_string())?;
    if changed == 0 {
        return Err(format!("dictionary not found: {id}"));
    }
    Ok(())
}

/// Delete a dictionary and every row it owns, in one transaction. The database
/// file itself is kept: other dictionaries stay untouched.
pub fn delete_dictionary(conn: &Connection, id: &str) -> Result<(), String> {
    let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
    for table in ["terms", "kanjis", "term_meta", "tags"] {
        tx.execute(
            &format!("DELETE FROM {table} WHERE dictionary_id = ?1"),
            params![id],
        )
        .map_err(|e| e.to_string())?;
    }
    let changed = tx
        .execute("DELETE FROM dictionaries WHERE id = ?1", params![id])
        .map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())?;
    if changed == 0 {
        return Err(format!("dictionary not found: {id}"));
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Lookups
// ---------------------------------------------------------------------------

const TERM_COLS: &str = "id, dictionary_id, expression, reading, definition_tags, rules, score, sequence, term_tags, glossary_json";

fn row_to_term(row: &rusqlite::Row<'_>) -> rusqlite::Result<TermEntry> {
    let glossary_json: String = row.get(9)?;
    let glossary = serde_json::from_str(&glossary_json).unwrap_or(Value::Null);
    Ok(TermEntry {
        id: row.get(0)?,
        dictionary_id: row.get(1)?,
        expression: row.get(2)?,
        reading: row.get(3)?,
        definition_tags: row.get(4)?,
        rules: row.get(5)?,
        score: row.get(6)?,
        sequence: row.get(7)?,
        term_tags: row.get(8)?,
        glossary,
    })
}

/// Headwords matching `term` exactly, either as written form or as reading, from
/// enabled dictionaries only. Highest score first.
pub fn find_terms(
    conn: &Connection,
    term: &str,
    limit: Option<u32>,
) -> Result<Vec<TermEntry>, String> {
    let limit = limit.unwrap_or(DEFAULT_TERM_LIMIT).clamp(1, MAX_TERM_LIMIT) as i64;
    let sql = format!(
        "SELECT {TERM_COLS} FROM terms \
         WHERE (expression = ?1 OR reading = ?1) \
           AND dictionary_id IN (SELECT id FROM dictionaries WHERE enabled = 1) \
         ORDER BY score DESC, id LIMIT ?2"
    );
    let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(params![term, limit], row_to_term)
        .map_err(|e| e.to_string())?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|e| e.to_string())?;
    Ok(rows)
}

/// The kanji entry for a single character, from enabled dictionaries only.
///
/// Note: the `kanjis` table is keyed by `character` alone (one row per
/// character, as specified), so when several kanji dictionaries are imported the
/// most recent import wins for a shared character. Widening the key to
/// `(character, dictionary_id)` is the follow-up if per-dictionary kanji data is
/// ever needed.
pub fn find_kanji(conn: &Connection, character: &str) -> Result<Option<KanjiEntry>, String> {
    let sql = "SELECT character, dictionary_id, onyomi, kunyomi, tags, meanings_json, stats_json \
               FROM kanjis WHERE character = ?1 \
                 AND dictionary_id IN (SELECT id FROM dictionaries WHERE enabled = 1) \
               LIMIT 1";
    let mut stmt = conn.prepare(sql).map_err(|e| e.to_string())?;
    let mut rows = stmt
        .query_map(params![character], |row| {
            let meanings_json: Option<String> = row.get(5)?;
            let meanings = meanings_json
                .and_then(|raw| serde_json::from_str::<Vec<String>>(&raw).ok())
                .unwrap_or_default();
            let stats_json: Option<String> = row.get(6)?;
            Ok(KanjiEntry {
                character: row.get(0)?,
                dictionary_id: row.get(1)?,
                onyomi: row.get(2)?,
                kunyomi: row.get(3)?,
                tags: row.get(4)?,
                meanings,
                stats: stats_json.and_then(|raw| serde_json::from_str(&raw).ok()),
            })
        })
        .map_err(|e| e.to_string())?;
    match rows.next() {
        Some(row) => row.map(Some).map_err(|e| e.to_string()),
        None => Ok(None),
    }
}

// ---------------------------------------------------------------------------
// Bulk (deinflection) lookups
// ---------------------------------------------------------------------------
//
// Yomitan's `Translator` deinflects a block of text in ONE pass: scanning
// `食べた` asks for `[食べた, たべた, 食べる, たべる, …]` at once. The functions below
// are the bulk counterparts of `find_terms` / `find_kanji`: one IPC crossing per
// batch instead of one per candidate.
//
// Three properties the translator's own contract demands, and where they come
// from:
//
// - every row carries the `index` of the QUERY ITEM it answers — that is how a
//   deinflection is matched back to the text that produced it,
// - `dictionary` is the dictionary TITLE, not the id: the translator's enabled
//   dictionary map is keyed by title (`options.dictionaries[].name`),
// - a term row carries its `id`: the translator de-duplicates entries BY id, so
//   a constant id would collapse every distinct headword into one.
//
// Each query item is answered by its own indexed statement (prepared per shape,
// run per item) rather than one `IN (…)` statement: the index of the item that
// produced a row would otherwise have to be threaded back through a `CASE`
// expression, and a scan only ever asks for a handful of items.

/// Rows one candidate of a bulk term query may contribute. Matches
/// `DEFAULT_TERM_LIMIT`, the single-term default, so a scan and a search page
/// ask for the same depth.
const BULK_TERM_LIMIT: u32 = DEFAULT_TERM_LIMIT;

/// Hard ceiling on the rows ONE bulk term query returns, across all candidates.
///
/// A deinflection batch is a handful of candidates, so this only bites when a
/// short query (a single kana) matches a great many headwords in a large
/// dictionary — where an unbounded reply would be thousands of glossary payloads
/// over IPC for a popup that draws a few entries.
const MAX_BULK_TERM_ROWS: usize = 2000;

/// How a bulk term query compares a stored headword against the query term.
///
/// Note: `Suffix` is accepted but answers nothing (see `find_terms_bulk`).
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum TermMatchType {
    /// Whole headword (or reading) equals the query term. What a scan uses.
    #[default]
    Exact,
    /// Headword (or reading) starts with the query term.
    Prefix,
    /// Headword (or reading) ends with the query term. Not answered yet.
    Suffix,
}

/// One bulk term row: a headword plus the index of the query term it answers.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BulkTermEntry {
    /// Index into the request's `terms` array.
    pub index: usize,
    /// Dictionary TITLE (the translator keys its dictionary set by title).
    pub dictionary: String,
    /// Engine row id — the translator's de-duplication key.
    pub id: i64,
    pub expression: String,
    pub reading: Option<String>,
    pub definition_tags: Option<String>,
    pub rules: Option<String>,
    pub score: i64,
    pub sequence: i64,
    pub term_tags: Option<String>,
    pub glossary: Value,
}

/// One bulk term-metadata row (frequency / pitch accent / IPA).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TermMetaEntry {
    /// Index into the request's `terms` array.
    pub index: usize,
    pub expression: String,
    /// `freq`, `pitch` or `ipa`.
    pub mode: String,
    pub data: Value,
    /// Dictionary TITLE.
    pub dictionary: String,
}

/// One bulk kanji row: a character entry plus the index it answers.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BulkKanjiEntry {
    /// Index into the request's `characters` array.
    pub index: usize,
    /// Dictionary TITLE.
    pub dictionary: String,
    pub character: String,
    pub onyomi: Option<String>,
    pub kunyomi: Option<String>,
    pub tags: Option<String>,
    pub meanings: Vec<String>,
    pub stats: Option<Value>,
}

/// One tag lookup request: a tag name within one dictionary (both are the title /
/// name as the dictionary spells them, which is what the translator asks with).
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TagQuery {
    /// Tag name, already stripped of any :category suffix by the caller.
    pub query: String,
    /// Dictionary TITLE the tag must belong to.
    pub dictionary: String,
}

/// One bulk tag row: a tag definition plus the index of the request it answers.
///
/// The translator asks for tags as `{query, dictionary}` pairs and reads the
/// reply POSITIONALLY, so a tag that does not exist is simply a missing row (its
/// `index` says which request it was) rather than a placeholder.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BulkTagEntry {
    /// Index into the request's `items` array.
    pub index: usize,
    /// Tag name as the dictionary spells it.
    pub name: String,
    /// `partOfSpeech`, `frequency`, `group`, …
    pub category: String,
    /// The bank's `order` (Yomitan's name for it on a tag object).
    pub order: i64,
    pub notes: String,
    pub score: i64,
    /// Dictionary TITLE.
    pub dictionary: String,
}

/// Columns every bulk term query reads: the headword's own columns plus the
/// dictionary TITLE (joined, never the id).
const BULK_TERM_COLS: &str = "terms.id, dictionaries.title, terms.expression, terms.reading, \
     terms.definition_tags, terms.rules, terms.score, terms.sequence, terms.term_tags, terms.glossary_json";

fn bulk_row_to_term(row: &rusqlite::Row<'_>) -> rusqlite::Result<BulkTermEntry> {
    let glossary_json: String = row.get(9)?;
    let glossary = serde_json::from_str(&glossary_json).unwrap_or(Value::Null);
    Ok(BulkTermEntry {
        // Filled in by the caller: the index of the query term this row answers.
        index: 0,
        dictionary: row.get(1)?,
        id: row.get(0)?,
        expression: row.get(2)?,
        reading: row.get(3)?,
        definition_tags: row.get(4)?,
        rules: row.get(5)?,
        score: row.get(6)?,
        sequence: row.get(7)?,
        term_tags: row.get(8)?,
        glossary,
    })
}

/// Run one prepared bulk term statement and collect its rows.
fn collect_bulk_terms(
    statement: &mut rusqlite::Statement<'_>,
    args: &[&dyn rusqlite::ToSql],
) -> Result<Vec<BulkTermEntry>, String> {
    let rows = statement
        .query_map(rusqlite::params_from_iter(args), bulk_row_to_term)
        .map_err(|e| e.to_string())?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|e| e.to_string())?;
    Ok(rows)
}

/// The smallest string that sorts after every string starting with `prefix`.
///
/// SQLite compares text byte-wise and UTF-8 byte order IS code point order, so
/// the successor of the prefix's LAST CHARACTER is that bound.
///
/// `None` means no bound can be expressed: an empty prefix (everything matches)
/// or a prefix ending on a code point with no successor (U+10FFFF, or U+D7FF
/// whose successor is a surrogate). Callers treat it as "cannot answer".
fn prefix_upper_bound(prefix: &str) -> Option<String> {
    let mut chars: Vec<char> = prefix.chars().collect();
    loop {
        let last = chars.pop()?;
        match char::from_u32(last as u32 + 1) {
            Some(successor) => {
                chars.push(successor);
                return Some(chars.into_iter().collect());
            }
            // No successor code point: drop this character and carry the bump
            // left, exactly as an overflowing increment would.
            None => continue,
        }
    }
}

/// Headwords matching MANY query terms in one round trip, from enabled
/// dictionaries only, highest score first.
///
/// Answers `Exact` and `Prefix`.
/// Note: `Suffix` answers nothing yet — SQLite cannot range-scan a suffix through
/// the `expression` index (only a leading-wildcard scan, which over a 500 MB bank
/// is seconds of full-table work), and no Entei surface selects suffix matching
/// today. The follow-up is Yomitan's own reversed-expression index.
pub fn find_terms_bulk(
    conn: &Connection,
    terms: &[String],
    match_type: TermMatchType,
    limit: Option<u32>,
) -> Result<Vec<BulkTermEntry>, String> {
    let limit = limit.unwrap_or(BULK_TERM_LIMIT).clamp(1, MAX_TERM_LIMIT) as i64;
    if terms.is_empty() || match_type == TermMatchType::Suffix {
        return Ok(Vec::new());
    }

    // Placeholder numbering differs per shape, so each shape is its own prepared
    // statement rather than one SQL string assembled at run time.
    let exact_sql = format!(
        "SELECT {BULK_TERM_COLS} FROM terms \
         JOIN dictionaries ON dictionaries.id = terms.dictionary_id \
         WHERE dictionaries.enabled = 1 AND (terms.expression = ?1 OR terms.reading = ?1) \
         ORDER BY terms.score DESC, terms.id LIMIT ?2"
    );
    let prefix_sql = format!(
        "SELECT {BULK_TERM_COLS} FROM terms \
         JOIN dictionaries ON dictionaries.id = terms.dictionary_id \
         WHERE dictionaries.enabled = 1 AND ( \
           (terms.expression >= ?1 AND terms.expression < ?2) OR \
           (terms.reading >= ?1 AND terms.reading < ?2) \
         ) ORDER BY terms.score DESC, terms.id LIMIT ?3"
    );

    let mut rows: Vec<BulkTermEntry> = Vec::new();
    for (index, term) in terms.iter().enumerate() {
        if term.is_empty() {
            continue;
        }
        let mut found = match match_type {
            TermMatchType::Exact => {
                let mut statement = conn.prepare(&exact_sql).map_err(|e| e.to_string())?;
                collect_bulk_terms(&mut statement, &[term, &limit])?
            }
            TermMatchType::Prefix => {
                let Some(upper) = prefix_upper_bound(term) else {
                    continue;
                };
                let mut statement = conn.prepare(&prefix_sql).map_err(|e| e.to_string())?;
                collect_bulk_terms(&mut statement, &[term, &upper, &limit])?
            }
            TermMatchType::Suffix => continue,
        };
        for row in &mut found {
            row.index = index;
        }
        rows.append(&mut found);
    }

    // Candidates are answered independently, so the ceiling applies to the merged
    // whole: the best-scoring rows win whichever candidate found them, which is
    // also the order the translator re-sorts them into.
    rows.sort_by(|left, right| {
        right
            .score
            .cmp(&left.score)
            .then_with(|| left.id.cmp(&right.id))
    });
    rows.truncate(MAX_BULK_TERM_ROWS);
    Ok(rows)
}

/// Term metadata (frequency / pitch / IPA) for MANY query terms in one round
/// trip, from enabled dictionaries only.
pub fn find_term_meta_bulk(
    conn: &Connection,
    terms: &[String],
) -> Result<Vec<TermMetaEntry>, String> {
    if terms.is_empty() {
        return Ok(Vec::new());
    }
    const SQL: &str = "SELECT term_meta.expression, term_meta.mode, term_meta.data_json, dictionaries.title \
         FROM term_meta JOIN dictionaries ON dictionaries.id = term_meta.dictionary_id \
         WHERE dictionaries.enabled = 1 AND term_meta.expression = ?1";

    let mut statement = conn.prepare(SQL).map_err(|e| e.to_string())?;
    let mut rows: Vec<TermMetaEntry> = Vec::new();
    for (index, term) in terms.iter().enumerate() {
        if term.is_empty() {
            continue;
        }
        let found = statement
            .query_map(params![term], |row| {
                let data_json: String = row.get(2)?;
                let data = serde_json::from_str(&data_json).unwrap_or(Value::Null);
                Ok(TermMetaEntry {
                    index,
                    expression: row.get(0)?,
                    mode: row.get(1)?,
                    data,
                    dictionary: row.get(3)?,
                })
            })
            .map_err(|e| e.to_string())?
            .collect::<rusqlite::Result<Vec<_>>>()
            .map_err(|e| e.to_string())?;
        rows.extend(found);
    }
    Ok(rows)
}

/// Kanji entries for MANY characters in one round trip, from enabled
/// dictionaries only.
///
/// The `kanjis` table is keyed by `character` alone (see `find_kanji`), so a
/// character answers at most one row however often the request repeats it.
pub fn find_kanji_bulk(
    conn: &Connection,
    characters: &[String],
) -> Result<Vec<BulkKanjiEntry>, String> {
    if characters.is_empty() {
        return Ok(Vec::new());
    }
    const SQL: &str = "SELECT kanjis.character, kanjis.onyomi, kanjis.kunyomi, kanjis.tags, \
         kanjis.meanings_json, kanjis.stats_json, \
         (SELECT title FROM dictionaries WHERE dictionaries.id = kanjis.dictionary_id) \
         FROM kanjis WHERE character = ?1 \
           AND dictionary_id IN (SELECT id FROM dictionaries WHERE enabled = 1) LIMIT 1";

    let mut statement = conn.prepare(SQL).map_err(|e| e.to_string())?;
    let mut rows: Vec<BulkKanjiEntry> = Vec::new();
    for (index, character) in characters.iter().enumerate() {
        if character.is_empty() {
            continue;
        }
        let found = statement
            .query_map(params![character], |row| {
                let meanings_json: Option<String> = row.get(4)?;
                let meanings = meanings_json
                    .and_then(|raw| serde_json::from_str::<Vec<String>>(&raw).ok())
                    .unwrap_or_default();
                let stats_json: Option<String> = row.get(5)?;
                Ok(BulkKanjiEntry {
                    index,
                    dictionary: row.get(6)?,
                    character: row.get(0)?,
                    onyomi: row.get(1)?,
                    kunyomi: row.get(2)?,
                    tags: row.get(3)?,
                    meanings,
                    stats: stats_json.and_then(|raw| serde_json::from_str(&raw).ok()),
                })
            })
            .map_err(|e| e.to_string())?
            .collect::<rusqlite::Result<Vec<_>>>()
            .map_err(|e| e.to_string())?;
        rows.extend(found);
    }
    Ok(rows)
}

/// Tag definitions for MANY `{name, dictionary}` requests, from enabled
/// dictionaries only.
///
/// A request with no matching tag contributes no row (the caller reads the reply
/// positionally through each row's `index`), and a tag several enabled
/// dictionaries define contributes one row per dictionary: the translator asks
/// per dictionary and picks the one it is drawing.
pub fn find_tags_bulk(conn: &Connection, items: &[TagQuery]) -> Result<Vec<BulkTagEntry>, String> {
    if items.is_empty() {
        return Ok(Vec::new());
    }
    const SQL: &str = "SELECT tags.name, tags.category, tags.sorting, tags.notes, tags.score, dictionaries.title \
         FROM tags JOIN dictionaries ON dictionaries.id = tags.dictionary_id \
         WHERE dictionaries.enabled = 1 AND tags.name = ?1 AND dictionaries.title = ?2";

    let mut statement = conn.prepare(SQL).map_err(|e| e.to_string())?;
    let mut rows: Vec<BulkTagEntry> = Vec::new();
    for (index, item) in items.iter().enumerate() {
        if item.query.is_empty() || item.dictionary.is_empty() {
            continue;
        }
        let found = statement
            .query_map(params![item.query, item.dictionary], |row| {
                Ok(BulkTagEntry {
                    index,
                    name: row.get(0)?,
                    category: row.get(1)?,
                    order: row.get(2)?,
                    notes: row.get(3)?,
                    score: row.get(4)?,
                    dictionary: row.get(5)?,
                })
            })
            .map_err(|e| e.to_string())?
            .collect::<rusqlite::Result<Vec<_>>>()
            .map_err(|e| e.to_string())?;
        rows.extend(found);
    }
    Ok(rows)
}

// ---------------------------------------------------------------------------
// Storage measurement
// ---------------------------------------------------------------------------

/// How much disk the dictionary database holds, and how much its volume still
/// has available.
///
/// The renderer's own `navigator.storage.estimate()` cannot answer this: every
/// dictionary byte lives in a Rust-owned SQLite file, so from the browser the
/// origin holds 0 bytes however many gigabytes were imported.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StorageUsageSnapshot {
    /// Bytes held by the database file and its WAL sidecars.
    pub usage: u64,
    /// Bytes the volume still offers, or 0 when the platform will not say.
    pub quota: u64,
}

/// The database file plus the two WAL sidecars [`configure`] switches on. The WAL
/// can hold dictionary pages that are not in the main file yet, so measuring the
/// main file alone would under-report a just-imported dictionary.
const DATABASE_FILE_SIDECARS: [&str; 3] = ["", "-wal", "-shm"];

/// Measure `yomitan-dictionaries.db*` inside `dir` (the `app_data_dir`).
///
/// A file that is not there counts as 0 rather than failing: a database that was
/// never imported into — or whose WAL was checkpointed away — really is 0 bytes,
/// and the settings meter must still draw.
pub fn storage_usage(dir: &Path) -> StorageUsageSnapshot {
    let usage = DATABASE_FILE_SIDECARS
        .iter()
        .filter_map(|suffix| {
            std::fs::metadata(dir.join(format!("{DATABASE_FILE_NAME}{suffix}"))).ok()
        })
        .map(|metadata| metadata.len())
        .sum();
    StorageUsageSnapshot {
        usage,
        quota: volume_available_bytes(dir),
    }
}

/// Bytes the volume holding `path` still has available, or 0 when the platform
/// cannot be asked.
///
/// Note: `std` has no stable free-space call, so each platform's own one is used
/// (a few lines of FFI rather than a crate for one number). AVAILABLE bytes are
/// reported because that is what answers "will this volume take another
/// dictionary?" — the same meaning `estimate().quota` has in a browser.
fn volume_available_bytes(path: &Path) -> u64 {
    #[cfg(windows)]
    {
        windows_available_bytes(path)
    }
    #[cfg(unix)]
    {
        unix_available_bytes(path).unwrap_or(0)
    }
    #[cfg(not(any(windows, unix)))]
    {
        let _ = path;
        0
    }
}

/// `GetDiskFreeSpaceExW`'s caller-available byte count for `path`.
#[cfg(windows)]
fn windows_available_bytes(path: &Path) -> u64 {
    use std::os::windows::ffi::OsStrExt;

    #[link(name = "kernel32")]
    extern "system" {
        fn GetDiskFreeSpaceExW(
            directory: *const u16,
            free_bytes_available_to_caller: *mut u64,
            total_bytes: *mut u64,
            total_free_bytes: *mut u64,
        ) -> i32;
    }

    // The NUL-terminated wide form every Win32 path function takes. A path with
    // an interior NUL cannot exist on disk, so this cannot truncate a real one.
    let mut wide: Vec<u16> = path.as_os_str().encode_wide().collect();
    wide.push(0);
    let mut available: u64 = 0;
    // SAFETY: `wide` is NUL-terminated and outlives the call; the first out
    // pointer writes a real `u64`, and the two this function does not need are
    // documented as optional (null is allowed).
    let ok = unsafe {
        GetDiskFreeSpaceExW(
            wide.as_ptr(),
            &mut available,
            std::ptr::null_mut(),
            std::ptr::null_mut(),
        )
    };
    if ok == 0 {
        0
    } else {
        available
    }
}

/// `statvfs`'s caller-available byte count for `path` (Linux, Android, macOS).
#[cfg(unix)]
fn unix_available_bytes(path: &Path) -> Option<u64> {
    use std::ffi::CString;
    use std::os::unix::ffi::OsStrExt;

    let c_path = CString::new(path.as_os_str().as_bytes()).ok()?;
    // SAFETY: `c_path` is NUL-terminated, and `statvfs` only writes into the
    // zeroed struct this function owns.
    let mut stats: libc::statvfs = unsafe { std::mem::zeroed() };
    if unsafe { libc::statvfs(c_path.as_ptr(), &mut stats) } != 0 {
        return None;
    }
    // `f_frsize` is the real block size; POSIX allows it to be 0, where the
    // filesystem block size is the only stride left.
    let block = if stats.f_frsize > 0 {
        stats.f_frsize
    } else {
        stats.f_bsize
    };
    Some(u64::from(stats.f_bavail) * u64::from(block))
}

// ---------------------------------------------------------------------------
// Import
// ---------------------------------------------------------------------------

/// `index.json` as written by Yomitan. Only the documented fields are read.
#[derive(Debug, Default, Deserialize)]
struct DictionaryIndex {
    #[serde(default)]
    title: Option<String>,
    #[serde(default)]
    format: Option<i64>,
    #[serde(default)]
    revision: Option<String>,
    #[serde(default)]
    sequenced: Option<bool>,
    #[serde(default)]
    author: Option<String>,
    #[serde(default)]
    url: Option<String>,
    #[serde(default)]
    description: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum BankKind {
    Term,
    Kanji,
    TermMeta,
    Tag,
}

impl BankKind {
    fn of(file_name: &str) -> Option<Self> {
        // `term_meta_bank_1.json` must not be swallowed by the `term_bank_`
        // prefix check, so the more specific name is tested first.
        if file_name.starts_with("term_meta_bank_") && file_name.ends_with(".json") {
            Some(Self::TermMeta)
        } else if file_name.starts_with("term_bank_") && file_name.ends_with(".json") {
            Some(Self::Term)
        } else if file_name.starts_with("kanji_bank_") && file_name.ends_with(".json") {
            Some(Self::Kanji)
        } else if file_name.starts_with("tag_bank_") && file_name.ends_with(".json") {
            Some(Self::Tag)
        } else {
            None
        }
    }
}

/// Import a Yomitan dictionary ZIP. Anything `Read + Seek` works, so callers can
/// pass a `Vec<u8>` cursor (bundled dictionary) or a `BufReader<File>` (a file
/// on disk, streamed straight out of the ZIP with no full read).
///
/// The import replaces that dictionary's previous content in one transaction:
/// a failed import leaves the earlier state intact. Re-importing always ends
/// with the dictionary enabled.
///
/// Callers that have to report progress (the Tauri command) use
/// [`import_dictionary_with_progress`]; this is that import with no reporter.
pub fn import_dictionary<R: Read + Seek>(
    conn: &Connection,
    reader: R,
) -> Result<DictionarySummary, String> {
    import_dictionary_with_progress(conn, reader, &mut |_| {})
}

/// The same import, reporting [`ImportProgress`] to `on_progress`: once before
/// the first bank, then after every bank that was written (plus, for a bank over
/// `INTRA_BANK_PROGRESS_MIN_BYTES`, while that bank streams).
///
/// The callback runs on the caller's thread (the Tauri command emits from the
/// blocking pool) and only observes — it cannot abort or alter the import.
pub fn import_dictionary_with_progress<R: Read + Seek>(
    conn: &Connection,
    reader: R,
    on_progress: &mut dyn FnMut(ImportProgress),
) -> Result<DictionarySummary, String> {
    let mut archive =
        ZipArchive::new(reader).map_err(|e| format!("not a readable dictionary zip: {e}"))?;

    let mut index_entry: Option<usize> = None;
    let mut banks: Vec<(BankKind, usize, String)> = Vec::new();
    // Fast central directory scan: `file_names()` only iterates in-memory
    // string slices from the ZIP directory without seeking local file headers
    // on disk. On large dictionaries with thousands of entries (e.g. Kojien with
    // 7,688 files), calling `by_index()` here caused a 6-7s blocking freeze.
    let names: Vec<String> = archive.file_names().map(|s| s.to_string()).collect();
    for (position, name) in names.iter().enumerate() {
        if name.ends_with('/') || name.ends_with('\\') {
            continue;
        }
        // Only the base name is classified: dictionaries nest their banks in a
        // folder, and folder names must not affect detection.
        let base = name
            .rsplit(['/', '\\'])
            .next()
            .unwrap_or(name)
            .to_ascii_lowercase();
        if base == "index.json" {
            if index_entry.is_some() {
                return Err("dictionary zip contains more than one index.json".to_string());
            }
            index_entry = Some(position);
            continue;
        }
        if let Some(kind) = BankKind::of(&base) {
            banks.push((kind, position, base));
        }
    }

    let index_position =
        index_entry.ok_or_else(|| "dictionary zip is missing index.json".to_string())?;
    let index = read_index(&mut archive, index_position)?;
    let summary = DictionarySummary {
        id: dictionary_id(
            index.format.unwrap_or(0),
            index.revision.as_deref().unwrap_or(""),
            index.title.as_deref().unwrap_or(""),
        ),
        title: index
            .title
            .clone()
            .unwrap_or_else(|| "Untitled dictionary".to_string()),
        format: index.format.unwrap_or(0),
        revision: index.revision.clone().unwrap_or_default(),
        sequenced: index.sequenced.unwrap_or(false),
        author: index.author.clone(),
        url: index.url.clone(),
        description: index.description.clone(),
        created_at: now_ms(),
        enabled: true,
        // Not read from `index.json`: a bank is not inspected until it is
        // written, so the stored row (read back below) is what reports it.
        has_frequency_data: false,
    };

    if banks.is_empty() {
        return Err("dictionary zip contains no term/kanji/term_meta/tag bank".to_string());
    }
    // Deterministic order: `term_bank_10` and `term_bank_2` are unrelated files,
    // but stable ordering keeps the same ZIP producing byte-identical rows.
    banks.sort_by(|a, b| a.2.cmp(&b.2));

    let total = banks.len() as u32;
    on_progress(ImportProgress::new(0, total));
    write_banks(conn, &mut archive, &summary, &banks, on_progress)?;
    // Read the row back instead of returning `summary`: `has_frequency_data` is
    // counted out of the stored `term_meta` rows, so the committed row is the
    // only truthful source for it.
    dictionary_by_id(conn, &summary.id)
}

/// Stream a dictionary ZIP from disk (the Tauri command path).
pub fn import_dictionary_from_path(
    conn: &Connection,
    path: impl AsRef<Path>,
) -> Result<DictionarySummary, String> {
    import_dictionary_from_path_with_progress(conn, path, &mut |_| {})
}

/// The same path-based import, reporting progress as it writes: once per bank,
/// and while a bank over `INTRA_BANK_PROGRESS_MIN_BYTES` streams (the Tauri
/// command path — the ZIP is read off disk, never buffered whole).
pub fn import_dictionary_from_path_with_progress(
    conn: &Connection,
    path: impl AsRef<Path>,
    on_progress: &mut dyn FnMut(ImportProgress),
) -> Result<DictionarySummary, String> {
    let path = path.as_ref();
    let file = File::open(path).map_err(|e| format!("failed to open {}: {e}", path.display()))?;
    import_dictionary_with_progress(conn, BufReader::new(file), on_progress)
}

fn read_index<R: Read + Seek>(
    archive: &mut ZipArchive<R>,
    position: usize,
) -> Result<DictionaryIndex, String> {
    let mut file = archive.by_index(position).map_err(|e| e.to_string())?;
    let mut raw = String::new();
    file.read_to_string(&mut raw).map_err(|e| e.to_string())?;
    // Same BOM tolerance as the banks: `serde_json` rejects a BOM.
    let raw = raw.strip_prefix('\u{feff}').unwrap_or(&raw);
    serde_json::from_str(raw).map_err(|e| format!("invalid index.json: {e}"))
}

/// Replace the dictionary's rows and insert every bank entry, in one
/// transaction over prepared statements.
fn write_banks<R: Read + Seek>(
    conn: &Connection,
    archive: &mut ZipArchive<R>,
    summary: &DictionarySummary,
    banks: &[(BankKind, usize, String)],
    on_progress: &mut dyn FnMut(ImportProgress),
) -> Result<(), String> {
    let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
    for table in ["terms", "kanjis", "term_meta", "tags"] {
        tx.execute(
            &format!("DELETE FROM {table} WHERE dictionary_id = ?1"),
            params![summary.id],
        )
        .map_err(|e| e.to_string())?;
    }
    tx.execute(
        "INSERT INTO dictionaries (id, title, format, revision, sequenced, author, url, description, created_at, enabled) \
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, 1) \
         ON CONFLICT(id) DO UPDATE SET \
           title=excluded.title, format=excluded.format, revision=excluded.revision, \
           sequenced=excluded.sequenced, author=excluded.author, url=excluded.url, \
           description=excluded.description, enabled=1",
        params![
            summary.id,
            summary.title,
            summary.format,
            summary.revision,
            summary.sequenced as i64,
            summary.author,
            summary.url,
            summary.description,
            summary.created_at,
        ],
    )
    .map_err(|e| e.to_string())?;

    let mut term_stmt = tx
        .prepare(
            "INSERT INTO terms (dictionary_id, expression, reading, definition_tags, rules, score, sequence, term_tags, glossary_json) \
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
        )
        .map_err(|e| e.to_string())?;
    let mut kanji_stmt = tx
        .prepare(
            "INSERT INTO kanjis (character, dictionary_id, onyomi, kunyomi, tags, meanings_json, stats_json) \
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7) \
             ON CONFLICT(character) DO UPDATE SET \
               dictionary_id=excluded.dictionary_id, onyomi=excluded.onyomi, kunyomi=excluded.kunyomi, \
               tags=excluded.tags, meanings_json=excluded.meanings_json, stats_json=excluded.stats_json",
        )
        .map_err(|e| e.to_string())?;
    let mut meta_stmt = tx
        .prepare(
            "INSERT INTO term_meta (expression, mode, data_json, dictionary_id) VALUES (?1, ?2, ?3, ?4)",
        )
        .map_err(|e| e.to_string())?;
    let mut tag_stmt = tx
        .prepare(
            "INSERT INTO tags (name, category, sorting, notes, score, dictionary_id) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        )
        .map_err(|e| e.to_string())?;

    let total = banks.len() as u32;
    for (index, (kind, position, name)) in banks.iter().enumerate() {
        let file = archive
            .by_index(*position)
            .map_err(|e| format!("failed to read {name}: {e}"))?;
        let bank_index = index as u32;
        // The uncompressed size the ZIP's central directory already knows: the
        // denominator of the in-bank progress a big bank reports.
        let bank_bytes = file.size();
        let consumed: ConsumedBytes = Rc::new(Cell::new(0));
        let mut reader = CountingReader::new(BufReader::new(file), consumed.clone());
        let mut reported = 0u32;
        let result = {
            let mut visit = |value: Value| -> Result<(), String> {
                match kind {
                    BankKind::Term => insert_term(&mut term_stmt, &summary.id, &value)?,
                    BankKind::Kanji => insert_kanji(&mut kanji_stmt, &summary.id, &value)?,
                    BankKind::TermMeta => insert_term_meta(&mut meta_stmt, &summary.id, &value)?,
                    BankKind::Tag => insert_tag(&mut tag_stmt, &summary.id, &value)?,
                }
                report_bank_progress(
                    on_progress,
                    &mut reported,
                    bank_index,
                    total,
                    bank_bytes,
                    consumed.get(),
                );
                Ok(())
            };
            stream_bank(&mut reader, &mut visit)
        };
        result.map_err(|e| format!("{name}: {e}"))?;
        // After the bank is in: the percent the UI shows is real work done,
        // not time spent reading the ZIP's central directory.
        on_progress(ImportProgress::new(index as u32 + 1, total));
    }

    // The statements borrow the transaction, so they must be gone before it is
    // committed.
    drop((term_stmt, kanji_stmt, meta_stmt, tag_stmt));
    tx.commit().map_err(|e| e.to_string())
}

/// Insert one streamed bank entry. An entry that cannot be parsed is skipped
/// rather than failing the whole import: third-party banks occasionally carry a
/// malformed entry, and losing one row beats losing a 500 MB dictionary.
fn insert_term(
    statement: &mut rusqlite::Statement<'_>,
    dictionary_id: &str,
    value: &Value,
) -> Result<(), String> {
    let Some(row) = parse_term(value) else {
        return Ok(());
    };
    statement
        .execute(params![
            dictionary_id,
            row.expression,
            row.reading,
            row.definition_tags,
            row.rules,
            row.score,
            row.sequence,
            row.term_tags,
            row.glossary_json,
        ])
        .map_err(|e| e.to_string())?;
    Ok(())
}

fn insert_kanji(
    statement: &mut rusqlite::Statement<'_>,
    dictionary_id: &str,
    value: &Value,
) -> Result<(), String> {
    let Some(row) = parse_kanji(value) else {
        return Ok(());
    };
    statement
        .execute(params![
            row.character,
            dictionary_id,
            row.onyomi,
            row.kunyomi,
            row.tags,
            row.meanings_json,
            row.stats_json,
        ])
        .map_err(|e| e.to_string())?;
    Ok(())
}

fn insert_term_meta(
    statement: &mut rusqlite::Statement<'_>,
    dictionary_id: &str,
    value: &Value,
) -> Result<(), String> {
    let Some(row) = parse_term_meta(value) else {
        return Ok(());
    };
    statement
        .execute(params![
            row.expression,
            row.mode,
            row.data_json,
            dictionary_id
        ])
        .map_err(|e| e.to_string())?;
    Ok(())
}

fn insert_tag(
    statement: &mut rusqlite::Statement<'_>,
    dictionary_id: &str,
    value: &Value,
) -> Result<(), String> {
    let Some(row) = parse_tag(value) else {
        return Ok(());
    };
    statement
        .execute(params![
            row.name,
            row.category,
            row.sorting,
            row.notes,
            row.score,
            dictionary_id
        ])
        .map_err(|e| e.to_string())?;
    Ok(())
}

// ---------------------------------------------------------------------------
// Streaming JSON bank reader
// ---------------------------------------------------------------------------

/// Skip whitespace (and a leading UTF-8 BOM) and return the next byte without
/// consuming it.
///
/// Note: a BOM is tolerated because the Rust subtitle/filename parsers on this
/// project had to handle BOM-prefixed files too; `serde_json` rejects one, so it
/// is consumed here rather than letting an otherwise valid bank fail to import.
fn peek_non_whitespace<R: BufRead>(reader: &mut R) -> Result<Option<u8>, String> {
    const BOM: [u8; 3] = [0xef, 0xbb, 0xbf];
    loop {
        let buffer = reader
            .fill_buf()
            .map_err(|e| format!("failed to read bank: {e}"))?;
        if buffer.starts_with(&BOM) {
            reader.consume(BOM.len());
            continue;
        }
        match buffer.iter().position(|byte| !byte.is_ascii_whitespace()) {
            Some(index) => return Ok(Some(buffer[index])),
            None => {
                let consumed = buffer.len();
                reader.consume(consumed);
                if consumed == 0 {
                    return Ok(None);
                }
            }
        }
    }
}

/// Visit every element of a bank file, one at a time.
///
/// The file is normally a top-level JSON array; its `[` is consumed and elements
/// are deserialized individually so nothing but one element is ever resident. A
/// bank whose top level is a single value (some third-party tools emit one
/// object) is parsed whole and visited as a single entry.
fn stream_bank<R: BufRead>(
    reader: &mut R,
    visit: &mut dyn FnMut(Value) -> Result<(), String>,
) -> Result<(), String> {
    match peek_non_whitespace(reader)? {
        None => return Err("bank file is empty".to_string()),
        Some(b'[') => reader.consume(1),
        Some(_) => {
            let mut whole = String::new();
            reader
                .read_to_string(&mut whole)
                .map_err(|e| format!("failed to read bank: {e}"))?;
            let value: Value =
                serde_json::from_str(&whole).map_err(|e| format!("invalid bank JSON: {e}"))?;
            visit(value)?;
            return Ok(());
        }
    }

    loop {
        match peek_non_whitespace(reader)? {
            // `]` closes the bank array: done.
            None => return Err("unterminated bank array".to_string()),
            Some(b']') => {
                reader.consume(1);
                return Ok(());
            }
            // Separator between two elements.
            Some(b',') => reader.consume(1),
            Some(_) => {
                let mut deserializer = serde_json::Deserializer::from_reader(&mut *reader);
                let value = Value::deserialize(&mut deserializer)
                    .map_err(|e| format!("invalid bank JSON: {e}"))?;
                drop(deserializer);
                visit(value)?;
            }
        }
    }
}

// ---------------------------------------------------------------------------
// Dexie JSON backup import (Yomitan "Export Database")
// ---------------------------------------------------------------------------
//
// Yomitan's "Export Database" writes a Dexie.js (IndexedDB) dump: one JSON
// object whose `data.data` array holds a `{table, rows}` entry per object store.
// A full backup reaches several gigabytes, so it is NEVER buffered whole — the
// file is read off a `BufRead` and one row at a time is deserialized off it,
// exactly like the ZIP bank importer above. Peak memory is one row plus the
// transaction, not the file. Each table's `rows` array is likewise streamed one
// element at a time (never materialized as a `Vec`), so a 2.8 GB `terms` store
// costs one row of memory, not the whole table.
//
// Row shape: each element of `rows` is any of the plain object
// `{"expression": ...}`, Dexie's `arrayNonindexKeys` wrap `{"$": [key, {...}]}`
// (appears when a store carries keys outside its keyPath), or the bare primary-
// key tuple `[key, {...}]` the `inbound=false` stores (dictionaries, kanji,
// termMeta, tagMeta) are written as in a real export. All three unwrap to the
// inner object before field parsing.
//
// Stores mapped: `dictionaries`, `terms`, `termMeta`, `kanji`, `tagMeta`.
// `kanjiMeta` and `media` are skipped — this schema models the five tables the
// lookups read, and a backup legitimately carries stores we do not.

/// Rows one transaction batches before it commits. Keeps the WAL from growing
/// without holding a multi-gigabyte import in one transaction, and a batch is
/// small enough that a crash loses little work.
const DEXIE_TRANSACTION_ROWS: usize = 5_000;

/// The title-less dictionary id a store row lands under when it names no
/// dictionary (array-form rows carry no `dictionary` field). [`DexieImport::finish`]
/// adopts these rows onto the single dictionary once the document has streamed.
const DEXIE_UNRESOLVED_DICTIONARY_ID: &str = "unresolved";

/// One imported dictionary as the Dexie importer reports it (same shape the ZIP
/// importer returns, so the web layer lists both kinds identically).
pub type DexieImportedDictionary = DictionarySummary;

/// Drop a Dexie key wrap, returning the row object.
///
/// A store whose rows are keyed OUTSIDE their keyPath arrives in one of two
/// wrapped shapes, and both carry the primary key the schema does not model:
/// - `{"$": [key, {…}]}` — Dexie's `arrayNonindexKeys` envelope.
/// - `[key, {…}]` — a bare primary-key tuple, which is how the `inbound=false`
///   stores (`dictionaries`, `kanji`, `termMeta`, `tagMeta`) are written in a
///   real export (e.g. `[1, {"title": "JMdict", …}]`).
///
/// Both are unwrapped to the inner object. The tuple form is recognized only
/// when its second element is an object, so a legit two-element ARRAY-form row
/// (e.g. `terms` `[expression, glossary]`, whose slot 1 is never an object) is
/// left alone for [`dexie_expand_array_row`] to expand by position.
///
/// Returns `None` for anything that is not an object / a recognizable tuple —
/// such a row is skipped, not fatal (a backup never carries one, but a partial
/// or hand-edited one may).
fn dexie_unwrap_row(value: Value) -> Option<Map<String, Value>> {
    match value {
        Value::Object(object) => {
            if let Some(wrapped) = object.get("$").and_then(Value::as_array) {
                return wrapped.get(1)?.as_object().cloned();
            }
            Some(object)
        }
        Value::Array(items) if items.len() == 2 => items.into_iter().nth(1)?.as_object().cloned(),
        _ => None,
    }
}

/// The outcome of normalizing one raw row for a store: an object ready for the
/// store handler, or a signal that the row carries nothing insertable and should
/// be skipped (not fatal — a backup never carries one, but a partial or
/// hand-edited one may).
enum DexieRow {
    Object(Map<String, Value>),
    Skipped,
}

/// Expand an array-form row into its named fields.
///
/// Some stores arrive as arrays — the same layouts the ZIP bank importer reads —
/// alongside the object form, so both shapes funnel through one handler:
/// - `terms`: `[expression, reading, definitionTags, rules, score, glossary, sequence, termTags]`
/// - `kanji`: `[character, onyomi, kunyomi, tags, meanings, stats]`
/// - `termMeta`: `[expression, mode, data]`
///
/// `terms` has the same ambiguous slot 5/6 as [`parse_term`] (some tools emit
/// `[..., score, sequence, glossary, termTags]`), resolved the same way. An
/// object row (or a `{"$": [key, {...}]}` wrap) passes through unchanged.
fn dexie_expand_array_row(table: &str, row: Value) -> DexieRow {
    if let Value::Array(items) = &row {
        // A bare primary-key tuple `[key, {...}]` (how the `inbound=false`
        // stores are written) is unwrapped to its object FIRST, so it is not
        // mistaken for an array-form row of the store. The guard — exactly two
        // elements whose second is an object — never matches a legit array-form
        // row, whose slot 1 is a reading / kunyomi / mode scalar, never an
        // object.
        if items.len() == 2 && items[1].as_object().is_some() {
            return match dexie_unwrap_row(row) {
                Some(object) => DexieRow::Object(object),
                None => DexieRow::Skipped,
            };
        }
    }
    if let Value::Array(items) = row {
        return dexie_expand_positional_row(table, &items);
    }
    match dexie_unwrap_row(row) {
        Some(object) => DexieRow::Object(object),
        None => DexieRow::Skipped,
    }
}

/// Expand a true array-form row (NOT a `[key, {…}]` tuple) into its named
/// fields, positionally.
fn dexie_expand_positional_row(table: &str, items: &[Value]) -> DexieRow {
    let field = |index: usize| items.get(index).cloned().unwrap_or(Value::Null);
    let object = match table {
        "terms" => {
            if items.len() < 6 || items[0].as_str().is_none() {
                return DexieRow::Skipped;
            }
            let mut glossary_index = 5;
            let mut sequence_index = 6;
            if items.len() > 6 && items[5].is_number() && !items[6].is_number() {
                glossary_index = 6;
                sequence_index = 5;
            }
            let mut object = Map::new();
            object.insert("expression".into(), field(0));
            object.insert("reading".into(), field(1));
            object.insert("definitionTags".into(), field(2));
            object.insert("rules".into(), field(3));
            object.insert("score".into(), field(4));
            object.insert("glossary".into(), field(glossary_index));
            object.insert("sequence".into(), field(sequence_index));
            object.insert("termTags".into(), field(7));
            object
        }
        "kanji" => {
            if items.len() < 5 || items[0].as_str().is_none() {
                return DexieRow::Skipped;
            }
            let mut object = Map::new();
            object.insert("character".into(), field(0));
            object.insert("onyomi".into(), field(1));
            object.insert("kunyomi".into(), field(2));
            object.insert("tags".into(), field(3));
            object.insert("meanings".into(), field(4));
            object.insert("stats".into(), field(5));
            object
        }
        "termMeta" => {
            if items.len() < 3 || items[0].as_str().is_none() {
                return DexieRow::Skipped;
            }
            let mut object = Map::new();
            object.insert("expression".into(), field(0));
            object.insert("mode".into(), field(1));
            object.insert("data".into(), field(2));
            object
        }
        // `dictionaries` and `tagMeta` are object-only; an array here carries
        // nothing this schema reads, so it is skipped rather than fatal.
        _ => return DexieRow::Skipped,
    };
    DexieRow::Object(object)
}
/// First present string among `keys`, or `None`. Numbers are stringified (some
/// exporters encode a reading or an author as a number).
fn dexie_string(object: &Map<String, Value>, keys: &[&str]) -> Option<String> {
    keys.iter().find_map(|key| object.get(*key).and_then(opt_string))
}

fn dexie_i64(object: &Map<String, Value>, key: &str) -> i64 {
    to_i64(object.get(key))
}

/// Join a JSON array of strings with single spaces — the stored form the term
/// lookup reads `definition_tags` / `rules` / `term_tags` back in (the ZIP path
/// stores the same wire shape). A scalar string passes through unchanged.
fn dexie_join_strings(value: Option<&Value>) -> Option<String> {
    let value = value?;
    if let Some(text) = value.as_str() {
        return if text.is_empty() { None } else { Some(text.into()) };
    }
    let items = value.as_array()?;
    let joined = items
        .iter()
        .filter_map(|item| opt_string(item))
        .collect::<Vec<_>>()
        .join(" ");
    if joined.is_empty() { None } else { Some(joined) }
}

/// A JSON payload stored as text, or `None` for a missing / null field.
fn dexie_json(value: Option<&Value>) -> Option<String> {
    to_json(value)
}

/// State threaded through one Dexie import.
///
/// Inserts run inside an explicit `BEGIN IMMEDIATE` … `COMMIT` batch that
/// reopens every [`DEXIE_TRANSACTION_ROWS`] rows. Plain `execute` per row (no
/// statements held across the commit) keeps the chunked-commit simple:
/// `rusqlite`'s own statement cache makes re-preparing free, and not borrowing a
/// prepared statement across a commit sidesteps the borrow conflict entirely.
///
/// A store row that names no dictionary (array-form rows carry no `dictionary`
/// field) lands under [`DEXIE_UNRESOLVED_DICTIONARY_ID`]; [`DexieImport::finish`]
/// adopts those onto the single dictionary once every dictionary is known.
struct DexieImport<'a> {
    connection: &'a Connection,
    pending: usize,
    /// Titles seen so far -> the dictionary id their rows carry.
    dictionary_ids: HashMap<String, String>,
    /// Whether a transaction is open on `connection` right now. `finish` and
    /// [`DexieImport::rollback`] clear it; the [`Drop`] impl reads it so a
    /// failed import never leaves the caller's connection holding an open
    /// `BEGIN IMMEDIATE` (which would poison every later statement on it).
    in_transaction: bool,
}

impl<'a> DexieImport<'a> {
    fn new(connection: &'a Connection) -> Result<Self, String> {
        connection
            .execute_batch("BEGIN IMMEDIATE")
            .map_err(|e| e.to_string())?;
        Ok(Self {
            connection,
            pending: 0,
            dictionary_ids: HashMap::new(),
            in_transaction: true,
        })
    }

    /// Explicitly abandon the import, rolling back everything not yet committed.
    ///
    /// Called on the streaming error path so a half-written backup is undone
    /// (see the re-import-safety note on [`import_dictionary_from_dexie_json_reader`]);
    /// the [`Drop`] impl covers any other early exit. Idempotent.
    fn rollback(mut self) {
        if self.in_transaction {
            // Best-effort: a rollback of a healthy transaction cannot fail, and
            // if the connection is already poisoned there is nothing to recover.
            let _ = self.connection.execute_batch("ROLLBACK");
            self.in_transaction = false;
        }
    }

    /// Run one insert inside the open batch, committing and reopening once
    /// [`DEXIE_TRANSACTION_ROWS`] rows are pending.
    fn insert(&mut self, sql: &str, args: impl rusqlite::Params) -> Result<(), String> {
        self.connection.execute(sql, args).map_err(|e| e.to_string())?;
        self.pending += 1;
        if self.pending >= DEXIE_TRANSACTION_ROWS {
            self.commit_and_reopen()?;
        }
        Ok(())
    }

    fn commit_and_reopen(&mut self) -> Result<(), String> {
        self.connection
            .execute_batch("COMMIT")
            .map_err(|e| e.to_string())?;
        self.pending = 0;
        self.connection
            .execute_batch("BEGIN IMMEDIATE")
            .map_err(|e| e.to_string())
    }

    fn finish(mut self) -> Result<(), String> {
        // A store row that names no dictionary (array-form rows carry no
        // `dictionary` field) lands under a single title-less placeholder id. Now
        // that the whole document has streamed and every dictionary is known, a
        // backup with exactly ONE dictionary unambiguously owns those rows; with
        // several an unnamed row is genuinely ambiguous, so it stays on the
        // placeholder and simply will not match a lookup (nothing is lost or
        // misattributed). Runs inside the still-open batch.
        if self.dictionary_ids.len() == 1 {
            let authoritative = self.dictionary_ids.values().next().unwrap().clone();
            if authoritative != DEXIE_UNRESOLVED_DICTIONARY_ID {
                for table in ["terms", "kanjis", "term_meta", "tags"] {
                    self.connection
                        .execute(
                            &format!(
                                "UPDATE {table} SET dictionary_id = ?1 WHERE dictionary_id = ?2"
                            ),
                            params![authoritative, DEXIE_UNRESOLVED_DICTIONARY_ID],
                        )
                        .map_err(|e| e.to_string())?;
        }
            }
        }
        // Committing an empty batch is a no-op, so this closes the transaction
        // either way and leaves the connection without an open one.
        let commit_result = self
            .connection
            .execute_batch("COMMIT")
            .map_err(|e| e.to_string());
        self.in_transaction = false;
        return commit_result;
    }
}

/// Roll back an uncommitted import on the way out, so an error never leaves
/// the connection holding an open `BEGIN IMMEDIATE` (which would poison every
/// later statement the caller runs on it).
impl<'a> Drop for DexieImport<'a> {
    fn drop(&mut self) {
        if self.in_transaction {
            let _ = self.connection.execute_batch("ROLLBACK");
            self.in_transaction = false;
        }
    }
}

impl<'a> DexieImport<'a> {

    /// The id rows for `title` should carry, computing it on first reference.
    ///
    /// Array-form rows carry no `dictionary` field, so `title` arrives empty.
    /// Those rows take a title-less placeholder id; once the whole document has
    /// streamed and every dictionary is known, [`finish`](Self::finish) adopts
    /// them onto the single dictionary (a backup with several dictionaries and
    /// unnamed rows is ambiguous, so those simply will not match a lookup).
    fn dictionary_id(&mut self, title: &str) -> Result<String, String> {
        // An empty title means the row named no dictionary (array-form rows carry
        // no `dictionary` field). It takes ONE shared title-less placeholder id,
        // which [`finish`](Self::finish) adopts onto the single dictionary once
        // the whole document has streamed.
        if title.is_empty() {
            return Ok(DEXIE_UNRESOLVED_DICTIONARY_ID.to_string());
        }
        if let Some(id) = self.dictionary_ids.get(title) {
            return Ok(id.clone());
        }
        let id = dictionary_id(0, "", title);
        self.dictionary_ids.insert(title.to_string(), id.clone());
        Ok(id)
    }

    fn insert_dictionary(&mut self, object: &Map<String, Value>) -> Result<(), String> {
        let Some(title) = dexie_string(object, &["title"]) else {
            return Ok(());
        };
        let version = dexie_i64(object, "version");
        let revision = dexie_string(object, &["revision"]).unwrap_or_default();
        // Recompute the authoritative id now that version/revision are known, and
        // adopt any rows already written under the title-only placeholder.
        let id = dictionary_id(version, &revision, &title);
        // Re-importing replaces a dictionary's content (the ZIP path deletes its
        // rows before writing banks), so clear this id's previous rows before the
        // fresh ones land. Runs before the adopt below so rows pulled off the
        // title-less placeholder are this import's, not a prior run's.
        for table in ["terms", "kanjis", "term_meta", "tags"] {
            self.insert(
                &format!("DELETE FROM {table} WHERE dictionary_id = ?1"),
                params![id],
            )?;
        }
        if let Some(previous) = self.dictionary_ids.insert(title.clone(), id.clone()) {
            if previous != id {
                for table in ["terms", "kanjis", "term_meta", "tags"] {
                    self.insert(
                        &format!("UPDATE {table} SET dictionary_id = ?1 WHERE dictionary_id = ?2"),
                        params![id, previous],
                    )?;
                }
            }
        }
        // `created_at` is written only on insert (the conflict path leaves the
        // first-import timestamp alone), matching the ZIP path.
        let created_at = now_ms();
        let sequenced = matches!(object.get("sequenced"), Some(Value::Bool(true)));
        let author = dexie_string(object, &["author"]);
        let url = dexie_string(object, &["url", "indexUrl", "downloadUrl"]);
        let description = dexie_string(object, &["description"]);
        // A Dexie dictionary row encodes its format version as `version` (there
        // is no separate `format` field like the ZIP bank filename carries), so
        // fall back to it when `format` is absent.
        let format = match dexie_i64(object, "format") {
            0 => dexie_i64(object, "version"),
            other => other,
        };
        self.insert(
            "INSERT INTO dictionaries (id, title, format, revision, sequenced, author, url, description, created_at, enabled) \
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, 1) \
             ON CONFLICT(id) DO UPDATE SET \
               title=excluded.title, format=excluded.format, revision=excluded.revision, \
               sequenced=excluded.sequenced, author=excluded.author, url=excluded.url, \
               description=excluded.description, enabled=1",
            params![id, title, format, revision, sequenced as i64, author, url, description, created_at],
        )
    }

    fn insert_term(&mut self, object: &Map<String, Value>) -> Result<(), String> {
        let Some(expression) = dexie_string(object, &["expression"]) else {
            return Ok(());
        };
        let title = dexie_string(object, &["dictionary"]).unwrap_or_default();
        let id = self.dictionary_id(&title)?;
        let reading = dexie_string(object, &["reading"]);
        // `tags` is the documented legacy alias for `definitionTags`.
        let definition_tags =
            dexie_join_strings(object.get("definitionTags").or_else(|| object.get("tags")));
        let rules = dexie_join_strings(object.get("rules"));
        let term_tags = dexie_join_strings(object.get("termTags"));
        let score = dexie_i64(object, "score");
        let sequence = dexie_i64(object, "sequence");
        let glossary_json = dexie_json(object.get("glossary"));
        self.insert(
            "INSERT INTO terms (dictionary_id, expression, reading, definition_tags, rules, score, sequence, term_tags, glossary_json) \
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
            params![
                id,
                expression,
                reading,
                definition_tags,
                rules,
                score,
                sequence,
                term_tags,
                glossary_json.unwrap_or_else(|| "null".into()),
            ],
        )
    }

    fn insert_kanji(&mut self, object: &Map<String, Value>) -> Result<(), String> {
        let Some(character) = dexie_string(object, &["character"]) else {
            return Ok(());
        };
        let title = dexie_string(object, &["dictionary"]).unwrap_or_default();
        let id = self.dictionary_id(&title)?;
        let onyomi = dexie_join_strings(object.get("onyomi"));
        let kunyomi = dexie_join_strings(object.get("kunyomi"));
        let tags = dexie_join_strings(object.get("tags"));
        let meanings_json = dexie_json(object.get("meanings"));
        let stats_json = dexie_json(object.get("stats"));
        self.insert(
            "INSERT INTO kanjis (character, dictionary_id, onyomi, kunyomi, tags, meanings_json, stats_json) \
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7) \
             ON CONFLICT(character) DO UPDATE SET \
               dictionary_id=excluded.dictionary_id, onyomi=excluded.onyomi, kunyomi=excluded.kunyomi, \
               tags=excluded.tags, meanings_json=excluded.meanings_json, stats_json=excluded.stats_json",
            params![character, id, onyomi, kunyomi, tags, meanings_json, stats_json],
        )
    }

    fn insert_term_meta(&mut self, object: &Map<String, Value>) -> Result<(), String> {
        let Some(expression) = dexie_string(object, &["expression"]) else {
            return Ok(());
        };
        let title = dexie_string(object, &["dictionary"]).unwrap_or_default();
        let id = self.dictionary_id(&title)?;
        let mode = dexie_string(object, &["mode"]).unwrap_or_else(|| "freq".into());
        let data_json = dexie_json(object.get("data"));
        self.insert(
            "INSERT INTO term_meta (expression, mode, data_json, dictionary_id) VALUES (?1, ?2, ?3, ?4)",
            params![expression, mode, data_json.unwrap_or_else(|| "null".into()), id],
        )
    }

    fn insert_tag(&mut self, object: &Map<String, Value>) -> Result<(), String> {
        let Some(name) = dexie_string(object, &["name"]) else {
            return Ok(());
        };
        let title = dexie_string(object, &["dictionary"]).unwrap_or_default();
        let id = self.dictionary_id(&title)?;
        let category = dexie_string(object, &["category"]).unwrap_or_else(|| "default".into());
        // The store spells it `order`; the column is `sorting` (ZIP path same).
        let sorting = dexie_i64(object, "order");
        let notes = dexie_string(object, &["notes"]).unwrap_or_default();
        let score = dexie_i64(object, "score");
        self.insert(
            "INSERT INTO tags (name, category, sorting, notes, score, dictionary_id) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![name, category, sorting, notes, score, id],
        )
    }

    /// Route one row of `table` to its store handler. Unknown stores (media,
    /// kanjiMeta) are ignored: a backup legitimately carries stores this schema
    /// does not model.
    fn insert_row(&mut self, table: &str, row: Value) -> Result<(), String> {
        // A row is usually the plain object, but some stores also arrive in
        // array form (the same layout the ZIP bank importer reads). Expand an
        // array to its named fields first so both shapes share one handler.
        let object = match dexie_expand_array_row(table, row) {
            DexieRow::Object(object) => object,
            DexieRow::Skipped => return Ok(()),
        };
        match table {
            "dictionaries" => self.insert_dictionary(&object),
            "terms" => self.insert_term(&object),
            "kanji" => self.insert_kanji(&object),
            "termMeta" => self.insert_term_meta(&object),
            "tagMeta" => self.insert_tag(&object),
            _ => Ok(()),
        }
    }
}

/// Import a Yomitan Dexie JSON backup read from `reader`, reporting progress
/// through `on_progress` (the same [`ImportProgress`] the ZIP importer emits, so
/// the web layer's existing listener drives the bar).
///
/// The whole file is streamed; returns every dictionary the backup carried.
pub fn import_dictionary_from_dexie_json_reader<R: BufRead>(
    conn: &Connection,
    reader: R,
    on_progress: &mut dyn FnMut(ImportProgress),
) -> Result<Vec<DexieImportedDictionary>, String> {
    let mut import = DexieImport::new(conn)?;
    let mut context = DexieStreamContext::default();
    if let Err(error) = stream_dexie_document(reader, &mut import, &mut context, on_progress) {
        // Roll back everything this import wrote (the last batch plus any
        // re-import deletes), so a failed import leaves the previous state
        // byte-for-byte intact instead of a half-written dictionary. The Drop
        // impl is the safety net; this explicit call is the documented path.
        import.rollback();
        return Err(error);
    }
    import.finish()?;
    // The final 100% carries a label like every streamed row, so the web bar's
    // label never flashes empty on completion.
    on_progress(ImportProgress {
        percent: 100,
        current: 1,
        total: 1,
        current_file: Some("dictionaries".to_string()),
    });
    list_dictionaries(conn)
}

/// Import a Yomitan Dexie JSON backup from a path on disk (the Tauri command
/// path): streamed off the file, never buffered whole.
pub fn import_dictionary_from_dexie_json(
    conn: &Connection,
    path: impl AsRef<Path>,
    on_progress: &mut dyn FnMut(ImportProgress),
) -> Result<Vec<DexieImportedDictionary>, String> {
    let path = path.as_ref();
    let file = File::open(path).map_err(|e| format!("failed to open {}: {e}", path.display()))?;
    import_dictionary_from_dexie_json_reader(conn, BufReader::new(file), on_progress)
}

// ---------------------------------------------------------------------------
// Export (SQLite -> Dexie JSON backup)
// ---------------------------------------------------------------------------

/// Split one space-separated tag string into a JSON array, or `null` when it
/// is empty/NULL. The importer joins `definitionTags`/`rules`/`termTags`/
/// `onyomi`/`kunyomi`/`tags` with single spaces, so this is the inverse.
fn tags_to_value(value: Option<String>) -> Value {
    match value {
        Some(text) if !text.trim().is_empty() => Value::Array(
            text.split_whitespace()
                .map(|tag| Value::String(tag.to_string()))
                .collect(),
        ),
        _ => Value::Null,
    }
}

/// Parse one JSON-text column (`glossary_json`, `meanings_json`, `stats_json`,
/// `data_json`) back into a JSON value, or `null` when NULL/unparseable. The
/// importer stored it with [`dexie_json`], so this round-trips the value.
fn json_text_to_value(value: Option<String>) -> Value {
    match value {
        Some(text) => serde_json::from_str(&text).unwrap_or(Value::Null),
        None => Value::Null,
    }
}

/// One store's SQL and its `dictionary_id` column position (every store keys
/// its rows to a dictionary, whose TITLE the exported rows carry).
const DEXIE_STORES: &[(&str, &str, usize)] = &[
    (
        "terms",
        "SELECT expression, dictionary_id, reading, definition_tags, rules, score, sequence, term_tags, glossary_json FROM terms",
        1,
    ),
    (
        "kanji",
        "SELECT character, dictionary_id, onyomi, kunyomi, tags, meanings_json, stats_json FROM kanjis",
        1,
    ),
    (
        "termMeta",
        "SELECT expression, dictionary_id, mode, data_json FROM term_meta",
        1,
    ),
    (
        "tagMeta",
        "SELECT name, dictionary_id, category, sorting, notes, score FROM tags",
        1,
    ),
];

/// Build one exported row for `store` from the current `row`, mapping the
/// flat SQLite columns back to the field names the importer's `insert_row`
/// reads. `dictionary_id_col` locates the row's dictionary foreign key.
fn dexie_row_to_value(
    store: &str,
    row: &rusqlite::Row<'_>,
    dictionary_id_col: usize,
    titles: &HashMap<String, String>,
) -> Result<Value, String> {
    let dictionary_id: String = row
        .get(dictionary_id_col)
        .map_err(|e| format!("read {store} dictionary_id: {e}"))?;
    let dictionary = titles
        .get(&dictionary_id)
        .cloned()
        .unwrap_or_default();
    let column = |index: usize| -> Result<String, String> {
        row.get::<_, Option<String>>(index)
            .map(|value| value.unwrap_or_default())
            .map_err(|e| format!("read {store} column {index}: {e}"))
    };
    let json_column = |index: usize| -> Result<Value, String> {
        row.get::<_, Option<String>>(index)
            .map(json_text_to_value)
            .map_err(|e| format!("read {store} json column {index}: {e}"))
    };
    let int_column = |index: usize| -> Result<i64, String> {
        row.get(index)
            .map_err(|e| format!("read {store} int column {index}: {e}"))
    };
    Ok(match store {
        "terms" => json!({
            "expression": column(0)?,
            "dictionary": dictionary,
            "reading": row.get::<_, Option<String>>(2).map_err(|e| e.to_string())?,
            "definitionTags": tags_to_value(row.get(3).map_err(|e| e.to_string())?),
            "rules": tags_to_value(row.get(4).map_err(|e| e.to_string())?),
            "score": int_column(5)?,
            "sequence": int_column(6)?,
            "termTags": tags_to_value(row.get(7).map_err(|e| e.to_string())?),
            "glossary": json_column(8)?,
        }),
        "kanji" => json!({
            "character": column(0)?,
            "dictionary": dictionary,
            "onyomi": tags_to_value(row.get(2).map_err(|e| e.to_string())?),
            "kunyomi": tags_to_value(row.get(3).map_err(|e| e.to_string())?),
            "tags": tags_to_value(row.get(4).map_err(|e| e.to_string())?),
            "meanings": json_column(5)?,
            "stats": json_column(6)?,
        }),
        "termMeta" => json!({
            "expression": column(0)?,
            "dictionary": dictionary,
            "mode": row.get::<_, Option<String>>(2).map_err(|e| e.to_string())?,
            "data": json_column(3)?,
        }),
        "tagMeta" => json!({
            "name": column(0)?,
            "dictionary": dictionary,
            "category": row.get::<_, Option<String>>(2).map_err(|e| e.to_string())?,
            "order": int_column(3)?,
            "notes": row.get::<_, Option<String>>(4).map_err(|e| e.to_string())?,
            "score": int_column(5)?,
        }),
        _ => return Err(format!("unknown dexie store {store}")),
    })
}

/// Stream one store's `{tableName, inbound, rowCount, rows:[...]}` entry into
/// `writer`. `first` governs the comma BEFORE the entry (the caller tracks how
/// many entries the `data.data` array already holds). `inbound` records whether
/// the store's rows carry their key INSIDE the object (`terms`, which has a
/// keyPath) or OUTSIDE as a `[key, {...}]` tuple (the autoIncrement stores).
/// Rows stream one at a time, so a multi-gigabyte `terms` store never lands in
/// memory whole.
fn write_dexie_store(
    writer: &mut impl io::Write,
    conn: &Connection,
    store: &str,
    sql: &str,
    dictionary_id_col: usize,
    first: bool,
    titles: &HashMap<String, String>,
) -> Result<(), String> {
    let row_count: i64 = conn
        .query_row(&format!("SELECT COUNT(*) FROM ({sql})"), [], |row| row.get(0))
        .map_err(|e| format!("count {store} for export: {e}"))?;
    if !first {
        writer.write_all(b",").map_err(|e| e.to_string())?;
    }
    let inbound = store == "terms";
    writer
        .write_all(format!(
            "{{\"tableName\":\"{store}\",\"inbound\":{inbound},\"rowCount\":{row_count},\"rows\":["
        )
        .as_bytes())
        .map_err(|e| e.to_string())?;
    let mut statement = conn
        .prepare(sql)
        .map_err(|e| format!("prepare {store} export: {e}"))?;
    let mut rows = statement
        .query([])
        .map_err(|e| format!("query {store} export: {e}"))?;
    let mut index: u64 = 0;
    while let Some(row) = rows
        .next()
        .map_err(|e| format!("read {store} row: {e}"))?
    {
        if index > 0 {
            writer.write_all(b",").map_err(|e| e.to_string())?;
        }
        let object = dexie_row_to_value(store, row, dictionary_id_col, titles)?;
        serde_json::to_writer(&mut *writer, &object).map_err(|e| e.to_string())?;
        index += 1;
    }
    writer.write_all(b"]").map_err(|e| e.to_string())?;
    writer.write_all(b"}").map_err(|e| e.to_string())?;
    Ok(())
}

/// Export every installed dictionary to a Yomitan Dexie JSON backup at `path`,
/// streamed straight to disk (never buffered whole). Returns the number of
/// dictionaries written. The output is the exact inverse of
/// [`import_dictionary_from_dexie_json_reader`]: `data.data` is an array of
/// `{tableName, rowCount, rows}` entries — one per store — so a backup
/// re-imports into any Yomitan, this engine or the reference implementation.
pub fn export_dictionaries_to_dexie_json(
    conn: &Connection,
    path: impl AsRef<Path>,
) -> Result<u64, String> {
    let path = path.as_ref();
    if let Some(parent) = path.parent() {
        if !parent.as_os_str().is_empty() {
            std::fs::create_dir_all(parent)
                .map_err(|e| format!("failed to create {}: {e}", parent.display()))?;
        }
    }
    // Write to a sibling `.json.part` temp and rename into place only on
    // success. A multi-gigabyte export that dies halfway (disk full, app
    // killed) must never leave a truncated backup that a later import would
    // choke on — the target either holds the previous good file or the new
    // complete one, never a half-written body.
    let tmp_path: PathBuf = path.with_extension("json.part");
    let file = File::create(&tmp_path)
        .map_err(|e| format!("failed to create {}: {e}", tmp_path.display()))?;
    let mut writer = BufWriter::new(file);

    // id -> title, so every row's `dictionary` names its dictionary by title
    // (what an import resolves back through).
    let mut titles: HashMap<String, String> = HashMap::new();
    {
        let mut statement = conn
            .prepare("SELECT id, title FROM dictionaries")
            .map_err(|e| format!("read dictionaries for export: {e}"))?;
        let mut rows = statement.query([]).map_err(|e| e.to_string())?;
        while let Some(row) = rows.next().map_err(|e| e.to_string())? {
            let id: String = row.get(0).map_err(|e| e.to_string())?;
            let title: String = row.get(1).map_err(|e| e.to_string())?;
            titles.insert(id, title);
        }
    }

    // Header by hand so the `data` object stays OPEN: the `data.data` array
    // streams into it below, before the two closing braces. Serializing a
    // whole `json!` value would close the top-level object and strand
    // `data.data` outside it (invalid JSON).
    writer
        .write_all(b"{\"formatName\":\"dexie\",\"formatVersion\":1,\"data\":{\"databaseName\":\"dict\",\"databaseVersion\":6,\"tables\":")
        .map_err(|e| e.to_string())?;
    // `schema` is each store's Dexie index definition string, so the backup
    // re-imports into a reference Yomitan with the same indexes this engine
    // queries. `rowCount` is informational; the import streams `data.data` and
    // ignores both.
    let tables_meta = json!([
        {
            "name": "dictionaries",
            "schema": "++id, &title",
            "rowCount": conn.query_row("SELECT COUNT(*) FROM dictionaries", [], |row| row.get::<_, i64>(0)).map_err(|e| e.to_string())?.max(0),
        },
        {
            "name": "terms",
            "schema": "++id, [dictionary+expression], [dictionary+reading], [dictionary+expression+reading]",
            "rowCount": conn.query_row("SELECT COUNT(*) FROM terms", [], |row| row.get::<_, i64>(0)).map_err(|e| e.to_string())?.max(0),
        },
        {
            "name": "kanji",
            "schema": "++id, [dictionary+character]",
            "rowCount": conn.query_row("SELECT COUNT(*) FROM kanjis", [], |row| row.get::<_, i64>(0)).map_err(|e| e.to_string())?.max(0),
        },
        {
            "name": "termMeta",
            "schema": "++id, [dictionary+expression]",
            "rowCount": conn.query_row("SELECT COUNT(*) FROM term_meta", [], |row| row.get::<_, i64>(0)).map_err(|e| e.to_string())?.max(0),
        },
        {
            "name": "tagMeta",
            "schema": "++id, [dictionary+name]",
            "rowCount": conn.query_row("SELECT COUNT(*) FROM tags", [], |row| row.get::<_, i64>(0)).map_err(|e| e.to_string())?.max(0),
        },
    ]);
    serde_json::to_writer(&mut writer, &tables_meta)
        .map_err(|e| format!("failed to write dexie header: {e}"))?;
    // `data.data` array, still inside the open `data` object.
    writer.write_all(b",\"data\":[").map_err(|e| e.to_string())?;

    // `dictionaries` is the first entry: each row is the primary-key tuple
    // `[id, {...}]` the importer unwraps (not a plain object). `inbound` is
    // false — the autoIncrement key travels OUTSIDE the object as the tuple.
    let dictionaries_count: i64 = conn
        .query_row("SELECT COUNT(*) FROM dictionaries", [], |row| row.get(0))
        .map_err(|e| format!("count dictionaries for export: {e}"))?;
    writer
        .write_all(
            format!("{{\"tableName\":\"dictionaries\",\"inbound\":false,\"rowCount\":{dictionaries_count},\"rows\":[")
                .as_bytes(),
        )
        .map_err(|e| e.to_string())?;
    {
        let mut statement = conn
            .prepare("SELECT id, title, format, revision, sequenced, author, url, description FROM dictionaries")
            .map_err(|e| format!("prepare dictionary export: {e}"))?;
        let mut rows = statement.query([]).map_err(|e| e.to_string())?;
        let mut index: u64 = 0;
        while let Some(row) = rows.next().map_err(|e| e.to_string())? {
            if index > 0 {
                writer.write_all(b",").map_err(|e| e.to_string())?;
            }
            let id: String = row.get(0).map_err(|e| e.to_string())?;
            let format: i64 = row.get(2).map_err(|e| e.to_string())?;
            let sequenced: i64 = row.get(4).map_err(|e| e.to_string())?;
            let tuple = json!([
                id,
                json!({
                    "title": row.get::<_, String>(1).map_err(|e| e.to_string())?,
                    "version": format,
                    "revision": row.get::<_, Option<String>>(3).map_err(|e| e.to_string())?,
                    "sequenced": sequenced != 0,
                    "author": row.get::<_, Option<String>>(5).map_err(|e| e.to_string())?,
                    "url": row.get::<_, Option<String>>(6).map_err(|e| e.to_string())?,
                    "description": row.get::<_, Option<String>>(7).map_err(|e| e.to_string())?,
                    "format": format,
                }),
            ]);
            serde_json::to_writer(&mut writer, &tuple).map_err(|e| e.to_string())?;
            index += 1;
        }
    }
    writer.write_all(b"]}").map_err(|e| e.to_string())?;

    // The four content stores, each its own `{tableName, inbound, rowCount,
    // rows}` entry. The `dictionaries` entry above is ALWAYS emitted (it is a
    // real `{tableName, ...}` object even at 0 dictionaries), so every store
    // here needs a leading comma — emitting the first without one would splice
    // two objects together (`…]}{…`) and corrupt the JSON when dictionaries is
    // empty.
    for (store, sql, dictionary_id_col) in DEXIE_STORES {
        write_dexie_store(&mut writer, conn, store, sql, *dictionary_id_col, false, &titles)?;
    }

    // Close the `data.data` array, the `data` object, and the top-level object.
    writer.write_all(b"]}}").map_err(|e| e.to_string())?;
    writer.flush().map_err(|e| e.to_string())?;
    // Drop the handle BEFORE the rename: on Windows an open handle keeps the
    // temp file locked and the rename would fail with a sharing violation.
    drop(writer);
    if let Err(error) = std::fs::rename(&tmp_path, path) {
        let _ = std::fs::remove_file(&tmp_path);
        return Err(format!(
            "failed to finalize {}: {error}",
            path.display()
        ));
    }
    Ok(dictionaries_count.max(0) as u64)
}
/// Position bookkeeping for one streamed backup: how many rows of the
/// current store have landed (for the progress label) and, in the rare case
/// a table's `tableName` key trails its `rows`, the one row held until the
/// name is known.
#[derive(Default)]
struct DexieStreamContext {
    rows: u64,
    buffered: Option<Value>,
}

impl DexieStreamContext {
    fn take_buffered(&mut self) -> Option<Value> {
        self.buffered.take()
    }
}
/// Parse the top-level object of a Dexie export. Every key is handled through
/// ONE serde deserializer — `formatName`/`formatVersion` are validated, the big
/// `data` object is streamed via [`stream_dexie_data`], and sibling keys (the
/// multi-megabyte `tables` metadata block) are skipped by value, never buffered
/// whole. Routing every read through serde (rather than mixing manual
/// peek/consume with `Deserializer::from_reader`) is deliberate: serde's own
/// read-ahead buffer otherwise desyncs a hand-rolled position walker and makes
/// it reject valid input as "malformed".
fn stream_dexie_document<R: BufRead>(
    reader: R,
    import: &mut DexieImport<'_>,
    context: &mut DexieStreamContext,
    on_progress: &mut dyn FnMut(ImportProgress),
) -> Result<(), String> {
    let mut de = serde_json::Deserializer::from_reader(reader);
    de.deserialize_map(DexieDocument {
        import,
        context,
        on_progress,
    })
    .map_err(|e| format!("invalid dexie export: {e}"))
}

/// [`serde::de::DeserializeSeed`] walking the top-level Dexie object's keys.
struct DexieDocument<'a, 'b> {
    import: &'a mut DexieImport<'b>,
    context: &'a mut DexieStreamContext,
    on_progress: &'a mut dyn FnMut(ImportProgress),
}

impl<'de> serde::de::DeserializeSeed<'de> for DexieDocument<'_, '_> {
    type Value = ();
    fn deserialize<D: serde::Deserializer<'de>>(
        self,
        deserializer: D,
    ) -> Result<Self::Value, D::Error> {
        deserializer.deserialize_map(self)
    }
}

impl<'de> serde::de::Visitor<'de> for DexieDocument<'_, '_> {
    type Value = ();
    fn expecting(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("a dexie export object")
    }
    fn visit_map<A: serde::de::MapAccess<'de>>(
        mut self,
        mut map: A,
    ) -> Result<Self::Value, A::Error> {
        let mut seen_data = false;
        while let Some(key) = map.next_key::<String>()? {
            match key.as_str() {
                "formatName" => {
                    let name = map.next_value::<String>()?;
                    if name != "dexie" {
                        return Err(serde::de::Error::custom(format!(
                            "not a dexie export (formatName {name:?})"
                        )));
                    }
                }
                "formatVersion" => {
                    let version = map.next_value::<i64>()?;
                    if version != 1 {
                        return Err(serde::de::Error::custom(format!(
                            "unsupported dexie formatVersion {version}"
                        )));
                    }
                }
                "data" => {
                    seen_data = true;
                    map.next_value_seed(DexieData {
                        import: &mut self.import,
                        context: &mut self.context,
                        on_progress: &mut self.on_progress,
                    })?;
                }
                _ => {
                    // `databaseName`, the `tables` metadata block, etc.
                    map.next_value::<IgnoredAny>()?;
                }
            }
        }
        if !seen_data {
            return Err(serde::de::Error::custom("dexie export has no data section"));
        }
        Ok(())
    }
}

/// The top-level `data` OBJECT — `{ databaseName, data:[ …tables… ] }`. The
/// small sibling keys are skipped via [`IgnoredAny`]; the big inner `data`
/// array is streamed one table entry at a time.
struct DexieData<'a, 'b> {
    import: &'a mut DexieImport<'b>,
    context: &'a mut DexieStreamContext,
    on_progress: &'a mut dyn FnMut(ImportProgress),
}

impl<'de> serde::de::DeserializeSeed<'de> for DexieData<'_, '_> {
    type Value = ();
    fn deserialize<D: serde::Deserializer<'de>>(
        self,
        deserializer: D,
    ) -> Result<Self::Value, D::Error> {
        deserializer.deserialize_map(self)
    }
}

impl<'de> serde::de::Visitor<'de> for DexieData<'_, '_> {
    type Value = ();
    fn expecting(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("a dexie data object")
    }
    fn visit_map<A: serde::de::MapAccess<'de>>(
        mut self,
        mut map: A,
    ) -> Result<Self::Value, A::Error> {
        let mut seen_array = false;
        while let Some(key) = map.next_key::<String>()? {
            if key == "data" {
                seen_array = true;
                map.next_value_seed(DexieTableSeq {
                    import: &mut self.import,
                    context: &mut self.context,
                    on_progress: &mut self.on_progress,
                })?;
            } else {
                map.next_value::<IgnoredAny>()?;
            }
        }
        if !seen_array {
            return Err(serde::de::Error::custom("dexie export has no data array"));
        }
        Ok(())
    }
}

/// The inner `data` ARRAY — one `{tableName, rows:[…]}` entry per table, visited
/// one at a time via [`serde::de::SeqAccess`].
struct DexieTableSeq<'a, 'b> {
    import: &'a mut DexieImport<'b>,
    context: &'a mut DexieStreamContext,
    on_progress: &'a mut dyn FnMut(ImportProgress),
}

impl<'de> serde::de::DeserializeSeed<'de> for DexieTableSeq<'_, '_> {
    type Value = ();
    fn deserialize<D: serde::Deserializer<'de>>(
        self,
        deserializer: D,
    ) -> Result<Self::Value, D::Error> {
        deserializer.deserialize_seq(self)
    }
}

impl<'de> serde::de::Visitor<'de> for DexieTableSeq<'_, '_> {
    type Value = ();
    fn expecting(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("a dexie data.data array")
    }
    fn visit_seq<A: serde::de::SeqAccess<'de>>(
        mut self,
        mut seq: A,
    ) -> Result<Self::Value, A::Error> {
        // Each table entry is streamed via its OWN seed, so only `tableName`
        // and the fields before `rows` are materialized — never the rows array
        // (a `terms` store alone can be gigabytes).
        while seq
            .next_element_seed(DexieTableEntry {
                import: &mut self.import,
                context: &mut self.context,
                on_progress: &mut self.on_progress,
            })?
            .is_some()
        {}
        Ok(())
    }
}

/// ONE `{tableName, rows:[…]}` entry, streamed key by key. `rows` is walked one
/// element at a time through its own [`SeqAccess`] and each row is inserted
/// immediately, so peak memory stays at ONE row rather than the whole table —
/// the difference between a few kilobytes and an OOM on a multi-gigabyte
/// backup.
struct DexieTableEntry<'a, 'b> {
    import: &'a mut DexieImport<'b>,
    context: &'a mut DexieStreamContext,
    on_progress: &'a mut dyn FnMut(ImportProgress),
}

impl<'de> serde::de::DeserializeSeed<'de> for DexieTableEntry<'_, '_> {
    type Value = ();
    fn deserialize<D: serde::Deserializer<'de>>(
        self,
        deserializer: D,
    ) -> Result<Self::Value, D::Error> {
        deserializer.deserialize_map(self)
    }
}

impl<'de> serde::de::Visitor<'de> for DexieTableEntry<'_, '_> {
    type Value = ();
    fn expecting(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("a dexie table entry")
    }
    fn visit_map<A: serde::de::MapAccess<'de>>(
        mut self,
        mut map: A,
    ) -> Result<Self::Value, A::Error> {
        let mut table: Option<String> = None;
        while let Some(key) = map.next_key::<String>()? {
            if key == "rows" {
                map.next_value_seed(DexieRowSeq {
                    import: &mut self.import,
                    context: &mut self.context,
                    on_progress: &mut self.on_progress,
                    // Resolved when `tableName` precedes `rows` (the export's
                    // own layout). If it somehow trails, the first row is
                    // buffered on the context until the name is known.
                    table: &mut table,
                })?;
            } else if key == "tableName" || key == "name" {
                let name = map.next_value::<String>()?;
                if let Some(buffered) = self.context.take_buffered() {
                    self.import
                        .insert_row(&name, buffered)
                        .map_err(serde::de::Error::custom)?;
                }
                table = Some(name);
            } else {
                map.next_value::<IgnoredAny>()?;
            }
        }
        if table.is_none() {
            // An entry with no name carries rows this schema cannot route.
            return Err(serde::de::Error::custom(
                "dexie table entry is missing tableName",
            ));
        }
        Ok(())
    }
}

/// The `rows` ARRAY of one table, visited one ROW at a time.
struct DexieRowSeq<'a, 'b> {
    import: &'a mut DexieImport<'b>,
    context: &'a mut DexieStreamContext,
    on_progress: &'a mut dyn FnMut(ImportProgress),
    /// Store name the rows belong to; resolved from the sibling `tableName`.
    table: &'a mut Option<String>,
}

impl<'de> serde::de::DeserializeSeed<'de> for DexieRowSeq<'_, '_> {
    type Value = ();
    fn deserialize<D: serde::Deserializer<'de>>(
        self,
        deserializer: D,
    ) -> Result<Self::Value, D::Error> {
        deserializer.deserialize_seq(self)
    }
}

impl<'de> serde::de::Visitor<'de> for DexieRowSeq<'_, '_> {
    type Value = ();
    fn expecting(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("a dexie table rows array")
    }
    fn visit_seq<A: serde::de::SeqAccess<'de>>(
        self,
        mut seq: A,
    ) -> Result<Self::Value, A::Error> {
        let mut reported_percent = 0u32;
        while let Some(row) = seq.next_element::<Value>()? {
            let Some(table) = self.table.as_deref() else {
                // `tableName` trails `rows`: hold the one row on the context
                // until the name arrives, then let the table-entry visitor
                // insert it under the resolved name. Only ever one row deep,
                // so memory stays bounded.
                self.context.buffered = Some(row);
                return Ok(());
            };
            self.import
                .insert_row(table, row)
                .map_err(serde::de::Error::custom)?;
            self.context.rows += 1;
            // Emit only when the whole-percent moves: a 3M-row table would
            // otherwise fire millions of near-identical events and freeze the
            // UI. `dexie_percent` is monotonic, so this is at most 100 emits
            // per table.
            let percent = dexie_percent(self.context.rows, reported_percent);
            if percent != reported_percent {
                reported_percent = percent;
                (self.on_progress)(ImportProgress {
                    percent,
                    current: self.context.rows as u32,
                    total: 1,
                    current_file: Some(table.to_string()),
                });
            }
        }
        Ok(())
    }
}

/// The whole-percent a streamed row count maps to, monotonic by construction.
///
/// The export's own `tables[].rowCount` metadata would give an exact total, but
/// reading it costs a first pass over a multi-gigabyte file. Instead the percent
/// follows the running row count on a curve that reaches only 99 while streaming
/// (the caller emits an explicit 100% once the document closes), so the bar
/// moves early and never jumps backwards.
fn dexie_percent(rows: u64, reported: u32) -> u32 {
    // 100 * rows / (rows + 1000): fast early movement, asymptotic to 100.
    let percent = ((rows.saturating_mul(100)) / (rows.saturating_add(1000))) as u32;
    percent.clamp(reported, 99)
}

// ---------------------------------------------------------------------------
// Bank entry parsing
// ---------------------------------------------------------------------------

fn string_field(object: &serde_json::Map<String, Value>, key: &str) -> Option<String> {
    object.get(key).and_then(opt_string)
}

/// Trimmed string, or `None` for null/missing/empty. Numbers are stringified:
/// some dictionaries encode a reading or a tag as a number.
fn opt_string(value: &Value) -> Option<String> {
    match value {
        Value::String(text) if !text.is_empty() => Some(text.clone()),
        Value::String(_) => None,
        Value::Number(number) => Some(number.to_string()),
        _ => None,
    }
}

fn to_i64(value: Option<&Value>) -> i64 {
    match value {
        Some(Value::Number(number)) => number
            .as_i64()
            .or_else(|| number.as_f64().map(|float| float as i64))
            .unwrap_or(0),
        Some(Value::String(text)) => text.trim().parse::<i64>().unwrap_or(0),
        _ => 0,
    }
}

fn to_json(value: Option<&Value>) -> Option<String> {
    match value {
        Some(Value::Null) | None => None,
        // A bare string stays a JSON string so the reader gets one uniform type.
        Some(other) => serde_json::to_string(other).ok(),
    }
}

struct TermRow {
    expression: String,
    reading: Option<String>,
    definition_tags: Option<String>,
    rules: Option<String>,
    score: i64,
    sequence: i64,
    term_tags: Option<String>,
    glossary_json: String,
}

/// Parse one `term_bank` entry.
///
/// Two layouts exist and both are accepted:
/// - array (v3 and the common JMdict layout):
///   `[expression, reading, definitionTags, rules, score, glossary, sequence, termTags]`
/// - object (v3 object form): the same fields by name.
///
/// Note: the array layout has an ambiguous slot 5/6 in the wild (some tools
/// emit `[..., score, sequence, glossary, termTags]`), so a numeric slot 5 with
/// a non-numeric slot 6 is read as sequence-then-glossary. Returns `None` for an
/// entry with no expression, which is skipped rather than failing the import.
fn parse_term(value: &Value) -> Option<TermRow> {
    if let Some(object) = value.as_object() {
        let expression = string_field(object, "expression")?;
        let glossary = object.get("glossary").cloned().unwrap_or(Value::Null);
        return Some(TermRow {
            expression,
            reading: string_field(object, "reading"),
            definition_tags: string_field(object, "definitionTags"),
            rules: string_field(object, "rules"),
            score: to_i64(object.get("score")),
            sequence: to_i64(object.get("sequence")),
            term_tags: string_field(object, "termTags"),
            glossary_json: serde_json::to_string(&glossary).unwrap_or_else(|_| "null".into()),
        });
    }

    let items = value.as_array()?;
    if items.len() < 6 {
        return None;
    }
    let expression = items[0].as_str()?.to_string();
    let mut glossary_index = 5;
    let mut sequence_index = 6;
    if items.len() > 6 && items[5].is_number() && !items[6].is_number() {
        glossary_index = 6;
        sequence_index = 5;
    }
    Some(TermRow {
        expression,
        reading: opt_string(&items[1]),
        definition_tags: opt_string(&items[2]),
        rules: opt_string(&items[3]),
        score: to_i64(Some(&items[4])),
        sequence: to_i64(items.get(sequence_index)),
        term_tags: items.get(7).and_then(opt_string),
        glossary_json: to_json(items.get(glossary_index)).unwrap_or_else(|| "null".into()),
    })
}

struct KanjiRow {
    character: String,
    onyomi: Option<String>,
    kunyomi: Option<String>,
    tags: Option<String>,
    meanings_json: Option<String>,
    stats_json: Option<String>,
}

/// Parse one `kanji_bank` entry. Array form is
/// `[character, onyomi, kunyomi, tags, meanings[], stats]`; the object form
/// carries the same fields by name.
fn parse_kanji(value: &Value) -> Option<KanjiRow> {
    if let Some(object) = value.as_object() {
        let character = string_field(object, "character")?;
        return Some(KanjiRow {
            character,
            onyomi: string_field(object, "onyomi"),
            kunyomi: string_field(object, "kunyomi"),
            tags: string_field(object, "tags"),
            meanings_json: to_json(object.get("meanings")),
            stats_json: to_json(object.get("stats")),
        });
    }

    let items = value.as_array()?;
    if items.len() < 5 {
        return None;
    }
    Some(KanjiRow {
        character: items[0].as_str()?.to_string(),
        onyomi: opt_string(&items[1]),
        kunyomi: opt_string(&items[2]),
        tags: opt_string(&items[3]),
        meanings_json: to_json(Some(&items[4])),
        stats_json: to_json(items.get(5)),
    })
}

struct TermMetaRow {
    expression: String,
    mode: String,
    data_json: String,
}

/// Parse one `term_meta_bank` entry: `[expression, mode, data]`, where `data` is
/// a number (frequency), a string (pitch accent) or an object (IPA).
fn parse_term_meta(value: &Value) -> Option<TermMetaRow> {
    let items = value.as_array()?;
    if items.len() < 3 {
        return None;
    }
    Some(TermMetaRow {
        expression: items[0].as_str()?.to_string(),
        mode: opt_string(&items[1]).unwrap_or_default(),
        data_json: serde_json::to_string(&items[2]).unwrap_or_else(|_| "null".into()),
    })
}

struct TagRow {
    name: String,
    category: String,
    sorting: i64,
    notes: String,
    score: i64,
}

/// Parse one `tag_bank` entry. `order` is the dictionary's name for `sorting`.
fn parse_tag(value: &Value) -> Option<TagRow> {
    let object = value.as_object()?;
    let name = string_field(object, "name")?;
    Some(TagRow {
        name,
        category: string_field(object, "category").unwrap_or_else(|| "default".to_string()),
        sorting: to_i64(object.get("order")),
        notes: string_field(object, "notes").unwrap_or_default(),
        score: to_i64(object.get("score")),
    })
}
