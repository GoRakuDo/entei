/**
 * Tests for the Home timeline store (docs/FREENET_SOCIAL_TIMELINE.md phase 1).
 * Pure logic only: clamping, post creation, handle derivation, feed merge
 * order, relative-time formatting, and the defensive localStorage round trip.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import {
  EMPTY_TIMELINE_STATE,
  TIMELINE_POST_MAX_LENGTH,
  TIMELINE_SEED_POSTS,
  TIMELINE_STORAGE_KEY,
  clampTimelineMessage,
  createTimelinePost,
  deriveHandle,
  formatRelativeTime,
  mergeTimelinePosts,
  readTimelineState,
  writeTimelineState,
} from '@/features/timeline/timeline-store';

const author = { name: 'Kitsune-A9K2', handle: '@kitsune_a9k2', avatar: '/avatars/3.webp' };

beforeEach(() => {
  localStorage.clear();
});

describe('clampTimelineMessage', () => {
  it('trims surrounding whitespace', () => {
    expect(clampTimelineMessage('  hello  ')).toBe('hello');
  });

  it('clamps to the post limit', () => {
    const long = 'あ'.repeat(TIMELINE_POST_MAX_LENGTH + 50);
    expect(clampTimelineMessage(long)).toHaveLength(TIMELINE_POST_MAX_LENGTH);
  });

  it('returns an empty string for whitespace-only drafts', () => {
    expect(clampTimelineMessage('   \n  ')).toBe('');
  });
});

describe('createTimelinePost', () => {
  it('builds a post from the draft and the local author', () => {
    const post = createTimelinePost('  はじめまして！  ', author, 1_700_000_000_000);
    expect(post).not.toBeNull();
    expect(post?.message).toBe('はじめまして！');
    expect(post?.authorName).toBe('Kitsune-A9K2');
    expect(post?.authorHandle).toBe('@kitsune_a9k2');
    expect(post?.avatar).toBe('/avatars/3.webp');
    expect(post?.createdAt).toBe(1_700_000_000_000);
  });

  it('returns null for an empty draft', () => {
    expect(createTimelinePost('   ', author)).toBeNull();
  });

  it('generates unique ids for posts created in the same millisecond', () => {
    const first = createTimelinePost('one', author, 1_700_000_000_000);
    const second = createTimelinePost('two', author, 1_700_000_000_000);
    expect(first?.id).not.toBe(second?.id);
  });
});

describe('deriveHandle', () => {
  it('slugifies the profile name into a lowercase handle', () => {
    expect(deriveHandle('Kitsune-A9K2')).toBe('@kitsune_a9k2');
  });

  it('keeps non-latin letters', () => {
    expect(deriveHandle('キツネ A9')).toBe('@キツネ_a9');
  });

  it('falls back to @entei when the name has no usable characters', () => {
    expect(deriveHandle('   ')).toBe('@entei');
  });
});

describe('mergeTimelinePosts', () => {
  it('returns the seeds when there are no local posts', () => {
    expect(mergeTimelinePosts([])).toHaveLength(TIMELINE_SEED_POSTS.length);
  });

  it('orders local posts before older seeds (newest first)', () => {
    const local = createTimelinePost('brand new', author, Date.now())!;
    const merged = mergeTimelinePosts([local]);
    expect(merged[0]!.id).toBe(local.id);
    expect(merged).toHaveLength(TIMELINE_SEED_POSTS.length + 1);
    for (let index = 1; index < merged.length; index += 1) {
      expect(merged[index - 1]!.createdAt).toBeGreaterThanOrEqual(
        merged[index]!.createdAt,
      );
    }
  });
});

describe('formatRelativeTime', () => {
  const now = 1_700_000_000_000;

  it('uses a "now" label for the current minute', () => {
    expect(formatRelativeTime(now, now, 'id')).not.toHaveLength(0);
  });

  it('formats minutes, hours, and days in Japanese', () => {
    expect(formatRelativeTime(now - 5 * 60_000, now, 'ja')).toContain('分');
    expect(formatRelativeTime(now - 3 * 3_600_000, now, 'ja')).toContain('時間');
    expect(formatRelativeTime(now - 2 * 86_400_000, now, 'ja')).toContain('日');
  });

  it('falls back to the default locale for an invalid locale tag', () => {
    expect(formatRelativeTime(now - 5 * 60_000, now, 'not a locale')).not.toHaveLength(0);
  });
});

describe('timeline persistence', () => {
  it('returns empty state when nothing is stored', () => {
    expect(readTimelineState()).toEqual(EMPTY_TIMELINE_STATE);
  });

  it('round-trips local posts and liked ids', () => {
    const post = createTimelinePost('保存テスト', author)!;
    writeTimelineState({
      schemaVersion: 1,
      posts: [post],
      likedIds: ['seed-1', post.id],
    });
    const restored = readTimelineState();
    expect(restored.posts).toHaveLength(1);
    expect(restored.posts[0]!.message).toBe('保存テスト');
    expect(restored.likedIds).toEqual(['seed-1', post.id]);
  });

  it('ignores malformed JSON', () => {
    localStorage.setItem(TIMELINE_STORAGE_KEY, '{not json');
    expect(readTimelineState()).toEqual(EMPTY_TIMELINE_STATE);
  });

  it('rejects an unknown schema version', () => {
    localStorage.setItem(
      TIMELINE_STORAGE_KEY,
      JSON.stringify({ schemaVersion: 99, posts: [], likedIds: [] }),
    );
    expect(readTimelineState()).toEqual(EMPTY_TIMELINE_STATE);
  });

  it('drops non-string liked ids instead of failing the whole payload', () => {
    const post = createTimelinePost('ok', author)!;
    localStorage.setItem(
      TIMELINE_STORAGE_KEY,
      JSON.stringify({ schemaVersion: 1, posts: [post], likedIds: ['seed-1', 7] }),
    );
    expect(readTimelineState().likedIds).toEqual(['seed-1']);
  });

  it('refuses to persist posts over the character limit', () => {
    const post = createTimelinePost('ok', author)!;
    writeTimelineState({
      schemaVersion: 1,
      posts: [{ ...post, message: 'あ'.repeat(TIMELINE_POST_MAX_LENGTH + 1) }],
      likedIds: [],
    });
    expect(readTimelineState().posts).toHaveLength(0);
  });
});
