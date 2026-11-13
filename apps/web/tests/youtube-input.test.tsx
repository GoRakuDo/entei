import { afterEach, describe, expect, it, vi } from 'bun:test';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import {
  parseYouTubeVideoId,
  sanitizeYouTubeUrl,
  YouTubeInput,
  type YouTubeInputDict,
} from '@/components/player/YouTubeInput';

const dict: YouTubeInputDict = {
  youtubeInputLabel: 'YouTube URL',
  youtubeInputTitle: 'YouTube streaming',
  youtubeInputFieldLabel: 'Link the YouTube video to stream:',
  youtubeInputCancel: 'Cancel',
  youtubeInputPlaceholder: 'https://www.youtube.com/watch?v=…',
  youtubeInputSubmit: 'Stream Now',
  youtubeInputErrorInvalid: 'Invalid YouTube URL.',
  youtubeInputErrorGeneric: 'Something went wrong. Try again.',
  dialogClose: 'Close',
  firefoxUnsupported: 'Firefox is not yet supported.',
};

const VALID_URL = 'https://www.youtube.com/watch?v=abcdefghijk';
const STREAM = {
  url: 'http://127.0.0.1:41234/stream/session',
  urls: ['http://127.0.0.1:41234/stream/session'],
  mode: 'video',
  format_selector: 'best[height<=1080]',
  relayed: true,
};
const INFO = {
  id: 'abcdefghijk',
  title: 'Test video',
  is_live: false,
  subtitles: ['ja'],
};

type Invoke = (command: string, args?: Record<string, unknown>) => Promise<unknown>;
function installTauri(invoke: Invoke) {
  (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = { invoke };
}
function removeTauri() {
  delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
}

const toastSpy = vi.hoisted(() => ({
  error: vi.fn(),
  info: vi.fn(),
  success: vi.fn(),
  warning: vi.fn(),
}));
vi.mock('sonner', () => ({ toast: toastSpy }));

function lastErrorToast(): string | undefined {
  const calls = toastSpy.error.mock.calls;
  return calls.length ? (calls[calls.length - 1] as [string])[0] : undefined;
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
  removeTauri();
});

describe('YouTube URL helpers', () => {
  it.each([
    ['https://www.youtube.com/watch?v=abcdefghijk', 'abcdefghijk'],
    ['https://youtu.be/abcdefghijk', 'abcdefghijk'],
    ['https://www.youtube.com/shorts/abcdefghijk', 'abcdefghijk'],
    ['https://www.youtube.com/embed/abcdefghijk', 'abcdefghijk'],
    ['https://www.youtube.com/live/abcdefghijk', 'abcdefghijk'],
  ])('parses the id from %s', (url, id) => {
    expect(parseYouTubeVideoId(url)).toBe(id);
  });

  it.each([
    'not a url',
    'http://www.youtube.com/watch?v=abcdefghijk',
    'https://www.youtube.com/watch?v=too-short',
    'https://example.com/watch?v=abcdefghijk',
  ])('rejects invalid URL %s', (url) => {
    expect(parseYouTubeVideoId(url)).toBeNull();
  });

  it('removes tracking parameters from supported YouTube share links', () => {
    expect(sanitizeYouTubeUrl('https://youtu.be/abcdefghijk?si=tracking')).toBe(
      'https://youtu.be/abcdefghijk',
    );
    expect(
      sanitizeYouTubeUrl('https://www.youtube.com/watch?v=abcdefghijk&si=x&t=10'),
    ).toBe(VALID_URL);
    expect(sanitizeYouTubeUrl('https://www.youtube.com/shorts/abcdefghijk?si=x')).toBe(
      'https://www.youtube.com/shorts/abcdefghijk',
    );
  });
});

