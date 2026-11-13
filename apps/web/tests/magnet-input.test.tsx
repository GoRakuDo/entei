import { afterEach, describe, expect, it, vi } from 'bun:test';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import {
  buildBreadcrumb,
  magnetDisplayName,
  MagnetInput,
  type DirectTorrentFile,
  type FileEntry,
  type MagnetInputDict,
} from '@/components/player/MagnetInput';

const dict: MagnetInputDict = {
  magnetInputLabel: 'Magnet URI',
  magnetInputPlaceholder: 'magnet:?xt=urn:btih:...',
  magnetInputLabelTitle: 'Open Torrent Stream',
  magnetErrorInvalid: 'Invalid magnet URI.',
  magnetInputSubmit: 'Load torrent',
  magnetInputErrorGeneric: 'Something went wrong. Try again.',
  magnetInputErrorMetadataTimeout: 'Metadata could not be retrieved.',
  magnetCheckMetadata: 'Checking metadata…',
  magnetNoVideoError: 'No selectable video in this torrent.',
  magnetSelectSubmit: 'Stream Now',
  magnetCancel: 'Cancel',
  dialogClose: 'Close',
  magnetTableFileName: 'File name',
  magnetTableSize: 'Size',
  magnetFileKindVideo: 'video',
  magnetFileKindSubtitle: 'subtitle',
  magnetFileKindFolder: 'folder',
  magnetFileKindOther: 'file',
  magnetTableNavUp: 'Go up one level',
  magnetNoVideosInFolder: 'No videos in this folder',
  magnetBreadcrumbLabel: 'Current folder',
  magnetBreadcrumbRoot: 'Torrent',
  firefoxUnsupported: 'Firefox is not yet supported.',
};
const VALID_URI = 'magnet:?xt=urn:btih:08ada5a7a6183aae1e09d831df6748d566095a10';
const FILES: DirectTorrentFile[] = [
  { index: 0, path: 'movie.mkv', length: 2_000_000 },
  { index: 1, path: 'movie.ass', length: 40_000 },
  { index: 2, path: 'readme.txt', length: 1_000 },
];

const toast = vi.hoisted(() => ({ error: vi.fn(), warning: vi.fn() }));
vi.mock('sonner', () => ({ toast }));

const defaultProps = {
  open: true,
  onOpenChange: vi.fn(),
  onJobAccepted: vi.fn(),
  dict,
};

function installTauri(handlers: Record<string, (args: Record<string, unknown>) => unknown>) {
  const calls: Array<{ command: string; args: Record<string, unknown> }> = [];
  const invoke = vi.fn(async (command: string, args?: Record<string, unknown>) => {
    const payload = args ?? {};
    calls.push({ command, args: payload });
    const handler = handlers[command];
    if (!handler) throw new Error(`unexpected command ${command}`);
    return handler(payload);
  });
  (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = { invoke };
  return { calls, invoke };
}

function removeTauri() {
  delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
}

async function createTorrent() {
  fireEvent.change(screen.getByRole('textbox'), { target: { value: VALID_URI } });
  fireEvent.click(screen.getByRole('button', { name: dict.magnetInputSubmit }));
  await waitFor(() => expect(screen.getByText('movie.mkv')).toBeInTheDocument());
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
  removeTauri();
});

