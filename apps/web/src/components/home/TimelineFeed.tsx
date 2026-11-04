/**
 * Home timeline — `FeedComposer` + `TimelineFeed` as one island.
 * ---------------------------------------------------------------------------
 * Phase 1 of `docs/FREENET_SOCIAL_TIMELINE.md`: the Home feed shows seeded
 * community posts plus the posts this device publishes. Everything is local —
 * no network, no account (Freenet sync lands in a later phase).
 *
 * Layout follows the approved mockup: composer on top (avatar + placeholder +
 * "Publish" with a paper-plane icon), then a divider-separated post list with
 * Comment / Like / Share on each item.
 *
 * Feed behaviour:
 * - **Newest first** — `mergeTimelinePosts` sorts every post by `createdAt`.
 * - **Pull to refresh** (touch) — dragging the feed down while the page is at
 *   the top reveals an indicator; releasing past `PULL_REFRESH_THRESHOLD`
 *   re-syncs the store (storage + clock) and shows the refresh state briefly.
 * - **Infinite scroll** — only `INITIAL_VISIBLE_POSTS` render at first; an
 *   `IntersectionObserver` sentinel appends `LOAD_MORE_STEP` older posts each
 *   time it enters the viewport, and a terminal label closes the feed.
 * - **Desktop new-post polling** — the feed re-reads the store on an interval
 *   (plus cross-tab `storage` events) and parks whatever arrived behind a
 *   "show N new posts" pill under the composer instead of yanking the reader's
 *   scroll position. Clicking it prepends the posts and glides to the top.
 *
 * Hydration note: the device profile and the "time ago" labels only exist in
 * the browser, so both are gated behind a post-mount effect. That keeps the
 * prerendered HTML free of storage reads and prevents hydration mismatches;
 * the avatar keeps its fixed box so nothing shifts when it fills in.
 * ---------------------------------------------------------------------------
 */

'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { MessageSquare, RefreshCw, Send, Share2, Sparkles } from 'lucide-react';
import { toast } from 'sonner';

import { getDictionary } from '@i18n/index';
import {
  LOCALE_CHANGE_EVENT,
  type LocaleChangeDetail,
} from '@i18n/locale-events';
import type { Locale } from '@i18n/types';
import { readLocalProfile } from '@/features/player/profile/profile-store';
import {
  TIMELINE_POST_MAX_LENGTH,
  clampTimelineMessage,
  createTimelinePost,
  deriveHandle,
  formatRelativeTime,
  mergeTimelinePosts,
  readTimelineState,
  writeTimelineState,
  TIMELINE_STORAGE_KEY,
  type TimelinePost,
} from '@/features/timeline/timeline-store';

interface LocalAuthor {
  name: string;
  handle: string;
  avatar: string;
}

/** Posts rendered before the user scrolls (the feed grows from here). */
export const INITIAL_VISIBLE_POSTS = 5;

/** Posts appended each time the scroll sentinel is reached. */
export const LOAD_MORE_STEP = 5;

/** Finger travel (px) that turns a pull gesture into a refresh. */
export const PULL_REFRESH_THRESHOLD = 60;

/** Ceiling for the pull indicator height so the drag stays bounded. */
export const PULL_REFRESH_MAX = 96;

/** How long the "refreshing" state stays visible after release. */
const REFRESH_SETTLE_MS = 600;

/**
 * Desktop poll cadence for "new posts" detection. Reads the local store today;
 * this is the hook a later Freenet sync phase plugs its fetch into.
 */
export const NEW_POSTS_POLL_INTERVAL_MS = 30_000;

/** Matches the `max-width: 767px` breakpoint in `styles/timeline.css`. */
const DESKTOP_MEDIA_QUERY = '(min-width: 768px)';

/** Fill the `{count}` placeholder in the "show new posts" label. */
export function formatNewPostsLabel(template: string, count: number): string {
  return template.replace('{count}', String(count));
}

/**
 * Union two post lists by id. `primary` wins on conflict, so a write from this
 * device is never replaced by an older copy of the same post.
 */
function mergePostsById(
  primary: readonly TimelinePost[],
  secondary: readonly TimelinePost[],
): TimelinePost[] {
  const byId = new Map<string, TimelinePost>();
  for (const post of secondary) byId.set(post.id, post);
  for (const post of primary) byId.set(post.id, post);
  return [...byId.values()];
}

