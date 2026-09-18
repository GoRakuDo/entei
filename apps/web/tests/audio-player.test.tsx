import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';

const audioPlayerMocks = vi.hoisted(() => ({
  beginJobSession: vi.fn(),
  cancelActiveJob: vi.fn(() => Promise.resolve()),
  attachMediaElement: vi.fn(),
  pairingConnected: true,
}));

vi.mock('@/features/player/use-companion-pairing', () => ({
  useCompanionPairing: () => ({
    connected: audioPlayerMocks.pairingConnected,
    tokenRef: { current: 'test-token' },
  }),
}));

vi.mock('@/features/player/companion-media', () => ({
  waitForPlayable: vi.fn(() => Promise.resolve({ ok: true, reason: 'playable' })),
}));

vi.mock('@/features/player/use-companion-job-session', () => ({
  useCompanionJobSession: () => ({
    active: false,
    kind: null,
    jobId: null,
    jobQuality: 0,
    jobMode: null,
    phase: 'idle',
    progress: null,
    reason: null,
    errorCode: null,
    token: null,
    subtitleFileId: null,
    subtitleUrl: null,
    jobTitle: null,
    beginJobSession: audioPlayerMocks.beginJobSession,
    cancelActiveJob: audioPlayerMocks.cancelActiveJob,
    endJobSession: vi.fn(),
    attachMediaElement: audioPlayerMocks.attachMediaElement,
    setPlayIntent: vi.fn(),
    requestSeek: vi.fn(),
  }),
}));
vi.mock('@/features/player/watch-history/audio', () => ({
  clearAudioProgress: vi.fn(),
  computeAudioMediaId: vi.fn(),
  createAudioPosterFromCoverUrl: vi.fn(),
  getAudioWatchHistoryRecord: vi.fn(),
  readAudioProgress: vi.fn(),
  recordAudioWatchHistory: vi.fn(),
  writeAudioProgress: vi.fn(),
}));

vi.mock('@/features/player/audio-cover/audio-cover', () => ({
  extractAudioCover: vi.fn(),
  revokeAudioCoverUrl: vi.fn(),
}));

import AudioPlayer, {
  clampAudioSeekTarget,
  findActiveAudioCue,
} from '@/components/player/AudioPlayer';
import { LOCALE_CHANGE_EVENT } from '@i18n/locale-events';
import * as audioCover from '@/features/player/audio-cover/audio-cover';
import * as audioHistory from '@/features/player/watch-history/audio';
import type { WatchHistoryRecord } from '@/features/player/watch-history/types';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  audioPlayerMocks.pairingConnected = true;
});

const cues = [
  { id: 1, start: 0, end: 2, text: 'First line' },
  { id: 2, start: 2, end: 5, text: 'Second line' },
] as const;

