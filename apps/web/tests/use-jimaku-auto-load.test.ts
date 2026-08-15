import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import { act } from 'react';
import { useJimakuAutoLoad } from '../src/features/player/use-jimaku-auto-load';

// Mock the P1 modules so the hook logic is tested in isolation.
const prefs = vi.hoisted(() => ({
  autoLoadEnabled: true,
  apiKey: 'test-key',
}));

vi.mock('../src/features/player/jimaku-preferences', () => ({
  readJimakuPreferences: () => ({ ...prefs }),
  shouldShowJimakuToast: () => true,
  incrementJimakuToastCount: () => 1,
  setJimakuSearchAnime: () => {},
}));

const client = vi.hoisted(() => ({
  search: vi.fn(),
  files: vi.fn(),
  download: vi.fn(),
}));

vi.mock('../src/features/player/jimaku-client', () => ({
  searchJimakuEntries: (...a: unknown[]) => client.search(...a),
  getJimakuEntryFiles: (...a: unknown[]) => client.files(...a),
  downloadJimakuSubtitle: (...a: unknown[]) => client.download(...a),
}));

describe('useJimakuAutoLoad', () => {
  const onSubtitleLoaded = vi.fn();
  const onOpenSearch = vi.fn();
  const onToast = vi.fn();

  beforeEach(() => {
    prefs.autoLoadEnabled = true;
    prefs.apiKey = 'test-key';
    onSubtitleLoaded.mockClear();
    onOpenSearch.mockClear();
    onToast.mockClear();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  function render() {
    return renderHook(() =>
      useJimakuAutoLoad({ onSubtitleLoaded, onOpenSearch, onToast }),
    );
  }

  it('does nothing when the auto-load switch is OFF', async () => {
    prefs.autoLoadEnabled = false;
    const { result } = render();
    await act(async () => {
      await result.current.runAutoLoad('Some Title EP01.mkv', 'k1');
    });
    expect(client.search).not.toHaveBeenCalled();
    expect(onToast).not.toHaveBeenCalled();
  });

  it('shows the key-missing toast (max-counted) when no API key is set', async () => {
    prefs.apiKey = '';
    const { result } = render();
    await act(async () => {
      await result.current.runAutoLoad('Some Title EP01.mkv', 'k1');
    });
    expect(client.search).not.toHaveBeenCalled();
    expect(onToast).toHaveBeenCalledWith('key-missing');
  });

  it('does nothing for an unparseable title', async () => {
    const { result } = render();
    await act(async () => {
      await result.current.runAutoLoad('-------', 'k1');
    });
    expect(client.search).not.toHaveBeenCalled();
  });

  it('loads subtitles on an exact match (anime first)', async () => {
    client.search.mockResolvedValueOnce({
      ok: true,
      data: [{ id: 729, name: 'Sousou no Frieren', flags: { anime: true } }],
    });
    client.files.mockResolvedValueOnce({
      ok: true,
      data: [
        { url: 'https://jimaku.cc/dl/a.srt', name: 'a.srt', size: 100, last_modified: '' },
        { url: 'https://jimaku.cc/dl/en.srt', name: 'b.en.srt', size: 90, last_modified: '' },
      ],
    });
    client.download.mockResolvedValueOnce({ ok: true, data: 'WEBVTT\n\n00:00:01 --> 00:00:02\nTest' });
    const { result } = render();
    await act(async () => {
      await result.current.runAutoLoad('Sousou no Frieren EP01.mkv', 'k1');
    });
    expect(client.search).toHaveBeenCalledWith(
      'test-key',
      'Sousou no Frieren',
      true,
      expect.any(AbortSignal),
    );
    expect(client.files).toHaveBeenCalledWith('test-key', 729, 1, expect.any(AbortSignal));
    expect(onSubtitleLoaded).toHaveBeenCalledWith(expect.stringContaining('WEBVTT'));
    expect(onOpenSearch).not.toHaveBeenCalled();
    // P4-1: spinner cleared once the subtitle is applied.
    expect(result.current.isLoading).toBe(false);
  });

  it('falls back to anime=false when anime search is empty', async () => {
    client.search
      .mockResolvedValueOnce({ ok: false, error: 'empty' })
      .mockResolvedValueOnce({
        ok: true,
        data: [{ id: 12426, name: 'Meitantei no Mama de Ite', flags: { anime: false } }],
      });
    client.files.mockResolvedValueOnce({ ok: true, data: [] });
    const { result } = render();
    await act(async () => {
      await result.current.runAutoLoad(
        '[MagicStar] Meitantei no Mama de Ite EP01 [1080p] [JPN_SUB].mkv',
        'k1',
      );
    });
    expect(client.search).toHaveBeenNthCalledWith(
      1,
      'test-key',
      expect.any(String),
      true,
      expect.any(AbortSignal),
    );
    expect(client.search).toHaveBeenNthCalledWith(
      2,
      'test-key',
      expect.any(String),
      false,
      expect.any(AbortSignal),
    );
    // Exact match found, but zero Japanese files → search modal fallback.
    expect(onOpenSearch).toHaveBeenCalledWith(expect.any(String), false);
    expect(result.current.isLoading).toBe(false);
  });

  it('opens the search modal when the top entry does not match', async () => {
    client.search.mockResolvedValueOnce({
      ok: true,
      data: [{ id: 1, name: 'Frieren 2nd Season', flags: { anime: true } }],
    });
    const { result } = render();
    await act(async () => {
      await result.current.runAutoLoad('Frieren EP02.mkv', 'k1');
    });
    expect(onOpenSearch).toHaveBeenCalledWith('Frieren', true);
    expect(client.files).not.toHaveBeenCalled();
    // P4-1: fallback to the search modal stops the spinner (no lingering glow).
    expect(result.current.isLoading).toBe(false);
  });

  it('shows a rate-limit toast and does not retry', async () => {
    client.search.mockResolvedValueOnce({ ok: false, error: 'rate-limit' });
    const { result } = render();
    await act(async () => {
      await result.current.runAutoLoad('Sousou no Frieren EP01.mkv', 'k1');
    });
    expect(onToast).toHaveBeenCalledWith('rate-limit');
    expect(client.search).toHaveBeenCalledTimes(1);
    expect(onOpenSearch).not.toHaveBeenCalled();
    expect(result.current.isLoading).toBe(false);
  });

  it('stays silent when superseded by a newer trigger (media switch)', async () => {
    // Media A's search resolves, but runB starts before A can proceed — A is
    // aborted at its first checkpoint and must produce no side effects.
    client.search.mockResolvedValueOnce({
      ok: true,
      data: [{ id: 1, name: 'Media A', flags: { anime: true } }],
    });
    // Media B: no JP files → search modal fallback. These mocks are consumed
    // by runB (runA aborts before reaching the files/download stages).
    client.search.mockResolvedValueOnce({
      ok: true,
      data: [{ id: 2, name: 'Media B', flags: { anime: true } }],
    });
    client.files.mockResolvedValueOnce({ ok: true, data: [] });

    const { result } = render();
    const runA = result.current.runAutoLoad('Media A EP01.mkv', 'kA');
    const runB = result.current.runAutoLoad('Media B EP01.mkv', 'kB');
    await act(async () => {
      await runB;
      await runA; // aborted at its first checkpoint — resolves silently
    });

    // A must neither load subtitles nor open the search modal…
    expect(onSubtitleLoaded).not.toHaveBeenCalled();
    // …and only B's fallback fires.
    expect(onOpenSearch).toHaveBeenCalledTimes(1);
    expect(onOpenSearch).toHaveBeenCalledWith('Media B', true);
  });

  it('aborts the previous run\'s requests when a newer trigger starts', async () => {
    // Media A: search resolves (captures the signal). A is aborted at its
    // search checkpoint before reaching the files stage.
    let firstSignal: AbortSignal | undefined;
    client.search.mockImplementationOnce(
      (_key: string, _query: string, _anime: boolean, signal?: AbortSignal) => {
        firstSignal = signal;
        return Promise.resolve({
          ok: true,
          data: [{ id: 1, name: 'Media A', flags: { anime: true } }],
        });
      },
    );
    // Media B: completes its flow — the files mock below is consumed by runB.
    client.search.mockResolvedValueOnce({
      ok: true,
      data: [{ id: 2, name: 'Media B', flags: { anime: true } }],
    });
    client.files.mockResolvedValueOnce({ ok: true, data: [] });

    const { result } = render();
    const runA = result.current.runAutoLoad('Media A EP01.mkv', 'kA');
    const runB = result.current.runAutoLoad('Media B EP01.mkv', 'kB');
    await act(async () => {
      await runB;
      await runA; // A aborts at its search checkpoint — resolves silently
    });

    // B's start must abort A's in-flight controller…
    expect(firstSignal?.aborted).toBe(true);
    // …while B's own flow still completes (fallback to the search modal).
    expect(onOpenSearch).toHaveBeenCalledWith('Media B', true);
  });

  it('keeps isLoading true while the search is in flight, then clears it', async () => {
    let resolveSearch!: (value: unknown) => void;
    client.search.mockImplementationOnce(
      () =>
        new Promise((res) => {
          resolveSearch = res;
        }),
    );
    const { result } = render();
    let runPromise!: Promise<void>;
    act(() => {
      runPromise = result.current.runAutoLoad('Sousou no Frieren EP01.mkv', 'k1');
    });
    // P4-1: spinner is on while the search is pending (no subtitles yet).
    expect(result.current.isLoading).toBe(true);

    await act(async () => {
      resolveSearch({ ok: false, error: 'network' });
      await runPromise;
    });
    expect(result.current.isLoading).toBe(false);
  });
});
