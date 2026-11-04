/**
 * Tests for the Home timeline island (docs/FREENET_SOCIAL_TIMELINE.md phase 1).
 * Covers the composer → feed flow, the like toggle, and local persistence.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import TimelineFeed, {
  INITIAL_VISIBLE_POSTS,
  LOAD_MORE_STEP,
  NEW_POSTS_POLL_INTERVAL_MS,
  PULL_REFRESH_MAX,
  PULL_REFRESH_THRESHOLD,
} from '@/components/home/TimelineFeed';
import {
  TIMELINE_SEED_POSTS,
  TIMELINE_STORAGE_KEY,
  readTimelineState,
  type TimelinePost,
} from '@/features/timeline/timeline-store';

function renderFeed() {
  return render(<TimelineFeed />);
}

/** Store `count` local posts (newest first) so the feed needs paging. */
function seedLocalPosts(count: number): TimelinePost[] {
  const base = Date.now();
  const posts: TimelinePost[] = Array.from({ length: count }, (_, index) => ({
    id: `local-seed-${index}`,
    authorName: 'Kitsune-A9K2',
    authorHandle: '@kitsune_a9k2',
    avatar: '/avatars/3.webp',
    message: `ローカル投稿 ${index}`,
    createdAt: base - index * 1_000,
  }));
  localStorage.setItem(
    TIMELINE_STORAGE_KEY,
    JSON.stringify({ schemaVersion: 1, posts, likedIds: [] }),
  );
  return posts;
}

/** Pretend to be a desktop viewport (the pill is desktop-only). */
function stubDesktop(isDesktop: boolean) {
  vi.stubGlobal(
    'matchMedia',
    (query: string) =>
      ({
        matches: query.includes('min-width') ? isDesktop : !isDesktop,
        media: query,
        onchange: null,
        addEventListener: () => {},
        removeEventListener: () => {},
        addListener: () => {},
        removeListener: () => {},
        dispatchEvent: () => false,
      }) as unknown as MediaQueryList,
  );
}

/** Minimal IntersectionObserver double so the sentinel can be fired by hand. */
class FakeIntersectionObserver {
  static instances: FakeIntersectionObserver[] = [];
  readonly callback: IntersectionObserverCallback;

  constructor(callback: IntersectionObserverCallback) {
    this.callback = callback;
    FakeIntersectionObserver.instances.push(this);
  }

  observe(): void {}

  unobserve(): void {}

  disconnect(): void {}

  takeRecords(): IntersectionObserverEntry[] {
    return [];
  }

  /** Pretend the sentinel scrolled into view. */
  enter(): void {
    this.callback(
      [{ isIntersecting: true } as IntersectionObserverEntry],
      this as unknown as IntersectionObserver,
    );
  }
}

