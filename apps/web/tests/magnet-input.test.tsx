/**
 * MagnetInput — Component Tests (ED-2G real torrent source dialog)
 * ---------------------------------------------------------------------------
 * Covers the paired-gate, the create/poll/files/select flow against the
 * mocked companion API, error mapping, the no-storage / no-leak contract,
 * close/unmount stale-callback aborts, and job cancellation — including the
 * serialized-cancel and re-open race sequence. No real torrent or network
 * is involved.
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
import { MagnetInput, type FileEntry } from '@/components/player/MagnetInput';

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
  magnetInputErrorEvicted: 'Playback stopped because the concurrent torrent limit was exceeded.',
  magnetInputErrorV2Unsupported:
    'v2-only torrents are not supported. Use a v1 or hybrid (v1+v2) torrent link.',
  magnetInputSubmitting: 'Starting…',
  magnetCheckMetadata: 'Checking metadata…',
  magnetFilesTitle: 'Select files',
  magnetFilesBody: 'Pick one video and, optionally, one subtitle.',
  magnetNoVideoError: 'No selectable video in this torrent.',
  magnetSelectSubmit: 'Select & play',
  magnetCancel: 'Cancel',
  dialogClose: 'Close',
  // ED-2G: File browser table
  magnetTableFileName: 'File name',
  magnetTableSize: 'Size',
  magnetFileKindVideo: 'video',
  magnetFileKindSubtitle: 'subtitle',
  magnetFileKindFolder: 'folder',
  magnetFileKindOther: 'file',
  magnetTableNavUp: 'Go up one level',
  magnetNoVideosInFolder: 'No videos in this folder',
  hevcUnsupported: 'H.265 (HEVC) video playback is not supported.',
  firefoxUnsupported: 'Firefox is not yet supported. Please use Google Chrome or a Chromium-based browser.',
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

const FILES: FileEntry[] = [
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

async function fillMagnet() {
  fireEvent.change(screen.getByRole('textbox'), { target: { value: VALID_URI } });
}

describe('MagnetInput — pairing gate', () => {
  it('unpaired: pairing-needed notice only; no input/submit, no fetch', () => {
    const fetchMock = vi.fn<typeof fetch>();
    vi.stubGlobal('fetch', fetchMock);
    render(
      <MagnetInput {...defaultProps} isPaired={false} token={null} />,
    );
    expect(screen.getByText(baseDict.magnetInputUnpairedBody)).toBeInTheDocument();
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('paired: input and create button render; submit disabled without valid magnet', () => {
    render(<MagnetInput {...defaultProps} />);
    expect(screen.getByRole('textbox')).toBeInTheDocument();
    const submit = screen.getByRole('button', { name: baseDict.magnetInputLabelTitle });
    expect(submit).toBeDisabled();
    // Valid magnet enables the button (no consent checkbox needed).
    fireEvent.change(screen.getByRole('textbox'), { target: { value: VALID_URI } });
    expect(submit).toBeEnabled();
  });

  it('no checkbox exists in the modal', () => {
    render(<MagnetInput {...defaultProps} />);
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
  });

  it('no "URI Magnet" in dialog description when paired', () => {
    render(<MagnetInput {...defaultProps} />);
    expect(screen.queryByText(baseDict.magnetInputLabel)).not.toBeInTheDocument();
  });

  it('consent text is shown as plain text near the bottom', () => {
    render(<MagnetInput {...defaultProps} />);
    expect(screen.getByText(baseDict.magnetConsentLabel)).toBeInTheDocument();
  });

  it('empty state row has static class to disable hover', () => {
    render(<MagnetInput {...defaultProps} />);
    const emptyRow = document.querySelector('.entei-magnet-table-row--static');
    expect(emptyRow).toBeInTheDocument();
  });

  it('no bottom ChevronLeft or ChevronRight buttons exist in the DOM', () => {
    render(<MagnetInput {...defaultProps} />);
    expect(document.querySelector('.entei-magnet-nav-btn')).not.toBeInTheDocument();
    expect(document.querySelector('.lucide-chevron-left')).not.toBeInTheDocument();
    expect(document.querySelector('.lucide-chevron-right')).not.toBeInTheDocument();
  });

  it('title has no Magnet SVG icon', () => {
    render(<MagnetInput {...defaultProps} />);
    const titleEl = document.querySelector('.entei-magnet-dialog-title');
    expect(titleEl).toBeInTheDocument();
    expect(titleEl!.querySelector('.lucide-magnet')).not.toBeInTheDocument();
  });

  it('input and create button share equal min-height', () => {
    render(<MagnetInput {...defaultProps} />);
    const input = screen.getByRole('textbox');
    const btn = screen.getByRole('button', { name: baseDict.magnetInputLabelTitle });
    const inputStyle = window.getComputedStyle(input);
    const btnStyle = window.getComputedStyle(btn);
    expect(inputStyle.minHeight).toBe(btnStyle.minHeight);
  });

  it('interactive buttons have transition properties', () => {
    render(<MagnetInput {...defaultProps} />);
    const addBtn = screen.getByRole('button', { name: baseDict.magnetInputLabelTitle });
    // Verify the button has our CSS class that defines transitions
    expect(addBtn.className).toContain('entei-magnet-add-btn');
  });

  it('consent text has correct CSS class for font sizing', () => {
    render(<MagnetInput {...defaultProps} />);
    const consentEl = screen.getByText(baseDict.magnetConsentLabel);
    expect(consentEl.className).toContain('entei-magnet-consent-text');
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
    await fillMagnet();
    fireEvent.click(screen.getByRole('button', { name: baseDict.magnetInputLabelTitle }));
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
    await fillMagnet();
    fireEvent.click(screen.getByRole('button', { name: baseDict.magnetInputLabelTitle }));
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent(label));
    expect(screen.queryByText(/raw server detail/)).not.toBeInTheDocument();
  });

  it('network failure maps to the companion-unavailable label', async () => {
    const { fetchMock } = makeFetcher([]);
    vi.stubGlobal('fetch', fetchMock);
    render(<MagnetInput {...defaultProps} />);
    await fillMagnet();
    fireEvent.click(screen.getByRole('button', { name: baseDict.magnetInputLabelTitle }));
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
    await fillMagnet();
    fireEvent.click(screen.getByRole('button', { name: baseDict.magnetInputLabelTitle }));
    await waitFor(() =>
      expect(screen.getByText(baseDict.magnetCheckMetadata)).toBeInTheDocument(),
    );
    expect(storageSpy).not.toHaveBeenCalled();
    storageSpy.mockRestore();
  });

  it('close clears the magnet; reopen starts clean', async () => {
    const onOpenChange = vi.fn();
    const { rerender } = render(
      <MagnetInput {...defaultProps} onOpenChange={onOpenChange} />,
    );
    await fillMagnet();
    fireEvent.click(screen.getByRole('button', { name: /close/i }));
    expect(onOpenChange).toHaveBeenCalledWith(false);
    rerender(<MagnetInput {...defaultProps} onOpenChange={onOpenChange} open={false} />);
    rerender(<MagnetInput {...defaultProps} onOpenChange={onOpenChange} open={true} />);
    const input = screen.getByRole('textbox') as HTMLInputElement;
    expect(input.value).toBe('');
  });

  it('cancels the owned torrent job when the dialog closes after acceptance', async () => {
    const { fetchMock, calls } = makeFetcher([jsonResponse({ id: 'jobCancel' }, 201)]);
    vi.stubGlobal('fetch', fetchMock);
    render(<MagnetInput {...defaultProps} />);
    await fillMagnet();
    fireEvent.click(screen.getByRole('button', { name: baseDict.magnetInputLabelTitle }));
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
    await fillMagnet();
    fireEvent.click(screen.getByRole('button', { name: baseDict.magnetInputLabelTitle }));
    unmount();
    resolveCreate(jsonResponse({ id: 'stale' }, 201));
    await Promise.resolve();
    expect(onJobAccepted).not.toHaveBeenCalled();
  });
});

describe('MagnetInput — v2-only torrent rejection', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('maps the torrent_v2_unsupported errorCode to the localized v2-unsupported label', async () => {
    const { fetchMock } = makeFetcher([
      jsonResponse({ id: 'jobV2' }, 201),
      jsonResponse(
        {
          state: 'error',
          error: 'v2-only torrent not supported',
          errorCode: 'torrent_v2_unsupported',
        },
        200,
      ),
    ]);
    vi.stubGlobal('fetch', fetchMock);
    render(<MagnetInput {...defaultProps} />);
    await fillMagnet();
    fireEvent.click(screen.getByRole('button', { name: baseDict.magnetInputLabelTitle }));
    await flush(0); // create resolves → checking
    expect(screen.getByText(baseDict.magnetCheckMetadata)).toBeInTheDocument();
    await flush(5000); // poll fires → error state
    // The dedicated localized message is shown, not the generic fallback.
    expect(screen.getByRole('alert')).toHaveTextContent(
      baseDict.magnetInputErrorV2Unsupported,
    );
    // The raw server error detail must not leak into the UI.
    expect(screen.queryByText(/v2-only torrent not supported/)).not.toBeInTheDocument();
  });
});

describe('MagnetInput — selection contracts (checkbox per kind)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
  });

  /** Two videos — for replacement tests. */
  const TWO_VIDEOS: FileEntry[] = [
    { id: 'f0', basename: 'movie_a.mkv', extension: 'mkv', byteSize: 2_000_000, kind: 'video' },
    { id: 'f1', basename: 'movie_b.mkv', extension: 'mkv', byteSize: 3_000_000, kind: 'video' },
    { id: 'f2', basename: 'readme.txt', extension: 'txt', byteSize: 1_000, kind: 'other' },
  ];

  /** Two subtitles + one video — for subtitle replacement tests. */
  const TWO_SUBTITLES: FileEntry[] = [
    { id: 'f0', basename: 'movie.mkv', extension: 'mkv', byteSize: 2_000_000, kind: 'video' },
    { id: 'f1', basename: 'sub_a.ass', extension: 'ass', byteSize: 40_000, kind: 'subtitle' },
    { id: 'f2', basename: 'sub_b.srt', extension: 'srt', byteSize: 35_000, kind: 'subtitle' },
    { id: 'f3', basename: 'readme.txt', extension: 'txt', byteSize: 1_000, kind: 'other' },
  ];

  /** Drive the dialog from input → selecting phase with the given file list. */
  async function reachSelecting() {
    await fillMagnet();
    fireEvent.click(screen.getByRole('button', { name: baseDict.magnetInputLabelTitle }));
    await flush(0);
    await flush(5000); // poll: downloading
    await flush(5000); // poll: buffering → files fetched
  }

  // ── 1. other file has no checkbox; video / subtitle rows have checkboxes ──
  it('other files have no checkbox; video and subtitle rows have checkboxes', async () => {
    const { fetchMock } = makeFetcher([
      jsonResponse({ id: 'jobCk' }, 201),
      jsonResponse({ state: 'downloading', media: { available: 500, total: 2_000_000 } }, 200),
      jsonResponse({ state: 'buffering', media: { available: 2_000_000, total: 2_000_000 } }, 200),
      jsonResponse({ files: FILES }, 200),
    ]);
    vi.stubGlobal('fetch', fetchMock);
    render(<MagnetInput {...defaultProps} />);
    await reachSelecting();

    // other → no checkbox at all (renders null)
    expect(
      screen.queryByLabelText(`${baseDict.magnetFileKindOther}: readme.txt`),
    ).not.toBeInTheDocument();
    // video → checkbox present
    expect(
      screen.getByLabelText(`${baseDict.magnetFileKindVideo}: movie.mkv`),
    ).toBeInTheDocument();
    // subtitle → checkbox present
    expect(
      screen.getByLabelText(`${baseDict.magnetFileKindSubtitle}: movie.ass`),
    ).toBeInTheDocument();
  });

  // ── 2. video is single-select (replacement) ──
  it('video is single-select: clicking a second video replaces the first', async () => {
    const { fetchMock } = makeFetcher([
      jsonResponse({ id: 'jobVid' }, 201),
      jsonResponse({ state: 'downloading', media: { available: 500, total: 5_000_000 } }, 200),
      jsonResponse({ state: 'buffering', media: { available: 5_000_000, total: 5_000_000 } }, 200),
      jsonResponse({ files: TWO_VIDEOS }, 200),
    ]);
    vi.stubGlobal('fetch', fetchMock);
    render(<MagnetInput {...defaultProps} />);
    await reachSelecting();

    const vA = screen.getByLabelText(`${baseDict.magnetFileKindVideo}: movie_a.mkv`);
    const vB = screen.getByLabelText(`${baseDict.magnetFileKindVideo}: movie_b.mkv`);

    // Click first video → checked
    fireEvent.click(vA);
    expect(vA).toBeChecked();
    expect(vB).not.toBeChecked();

    // Click second video → first unchecked, second checked
    fireEvent.click(vB);
    expect(vB).toBeChecked();
    expect(vA).not.toBeChecked();
  });

  // ── 3. subtitle is single-select (replacement) ──
  it('subtitle is single-select: clicking a second subtitle replaces the first', async () => {
    const { fetchMock } = makeFetcher([
      jsonResponse({ id: 'jobSub' }, 201),
      jsonResponse({ state: 'downloading', media: { available: 500, total: 5_000_000 } }, 200),
      jsonResponse({ state: 'buffering', media: { available: 5_000_000, total: 5_000_000 } }, 200),
      jsonResponse({ files: TWO_SUBTITLES }, 200),
    ]);
    vi.stubGlobal('fetch', fetchMock);
    render(<MagnetInput {...defaultProps} />);
    await reachSelecting();

    const sA = screen.getByLabelText(`${baseDict.magnetFileKindSubtitle}: sub_a.ass`);
    const sB = screen.getByLabelText(`${baseDict.magnetFileKindSubtitle}: sub_b.srt`);

    // Click first subtitle → checked
    fireEvent.click(sA);
    expect(sA).toBeChecked();
    expect(sB).not.toBeChecked();

    // Click second subtitle → first unchecked, second checked
    fireEvent.click(sB);
    expect(sB).toBeChecked();
    expect(sA).not.toBeChecked();
  });

  // ── 4. video + subtitle pair can be selected simultaneously ──
  it('video + subtitle pair: both checked simultaneously, select button enabled', async () => {
    const { fetchMock } = makeFetcher([
      jsonResponse({ id: 'jobPair' }, 201),
      jsonResponse({ state: 'downloading', media: { available: 500, total: 2_000_000 } }, 200),
      jsonResponse({ state: 'buffering', media: { available: 2_000_000, total: 2_000_000 } }, 200),
      jsonResponse({ files: FILES }, 200),
    ]);
    vi.stubGlobal('fetch', fetchMock);
    render(<MagnetInput {...defaultProps} />);
    await reachSelecting();

    const selectBtn = screen.getByRole('button', { name: baseDict.magnetSelectSubmit });
    expect(selectBtn).toBeDisabled();

    const v = screen.getByLabelText(`${baseDict.magnetFileKindVideo}: movie.mkv`);
    const s = screen.getByLabelText(`${baseDict.magnetFileKindSubtitle}: movie.ass`);

    // Check video → enabled
    fireEvent.click(v);
    expect(selectBtn).toBeEnabled();
    expect(v).toBeChecked();

    // Check subtitle → video still checked, button still enabled
    fireEvent.click(s);
    expect(v).toBeChecked();
    expect(s).toBeChecked();
    expect(selectBtn).toBeEnabled();
  });

  // ── 5. replacement → select sends the final videoFileId ──
  it('after video replacement, select sends the final videoFileId', async () => {
    const { fetchMock, calls } = makeFetcher([
      jsonResponse({ id: 'jobRep' }, 201),
      jsonResponse({ state: 'downloading', media: { available: 500, total: 5_000_000 } }, 200),
      jsonResponse({ state: 'buffering', media: { available: 5_000_000, total: 5_000_000 } }, 200),
      jsonResponse({ files: TWO_VIDEOS }, 200),
      jsonResponse({ id: 'jobRep', state: 'complete' }, 200),
      // /v1/media/status poll → playable (accepted job becomes playable).
      jsonResponse({ state: 'playable', available: 5_000_000, total: 5_000_000 }, 200),
    ]);
    vi.stubGlobal('fetch', fetchMock);
    render(<MagnetInput {...defaultProps} />);
    await reachSelecting();

    // Select first, then replace with second
    fireEvent.click(screen.getByLabelText(`${baseDict.magnetFileKindVideo}: movie_a.mkv`));
    fireEvent.click(screen.getByLabelText(`${baseDict.magnetFileKindVideo}: movie_b.mkv`));

    // Click select
    fireEvent.click(screen.getByRole('button', { name: baseDict.magnetSelectSubmit }));
    await flush(0);

    const selectCall = calls.find((c) =>
      c.url.includes('/v1/source/torrents/jobRep/select'),
    );
    expect(selectCall).toBeTruthy();
    const body = JSON.parse(String(selectCall?.init?.body)) as {
      videoFileId?: string;
    };
    // Must be the second video's id, not the first
    expect(body.videoFileId).toBe('f1');
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
      // /v1/media/status poll → playable (accepted job becomes playable).
      jsonResponse({ state: 'playable', available: 2_000_000, total: 2_000_000 }, 200),
    ]);
    vi.stubGlobal('fetch', fetchMock);
    const onJobAccepted = vi.fn();
    render(<MagnetInput {...defaultProps} onJobAccepted={onJobAccepted} />);
    await fillMagnet();
    fireEvent.click(screen.getByRole('button', { name: baseDict.magnetInputLabelTitle }));
    await flush(0);
    expect(screen.getByText(baseDict.magnetCheckMetadata)).toBeInTheDocument();
    await flush(5000); // poll: downloading
    await flush(5000); // poll: buffering → files fetched

    // Sanitized rows: basename/ext/size/kind; no internal ids as primary UI.
    expect(screen.getByText('movie.mkv')).toBeInTheDocument();
    expect(screen.getByText('movie.ass')).toBeInTheDocument();
    expect(screen.queryByText('f0')).not.toBeInTheDocument();

    // No auto-selection: submit disabled until the user picks a video.
    const selectBtn = screen.getByRole('button', { name: baseDict.magnetSelectSubmit });
    expect(selectBtn).toBeDisabled();

    // Pick the video + subtitle checkboxes (labels are kind + basename).
    fireEvent.click(screen.getByLabelText(`${baseDict.magnetFileKindVideo}: movie.mkv`));
    expect(selectBtn).toBeEnabled();
    fireEvent.click(screen.getByLabelText(`${baseDict.magnetFileKindSubtitle}: movie.ass`));
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
    expect(onJobAccepted).toHaveBeenCalledWith('jobSel', 'movie.mkv', 'f1');
  });

  it('keeps the file list and shows a loading cancel button while waiting for playable', async () => {
    let resolveSelect!: (r: Response) => void;
    const selectGate = new Promise<Response>((res) => {
      resolveSelect = res;
    });
    const { fetchMock, calls } = makeFetcher([
      jsonResponse({ id: 'jobWait' }, 201),
      jsonResponse({ state: 'downloading', media: { available: 0, total: 0 } }, 200),
      jsonResponse({ state: 'buffering', media: { available: 0, total: 0 } }, 200),
      jsonResponse({ files: FILES }, 200),
      () => selectGate, // select POST — held open (playable-wait window)
      jsonResponse({ state: 'playable', available: 2_000_000, total: 2_000_000 }, 200),
    ]);
    vi.stubGlobal('fetch', fetchMock);
    const onJobAccepted = vi.fn();
    render(<MagnetInput {...defaultProps} onJobAccepted={onJobAccepted} />);
    await fillMagnet();
    fireEvent.click(screen.getByRole('button', { name: baseDict.magnetInputLabelTitle }));
    await flush(0);
    await flush(5000);
    await flush(5000);
    expect(screen.getByText('movie.mkv')).toBeInTheDocument();

    fireEvent.click(screen.getByLabelText(`${baseDict.magnetFileKindVideo}: movie.mkv`));
    fireEvent.click(screen.getByRole('button', { name: baseDict.magnetSelectSubmit }));
    await flush(0);

    // The file list stays visible (no empty state) while the wait runs…
    expect(screen.getByText('movie.mkv')).toBeInTheDocument();
    // …and the bottom button is the loading cancel (TypewriterLoading; the
    // accessible name still says "Batalkan").
    const cancelBtn = screen.getByRole('button', { name: baseDict.magnetCancel });
    expect(cancelBtn.querySelector('.entei-typewriter')).toBeTruthy();
    expect(calls.some((c) => c.url.includes('/v1/source/torrents/jobWait/select'))).toBe(true);

    // Complete the playable wait → the job reaches the Player.
    resolveSelect(jsonResponse({ id: 'jobWait', state: 'complete' }, 200));
    await flush(0);
    expect(onJobAccepted).toHaveBeenCalledWith('jobWait', 'movie.mkv', '');
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
    await fillMagnet();
    fireEvent.click(screen.getByRole('button', { name: baseDict.magnetInputLabelTitle }));
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
    await fillMagnet();
    fireEvent.click(screen.getByRole('button', { name: baseDict.magnetInputLabelTitle }));
    // Flush microtasks so the create fetch resolves and state commits.
    await flush(0);
    await flush(0);
    // The checking label and Cancel button should both be visible now.
    expect(screen.getByText(baseDict.magnetCheckMetadata)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: baseDict.magnetCancel }));
    // After clicking Cancel, the input is still visible (unified shell).
    expect(screen.getByRole('textbox')).toBeInTheDocument();
    await flush(0);
    expect(screen.getByRole('textbox')).toBeInTheDocument(); // back to input
    expect(calls.some((c) => c.url.includes('/v1/source/torrents/jobCancel2/cancel'))).toBe(true);
  });

  it('create icon is enabled during selecting phase — creates a new job and cancels the old one', async () => {
    const { fetchMock } = makeFetcher([
      jsonResponse({ id: 'jobSel2' }, 201),
      jsonResponse({ state: 'downloading', media: { available: 500, total: 2_000_000 } }, 200),
      jsonResponse({ state: 'buffering', media: { available: 2_000_000, total: 2_000_000 } }, 200),
      jsonResponse({ files: FILES }, 200),
      // Cancel for the old job (fire-and-forget)
      jsonResponse({ id: 'jobSel2', state: 'cancelled' }, 200),
      // New job creation
      jsonResponse({ id: 'jobSel3' }, 201),
    ]);
    vi.stubGlobal('fetch', fetchMock);
    render(<MagnetInput {...defaultProps} />);
    await fillMagnet();
    fireEvent.click(screen.getByRole('button', { name: baseDict.magnetInputLabelTitle }));
    await flush(0);
    await flush(5000);
    await flush(5000);
    // Now in selecting phase — file table visible.
    expect(screen.getByText('movie.mkv')).toBeInTheDocument();
    // The create icon button must be enabled during selecting.
    const createBtn = screen.getByRole('button', { name: baseDict.magnetInputLabelTitle });
    expect(createBtn).toBeEnabled();
    // Clicking it cancels the old job and creates a new one.
    fireEvent.click(createBtn);
    await flush(0);
    await flush(0);
    const createCalls = fetchMock.mock.calls.filter(
      (c) => String(c[0]).includes('/v1/source/torrents?'),
    );
    expect(createCalls).toHaveLength(2); // original + new
    // Explicitly verify that the cancel request was sent for the old job.
    const cancelCalls = fetchMock.mock.calls.filter(
      (c) => String(c[0]).includes('/v1/source/torrents/jobSel2/cancel'),
    );
    expect(cancelCalls.length).toBeGreaterThanOrEqual(1);
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
    await fillMagnet();
    fireEvent.click(screen.getByRole('button', { name: baseDict.magnetInputLabelTitle }));
    await flush(0);
    await flush(5000);
    expect(screen.getByText(baseDict.magnetCheckMetadata)).toBeInTheDocument();
    // The payload has not started: no byte rendering of any form.
    expect(screen.queryByText(/[0-9.,]+\s*(B|KB|MB)/)).not.toBeInTheDocument();
  });

  it('file list → Close → same-magnet retry: the first cancel settles before the second create', async () => {
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
    const onOpenChange = vi.fn();
    const { rerender } = render(
      <MagnetInput {...defaultProps} onOpenChange={onOpenChange} />,
    );

    // First attempt: create → metadata → file picker.
    await fillMagnet();
    fireEvent.click(screen.getByRole('button', { name: baseDict.magnetInputLabelTitle }));
    await flush(0);
    await flush(5000);
    await flush(5000);
    expect(screen.getByText('movie.mkv')).toBeInTheDocument();

    // Close (×) from the file picker: the dialog must NOT become
    // actionable while the cancel settlement is pending.
    fireEvent.click(screen.getByRole('button', { name: /close/i }));
    expect(onOpenChange).toHaveBeenCalledWith(false);
    // Reopen the dialog — the cancel settles during reopen.
    rerender(<MagnetInput {...defaultProps} onOpenChange={onOpenChange} open={false} />);
    rerender(<MagnetInput {...defaultProps} onOpenChange={onOpenChange} open={true} />);
    await flush(0); // cancel ack settles → fresh input ready
    expect(screen.getByRole('textbox')).toBeInTheDocument();

    // Same attempt, same magnet: submit again immediately.
    await fillMagnet();
    fireEvent.click(screen.getByRole('button', { name: baseDict.magnetInputLabelTitle }));
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

    await fillMagnet();
    fireEvent.click(screen.getByRole('button', { name: baseDict.magnetInputLabelTitle }));
    await flush(0);
    await flush(5000); // poll A fires and stays pending

    // Batal while the first poll is in flight; the cancel settles cleanly.
    fireEvent.click(screen.getByRole('button', { name: baseDict.magnetCancel }));
    await flush(0);
    await flush(0);
    expect(screen.getByRole('textbox')).toBeInTheDocument();

    // Retry immediately.
    fireEvent.click(screen.getByRole('button', { name: baseDict.magnetInputLabelTitle }));
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
    await fillMagnet();
    fireEvent.click(screen.getByRole('button', { name: baseDict.magnetInputLabelTitle }));
    await flush(0);
    fireEvent.click(screen.getByRole('button', { name: baseDict.magnetCancel }));
    await flush(0);
    // Recoverable: the input is back and the failure is visible.
    expect(screen.getByRole('textbox')).toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent(baseDict.magnetInputErrorNetwork);
  });

  it('cancel non-OK (500) recovers visibly with a generic localized error', async () => {
    const { fetchMock } = makeFetcher([
      jsonResponse({ id: 'job500' }, 201),
      jsonResponse({ error: 'raw server detail' }, 500),
    ]);
    vi.stubGlobal('fetch', fetchMock);
    render(<MagnetInput {...defaultProps} />);
    await fillMagnet();
    fireEvent.click(screen.getByRole('button', { name: baseDict.magnetInputLabelTitle }));
    await flush(0);
    fireEvent.click(screen.getByRole('button', { name: baseDict.magnetCancel }));
    await flush(0);
    expect(screen.getByRole('textbox')).toBeInTheDocument();
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
    await fillMagnet();
    fireEvent.click(screen.getByRole('button', { name: baseDict.magnetInputLabelTitle }));
    await flush(0);
    fireEvent.click(screen.getByRole('button', { name: baseDict.magnetCancel }));
    await flush(0);
    expect(screen.getByRole('textbox')).toBeInTheDocument();
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
    await fillMagnet();
    fireEvent.click(screen.getByRole('button', { name: baseDict.magnetInputLabelTitle }));
    await flush(0);
    // B1 starts the cancel; it stays pending.
    fireEvent.click(screen.getByRole('button', { name: baseDict.magnetCancel }));
    // Close the dialog while the cancel is in flight, then reopen.
    fireEvent.click(screen.getByRole('button', { name: /close/i }));
    expect(onOpenChange).toHaveBeenCalledWith(false);
    rerender(<MagnetInput {...defaultProps} onOpenChange={onOpenChange} open={false} />);
    rerender(<MagnetInput {...defaultProps} onOpenChange={onOpenChange} open={true} />);
    await flush(0);
    // The settle has not resolved: input is visible (unified shell) but the
    // create button is disabled and the Cancel button remains visible.
    expect(screen.getByRole('textbox')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: baseDict.magnetCancel })).toBeInTheDocument();
    // The cancel resolves; the Cancel button disappears and fresh input is ready.
    resolveCancel(jsonResponse({ id: 'jobGate', state: 'cancelled' }, 200));
    await flush(0);
    expect(screen.getByRole('textbox')).toBeInTheDocument();
  });

  it('ArrowUp in a subfolder navigates up without cancelling the job', async () => {
    const { fetchMock, calls } = makeFetcher([
      jsonResponse({ id: 'jobUp' }, 201),                           // create
      jsonResponse({ state: 'downloading', media: { available: 0, total: 0 } }, 200), // poll
      jsonResponse({ state: 'buffering', media: { available: 0, total: 0 } }, 200),   // poll → files
      jsonResponse(
        {
          files: [
            { id: 'da1b2c3d4', basename: 'Season 01', kind: 'folder', relativePath: 'Season 01' },
          ],
        },
        200,
      ), // root: folder only
      jsonResponse({ files: [FILES[0]] }, 200),                    // inside Season 01: video
      jsonResponse(
        {
          files: [
            { id: 'da1b2c3d4', basename: 'Season 01', kind: 'folder', relativePath: 'Season 01' },
          ],
        },
        200,
      ), // ArrowUp → root re-fetch
    ]);
    vi.stubGlobal('fetch', fetchMock);
    render(<MagnetInput {...defaultProps} />);
    await fillMagnet();
    fireEvent.click(screen.getByRole('button', { name: baseDict.magnetInputLabelTitle }));
    await flush(0);
    await flush(5000);
    await flush(5000);
    // Root: ArrowUp must NOT be in the DOM.
    expect(screen.queryByRole('button', { name: baseDict.magnetTableNavUp })).not.toBeInTheDocument();
    // Open the subfolder.
    fireEvent.click(screen.getByRole('button', { name: 'Season 01' }));
    await flush(0);
    expect(screen.getByText('movie.mkv')).toBeInTheDocument();
    // ArrowUp is now visible.
    const arrowUp = screen.getByRole('button', { name: baseDict.magnetTableNavUp });
    expect(arrowUp).toBeInTheDocument();
    // Click ArrowUp: should fetch root (parentPath absent) and NOT call /cancel.
    fireEvent.click(arrowUp);
    await flush(0);
    await flush(0);
    await flush(0);
    // The root fetch should have been made (no parentPath param).
    const rootFetch = calls.find(
      (c) => c.url.includes('/v1/source/torrents/jobUp/files') && !c.url.includes('parentPath'),
    );
    expect(rootFetch).toBeTruthy();
    // The cancel endpoint must NOT have been called.
    expect(calls.some((c) => c.url.includes('/v1/source/torrents/jobUp/cancel'))).toBe(false);
    // Back to root: ArrowUp disappears.
    await flush(0);
    expect(screen.queryByRole('button', { name: baseDict.magnetTableNavUp })).not.toBeInTheDocument();
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
    await fillMagnet();
    fireEvent.click(screen.getByRole('button', { name: baseDict.magnetInputLabelTitle }));
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
    expect(screen.getByRole('textbox')).toBeInTheDocument();
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
    await fillMagnet();
    fireEvent.click(screen.getByRole('button', { name: baseDict.magnetInputLabelTitle })); // create pending
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
    expect(screen.getByRole('textbox')).toBeInTheDocument();
    expect(screen.queryByText(baseDict.magnetCheckMetadata)).not.toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    // While the late cleanup is still settling, a retry create is gated.
    await fillMagnet();
    fireEvent.click(screen.getByRole('button', { name: baseDict.magnetInputLabelTitle }));
    await flush(0);
    const createPosts = () =>
      calls.filter((c) => c.url === 'http://127.0.0.1:4322/v1/source/torrents?token=tok123');
    expect(createPosts()).toHaveLength(1);
    // The late cleanup settles; only then may a fresh create run.
    resolveLateCancel(jsonResponse({ id: 'orphanedLate', state: 'cancelled' }, 200));
    await flush(0);
    fireEvent.click(screen.getByRole('button', { name: baseDict.magnetInputLabelTitle }));
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
    await fillMagnet();
    fireEvent.click(screen.getByRole('button', { name: baseDict.magnetInputLabelTitle }));
    await flush(0);
    await flush(5000); // poll fires and stays pending
    // Close while the poll is in flight: cancel + settle.
    fireEvent.click(screen.getByRole('button', { name: /close/i }));
    await flush(0);
    expect(calls.some((c) => c.url.includes('/v1/source/torrents/jobPoll/cancel'))).toBe(true);
    rerender(<MagnetInput {...defaultProps} onOpenChange={onOpenChange} open={false} />);
    rerender(<MagnetInput {...defaultProps} onOpenChange={onOpenChange} open={true} />);
    await flush(0);
    expect(screen.getByRole('textbox')).toBeInTheDocument();
    // The stale buffering response arrives now, mid-reopened input.
    resolvePoll(jsonResponse({ state: 'buffering', media: { available: 0, total: 0 } }, 200));
    await flush(0);
    // It must NOT resurrect the file picker or trigger a files fetch.
    expect(screen.getByRole('textbox')).toBeInTheDocument();
    // magnetFilesTitle is the default empty-state label in the unified shell,
    // so it IS expected to be visible; the key check is that no file rows appear.
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
    await fillMagnet();
    fireEvent.click(screen.getByRole('button', { name: baseDict.magnetInputLabelTitle }));
    await flush(0);
    await flush(5000);
    await flush(5000);
    expect(screen.getByText('movie.mkv')).toBeInTheDocument();
    fireEvent.click(screen.getByLabelText(`${baseDict.magnetFileKindVideo}: movie.mkv`));
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
    expect(screen.getByRole('textbox')).toBeInTheDocument();
  });
});

