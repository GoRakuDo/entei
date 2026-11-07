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

installTraceInstrumentation();
