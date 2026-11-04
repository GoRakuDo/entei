/**
 * Tests for the Home timeline island (docs/FREENET_SOCIAL_TIMELINE.md phase 1).
 * Covers the composer → feed flow, the like toggle, and local persistence.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import TimelineFeed from '@/components/home/TimelineFeed';
import {
  TIMELINE_SEED_POSTS,
  TIMELINE_STORAGE_KEY,
  readTimelineState,
} from '@/features/timeline/timeline-store';

function renderFeed() {
  return render(<TimelineFeed />);
}

beforeEach(() => {
  localStorage.clear();
  document.documentElement.lang = 'id';
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