describe('MagnetInput — direct Tauri torrent flow', () => {
  it('keeps the dialog local until submit, then requests torrent metadata without HTTP', async () => {
    const { calls } = installTauri({
      'plugin:modules|add_torrent': () => ({ id: 'torrent-1', name: 'Movie', files: FILES }),
    });
    const fetchMock = vi.fn<typeof fetch>();
    vi.stubGlobal('fetch', fetchMock);
    render(<MagnetInput {...defaultProps} />);

    expect(screen.getByRole('textbox')).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
    await createTorrent();

    expect(calls).toEqual([{
      command: 'plugin:modules|add_torrent',
      args: { magnetUri: VALID_URI },
    }]);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(document.body).not.toHaveTextContent(VALID_URI);
  });

  it('sends selected plugin file indices and hands relay URLs to the player', async () => {
    const { calls } = installTauri({
      'plugin:modules|add_torrent': () => ({ id: 'torrent-2', name: 'Movie', files: FILES }),
      'plugin:modules|select_torrent_files': () => ({
        video_url: 'http://127.0.0.1:5555/stream/video',
        video_name: 'movie.mkv',
        video_length: 2_000_000,
        subtitle_url: 'http://127.0.0.1:5555/stream/subtitle',
        subtitle_name: 'movie.ass',
        selected_audio_track: null,
        selected_subtitle_track: null,
      }),
    });
    const onJobAccepted = vi.fn();
    render(<MagnetInput {...defaultProps} onJobAccepted={onJobAccepted} />);
    await createTorrent();

    fireEvent.click(screen.getByLabelText('video: movie.mkv'));
    fireEvent.click(screen.getByLabelText('subtitle: movie.ass'));
    fireEvent.click(screen.getByRole('button', { name: dict.magnetSelectSubmit }));

    await waitFor(() => expect(onJobAccepted).toHaveBeenCalledWith(
      'torrent-2',
      'movie.mkv',
      '',
      {
        videoUrl: 'http://127.0.0.1:5555/stream/video',
        subtitleUrl: 'http://127.0.0.1:5555/stream/subtitle',
      },
    ));
    expect(calls.find((call) => call.command === 'plugin:modules|select_torrent_files')?.args)
      .toEqual({ id: 'torrent-2', videoIndex: 0, subtitleIndex: 1 });
  });

  it('cancels an unselected torrent when the dialog is dismissed', async () => {
    const { calls } = installTauri({
      'plugin:modules|add_torrent': () => ({ id: 'torrent-3', name: 'Movie', files: FILES }),
      'plugin:modules|cancel_torrent': () => null,
    });
    const onOpenChange = vi.fn();
    render(<MagnetInput {...defaultProps} onOpenChange={onOpenChange} />);
    await createTorrent();
    fireEvent.click(screen.getByRole('button', { name: dict.magnetCancel }));

    await waitFor(() => expect(calls.some((call) =>
      call.command === 'plugin:modules|cancel_torrent' && call.args.id === 'torrent-3',
    )).toBe(true));
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('keeps polling native metadata until the file list is available', async () => {
    vi.useFakeTimers();
    let files: DirectTorrentFile[] = [];
    const { calls } = installTauri({
      'plugin:modules|add_torrent': () => ({ id: 'torrent-4', name: 'Movie', files: [] }),
      'plugin:modules|get_torrent_status': () => ({
        id: 'torrent-4',
        name: 'Movie',
        state: 'metadata',
        files,
      }),
    });
    render(<MagnetInput {...defaultProps} />);
    fireEvent.change(screen.getByRole('textbox'), { target: { value: VALID_URI } });
    fireEvent.click(screen.getByRole('button', { name: dict.magnetInputSubmit }));
    await act(async () => { await Promise.resolve(); });
    expect(screen.getByText(dict.magnetCheckMetadata)).toBeInTheDocument();

    files = FILES;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });
    expect(screen.getByText('movie.mkv')).toBeInTheDocument();
    expect(calls.filter((call) => call.command === 'plugin:modules|get_torrent_status')).toHaveLength(1);
  });

  it('maps invalid plugin input to a safe localized toast', async () => {
    installTauri({
      'plugin:modules|add_torrent': () => { throw new Error('invalid magnet uri: secret'); },
    });
    render(<MagnetInput {...defaultProps} />);
    await createTorrent().catch(() => undefined);
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith(
      dict.magnetErrorInvalid,
      expect.objectContaining({ id: 'magnet-input-error' }),
    ));
    expect(document.body).not.toHaveTextContent('secret');
  });
});

describe('MagnetInput pure helpers', () => {
  it('parses the display name without throwing on malformed URI encoding', () => {
    expect(magnetDisplayName('magnet:?dn=My+Movie')).toBe('My Movie');
    expect(magnetDisplayName('magnet:?dn=%E0%A4%A')).toBe('');
  });

  it('builds and collapses folder breadcrumbs', () => {
    expect(buildBreadcrumb('Movie', 'A/B').map((crumb) => crumb.label)).toEqual(['Movie', 'A', 'B']);
    const deep = buildBreadcrumb('Movie', 'A/B/C');
    expect(deep).toHaveLength(3);
    expect(deep[1]?.ellipsis).toBe(true);
    expect(deep[2]?.current).toBe(true);
  });

  it('renders only video and subtitle rows as selectable entries', () => {
    const onJobAccepted = vi.fn();
    const fileEntries: FileEntry[] = [];
    expect(fileEntries).toHaveLength(0);
    expect(onJobAccepted).not.toHaveBeenCalled();
  });
});
