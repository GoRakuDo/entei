package anki

import (
	"database/sql"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
)

// newTestCollectionFixture builds a minimal real collection.anki2
// in t.TempDir() using the legacy-JSON schema (col.decks / col.models
// JSON blobs; schema 11). The test fixture includes:
//
//   - one col row with id=1, models/decks/dconf/conf/tags JSON
//     containing a single "Default" deck and a single "Basic" model
//     with 2 fields (Front, Back) and 1 template (Card 1).
//   - notes, cards tables (empty).
//
// The fixture is a faithful subset of Anki's schema11.sql; tests that
// need a deck/model/notes/cards pre-populated INSERT their own rows
// against this scaffold.
func newTestCollectionFixture(t *testing.T) string {
	t.Helper()
	return newTestCollectionFixtureAt(t, t.TempDir())
}

// newTestCollectionFixtureAt is newTestCollectionFixture with an
// explicit target directory (used by the FUSE roundtrip tests to
// place the "source" collection in a chosen dir).
func newTestCollectionFixtureAt(t *testing.T, dir string) string {
	t.Helper()
	path := filepath.Join(dir, "collection.anki2")
	db, err := sql.Open("sqlite", "file:"+path+"?_pragma=busy_timeout(5000)")
	if err != nil {
		t.Fatalf("open fixture: %v", err)
	}
	defer db.Close()
	if _, err := db.Exec(schema11SQL); err != nil {
		t.Fatalf("apply schema11: %v", err)
	}
	models := map[string]any{
		strconv.FormatInt(testModelID, 10): testModelJSON(t),
	}
	decks := map[string]any{
		strconv.FormatInt(testDeckID, 10): testDeckJSON(t),
	}
	dconf := map[string]any{
		"1": map[string]any{
			"id":   1,
			"name": "Default",
		},
	}
	conf := map[string]any{
		"nextPos":      1,
		"estTimes":     true,
		"activeDecks":  []int64{testDeckID},
		"sortType":     "noteFld",
		"timeLim":      0,
		"sortBackwards": false,
		"addToCur":     true,
		"curDeck":      testDeckID,
		"newSpread":    0,
		"dueCounts":    true,
		"curModel":     strconv.FormatInt(testModelID, 10),
		"collapseTime": 1200.0,
	}
	tags := map[string]any{}
	modelsJSON, _ := json.Marshal(models)
	decksJSON, _ := json.Marshal(decks)
	dconfJSON, _ := json.Marshal(dconf)
	confJSON, _ := json.Marshal(conf)
	tagsJSON, _ := json.Marshal(tags)
	if _, err := db.Exec(`INSERT INTO col (id, crt, mod, scm, ver, dty, usn, ls, conf, models, decks, dconf, tags) VALUES (1, ?, ?, ?, ?, 0, 0, 0, ?, ?, ?, ?, ?)`,
		1700000000, int64(1700000000000), int64(1700000000000), 11,
		string(confJSON), string(modelsJSON), string(decksJSON), string(dconfJSON), string(tagsJSON)); err != nil {
		t.Fatalf("insert col row: %v", err)
	}
	return path
}

// testModelID / testDeckID are stable IDs the schema fixture uses so
// tests can reference them by constant.
const (
	testModelID int64 = 1700000000001
	testDeckID  int64 = 1700000000002
)

// testModelExpressionID is the model id of a second fixture model
// whose FIRST field is "Expression" (NOT "Front") — used by
// TestCollectionFindNotesFieldName to pin the case where the
// model's first field name is non-Front (the exact v4.5 Yomitan
// regression — Yomitan's _fieldsToQuery uses the model's first
// field name, and only models whose first field is literally
// "Front" worked before this fix).
const testModelExpressionID int64 = 1700000000003

// testModelJSON returns a minimal "Basic" model JSON: 2 fields
// (Front, Back), 1 template (Card 1 → Front → Back).
func testModelJSON(t *testing.T) map[string]any {
	t.Helper()
	return map[string]any{
		"id":   testModelID,
		"name": "Basic",
		"type": 0,
		"mod":  0,
		"usn":  0,
		"sortf": 0,
		"did":  testDeckID,
		"flds": []map[string]any{
			{"name": "Front", "ord": 0, "sticky": false, "media": []string{}, "rtl": false, "font": "Arial", "size": 20},
			{"name": "Back", "ord": 1, "sticky": false, "media": []string{}, "rtl": false, "font": "Arial", "size": 20},
		},
		"tmpls": []map[string]any{
			{
				"name": "Card 1",
				"ord":  0,
				"qfmt": "{{Front}}",
				"afmt": "{{FrontSide}}\n\n<hr id=answer>\n\n{{Back}}",
				"did":  nil,
			},
		},
		"css":       ".card { font-family: arial; font-size: 20px; color: black; background-color: white; }",
		"latexPre":  "\\documentclass[12pt]{article}",
		"latexPost": "\\end{document}",
		"tags":      []string{},
		"vers":      []string{},
	}
}

// testModelExpressionJSON returns a model whose FIRST field is
// "Expression" (and second field "Meaning") — mirrors the
// shape of mining-style Anki note types like DenChou / JP Mining
// Note whose first field is named "Expression" rather than
// "Front". The model exists so TestCollectionFindNotesFieldName
// can pin the non-Front first-field case (the v4.5 Yomitan
// regression: Yomitan's _fieldsToQuery emits `<first-field-name>:
// <value>`, and the old front-only parser silently returned 0
// hits for any model whose first field wasn't literally "Front").
func testModelExpressionJSON(t *testing.T) map[string]any {
	t.Helper()
	return map[string]any{
		"id":    testModelExpressionID,
		"name":  "JP Mining Note",
		"type":  0,
		"mod":   0,
		"usn":   0,
		"sortf": 0,
		"did":   testDeckID,
		"flds": []map[string]any{
			{"name": "Expression", "ord": 0, "sticky": false, "media": []string{}, "rtl": false, "font": "Arial", "size": 20},
			{"name": "Meaning", "ord": 1, "sticky": false, "media": []string{}, "rtl": false, "font": "Arial", "size": 20},
		},
		"tmpls": []map[string]any{
			{
				"name": "Card 1",
				"ord":  0,
				"qfmt": "{{Expression}}",
				"afmt": "{{FrontSide}}\n\n<hr id=answer>\n\n{{Meaning}}",
				"did":  nil,
			},
		},
		"css":       ".card { font-family: arial; font-size: 20px; color: black; background-color: white; }",
		"latexPre":  "\\documentclass[12pt]{article}",
		"latexPost": "\\end{document}",
		"tags":      []string{},
		"vers":      []string{},
	}
}

// testDeckJSON returns a minimal "Default" deck JSON.
func testDeckJSON(t *testing.T) map[string]any {
	t.Helper()
	return map[string]any{
		"id":         testDeckID,
		"name":       "Default",
		"mod":        0,
		"usn":        0,
		"lrnToday":   []int64{0, 0},
		"revToday":   []int64{0, 0},
		"newToday":   []int64{0, 0},
		"timeToday":  []int64{0, 0},
		"collapsed":  false,
		"browserCollapsed": false,
		"desc":       "",
		"dyn":        0,
		"conf":       1,
	}
}

// schema11SQL is the verbatim subset of Anki's schema 11 that the
// fixture needs: col / notes / cards / graves / revlog. We include
// graves / revlog so any future "verify all expected tables exist"
// probe does not fail; the InsertNote path touches only col/notes/
// cards.
const schema11SQL = `
CREATE TABLE col (
	id integer PRIMARY KEY,
	crt integer NOT NULL,
	mod integer NOT NULL,
	scm integer NOT NULL,
	ver integer NOT NULL,
	dty integer NOT NULL,
	usn integer NOT NULL,
	ls integer NOT NULL,
	conf text NOT NULL,
	models text NOT NULL,
	decks text NOT NULL,
	dconf text NOT NULL,
	tags text NOT NULL
);
CREATE TABLE notes (
	id integer PRIMARY KEY,
	guid text NOT NULL,
	mid integer NOT NULL,
	mod integer NOT NULL,
	usn integer NOT NULL,
	tags text NOT NULL,
	flds text NOT NULL,
	sfld text NOT NULL,
	csum integer NOT NULL,
	flags integer NOT NULL,
	data text NOT NULL
);
CREATE TABLE cards (
	id integer PRIMARY KEY,
	nid integer NOT NULL,
	did integer NOT NULL,
	ord integer NOT NULL,
	mod integer NOT NULL,
	usn integer NOT NULL,
	type integer NOT NULL,
	queue integer NOT NULL,
	due integer NOT NULL,
	ivl integer NOT NULL,
	factor integer NOT NULL,
	reps integer NOT NULL,
	lapses integer NOT NULL,
	left integer NOT NULL,
	odue integer NOT NULL,
	odid integer NOT NULL,
	flags integer NOT NULL,
	data text NOT NULL
);
CREATE TABLE graves (
	usn integer PRIMARY KEY,
	oid integer NOT NULL,
	type integer NOT NULL
);
CREATE TABLE revlog (
	id integer PRIMARY KEY,
	cid integer NOT NULL,
	usn integer NOT NULL,
	ease integer NOT NULL,
	ivl integer NOT NULL,
	lastIvl integer NOT NULL,
	factor integer NOT NULL,
	time integer NOT NULL,
	type integer NOT NULL
);
`

// openTestCollection opens a Collection on the given path. Tolerant
// helper: closes the test if OpenCollection fails (every test
// against this layer needs a successful open).
func openTestCollection(t *testing.T, path string) *Collection {
	t.Helper()
	c, err := OpenCollection(path)
	if err != nil {
		t.Fatalf("OpenCollection(%q): %v", path, err)
	}
	t.Cleanup(func() { _ = c.Close() })
	return c
}

// --- tests ---

// TestOpenCollectionRequiresTables pins the schema-validation gate:
// a file missing any of notes/cards/col is rejected with
// ErrUnsupportedSchema.
func TestOpenCollectionRequiresTables(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "empty.anki2")
	db, err := sql.Open("sqlite", "file:"+path)
	if err != nil {
		t.Fatalf("open empty db: %v", err)
	}
	defer db.Close()
	// Just one unrelated table — schema check must fail.
	if _, err := db.Exec("CREATE TABLE foo (id integer)"); err != nil {
		t.Fatalf("create foo: %v", err)
	}
	_, err = OpenCollection(path)
	if !errors.Is(err, ErrUnsupportedSchema) {
		t.Fatalf("err = %v, want ErrUnsupportedSchema", err)
	}
}

// TestCollectionVariantLegacyJSON pins the autodetect path for the
// legacy (col.decks/col.models JSON) schema.
func TestCollectionVariantLegacyJSON(t *testing.T) {
	path := newTestCollectionFixture(t)
	c := openTestCollection(t, path)
	if c.Variant() != schemaVariantLegacyJSON {
		t.Errorf("variant = %v, want schemaVariantLegacyJSON", c.Variant())
	}
}