describe('AudioPlayer', () => {
  beforeEach(() => {
    document.documentElement.lang = 'en';
  });

  it('renders cover/subtitle ButtonGroup tabs and subtitle cues from a loaded source', () => {
    render(<AudioPlayer src="/book.m4b" title="Book title" cues={cues} />);

    const subtitleTab = screen.getByRole('button', { name: 'Subtitle' });
    const coverTab = screen.getByRole('button', { name: 'Cover' });
    expect(subtitleTab.getAttribute('aria-pressed')).toBe('false');
    expect(coverTab.getAttribute('aria-pressed')).toBe('true');

    fireEvent.click(subtitleTab);
    expect(subtitleTab.getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByRole('button', { name: /First line/ })).not.toBeNull();
    expect(screen.getByRole('button', { name: /Second line/ })).not.toBeNull();

    fireEvent.click(coverTab);
    expect(coverTab.getAttribute('aria-pressed')).toBe('true');
  });

  it('shows only the file-selection panel before an audio source is loaded', () => {
    render(<AudioPlayer />);

    expect(screen.getByRole('button', { name: 'Open audio file' })).not.toBeNull();
    expect(screen.getByRole('button', { name: 'Open YouTube audio' })).not.toBeNull();
    expect(screen.getByText('Accepted formats: MP3, WAV, FLAC, AAC, M4A, M4B, and OPUS.')).not.toBeNull();
    expect(screen.queryByRole('button', { name: 'Subtitle' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Cover' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Play' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Skip back 10 seconds' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Skip back 30 seconds' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Skip forward 10 seconds' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Skip forward 30 seconds' })).toBeNull();
    expect(screen.queryByRole('button', { name: /Playback speed: 1x/ })).toBeNull();
    expect(screen.queryByRole('slider', { name: 'Seek through audio' })).toBeNull();
  });

  it('disables YouTube audio entry when the companion is not paired', () => {
    audioPlayerMocks.pairingConnected = false;
    render(<AudioPlayer />);

    expect(
      screen.getByRole('button', { name: 'Open YouTube audio' }),
    ).toBeDisabled();
  });

  it('opens YouTube audio entry and loads the accepted job into the player', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ id: 'audio-job', title: 'YouTube lesson' }), {
        status: 201,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    render(<AudioPlayer />);
    fireEvent.click(screen.getByRole('button', { name: 'Open YouTube audio' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'YouTube URL' }), {
      target: { value: 'https://www.youtube.com/watch?v=abcdefghijk' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Start download' }));

    await waitFor(() => {
      expect(audioPlayerMocks.beginJobSession).toHaveBeenCalledWith({
        baseUrl: 'http://127.0.0.1:4322',
        token: 'test-token',
        jobId: 'audio-job',
        kind: 'youtube',
      });
    });
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual({
      url: 'https://www.youtube.com/watch?v=abcdefghijk',
      mode: 'audio',
    });
    const heading = screen.getByRole('heading', { name: 'YouTube lesson' });
    expect(heading).toHaveClass('entei-sr-only');
    expect(document.querySelector('.audio-player__header')).toBeNull();
    expect(document.querySelector('.audio-player__eyebrow')).toBeNull();
    expect(screen.getByRole('button', { name: 'Play' })).not.toBeNull();
  });

  it('uses Japanese labels for the open button and empty state', () => {
    document.documentElement.lang = 'ja';
    render(<AudioPlayer />);

    expect(screen.getByRole('button', { name: '音声ファイルを開く' })).not.toBeNull();
    expect(
      screen.getByRole('heading', {
        name: '音声ファイルを選択して聴き始めてください。',
      }),
    ).not.toBeNull();
  });

  it('updates labels when the shared locale event changes to Japanese', () => {
    render(<AudioPlayer />);

    act(() => {
      window.dispatchEvent(
        new CustomEvent(LOCALE_CHANGE_EVENT, { detail: { locale: 'ja' } }),
      );
    });

    expect(screen.getByRole('button', { name: '音声ファイルを開く' })).not.toBeNull();
    expect(
      screen.getByRole('heading', {
        name: '音声ファイルを選択して聴き始めてください。',
      }),
    ).not.toBeNull();
  });

  it('shows the full playback chrome when a source is supplied', () => {
    render(<AudioPlayer src="/book.m4b" />);

    expect(screen.getByRole('button', { name: 'Subtitle' })).not.toBeNull();
    expect(screen.getByRole('button', { name: 'Cover' })).not.toBeNull();

    const controlRow = document.querySelector('.audio-player__control-row');
    expect(controlRow).not.toBeNull();
    expect(controlRow?.children).toHaveLength(3);
    expect(window.getComputedStyle(controlRow!).flexWrap).toBe('nowrap');

    const play = screen.getByRole('button', { name: 'Play' }) as HTMLButtonElement;
    expect(play.disabled).toBe(false);
    expect(
      (screen.getByRole('button', { name: 'Skip back 10 seconds' }) as HTMLButtonElement).disabled,
    ).toBe(false);
    expect(
      (screen.getByRole('button', { name: 'Skip forward 30 seconds' }) as HTMLButtonElement).disabled,
    ).toBe(false);

    const seek = screen.getByRole('slider', { name: 'Seek through audio' }) as HTMLInputElement;
    expect(seek.disabled).toBe(true);
    // Restyle contract: AudioPlayer.css reads the played share from this custom
    // property, which stays 0% until duration metadata arrives.
    expect(seek.style.getPropertyValue('--audio-player-seek-fill')).toBe('0%');

    const speed = screen.getByRole('button', {
      name: 'Playback speed: 1x',
    });
    expect(speed).toHaveAttribute('aria-expanded', 'false');

    fireEvent.click(speed);
    expect(speed).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByRole('button', { name: '0.25x' })).toHaveAttribute(
      'aria-pressed',
      'false',
    );
    expect(screen.getByRole('button', { name: '1x' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    expect(
      screen.getAllByRole('button', { name: /^\d(?:\.\d+)?x$/ }),
    ).toHaveLength(8);

    fireEvent.click(screen.getByRole('button', { name: '1.5x' }));
    expect(
      screen.getByRole('button', { name: 'Playback speed: 1.5x' }),
    ).toHaveAttribute('aria-expanded', 'false');
    expect(document.querySelector('audio')).toHaveProperty('playbackRate', 1.5);

    // Loaded state: the bottom entry bar is gone, source switching lives
    // inside the tabs ButtonGroup instead.
    expect(document.querySelector('.audio-player__entry-actions')).toBeNull();
    expect(document.querySelector('.audio-player__entry-bar')).toBeNull();
    expect(document.querySelector('.audio-player__source-switch')).toBeNull();
    const tabsGroup = document.querySelector(
      '.audio-player__tabs [data-slot="button-group"]',
    );
    expect(tabsGroup).not.toBeNull();
    expect(
      tabsGroup?.querySelector('button[aria-label="Open audio file"]'),
    ).not.toBeNull();
    expect(
      tabsGroup?.querySelector('button[aria-label="Open YouTube audio"]'),
    ).not.toBeNull();
  });

  it('loads subtitle cues from a subtitle file in the empty state', async () => {
    render(<AudioPlayer src="/book.m4b" />);
    fireEvent.click(screen.getByRole('button', { name: 'Subtitle' }));

    expect(screen.getByRole('button', { name: 'Open subtitle file' })).not.toBeNull();
    const file = new File(
      ['WEBVTT\n\n00:00:00.000 --> 00:00:02.000\nFirst line'],
      'sub.vtt',
      { type: 'text/vtt' },
    );
    fireEvent.change(screen.getByLabelText('Choose a subtitle file'), {
      target: { files: [file] },
    });

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /First line/ })).not.toBeNull();
    });
  });

  it('centers the active cue in the subtitle list', () => {
    const listHeight = Object.getOwnPropertyDescriptor(
      window.HTMLElement.prototype,
      'clientHeight',
    );
    const offsetTop = Object.getOwnPropertyDescriptor(
      window.HTMLElement.prototype,
      'offsetTop',
    );
    const scrollTo = window.HTMLElement.prototype.scrollTo;
    Object.defineProperty(window.HTMLElement.prototype, 'clientHeight', {
      configurable: true,
      get() {
        return this.classList?.contains('audio-player__cue-list') ? 300 : 40;
      },
    });
    Object.defineProperty(window.HTMLElement.prototype, 'offsetTop', {
      configurable: true,
      get() {
        return 200;
      },
    });
    const scrollToMock = vi.fn();
    window.HTMLElement.prototype.scrollTo = scrollToMock;
    try {
      render(<AudioPlayer src="/book.m4b" cues={cues} />);
      fireEvent.click(screen.getByRole('button', { name: 'Subtitle' }));
      // First cue is active at time 0: 200 - 300/2 + 40/2 = 70.
      expect(scrollToMock).toHaveBeenCalledWith({
        top: 70,
        behavior: 'smooth',
      });
    } finally {
      if (listHeight) {
        Object.defineProperty(
          window.HTMLElement.prototype,
          'clientHeight',
          listHeight,
        );
      }
      if (offsetTop) {
        Object.defineProperty(window.HTMLElement.prototype, 'offsetTop', offsetTop);
      }
      window.HTMLElement.prototype.scrollTo = scrollTo;
    }
  });

  it('marks the document as loaded so the mobile chrome auto-hides after a source loads', () => {
    render(<AudioPlayer src="/book.m4b" title="Book title" />);

    expect(
      document.documentElement.classList.contains('entei-audio-loaded'),
    ).toBe(true);
  });

  it('leaves the mobile chrome marker off while no track is loaded', () => {
    render(<AudioPlayer />);

    expect(
      document.documentElement.classList.contains('entei-audio-loaded'),
    ).toBe(false);
  });
});

