/**
 * Clipboard monitor sampling — `useClipboardMonitor`
 * ---------------------------------------------------------------------------
 * `clipboard-monitor.ts` owns the decisions and is tested next door; this file pins
 * WHEN a sample is taken, which is where the reported bug lived:
 *
 * the baseline used to be filled by the first sample the monitor happened to take,
 * so the copy that made the user come back to `/search/` was read, remembered and
 * dropped — nothing was looked up, and only the NEXT copy worked (which reads as
 * "the clipboard monitor is broken" or "it shows up minutes late").
 *
 * What is asserted here is therefore the shape of the fix: the clipboard is read as
 * the monitor starts and THAT is the baseline, a copy made afterwards is searched on
 * the focus edge with no timer in the way, an unchanged clipboard is quiet, and a
 * copy made on this page is never looked up.
 * ---------------------------------------------------------------------------
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'bun:test';
import { act, renderHook } from '@testing-library/react';
import {
  CLIPBOARD_POLL_INTERVAL_MS,
} from '@/modules/yomitan/search/clipboard-monitor';
import { useClipboardMonitor } from '@/modules/yomitan/search/use-clipboard-monitor';

/** The fake OS clipboard, and how many times the monitor has read it. */
const clipboard = vi.hoisted(() => ({
  text: null as string | null,
  reads: 0,
}));

/* The native read is the monitor's only outside contact, so it is the only thing
   replaced: no Tauri runtime, no permission prompt, no jsdom clipboard. */
vi.mock('@/features/player/tauri-bridge', () => ({
  readClipboardTextDirect: async (): Promise<string | null> => {
    clipboard.reads += 1;
    return clipboard.text;
  },
}));

const onSearch = vi.fn();

function render(enabled = true) {
  return renderHook(() => useClipboardMonitor({ enabled, onSearch }));
}

/**
 * One macrotask, which is what drains the monitor's pending read.
 *
 * Deliberately a 0 ms timer and not an advance of any clock: the poll runs once a
 * second, so nothing in this file can be satisfied by the poll firing.
 */
function flush(): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, 0);
  });
}

/** Let the hook's own async read settle. */
async function settle(): Promise<void> {
  await act(async () => {
    await flush();
  });
}

/** The window coming back: the edge the user's alt-tab lands on. */
async function regainFocus(): Promise<void> {
  await act(async () => {
    window.dispatchEvent(new Event('focus'));
    await flush();
  });
}

/** Change tabs without making the document hidden. */
async function becomeVisible(): Promise<void> {
  await act(async () => {
    document.dispatchEvent(new Event('visibilitychange'));
    await flush();
  });
}

/** A copy made on this page, which must not become a lookup. */
async function copyOnPage(text: string): Promise<void> {
  await act(async () => {
    const event = new Event('copy', { bubbles: true });
    Object.defineProperty(event, 'clipboardData', {
      value: { getData: () => text },
    });
    document.dispatchEvent(event);
    await flush();
  });
}

