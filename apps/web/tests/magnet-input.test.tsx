/**
 * MagnetInput — Component Tests (ED-2G real torrent source dialog)
 * ---------------------------------------------------------------------------
 * Covers the paired-gate, the required tracker-consent, the create/poll/
 * files/select flow against the mocked companion API, error mapping, the
 * no-storage / no-leak contract, close/unmount stale-callback aborts, and
 * job cancellation — including the serialized-cancel and re-open race
 * sequence (file list → Batal → same-magnet retry) that previously wedged
 * the dialog in an endless "Mengunduh… 0 B / 0 B" spinner. No real torrent
 * or network is involved.
 * --------------------------------------------------------------------------- */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  render,
  screen,
  fireEvent,
  cleanup,
  waitFor,
  act,
} from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { MagnetInput, type TorrentFileInfo } from '@/components/player/MagnetInput';

const baseDict = {
  magnetInputLabel: 'Magnet URI',
  magnetInputPlaceholder: 'magnet:?xt=urn:btih:...',
  magnetInputLabelTitle: 'Open Torrent Stream',
  magnetErrorInvalid: 'Invalid magnet URI.',
  magnetInputSubmit: 'Start download',
  magnetInputUnpairedBody: 'Pair EizouDendenshi first to download a torrent.',
  magnetConsentLabel: 'I understand: torrent trackers and peers can see my IP address while downloading.',
  magnetInputErrorRepair: 'The connection needs re-pairing.',
  magnetInputErrorConflict: 'A download is already active.',
  magnetInputErrorNetwork: 'Could not reach EizouDendenshi.',
  magnetInputErrorGeneric: 'Something went wrong. Try again.',
  magnetInputErrorMetadataTimeout: 'Metadata could not be retrieved.',
  magnetInputSubmitting: 'Starting…',
  magnetCheckMetadata: 'Checking metadata…',
  magnetFilesTitle: 'Select files',
  magnetFilesBody: 'Pick one video and, optionally, one subtitle.',
  magnetVideoKindLabel: 'video',
  magnetSubtitleKindLabel: 'subtitle',
  magnetOtherKindLabel: 'other',
  magnetNoVideoError: 'No selectable video in this torrent.',
  magnetSelectSubmit: 'Select & play',
  magnetCancel: 'Cancel',
  magnetBack: 'Back',
  dialogClose: 'Close',
};

const VALID_URI = 'magnet:?xt=urn:btih:08ada5a7a6183aae1e09d831df6748d566095a10';

function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function makeFetcher(responses: Array<Response | (() => Promise<Response>)>) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const queue = [...responses];
  const fetchMock = vi.fn<typeof fetch>((input, init) => {
    calls.push({ url: String(input), init });
    const next = queue.shift();
    if (!next) return Promise.reject(new TypeError('no queued response'));
    return typeof next === 'function' ? next() : Promise.resolve(next);
  });
  return { fetchMock, calls, queue };
}

const FILES: TorrentFileInfo[] = [
  { id: 'f0', basename: 'movie.mkv', extension: 'mkv', byteSize: 2_000_000, kind: 'video' },
  { id: 'f1', basename: 'movie.ass', extension: 'ass', byteSize: 40_000, kind: 'subtitle' },
  { id: 'f2', basename: 'readme.txt', extension: 'txt', byteSize: 1_000, kind: 'other' },
];

const defaultProps = {
  open: true,
  onOpenChange: vi.fn(),
  isPaired: true,
  token: 'tok123',
  onJobAccepted: vi.fn(),
  dict: baseDict,
};

