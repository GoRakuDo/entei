/**
 * MagnetInput — Component Tests (ED-2G real torrent source dialog)
 * ---------------------------------------------------------------------------
 * Covers the paired-gate, the required tracker-consent, the create/poll/
 * files/select flow against the mocked companion API, error mapping, the
 * no-storage / no-leak contract, close/unmount stale-callback aborts, and
 * job cancellation. No real torrent or network is involved.
 * --------------------------------------------------------------------------- */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
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
  magnetInputSubmitting: 'Starting…',
  magnetDownloading: 'Downloading…',
  magnetFilesTitle: 'Select files',
  magnetFilesBody: 'Pick one video and, optionally, one subtitle.',
  magnetVideoKindLabel: 'video',
  magnetSubtitleKindLabel: 'subtitle',
  magnetOtherKindLabel: 'other',
  magnetNoVideoError: 'No selectable video in this torrent.',
  magnetSelectSubmit: 'Select & play',
  magnetCancel: 'Cancel',
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
    // Accepted: dialog moves to the downloading phase.
    await waitFor(() => expect(screen.getByText(baseDict.magnetDownloading)).toBeInTheDocument());
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
      expect(screen.getByText(baseDict.magnetDownloading)).toBeInTheDocument(),
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
    await waitFor(() => expect(screen.getByText(baseDict.magnetDownloading)).toBeInTheDocument());
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

  it('downloads → files listed sanitized → user picks one video + subtitle → select POST → accepted', async () => {
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
    await vi.advanceTimersByTimeAsync(0);
    expect(screen.getByText(baseDict.magnetDownloading)).toBeInTheDocument();
    await vi.advanceTimersByTimeAsync(5000); // poll: downloading
    await vi.advanceTimersByTimeAsync(5000); // poll: buffering → files fetched

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
    await vi.advanceTimersByTimeAsync(0);

    const selectCall = calls.find((c) => c.url.includes('/v1/source/torrents/jobSel/select'));
    expect(selectCall).toBeTruthy();
    const selectBody = JSON.parse(String(selectCall?.init?.body)) as {
      videoFileId?: string;
      subtitleFileId?: string;
    };
    expect(selectBody.videoFileId).toBe('f0');
    expect(selectBody.subtitleFileId).toBe('f1');
    await vi.advanceTimersByTimeAsync(0);
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
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(5000);
    await vi.advanceTimersByTimeAsync(5000);
    await vi.advanceTimersByTimeAsync(0);
    expect(screen.getByRole('alert')).toHaveTextContent(baseDict.magnetNoVideoError);
  });

  it('Cancel during downloading cancels the job and returns to the input phase', async () => {
    const { fetchMock, calls } = makeFetcher([
      jsonResponse({ id: 'jobCancel2' }, 201),
    ]);
    vi.stubGlobal('fetch', fetchMock);
    render(<MagnetInput {...defaultProps} />);
    await fillAndConsent();
    fireEvent.click(screen.getByRole('button', { name: baseDict.magnetInputSubmit }));
    await vi.advanceTimersByTimeAsync(0);
    expect(screen.getByText(baseDict.magnetDownloading)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: baseDict.magnetCancel }));
    await vi.advanceTimersByTimeAsync(0);
    expect(calls.some((c) => c.url.includes('/v1/source/torrents/jobCancel2/cancel'))).toBe(true);
    expect(screen.getByLabelText('Magnet URI')).toBeInTheDocument(); // back to input
  });
});
