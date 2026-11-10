//! Unit tests for the embedded SQLite store, run against an in-memory
//! database so no Tauri runtime or on-disk state is required.

use tauri_plugin_database::store;
use tauri_plugin_database::{
    MigrationPayloadV1, MiningArchiveInput, TimelinePostInput, UserProfileInput,
    WatchHistoryInput, WatchSessionInput, WatchSessionItem,
};

fn conn() -> rusqlite::Connection {
    store::open_in_memory().expect("open in-memory db")
}

fn sample_post_input(created_at: i64, parent_id: Option<String>) -> TimelinePostInput {
    TimelinePostInput {
        author_handle: format!("handle_{created_at}"),
        author_name: "Author".into(),
        author_avatar: "avatar.png".into(),
        content: "こんにちは世界".into(),
        created_at,
        parent_id,
    }
}

#[test]
fn schema_creates_all_tables() {
    let c = conn();
    for table in [
        "timeline_posts",
        "watch_history",
        "watch_sessions",
        "mining_archive",
        "user_profile",
        "kv_store",
    ] {
        let n: i64 = c
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name=?1",
                [table],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(n, 1, "table {table} should exist");
    }
}

#[test]
fn wal_mode_is_enabled_on_disk() {
    let dir = std::env::temp_dir().join("entei_db_test_wal");
    std::fs::create_dir_all(&dir).unwrap();
    let path = dir.join("wal.db");
    let _ = std::fs::remove_file(&path);
    let c = store::open(&path).unwrap();
    let mode: String = c
        .query_row("PRAGMA journal_mode", [], |r| r.get(0))
        .unwrap();
    assert_eq!(mode.to_lowercase(), "wal");
    drop(c);
    let _ = std::fs::remove_file(&path);
}

#[test]
fn foreign_keys_are_enforced() {
    let c = conn();
    let on: i64 = c
        .query_row("PRAGMA foreign_keys", [], |r| r.get(0))
        .unwrap();
    assert_eq!(on, 1);
}

#[test]
fn timeline_create_and_list_top_level() {
    let mut c = conn();
    let p1 = store::create_timeline_post(&c, sample_post_input(100, None)).unwrap();
    let p2 = store::create_timeline_post(&c, sample_post_input(200, None)).unwrap();
    assert_ne!(p1.id, p2.id);
    assert_eq!(p1.likes, 0);
    assert!(!p1.liked_by_me);

    let posts = store::get_timeline_posts(&mut c, None, None, None).unwrap();
    assert_eq!(posts.len(), 2);
    // newest first
    assert_eq!(posts[0].id, p2.id);
    assert_eq!(posts[1].id, p1.id);
}

#[test]
fn timeline_replies_filter_and_increment_parent_count() {
    let mut c = conn();
    let parent = store::create_timeline_post(&c, sample_post_input(100, None)).unwrap();
    let r1 = store::create_timeline_post(&c, sample_post_input(110, Some(parent.id.clone()))).unwrap();
    let _r2 = store::create_timeline_post(&c, sample_post_input(120, Some(parent.id.clone()))).unwrap();

    // parent's reply_count bumped twice
    let updated_parent = store::get_timeline_posts(&mut c, None, None, None).unwrap();
    assert_eq!(updated_parent[0].reply_count, 2);

    // only replies listed when parent_id given
    let replies = store::get_timeline_posts(&mut c, None, None, Some(parent.id)).unwrap();
    assert_eq!(replies.len(), 2);
    // oldest first within a thread
    assert_eq!(replies[0].id, r1.id);
}

#[test]
fn timeline_toggle_like_flips_and_updates_count() {
    let mut c = conn();
    let p = store::create_timeline_post(&c, sample_post_input(100, None)).unwrap();
    let liked = store::toggle_like_post(&mut c, &p.id).unwrap();
    assert!(liked.liked_by_me);
    assert_eq!(liked.likes, 1);
    let unliked = store::toggle_like_post(&mut c, &p.id).unwrap();
    assert!(!unliked.liked_by_me);
    assert_eq!(unliked.likes, 0);
}

#[test]
fn timeline_toggle_like_missing_post_errors() {
    let mut c = conn();
    assert!(store::toggle_like_post(&mut c, "nope").is_err());
}

#[test]
fn timeline_paging() {
    let mut c = conn();
    for i in 0..10 {
        store::create_timeline_post(&c, sample_post_input(i, None)).unwrap();
    }
    let page1 = store::get_timeline_posts(&mut c, Some(3), Some(0), None).unwrap();
    let page2 = store::get_timeline_posts(&mut c, Some(3), Some(3), None).unwrap();
    assert_eq!(page1.len(), 3);
    assert_eq!(page2.len(), 3);
    // pages do not overlap
    let ids1: Vec<_> = page1.iter().map(|p| p.id.clone()).collect();
    let ids2: Vec<_> = page2.iter().map(|p| p.id.clone()).collect();
    assert!(ids1.iter().all(|id| !ids2.contains(id)));
}

