/**
 * Desktop (Tauri) direct torrent sessions — media-error recovery.
 * ---------------------------------------------------------------------------
 * The in-process torrent plugin hands the player a loopback relay URL. A
 * browser media element never retries a failed fetch (Chrome stops with error
 * code 4 and stays dead), so one transient relay answer — the `503` window
 * while the torrent was still opening its storage, or an aborted range
 * request — used to freeze playback until the user picked the file again.
 *
 * The session hook now owns a bounded explicit `src` + `load()` reset for the
 * direct path (the same measured recovery the companion bridge uses). These
 * tests pin that contract: one reset per error, bounded retries, budget
 * refilled by a successful load, and no reset once the session ended.
 */
import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'bun:test';
import { useCompanionJobSession } from '../src/features/player/use-companion-job-session';

/** The reset delay the hook uses between an error and the reload. */
const RESET_DELAY_MS = 600;
/** Bounded resets allowed per direct session. */
const RESET_LIMIT = 3;

const DIRECT = {
  torrentId: 'torrent-1',
  videoUrl: 'http://127.0.0.1:45678/stream/abc',
};

/** Mirrors PlayerApp's wiring: the video element mounts once the session
 *  surfaces a media URL, and its ref is fed back into the hook. */
function Harness() {
  const session = useCompanionJobSession();
  return (
    <div>
      <button type="button" onClick={() => session.beginDirectTorrentSession(DIRECT)}>
        begin
      </button>
      <button type="button" onClick={() => session.endJobSession()}>
        end
      </button>
      {session.jobMediaUrl && (
        <video data-testid="video" ref={(el) => session.attachMediaElement(el)} />
      )}
    </div>
  );
}

function startDirectSession(): HTMLVideoElement {
  render(<Harness />);
  fireEvent.click(screen.getByText('begin'));
  return screen.getByTestId('video') as HTMLVideoElement;
}

function fireError(video: HTMLVideoElement): void {
  fireEvent.error(video);
  act(() => {
    vi.advanceTimersByTime(RESET_DELAY_MS);
  });
}

let loadSpy: ReturnType<typeof vi.spyOn>;
let playSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.useFakeTimers();
  // jsdom has no media pipeline; the hook only needs `load()` to be callable
  // so the reset path can be counted.
  loadSpy = vi
    .spyOn(HTMLMediaElement.prototype, 'load')
    .mockImplementation(() => {});
  // `play()` is what resumes playback after a reset; jsdom's own stub only
  // reports "not implemented", so it is replaced by a resolved promise.
  playSpy = vi
    .spyOn(HTMLMediaElement.prototype, 'play')
    .mockImplementation(() => Promise.resolve());
});

afterEach(() => {
  loadSpy.mockRestore();
  playSpy.mockRestore();
  vi.useRealTimers();
});

describe('direct torrent session — media error recovery', () => {
  it('reloads the relay URL once when the media element errors', () => {
    const video = startDirectSession();
    expect(loadSpy).not.toHaveBeenCalled();

    fireError(video);

    expect(loadSpy).toHaveBeenCalledTimes(1);
    // The relay URL stays valid across a reset (same session id), so the
    // element is pointed at the very same stream again.
    expect(video.getAttribute('src')).toBe(DIRECT.videoUrl);
  });

  it('gives up after the bounded reset budget instead of looping forever', () => {
    const video = startDirectSession();

    for (let attempt = 0; attempt < RESET_LIMIT + 2; attempt += 1) {
      fireError(video);
    }

    expect(loadSpy).toHaveBeenCalledTimes(RESET_LIMIT);
  });

  it('refills the reset budget after a successful load', () => {
    const video = startDirectSession();
    for (let attempt = 0; attempt < RESET_LIMIT; attempt += 1) {
      fireError(video);
    }
    expect(loadSpy).toHaveBeenCalledTimes(RESET_LIMIT);

    // `loadeddata` proves the element is healthy again.
    fireEvent.loadedData(video);
    fireError(video);

    expect(loadSpy).toHaveBeenCalledTimes(RESET_LIMIT + 1);
  });

  it('never reloads after the session ended', () => {
    const video = startDirectSession();
    fireEvent.click(screen.getByText('end'));

    fireError(video);

    expect(loadSpy).not.toHaveBeenCalled();
  });

  it('resumes from the last played position instead of 00:00', () => {
    const video = startDirectSession();
    // jsdom's media element keeps `currentTime` at 0; a real one reports the
    // playhead through `timeupdate`, which is the value the hook records.
    let position = 0;
    Object.defineProperty(video, 'currentTime', {
      configurable: true,
      get: () => position,
      set: (value: number) => {
        position = value;
      },
    });

    // Playing at 42.5 s, then the relay hiccups.
    position = 42.5;
    fireEvent.timeUpdate(video);
    fireEvent.playing(video);
    // The player's own error handling rewinds the element before our reset.
    position = 0;
    fireError(video);

    expect(loadSpy).toHaveBeenCalledTimes(1);

    // Metadata arriving is what makes the seek valid again.
    fireEvent.loadedMetadata(video);

    expect(position).toBe(42.5);
    expect(playSpy).toHaveBeenCalledTimes(1);
  });

  it('does not resume playback that the user had paused', () => {
    const video = startDirectSession();
    let position = 0;
    Object.defineProperty(video, 'currentTime', {
      configurable: true,
      get: () => position,
      set: (value: number) => {
        position = value;
      },
    });

    position = 12;
    fireEvent.timeUpdate(video);
    fireEvent.playing(video);
    // The user paused before the error: the position is kept, the intent is not.
    fireEvent.pause(video);
    fireError(video);
    fireEvent.loadedMetadata(video);

    expect(position).toBe(12);
    expect(playSpy).not.toHaveBeenCalled();
  });

  it('releases its media listeners when the player unmounts', () => {
    const view = render(<Harness />);
    fireEvent.click(screen.getByText('begin'));
    const video = screen.getByTestId('video') as HTMLVideoElement;

    view.unmount();
    fireEvent.error(video);
    act(() => {
      vi.advanceTimersByTime(RESET_DELAY_MS);
    });

    // The pending reset timer and the error listener are both gone.
    expect(loadSpy).not.toHaveBeenCalled();
  });
});