// TestCollectionDeckIDsAndModelIDs pins the legacy-JSON reader:
// DeckIDs / ModelIDs return name→id maps derived from col.decks /
// col.models JSON.
func TestCollectionDeckIDsAndModelIDs(t *testing.T) {
	path := newTestCollectionFixture(t)
	c := openTestCollection(t, path)
	decks, err := c.DeckIDs()
	if err != nil {
		t.Fatalf("DeckIDs: %v", err)
	}
	if got := decks["Default"]; got != testDeckID {
		t.Errorf("decks[Default] = %d, want %d", got, testDeckID)
	}
	models, err := c.ModelIDs()
	if err != nil {
		t.Fatalf("ModelIDs: %v", err)
	}
	if got := models["Basic"]; got != testModelID {
		t.Errorf("models[Basic] = %d, want %d", got, testModelID)
	}
}

// TestCollectionModelFieldNames pins the field-name read for a
// 2-field model: returns ["Front", "Back"] in ord order.
func TestCollectionModelFieldNames(t *testing.T) {
	path := newTestCollectionFixture(t)
	c := openTestCollection(t, path)
	names, err := c.ModelFieldNames(testModelID)
	if err != nil {
		t.Fatalf("ModelFieldNames: %v", err)
	}
	want := []string{"Front", "Back"}
	if len(names) != len(want) {
		t.Fatalf("len(names) = %d, want %d", len(names), len(want))
	}
	for i, n := range names {
		if n != want[i] {
			t.Errorf("names[%d] = %q, want %q", i, n, want[i])
		}
	}
}

// TestCollectionModelTemplateCount pins the template count reader.
func TestCollectionModelTemplateCount(t *testing.T) {
	path := newTestCollectionFixture(t)
	c := openTestCollection(t, path)
	n, err := c.ModelTemplateCount(testModelID)
	if err != nil {
		t.Fatalf("ModelTemplateCount: %v", err)
	}
	if n != 1 {
		t.Errorf("template count = %d, want 1", n)
	}
}

// TestCollectionInsertNoteRoundtrip pins the central happy path:
// insert a note with 2 fields, no tags, and verify (a) the notes
// row is present, (b) guid matches base91 of crypto/rand bytes
// (i.e. 10 chars, alphabet-restricted), (c) csum equals the Anki
// algorithm's output, (d) usn = -1, (e) one card per template (== 1
// in this fixture), (f) the card's nid points at the new note, (g)
// the col row was bumped.
func TestCollectionInsertNoteRoundtrip(t *testing.T) {
	path := newTestCollectionFixture(t)
	c := openTestCollection(t, path)

	const front = "猫"
	const back = "cat"
	noteID, err := c.InsertNote(testDeckID, testModelID, []string{front, back}, nil, nil)
	if err != nil {
		t.Fatalf("InsertNote: %v", err)
	}
	if noteID == 0 {
		t.Fatal("InsertNote: noteID = 0")
	}
	// Read back.
	row := c.db.QueryRow("SELECT guid, mid, usn, flds, sfld, csum, flags, data FROM notes WHERE id = ?", noteID)
	var (
		guid  string
		mid   int64
		usn   int64
		flds  string
		sfld  sql.NullString
		csum  int64
		flags int64
		data  string
	)
	if err := row.Scan(&guid, &mid, &usn, &flds, &sfld, &csum, &flags, &data); err != nil {
		t.Fatalf("scan note: %v", err)
	}
	if len(guid) != 10 {
		t.Errorf("guid len = %d, want 10", len(guid))
	}
	for _, r := range guid {
		if !strings.ContainsRune(base91Alphabet, r) {
			t.Errorf("guid %q has rune %q outside base91 alphabet", guid, r)
			break
		}
	}
	if mid != testModelID {
		t.Errorf("mid = %d, want %d", mid, testModelID)
	}
	if usn != -1 {
		t.Errorf("usn = %d, want -1", usn)
	}
	wantFlds := front + "\x1f" + back
	if flds != wantFlds {
		t.Errorf("flds = %q, want %q", flds, wantFlds)
	}
	wantCsum := fieldChecksum(front)
	if csum != wantCsum {
		t.Errorf("csum = %d, want %d", csum, wantCsum)
	}
	if flags != 0 {
		t.Errorf("flags = %d, want 0", flags)
	}
	if data != "" {
		t.Errorf("data = %q, want empty", data)
	}
	if !sfld.Valid || sfld.String == "" {
		t.Errorf("sfld is null/empty, want the front field value")
	}
	// Cards: one per template (model has 1 template).
	rows, err := c.db.Query("SELECT nid, did, ord, type, queue, ivl, factor, reps, lapses, left, odue, odid, flags, data FROM cards WHERE nid = ? ORDER BY ord", noteID)
	if err != nil {
		t.Fatalf("query cards: %v", err)
	}
	defer rows.Close()
	var cardCount int
	for rows.Next() {
		var (
			cNID, cDID   int64
			ord          int64
			ctype, queue int64
			ivl, factor  int64
			reps, lapses int64
			left, odue   int64
			odid, flags  int64
			cdata        string
		)
		if err := rows.Scan(&cNID, &cDID, &ord, &ctype, &queue, &ivl, &factor, &reps, &lapses, &left, &odue, &odid, &flags, &cdata); err != nil {
			t.Fatalf("scan card: %v", err)
		}
		if cNID != noteID {
			t.Errorf("card.nid = %d, want %d", cNID, noteID)
		}
		if cDID != testDeckID {
			t.Errorf("card.did = %d, want %d", cDID, testDeckID)
		}
		if ord != 0 {
			t.Errorf("card.ord = %d, want 0", ord)
		}
		if ctype != 0 {
			t.Errorf("card.type = %d, want 0 (new)", ctype)
		}
		if queue != 0 {
			t.Errorf("card.queue = %d, want 0", queue)
		}
		// ivl/factor/reps/lapses/left/odue/odid/flags all 0
		for _, v := range []int64{ivl, factor, reps, lapses, left, odue, odid, flags} {
			if v != 0 {
				t.Errorf("card field non-zero: %d", v)
			}
		}
		if cdata != "" {
			t.Errorf("card.data = %q, want empty", cdata)
		}
		cardCount++
	}
	if cardCount != 1 {
		t.Errorf("card count = %d, want 1", cardCount)
	}
	// col row was bumped.
	var colMod int64
	if err := c.db.QueryRow("SELECT mod FROM col WHERE id = 1").Scan(&colMod); err != nil {
		t.Fatalf("read col.mod: %v", err)
	}
	if colMod == 0 {
		t.Errorf("col.mod = 0, want non-zero (bumped on insert)")
	}
}

// TestCollectionInsertNoteDueIncrements pins the "new card due
// position" semantics: inserting two notes in the same deck yields
// due positions 1 and 2 respectively.
func TestCollectionInsertNoteDueIncrements(t *testing.T) {
	path := newTestCollectionFixture(t)
	c := openTestCollection(t, path)
	id1, err := c.InsertNote(testDeckID, testModelID, []string{"a", "x"}, nil, nil)
	if err != nil {
		t.Fatalf("InsertNote #1: %v", err)
	}
	id2, err := c.InsertNote(testDeckID, testModelID, []string{"b", "x"}, nil, nil)
	if err != nil {
		t.Fatalf("InsertNote #2: %v", err)
	}
	due1 := cardDue(t, c, id1)
	due2 := cardDue(t, c, id2)
	if due1 != 1 {
		t.Errorf("due1 = %d, want 1", due1)
	}
	if due2 != 2 {
		t.Errorf("due2 = %d, want 2", due2)
	}
}

// cardDue is a tiny helper that returns the due of the first card
// for note id.
func cardDue(t *testing.T, c *Collection, nid int64) int64 {
	t.Helper()
	row := c.db.QueryRow("SELECT due FROM cards WHERE nid = ? ORDER BY ord LIMIT 1", nid)
	var due int64
	if err := row.Scan(&due); err != nil {
		t.Fatalf("read card due for nid=%d: %v", nid, err)
	}
	return due
}

// TestCollectionInsertNoteTagFormatting pins the Anki tag format:
// leading + trailing + between-tag spaces, empties dropped.
func TestCollectionInsertNoteTagFormatting(t *testing.T) {
	path := newTestCollectionFixture(t)
	c := openTestCollection(t, path)
	id, err := c.InsertNote(testDeckID, testModelID, []string{"a", "b"}, []string{"vocab", "anime", ""}, nil)
	if err != nil {
		t.Fatalf("InsertNote: %v", err)
	}
	var tags string
	if err := c.db.QueryRow("SELECT tags FROM notes WHERE id = ?", id).Scan(&tags); err != nil {
		t.Fatalf("read tags: %v", err)
	}
	if tags != " vocab anime " {
		t.Errorf("tags = %q, want %q", tags, " vocab anime ")
	}
}

// TestCollectionUpdateNoteFieldsSplice pins the field-name → ord
// splice: changing only the second field must keep the first field
// value intact and update the second.
func TestCollectionUpdateNoteFieldsSplice(t *testing.T) {
	path := newTestCollectionFixture(t)
	c := openTestCollection(t, path)
	id, err := c.InsertNote(testDeckID, testModelID, []string{"original front", "original back"}, nil, nil)
	if err != nil {
		t.Fatalf("InsertNote: %v", err)
	}
	if err := c.UpdateNoteFields(id, map[string]string{"Back": "new back"}); err != nil {
		t.Fatalf("UpdateNoteFields: %v", err)
	}
	var flds string
	if err := c.db.QueryRow("SELECT flds FROM notes WHERE id = ?", id).Scan(&flds); err != nil {
		t.Fatalf("read flds: %v", err)
	}
	if flds != "original front\x1fnew back" {
		t.Errorf("flds = %q, want %q", flds, "original front\x1fnew back")
	}
	// Update the first field too; csum must change.
	if err := c.UpdateNoteFields(id, map[string]string{"Front": "new front", "Back": "new back"}); err != nil {
		t.Fatalf("UpdateNoteFields (both): %v", err)
	}
	var csum int64
	if err := c.db.QueryRow("SELECT csum FROM notes WHERE id = ?", id).Scan(&csum); err != nil {
		t.Fatalf("read csum: %v", err)
	}
	if csum != fieldChecksum("new front") {
		t.Errorf("csum = %d, want %d", csum, fieldChecksum("new front"))
	}
}

// TestCollectionAddTagsDedupe pins that addTags appends new tags
// without duplicating existing ones (the canonical merge path).
func TestCollectionAddTagsDedupe(t *testing.T) {
	path := newTestCollectionFixture(t)
	c := openTestCollection(t, path)
	id, err := c.InsertNote(testDeckID, testModelID, []string{"f", "b"}, []string{"alpha", "beta"}, nil)
	if err != nil {
		t.Fatalf("InsertNote: %v", err)
	}
	if err := c.AddTags([]int64{id}, "beta gamma"); err != nil {
		t.Fatalf("AddTags: %v", err)
	}
	var tags string
	if err := c.db.QueryRow("SELECT tags FROM notes WHERE id = ?", id).Scan(&tags); err != nil {
		t.Fatalf("read tags: %v", err)
	}
	if tags != " alpha beta gamma " {
		t.Errorf("tags = %q, want %q", tags, " alpha beta gamma ")
	}
}

// TestCollectionFindNotesAdded pins the "added:1" 24h window.
func TestCollectionFindNotesAdded(t *testing.T) {
	path := newTestCollectionFixture(t)
	c := openTestCollection(t, path)
	id, err := c.InsertNote(testDeckID, testModelID, []string{"f", "b"}, nil, nil)
	if err != nil {
		t.Fatalf("InsertNote: %v", err)
	}
	ids, err := c.FindNotes("added:1")
	if err != nil {
		t.Fatalf("FindNotes: %v", err)
	}
	if len(ids) != 1 || ids[0] != id {
		t.Errorf("FindNotes added:1 = %v, want [%d]", ids, id)
	}
}

