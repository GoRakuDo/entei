import { render, cleanup, fireEvent, screen, act } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { JimakuSearchDialog } from '@/components/player/JimakuSearchDialog';
import { en } from '@i18n/locales/en';

// Mock the P1 modules so the dialog logic is tested in isolation.
const prefs = vi.hoisted(() => ({
  apiKey: 'test-key',
  autoLoadEnabled: true,
  toastCount: 0,
  searchAnime: true,
}));
const setSearchAnime = vi.hoisted(() => vi.fn());

vi.mock('@/features/player/jimaku-preferences', () => ({
  readJimakuPreferences: () => ({ ...prefs }),
  setJimakuSearchAnime: setSearchAnime,
  shouldShowJimakuToast: () => true,
  incrementJimakuToastCount: () => 1,
}));

const client = vi.hoisted(() => ({
  search: vi.fn(),
  files: vi.fn(),
  download: vi.fn(),
}));

vi.mock('@/features/player/jimaku-client', () => ({
  searchJimakuEntries: (...a: unknown[]) => client.search(...a),
  getJimakuEntryFiles: (...a: unknown[]) => client.files(...a),
  downloadJimakuSubtitle: (...a: unknown[]) => client.download(...a),
}));

const dict = en.playerUI;
const onOpenChange = vi.fn();
const onSubtitleLoaded = vi.fn();
const onToast = vi.fn();
const onOpenSettings = vi.fn();

function renderDialog(open = true) {
  return render(
    <JimakuSearchDialog
      open={open}
      onOpenChange={onOpenChange}
      initialTitle="Sousou no Frieren EP01.mkv"
      initialAnime={true}
      onSubtitleLoaded={onSubtitleLoaded}
      onToast={onToast}
      onOpenSettings={onOpenSettings}
      dict={dict}
    />,
  );
}

/** Flush the dialog's async handlers (mocked promises resolve on microtasks). */
async function flush() {
  await act(async () => {
    await Promise.resolve();
  });
}

async function searchForEntry() {
  fireEvent.click(screen.getByText(dict.jimakuSearchButton));
  await flush();
}

