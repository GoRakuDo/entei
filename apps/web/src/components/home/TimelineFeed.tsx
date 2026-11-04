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
 * Hydration note: the device profile and the "time ago" labels only exist in
 * the browser, so both are gated behind a post-mount effect. That keeps the
 * prerendered HTML free of storage reads and prevents hydration mismatches;
 * the avatar keeps its fixed box so nothing shifts when it fills in.
 * ---------------------------------------------------------------------------
 */

'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { MessageSquare, Send, Share2, Sparkles } from 'lucide-react';
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
  type TimelinePost,
} from '@/features/timeline/timeline-store';

interface LocalAuthor {
  name: string;
  handle: string;
  avatar: string;
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
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

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
    const state = readTimelineState();
    setLocalPosts(state.posts);
    setLikedIds(state.likedIds);
    setNow(Date.now());
  }, []);

  useEffect(() => {
    const handler = (event: Event) => {
      const detail = (event as CustomEvent<LocaleChangeDetail>).detail;
      if (detail?.locale) setLocale(detail.locale);
    };
    window.addEventListener(LOCALE_CHANGE_EVENT, handler);
    return () => window.removeEventListener(LOCALE_CHANGE_EVENT, handler);
  }, []);

  const t = getDictionary(locale).timeline;
  const feed = useMemo(() => mergeTimelinePosts(localPosts), [localPosts]);
  const canPublish = clampTimelineMessage(draft).length > 0;

  const persist = useCallback(
    (posts: TimelinePost[], likes: string[]) => {
      writeTimelineState({
        schemaVersion: 1,
        posts,
        likedIds: likes,
      });
    },
    [],
  );

  const handlePublish = useCallback(
    (event: React.SyntheticEvent<HTMLFormElement>) => {
      event.preventDefault();
      if (author === null) return;
      const post = createTimelinePost(draft, author);
      if (post === null) return;
      const next = [post, ...localPosts];
      setLocalPosts(next);
      persist(next, likedIds);
      setDraft('');
    },
    [author, draft, localPosts, likedIds, persist],
  );

  const toggleLike = useCallback(
    (postId: string) => {
      const next = likedIds.includes(postId)
        ? likedIds.filter((id) => id !== postId)
        : [...likedIds, postId];
      setLikedIds(next);
      persist(localPosts, next);
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

  return (
    <section className="entei-timeline-root" aria-labelledby="entei-timeline-heading">
      <h2 className="entei-sr-only" id="entei-timeline-heading">
        {t.heading}
      </h2>

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

      <ul className="entei-timeline-feed" role="list">
        {feed.map((post) => {
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
    </section>
  );
}