describe('audio player pure controls', () => {
  it('clamps skip and cue targets without exceeding media duration', () => {
    expect(clampAudioSeekTarget(-10, 20)).toBe(0);
    expect(clampAudioSeekTarget(25, 20)).toBe(20);
    expect(clampAudioSeekTarget(7, Number.NaN)).toBe(7);
  });

  it('finds only the cue active at the current playback time', () => {
    expect(findActiveAudioCue(cues, 1)?.text).toBe('First line');
    expect(findActiveAudioCue(cues, 2)?.text).toBe('Second line');
    expect(findActiveAudioCue(cues, 5)).toBeNull();
  });
});

const cachedRecord: WatchHistoryRecord = {
  mediaId: 'fingerprint-1',
  title: 'Cached book title',
  episode: null,
  watchedAt: 1,
  source: 'audio',
  anilistId: null,
  tmdbId: null,
  posterUrl: 'data:image/png;base64,CACHED',
  posterStatus: 'ready',
};

function selectAudioFile(): void {
  fireEvent.change(screen.getByLabelText('Choose an audio file'), {
    target: {
      files: [
        new File([new Uint8Array([1, 2, 3, 4])], 'book.m4b', {
          type: 'audio/mp4',
        }),
      ],
    },
  });
}

/** Load the fake media clock so resume/ended logic can run in jsdom. */
function getAudioElement(): HTMLAudioElement {
  return document.querySelector('audio') as HTMLAudioElement;
}

