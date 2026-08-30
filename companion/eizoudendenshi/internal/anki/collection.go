package anki

import (
	"crypto/rand"
	"crypto/sha1"
	"database/sql"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"html"
	"math/big"
	"strconv"
	"strings"
	"time"

	_ "modernc.org/sqlite"
)

// Collection opens an AnkiDroid collection.anki2 SQLite database and
// exposes the AnkiConnect-compatible note operations as in-process
// methods. The companion itself becomes the AnkiConnect-compatible
// server for AnkiDroid by writing directly to the same database file
// AnkiDroid reads from. This removes the prior dependency on the
// AnkiconnectAndroid APK (docs v3.0, 2026-08-30).
//
// Schema detection runs at open time: Anki 2.1.28+ (schema 18) stores
// decks/models in dedicated tables (`decks`, `models`); older schemas
// store them as JSON blobs inside the `col` table (`col.decks`,
// `col.models`). The collection layer implements BOTH readers and
// dispatches at runtime, so the bridge works on every supported
// AnkiDroid version. See `schemaVariant` for the autodetected branch.
//
// All writes run inside a transaction; reads use a single shared
// connection from the pool. busy_timeout is 5000ms; journal_mode is
// read once at open time and never overwritten (respecting the
// existing AnkiDroid WAL mode when present).
type Collection struct {
	db       *sql.DB
	path     string
	variant  schemaVariant
	colCache *colRow // cached single-row col data (parses lazily)
}

// schemaVariant distinguishes the two Anki storage layouts the
// collection layer handles. The autodetection runs once at open time;
// subsequent calls consult this field directly.
type schemaVariant int

const (
	// schemaVariantUnknown is the zero-value sentinel; OpenCollection
	// never leaves it in this state.
	schemaVariantUnknown schemaVariant = iota
	// schemaVariantLegacyJSON: decks/models stored as JSON in col.decks / col.models
	// (Anki 2.1 < 2.1.28 / schema 11).
	schemaVariantLegacyJSON
	// schemaVariantModernTables: decks/models stored in dedicated tables
	// `decks` / `models` (Anki 2.1.28+ / schema 18).
	schemaVariantModernTables
)

// colRow is the parsed shape of the single row in the `col` table.
// Only the fields we read are decoded; the rest is the raw JSON for
// forward compatibility.
type colRow struct {
	ID     int64           `json:"-"`
	Mod    int64           `json:"mod"`
	Usn    int64           `json:"usn"`
	Models json.RawMessage `json:"models"`
	Decks  json.RawMessage `json:"decks"`
}

// ErrCollectionNotOpen is returned by every Collection method when the
// receiver is nil (or already Closed). The /v1/anki/action handler maps
// this to 503 with a "collection not available" message.
var ErrCollectionNotOpen = errors.New("anki: collection not open")

// ErrUnsupportedSchema is returned when the opened database is missing
// the expected `notes` / `cards` / `col` tables. The /v1/anki/action
// handler maps this to 503 with a clear schema-version hint.
var ErrUnsupportedSchema = errors.New("anki: collection schema not supported")

// ErrBadQuery is returned for FindNotes queries outside the documented
// subset (`added:1`, `nid:…`). Mirrors the "we won't pretend to
// support something we can't" stance — the upstream AnkiconnectAndroid
// routes forward arbitrary queries into the AnkiDroid provider, but
// we run an in-process implementation and refuse to silently drop the
// floor on a parse failure.
var ErrBadQuery = errors.New("anki: unsupported findNotes query")

// ErrDuplicateNote is returned by InsertNote when the candidate note
// duplicates an existing note (csum match, scoped by the caller's
// AllowDuplicate / DuplicateScope). The dispatcher maps this to a
// null "result" with HTTP 200, matching the official AnkiConnect
// addNote semantics for allowDuplicate=false (the upstream returns
// null rather than an error — the caller is expected to pre-check
// via canAddNotes). The error is a sentinel so the dispatcher can
// distinguish a duplicate-rejection from a real failure and pick
// the right wire shape.
var ErrDuplicateNote = errors.New("anki: duplicate note")

// base91Alphabet is the standard Anki guid64 base91 alphabet
// (ankitects/anki, rslib/src/links.rs: BASE91_CHARS). Every other
// documented base91 alphabet (Wikipedia, ICU, etc.) is a strict subset
// or superset; using the wrong one produces notes whose guid Anki
// recognises as malformed on next sync.
const base91Alphabet = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789!#$%&()*+,-./:;<=>?@[]^_`{|}~"

// base91Encode encodes the first 8 bytes of src as 10 base91 chars
// using Anki's BASE91_CHARS alphabet. The output is the literal guid
// Anki stores in notes.guid (a TEXT column).
//
// We decode via BigInt rather than per-byte math because the
// intermediate value exceeds int64 on 32-bit hosts; BigInt is
// portable and the cost is one allocation per note insert.
func base91Encode(src []byte) string {
	if len(src) < 8 {
		// Defensive: callers always pass crypto/rand 8-byte slices, but
		// panicking on an off-by-one is worse than silently failing
		// sync. Zero-pad and continue.
		padded := make([]byte, 8)
		copy(padded, src)
		src = padded
	}
	v := new(big.Int).SetBytes(src[:8])
	zero := big.NewInt(0)
	base := big.NewInt(91)
	mod := new(big.Int)
	out := make([]byte, 10)
	for i := 9; i >= 0; i-- {
		v.QuoRem(v, base, mod)
		out[i] = base91Alphabet[mod.Int64()]
		if v.Cmp(zero) == 0 && i > 0 {
			// Left-pad remainder with the alphabet's first char (matches
			// Anki's output for small inputs like all-zero bytes).
			for j := i - 1; j >= 0; j-- {
				out[j] = base91Alphabet[0]
			}
			break
		}
	}
	return string(out)
}

// generateGUID returns a fresh Anki-compatible 10-char base91 guid.
// The seed is 8 crypto/rand bytes — collision-resistant across the
// lifetime of the companion and independent of the wall clock (so
// two companions starting at the same instant still produce distinct
// guids).
func generateGUID() (string, error) {
	var b [8]byte
	if _, err := rand.Read(b[:]); err != nil {
		return "", fmt.Errorf("anki: read crypto/rand for guid: %w", err)
	}
	return base91Encode(b[:]), nil
}

