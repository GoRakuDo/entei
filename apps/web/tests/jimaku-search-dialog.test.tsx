import {
  render,
  cleanup,
  fireEvent,
  screen,
  act,
} from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'bun:test';
import { JimakuSearchDialog } from '@/components/player/JimakuSearchDialog';
import { dispatchJimakuKeyChanged } from '@/features/player/settings-bridge';
import { en } from '@i18n/locales/en';

const prefs = vi.hoisted(() => ({ apiKey: 'test-key' }));
const setApiKey = vi.hoisted(() => vi.fn());

vi.mock('@/features/player/jimaku-preferences', () => ({
  readJimakuPreferences: () => ({ ...prefs }),
  setJimakuApiKey: (...args: unknown[]) => setApiKey(...args),
}));

const client = vi.hoisted(() => ({
  search: vi.fn(),
  files: vi.fn(),
  download: vi.fn(),
}));

vi.mock('@/features/player/jimaku-client', () => ({
  searchJimakuEntries: (...args: unknown[]) => client.search(...args),
  getJimakuEntryFiles: (...args: unknown[]) => client.files(...args),
  downloadJimakuSubtitle: (...args: unknown[]) => client.download(...args),
}));

const dict = en.playerUI;
const onOpenChange = vi.fn();
const onSubtitleLoaded = vi.fn();
const onToast = vi.fn();

function renderDialog(open = true) {
  return render(
    <JimakuSearchDialog
      open={open}
      onOpenChange={onOpenChange}
      initialTitle="Sousou no Frieren EP01.mkv"
      onSubtitleLoaded={onSubtitleLoaded}
      onToast={onToast}
      dict={dict}
    />,
  );
}

async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

async function searchForEntry() {
  fireEvent.click(screen.getByLabelText(dict.jimakuSearchButton));
  await flush();
}

