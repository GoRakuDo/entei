/**
 * Floating Yomitan popup — the card that opens beside a scanned word.
 * ---------------------------------------------------------------------------
 * The scanner publishes what it found (the translator's OWN entries, plus where
 * the word is), and this popup draws them through Yomitan's generator and
 * stylesheets. Three things are pinned here:
 *
 *  - the card is upstream's: real translator entries → the vendored
 *    `DisplayGenerator` → the vendored CSS, with no second dictionary lookup;
 *  - a scan that found nothing never opens a frame (the "no dictionaries"
 *    placeholder is the wrong message for a miss);
 *  - the popup closes on Escape and on a press outside it, and never on a press
 *    inside it — the user may be reading or selecting.
 * ---------------------------------------------------------------------------
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import { createDefaultOptions } from '@gorakudo/yomitan-headless/settings';
import { YomitanPopup } from '@/modules/yomitan/overlay';
import {
  YOMITAN_SCAN_RESULT_EVENT,
  type YomitanScanResultDetail,
} from '@/modules/yomitan/text-scanner';
import { invalidateInstalledDictionaries } from '@/modules/yomitan/dictionary-store';
import {
  invalidateYomitanEngineCaches,
  lookupKanji,
  lookupTerms,
} from '@/modules/yomitan/yomitan-engine';
import { setPathValue } from '@/modules/yomitan/yomitan-preferences';
import { loadPopupPreviewAssets } from '@/modules/yomitan/popup-preview/popup-assets';
import { renderPopupEntriesHtml } from '@/modules/yomitan/popup-preview/popup-entries';

/* ---------------------------------------------------------------------------
 * A faked Rust engine: one dictionary, one headword.
 * ------------------------------------------------------------------------- */

/** The installed-dictionary reply the fake engine answers with. */
interface FakeDictionary {
  id: string;
  title: string;
  revision: string;
}

const JMDICT: FakeDictionary = {
  id: 'a1',
  title: 'JMdict',
  revision: 'jmdict-3.5.0',
};

const KANJIDIC: FakeDictionary = {
  id: 'k1',
  title: 'KANJIDIC',
  revision: 'kanjidic-3.6.0',
};

function installedRow(dictionary: FakeDictionary): Record<string, unknown> {
  return {
    ...dictionary,
    format: 3,
    sequenced: true,
    author: null,
    url: null,
    description: null,
    createdAt: 1_700_000_000_000,
    enabled: true,
    hasFrequencyData: false,
  };
}

/** One Rust bulk term row, exactly as the plugin serialises it. */
function termRow(): Record<string, unknown> {
  return {
    dictionary: JMDICT.title,
    definitionTags: 'v1 vt',
    expression: '食べる',
    glossary: ['to eat'],
    reading: 'たべる',
    rules: 'v1',
    score: 100,
    sequence: 1001,
    termTags: 'common',
  };
}

/** One Rust bulk kanji row (`find_kanji_bulk`'s shape). */
function kanjiRow(): Record<string, unknown> {
  return {
    index: 0,
    dictionary: KANJIDIC.title,
    character: '食',
    onyomi: 'ショク ジキ',
    kunyomi: 'た.べる く.う',
    tags: 'ate1',
    meanings: ['eat', 'food'],
    stats: { grade: 2 },
  };
}

/**
 * A faked Rust engine over the given dictionaries.
 *
 * Both dictionaries are installed, because a real scan resolves term AND kanji
 * rows against whatever is installed — a kanji hit needs `KANJIDIC`, a term hit
 * needs `JMdict`, and the lookup filters by the enabled set either way.
 */