// Advance fake timers AND flush microtask-driven React updates on an act
// boundary. The dialog's async continuations (cancel settlement, poll ticks)
// resolve in the microtask queue after the interval fires; without the act
// boundary React does not commit those updates before the next assertion.
async function flush(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

async function fillAndConsent() {
  fireEvent.change(screen.getByLabelText('Magnet URI'), { target: { value: VALID_URI } });
  fireEvent.click(screen.getByRole('checkbox'));
}

describe('MagnetInput — pairing gate', () => {
  it('unpaired: pairing-needed notice only; no input/consent/submit, no fetch', () => {
    const fetchMock = vi.fn<typeof fetch>();
    vi.stubGlobal('fetch', fetchMock);
    render(
      <MagnetInput {...defaultProps} isPaired={false} token={null} />,
    );
    expect(screen.getByText(baseDict.magnetInputUnpairedBody)).toBeInTheDocument();
    expect(screen.queryByLabelText('Magnet URI')).not.toBeInTheDocument();
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('paired: input, consent and submit render; submit disabled without consent or a valid magnet', () => {
    render(<MagnetInput {...defaultProps} />);
    expect(screen.getByLabelText('Magnet URI')).toBeInTheDocument();
    const submit = screen.getByRole('button', { name: baseDict.magnetInputSubmit });
    expect(submit).toBeDisabled();
    // Valid magnet but no consent.
    fireEvent.change(screen.getByLabelText('Magnet URI'), { target: { value: VALID_URI } });
    expect(submit).toBeDisabled();
    fireEvent.click(screen.getByRole('checkbox'));
    expect(submit).toBeEnabled();
  });

  it('consent is required: without it the submit sends nothing', () => {
    const { fetchMock } = makeFetcher([jsonResponse({ id: 'job1' }, 201)]);
    vi.stubGlobal('fetch', fetchMock);
    render(<MagnetInput {...defaultProps} />);
    fireEvent.change(screen.getByLabelText('Magnet URI'), { target: { value: VALID_URI } });
    fireEvent.click(screen.getByRole('button', { name: baseDict.magnetInputSubmit }));
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('MagnetInput — create + errors', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('submits the exact payload and endpoint', async () => {
    const { fetchMock, calls } = makeFetcher([jsonResponse({ id: 'job123' }, 201)]);
    vi.stubGlobal('fetch', fetchMock);
    render(<MagnetInput {...defaultProps} />);
    await fillAndConsent();
    fireEvent.click(screen.getByRole('button', { name: baseDict.magnetInputSubmit }));
    await waitFor(() => expect(calls).toHaveLength(1));
    const firstCall = calls[0];
    expect(firstCall?.url).toBe('http://127.0.0.1:4322/v1/source/torrents?token=tok123');
    expect(firstCall?.init?.method).toBe('POST');
    const body = JSON.parse(String(firstCall?.init?.body)) as { magnet?: string };
    expect(body.magnet).toBe(VALID_URI);
    // The magnet must not leak into the DOM.
    expect(screen.queryByText(VALID_URI)).not.toBeInTheDocument();
    // Accepted: dialog moves to the metadata-checking phase.
    await waitFor(() => expect(screen.getByText(baseDict.magnetCheckMetadata)).toBeInTheDocument());
  });

  it.each([
    [400, baseDict.magnetErrorInvalid],
    [401, baseDict.magnetInputErrorRepair],
    [403, baseDict.magnetInputErrorRepair],
    [409, baseDict.magnetInputErrorConflict],
    [500, baseDict.magnetInputErrorGeneric],
  ])('maps HTTP %i to a generic localized label without raw detail', async (status, label) => {
    const { fetchMock } = makeFetcher([jsonResponse({ error: 'raw server detail' }, status)]);
    vi.stubGlobal('fetch', fetchMock);
    render(<MagnetInput {...defaultProps} />);
    await fillAndConsent();
    fireEvent.click(screen.getByRole('button', { name: baseDict.magnetInputSubmit }));
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent(label));
    expect(screen.queryByText(/raw server detail/)).not.toBeInTheDocument();
  });

  it('network failure maps to the companion-unavailable label', async () => {
    const { fetchMock } = makeFetcher([]);
    vi.stubGlobal('fetch', fetchMock);
    render(<MagnetInput {...defaultProps} />);
    await fillAndConsent();
    fireEvent.click(screen.getByRole('button', { name: baseDict.magnetInputSubmit }));
    await waitFor(() =>
      expect(screen.getByRole('alert')).toHaveTextContent(baseDict.magnetInputErrorNetwork),
    );
  });

  it('never writes to any storage API during the flow', async () => {
    const storageSpy = vi
      .spyOn(Storage.prototype, 'setItem')
      .mockImplementation(() => {});
    const { fetchMock } = makeFetcher([
      jsonResponse({ id: 'job123' }, 201),
      jsonResponse({ state: 'downloading', media: { available: 100, total: 1000 } }, 200),
    ]);
    vi.stubGlobal('fetch', fetchMock);
    render(<MagnetInput {...defaultProps} />);
    await fillAndConsent();
    fireEvent.click(screen.getByRole('button', { name: baseDict.magnetInputSubmit }));
    await waitFor(() =>
      expect(screen.getByText(baseDict.magnetCheckMetadata)).toBeInTheDocument(),
    );
    expect(storageSpy).not.toHaveBeenCalled();
    storageSpy.mockRestore();
  });

  it('close clears the magnet and consent; reopen starts clean', async () => {
    const onOpenChange = vi.fn();
    const { rerender } = render(
      <MagnetInput {...defaultProps} onOpenChange={onOpenChange} />,
    );
    await fillAndConsent();
    fireEvent.click(screen.getByRole('button', { name: /close/i }));
    expect(onOpenChange).toHaveBeenCalledWith(false);
    rerender(<MagnetInput {...defaultProps} onOpenChange={onOpenChange} open={false} />);
    rerender(<MagnetInput {...defaultProps} onOpenChange={onOpenChange} open={true} />);
    const input = screen.getByLabelText('Magnet URI') as HTMLTextAreaElement;
    expect(input.value).toBe('');
    expect(screen.getByRole('checkbox').getAttribute('aria-checked')).toBe('false');
  });

  it('cancels the owned torrent job when the dialog closes after acceptance', async () => {
    const { fetchMock, calls } = makeFetcher([jsonResponse({ id: 'jobCancel' }, 201)]);
    vi.stubGlobal('fetch', fetchMock);
    render(<MagnetInput {...defaultProps} />);
    await fillAndConsent();
    fireEvent.click(screen.getByRole('button', { name: baseDict.magnetInputSubmit }));
    await waitFor(() => expect(screen.getByText(baseDict.magnetCheckMetadata)).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: /close/i }));
    await waitFor(() => {
      const cancel = calls.find((c) => c.url.includes('/v1/source/torrents/jobCancel/cancel'));
      expect(cancel).toBeTruthy();
    });
  });

  it('stale acceptance after unmount does not fire the callback', async () => {
    let resolveCreate!: (r: Response) => void;
    const slow = new Promise<Response>((res) => {
      resolveCreate = res;
    });
    const { fetchMock } = makeFetcher([() => slow]);
    vi.stubGlobal('fetch', fetchMock);
    const onJobAccepted = vi.fn();
    const { unmount } = render(
      <MagnetInput {...defaultProps} onJobAccepted={onJobAccepted} />,
    );
    await fillAndConsent();
    fireEvent.click(screen.getByRole('button', { name: baseDict.magnetInputSubmit }));
    unmount();
    resolveCreate(jsonResponse({ id: 'stale' }, 201));
    await Promise.resolve();
    expect(onJobAccepted).not.toHaveBeenCalled();
  });
});

describe('MagnetInput — selection flow', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
  });

  it('metadata → files listed sanitized → user picks one video + subtitle → select POST → accepted', async () => {
    const { fetchMock, calls } = makeFetcher([
      jsonResponse({ id: 'jobSel' }, 201),
      jsonResponse({ state: 'downloading', media: { available: 500, total: 2_000_000 } }, 200),
      jsonResponse({ state: 'buffering', media: { available: 2_000_000, total: 2_000_000 } }, 200),
      jsonResponse({ files: FILES }, 200),
      jsonResponse({ id: 'jobSel', state: 'complete' }, 200),
    ]);
    vi.stubGlobal('fetch', fetchMock);
    const onJobAccepted = vi.fn();
    render(<MagnetInput {...defaultProps} onJobAccepted={onJobAccepted} />);
    await fillAndConsent();
    fireEvent.click(screen.getByRole('button', { name: baseDict.magnetInputSubmit }));
    await flush(0);
    expect(screen.getByText(baseDict.magnetCheckMetadata)).toBeInTheDocument();
    await flush(5000); // poll: downloading
    await flush(5000); // poll: buffering → files fetched

    // Sanitized rows: basename/ext/size/kind; no internal ids as primary UI.
    expect(screen.getByText('movie.mkv')).toBeInTheDocument();
    expect(screen.getByText('movie.ass')).toBeInTheDocument();
    expect(screen.getByText(/video · mkv · 1\.9 MB/)).toBeInTheDocument();
    expect(screen.getByText(/subtitle · ass · 39\.1 KB/)).toBeInTheDocument();
    expect(screen.queryByText('f0')).not.toBeInTheDocument();
    expect(screen.getByRole('radiogroup')).toBeInTheDocument();

    // No auto-selection: submit disabled until the user picks a video.
    const selectBtn = screen.getByRole('button', { name: baseDict.magnetSelectSubmit });
    expect(selectBtn).toBeDisabled();

    // Pick the video + subtitle radios (labels are kind + basename).
    fireEvent.click(screen.getByLabelText(`${baseDict.magnetVideoKindLabel}: movie.mkv`));
    expect(selectBtn).toBeEnabled();
    fireEvent.click(screen.getByLabelText(`${baseDict.magnetSubtitleKindLabel}: movie.ass`));
    fireEvent.click(selectBtn);
    await flush(0);

    const selectCall = calls.find((c) => c.url.includes('/v1/source/torrents/jobSel/select'));
    expect(selectCall).toBeTruthy();
    const selectBody = JSON.parse(String(selectCall?.init?.body)) as {
      videoFileId?: string;
      subtitleFileId?: string;
    };
    expect(selectBody.videoFileId).toBe('f0');
    expect(selectBody.subtitleFileId).toBe('f1');
    await flush(0);
    // The job id travels with the sanitized basename of the selected video.
    expect(onJobAccepted).toHaveBeenCalledWith('jobSel', 'movie.mkv');
  });

  it('no selectable video shows the localized no-video error', async () => {
    const { fetchMock } = makeFetcher([
      jsonResponse({ id: 'jobNoVid' }, 201),
      jsonResponse({ state: 'downloading', media: { available: 10, total: 10 } }, 200),
      jsonResponse({ state: 'buffering', media: { available: 10, total: 10 } }, 200),
      jsonResponse({ files: [FILES[2]] }, 200),
    ]);
    vi.stubGlobal('fetch', fetchMock);
    render(<MagnetInput {...defaultProps} />);
    await fillAndConsent();
    fireEvent.click(screen.getByRole('button', { name: baseDict.magnetInputSubmit }));
    await flush(0);
    await flush(5000);
    await flush(5000);
    expect(screen.getByRole('alert')).toHaveTextContent(baseDict.magnetNoVideoError);
  });

  it('Cancel while checking metadata cancels the job; input returns only after the cancel settles', async () => {
    const { fetchMock, calls } = makeFetcher([
      jsonResponse({ id: 'jobCancel2' }, 201),
      jsonResponse({ id: 'jobCancel2', state: 'cancelled' }, 200),
    ]);
    vi.stubGlobal('fetch', fetchMock);
    render(<MagnetInput {...defaultProps} />);
    await fillAndConsent();
    fireEvent.click(screen.getByRole('button', { name: baseDict.magnetInputSubmit }));
    await flush(0);
    expect(screen.getByText(baseDict.magnetCheckMetadata)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: baseDict.magnetCancel }));
    // The cancel hasn't settled: the form is not actionable.
    expect(screen.queryByLabelText('Magnet URI')).not.toBeInTheDocument();
    await flush(0);
    expect(screen.getByLabelText('Magnet URI')).toBeInTheDocument(); // back to input
    expect(calls.some((c) => c.url.includes('/v1/source/torrents/jobCancel2/cancel'))).toBe(true);
  });
});