#[test]
fn watch_history_upsert_is_idempotent_by_media_id() {
    let mut c = conn();
    let item = WatchHistoryInput {
        media_id: "m1".into(),
        title: "Title".into(),
        title_native: Some("タイトル".into()),
        episode: Some(3),
        source: "local".into(),
        watched_at: 1000,
        duration: Some(120.0),
        position: Some(30.0),
        poster_url: Some("p.jpg".into()),
        poster_status: Some("ok".into()),
        anilist_id: Some(42),
        tmdb_id: None,
    };
    store::upsert_watch_history(&mut c, item.clone()).unwrap();
    store::upsert_watch_history(&mut c, WatchHistoryInput {
        watched_at: 2000,
        position: Some(60.0),
        ..item
    })
    .unwrap();

    let all = store::get_watch_history(&mut c, None, None).unwrap();
    assert_eq!(all.len(), 1, "upsert should not duplicate");
    assert_eq!(all[0].watched_at, 2000);
    assert_eq!(all[0].position, Some(60.0));
}

#[test]
fn watch_sessions_save_and_filter_by_media() {
    let mut c = conn();
    store::upsert_watch_history(&mut c, WatchHistoryInput {
        media_id: "m1".into(),
        title: "T".into(),
        title_native: None,
        episode: None,
        source: "local".into(),
        watched_at: 1,
        duration: None,
        position: None,
        poster_url: None,
        poster_status: None,
        anilist_id: None,
        tmdb_id: None,
    })
    .unwrap();

    store::save_watch_session(&mut c, WatchSessionInput {
        id: None,
        media_id: "m1".into(),
        title: "T".into(),
        start_time: 100,
        end_time: 200,
        duration: 100,
        cues_mined: 2,
        mined_sentences: vec!["文1".into(), "文2".into()],
    })
    .unwrap();
    // m2 needs its own history row: watch_sessions.media_id is a foreign key.
    store::upsert_watch_history(&mut c, WatchHistoryInput {
        media_id: "m2".into(),
        title: "Other".into(),
        title_native: None,
        episode: None,
        source: "local".into(),
        watched_at: 2,
        duration: None,
        position: None,
        poster_url: None,
        poster_status: None,
        anilist_id: None,
        tmdb_id: None,
    })
    .unwrap();
    store::save_watch_session(&mut c, WatchSessionInput {
        id: None,
        media_id: "m2".into(),
        title: "Other".into(),
        start_time: 300,
        end_time: 400,
        duration: 100,
        cues_mined: 0,
        mined_sentences: vec![],
    })
    .unwrap();

    let all = store::get_watch_sessions(&mut c, None).unwrap();
    assert_eq!(all.len(), 2);
    let filtered = store::get_watch_sessions(&mut c, Some("m1".into())).unwrap();
    assert_eq!(filtered.len(), 1);
    assert_eq!(filtered[0].mined_sentences, vec!["文1".to_string(), "文2".to_string()]);
    assert_eq!(filtered[0].cues_mined, 2);
}

#[test]
fn watch_session_client_id_upserts_single_row() {
    let mut c = conn();
    store::upsert_watch_history(&mut c, WatchHistoryInput {
        media_id: "m1".into(),
        title: "T".into(),
        title_native: None,
        episode: None,
        source: "local".into(),
        watched_at: 1,
        duration: None,
        position: None,
        poster_url: None,
        poster_status: None,
        anilist_id: None,
        tmdb_id: None,
    })
    .unwrap();

    // The web layer re-saves the SAME session id as it progresses.
    let sid = "watch-abc".to_string();
    store::save_watch_session(&mut c, WatchSessionInput {
        id: Some(sid.clone()),
        media_id: "m1".into(),
        title: "T".into(),
        start_time: 100,
        end_time: 150,
        duration: 50,
        cues_mined: 0,
        mined_sentences: vec![],
    })
    .unwrap();
    store::save_watch_session(&mut c, WatchSessionInput {
        id: Some(sid.clone()),
        media_id: "m1".into(),
        title: "T".into(),
        start_time: 100,
        end_time: 300,
        duration: 200,
        cues_mined: 1,
        mined_sentences: vec!["文".into()],
    })
    .unwrap();

    let all = store::get_watch_sessions(&mut c, Some("m1".into())).unwrap();
    assert_eq!(all.len(), 1, "same client id must upsert one row");
    assert_eq!(all[0].id, sid);
    assert_eq!(all[0].duration, 200);
    assert_eq!(all[0].cues_mined, 1);
    assert_eq!(all[0].mined_sentences, vec!["文".to_string()]);
}