function installEngine(): void {
  const installed = [installedRow(JMDICT), installedRow(KANJIDIC)];
  (globalThis as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {
    invoke: vi.fn(
      async (
        command: string,
        args?: Record<string, unknown>,
      ): Promise<unknown> => {
        switch (command) {
          case 'plugin:modules|yomitan_list_dictionaries':
            return installed;
          case 'plugin:modules|yomitan_find_terms_bulk': {
            /* The translator asks for the whole deinflection batch at once; only
               the dictionary form is in the (fake) dictionary, and `index` is the
               query term that produced the row — the translator reads the reply
               positionally against it. */
            const terms = (args?.terms as string[]) ?? [];
            return terms.flatMap((term, index) =>
              term === '食べる' ? [{ index, id: index + 1, ...termRow() }] : [],
            );
          }
          case 'plugin:modules|yomitan_find_kanji_bulk':
            return [kanjiRow()];
          default:
            return [];
        }
      },
    ),
  };
}

/**
 * Persist a tree whose active profile enables `JMdict`.
 *
 * Without a configured dictionary the translator's enabled-map is empty and a
 * lookup answers nothing — which is exactly what a fresh install looks like, so
 * this is the setup a real hit needs.
 */
function persistDictionaryConfig(): void {
  const base = createDefaultOptions();
  const options = {
    ...base,
    profiles: base.profiles.map((profile, index) =>
      index === base.profileCurrent
        ? {
            ...profile,
            options: setPathValue(profile.options, 'dictionaries', [
              { name: JMDICT.title, enabled: true },
              { name: KANJIDIC.title, enabled: true },
            ]) as typeof profile.options,
          }
        : profile,
    ),
  } as typeof base;
  window.localStorage.setItem(
    'entei.yomitan.options.v1',
    JSON.stringify({ version: 1, options }),
  );
}

beforeEach(() => {
  localStorage.clear();
  invalidateInstalledDictionaries();
  invalidateYomitanEngineCaches();
  installEngine();
  /* jsdom has no server behind `/yomitan/`: serve the real vendored files off
     disk, so the card is built from the same upstream text the app ships. */
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
    const url = String(input);
    if (!url.startsWith('/yomitan/')) {
      throw new Error(`unexpected fetch: ${url}`);
    }
    const bytes = readFileSync(resolve(process.cwd(), 'public', url.slice(1)));
    return new Response(bytes, { status: 200 });
  });
});

