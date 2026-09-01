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
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
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
// decks in the dedicated `decks` table. Models live in either the
// `models` table (Anki desktop / older AnkiDroid) or the `notetypes`
// table (AnkiDroid 2.16+, verified on real device 2026-09-01 — the
// real collection.anki2 also has empty col.decks / col.models JSON,
// so the legacy reader is useless there). Older schemas (schema 11)
// store decks AND models as JSON blobs inside the `col` table.
//
// The modern variant triggers when `decks` exists AND either
// `models` or `notetypes` exists. c.modernNotetypes records which
// of the two was found; the modern reader dispatches on it. The
// collection layer implements both readers and dispatches at
// runtime, so the bridge works on every supported AnkiDroid version.
// See `schemaVariant` for the autodetected branch and
// `c.modernNotetypes` for the per-table pick inside the modern branch.
//
// Lock coexistence with AnkiDroid (spec v4.4, 2026-09-01): the
// companion NEVER holds a write lock on the AnkiDroid-visible file.
// OpenCollection / OpenCollectionWithWorkDir open an IMMUTABLE read-
// only handle (DSN `immutable=1`) — SQLite skips all locking and
// change detection, so AnkiDroid can open its own RW handle at any
// time without the "Database Locked" dialog. The companion reads
// see a per-connection file snapshot; they are refreshed after every
// write via a close + reopen of the immutable handle.
//
// Writes (InsertNote / UpdateNoteFields / AddTags) go through
// WriteSession: each write does its own CopyIn → INSERT/UPDATE →
// checkpoint → CopyOut roundtrip against a work copy in the configured
// --anki-work-dir (a non-FUSE directory, e.g. the Termux app-private
// temp dir). The work copy holds the only write lock during the
// roundtrip; the AnkiDroid-visible file is touched only via plain
// `os.Create` (no fcntl locks), which on Linux/Android/FUSE never
// conflicts with AnkiDroid's SQLite handle. The FUSE roundtrip is
// still REQUIRED — Android/media + no APK + direct-SQLite
// semantics — but the roundtrip is per-write, not per-open, and
// the lock window is microseconds.
//
// Concurrency: WriteSession calls serialize on c.writeMu. Reads do
// not block writes (they use the immutable handle which has no
// locks). On a real device the roundtrip takes ~400ms; if a
// second action arrives during the roundtrip it queues, then runs
// sequentially. This avoids the "double-CopyIn" race that would
// otherwise lose one roundtrip's writes.
//
// busy_timeout on the work copy is 2000ms (short enough to surface
// the rare "AnkiDroid is writing" contention as a clear error,
// long enough to absorb normal scheduler hiccups). The immutable
// read handle uses busy_timeout=5000 like the pre-v4.4 default
// (irrelevant in practice because immutable=1 skips locking).
type Collection struct {
	db       *sql.DB
	path     string
	variant  schemaVariant
	colCache *colRow // cached single-row col data (parses lazily; invalidated on writes)

	// modernNotetypes is set by detectSchema when the modern variant
	// was selected and the dedicated note-type storage is the
	// `notetypes` table (AnkiDroid 2.16+) rather than the `models`
	// table (Anki desktop / older AnkiDroid). It drives the modern
	// reader dispatch in modelIDsFromTable / modelJSON. False when
	// variant is legacy. False on modern when only `models` exists.
	modernNotetypes bool

	// writePath is the --anki-work-dir captured at OpenCollection
	// time. Empty when the open path didn't include a work dir; in
	// that case WriteSession falls back to filepath.Dir(c.path) (a
	// normal-fs directory, on dev hosts; an Android/media
	// directory on device — which the roundtrip still needs because
	// direct SQLite writes against the FUSE mount lock up). The
	// companion's caller is expected to forward an explicit work
	// dir on Android (cmd/eizouden/main.go does this).
	writePath string

	// writeMu serializes WriteSession calls so concurrent actions
	// don't double-roundtrip. One WriteSession at a time per
	// Collection receiver.
	writeMu sync.Mutex

	// displayPath is the path Path() returns: the original
	// collection path captured at open time. Survives Close() and
	// refreshReadHandle() (which both clear path/db but not the
	// identity) so the operator-facing identity is stable.
	displayPath string
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
	// (Anki 2.1.28+ / schema 18). Models live in either `models` (Anki
	// desktop, older AnkiDroid) or `notetypes` (AnkiDroid 2.16+) —
	// the modern reader dispatch is driven by Collection.modernNotetypes.
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
// receiver is nil (or already Closed). The raw AnkiConnect handler
// maps this to an envelope with "anki collection not available".
var ErrCollectionNotOpen = errors.New("anki: collection not open")

// ErrUnsupportedSchema is returned when the opened database is missing
// the expected `notes` / `cards` / `col` tables. The raw AnkiConnect
// handler maps this to an envelope with a clear schema-version hint.
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
// collectionPath with an IMMUTABLE read-only handle (DSN
// `immutable=1`). The companion never holds a write lock on the
// AnkiDroid-visible file, so AnkiDroid can open its RW handle at
// any time without the "Database Locked" dialog (spec v4.4,
// 2026-09-01). Writes go through WriteSession instead.
//
// Schema detection (notes / cards / col tables present; legacy JSON
// vs modern dedicated tables), unicase collation registration, and
// the per-connection busy_timeout all happen here. Returns
// ErrUnsupportedSchema when the file is missing any required table.
//
// Thin wrapper over OpenCollectionWithWorkDir with an empty work
// dir (no per-write roundtrip fallback dir configured; WriteSession
// falls back to filepath.Dir(c.path) in that case, which on a normal
// fs is fine — the roundtrip copies src → dir/src → back).
func OpenCollection(collectionPath string) (*Collection, error) {
	return OpenCollectionWithWorkDir(collectionPath, "")
}

// OpenCollectionWithWorkDir is OpenCollection plus the
// --anki-work-dir forwarded for WriteSession's per-write roundtrip.
// The work dir must be on a non-FUSE filesystem (e.g. Termux
// app-private temp dir, a Linux dev-host tmp dir) so the SQLite
// write lock on the work copy doesn't conflict with AnkiDroid's
// handle on the source. On a normal fs the roundtrip still
// succeeds (the work copy is just a file copy in the same dir).
//
// On Android the typical setup is:
//
//	--anki-work-dir <Termux $TMPDIR>/eizouden-anki-work
//
// which resolves to a non-FUSE ext4 directory in Termux's app-
// private storage. cmd/eizouden/main.go picks the default when the
// flag is empty.
//
// As of v4.4 the OPEN path never falls back to a copy-work-writeback
// at open time (the previous v4.3 roundtrip-on-open fallback
// caused the Database Locked symptom because the source-side
// immutable handle never engaged). The v4.3 fallback is dead code:
// this signature preserves --anki-work-dir so the deployment
// surface is unchanged, but the work dir is now consumed by
// WriteSession per write.
func OpenCollectionWithWorkDir(collectionPath, workDir string) (*Collection, error) {
	return OpenCollectionWithWorkDirHooked(collectionPath, workDir, nil, nil)
}

// OpenCollectionWithWorkDirHooked is OpenCollectionWithWorkDir with
// two additional callbacks.
//
//   - onRecovered: reserved for the v4.3 stale-work-preservation
//     hook. v4.4 no longer preserves stale work copies — every
//     WriteSession is a fresh CopyIn on a unique work path, so
//     there is no recovery event to surface. The hook is kept on
//     the signature for source-compat (existing call sites still
//     compile) and in case a future hardening pass re-introduces
//     preservation semantics. nil = no-op.
//   - warnf: reserved for the v4.3 busy-locked-fallback notice.
//     v4.4's open path is always read-only immutable (no busy
//     fallback possible — immutable=1 skips locking). The hook is
//     kept on the signature for source-compat; nil = no-op.
//
// Thin wrapper over openCollectionDSN — the v4.3 fallback
// machinery (FuseRoundtrip at open time) is removed.
func OpenCollectionWithWorkDirHooked(collectionPath, workDir string, onRecovered func(string), warnf func(string, ...any)) (*Collection, error) {
	if collectionPath == "" {
		return nil, errors.New("anki: empty collection path")
	}
	_ = onRecovered
	_ = warnf
	c, err := openCollectionDSN(collectionPath)
	if err != nil {
		return nil, err
	}
	c.writePath = workDir
	return c, nil
}

// openCollectionDSN is the direct-open shared by OpenCollection /
// OpenCollectionWithWorkDir / OpenCollectionWithWorkDirHooked and
// by WriteSession's post-write refreshReadHandle. DSN is
// `immutable=1` (no locking, no change detection; spec v4.4) plus
// the bridge's foreign_keys pragma. Pool is capped at one
// connection (SQLite is single-writer; one is enough for our read
// usage and avoids spurious SQLITE_BUSY under concurrent
// reads). Schema detection runs after the immutable open succeeds.
func openCollectionDSN(collectionPath string) (*Collection, error) {
	// Register UNICASE BEFORE opening the connection. modernc binds
	// newly-registered collations to all subsequent sqlite-driver
	// connections; a connection opened before this call would
	// permanently lack UNICASE and every name-filtered query
	// against the real AnkiDroid 2.16+ schema would fail with
	// "no such collation sequence: unicase" — the on-device
	// bridge failure mode this layer exists to work around.
	// sync.Once inside ensureUnicaseCollation keeps the cost at
	// one register call for the process lifetime.
	ensureUnicaseCollation()
	dsn := "file:" + collectionPath + "?immutable=1&_pragma=foreign_keys(0)"
	db, err := sql.Open("sqlite", dsn)
	if err != nil {
		return nil, fmt.Errorf("anki: open collection: %w", err)
	}
	db.SetMaxOpenConns(1)
	if err := db.Ping(); err != nil {
		_ = db.Close()
		return nil, fmt.Errorf("anki: ping collection: %w", err)
	}
	c := &Collection{db: db, path: collectionPath, displayPath: collectionPath}
	if err := c.detectSchema(); err != nil {
		_ = db.Close()
		return nil, err
	}
	return c, nil
}

// openWorkCollection opens a work copy as a regular RW handle (no
// immutable=1 — we want full write semantics for the duration of a
// WriteSession). Busy timeout is 2000ms (shorter than the pre-v4.4
// default): a long busy wait during a write means AnkiDroid is
// writing its own WAL/footer and we should fail fast (the user
// gets a clear "AnkiDroid is open" envelope) instead of holding
// the roundtrip open for ~5s. The work copy lives on the configured
// --anki-work-dir (or filepath.Dir(src) when unset) so SQLite's
// locks don't conflict with AnkiDroid's RW handle on the source.
func openWorkCollection(workPath string) (*Collection, error) {
	ensureUnicaseCollation()
	dsn := "file:" + workPath + "?_pragma=busy_timeout(2000)&_pragma=foreign_keys(0)"
	db, err := sql.Open("sqlite", dsn)
	if err != nil {
		return nil, fmt.Errorf("anki: open work copy: %w", err)
	}
	db.SetMaxOpenConns(1)
	if err := db.Ping(); err != nil {
		_ = db.Close()
		return nil, fmt.Errorf("anki: ping work copy: %w", err)
	}
	c := &Collection{db: db, path: workPath, displayPath: workPath}
	if err := c.detectSchema(); err != nil {
		_ = db.Close()
		return nil, err
	}
	return c, nil
}

// isBusyLockError reports whether err is an SQLite busy/locked
// failure — kept for the v4.3 roundtrip-fallback classifier and
// for any future caller that wants to detect the AnkiDroid-locked
// scenario. v4.4's open path no longer uses it (immutable=1 skips
// locking so the open never busy-locks).
func isBusyLockError(err error) bool {
	if err == nil {
		return false
	}
	msg := err.Error()
	return strings.Contains(msg, "database is locked") || strings.Contains(msg, "SQLITE_BUSY")
}

// detectSchema verifies the required tables exist (notes, cards, col)
// and chooses the variant by checking which deck/model storage is
// present:
//
//   - modern: `decks` exists AND (`models` or `notetypes`) exists.
//     AnkiDroid 2.16+ uses `notetypes` (no `models` table) and
//     leaves col.decks / col.models as empty strings — verified on
//     real device 2026-09-01. Without the notetypes branch the
//     modern check fails, the collection falls into the legacy
//     reader, deckIDsFromCol parses "" as JSON and dies with
//     "unexpected end of JSON input", and every deck/model query
//     surfaces as "anki action failed".
//   - legacy: no dedicated decks table; col.decks / col.models JSON
//     are the only source (schema 11).
//
// modernNotetypes is set as a side effect so the modern reader
// dispatches to the right table on every subsequent call without
// re-probing sqlite_master.
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
	switch {
	case tables["decks"] && tables["notetypes"]:
		c.variant = schemaVariantModernTables
		c.modernNotetypes = true
	case tables["decks"] && tables["models"]:
		c.variant = schemaVariantModernTables
		c.modernNotetypes = false
	default:
		c.variant = schemaVariantLegacyJSON
		c.modernNotetypes = false
	}
	return nil
}