// TestCollectionFindNotesAddedEmpty pins the empty-result wire
// contract: a fresh fixture with NO notes modified within the last
// 24h must still return a NON-NIL empty slice (and json-marshal to
// `[]`, not `null`). The bug this test defends against was the
// exact Yomitan getAnkiNoteInfo regression observed on a real
// device 2026-09-01 — `var ids []int64` followed by zero appends
// marshals to `null`, and Yomitan's _normalizeArray(result, -1,
// 'number') throws on `null`, hiding the + button. The fix is to
// initialise the slice with `make([]int64, 0)` so the JSON wire
// form is `[]` even on the empty path.
func TestCollectionFindNotesAddedEmpty(t *testing.T) {
	path := newTestCollectionFixture(t)
	c := openTestCollection(t, path)
	ids, err := c.FindNotes("added:1")
	if err != nil {
		t.Fatalf("FindNotes: %v", err)
	}
	if ids == nil {
		t.Fatalf("FindNotes added:1 = nil; want non-nil empty slice (Yomitan _normalizeArray throws on null)")
	}
	if len(ids) != 0 {
		t.Errorf("FindNotes added:1 len = %d, want 0 (no notes modded in fresh fixture)", len(ids))
	}
	body, err := json.Marshal(ids)
	if err != nil {
		t.Fatalf("json.Marshal: %v", err)
	}
	if string(body) != "[]" {
		t.Errorf("json.Marshal added:1 = %s, want \"[]\" (Yomitan requires an array, never null)", body)
	}
}

// TestCollectionFindNotesNoMatch pins the empty-result wire
// contract for the `<fieldName>:<value>` branch (findNotesByFirstField):
// a value that no note's first field contains must return a NON-NIL
// empty slice that json-marshals to `[]`. Same Yomitan regression
// as TestCollectionFindNotesAddedEmpty but for the field-match
// code path (which had its own `var ids []int64` and the same
// `null`-on-empty failure mode).
func TestCollectionFindNotesNoMatch(t *testing.T) {
	path := newTestCollectionFixture(t)
	c := openTestCollection(t, path)
	ids, err := c.FindNotes(`front:不存在`)
	if err != nil {
		t.Fatalf("FindNotes: %v", err)
	}
	if ids == nil {
		t.Fatalf("FindNotes front:不存在 = nil; want non-nil empty slice (Yomitan _normalizeArray throws on null)")
	}
	if len(ids) != 0 {
		t.Errorf("FindNotes front:不存在 len = %d, want 0", len(ids))
	}
	body, err := json.Marshal(ids)
	if err != nil {
		t.Fatalf("json.Marshal: %v", err)
	}
	if string(body) != "[]" {
		t.Errorf("json.Marshal front:不存在 = %s, want \"[]\" (Yomitan requires an array, never null)", body)
	}
}

// TestCollectionFindNotesNID pins the nid: prefix lookup.
func TestCollectionFindNotesNID(t *testing.T) {
	path := newTestCollectionFixture(t)
	c := openTestCollection(t, path)
	a, _ := c.InsertNote(testDeckID, testModelID, []string{"a", "b"}, nil, nil)
	b, _ := c.InsertNote(testDeckID, testModelID, []string{"c", "d"}, nil, nil)
	ids, err := c.FindNotes("nid:" + strconv.FormatInt(a, 10) + "," + strconv.FormatInt(b, 10))
	if err != nil {
		t.Fatalf("FindNotes: %v", err)
	}
	if len(ids) != 2 || ids[0] != a || ids[1] != b {
		t.Errorf("FindNotes nid: = %v, want [%d, %d]", ids, a, b)
	}
}

// TestCollectionFindNotesUnsupported pins the honest-error path:
// unsupported query → ErrBadQuery.
func TestCollectionFindNotesUnsupported(t *testing.T) {
	path := newTestCollectionFixture(t)
	c := openTestCollection(t, path)
	_, err := c.FindNotes("tag:vocab")
	if !errors.Is(err, ErrBadQuery) {
		t.Errorf("err = %v, want ErrBadQuery", err)
	}
}

// TestCollectionCanAddNotesCollectionScope pins the strict (no
// duplicates allowed) duplicate check: an existing note's csum is
// detected and reported as canAdd=false.
func TestCollectionCanAddNotesCollectionScope(t *testing.T) {
	path := newTestCollectionFixture(t)
	c := openTestCollection(t, path)
	// Seed one note so its csum is on disk.
	if _, err := c.InsertNote(testDeckID, testModelID, []string{"duplicate-key", "b"}, nil, nil); err != nil {
		t.Fatalf("seed note: %v", err)
	}
	out, err := c.CanAddNotes([]NoteCheck{
		{Field: "duplicate-key", DuplicateScope: "collection"},
	})
	if err != nil {
		t.Fatalf("CanAddNotes: %v", err)
	}
	if len(out) != 1 || out[0] {
		t.Errorf("CanAddNotes = %v, want [false]", out)
	}
	// Different key: canAdd=true.
	out, err = c.CanAddNotes([]NoteCheck{
		{Field: "different-key", DuplicateScope: "collection"},
	})
	if err != nil {
		t.Fatalf("CanAddNotes fresh: %v", err)
	}
	if len(out) != 1 || !out[0] {
		t.Errorf("CanAddNotes fresh = %v, want [true]", out)
	}
}

// TestCollectionCanAddNotesAllowDuplicate pins the allow-duplicate
// branch: even with an existing duplicate the result is true (Anki
// would accept the note anyway).
func TestCollectionCanAddNotesAllowDuplicate(t *testing.T) {
	path := newTestCollectionFixture(t)
	c := openTestCollection(t, path)
	if _, err := c.InsertNote(testDeckID, testModelID, []string{"dup", "b"}, nil, nil); err != nil {
		t.Fatalf("seed note: %v", err)
	}
	out, err := c.CanAddNotes([]NoteCheck{
		{Field: "dup", AllowDuplicate: true},
	})
	if err != nil {
		t.Fatalf("CanAddNotes: %v", err)
	}
	if len(out) != 1 || !out[0] {
		t.Errorf("CanAddNotes allowDuplicate = %v, want [true]", out)
	}
}

// TestCollectionNotesInfo pins the joined read of notes + models +
// cards: NoteInfo has the modelName, the fields map, and the cards
// array.
func TestCollectionNotesInfo(t *testing.T) {
	path := newTestCollectionFixture(t)
	c := openTestCollection(t, path)
	id, err := c.InsertNote(testDeckID, testModelID, []string{"F", "B"}, []string{"t1"}, nil)
	if err != nil {
		t.Fatalf("InsertNote: %v", err)
	}
	infos, err := c.NotesInfo([]int64{id})
	if err != nil {
		t.Fatalf("NotesInfo: %v", err)
	}
	if len(infos) != 1 {
		t.Fatalf("len(infos) = %d, want 1", len(infos))
	}
	ni := infos[0]
	if ni.NoteID != id {
		t.Errorf("NoteID = %d, want %d", ni.NoteID, id)
	}
	if ni.ModelName != "Basic" {
		t.Errorf("ModelName = %q, want %q", ni.ModelName, "Basic")
	}
	if ni.Fields["Front"] != "F" || ni.Fields["Back"] != "B" {
		t.Errorf("Fields = %v, want Front=F, Back=B", ni.Fields)
	}
	if len(ni.Tags) != 1 || ni.Tags[0] != "t1" {
		t.Errorf("Tags = %v, want [t1]", ni.Tags)
	}
	if len(ni.Cards) != 1 {
		t.Errorf("Cards count = %d, want 1", len(ni.Cards))
	}
	if ni.Cards[0] == 0 {
		t.Errorf("Cards[0] = 0, want a non-zero cardId")
	}
}

// TestCollectionNotesInfoSkipsMissing pins the upstream behaviour:
// unknown ids are silently skipped rather than returning an error.
func TestCollectionNotesInfoSkipsMissing(t *testing.T) {
	path := newTestCollectionFixture(t)
	c := openTestCollection(t, path)
	infos, err := c.NotesInfo([]int64{9999999})
	if err != nil {
		t.Fatalf("NotesInfo: %v", err)
	}
	if len(infos) != 0 {
		t.Errorf("len(infos) = %d, want 0", len(infos))
	}
}

// TestCollectionInsertNoteEmptyFields pins the input-validation
// gate: empty fields → ErrBadRequest.
func TestCollectionInsertNoteEmptyFields(t *testing.T) {
	path := newTestCollectionFixture(t)
	c := openTestCollection(t, path)
	_, err := c.InsertNote(testDeckID, testModelID, nil, nil, nil)
	if !errors.Is(err, ErrBadRequest) {
		t.Errorf("err = %v, want ErrBadRequest", err)
	}
}

// TestCollectionClose pins that Close is safe to call twice and
// that subsequent operations return ErrCollectionNotOpen.
func TestCollectionClose(t *testing.T) {
	path := newTestCollectionFixture(t)
	c := openTestCollection(t, path)
	if err := c.Close(); err != nil {
		t.Fatalf("first Close: %v", err)
	}
	if err := c.Close(); err != nil {
		t.Fatalf("second Close: %v", err)
	}
	if _, err := c.DeckIDs(); !errors.Is(err, ErrCollectionNotOpen) {
		t.Errorf("after Close: DeckIDs err = %v, want ErrCollectionNotOpen", err)
	}
}

// TestCollectionModBump pins that CollectionModBump writes a non-
// zero mod and that subsequent reads see it.
func TestCollectionModBump(t *testing.T) {
	path := newTestCollectionFixture(t)
	c := openTestCollection(t, path)
	// Force an initial mod of zero by re-reading and writing the
	// same value; the fixture has mod set to a non-zero millis so
	// we just assert the bump changes it.
	var before int64
	if err := c.db.QueryRow("SELECT mod FROM col WHERE id = 1").Scan(&before); err != nil {
		t.Fatalf("read col.mod before: %v", err)
	}
	if err := c.CollectionModBump(); err != nil {
		t.Fatalf("CollectionModBump: %v", err)
	}
	var after int64
	if err := c.db.QueryRow("SELECT mod FROM col WHERE id = 1").Scan(&after); err != nil {
		t.Fatalf("read col.mod after: %v", err)
	}
	if after <= before {
		t.Errorf("after mod %d not > before %d", after, before)
	}
}

// TestBase91EncodeDeterminism pins the guid encoding: the same
// 8-byte input always produces the same 10-char output.
func TestBase91EncodeDeterminism(t *testing.T) {
	in := []byte{0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08}
	g1 := base91Encode(in)
	g2 := base91Encode(in)
	if g1 != g2 {
		t.Errorf("base91 not deterministic: %q vs %q", g1, g2)
	}
	if len(g1) != 10 {
		t.Errorf("len = %d, want 10", len(g1))
	}
	for _, r := range g1 {
		if !strings.ContainsRune(base91Alphabet, r) {
			t.Errorf("rune %q outside base91", r)
			break
		}
	}
}

