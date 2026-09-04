/**
 * Tests for the NadeshikoPanel (RightPanel context tab).
 * ---------------------------------------------------------------------------
 * - Renders the search form + tab label
 * - Submits to the API client with include: ['media'] (the user-reported
 *   "作品名が見えない" fix)
 * - Card layout: 16:9 image, audio toggle, centered line, timestamp,
 *   context paragraph (auto-fetched), work name
 * - Shows key-missing, invalid-key, rate-limited, and generic errors
 * - Renders empty / no-results state
 * - Renders inline key form on key-missing
 * - Audio toggle pauses the previously-playing card
 * - Switches to the context tab when invoked
 * ---------------------------------------------------------------------------
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  render,
  fireEvent,
  waitFor,
  screen,
  act,
} from '@testing-library/react';
import { RightPanel } from '@/components/player/RightPanel';
import * as nadeshikoClient from '@/features/nadeshiko/nadeshiko-client';
import * as apiKey from '@/features/nadeshiko/api-key';

function baseDict(): Record<string, unknown> {
  return {
    rightPanelTabsLabel: 'Panel',
    rightPanelTabCaptions: 'Captions',
    contextTabLabel: 'Context',
    contextSearchPlaceholder: 'Search',
    contextSearchButton: 'Search',
    contextSearchAriaLabel: 'Search',
    contextEmpty: 'No results',
    contextKeyMissing: 'Set API key',
    contextKeyInputPlaceholder: 'Enter API key',
    contextKeySave: 'Save',
    contextKeySaveFailed: 'Could not save',
    contextInvalidKey: 'Invalid key',
    contextRateLimited: (s: number) => `Wait ${s}s`,
    contextQuotaExceeded: 'Please check your Nadeshiko usage',
    contextNetworkError: 'Network error',
    contextGenericError: 'Generic error',
    contextContextLoading: 'Loading context…',
    contextContextFailed: 'Could not load context',
    contextAudioPlay: 'Play audio',
    contextAudioStop: 'Stop audio',
    contextNoTimestamp: '–',
    contextResultsHeading: (n: number) => `Results (${n})`,
  };
}

function makeDict() {
  return baseDict() as Parameters<typeof RightPanel>[0]['dict'];
}

function noop() {}

const baseProps = () => ({
  dict: makeDict(),
  cues: [],
  activeCueId: null,
  onCueClick: noop,
  onSubtitleSelect: noop,
  subtitleAccept: '.srt',
});

/**
 * Stub HTMLAudioElement so we can assert play / pause / reset semantics.
 * jsdom doesn't ship a full audio implementation; we install just the
 * surface our component touches.
 */
function installAudioStub() {
  type AudioStub = HTMLAudioElement & {
    __playCount: number;
    __pauseCount: number;
    __resetCount: number;
    __currentTime: number;
  };
  const origPlay = HTMLAudioElement.prototype.play;
  const origPause = HTMLAudioElement.prototype.pause;
  HTMLAudioElement.prototype.play = function (this: AudioStub) {
    this.__playCount = (this.__playCount ?? 0) + 1;
    return Promise.resolve();
  };
  HTMLAudioElement.prototype.pause = function (this: AudioStub) {
    this.__pauseCount = (this.__pauseCount ?? 0) + 1;
  };
  // We can't override the currentTime setter on the prototype easily, so
  // track assignments via a property descriptor on instances via Object.
  const origDescriptor = Object.getOwnPropertyDescriptor(
    HTMLAudioElement.prototype,
    'currentTime',
  );
  Object.defineProperty(HTMLAudioElement.prototype, 'currentTime', {
    configurable: true,
    get(this: AudioStub) {
      return this.__currentTime ?? 0;
    },
    set(this: AudioStub, v: number) {
      this.__currentTime = v;
      this.__resetCount = (this.__resetCount ?? 0) + 1;
    },
  });
  return () => {
    HTMLAudioElement.prototype.play = origPlay;
    HTMLAudioElement.prototype.pause = origPause;
    if (origDescriptor) {
      Object.defineProperty(
        HTMLAudioElement.prototype,
        'currentTime',
        origDescriptor,
      );
    }
  };
}