#[test]
fn mining_archive_save_and_list() {
    let mut c = conn();
    store::save_mining_card(&mut c, MiningArchiveInput {
        media_filename: "ep01.mkv".into(),
        created_at: 500,
        sentence: "これはペンです".into(),
        word: Some("ペン".into()),
        range_start: Some(1.0),
        range_end: Some(2.5),
    })
    .unwrap();
    store::save_mining_card(&mut c, MiningArchiveInput {
        media_filename: "ep01.mkv".into(),
        created_at: 900,
        sentence: "二文目".into(),
        word: None,
        range_start: None,
        range_end: None,
    })
    .unwrap();

    let all = store::get_mining_archive(&mut c, None, None).unwrap();
    assert_eq!(all.len(), 2);
    assert_eq!(all[0].sentence, "二文目"); // newest first
    assert_eq!(all[1].word, Some("ペン".to_string()));
}

#[test]
fn profile_upsert_single_row() {
    let mut c = conn();
    assert!(store::get_profile(&mut c).unwrap().is_none());
    let p = store::upsert_profile(&mut c, UserProfileInput {
        handle: "yosia".into(),
        display_name: "Yosia".into(),
        bio: Some("hi".into()),
        avatar_url: None,
        updated_at: 1,
    })
    .unwrap();
    assert_eq!(p.handle, "yosia");
    let p2 = store::upsert_profile(&mut c, UserProfileInput {
        handle: "yosia2".into(),
        display_name: "Y2".into(),
        bio: None,
        avatar_url: Some("a.png".into()),
        updated_at: 2,
    })
    .unwrap();
    assert_eq!(p2.handle, "yosia2");
    // still a single row
    let n: i64 = c.query_row("SELECT COUNT(*) FROM user_profile", [], |r| r.get(0)).unwrap();
    assert_eq!(n, 1);
    assert_eq!(store::get_profile(&mut c).unwrap().unwrap().updated_at, 2);
}

#[test]
fn kv_get_set_roundtrip_and_overwrite() {
    let mut c = conn();
    assert_eq!(store::kv_get(&mut c, "k").unwrap(), None);
    store::kv_set(&mut c, "k", "v1").unwrap();
    assert_eq!(store::kv_get(&mut c, "k").unwrap(), Some("v1".into()));
    store::kv_set(&mut c, "k", "v2").unwrap();
    assert_eq!(store::kv_get(&mut c, "k").unwrap(), Some("v2".into()));
    assert_eq!(store::kv_get(&mut c, "missing").unwrap(), None);
}

#[test]
fn migrate_v1_imports_everything_in_one_call() {
    let mut c = conn();
    let payload = MigrationPayloadV1 {
        posts: vec![tauri_plugin_database::TimelinePost {
            id: "p1".into(),
            author_handle: "h".into(),
            author_name: "n".into(),
            author_avatar: "a".into(),
            content: "c".into(),
            created_at: 1,
            likes: 5,
            liked_by_me: true,
            reply_count: 0,
            parent_id: None,
        }],
        watch_history: vec![tauri_plugin_database::WatchHistoryItem {
            media_id: "m1".into(),
            title: "T".into(),
            title_native: None,
            episode: None,
            source: "youtube".into(),
            watched_at: 10,
            duration: None,
            position: None,
            poster_url: None,
            poster_status: None,
            anilist_id: None,
            tmdb_id: None,
        }],
        watch_sessions: vec![tauri_plugin_database::WatchSessionItem {
            id: "s1".into(),
            media_id: "m1".into(),
            title: "T".into(),
            start_time: 1,
            end_time: 2,
            duration: 1,
            cues_mined: 3,
            mined_sentences: vec!["x".into()],
        }],
        mining_archive: vec![tauri_plugin_database::MiningArchiveItem {
            id: "mi1".into(),
            media_filename: "f.mkv".into(),
            created_at: 7,
            sentence: "s".into(),
            word: Some("w".into()),
            range_start: None,
            range_end: None,
        }],
        profile: Some(tauri_plugin_database::UserProfile {
            handle: "yosia".into(),
            display_name: "Y".into(),
            bio: None,
            avatar_url: None,
            updated_at: 9,
        }),
        kv: vec![tauri_plugin_database::KvEntry {
            key: "flag".into(),
            value: "1".into(),
        }],
    };
    store::migrate_v1(&mut c, payload).unwrap();

    assert_eq!(store::get_timeline_posts(&mut c, None, None, None).unwrap().len(), 1);
    assert_eq!(store::get_watch_history(&mut c, None, None).unwrap().len(), 1);
    assert_eq!(store::get_watch_sessions(&mut c, None).unwrap().len(), 1);
    assert_eq!(store::get_mining_archive(&mut c, None, None).unwrap().len(), 1);
    assert_eq!(store::get_profile(&mut c).unwrap().unwrap().handle, "yosia");
    assert_eq!(store::kv_get(&mut c, "flag").unwrap(), Some("1".into()));
}

