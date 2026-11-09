/**
 * Native Tauri torrent relay media-error recovery.
 *
 * The relay session owns a bounded src/load retry and restores the last
 * position/play intent after a transient stream error.
 */
import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'bun:test';
import { useTorrentSession } from '../src/features/player/use-torrent-session';

const RESET_DELAY_MS = 600;
const RESET_LIMIT = 3;
const DIRECT = {
  torrentId: 'torrent-1',
  videoUrl: 'http://127.0.0.1:45678/stream/torrent-1',
};

function Harness() {
  const session = useTorrentSession();
  return (
    <div>
      <button type="button" onClick={() => session.beginSession(DIRECT)}>begin</button>
      <button type="button" onClick={() => session.endSession()}>end</button>
      {session.mediaUrl && (
        <video data-testid="video" ref={(element) => session.attachMediaElement(element)} />
      )}
    </div>
  );
}

function startSession(): HTMLVideoElement {
  render(<Harness />);
  fireEvent.click(screen.getByText('begin'));
  return screen.getByTestId('video') as HTMLVideoElement;
}

function fireError(video: HTMLVideoElement): void {
  fireEvent.error(video);
  act(() => vi.advanceTimersByTime(RESET_DELAY_MS));
}

let loadSpy: ReturnType<typeof vi.spyOn>;
let playSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.useFakeTimers();
  loadSpy = vi.spyOn(HTMLMediaElement.prototype, 'load').mockImplementation(() => {});
  playSpy = vi.spyOn(HTMLMediaElement.prototype, 'play').mockImplementation(() => Promise.resolve());
});

afterEach(() => {
  loadSpy.mockRestore();
  playSpy.mockRestore();
  vi.useRealTimers();
});

describe('useTorrentSession relay recovery', () => {
  it('reloads the relay URL after a transient media error', () => {
    const video = startSession();
    fireError(video);
    expect(loadSpy).toHaveBeenCalledTimes(1);
    expect(video.getAttribute('src')).toBe(DIRECT.videoUrl);
  });

  it('bounds retries and replenishes the budget after a successful load', () => {
    const video = startSession();
    for (let i = 0; i < RESET_LIMIT + 1; i += 1) fireError(video);
    expect(loadSpy).toHaveBeenCalledTimes(RESET_LIMIT);
    fireEvent.loadedData(video);
    fireError(video);
    expect(loadSpy).toHaveBeenCalledTimes(RESET_LIMIT + 1);
  });

  it('restores position and playback intent after recovery', () => {
    const video = startSession();
    let position = 0;
    Object.defineProperty(video, 'currentTime', {
      configurable: true,
      get: () => position,
      set: (value: number) => { position = value; },
    });
    position = 42.5;
    fireEvent.timeUpdate(video);
    fireEvent.playing(video);
    position = 0;
    fireError(video);
    fireEvent.loadedMetadata(video);
    expect(position).toBe(42.5);
    expect(playSpy).toHaveBeenCalledTimes(1);
  });

  it('does not resume if playback had been paused and releases listeners at unmount', () => {
    const view = render(<Harness />);
    fireEvent.click(screen.getByText('begin'));
    const video = screen.getByTestId('video') as HTMLVideoElement;
    fireEvent.timeUpdate(video);
    fireEvent.playing(video);
    fireEvent.pause(video);
    fireError(video);
    fireEvent.loadedMetadata(video);
    expect(playSpy).not.toHaveBeenCalled();
    view.unmount();
    fireError(video);
    expect(loadSpy).toHaveBeenCalledTimes(1);
  });
});