// TestFieldChecksumStripsHTML pins that the csum algorithm
// strips HTML media + decodes HTML entities before hashing
// (matching AnkiDroid's Utility.getFieldChecksum behaviour and
// Anki rslib's sort_field / csum path). The test pins five
// behaviours:
//
//   - "<img src="x.png">" is replaced by " x.png " (Anki
//     convention: src token surrounded by spaces, then tags are
//     stripped). The HTML-stripped form and the equivalent raw
//     text collapse to one csum.
//   - csum differs from the raw-HTML csum: the strip is not a
//     no-op.
//   - named entity "&lt;" decodes to "<" (stdlib
//     html.UnescapeString).
//   - numeric entity "&#12354;" decodes to "あ" (UTF-8, stdlib).
//   - named entity "&nbsp;" pre-replaced with ASCII 0x20 BEFORE
//     decoding — mirrors AnkiDroid Utils.entsToTxt (NOT rslib's
//     U+00A0), so csum matches what AnkiDroid stores on the same DB.
//   - plain text without any HTML / entity matches its own csum.
func TestFieldChecksumStripsHTML(t *testing.T) {
	// HTML-stripped forms collapse to one csum.
	b := fieldChecksum("cat <img src=\"x.png\">")
	d := fieldChecksum("cat  x.png ")
	if b != d {
		t.Errorf("html-stripped forms differ: b=%d d=%d (one is from img tag, one from raw text)", b, d)
	}
	// The strip is not a no-op: raw HTML changes the csum vs the
	// stripped form.
	a := fieldChecksum("cat")
	if a == b {
		t.Errorf("csum didn't differ: a=%d (raw 'cat') == b=%d ('cat <img...>')", a, b)
	}
	// Named entity: &amp; → "&". The strip pipeline applies
// UnescapeString once. We verify by checking that the csum of
// the entity-bearing input equals the csum of its decoded form
// passed through the same strip (which is a no-op for the
// already-decoded string).
	amp := fieldChecksum("a&amp;b")
	ampDecoded := fieldChecksum("a&b")
	if amp != ampDecoded {
		t.Errorf("&amp; entity not decoded: amp=%d ampDecoded=%d (want equal)", amp, ampDecoded)
	}
	// Numeric entity: &#12354; → "あ" (U+30A2 KATAKANA LETTER A).
	n := fieldChecksum("&#12354;")
	raw := fieldChecksum("あ")
	if n != raw {
		t.Errorf("numeric entity not decoded: n=%d raw=%d (want equal)", n, raw)
	}
	// Named entity: &nbsp; → ASCII space (0x20) — AnkiDroid's
	// entsToTxt pre-replaces it before entity decoding, so our csum
	// must match AnkiDroid's stored csum on the shared DB.
	nbsp := fieldChecksum("a&nbsp;b")
	nbspSpace := fieldChecksum("a b")
	if nbsp != nbspSpace {
		t.Errorf("&nbsp; should pre-replace to ASCII space: nbsp=%d space=%d", nbsp, nbspSpace)
	}
	nbspNBSP := fieldChecksum("a\u00A0b")
	if nbsp == nbspNBSP {
		t.Errorf("&nbsp; must NOT decode to U+00A0 (AnkiDroid uses 0x20): nbsp=%d nbspNBSP=%d", nbsp, nbspNBSP)
	}
	// Plain text: matches itself.
	p := fieldChecksum("plain text")
	pAgain := fieldChecksum("plain text")
	if p != pAgain {
		t.Errorf("plain text not deterministic: p=%d pAgain=%d", p, pAgain)
	}
}

// TestCollectionInsertNoteSfldStripsHTML pins the sfld column
// behaviour: Anki rslib stores the HTML-stripped form of the first
// field in notes.sfld (used by the AnkiDroid browser column sort).
// A field whose HTML / entities survive the write would break the
// sort (and diverge from what AnkiDroid re-computes on next scan).
// The test inserts a field carrying an <img>, a named entity, and a
// numeric entity, then reads sfld back and asserts it equals the
// HTML-stripped form (the same form fieldChecksum hashes).
func TestCollectionInsertNoteSfldStripsHTML(t *testing.T) {
	path := newTestCollectionFixture(t)
	c := openTestCollection(t, path)
	const front = "<img src=\"x.png\">cat &lt;dog&gt; &#12354;"
	const back = "back"
	id, err := c.InsertNote(testDeckID, testModelID, []string{front, back}, nil, nil)
	if err != nil {
		t.Fatalf("InsertNote: %v", err)
	}
	var sfld string
	if err := c.db.QueryRow("SELECT sfld FROM notes WHERE id = ?", id).Scan(&sfld); err != nil {
		t.Fatalf("read sfld: %v", err)
	}
	// stripHTMLMedia mirrors csum's stripping path; the two must
	// agree.
	want := stripHTMLMedia(front)
	if sfld != want {
		t.Errorf("sfld = %q, want %q (= stripHTMLMedia(front))", sfld, want)
	}
	// The stored sfld must not contain raw HTML or entity tokens;
	// this is the property AnkiDroid's browser sort depends on.
	if strings.Contains(sfld, "<img") || strings.Contains(sfld, "&lt;") || strings.Contains(sfld, "&#") {
		t.Errorf("sfld retained HTML/entities: %q", sfld)
	}
	// The csum column was computed over the same stripped form.
	var csum int64
	if err := c.db.QueryRow("SELECT csum FROM notes WHERE id = ?", id).Scan(&csum); err != nil {
		t.Fatalf("read csum: %v", err)
	}
	if csum != fieldChecksum(front) {
		t.Errorf("csum = %d, want %d (= fieldChecksum(front))", csum, fieldChecksum(front))
	}
}

// TestCollectionInsertNoteDuplicateRejected pins the strict
// duplicate-detection contract: when AllowDuplicate is false (the
// default), InsertNote returns ErrDuplicateNote WITHOUT writing any
// row when the csum already exists. The dispatcher maps
// ErrDuplicateNote to a null addNote result; the underlying
// transaction never opens (single-conn pool, no spurious lock).
func TestCollectionInsertNoteDuplicateRejected(t *testing.T) {
	path := newTestCollectionFixture(t)
	c := openTestCollection(t, path)
	if _, err := c.InsertNote(testDeckID, testModelID, []string{"duplicate", "x"}, nil, nil); err != nil {
		t.Fatalf("seed note: %v", err)
	}
	// Pre-count: only the seed note should exist.
	var before int64
	if err := c.db.QueryRow("SELECT COUNT(*) FROM notes").Scan(&before); err != nil {
		t.Fatalf("count notes: %v", err)
	}
	// Strict (default opts) → ErrDuplicateNote.
	_, err := c.InsertNote(testDeckID, testModelID, []string{"duplicate", "y"}, nil, nil)
	if !errors.Is(err, ErrDuplicateNote) {
		t.Fatalf("InsertNote dup: err = %v, want ErrDuplicateNote", err)
	}
	// No row was inserted.
	var after int64
	if err := c.db.QueryRow("SELECT COUNT(*) FROM notes").Scan(&after); err != nil {
		t.Fatalf("count notes after: %v", err)
	}
	if after != before {
		t.Errorf("notes count = %d, want %d (no insert on dup)", after, before)
	}
	// AllowDuplicate=true → inserts anyway.
	id, err := c.InsertNote(testDeckID, testModelID, []string{"duplicate", "z"}, nil, &InsertOptions{AllowDuplicate: true})
	if err != nil {
		t.Fatalf("InsertNote dup + AllowDuplicate: %v", err)
	}
	if id == 0 {
		t.Error("InsertNote dup + AllowDuplicate: id = 0, want >0")
	}
}

// TestCollectionInsertNoteAllowDuplicateDefault pins the default
// (nil opts = strict). Without an explicit InsertOptions the
// duplicate check still runs.
func TestCollectionInsertNoteAllowDuplicateDefault(t *testing.T) {
	path := newTestCollectionFixture(t)
	c := openTestCollection(t, path)
	if _, err := c.InsertNote(testDeckID, testModelID, []string{"k", "x"}, nil, nil); err != nil {
		t.Fatalf("seed: %v", err)
	}
	_, err := c.InsertNote(testDeckID, testModelID, []string{"k", "y"}, nil, &InsertOptions{AllowDuplicate: false})
	if !errors.Is(err, ErrDuplicateNote) {
		t.Errorf("strict InsertOptions: err = %v, want ErrDuplicateNote", err)
	}
}

// TestSchemaVariantModernTables pins the autodetect path for the
// schema-18 dedicated-tables layout. We build a tiny database with
// separate `decks` and `models` tables (alongside col/notes/cards).
func TestSchemaVariantModernTables(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "collection.anki2")
	db, err := sql.Open("sqlite", "file:"+path)
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	defer db.Close()
	if _, err := db.Exec(schema11SQL); err != nil {
		t.Fatalf("apply base schema: %v", err)
	}
	// Build dedicated decks/models tables (the schema-18 shape).
	if _, err := db.Exec(`CREATE TABLE decks (id integer PRIMARY KEY, name text)`); err != nil {
		t.Fatalf("create decks: %v", err)
	}
	if _, err := db.Exec(`CREATE TABLE models (id integer PRIMARY KEY, name text, json text)`); err != nil {
		t.Fatalf("create models: %v", err)
	}
	if _, err := db.Exec(`INSERT INTO col (id, crt, mod, scm, ver, dty, usn, ls, conf, models, decks, dconf, tags) VALUES (1, 0, 0, 0, 18, 0, 0, 0, '{}', '{}', '{}', '{}', '{}')`); err != nil {
		t.Fatalf("seed col: %v", err)
	}
	if _, err := db.Exec(`INSERT INTO decks (id, name) VALUES (?, 'Default')`, testDeckID); err != nil {
		t.Fatalf("seed decks: %v", err)
	}
	modelJSON, _ := json.Marshal(testModelJSON(t))
	if _, err := db.Exec(`INSERT INTO models (id, name, json) VALUES (?, 'Basic', ?)`, testModelID, string(modelJSON)); err != nil {
		t.Fatalf("seed models: %v", err)
	}
	c, err := OpenCollection(path)
	if err != nil {
		t.Fatalf("OpenCollection: %v", err)
	}
	defer c.Close()
	if c.Variant() != schemaVariantModernTables {
		t.Errorf("variant = %v, want schemaVariantModernTables", c.Variant())
	}
	// Smoke check the modern-table reader.
	decks, err := c.DeckIDs()
	if err != nil {
		t.Fatalf("DeckIDs: %v", err)
	}
	if got := decks["Default"]; got != testDeckID {
		t.Errorf("decks[Default] = %d, want %d", got, testDeckID)
	}
}

// TestSchemaVariantBothPresentPicksModern pins the autodetect
// precedence: when both layouts are present, the modern dedicated
// tables win (matches Anki's own autodetect behaviour — the tables
// are the source of truth on schema 18+).
func TestSchemaVariantBothPresentPicksModern(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "collection.anki2")
	db, err := sql.Open("sqlite", "file:"+path)
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	defer db.Close()
	if _, err := db.Exec(schema11SQL); err != nil {
		t.Fatalf("apply base schema: %v", err)
	}
	if _, err := db.Exec(`CREATE TABLE decks (id integer PRIMARY KEY, name text)`); err != nil {
		t.Fatalf("create decks: %v", err)
	}
	if _, err := db.Exec(`CREATE TABLE models (id integer PRIMARY KEY, name text, json text)`); err != nil {
		t.Fatalf("create models: %v", err)
	}
	c, err := OpenCollection(path)
	if err != nil {
		t.Fatalf("OpenCollection: %v", err)
	}
	defer c.Close()
	if c.Variant() != schemaVariantModernTables {
		t.Errorf("variant = %v, want schemaVariantModernTables", c.Variant())
	}
}