beforeEach(() => {
  clipboard.text = null;
  clipboard.reads = 0;
  onSearch.mockClear();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('useClipboardMonitor — the baseline', () => {
  it('reads the clipboard as it opens and never searches that value', () => {
    // Copying a word and THEN opening /search/ must not look that word up.
    clipboard.text = '犬';
    render();
    expect(clipboard.reads).toBe(1);
    expect(onSearch).not.toHaveBeenCalled();
  });

  it('searches the FIRST copy made after the page opened', async () => {
    /* The reported bug: this copy used to BE the baseline, so it was dropped and
       only the second one ever appeared in the field. */
    clipboard.text = '犬';
    render();
    await settle();
    clipboard.text = '落ちる';
    await regainFocus();
    expect(onSearch).toHaveBeenCalledWith('落ちる');
  });

  it('still searches when the clipboard was empty as the page opened', async () => {
    // Android answers a background read with nothing, and an empty clipboard reads
    // as null: an UNKNOWN baseline must not eat the first copy either.
    clipboard.text = null;
    render();
    await settle();
    clipboard.text = '猫';
    await regainFocus();
    expect(onSearch).toHaveBeenCalledWith('猫');
  });

  it('does nothing at all while the monitor is switched off', async () => {
    clipboard.text = '犬';
    render(false);
    await settle();
    clipboard.text = '猫';
    await regainFocus();
    expect(clipboard.reads).toBe(0);
    expect(onSearch).not.toHaveBeenCalled();
  });
});

describe('useClipboardMonitor — when a sample is taken', () => {
  it('reads when the document becomes visible', async () => {
    clipboard.text = '犬';
    render();
    await settle();
    const readsAtRest = clipboard.reads;
    clipboard.text = '落ちる';
    await becomeVisible();
    expect(clipboard.reads).toBe(readsAtRest + 1);
    expect(onSearch).toHaveBeenCalledWith('落ちる');
  });

  it('does not read while the document is hidden', async () => {
    clipboard.text = '犬';
    render();
    await settle();
    const readsAtRest = clipboard.reads;
    const visibility = vi
      .spyOn(document, 'visibilityState', 'get')
      .mockReturnValue('hidden');
    clipboard.text = '落ちる';
    await act(async () => {
      document.dispatchEvent(new Event('visibilitychange'));
      await flush();
    });
    visibility.mockRestore();
    expect(clipboard.reads).toBe(readsAtRest);
    expect(onSearch).not.toHaveBeenCalled();
  });

  it('does not treat an empty copy on this page as the baseline', async () => {
    clipboard.text = '犬';
    render();
    await settle();
    clipboard.text = '猫';
    const selection = vi.spyOn(window, 'getSelection').mockReturnValue({
      toString: () => '',
    } as unknown as Selection);
    await copyOnPage('');
    selection.mockRestore();
    await regainFocus();
    expect(onSearch).toHaveBeenCalledWith('猫');
  });

  it('reads on the focus edge immediately, without waiting out the poll', async () => {
    // No timer is advanced anywhere in this test: if the copy were left to the
    // once-a-second poll, no read would have happened by the time it ends.
    clipboard.text = '犬';
    render();
    await settle();
    const readsAtRest = clipboard.reads;
    clipboard.text = '落ちる';
    await regainFocus();
    expect(clipboard.reads).toBe(readsAtRest + 1);
    expect(onSearch).toHaveBeenCalledTimes(1);
  });

  it('is quiet while the clipboard still holds the same word', async () => {
    clipboard.text = '犬';
    render();
    await settle();
    await regainFocus();
    await regainFocus();
    expect(onSearch).not.toHaveBeenCalled();
  });

  it('follows a copy made in another app while this window has NO focus', async () => {
    /* The reported use case, and the reason the poll is not focus-gated: the user is
       still working in the other app, so there is no focus edge to land on — the poll
       itself has to see the copy. `hasFocus` is pinned to false so that reintroducing
       a focus gate fails HERE rather than in a desktop session. */
    clipboard.text = '犬';
    render();
    await settle();
    const hasFocus = vi.spyOn(document, 'hasFocus').mockReturnValue(false);
    clipboard.text = '落ちる';
    await act(async () => {
      await new Promise((resolve) => {
        setTimeout(resolve, CLIPBOARD_POLL_INTERVAL_MS + 100);
      });
    });
    hasFocus.mockRestore();
    expect(onSearch).toHaveBeenCalledWith('落ちる');
  });

  it('searches again for a genuinely different copy on a later visit', async () => {
    clipboard.text = '犬';
    render();
    await settle();
    clipboard.text = '落ちる';
    await regainFocus();
    clipboard.text = '曖昧';
    await regainFocus();
    expect(onSearch).toHaveBeenCalledTimes(2);
    expect(onSearch).toHaveBeenLastCalledWith('曖昧');
  });

  it('does not look up a copy made on this page', async () => {
    /* Copying a headword out of the results and alt-tabbing away would otherwise
       come back as a brand-new sample — the OS clipboard now holds this page's own
       text — and the page would look itself up. */
    clipboard.text = '犬';
    render();
    await settle();
    clipboard.text = '猫';
    await copyOnPage('猫');
    await regainFocus();
    expect(onSearch).not.toHaveBeenCalled();
  });
});