describe('JimakuSearchDialog', () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
    // Restore the shared prefs fixture (tests may mutate it, e.g. no-key).
    prefs.apiKey = 'test-key';
    vi.useRealTimers();
  });

  it('pre-fills the title from the media name and searches on button click', async () => {
    client.search.mockResolvedValueOnce({
      ok: true,
      data: [{ id: 729, name: 'Sousou no Frieren', flags: { anime: true } }],
    });
    renderDialog();

    const titleInput = screen.getByLabelText(dict.jimakuSearchTitle) as HTMLInputElement;
    expect(titleInput.value).toBe('Sousou no Frieren EP01.mkv');

    await searchForEntry();
    expect(client.search).toHaveBeenCalledWith(
      'test-key',
      'Sousou no Frieren EP01.mkv',
      true,
      expect.any(AbortSignal),
    );
    expect(screen.getByText('Sousou no Frieren')).toBeTruthy();
  });

  it('lists files on entry select, filtering non-Japanese and compressed', async () => {
    client.search.mockResolvedValueOnce({
      ok: true,
      data: [{ id: 729, name: 'Sousou no Frieren', flags: { anime: true } }],
    });
    client.files.mockResolvedValueOnce({
      ok: true,
      data: [
        { url: 'u1', name: 'Frieren.EP01.srt', size: 100, last_modified: '' },
        { url: 'u2', name: 'Frieren.EP01.en.srt', size: 90, last_modified: '' },
        { url: 'u3', name: 'Frieren.EP01.zip', size: 80, last_modified: '' },
      ],
    });
    renderDialog();
    await searchForEntry();

    fireEvent.click(screen.getByText('Sousou no Frieren'));
    await flush();

    expect(client.files).toHaveBeenCalledWith(
      'test-key',
      729,
      undefined,
      expect.any(AbortSignal),
    );
    expect(screen.getByText('Frieren.EP01.srt')).toBeTruthy();
    // Non-Japanese (.en.) and compressed (.zip) files are hidden.
    expect(screen.queryByText('Frieren.EP01.en.srt')).toBeNull();
    expect(screen.queryByText('Frieren.EP01.zip')).toBeNull();
  });

  it('falls back to all uncompressed files when no Japanese file exists', async () => {
    client.search.mockResolvedValueOnce({
      ok: true,
      data: [{ id: 729, name: 'Sousou no Frieren', flags: { anime: true } }],
    });
    client.files.mockResolvedValueOnce({
      ok: true,
      data: [
        { url: 'u1', name: 'Frieren.EP01.en.srt', size: 90, last_modified: '' },
        { url: 'u2', name: 'Frieren.EP01.zip', size: 80, last_modified: '' },
      ],
    });
    renderDialog();
    await searchForEntry();

    fireEvent.click(screen.getByText('Sousou no Frieren'));
    await flush();

    // Design §2.3-3: zero Japanese → the non-Japanese .srt is shown, .zip stays hidden.
    expect(screen.getByText('Frieren.EP01.en.srt')).toBeTruthy();
    expect(screen.queryByText('Frieren.EP01.zip')).toBeNull();
  });

  it('re-fetches the file list when the episode changes (selected entry)', async () => {
    client.search.mockResolvedValueOnce({
      ok: true,
      data: [{ id: 729, name: 'Sousou no Frieren', flags: { anime: true } }],
    });
    client.files
      .mockResolvedValueOnce({
        ok: true,
        data: [{ url: 'u1', name: 'Frieren.EP01.srt', size: 100, last_modified: '' }],
      })
      .mockResolvedValueOnce({
        ok: true,
        data: [{ url: 'u2', name: 'Frieren.EP02.srt', size: 110, last_modified: '' }],
      });
    renderDialog();
    await searchForEntry();

    fireEvent.click(screen.getByText('Sousou no Frieren'));
    await flush();
    expect(screen.getByText('Frieren.EP01.srt')).toBeTruthy();

    const episodeInput = screen.getByLabelText(dict.jimakuSearchEpisode);
    fireEvent.change(episodeInput, { target: { value: '2' } });
    await flush();

    // Design §2.3-5: episode change on a selected entry re-fetches the list.
    expect(client.files).toHaveBeenLastCalledWith(
      'test-key',
      729,
      2,
      expect.any(AbortSignal),
    );
    expect(screen.getByText('Frieren.EP02.srt')).toBeTruthy();
  });

  it('downloads the selected file and hands the text to the parent', async () => {
    client.search.mockResolvedValueOnce({
      ok: true,
      data: [{ id: 729, name: 'Sousou no Frieren', flags: { anime: true } }],
    });
    client.files.mockResolvedValueOnce({
      ok: true,
      data: [{ url: 'u1', name: 'Frieren.EP01.srt', size: 100, last_modified: '' }],
    });
    client.download.mockResolvedValueOnce({
      ok: true,
      data: 'WEBVTT\n\n00:00:01 --> 00:00:02\nSubtitle text',
    });
    renderDialog();
    await searchForEntry();

    fireEvent.click(screen.getByText('Sousou no Frieren'));
    await flush();
    fireEvent.click(screen.getByText('Frieren.EP01.srt'));
    await flush();

    expect(client.download).toHaveBeenCalledWith('u1', expect.any(AbortSignal));
    expect(onSubtitleLoaded).toHaveBeenCalledWith(expect.stringContaining('WEBVTT'));
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('toasts rate-limit and shows the empty results state', async () => {
    client.search.mockResolvedValueOnce({ ok: false, error: 'rate-limit' });
    renderDialog();
    await searchForEntry();

    expect(onToast).toHaveBeenCalledWith('rate-limit');
    expect(screen.getByText(dict.jimakuSearchResultsEmpty)).toBeTruthy();
  });

  it('toasts auth on an invalid API key', async () => {
    client.search.mockResolvedValueOnce({ ok: false, error: 'auth' });
    renderDialog();
    await searchForEntry();

    expect(onToast).toHaveBeenCalledWith('auth');
  });

  it('replaces the search form with an empty state when the key is missing', () => {
    prefs.apiKey = '';
    renderDialog();

    // Empty state: message + settings button.
    expect(screen.getByText(dict.jimakuSearchNoKey)).toBeTruthy();
    expect(screen.getByText(dict.jimakuOpenSettings)).toBeTruthy();
    // The whole form is hidden — no search button, no inputs, no toggle.
    expect(screen.queryByText(dict.jimakuSearchButton)).toBeNull();
    expect(screen.queryByLabelText(dict.jimakuSearchTitle)).toBeNull();
    expect(screen.queryByLabelText(dict.jimakuSearchEpisode)).toBeNull();
    expect(screen.queryByText(dict.jimakuSearchAnimeToggle)).toBeNull();
  });

  it('clears the no-key message when the key is set while the dialog is open', async () => {
    vi.useFakeTimers();
    prefs.apiKey = '';
    renderDialog();
    expect(screen.getByText(dict.jimakuSearchNoKey)).toBeTruthy();

    // The key is set in the settings modal — the 1s poll notices it.
    prefs.apiKey = 'new-key';
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(screen.queryByText(dict.jimakuSearchNoKey)).toBeNull();
    // The form is back once the key exists.
    expect(screen.getByLabelText(dict.jimakuSearchTitle)).toBeTruthy();
  });

  it('opens the settings modal from the no-key message', () => {
    prefs.apiKey = '';
    renderDialog();
    fireEvent.click(screen.getByText(dict.jimakuOpenSettings));
    expect(onOpenSettings).toHaveBeenCalledTimes(1);
  });

  it('persists the anime/drama toggle and re-searches with the new flag', async () => {
    client.search
      .mockResolvedValueOnce({
        ok: true,
        data: [{ id: 729, name: 'Sousou no Frieren', flags: { anime: true } }],
      })
      .mockResolvedValueOnce({
        ok: true,
        data: [{ id: 12426, name: 'Meitantei no Mama de Ite', flags: { anime: false } }],
      });
    renderDialog();
    await searchForEntry();
    expect(client.search).toHaveBeenLastCalledWith(
      'test-key',
      expect.any(String),
      true,
      expect.any(AbortSignal),
    );

    // Toggle anime → drama (ToggleGroup): persisted via setJimakuSearchAnime.
    fireEvent.click(screen.getByText(dict.jimakuSearchDramaToggle));
    expect(setSearchAnime).toHaveBeenCalledWith(false);

    await searchForEntry();
    expect(client.search).toHaveBeenLastCalledWith(
      'test-key',
      expect.any(String),
      false,
      expect.any(AbortSignal),
    );
  });

  it('returns to the entry list via the back button', async () => {
    client.search.mockResolvedValueOnce({
      ok: true,
      data: [{ id: 729, name: 'Sousou no Frieren', flags: { anime: true } }],
    });
    client.files.mockResolvedValueOnce({
      ok: true,
      data: [{ url: 'u1', name: 'Frieren.EP01.srt', size: 100, last_modified: '' }],
    });
    renderDialog();
    await searchForEntry();

    fireEvent.click(screen.getByText('Sousou no Frieren'));
    await flush();
    expect(screen.getByText('Frieren.EP01.srt')).toBeTruthy();

    fireEvent.click(screen.getByText(dict.jimakuSearchBack));
    expect(screen.getByText('Sousou no Frieren')).toBeTruthy();
    expect(screen.queryByText('Frieren.EP01.srt')).toBeNull();
  });
});