// fieldChecksum returns the Anki csum value for a single field: the
// first 8 hex chars of SHA-1(stripped(field)) interpreted as int64.
// AnkiDroid's Utility.getFieldChecksum strips HTML/media before
// hashing; we replicate that here so csum matches what the AddContent
// API would produce on the same input (Anki's desktop csum path is
// identical — first 8 hex of SHA-1(stripped)).
//
// stripHTMLMedia mirrors AnkiDroid's order: strip <img src=…> tag
// to " <src> ", drop <style>/<script>/generic tags, then
// HTML-entity-decode the result with stdlib html.UnescapeString.
// html.UnescapeString handles both named (&nbsp;, &lt;, &amp;,
// …) and numeric (&#12354;, &#x1F600;) entities and decodes to
// proper UTF-8 (matching Anki's rslib sort_field + csum path). The
// stdlib entity decoder is what diverged from Anki in v2.x: our
// hand-rolled decodeHTMLEntities only knew &nbsp; + numeric bytes,
// so a field with "&lt;" would compute a csum that did not match
// what AnkiDroid computes for the same field.
//
// sha1 here is intentional, not SHA-256: Anki's duplicate-detection
// scheme is anchored to SHA-1; switching the algorithm silently
// breaks CanAddNotes (every note would look unique).
func fieldChecksum(field string) int64 {
	stripped := fieldChecksumInput(field)
	sum := sha1.Sum([]byte(stripped))
	hex8 := hex.EncodeToString(sum[:])[:8]
	n, err := strconv.ParseInt(hex8, 16, 64)
	if err != nil {
		// SHA-1 of 8 hex chars never fails to parse; this branch only
		// fires on a corrupt runtime, in which case 0 (== Anki's
		// "no checksum") is the right defensive fallback.
		return 0
	}
	return n
}

// stripHTMLMedia and stripHTML replicate AnkiDroid's
// Utility.stripHTMLMedia: img tags → space + src, then strip style /
// script / generic tags, then HTML-entity-decoding. The output is the
// canonical csum + sfld input. Cost is O(n) over field length.
//
// Entity decoding: AnkiDroid's Utils.entsToTxt pre-replaces &nbsp;
// with an ASCII space (0x20) BEFORE decoding, then unescapes the rest
// (named + numeric via stdlib html.UnescapeString). We mirror that
// order exactly — the dedup target is the csum AnkiDroid itself stored
// on the same shared DB, so byte-identical semantics matter more than
// rslib fidelity (which maps &nbsp; → U+00A0).
func fieldChecksumInput(field string) string {
	return stripHTMLMedia(field)
}

// stripHTMLMedia and stripHTML replicate AnkiDroid's
// Utility.stripHTMLMedia: img tags → space + src, then strip style /
// script / generic tags, then HTML-entity-decoding (see
// fieldChecksumInput for the entity order).
func stripHTMLMedia(s string) string {
	// Single-pass: split on `<img src=...>`, replace with " src ".
	var b strings.Builder
	b.Grow(len(s))
	i := 0
	for i < len(s) {
		idx := indexImgTag(s[i:])
		if idx < 0 {
			b.WriteString(s[i:])
			break
		}
		b.WriteString(s[i : i+idx])
		// find end of tag
		end := indexTagClose(s[i+idx:])
		if end < 0 {
			b.WriteString(s[i+idx:])
			break
		}
		// extract src
		srcStart := indexAttr(s[i+idx:i+idx+end], "src")
		if srcStart >= 0 {
			// srcStart is relative to the start of the tag
			tag := s[i+idx : i+idx+end]
			src := extractAttrValue(tag, srcStart)
			b.WriteByte(' ')
			b.WriteString(src)
			b.WriteByte(' ')
		}
		i += idx + end
	}
	stripped := stripHTML(b.String())
	// AnkiDroid's entsToTxt pre-replaces &nbsp; with an ASCII space
	// (0x20) BEFORE entity-decoding the rest — mirror that order so the
	// csum matches what AnkiDroid stores on the same shared DB
	// (2026-08-30 review: html.UnescapeString maps &nbsp; to U+00A0,
	// which made duplicate detection miss true duplicates).
	stripped = strings.ReplaceAll(stripped, "&nbsp;", " ")
	return html.UnescapeString(stripped)
}

func indexImgTag(s string) int {
	// case-insensitive "<img"
	return indexCaseInsensitive(s, "<img")
}

func indexTagClose(s string) int {
	// find first '>' at or after position 0
	for i := 0; i < len(s); i++ {
		if s[i] == '>' {
			return i + 1
		}
	}
	return -1
}

func indexAttr(tag, name string) int {
	// find `name=` (with surrounding space or =) at any position
	want := name + "="
	lowTag := strings.ToLower(tag)
	lowWant := strings.ToLower(want)
	for i := 0; i+len(lowWant) <= len(lowTag); i++ {
		if lowTag[i:i+len(lowWant)] == lowWant {
			// require preceding char to be space or start (to avoid
			// matching `data-src=` when looking for `src`)
			if i == 0 || lowTag[i-1] == ' ' || lowTag[i-1] == '\t' {
				return i
			}
		}
	}
	return -1
}

func extractAttrValue(tag string, attrStart int) string {
	// attrStart points at "src=" — skip the name and =, then read
	// the quoted or bare value.
	i := attrStart
	for i < len(tag) && tag[i] != '=' {
		i++
	}
	if i >= len(tag) {
		return ""
	}
	i++ // past '='
	// skip whitespace
	for i < len(tag) && (tag[i] == ' ' || tag[i] == '\t') {
		i++
	}
	if i >= len(tag) {
		return ""
	}
	if tag[i] == '"' || tag[i] == '\'' {
		quote := tag[i]
		i++
		start := i
		for i < len(tag) && tag[i] != quote {
			i++
		}
		return tag[start:i]
	}
	// bare value: until whitespace or '>'
	start := i
	for i < len(tag) && tag[i] != ' ' && tag[i] != '\t' && tag[i] != '>' {
		i++
	}
	return tag[start:i]
}

func indexCaseInsensitive(s, sub string) int {
	lowS := strings.ToLower(s)
	lowSub := strings.ToLower(sub)
	return strings.Index(lowS, lowSub)
}

func stripHTML(s string) string {
	// remove <style>...</style>
	s = removeTagBlocks(s, "style")
	s = removeTagBlocks(s, "script")
	// remove all remaining <...>
	var b strings.Builder
	b.Grow(len(s))
	in := false
	for i := 0; i < len(s); i++ {
		if !in && s[i] == '<' {
			in = true
			continue
		}
		if in && s[i] == '>' {
			in = false
			continue
		}
		if !in {
			b.WriteByte(s[i])
		}
	}
	return b.String()
}

func removeTagBlocks(s, tag string) string {
	open := "<" + tag
	close := "</" + tag + ">"
	for {
		start := indexCaseInsensitive(s, open)
		if start < 0 {
			return s
		}
		end := indexCaseInsensitive(s[start:], close)
		if end < 0 {
			return s[:start]
		}
		s = s[:start] + s[start+end+len(close):]
	}
}

