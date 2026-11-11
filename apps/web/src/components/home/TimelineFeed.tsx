/**
 * Home timeline — `FeedComposer` + `TimelineFeed` as one island.
 * ---------------------------------------------------------------------------
 * Phase 1 of `docs/FREENET_SOCIAL_TIMELINE.md`: the Home feed shows seeded
 * community posts plus the posts this device publishes. Everything is local —
 * no network, no account (Freenet sync lands in a later phase).
 *
 * Layout follows the approved mockup: composer on top (avatar + a shadcn-style
 * block-end InputGroup holding the textarea, character count and Publish),
 * then a divider-separated post list with Comment / Like / Share on each item.
 * The thread reply composer uses the same joined InputGroup.
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
 * - **Post detail** — clicking a post (or its Comment button) swaps the feed
 *   for a Twitter/X-style thread: back header, the focused post, a reply
 *   composer, and the replies below it.
 *
 * Hydration note: the device profile and the "time ago" labels only exist in
 * the browser, so both are gated behind a post-mount effect. That keeps the
 * prerendered HTML free of storage reads and prevents hydration mismatches;
 * the avatar keeps its fixed box so nothing shifts when it fills in.
 * ---------------------------------------------------------------------------
 */

'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowLeft,
  MessageSquare,
  RefreshCw,
  Send,
  Share2,
  Sparkles,
} from 'lucide-react';
import { toast } from 'sonner';

