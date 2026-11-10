/**
 * trace-boot — installs the trace instrumentation for every page.
 * ---------------------------------------------------------------------------
 * Both layouts (`BaseLayout` for Home / Profile / Modules, `PlayerLayout` for
 * Player / Audio Player) load this module script, so the automatic trace
 * layers (UI clicks, keys, Tauri IPC, HTTP, lifecycle, uncaught errors) are
 * live before the React islands hydrate.
 *
 * Importing the logger here — not inside each island — is what keeps the
 * journal complete: a page that forgets to call `trace()` still records what
 * the user pressed.
 * ---------------------------------------------------------------------------
 */
import { installTraceInstrumentation } from '@/features/trace/trace-logger';
import { ensureDatabaseMigrated } from '@/features/database/migration';

installTraceInstrumentation();

// Desktop only: import the browser-era localStorage / IndexedDB data into the
// embedded SQLite database once (idempotent, gated by a completion flag).
// Kicking it off here — before the React islands read any store — lets the
// import run while the shell boots; the store readers also await the same
// memoized promise, so the first render after a migration already sees the
// imported rows. Outside Tauri this resolves immediately as a no-op.
void ensureDatabaseMigrated();