// Close releases the immutable read handle on the source file.
// v4.4 (2026-09-01) has no Close-time writeback: every write goes
// through WriteSession which copies src → work → src inline. The
// only thing Close has to do is release the SQLite handle. Safe to
// call multiple times; subsequent method calls on the receiver will
// return ErrCollectionNotOpen.
//
// Display path semantics are unchanged: Path() returns the src path
// captured at open time even after Close().
func (c *Collection) Close() error {
	if c == nil || c.db == nil {
		return nil
	}
	err := c.db.Close()
	c.db = nil
	c.colCache = nil
	if err != nil {
		return err
	}
	return nil
}

// WriteSession executes fn inside a per-write CopyIn → INSERT/UPDATE
// → checkpoint → CopyOut roundtrip against a work copy in the
// configured --anki-work-dir. The companion's read handle on the
// source is NOT touched during the roundtrip — AnkiDroid can keep
// its own RW handle open at all times.
//
// The fn callback receives a *Collection whose .db is the work
// copy (RW, single-connection). fn is expected to begin/commit its
// own SQL transaction via wc.db.Begin() / tx.Commit() exactly like
// the v4.3 internal API; the callback's contract is "return nil
// iff the writes are durably committed to the work copy; return
// non-nil to roll back". WriteSession then checkpoints + closes
// the work DB and copies the work main file (plus any non-empty
// sidecars) back to the source. The parent's col cache is
// invalidated on success so subsequent reads see the bumped
// mod/usn.
//
// Concurrency: WriteSession calls are serialized on c.writeMu.
// Concurrent addNote/updateNoteFields/addTags queue rather than
// double-roundtrip (which would lose one roundtrip's writes). On a
// normal fs a roundtrip is microseconds; on Android with an 18 MiB
// collection over FUSE it is ~400ms. The lock window on the
// AnkiDroid-visible file is the CopyIn (read) and CopyOut (write)
// steps only — these use plain os.Create / os.Open which on
// Linux/Android do not conflict with AnkiDroid's SQLite locks.
//
// Returns the callback's error if fn returned one, or any
// roundtrip-stage error from the CopyIn / checkpoint / close /
// CopyOut / refreshReadHandle path. fn's transaction is rolled
// back in this case; the work copy is removed; the source file is
// unchanged.
//
// Refresh: after a successful roundtrip the parent's immutable
// handle is closed + reopened so subsequent reads see the new
// file state. SQLite's immutable=1 disables per-connection change
// detection; reopening is the only safe way to invalidate the
// pager's view of the file.
func (c *Collection) WriteSession(fn func(wc *Collection) error) error {
	if c == nil {
		return ErrCollectionNotOpen
	}
	if c.path == "" {
		return ErrCollectionNotOpen
	}
	c.writeMu.Lock()
	defer c.writeMu.Unlock()

	workDir := c.writePath
	if workDir == "" {
		// Default: a sibling directory of src (so test fixtures in
		// t.TempDir() stay isolated) named <base>.work-<unix-ts>
		// so the work path never equals the source path (which
		// the roundtrip guard rejects). On production (Android or
		// a long-running dev host) this only fires for callers that
		// never set --anki-work-dir; the cmdline wiring always
		// forwards an explicit work dir.
		base := filepath.Base(c.path)
		workDir = filepath.Join(filepath.Dir(c.path), base+".work-"+strconv.FormatInt(time.Now().UnixNano(), 10))
	}
	rt := NewFuseRoundtrip(workDir)
	workPath, err := rt.CopyIn(c.path)
	if err != nil {
		return fmt.Errorf("anki: write session copy-in: %w", err)
	}
	// Best-effort cleanup if anything below fails. CopyOut on
	// success does its own removal; this path catches CopyIn-
	// succeeded-but-write-failed scenarios.
	success := false
	defer func() {
		if !success {
			_ = os.Remove(workPath)
			removeWorkSidecars(workPath)
		}
	}()

	wc, err := openWorkCollection(workPath)
	if err != nil {
		return fmt.Errorf("anki: write session open work: %w", err)
	}
	// Run the callback. Panics in fn are converted to errors so the
	// roundtrip's cleanup still runs (otherwise the work copy would
	// linger until the next CopyIn's stale-work detection kicked
	// in).
	var fnErr error
	func() {
		defer func() {
			if r := recover(); r != nil {
				fnErr = fmt.Errorf("anki: write session callback panic: %v", r)
			}
		}()
		fnErr = fn(wc)
	}()

	// Checkpoint + close the work DB unconditionally (the work
	// connection is the only one with write state, and a clean
	// close guarantees a coherent file for CopyOut). Errors here
	// are surfaced verbatim; the work copy is NOT copied back in
	// that case (a torn file on the source is worse than a no-op).
	if _, cerr := wc.db.Exec("PRAGMA wal_checkpoint(TRUNCATE)"); cerr != nil {
		_ = wc.db.Close()
		return fmt.Errorf("anki: write session checkpoint: %w", cerr)
	}
	if cerr := wc.db.Close(); cerr != nil {
		return fmt.Errorf("anki: write session close work: %w", cerr)
	}

	if fnErr != nil {
		return fnErr
	}

	// CopyOut writes the work main file (+ any non-empty sidecars)
	// back to the source. A CopyOut failure leaves the work copy
	// in place (FuseRoundtrip's own guarantee) and surfaces the
	// error so the operator sees it in the diagnostic log.
	if cerr := rt.CopyOut(workPath, c.path); cerr != nil {
		return fmt.Errorf("anki: write session copy-out: %w", cerr)
	}
	success = true

	// Refresh the parent's immutable read handle so subsequent
	// reads see the new file state (SQLite's immutable=1 disables
	// per-connection change detection; close + reopen is the
	// canonical way to pick up writes).
	if cerr := c.refreshReadHandle(); cerr != nil {
		return fmt.Errorf("anki: write session refresh: %w", cerr)
	}
	c.invalidateColCache()
	return nil
}

