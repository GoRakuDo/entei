/**
 * YouTubeInput — ED-2F real YouTube URL source dialog tests.
 * ---------------------------------------------------------------------------
 * Paired: a URL text input submits to the companion job endpoint; all HTTP
 * error classes map to generic localized messages; the URL and token are
 * page-memory only (no storage, no DOM/log leakage) and are cleared on
 * close/unmount. Unpaired: pairing-needed notice only, no job create.
 * --------------------------------------------------------------------------- */

import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { YouTubeInput, type YouTubeInputDict } from '@/components/player/YouTubeInput';
import { YT_MODE_KEY } from '@/features/player/yt-download-mode';

const baseDict: YouTubeInputDict = {
  youtubeInputLabel: 'YouTube URL',
  youtubeInputTitle: 'YouTube streaming',
  youtubeInputPlaceholder: 'https://www.youtube.com/watch?v=…',
  youtubeInputSubmit: 'Start download',
  youtubeInputErrorInvalid: 'Invalid YouTube URL.',
  youtubeInputErrorRepair: 'The connection needs re-pairing. Open Setup and connect again.',
  youtubeInputErrorConflict: 'A download is already active. Cancel the previous download first.',
  youtubeInputErrorNetwork: 'Could not reach EizouDendenshi. Make sure the companion app is running.',
  youtubeInputErrorGeneric: 'Something went wrong. Try again.',
  youtubeInputSubmitting: 'Starting…',
  dialogClose: 'Close',
  firefoxUnsupported: 'Firefox is not yet supported.',
};

const VALID_URL = 'https://www.youtube.com/watch?v=abcdefghijk';
const TOKEN = 'tok123';

function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