import { getDictionary } from '@i18n/index';
import {
  LOCALE_CHANGE_EVENT,
  type LocaleChangeDetail,
} from '@i18n/locale-events';
import type { Locale } from '@i18n/types';
import { readLocalProfile } from '@/features/player/profile/profile-store';
import { isTauri } from '@/features/player/tauri-bridge';
import { trace, traceError } from '@/features/trace/trace-logger';
import {
  TIMELINE_POST_MAX_LENGTH,
  clampTimelineComment,
  clampTimelineMessage,
  countTimelineComments,
  countTimelineLikes,
  createPostDb,
  createReplyDb,
  createTimelineComment,
  createTimelinePost,
  deriveHandle,
  formatMetricCount,
  formatRelativeTime,
  loadTimelineState,
  mergeTimelineComments,
  mergeTimelinePosts,
  readTimelineState,
  toggleLikeDb,
  writeTimelineState,
  TIMELINE_STORAGE_KEY,
  type TimelineComment,
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

/**
 * Accessible name for an action button that also shows a count: the count is
 * part of the name so a screen reader hears "Comment 2" instead of a bare
 * label with a silently skipped number.
 */
function actionLabel(label: string, countLabel: string): string {
  return countLabel.length === 0 ? label : `${label} ${countLabel}`;
}

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

/**
 * Union reply lists by id and append `incoming`, so the reply just written and
 * anything another tab stored meanwhile both survive the write.
 *
 * `incoming` is optional: a write that does not create a reply (publishing a
 * post, toggling a like) still has to merge, otherwise the raw React state
 * would overwrite replies another tab stored in the meantime.
 */
function mergeCommentsById(
  primary: readonly TimelineComment[],
  secondary: readonly TimelineComment[],
  incoming?: TimelineComment,
): TimelineComment[] {
  const byId = new Map<string, TimelineComment>();
  for (const comment of secondary) byId.set(comment.id, comment);
  for (const comment of primary) byId.set(comment.id, comment);
  if (incoming !== undefined && !byId.has(incoming.id)) {
    byId.set(incoming.id, incoming);
  }
  return [...byId.values()];
}

/**
 * True when the current history entry is the one `openPost` pushed for a
 * thread. Closing the thread must consume that entry (`history.back()`) rather
 * than stacking another one, or the browser's Back button would need two
 * presses to leave the page.
 */
function hasTimelineHistoryEntry(): boolean {
  try {
    const state = window.history.state as
      | { enteiTimelinePost?: unknown }
      | null;
    return typeof state?.enteiTimelinePost === 'string';
  } catch {
    return false;
  }
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
  const [comments, setComments] = useState<TimelineComment[]>([]);
  // Post detail view: `null` is the feed, an id is that post's thread.
  const [selectedPostId, setSelectedPostId] = useState<string | null>(null);
  const [replyDraft, setReplyDraft] = useState('');
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
  const syncFromStorage = useCallback(async () => {
    // Desktop reads SQLite (user posts/replies + kv likedIds); browser reads
    // localStorage. Both return the same TimelineState shape, seeds excluded.
    const state = await loadTimelineState();
    setLocalPosts(state.posts);
    setLikedIds(state.likedIds);
    setComments(state.comments);
    setNow(Date.now());
    setVisibleCount(INITIAL_VISIBLE_POSTS);
  }, []);

  // Browser-only state: profile, persisted posts, likes, and the clock used by
  // the relative-time labels.
  useEffect(() => {
    const lang = document.documentElement.lang;
    if (lang === 'ja' || lang === 'en') setLocale(lang);

    // The composer author is read synchronously from the profile cache so it is
    // ready the instant the feed mounts — awaiting a desktop DB read here would
    // leave the composer authorless through the first paint. On desktop the
    // cache mirrors the SQLite profile (write-through + the profile dashboard's
    // DB hydration), so the synchronous read is consistent with the DB.
    const profile = readLocalProfile();
    setAuthor({
      name: profile.name,
      handle: deriveHandle(profile.name),
      avatar: profile.avatar,
    });

    let cancelled = false;
    void (async () => {
      await syncFromStorage();
      const state = await loadTimelineState();
      if (cancelled) return;
      trace('home', 'feed_ready', {
        posts: state.posts.length,
        likes: state.likedIds.length,
        comments: state.comments.length,
        hasProfileName: profile.name.trim().length > 0,
      });
    })();
    return () => {
      cancelled = true;
    };
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

  // Post detail view data. `selectedPost` is null when the id no longer exists
  // (e.g. another tab removed it), which falls back to the feed.
  const selectedPost = useMemo(
    () =>
      selectedPostId === null
        ? null
        : (feed.find((post) => post.id === selectedPostId) ?? null),
    [feed, selectedPostId],
  );
  const thread = useMemo(
    () =>
      selectedPostId === null
        ? []
        : mergeTimelineComments(comments, selectedPostId),
    [comments, selectedPostId],
  );
  const canReply = clampTimelineComment(replyDraft).length > 0;
  const isDetail = selectedPost !== null;
  // Computed once for the thread view, exactly like a feed row: the label
  // feeds both the aria-label and the badge, and an empty label hides the
  // badge so the pill never shows a dangling "0".
  const detailLiked =
    selectedPost !== null && likedIds.includes(selectedPost.id);
  const detailLikeCountLabel =
    selectedPost === null
      ? ''
      : formatMetricCount(countTimelineLikes(selectedPost.id, detailLiked));

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
    trace('home', 'new_posts_click', { added, total: parked.length });

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
    void syncFromStorage();
    trace('home', 'refresh', { posts: localPostsRef.current.length });
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
    // Pull-to-refresh belongs to the feed; the detail view is not a list.
    if (isDetail) return;
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
  }, [triggerRefresh, isDetail]);

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
        trace('home', 'load_more', { step: LOAD_MORE_STEP });
      },
      { rootMargin: '200px 0px' },
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, [hasMore, visibleCount]);

  const persist = useCallback(
    (posts: TimelinePost[], likes: string[], replies: TimelineComment[]) => {
      writeTimelineState({
        schemaVersion: 1,
        posts,
        likedIds: likes,
        comments: replies,
      });
    },
    [],
  );

  const handlePublish = useCallback(
    (event: React.SyntheticEvent<HTMLFormElement>) => {
      event.preventDefault();
      if (author === null) return;
      if (isTauri()) {
        // Desktop: persist to SQLite and adopt the DB-assigned id so likes and
        // the detail view stay keyed to the persisted row. No cross-tab merge
        // is needed (a single desktop window has no second tab writing).
        void (async () => {
          const post = await createPostDb(draft, author);
          if (post === null) return;
          setLocalPosts((current) => mergePostsById([post], current));
          pendingSnapshotRef.current = null;
          pendingLikesRef.current = [];
          setPendingCount(0);
          setDraft('');
          setVisibleCount((count) => count + 1);
          trace('home', 'post_publish', {
            postId: post.id,
            length: post.message.length,
            author: post.authorName,
            totalPosts: localPostsRef.current.length + 1,
          });
        })();
        return;
      }
      const post = createTimelinePost(draft, author);
      if (post === null) return;
      // Fold in whatever the store holds (a cross-tab write parked behind the
      // pill, a like from another tab) so publishing never clobbers it.
      const state = readTimelineState();
      const next = [post, ...mergePostsById(localPosts, state.posts)];
      const likes = mergeLikedIds(likedIds, state.likedIds);
      const replies = mergeCommentsById(comments, state.comments);
      setLocalPosts(next);
      setLikedIds(likes);
      setComments(replies);
      persist(next, likes, replies);
      // The pill's snapshot is now stale and its posts are on screen: retire it
      // instead of letting a later click restore an older feed.
      pendingSnapshotRef.current = null;
      pendingLikesRef.current = [];
      setPendingCount(0);
      setDraft('');
      // Keep every already-visible post on screen: the new one adds a row at
      // the top of the page window.
      setVisibleCount((count) => count + 1);
      trace('home', 'post_publish', {
        postId: post.id,
        length: post.message.length,
        author: post.authorName,
        totalPosts: next.length,
      });
    },
    [author, draft, localPosts, likedIds, comments, persist],
  );

  const toggleLike = useCallback(
    (postId: string) => {
      if (isTauri()) {
        // Desktop: the liked-id array lives in the key/value store (it covers
        // seed posts too, which have no row for a per-post flag).
        void (async () => {
          const next = await toggleLikeDb(postId);
          if (next === null) return;
          setLikedIds(next);
          pendingSnapshotRef.current = null;
          pendingLikesRef.current = [];
          setPendingCount(0);
          trace('home', 'like_toggle', {
            postId,
            liked: next.includes(postId),
            likes: next.length,
          });
        })();
        return;
      }
      const state = readTimelineState();
      const merged = mergeLikedIds(likedIds, state.likedIds);
      const next = merged.includes(postId)
        ? merged.filter((id) => id !== postId)
        : [...merged, postId];
      // A like is a full-state write, so replies written in another tab have to
      // be merged in as well or they would be clobbered by the React copy.
      const replies = mergeCommentsById(comments, state.comments);
      setLikedIds(next);
      setComments(replies);
      persist(mergePostsById(localPosts, state.posts), next, replies);
      // Same reason as publishing: a like is a write, so the parked snapshot
      // would no longer match the store.
      pendingSnapshotRef.current = null;
      pendingLikesRef.current = [];
      setPendingCount(0);
      trace('home', 'like_toggle', {
        postId,
        liked: next.includes(postId),
        likes: next.length,
      });
    },
    [likedIds, localPosts, comments, persist],
  );

  // Note: replies live in the post detail view — the feed's "Comment" button
  // opens that post's thread, so the button never lands on a dead end.
  const openPost = useCallback((postId: string) => {
    setReplyDraft('');
    setSelectedPostId(postId);
    trace('home', 'post_open', { postId });
    // Give the browser's Back button the same meaning as the header control.
    try {
      window.history.pushState({ enteiTimelinePost: postId }, '');
    } catch {
      // History is unavailable in some embeddings; the back button still works.
    }
  }, []);

  const closePost = useCallback(() => {
    trace('home', 'post_close', { postId: selectedPostId });
    setSelectedPostId(null);
    setReplyDraft('');
    // `openPost` pushed a history entry so the browser Back button could leave
    // the thread. Closing from the header control has to consume that entry,
    // otherwise it stays behind and Back only appears to do nothing.
    if (hasTimelineHistoryEntry()) {
      try {
        window.history.back();
      } catch {
        // History is unavailable in some embeddings; the state is cleared.
      }
    }
  }, [selectedPostId]);

  // Browser back (and the hardware back gesture) leaves the thread. Clearing
  // `selectedPostId` is what clears the thread: `selectedPost` is derived from
  // it, so a null/undefined history state can never leave a stale post behind.
  useEffect(() => {
    const onPopState = () => {
      setSelectedPostId(null);
      setReplyDraft('');
    };
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, []);

  const handleReply = useCallback(
    (event: React.SyntheticEvent<HTMLFormElement>) => {
      event.preventDefault();
      if (author === null || selectedPostId === null) return;
      if (isTauri()) {
        // Desktop: persist the reply (a post with a parentId) and adopt the
        // DB-assigned id.
        void (async () => {
          const comment = await createReplyDb(selectedPostId, replyDraft, author);
          if (comment === null) return;
          setComments((current) => mergeCommentsById(current, [], comment));
          setReplyDraft('');
          setNow(Date.now());
          trace('home', 'comment_publish', {
            postId: selectedPostId,
            commentId: comment.id,
            length: comment.text.length,
            replies:
              comments.filter((item) => item.postId === selectedPostId).length + 1,
          });
        })();
        return;
      }
      const comment = createTimelineComment(selectedPostId, replyDraft, author);
      if (comment === null) return;
      // Fold in whatever the store holds so a cross-tab reply is never dropped.
      const state = readTimelineState();
      const next = mergeCommentsById(comments, state.comments, comment);
      setComments(next);
      setReplyDraft('');
      persist(mergePostsById(localPosts, state.posts), mergeLikedIds(likedIds, state.likedIds), next);
      setNow(Date.now());
      trace('home', 'comment_publish', {
        postId: selectedPostId,
        commentId: comment.id,
        length: comment.text.length,
        replies: next.filter((item) => item.postId === selectedPostId).length,
      });
    },
    [author, selectedPostId, replyDraft, comments, localPosts, likedIds, persist],
  );

  const sharePost = useCallback(
    async (post: TimelinePost) => {
      try {
        await navigator.clipboard.writeText(post.message);
        toast.success(t.shareCopied);
        trace('home', 'share', { postId: post.id, ok: true });
      } catch (error) {
        toast.error(t.shareFailed);
        traceError('home', 'share', error, { postId: post.id, ok: false });
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
      className={
        isDetail
          ? 'entei-timeline-root entei-timeline-root--detail'
          : 'entei-timeline-root'
      }
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

      {isDetail && selectedPost !== null ? (
        /* ===== POST DETAIL (thread) ===== */
        <div className="entei-timeline-detail">
          <div className="entei-timeline-detail-head">
            <button
              type="button"
              className="entei-timeline-back"
              onClick={closePost}
              aria-label={t.backAriaLabel}
            >
              <ArrowLeft size={18} aria-hidden="true" />
              <span>{t.back}</span>
            </button>
            <h2 className="entei-timeline-detail-title">{t.postTitle}</h2>
          </div>

          <article className="entei-timeline-detail-post">
            <div className="entei-timeline-post-head">
              <span className="entei-timeline-avatar entei-timeline-detail-avatar">
                <img src={selectedPost.avatar} alt="" loading="lazy" />
              </span>
              <span className="entei-timeline-author">
                <span className="entei-timeline-author-name">
                  {selectedPost.authorName}
                </span>
                <span className="entei-timeline-author-meta">
                  <span className="entei-timeline-author-handle">
                    {selectedPost.authorHandle}
                  </span>
                  {now !== null && (
                    <>
                      <span
                        className="entei-timeline-author-dot"
                        aria-hidden="true"
                      >
                        ·
                      </span>
                      <time
                        className="entei-timeline-time"
                        dateTime={new Date(selectedPost.createdAt).toISOString()}
                      >
                        {formatRelativeTime(selectedPost.createdAt, now, locale)}
                      </time>
                    </>
                  )}
                </span>
              </span>
            </div>

            <p className="entei-timeline-detail-body">{selectedPost.message}</p>

            <div className="entei-timeline-post-actions">
              <button
                type="button"
                className="entei-timeline-action"
                aria-pressed={detailLiked}
                aria-label={actionLabel(
                  detailLiked ? t.actionUnlike : t.actionLike,
                  detailLikeCountLabel,
                )}
                onClick={() => toggleLike(selectedPost.id)}
              >
                <Sparkles size={14} aria-hidden="true" />
                <span>{detailLiked ? t.actionUnlike : t.actionLike}</span>
                {detailLikeCountLabel !== '' && (
                  <span className="entei-timeline-action-count">
                    {detailLikeCountLabel}
                  </span>
                )}
              </button>
              <button
                type="button"
                className="entei-timeline-action"
                onClick={() => {
                  void sharePost(selectedPost);
                }}
              >
                <Share2 size={14} aria-hidden="true" />
                <span>{t.actionShare}</span>
              </button>
            </div>
          </article>

          {/* Reply composer: shadcn InputGroup with a block-end addon. The
              control comes first in the DOM so focus moves from the textarea
              into the footer actions (official InputGroupAddon contract). */}
          <form className="entei-timeline-reply" onSubmit={handleReply}>
            <span className="entei-timeline-avatar entei-timeline-reply-avatar">
              {author !== null && (
                <img src={author.avatar} alt={t.avatarAlt} loading="lazy" />
              )}
            </span>
            <div className="entei-timeline-input-group" data-slot="input-group">
              <textarea
                className="entei-timeline-reply-input"
                data-slot="input-group-control"
                value={replyDraft}
                onChange={(event) => setReplyDraft(event.target.value)}
                placeholder={t.replyPlaceholder}
                aria-label={t.replyPlaceholder}
                maxLength={TIMELINE_POST_MAX_LENGTH}
                rows={1}
              />
              <div
                className="entei-timeline-input-group-addon"
                data-slot="input-group-addon"
                data-align="block-end"
              >
                <span
                  className="entei-timeline-input-group-text"
                  data-slot="input-group-text"
                  aria-hidden="true"
                >
                  {replyDraft.length}/{TIMELINE_POST_MAX_LENGTH}
                </span>
                <button
                  type="submit"
                  className="entei-timeline-reply-submit"
                  data-slot="input-group-button"
                  aria-label={t.replySubmitAriaLabel}
                  disabled={!canReply}
                >
                  <Send size={15} aria-hidden="true" />
                  <span>{t.replySubmit}</span>
                </button>
              </div>
            </div>
          </form>

          {thread.length > 0 ? (
            <ul className="entei-timeline-comments" role="list">
              {thread.map((comment) => (
                <li className="entei-timeline-comment" key={comment.id}>
                  <span className="entei-timeline-avatar entei-timeline-comment-avatar">
                    <img src={comment.author.avatar} alt="" loading="lazy" />
                  </span>
                  <div className="entei-timeline-comment-main">
                    <span className="entei-timeline-author">
                      <span className="entei-timeline-author-name">
                        {comment.author.name}
                      </span>
                      <span className="entei-timeline-author-meta">
                        <span className="entei-timeline-author-handle">
                          {comment.author.handle}
                        </span>
                        {now !== null && (
                          <>
                            <span
                              className="entei-timeline-author-dot"
                              aria-hidden="true"
                            >
                              ·
                            </span>
                            <time
                              className="entei-timeline-time"
                              dateTime={new Date(
                                comment.createdAt,
                              ).toISOString()}
                            >
                              {formatRelativeTime(
                                comment.createdAt,
                                now,
                                locale,
                              )}
                            </time>
                          </>
                        )}
                      </span>
                    </span>
                    <p className="entei-timeline-comment-body">
                      {comment.text}
                    </p>
                  </div>
                </li>
              ))}
            </ul>
          ) : (
            <p className="entei-timeline-comments-empty">{t.noComments}</p>
          )}
        </div>
      ) : (
        <>
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
              <div
                className="entei-timeline-input-group"
                data-slot="input-group"
              >
                <textarea
                  ref={textareaRef}
                  className="entei-timeline-textarea"
                  data-slot="input-group-control"
                  value={draft}
                  onChange={(event) => setDraft(event.target.value)}
                  placeholder={t.composerPlaceholder}
                  aria-label={t.composerPlaceholder}
                  maxLength={TIMELINE_POST_MAX_LENGTH}
                  rows={1}
                />
                <div
                  className="entei-timeline-input-group-addon"
                  data-slot="input-group-addon"
                  data-align="block-end"
                >
                  <span
                    className="entei-timeline-input-group-text"
                    data-slot="input-group-text"
                    aria-hidden="true"
                  >
                    {draft.length}/{TIMELINE_POST_MAX_LENGTH}
                  </span>
                  <button
                    type="submit"
                    className="entei-timeline-publish"
                    data-slot="input-group-button"
                    aria-label={t.composerSubmitAriaLabel}
                    disabled={!canPublish}
                  >
                    <Send size={15} aria-hidden="true" />
                    <span>{t.composerSubmit}</span>
                  </button>
                </div>
              </div>
            </div>
          </form>

          {/* Desktop "new posts" pill: appears when the poll found posts that
              are not on screen yet. Clicking adopts them and scrolls to top. */}
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
              // Computed once per post: the label feeds both the aria-label
              // and the badge below.
              const commentCountLabel = formatMetricCount(
                countTimelineComments(comments, post.id),
              );
              const likeCountLabel = formatMetricCount(
                countTimelineLikes(post.id, liked),
              );
              return (
                <li
                  className="entei-timeline-post"
                  key={post.id}
                  onClick={() => openPost(post.id)}
                >
                  {/* The whole card opens the thread. The head + body wrapper
                      keeps the keyboard affordance (role=button + focus ring)
                      because the content is flow content; the pointer handler
                      lives on the card so padding and the action-row gutter
                      are clickable too. Action pills stop propagation so
                      Like/Share never navigate. */}
                  <div
                    className="entei-timeline-post-open"
                    role="button"
                    tabIndex={0}
                    onKeyDown={(event) => {
                      if (event.key !== 'Enter' && event.key !== ' ') return;
                      event.preventDefault();
                      openPost(post.id);
                    }}
                  >
                    <div className="entei-timeline-post-head">
                      <span className="entei-timeline-avatar">
                        <img src={post.avatar} alt="" loading="lazy" />
                      </span>
                      <span className="entei-timeline-author">
                        <span className="entei-timeline-author-name">
                          {post.authorName}
                        </span>
                        <span className="entei-timeline-author-meta">
                          <span className="entei-timeline-author-handle">
                            {post.authorHandle}
                          </span>
                          {now !== null && (
                            <>
                              <span
                                className="entei-timeline-author-dot"
                                aria-hidden="true"
                              >
                                ·
                              </span>
                              <time
                                className="entei-timeline-time"
                                dateTime={new Date(post.createdAt).toISOString()}
                              >
                                {formatRelativeTime(post.createdAt, now, locale)}
                              </time>
                            </>
                          )}
                        </span>
                      </span>
                    </div>

                    <p className="entei-timeline-post-body">{post.message}</p>
                  </div>

                  <div className="entei-timeline-post-actions">
                    <button
                      type="button"
                      className="entei-timeline-action"
                      aria-label={actionLabel(
                        t.actionComment,
                        commentCountLabel,
                      )}
                      onClick={(event) => {
                        event.stopPropagation();
                        openPost(post.id);
                      }}
                    >
                      <MessageSquare size={14} aria-hidden="true" />
                      <span>{t.actionComment}</span>
                      {commentCountLabel !== '' && (
                        <span className="entei-timeline-action-count">
                          {commentCountLabel}
                        </span>
                      )}
                    </button>
                    <button
                      type="button"
                      className="entei-timeline-action"
                      aria-pressed={liked}
                      aria-label={actionLabel(
                        liked ? t.actionUnlike : t.actionLike,
                        likeCountLabel,
                      )}
                      onClick={(event) => {
                        event.stopPropagation();
                        toggleLike(post.id);
                      }}
                    >
                      <Sparkles size={14} aria-hidden="true" />
                      <span>{liked ? t.actionUnlike : t.actionLike}</span>
                      {likeCountLabel !== '' && (
                        <span className="entei-timeline-action-count">
                          {likeCountLabel}
                        </span>
                      )}
                    </button>
                    <button
                      type="button"
                      className="entei-timeline-action"
                      onClick={(event) => {
                        event.stopPropagation();
                        void sharePost(post);
                      }}
                    >
                      <Share2 size={14} aria-hidden="true" />
                      <span>{t.actionShare}</span>
                    </button>
                  </div>
                </li>
              );
            })}
          </ul>

          {/* Infinite scroll: the sentinel is not a post, so it stays outside
              the list (keeps `listitem` counts equal to the rendered posts). */}
          {hasMore ? (
            <div
              className="entei-timeline-sentinel"
              ref={sentinelRef}
              aria-hidden="true"
            />
          ) : (
            <p className="entei-timeline-end">{t.endOfFeed}</p>
          )}
        </>
      )}
    </section>
  );
}