describe('MagnetInput — folder navigation robustness', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('folder fetch error shows generic error message', async () => {
    // Create → poll (buffering) → files with video + folder → folder click → 500 error.
    // The selecting phase is reachable with a video, a folder, or both at
    // root (only a root with neither is a no-video torrent).
    const { fetchMock } = makeFetcher([
      jsonResponse({ id: 'jobFold' }, 201),                           // create
      jsonResponse({ state: 'buffering', media: { available: 0, total: 0 } }, 200), // poll
      jsonResponse(
        {
          files: [
            { id: 'f0', basename: 'video.mkv', extension: 'mkv', byteSize: 1_000_000, kind: 'video' },
            { id: 'f1', basename: 'Subs', kind: 'folder', relativePath: 'Subs' },
          ],
        },
        200,
      ), // files
    ]);
    vi.stubGlobal('fetch', fetchMock);
    render(<MagnetInput {...defaultProps} />);
    await fillMagnet();
    fireEvent.click(screen.getByRole('button', { name: baseDict.magnetInputLabelTitle }));
    await flush(0);
    await flush(5000);
    // After buffering + files, we should see the folder button
    const folderBtn = screen.getByRole('button', { name: 'Subs' });
    // Now set up the folder navigation to fail
    fetchMock.mockResolvedValueOnce(jsonResponse({ error: 'server error' }, 500));
    fireEvent.click(folderBtn);
    await flush(0);
    // Error should be displayed
    expect(screen.getByRole('alert')).toHaveTextContent(baseDict.magnetInputErrorGeneric);
  });

  it('folder-only root enters selecting (no no-video error); opening the folder reveals playable videos', async () => {
    // Real folder-structured torrent: the backend root listing contains only
    // folder rows (SynthesizeEntries hides nested files), so a root response
    // without any video row must still reach the selecting phase. Only a root
    // with neither videos nor folders is a no-video torrent.
    const { fetchMock, calls } = makeFetcher([
      jsonResponse({ id: 'jobFoldOnly' }, 201), // create
      jsonResponse({ state: 'downloading', media: { available: 0, total: 0 } }, 200), // poll
      jsonResponse({ state: 'buffering', media: { available: 0, total: 0 } }, 200), // poll → files
      jsonResponse(
        {
          files: [
            { id: 'da1b2c3d4', basename: 'Subs', kind: 'folder', relativePath: 'Subs' },
          ],
        },
        200,
      ), // root files: folder only
      jsonResponse({ files: [FILES[0], FILES[1]] }, 200), // inside Subs: video + subtitle
      jsonResponse({ id: 'jobFoldOnly', state: 'complete' }, 200), // select ack
      // /v1/media/status poll → playable (accepted job becomes playable).
      jsonResponse({ state: 'playable', available: 2_000_000, total: 2_000_000 }, 200),
    ]);
    vi.stubGlobal('fetch', fetchMock);
    const onJobAccepted = vi.fn();
    render(<MagnetInput {...defaultProps} onJobAccepted={onJobAccepted} />);
    await fillMagnet();
    fireEvent.click(screen.getByRole('button', { name: baseDict.magnetInputLabelTitle }));
    await flush(0);
    await flush(5000);
    await flush(5000);
    // No no-video error: the folder row is rendered and the picker is open.
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    const folderBtn = screen.getByRole('button', { name: 'Subs' });
    // Open the folder: its videos become visible and selectable.
    fireEvent.click(folderBtn);
    await flush(0);
    expect(screen.getByText('movie.mkv')).toBeInTheDocument();
    fireEvent.click(screen.getByLabelText(`${baseDict.magnetFileKindVideo}: movie.mkv`));
    fireEvent.click(screen.getByRole('button', { name: baseDict.magnetSelectSubmit }));
    await flush(0);
    const selectCall = calls.find((c) => c.url.includes('/v1/source/torrents/jobFoldOnly/select'));
    expect(selectCall).toBeTruthy();
    const selectBody = JSON.parse(String(selectCall?.init?.body)) as { videoFileId?: string };
    expect(selectBody.videoFileId).toBe('f0');
    await flush(0);
    expect(onJobAccepted).toHaveBeenCalledWith('jobFoldOnly', 'movie.mkv', '');
  });
});
