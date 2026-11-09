/**
 * VideoPlayer — Component Tests (P1.1 + native torrent relay recovery)
 * ---------------------------------------------------------------------------
 * Covers the crossOrigin="anonymous" attribute (ORB avoidance for the
 * loopback relay's cross-origin media fetch), the keepElementOnError
 * overlay behavior (the element survives errors during torrent recovery
 * so the session's explicit src/load retry can drive loadeddata and clear
 * the error), and the legacy standalone error state (element unmounted, as
 * before).
 * --------------------------------------------------------------------------- */

import { describe, it, expect, vi, beforeEach, afterEach } from 'bun:test';
import {
  render,
  fireEvent,
  cleanup,
} from '@testing-library/react';
import type { ComponentProps } from 'react';
import { VideoPlayer } from '@/components/player/VideoPlayer';

type VideoPlayerProps = ComponentProps<typeof VideoPlayer>;

const SRC = 'http://127.0.0.1:41234/stream/session';

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
    // With keepElementOnError the element stays mounted, so torrent recovery's
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

  it('stops the element and drops the src on error (no residual buffered audio)', () => {
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
    // Mock the media-element API so the test pins the exact reset calls
    // (pause / removeAttribute('src') / load) that stop the decoder and
    // any buffered audio from a failed (auto)play.
    const pause = vi.fn();
    const load = vi.fn();
    const removeAttribute = vi.fn();
    video.pause = pause;
    video.load = load;
    video.removeAttribute = removeAttribute;
    fireEvent.error(video);
    expect(pause).toHaveBeenCalledTimes(1);
    expect(removeAttribute).toHaveBeenCalledWith('src');
    expect(load).toHaveBeenCalledTimes(1);
    // The error classification/callback order is unchanged.
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledWith('Network failed');
  });

  it('still resets the element on error while keepElementOnError keeps it mounted', () => {
    const onError = vi.fn();
    const { container } = render(
      <VideoPlayer
        {...makeProps({
          error: null,
          keepElementOnError: true,
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
    const pause = vi.fn();
    const load = vi.fn();
    const removeAttribute = vi.fn();
    video.pause = pause;
    video.load = load;
    video.removeAttribute = removeAttribute;
    fireEvent.error(video);
    // Element survives (bridge recovery) but its playback state is reset.
    expect(container.querySelector('video')).not.toBeNull();
    expect(pause).toHaveBeenCalledTimes(1);
    expect(removeAttribute).toHaveBeenCalledWith('src');
    expect(load).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledWith('Decode failed');
  });

  it('captures the MediaError before load() clears it (classification sees the pre-reset error)', () => {
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
    const pause = vi.fn();
    // Browser semantics: load() resets the element's error state. If the
    // handler read e.currentTarget.error AFTER load(), classification
    // would see null and fall back to the generic label.
    const load = vi.fn(() => {
      Object.defineProperty(video, 'error', { value: null, configurable: true });
    });
    const removeAttribute = vi.fn();
    video.pause = pause;
    video.load = load;
    video.removeAttribute = removeAttribute;
    fireEvent.error(video);
    // The pre-reset MediaError (code 3 → decode) must win despite load()
    // clearing the element's error.
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledWith('Decode failed');
    expect(pause).toHaveBeenCalledTimes(1);
    expect(removeAttribute).toHaveBeenCalledWith('src');
    expect(load).toHaveBeenCalledTimes(1);
  });

  // --- Native mpv mode: the element is a passive shim -------------------
  // libmpv owns the clock (the 200 ms `mpv_get_time` poll) and the
  // transport state. The element's own events describe the shim, not the
  // engine: two clocks writing the same position made the time display
  // jump back and forth.

  it('reports the element position in HTML mode', () => {
    const onTimeUpdate = vi.fn();
    const { container } = render(
      <VideoPlayer {...makeProps({ onTimeUpdate })} />,
    );
    const video = container.querySelector('video')!;
    Object.defineProperty(video, 'currentTime', {
      value: 12.5,
      configurable: true,
    });
    fireEvent.timeUpdate(video);
    expect(onTimeUpdate).toHaveBeenCalledTimes(1);
    expect(onTimeUpdate).toHaveBeenCalledWith(12.5);
  });

  it('never reports the element position in native render mode', () => {
    const onTimeUpdate = vi.fn();
    const { container } = render(
      <VideoPlayer {...makeProps({ onTimeUpdate, nativeRender: true })} />,
    );
    const video = container.querySelector('video')!;
    Object.defineProperty(video, 'currentTime', {
      value: 12.5,
      configurable: true,
    });
    fireEvent.timeUpdate(video);
    expect(onTimeUpdate).not.toHaveBeenCalled();
  });

  it('does not forward play/pause in native render mode (the engine owns the transport state)', () => {
    const onPlay = vi.fn();
    const onPause = vi.fn();
    const { container } = render(
      <VideoPlayer
        {...makeProps({ onPlay, onPause, nativeRender: true })}
      />,
    );
    const video = container.querySelector('video')!;
    fireEvent.play(video);
    fireEvent.pause(video);
    expect(onPlay).not.toHaveBeenCalled();
    expect(onPause).not.toHaveBeenCalled();
  });

  it('forwards play/pause in HTML mode', () => {
    const onPlay = vi.fn();
    const onPause = vi.fn();
    const { container } = render(
      <VideoPlayer {...makeProps({ onPlay, onPause })} />,
    );
    const video = container.querySelector('video')!;
    fireEvent.play(video);
    fireEvent.pause(video);
    expect(onPlay).toHaveBeenCalledTimes(1);
    expect(onPause).toHaveBeenCalledTimes(1);
  });

  it('mutes the shim in native render mode so it never makes sound next to the engine', () => {
    const { container } = render(
      <VideoPlayer {...makeProps({ nativeRender: true })} />,
    );
    expect(container.querySelector('video')?.muted).toBe(true);
  });

  it('keeps the decode error out of the surface in native render mode (the engine paints the picture)', () => {
    const onError = vi.fn();
    const { container } = render(
      <VideoPlayer {...makeProps({ onError, nativeRender: true })} />,
    );
    const video = container.querySelector('video')!;
    Object.defineProperty(video, 'error', {
      value: { code: 3, message: 'DEMUXER_ERROR' },
      configurable: true,
    });
    fireEvent.error(video);
    expect(onError).not.toHaveBeenCalled();
    // The element stays mounted — it is the frame source for mining captures.
    expect(container.querySelector('video')).not.toBeNull();
  });
});