beforeEach(() => {
  localStorage.clear();
  document.documentElement.lang = 'id';
  FakeIntersectionObserver.instances = [];
  vi.stubGlobal('IntersectionObserver', FakeIntersectionObserver);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('TimelineFeed', () => {
  it('renders the composer placeholder and the seeded posts', async () => {
    renderFeed();
    expect(
      screen.getByPlaceholderText('Tulis di sini untuk membuat pos!'),
    ).toBeTruthy();
    const items = await screen.findAllByRole('listitem');
    expect(items).toHaveLength(TIMELINE_SEED_POSTS.length);
    expect(screen.getByText(TIMELINE_SEED_POSTS[0]!.message)).toBeTruthy();
  });

  it('exposes exactly one h1 and points the avatars at the rounded hexagon clip', () => {
    const { container } = renderFeed();
    const headings = container.querySelectorAll('h1');
    expect(headings).toHaveLength(1);
    expect(headings[0]!.getAttribute('id')).toBe('entei-timeline-heading');

    const clip = container.querySelector('#entei-hex-clip');
    expect(clip?.getAttribute('clipPathUnits')).toBe('objectBoundingBox');
    // Smooth rounded corners: the contour uses quadratic joins, not sharp vertices.
    expect(clip?.querySelector('path')?.getAttribute('d')).toContain('Q');
  });

  it('keeps Publish disabled until the draft has content', () => {
    renderFeed();
    const publish = screen.getByRole('button', { name: 'Terbitkan pos' });
    expect(publish.hasAttribute('disabled')).toBe(true);
    fireEvent.change(screen.getByPlaceholderText('Tulis di sini untuk membuat pos!'), {
      target: { value: 'こんにちは' },
    });
    expect(publish.hasAttribute('disabled')).toBe(false);
  });

  it('publishes a post to the top of the feed and persists it', async () => {
    renderFeed();
    const textarea = screen.getByPlaceholderText('Tulis di sini untuk membuat pos!');
    fireEvent.change(textarea, { target: { value: '  はじめてのポスト  ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Terbitkan pos' }));

    await waitFor(() => {
      expect(screen.getAllByRole('listitem')).toHaveLength(
        TIMELINE_SEED_POSTS.length + 1,
      );
    });

    const items = screen.getAllByRole('listitem');
    expect(items[0]!.textContent).toContain('はじめてのポスト');
    expect((textarea as HTMLTextAreaElement).value).toBe('');

    const stored = readTimelineState();
    expect(stored.posts).toHaveLength(1);
    expect(stored.posts[0]!.message).toBe('はじめてのポスト');
    expect(stored.posts[0]!.authorName.length).toBeGreaterThan(0);
  });

  it('restores published posts from localStorage on mount', async () => {
    localStorage.setItem(
      TIMELINE_STORAGE_KEY,
      JSON.stringify({
        schemaVersion: 1,
        posts: [
          {
            id: 'local-1',
            authorName: 'Kitsune-A9K2',
            authorHandle: '@kitsune_a9k2',
            avatar: '/avatars/3.webp',
            message: '復元されたポスト',
            createdAt: Date.now(),
          },
        ],
        likedIds: [],
      }),
    );

    renderFeed();
    await screen.findByText('復元されたポスト');
    expect(screen.getAllByRole('listitem')).toHaveLength(
      TIMELINE_SEED_POSTS.length + 1,
    );
  });

  it('toggles the like state and persists it', async () => {
    renderFeed();
    const likeButtons = await screen.findAllByRole('button', { name: 'Like' });
    const first = likeButtons[0]!;
    expect(first.getAttribute('aria-pressed')).toBe('false');

    fireEvent.click(first);
    await waitFor(() => {
      expect(
        screen.getAllByRole('button', { name: 'Batalkan suka' }).length,
      ).toBe(1);
    });
    expect(readTimelineState().likedIds).toHaveLength(1);

    fireEvent.click(screen.getAllByRole('button', { name: 'Batalkan suka' })[0]!);
    await waitFor(() => {
      expect(screen.queryAllByRole('button', { name: 'Batalkan suka' })).toHaveLength(0);
    });
    expect(readTimelineState().likedIds).toHaveLength(0);
  });
});

describe('TimelineFeed — infinite scroll', () => {
  it('renders only the first page, then appends older posts and closes the feed', async () => {
    seedLocalPosts(8); // 8 local + 4 seeds = 12 posts
    renderFeed();

    await waitFor(() => {
      expect(screen.getAllByRole('listitem')).toHaveLength(
        INITIAL_VISIBLE_POSTS,
      );
    });
    expect(screen.queryByText('Tidak ada pos lain')).toBeNull();

    await act(async () => {
      FakeIntersectionObserver.instances.at(-1)!.enter();
    });
    expect(screen.getAllByRole('listitem')).toHaveLength(
      INITIAL_VISIBLE_POSTS + LOAD_MORE_STEP,
    );

    await act(async () => {
      FakeIntersectionObserver.instances.at(-1)!.enter();
    });
    expect(screen.getAllByRole('listitem')).toHaveLength(12);
    expect(screen.getByText('Tidak ada pos lain')).toBeTruthy();
  });

  it('shows the terminal label immediately when everything fits on one page', async () => {
    renderFeed();
    await waitFor(() => {
      expect(screen.getAllByRole('listitem')).toHaveLength(
        TIMELINE_SEED_POSTS.length,
      );
    });
    expect(screen.getByText('Tidak ada pos lain')).toBeTruthy();
  });
});

describe('TimelineFeed — pull to refresh', () => {
  function pullSection(container: HTMLElement): HTMLElement {
    const root = container.querySelector('.entei-timeline-root');
    expect(root).not.toBeNull();
    return root as HTMLElement;
  }

  function indicator(container: HTMLElement): HTMLElement {
    const node = container.querySelector('.entei-timeline-pull');
    expect(node).not.toBeNull();
    return node as HTMLElement;
  }

  it('tracks the finger and refreshes the feed past the threshold', async () => {
    const { container } = renderFeed();
    await screen.findAllByRole('listitem');
    const root = pullSection(container);

    // A post written while the reader is on the page (another tab / later sync).
    const incoming: TimelinePost = {
      id: 'local-incoming',
      authorName: 'Yuki-H2M8',
      authorHandle: '@yuki_h2m8',
      avatar: '/avatars/7.webp',
      message: '新着ポスト',
      createdAt: Date.now(),
    };
    localStorage.setItem(
      TIMELINE_STORAGE_KEY,
      JSON.stringify({ schemaVersion: 1, posts: [incoming], likedIds: [] }),
    );

    fireEvent.touchStart(root, { touches: [{ clientY: 0 }] });
    fireEvent.touchMove(root, {
      touches: [{ clientY: PULL_REFRESH_THRESHOLD + 10 }],
    });

    expect(indicator(container).dataset.state).toBe('ready');
    expect(indicator(container).style.height).toBe(
      `${PULL_REFRESH_THRESHOLD + 10}px`,
    );
    expect(screen.getByText('Tarik untuk memperbarui')).toBeTruthy();

    fireEvent.touchEnd(root);

    await waitFor(() => {
      expect(indicator(container).dataset.state).toBe('refreshing');
    });
    expect(screen.getByText('Memperbarui…')).toBeTruthy();
    await screen.findByText('新着ポスト');

    // The indicator collapses again once the refresh settles.
    await waitFor(
      () => {
        expect(indicator(container).dataset.state).toBe('idle');
      },
      { timeout: 2_000 },
    );
  });

  it('caps the indicator height and does not refresh below the threshold', async () => {
    const { container } = renderFeed();
    await screen.findAllByRole('listitem');
    const root = pullSection(container);

    localStorage.setItem(
      TIMELINE_STORAGE_KEY,
      JSON.stringify({
        schemaVersion: 1,
        posts: [
          {
            id: 'local-ignored',
            authorName: 'Sora-T4P1',
            authorHandle: '@sora_t4p1',
            avatar: '/avatars/11.webp',
            message: '引っ張り不足',
            createdAt: Date.now(),
          },
        ],
        likedIds: [],
      }),
    );

    fireEvent.touchStart(root, { touches: [{ clientY: 0 }] });
    fireEvent.touchMove(root, { touches: [{ clientY: 400 }] });
    // Bounded so a hard drag cannot push the feed off screen.
    expect(indicator(container).style.height).toBe(`${PULL_REFRESH_MAX}px`);

    fireEvent.touchMove(root, {
      touches: [{ clientY: PULL_REFRESH_THRESHOLD - 30 }],
    });
    expect(indicator(container).dataset.state).toBe('idle');
    fireEvent.touchEnd(root);

    expect(indicator(container).dataset.state).toBe('idle');
    expect(screen.queryByText('引っ張り不足')).toBeNull();
  });

  it('ignores a pull that starts while the page is already scrolled', async () => {
    const { container } = renderFeed();
    await screen.findAllByRole('listitem');
    const root = pullSection(container);

    const scrollSpy = vi.spyOn(window, 'scrollY', 'get').mockReturnValue(240);
    fireEvent.touchStart(root, { touches: [{ clientY: 0 }] });
    fireEvent.touchMove(root, { touches: [{ clientY: 200 }] });
    expect(indicator(container).dataset.state).toBe('idle');
    scrollSpy.mockRestore();
  });
});

describe('TimelineFeed — desktop new posts pill', () => {
  function storePosts(posts: TimelinePost[]): void {
    localStorage.setItem(
      TIMELINE_STORAGE_KEY,
      JSON.stringify({ schemaVersion: 1, posts, likedIds: [] }),
    );
  }

  function makePost(id: string, message: string): TimelinePost {
    return {
      id,
      authorName: 'Ren-K7C5',
      authorHandle: '@ren_k7c5',
      avatar: '/avatars/14.webp',
      message,
      createdAt: Date.now(),
    };
  }

  it('parks polled posts behind the pill and reveals them on click', async () => {
    vi.useFakeTimers();
    try {
      stubDesktop(true);
      const scrollTo = vi.fn();
      vi.stubGlobal('scrollTo', scrollTo);

      renderFeed();
      await act(async () => {
        vi.advanceTimersByTime(0);
      });
      expect(screen.getAllByRole('listitem')).toHaveLength(
        TIMELINE_SEED_POSTS.length,
      );

      storePosts([
        makePost('local-a', 'ポーリング新着A'),
        makePost('local-b', 'ポーリング新着B'),
      ]);

      await act(async () => {
        vi.advanceTimersByTime(NEW_POSTS_POLL_INTERVAL_MS);
      });

      // Parked, not injected: the reader keeps their scroll position.
      const pill = screen.getByRole('button', { name: 'Tampilkan 2 pos baru' });
      expect(screen.queryByText('ポーリング新着A')).toBeNull();

      await act(async () => {
        fireEvent.click(pill);
      });

      expect(screen.getByText('ポーリング新着A')).toBeTruthy();
      expect(screen.getByText('ポーリング新着B')).toBeTruthy();
      expect(
        screen.queryByRole('button', { name: 'Tampilkan 2 pos baru' }),
      ).toBeNull();
      expect(scrollTo).toHaveBeenCalledWith({ top: 0, behavior: 'smooth' });
    } finally {
      vi.useRealTimers();
    }
  });

  it('surfaces cross-tab storage writes without waiting for the poll', async () => {
    stubDesktop(true);
    renderFeed();
    await screen.findAllByRole('listitem');

    storePosts([makePost('local-tab', '別タブの投稿')]);
    fireEvent(
      window,
      new StorageEvent('storage', { key: TIMELINE_STORAGE_KEY }),
    );

    expect(
      await screen.findByRole('button', { name: 'Tampilkan 1 pos baru' }),
    ).toBeTruthy();
  });

  it('keeps a post published while the pill is pending', async () => {
    stubDesktop(true);
    renderFeed();
    await screen.findAllByRole('listitem');

    // Another tab writes a post: it parks behind the pill.
    storePosts([makePost('local-parked', '保留中の新着')]);
    fireEvent(
      window,
      new StorageEvent('storage', { key: TIMELINE_STORAGE_KEY }),
    );
    expect(
      await screen.findByRole('button', { name: 'Tampilkan 1 pos baru' }),
    ).toBeTruthy();

    // The reader publishes without touching the pill first.
    fireEvent.change(
      screen.getByPlaceholderText('Tulis di sini untuk membuat pos!'),
      { target: { value: 'ピル保留中の投稿' } },
    );
    fireEvent.click(screen.getByRole('button', { name: 'Terbitkan pos' }));

    // The pill is retired instead of adopting the pre-publish snapshot, so the
    // new post cannot vanish when the reader clicks it afterwards.
    await waitFor(() => {
      expect(
        screen.queryByRole('button', { name: 'Tampilkan 1 pos baru' }),
      ).toBeNull();
    });
    expect(screen.getByText('ピル保留中の投稿')).toBeTruthy();

    // Neither write is lost: the published and the parked post both persist.
    const stored = readTimelineState();
    expect(stored.posts.map((post) => post.message)).toEqual(
      expect.arrayContaining(['ピル保留中の投稿', '保留中の新着']),
    );
  });

  it('re-reads the store when the pill is clicked so nothing newer is dropped', async () => {
    stubDesktop(true);
    const scrollTo = vi.fn();
    vi.stubGlobal('scrollTo', scrollTo);

    renderFeed();
    await screen.findAllByRole('listitem');

    storePosts([makePost('local-first', 'ピル表示時の新着')]);
    fireEvent(
      window,
      new StorageEvent('storage', { key: TIMELINE_STORAGE_KEY }),
    );
    const pill = await screen.findByRole('button', {
      name: 'Tampilkan 1 pos baru',
    });

    // A second write lands after the snapshot was taken (no storage event is
    // delivered here), so only a fresh read can see it.
    storePosts([
      makePost('local-second', 'ピル待機中の追加投稿'),
      makePost('local-first', 'ピル表示時の新着'),
    ]);

    await act(async () => {
      fireEvent.click(pill);
    });

    expect(screen.getByText('ピル表示時の新着')).toBeTruthy();
    expect(screen.getByText('ピル待機中の追加投稿')).toBeTruthy();
    expect(scrollTo).toHaveBeenCalledWith({ top: 0, behavior: 'smooth' });
  });

  it('stays quiet on mobile viewports', async () => {
    vi.useFakeTimers();
    try {
      stubDesktop(false);
      renderFeed();
      await act(async () => {
        vi.advanceTimersByTime(0);
      });

      storePosts([makePost('local-mobile', 'モバイル新着')]);
      await act(async () => {
        vi.advanceTimersByTime(NEW_POSTS_POLL_INTERVAL_MS * 2);
      });

      expect(
        screen.queryByRole('button', { name: 'Tampilkan 1 pos baru' }),
      ).toBeNull();
      expect(screen.queryByText('モバイル新着')).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});
