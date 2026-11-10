//! Embedded SQLite store: schema, connection factory and all CRUD operations.
//!
//! Every function takes `&Connection` so the whole layer is testable against an
//! in-memory database with no Tauri runtime involved. The Tauri commands in
//! [`crate`] only serialize/deserialize and hop onto the blocking thread pool.

use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};

use rusqlite::{params, Connection, OptionalExtension};
use serde_json;

use crate::models::*;

/// Full schema (§11.3). `IF NOT EXISTS` keeps every open idempotent.
const SCHEMA_SQL: &str = r#"
CREATE TABLE IF NOT EXISTS timeline_posts (
    id TEXT PRIMARY KEY,
    author_handle TEXT NOT NULL,
    author_name TEXT NOT NULL,
    author_avatar TEXT NOT NULL,
    content TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    likes INTEGER NOT NULL DEFAULT 0,
    liked_by_me INTEGER NOT NULL DEFAULT 0,
    reply_count INTEGER NOT NULL DEFAULT 0,
    parent_id TEXT,
    FOREIGN KEY(parent_id) REFERENCES timeline_posts(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_timeline_created ON timeline_posts(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_timeline_parent ON timeline_posts(parent_id);

CREATE TABLE IF NOT EXISTS watch_history (
    media_id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    title_native TEXT,
    episode INTEGER,
    source TEXT NOT NULL,
    watched_at INTEGER NOT NULL,
    duration REAL,
    position REAL,
    poster_url TEXT,
    poster_status TEXT,
    anilist_id INTEGER,
    tmdb_id INTEGER
);
CREATE INDEX IF NOT EXISTS idx_watch_history_time ON watch_history(watched_at DESC);

CREATE TABLE IF NOT EXISTS watch_sessions (
    id TEXT PRIMARY KEY,
    media_id TEXT NOT NULL,
    title TEXT NOT NULL,
    start_time INTEGER NOT NULL,
    end_time INTEGER NOT NULL,
    duration INTEGER NOT NULL,
    cues_mined INTEGER NOT NULL DEFAULT 0,
    mined_sentences TEXT,
    FOREIGN KEY(media_id) REFERENCES watch_history(media_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_watch_sessions_media ON watch_sessions(media_id, start_time DESC);

CREATE TABLE IF NOT EXISTS mining_archive (
    id TEXT PRIMARY KEY,
    media_filename TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    sentence TEXT NOT NULL,
    word TEXT,
    range_start REAL,
    range_end REAL
);
CREATE INDEX IF NOT EXISTS idx_mining_archive_time ON mining_archive(created_at DESC);

CREATE TABLE IF NOT EXISTS user_profile (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    handle TEXT NOT NULL,
    display_name TEXT NOT NULL,
    bio TEXT,
    avatar_url TEXT,
    updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS kv_store (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at INTEGER NOT NULL
);
"#;

/// Open (creating if needed) the on-disk database at `path`, enabling WAL and
/// foreign keys and applying the schema.
pub fn open(path: &Path) -> rusqlite::Result<Connection> {
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let conn = Connection::open(path)?;
    configure(&conn)?;
    Ok(conn)
}

/// Open an in-memory database (tests / ephemeral use).
pub fn open_in_memory() -> rusqlite::Result<Connection> {
    let conn = Connection::open_in_memory()?;
    configure(&conn)?;
    Ok(conn)
}

/// Apply pragmas and schema. Split out so both open paths share it.
fn configure(conn: &Connection) -> rusqlite::Result<()> {
    // WAL keeps readers and the single writer from blocking each other.
    conn.pragma_update(None, "journal_mode", "WAL")?;
    conn.pragma_update(None, "synchronous", "NORMAL")?;
    // Foreign keys are off by default in SQLite; the schema relies on them for
    // ON DELETE CASCADE.
    conn.pragma_update(None, "foreign_keys", true)?;
    conn.execute_batch(SCHEMA_SQL)?;
    Ok(())
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// Generate a reasonably unique id without pulling in `uuid`.
fn new_id(prefix: &str) -> String {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    format!("{prefix}_{nanos}")
}

// ---------------------------------------------------------------------------
// Timeline
// ---------------------------------------------------------------------------

fn row_to_post(row: &rusqlite::Row<'_>) -> rusqlite::Result<TimelinePost> {
    Ok(TimelinePost {
        id: row.get(0)?,
        author_handle: row.get(1)?,
        author_name: row.get(2)?,
        author_avatar: row.get(3)?,
        content: row.get(4)?,
        created_at: row.get(5)?,
        likes: row.get(6)?,
        liked_by_me: row.get::<_, i64>(7)? != 0,
        reply_count: row.get(8)?,
        parent_id: row.get(9)?,
    })
}

const POST_COLS: &str = "id, author_handle, author_name, author_avatar, content, created_at, likes, liked_by_me, reply_count, parent_id";

/// List posts. When `parent_id` is `Some`, return that post's replies ordered
/// oldest-first; otherwise return top-level posts newest-first.
pub fn get_timeline_posts(
    conn: &Connection,
    limit: Option<u32>,
    offset: Option<u32>,
    parent_id: Option<String>,
) -> rusqlite::Result<Vec<TimelinePost>> {
    let limit = limit.unwrap_or(50).clamp(1, 500) as i64;
    let offset = offset.unwrap_or(0) as i64;
    // Replies are returned oldest-first so a thread reads top-down; top-level
    // posts are newest-first for the feed.
    let mut stmt = if let Some(parent) = &parent_id {
        let sql = format!(
            "SELECT {POST_COLS} FROM timeline_posts WHERE parent_id = ?1 ORDER BY created_at ASC, id LIMIT ?2 OFFSET ?3"
        );
        let mut stmt = conn.prepare(&sql)?;
        let out = stmt
            .query_map(params![parent, limit, offset], row_to_post)?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        return Ok(out);
    } else {
        let sql = format!(
            "SELECT {POST_COLS} FROM timeline_posts WHERE parent_id IS NULL ORDER BY created_at DESC, id LIMIT ?1 OFFSET ?2"
        );
        conn.prepare(&sql)?
    };
    let out = stmt
        .query_map(params![limit, offset], row_to_post)?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(out)
}

/// Insert a post. When it is a reply, bump the parent's `reply_count`.
///
/// The insert and the counter bump run in one transaction so a reply is never
/// left behind with a stale parent `reply_count` if either statement fails.
/// `unchecked_transaction` keeps the `&Connection` signature (all callers hold
/// a shared conn via `with_db!`); it is safe here because we are the only
/// active writer on this connection for the duration of the call.
pub fn create_timeline_post(
    conn: &Connection,
    input: TimelinePostInput,
) -> rusqlite::Result<TimelinePost> {
    let id = new_id("post");
    let tx = conn.unchecked_transaction()?;
    tx.execute(
        "INSERT INTO timeline_posts (id, author_handle, author_name, author_avatar, content, created_at, likes, liked_by_me, reply_count, parent_id) \
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, 0, 0, 0, ?7)",
        params![
            id,
            input.author_handle,
            input.author_name,
            input.author_avatar,
            input.content,
            input.created_at,
            input.parent_id
        ],
    )?;
    if let Some(parent) = &input.parent_id {
        tx.execute(
            "UPDATE timeline_posts SET reply_count = reply_count + 1 WHERE id = ?1",
            params![parent],
        )?;
    }
    tx.commit()?;
    get_post_by_id(conn, &id)?.ok_or_else(|| {
        rusqlite::Error::QueryReturnedNoRows
    })
}

pub fn get_post_by_id(conn: &Connection, id: &str) -> rusqlite::Result<Option<TimelinePost>> {
    let sql = format!("SELECT {POST_COLS} FROM timeline_posts WHERE id = ?1");
    conn.query_row(&sql, params![id], row_to_post).optional()
}

/// Toggle the caller's like on a post and return the updated row.
pub fn toggle_like_post(conn: &Connection, id: &str) -> rusqlite::Result<TimelinePost> {
    let liked = conn
        .query_row(
            "SELECT liked_by_me FROM timeline_posts WHERE id = ?1",
            params![id],
            |r| r.get::<_, i64>(0),
        )
        .optional()?
        .ok_or(rusqlite::Error::QueryReturnedNoRows)?;
    if liked != 0 {
        conn.execute(
            "UPDATE timeline_posts SET liked_by_me = 0, likes = MAX(likes - 1, 0) WHERE id = ?1",
            params![id],
        )?;
    } else {
        conn.execute(
            "UPDATE timeline_posts SET liked_by_me = 1, likes = likes + 1 WHERE id = ?1",
            params![id],
        )?;
    }
    get_post_by_id(conn, id)?.ok_or(rusqlite::Error::QueryReturnedNoRows)
}

// ---------------------------------------------------------------------------
// Watch history
// ---------------------------------------------------------------------------

const HISTORY_COLS: &str = "media_id, title, title_native, episode, source, watched_at, duration, position, poster_url, poster_status, anilist_id, tmdb_id";

fn row_to_history(row: &rusqlite::Row<'_>) -> rusqlite::Result<WatchHistoryItem> {
    Ok(WatchHistoryItem {
        media_id: row.get(0)?,
        title: row.get(1)?,
        title_native: row.get(2)?,
        episode: row.get(3)?,
        source: row.get(4)?,
        watched_at: row.get(5)?,
        duration: row.get(6)?,
        position: row.get(7)?,
        poster_url: row.get(8)?,
        poster_status: row.get(9)?,
        anilist_id: row.get(10)?,
        tmdb_id: row.get(11)?,
    })
}

/// Insert or update a watch-history entry keyed by `media_id`.
pub fn upsert_watch_history(
    conn: &Connection,
    item: WatchHistoryInput,
) -> rusqlite::Result<()> {
    conn.execute(
        "INSERT INTO watch_history (media_id, title, title_native, episode, source, watched_at, duration, position, poster_url, poster_status, anilist_id, tmdb_id) \
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12) \
         ON CONFLICT(media_id) DO UPDATE SET \
           title=excluded.title, title_native=excluded.title_native, episode=excluded.episode, \
           source=excluded.source, watched_at=excluded.watched_at, duration=excluded.duration, \
           position=excluded.position, poster_url=excluded.poster_url, poster_status=excluded.poster_status, \
           anilist_id=excluded.anilist_id, tmdb_id=excluded.tmdb_id",
        params![
            item.media_id,
            item.title,
            item.title_native,
            item.episode,
            item.source,
            item.watched_at,
            item.duration,
            item.position,
            item.poster_url,
            item.poster_status,
            item.anilist_id,
            item.tmdb_id
        ],
    )?;
    Ok(())
}

pub fn get_watch_history(
    conn: &Connection,
    limit: Option<u32>,
    offset: Option<u32>,
) -> rusqlite::Result<Vec<WatchHistoryItem>> {
    let limit = limit.unwrap_or(50).clamp(1, 500) as i64;
    let offset = offset.unwrap_or(0) as i64;
    let sql = format!(
        "SELECT {HISTORY_COLS} FROM watch_history ORDER BY watched_at DESC, media_id LIMIT ?1 OFFSET ?2"
    );
    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt.query_map(params![limit, offset], row_to_history)?;
    rows.collect()
}

// ---------------------------------------------------------------------------
// Watch sessions
// ---------------------------------------------------------------------------

fn row_to_session(row: &rusqlite::Row<'_>) -> rusqlite::Result<WatchSessionItem> {
    let mined_json: Option<String> = row.get(7)?;
    let mined_sentences = mined_json
        .and_then(|s| serde_json::from_str::<Vec<String>>(&s).ok())
        .unwrap_or_default();
    Ok(WatchSessionItem {
        id: row.get(0)?,
        media_id: row.get(1)?,
        title: row.get(2)?,
        start_time: row.get(3)?,
        end_time: row.get(4)?,
        duration: row.get(5)?,
        cues_mined: row.get(6)?,
        mined_sentences,
    })
}

/// Save a viewing session. `mined_sentences` is stored as a JSON array.
///
/// When `session.id` is `Some`, that client-provided identity is used so
/// repeated saves of one logical session upsert a single row (the web layer
/// re-saves the same session as it progresses). When `None`, a fresh id is
/// generated — the server-authoritative one-shot default.
pub fn save_watch_session(
    conn: &Connection,
    session: WatchSessionInput,
) -> rusqlite::Result<()> {
    let id = match session.id {
        Some(ref id) if !id.is_empty() => id.clone(),
        _ => new_id("sess"),
    };
    let mined = serde_json::to_string(&session.mined_sentences)
        .map_err(|e| rusqlite::Error::ToSqlConversionFailure(Box::new(e)))?;
    conn.execute(
        "INSERT INTO watch_sessions (id, media_id, title, start_time, end_time, duration, cues_mined, mined_sentences) \
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8) \
         ON CONFLICT(id) DO UPDATE SET \
           media_id=excluded.media_id, title=excluded.title, start_time=excluded.start_time, \
           end_time=excluded.end_time, duration=excluded.duration, cues_mined=excluded.cues_mined, \
           mined_sentences=excluded.mined_sentences",
        params![
            id,
            session.media_id,
            session.title,
            session.start_time,
            session.end_time,
            session.duration,
            session.cues_mined,
            mined
        ],
    )?;
    Ok(())
}

pub fn get_watch_sessions(
    conn: &Connection,
    media_id: Option<String>,
) -> rusqlite::Result<Vec<WatchSessionItem>> {
    let (sql, params_used): (String, Vec<Box<dyn rusqlite::ToSql>>) = match &media_id {
        Some(_) => (
            "SELECT id, media_id, title, start_time, end_time, duration, cues_mined, mined_sentences \
             FROM watch_sessions WHERE media_id = ?1 ORDER BY start_time DESC".into(),
            vec![Box::new(media_id)],
        ),
        None => (
            "SELECT id, media_id, title, start_time, end_time, duration, cues_mined, mined_sentences \
             FROM watch_sessions ORDER BY start_time DESC".into(),
            vec![],
        ),
    };
    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt.query_map(rusqlite::params_from_iter(params_used), row_to_session)?;
    rows.collect()
}

// ---------------------------------------------------------------------------
// Mining archive
// ---------------------------------------------------------------------------

const MINING_COLS: &str = "id, media_filename, created_at, sentence, word, range_start, range_end";

fn row_to_mining(row: &rusqlite::Row<'_>) -> rusqlite::Result<MiningArchiveItem> {
    Ok(MiningArchiveItem {
        id: row.get(0)?,
        media_filename: row.get(1)?,
        created_at: row.get(2)?,
        sentence: row.get(3)?,
        word: row.get(4)?,
        range_start: row.get(5)?,
        range_end: row.get(6)?,
    })
}

pub fn save_mining_card(conn: &Connection, card: MiningArchiveInput) -> rusqlite::Result<()> {
    let id = new_id("mine");
    conn.execute(
        "INSERT INTO mining_archive (id, media_filename, created_at, sentence, word, range_start, range_end) \
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
        params![
            id,
            card.media_filename,
            card.created_at,
            card.sentence,
            card.word,
            card.range_start,
            card.range_end
        ],
    )?;
    Ok(())
}

pub fn get_mining_archive(
    conn: &Connection,
    limit: Option<u32>,
    offset: Option<u32>,
) -> rusqlite::Result<Vec<MiningArchiveItem>> {
    let limit = limit.unwrap_or(50).clamp(1, 500) as i64;
    let offset = offset.unwrap_or(0) as i64;
    let sql = format!(
        "SELECT {MINING_COLS} FROM mining_archive ORDER BY created_at DESC, id LIMIT ?1 OFFSET ?2"
    );
    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt.query_map(params![limit, offset], row_to_mining)?;
    rows.collect()
}

// ---------------------------------------------------------------------------
// Profile
// ---------------------------------------------------------------------------

const PROFILE_COLS: &str = "handle, display_name, bio, avatar_url, updated_at";

fn row_to_profile(row: &rusqlite::Row<'_>) -> rusqlite::Result<UserProfile> {
    Ok(UserProfile {
        handle: row.get(0)?,
        display_name: row.get(1)?,
        bio: row.get(2)?,
        avatar_url: row.get(3)?,
        updated_at: row.get(4)?,
    })
}

pub fn get_profile(conn: &Connection) -> rusqlite::Result<Option<UserProfile>> {
    let sql = format!("SELECT {PROFILE_COLS} FROM user_profile WHERE id = 1");
    conn.query_row(&sql, [], row_to_profile).optional()
}

pub fn upsert_profile(conn: &Connection, profile: UserProfileInput) -> rusqlite::Result<UserProfile> {
    conn.execute(
        "INSERT INTO user_profile (id, handle, display_name, bio, avatar_url, updated_at) \
         VALUES (1, ?1, ?2, ?3, ?4, ?5) \
         ON CONFLICT(id) DO UPDATE SET \
           handle=excluded.handle, display_name=excluded.display_name, bio=excluded.bio, \
           avatar_url=excluded.avatar_url, updated_at=excluded.updated_at",
        params![
            profile.handle,
            profile.display_name,
            profile.bio,
            profile.avatar_url,
            profile.updated_at
        ],
    )?;
    get_profile(conn)?.ok_or(rusqlite::Error::QueryReturnedNoRows)
}

// ---------------------------------------------------------------------------
// KV store
// ---------------------------------------------------------------------------

pub fn kv_get(conn: &Connection, key: &str) -> rusqlite::Result<Option<String>> {
    conn.query_row(
        "SELECT value FROM kv_store WHERE key = ?1",
        params![key],
        |r| r.get(0),
    )
    .optional()
}

pub fn kv_set(conn: &Connection, key: &str, value: &str) -> rusqlite::Result<()> {
    let now = now_ms();
    conn.execute(
        "INSERT INTO kv_store (key, value, updated_at) VALUES (?1, ?2, ?3) \
         ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at",
        params![key, value, now],
    )?;
    Ok(())
}

// ---------------------------------------------------------------------------
// One-shot migration
// ---------------------------------------------------------------------------

/// Import the browser-exported payload inside a single transaction. Idempotent:
/// re-importing the same payload produces the same state. Every insert is an
/// `ON CONFLICT ... DO UPDATE` upsert (never `INSERT OR REPLACE`) so re-import
/// cannot DELETE+re-INSERT a parent row and thereby fire `ON DELETE CASCADE`
/// against its replies or a history row's sessions.
pub fn migrate_v1(conn: &mut Connection, payload: MigrationPayloadV1) -> rusqlite::Result<()> {
    let tx = conn.transaction()?;
    for post in payload.posts {
        tx.execute(
            "INSERT INTO timeline_posts (id, author_handle, author_name, author_avatar, content, created_at, likes, liked_by_me, reply_count, parent_id) \
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10) \
             ON CONFLICT(id) DO UPDATE SET \
               author_handle=excluded.author_handle, author_name=excluded.author_name, \
               author_avatar=excluded.author_avatar, content=excluded.content, \
               created_at=excluded.created_at, likes=excluded.likes, \
               liked_by_me=excluded.liked_by_me, reply_count=excluded.reply_count, \
               parent_id=excluded.parent_id",
            params![
                post.id,
                post.author_handle,
                post.author_name,
                post.author_avatar,
                post.content,
                post.created_at,
                post.likes,
                post.liked_by_me as i64,
                post.reply_count,
                post.parent_id
            ],
        )?;
    }
    for h in payload.watch_history {
        upsert_watch_history(&tx, WatchHistoryInput {
            media_id: h.media_id,
            title: h.title,
            title_native: h.title_native,
            episode: h.episode,
            source: h.source,
            watched_at: h.watched_at,
            duration: h.duration,
            position: h.position,
            poster_url: h.poster_url,
            poster_status: h.poster_status,
            anilist_id: h.anilist_id,
            tmdb_id: h.tmdb_id,
        })?;
    }
    for s in payload.watch_sessions {
        // Guarantee parent watch_history row exists so browser-era orphaned sessions
        // (which originated in an older or separate store) do not abort the migration
        // with a FOREIGN KEY constraint failure.
        tx.execute(
            "INSERT INTO watch_history (media_id, title, source, watched_at) \
             VALUES (?1, ?2, 'local', ?3) \
             ON CONFLICT(media_id) DO NOTHING",
            params![s.media_id, s.title, s.end_time],
        )?;

        let mined = serde_json::to_string(&s.mined_sentences)
            .map_err(|e| rusqlite::Error::ToSqlConversionFailure(Box::new(e)))?;
        tx.execute(
            "INSERT INTO watch_sessions (id, media_id, title, start_time, end_time, duration, cues_mined, mined_sentences) \
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8) \
             ON CONFLICT(id) DO UPDATE SET \
               media_id=excluded.media_id, title=excluded.title, start_time=excluded.start_time, \
               end_time=excluded.end_time, duration=excluded.duration, \
               cues_mined=excluded.cues_mined, mined_sentences=excluded.mined_sentences",
            params![s.id, s.media_id, s.title, s.start_time, s.end_time, s.duration, s.cues_mined, mined],
        )?;
    }
    for m in payload.mining_archive {
        tx.execute(
            "INSERT INTO mining_archive (id, media_filename, created_at, sentence, word, range_start, range_end) \
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7) \
             ON CONFLICT(id) DO UPDATE SET \
               media_filename=excluded.media_filename, created_at=excluded.created_at, \
               sentence=excluded.sentence, word=excluded.word, range_start=excluded.range_start, \
               range_end=excluded.range_end",
            params![m.id, m.media_filename, m.created_at, m.sentence, m.word, m.range_start, m.range_end],
        )?;
    }
    if let Some(p) = payload.profile {
        upsert_profile(&tx, UserProfileInput {
            handle: p.handle,
            display_name: p.display_name,
            bio: p.bio,
            avatar_url: p.avatar_url,
            updated_at: p.updated_at,
        })?;
    }
    for kv in payload.kv {
        kv_set(&tx, &kv.key, &kv.value)?;
    }
    tx.commit()?;
    Ok(())
}