afterEach(() => {
  cleanup();
  delete (globalThis as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
  vi.restoreAllMocks();
});

/* ---------------------------------------------------------------------------
 * Helpers
 * ------------------------------------------------------------------------- */

/** The floating frame (null while the popup is closed). */
function popupFrame(container: HTMLElement): HTMLElement | null {
  return container.querySelector('.entei-yomitan-popup');
}

/** The document inside the frame: upstream markup + upstream stylesheets. */
function popupDocument(container: HTMLElement): string | null {
  return (
    popupFrame(container)?.querySelector('iframe')?.getAttribute('srcdoc') ??
    null
  );
}

/** Publish one scan result the way the scanner does: one CustomEvent on window. */
function publishScan(
  detail: Partial<YomitanScanResultDetail> & { entries: unknown[] },
): void {
  window.dispatchEvent(
    new CustomEvent<YomitanScanResultDetail>(YOMITAN_SCAN_RESULT_EVENT, {
      detail: {
        text: '食べる',
        offset: 0,
        matchLength: 3,
        anchor: { top: 400, left: 120, width: 28, height: 20 },
        terms: [],
        kanji: [],
        kanjiEntries: [],
        x: 120,
        y: 400,
        ...detail,
      },
    }),
  );
}

/**
 * Run the scanner's own lookup for one text, exactly as `scanAt` does.
 *
 * The popup is fed a REAL scan result rather than a hand-built one: the point of
 * the contract is that the scanner's published payload — the translator's own
 * entries, the summaries and the pointer — is what the card is drawn from.
 */
async function scanResultFor(text: string): Promise<YomitanScanResultDetail> {
  persistDictionaryConfig();
  return {
    text,
    offset: 0,
    matchLength: 3,
    anchor: { top: 400, left: 120, width: 28, height: 20 },
    terms: [],
    kanji: [],
    kanjiEntries: [],
    entries: await lookupTerms(text),
    x: 120,
    y: 400,
  };
}

/** A kanji scan's result (one entry per character, the scanner's own lookup). */
async function kanjiScanResultFor(
  text: string,
): Promise<YomitanScanResultDetail> {
  persistDictionaryConfig();
  return {
    text,
    offset: 0,
    matchLength: 1,
    anchor: { top: 400, left: 120, width: 20, height: 20 },
    terms: [],
    kanji: [],
    kanjiEntries: await lookupKanji(text),
    entries: [],
    x: 120,
    y: 400,
  };
}

/** What the vendored generator itself draws for these entries (the expectation). */
async function generatorOutput(entries: unknown[]): Promise<string> {
  const assets = await loadPopupPreviewAssets();
  return await renderPopupEntriesHtml(assets.templates, entries, [
    { title: 'JMdict', revision: 'jmdict-3.5.0' },
  ]);
}

/* ---------------------------------------------------------------------------
 * Tests
 * ------------------------------------------------------------------------- */

describe('YomitanPopup — floating scan popup', () => {
  it('draws the scanned entry with Yomitan’s own markup and stylesheets', async () => {
    const detail = await scanResultFor('食べた');
    const expected = await generatorOutput(detail.entries);
    expect(expected).toContain('to eat');

    const { container } = render(<YomitanPopup />);
    /* Nothing scanned, nothing on screen: the popup is not page chrome. */
    expect(popupFrame(container)).toBeNull();

    publishScan(detail);

    await waitFor(() => expect(popupDocument(container)).not.toBeNull());
    const document = popupDocument(container) as string;
    /* The generator's own card … */
    expect(document).toContain(expected);
    /* … inside upstream's own stylesheet, not a local approximation. */
    expect(document).toContain('.entry-current-indicator');
    /* The frame is named after what was scanned, so it is identifiable to a
       screen reader and to anything looking for it. */
    expect(
      popupFrame(container)?.querySelector('iframe')?.getAttribute('title'),
    ).toBe('Yomitan popup: 食べた');
  });

  it('draws a kanji scan with the generator’s own kanji card', async () => {
    const detail = await kanjiScanResultFor('食');
    const { container } = render(<YomitanPopup />);

    publishScan(detail);

    await waitFor(() => expect(popupDocument(container)).not.toBeNull());
    const document = popupDocument(container) as string;
    /* Upstream's kanji block (its own template and its own glyph node), not a
       hand-written one: the entry carries the kanji's own tag and the dictionary
       it came from. */
    expect(document).toContain('kanji-entry');
    expect(document).toContain('kanji-tag');
    expect(document).toContain('ate1');
    expect(document).toContain('KANJIDIC');
  });

  it('sits against the matched word, not against the pointer', async () => {
    const detail = await scanResultFor('食べた');
    const { container } = render(<YomitanPopup />);

    /* The scanner publishes the MATCHED WORD's own box; the pointer (120, 400) is
       what the frame must ignore — that is what used to drag it up and to the
       left of the word. */
    publishScan({
      ...detail,
      anchor: { top: 200, left: 300, width: 28, height: 20 },
    });

    await waitFor(() => expect(popupFrame(container)).not.toBeNull());
    const frame = popupFrame(container) as HTMLElement;
    /* Upstream's own placement: the frame's left edge on the word's left edge,
       its top edge just under the word, with the user's two distance knobs
       (general.popupHorizontalOffset 0 / popupVerticalOffset 10) between. */
    expect(frame.style.left).toBe('300px');
    expect(frame.style.top).toBe('230px');
    expect(frame.dataset.side).toBe('below');
  });

  it('stays closed for a scan that found nothing', async () => {
    const { container } = render(<YomitanPopup />);

    publishScan({ entries: [] });

    /* Let the asset read settle: a popup that opened on a miss would appear. */
    await new Promise((r) => setTimeout(r, 20));
    expect(popupFrame(container)).toBeNull();
  });

  it('closes on Escape and on a press outside the frame', async () => {
    const detail = await scanResultFor('食べた');
    const { container } = render(<YomitanPopup />);

    publishScan(detail);
    await waitFor(() => expect(popupFrame(container)).not.toBeNull());

    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => expect(popupFrame(container)).toBeNull());

    publishScan(detail);
    await waitFor(() => expect(popupFrame(container)).not.toBeNull());

    /* A press on the page around it dismisses it — the usual way a floating card
       goes away. A press INSIDE the frame is the user reading or selecting. */
    fireEvent.pointerDown(document.body);
    await waitFor(() => expect(popupFrame(container)).toBeNull());
  });

  it('does not close on a press inside the frame', async () => {
    const detail = await scanResultFor('食べた');
    const { container } = render(<YomitanPopup />);

    publishScan(detail);
    await waitFor(() => expect(popupFrame(container)).not.toBeNull());

    fireEvent.pointerDown(popupFrame(container) as HTMLElement);
    expect(popupFrame(container)).not.toBeNull();
  });
});
