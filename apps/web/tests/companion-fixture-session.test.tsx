import '@testing-library/jest-dom/vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CompanionFixtureSessionStatus } from '../src/components/player/CompanionFixtureSessionStatus';
import {
  beginCompanionFixtureSession,
  registerCompanionFixtureEntry,
  resetCompanionFixtureEntryForTests,
} from '../src/features/player/companion-fixture-entry';
import { useCompanionFixtureSession } from '../src/features/player/use-companion-fixture-session';

/** Mirrors PlayerApp's wiring: the video element mounts only when the
 *  fixture media URL is surfaced (complete gate), and its ref is fed back
 *  into the session hook (attachMediaElement). */
function Harness() {
  const session = useCompanionFixtureSession();
  return (
    <div>
      <button type="button" onClick={() => session.beginFixtureSession({ baseUrl: 'http://127.0.0.1:4322', token: 'tok123' })}>
        begin
      </button>
      <button type="button" onClick={() => session.endFixtureSession()}>
        end
      </button>
      <button type="button" onClick={() => session.setPlayIntent(false)}>
        pauseIntent
      </button>
      <button type="button" onClick={() => session.requestSeek(2)}>
        seek2
      </button>
      <span data-testid="phase">{session.phase}</span>
      <span data-testid="active">{String(session.active)}</span>
      <span data-testid="url">{session.fixtureMediaUrl ?? 'none'}</span>
      {session.fixtureMediaUrl && (
        <video
          data-testid="video"
          ref={(el) => session.attachMediaElement(el)}
        />
      )}
    </div>
  );
}

