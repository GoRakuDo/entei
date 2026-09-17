import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
} from 'react';
import {
  Captions,
  FolderOpen,
  Gauge,
  Image,
  Pause,
  Play,
  RotateCcw,
  RotateCw,
} from 'lucide-react';
import { ButtonGroup } from '@/components/player/ui/button-group';
import {
  clampSeek,
  formatTime,
  PLAYBACK_RATES,
} from '@/features/player/control-helpers';
import {
  createMediaUrl,
  isAudioFile,
  revokeUrl,
} from '@/features/player/media-url';
import {
  readPlayerPreferences,
  writePlayerPreferences,
  type PlayerPreferences,
} from '@/features/player/preferences';
import type { SubtitleCue } from '@/features/player/subtitle-reader';
import { AudioCover } from '@/features/player/audio-cover/AudioCover';
import {
  extractAudioCover,
  revokeAudioCoverUrl,
} from '@/features/player/audio-cover/audio-cover';
import './AudioPlayer.css';

const STRINGS = {
  eyebrow: 'Audio player',
  openFile: 'Open audio file',
  fileInput: 'Choose an audio file',
  subtitle: 'Subtitle',
  cover: 'Cover',
  coverPanel: 'Cover artwork',
  subtitlePanel: 'Loaded subtitles',
  noSubtitles: 'No subtitles loaded',
  play: 'Play',
  pause: 'Pause',
  seek: 'Seek through audio',
  skipBack10: 'Skip back 10 seconds',
  skipBack30: 'Skip back 30 seconds',
  skipForward10: 'Skip forward 10 seconds',
  skipForward30: 'Skip forward 30 seconds',
  playbackSpeed: 'Playback speed',
  unsupportedFile: 'Choose a supported audio file.',
  playbackError: 'Unable to play this audio file.',
  audioElement: 'Audio playback',
  noTrack: 'Choose an audio file to begin listening.',
} as const;

export interface AudioPlayerProps {
  /** Optional source supplied by a future local/companion integration. */
  src?: string | null;
  /** Display title for a supplied source or YouTube audio job. */
  title?: string;
  /** YouTube video id for the cover-only thumbnail fallback chain. */
  youtubeVideoId?: string | null;
  /** Already-loaded subtitle cues; subtitle plumbing remains outside this screen. */
  cues?: readonly SubtitleCue[];
}

/** Active cue lookup kept pure so subtitle highlighting is deterministic. */
export function findActiveAudioCue(
  cues: readonly SubtitleCue[],
  currentTime: number,
): SubtitleCue | null {
  if (!Number.isFinite(currentTime)) return null;
  return (
    cues.find((cue) => currentTime >= cue.start && currentTime < cue.end) ?? null
  );
}

/** Clamp a skip/cue target with the same media rules used by the player. */
export function clampAudioSeekTarget(time: number, duration: number): number {
  return clampSeek(time, duration);
}

function isInteractiveTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return (
    target.matches(
      'button, input, select, textarea, a, [contenteditable="true"]',
    ) || target.closest('button, input, select, textarea, a') !== null
  );
}