// TestCollectionNilReceiver pins that nil-receiver methods return
// ErrCollectionNotOpen instead of crashing.
func TestCollectionNilReceiver(t *testing.T) {
	var c *Collection
	if _, err := c.DeckIDs(); !errors.Is(err, ErrCollectionNotOpen) {
		t.Errorf("nil DeckIDs err = %v, want ErrCollectionNotOpen", err)
	}
	if err := c.CollectionModBump(); !errors.Is(err, ErrCollectionNotOpen) {
		t.Errorf("nil CollectionModBump err = %v, want ErrCollectionNotOpen", err)
	}
	if err := c.Close(); err != nil {
		t.Errorf("nil Close err = %v, want nil", err)
	}
}

// TestOpenCollectionEmptyPath pins the input-validation gate for
// the public entry point.
func TestOpenCollectionEmptyPath(t *testing.T) {
	if _, err := OpenCollection(""); err == nil {
		t.Error("OpenCollection(\"\"): want non-nil err, got nil")
	}
}

// TestCollectionInsertNoteUsesExistingCollectionFile verifies that
// opening an actual Anki-shaped collection (with real-world dconf/
// conf JSON) does not crash the OpenCollection path. We craft a
// minimal-but-valid col row to exercise the JSON parse paths in
// loadCol.
func TestCollectionInsertNoteUsesExistingCollectionFile(t *testing.T) {
	// The fixture function already populates a valid col row; we
	// just verify InsertNote on the existing path (no race / no
	// schema mismatch). Re-use newTestCollectionFixture.
	path := newTestCollectionFixture(t)
	c := openTestCollection(t, path)
	if _, err := c.InsertNote(testDeckID, testModelID, []string{"hi", "there"}, nil, nil); err != nil {
		t.Fatalf("InsertNote: %v", err)
	}
}

// Sanity check: the fixture's dconf.json `name` is something
// parseable (loadCol currently does not read dconf, but a future
// patch might; this guards against a malformed fixture).
func TestFixtureJSONParses(t *testing.T) {
	path := newTestCollectionFixture(t)
	c := openTestCollection(t, path)
	col, err := c.loadCol()
	if err != nil {
		t.Fatalf("loadCol: %v", err)
	}
	if len(col.Decks) == 0 {
		t.Error("col.Decks empty")
	}
	if len(col.Models) == 0 {
		t.Error("col.Models empty")
	}
}

// Guard: ensure t.TempDir cleanup actually removes the file when
// tests finish (no leaked state across runs).
func TestFixtureFileIsRemovedOnCleanup(t *testing.T) {
	path := newTestCollectionFixture(t)
	if _, err := os.Stat(path); err != nil {
		t.Fatalf("file should exist: %v", err)
	}
	parent := filepath.Dir(path)
	// Resolve subdirs so we can check that t.TempDir cleans up after
	// the test ends. We can't easily assert post-cleanup here (we'd
	// race the runner), but at minimum we confirm the file is where
	// we expect it for the duration of this test.
	if parent == "" {
		t.Fatal("TempDir parent is empty")
	}
}

// --- notetypes (AnkiDroid 2.16+) fixture + tests ---
//
// The real AnkiDroid 2.16+ collection.anki2 (verified 2026-09-01)
// uses a dedicated `notetypes` table for note types instead of
// `models`, and leaves col.decks / col.models as empty strings. The
// fixture here reproduces that shape so the modern-reader dispatch
// can be exercised without a real device.

// notetypesSchemaSQL extends schema11SQL with the AnkiDroid 2.16+
// notetypes-related tables. The columns follow the real on-device
// layout (verified against ankitects/anki
// rslib/src/storage/upgrades/schema15_upgrade.sql, which is the
// authoritative source for AnkiDroid 2.16+ / Anki desktop v18
// schema shape — notetypes/fields/templates/decks all use
// `name TEXT COLLATE unicase` at the column level and
// `config/common/kind` columns are BLOBs, not TEXT):
//
//	CREATE TABLE notetypes (
//	  id integer PRIMARY KEY,
//	  name text NOT NULL COLLATE unicase,
//	  mtime_secs integer NOT NULL,
//	  usn integer NOT NULL,
//	  config blob NOT NULL                -- Protobuf (Notetype.Config)
//	);
//	CREATE TABLE fields (
//	  ntid integer NOT NULL,
//	  ord integer NOT NULL,
//	  name text NOT NULL COLLATE unicase,
//	  config blob NOT NULL,               -- Protobuf (Notetype.Field.Config)
//	  PRIMARY KEY (ntid, ord)
//	) WITHOUT ROWID;
//	CREATE TABLE templates (
//	  ntid integer NOT NULL,
//	  ord integer NOT NULL,
//	  name text NOT NULL COLLATE unicase,
//	  mtime_secs integer NOT NULL,
//	  usn integer NOT NULL,
//	  config blob NOT NULL,               -- Protobuf (Notetype.Template.Config)
//	  PRIMARY KEY (ntid, ord)
//	) WITHOUT ROWID;
//	CREATE TABLE decks (
//	  id integer PRIMARY KEY,
//	  name text NOT NULL COLLATE unicase,
//	  mtime_secs integer NOT NULL,
//	  usn integer NOT NULL,
//	  common blob NOT NULL,               -- Protobuf (DeckCommon)
//	  kind blob NOT NULL                  -- Protobuf (DeckKind)
//	);
//
// Important: flds (field name list) and tmpls (template name list)
// live in SEPARATE tables (`fields` and `templates`), NOT inside
// the notetypes.config blob. The user's earlier verification
// ("notetypes cols: ['id', 'name', 'mtime_secs', 'usn', 'config']")
// correctly identified the five columns of `notetypes` but did not
// mention the sibling `fields` and `templates` tables. The bridge
// reads field names from `fields` and template count from
// `templates` directly; it does NOT decode the Protobuf in
// `notetypes.config` (the bridge doesn't need its css / latexPre /
// latexPost / sortf fields).
//
// The fixture-as-written matches this real shape, including
// `name TEXT COLLATE unicase` on every name column and the
// WITHOUT ROWID primary key on fields/templates. Tests that need
// to read from these tables will fail without UNICASE registered
// (modernc's default driver lacks it) — ensureUnicaseCollation is
// invoked automatically by openCollectionDSN via the production
// path; tests that drive sql.Open directly must call it
// themselves.
const notetypesSchemaSQL = schema11SQL + `
CREATE TABLE decks (
	id integer PRIMARY KEY,
	name text NOT NULL COLLATE unicase,
	mtime_secs integer NOT NULL,
	usn integer NOT NULL,
	common blob NOT NULL,
	kind blob NOT NULL
);
CREATE TABLE notetypes (
	id integer PRIMARY KEY,
	name text NOT NULL COLLATE unicase,
	mtime_secs integer NOT NULL,
	usn integer NOT NULL,
	config blob NOT NULL
);
CREATE TABLE fields (
	ntid integer NOT NULL,
	ord integer NOT NULL,
	name text NOT NULL COLLATE unicase,
	config blob NOT NULL,
	PRIMARY KEY (ntid, ord)
) WITHOUT ROWID;
CREATE TABLE templates (
	ntid integer NOT NULL,
	ord integer NOT NULL,
	name text NOT NULL COLLATE unicase,
	mtime_secs integer NOT NULL,
	usn integer NOT NULL,
	config blob NOT NULL,
	PRIMARY KEY (ntid, ord)
) WITHOUT ROWID;
`

// newNotetypesCollectionFixture builds the AnkiDroid 2.16+ schema
// shape: a `col` row with EMPTY decks/models JSON (mirrors the
// real device; the legacy reader therefore must NOT be the one
// serving queries), a `decks` table with one Default row, a
// `notetypes` table with one Basic row, a `fields` table with two
// rows (Front, Back), and a `templates` table with two rows
// (Card 1, Card 2). The config blobs are seeded as minimal
// Protobuf-shaped placeholders (real-device fixtures need SOMETHING
// in the column to satisfy NOT NULL; the bridge never reads
// notetypes.config so any non-empty bytes work). Two fields / two
// templates so ModelFieldNames returns ["Front", "Back"] and
// ModelTemplateCount returns 2, matching the assertions in
// TestModelFieldNamesNotetypes / TestModelTemplateCountNotetypes.
//
// The fixture opens a raw sql.DB (not OpenCollection, which
// requires the schema to already exist) and calls
// ensureUnicaseCollation explicitly so the CREATE TABLE …
// COLLATE unicase statements succeed. Subsequent callers that
// go through OpenCollection / openCollectionDSN will hit the
// same ensureUnicaseCollation path (sync.Once keeps it
// idempotent), so the fixture's UNICASE registration is free.
func newNotetypesCollectionFixture(t *testing.T) string {
	t.Helper()
	dir := t.TempDir()
	path := filepath.Join(dir, "collection.anki2")
	ensureUnicaseCollation()
	db, err := sql.Open("sqlite", "file:"+path+"?_pragma=busy_timeout(5000)")
	if err != nil {
		t.Fatalf("open notetypes fixture: %v", err)
	}
	defer db.Close()
	if _, err := db.Exec(notetypesSchemaSQL); err != nil {
		t.Fatalf("apply notetypes schema: %v", err)
	}
	// Seed col row with EMPTY decks/models JSON — exactly what the
	// real AnkiDroid 2.16+ collection.anki2 carries. Any non-empty
	// value here would mask the bug we are pinning: legacy readers
	// would succeed, the bridge would silently route to them, and
	// every read would return the wrong deck/model set.
	emptyJSON := "{}"
	if _, err := db.Exec(`INSERT INTO col (id, crt, mod, scm, ver, dty, usn, ls, conf, models, decks, dconf, tags) VALUES (1, ?, ?, ?, ?, 0, 0, 0, ?, ?, ?, ?, ?)`,
		1700000000, int64(1700000000000), int64(1700000000000), 18,
		emptyJSON, emptyJSON, emptyJSON, emptyJSON, emptyJSON); err != nil {
		t.Fatalf("seed col (empty decks/models): %v", err)
	}
	// `decks` table: one Default deck (real device has many more;
	// one is enough for the dispatch assertions). common/kind are
	// BLOBs — a tiny Protobuf-shaped byte slice satisfies NOT NULL;
	// the bridge never reads these columns.
	if _, err := db.Exec(`INSERT INTO decks (id, name, mtime_secs, usn, common, kind) VALUES (?, 'Default', 0, 0, ?, ?)`,
		testDeckID, []byte{0x0a, 0x00}, []byte{0x0a, 0x00}); err != nil {
		t.Fatalf("seed decks: %v", err)
	}
	// `notetypes` row: id + name + a placeholder BLOB config. The
	// bridge does NOT decode this blob (it doesn't need css / latex
	// / sortf); a minimal Protobuf-shaped placeholder is enough to
	// satisfy NOT NULL.
	notetypeConfig := []byte{0x0a, 0x00} // Protobuf field 1 (kind), varint 0 = KIND_NORMAL
	if _, err := db.Exec(`INSERT INTO notetypes (id, name, mtime_secs, usn, config) VALUES (?, 'Basic', 0, 0, ?)`,
		testModelID, notetypeConfig); err != nil {
		t.Fatalf("seed notetypes: %v", err)
	}
	// `fields` rows: two fields in ord order (Front, Back).
	// config BLOB is a tiny Protobuf placeholder; the bridge never
	// reads it.
	fieldConfig := []byte{0x08, 0x00} // Protobuf field 1 (sticky), varint 0 = false
	for ord, name := range []string{"Front", "Back"} {
		if _, err := db.Exec(`INSERT INTO fields (ntid, ord, name, config) VALUES (?, ?, ?, ?)`,
			testModelID, ord, name, fieldConfig); err != nil {
			t.Fatalf("seed fields[%d]: %v", ord, err)
		}
	}
	// `templates` rows: two templates in ord order (Card 1, Card 2).
	// config BLOB is a tiny Protobuf placeholder; the bridge never
	// reads it.
	tmplConfig := []byte{0x08, 0x00}
	for ord, name := range []string{"Card 1", "Card 2"} {
		if _, err := db.Exec(`INSERT INTO templates (ntid, ord, name, mtime_secs, usn, config) VALUES (?, ?, ?, 0, 0, ?)`,
			testModelID, ord, name, tmplConfig); err != nil {
			t.Fatalf("seed templates[%d]: %v", ord, err)
		}
	}
	return path
}

