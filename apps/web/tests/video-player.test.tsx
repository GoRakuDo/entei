/**
 * VideoPlayer — Component Tests (P1.1 + ED-2H companion buffering)
 * ---------------------------------------------------------------------------
 * Covers the crossOrigin="anonymous" attribute (ORB avoidance for the
 * loopback companion's cross-origin media fetch), the keepElementOnError
 * overlay behavior (the element survives errors during companion buffering
 * so the bridge's explicit src/load recovery can drive loadeddata and clear
 * the error), and the legacy standalone error state (element unmounted, as
 * before).
 * --------------------------------------------------------------------------- */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  render,
  fireEvent,
  cleanup,
} from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import type { ComponentProps } from 'react';
import { VideoPlayer } from '@/components/player/VideoPlayer';

type VideoPlayerProps = ComponentProps<typeof VideoPlayer>;

const SRC = 'http://127.0.0.1:4322/v1/media/fixture?token=abc';

function makeProps(
  overrides: Partial<VideoPlayerProps> = {},
): VideoPlayerProps {
  return {
    src: SRC,
    isLoading: false,
    error: null,
    onTimeUpdate: vi.fn(),
    onPlay: vi.fn(),
    onPause: vi.fn(),
    onLoaded: vi.fn(),
    onError: vi.fn(),
    ...overrides,
  };
}

describe('VideoPlayer', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    cleanup();
  });

  it('renders the video element with the given src', () => {
    const { container } = render(<VideoPlayer {...makeProps()} />);
    const video = container.querySelector('video');
    expect(video).not.toBeNull();
    expect(video?.getAttribute('src')).toBe(SRC);
  });

  it('sets crossOrigin="anonymous" so the source fetch is CORS, not no-cors (ORB avoidance)', () => {
    const { container } = render(<VideoPlayer {...makeProps()} />);
    expect(container.querySelector('video')?.crossOrigin).toBe('anonymous');
    expect(
      container.querySelector('video')?.getAttribute('crossorigin'),
    ).toBe('anonymous');
  });

  it('shows the loading overlay while isLoading and no error', () => {
    const { container } = render(
      <VideoPlayer {...makeProps({ isLoading: true })} />,
    );
    expect(
      container.querySelector('.entei-player-loading-overlay'),
    ).not.toBeNull();
    expect(container.querySelector('.entei-player-error-state')).toBeNull();
  });

  it('replaces the element with the standalone error state by default (legacy behavior)', () => {
    const { container } = render(
      <VideoPlayer {...makeProps({ error: 'Failed to load video' })} />,
    );
    expect(container.querySelector('video')).toBeNull();
    const err = container.querySelector('.entei-player-error-state');
    expect(err).not.toBeNull();
    expect(err?.textContent).toBe('Failed to load video');
    // Standalone: the error state is NOT inside the video wrapper.
    expect(err?.closest('.entei-player-video-wrapper')).toBeNull();
  });

  it('keeps the element mounted and overlays the error when keepElementOnError', () => {
    const { container } = render(
      <VideoPlayer
        {...makeProps({
          error: 'Stream not ready',
          keepElementOnError: true,
        })}
      />,
    );
    // The element must survive the error for the bridge's src/load recovery.
    expect(container.querySelector('video')).not.toBeNull();
    const err = container.querySelector('.entei-player-error-state');
    expect(err).not.toBeNull();
    expect(err?.textContent).toBe('Stream not ready');
    // Overlay: the error state lives INSIDE the video wrapper (absolute
    // overlay covers the kept element).
    expect(err?.closest('.entei-player-video-wrapper')).not.toBeNull();
  });

  it('recovers: clearing the error drops the overlay and keeps the element', () => {
    const { container, rerender } = render(
      <VideoPlayer
        {...makeProps({
          error: 'Stream not ready',
          keepElementOnError: true,
        })}
      />,
    );
    expect(container.querySelector('.entei-player-error-state')).not.toBeNull();
    rerender(
      <VideoPlayer
        {...makeProps({
          error: null,
          keepElementOnError: true,
        })}
      />,
    );
    expect(container.querySelector('.entei-player-error-state')).toBeNull();
    expect(container.querySelector('video')).not.toBeNull();
  });

  it('forwards loadeddata to onLoaded', () => {
    const onLoaded = vi.fn();
    const { container } = render(
      <VideoPlayer {...makeProps({ onLoaded })} />,
    );
    fireEvent.loadedData(container.querySelector('video')!);
    expect(onLoaded).toHaveBeenCalledTimes(1);
  });

  it('still forwards loadeddata while the overlay error is shown — the bridge recovery path clears loadError upstream', () => {
    // With keepElementOnError the element stays mounted, so the bridge's
    // explicit src/load after completion fires loadeddata → onLoaded →
    // handleLoaded (setLoadError(null)) in PlayerApp, dropping the
    // "Aliran belum siap" overlay.
    const onLoaded = vi.fn();
    const { container } = render(
      <VideoPlayer
        {...makeProps({
          error: 'Stream not ready',
          keepElementOnError: true,
          onLoaded,
        })}
      />,
    );
    expect(container.querySelector('video')).not.toBeNull();
    fireEvent.loadedData(container.querySelector('video')!);
    expect(onLoaded).toHaveBeenCalledTimes(1);
  });

  it('classifies a decode error (code 3) to decodeErrorLabel', () => {
    const onError = vi.fn();
    const { container } = render(
      <VideoPlayer
        {...makeProps({
          onError,
          errorLabel: 'Network failed',
          decodeErrorLabel: 'Decode failed',
        })}
      />,
    );
    const video = container.querySelector('video')!;
    Object.defineProperty(video, 'error', {
      value: { code: 3, message: 'DEMUXER_ERROR' },
      configurable: true,
    });
    fireEvent.error(video);
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledWith('Decode failed');
  });

  it('classifies a network error (code 2) to errorLabel', () => {
    const onError = vi.fn();
    const { container } = render(
      <VideoPlayer
        {...makeProps({
          onError,
          errorLabel: 'Network failed',
          decodeErrorLabel: 'Decode failed',
        })}
      />,
    );
    const video = container.querySelector('video')!;
    Object.defineProperty(video, 'error', {
      value: { code: 2, message: 'NETWORK_ERROR' },
      configurable: true,
    });
    fireEvent.error(video);
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledWith('Network failed');
  });
});
