/**
 * Yomitan popup preview — the editable term field.
 * ---------------------------------------------------------------------------
 * The one piece of the preview card that is state rather than a string: the field
 * the user types a word into, and the debounce between a half-typed word and the
 * lookup that answers it.
 *
 * Observed through the FRAME's own title (the component names it after the term it
 * is currently drawing), so the assertion is on what the card shows rather than on
 * an internal: the title only moves when the debounced query does.
 *
 * The vendored upstream files are served from `public/yomitan/` by a fetch stub,
 * which is all the asset loader needs — the lookup itself answers from the empty
 * test profile without an engine.
 * ---------------------------------------------------------------------------
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { createDefaultOptions } from '@gorakudo/yomitan-headless/settings';
import { YomitanPopupPreview } from '@/components/settings/YomitanPopupPreview';
import { POPUP_PREVIEW_TERM } from '@/modules/yomitan/popup-preview';

/** Accessible name of the field (the row's own English chrome). */
const TERM_LABEL = 'Preview term';

beforeEach(() => {
  /* jsdom has no server behind `/yomitan/`: serve the real vendored files off disk,
     so the card is built from the same upstream text the app ships. */
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
  vi.restoreAllMocks();
});

/** The term the card is currently drawing, as the frame reports it. */
function drawnTerm(container: HTMLElement): string | null {
  return container.querySelector('iframe')?.getAttribute('title') ?? null;
}

function termField(): HTMLInputElement {
  return screen.getByLabelText(TERM_LABEL) as HTMLInputElement;
}

describe('YomitanPopupPreview — term field', () => {
  it('draws the example word, then the typed one once the field settles', async () => {
    const { container } = render(
      <YomitanPopupPreview options={createDefaultOptions()} />,
    );
    await waitFor(() => expect(container.querySelector('iframe')).not.toBeNull());
    expect(drawnTerm(container)).toBe(POPUP_PREVIEW_TERM);

    fireEvent.change(termField(), { target: { value: '食べる' } });
    /* Debounced: the card keeps the previous answer while the word is typed, so a
       lookup crosses the IPC boundary once per word, not once per keystroke. */
    expect(drawnTerm(container)).toBe(POPUP_PREVIEW_TERM);

    await waitFor(() => expect(drawnTerm(container)).toBe('食べる'));
  });

  it('falls back to the example word when the field is cleared', async () => {
    const { container } = render(
      <YomitanPopupPreview options={createDefaultOptions()} />,
    );
    await waitFor(() => expect(container.querySelector('iframe')).not.toBeNull());

    fireEvent.change(termField(), { target: { value: '猫' } });
    await waitFor(() => expect(drawnTerm(container)).toBe('猫'));

    /* An empty field is a half-finished edit, not a request to search for nothing. */
    fireEvent.change(termField(), { target: { value: '   ' } });
    await waitFor(() => expect(drawnTerm(container)).toBe(POPUP_PREVIEW_TERM));
  });
});
