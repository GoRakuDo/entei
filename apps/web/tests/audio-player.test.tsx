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
import AudioPlayer, {
  clampAudioSeekTarget,
  findActiveAudioCue,
} from '@/components/player/AudioPlayer';
import { LOCALE_CHANGE_EVENT } from '@i18n/locale-events';

afterEach(() => {
  vi.unstubAllGlobals();
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
    expect(controlRow?.children).toHaveLength(5);
    expect(window.getComputedStyle(controlRow!).flexWrap).toBe('nowrap');

    const play = screen.getByRole('button', { name: 'Play' }) as HTMLButtonElement;
    expect(play.disabled).toBe(false);
    expect(
      (screen.getByRole('button', { name: 'Skip back 10 seconds' }) as HTMLButtonElement).disabled,
    ).toBe(false);
    expect(
      (screen.getByRole('button', { name: 'Skip back 30 seconds' }) as HTMLButtonElement).disabled,
    ).toBe(false);
    expect(
      (screen.getByRole('button', { name: 'Skip forward 10 seconds' }) as HTMLButtonElement).disabled,
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