/** Union two like-id lists (post ids are unique, so order is not meaningful). */
function mergeLikedIds(
  primary: readonly string[],
  secondary: readonly string[],
): string[] {
  return [...new Set([...secondary, ...primary])];
}

export default function TimelineFeed() {
  // The Home page is prerendered, so the initial locale must match the server
  // HTML. Reading `document.documentElement.lang` here would hydrate a
  // different locale than the prerendered markup; the mount effect below
  // adopts the stored locale instead.
  const [locale, setLocale] = useState<Locale>('id');
  const [author, setAuthor] = useState<LocalAuthor | null>(null);
  const [localPosts, setLocalPosts] = useState<TimelinePost[]>([]);
  const [likedIds, setLikedIds] = useState<string[]>([]);
  const [draft, setDraft] = useState('');
  const [now, setNow] = useState<number | null>(null);
  const [visibleCount, setVisibleCount] = useState(INITIAL_VISIBLE_POSTS);
  const [pullDistance, setPullDistance] = useState(0);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [pendingCount, setPendingCount] = useState(0);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const rootRef = useRef<HTMLElement | null>(null);
  const sentinelRef = useRef<HTMLDivElement | null>(null);
  // Posts the reader has not accepted yet. The snapshot is the parked payload;
  // `showNewPosts` re-reads the store and merges by id on top of it, so a write
  // made while the pill was waiting is never dropped.
  const pendingSnapshotRef = useRef<TimelinePost[] | null>(null);
  const pendingLikesRef = useRef<string[]>([]);
  const localPostsRef = useRef<TimelinePost[]>([]);
  // Touch tracking lives in refs: the native listeners must see the current
  // values without being re-bound on every pointer move.
  const pullStartYRef = useRef<number | null>(null);
  const pullDistanceRef = useRef(0);
  const refreshingRef = useRef(false);
  const settleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  /** Re-sync the feed from storage and reset the clock behind the time labels. */
  const syncFromStorage = useCallback(() => {
    const state = readTimelineState();
    setLocalPosts(state.posts);
    setLikedIds(state.likedIds);
    setNow(Date.now());
    setVisibleCount(INITIAL_VISIBLE_POSTS);
  }, []);

  // Browser-only state: profile, persisted posts, likes, and the clock used by
  // the relative-time labels.
  useEffect(() => {
    const lang = document.documentElement.lang;
    if (lang === 'ja' || lang === 'en') setLocale(lang);

    const profile = readLocalProfile();
    setAuthor({
      name: profile.name,
      handle: deriveHandle(profile.name),
      avatar: profile.avatar,
    });
    syncFromStorage();
  }, [syncFromStorage]);

  useEffect(() => {
    const handler = (event: Event) => {
      const detail = (event as CustomEvent<LocaleChangeDetail>).detail;
      if (detail?.locale) setLocale(detail.locale);
    };
    window.addEventListener(LOCALE_CHANGE_EVENT, handler);
    return () => window.removeEventListener(LOCALE_CHANGE_EVENT, handler);
  }, []);

  // Mirror the rendered posts so the polling callback can diff without being
  // re-created on every publish.
  useEffect(() => {
    localPostsRef.current = localPosts;
  }, [localPosts]);

  const t = getDictionary(locale).timeline;
  const feed = useMemo(() => mergeTimelinePosts(localPosts), [localPosts]);
  const canPublish = clampTimelineMessage(draft).length > 0;
  const visiblePosts = useMemo(
    () => feed.slice(0, visibleCount),
    [feed, visibleCount],
  );
  const hasMore = visibleCount < feed.length;

  /** Release the pull indicator after a completed refresh. */
  useEffect(
    () => () => {
      if (settleTimerRef.current !== null) clearTimeout(settleTimerRef.current);
    },
    [],
  );

  /**
   * Diff the store against what is on screen and park anything new behind the
   * pill. Desktop only — on mobile the pull gesture owns the refresh.
   */
  const checkForNewPosts = useCallback(() => {
    if (typeof window === 'undefined') return;
    const isDesktop =
      typeof window.matchMedia === 'function'
        ? window.matchMedia(DESKTOP_MEDIA_QUERY).matches
        : true;
    if (!isDesktop) return;

    const state = readTimelineState();
    const known = new Set(localPostsRef.current.map((post) => post.id));
    const fresh = state.posts.filter((post) => !known.has(post.id));
    if (fresh.length === 0) {
      // Nothing is waiting any more (another tab undid its write, or the posts
      // were adopted): drop the parked snapshot so a later click cannot revive
      // a stale feed.
      pendingSnapshotRef.current = null;
      pendingLikesRef.current = [];
      setPendingCount(0);
      return;
    }

    pendingSnapshotRef.current = state.posts;
    pendingLikesRef.current = state.likedIds;
    setPendingCount(fresh.length);
  }, []);

  // Desktop poll + cross-tab sync. Neither touches the scroll position: new
  // posts wait behind the pill until the reader asks for them.
  useEffect(() => {
    const timer = setInterval(checkForNewPosts, NEW_POSTS_POLL_INTERVAL_MS);
    const onStorage = (event: StorageEvent) => {
      if (event.key !== null && event.key !== TIMELINE_STORAGE_KEY) return;
      checkForNewPosts();
    };
    window.addEventListener('storage', onStorage);
    return () => {
      clearInterval(timer);
      window.removeEventListener('storage', onStorage);
    };
  }, [checkForNewPosts]);

  /**
   * Adopt the parked posts: merge, re-sort, and glide back to the top.
   *
   * The snapshot alone is stale — a post published (or a like toggled) after
   * the pill appeared lives in React state and in storage, not in it — so the
   * store is read again and both sides are merged by id. Nothing the reader
   * did while the pill was waiting can be lost.
   */
  const showNewPosts = useCallback(() => {
    const snapshot = pendingSnapshotRef.current;
    const snapshotLikes = pendingLikesRef.current;
    const added = pendingCount;
    pendingSnapshotRef.current = null;
    pendingLikesRef.current = [];
    setPendingCount(0);
    if (snapshot === null) return;

    const state = readTimelineState();
    const parked = state.posts.length > 0 ? state.posts : snapshot;
    const likes = state.likedIds.length > 0 ? state.likedIds : snapshotLikes;

    setLocalPosts((current) => mergePostsById(current, parked));
    setLikedIds((current) => mergeLikedIds(likes, current));
    setNow(Date.now());
    setVisibleCount((count) => Math.max(count, INITIAL_VISIBLE_POSTS) + added);

    // Smooth scroll to the top so the newest post lands in view.
    try {
      window.scrollTo({ top: 0, behavior: 'smooth' });
    } catch {
      // Environments without smooth scrolling (jsdom included) simply stay put.
    }
  }, [pendingCount]);

  const triggerRefresh = useCallback(() => {
    refreshingRef.current = true;
    setIsRefreshing(true);
    syncFromStorage();
    if (settleTimerRef.current !== null) clearTimeout(settleTimerRef.current);
    settleTimerRef.current = setTimeout(() => {
      settleTimerRef.current = null;
      refreshingRef.current = false;
      setIsRefreshing(false);
    }, REFRESH_SETTLE_MS);
  }, [syncFromStorage]);

  // Pull to refresh. Native (non-passive) touch listeners so the drag can call
  // `preventDefault()` and stop the browser's own overscroll/refresh gesture.
  useEffect(() => {
    const node = rootRef.current;
    if (node === null) return;

    const resetPull = () => {
      pullStartYRef.current = null;
      pullDistanceRef.current = 0;
      setPullDistance(0);
    };

    const handleStart = (event: TouchEvent) => {
      if (refreshingRef.current) return;
      // Only a feed that is already scrolled to the very top may be pulled.
      if (window.scrollY > 0) return;
      const touch = event.touches[0];
      if (touch === undefined) return;
      pullStartYRef.current = touch.clientY;
    };

    const handleMove = (event: TouchEvent) => {
      const start = pullStartYRef.current;
      if (start === null) return;
      const touch = event.touches[0];
      if (touch === undefined) return;
      const delta = touch.clientY - start;
      if (delta <= 0) {
        pullDistanceRef.current = 0;
        setPullDistance(0);
        return;
      }
      if (event.cancelable) event.preventDefault();
      const next = Math.min(delta, PULL_REFRESH_MAX);
      pullDistanceRef.current = next;
      setPullDistance(next);
    };

    const handleEnd = () => {
      if (pullStartYRef.current === null) return;
      const distance = pullDistanceRef.current;
      resetPull();
      if (distance >= PULL_REFRESH_THRESHOLD) triggerRefresh();
    };

    node.addEventListener('touchstart', handleStart, { passive: true });
    node.addEventListener('touchmove', handleMove, { passive: false });
    node.addEventListener('touchend', handleEnd);
    node.addEventListener('touchcancel', handleEnd);
    return () => {
      node.removeEventListener('touchstart', handleStart);
      node.removeEventListener('touchmove', handleMove);
      node.removeEventListener('touchend', handleEnd);
      node.removeEventListener('touchcancel', handleEnd);
    };
  }, [triggerRefresh]);

  // Infinite scroll: watch the sentinel that trails the last rendered post and
  // append the next (older) page when it comes into view.
  useEffect(() => {
    if (!hasMore) return;
    const node = sentinelRef.current;
    if (node === null) return;
    if (typeof IntersectionObserver === 'undefined') return;

    const observer = new IntersectionObserver(
      (entries) => {
        if (!entries.some((entry) => entry.isIntersecting)) return;
        setVisibleCount((count) => count + LOAD_MORE_STEP);
      },
      { rootMargin: '200px 0px' },
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, [hasMore, visibleCount]);

  const persist = useCallback((posts: TimelinePost[], likes: string[]) => {
    writeTimelineState({
      schemaVersion: 1,
      posts,
      likedIds: likes,
    });
  }, []);

  const handlePublish = useCallback(
    (event: React.SyntheticEvent<HTMLFormElement>) => {
      event.preventDefault();
      if (author === null) return;
      const post = createTimelinePost(draft, author);
      if (post === null) return;
      // Fold in whatever the store holds (a cross-tab write parked behind the
      // pill, a like from another tab) so publishing never clobbers it.
      const state = readTimelineState();
      const next = [post, ...mergePostsById(localPosts, state.posts)];
      const likes = mergeLikedIds(likedIds, state.likedIds);
      setLocalPosts(next);
      setLikedIds(likes);
      persist(next, likes);
      // The pill's snapshot is now stale and its posts are on screen: retire it
      // instead of letting a later click restore an older feed.
      pendingSnapshotRef.current = null;
      pendingLikesRef.current = [];
      setPendingCount(0);
      setDraft('');
      // Keep every already-visible post on screen: the new one adds a row at
      // the top of the page window.
      setVisibleCount((count) => count + 1);
    },
    [author, draft, localPosts, likedIds, persist],
  );

  const toggleLike = useCallback(
    (postId: string) => {
      const state = readTimelineState();
      const merged = mergeLikedIds(likedIds, state.likedIds);
      const next = merged.includes(postId)
        ? merged.filter((id) => id !== postId)
        : [...merged, postId];
      setLikedIds(next);
      persist(mergePostsById(localPosts, state.posts), next);
      // Same reason as publishing: a like is a write, so the parked snapshot
      // would no longer match the store.
      pendingSnapshotRef.current = null;
      pendingLikesRef.current = [];
      setPendingCount(0);
    },
    [likedIds, localPosts, persist],
  );

  // Note: replies are not part of phase 1 — "Comment" opens the composer so the
  // user lands in the right place instead of hitting a dead button.
  const focusComposer = useCallback(() => {
    textareaRef.current?.focus();
  }, []);

  const sharePost = useCallback(
    async (post: TimelinePost) => {
      try {
        await navigator.clipboard.writeText(post.message);
        toast.success(t.shareCopied);
      } catch {
        toast.error(t.shareFailed);
      }
    },
    [t.shareCopied, t.shareFailed],
  );

  const indicatorHeight = isRefreshing ? 44 : pullDistance;
  const pullState = isRefreshing
    ? 'refreshing'
    : pullDistance >= PULL_REFRESH_THRESHOLD
      ? 'ready'
      : 'idle';

  return (
    <section
      className="entei-timeline-root"
      aria-labelledby="entei-timeline-heading"
      ref={rootRef}
    >
      {/* The Home page has no other top-level heading, so the (visually
          hidden) feed heading is the page h1 — exactly one h1 per page. */}
      <h1 className="entei-sr-only" id="entei-timeline-heading">
        {t.heading}
      </h1>

      {/* Rounded-hexagon avatar contour. Declared once here so the composer
          avatar and every post avatar share the same smooth-cornered shape
          (see `.entei-timeline-avatar` in `styles/timeline.css`). */}
      <svg
        className="entei-timeline-avatar-clip-defs"
        aria-hidden="true"
        focusable="false"
      >
        <defs>
          <clipPath id="entei-hex-clip" clipPathUnits="objectBoundingBox">
            <path d="M0.661 0.0805L0.839 0.1695Q1 0.25 1 0.43L1 0.57Q1 0.75 0.839 0.8305L0.661 0.9195Q0.5 1 0.339 0.9195L0.161 0.8305Q0 0.75 0 0.57L0 0.43Q0 0.25 0.161 0.1695L0.339 0.0805Q0.5 0 0.661 0.0805Z" />
          </clipPath>
        </defs>
      </svg>

      {/* Pull-to-refresh indicator: its height follows the finger, and it
          collapses to 0 when idle so it never reserves layout space. */}
      <div
        className="entei-timeline-pull"
        data-state={pullState}
        style={{ height: `${indicatorHeight}px` }}
        aria-live="polite"
        aria-hidden={pullState === 'idle'}
      >
        <RefreshCw
          className="entei-timeline-pull-icon"
          size={18}
          aria-hidden="true"
        />
        <span className="entei-timeline-pull-label">
          {isRefreshing ? t.refreshing : t.pullToRefresh}
        </span>
      </div>

      <form className="entei-timeline-composer" onSubmit={handlePublish}>
        <div className="entei-timeline-composer-row">
          <span className="entei-timeline-avatar">
            {author !== null && (
              <img src={author.avatar} alt={t.avatarAlt} loading="lazy" />
            )}
          </span>
          <textarea
            ref={textareaRef}
            className="entei-timeline-textarea"
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            placeholder={t.composerPlaceholder}
            aria-label={t.composerPlaceholder}
            maxLength={TIMELINE_POST_MAX_LENGTH}
            rows={1}
          />
        </div>
        <div className="entei-timeline-composer-actions">
          <button
            type="submit"
            className="entei-timeline-publish"
            aria-label={t.composerSubmitAriaLabel}
            disabled={!canPublish}
          >
            <Send size={16} aria-hidden="true" />
            <span>{t.composerSubmit}</span>
          </button>
        </div>
      </form>

      {/* Desktop "new posts" pill: appears when the poll found posts that are
          not on screen yet. Clicking adopts them and scrolls to the top. */}
      {pendingCount > 0 && (
        <div className="entei-timeline-new-posts-wrap" role="status">
          <button
            type="button"
            className="entei-timeline-new-posts"
            onClick={showNewPosts}
          >
            <Sparkles size={14} aria-hidden="true" />
            <span>{formatNewPostsLabel(t.showNewPosts, pendingCount)}</span>
          </button>
        </div>
      )}

      <ul className="entei-timeline-feed" role="list">
        {visiblePosts.map((post) => {
          const liked = likedIds.includes(post.id);
          return (
            <li className="entei-timeline-post" key={post.id}>
              <div className="entei-timeline-post-head">
                <span className="entei-timeline-avatar">
                  <img src={post.avatar} alt="" loading="lazy" />
                </span>
                <span className="entei-timeline-author">
                  <span className="entei-timeline-author-name">
                    {post.authorName}
                  </span>
                  <span className="entei-timeline-author-handle">
                    {post.authorHandle}
                  </span>
                </span>
                {now !== null && (
                  <time
                    className="entei-timeline-time"
                    dateTime={new Date(post.createdAt).toISOString()}
                  >
                    {formatRelativeTime(post.createdAt, now, locale)}
                  </time>
                )}
              </div>

              <p className="entei-timeline-post-body">{post.message}</p>

              <div className="entei-timeline-post-actions">
                <button
                  type="button"
                  className="entei-timeline-action"
                  onClick={focusComposer}
                >
                  <MessageSquare size={16} aria-hidden="true" />
                  <span>{t.actionComment}</span>
                </button>
                <button
                  type="button"
                  className="entei-timeline-action"
                  aria-pressed={liked}
                  aria-label={liked ? t.actionUnlike : t.actionLike}
                  onClick={() => toggleLike(post.id)}
                >
                  <Sparkles size={16} aria-hidden="true" />
                  <span>{t.actionLike}</span>
                </button>
                <button
                  type="button"
                  className="entei-timeline-action"
                  onClick={() => {
                    void sharePost(post);
                  }}
                >
                  <Share2 size={16} aria-hidden="true" />
                  <span>{t.actionShare}</span>
                </button>
              </div>
            </li>
          );
        })}
      </ul>

      {/* Infinite scroll: the sentinel is not a post, so it stays outside the
          list (keeps `listitem` counts equal to the rendered posts). */}
      {hasMore ? (
        <div
          className="entei-timeline-sentinel"
          ref={sentinelRef}
          aria-hidden="true"
        />
      ) : (
        <p className="entei-timeline-end">{t.endOfFeed}</p>
      )}
    </section>
  );
}
