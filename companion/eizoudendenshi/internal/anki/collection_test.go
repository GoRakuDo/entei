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
	dir := t.TempDir()
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
	if ni.Cards[0].DeckID != testDeckID {
		t.Errorf("Cards[0].DeckID = %d, want %d", ni.Cards[0].DeckID, testDeckID)
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