describe('RightPanel — Nadeshiko context tab', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    window.localStorage.clear();
  });

  it('renders the context tab label', () => {
    const { getByRole } = render(
      <RightPanel visible={true} {...baseProps()} />,
    );
    const tab = getByRole('tab', { name: /Context/i });
    expect(tab).toBeTruthy();
    expect(tab.getAttribute('aria-controls')).toBe('right-panel-context');
  });

  it('shows the key-missing state when no key is stored', () => {
    const { getByText, getByPlaceholderText } = render(
      <RightPanel visible={true} {...baseProps()} />,
    );
    fireEvent.click(getByText('Context'));
    expect(getByText('Set API key')).toBeTruthy();
    expect(getByPlaceholderText('Enter API key')).toBeTruthy();
  });

  it('saves the key to localStorage and clears the key-missing state', () => {
    const { getByText, getByPlaceholderText, queryByText } = render(
      <RightPanel visible={true} {...baseProps()} />,
    );
    fireEvent.click(getByText('Context'));
    fireEvent.change(getByPlaceholderText('Enter API key'), {
      target: { value: 'KEY-123' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(window.localStorage.getItem('entei.nadeshiko.api-key.v1')).toBe(
      'KEY-123',
    );
    // Key saved → key-missing state disappears.
    expect(queryByText('Set API key')).toBeNull();
  });

  it('passes include: ["media"] to the search call so workName resolves', async () => {
    window.localStorage.setItem('entei.nadeshiko.api-key.v1', 'KEY');
    const spy = vi
      .spyOn(nadeshikoClient, 'searchNadeshikoSegments')
      .mockResolvedValue([]);

    const { getByText } = render(
      <RightPanel visible={true} {...baseProps()} />,
    );
    fireEvent.click(getByText('Context'));
    const input = document.querySelector(
      'input[placeholder="Search"]',
    ) as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'また' } });
    fireEvent.click(screen.getByRole('button', { name: 'Search' }));

    await waitFor(() => {
      expect(spy).toHaveBeenCalled();
    });
    const [, , options] = spy.mock.calls[0]!;
    expect(options).toEqual({ include: ['media'] });
  });

  it('renders a result card with image, line, timestamp, and work name', async () => {
    window.localStorage.setItem('entei.nadeshiko.api-key.v1', 'KEY');
    vi.spyOn(nadeshikoClient, 'searchNadeshikoSegments').mockResolvedValue([
      {
        id: 'seg-1',
        workName: '神之塔 -Tower of God-',
        line: '僕が聞く言葉 見る言葉…',
        timestampSeconds: 117,
        timestampLabel: '1:57',
        imageUrl: 'https://cdn.example/x.webp',
        audioUrl: 'https://cdn.example/x.mp3',
      },
    ]);
    vi.spyOn(nadeshikoClient, 'getNadeshikoSegmentContext').mockResolvedValue({
      center: {
        id: 'seg-1',
        workName: '神之塔 -Tower of God-',
        line: '僕が聞く言葉 見る言葉…',
        timestampSeconds: 117,
      },
      surrounding: [
        {
          id: 'seg-1-prev',
          workName: '神之塔 -Tower of God-',
          line: '前にも教えたでしょ',
          timestampSeconds: 110,
        },
      ],
      centerIdx: 1,
    });

    const { getByText, findByText, container } = render(
      <RightPanel visible={true} {...baseProps()} />,
    );
    fireEvent.click(getByText('Context'));
    const input = document.querySelector(
      'input[placeholder="Search"]',
    ) as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'また' } });
    fireEvent.click(screen.getByRole('button', { name: 'Search' }));

    // Mocked segment fields surface in the new layout.
    expect(await findByText('神之塔 -Tower of God-')).toBeTruthy();
    expect(await findByText('僕が聞く言葉 見る言葉…')).toBeTruthy();
    expect(await findByText('1:57')).toBeTruthy();
    // Image renders with the API-provided src.
    const img = container.querySelector(
      'img.entei-nadeshiko-card-image',
    ) as HTMLImageElement | null;
    expect(img?.getAttribute('src')).toBe('https://cdn.example/x.webp');
    // Context paragraph: surrounding + centre joined into one block.
    await waitFor(() => {
      expect(
        getByText('前にも教えたでしょ 僕が聞く言葉 見る言葉…'),
      ).toBeTruthy();
    });
    // English translation is gone.
    expect(container.querySelector('.entei-nadeshiko-card-english')).toBeNull();
  });

  it('falls back to the dark-navy image placeholder when imageUrl is absent', async () => {
    window.localStorage.setItem('entei.nadeshiko.api-key.v1', 'KEY');
    vi.spyOn(nadeshikoClient, 'searchNadeshikoSegments').mockResolvedValue([
      {
        id: 'seg-2',
        workName: 'Sousou no Frieren',
        line: 'また会えたね',
        timestampSeconds: 91,
        timestampLabel: '01:31',
        // No imageUrl / audioUrl — fallback path.
      },
    ]);
    vi.spyOn(nadeshikoClient, 'getNadeshikoSegmentContext').mockResolvedValue({
      center: {
        id: 'seg-2',
        workName: 'Sousou no Frieren',
        line: 'また会えたね',
        timestampSeconds: 91,
      },
      surrounding: [],
      centerIdx: 0,
    });

    const { getByText, findByText, container } = render(
      <RightPanel visible={true} {...baseProps()} />,
    );
    fireEvent.click(getByText('Context'));
    const input = document.querySelector(
      'input[placeholder="Search"]',
    ) as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'q' } });
    fireEvent.click(screen.getByRole('button', { name: 'Search' }));

    expect(await findByText('Sousou no Frieren')).toBeTruthy();
    // Fallback block is rendered, not an <img>.
    expect(
      container.querySelector('img.entei-nadeshiko-card-image'),
    ).toBeNull();
    expect(
      container.querySelector('.entei-nadeshiko-card-image-fallback'),
    ).toBeTruthy();
  });

  it('toggles audio: play → stop, switching cards pauses the previous one', async () => {
    const restoreAudio = installAudioStub();
    try {
      window.localStorage.setItem('entei.nadeshiko.api-key.v1', 'KEY');
      vi.spyOn(nadeshikoClient, 'searchNadeshikoSegments').mockResolvedValue([
        {
          id: 'seg-a',
          workName: 'Work A',
          line: 'A のセリフ',
          timestampSeconds: 10,
          timestampLabel: '0:10',
          audioUrl: 'https://cdn.example/a.mp3',
          imageUrl: 'https://cdn.example/a.webp',
        },
        {
          id: 'seg-b',
          workName: 'Work B',
          line: 'B のセリフ',
          timestampSeconds: 20,
          timestampLabel: '0:20',
          audioUrl: 'https://cdn.example/b.mp3',
          imageUrl: 'https://cdn.example/b.webp',
        },
      ]);
      vi.spyOn(nadeshikoClient, 'getNadeshikoSegmentContext').mockResolvedValue(
        {
          center: {
            id: 'noop',
            workName: '',
            line: '',
            timestampSeconds: 0,
          },
          surrounding: [],
          centerIdx: 0,
        },
      );

      const { getByText, findAllByLabelText } = render(
        <RightPanel visible={true} {...baseProps()} />,
      );
      fireEvent.click(getByText('Context'));
      const input = document.querySelector(
        'input[placeholder="Search"]',
      ) as HTMLInputElement;
      fireEvent.change(input, { target: { value: 'q' } });
      fireEvent.click(screen.getByRole('button', { name: 'Search' }));

      const buttons = await findAllByLabelText('Play audio');
      expect(buttons).toHaveLength(2);
      const audios = document.querySelectorAll('audio') as NodeListOf<
        HTMLAudioElement & { __playCount?: number; __pauseCount?: number }
      >;
      expect(audios).toHaveLength(2);

      // Press card A's play button.
      await act(async () => {
        fireEvent.click(buttons[0]!);
      });
      expect(audios[0]!.__playCount).toBe(1);
      // While A is playing, A's button reflects aria-pressed + Stop label.
      const stopOnA = await waitFor(() => {
        const all = screen.getAllByLabelText('Stop audio');
        expect(all.length).toBe(1);
        return all[0]!;
      });
      expect(stopOnA.getAttribute('aria-pressed')).toBe('true');

      // Press card B's play button — A should be paused + rewound, B plays.
      await act(async () => {
        fireEvent.click(buttons[1]!);
      });
      expect(audios[0]!.__pauseCount).toBe(1);
      expect(audios[1]!.__playCount).toBe(1);
      // B is now the playing card.
      await waitFor(() => {
        expect(screen.getAllByLabelText('Stop audio').length).toBe(1);
      });

      // Press B again to stop — both audios paused, B rewound.
      await act(async () => {
        fireEvent.click(screen.getByLabelText('Stop audio'));
      });
      expect(audios[1]!.__pauseCount).toBe(1);
      // Back to "Play audio" everywhere.
      await waitFor(() => {
        expect(screen.getAllByLabelText('Play audio')).toHaveLength(2);
      });
    } finally {
      restoreAudio();
    }
  });

  it('auto-fetches context once per card without IntersectionObserver', async () => {
    window.localStorage.setItem('entei.nadeshiko.api-key.v1', 'KEY');
    vi.spyOn(nadeshikoClient, 'searchNadeshikoSegments').mockResolvedValue([
      {
        id: 'seg-ctx',
        workName: 'Work',
        line: 'セリフ',
        timestampSeconds: 30,
        timestampLabel: '0:30',
        imageUrl: 'https://cdn.example/x.webp',
      },
    ]);
    const ctxSpy = vi
      .spyOn(nadeshikoClient, 'getNadeshikoSegmentContext')
      .mockResolvedValue({
        center: {
          id: 'seg-ctx',
          workName: 'Work',
          line: 'セリフ',
          timestampSeconds: 30,
        },
        surrounding: [
          {
            id: 'prev',
            workName: 'Work',
            line: '前の文脈',
            timestampSeconds: 25,
          },
        ],
        centerIdx: 1,
      });

    const { getByText, findByText } = render(
      <RightPanel visible={true} {...baseProps()} />,
    );
    fireEvent.click(getByText('Context'));
    const input = document.querySelector(
      'input[placeholder="Search"]',
    ) as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'q' } });
    fireEvent.click(screen.getByRole('button', { name: 'Search' }));

    // Context fetch fires automatically once per card.
    await waitFor(() => {
      expect(ctxSpy).toHaveBeenCalledWith('KEY', 'seg-ctx', expect.anything());
    });
    expect(await findByText('前の文脈 セリフ')).toBeTruthy();
  });

  it('renders the no-results state when the API returns an empty list', async () => {
    window.localStorage.setItem('entei.nadeshiko.api-key.v1', 'KEY');
    vi.spyOn(nadeshikoClient, 'searchNadeshikoSegments').mockResolvedValue([]);

    const { getByText, findByText } = render(
      <RightPanel visible={true} {...baseProps()} />,
    );
    fireEvent.click(getByText('Context'));
    const input = document.querySelector(
      'input[placeholder="Search"]',
    ) as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'x' } });
    fireEvent.click(screen.getByRole('button', { name: 'Search' }));

    expect(await findByText('No results')).toBeTruthy();
  });

  it('shows the invalid-key banner when the client throws invalid-key', async () => {
    window.localStorage.setItem('entei.nadeshiko.api-key.v1', 'BAD');
    const err = Object.assign(new Error('x'), {
      kind: 'invalid-key',
    }) as nadeshikoClient.NadeshikoError;
    vi.spyOn(nadeshikoClient, 'searchNadeshikoSegments').mockRejectedValue(err);

    const { getByText, findByText } = render(
      <RightPanel visible={true} {...baseProps()} />,
    );
    fireEvent.click(getByText('Context'));
    const input = document.querySelector(
      'input[placeholder="Search"]',
    ) as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'q' } });
    fireEvent.click(screen.getByRole('button', { name: 'Search' }));

    expect(await findByText('Invalid key')).toBeTruthy();
  });

  it('shows the rate-limited banner with the retry-after seconds', async () => {
    window.localStorage.setItem('entei.nadeshiko.api-key.v1', 'K');
    const err = Object.assign(new Error('x'), {
      kind: 'rate-limited',
      retryAfterSeconds: 7,
    }) as nadeshikoClient.NadeshikoError;
    vi.spyOn(nadeshikoClient, 'searchNadeshikoSegments').mockRejectedValue(err);

    const { getByText, findByText } = render(
      <RightPanel visible={true} {...baseProps()} />,
    );
    fireEvent.click(getByText('Context'));
    const input = document.querySelector(
      'input[placeholder="Search"]',
    ) as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'q' } });
    fireEvent.click(screen.getByRole('button', { name: 'Search' }));

    expect(await findByText('Wait 7s')).toBeTruthy();
  });

  it('shows the quota-exceeded banner when the API returns 429 + QUOTA_EXCEEDED', async () => {
    window.localStorage.setItem('entei.nadeshiko.api-key.v1', 'K');
    const err = Object.assign(new Error('x'), {
      kind: 'quota-exceeded',
    }) as nadeshikoClient.NadeshikoError;
    vi.spyOn(nadeshikoClient, 'searchNadeshikoSegments').mockRejectedValue(err);

    const { getByText, findByText } = render(
      <RightPanel visible={true} {...baseProps()} />,
    );
    fireEvent.click(getByText('Context'));
    const input = document.querySelector(
      'input[placeholder="Search"]',
    ) as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'q' } });
    fireEvent.click(screen.getByRole('button', { name: 'Search' }));

    // Quota display was removed from the settings tab (GET /user/me is
    // CORS-blocked browser-side), so overage is surfaced here instead,
    // telling the user to check their Nadeshiko usage.
    expect(await findByText('Please check your Nadeshiko usage')).toBeTruthy();
  });

  it('re-reads the API key when the key-changed event fires', async () => {
    const { getByText, findByText, queryByText } = render(
      <RightPanel visible={true} {...baseProps()} />,
    );
    fireEvent.click(getByText('Context'));
    expect(getByText('Set API key')).toBeTruthy();

    window.localStorage.setItem('entei.nadeshiko.api-key.v1', 'NEW');
    window.dispatchEvent(new CustomEvent('entei:nadeshiko-key-changed'));

    await waitFor(() => {
      expect(queryByText('Set API key')).toBeNull();
    });

    vi.spyOn(apiKey, 'readNadeshikoApiKey').mockReturnValue('NEW');
    vi.spyOn(nadeshikoClient, 'searchNadeshikoSegments').mockResolvedValue([]);
    const input = document.querySelector(
      'input[placeholder="Search"]',
    ) as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'q' } });
    fireEvent.click(screen.getByRole('button', { name: 'Search' }));
    expect(await findByText('No results')).toBeTruthy();
  });

  it('does not render history/tab labels that no longer exist', () => {
    const { queryByText } = render(
      <RightPanel visible={true} {...baseProps()} />,
    );
    // History label must be gone (it moved to /tracker/).
    expect(queryByText('History')).toBeNull();
  });

  it('renders the context paragraph in temporal order: before + center + after', async () => {
    // Regression: prior code concatenated surrounding then appended
    // centre, which put after-lines BEFORE the centre when the spec
    // returned a window like [before, center, after]. The fix splits
    // surrounding via centerIdx and renders before + centre + after.
    window.localStorage.setItem('entei.nadeshiko.api-key.v1', 'KEY');
    vi.spyOn(nadeshikoClient, 'searchNadeshikoSegments').mockResolvedValue([
      {
        id: 'seg-tempo',
        workName: 'Tower of God',
        line: '中',
        timestampSeconds: 120,
        timestampLabel: '2:00',
        imageUrl: 'https://cdn.example/x.webp',
      },
    ]);
    // Server returns temporal order: [before, center, after].
    // surrounding = [before, after] (centre removed), centerIdx = 1.
    vi.spyOn(nadeshikoClient, 'getNadeshikoSegmentContext').mockResolvedValue({
      center: {
        id: 'seg-tempo',
        workName: 'Tower of God',
        line: '中',
        timestampSeconds: 120,
      },
      surrounding: [
        {
          id: 'before',
          workName: 'Tower of God',
          line: '前',
          timestampSeconds: 115,
        },
        {
          id: 'after',
          workName: 'Tower of God',
          line: '後',
          timestampSeconds: 125,
        },
      ],
      centerIdx: 1,
    });

    const { getByText, findByText } = render(
      <RightPanel visible={true} {...baseProps()} />,
    );
    fireEvent.click(getByText('Context'));
    const input = document.querySelector(
      'input[placeholder="Search"]',
    ) as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'q' } });
    fireEvent.click(screen.getByRole('button', { name: 'Search' }));

    // The exact rendered text must be `前 中 後` — the previous bug
    // rendered `前 後 中`. Use a non-substring assertion so we catch
    // both directions of the bug.
    const para = await findByText('前 中 後');
    expect(para).toBeTruthy();
    expect(
      document.querySelector('.entei-nadeshiko-card-context')?.textContent,
    ).toBe('前 中 後');
  });

  it('does not re-fire the context fetch when the same card remounts (StrictMode guard)', async () => {
    // LOW-1 burst-cap fix: React 18 StrictMode double-invokes effects.
    // The panel-level `fetchedIds` set ensures only one network call
    // fires per segment id per search batch. We simulate a remount by
    // re-rendering the panel with the same result set and asserting the
    // context spy was called exactly once per card.
    window.localStorage.setItem('entei.nadeshiko.api-key.v1', 'KEY');
    vi.spyOn(nadeshikoClient, 'searchNadeshikoSegments').mockResolvedValue([
      {
        id: 'seg-guard',
        workName: 'Work',
        line: 'セリフ',
        timestampSeconds: 30,
        timestampLabel: '0:30',
        imageUrl: 'https://cdn.example/x.webp',
      },
    ]);
    const ctxSpy = vi
      .spyOn(nadeshikoClient, 'getNadeshikoSegmentContext')
      .mockResolvedValue({
        center: {
          id: 'seg-guard',
          workName: 'Work',
          line: 'セリフ',
          timestampSeconds: 30,
        },
        surrounding: [],
        centerIdx: 0,
      });

    const { getByText, rerender } = render(
      <RightPanel visible={true} {...baseProps()} />,
    );
    fireEvent.click(getByText('Context'));
    const input = document.querySelector(
      'input[placeholder="Search"]',
    ) as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'q' } });
    fireEvent.click(screen.getByRole('button', { name: 'Search' }));

    await waitFor(() => {
      expect(ctxSpy).toHaveBeenCalledTimes(1);
    });

    // Re-render with the same props — simulates a StrictMode-driven
    // remount. The fetchedIds set lives on a panel-level ref so it
    // survives; the second card instance must short-circuit.
    rerender(<RightPanel visible={true} {...baseProps()} />);

    // Give a microtask tick in case any stray effect tries to fire.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(ctxSpy).toHaveBeenCalledTimes(1);

    // A fresh search clears the set, so a re-search does fire the
    // fetch again (the guard only suppresses remounts, not new work).
    fireEvent.click(getByText('Context'));
    fireEvent.change(input, { target: { value: 'q2' } });
    fireEvent.click(screen.getByRole('button', { name: 'Search' }));
    await waitFor(() => {
      expect(ctxSpy).toHaveBeenCalledTimes(2);
    });

    // The card renders both the segment line and (when the context
    // response has no surrounding entries) the centre as the context
    // paragraph. Both contain "セリフ" — just assert the segment line is
    // present.
    await waitFor(() => {
      expect(
        document.querySelector('.entei-nadeshiko-card-line')?.textContent,
      ).toBe('セリフ');
    });
  });
});
