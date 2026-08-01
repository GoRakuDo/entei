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

const baseDict: YouTubeInputDict = {
  youtubeInputLabel: 'YouTube URL',
  youtubeInputTitle: 'YouTube streaming',
  youtubeInputPlaceholder: 'https://www.youtube.com/watch?v=…',
  youtubeInputSubmit: 'Start download',
  youtubeInputUnpairedBody: 'Pair EizouDendenshi first to download from YouTube.',
  youtubeInputErrorInvalid: 'Invalid YouTube URL.',
  youtubeInputErrorRepair: 'The connection needs re-pairing. Open Setup and connect again.',
  youtubeInputErrorConflict: 'A download is already active. Cancel the previous download first.',
  youtubeInputErrorNetwork: 'Could not reach EizouDendenshi. Make sure the companion app is running.',
  youtubeInputErrorGeneric: 'Something went wrong. Try again.',
  youtubeInputSubmitting: 'Starting…',
  dialogClose: 'Close',
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
  const defaultProps = {
    open: true,
    onOpenChange: vi.fn(),
    isPaired: true,
    token: TOKEN,
    onJobAccepted: vi.fn(),
    dict: baseDict,
  };

  it('renders the URL input and submit when paired', () => {
    render(<YouTubeInput {...defaultProps} />);
    expect(screen.getByRole('textbox', { name: baseDict.youtubeInputLabel })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: baseDict.youtubeInputSubmit })).toBeInTheDocument();
  });

  it('submits the exact payload to the job endpoint with the token in the query', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse({ id: 'job123' }, 201),
    );
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
    expect(JSON.parse(String(init?.body))).toEqual({ url: VALID_URL });
    // The token must never appear in the body.
    expect(String(init?.body)).not.toContain(TOKEN);
    // The parent closes the dialog on acceptance (PlayerApp wiring).
    expect(onJobAccepted).toHaveBeenCalledTimes(1);
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
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse({ id: 'job123' }, 201));
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
    const fetchMock = vi.fn<typeof fetch>().mockImplementation(
      () => new Promise<Response>((res) => { resolveFetch = res; }),
    );
    vi.stubGlobal('fetch', fetchMock);
    render(<YouTubeInput {...defaultProps} />);
    fireEvent.change(screen.getByRole('textbox'), { target: { value: VALID_URL } });
    fireEvent.click(screen.getByRole('button', { name: baseDict.youtubeInputSubmit }));
    const submit = screen.getByRole('button', { name: baseDict.youtubeInputSubmitting });
    expect(submit).toBeDisabled();
    resolveFetch(jsonResponse({ id: 'job123' }, 201));
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
  });
});

describe('YouTubeInput — unpaired gate', () => {
  it('shows the pairing-needed notice and allows no input or submit', () => {
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
    expect(screen.getByText(baseDict.youtubeInputUnpairedBody)).toBeInTheDocument();
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: baseDict.youtubeInputSubmit })).not.toBeInTheDocument();
    // Only the X close remains.
    expect(screen.getAllByRole('button')).toHaveLength(1);
  });
});
