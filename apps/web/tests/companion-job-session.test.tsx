import '@testing-library/jest-dom/vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useCompanionJobSession } from '../src/features/player/use-companion-job-session';

/** Mirrors PlayerApp's wiring: the video element mounts only when the
 *  job media URL is surfaced (complete gate), and its ref is fed back
 *  into the session hook (attachMediaElement). */
function Harness() {
  const session = useCompanionJobSession();
  return (
    <div>
      <button
        type="button"
        onClick={() => session.beginJobSession({ baseUrl: 'http://127.0.0.1:4322', token: 'tok123', jobId: 'job123', kind: 'youtube' })}
      >
        begin
      </button>
      <button type="button" onClick={() => void session.cancelActiveJob()}>
        cancel
      </button>
      <button type="button" onClick={() => session.setPlayIntent(false)}>
        pauseIntent
      </button>
      <button type="button" onClick={() => session.requestSeek(2)}>
        seek2
      </button>
      <span data-testid="phase">{session.phase}</span>
      <span data-testid="active">{String(session.active)}</span>
      <span data-testid="url">{session.jobMediaUrl ?? 'none'}</span>
      {session.jobMediaUrl && (
        <video data-testid="video" ref={(el) => session.attachMediaElement(el)} />
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
const playable = (available: number, total: number) =>
  json({ state: 'playable', available, total, headReady: false });

function makeFetcher(responses: Array<Response | Promise<Response>> = []) {
  const calls: { url: string; init?: RequestInit }[] = [];
  const queue = [...responses];
  const fetchFn = vi.fn<typeof fetch>((input, init) => {
    calls.push({ url: String(input), init });
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

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('useCompanionJobSession — real YouTube job → bridge integration', () => {
  it('starts no session without an explicit job acceptance; begin → buffering, URL surfaced immediately', async () => {
    const { calls, fetchFn } = makeFetcher([buffering(100, 1000)]);
    vi.stubGlobal('fetch', fetchFn);
    render(<Harness />);

    expect(screen.getByTestId('phase').textContent).toBe('idle');
    expect(screen.getByTestId('url').textContent).toBe('none');
    expect(screen.queryByTestId('video')).toBeNull();
    expect(calls).toHaveLength(0);

    fireEvent.click(screen.getByText('begin'));
    await flush();

    expect(screen.getByTestId('phase').textContent).toBe('buffering');
    expect(screen.getByTestId('active').textContent).toBe('true');
    // URL is surfaced immediately (video mounts right away; native
    // browser loading state is the only visual wait).
    expect(screen.getByTestId('url').textContent).toBe(
      'http://127.0.0.1:4322/v1/media/fixture?token=tok123',
    );
    expect(screen.getByTestId('video')).toBeInTheDocument();
    // The bridge polls the job status.
    expect(calls.some((c) => c.url.includes('/v1/media/status?token='))).toBe(true);
    expect(calls.some((c) => c.url.includes('/v1/media/fixture'))).toBe(false);
  });

  it('complete gate: surfaces the URL, mounts the element, explicit src/load, plays', async () => {
    const { calls, fetchFn } = makeFetcher([buffering(100, 1000), complete(1000)]);
    vi.stubGlobal('fetch', fetchFn);
    render(<Harness />);

    fireEvent.click(screen.getByText('begin'));
    await flush();
    await vi.advanceTimersByTimeAsync(1000);
    await flush();

    expect(screen.getByTestId('phase').textContent).toBe('ready');
    expect(screen.getByTestId('url').textContent).toBe(
      'http://127.0.0.1:4322/v1/media/fixture?token=tok123',
    );

    const video = screen.getByTestId('video') as HTMLVideoElement;
    expect(video.crossOrigin).toBe('anonymous');
    expect(video.src).toBe('http://127.0.0.1:4322/v1/media/fixture?token=tok123');
    const playSpy = vi.fn(() => Promise.resolve());
    video.play = playSpy;
    fireEvent(video, new Event('loadedmetadata'));
    expect(playSpy).toHaveBeenCalledTimes(1);
    fireEvent(video, new Event('playing'));
    expect(screen.getByTestId('phase').textContent).toBe('playing');
    // The URL persists through `playing` (dropping it unmounts the element).
    expect(screen.getByTestId('url').textContent).toBe(
      'http://127.0.0.1:4322/v1/media/fixture?token=tok123',
    );
    expect(screen.getByTestId('video')).toBeInTheDocument();

    const callsAfter = calls.length;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(calls.length).toBe(callsAfter);
  });

  it('preserves latest pending seek, then plays after seeked', async () => {
    const { fetchFn } = makeFetcher([buffering(100, 1000), complete(1000)]);
    vi.stubGlobal('fetch', fetchFn);
    render(<Harness />);

    fireEvent.click(screen.getByText('begin'));
    await flush();
    fireEvent.click(screen.getByText('seek2'));

    await vi.advanceTimersByTimeAsync(1000);
    await flush();

    const video = screen.getByTestId('video') as HTMLVideoElement;
    const playSpy = vi.fn(() => Promise.resolve());
    video.play = playSpy;
    fireEvent(video, new Event('loadedmetadata'));
    expect(video.currentTime).toBe(2);
    expect(playSpy).not.toHaveBeenCalled();
    fireEvent(video, new Event('seeked'));
    expect(playSpy).toHaveBeenCalledTimes(1);
  });

  it('respects play intent: pause intent suppresses auto-play', async () => {
    const { fetchFn } = makeFetcher([buffering(100, 1000), complete(1000)]);
    vi.stubGlobal('fetch', fetchFn);
    render(<Harness />);

    fireEvent.click(screen.getByText('begin'));
    await flush();
    fireEvent.click(screen.getByText('pauseIntent'));

    await vi.advanceTimersByTimeAsync(1000);
    await flush();

    const video = screen.getByTestId('video') as HTMLVideoElement;
    const playSpy = vi.fn(() => Promise.resolve());
    video.play = playSpy;
    fireEvent(video, new Event('loadedmetadata'));
    expect(playSpy).not.toHaveBeenCalled();
  });

  it('401/403 → rePairRequired with no further polls', async () => {
    const { calls, fetchFn } = makeFetcher([json({ error: 'unauthorized' }, 401)]);
    vi.stubGlobal('fetch', fetchFn);
    render(<Harness />);

    fireEvent.click(screen.getByText('begin'));
    await flush();

    expect(screen.getByTestId('phase').textContent).toBe('rePairRequired');
    const callsAfter = calls.length;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(calls.length).toBe(callsAfter);
    // URL is surfaced immediately (video mounts even on auth failure;
    // the bridge detects the failure and transitions to rePairRequired).
    expect(screen.getByTestId('url').textContent).toBe(
      'http://127.0.0.1:4322/v1/media/fixture?token=tok123',
    );
  });

  it('attaches the video element while buffering; initial 503 → playable recovers with explicit src/load', async () => {
    const { calls, fetchFn } = makeFetcher([
      buffering(100, 1000),
      playable(300, 1000), // status re-check after the media error
    ]);
    vi.stubGlobal('fetch', fetchFn);
    render(<Harness />);

    fireEvent.click(screen.getByText('begin'));
    await flush();

    expect(screen.getByTestId('phase').textContent).toBe('buffering');
    const video = screen.getByTestId('video') as HTMLVideoElement;
    expect(video).toBeInTheDocument();

    // The mounted element is attached to the bridge while buffering, so
    // the browser's 503 error (no verified prefix yet) reaches the
    // single error listener.
    fireEvent(video, new Event('error'));
    await flush();

    // The status re-check kept polling alive, saw "playable", and
    // recovered with an explicit src/load reset.
    expect(calls).toHaveLength(2); // initial poll + exactly one re-check
    expect(screen.getByTestId('phase').textContent).toBe('ready');
    expect(video.src).toBe('http://127.0.0.1:4322/v1/media/fixture?token=tok123');
  });

  it('cancelActiveJob POSTs the job-cancel endpoint then ends the session', async () => {
    const { calls, fetchFn } = makeFetcher([
      buffering(100, 1000),
      json({ id: 'job123', state: 'cancelled' }, 200),
    ]);
    vi.stubGlobal('fetch', fetchFn);
    render(<Harness />);

    fireEvent.click(screen.getByText('begin'));
    await flush();
    expect(screen.getByTestId('active').textContent).toBe('true');

    fireEvent.click(screen.getByText('cancel'));
    await flush();

    // The companion job-cancel endpoint is called with the token in the
    // query and never in the body.
    const cancelCall = calls.find((c) => c.url.includes('/v1/source/jobs/job123/cancel'));
    expect(cancelCall).toBeTruthy();
    expect(cancelCall?.init?.method).toBe('POST');
    expect(cancelCall?.url).toContain('token=tok123');
    expect(cancelCall?.url).not.toContain('tok123tok123');

    expect(screen.getByTestId('phase').textContent).toBe('idle');
    expect(screen.getByTestId('active').textContent).toBe('false');
    expect(screen.getByTestId('url').textContent).toBe('none');
    expect(screen.queryByTestId('video')).toBeNull();

    const callsAfter = calls.length;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(calls.length).toBe(callsAfter);
  });

  it('cancel still ends the session when the companion is unreachable', async () => {
    const { calls, fetchFn } = makeFetcher([
      buffering(100, 1000),
      // The cancel fetch rejects (no queued response).
    ]);
    vi.stubGlobal('fetch', fetchFn);
    render(<Harness />);

    fireEvent.click(screen.getByText('begin'));
    await flush();
    fireEvent.click(screen.getByText('cancel'));
    await flush();

    expect(screen.getByTestId('phase').textContent).toBe('idle');
    expect(screen.getByTestId('active').textContent).toBe('false');
    expect(screen.getByTestId('url').textContent).toBe('none');
  });
});