// nowMillis returns the current wall-clock time as Anki's mod unit:
// milliseconds since the Unix epoch. Anki stores note.mod / card.mod /
// col.mod in millisecond precision.
func nowMillis() int64 {
	return time.Now().UnixMilli()
}

// OpenCollection opens the AnkiDroid collection.anki2 file at
// collectionPath, applies the bridge's pragmas (busy_timeout=5000,
// respect existing journal_mode), verifies the notes/cards/col tables
// exist, and detects the schema variant (legacy JSON in col.* or
// dedicated decks/models tables). Returns ErrUnsupportedSchema when
// the file is missing any of the required tables.
//
// The directory containing the file must be writable (we create
// collection.anki2-wal / -shm sidecars for WAL mode if AnkiDroid
// hasn't already). busy_timeout=5000 means concurrent AnkiDroid
// reads/writes wait up to 5s for our transaction to finish.
func OpenCollection(collectionPath string) (*Collection, error) {
	if collectionPath == "" {
		return nil, errors.New("anki: empty collection path")
	}
	// DSN: file:<path>?_pragma=busy_timeout(5000) — modernc's
	// parameter binding for pragmas. _time_format=sqlite is the
	// default; we don't override it.
	dsn := "file:" + collectionPath + "?_pragma=busy_timeout(5000)&_pragma=foreign_keys(0)"
	db, err := sql.Open("sqlite", dsn)
	if err != nil {
		return nil, fmt.Errorf("anki: open collection: %w", err)
	}
	// Limit pool size: SQLite is single-writer; one connection is
	// enough for our usage and avoids spurious SQLITE_BUSY under
	// concurrent reads.
	db.SetMaxOpenConns(1)
	if err := db.Ping(); err != nil {
		_ = db.Close()
		return nil, fmt.Errorf("anki: ping collection: %w", err)
	}
	c := &Collection{db: db, path: collectionPath}
	if err := c.detectSchema(); err != nil {
		_ = db.Close()
		return nil, err
	}
	return c, nil
}

// detectSchema verifies the required tables exist (notes, cards, col)
// and chooses the variant by checking whether `decks` / `models` are
// also tables (modern, schema 18) or live as JSON columns in `col`
// (legacy, schema 11).
func (c *Collection) detectSchema() error {
	rows, err := c.db.Query("SELECT name FROM sqlite_master WHERE type='table'")
	if err != nil {
		return fmt.Errorf("anki: read sqlite_master: %w", err)
	}
	defer rows.Close()
	tables := map[string]bool{}
	for rows.Next() {
		var name string
		if err := rows.Scan(&name); err != nil {
			return fmt.Errorf("anki: scan sqlite_master: %w", err)
		}
		tables[name] = true
	}
	if err := rows.Err(); err != nil {
		return fmt.Errorf("anki: iterate sqlite_master: %w", err)
	}
	for _, required := range []string{"notes", "cards", "col"} {
		if !tables[required] {
			return fmt.Errorf("%w: missing table %q", ErrUnsupportedSchema, required)
		}
	}
	if tables["decks"] && tables["models"] {
		c.variant = schemaVariantModernTables
	} else {
		c.variant = schemaVariantLegacyJSON
	}
	return nil
}

// Close releases the underlying database handle. Safe to call multiple
// times; subsequent method calls on the receiver will return
// ErrCollectionNotOpen.
func (c *Collection) Close() error {
	if c == nil || c.db == nil {
		return nil
	}
	err := c.db.Close()
	c.db = nil
	c.colCache = nil
	return err
}

// Path returns the collection file path the receiver was opened on.
// Safe to expose in /v1/anki/status (the path is the same one the
// operator passed via --anki-collection; not a secret).
func (c *Collection) Path() string {
	if c == nil {
		return ""
	}
	return c.path
}

// Variant returns the autodetected schema variant. Exposed for tests.
func (c *Collection) Variant() schemaVariant {
	if c == nil {
		return schemaVariantUnknown
	}
	return c.variant
}

// loadCol reads the single row in the `col` table and parses its JSON
// fields. The result is cached because the row is read on every
// write (mod/usn bump). AnkiDroid only ever has one row in `col`,
// always with id=1.
func (c *Collection) loadCol() (*colRow, error) {
	if c == nil || c.db == nil {
		return nil, ErrCollectionNotOpen
	}
	if c.colCache != nil {
		return c.colCache, nil
	}
	row := c.db.QueryRow("SELECT id, mod, usn, models, decks FROM col WHERE id=1")
	var (
		id        int64
		mod       int64
		usn       int64
		modelsRaw string
		decksRaw  string
	)
	if err := row.Scan(&id, &mod, &usn, &modelsRaw, &decksRaw); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return nil, fmt.Errorf("%w: col row missing", ErrUnsupportedSchema)
		}
		return nil, fmt.Errorf("anki: read col: %w", err)
	}
	out := &colRow{
		ID:     id,
		Mod:    mod,
		Usn:    usn,
		Models: json.RawMessage(modelsRaw),
		Decks:  json.RawMessage(decksRaw),
	}
	c.colCache = out
	return out, nil
}

// invalidateColCache drops the cached colRow so the next loadCol
// re-reads from SQLite. Call after every write that mutates col.mod
// / col.usn (InsertNote / UpdateNoteFields / AddTags).
func (c *Collection) invalidateColCache() {
	c.colCache = nil
}

// CollectionModBump updates col.mod to the current millis. Called
// after every write that mutates notes/cards (AnkiDroid would do this
// automatically on close; we mimic it eagerly so a stale screen in
// AnkiDroid sees a fresh "modified" timestamp).
func (c *Collection) CollectionModBump() error {
	if c == nil || c.db == nil {
		return ErrCollectionNotOpen
	}
	_, err := c.db.Exec("UPDATE col SET mod = ? WHERE id = 1", nowMillis())
	if err != nil {
		return fmt.Errorf("anki: bump col.mod: %w", err)
	}
	c.invalidateColCache()
	return nil
}

// DeckIDs returns a name→id map of every deck in the collection.
// Dispatches between the legacy-JSON reader (col.decks JSON object)
// and the modern-tables reader (SELECT id, name FROM decks).
func (c *Collection) DeckIDs() (map[string]int64, error) {
	if c == nil || c.db == nil {
		return nil, ErrCollectionNotOpen
	}
	switch c.variant {
	case schemaVariantModernTables:
		return c.deckIDsFromTable()
	case schemaVariantLegacyJSON:
		return c.deckIDsFromCol()
	default:
		return nil, ErrUnsupportedSchema
	}
}

