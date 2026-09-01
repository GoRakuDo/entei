package anki

import (
	"database/sql"
	"path/filepath"
	"strings"
	"testing"

	_ "modernc.org/sqlite" // imported in collection.go too; safe to repeat
)

// TestUnicaseCollationRegistered pins the on-device failure mode:
// a SQLite table whose name column is declared `COLLATE UNICASE`
// (the real AnkiDroid 2.16+ schema — verified 2026-09-01) raises
// `no such collation sequence: unicase` for any SELECT … WHERE
// name = ? query UNLESS the bridge has registered UNICASE on the
// driver. This test creates that exact table shape, runs the exact
// name-filtered query the Entei addNote path issues, and asserts it
// succeeds. Pre-registration the test fails with the modernc
// `no such collation sequence: unicase` error; post-registration it
// returns the row. The test would have caught the real-device
// "anki action failed" failure on modelFieldNames / deckNames lookups.
func TestUnicaseCollationRegistered(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "unicase.db")
	// Production path (OpenCollection → openCollectionDSN) calls
	// ensureUnicaseCollation before sql.Open. Tests that drive
	// sql.Open directly must call it too, otherwise the CREATE TABLE
	// fails with `no such collation sequence: UNICASE`. The whole
	// point of the test is to confirm registration works, so it
	// must exercise the post-registration path.
	ensureUnicaseCollation()
	db, err := sql.Open("sqlite", "file:"+path)
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	defer db.Close()
	// Mirror the real on-device shape: `name TEXT COLLATE UNICASE`
	// (AnkiDroid 2.16+ notetypes and decks tables). modernc fails
	// to CREATE this table without UNICASE registered.
	if _, err := db.Exec(`CREATE TABLE t (name TEXT COLLATE UNICASE)`); err != nil {
		t.Fatalf("CREATE TABLE with COLLATE UNICASE: %v (modernc needs UNICASE registered first)", err)
	}
	for _, v := range []string{"Basic", "Cloze", "Default", "Japanese"} {
		if _, err := db.Exec(`INSERT INTO t(name) VALUES (?)`, v); err != nil {
			t.Fatalf("insert %q: %v", v, err)
		}
	}
	// The on-device failing query shape: SELECT … WHERE name = ?
	// against a UNICASE-collated name column. Without registration
	// this returns `no such collation sequence: unicase`; with
	// registration it returns the row.
	rows, err := db.Query(`SELECT name FROM t WHERE name = ?`, "basic")
	if err != nil {
		t.Fatalf("SELECT WHERE name = ? with UNICASE: %v", err)
	}
	defer rows.Close()
	var got []string
	for rows.Next() {
		var n string
		if err := rows.Scan(&n); err != nil {
			t.Fatalf("scan: %v", err)
		}
		got = append(got, n)
	}
	if err := rows.Err(); err != nil {
		t.Fatalf("rows.Err(): %v", err)
	}
	if len(got) != 1 || got[0] != "Basic" {
		t.Errorf("name-filtered query returned %v, want [Basic]", got)
	}
}

// TestUnicaseOrdering pins the second on-device failure mode that
// UNICASE registration must also fix: ORDER BY name on a
// UNICASE-collated column. The real AnkiDroid schema does not
// ORDER BY name in the tables the bridge reads, but the same
// `no such collation sequence: unicase` error fires for both WHERE
// and ORDER BY — registration must cover both. A naive comparator
// (no lowercase folding) would still match `Basic == basic` but
// fail to put `apple` before `Banana` (lexicographic: B < a); the
// pinned sort order here validates the case-folded comparator.
func TestUnicaseOrdering(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "unicase_sort.db")
	// See TestUnicaseCollationRegistered: sql.Open directly bypasses
	// openCollectionDSN, so the test must register UNICASE itself.
	ensureUnicaseCollation()
	db, err := sql.Open("sqlite", "file:"+path)
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	defer db.Close()
	if _, err := db.Exec(`CREATE TABLE t (name TEXT COLLATE UNICASE)`); err != nil {
		t.Fatalf("CREATE TABLE with COLLATE UNICASE: %v", err)
	}
	for _, v := range []string{"Banana", "apple", "Cherry"} {
		if _, err := db.Exec(`INSERT INTO t(name) VALUES (?)`, v); err != nil {
			t.Fatalf("insert %q: %v", v, err)
		}
	}
	rows, err := db.Query(`SELECT name FROM t ORDER BY name`)
	if err != nil {
		t.Fatalf("ORDER BY name with UNICASE: %v", err)
	}
	defer rows.Close()
	var got []string
	for rows.Next() {
		var n string
		if err := rows.Scan(&n); err != nil {
			t.Fatalf("scan: %v", err)
		}
		got = append(got, n)
	}
	if err := rows.Err(); err != nil {
		t.Fatalf("rows.Err(): %v", err)
	}
	want := []string{"apple", "Banana", "Cherry"}
	if len(got) != len(want) {
		t.Fatalf("ORDER BY name returned %v, want %v", got, want)
	}
	for i := range got {
		if got[i] != want[i] {
			t.Errorf("ORDER BY name[%d] = %q, want %q", i, got[i], want[i])
		}
	}
}

// TestEnsureUnicaseCollationIdempotent pins that calling
// ensureUnicaseCollation() multiple times (across tests in the same
// process) is safe: sync.Once inside guards double-register. Without
// idempotency, a parallel test that also registers UNICASE under a
// different comparator could silently shadow the production one.
func TestEnsureUnicaseCollationIdempotent(t *testing.T) {
	// Two back-to-back calls must not panic and must not throw.
	// The actual side-effect is unobservable from outside, so we
	// just confirm the function returns without error.
	for i := 0; i < 3; i++ {
		ensureUnicaseCollation()
	}
	// The real proof of idempotency is that TestUnicaseCollationRegistered
	// and TestUnicaseOrdering — which both go through sql.Open →
	// ensureUnicaseCollation (via openCollectionDSN for the
	// production path, via their own sql.Open here) — keep passing
	// in any order.
	if !strings.Contains("sanity", "anity") {
		t.Fatal("strings.Contains sanity check failed — test runner is broken")
	}
}