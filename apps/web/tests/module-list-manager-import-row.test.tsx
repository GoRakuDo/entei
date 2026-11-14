/**
 * ModuleListManager — the in-flight import's placeholder row.
 * ---------------------------------------------------------------------------
 * The layout is the platform's generic "installed items" list, so this covers
 * the one piece of import behaviour it owns itself: the row exists from the
 * moment an import STARTS, without waiting for the data source to report
 * anything.
 *
 * That is a UX guarantee, not a detail: a dictionary import is a long native job,
 * and a button that looks dead for as long as the first bank takes is what the
 * user reports as "nothing happened when I opened the file". The source's own
 * percent wins whenever it is higher than that floor; staying monotonic inside
 * one import is the source's contract (`ModuleItemManager` keeps the higher of
 * two deliveries, which is what the engine's two emit routes make normal).
 */

import { afterEach, describe, expect, it } from 'bun:test';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import {
  ModuleListManager,
  type ModuleListManagerCopy,
} from '@/components/settings/ModuleListManager';

const COPY: ModuleListManagerCopy = {
  import: 'Import',
  importing: 'Importing…',
  importingProgress: 'Importing',
  empty: 'Nothing installed.',
  enable: 'Enable',
  remove: 'Remove',
  importFailed: 'Import failed',
  loadFailed: 'List could not be read',
  reorder: 'Reorder',
  reorderHint: 'Drag to reorder.',
};

/**
 * The list, with an import that never settles (so the placeholder row stays up
 * for the whole test). `sourceReports = false` is a source that reports no
 * percent at all; the button is the report it would otherwise deliver.
 */
function Harness({ sourceReports }: { sourceReports: boolean }) {
  const [progress, setProgress] = useState<number | null>(null);
  return (
    <>
      <ModuleListManager
        rows={[]}
        copy={COPY}
        title="Installed dictionaries"
        importProgress={sourceReports ? progress : null}
        onImport={() => new Promise<void>(() => {})}
      />
      <button type="button" onClick={() => setProgress(64)}>
        report 64
      </button>
    </>
  );
}

/** Pick a file in the layout's own HTML input, which is what starts an import. */
function startImport(): void {
  fireEvent.click(screen.getByRole('button', { name: COPY.import }));
  const input = document.querySelector<HTMLInputElement>(
    'input[type="file"].entei-module-list-file-input',
  );
  if (input === null) throw new Error('no file input rendered');
  fireEvent.change(input, {
    target: { files: [new File([''], 'dictionary.zip')] },
  });
}

/** The percent the placeholder row's bar currently shows. */
function shownPercent(): string | null {
  return screen
    .queryByRole('progressbar', { name: COPY.importingProgress })
    ?.getAttribute('aria-valuenow') ?? null;
}

afterEach(() => {
  cleanup();
});

describe('ModuleListManager — in-flight import row', () => {
  it('draw the placeholder at 0% when the source reports nothing', () => {
    render(<Harness sourceReports={false} />);

    // No import yet: the empty state, not a phantom row.
    expect(screen.getByText(COPY.empty)).toBeTruthy();
    expect(shownPercent()).toBeNull();

    startImport();

    // The row is up with no report from anywhere: the click is the trigger.
    expect(screen.getByText(`${COPY.importingProgress} 0%`)).toBeTruthy();
    expect(screen.queryByText(COPY.empty)).toBeNull();
    expect(shownPercent()).toBe('0');
    // A placeholder, not an item: the toolbar's button is busy, not actionable.
    expect(
      screen.getByRole('button', { name: COPY.importing }).hasAttribute('disabled'),
    ).toBe(true);
  });

  it('shows the source’s percent, and the same report twice changes nothing', async () => {
    render(<Harness sourceReports />);
    startImport();
    expect(shownPercent()).toBe('0');

    fireEvent.click(screen.getByRole('button', { name: 'report 64' }));
    expect(await screen.findByText(`${COPY.importingProgress} 64%`)).toBeTruthy();
    expect(shownPercent()).toBe('64');

    /* The engine sends each report by two routes, so the same number arriving
       twice is normal: it must draw exactly what it drew before. */
    fireEvent.click(screen.getByRole('button', { name: 'report 64' }));
    expect(shownPercent()).toBe('64');
    expect(screen.getByText(`${COPY.importingProgress} 64%`)).toBeTruthy();
  });
});