#[test]
fn migrate_v1_is_idempotent() {
    let mut c = conn();
    let payload = MigrationPayloadV1 {
        kv: vec![tauri_plugin_database::KvEntry { key: "k".into(), value: "v".into() }],
        ..Default::default()
    };
    store::migrate_v1(&mut c, payload.clone()).unwrap();
    store::migrate_v1(&mut c, payload).unwrap();
    let n: i64 = c.query_row("SELECT COUNT(*) FROM kv_store", [], |r| r.get(0)).unwrap();
    assert_eq!(n, 1);
}

#[test]
fn migrate_v1_reimport_does_not_cascade_delete_replies() {
    let mut c = conn();
    // Seed a parent + reply through the normal write path so the DB has real
    // child rows that an `INSERT OR REPLACE` on the parent would cascade-delete.
    let parent = store::create_timeline_post(&c, sample_post_input(100, None)).unwrap();
    let reply = store::create_timeline_post(&c, sample_post_input(110, Some(parent.id.clone()))).unwrap();

    // Re-import the same parent (authoritative reply_count = 1).
    let payload = MigrationPayloadV1 {
        posts: vec![tauri_plugin_database::TimelinePost {
            id: parent.id.clone(),
            author_handle: parent.author_handle.clone(),
            author_name: parent.author_name.clone(),
            author_avatar: parent.author_avatar.clone(),
            content: parent.content.clone(),
            created_at: parent.created_at,
            likes: 0,
            liked_by_me: false,
            reply_count: 1,
            parent_id: None,
        }],
        ..Default::default()
    };
    store::migrate_v1(&mut c, payload).unwrap();

    // The reply must survive the parent's upsert — ON CONFLICT DO UPDATE never
    // DELETEs the parent row, so ON DELETE CASCADE cannot fire.
    let replies = store::get_timeline_posts(&mut c, None, None, Some(parent.id)).unwrap();
    assert_eq!(replies.len(), 1, "reply must not be cascade-deleted on re-import");
    assert_eq!(replies[0].id, reply.id);
}

#[test]
fn cascade_delete_removes_sessions_with_history() {
    let mut c = conn();
    store::upsert_watch_history(&mut c, WatchHistoryInput {
        media_id: "m1".into(),
        title: "T".into(),
        title_native: None,
        episode: None,
        source: "local".into(),
        watched_at: 1,
        duration: None,
        position: None,
        poster_url: None,
        poster_status: None,
        anilist_id: None,
        tmdb_id: None,
    })
    .unwrap();
    store::save_watch_session(&mut c, WatchSessionInput {
        id: None,
        media_id: "m1".into(),
        title: "T".into(),
        start_time: 1,
        end_time: 2,
        duration: 1,
        cues_mined: 0,
        mined_sentences: vec![],
    })
    .unwrap();
    c.execute("DELETE FROM watch_history WHERE media_id='m1'", []).unwrap();
    let n: i64 = c.query_row("SELECT COUNT(*) FROM watch_sessions", [], |r| r.get(0)).unwrap();
    assert_eq!(n, 0, "session should be cascade-deleted with its history");
}

#[test]
fn migrate_v1_orphaned_sessions_do_not_abort() {
    let mut c = conn();
    // Payload contains watch_sessions with a media_id that is NOT in watch_history.
    let payload = MigrationPayloadV1 {
        posts: vec![],
        watch_history: vec![],
        watch_sessions: vec![WatchSessionItem {
            id: "orphan-sess-1".into(),
            media_id: "never-seen-media".into(),
            title: "Orphaned Movie".into(),
            start_time: 1000,
            end_time: 2000,
            duration: 1000,
            cues_mined: 0,
            mined_sentences: vec![],
        }],
        mining_archive: vec![],
        profile: None,
        kv: vec![],
    };

    // Must succeed without foreign key constraint failure.
    store::migrate_v1(&mut c, payload).unwrap();

    let sessions = store::get_watch_sessions(&mut c, Some("never-seen-media".into())).unwrap();
    assert_eq!(sessions.len(), 1);
    assert_eq!(sessions[0].id, "orphan-sess-1");

    let history = store::get_watch_history(&mut c, None, None).unwrap();
    assert_eq!(history.len(), 1);
    assert_eq!(history[0].media_id, "never-seen-media");
    assert_eq!(history[0].title, "Orphaned Movie");
}