describe('MagnetInput — cancel serialization & re-open races (ED-2G) — happy-path retry loop', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
  });

  it('checks metadata with NO byte counts in the label (0 B / 0 B must never appear)', async () => {
    const { fetchMock } = makeFetcher([
      jsonResponse({ id: 'jobMeta' }, 201),
      // A metadata (0/0) poll response arrives while still checking.
      jsonResponse({ state: 'downloading', media: { available: 0, total: 0 } }, 200),
    ]);
    vi.stubGlobal('fetch', fetchMock);
    render(<MagnetInput {...defaultProps} />);
    await fillAndConsent();
    fireEvent.click(screen.getByRole('button', { name: baseDict.magnetInputSubmit }));
    await flush(0);
    await flush(5000);
    expect(screen.getByText(baseDict.magnetCheckMetadata)).toBeInTheDocument();
    // The payload has not started: no byte rendering of any form.
    expect(screen.queryByText(/[0-9.,]+\s*(B|KB|MB)/)).not.toBeInTheDocument();
  });

  it('file list → Batal → same-magnet retry: the first cancel settles before the second create', async () => {
    const { fetchMock, calls } = makeFetcher([
      jsonResponse({ id: 'jobA' }, 201),                                                        // create A
      jsonResponse({ state: 'downloading', media: { available: 0, total: 0 } }, 200),           // poll A
      jsonResponse({ state: 'buffering', media: { available: 0, total: 0 } }, 200),             // poll A → files
      jsonResponse({ files: FILES }, 200),                                                      // files A
      jsonResponse({ id: 'jobA', state: 'cancelled' }, 200),                                    // cancel A ack
      jsonResponse({ id: 'jobB' }, 201),                                                        // create B (retry)
      jsonResponse({ state: 'downloading', media: { available: 0, total: 0 } }, 200),           // poll B
      jsonResponse({ state: 'buffering', media: { available: 0, total: 0 } }, 200),             // poll B → files
      jsonResponse({ files: FILES }, 200),                                                      // files B
    ]);
    vi.stubGlobal('fetch', fetchMock);
    render(<MagnetInput {...defaultProps} />);

    // First attempt: create → metadata → file picker.
    await fillAndConsent();
    fireEvent.click(screen.getByRole('button', { name: baseDict.magnetInputSubmit }));
    await flush(0);
    await flush(5000);
    await flush(5000);
    expect(screen.getByText('movie.mkv')).toBeInTheDocument();

    // Kembali (Back) from the file picker: the dialog must NOT become
    // actionable while the cancel settlement is pending.
    fireEvent.click(screen.getByRole('button', { name: baseDict.magnetBack }));
    expect(screen.queryByLabelText('Magnet URI')).not.toBeInTheDocument();
    await flush(0); // cancel ack settles → input restored
    expect(screen.getByLabelText('Magnet URI')).toBeInTheDocument();

    // Same attempt, same magnet: submit again immediately.
    fireEvent.click(screen.getByRole('button', { name: baseDict.magnetInputSubmit }));
    await flush(0);

    // The first cancel (call) completed before the second create was posted.
    const createPosts = calls
      .map((c, i) => ({ c, i }))
      .filter((x) => x.c.url === 'http://127.0.0.1:4322/v1/source/torrents?token=tok123');
    const cancelA = calls.findIndex((c) => c.url.includes('/jobA/cancel'));
    expect(createPosts).toHaveLength(2);
    expect(createPosts[0]!.i).toBeLessThan(cancelA);
    expect(cancelA).toBeLessThan(createPosts[1]!.i);

    // Metadata phase of the retry: checking label only — never bytes.
    expect(screen.getByText(baseDict.magnetCheckMetadata)).toBeInTheDocument();
    expect(screen.queryByText(/[0-9.,]+\s*(B|KB|MB)/)).not.toBeInTheDocument();

    // The second attempt reaches the file picker normally.
    await flush(5000);
    await flush(5000);
    expect(screen.getByText('movie.mkv')).toBeInTheDocument();
  });

  it('a stale first-attempt poll response can never mutate the second attempt', async () => {
    let resolveStale!: (r: Response) => void;
    const stalePoll = new Promise<Response>((res) => {
      resolveStale = res;
    });
    const { fetchMock } = makeFetcher([
      jsonResponse({ id: 'jobA' }, 201),
      () => stalePoll,                                                                           // poll A — held open
      jsonResponse({ id: 'jobA', state: 'cancelled' }, 200), // cancel A ack
      jsonResponse({ id: 'jobB' }, 201),
      jsonResponse({ state: 'downloading', media: { available: 0, total: 0 } }, 200),
      jsonResponse({ state: 'buffering', media: { available: 0, total: 0 } }, 200),
      jsonResponse({ files: FILES }, 200),
    ]);
    vi.stubGlobal('fetch', fetchMock);
    render(<MagnetInput {...defaultProps} />);

    await fillAndConsent();
    fireEvent.click(screen.getByRole('button', { name: baseDict.magnetInputSubmit }));
    await flush(0);
    await flush(5000); // poll A fires and stays pending

    // Batal while the first poll is in flight; the cancel settles cleanly.
    fireEvent.click(screen.getByRole('button', { name: baseDict.magnetCancel }));
    await flush(0);
    expect(screen.getByLabelText('Magnet URI')).toBeInTheDocument();

    // Retry immediately.
    fireEvent.click(screen.getByRole('button', { name: baseDict.magnetInputSubmit }));
    await flush(0);
    expect(screen.getByText(baseDict.magnetCheckMetadata)).toBeInTheDocument();

    // The stale first-attempt response arrives only now, mid‑second‑attempt.
    resolveStale(jsonResponse({ state: 'buffering', media: { available: 0, total: 0 } }, 200));
    await flush(0);
    // It must not short-circuit the second attempt into selecting/error.
    expect(screen.getByText(baseDict.magnetCheckMetadata)).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();

    // The second attempt proceeds to the file picker normally.
    await flush(5000);
    await flush(5000);
    expect(screen.getByText('movie.mkv')).toBeInTheDocument();
  });

  it('cancel network failure recovers visibly with a localized error', async () => {
    const { fetchMock } = makeFetcher([
      jsonResponse({ id: 'jobNet' }, 201),
      // cancel: network failure (no queued response)
    ]);
    vi.stubGlobal('fetch', fetchMock);
    render(<MagnetInput {...defaultProps} />);
    await fillAndConsent();
    fireEvent.click(screen.getByRole('button', { name: baseDict.magnetInputSubmit }));
    await flush(0);
    fireEvent.click(screen.getByRole('button', { name: baseDict.magnetCancel }));
    await flush(0);
    // Recoverable: the input is back and the failure is visible.
    expect(screen.getByLabelText('Magnet URI')).toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent(baseDict.magnetInputErrorNetwork);
  });

  it('cancel non-OK (500) recovers visibly with a generic localized error', async () => {
    const { fetchMock } = makeFetcher([
      jsonResponse({ id: 'job500' }, 201),
      jsonResponse({ error: 'raw server detail' }, 500),
    ]);
    vi.stubGlobal('fetch', fetchMock);
    render(<MagnetInput {...defaultProps} />);
    await fillAndConsent();
    fireEvent.click(screen.getByRole('button', { name: baseDict.magnetInputSubmit }));
    await flush(0);
    fireEvent.click(screen.getByRole('button', { name: baseDict.magnetCancel }));
    await flush(0);
    expect(screen.getByLabelText('Magnet URI')).toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent(baseDict.magnetInputErrorGeneric);
    expect(screen.queryByText(/raw server detail/)).not.toBeInTheDocument();
  });

  it('cancel 404 (job already freed) settles cleanly without an error', async () => {
    const { fetchMock } = makeFetcher([
      jsonResponse({ id: 'jobGone' }, 201),
      jsonResponse({ error: 'job not found' }, 404),
    ]);
    vi.stubGlobal('fetch', fetchMock);
    render(<MagnetInput {...defaultProps} />);
    await fillAndConsent();
    fireEvent.click(screen.getByRole('button', { name: baseDict.magnetInputSubmit }));
    await flush(0);
    fireEvent.click(screen.getByRole('button', { name: baseDict.magnetCancel }));
    await flush(0);
    expect(screen.getByLabelText('Magnet URI')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('reopening while a cancel is in flight stays non-actionable until the settle resolves', async () => {
    let resolveCancel!: (r: Response) => void;
    const cancelGate = new Promise<Response>((res) => {
      resolveCancel = res;
    });
    const { fetchMock } = makeFetcher([
      jsonResponse({ id: 'jobGate' }, 201),
      () => cancelGate, // cancel held open
    ]);
    vi.stubGlobal('fetch', fetchMock);
    const onOpenChange = vi.fn();
    const { rerender } = render(
      <MagnetInput {...defaultProps} onOpenChange={onOpenChange} />,
    );
    await fillAndConsent();
    fireEvent.click(screen.getByRole('button', { name: baseDict.magnetInputSubmit }));
    await flush(0);
    // B1 starts the cancel; it stays pending.
    fireEvent.click(screen.getByRole('button', { name: baseDict.magnetCancel }));
    // Close the dialog while the cancel is in flight, then reopen.
    fireEvent.click(screen.getByRole('button', { name: /close/i }));
    expect(onOpenChange).toHaveBeenCalledWith(false);
    rerender(<MagnetInput {...defaultProps} onOpenChange={onOpenChange} open={false} />);
    rerender(<MagnetInput {...defaultProps} onOpenChange={onOpenChange} open={true} />);
    await flush(0);
    // The settle has not resolved: no actionable input yet, no new job.
    expect(screen.queryByLabelText('Magnet URI')).not.toBeInTheDocument();
    // The cancel resolves; only then does the fresh input appear.
    resolveCancel(jsonResponse({ id: 'jobGate', state: 'cancelled' }, 200));
    await flush(0);
    expect(screen.getByLabelText('Magnet URI')).toBeInTheDocument();
  });

  it('file picker shows the localized Back label (never Batal) and it releases the owned job', async () => {
    const { fetchMock, calls } = makeFetcher([
      jsonResponse({ id: 'jobBack' }, 201),
      jsonResponse({ state: 'downloading', media: { available: 0, total: 0 } }, 200),
      jsonResponse({ state: 'buffering', media: { available: 0, total: 0 } }, 200),
      jsonResponse({ files: FILES }, 200),
      jsonResponse({ id: 'jobBack', state: 'cancelled' }, 200),
    ]);
    vi.stubGlobal('fetch', fetchMock);
    render(<MagnetInput {...defaultProps} />);
    await fillAndConsent();
    fireEvent.click(screen.getByRole('button', { name: baseDict.magnetInputSubmit }));
    await flush(0);
    await flush(5000);
    await flush(5000);
    // The picker's return action is the localized Back wording — no
    // cancel/Batal label may appear on the selecting screen.
    const backBtn = screen.getByRole('button', { name: baseDict.magnetBack });
    expect(screen.queryByRole('button', { name: baseDict.magnetCancel })).not.toBeInTheDocument();
    // Pressing it runs the SAME awaited cancel settlement (not a phase reset).
    fireEvent.click(backBtn);
    expect(screen.queryByLabelText('Magnet URI')).not.toBeInTheDocument();
    await flush(0);
    expect(screen.getByLabelText('Magnet URI')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(calls.some((c) => c.url.includes('/v1/source/torrents/jobBack/cancel'))).toBe(true);
  });

  it('top-right close from the file picker cancels the owned job and gates the next open', async () => {
    const { fetchMock, calls } = makeFetcher([
      jsonResponse({ id: 'jobCloseSel' }, 201),
      jsonResponse({ state: 'downloading', media: { available: 0, total: 0 } }, 200),
      jsonResponse({ state: 'buffering', media: { available: 0, total: 0 } }, 200),
      jsonResponse({ files: FILES }, 200),
      jsonResponse({ id: 'jobCloseSel', state: 'cancelled' }, 200),
    ]);
    vi.stubGlobal('fetch', fetchMock);
    const onOpenChange = vi.fn();
    const { rerender } = render(
      <MagnetInput {...defaultProps} onOpenChange={onOpenChange} />,
    );
    await fillAndConsent();
    fireEvent.click(screen.getByRole('button', { name: baseDict.magnetInputSubmit }));
    await flush(0);
    await flush(5000);
    await flush(5000);
    expect(screen.getByText('movie.mkv')).toBeInTheDocument();
    // Top-right × from selecting: the owned job is cancelled (awaited) and
    // the dialog closes.
    fireEvent.click(screen.getByRole('button', { name: /close/i }));
    await flush(0);
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(calls.some((c) => c.url.includes('/v1/source/torrents/jobCloseSel/cancel'))).toBe(true);
    // Reopen after the settle: input only, no lingering file picker state.
    rerender(<MagnetInput {...defaultProps} onOpenChange={onOpenChange} open={false} />);
    rerender(<MagnetInput {...defaultProps} onOpenChange={onOpenChange} open={true} />);
    await flush(0);
    expect(screen.getByLabelText('Magnet URI')).toBeInTheDocument();
    expect(screen.queryByText('movie.mkv')).not.toBeInTheDocument();
  });

  it('closing while the create request is in flight: the late 201 is released with an immediate cancel before any retry', async () => {
    let resolveCreate!: (r: Response) => void;
    const createGate = new Promise<Response>((res) => {
      resolveCreate = res;
    });
    let resolveLateCancel!: (r: Response) => void;
    const lateCancelGate = new Promise<Response>((res) => {
      resolveLateCancel = res;
    });
    const { fetchMock, calls } = makeFetcher([
      () => createGate,        // create POST — held open
      () => lateCancelGate,    // stale-job cancel — held open (gates retry)
      jsonResponse({ id: 'freshJob', state: 'queued' }, 201), // retry create
    ]);
    vi.stubGlobal('fetch', fetchMock);
    const onJobAccepted = vi.fn();
    const onOpenChange = vi.fn();
    const { rerender } = render(
      <MagnetInput
        {...defaultProps}
        onJobAccepted={onJobAccepted}
        onOpenChange={onOpenChange}
      />,
    );
    await fillAndConsent();
    fireEvent.click(screen.getByRole('button', { name: baseDict.magnetInputSubmit })); // create pending
    fireEvent.click(screen.getByRole('button', { name: /close/i })); // close while in flight
    await flush(0);
    expect(onOpenChange).toHaveBeenCalledWith(false);
    rerender(
      <MagnetInput
        {...defaultProps}
        onJobAccepted={onJobAccepted}
        onOpenChange={onOpenChange}
        open={false}
      />,
    );
    rerender(
      <MagnetInput
        {...defaultProps}
        onJobAccepted={onJobAccepted}
        onOpenChange={onOpenChange}
        open={true}
      />,
    );
    await flush(0);
    // The companion answers 201 with an opaque id only after the close.
    resolveCreate(jsonResponse({ id: 'orphanedLate', state: 'queued' }, 201));
    await flush(0);
    // The late job is released immediately: a cancel POST for THAT id.
    expect(calls.some((c) => c.url.includes('/v1/source/torrents/orphanedLate/cancel'))).toBe(true);
    // It is never adopted: no status poll, no files fetch, no metadata
    // phase, nothing leaked into the reopened dialog, no acceptance.
    expect(calls.some((c) => c.url.includes('/v1/source/torrents/orphanedLate?'))).toBe(false);
    expect(calls.some((c) => c.url.includes('/files'))).toBe(false);
    expect(onJobAccepted).not.toHaveBeenCalled();
    expect(screen.getByLabelText('Magnet URI')).toBeInTheDocument();
    expect(screen.queryByText(baseDict.magnetCheckMetadata)).not.toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    // While the late cleanup is still settling, a retry create is gated.
    await fillAndConsent();
    fireEvent.click(screen.getByRole('button', { name: baseDict.magnetInputSubmit }));
    await flush(0);
    const createPosts = () =>
      calls.filter((c) => c.url === 'http://127.0.0.1:4322/v1/source/torrents?token=tok123');
    expect(createPosts()).toHaveLength(1);
    // The late cleanup settles; only then may a fresh create run.
    resolveLateCancel(jsonResponse({ id: 'orphanedLate', state: 'cancelled' }, 200));
    await flush(0);
    fireEvent.click(screen.getByRole('button', { name: baseDict.magnetInputSubmit }));
    await flush(0);
    expect(createPosts()).toHaveLength(2);
  });

  it('closing while a status poll is in flight: the late buffering response cannot open the picker', async () => {
    let resolvePoll!: (r: Response) => void;
    const pollGate = new Promise<Response>((res) => {
      resolvePoll = res;
    });
    const { fetchMock, calls } = makeFetcher([
      jsonResponse({ id: 'jobPoll' }, 201),
      () => pollGate, // first status poll — held open
      jsonResponse({ id: 'jobPoll', state: 'cancelled' }, 200), // cancel ack
    ]);
    vi.stubGlobal('fetch', fetchMock);
    const onOpenChange = vi.fn();
    const { rerender } = render(
      <MagnetInput {...defaultProps} onOpenChange={onOpenChange} />,
    );
    await fillAndConsent();
    fireEvent.click(screen.getByRole('button', { name: baseDict.magnetInputSubmit }));
    await flush(0);
    await flush(5000); // poll fires and stays pending
    // Close while the poll is in flight: cancel + settle.
    fireEvent.click(screen.getByRole('button', { name: /close/i }));
    await flush(0);
    expect(calls.some((c) => c.url.includes('/v1/source/torrents/jobPoll/cancel'))).toBe(true);
    rerender(<MagnetInput {...defaultProps} onOpenChange={onOpenChange} open={false} />);
    rerender(<MagnetInput {...defaultProps} onOpenChange={onOpenChange} open={true} />);
    await flush(0);
    expect(screen.getByLabelText('Magnet URI')).toBeInTheDocument();
    // The stale buffering response arrives now, mid-reopened input.
    resolvePoll(jsonResponse({ state: 'buffering', media: { available: 0, total: 0 } }, 200));
    await flush(0);
    // It must NOT resurrect the file picker or trigger a files fetch.
    expect(screen.getByLabelText('Magnet URI')).toBeInTheDocument();
    expect(screen.queryByText(baseDict.magnetFilesTitle)).not.toBeInTheDocument();
    expect(screen.queryByText('movie.mkv')).not.toBeInTheDocument();
    expect(calls.some((c) => c.url.includes('/files'))).toBe(false);
  });

  it('closing while the select request is in flight: a late 200 cannot fire onJobAccepted', async () => {
    let resolveSelect!: (r: Response) => void;
    const selectGate = new Promise<Response>((res) => {
      resolveSelect = res;
    });
    const { fetchMock, calls } = makeFetcher([
      jsonResponse({ id: 'jobSelX' }, 201),
      jsonResponse({ state: 'downloading', media: { available: 0, total: 0 } }, 200),
      jsonResponse({ state: 'buffering', media: { available: 0, total: 0 } }, 200),
      jsonResponse({ files: FILES }, 200),
      () => selectGate, // select POST — held open
      jsonResponse({ id: 'jobSelX', state: 'cancelled' }, 200), // cancel ack
    ]);
    vi.stubGlobal('fetch', fetchMock);
    const onJobAccepted = vi.fn();
    const onOpenChange = vi.fn();
    const { rerender } = render(
      <MagnetInput
        {...defaultProps}
        onJobAccepted={onJobAccepted}
        onOpenChange={onOpenChange}
      />,
    );
    await fillAndConsent();
    fireEvent.click(screen.getByRole('button', { name: baseDict.magnetInputSubmit }));
    await flush(0);
    await flush(5000);
    await flush(5000);
    expect(screen.getByText('movie.mkv')).toBeInTheDocument();
    fireEvent.click(screen.getByLabelText(`${baseDict.magnetVideoKindLabel}: movie.mkv`));
    fireEvent.click(screen.getByRole('button', { name: baseDict.magnetSelectSubmit })); // select pending
    // Close × while the select is in flight: cancel the owned job.
    fireEvent.click(screen.getByRole('button', { name: /close/i }));
    await flush(0);
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(calls.some((c) => c.url.includes('/v1/source/torrents/jobSelX/cancel'))).toBe(true);
    // The stale select success arrives only after the close.
    resolveSelect(jsonResponse({ id: 'jobSelX', state: 'complete' }, 200));
    await flush(0);
    // Late acceptance must never reach the Player / bridge.
    expect(onJobAccepted).not.toHaveBeenCalled();
    rerender(
      <MagnetInput
        {...defaultProps}
        onJobAccepted={onJobAccepted}
        onOpenChange={onOpenChange}
        open={false}
      />,
    );
    rerender(
      <MagnetInput
        {...defaultProps}
        onJobAccepted={onJobAccepted}
        onOpenChange={onOpenChange}
        open={true}
      />,
    );
    await flush(0);
    expect(screen.getByLabelText('Magnet URI')).toBeInTheDocument();
  });
});