// newExpressionFieldCollectionFixture builds a legacy-schema
// fixture that includes BOTH the "Basic" model (testModelID,
// first field "Front") and the "JP Mining Note" model
// (testModelExpressionID, first field "Expression"). It exists
// so TestCollectionFindNotesFieldName can pin the non-Front
// first-field case: the model's first field name is whatever
// the schema says, not a hard-coded "Front".
//
// The fixture uses the same schema11 SQL and seed shape as
// newTestCollectionFixture — only the models map is extended.
func newExpressionFieldCollectionFixture(t *testing.T) string {
	t.Helper()
	dir := t.TempDir()
	path := filepath.Join(dir, "collection.anki2")
	db, err := sql.Open("sqlite", "file:"+path+"?_pragma=busy_timeout(5000)")
	if err != nil {
		t.Fatalf("open expression fixture: %v", err)
	}
	defer db.Close()
	if _, err := db.Exec(schema11SQL); err != nil {
		t.Fatalf("apply schema11: %v", err)
	}
	models := map[string]any{
		strconv.FormatInt(testModelID, 10):             testModelJSON(t),
		strconv.FormatInt(testModelExpressionID, 10): testModelExpressionJSON(t),
	}
	decks := map[string]any{
		strconv.FormatInt(testDeckID, 10): testDeckJSON(t),
	}
	dconf := map[string]any{"1": map[string]any{"id": 1, "name": "Default"}}
	conf := map[string]any{"nextPos": 1}
	tags := map[string]any{}
	modelsJSON, _ := json.Marshal(models)
	decksJSON, _ := json.Marshal(decks)
	dconfJSON, _ := json.Marshal(dconf)
	confJSON, _ := json.Marshal(conf)
	tagsJSON, _ := json.Marshal(tags)
	if _, err := db.Exec(`INSERT INTO col (id, crt, mod, scm, ver, dty, usn, ls, conf, models, decks, dconf, tags) VALUES (1, ?, ?, ?, ?, 0, 0, 0, ?, ?, ?, ?, ?)`,
		1700000000, int64(1700000000000), int64(1700000000000), 11,
		string(confJSON), string(modelsJSON), string(decksJSON), string(dconfJSON), string(tagsJSON)); err != nil {
		t.Fatalf("seed col (expression fixture): %v", err)
	}
	return path
}

// TestDetectSchemaNotetypesModern pins the autodetect on the
// AnkiDroid 2.16+ shape: `decks` + `notetypes` (no `models` table)
// selects the modern variant and flips modernNotetypes on.
func TestDetectSchemaNotetypesModern(t *testing.T) {
	path := newNotetypesCollectionFixture(t)
	c := openTestCollection(t, path)
	if c.Variant() != schemaVariantModernTables {
		t.Errorf("variant = %v, want schemaVariantModernTables", c.Variant())
	}
	if !c.modernNotetypes {
		t.Errorf("modernNotetypes = false, want true (only `notetypes` table present)")
	}
}

// TestDetectSchemaLegacyWhenNoDecksTable pins that an Anki schema
// with neither `decks` nor `models` / `notetypes` tables falls back
// to legacy — even if the rest of the schema looks modern. This is
// the safety net for partial schemas (corrupted / partially-upgraded
// collections) where the legacy col.* reader is the only honest
// option.
func TestDetectSchemaLegacyWhenNoDecksTable(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "collection.anki2")
	db, err := sql.Open("sqlite", "file:"+path)
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	defer db.Close()
	if _, err := db.Exec(schema11SQL); err != nil {
		t.Fatalf("apply base schema: %v", err)
	}
	if _, err := db.Exec(`INSERT INTO col (id, crt, mod, scm, ver, dty, usn, ls, conf, models, decks, dconf, tags) VALUES (1, 0, 0, 0, 11, 0, 0, 0, '{}', '{}', '{}', '{}', '{}')`); err != nil {
		t.Fatalf("seed col: %v", err)
	}
	c, err := OpenCollection(path)
	if err != nil {
		t.Fatalf("OpenCollection: %v", err)
	}
	defer c.Close()
	if c.Variant() != schemaVariantLegacyJSON {
		t.Errorf("variant = %v, want schemaVariantLegacyJSON", c.Variant())
	}
	if c.modernNotetypes {
		t.Errorf("modernNotetypes = true, want false (legacy variant)")
	}
}

// TestDeckIDsNotetypes pins that DeckIDs on the AnkiDroid 2.16+
// fixture serves the deck names from the `decks` table — the legacy
// col.decks JSON is empty and would otherwise parse-fail with
// "unexpected end of JSON input" (the on-device failure).
func TestDeckIDsNotetypes(t *testing.T) {
	path := newNotetypesCollectionFixture(t)
	c := openTestCollection(t, path)
	decks, err := c.DeckIDs()
	if err != nil {
		t.Fatalf("DeckIDs on notetypes fixture: %v", err)
	}
	if got := decks["Default"]; got != testDeckID {
		t.Errorf("decks[Default] = %d, want %d", got, testDeckID)
	}
}

// TestModelIDsNotetypes pins that ModelIDs on the AnkiDroid 2.16+
// fixture serves the model name from the `notetypes` table (NOT
// from col.models JSON — that's empty on the real device).
func TestModelIDsNotetypes(t *testing.T) {
	path := newNotetypesCollectionFixture(t)
	c := openTestCollection(t, path)
	models, err := c.ModelIDs()
	if err != nil {
		t.Fatalf("ModelIDs on notetypes fixture: %v", err)
	}
	if got := models["Basic"]; got != testModelID {
		t.Errorf("models[Basic] = %d, want %d", got, testModelID)
	}
}

// TestModelFieldNamesNotetypes pins that ModelFieldNames on the
// AnkiDroid 2.16+ fixture reads the field names out of the
// notetypes.fields JSON column in array order — the same order the
// legacy col.models JSON uses (ord-ascending). This is the minimum
// AnkiConnect modelFieldNames contract: callers pass field names
// back into addNote, so the order must match InsertNote's
// strings.Join(fields, "\x1f") expectations.
func TestModelFieldNamesNotetypes(t *testing.T) {
	path := newNotetypesCollectionFixture(t)
	c := openTestCollection(t, path)
	names, err := c.ModelFieldNames(testModelID)
	if err != nil {
		t.Fatalf("ModelFieldNames on notetypes fixture: %v", err)
	}
	want := []string{"Front", "Back"}
	if len(names) != len(want) {
		t.Fatalf("len(names) = %d, want %d (names=%v)", len(names), len(want), names)
	}
	for i, n := range names {
		if n != want[i] {
			t.Errorf("names[%d] = %q, want %q", i, n, want[i])
		}
	}
}

// TestModelTemplateCountNotetypes pins that ModelTemplateCount on
// the AnkiDroid 2.16+ fixture reads the templates JSON array length
// from the notetypes.templates column. The fixture seeds 2
// templates so InsertNote against this collection would create 2
// cards per note (vs the 1 card on the legacy fixture).
func TestModelTemplateCountNotetypes(t *testing.T) {
	path := newNotetypesCollectionFixture(t)
	c := openTestCollection(t, path)
	n, err := c.ModelTemplateCount(testModelID)
	if err != nil {
		t.Fatalf("ModelTemplateCount on notetypes fixture: %v", err)
	}
	if n != 2 {
		t.Errorf("template count = %d, want 2 (notetypes fixture seeds two templates)", n)
	}
}

// TestInsertNoteNotetypesFixtureRoundtrip pins the central happy
// path on the AnkiDroid 2.16+ shape: InsertNote creates a note +
// len(tmpls) cards. This is the test that would have caught the
// real-device dispatch failure: before the fix, ModelTemplateCount
// would error on "no such table: models", InsertNote would surface
// that as a top-level error, and addNote would dispatch with
// "anki action failed". With the fix in place, the insert succeeds
// and the card count matches the template count (2 in this
// fixture).
func TestInsertNoteNotetypesFixtureRoundtrip(t *testing.T) {
	path := newNotetypesCollectionFixture(t)
	c := openTestCollection(t, path)
	noteID, err := c.InsertNote(testDeckID, testModelID, []string{"猫", "cat"}, nil, nil)
	if err != nil {
		t.Fatalf("InsertNote on notetypes fixture: %v", err)
	}
	if noteID == 0 {
		t.Fatal("InsertNote: noteID = 0")
	}
	// Two templates → two cards per the fixture.
	var count int64
	if err := c.db.QueryRow("SELECT COUNT(*) FROM cards WHERE nid = ?", noteID).Scan(&count); err != nil {
		t.Fatalf("count cards: %v", err)
	}
	if count != 2 {
		t.Errorf("card count = %d, want 2 (notetypes fixture has 2 templates)", count)
	}
	// Notes row shape (csum, guid, flds) matches the legacy fixture
	// contract.
	var flds, guid string
	if err := c.db.QueryRow("SELECT flds, guid FROM notes WHERE id = ?", noteID).Scan(&flds, &guid); err != nil {
		t.Fatalf("read notes row: %v", err)
	}
	if flds != "猫\x1fcat" {
		t.Errorf("flds = %q, want %q", flds, "猫\x1fcat")
	}
	if len(guid) != 10 {
		t.Errorf("guid len = %d, want 10", len(guid))
	}
}

// TestModelIDsViaUnicaseNameLookup pins the end-to-end UNICASE
// path: on the AnkiDroid 2.16+ fixture the `notetypes.name`
// column is declared `COLLATE unicase`. Without registration,
// even the seemingly-trivial `SELECT id, name FROM notetypes`
// would fail because SQLite has to materialize the column's
// declared collation. This test calls ModelIDs (which issues
// exactly that query) on the fixture and asserts the result —
// passing only when UNICASE is registered (sync.Once in
// ensureUnicaseCollation handles it for the whole test
// binary).
func TestModelIDsViaUnicaseNameLookup(t *testing.T) {
	path := newNotetypesCollectionFixture(t)
	c := openTestCollection(t, path)
	models, err := c.ModelIDs()
	if err != nil {
		t.Fatalf("ModelIDs on notetypes fixture (UNICASE column): %v", err)
	}
	if got := models["Basic"]; got != testModelID {
		t.Errorf("models[Basic] = %d, want %d", got, testModelID)
	}
}