describe('AudioPlayer cover cache and playback resume', () => {
  beforeEach(() => {
    vi.mocked(audioHistory.computeAudioMediaId).mockResolvedValue(
      'fingerprint-1',
    );
    vi.mocked(audioHistory.getAudioWatchHistoryRecord).mockResolvedValue(null);
    vi.mocked(audioHistory.readAudioProgress).mockReturnValue(null);
    vi.mocked(audioHistory.createAudioPosterFromCoverUrl).mockResolvedValue(
      null,
    );
    vi.mocked(audioCover.extractAudioCover).mockResolvedValue({
      title: 'Parsed book title',
      coverUrl: 'blob:extracted-cover',
    });
  });

  it('reuses a cached cover and title without parsing the file again', async () => {
    vi.mocked(audioHistory.getAudioWatchHistoryRecord).mockResolvedValue(
      cachedRecord,
    );

    render(<AudioPlayer />);
    selectAudioFile();

    await waitFor(() => {
      expect(
        screen.getByRole('img', { name: 'Cached book title cover' }),
      ).toHaveAttribute('src', 'data:image/png;base64,CACHED');
    });
    expect(audioHistory.getAudioWatchHistoryRecord).toHaveBeenCalledWith(
      'fingerprint-1',
    );
    expect(audioCover.extractAudioCover).not.toHaveBeenCalled();
    expect(audioHistory.recordAudioWatchHistory).not.toHaveBeenCalled();
    expect(
      screen.getByRole('heading', { name: 'Cached book title' }),
    ).not.toBeNull();
  });

  it('records the extracted cover as a reload-safe poster for the next open', async () => {
    const poster = { format: 'image/png', data: new Uint8Array([9, 8, 7]) };
    vi.mocked(audioHistory.createAudioPosterFromCoverUrl).mockResolvedValue(
      poster,
    );

    render(<AudioPlayer />);
    selectAudioFile();

    await waitFor(() => {
      expect(audioHistory.recordAudioWatchHistory).toHaveBeenCalledTimes(1);
    });
    expect(audioCover.extractAudioCover).toHaveBeenCalledTimes(1);
    expect(audioHistory.createAudioPosterFromCoverUrl).toHaveBeenCalledWith(
      'blob:extracted-cover',
    );
    expect(audioHistory.recordAudioWatchHistory).toHaveBeenCalledWith({
      mediaId: 'fingerprint-1',
      fileName: 'book.m4b',
      metadataTitle: 'Parsed book title',
      poster,
    });
    expect(
      screen.getByRole('img', { name: 'Parsed book title cover' }),
    ).toHaveAttribute('src', 'blob:extracted-cover');
  });

  it('restores a saved playback position once metadata is known', async () => {
    vi.mocked(audioHistory.readAudioProgress).mockReturnValue(42);

    render(<AudioPlayer />);
    selectAudioFile();
    await waitFor(() => {
      expect(audioHistory.getAudioWatchHistoryRecord).toHaveBeenCalled();
    });

    const audio = getAudioElement();
    Object.defineProperty(audio, 'duration', {
      configurable: true,
      value: 600,
    });
    act(() => {
      audio.dispatchEvent(new Event('loadedmetadata'));
    });

    expect(audioHistory.readAudioProgress).toHaveBeenCalledWith(
      'fingerprint-1',
    );
    expect(audio.currentTime).toBe(42);
    const seek = screen.getByRole('slider', {
      name: 'Seek through audio',
    }) as HTMLInputElement;
    expect(seek.value).toBe('42');
  });

  it('does not resume a saved position inside the final seconds', async () => {
    vi.mocked(audioHistory.readAudioProgress).mockReturnValue(598);

    render(<AudioPlayer />);
    selectAudioFile();
    await waitFor(() => {
      expect(audioHistory.getAudioWatchHistoryRecord).toHaveBeenCalled();
    });

    const audio = getAudioElement();
    Object.defineProperty(audio, 'duration', {
      configurable: true,
      value: 600,
    });
    act(() => {
      audio.dispatchEvent(new Event('loadedmetadata'));
    });

    expect(audio.currentTime).toBe(0);
    expect(audioHistory.clearAudioProgress).toHaveBeenCalledWith(
      'fingerprint-1',
    );
  });

  it('persists the position from timeupdate, throttled to a few seconds', async () => {
    render(<AudioPlayer />);
    selectAudioFile();
    await waitFor(() => {
      expect(audioHistory.getAudioWatchHistoryRecord).toHaveBeenCalled();
    });

    const audio = getAudioElement();
    Object.defineProperty(audio, 'duration', {
      configurable: true,
      value: 600,
    });

    audio.currentTime = 30;
    act(() => {
      audio.dispatchEvent(new Event('timeupdate'));
    });
    // A sub-throttle step must not write again.
    audio.currentTime = 31;
    act(() => {
      audio.dispatchEvent(new Event('timeupdate'));
    });

    expect(audioHistory.writeAudioProgress).toHaveBeenCalledTimes(1);
    expect(audioHistory.writeAudioProgress).toHaveBeenCalledWith(
      'fingerprint-1',
      30,
    );
  });

  it('clears the saved position when the track ends or nears the end', async () => {
    vi.mocked(audioHistory.readAudioProgress).mockReturnValue(42);

    render(<AudioPlayer />);
    selectAudioFile();
    await waitFor(() => {
      expect(audioHistory.getAudioWatchHistoryRecord).toHaveBeenCalled();
    });

    const audio = getAudioElement();
    Object.defineProperty(audio, 'duration', {
      configurable: true,
      value: 600,
    });

    // Time inside the closing 5 seconds clears the record.
    audio.currentTime = 597;
    act(() => {
      audio.dispatchEvent(new Event('timeupdate'));
    });
    expect(audioHistory.clearAudioProgress).toHaveBeenCalledWith(
      'fingerprint-1',
    );

    vi.mocked(audioHistory.clearAudioProgress).mockClear();
    act(() => {
      audio.dispatchEvent(new Event('ended'));
    });
    expect(audioHistory.clearAudioProgress).toHaveBeenCalledWith(
      'fingerprint-1',
    );
  });
});
