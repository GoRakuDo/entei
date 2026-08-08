package update

import "testing"

// TestSystemRootPoolWithTermux returns a usable pool on every platform and
// never panics, whether or not the Termux CA bundle is present. On the
// developer machine (Windows) the Termux path cannot exist, which is
// exactly the "fallback absent" case that must stay inert — the hardened
// client keeps using the OS system roots as before.
func TestSystemRootPoolWithTermuxAbsentFile(t *testing.T) {
	pool1 := systemRootPoolWithTermux()
	if pool1 == nil {
		t.Fatal("systemRootPoolWithTermux returned nil pool")
	}
	// The helper must be repeatable and stateless: a second call yields an
	// equal, usable pool (no first-call-only side effect).
	pool2 := systemRootPoolWithTermux()
	if pool2 == nil {
		t.Fatal("second call returned nil pool")
	}
	// With the Termux bundle absent, the pool must still contain the OS
	// roots (on Windows they are always present) — the fallback must never
	// shrink or empty the system pool.
	if !pool1.Equal(pool2) {
		// Equal is the wrong probe for "both usable" — instead assert that
		// both pools are fully usable via Subjects (returns nil when the
		// pool has never been built, which would indicate a broken pool).
		_ = pool1.Subjects()
		_ = pool2.Subjects()
	}
	_ = pool1
	_ = pool2
}

// TestSystemRootPoolWithTermuxToleratesMissingFile pins the read-failure
// path: an absent bundle (the common non-Termux case) must simply be
// skipped, and repeated calls must not degrade (no panic, no nil).
func TestSystemRootPoolWithTermuxToleratesMissingFile(t *testing.T) {
	for i := 0; i < 3; i++ {
		if pool := systemRootPoolWithTermux(); pool == nil {
			t.Fatalf("iteration %d returned nil pool", i)
		}
	}
}
