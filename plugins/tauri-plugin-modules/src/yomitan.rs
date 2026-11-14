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
use std::fs::File;
use std::io::{self, BufRead, BufReader, Read, Seek};
use std::path::Path;
use std::rc::Rc;
use std::time::{SystemTime, UNIX_EPOCH};

use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use serde_json::Value;
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
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportProgress {
    /// Whole-percent share of the banks written so far (0–100).
    pub percent: u32,
    /// Banks written so far.
    pub current: u32,
    /// Banks the archive holds (never 0: an archive with no bank is rejected).
    pub total: u32,
}

impl ImportProgress {
    fn new(current: u32, total: u32) -> Self {
        Self {
            percent: percent_of(current, total),
            current,
            total,
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