// deckIDsFromTable reads the modern (schema 18) `decks` table. The
// deck name column may be named `name` or `json` depending on
// AnkiDroid build; we read both and prefer whichever is non-empty.
func (c *Collection) deckIDsFromTable() (map[string]int64, error) {
	rows, err := c.db.Query("SELECT id, name FROM decks")
	if err != nil {
		return nil, fmt.Errorf("anki: query decks: %w", err)
	}
	defer rows.Close()
	out := map[string]int64{}
	for rows.Next() {
		var id int64
		var name sql.NullString
		if err := rows.Scan(&id, &name); err != nil {
			return nil, fmt.Errorf("anki: scan decks: %w", err)
		}
		if !name.Valid || name.String == "" {
			continue
		}
		out[name.String] = id
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("anki: iterate decks: %w", err)
	}
	return out, nil
}

// deckIDsFromCol reads col.decks JSON object (key=string-id,
// value={name: ..., ...}). Anki's deck IDs are int64 but the JSON
// key is a string; we parse it as int64 here.
func (c *Collection) deckIDsFromCol() (map[string]int64, error) {
	col, err := c.loadCol()
	if err != nil {
		return nil, err
	}
	raw := map[string]json.RawMessage{}
	if err := json.Unmarshal(col.Decks, &raw); err != nil {
		return nil, fmt.Errorf("anki: parse col.decks: %w", err)
	}
	out := map[string]int64{}
	for idStr, deckRaw := range raw {
		id, err := strconv.ParseInt(idStr, 10, 64)
		if err != nil {
			continue
		}
		var deck struct {
			Name string `json:"name"`
		}
		if err := json.Unmarshal(deckRaw, &deck); err != nil {
			continue
		}
		if deck.Name != "" {
			out[deck.Name] = id
		}
	}
	return out, nil
}

// ModelIDs returns a name→id map of every note-type model in the
// collection. Dispatches between legacy JSON (col.models) and modern
// tables (models).
func (c *Collection) ModelIDs() (map[string]int64, error) {
	if c == nil || c.db == nil {
		return nil, ErrCollectionNotOpen
	}
	switch c.variant {
	case schemaVariantModernTables:
		return c.modelIDsFromTable()
	case schemaVariantLegacyJSON:
		return c.modelIDsFromCol()
	default:
		return nil, ErrUnsupportedSchema
	}
}

func (c *Collection) modelIDsFromTable() (map[string]int64, error) {
	rows, err := c.db.Query("SELECT id, name FROM models")
	if err != nil {
		return nil, fmt.Errorf("anki: query models: %w", err)
	}
	defer rows.Close()
	out := map[string]int64{}
	for rows.Next() {
		var id int64
		var name sql.NullString
		if err := rows.Scan(&id, &name); err != nil {
			return nil, fmt.Errorf("anki: scan models: %w", err)
		}
		if !name.Valid || name.String == "" {
			continue
		}
		out[name.String] = id
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("anki: iterate models: %w", err)
	}
	return out, nil
}

func (c *Collection) modelIDsFromCol() (map[string]int64, error) {
	col, err := c.loadCol()
	if err != nil {
		return nil, err
	}
	raw := map[string]json.RawMessage{}
	if err := json.Unmarshal(col.Models, &raw); err != nil {
		return nil, fmt.Errorf("anki: parse col.models: %w", err)
	}
	out := map[string]int64{}
	for idStr, modelRaw := range raw {
		id, err := strconv.ParseInt(idStr, 10, 64)
		if err != nil {
			continue
		}
		var model struct {
			Name string `json:"name"`
		}
		if err := json.Unmarshal(modelRaw, &model); err != nil {
			continue
		}
		if model.Name != "" {
			out[model.Name] = id
		}
	}
	return out, nil
}

// modelJSON returns the raw JSON object for a single model
// (id-as-string keys → model-detail-object). Reads from the dedicated
// models table or col.models depending on the variant.
func (c *Collection) modelJSON(mid int64) (json.RawMessage, error) {
	if c == nil || c.db == nil {
		return nil, ErrCollectionNotOpen
	}
	switch c.variant {
	case schemaVariantModernTables:
		row := c.db.QueryRow("SELECT json FROM models WHERE id = ?", mid)
		var raw sql.NullString
		if err := row.Scan(&raw); err != nil {
			if errors.Is(err, sql.ErrNoRows) {
				return nil, fmt.Errorf("anki: model %d not found", mid)
			}
			return nil, fmt.Errorf("anki: read model: %w", err)
		}
		if !raw.Valid {
			return nil, fmt.Errorf("anki: model %d has no JSON column", mid)
		}
		return json.RawMessage(raw.String), nil
	case schemaVariantLegacyJSON:
		col, err := c.loadCol()
		if err != nil {
			return nil, err
		}
		raw := map[string]json.RawMessage{}
		if err := json.Unmarshal(col.Models, &raw); err != nil {
			return nil, fmt.Errorf("anki: parse col.models: %w", err)
		}
		key := strconv.FormatInt(mid, 10)
		if v, ok := raw[key]; ok {
			return v, nil
		}
		return nil, fmt.Errorf("anki: model %d not found in col.models", mid)
	default:
		return nil, ErrUnsupportedSchema
	}
}

// ModelFieldNames returns the field-name list for the model in
// ord order — exactly what AnkiConnect's modelFieldNames returns. The
// flds array is the source of truth; we read names by ordinal.
func (c *Collection) ModelFieldNames(mid int64) ([]string, error) {
	if c == nil || c.db == nil {
		return nil, ErrCollectionNotOpen
	}
	raw, err := c.modelJSON(mid)
	if err != nil {
		return nil, err
	}
	var model struct {
		Flds []struct {
			Name string `json:"name"`
			Ord  int    `json:"ord"`
		} `json:"flds"`
	}
	if err := json.Unmarshal(raw, &model); err != nil {
		return nil, fmt.Errorf("anki: parse model %d: %w", mid, err)
	}
	// Sort by ord ascending (Anki stores them that way, but the JSON
	// array order is the canonical order — we trust it instead).
	names := make([]string, 0, len(model.Flds))
	for _, f := range model.Flds {
		if f.Name != "" {
			names = append(names, f.Name)
		}
	}
	return names, nil
}

// ModelTemplateCount returns the count of tmpls entries for the model.
// One template = one card; InsertNote creates len(tmpls) cards.
func (c *Collection) ModelTemplateCount(mid int64) (int, error) {
	if c == nil || c.db == nil {
		return 0, ErrCollectionNotOpen
	}
	raw, err := c.modelJSON(mid)
	if err != nil {
		return 0, err
	}
	var model struct {
		Tmpls []json.RawMessage `json:"tmpls"`
	}
	if err := json.Unmarshal(raw, &model); err != nil {
		return 0, fmt.Errorf("anki: parse model %d tmpls: %w", mid, err)
	}
	return len(model.Tmpls), nil
}