describe('YouTubeInput — paired flow', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  const defaultProps = {
    open: true,
    onOpenChange: vi.fn(),
    isPaired: true,
    token: TOKEN,
    onJobAccepted: vi.fn(),
    cancelActiveJob: vi.fn(),
    dict: baseDict,
  };

  it('renders the URL input and submit when paired', () => {
    render(<YouTubeInput {...defaultProps} />);
    expect(screen.getByRole('textbox', { name: baseDict.youtubeInputLabel })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: baseDict.youtubeInputSubmit })).toBeInTheDocument();
  });

  it('submits the exact payload to the job endpoint with the token in the query', async () => {
    const fetchMock = vi.fn<typeof fetch>((input) => {
      const url = String(input);
      // The playable wait polls /v1/media/status after the job is created.
      if (url.includes('/v1/media/status')) {
        return Promise.resolve(
          jsonResponse({ state: 'playable', available: 0, total: 0 }, 200),
        );
      }
      return Promise.resolve(jsonResponse({ id: 'job123' }, 201));
    });
    vi.stubGlobal('fetch', fetchMock);
    const onJobAccepted = vi.fn();
    const onOpenChange = vi.fn();
    render(
      <YouTubeInput {...defaultProps} onJobAccepted={onJobAccepted} onOpenChange={onOpenChange} />,
    );
    fireEvent.change(screen.getByRole('textbox'), { target: { value: VALID_URL } });
    fireEvent.click(screen.getByRole('button', { name: baseDict.youtubeInputSubmit }));

    await waitFor(() => expect(onJobAccepted).toHaveBeenCalledWith('job123'));
    const firstCall = fetchMock.mock.calls[0];
    if (!firstCall) throw new Error('no fetch call');
    const [url, init] = firstCall;
    expect(String(url)).toBe(`http://127.0.0.1:4322/v1/source/jobs?token=${TOKEN}`);
    expect(init?.method).toBe('POST');
    // The DL mode is included from the EizouDen settings; default speed.
    expect(JSON.parse(String(init?.body))).toEqual({ url: VALID_URL, mode: 'speed' });
    // The token must never appear in the body.
    expect(String(init?.body)).not.toContain(TOKEN);
    // The parent closes the dialog on acceptance (PlayerApp wiring).
    expect(onJobAccepted).toHaveBeenCalledTimes(1);
  });

  it('sends the persisted quality mode when set in the EizouDen settings', async () => {
    localStorage.setItem(YT_MODE_KEY, '"quality"');
    const fetchMock = vi.fn<typeof fetch>((input) => {
      const url = String(input);
      if (url.includes('/v1/media/status')) {
        return Promise.resolve(
          jsonResponse({ state: 'playable', available: 0, total: 0 }, 200),
        );
      }
      return Promise.resolve(jsonResponse({ id: 'jobX' }, 201));
    });
    vi.stubGlobal('fetch', fetchMock);
    const onJobAccepted = vi.fn();
    render(
      <YouTubeInput {...defaultProps} onJobAccepted={onJobAccepted} />,
    );
    fireEvent.change(screen.getByRole('textbox'), { target: { value: VALID_URL } });
    fireEvent.click(screen.getByRole('button', { name: baseDict.youtubeInputSubmit }));

    await waitFor(() => expect(onJobAccepted).toHaveBeenCalledWith('jobX'));
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toBe(`http://127.0.0.1:4322/v1/source/jobs?token=${TOKEN}`);
    expect(JSON.parse(String(init?.body))).toEqual({ url: VALID_URL, mode: 'quality' });
  });

  it('rejects clearly-invalid URLs locally without a network call', async () => {
    const fetchMock = vi.fn<typeof fetch>();
    vi.stubGlobal('fetch', fetchMock);
    render(<YouTubeInput {...defaultProps} />);
    for (const bad of ['not a url', 'http://www.youtube.com/watch?v=abcdefghijk', 'https://google.com/x']) {
      fireEvent.change(screen.getByRole('textbox'), { target: { value: bad } });
      fireEvent.click(screen.getByRole('button', { name: baseDict.youtubeInputSubmit }));
      expect(await screen.findByRole('alert')).toHaveTextContent(baseDict.youtubeInputErrorInvalid);
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each<[number, keyof YouTubeInputDict]>([
    [400, 'youtubeInputErrorInvalid'],
    [401, 'youtubeInputErrorRepair'],
    [403, 'youtubeInputErrorRepair'],
    [409, 'youtubeInputErrorConflict'],
    [500, 'youtubeInputErrorGeneric'],
  ])('maps HTTP %s to the localized %s error, with no raw details', async (status, key) => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse({ error: 'raw server detail' }, status),
    );
    vi.stubGlobal('fetch', fetchMock);
    render(<YouTubeInput {...defaultProps} />);
    fireEvent.change(screen.getByRole('textbox'), { target: { value: VALID_URL } });
    fireEvent.click(screen.getByRole('button', { name: baseDict.youtubeInputSubmit }));
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(baseDict[key]);
    // Raw server detail and the URL must never surface in the UI.
    expect(alert.textContent).not.toContain('raw server detail');
    expect(alert.textContent).not.toContain(VALID_URL);
    expect(screen.queryByText(VALID_URL)).not.toBeInTheDocument();
  });

  it('maps a network failure to the generic companion-unavailable error', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockRejectedValue(new TypeError('Failed to fetch'));
    vi.stubGlobal('fetch', fetchMock);
    render(<YouTubeInput {...defaultProps} />);
    fireEvent.change(screen.getByRole('textbox'), { target: { value: VALID_URL } });
    fireEvent.click(screen.getByRole('button', { name: baseDict.youtubeInputSubmit }));
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(baseDict.youtubeInputErrorNetwork);
    expect(alert.textContent).not.toContain('Failed to fetch');
    expect(alert.textContent).not.toContain(VALID_URL);
  });

  it('never touches storage during the flow', async () => {
    const fetchMock = vi.fn<typeof fetch>((input) => {
      const url = String(input);
      if (url.includes('/v1/media/status')) {
        return Promise.resolve(
          jsonResponse({ state: 'playable', available: 0, total: 0 }, 200),
        );
      }
      return Promise.resolve(jsonResponse({ id: 'job123' }, 201));
    });
    vi.stubGlobal('fetch', fetchMock);
    const setItemSpy = vi.spyOn(Storage.prototype, 'setItem');
    render(<YouTubeInput {...defaultProps} />);
    fireEvent.change(screen.getByRole('textbox'), { target: { value: VALID_URL } });
    fireEvent.click(screen.getByRole('button', { name: baseDict.youtubeInputSubmit }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(setItemSpy).not.toHaveBeenCalled();
    setItemSpy.mockRestore();
  });

  it('clears the URL when the dialog closes and reopens', () => {
    const { rerender } = render(<YouTubeInput {...defaultProps} />);
    fireEvent.change(screen.getByRole('textbox'), { target: { value: VALID_URL } });
    expect((screen.getByRole('textbox') as HTMLInputElement).value).toBe(VALID_URL);
    // Close (unmounts the content) then reopen.
    rerender(<YouTubeInput {...defaultProps} open={false} />);
    rerender(<YouTubeInput {...defaultProps} open={true} />);
    expect((screen.getByRole('textbox') as HTMLInputElement).value).toBe('');
  });

  it('aborts a stale submit when the dialog closes mid-flight', async () => {
    let resolveFetch: (r: Response) => void = () => {};
    const fetchMock = vi.fn<typeof fetch>().mockImplementation(
      () => new Promise<Response>((res) => { resolveFetch = res; }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const onJobAccepted = vi.fn();
    const { unmount } = render(
      <YouTubeInput {...defaultProps} onJobAccepted={onJobAccepted} />,
    );
    fireEvent.change(screen.getByRole('textbox'), { target: { value: VALID_URL } });
    fireEvent.click(screen.getByRole('button', { name: baseDict.youtubeInputSubmit }));
    unmount(); // component gone before the response lands
    resolveFetch(jsonResponse({ id: 'job456' }, 201));
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(onJobAccepted).not.toHaveBeenCalled(); // stale callback ignored
  });

  it('disables submit while a request is in flight', async () => {
    let resolveFetch: (r: Response) => void = () => {};
    const fetchMock = vi.fn<typeof fetch>((input) => {
      const url = String(input);
      if (url.includes('/v1/media/status')) {
        return Promise.resolve(
          jsonResponse({ state: 'playable', available: 0, total: 0 }, 200),
        );
      }
      return new Promise<Response>((res) => {
        resolveFetch = res;
      });
    });
    vi.stubGlobal('fetch', fetchMock);
    const onJobAccepted = vi.fn();
    render(<YouTubeInput {...defaultProps} onJobAccepted={onJobAccepted} />);
    fireEvent.change(screen.getByRole('textbox'), { target: { value: VALID_URL } });
    fireEvent.click(screen.getByRole('button', { name: baseDict.youtubeInputSubmit }));
    // While the request is in flight the button stays disabled and shows
    // the TypewriterLoading animation (no text change needed).
    const submit = screen.getByRole('button', { name: baseDict.youtubeInputSubmit });
    expect(submit).toBeDisabled();
    resolveFetch(jsonResponse({ id: 'job123' }, 201));
    await waitFor(() => expect(onJobAccepted).toHaveBeenCalledWith('job123'));
  });

  it('cancels the active job before creating a new one (auto-cancel)', async () => {
    const fetchMock = vi.fn<typeof fetch>((input) => {
      const url = String(input);
      if (url.includes('/v1/media/status')) {
        return Promise.resolve(
          jsonResponse({ state: 'playable', available: 0, total: 0 }, 200),
        );
      }
      return Promise.resolve(jsonResponse({ id: 'job456' }, 201));
    });
    vi.stubGlobal('fetch', fetchMock);
    const cancelActiveJob = vi.fn();
    render(
      <YouTubeInput {...defaultProps} cancelActiveJob={cancelActiveJob} />,
    );
    fireEvent.change(screen.getByRole('textbox'), { target: { value: VALID_URL } });
    fireEvent.click(screen.getByRole('button', { name: baseDict.youtubeInputSubmit }));

    await waitFor(() => expect(cancelActiveJob).toHaveBeenCalledTimes(1));
    // The new job creation request is sent, then the playable status poll.
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('works without cancelActiveJob prop (no active job)', async () => {
    const fetchMock = vi.fn<typeof fetch>((input) => {
      const url = String(input);
      if (url.includes('/v1/media/status')) {
        return Promise.resolve(
          jsonResponse({ state: 'playable', available: 0, total: 0 }, 200),
        );
      }
      return Promise.resolve(jsonResponse({ id: 'job789' }, 201));
    });
    vi.stubGlobal('fetch', fetchMock);
    const onJobAccepted = vi.fn();
    render(
      <YouTubeInput {...defaultProps} cancelActiveJob={undefined} onJobAccepted={onJobAccepted} />,
    );
    fireEvent.change(screen.getByRole('textbox'), { target: { value: VALID_URL } });
    fireEvent.click(screen.getByRole('button', { name: baseDict.youtubeInputSubmit }));

    await waitFor(() => expect(onJobAccepted).toHaveBeenCalledWith('job789'));
    // Job POST + the immediate playable status poll.
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe('YouTubeInput — unpaired gate', () => {
  it('allows no input or submit while unpaired (title only)', () => {
    render(
      <YouTubeInput
        open={true}
        onOpenChange={vi.fn()}
        isPaired={false}
        token={null}
        onJobAccepted={vi.fn()}
        dict={baseDict}
      />,
    );
    // The sr-only pairing notice was removed (2026-08-10 cleanup): the
    // dialog keeps the title and the pairing happens in the settings UI.
    expect(screen.queryByText('Pair EizouDendenshi first to download from YouTube.')).not.toBeInTheDocument();
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: baseDict.youtubeInputSubmit })).not.toBeInTheDocument();
    // Only the X close remains.
    expect(screen.getAllByRole('button')).toHaveLength(1);
  });
});
