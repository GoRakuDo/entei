/**
 * PlayerControls — native mpv clock ownership.
 * ---------------------------------------------------------------------------
 * While libmpv renders the media, the HTML element is a passive shim and the
 * engine's `externalTime` / `externalDuration` are the only clock. The
 * element's own `timeupdate` must never write the displayed position: it is a
 * second clock, and both writing the same state made the timestamp jump back
 * and forth (the "runaway time" symptom).
 *
 * These tests pin that contract on the control layer:
 *   - HTML mode: the element's timeupdate drives the displayed time.
 *   - Native mode: the element's timeupdate is ignored.
 *   - Native mode: the engine's position drives the displayed time.
 * --------------------------------------------------------------------------- */

import { describe, it, expect, vi, beforeEach, afterEach } from 'bun:test';
import { render, cleanup, fireEvent, act } from '@testing-library/react';
import type { ComponentProps, RefObject } from 'react';
import { PlayerControls } from '@/components/player/PlayerControls';

type ControlsProps = ComponentProps<typeof PlayerControls>;

/** Only the labels the control layer renders are needed here. */
const mockDict = {
  controlsShow: 'Controls',
  playLabel: 'Play',
  pauseLabel: 'Pause',
  volumeLabel: 'Volume',
  speedLabel: 'Speed',
  fullscreenLabel: 'Fullscreen',
  timelineLabel: 'Timeline',
  captionsLabel: 'Captions',
  mineLabel: 'Mine',
  openFileLabel: 'Open file',
} as unknown as ControlsProps['dict'];

function makeVideo(currentTime: number, duration: number): HTMLVideoElement {
  const video = document.createElement('video');
  Object.defineProperty(video, 'currentTime', {
    value: currentTime,
    writable: true,
    configurable: true,
  });
  Object.defineProperty(video, 'duration', {
    value: duration,
    writable: true,
    configurable: true,
  });
  Object.defineProperty(video, 'buffered', {
    value: { length: 0, start: () => 0, end: () => 0 },
    configurable: true,
  });
  return video;
}

function renderControls(
  video: HTMLVideoElement,
  overrides: Partial<ControlsProps> = {},
) {
  const mediaRef = { current: video } as RefObject<HTMLMediaElement | null>;
  const surfaceRef = { current: null } as RefObject<HTMLDivElement | null>;
  const utils = render(
    <PlayerControls
      mediaRef={mediaRef}
      surfaceRef={surfaceRef}
      isPlaying={false}
      isLoading={false}
      error={null}
      hasMedia
      mediaType="video"
      mediaKey="probe"
      dict={mockDict}
      mediaName="probe"
      isSubtitlePanelVisible={false}
      onToggleSubtitlePanel={() => {}}
      captionDisplayMode="visible"
      onCycleCaptionMode={() => {}}
      volume={1}
      onVolumeChange={() => {}}
      playbackRate={1}
      onPlaybackRateChange={() => {}}
      onTogglePlayback={() => {}}
      isTouchDevice={false}
      reducedMotion={false}
      {...overrides}
    />,
  );
  const current = () =>
    utils.container.querySelector('.entei-controls-time-current')?.textContent ??
    '';
  return { ...utils, current };
}

describe('PlayerControls — native mpv clock', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    global.ResizeObserver = vi.fn(function () {
      return { observe: vi.fn(), unobserve: vi.fn(), disconnect: vi.fn() };
    }) as unknown as typeof ResizeObserver;
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('follows the element position in HTML mode', () => {
    const video = makeVideo(0, 100);
    const { current } = renderControls(video);
    expect(current()).toBe('00:00');

    act(() => {
      video.currentTime = 42;
      fireEvent.timeUpdate(video);
    });
    expect(current()).toBe('00:42');
  });

  it('ignores the element position in native mode (the engine owns the clock)', () => {
    const video = makeVideo(0, 100);
    const { current } = renderControls(video, { nativeRender: true });
    expect(current()).toBe('00:00');

    act(() => {
      video.currentTime = 42;
      fireEvent.timeUpdate(video);
    });
    // The shim's clock must never reach the display.
    expect(current()).toBe('00:00');
  });

  it('shows the engine position in native mode', () => {
    const video = makeVideo(0, 100);
    const { current } = renderControls(video, {
      nativeRender: true,
      externalTime: 42,
      externalDuration: 100,
    });
    expect(current()).toBe('00:42');
  });

  it('keeps the engine position when the shim reports another one in native mode', () => {
    const video = makeVideo(0, 100);
    const { current } = renderControls(video, {
      nativeRender: true,
      externalTime: 42,
      externalDuration: 100,
    });

    act(() => {
      video.currentTime = 7;
      fireEvent.timeUpdate(video);
    });
    expect(current()).toBe('00:42');
  });
});