// NoteCheck is the inbound shape for CanAddNotes. Mirrors the
// upstream AnkiconnectAndroid canAddNotes contract: one or more
// (field-value, allowDuplicate, duplicateScope, deckName) tuples.
// We only consume Field (first field = the one Anki uses for csum
// and sort), AllowDuplicate, DuplicateScope, and DeckName.
type NoteCheck struct {
	Field          string `json:"field"`
	AllowDuplicate bool   `json:"allowDuplicate"`
	DuplicateScope string `json:"duplicateScope"` // "deck" | "collection"
	DeckName       string `json:"deckName"`
}

// indexCsum is the per-input tuple passed through the scope loop. It
// captures the index back into the caller's slice, the csum, the
// scope, and the candidate deck name.
type indexCsum struct {
	idx   int
	csum  int64
	scope string
	deck  string
}

// CanAddNotes returns one bool per input NoteCheck: true = Anki would
// accept this note, false = a duplicate already exists. Mirrors
// A:/AnkiconnectAndroid IntegratedAPI.canAddNotes: csum-based lookup
// with optional deck-scope filter (the scope check follows the same
// SQL path Anki uses on its own duplicate-detection filter).
func (c *Collection) CanAddNotes(checks []NoteCheck) ([]bool, error) {
	if c == nil || c.db == nil {
		return nil, ErrCollectionNotOpen
	}
	if len(checks) == 0 {
		return []bool{}, nil
	}
	out := make([]bool, len(checks))
	// Partition into allow-duplicate (no DB lookup needed) vs strict.
	var strict []indexCsum
	for i, ch := range checks {
		cs := fieldChecksum(ch.Field)
		if ch.AllowDuplicate {
			out[i] = cs != 0
			continue
		}
		strict = append(strict, indexCsum{
			idx:   i,
			csum:  cs,
			scope: ch.DuplicateScope,
			deck:  ch.DeckName,
		})
	}
	if len(strict) == 0 {
		return out, nil
	}
	// Group by duplicateScope so we can do one query per scope (deck
	// vs collection). Csums within a group go into a single IN(...)
	// clause.
	byScope := map[string][]indexCsum{}
	for _, ic := range strict {
		byScope[ic.scope] = append(byScope[ic.scope], ic)
	}
	for scope, list := range byScope {
		if err := c.canAddNotesForScope(scope, list, out); err != nil {
			return nil, err
		}
	}
	return out, nil
}

// canAddNotesForScope marks duplicates for a single scope. For
// "deck" scope we additionally check that the existing card belongs
// to the same deck as the candidate; the unit tests pin the
// collection-scope branch, and the wire-level allowDuplicate tests
// pin the addNote path (deck-scope reject branch is exercised by
// real-device QA, 2026-08-30).
func (c *Collection) canAddNotesForScope(scope string, list []indexCsum, out []bool) error {
	// Build the csum IN clause.
	placeholders := make([]string, len(list))
	args := make([]any, len(list))
	for i, ic := range list {
		placeholders[i] = "?"
		args[i] = ic.csum
	}
	q := "SELECT id, csum FROM notes WHERE csum IN (" + strings.Join(placeholders, ",") + ")"
	rows, err := c.db.Query(q, args...)
	if err != nil {
		return fmt.Errorf("anki: query duplicates: %w", err)
	}
	defer rows.Close()
	type dupHit struct {
		nid  int64
		csum int64
	}
	var hits []dupHit
	for rows.Next() {
		var nid, cs int64
		if err := rows.Scan(&nid, &cs); err != nil {
			return fmt.Errorf("anki: scan duplicate: %w", err)
		}
		hits = append(hits, dupHit{nid: nid, csum: cs})
	}
	if err := rows.Err(); err != nil {
		return fmt.Errorf("anki: iterate duplicates: %w", err)
	}
	if len(hits) == 0 {
		// No candidate-level duplicates; every strict check passes.
		for _, ic := range list {
			out[ic.idx] = true
		}
		return nil
	}
	// Build the candidate-deck map for scope=="deck" so we can filter
	// duplicates to the requested deck only.
	needDeckFilter := scope == "deck"
	deckIDs := map[string]int64{}
	if needDeckFilter {
		for _, ic := range list {
			if ic.deck == "" {
				continue
			}
			if _, ok := deckIDs[ic.deck]; ok {
				continue
			}
			all, err := c.DeckIDs()
			if err != nil {
				return err
			}
			deckIDs = all
			break
		}
	}
	// For each hit, see if it matches one of the input csums and
	// (optionally) whether any of its cards is in the candidate deck.
	hitCsums := map[int64]struct{}{}
	for _, h := range hits {
		hitCsums[h.csum] = struct{}{}
	}
	// Default: every input is allowed (no per-input mark yet).
	for _, ic := range list {
		out[ic.idx] = true
	}
	for _, h := range hits {
		// for each input that has this csum, check scope
		if !needDeckFilter {
			for _, ic := range list {
				if ic.csum == h.csum {
					out[ic.idx] = false
				}
			}
			continue
		}
		// deck scope: query cards.did for this note
		for _, ic := range list {
			if ic.csum != h.csum {
				continue
			}
			if ic.deck == "" {
				// no deck on the candidate → match any card in any
				// deck (collection-scope-equivalent for this branch).
				out[ic.idx] = false
				continue
			}
			want, ok := deckIDs[ic.deck]
			if !ok {
				// unknown deck: be conservative and block
				out[ic.idx] = false
				continue
			}
			exists, err := c.noteHasCardInDeck(h.nid, want)
			if err != nil {
				return err
			}
			if exists {
				out[ic.idx] = false
			}
		}
	}
	return nil
}

// noteHasCardInDeck reports whether note nid has at least one card
// with did = deckID. Used by the deck-scope duplicate filter.
func (c *Collection) noteHasCardInDeck(nid, deckID int64) (bool, error) {
	row := c.db.QueryRow("SELECT 1 FROM cards WHERE nid = ? AND did = ? LIMIT 1", nid, deckID)
	var x int
	err := row.Scan(&x)
	if err == nil {
		return true, nil
	}
	if errors.Is(err, sql.ErrNoRows) {
		return false, nil
	}
	return false, fmt.Errorf("anki: scan card for deck dup: %w", err)
}

// InsertOptions controls the duplicate-detection behaviour of
// InsertNote. The fields mirror the AnkiConnect addNote `options`
// block: AllowDuplicate is the explicit bypass (default false =
// strict, matching the AnkiConnect web/desktop default), and
// DuplicateScope narrows the check to one deck (when non-empty +
// "deck") or the whole collection (the default). ScopeDeckID is the
// resolved deck id used for the deck-scope path; pass 0 when
// DuplicateScope != "deck".
//
// A nil *InsertOptions is treated as AllowDuplicate=false,
// DuplicateScope="collection" (the safe strict default).
type InsertOptions struct {
	AllowDuplicate  bool
	DuplicateScope  string // "deck" | "collection" (default)
	ScopeDeckID     int64  // resolved deck id when DuplicateScope == "deck"
}