// refreshReadHandle closes + reopens the immutable read handle on
// the source file. Called after every successful WriteSession so
// subsequent reads see the post-CopyOut file state. SQLite's
// immutable=1 path disables change detection, so an already-open
// connection would return the pre-write snapshot indefinitely; a
// close + reopen is the only safe refresh.
//
// Schema detection runs again because openCollectionDSN returns a
// fresh Collection with its own detectSchema call. The result is
// the same (the schema doesn't change between writes); the cost
// is one extra sqlite_master query per write (microseconds).
func (c *Collection) refreshReadHandle() error {
	if c == nil || c.path == "" || c.db == nil {
		return ErrCollectionNotOpen
	}
	if c.db != nil {
		_ = c.db.Close()
		c.db = nil
	}
	fresh, err := openCollectionDSN(c.path)
	if err != nil {
		return err
	}
	c.db = fresh.db
	c.variant = fresh.variant
	c.modernNotetypes = fresh.modernNotetypes
	c.colCache = nil // always invalidate on reopen
	return nil
}

// WritePath returns the configured --anki-work-dir (empty when
// none was set at open time). Exposed for tests that want to
// verify the open-time capture and for diagnostics.
func (c *Collection) WritePath() string {
	if c == nil {
		return ""
	}
	return c.writePath
}