describe('JimakuSearchDialog', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    client.search.mockResolvedValue({ ok: false, error: 'empty' });
    client.files.mockResolvedValue({ ok: false, error: 'empty' });
    client.download.mockResolvedValue({ ok: false, error: 'network' });
    prefs.apiKey = 'test-key';
  });

  afterEach(() => {
    cleanup();
    prefs.apiKey = 'test-key';
    vi.useRealTimers();
  });

  it('renders the mockup shell without a duplicate close button', () => {
    renderDialog();
    expect(screen.getByText('JIMAKU.CC')).toBeTruthy();
    expect(screen.getByText('Judul Anime / Drama:')).toBeTruthy();
    expect(screen.getByText('Load')).toBeTruthy();
    expect(screen.getByText('Cancel')).toBeTruthy();
    expect(
      screen.queryByRole('button', { name: dict.dialogClose }),
    ).toBeNull();
  });

  it('pre-fills the title and searches anime and drama in parallel', async () => {
    client.search.mockResolvedValueOnce({
      ok: true,
      data: [{ id: 729, name: 'Sousou no Frieren', flags: { anime: true } }],
    });
    renderDialog();

    const titleInput = screen.getByLabelText(
      'Judul Anime / Drama:',
    ) as HTMLInputElement;
    expect(titleInput.value).toBe('Sousou no Frieren EP01.mkv');

    await searchForEntry();
    expect(client.search).toHaveBeenCalledTimes(2);
    expect(client.search).toHaveBeenNthCalledWith(
      1,
      'test-key',
      'Sousou no Frieren EP01.mkv',
      true,
      expect.any(AbortSignal),
    );
    expect(client.search).toHaveBeenNthCalledWith(
      2,
      'test-key',
      'Sousou no Frieren EP01.mkv',
      false,
      expect.any(AbortSignal),
    );
    expect(screen.getByText('Sousou no Frieren')).toBeTruthy();
  });

  it('merges both catalogs, dedupes by id, sorts A-Z, and badges each row', async () => {
    client.search
      .mockResolvedValueOnce({
        ok: true,
        data: [
          { id: 2, name: 'Zettai', flags: { anime: true } },
          { id: 1, name: 'Alpha', flags: { anime: true } },
        ],
      })
      .mockResolvedValueOnce({
        ok: true,
        data: [
          { id: 3, name: 'Beta', flags: { anime: false } },
          { id: 2, name: 'Zettai', flags: { anime: true } },
        ],
      });
    renderDialog();
    await searchForEntry();

    const names = Array.from(
      document.querySelectorAll('.entei-jimaku-row-text'),
    ).map((node) => node.textContent);
    expect(names).toEqual(['Alpha', 'Beta', 'Zettai']);
    expect(screen.getAllByText('ア')).toHaveLength(2);
    expect(screen.getAllByText('ド')).toHaveLength(1);
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

    expect(screen.getByText('Frieren.EP01.en.srt')).toBeTruthy();
    expect(screen.queryByText('Frieren.EP01.zip')).toBeNull();
  });

  it('selects a file first and downloads only when Load is pressed', async () => {
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

    expect((screen.getByText('Load') as HTMLButtonElement).disabled).toBe(true);

    fireEvent.click(screen.getByText('Sousou no Frieren'));
    await flush();

    const fileButton = screen
      .getByText('Frieren.EP01.srt')
      .closest('button') as HTMLButtonElement;
    fireEvent.click(fileButton);
    expect(fileButton.getAttribute('aria-pressed')).toBe('true');
    expect(client.download).not.toHaveBeenCalled();
    expect((screen.getByText('Load') as HTMLButtonElement).disabled).toBe(false);

    fireEvent.click(screen.getByText('Load'));
    await flush();

    expect(client.download).toHaveBeenCalledWith('u1', expect.any(AbortSignal));
    expect(onSubtitleLoaded).toHaveBeenCalledWith(
      expect.stringContaining('WEBVTT'),
    );
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('returns to the mixed entry list via the breadcrumb back button', async () => {
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
    const entryButton = screen
      .getByText('Sousou no Frieren')
      .closest('button') as HTMLButtonElement;
    expect(entryButton.getAttribute('aria-current')).toBe('true');
    expect(screen.queryByText('Frieren.EP01.srt')).toBeNull();
  });

  it('closes the dialog from Cancel', () => {
    renderDialog();
    fireEvent.click(screen.getByText('Cancel'));
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('toasts rate-limit once for both parallel failures', async () => {
    client.search.mockResolvedValue({ ok: false, error: 'rate-limit' });
    renderDialog();
    await searchForEntry();

    expect(onToast).toHaveBeenCalledTimes(1);
    expect(onToast).toHaveBeenCalledWith('rate-limit');
    expect(screen.getByText(dict.jimakuSearchResultsEmpty)).toBeTruthy();
  });

  it('toasts auth on an invalid API key', async () => {
    client.search.mockResolvedValue({ ok: false, error: 'auth' });
    renderDialog();
    await searchForEntry();

    expect(onToast).toHaveBeenCalledTimes(1);
    expect(onToast).toHaveBeenCalledWith('auth');
  });

  it('replaces the search form with an inline API-key form when the key is missing', () => {
    prefs.apiKey = '';
    renderDialog();

    expect(screen.getByText(dict.jimakuSearchNoKey)).toBeTruthy();
    const placeholder = dict.jimakuApiKeyPlaceholder ?? 'jimaku.cc API key';
    const keyInput = screen.getByLabelText(placeholder);
    expect(keyInput).toBeTruthy();
    expect((keyInput as HTMLInputElement).type).toBe('password');
    const saveLabel = dict.contextKeySave ?? 'Save';
    const saveButton = screen.getByLabelText(saveLabel);
    expect((saveButton as HTMLButtonElement).type).toBe('submit');
    expect((saveButton as HTMLButtonElement).disabled).toBe(true);
    expect(screen.queryByLabelText(dict.jimakuSearchButton)).toBeNull();
    expect(screen.queryByLabelText('Judul Anime / Drama:')).toBeNull();
    expect(screen.queryByText(dict.jimakuSearchAnimeToggle)).toBeNull();
    expect(screen.queryByText(dict.jimakuSearchDramaToggle)).toBeNull();
    expect(screen.queryByText(dict.jimakuOpenSettings)).toBeNull();
  });

  it('saves the typed key from the inline form and switches back to search fields', () => {
    prefs.apiKey = '';
    renderDialog();

    const placeholder = dict.jimakuApiKeyPlaceholder ?? 'jimaku.cc API key';
    const keyInput = screen.getByLabelText(placeholder) as HTMLInputElement;
    fireEvent.change(keyInput, { target: { value: 'inline-key' } });

    const saveLabel = dict.contextKeySave ?? 'Save';
    const saveButton = screen.getByLabelText(saveLabel);
    expect((saveButton as HTMLButtonElement).disabled).toBe(false);
    fireEvent.submit(keyInput.closest('form') as HTMLFormElement);

    expect(setApiKey).toHaveBeenCalledWith('inline-key');
    expect(screen.queryByText(dict.jimakuSearchNoKey)).toBeNull();
    expect(screen.getByLabelText('Judul Anime / Drama:')).toBeTruthy();
    expect(screen.getByLabelText(dict.jimakuSearchButton)).toBeTruthy();
  });

  it('clears the no-key message when the key is set while the dialog is open', async () => {
    prefs.apiKey = '';
    renderDialog();
    expect(screen.getByText(dict.jimakuSearchNoKey)).toBeTruthy();

    prefs.apiKey = 'new-key';
    await act(async () => {
      dispatchJimakuKeyChanged(true);
    });
    expect(screen.queryByText(dict.jimakuSearchNoKey)).toBeNull();
    expect(screen.getByLabelText('Judul Anime / Drama:')).toBeTruthy();
  });

  it('ignores whitespace-only keys when submitting the inline form', () => {
    prefs.apiKey = '';
    renderDialog();

    const placeholder = dict.jimakuApiKeyPlaceholder ?? 'jimaku.cc API key';
    const keyInput = screen.getByLabelText(placeholder) as HTMLInputElement;
    fireEvent.change(keyInput, { target: { value: '   ' } });
    const saveLabel = dict.contextKeySave ?? 'Save';
    expect(
      (screen.getByLabelText(saveLabel) as HTMLButtonElement).disabled,
    ).toBe(true);

    fireEvent.submit(keyInput.closest('form') as HTMLFormElement);
    expect(setApiKey).not.toHaveBeenCalled();
    expect(screen.getByText(dict.jimakuSearchNoKey)).toBeTruthy();
  });
});