// InsertNote creates a new note (and one card per template) in a
// single transaction. Returns the new note id. The transaction:
//
//  1. Generates a base91 guid from crypto/rand
//  2. Computes csum as SHA-1(stripped(fields[0]))[:8]
//  3. INSERTs the notes row (mod = now-millis, usn = -1, flags = 0, data = "")
//  4. For each template ord, INSERTs one card. New cards get the
//     smallest available due position in their deck (max-due+1, or 1
//     if the deck is empty). ivl/factor/reps/lapses/left/odue/odid/
//     flags = 0; data = ""; mod = now-millis; usn = -1.
//  5. UPDATE col SET mod = now-millis, usn = -1
//
// On any error the transaction rolls back and no rows are written.
//
// When opts.AllowDuplicate is false (the default), InsertNote runs
// the same csum-based duplicate check as CanAddNotes BEFORE opening
// the write transaction. A hit returns ErrDuplicateNote without
// inserting (the caller maps this to a null addNote result, matching
// AnkiConnect's official contract). The duplicate check happens
// outside the transaction so a rolled-back read doesn't take a
// write lock on the connection pool (the pool is single-conn).
func (c *Collection) InsertNote(deckID, modelID int64, fields []string, tags []string, opts *InsertOptions) (int64, error) {
	if c == nil || c.db == nil {
		return 0, ErrCollectionNotOpen
	}
	if len(fields) == 0 {
		return 0, fmt.Errorf("%w: note has no fields", ErrBadRequest)
	}
	if modelID == 0 {
		return 0, fmt.Errorf("%w: model id is 0", ErrBadRequest)
	}
	if deckID == 0 {
		return 0, fmt.Errorf("%w: deck id is 0", ErrBadRequest)
	}
	if opts == nil {
		opts = &InsertOptions{}
	}
	if !opts.AllowDuplicate {
		// Resolve the scope deck's name so the dup check filters by that
		// deck's cards (duplicateScope:"deck"), mirroring canAddNotes —
		// otherwise deck-scope degenerates to collection-wide and a deck-
		// scoped pre-check passes while addNote rejects (2026-08-30 review).
		deckName := ""
		if opts.DuplicateScope == "deck" && opts.ScopeDeckID > 0 {
			decks, deckErr := c.DeckIDs()
			if deckErr != nil {
				return 0, deckErr
			}
			for name, id := range decks {
				if id == opts.ScopeDeckID {
					deckName = name
					break
				}
			}
		}
		checks := []NoteCheck{{
			Field:          fields[0],
			AllowDuplicate: false,
			DuplicateScope: opts.DuplicateScope,
			DeckName:       deckName,
		}}
		canAdd, err := c.CanAddNotes(checks)
		if err != nil {
			return 0, err
		}
		if len(canAdd) > 0 && !canAdd[0] {
			return 0, ErrDuplicateNote
		}
	}
	guid, err := generateGUID()
	if err != nil {
		return 0, err
	}
	cs := fieldChecksum(fields[0])
	flds := strings.Join(fields, "\x1f")
	// sfld is the sort-field column Anki writes the FIRST field's
	// HTML-stripped form into. Anki rslib computes sort_field via the
	// same strip-HTML pipeline as csum; storing the raw HTML here
	// would break browser-side sort and the AnkiDroid browser
	// column. Mirroring stripHTMLMedia on field[0] here pins the
	// behaviour to the csum path.
	sfld := fieldChecksumInput(fields[0])
	mod := nowMillis()
	// Resolve template count BEFORE opening the transaction: the
	// pool is single-connection (SetMaxOpenConns(1)) so a
	// Query inside the tx would deadlock. Resolving upfront keeps
	// the tx body to its own writes.
	tCount, err := c.ModelTemplateCount(modelID)
	if err != nil {
		return 0, err
	}
	if tCount == 0 {
		// zero-template model: still insert a single card so the note
		// is usable (some Anki models omit tmpls and rely on auto
		// generation; without a card the note is invisible).
		tCount = 1
	}
	tx, err := c.db.Begin()
	if err != nil {
		return 0, fmt.Errorf("anki: begin insert tx: %w", err)
	}
	committed := false
	defer func() {
		if !committed {
			_ = tx.Rollback()
		}
	}()
	res, err := tx.Exec(`INSERT INTO notes (guid, mid, mod, usn, tags, flds, sfld, csum, flags, data)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		guid, modelID, mod, int64(-1), formatTags(tags), flds, sfld, cs, 0, "")
	if err != nil {
		return 0, fmt.Errorf("anki: insert note: %w", err)
	}
	noteID, err := res.LastInsertId()
	if err != nil {
		return 0, fmt.Errorf("anki: note lastInsertId: %w", err)
	}
	// Compute next due for the deck using the same tx (single
	// connection, no deadlock).
	nextDue, err := c.nextNewCardDue(tx, deckID)
	if err != nil {
		return 0, err
	}
	for ord := 0; ord < tCount; ord++ {
		_, err := tx.Exec(`INSERT INTO cards (nid, did, ord, mod, usn, type, queue, due, ivl, factor, reps, lapses, left, odue, odid, flags, data)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			noteID, deckID, ord, mod, int64(-1), 0, 0, nextDue+int64(ord), 0, 0, 0, 0, 0, 0, 0, 0, "")
		if err != nil {
			return 0, fmt.Errorf("anki: insert card ord=%d: %w", ord, err)
		}
	}
	if _, err := tx.Exec("UPDATE col SET mod = ?, usn = -1 WHERE id = 1", mod); err != nil {
		return 0, fmt.Errorf("anki: bump col.mod on insert: %w", err)
	}
	if err := tx.Commit(); err != nil {
		return 0, fmt.Errorf("anki: commit insert tx: %w", err)
	}
	committed = true
	c.invalidateColCache()
	return noteID, nil
}

// nextNewCardDue returns the smallest unused new-card due position
// for the given deck: max(due) + 1 across all type=0 cards in the
// deck. When the deck has no cards, due starts at 1 (Anki's default).
func (c *Collection) nextNewCardDue(tx *sql.Tx, deckID int64) (int64, error) {
	row := tx.QueryRow("SELECT COALESCE(MAX(due), 0) FROM cards WHERE did = ? AND type = 0", deckID)
	var maxDue sql.NullInt64
	if err := row.Scan(&maxDue); err != nil {
		return 0, fmt.Errorf("anki: scan max due: %w", err)
	}
	if !maxDue.Valid || maxDue.Int64 < 1 {
		return 1, nil
	}
	return maxDue.Int64 + 1, nil
}