// Path returns the collection file path the receiver was opened on.
// This is the ORIGINAL src path captured at open time (never a work
// copy path, even right after a WriteSession), and it remains
// available after Close(). Safe to expose in the terminal handoff
// line (the path is the same one the operator passed via
// --anki-collection; not a secret).
func (c *Collection) Path() string {
	if c == nil {
		return ""
	}
	if c.displayPath != "" {
		return c.displayPath
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
// AnkiDroid sees a fresh "modified" timestamp). v4.4 routes the
// bump through WriteSession so the work-copy / writeback / read-
// refresh dance happens exactly the same way as a normal Insert /
// Update / AddTags — a single tiny transaction that bumps col.mod
// and lands durably in the source file.
func (c *Collection) CollectionModBump() error {
	if c == nil || c.path == "" {
		return ErrCollectionNotOpen
	}
	mod := nowMillis()
	return c.WriteSession(func(wc *Collection) error {
		tx, err := wc.db.Begin()
		if err != nil {
			return fmt.Errorf("anki: begin bump tx: %w", err)
		}
		committed := false
		defer func() {
			if !committed {
				_ = tx.Rollback()
			}
		}()
		if _, err := tx.Exec("UPDATE col SET mod = ? WHERE id = 1", mod); err != nil {
			return fmt.Errorf("anki: bump col.mod: %w", err)
		}
		if err := tx.Commit(); err != nil {
			return fmt.Errorf("anki: commit bump tx: %w", err)
		}
		committed = true
		return nil
	})
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

// modelIDsFromTable reads the modern note-type table. On Anki
// desktop / older AnkiDroid that's `models`; on AnkiDroid 2.16+
// it's `notetypes` (no `models` table — verified on real device
// 2026-09-01). c.modernNotetypes picks the table at detect time so
// this method issues exactly one query.
func (c *Collection) modelIDsFromTable() (map[string]int64, error) {
	table := "models"
	if c.modernNotetypes {
		table = "notetypes"
	}
	rows, err := c.db.Query("SELECT id, name FROM " + table)
	if err != nil {
		return nil, fmt.Errorf("anki: query %s: %w", table, err)
	}
	defer rows.Close()
	out := map[string]int64{}
	for rows.Next() {
		var id int64
		var name sql.NullString
		if err := rows.Scan(&id, &name); err != nil {
			return nil, fmt.Errorf("anki: scan %s: %w", table, err)
		}
		if !name.Valid || name.String == "" {
			continue
		}
		out[name.String] = id
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("anki: iterate %s: %w", table, err)
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
//
// On the modern branch with AnkiDroid 2.16+ the dedicated table is
// `notetypes` (no `models` table). Its layout is split: the `fields`
// column holds the flds JSON array and the `templates` column holds
// the tmpls JSON array — there is no single JSON column mirroring
// col.models. We rebuild a synthetic {"flds": [...], "tmpls": [...]}
// object from those two columns so the existing
// ModelFieldNames / ModelTemplateCount parsers (which only read flds
// and tmpls) work unchanged. This is intentionally narrow: we do not
// attempt to reconstruct the full Anki model object (css, latexPre,
// sortf, …) because nothing in the bridge reads those fields — see
// ModelFieldNames / ModelTemplateCount for the supported surface.
func (c *Collection) modelJSON(mid int64) (json.RawMessage, error) {
	if c == nil || c.db == nil {
		return nil, ErrCollectionNotOpen
	}
	switch c.variant {
	case schemaVariantModernTables:
		if c.modernNotetypes {
			return c.modelJSONFromNotetypes(mid)
		}
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

// modelJSONFromNotetypes is the no-op fallback used by
// ModelFieldNames / ModelTemplateCount on the AnkiDroid 2.16+
// branch: the real device schema v18 stores flds/tmpls data in
// SEPARATE tables (`fields` and `templates`), NOT inside
// `notetypes.config`. The `notetypes.config` blob is a Protobuf-
// encoded Notetype.Config (containing css, latexPre, latexPost,
// latex_svg, sort_field_idx, kind, reqs, original_stock_kind,
// original_id, other) which the bridge does NOT need to decode.
//
// Field names come from the `fields` table (read by
// ModelFieldNames via fieldNamesFromNotetypes). Template count
// comes from the `templates` table (read by ModelTemplateCount
// via templateCountFromNotetypes). The two-table model is a clean
// fit for what the bridge needs; trying to decode the Protobuf
// config blob would just introduce a protobuf dependency to
// extract data that is sitting in adjacent columns.
//
// This function exists as a vestige of the earlier "decode the
// config JSON" attempt and is left in place so callers that go
// through modelJSON (none, after the dispatch is in
// ModelFieldNames / ModelTemplateCount) keep a clear error path.
// It returns an error describing the proper access path so any
// future caller that mistakenly falls into the modelJSON funnel
// gets a precise message rather than a confusing parse failure.
func (c *Collection) modelJSONFromNotetypes(mid int64) (json.RawMessage, error) {
	return nil, fmt.Errorf("anki: modelJSON not implemented for notetypes table on AnkiDroid 2.16+; use ModelFieldNames (→ fields table) / ModelTemplateCount (→ templates table) directly")
}

// ModelFieldNames returns the field-name list for the model in
// ord order — exactly what AnkiConnect's modelFieldNames returns.
// The flds array is the source of truth; we read names by ordinal.
//
// On the AnkiDroid 2.16+ (notetypes) schema the field names live
// in a separate `fields` table (one row per ord, primary key
// (ntid, ord)) — verified against the authoritative
// ankitects/anki rslib/src/storage/upgrades/schema15_upgrade.sql.
// `fields.name` is declared `COLLATE unicase`, so the SELECT must
// run on a connection with UNICASE registered (the production
// openCollectionDSN registers it before sql.Open). The bridge
// does NOT decode the Protobuf blob in `notetypes.config` — it
// only reads the textual `name` column from `fields`.
func (c *Collection) ModelFieldNames(mid int64) ([]string, error) {
	if c == nil || c.db == nil {
		return nil, ErrCollectionNotOpen
	}
	if c.modernNotetypes {
		return c.fieldNamesFromNotetypes(mid)
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

// fieldNamesFromNotetypes reads the field-name list directly from
// the AnkiDroid 2.16+ `fields` table. The PK (ntid, ord) is the
// sort key, so an ORDER BY ord makes the result stable without a
// secondary index. Returns nil + ErrCollectionNotOpen-style
// errors if the receiver is closed.
func (c *Collection) fieldNamesFromNotetypes(mid int64) ([]string, error) {
	if c == nil || c.db == nil {
		return nil, ErrCollectionNotOpen
	}
	rows, err := c.db.Query("SELECT name FROM fields WHERE ntid = ? ORDER BY ord", mid)
	if err != nil {
		return nil, fmt.Errorf("anki: query fields: %w", err)
	}
	defer rows.Close()
	var names []string
	for rows.Next() {
		var name sql.NullString
		if err := rows.Scan(&name); err != nil {
			return nil, fmt.Errorf("anki: scan fields: %w", err)
		}
		if name.Valid && name.String != "" {
			names = append(names, name.String)
		}
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("anki: iterate fields: %w", err)
	}
	return names, nil
}

// ModelTemplateCount returns the count of tmpls entries for the
// model. One template = one card; InsertNote creates len(tmpls)
// cards.
//
// On the AnkiDroid 2.16+ (notetypes) schema the templates live
// in a separate `templates` table keyed by (ntid, ord). COUNT(*)
// doesn't touch the `name` column, so the COUNT path itself does
// not depend on UNICASE registration — but the table creation
// (which uses `name TEXT COLLATE unicase` on the real device)
// does, so the connection still needs UNICASE registered before
// the table exists. The legacy / modern-with-models-table paths
// keep reading the JSON `tmpls` array length.
func (c *Collection) ModelTemplateCount(mid int64) (int, error) {
	if c == nil || c.db == nil {
		return 0, ErrCollectionNotOpen
	}
	if c.modernNotetypes {
		return c.templateCountFromNotetypes(mid)
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

// templateCountFromNotetypes reads the template count directly
// from the AnkiDroid 2.16+ `templates` table. COUNT(*) avoids the
// `name` column entirely, so this path is collation-agnostic at
// query time (the table-creation path's UNICASE requirement is
// satisfied upstream by openCollectionDSN's
// ensureUnicaseCollation call).
func (c *Collection) templateCountFromNotetypes(mid int64) (int, error) {
	if c == nil || c.db == nil {
		return 0, ErrCollectionNotOpen
	}
	var n int
	if err := c.db.QueryRow("SELECT COUNT(*) FROM templates WHERE ntid = ?", mid).Scan(&n); err != nil {
		return 0, fmt.Errorf("anki: count templates: %w", err)
	}
	return n, nil
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
	if c == nil || c.path == "" {
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
	// Resolve template count BEFORE opening the WriteSession: the
	// read goes through the immutable handle and avoids wasting a
	// roundtrip on a model id that doesn't exist. The template count
	// is identical between the source and the work copy at CopyIn
	// time (the work copy is a fresh src snapshot).
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
	// Captured by the closure below so the post-session return can
	// surface the new note id.
	var noteID int64
	err = c.WriteSession(func(wc *Collection) error {
		tx, err := wc.db.Begin()
		if err != nil {
			return fmt.Errorf("anki: begin insert tx: %w", err)
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
			return fmt.Errorf("anki: insert note: %w", err)
		}
		nid, err := res.LastInsertId()
		if err != nil {
			return fmt.Errorf("anki: note lastInsertId: %w", err)
		}
		noteID = nid
		// Compute next due for the deck using the same tx (single
		// connection on the work copy, no deadlock).
		nextDue, err := wc.nextNewCardDue(tx, deckID)
		if err != nil {
			return err
		}
		for ord := 0; ord < tCount; ord++ {
			_, err := tx.Exec(`INSERT INTO cards (nid, did, ord, mod, usn, type, queue, due, ivl, factor, reps, lapses, left, odue, odid, flags, data)
				VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
				nid, deckID, ord, mod, int64(-1), 0, 0, nextDue+int64(ord), 0, 0, 0, 0, 0, 0, 0, 0, "")
			if err != nil {
				return fmt.Errorf("anki: insert card ord=%d: %w", ord, err)
			}
		}
		if _, err := tx.Exec("UPDATE col SET mod = ?, usn = -1 WHERE id = 1", mod); err != nil {
			return fmt.Errorf("anki: bump col.mod on insert: %w", err)
		}
		if err := tx.Commit(); err != nil {
			return fmt.Errorf("anki: commit insert tx: %w", err)
		}
		committed = true
		return nil
	})
	if err != nil {
		return 0, err
	}
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
	if c == nil || c.path == "" {
		return ErrCollectionNotOpen
	}
	if noteID == 0 {
		return fmt.Errorf("%w: note id is 0", ErrBadRequest)
	}
	if len(fields) == 0 {
		return nil // no-op
	}
	// Load current note + model to map field names to ords. Reads
	// go through the immutable handle — the source file is the
	// source of truth, and AnkiDroid may have edited the note
	// between our read and the write roundtrip. The next WriteSession
	// will refreshReadHandle, so a TOCTOU window is bounded to
	// ~400ms; AnkiDroid's own writer waits on SQLite's locking
	// the same way ours does.
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
	_ = oldCsum
	return c.WriteSession(func(wc *Collection) error {
		tx, err := wc.db.Begin()
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
		return nil
	})
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
	if c == nil || c.path == "" {
		return ErrCollectionNotOpen
	}
	if len(noteIDs) == 0 || tags == "" {
		return nil
	}
	newOnes := splitTags(tags)
	if len(newOnes) == 0 {
		return nil
	}
	return c.WriteSession(func(wc *Collection) error {
		tx, err := wc.db.Begin()
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
			// Read the existing tags from the WORK copy (not the
			// parent's immutable handle) so we merge against the
			// freshest state available inside the roundtrip. A
			// concurrent AnkiDroid edit would be reflected on the
			// work copy because CopyIn mirrors src -wal / -shm.
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
		return nil
	})
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

// FindNotes supports the documented subset:
//   - "added:1"            → notes modified in the last 24h
//   - "nid:<id>,<id>..."    → explicit note-id list
//   - '"front:<value>"'     → substring match on the first field
//                            (Yomitan's _fieldsToQuery produces
//                            this exact wire shape for the duplicate-
//                            note popup flow). The outer / inner
//                            double-quotes are optional; the value
//                            is matched as a case-sensitive LIKE
//                            (LIKE %<value>% with %/_ escaped by
//                            doubling) against notes.flds' first
//                            segment (text up to the first \x1f).
//
// Anything else returns ErrBadQuery — mirroring the
// "we won't pretend to support something we can't" stance taken by
// the original FindNotes. Upstream AnkiconnectAndroid forwards
// arbitrary queries into AnkiDroid's provider, but we run an
// in-process implementation and refuse to silently drop the floor
// on a parse failure.
//
// Yomitan's _fieldsToQuery emits `${key.toLowerCase()}:${value}`
// wrapped in double quotes ("front:cat"). For real AnkiConnect the
// matching is across the FIRST field by convention; we replicate
// that by reading the flds column up to its first \x1f separator
// (Anki joins fields with \x1f in the notes.flds storage).
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
	case isFrontQuery(q):
		value := frontQueryValue(q)
		if value == "" {
			return nil, fmt.Errorf("%w: empty front: value in %q", ErrBadQuery, query)
		}
		// Escape SQL LIKE metacharacters in the user-supplied value:
		// % and _ are wildcards in SQLite's LIKE; doubling is the
		// canonical escape. The pattern is "%" + escaped + "%" so we
		// substring-match within the flds string (which is "<f1>\x1f
		// <f2>\x1f..."). fldr is read up to the first \x1f so we
		// only match the first field, matching AnkiConnect's
		// documented front: semantics.
		pattern := "%" + escapeLike(value) + "%"
		rows, err := c.db.Query(
			"SELECT id FROM notes WHERE substr(flds, 1, instr(flds, char(31)) - 1) LIKE ? ESCAPE '\\' ORDER BY id",
			pattern)
		if err != nil {
			return nil, fmt.Errorf("anki: front: query: %w", err)
		}
		defer rows.Close()
		var ids []int64
		for rows.Next() {
			var id int64
			if err := rows.Scan(&id); err != nil {
				return nil, fmt.Errorf("anki: scan front: %w", err)
			}
			ids = append(ids, id)
		}
		if err := rows.Err(); err != nil {
			return nil, fmt.Errorf("anki: iterate front: %w", err)
		}
		return ids, nil
	case q == "":
		return nil, nil
	default:
		return nil, fmt.Errorf("%w: %q", ErrBadQuery, query)
	}
}

// isFrontQuery reports whether q is a Yomitan/AnkiConnect-style
// first-field query. Accepts both the bare `front:value` and the
// quote-wrapped `"front:value"` shape Yomitan's _fieldsToQuery
// produces (the outer double-quotes are part of the query string,
// not string-quoting on our side). Case-insensitive on the field
// name prefix.
func isFrontQuery(q string) bool {
	q = strings.TrimSpace(q)
	if len(q) >= 2 && q[0] == '"' && q[len(q)-1] == '"' {
		q = q[1 : len(q)-1]
	}
	return len(q) >= len("front:") && strings.EqualFold(q[0:len("front:")], "front:")
}

// frontQueryValue extracts the value half of a front: query. The
// value may itself be wrapped in double-quotes (Yomitan does not
// quote the value, but real AnkiConnect does in some clients).
// Returns the unquoted value.
func frontQueryValue(q string) string {
	q = strings.TrimSpace(q)
	if len(q) >= 2 && q[0] == '"' && q[len(q)-1] == '"' {
		q = q[1 : len(q)-1]
	}
	v := q
	if len(v) >= len("front:") && strings.EqualFold(v[0:len("front:")], "front:") {
		v = v[len("front:"):]
	}
	if len(v) >= 2 && v[0] == '"' && v[len(v)-1] == '"' {
		v = v[1 : len(v)-1]
	}
	return v
}

// escapeLike doubles % and _ so the user-supplied substring is
// matched literally as a LIKE pattern. SQLite LIKE recognizes
// these two metacharacters; ESCAPE '\\' in the query makes the
// backslash the escape char. We also escape the backslash itself
// (otherwise an embedded `\` in user input would consume the next
// char, which then wouldn't escape the meta).
func escapeLike(s string) string {
	r := strings.NewReplacer(`\`, `\\`, `%`, `\%`, `_`, `\_`)
	return r.Replace(s)
}

// NoteInfo is one entry of the notesInfo response. Mirrors the
// AnkiConnect wire shape: noteId, modelName, tags (list of strings),
// fields (name → value map), and cards (flat list of cardId
// integers — NOT an array of objects). Yomitan's _normalizeNoteInfoArray
// runs _normalizeArray(result.cards, -1, 'number'), which throws
// if each slot isn't a number; the upstream AnkiConnect contract is
// `cards: [cardId, ...]`. Per-card state (deckId, ord, queue, …)
// lives on the dedicated cardsInfo action — callers that need it
// issue cardsInfo with the flat cardIds from this field and zip the
// result by index (this is exactly Yomitan's _notesCardsInfo flow).
type NoteInfo struct {
	NoteID    int64             `json:"noteId"`
	ModelName string            `json:"modelName"`
	Tags      []string          `json:"tags"`
	Fields    map[string]string `json:"fields"`
	Cards     []int64           `json:"cards"`
}

// CardInfo is the card-level entry used in two surfaces:
//   - as the `cards` array element of a notesInfo response
//   - as the top-level element of a cardsInfo response
//
// The JSON tags mirror the AnkiConnect wire contract (lowercase,
// camelCase). Yomitan's notesInfo consumer reads `cards` as a flat
// `number[]` (just cardIds) and never touches the per-card fields,
// so widening this struct to add NoteID doesn't break notesInfo.
// Yomitan's cardsInfo consumer normalises a narrower shape (it
// reads `cardId` / `note` / `flags` / `queue`) — we emit the full
// AnkiConnect field set so other clients (Entei, asbplayer) get
// the documented shape and the wire remains forward-compatible.
type CardInfo struct {
	CardID   int64  `json:"cardId"`
	NoteID   int64  `json:"noteId"`
	DeckID   int64  `json:"deckId"`
	Ord      int    `json:"ord"`
	Queue    int    `json:"queue"`
	Type     int    `json:"type"`
	Due      int64  `json:"due"`
	IVL      int    `json:"ivl"`
	Factor   int    `json:"factor"`
	Reps     int    `json:"reps"`
	Lapses   int    `json:"lapses"`
	Left     int    `json:"left"`
	ODue     int64  `json:"odue"`
	ODID     int64  `json:"odid"`
	Flags    int    `json:"flags"`
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
	cards, err := c.CardsForNote(id)
	if err != nil {
		return NoteInfo{}, err
	}
	// Reduce CardInfo objects to flat cardIds — the AnkiConnect
	// notesInfo contract is `cards: [cardId, ...]`, not objects.
	// Per-card state is fetched separately via cardsInfo.
	cardIDs := make([]int64, len(cards))
	for i, ci := range cards {
		cardIDs[i] = ci.CardID
	}
	return NoteInfo{
		NoteID:    id,
		ModelName: modelName,
		Tags:      splitTags(tags),
		Fields:    fields,
		Cards:     cardIDs,
	}, nil
}

// CardsForNote returns the cards array for a note (one entry per
// card). Mirrors AnkiConnect notesInfo's card-level fields.
func (c *Collection) CardsForNote(nid int64) ([]CardInfo, error) {
	rows, err := c.db.Query(`SELECT id, nid, ord, did, type, queue, due, ivl, factor, reps, lapses, left, odue, odid, flags FROM cards WHERE nid = ? ORDER BY ord`, nid)
	if err != nil {
		return nil, fmt.Errorf("anki: query cards for note %d: %w", nid, err)
	}
	defer rows.Close()
	var out []CardInfo
	for rows.Next() {
		var c CardInfo
		if err := rows.Scan(&c.CardID, &c.NoteID, &c.Ord, &c.DeckID, &c.Type, &c.Queue, &c.Due, &c.IVL, &c.Factor, &c.Reps, &c.Lapses, &c.Left, &c.ODue, &c.ODID, &c.Flags); err != nil {
			return nil, fmt.Errorf("anki: scan card: %w", err)
		}
		out = append(out, c)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("anki: iterate cards: %w", err)
	}
	return out, nil
}

// CardsInfo returns one CardInfo per requested card id. The order
// of the result matches the input order (callers like Yomitan's
// _notesCardsInfo depend on positional alignment: it zips
// cardsInfo[i].noteId against notesInfo[i].noteId to associate
// card info with note info). Unknown card ids are skipped (matches
// the AnkiConnect behaviour: the upstream omits missing ids rather
// than returning an error).
//
// Yomitan's _notesCardsInfo calls cardsInfo as a top-level AnkiConnect
// action (not via multi) — see
// A:/yomitan/ext/js/comm/anki-connect.js cardsInfo() (around line 198).
// The response is a JSON array of CardInfo objects; the client reads
// `cardId` and `noteId` per element and zips against the notesInfo
// results.
func (c *Collection) CardsInfo(ids []int64) ([]CardInfo, error) {
	if c == nil || c.db == nil {
		return nil, ErrCollectionNotOpen
	}
	if len(ids) == 0 {
		return []CardInfo{}, nil
	}
	// Issue one query per id so the input order is preserved on the
	// wire (a single SELECT IN(...) would require re-sorting on the
	// caller side). For a typical Yomitan batch (1–10 cards) this is
	// microseconds vs. a single ORDER BY FIELD(...) roundtrip.
	out := make([]CardInfo, 0, len(ids))
	for _, id := range ids {
		row := c.db.QueryRow(`SELECT id, nid, ord, did, type, queue, due, ivl, factor, reps, lapses, left, odue, odid, flags FROM cards WHERE id = ?`, id)
		var ci CardInfo
		if err := row.Scan(&ci.CardID, &ci.NoteID, &ci.Ord, &ci.DeckID, &ci.Type, &ci.Queue, &ci.Due, &ci.IVL, &ci.Factor, &ci.Reps, &ci.Lapses, &ci.Left, &ci.ODue, &ci.ODID, &ci.Flags); err != nil {
			if errors.Is(err, sql.ErrNoRows) {
				continue
			}
			return nil, fmt.Errorf("anki: scan card %d: %w", id, err)
		}
		out = append(out, ci)
	}
	return out, nil
}

// CardIDsForNoteIDs returns the flat list of card IDs belonging to
// the given note ids. Order is deterministic: for each input note
// the cards are returned in ord ASC, and notes are visited in the
// order they appear in noteIDs. Unknown note ids are skipped
// silently (matches the AnkiConnect-style "missing ids are omitted"
// convention used elsewhere in this file).
//
// Used by the guiBrowse dispatcher to resolve a FindNotes result
// (which is note ids) into the card ids that AnkiConnect's
// documented guiBrowse contract returns. Yomitan's guiBrowseNote
// path passes a single nid and never reaches this branch (it takes
// the dedicated nid: query path); this helper is for the
// general-query branch (added:1, front:…, arbitrary FindNotes
// queries).
//
// Implementation: one SELECT per note id so the result order
// tracks the input order exactly. A single SELECT ... WHERE nid IN
// (...) would require re-sorting on the caller side; the per-id
// loop is microseconds for a typical Yomitan batch (1-10 notes).
func (c *Collection) CardIDsForNoteIDs(noteIDs []int64) ([]int64, error) {
	if c == nil || c.db == nil {
		return nil, ErrCollectionNotOpen
	}
	if len(noteIDs) == 0 {
		return []int64{}, nil
	}
	out := make([]int64, 0, len(noteIDs))
	for _, nid := range noteIDs {
		if nid == 0 {
			continue
		}
		rows, err := c.db.Query("SELECT id FROM cards WHERE nid = ? ORDER BY ord", nid)
		if err != nil {
			return nil, fmt.Errorf("anki: query cards for note %d: %w", nid, err)
		}
		for rows.Next() {
			var id int64
			if err := rows.Scan(&id); err != nil {
				rows.Close()
				return nil, fmt.Errorf("anki: scan card for note %d: %w", nid, err)
			}
			out = append(out, id)
		}
		if err := rows.Err(); err != nil {
			rows.Close()
			return nil, fmt.Errorf("anki: iterate cards for note %d: %w", nid, err)
		}
		rows.Close()
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