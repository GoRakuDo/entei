/**
 * ED-2E internal companion fixture entry (dev/QA only).
 * ---------------------------------------------------------------------------
 * Deliberately explicit, internal, testable entry path that begins a known
 * companion fixture session with the page-memory pairing token. It is
 * NEVER wired to user-facing UI (Magnet / YouTube / source buttons remain
 * non-functional sources). Inert without a pairing token and while local
 * media is loaded.
 *
 * PlayerApp registers itself once; the PSMUX browser-QA harness and tests
 * call beginCompanionFixtureSession(). A production build keeps the module
 * but nothing user-visible invokes it, so it cannot ship as a misleading
 * feature.
 * ---------------------------------------------------------------------------
 */
type FixtureEntry = () => void;

let registered: FixtureEntry | null = null;

export function registerCompanionFixtureEntry(entry: FixtureEntry | null): void {
  registered = entry;
}

/** Begin a known companion fixture session (no-op unless PlayerApp is
 *  paired and idle). Used by tests and the PSMUX browser-QA harness. */
export function beginCompanionFixtureSession(): void {
  registered?.();
}

/** Test-only reset. */
export function resetCompanionFixtureEntryForTests(): void {
  registered = null;
}