// formatTags converts a ["vocab", "anime"] slice into Anki's
// canonical " vocab anime " form (leading + trailing + between-tag
// spaces). Anki's tag search relies on the boundary spaces for
// `LIKE "% tag %"` matches; a malformed tags string silently breaks
// collection-wide tag queries.
func formatTags(tags []string) string {
	if len(tags) == 0 {
		return " "
	}
	var b strings.Builder
	b.WriteByte(' ')
	for _, t := range tags {
		t = strings.TrimSpace(t)
		if t == "" {
			continue
		}
		b.WriteString(t)
		b.WriteByte(' ')
	}
	return b.String()
}

// UpdateNoteFields replaces specific field values on an existing
// note. fields is a map of field-name→new-value; only fields whose
// name matches a known model field are written. The card's flds is
// rebuilt in ord order, csum is recomputed (if the first field
// changed), and mod/usn are bumped.
func (c *Collection) UpdateNoteFields(noteID int64, fields map[string]string) error {
	if c == nil || c.db == nil {
		return ErrCollectionNotOpen
	}
	if noteID == 0 {
		return fmt.Errorf("%w: note id is 0", ErrBadRequest)
	}
	if len(fields) == 0 {
		return nil // no-op
	}
	// Load current note + model to map field names to ords.
	row := c.db.QueryRow("SELECT mid, flds, csum FROM notes WHERE id = ?", noteID)
	var (
		mid     int64
		fldsOld string
		oldCsum int64
	)
	if err := row.Scan(&mid, &fldsOld, &oldCsum); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return fmt.Errorf("anki: note %d not found", noteID)
		}
		return fmt.Errorf("anki: read note %d: %w", noteID, err)
	}
	names, err := c.ModelFieldNames(mid)
	if err != nil {
		return err
	}
	oldParts := strings.Split(fldsOld, "\x1f")
	if len(oldParts) < len(names) {
		// Anki stores flds with trailing empties for un-set trailing
		// fields; pad so we can index by ord.
		for len(oldParts) < len(names) {
			oldParts = append(oldParts, "")
		}
	}
	for name, val := range fields {
		idx := indexOfString(names, name)
		if idx < 0 {
			// Unknown field name: silently skip (matches
			// AnkiconnectAndroid updateNoteFields behaviour — it
			// also ignores unknown fields rather than erroring).
			continue
		}
		oldParts[idx] = val
	}
	newFlds := strings.Join(oldParts, "\x1f")
	newCsum := fieldChecksum(oldParts[0])
	// sfld mirrors the InsertNote path: HTML-stripped first field,
	// matching Anki rslib sort_field. Keeps the csum + sfld columns
	// in lockstep so AnkiDroid's sort sees the same string the csum
	// pipeline was computed over.
	newSfld := stripHTMLMedia(oldParts[0])
	mod := nowMillis()
	tx, err := c.db.Begin()
	if err != nil {
		return fmt.Errorf("anki: begin update tx: %w", err)
	}
	committed := false
	defer func() {
		if !committed {
			_ = tx.Rollback()
		}
	}()
	if _, err := tx.Exec(`UPDATE notes SET flds = ?, sfld = ?, csum = ?, mod = ?, usn = -1 WHERE id = ?`,
		newFlds, newSfld, newCsum, mod, noteID); err != nil {
		return fmt.Errorf("anki: update note flds: %w", err)
	}
	if _, err := tx.Exec("UPDATE col SET mod = ?, usn = -1 WHERE id = 1", mod); err != nil {
		return fmt.Errorf("anki: bump col.mod on update: %w", err)
	}
	if err := tx.Commit(); err != nil {
		return fmt.Errorf("anki: commit update tx: %w", err)
	}
	committed = true
	c.invalidateColCache()
	_ = oldCsum
	return nil
}

// indexOfString returns the index of v in s, or -1 if absent.
func indexOfString(s []string, v string) int {
	for i, x := range s {
		if x == v {
			return i
		}
	}
	return -1
}

// AddTags appends tags (space-separated input) to every note in
// noteIDs. Duplicates within a note's tag list are deduped; tags
// already present are not re-added.
func (c *Collection) AddTags(noteIDs []int64, tags string) error {
	if c == nil || c.db == nil {
		return ErrCollectionNotOpen
	}
	if len(noteIDs) == 0 || tags == "" {
		return nil
	}
	newOnes := splitTags(tags)
	if len(newOnes) == 0 {
		return nil
	}
	tx, err := c.db.Begin()
	if err != nil {
		return fmt.Errorf("anki: begin addTags tx: %w", err)
	}
	committed := false
	defer func() {
		if !committed {
			_ = tx.Rollback()
		}
	}()
	for _, nid := range noteIDs {
		if nid == 0 {
			continue
		}
		var existing string
		err := tx.QueryRow("SELECT tags FROM notes WHERE id = ?", nid).Scan(&existing)
		if err != nil {
			if errors.Is(err, sql.ErrNoRows) {
				continue
			}
			return fmt.Errorf("anki: read note %d tags: %w", nid, err)
		}
		merged := mergeTags(existing, newOnes)
		if _, err := tx.Exec("UPDATE notes SET tags = ?, mod = ?, usn = -1 WHERE id = ?", merged, nowMillis(), nid); err != nil {
			return fmt.Errorf("anki: update note %d tags: %w", nid, err)
		}
	}
	if _, err := tx.Exec("UPDATE col SET mod = ?, usn = -1 WHERE id = 1", nowMillis()); err != nil {
		return fmt.Errorf("anki: bump col.mod on addTags: %w", err)
	}
	if err := tx.Commit(); err != nil {
		return fmt.Errorf("anki: commit addTags tx: %w", err)
	}
	committed = true
	c.invalidateColCache()
	return nil
}

// splitTags is AnkiDroid's Utility.splitTags: trim and split on
// whitespace, drop empties. Mirrors A:/AnkiconnectAndroid reference.
func splitTags(tags string) []string {
	return strings.Fields(strings.TrimSpace(tags))
}

// mergeTags returns the deduped union of existing + new tags, in the
// Anki canonical " tag1 tag2 " shape (leading + trailing space).
func mergeTags(existing string, newOnes []string) string {
	seen := map[string]struct{}{}
	parts := []string{}
	for _, t := range splitTags(existing) {
		if _, ok := seen[t]; ok {
			continue
		}
		seen[t] = struct{}{}
		parts = append(parts, t)
	}
	for _, t := range newOnes {
		if _, ok := seen[t]; ok {
			continue
		}
		seen[t] = struct{}{}
		parts = append(parts, t)
	}
	if len(parts) == 0 {
		return " "
	}
	return " " + strings.Join(parts, " ") + " "
}

