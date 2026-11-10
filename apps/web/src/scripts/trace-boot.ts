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
import { isTauri, openExternalUrlDirect } from '@/features/player/tauri-bridge';

installTraceInstrumentation();

// Desktop only: intercept any external link click globally and hand it
// over to the operating system's default browser, keeping the app webview
// from navigating away to external websites.
if (typeof window !== 'undefined' && isTauri()) {
  window.addEventListener(
    'click',
    (e) => {
      const target = (e.target as HTMLElement | null)?.closest('a');
      if (!target || !target.href) return;
      try {
        const url = new URL(target.href);
        if (
          (url.protocol === 'http:' || url.protocol === 'https:') &&
          url.hostname !== 'tauri.localhost' &&
          url.hostname !== 'localhost' &&
          url.hostname !== '127.0.0.1'
        ) {
          e.preventDefault();
          e.stopPropagation();
          void openExternalUrlDirect(target.href);
        }
      } catch {
        // invalid URL — ignore
      }
    },
    true, // capture phase to intercept before React or native navigation
  );
}

// Desktop only: import the browser-era localStorage / IndexedDB data into the
// embedded SQLite database once (idempotent, gated by a completion flag).
// Kicking it off here — before the React islands read any store — lets the
// import run while the shell boots; the store readers also await the same
// memoized promise, so the first render after a migration already sees the
// imported rows. Outside Tauri this resolves immediately as a no-op.
void ensureDatabaseMigrated();