const json = (body: object, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
const buffering = (available: number, total: number, retryAfter?: number) =>
  json({
    state: 'buffering',
    available,
    total,
    headReady: false,
    ...(retryAfter !== undefined ? { retryAfter } : {}),
  });
const complete = (total: number) =>
  json({ state: 'complete', available: total, total, headReady: false });

function makeFetcher(responses: Array<Response | Promise<Response>> = []) {
  const calls: { url: string }[] = [];
  const queue = [...responses];
  const fetchFn = vi.fn<typeof fetch>((input) => {
    calls.push({ url: String(input) });
    const next = queue.shift();
    if (next === undefined) return Promise.reject(new TypeError('no queued response'));
    return Promise.resolve(next);
  });
  return { calls, fetchFn };
}

const flush = async () => {
  await vi.advanceTimersByTimeAsync(0);
  await Promise.resolve();
  await vi.advanceTimersByTimeAsync(0);
};

const MINI_DICT = {
  eizouSessionBuffering: 'Waiting for the file to be ready…',
  eizouSessionProgressLabel: 'Progress',
  eizouSessionError: 'The companion session failed. End it and try again.',
  eizouSessionRePairRequired: 'Re-pair required — the pairing code has changed.',
  eizouSessionEnd: 'End session',
};

beforeEach(() => {
  vi.useFakeTimers();
  resetCompanionFixtureEntryForTests();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('ED-2E companion fixture entry (internal, dev/QA only)', () => {
  it('does nothing unless PlayerApp registered the entry', () => {
    beginCompanionFixtureSession(); // no crash, no session
  });

  it('calls only the registered PlayerApp entry', () => {
    const spy = vi.fn();
    registerCompanionFixtureEntry(spy);
    beginCompanionFixtureSession();
    expect(spy).toHaveBeenCalledTimes(1);
  });
});

describe('useCompanionFixtureSession — fixture integration contract', () => {
  it('pairing token alone starts no source; explicit begin → buffering, no src', async () => {
    const { calls, fetchFn } = makeFetcher([buffering(100, 1000)]);
    vi.stubGlobal('fetch', fetchFn);
    render(<Harness />);

    // No session before explicit begin: phase idle, no URL, no element.
    expect(screen.getByTestId('phase').textContent).toBe('idle');
    expect(screen.getByTestId('url').textContent).toBe('none');
    expect(screen.queryByTestId('video')).toBeNull();
    expect(calls).toHaveLength(0);

    fireEvent.click(screen.getByText('begin'));
    await flush();

    // Buffering: progress polls, but the media URL is never assigned.
    expect(screen.getByTestId('phase').textContent).toBe('buffering');
    expect(screen.getByTestId('active').textContent).toBe('true');
    expect(screen.getByTestId('url').textContent).toBe('none');
    expect(screen.queryByTestId('video')).toBeNull();
    expect(calls.some((c) => c.url.includes('/v1/media/status?token='))).toBe(true);
    expect(calls.some((c) => c.url.includes('/v1/media/fixture'))).toBe(false);
  });

  it('complete gate: surfaces the URL, mounts the element, explicit src/load, plays', async () => {
    const { calls, fetchFn } = makeFetcher([
      buffering(100, 1000),
      complete(1000),
    ]);
    vi.stubGlobal('fetch', fetchFn);
    render(<Harness />);

    fireEvent.click(screen.getByText('begin'));
    await flush(); // buffering

    await vi.advanceTimersByTimeAsync(1000);
    await flush(); // complete → ready

    expect(screen.getByTestId('phase').textContent).toBe('ready');
    expect(screen.getByTestId('url').textContent).toBe(
      'http://127.0.0.1:4322/v1/media/fixture?token=tok123',
    );

    // The element mounts and the controller attaches: src + load.
    const video = screen.getByTestId('video') as HTMLVideoElement;
    // ED-2C contract: the media gate needs a CORS-mode request.
    expect(video.crossOrigin).toBe('anonymous');
    expect(video.src).toBe('http://127.0.0.1:4322/v1/media/fixture?token=tok123');
    const playSpy = vi.fn(() => Promise.resolve());
    video.play = playSpy;
    fireEvent(video, new Event('loadedmetadata'));
    expect(playSpy).toHaveBeenCalledTimes(1);
    fireEvent(video, new Event('playing'));
    expect(screen.getByTestId('phase').textContent).toBe('playing');
    // The media URL must persist through `playing` (dropping it would
    // unmount the element mid-playback — found by headed Chrome QA).
    expect(screen.getByTestId('url').textContent).toBe(
      'http://127.0.0.1:4322/v1/media/fixture?token=tok123',
    );
    expect(screen.getByTestId('video')).toBeInTheDocument();

    // Polling stopped: no further status requests.
    const callsAfterReady = calls.length;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(calls.length).toBe(callsAfterReady);
  });

  it('preserves latest pending seek, then plays after seeked', async () => {
    const { fetchFn } = makeFetcher([buffering(100, 1000), complete(1000)]);
    vi.stubGlobal('fetch', fetchFn);
    render(<Harness />);

    fireEvent.click(screen.getByText('begin'));
    await flush();
    fireEvent.click(screen.getByText('seek2')); // pending seek while buffering
    fireEvent.click(screen.getByText('seek2')); // latest wins (same value here)

    await vi.advanceTimersByTimeAsync(1000);
    await flush();

    const video = screen.getByTestId('video') as HTMLVideoElement;
    const playSpy = vi.fn(() => Promise.resolve());
    video.play = playSpy;
    fireEvent(video, new Event('loadedmetadata'));
    expect(video.currentTime).toBe(2); // pending seek applied
    expect(playSpy).not.toHaveBeenCalled(); // waits for seeked
    fireEvent(video, new Event('seeked'));
    expect(playSpy).toHaveBeenCalledTimes(1);
  });

  it('respects play intent: pause intent suppresses auto-play', async () => {
    const { fetchFn } = makeFetcher([buffering(100, 1000), complete(1000)]);
    vi.stubGlobal('fetch', fetchFn);
    render(<Harness />);

    fireEvent.click(screen.getByText('begin'));
    await flush();
    fireEvent.click(screen.getByText('pauseIntent')); // user paused during buffering

    await vi.advanceTimersByTimeAsync(1000);
    await flush();

    const video = screen.getByTestId('video') as HTMLVideoElement;
    const playSpy = vi.fn(() => Promise.resolve());
    video.play = playSpy;
    fireEvent(video, new Event('loadedmetadata'));
    expect(playSpy).not.toHaveBeenCalled();
  });

  it('401/403 → rePairRequired with no further polls', async () => {
    const { calls, fetchFn } = makeFetcher([
      json({ error: 'unauthorized' }, 401),
    ]);
    vi.stubGlobal('fetch', fetchFn);
    render(<Harness />);

    fireEvent.click(screen.getByText('begin'));
    await flush();

    expect(screen.getByTestId('phase').textContent).toBe('rePairRequired');
    const callsAfter = calls.length;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(calls.length).toBe(callsAfter);
    expect(screen.getByTestId('url').textContent).toBe('none');
  });

  it('end session aborts polling and clears the surfaced URL (media switch/unmount)', async () => {
    const { calls, fetchFn } = makeFetcher([
      buffering(100, 1000),
      complete(1000),
    ]);
    vi.stubGlobal('fetch', fetchFn);
    render(<Harness />);

    fireEvent.click(screen.getByText('begin'));
    await flush();
    await vi.advanceTimersByTimeAsync(1000);
    await flush();
    expect(screen.getByTestId('url').textContent).not.toBe('none');

    fireEvent.click(screen.getByText('end'));
    await flush();
    expect(screen.getByTestId('phase').textContent).toBe('idle');
    expect(screen.getByTestId('active').textContent).toBe('false');
    expect(screen.getByTestId('url').textContent).toBe('none');
    expect(screen.queryByTestId('video')).toBeNull();

    const callsAfter = calls.length;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(calls.length).toBe(callsAfter);
  });
});

describe('CompanionFixtureSessionStatus — session-only UI', () => {
  it('shows buffering with accessible progress and an end button', () => {
    render(
      <CompanionFixtureSessionStatus
        phase="buffering"
        progress={{ available: 100, total: 1000 }}
        reason={null}
        onEndSession={vi.fn()}
        dict={MINI_DICT}
      />,
    );
    const status = screen.getByRole('status');
    expect(status.textContent).toContain('Waiting for the file to be ready…');
    expect(status.textContent).toContain('100 / 1000');
    expect(screen.getByRole('button', { name: 'End session' })).toBeInTheDocument();
  });

  it('shows the re-pair required message without raw details', () => {
    render(
      <CompanionFixtureSessionStatus
        phase="rePairRequired"
        progress={null}
        reason={null}
        onEndSession={vi.fn()}
        dict={MINI_DICT}
      />,
    );
    expect(screen.getByRole('status').textContent).toContain('Re-pair required');
    expect(screen.getByRole('status').textContent).not.toContain('tok123');
  });

  it('renders nothing for idle/ready/playing (local flow untouched)', () => {
    const { rerender } = render(
      <CompanionFixtureSessionStatus
        phase="idle"
        progress={null}
        reason={null}
        onEndSession={vi.fn()}
        dict={MINI_DICT}
      />,
    );
    expect(screen.queryByRole('status')).toBeNull();
    rerender(
      <CompanionFixtureSessionStatus
        phase="playing"
        progress={null}
        reason={null}
        onEndSession={vi.fn()}
        dict={MINI_DICT}
      />,
    );
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('error state shows the generic session error', () => {
    render(
      <CompanionFixtureSessionStatus
        phase="error"
        progress={null}
        reason={null}
        onEndSession={vi.fn()}
        dict={MINI_DICT}
      />,
    );
    expect(screen.getByRole('status').textContent).toContain(
      'The companion session failed. End it and try again.',
    );
  });
});
