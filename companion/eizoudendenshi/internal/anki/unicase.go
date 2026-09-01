package anki

import (
	"strings"
	"sync"

	"modernc.org/sqlite"
)

// unicaseRegistered guards a one-shot registration of the UNICASE
// collation the Anki schema relies on. AnkiDroid's collection.anki2
// (verified on real device 2026-09-01) declares
//
//	notetypes(name TEXT COLLATE UNICASE, …)
//	decks(name TEXT COLLATE UNICASE, …)
//
// and modernc.org/sqlite does NOT register UNICASE itself, so a bare
// SELECT … WHERE name = ? (or ORDER BY name) fails with
//
//	no such collation sequence: unicase
//
// — the exact error the on-device Entei addNote path surfaces.
//
// The fix is to register a case-insensitive comparator under the name
// UNICASE before any SQLite connection is opened. modernc's
// RegisterCollationUtf8 is documented to make the collation available
// to all NEW connections opened by the driver named "sqlite" AFTER
// registration; the package init() ordering takes care of the rest
// (callers' sql.Open hits the driver which already has the collation
// installed).
//
// sync.Once guards against a redundant call path (e.g. tests that
// invoke OpenCollection directly) double-registering. modernc is
// happy to re-register the same name, but sync.Once keeps the
// behavior deterministic across the test binary and the production
// binary without paying for a re-register probe every connection.
var unicaseRegistered sync.Once

// ensureUnicaseCollation registers the UNICASE collation exactly once.
// Safe to call from any goroutine. MUST run before any call to
// sql.Open("sqlite", …) — the companion calls it at the top of
// openCollectionDSN, the only entry point that opens SQLite
// connections in this package.
//
// The implementation is a reasonable ICU-style case-insensitive
// comparator: strings are case-folded with strings.ToLower
// (Unicode-lowercase, not ASCII), then compared. The folded
// comparison is deterministic for any fixed pair
// (strings.ToLower is pure), transitive (lower(X) == lower(Y) iff
// lower(Y) == lower(X)), and order-stable (lower(A) < lower(B) iff
// lower(B) > lower(A)).
//
// Deviations from real Anki/ICU UNICASE: no diacritic folding and
// no Turkish-i rule. Neither matters for the bridge surface
// (deck names "Default", model names "Basic" / "Cloze", etc. — short
// user-typed ASCII strings). Anki's own libanki/rslib uses a
// similar case-folded comparator for the sqlite UNICASE binding;
// this is the same approach without pulling in
// golang.org/x/text/collate. If a future caller needs true
// locale-aware folding, replace the body with a
// collate.New(language.Und).CompareString call — the rest of the
// plumbing stays identical.
func ensureUnicaseCollation() {
	unicaseRegistered.Do(func() {
		// _ = on purpose: modernc.RegisterCollationUtf8 only errors
		// when the named driver is not registered. The blank import
		// in collection.go guarantees it is, so this never errors in
		// practice. If it ever does, the error is silently swallowed
		// — the next query will surface the original "no such
		// collation sequence: unicase" with a clear driver-level
		// message; nothing the bridge can do better.
		_ = sqlite.RegisterCollationUtf8("UNICASE", func(l, r string) int {
			fl, fr := strings.ToLower(l), strings.ToLower(r)
			switch {
			case fl == fr:
				return 0
			case fl < fr:
				return -1
			default:
				return 1
			}
		})
	})
}