/**
 * use-clipboard-monitor — the sampling half of the search page's clipboard monitor.
 * ---------------------------------------------------------------------------
 * `clipboard-monitor.ts` decides what a sample MEANS; this hook decides WHEN one is
 * taken and what the page does with it. Both exist because
 * `clipboard.enableSearchPageMonitor` (Settings → Yomitan → Search window →
 * "Clipboard monitor") promises that text copied anywhere else shows up in the box
 * and is looked up.
 *
 * THE BASELINE IS TAKEN ON MOUNT, BEFORE ANYTHING ELSE. The rule the pure module
 * enforces is "whatever was already on the clipboard is not a query" — but that only
 * holds if something READ the clipboard when the page opened. Leaving the baseline
 * empty and letting the first sample fill it meant the baseline became whatever the
 * user had JUST copied in another app: the copy that made them come back to
 * `/search/` was read, remembered and dropped, nothing was searched, and only the
 * NEXT copy worked — which is what "the clipboard monitor is broken" and "it shows
 * up minutes late" both were. So the first read happens as the monitor starts, is
 * remembered as the baseline, and is never searched; every read after it is compared
 * against it, and the first copy after that is a search.
 *
 * A mount read that comes back empty still records `''` rather than "nothing read
 * yet", because an unknown baseline would eat the first real copy exactly the same
 * way. `''` differs from every lookup-worthy text, so that copy is a search.
 *
 * NEVER FOCUS-GATED. Copying in another app is the whole point, so the poll runs
 * whether or not this window holds focus: on Windows the clipboard is readable
 * either way, and the field follows a copy while the user is still in the other app.
 * An OS that refuses (Android 10+ hands the clipboard to the focused app only) simply
 * answers nothing, which is an ordinary `idle` sample.
 *
 * THREE TRIGGERS, ONE LATCH:
 *  - the mount read (the baseline),
 *  - the poll, every `CLIPBOARD_POLL_INTERVAL_MS` (see `clipboard-monitor.ts`),
 *  - `focus` and the visible edge of `visibilitychange` — the two edges the platforms
 *    hand the clipboard back on, which read IMMEDIATELY so a copy → alt-tab → read round trip does not
 *    wait out the poll to appear in the field.
 * One read is in flight at a time, because focus and the poll fire together whenever
 * the window comes back and two reads of the same new text would look it up twice.
 *
 * A COPY MADE ON THIS PAGE IS NOT NEWS. Copying a headword out of the results and
 * then alt-tabbing away would otherwise come back as a brand-new sample — the OS
 * clipboard now holds this page's own text — and the page would look itself up. The
 * `copy` listener remembers those as the baseline instead.
 * ---------------------------------------------------------------------------
 */

import { useEffect, useRef } from 'react';
import { readClipboardTextDirect } from '@/features/player/tauri-bridge';
import {
  CLIPBOARD_POLL_INTERVAL_MS,
  classifyClipboardSample,
  normalizeClipboardText,
} from '@/modules/yomitan/search/clipboard-monitor';

/** What the monitor needs from the page that hosts it. */
export interface ClipboardMonitorOptions {
  /** `clipboard.enableSearchPageMonitor`, independent of dictionary asset readiness. */
  readonly enabled: boolean;
  /**
   * A new clipboard text to put in the field and look up.
   *
   * The page owns this because only it knows how a query is entered and recorded:
   * a clipboard sample is not a keystroke (nothing to convert from romaji, no caret
   * to place) and not a navigation (`replace`, never `push`).
   */
  readonly onSearch: (query: string) => void;
}

/**
 * The plain text one `copy` event is putting on the clipboard, or `null`.
 *
 * The event's own clipboard payload comes first (a handler elsewhere may have
 * overridden what is copied); the document selection is the normal case, since a
 * plain Ctrl+C in the results does not touch `clipboardData` until after the
 * event has finished.
 */