export default function AudioPlayer({
  src = null,
  title: suppliedTitle = 'Audio track',
  youtubeVideoId = null,
  cues = [],
}: AudioPlayerProps) {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const ownedAudioUrlRef = useRef<string | null>(null);
  const coverUrlRef = useRef<string | null>(null);
  const coverRequestRef = useRef(0);
  const preferencesRef = useRef<PlayerPreferences>(readPlayerPreferences());
  const [audioSrc, setAudioSrc] = useState<string | null>(src);
  const [title, setTitle] = useState(suppliedTitle);
  const [coverUrl, setCoverUrl] = useState<string | null>(null);
  const [isLocalSource, setIsLocalSource] = useState(false);
  const [view, setView] = useState<'cover' | 'subtitle'>('cover');
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [playbackRate, setPlaybackRate] = useState(
    preferencesRef.current.playbackRate,
  );
  const [error, setError] = useState<string | null>(null);

  const activeCue = useMemo(
    () => findActiveAudioCue(cues, currentTime),
    [cues, currentTime],
  );

  const releaseCover = useCallback(() => {
    revokeAudioCoverUrl(coverUrlRef.current);
    coverUrlRef.current = null;
    setCoverUrl(null);
  }, []);

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;
    audio.volume = preferencesRef.current.volume;
    audio.playbackRate = playbackRate;
  }, [audioSrc, playbackRate]);

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;

    const onTimeUpdate = () => setCurrentTime(audio.currentTime);
    const onLoadedMetadata = () => {
      setDuration(Number.isFinite(audio.duration) ? audio.duration : 0);
      setCurrentTime(Number.isFinite(audio.currentTime) ? audio.currentTime : 0);
    };
    const onPlay = () => setIsPlaying(true);
    const onPause = () => setIsPlaying(false);
    const onEnded = () => {
      setIsPlaying(false);
      setCurrentTime(audio.duration);
    };
    const onError = () => {
      setIsPlaying(false);
      setError(STRINGS.playbackError);
    };

    audio.addEventListener('timeupdate', onTimeUpdate);
    audio.addEventListener('loadedmetadata', onLoadedMetadata);
    audio.addEventListener('play', onPlay);
    audio.addEventListener('pause', onPause);
    audio.addEventListener('ended', onEnded);
    audio.addEventListener('error', onError);

    return () => {
      audio.removeEventListener('timeupdate', onTimeUpdate);
      audio.removeEventListener('loadedmetadata', onLoadedMetadata);
      audio.removeEventListener('play', onPlay);
      audio.removeEventListener('pause', onPause);
      audio.removeEventListener('ended', onEnded);
      audio.removeEventListener('error', onError);
    };
  }, []);

  useEffect(() => {
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.defaultPrevented || isInteractiveTarget(event.target)) return;

      if (event.key === ' ') {
        event.preventDefault();
        void togglePlayback();
      } else if (event.key === 'ArrowLeft') {
        event.preventDefault();
        skipBy(event.shiftKey ? -30 : -10);
      } else if (event.key === 'ArrowRight') {
        event.preventDefault();
        skipBy(event.shiftKey ? 30 : 10);
      }
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  });

  useEffect(() => {
    return () => {
      // Invalidate an in-flight parser before releasing the currently shown
      // cover, so a late result cannot install an orphaned object URL.
      coverRequestRef.current += 1;
      revokeUrl(ownedAudioUrlRef.current);
      revokeAudioCoverUrl(coverUrlRef.current);
      coverUrlRef.current = null;
    };
  }, []);

  const togglePlayback = useCallback(async () => {
    const audio = audioRef.current;
    if (!audio || audioSrc === null) return;

    if (audio.paused) {
      try {
        await audio.play();
        setError(null);
      } catch {
        // Browser autoplay policies may reject a play request. The control
        // remains usable and the next explicit tap/click can retry it.
      }
    } else {
      audio.pause();
    }
  }, [audioSrc]);

  const skipBy = useCallback((seconds: number) => {
    const audio = audioRef.current;
    if (!audio || audioSrc === null) return;
    const target = clampAudioSeekTarget(
      audio.currentTime + seconds,
      audio.duration,
    );
    audio.currentTime = target;
    setCurrentTime(target);
  }, [audioSrc]);

  const handleSeek = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => {
      const audio = audioRef.current;
      if (!audio) return;
      const target = clampAudioSeekTarget(Number(event.target.value), duration);
      audio.currentTime = target;
      setCurrentTime(target);
    },
    [duration],
  );

  const handleRateChange = useCallback((event: ChangeEvent<HTMLSelectElement>) => {
    const rate = Number(event.target.value);
    if (!PLAYBACK_RATES.includes(rate)) return;

    setPlaybackRate(rate);
    if (audioRef.current) audioRef.current.playbackRate = rate;

    const nextPreferences = {
      ...preferencesRef.current,
      playbackRate: rate,
    };
    preferencesRef.current = nextPreferences;
    writePlayerPreferences(nextPreferences);
  }, []);

  const handleFileChange = useCallback(
    async (event: ChangeEvent<HTMLInputElement>) => {
      const file = event.target.files?.[0];
      event.target.value = '';
      if (!file) return;

      if (!isAudioFile(file)) {
        setError(STRINGS.unsupportedFile);
        return;
      }

      const audio = audioRef.current;
      audio?.pause();
      setIsPlaying(false);
      setCurrentTime(0);
      setDuration(0);
      setError(null);
      setIsLocalSource(true);
      setTitle(file.name || 'Audio track');
      releaseCover();

      const nextAudioUrl = createMediaUrl(file, ownedAudioUrlRef.current);
      ownedAudioUrlRef.current = nextAudioUrl;
      setAudioSrc(nextAudioUrl);

      const requestId = coverRequestRef.current + 1;
      coverRequestRef.current = requestId;
      const result = await extractAudioCover(file);
      if (requestId !== coverRequestRef.current) {
        revokeAudioCoverUrl(result.coverUrl);
        return;
      }

      setTitle(result.title);
      coverUrlRef.current = result.coverUrl;
      setCoverUrl(result.coverUrl);
    },
    [releaseCover],
  );

  const handleCueClick = useCallback(
    (cue: SubtitleCue) => {
      const audio = audioRef.current;
      if (!audio || audioSrc === null) return;
      const target = clampAudioSeekTarget(cue.start, audio.duration);
      audio.currentTime = target;
      setCurrentTime(target);
    },
    [audioSrc],
  );

  const isSeekable = audioSrc !== null && duration > 0;
  const displayedTime = Number.isFinite(currentTime) ? currentTime : 0;
  const displayedDuration = Number.isFinite(duration) ? duration : 0;
  const coverVideoId = isLocalSource ? null : youtubeVideoId;

  return (
    <section className="audio-player" aria-labelledby="audio-player-title">
      <header className="audio-player__header">
        <div>
          <p className="audio-player__eyebrow">{STRINGS.eyebrow}</p>
          <h1 id="audio-player-title" className="audio-player__title">
            {title}
          </h1>
        </div>
        <label className="audio-player__open-button">
          <FolderOpen size={18} aria-hidden="true" />
          <span>{STRINGS.openFile}</span>
          <input
            className="audio-player__file-input"
            type="file"
            accept="audio/*,.m4b,.m4a,.mp3,.wav,.flac,.aac,.opus"
            aria-label={STRINGS.fileInput}
            onChange={handleFileChange}
          />
        </label>
      </header>

      <div className="audio-player__stage">
        <div className="audio-player__media-panel">
          <div className="audio-player__tabs">
            <ButtonGroup aria-label="Audio display mode">
              <button
                className="audio-player__tab"
                type="button"
                aria-pressed={view === 'subtitle'}
                onClick={() => setView('subtitle')}
              >
                <Captions size={17} aria-hidden="true" />
                {STRINGS.subtitle}
              </button>
              <button
                className="audio-player__tab"
                type="button"
                aria-pressed={view === 'cover'}
                onClick={() => setView('cover')}
              >
                <Image size={17} aria-hidden="true" />
                {STRINGS.cover}
              </button>
            </ButtonGroup>
          </div>

          {view === 'cover' ? (
            <div className="audio-player__cover" aria-label={STRINGS.coverPanel}>
              <AudioCover
                title={title}
                coverUrl={coverUrl}
                youtubeVideoId={coverVideoId}
              />
            </div>
          ) : (
            <section
              className="audio-player__subtitle-panel"
              aria-labelledby="audio-player-subtitle-heading"
            >
              <h2
                id="audio-player-subtitle-heading"
                className="audio-player__panel-heading"
              >
                {STRINGS.subtitlePanel}
              </h2>
              {cues.length > 0 ? (
                <ol className="audio-player__cue-list">
                  {cues.map((cue) => (
                    <li key={cue.id}>
                      <button
                        className="audio-player__cue-button"
                        type="button"
                        aria-current={activeCue?.id === cue.id ? 'true' : undefined}
                        onClick={() => handleCueClick(cue)}
                      >
                        <span className="audio-player__cue-time">
                          {formatTime(cue.start)}
                        </span>
                        <span className="audio-player__cue-text">{cue.text}</span>
                      </button>
                    </li>
                  ))}
                </ol>
              ) : (
                <p className="audio-player__empty">{STRINGS.noSubtitles}</p>
              )}
            </section>
          )}

          <p className="audio-player__now-playing">
            {audioSrc === null ? STRINGS.noTrack : title}
          </p>

          <div className="audio-player__controls">
            <div className="audio-player__seek-wrap">
              <span aria-hidden="true">{formatTime(displayedTime)}</span>
              <input
                className="audio-player__seek"
                type="range"
                min={0}
                max={displayedDuration}
                step={0.1}
                value={Math.min(displayedTime, displayedDuration)}
                disabled={!isSeekable}
                aria-label={STRINGS.seek}
                aria-valuetext={`${formatTime(displayedTime)} / ${formatTime(displayedDuration)}`}
                onChange={handleSeek}
              />
              <span aria-hidden="true">
                {formatTime(displayedDuration)}
              </span>
            </div>

            <div className="audio-player__control-row">
              <button
                className="audio-player__skip"
                type="button"
                disabled={audioSrc === null}
                aria-label={STRINGS.skipBack30}
                title={STRINGS.skipBack30}
                onClick={() => skipBy(-30)}
              >
                <RotateCcw size={17} aria-hidden="true" />
                <span>30</span>
              </button>
              <button
                className="audio-player__skip"
                type="button"
                disabled={audioSrc === null}
                aria-label={STRINGS.skipBack10}
                title={STRINGS.skipBack10}
                onClick={() => skipBy(-10)}
              >
                <RotateCcw size={17} aria-hidden="true" />
                <span>10</span>
              </button>
              <button
                className="audio-player__control audio-player__control--primary"
                type="button"
                disabled={audioSrc === null}
                aria-label={isPlaying ? STRINGS.pause : STRINGS.play}
                title={isPlaying ? STRINGS.pause : STRINGS.play}
                onClick={() => void togglePlayback()}
              >
                {isPlaying ? (
                  <Pause size={23} aria-hidden="true" />
                ) : (
                  <Play size={23} aria-hidden="true" />
                )}
              </button>
              <button
                className="audio-player__skip"
                type="button"
                disabled={audioSrc === null}
                aria-label={STRINGS.skipForward10}
                title={STRINGS.skipForward10}
                onClick={() => skipBy(10)}
              >
                <RotateCw size={17} aria-hidden="true" />
                <span>10</span>
              </button>
              <button
                className="audio-player__skip"
                type="button"
                disabled={audioSrc === null}
                aria-label={STRINGS.skipForward30}
                title={STRINGS.skipForward30}
                onClick={() => skipBy(30)}
              >
                <RotateCw size={17} aria-hidden="true" />
                <span>30</span>
              </button>
            </div>

            <div className="audio-player__bottom-row">
              <span className="audio-player__speed-label">
                <Gauge size={16} aria-hidden="true" /> {STRINGS.playbackSpeed}
              </span>
              <select
                className="audio-player__speed"
                value={playbackRate}
                aria-label={STRINGS.playbackSpeed}
                onChange={handleRateChange}
              >
                {PLAYBACK_RATES.map((rate) => (
                  <option key={rate} value={rate}>
                    {rate}x
                  </option>
                ))}
              </select>
            </div>
          </div>

          {error !== null && (
            <p className="audio-player__status" role="alert">
              {error}
            </p>
          )}
        </div>

      </div>

      <audio
        ref={audioRef}
        src={audioSrc ?? undefined}
        preload="metadata"
        aria-label={`${STRINGS.audioElement}: ${title}`}
      />

    </section>
  );
}
