import '@testing-library/jest-dom/vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useCompanionJobSession } from '../src/features/player/use-companion-job-session';

/** Mirrors PlayerApp's wiring: the video element mounts only when the
 *  job media URL is surfaced (ready gate: bridge phase = ready/playing),
 *  and its ref is fed back into the session hook (attachMediaElement). */
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
      <span data-testid="title">{session.jobTitle ?? 'none'}</span>
      {session.jobMediaUrl && (
        <video data-testid="video" crossOrigin="anonymous" ref={(el) => session.attachMediaElement(el)} />
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

function makeFetcher(
  statusResponses: Array<Response | Promise<Response>> = [],
  jobResponses: Array<Response | Promise<Response>> = [],
) {
  const calls: { url: string; init?: RequestInit }[] = [];
  const statusQueue = [...statusResponses];
  const jobQueue = [...jobResponses];
  const fetchFn = vi.fn<typeof fetch>((input, init) => {
    const url = String(input);
    calls.push({ url, init });
    if (url.includes('/v1/source/jobs/'))
      return Promise.resolve(jobQueue.shift() ?? new Response('{}', { status: 404 }));
    if (url.includes('/v1/source/torrents/'))
      return Promise.resolve(jobQueue.shift() ?? new Response('{}', { status: 404 }));
    const next = statusQueue.shift();
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
  it('starts no session without an explicit job acceptance; begin → buffering, URL deferred until playable', async () => {
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
    // URL is NOT surfaced during buffering — the companion may have
    // available=0 (no verified piece0), and a premature fetch would block
    // on ServeContent Read until pieces arrive, hitting Chrome's ~30 s
    // video timeout. The URL surfaces only when the bridge reaches `ready`.
    expect(screen.getByTestId('url').textContent).toBe('none');
    expect(screen.queryByTestId('video')).toBeNull();
    // The bridge polls the job status.
    expect(calls.some((c) => c.url.includes('/v1/media/status?token='))).toBe(true);
    expect(calls.some((c) => c.url.includes('/v1/media/fixture'))).toBe(false);
  });

  it('complete gate: surfaces the URL, mounts the element; paused start until the user presses play', async () => {
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
    // ED-2I: Magnet/YouTube start paused — the ready transition must NOT
    // auto-play. The user starts playback by pressing play.
    expect(playSpy).not.toHaveBeenCalled();
    void video.play(); // user pressed play (PlayerControls → el.play())
    fireEvent(video, new Event('play')); // intent flips via the 'play' event
    expect(playSpy).toHaveBeenCalledTimes(1);
    fireEvent(video, new Event('playing'));
    expect(screen.getByTestId('phase').textContent).toBe('playing');
    // The URL persists through `playing` (dropping it unmounts the element).
    expect(screen.getByTestId('url').textContent).toBe(
      'http://127.0.0.1:4322/v1/media/fixture?token=tok123',
    );
    expect(screen.getByTestId('video')).toBeInTheDocument();

    // No further media/status polling passes after the title poll has
    // settled (capped); count only the bridge's own calls.
    const bridgeCallsAfter = calls.filter(
      (c) => !c.url.includes('/v1/source/jobs/'),
    ).length;
    await vi.advanceTimersByTimeAsync(60_000);
    const bridgeCallsNow = calls.filter(
      (c) => !c.url.includes('/v1/source/jobs/'),
    ).length;
    expect(bridgeCallsNow).toBe(bridgeCallsAfter);
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
    // ED-2I: paused start — the seek lands but playback stays paused until
    // the user presses play.
    expect(playSpy).not.toHaveBeenCalled();
    void video.play(); // user pressed play
    fireEvent(video, new Event('play'));
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
    // No further bridge/media polling after rePairRequired reaches steady
    // state (the bounded YouTube title poll is counted separately).
    const bridgeCallsAfter = calls.filter(
      (c) => !c.url.includes('/v1/source/jobs/'),
    ).length;
    await vi.advanceTimersByTimeAsync(60_000);
    const bridgeCallsNow = calls.filter(
      (c) => !c.url.includes('/v1/source/jobs/'),
    ).length;
    expect(bridgeCallsNow).toBe(bridgeCallsAfter);
    // URL is NOT surfaced on rePairRequired — the phase is not 'ready' or
    // 'playing', so the media URL stays null and the video element stays
    // unmounted.
    expect(screen.getByTestId('url').textContent).toBe('none');
  });

  it('video mounts only on ready; src/load + play flows without 503', async () => {
    const { fetchFn } = makeFetcher([
      buffering(0, 1000),
      playable(300, 1000),
    ]);
    vi.stubGlobal('fetch', fetchFn);
    render(<Harness />);

    fireEvent.click(screen.getByText('begin'));
    await flush();

    // During buffering the video element is NOT mounted (URL deferred).
    expect(screen.getByTestId('phase').textContent).toBe('buffering');
    expect(screen.getByTestId('url').textContent).toBe('none');
    expect(screen.queryByTestId('video')).toBeNull();

    // Advance past the poll delay → bridge sees "playable", transitions to
    // "ready" → jobMediaUrl surfaces → video mounts.
    await vi.advanceTimersByTimeAsync(1000);
    await flush();

    expect(screen.getByTestId('phase').textContent).toBe('ready');
    const video = screen.getByTestId('video') as HTMLVideoElement;
    expect(video).toBeInTheDocument();
    expect(video.crossOrigin).toBe('anonymous');
    expect(video.src).toBe('http://127.0.0.1:4322/v1/media/fixture?token=tok123');

    // Bridge's startReadyTransition fired: metadata → seek → play intent.
    const playSpy = vi.fn(() => Promise.resolve());
    video.play = playSpy;
    fireEvent(video, new Event('loadedmetadata'));
    // ED-2I: paused start — no auto-play until the user presses play.
    expect(playSpy).not.toHaveBeenCalled();
    void video.play(); // user pressed play
    fireEvent(video, new Event('play'));
    expect(playSpy).toHaveBeenCalledTimes(1);
    fireEvent(video, new Event('playing'));
    expect(screen.getByTestId('phase').textContent).toBe('playing');
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
    const { fetchFn } = makeFetcher([
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

  it('polls the YouTube job status and surfaces the video title as jobTitle', async () => {
    const { calls, fetchFn } = makeFetcher(
      [buffering(100, 1000)],
      [json({ id: 'job123', state: 'downloading', mode: 'quality', title: 'Sample YouTube Video Title', media: { available: 100, total: 0 } })],
    );
    vi.stubGlobal('fetch', fetchFn);
    render(<Harness />);

    fireEvent.click(screen.getByText('begin'));
    await flush();

    // The job-status fetch is issued (title poll) for YouTube kind.
    expect(
      calls.some((c) => c.url.includes('/v1/source/jobs/job123?token=')),
    ).toBe(true);
    // Title lands after the poll response is processed.
    await vi.advanceTimersByTimeAsync(0);
    await flush();
    expect(screen.getByTestId('title').textContent).toBe(
      'Sample YouTube Video Title',
    );
  });

  it('clears jobTitle when the session ends', async () => {
    const { fetchFn } = makeFetcher(
      [buffering(100, 1000)],
      [json({ id: 'job123', state: 'downloading', title: 'T', media: { available: 100, total: 0 } })],
    );
    vi.stubGlobal('fetch', fetchFn);
    render(<Harness />);

    fireEvent.click(screen.getByText('begin'));
    await flush();
    await vi.advanceTimersByTimeAsync(0);
    await flush();
    expect(screen.getByTestId('title').textContent).toBe('T');

    fireEvent.click(screen.getByText('cancel'));
    await flush();
    expect(screen.getByTestId('title').textContent).toBe('none');
  });
});