function copiedText(event: ClipboardEvent): string | null {
  const payload = event.clipboardData?.getData('text/plain');
  const text = payload || window.getSelection()?.toString() || '';
  return text.trim() === '' ? null : text;
}

/**
 * Follow the OS clipboard for as long as `enabled` holds.
 *
 * A hook rather than a ref plus two effects inside the page: the baseline, the copy
 * listener and the three triggers are one state machine, and this is what makes the
 * mount read and the focus read testable without a dictionary engine.
 */
export function useClipboardMonitor({
  enabled,
  onSearch,
}: ClipboardMonitorOptions): void {
  /**
   * The last sample this page ACCEPTED, in `normalizeClipboardText` form.
   *
   * A ref so it survives every re-run of the effect below: re-reading the clipboard
   * as a fresh baseline each time the monitor is re-armed would drop a copy.
   */
  const previousRef = useRef<string | null>(null);
  /**
   * The latest `onSearch`.
   *
   * A ref, so that a new callback identity does NOT restart the monitor: the effect
   * re-arming would take another baseline sample, and the copy the user just made
   * would be remembered instead of searched.
   */
  const onSearchRef = useRef(onSearch);
  useEffect(() => {
    onSearchRef.current = onSearch;
  }, [onSearch]);

  useEffect(() => {
    if (!enabled) return;
    let disposed = false;
    /** One clipboard read in flight at a time — see the note above. */
    let sampling = false;

    /** Read the clipboard. `null` when it could not be read at all. */
    const read = async (): Promise<string | null | undefined> => {
      sampling = true;
      try {
        return await readClipboardTextDirect();
      } finally {
        /* ALWAYS released: this latch is the monitor's only one, and a read that
           escaped would stop the clipboard being followed for the rest of the
           page's life — with no error anywhere to say so. */
        sampling = false;
      }
    };

    /**
     * The baseline: what was on the clipboard before this page opened.
     *
     * Never searched. A read that comes back empty (Android refuses without focus) or
     * unreadable records the same "unknown" `''` baseline rather than losing the
     * monitor, so the first real copy afterwards is still a search. A read still in
     * flight when the first sample arrives wins, because the latch skips that sample;
     * its value IS the pre-existing clipboard either way.
     */
    const primeBaseline = async (): Promise<void> => {
      const current = await read();
      if (disposed || current === undefined) return;
      previousRef.current = normalizeClipboardText(current);
    };

    /** One sample: read, decide, and act on anything that is news. */
    const sample = async (): Promise<void> => {
      if (disposed || sampling) return;
      const current = await read();
      if (disposed || current === undefined) return;
      const decision = classifyClipboardSample(previousRef.current, current);
      if (decision.kind === 'idle') return;
      /* Remembered in the SAME shortened form the decision was made on, or a value
         longer than the cap would differ from itself on every poll and re-run the
         same lookup twice a second. */
      previousRef.current = normalizeClipboardText(current);
      if (decision.kind === 'baseline') return;
      onSearchRef.current(decision.query);
    };

    /** A copy made on this page is this page's own text, not a sample. */
    const onCopy = (event: ClipboardEvent): void => {
      const copied = copiedText(event);
      if (copied === null) return;
      previousRef.current = normalizeClipboardText(copied);
    };

    void primeBaseline();
    const timer = window.setInterval(() => {
      void sample();
    }, CLIPBOARD_POLL_INTERVAL_MS);
    const onVisibilityChange = (): void => {
      if (document.visibilityState === 'hidden') return;
      void sample();
    };
    window.addEventListener('focus', sample);
    document.addEventListener('visibilitychange', onVisibilityChange);
    document.addEventListener('copy', onCopy);
    return () => {
      disposed = true;
      window.clearInterval(timer);
      window.removeEventListener('focus', sample);
      document.removeEventListener('visibilitychange', onVisibilityChange);
      document.removeEventListener('copy', onCopy);
    };
  }, [enabled]);
}