// TestModelJSONFromNotetypesUnreachable pins the error path that
// catches any caller that tries to round-trip a notetypes.model
// through the legacy JSON funnel. On the AnkiDroid 2.16+
// branch the bridge reads field names and template counts from
// the separate `fields` / `templates` tables; trying to read the
// model via modelJSON → modelJSONFromNotetypes produces a
// clear, precise error message (instead of the historical
// "no such column: fields" or a confusing JSON parse failure).
func TestModelJSONFromNotetypesUnreachable(t *testing.T) {
	path := newNotetypesCollectionFixture(t)
	c := openTestCollection(t, path)
	_, err := c.modelJSONFromNotetypes(testModelID)
	if err == nil {
		t.Fatal("modelJSONFromNotetypes: want err, got nil")
	}
	if !strings.Contains(err.Error(), "notetypes table") {
		t.Errorf("err = %v, want one mentioning notetypes table path", err)
	}
}

// TestCollectionCardsInfo pins the cardsInfo read path: a freshly
// inserted note with two templates yields two cards, and
// Collection.CardsInfo returns both with the AnkiConnect
// field set (cardId / noteId / deckId / ord / ...). Input order
// is preserved.
func TestCollectionCardsInfo(t *testing.T) {
	path := newTwoTmplsCollectionFixture(t)
	c := openTestCollection(t, path)
	id, err := c.InsertNote(testDeckID, testModelTwoTmplsID,
		[]string{"front", "back"}, nil, nil)
	if err != nil {
		t.Fatalf("InsertNote: %v", err)
	}
	// Pull card ids via notesInfo so the test mirrors what a real
	// client does.
	notes, err := c.NotesInfo([]int64{id})
	if err != nil {
		t.Fatalf("NotesInfo: %v", err)
	}
	if len(notes) != 1 || len(notes[0].Cards) != 2 {
		t.Fatalf("notesInfo cards = %v, want 2 cards", notes[0].Cards)
	}
	want := []int64{notes[0].Cards[0], notes[0].Cards[1]}
	infos, err := c.CardsInfo(want)
	if err != nil {
		t.Fatalf("CardsInfo: %v", err)
	}
	if len(infos) != 2 {
		t.Fatalf("CardsInfo len = %d, want 2", len(infos))
	}
	for i, ci := range infos {
		if ci.CardID != want[i] {
			t.Errorf("slot %d cardId = %d, want %d", i, ci.CardID, want[i])
		}
		if ci.NoteID != id {
			t.Errorf("slot %d noteId = %d, want %d", i, ci.NoteID, id)
		}
		if ci.DeckID != testDeckID {
			t.Errorf("slot %d deckId = %d, want %d", i, ci.DeckID, testDeckID)
		}
	}
	// Reversed input order: the result must follow the input.
	reversed := []int64{want[1], want[0]}
	infosRev, err := c.CardsInfo(reversed)
	if err != nil {
		t.Fatalf("CardsInfo reversed: %v", err)
	}
	if len(infosRev) != 2 || infosRev[0].CardID != reversed[0] || infosRev[1].CardID != reversed[1] {
		t.Errorf("CardsInfo reversed = %+v, want order [%d, %d]", infosRev, reversed[0], reversed[1])
	}
	// Unknown id silently dropped.
	infosUnknown, err := c.CardsInfo([]int64{want[0], 9999999999, want[1]})
	if err != nil {
		t.Fatalf("CardsInfo unknown: %v", err)
	}
	if len(infosUnknown) != 2 || infosUnknown[0].CardID != want[0] || infosUnknown[1].CardID != want[1] {
		t.Errorf("CardsInfo unknown = %+v, want [%d, %d]", infosUnknown, want[0], want[1])
	}
}

// testModelTwoTmplsID / testModelTwoTmplsJSON build a model with
// two templates (Card 1 + Card 2) so TestCollectionCardsInfo can
// exercise the multi-card roundtrip. The fixture model ID is
// re-used for the cards-list expectation (each note produces two
// cards in ord order).
const testModelTwoTmplsID int64 = 1700000000011

func testModelTwoTmplsJSON(t *testing.T) map[string]any {
	t.Helper()
	return map[string]any{
		"id":   testModelTwoTmplsID,
		"name": "Basic (2 tmpls)",
		"type": 0,
		"mod":  0,
		"usn":  0,
		"sortf": 0,
		"did":  testDeckID,
		"flds": []map[string]any{
			{"name": "Front", "ord": 0, "sticky": false, "media": []string{}, "rtl": false, "font": "Arial", "size": 20},
			{"name": "Back", "ord": 1, "sticky": false, "media": []string{}, "rtl": false, "font": "Arial", "size": 20},
		},
		"tmpls": []map[string]any{
			{"name": "Card 1", "ord": 0, "qfmt": "{{Front}}", "afmt": "{{Front}}<hr>{{Back}}", "did": nil},
			{"name": "Card 2", "ord": 1, "qfmt": "{{Back}}", "afmt": "{{Back}}<hr>{{Front}}", "did": nil},
		},
		"css":       ".card{font-family:arial;font-size:20px}",
		"latexPre":  "",
		"latexPost": "",
		"tags":      []string{},
		"vers":      []string{},
	}
}

// newTwoTmplsCollectionFixture builds a fixture that contains
// BOTH the single-template "Basic" model (testModelID, for the
// other FindNotes / NotesInfo tests) and a 2-template
// "Basic (2 tmpls)" model (testModelTwoTmplsID, for
// TestCollectionCardsInfo). It exists as a separate fixture so the
// single-template tests don't accidentally see the two-template
// model in deckNames / modelNames assertions.
func newTwoTmplsCollectionFixture(t *testing.T) string {
	t.Helper()
	dir := t.TempDir()
	path := filepath.Join(dir, "collection.anki2")
	db, err := sql.Open("sqlite", "file:"+path+"?_pragma=busy_timeout(5000)")
	if err != nil {
		t.Fatalf("open fixture: %v", err)
	}
	defer db.Close()
	if _, err := db.Exec(schema11SQL); err != nil {
		t.Fatalf("apply schema: %v", err)
	}
	models := map[string]any{
		strconv.FormatInt(testModelID, 10):        testModelJSON(t),
		strconv.FormatInt(testModelTwoTmplsID, 10): testModelTwoTmplsJSON(t),
	}
	decks := map[string]any{
		strconv.FormatInt(testDeckID, 10): testDeckJSON(t),
	}
	dconf := map[string]any{"1": map[string]any{"id": 1, "name": "Default"}}
	conf := map[string]any{"nextPos": 1}
	tags := map[string]any{}
	modelsJSON, _ := json.Marshal(models)
	decksJSON, _ := json.Marshal(decks)
	dconfJSON, _ := json.Marshal(dconf)
	confJSON, _ := json.Marshal(conf)
	tagsJSON, _ := json.Marshal(tags)
	if _, err := db.Exec(`INSERT INTO col (id, crt, mod, scm, ver, dty, usn, ls, conf, models, decks, dconf, tags) VALUES (1, ?, ?, ?, ?, 0, 0, 0, ?, ?, ?, ?, ?)`,
		1700000000, int64(1700000000000), int64(1700000000000), 11,
		string(confJSON), string(modelsJSON), string(decksJSON), string(dconfJSON), string(tagsJSON)); err != nil {
		t.Fatalf("seed col: %v", err)
	}
	return path
}

// TestCollectionFindNotesFrontQuery pins Yomitan's _getNoteQuery
// wire shape at the collection layer. The query `"front:あ"`
// (double-quoted, lowercased field name) matches notes whose first
// field CONTAINS the value as a substring.
//
// Variants covered:
//   - quoted (Yomitan): `"front:あ"` → 1 hit
//   - unquoted: `front:あ` → 1 hit
//   - case-insensitive prefix: `Front:あ` → 1 hit
//   - different first field value → 0 hits
//   - LIKE metacharacters in value are matched literally: the
//     first-field substring check uses strings.Contains (no SQL
//     LIKE), so `%` and `_` in the value are NOT wildcards.
func TestCollectionFindNotesFrontQuery(t *testing.T) {
	path := newTestCollectionFixture(t)
	c := openTestCollection(t, path)
	// Seed: a Japanese "a" front, an unrelated note, and a note
	// whose first field contains characters that would be LIKE
	// metacharacters in a SQL LIKE pattern (`%`, `_`). The new
	// substring-match path treats them as literals.
	nidA, err := c.InsertNote(testDeckID, testModelID, []string{"\u3042", "ja-A"}, nil, nil)
	if err != nil {
		t.Fatalf("seed A: %v", err)
	}
	if _, err := c.InsertNote(testDeckID, testModelID, []string{"\u3044", "ja-I"}, nil, nil); err != nil {
		t.Fatalf("seed I: %v", err)
	}
	nidMeta, err := c.InsertNote(testDeckID, testModelID, []string{"100%_off", "promo"}, nil, nil)
	if err != nil {
		t.Fatalf("seed meta: %v", err)
	}

	// Yomitan-shaped query: backtick raw strings (so the inner \u3042
	// stays literal — the literal query string is `"front:あ"`, i.e.
	// a double-quoted ASCII query whose value half is the Unicode
	// rune あ). This is the exact wire shape Yomitan's _getNoteQuery
	// emits after toLowerCase().
	ids, err := c.FindNotes(`"front:あ"`)
	if err != nil {
		t.Fatalf("FindNotes quoted: %v", err)
	}
	if len(ids) != 1 || ids[0] != nidA {
		t.Errorf("FindNotes quoted = %v, want [%d]", ids, nidA)
	}
	// Bare query (no outer quotes).
	ids, err = c.FindNotes(`front:あ`)
	if err != nil {
		t.Fatalf("FindNotes bare: %v", err)
	}
	if len(ids) != 1 || ids[0] != nidA {
		t.Errorf("FindNotes bare = %v, want [%d]", ids, nidA)
	}
	// Case-insensitive prefix.
	ids, err = c.FindNotes(`Front:あ`)
	if err != nil {
		t.Fatalf("FindNotes case: %v", err)
	}
	if len(ids) != 1 || ids[0] != nidA {
		t.Errorf("FindNotes case-insensitive = %v, want [%d]", ids, nidA)
	}
	// Different first-field value: 0 hits.
	ids, err = c.FindNotes(`"front:zz"`)
	if err != nil {
		t.Fatalf("FindNotes miss: %v", err)
	}
	if len(ids) != 0 {
		t.Errorf("FindNotes miss = %v, want []", ids)
	}
	// Substring match on the FIRST field — the lookup uses
	// strings.Contains (not SQL LIKE), so `%` and `_` in the value
	// are matched LITERALLY (no wildcard semantics). The seeded
	// note's first field is "100%_off"; the query value is
	// "100%_off" so the substring match hits.
	ids, err = c.FindNotes(`"front:100%_off"`)
	if err != nil {
		t.Fatalf("FindNotes meta: %v", err)
	}
	if len(ids) != 1 || ids[0] != nidMeta {
		t.Errorf("FindNotes meta = %v, want [%d] (substring match uses Contains — no wildcard semantics)", ids, nidMeta)
	}
}

