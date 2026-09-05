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
import type {
  NadeshikoSearchPage,
  NadeshikoSegment,
} from '@/features/nadeshiko/nadeshiko-client';

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
    contextLoadingMore: 'Loading more…',
    contextRetry: 'Retry',
    contextEndOfResults: 'End of results',
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

/** Build a NadeshikoSearchPage from a segment list + optional pagination. */
function makePage(
  segments: NadeshikoSegment[],
  pagination: Partial<NadeshikoSearchPage> = {},
): NadeshikoSearchPage {
  return {
    segments,
    hasMore: pagination.hasMore ?? false,
    nextCursor: pagination.nextCursor ?? null,
    ...pagination,
  };
}

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

/**
 * Lightweight IntersectionObserver replacement for jsdom (which doesn't ship
 * one). Records every `.observe(target)` call, exposes a `trigger()` to
 * synchronously fire the callback as if every observed target were
 * intersecting, and tracks `.disconnect()` / `.unobserve()` for cleanup
 * assertions. The panel uses it to drive sentinel callbacks from tests.
 */
function installIntersectionObserverStub() {
  type Observer = {
    callback: IntersectionObserverCallback;
    options: IntersectionObserverInit | undefined;
    targets: Set<Element>;
    disconnect: () => void;
    unobserve: (target: Element) => void;
    observe: (target: Element) => void;
    takeTargets: () => Element[];
  };
  const observers: Observer[] = [];
  const orig =
    typeof window !== 'undefined'
      ? (
          window as unknown as {
            IntersectionObserver?: typeof IntersectionObserver;
          }
        ).IntersectionObserver
      : undefined;
  class StubIntersectionObserver {
    private readonly inner: Observer;
    constructor(
      callback: IntersectionObserverCallback,
      options?: IntersectionObserverInit,
    ) {
      this.inner = {
        callback,
        options,
        targets: new Set<Element>(),
        disconnect: () => {
          this.inner.targets.clear();
        },
        unobserve: (target) => {
          this.inner.targets.delete(target);
        },
        observe: (target) => {
          this.inner.targets.add(target);
        },
        takeTargets: () => Array.from(this.inner.targets),
      };
      observers.push(this.inner);
    }
    observe(target: Element) {
      this.inner.observe(target);
    }
    unobserve(target: Element) {
      this.inner.unobserve(target);
    }
    disconnect() {
      this.inner.disconnect();
    }
    takeTargets() {
      return this.inner.takeTargets();
    }
  }
  (
    window as unknown as { IntersectionObserver: unknown }
  ).IntersectionObserver = StubIntersectionObserver as unknown;
  return {
    observers,
    /**
     * Fire the callback once for every recorded observer, simulating all
     * observed targets becoming intersecting. Optionally restricted to a
     * single observer index (the most recently created one by default).
     * The helper is async and awaits microtasks so React's act() warning
     * doesn't fire for the resulting state updates.
     */
    async triggerAllIntersecting(observerIndex?: number) {
      for (let i = 0; i < observers.length; i++) {
        if (observerIndex !== undefined && i !== observerIndex) continue;
        const obs = observers[i]!;
        const entries = obs.takeTargets().map(
          (target) =>
            ({
              isIntersecting: true,
              target,
              intersectionRatio: 1,
              intersectionRect: {} as DOMRectReadOnly,
              boundingClientRect: {} as DOMRectReadOnly,
              rootBounds: null,
              time: Date.now(),
            }) as IntersectionObserverEntry,
        );
        obs.callback(entries, obs as unknown as IntersectionObserver);
      }
      // Yield so any async work kicked off by the callback (e.g.
      // `loadMore`) gets a chance to advance before the caller asserts.
      await new Promise((r) => setTimeout(r, 0));
    },
    async triggerNoIntersection(observerIndex?: number) {
      for (let i = 0; i < observers.length; i++) {
        if (observerIndex !== undefined && i !== observerIndex) continue;
        const obs = observers[i]!;
        const entries = obs.takeTargets().map(
          (target) =>
            ({
              isIntersecting: false,
              target,
              intersectionRatio: 0,
              intersectionRect: {} as DOMRectReadOnly,
              boundingClientRect: {} as DOMRectReadOnly,
              rootBounds: null,
              time: Date.now(),
            }) as IntersectionObserverEntry,
        );
        obs.callback(entries, obs as unknown as IntersectionObserver);
      }
    },
    restore() {
      if (typeof window !== 'undefined') {
        if (orig) {
          (
            window as unknown as {
              IntersectionObserver: typeof IntersectionObserver;
            }
          ).IntersectionObserver = orig;
        } else {
          delete (
            window as unknown as {
              IntersectionObserver?: typeof IntersectionObserver;
            }
          ).IntersectionObserver;
        }
      }
      observers.length = 0;
    },
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
      .mockResolvedValue(makePage([]));

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
    vi.spyOn(nadeshikoClient, 'searchNadeshikoSegments').mockResolvedValue(
      makePage([
        {
          id: 'seg-1',
          workName: '神之塔 -Tower of God-',
          line: '僕が聞く言葉 見る言葉…',
          timestampSeconds: 117,
          timestampLabel: '1:57',
          imageUrl: 'https://cdn.example/x.webp',
          audioUrl: 'https://cdn.example/x.mp3',
        },
      ]),
    );
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
    vi.spyOn(nadeshikoClient, 'searchNadeshikoSegments').mockResolvedValue(
      makePage([
        {
          id: 'seg-2',
          workName: 'Sousou no Frieren',
          line: 'また会えたね',
          timestampSeconds: 91,
          timestampLabel: '01:31',
          // No imageUrl / audioUrl — fallback path.
        },
      ]),
    );
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
      vi.spyOn(nadeshikoClient, 'searchNadeshikoSegments').mockResolvedValue(
        makePage([
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
        ]),
      );
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

      // Natural end: dispatch `ended` on B's audio while it plays again —
      // the button must snap back to play (regression: ended left the
      // Stop icon stuck because playingId was never cleared).
      await act(async () => {
        fireEvent.click(screen.getAllByLabelText('Play audio')[1]!);
      });
      await waitFor(() => {
        expect(screen.getAllByLabelText('Stop audio')).toHaveLength(1);
      });
      await act(async () => {
        audios[1]!.dispatchEvent(new Event('ended'));
      });
      await waitFor(() => {
        expect(screen.getAllByLabelText('Play audio')).toHaveLength(2);
      });
      expect(screen.queryByLabelText('Stop audio')).toBeNull();
    } finally {
      restoreAudio();
    }
  });

  it('auto-fetches context once per card without IntersectionObserver', async () => {
    window.localStorage.setItem('entei.nadeshiko.api-key.v1', 'KEY');
    vi.spyOn(nadeshikoClient, 'searchNadeshikoSegments').mockResolvedValue(
      makePage([
        {
          id: 'seg-ctx',
          workName: 'Work',
          line: 'セリフ',
          timestampSeconds: 30,
          timestampLabel: '0:30',
          imageUrl: 'https://cdn.example/x.webp',
        },
      ]),
    );
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
    vi.spyOn(nadeshikoClient, 'searchNadeshikoSegments').mockResolvedValue(
      makePage([]),
    );

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
    vi.spyOn(nadeshikoClient, 'searchNadeshikoSegments').mockResolvedValue(
      makePage([]),
    );
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
    vi.spyOn(nadeshikoClient, 'searchNadeshikoSegments').mockResolvedValue(
      makePage([
        {
          id: 'seg-tempo',
          workName: 'Tower of God',
          line: '中',
          timestampSeconds: 120,
          timestampLabel: '2:00',
          imageUrl: 'https://cdn.example/x.webp',
        },
      ]),
    );
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
    vi.spyOn(nadeshikoClient, 'searchNadeshikoSegments').mockResolvedValue(
      makePage([
        {
          id: 'seg-guard',
          workName: 'Work',
          line: 'セリフ',
          timestampSeconds: 30,
          timestampLabel: '0:30',
          imageUrl: 'https://cdn.example/x.webp',
        },
      ]),
    );
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

  /* -------------------------------------------------------------------- */
  /* Pagination                                                            */
  /* -------------------------------------------------------------------- */

  function firstPageSegments(): NadeshikoSegment[] {
    return Array.from({ length: 3 }, (_, i) => ({
      id: `seg-p1-${i}`,
      workName: 'Work',
      line: `P1 line ${i}`,
      timestampSeconds: 10 + i,
      timestampLabel: `0:${10 + i}`,
      imageUrl: `https://cdn.example/p1-${i}.webp`,
    }));
  }

  function secondPageSegments(): NadeshikoSegment[] {
    return Array.from({ length: 3 }, (_, i) => ({
      id: `seg-p2-${i}`,
      workName: 'Work',
      line: `P2 line ${i}`,
      timestampSeconds: 30 + i,
      timestampLabel: `0:${30 + i}`,
      imageUrl: `https://cdn.example/p2-${i}.webp`,
    }));
  }

  it('pagination: appends the second page when the sentinel intersects', async () => {
    const obs = installIntersectionObserverStub();
    try {
      window.localStorage.setItem('entei.nadeshiko.api-key.v1', 'KEY');
      const spy = vi
        .spyOn(nadeshikoClient, 'searchNadeshikoSegments')
        .mockResolvedValueOnce(
          makePage(firstPageSegments(), {
            hasMore: true,
            nextCursor: 'cursor-1',
          }),
        )
        .mockResolvedValueOnce(
          makePage(secondPageSegments(), {
            hasMore: false,
            nextCursor: null,
          }),
        );
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

      const { getByText, findAllByText } = render(
        <RightPanel visible={true} {...baseProps()} />,
      );
      fireEvent.click(getByText('Context'));
      const input = document.querySelector(
        'input[placeholder="Search"]',
      ) as HTMLInputElement;
      fireEvent.change(input, { target: { value: '猫' } });
      fireEvent.click(screen.getByRole('button', { name: 'Search' }));

      // First page renders — 3 cards.
      await waitFor(() => {
        expect(document.querySelectorAll('.entei-nadeshiko-card')).toHaveLength(
          3,
        );
      });
      expect(spy).toHaveBeenCalledTimes(1);
      const [, q1, opts1] = spy.mock.calls[0]!;
      expect(q1).toBe('猫');
      // First page must NOT send a cursor in the body.
      expect((opts1 as { cursor?: string }).cursor).toBeUndefined();

      // Sentinel intersects → second page appended. The IO callback fires
      // a state update, so we wrap the trigger in `act` and let microtasks
      // drain before asserting.
      await act(async () => {
        obs.triggerAllIntersecting();
      });
      await waitFor(() => {
        expect(document.querySelectorAll('.entei-nadeshiko-card')).toHaveLength(
          6,
        );
      });
      expect(spy).toHaveBeenCalledTimes(2);
      const [, q2, opts2] = spy.mock.calls[1]!;
      expect(q2).toBe('猫');
      // Second page sends the cursor returned by the first response.
      expect((opts2 as { cursor?: string }).cursor).toBe('cursor-1');

      // End-of-results sentinel appears once hasMore flips to false.
      await waitFor(() => {
        expect(screen.getByText('End of results')).toBeTruthy();
      });

      // Page-1 + Page-2 lines both rendered in order (existing cards
      // preserved, new ones appended).
      const lines = await findAllByText(/^P[12] line \d$/);
      expect(lines.length).toBeGreaterThanOrEqual(6);
    } finally {
      obs.restore();
    }
  });

  it('pagination: stops at terminal page (hasMore=false, cursor=null)', async () => {
    const obs = installIntersectionObserverStub();
    try {
      window.localStorage.setItem('entei.nadeshiko.api-key.v1', 'KEY');
      const spy = vi
        .spyOn(nadeshikoClient, 'searchNadeshikoSegments')
        .mockResolvedValueOnce(
          makePage(firstPageSegments(), {
            hasMore: false,
            nextCursor: null,
          }),
        );
      vi.spyOn(nadeshikoClient, 'getNadeshikoSegmentContext').mockResolvedValue(
        {
          center: { id: 'noop', workName: '', line: '', timestampSeconds: 0 },
          surrounding: [],
          centerIdx: 0,
        },
      );

      const { getByText } = render(
        <RightPanel visible={true} {...baseProps()} />,
      );
      fireEvent.click(getByText('Context'));
      const input = document.querySelector(
        'input[placeholder="Search"]',
      ) as HTMLInputElement;
      fireEvent.change(input, { target: { value: 'q' } });
      fireEvent.click(screen.getByRole('button', { name: 'Search' }));

      await waitFor(() => {
        expect(document.querySelectorAll('.entei-nadeshiko-card')).toHaveLength(
          3,
        );
      });
      // Triggering the sentinel after a terminal page must not fire a
      // second request — `hasMore` is false so `loadMore` is a no-op.
      await act(async () => {
        await obs.triggerAllIntersecting();
      });
      await new Promise((r) => setTimeout(r, 30));
      expect(spy).toHaveBeenCalledTimes(1);
      expect(screen.getByText('End of results')).toBeTruthy();
    } finally {
      obs.restore();
    }
  });

  it('pagination: stops when the next cursor is missing (no retry loop)', async () => {
    const obs = installIntersectionObserverStub();
    try {
      window.localStorage.setItem('entei.nadeshiko.api-key.v1', 'KEY');
      const spy = vi
        .spyOn(nadeshikoClient, 'searchNadeshikoSegments')
        .mockResolvedValueOnce(
          makePage(firstPageSegments(), {
            hasMore: true,
            // Missing cursor entirely — the client coerces this to terminal,
            // so the panel must treat the response as end-of-list.
            nextCursor: null,
          }),
        );
      vi.spyOn(nadeshikoClient, 'getNadeshikoSegmentContext').mockResolvedValue(
        {
          center: { id: 'noop', workName: '', line: '', timestampSeconds: 0 },
          surrounding: [],
          centerIdx: 0,
        },
      );

      const { getByText } = render(
        <RightPanel visible={true} {...baseProps()} />,
      );
      fireEvent.click(getByText('Context'));
      const input = document.querySelector(
        'input[placeholder="Search"]',
      ) as HTMLInputElement;
      fireEvent.change(input, { target: { value: 'q' } });
      fireEvent.click(screen.getByRole('button', { name: 'Search' }));

      await waitFor(() => {
        expect(document.querySelectorAll('.entei-nadeshiko-card')).toHaveLength(
          3,
        );
      });
      expect(spy).toHaveBeenCalledTimes(1);
      await act(async () => {
        await obs.triggerAllIntersecting();
      });
      await new Promise((r) => setTimeout(r, 30));
      expect(spy).toHaveBeenCalledTimes(1);
      expect(
        document.querySelector('.entei-nadeshiko-pagination-end')?.textContent,
      ).toBe('End of results');
    } finally {
      obs.restore();
    }
  });

  it('pagination: stops on repeated cursor (server-side no-progress)', async () => {
    const obs = installIntersectionObserverStub();
    try {
      window.localStorage.setItem('entei.nadeshiko.api-key.v1', 'KEY');
      const spy = vi
        .spyOn(nadeshikoClient, 'searchNadeshikoSegments')
        .mockResolvedValueOnce(
          makePage(firstPageSegments(), {
            hasMore: true,
            nextCursor: 'cursor-1',
          }),
        )
        // Server lies and returns the same cursor it just gave us.
        .mockResolvedValueOnce(
          makePage([], {
            hasMore: true,
            nextCursor: 'cursor-1',
          }),
        );
      vi.spyOn(nadeshikoClient, 'getNadeshikoSegmentContext').mockResolvedValue(
        {
          center: { id: 'noop', workName: '', line: '', timestampSeconds: 0 },
          surrounding: [],
          centerIdx: 0,
        },
      );

      const { getByText } = render(
        <RightPanel visible={true} {...baseProps()} />,
      );
      fireEvent.click(getByText('Context'));
      const input = document.querySelector(
        'input[placeholder="Search"]',
      ) as HTMLInputElement;
      fireEvent.change(input, { target: { value: 'q' } });
      fireEvent.click(screen.getByRole('button', { name: 'Search' }));

      await waitFor(() => {
        expect(document.querySelectorAll('.entei-nadeshiko-card')).toHaveLength(
          3,
        );
      });
      await act(async () => {
        await obs.triggerAllIntersecting();
      });
      // Allow the second request to settle.
      await waitFor(() => {
        expect(spy).toHaveBeenCalledTimes(2);
      });
      // Trigger the observer again — must NOT fire a third request since
      // the cursor is unchanged and hasMore was flipped to false.
      await act(async () => {
        await obs.triggerAllIntersecting();
      });
      await new Promise((r) => setTimeout(r, 30));
      expect(spy).toHaveBeenCalledTimes(2);
    } finally {
      obs.restore();
    }
  });

  it('pagination: in-flight guard prevents duplicate observer triggers from issuing parallel fetches', async () => {
    const obs = installIntersectionObserverStub();
    try {
      window.localStorage.setItem('entei.nadeshiko.api-key.v1', 'KEY');
      // Resolve slowly so the second observer trigger happens while the
      // first request is still in flight.
      let resolveSecond!: (page: NadeshikoSearchPage) => void;
      const spy = vi
        .spyOn(nadeshikoClient, 'searchNadeshikoSegments')
        .mockResolvedValueOnce(
          makePage(firstPageSegments(), {
            hasMore: true,
            nextCursor: 'cursor-1',
          }),
        )
        .mockImplementationOnce(
          () =>
            new Promise<NadeshikoSearchPage>((resolve) => {
              resolveSecond = resolve;
            }),
        );
      vi.spyOn(nadeshikoClient, 'getNadeshikoSegmentContext').mockResolvedValue(
        {
          center: { id: 'noop', workName: '', line: '', timestampSeconds: 0 },
          surrounding: [],
          centerIdx: 0,
        },
      );

      const { getByText } = render(
        <RightPanel visible={true} {...baseProps()} />,
      );
      fireEvent.click(getByText('Context'));
      const input = document.querySelector(
        'input[placeholder="Search"]',
      ) as HTMLInputElement;
      fireEvent.change(input, { target: { value: 'q' } });
      fireEvent.click(screen.getByRole('button', { name: 'Search' }));

      await waitFor(() => {
        expect(document.querySelectorAll('.entei-nadeshiko-card')).toHaveLength(
          3,
        );
      });
      // Fire the observer synchronously twice — the second trigger must
      // hit the in-flight guard and skip.
      await act(async () => {
        await obs.triggerAllIntersecting();
        await obs.triggerAllIntersecting();
      });
      // Only the first trigger should have produced a second request.
      expect(spy).toHaveBeenCalledTimes(2);
      // Resolve the slow second page so the test cleans up.
      resolveSecond(
        makePage(secondPageSegments(), { hasMore: false, nextCursor: null }),
      );
      await waitFor(() => {
        expect(document.querySelectorAll('.entei-nadeshiko-card')).toHaveLength(
          6,
        );
      });
    } finally {
      obs.restore();
    }
  });

  it('pagination: dedupes duplicate segment ids across pages (no double cards)', async () => {
    const obs = installIntersectionObserverStub();
    try {
      window.localStorage.setItem('entei.nadeshiko.api-key.v1', 'KEY');
      // Page 2 echoes one id from page 1 (the API can do this across
      // paging windows) plus new ids. The panel must not render the
      // duplicate id twice.
      const p1 = firstPageSegments();
      const p2: NadeshikoSegment[] = [
        p1[0]!,
        {
          id: 'seg-p2-0',
          workName: 'Work',
          line: 'new',
          timestampSeconds: 30,
          timestampLabel: '0:30',
          imageUrl: 'https://cdn.example/p2-0.webp',
        },
      ];
      const spy = vi
        .spyOn(nadeshikoClient, 'searchNadeshikoSegments')
        .mockResolvedValueOnce(
          makePage(p1, { hasMore: true, nextCursor: 'c1' }),
        )
        .mockResolvedValueOnce(
          makePage(p2, { hasMore: false, nextCursor: null }),
        );
      vi.spyOn(nadeshikoClient, 'getNadeshikoSegmentContext').mockResolvedValue(
        {
          center: { id: 'noop', workName: '', line: '', timestampSeconds: 0 },
          surrounding: [],
          centerIdx: 0,
        },
      );

      const { getByText } = render(
        <RightPanel visible={true} {...baseProps()} />,
      );
      fireEvent.click(getByText('Context'));
      const input = document.querySelector(
        'input[placeholder="Search"]',
      ) as HTMLInputElement;
      fireEvent.change(input, { target: { value: 'q' } });
      fireEvent.click(screen.getByRole('button', { name: 'Search' }));

      await waitFor(() => {
        expect(document.querySelectorAll('.entei-nadeshiko-card')).toHaveLength(
          3,
        );
      });
      await act(async () => {
        await obs.triggerAllIntersecting();
      });
      await waitFor(() => {
        // 3 from page 1 + 1 new from page 2 = 4 (echo of p1[0] deduped).
        expect(document.querySelectorAll('.entei-nadeshiko-card')).toHaveLength(
          4,
        );
      });
      // Search called twice; only one call per generation.
      expect(spy).toHaveBeenCalledTimes(2);
    } finally {
      obs.restore();
    }
  });

  it('pagination: error surfaces an inline Retry button without removing existing cards', async () => {
    const obs = installIntersectionObserverStub();
    try {
      window.localStorage.setItem('entei.nadeshiko.api-key.v1', 'KEY');
      const rateLimitErr = Object.assign(new Error('x'), {
        kind: 'rate-limited',
        retryAfterSeconds: 9,
      }) as nadeshikoClient.NadeshikoError;
      const spy = vi
        .spyOn(nadeshikoClient, 'searchNadeshikoSegments')
        .mockResolvedValueOnce(
          makePage(firstPageSegments(), {
            hasMore: true,
            nextCursor: 'cursor-1',
          }),
        )
        .mockRejectedValueOnce(rateLimitErr);
      vi.spyOn(nadeshikoClient, 'getNadeshikoSegmentContext').mockResolvedValue(
        {
          center: { id: 'noop', workName: '', line: '', timestampSeconds: 0 },
          surrounding: [],
          centerIdx: 0,
        },
      );

      const { getByText } = render(
        <RightPanel visible={true} {...baseProps()} />,
      );
      fireEvent.click(getByText('Context'));
      const input = document.querySelector(
        'input[placeholder="Search"]',
      ) as HTMLInputElement;
      fireEvent.change(input, { target: { value: 'q' } });
      fireEvent.click(screen.getByRole('button', { name: 'Search' }));

      await waitFor(() => {
        expect(document.querySelectorAll('.entei-nadeshiko-card')).toHaveLength(
          3,
        );
      });
      await act(async () => {
        await obs.triggerAllIntersecting();
      });
      // The countdown tick may have already decremented once by the time
      // we assert (the tick is 1000ms), so match the prefix instead of
      // the exact "9s" label.
      await waitFor(() => {
        expect(screen.getByText(/^Wait \ds$/)).toBeTruthy();
        expect(screen.getByRole('button', { name: 'Retry' })).toBeTruthy();
      });
      expect(document.querySelectorAll('.entei-nadeshiko-card')).toHaveLength(
        3,
      );
      // No automatic retry loop: just one error attempt so far.
      expect(spy).toHaveBeenCalledTimes(2);

      // User clicks Retry — the next request succeeds.
      spy.mockResolvedValueOnce(
        makePage(secondPageSegments(), {
          hasMore: false,
          nextCursor: null,
        }),
      );
      fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
      await waitFor(() => {
        expect(document.querySelectorAll('.entei-nadeshiko-card')).toHaveLength(
          6,
        );
      });
      expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull();
      expect(screen.getByText('End of results')).toBeTruthy();
    } finally {
      obs.restore();
    }
  });

  it('pagination: 429 stops pagination (no retry loop); existing results stay visible', async () => {
    const obs = installIntersectionObserverStub();
    try {
      window.localStorage.setItem('entei.nadeshiko.api-key.v1', 'KEY');
      const quotaErr = Object.assign(new Error('x'), {
        kind: 'quota-exceeded',
      }) as nadeshikoClient.NadeshikoError;
      const spy = vi
        .spyOn(nadeshikoClient, 'searchNadeshikoSegments')
        .mockResolvedValueOnce(
          makePage(firstPageSegments(), {
            hasMore: true,
            nextCursor: 'cursor-1',
          }),
        )
        .mockRejectedValueOnce(quotaErr);
      vi.spyOn(nadeshikoClient, 'getNadeshikoSegmentContext').mockResolvedValue(
        {
          center: { id: 'noop', workName: '', line: '', timestampSeconds: 0 },
          surrounding: [],
          centerIdx: 0,
        },
      );

      const { getByText } = render(
        <RightPanel visible={true} {...baseProps()} />,
      );
      fireEvent.click(getByText('Context'));
      const input = document.querySelector(
        'input[placeholder="Search"]',
      ) as HTMLInputElement;
      fireEvent.change(input, { target: { value: 'q' } });
      fireEvent.click(screen.getByRole('button', { name: 'Search' }));

      await waitFor(() => {
        expect(document.querySelectorAll('.entei-nadeshiko-card')).toHaveLength(
          3,
        );
      });
      await act(async () => {
        await obs.triggerAllIntersecting();
      });
      await waitFor(() => {
        expect(
          screen.getByText('Please check your Nadeshiko usage'),
        ).toBeTruthy();
      });
      expect(document.querySelectorAll('.entei-nadeshiko-card')).toHaveLength(
        3,
      );
      expect(spy).toHaveBeenCalledTimes(2);
      // Trigger the observer repeatedly — no automatic loop.
      await act(async () => {
        await obs.triggerAllIntersecting();
        await obs.triggerAllIntersecting();
      });
      await new Promise((r) => setTimeout(r, 30));
      expect(spy).toHaveBeenCalledTimes(2);
    } finally {
      obs.restore();
    }
  });

  it('pagination: a new submit aborts the in-flight pagination and ignores its result', async () => {
    const obs = installIntersectionObserverStub();
    try {
      window.localStorage.setItem('entei.nadeshiko.api-key.v1', 'KEY');
      let resolveSecond!: (page: NadeshikoSearchPage) => void;
      const spy = vi
        .spyOn(nadeshikoClient, 'searchNadeshikoSegments')
        .mockResolvedValueOnce(
          makePage(firstPageSegments(), {
            hasMore: true,
            nextCursor: 'cursor-1',
          }),
        )
        .mockImplementationOnce(
          () =>
            new Promise<NadeshikoSearchPage>((resolve) => {
              resolveSecond = resolve;
            }),
        )
        .mockResolvedValueOnce(
          makePage(
            [
              {
                id: 'new-seg',
                workName: 'NewWork',
                line: 'new line',
                timestampSeconds: 99,
                timestampLabel: '1:39',
              },
            ],
            { hasMore: false, nextCursor: null },
          ),
        );
      vi.spyOn(nadeshikoClient, 'getNadeshikoSegmentContext').mockResolvedValue(
        {
          center: { id: 'noop', workName: '', line: '', timestampSeconds: 0 },
          surrounding: [],
          centerIdx: 0,
        },
      );

      const { getByText } = render(
        <RightPanel visible={true} {...baseProps()} />,
      );
      fireEvent.click(getByText('Context'));
      const input = document.querySelector(
        'input[placeholder="Search"]',
      ) as HTMLInputElement;
      fireEvent.change(input, { target: { value: 'first' } });
      fireEvent.click(screen.getByRole('button', { name: 'Search' }));

      await waitFor(() => {
        expect(document.querySelectorAll('.entei-nadeshiko-card')).toHaveLength(
          3,
        );
      });
      // Start pagination; it's hanging on `resolveSecond`.
      await act(async () => {
        await obs.triggerAllIntersecting();
      });
      await new Promise((r) => setTimeout(r, 0));
      expect(spy).toHaveBeenCalledTimes(2);

      // New query while pagination is in flight.
      fireEvent.change(input, { target: { value: 'second' } });
      fireEvent.click(screen.getByRole('button', { name: 'Search' }));
      await waitFor(() => {
        expect(document.querySelectorAll('.entei-nadeshiko-card')).toHaveLength(
          1,
        );
      });
      // Old page-1 cards must be gone.
      expect(
        document.querySelector('.entei-nadeshiko-card-line')?.textContent,
      ).toBe('new line');

      // Now resolve the old pagination — its late response must NOT bleed
      // into the new result set (generation guard).
      resolveSecond(
        makePage(secondPageSegments(), { hasMore: false, nextCursor: null }),
      );
      await new Promise((r) => setTimeout(r, 50));
      // Still only one card — the stale page was dropped.
      expect(document.querySelectorAll('.entei-nadeshiko-card')).toHaveLength(
        1,
      );
      expect(spy).toHaveBeenCalledTimes(3);
    } finally {
      obs.restore();
    }
  });

  it('pagination: appending a new page does NOT re-fetch context for cards already loaded', async () => {
    const obs = installIntersectionObserverStub();
    try {
      window.localStorage.setItem('entei.nadeshiko.api-key.v1', 'KEY');
      const ctxSpy = vi
        .spyOn(nadeshikoClient, 'getNadeshikoSegmentContext')
        .mockResolvedValue({
          center: { id: 'noop', workName: '', line: '', timestampSeconds: 0 },
          surrounding: [],
          centerIdx: 0,
        });
      vi.spyOn(nadeshikoClient, 'searchNadeshikoSegments')
        .mockResolvedValueOnce(
          makePage(firstPageSegments(), {
            hasMore: true,
            nextCursor: 'cursor-1',
          }),
        )
        .mockResolvedValueOnce(
          makePage(secondPageSegments(), {
            hasMore: false,
            nextCursor: null,
          }),
        );

      const { getByText } = render(
        <RightPanel visible={true} {...baseProps()} />,
      );
      fireEvent.click(getByText('Context'));
      const input = document.querySelector(
        'input[placeholder="Search"]',
      ) as HTMLInputElement;
      fireEvent.change(input, { target: { value: 'q' } });
      fireEvent.click(screen.getByRole('button', { name: 'Search' }));

      // After page 1, context fetches fired once per card (3 ids).
      await waitFor(() => {
        expect(ctxSpy).toHaveBeenCalledTimes(3);
      });
      const callsAfterP1 = ctxSpy.mock.calls.length;

      // Append page 2.
      await act(async () => {
        await obs.triggerAllIntersecting();
      });
      await waitFor(() => {
        expect(document.querySelectorAll('.entei-nadeshiko-card')).toHaveLength(
          6,
        );
      });
      // The 3 new cards on page 2 each fire one context fetch — the 3
      // existing cards on page 1 do NOT re-fire (fetchedIds is
      // append-only across paginated appends).
      await waitFor(() => {
        expect(ctxSpy).toHaveBeenCalledTimes(callsAfterP1 + 3);
      });
    } finally {
      obs.restore();
    }
  });

  it('pagination: editing the input after submit does NOT alter the next-page query', async () => {
    const obs = installIntersectionObserverStub();
    try {
      window.localStorage.setItem('entei.nadeshiko.api-key.v1', 'KEY');
      const spy = vi
        .spyOn(nadeshikoClient, 'searchNadeshikoSegments')
        .mockResolvedValueOnce(
          makePage(firstPageSegments(), {
            hasMore: true,
            nextCursor: 'cursor-1',
          }),
        )
        .mockResolvedValueOnce(
          makePage(secondPageSegments(), {
            hasMore: false,
            nextCursor: null,
          }),
        );
      vi.spyOn(nadeshikoClient, 'getNadeshikoSegmentContext').mockResolvedValue(
        {
          center: { id: 'noop', workName: '', line: '', timestampSeconds: 0 },
          surrounding: [],
          centerIdx: 0,
        },
      );

      const { getByText } = render(
        <RightPanel visible={true} {...baseProps()} />,
      );
      fireEvent.click(getByText('Context'));
      const input = document.querySelector(
        'input[placeholder="Search"]',
      ) as HTMLInputElement;
      fireEvent.change(input, { target: { value: 'first' } });
      fireEvent.click(screen.getByRole('button', { name: 'Search' }));

      await waitFor(() => {
        expect(document.querySelectorAll('.entei-nadeshiko-card')).toHaveLength(
          3,
        );
      });
      // Edit the input after submit (don't click Search). The next-page
      // request must still use the *submitted* term.
      fireEvent.change(input, {
        target: { value: 'edited-but-not-submitted' },
      });
      await act(async () => {
        await obs.triggerAllIntersecting();
      });
      await waitFor(() => {
        expect(spy).toHaveBeenCalledTimes(2);
      });
      const [, q2] = spy.mock.calls[1]!;
      expect(q2).toBe('first');
    } finally {
      obs.restore();
    }
  });

  it('pagination: IO observer uses the actual scroll ancestor (.entei-right-panel-content) as root', async () => {
    const obs = installIntersectionObserverStub();
    try {
      window.localStorage.setItem('entei.nadeshiko.api-key.v1', 'KEY');
      vi.spyOn(nadeshikoClient, 'searchNadeshikoSegments').mockResolvedValue(
        makePage(firstPageSegments(), {
          hasMore: false,
          nextCursor: null,
        }),
      );
      vi.spyOn(nadeshikoClient, 'getNadeshikoSegmentContext').mockResolvedValue(
        {
          center: { id: 'noop', workName: '', line: '', timestampSeconds: 0 },
          surrounding: [],
          centerIdx: 0,
        },
      );

      render(<RightPanel visible={true} {...baseProps()} />);
      fireEvent.click(screen.getByText('Context'));
      const input = document.querySelector(
        'input[placeholder="Search"]',
      ) as HTMLInputElement;
      fireEvent.change(input, { target: { value: 'q' } });
      fireEvent.click(screen.getByRole('button', { name: 'Search' }));

      await waitFor(() => {
        expect(document.querySelectorAll('.entei-nadeshiko-card')).toHaveLength(
          3,
        );
      });

      // The observer was created with `root` pointing at the
      // .entei-right-panel-content element (the panel's actual scroll
      // ancestor). The stub records the options object passed to its
      // constructor. We pick the most recent observer with non-empty
      // options, since each `installIntersectionObserverStub` / `restore`
      // pair resets the global stub but a stray earlier observer could
      // theoretically still be in the list if a previous test forgot to
      // restore.
      const lastObs = [...obs.observers]
        .reverse()
        .find((o) => o.options !== undefined);
      expect(lastObs).toBeDefined();
      expect(lastObs!.options!.root).toBe(
        document.querySelector('.entei-right-panel-content'),
      );
      expect(lastObs!.options!.rootMargin).toBe('200px 0px');
    } finally {
      obs.restore();
    }
  });
});