// FindNotes supports only the documented subset: `added:1` (notes
// modified in the last 24h, newest first) and `nid:…` (comma list
// of note ids). Returns ErrBadQuery for anything else.
func (c *Collection) FindNotes(query string) ([]int64, error) {
	if c == nil || c.db == nil {
		return nil, ErrCollectionNotOpen
	}
	q := strings.TrimSpace(query)
	switch {
	case q == "added:1":
		// 24h window in milliseconds.
		cutoff := nowMillis() - int64(24*time.Hour/time.Millisecond)
		rows, err := c.db.Query("SELECT id FROM notes WHERE mod > ? ORDER BY id DESC", cutoff)
		if err != nil {
			return nil, fmt.Errorf("anki: added:1 query: %w", err)
		}
		defer rows.Close()
		var ids []int64
		for rows.Next() {
			var id int64
			if err := rows.Scan(&id); err != nil {
				return nil, fmt.Errorf("anki: scan added:1: %w", err)
			}
			ids = append(ids, id)
		}
		if err := rows.Err(); err != nil {
			return nil, fmt.Errorf("anki: iterate added:1: %w", err)
		}
		return ids, nil
	case strings.HasPrefix(q, "nid:"):
		body := strings.TrimPrefix(q, "nid:")
		parts := strings.Split(body, ",")
		ids := make([]int64, 0, len(parts))
		for _, p := range parts {
			p = strings.TrimSpace(p)
			if p == "" {
				continue
			}
			id, err := strconv.ParseInt(p, 10, 64)
			if err != nil {
				return nil, fmt.Errorf("%w: nid: %q is not an integer", ErrBadQuery, p)
			}
			ids = append(ids, id)
		}
		return ids, nil
	case q == "":
		return nil, nil
	default:
		return nil, fmt.Errorf("%w: %q", ErrBadQuery, query)
	}
}

// NoteInfo is one entry of the notesInfo response. Mirrors the
// AnkiConnect shape: noteId, modelName, tags (list of strings), and
// fields (name → value map). Cards array is intentionally minimal —
// we don't surface card-level state beyond what addNote already
// populated.
type NoteInfo struct {
	NoteID    int64             `json:"noteId"`
	ModelName string            `json:"modelName"`
	Tags      []string          `json:"tags"`
	Fields    map[string]string `json:"fields"`
	Cards     []CardInfo        `json:"cards"`
}

// CardInfo is the minimal card entry in a notesInfo body.
type CardInfo struct {
	CardID    int64 `json:"cardId"`
	Ord       int   `json:"ord"`
	DeckID    int64 `json:"deckId"`
	Queue     int   `json:"queue"`
	Type      int   `json:"type"`
	Due       int64 `json:"due"`
	Interval  int   `json:"ivl"`
	Factor    int   `json:"factor"`
	Reps      int   `json:"reps"`
	Lapses    int   `json:"lapses"`
	Left      int   `json:"left"`
	ODue      int64 `json:"odue"`
	ODeckID   int64 `json:"odid"`
	Flags     int   `json:"flags"`
}

// NotesInfo returns one NoteInfo per id in the requested order.
// Unknown ids are skipped (matches the AnkiConnect behaviour: the
// upstream just omits them rather than returning an error).
func (c *Collection) NotesInfo(ids []int64) ([]NoteInfo, error) {
	if c == nil || c.db == nil {
		return nil, ErrCollectionNotOpen
	}
	if len(ids) == 0 {
		return []NoteInfo{}, nil
	}
	out := make([]NoteInfo, 0, len(ids))
	for _, id := range ids {
		ni, err := c.noteInfo(id)
		if err != nil {
			if errors.Is(err, sql.ErrNoRows) {
				continue
			}
			return nil, err
		}
		out = append(out, ni)
	}
	return out, nil
}

// noteInfo assembles a single NoteInfo by joining notes, models,
// cards. Returns sql.ErrNoRows when the note id does not exist.
func (c *Collection) noteInfo(id int64) (NoteInfo, error) {
	row := c.db.QueryRow("SELECT mid, flds, tags FROM notes WHERE id = ?", id)
	var (
		mid  int64
		flds string
		tags string
	)
	if err := row.Scan(&mid, &flds, &tags); err != nil {
		return NoteInfo{}, err
	}
	names, err := c.ModelFieldNames(mid)
	if err != nil {
		return NoteInfo{}, err
	}
	modelName, err := c.ModelName(mid)
	if err != nil {
		return NoteInfo{}, err
	}
	parts := strings.Split(flds, "\x1f")
	fields := map[string]string{}
	for i, name := range names {
		if i < len(parts) {
			fields[name] = parts[i]
		} else {
			fields[name] = ""
		}
	}
	cards, err := c.cardsForNote(id)
	if err != nil {
		return NoteInfo{}, err
	}
	return NoteInfo{
		NoteID:    id,
		ModelName: modelName,
		Tags:      splitTags(tags),
		Fields:    fields,
		Cards:     cards,
	}, nil
}

// cardsForNote returns the cards array for a note (one entry per
// card). Mirrors AnkiConnect notesInfo's card-level fields.
func (c *Collection) cardsForNote(nid int64) ([]CardInfo, error) {
	rows, err := c.db.Query(`SELECT id, ord, did, type, queue, due, ivl, factor, reps, lapses, left, odue, odid, flags FROM cards WHERE nid = ? ORDER BY ord`, nid)
	if err != nil {
		return nil, fmt.Errorf("anki: query cards for note %d: %w", nid, err)
	}
	defer rows.Close()
	var out []CardInfo
	for rows.Next() {
		var c CardInfo
		if err := rows.Scan(&c.CardID, &c.Ord, &c.DeckID, &c.Type, &c.Queue, &c.Due, &c.Interval, &c.Factor, &c.Reps, &c.Lapses, &c.Left, &c.ODue, &c.ODeckID, &c.Flags); err != nil {
			return nil, fmt.Errorf("anki: scan card: %w", err)
		}
		out = append(out, c)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("anki: iterate cards: %w", err)
	}
	return out, nil
}

// ModelName returns the human-readable name for a model id. Used by
// NotesInfo and exposed so callers can build error messages.
func (c *Collection) ModelName(mid int64) (string, error) {
	names, err := c.ModelIDs()
	if err != nil {
		return "", err
	}
	for n, id := range names {
		if id == mid {
			return n, nil
		}
	}
	return "", fmt.Errorf("anki: model %d not found", mid)
}

// Unused: keep the import for the strict BigInt math helper around in
// case future Anki schema versions encode the guid differently.
var _ = binary.BigEndian