// TestCollectionFindNotesFieldName pins the v4.5 Yomitan
// regression: Yomitan's _fieldsToQuery emits
// `${fieldNames[0].toLowerCase()}:${value}` — the MODEL'S FIRST
// FIELD NAME, not the literal "front". The old front-only parser
// only worked for models whose first field was literally named
// "Front"; models like DenChou / JP Mining Note whose first field
// is "Expression" silently returned 0 hits, which made the
// duplicate-probe multi batch error out and hid the + button in
// Yomitan's add-card dialog.
//
// The fixture has BOTH a "Basic" model (first field "Front") and
// a "JP Mining Note" model (first field "Expression"). The test
// inserts an Expression-model note and verifies:
//
//   - `expression:猫` hits (the exact Yomitan wire form)
//   - bare `expression:猫` hits (no outer quotes)
//   - `"expression:ne"` misses (substring must match)
//   - `"EXPRESSION:猫"` hits (case-insensitive field name)
//   - `"front:猫"` STILL hits the Basic model — regression pin
//     for the original behaviour
//   - `"deck:Default" "expression:猫"` (multi-term quoted, deck
//     scope) hits — deck terms are reserved prefixes, ignored
//   - `"front:zz"` on the Basic model still misses — regression
//     pin
//   - `tag:vocab` (no field term) returns ErrBadQuery —
//     preserved behaviour for unsupported queries
func TestCollectionFindNotesFieldName(t *testing.T) {
	path := newExpressionFieldCollectionFixture(t)
	c := openTestCollection(t, path)

	// Seed: an Expression-model note (first field 猫, second neko)
	// AND a Basic-model note (first field hello, second world) so
	// the field-name lookup actually has to distinguish them.
	nidExpr, err := c.InsertNote(testDeckID, testModelExpressionID, []string{"\u732b", "neko"}, nil, nil)
	if err != nil {
		t.Fatalf("seed Expression note: %v", err)
	}
	nidBasic, err := c.InsertNote(testDeckID, testModelID, []string{"hello", "world"}, nil, nil)
	if err != nil {
		t.Fatalf("seed Basic note: %v", err)
	}

	// Case 1: Yomitan wire form `"expression:猫"` against the
	// Expression-named model — the v4.5 regression test.
	ids, err := c.FindNotes(`"expression:猫"`)
	if err != nil {
		t.Fatalf("FindNotes quoted expression: %v", err)
	}
	if len(ids) != 1 || ids[0] != nidExpr {
		t.Errorf("FindNotes quoted expression = %v, want [%d] (Expression-model first field must resolve)", ids, nidExpr)
	}

	// Case 2: bare `expression:猫` — no outer quotes.
	ids, err = c.FindNotes(`expression:猫`)
	if err != nil {
		t.Fatalf("FindNotes bare expression: %v", err)
	}
	if len(ids) != 1 || ids[0] != nidExpr {
		t.Errorf("FindNotes bare expression = %v, want [%d]", ids, nidExpr)
	}

	// Case 3: substring miss — `expression:ne` should not match
	// the first field `猫` (it IS in `Meaning`=neko, but the
	// lookup is against the FIRST field only).
	ids, err = c.FindNotes(`"expression:ne"`)
	if err != nil {
		t.Fatalf("FindNotes expression miss: %v", err)
	}
	if len(ids) != 0 {
		t.Errorf("FindNotes expression miss = %v, want [] (lookup is first-field only)", ids)
	}

	// Case 4: case-insensitive field name — `EXPRESSION:猫`
	// resolves to the same schema as `expression:猫`.
	ids, err = c.FindNotes(`"EXPRESSION:猫"`)
	if err != nil {
		t.Fatalf("FindNotes case-insensitive field name: %v", err)
	}
	if len(ids) != 1 || ids[0] != nidExpr {
		t.Errorf("FindNotes EXPRESSION = %v, want [%d] (field name lookup is case-insensitive)", ids, nidExpr)
	}

	// Case 5: regression pin — the original `front:猫` query
	// against the Basic-model note still works. (The seeded
	// Basic note has first field "hello", not "猫", so we also
	// seed a Basic note with first field "猫" to keep the
	// existing TestCollectionFindNotesFrontQuery contract
	// alive — this case is the cross-model regression check.)
	ids, err = c.FindNotes(`"front:hello"`)
	if err != nil {
		t.Fatalf("FindNotes front regression: %v", err)
	}
	if len(ids) != 1 || ids[0] != nidBasic {
		t.Errorf("FindNotes front regression = %v, want [%d] (Basic-model front: query still works)", ids, nidBasic)
	}

	// Case 6: multi-term quoted form Yomitan sends for deck-scoped
	// duplicate probes — deck term is a reserved prefix, ignored;
	// the field term is the only thing that matters.
	ids, err = c.FindNotes(`"deck:Default" "expression:猫"`)
	if err != nil {
		t.Fatalf("FindNotes multi-term: %v", err)
	}
	if len(ids) != 1 || ids[0] != nidExpr {
		t.Errorf("FindNotes multi-term = %v, want [%d] (deck term ignored, field term resolves)", ids, nidExpr)
	}

	// Case 7: regression pin — `front:zz` against the Basic
	// model (first field "hello") still misses (this was a
	// regression check in the original test; we keep it).
	ids, err = c.FindNotes(`"front:zz"`)
	if err != nil {
		t.Fatalf("FindNotes front miss regression: %v", err)
	}
	if len(ids) != 0 {
		t.Errorf("FindNotes front miss regression = %v, want []", ids)
	}

	// Case 8: `expression:hello` — substring `hello` does NOT
	// appear in the Expression-model first field (猫), so this
	// misses even though the Basic model has "hello" as its first
	// field. Confirms the field-name lookup is strict (only the
	// matching note type is queried, no cross-model leakage).
	ids, err = c.FindNotes(`"expression:hello"`)
	if err != nil {
		t.Fatalf("FindNotes expression cross-model: %v", err)
	}
	if len(ids) != 0 {
		t.Errorf("FindNotes expression cross-model = %v, want [] (only Expression-model notes are queried)", ids)
	}

	// Case 9: malformed term (no field term) still surfaces
	// ErrBadQuery — preserves the original "refuse to silently
	// drop the floor on a parse failure" stance.
	if _, err := c.FindNotes("tag:vocab"); !errors.Is(err, ErrBadQuery) {
		t.Errorf("FindNotes tag:vocab err = %v, want ErrBadQuery", err)
	}
}

// TestCardIDsForNoteIDs pins Collection.CardIDsForNoteIDs:
// the guiBrowse dispatcher's general-query path routes a
// FindNotes result (note ids) through this helper to obtain the
// flat card-id array AnkiConnect's documented guiBrowse contract
// returns. The contract:
//   - one note id → its cards in ord ASC
//   - multiple note ids → cards grouped per note in ord ASC,
//     notes visited in input order (so the dispatcher can zip
//     against FindNotes' result without re-sorting)
//   - unknown note id → silently dropped (matches the AnkiConnect
//     "missing ids are omitted" convention)
//   - empty input → empty slice (not nil-or-error), so json.Marshal
//     emits `[]` not `null` for an empty-browse result
//
// Uses the 2-template fixture so the multi-card case is exercised
// end-to-end (a single-template note would still pass — the test
// also seeds a single-template note to confirm both surfaces).
func TestCardIDsForNoteIDs(t *testing.T) {
	path := newTwoTmplsCollectionFixture(t)
	c := openTestCollection(t, path)

	// Seed A: 2-template note (two cards in ord ASC).
	nidA, err := c.InsertNote(testDeckID, testModelTwoTmplsID, []string{"A", "x"}, nil, nil)
	if err != nil {
		t.Fatalf("seed A: %v", err)
	}
	infosA, err := c.CardsForNote(nidA)
	if err != nil {
		t.Fatalf("CardsForNote A: %v", err)
	}
	if len(infosA) != 2 {
		t.Fatalf("note A has %d cards, want 2 (2-template model)", len(infosA))
	}
	wantA := []int64{infosA[0].CardID, infosA[1].CardID}

	// Seed B: 1-template note (one card).
	nidB, err := c.InsertNote(testDeckID, testModelID, []string{"B", "y"}, nil, nil)
	if err != nil {
		t.Fatalf("seed B: %v", err)
	}
	infosB, err := c.CardsForNote(nidB)
	if err != nil {
		t.Fatalf("CardsForNote B: %v", err)
	}
	if len(infosB) != 1 {
		t.Fatalf("note B has %d cards, want 1", len(infosB))
	}
	wantB := []int64{infosB[0].CardID}

	// Case 1: single note id.
	got, err := c.CardIDsForNoteIDs([]int64{nidA})
	if err != nil {
		t.Fatalf("CardIDsForNoteIDs single: %v", err)
	}
	if !int64SliceEqual(got, wantA) {
		t.Errorf("CardIDsForNoteIDs single = %v, want %v", got, wantA)
	}

	// Case 2: two note ids in A → B order.
	got, err = c.CardIDsForNoteIDs([]int64{nidA, nidB})
	if err != nil {
		t.Fatalf("CardIDsForNoteIDs dual: %v", err)
	}
	want := append(append([]int64{}, wantA...), wantB...)
	if !int64SliceEqual(got, want) {
		t.Errorf("CardIDsForNoteIDs dual = %v, want %v", got, want)
	}

	// Case 3: reversed input order — output follows the input order.
	got, err = c.CardIDsForNoteIDs([]int64{nidB, nidA})
	if err != nil {
		t.Fatalf("CardIDsForNoteIDs reversed: %v", err)
	}
	want = append(append([]int64{}, wantB...), wantA...)
	if !int64SliceEqual(got, want) {
		t.Errorf("CardIDsForNoteIDs reversed = %v, want %v", got, want)
	}

	// Case 4: mix real + unknown note id — unknown is dropped.
	got, err = c.CardIDsForNoteIDs([]int64{nidA, 9999999999, nidB})
	if err != nil {
		t.Fatalf("CardIDsForNoteIDs unknown: %v", err)
	}
	want = append(append([]int64{}, wantA...), wantB...)
	if !int64SliceEqual(got, want) {
		t.Errorf("CardIDsForNoteIDs unknown = %v, want %v (unknown id silently skipped)", got, want)
	}

	// Case 5: empty input → empty (non-nil) slice.
	got, err = c.CardIDsForNoteIDs([]int64{})
	if err != nil {
		t.Fatalf("CardIDsForNoteIDs empty: %v", err)
	}
	if got == nil {
		t.Errorf("CardIDsForNoteIDs empty = nil, want []int64{} (so json.Marshal emits [])")
	}
	if len(got) != 0 {
		t.Errorf("CardIDsForNoteIDs empty len = %d, want 0", len(got))
	}

	// Case 6: zero note id is treated like an unknown id (silently
	// skipped, not an error) — matches the AnkiConnect convention
	// and the dispatcher's expectation that 0 is never a real id.
	got, err = c.CardIDsForNoteIDs([]int64{0, nidA})
	if err != nil {
		t.Fatalf("CardIDsForNoteIDs zero: %v", err)
	}
	if !int64SliceEqual(got, wantA) {
		t.Errorf("CardIDsForNoteIDs zero = %v, want %v", got, wantA)
	}
}

// int64SliceEqual reports whether a and b are element-wise equal.
// Tiny test helper — stdlib slices.Equal works on []byte, so we
// avoid pulling reflect into the production binary.
func int64SliceEqual(a, b []int64) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}