describe('YouTubeInput — direct Tauri yt-dlp flow', () => {
  it('renders the URL form and starts the stream with its parsed video id', async () => {
    const invoke = vi.fn<Invoke>((command) =>
      Promise.resolve(command === 'plugin:modules|stream_youtube' ? STREAM : INFO),
    );
    installTauri(invoke);
    const onOpenChange = vi.fn();
    const onStreamAccepted = vi.fn(() => onOpenChange(false));
    const onVideoIdParsed = vi.fn();
    const fetchMock = vi.fn<typeof fetch>();
    vi.stubGlobal('fetch', fetchMock);

    render(
      <YouTubeInput
        open
        onOpenChange={onOpenChange}
        onStreamAccepted={onStreamAccepted}
        onVideoIdParsed={onVideoIdParsed}
        dict={dict}
      />,
    );
    fireEvent.change(screen.getByRole('textbox', { name: dict.youtubeInputFieldLabel }), {
      target: { value: 'https://youtu.be/abcdefghijk?si=tracking' },
    });
    fireEvent.click(screen.getByRole('button', { name: dict.youtubeInputSubmit }));

    await waitFor(() => expect(onStreamAccepted).toHaveBeenCalledWith(STREAM, INFO));
    expect(onVideoIdParsed).toHaveBeenCalledWith('abcdefghijk');
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(invoke).toHaveBeenCalledWith('plugin:modules|stream_youtube', {
      url: 'https://youtu.be/abcdefghijk',
      mode: 'video',
    });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(document.body).not.toHaveTextContent('tracking');
  });

  it('uses the requested stream mode and treats metadata as optional', async () => {
    const invoke = vi.fn<Invoke>((command) =>
      command === 'plugin:modules|stream_youtube'
        ? Promise.resolve(STREAM)
        : Promise.reject(new Error('metadata unavailable')),
    );
    installTauri(invoke);
    const onStreamAccepted = vi.fn();

    render(
      <YouTubeInput
        open
        onOpenChange={vi.fn()}
        streamMode="audio"
        onStreamAccepted={onStreamAccepted}
        dict={dict}
      />,
    );
    fireEvent.change(screen.getByRole('textbox'), { target: { value: VALID_URL } });
    fireEvent.click(screen.getByRole('button', { name: dict.youtubeInputSubmit }));

    await waitFor(() => expect(onStreamAccepted).toHaveBeenCalledWith(STREAM, null));
    expect(invoke).toHaveBeenCalledWith('plugin:modules|stream_youtube', {
      url: VALID_URL,
      mode: 'audio',
    });
  });

  it('rejects invalid input locally without invoking native commands', async () => {
    const invoke = vi.fn<Invoke>();
    installTauri(invoke);
    render(
      <YouTubeInput
        open
        onOpenChange={vi.fn()}
        onStreamAccepted={vi.fn()}
        dict={dict}
      />,
    );
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'not a URL' } });
    fireEvent.click(screen.getByRole('button', { name: dict.youtubeInputSubmit }));

    await waitFor(() => expect(lastErrorToast()).toBe(dict.youtubeInputErrorInvalid));
    expect(invoke).not.toHaveBeenCalled();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('hides native error details and rejects a late result after the dialog closes', async () => {
    let resolveStream: (value: unknown) => void = () => {};
    const invoke = vi.fn<Invoke>((command) =>
      command === 'plugin:modules|stream_youtube'
        ? new Promise((resolve) => { resolveStream = resolve; })
        : Promise.reject(new Error('metadata unavailable')),
    );
    installTauri(invoke);
    const onStreamAccepted = vi.fn();
    const props = {
      onOpenChange: vi.fn(),
      onStreamAccepted,
      dict,
    };
    const view = render(<YouTubeInput {...props} open />);
    fireEvent.change(screen.getByRole('textbox'), { target: { value: VALID_URL } });
    fireEvent.click(screen.getByRole('button', { name: dict.youtubeInputSubmit }));
    view.rerender(<YouTubeInput {...props} open={false} />);
    resolveStream(STREAM);

    await waitFor(() => expect(invoke).toHaveBeenCalled());
    expect(onStreamAccepted).not.toHaveBeenCalled();

    const failingInvoke = vi.fn<Invoke>(() =>
      Promise.reject(new Error('upstream https://googlevideo.example/token')),
    );
    installTauri(failingInvoke);
    render(<YouTubeInput {...props} open />);
    fireEvent.change(screen.getByRole('textbox'), { target: { value: VALID_URL } });
    fireEvent.click(screen.getByRole('button', { name: dict.youtubeInputSubmit }));
    await waitFor(() => expect(lastErrorToast()).toBe(dict.youtubeInputErrorGeneric));
    expect(lastErrorToast()).not.toContain('googlevideo.example');
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
});
