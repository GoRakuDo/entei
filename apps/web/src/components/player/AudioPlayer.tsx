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
import {
  LOCALE_CHANGE_EVENT,
  type LocaleChangeDetail,
} from '@i18n/locale-events';
import { getDictionary } from '@i18n/index';
import type { Locale } from '@i18n/types';
import { AudioCover } from '@/features/player/audio-cover/AudioCover';
import {
  extractAudioCover,
  revokeAudioCoverUrl,
} from '@/features/player/audio-cover/audio-cover';
import { Button } from '@/components/player/ui/button';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/player/ui/dialog';
import { Input } from '@/components/player/ui/input';
import { TypewriterLoading } from '@/components/player/TypewriterLoading';
import { YouTubeMark } from '@/components/player/YouTubeMark';
import {
  parseYouTubeVideoId,
  sanitizeYouTubeUrl,
} from '@/components/player/YouTubeInput';
import { isFirefox } from '@/features/player/browser-detect';
import { notifyFirefoxUnsupported } from '@/features/player/eizouden-toast';
import { waitForPlayable } from '@/features/player/companion-media';
import { useCompanionJobSession } from '@/features/player/use-companion-job-session';
import { useCompanionPairing } from '@/features/player/use-companion-pairing';
import { COMPANION_PAIRING_BASE_URL } from '@/features/player/companion-pairing-store';
import './AudioPlayer.css';

function getInitialLocale(): Locale {
  const lang = document.documentElement.lang;
  if (lang === 'ja' || lang === 'en') return lang;
  return 'id';
}

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

type YouTubeAudioError =
  | 'invalid'
  | 'repair'
  | 'conflict'
  | 'network'
  | 'generic'
  | null;

export default function AudioPlayer({
  src = null,
  title: suppliedTitle,
  youtubeVideoId: suppliedYouTubeVideoId = null,
  cues = [],
}: AudioPlayerProps) {
  const [locale, setLocale] = useState<Locale>(getInitialLocale);
  const dictionary = getDictionary(locale);
  const t = dictionary.audioPlayer;
  const youtubeDict = dictionary.playerUI;
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const ownedAudioUrlRef = useRef<string | null>(null);
  const youtubeWaitAbortRef = useRef<AbortController | null>(null);
  const youtubeDialogOpenRef = useRef(false);
  const mountedRef = useRef(true);
  const pairing = useCompanionPairing();
  const jobSession = useCompanionJobSession();
  const coverUrlRef = useRef<string | null>(null);
  const coverRequestRef = useRef(0);
  const preferencesRef = useRef<PlayerPreferences>(readPlayerPreferences());
  const [audioSrc, setAudioSrc] = useState<string | null>(src);
  const [title, setTitle] = useState(suppliedTitle ?? '');
  const [youtubeVideoId, setYoutubeVideoId] = useState<string | null>(
    suppliedYouTubeVideoId,
  );
  const [coverUrl, setCoverUrl] = useState<string | null>(null);
  const [isLocalSource, setIsLocalSource] = useState(false);
  const [isYouTubeDialogOpen, setIsYouTubeDialogOpen] = useState(false);
  const [youtubeUrl, setYouTubeUrl] = useState('');
  const [youtubeSubmitting, setYouTubeSubmitting] = useState(false);
  const [youtubeError, setYouTubeError] = useState<YouTubeAudioError>(null);
  const [view, setView] = useState<'cover' | 'subtitle'>('cover');
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [playbackRate, setPlaybackRate] = useState(
    preferencesRef.current.playbackRate,
  );
  const [error, setError] = useState<
    'unsupportedFile' | 'playbackError' | null
  >(null);

  useEffect(() => {
    const handler = (event: Event) => {
      const detail = (event as CustomEvent<LocaleChangeDetail>).detail;
      if (detail?.locale) setLocale(detail.locale);
    };
    window.addEventListener(LOCALE_CHANGE_EVENT, handler);
    return () => window.removeEventListener(LOCALE_CHANGE_EVENT, handler);
  }, []);

  const displayTitle = title || t.defaultTitle;
  const errorMessage = error === null ? null : t[error];
  const youtubeErrorMessage =
    youtubeError === null
      ? null
      : youtubeError === 'invalid'
        ? youtubeDict.youtubeInputErrorInvalid
        : youtubeError === 'repair'
          ? youtubeDict.youtubeInputErrorRepair
          : youtubeError === 'conflict'
            ? youtubeDict.youtubeInputErrorConflict
            : youtubeError === 'network'
              ? youtubeDict.youtubeInputErrorNetwork
              : youtubeDict.youtubeInputErrorGeneric;

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
      setError('playbackError');
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
    if (!audio) return;

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
  }, []);

  const skipBy = useCallback((seconds: number) => {
    const audio = audioRef.current;
    if (!audio) return;
    const target = clampAudioSeekTarget(
      audio.currentTime + seconds,
      audio.duration,
    );
    audio.currentTime = target;
    setCurrentTime(target);
  }, []);

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

  const handleYouTubeSubmit = useCallback(async () => {
    const token = pairing.tokenRef.current;
    if (!pairing.connected || !token) return;
    if (isFirefox()) {
      notifyFirefoxUnsupported(youtubeDict.firefoxUnsupported);
      return;
    }

    const sanitizedUrl = sanitizeYouTubeUrl(youtubeUrl);
    const videoId = parseYouTubeVideoId(sanitizedUrl);
    if (videoId === null) {
      setYouTubeError('invalid');
      return;
    }

    void jobSession.cancelActiveJob();
    setYouTubeSubmitting(true);
    setYouTubeError(null);
    youtubeWaitAbortRef.current?.abort();
    const waitAbort = new AbortController();
    youtubeWaitAbortRef.current = waitAbort;

    try {
      const response = await fetch(
        `${COMPANION_PAIRING_BASE_URL}/v1/source/jobs?token=${encodeURIComponent(token)}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ url: sanitizedUrl, mode: 'audio' }),
          cache: 'no-store',
        },
      );
      if (response.status !== 201) {
        setYouTubeError(
          response.status === 400
            ? 'invalid'
            : response.status === 401 || response.status === 403
              ? 'repair'
              : response.status === 409
                ? 'conflict'
                : 'generic',
        );
        return;
      }

      const body = (await response.json()) as {
        id?: unknown;
        title?: unknown;
      };
      if (typeof body.id !== 'string' || body.id.length === 0) {
        setYouTubeError('generic');
        return;
      }

      const playable = await waitForPlayable(token, { signal: waitAbort.signal });
      if (!playable.ok) {
        if (playable.reason === 'aborted') return;
        setYouTubeError(playable.reason === 'network' ? 'network' : 'generic');
        return;
      }
      if (!mountedRef.current || !youtubeDialogOpenRef.current) return;

      const audio = audioRef.current;
      audio?.pause();
      setIsPlaying(false);
      setCurrentTime(0);
      setDuration(0);
      setError(null);
      setIsLocalSource(false);
      setYoutubeVideoId(videoId);
      setTitle(typeof body.title === 'string' ? body.title : t.defaultTitle);
      releaseCover();
      revokeUrl(ownedAudioUrlRef.current);
      ownedAudioUrlRef.current = null;
      // waitForPlayable has confirmed that the fixture has playable bytes;
      // the companion session then keeps the URL/status bridge alive.
      setAudioSrc(
        `${COMPANION_PAIRING_BASE_URL}/v1/media/fixture?token=${encodeURIComponent(token)}`,
      );
      jobSession.beginJobSession({
        baseUrl: COMPANION_PAIRING_BASE_URL,
        token,
        jobId: body.id,
        kind: 'youtube',
      });
      setYouTubeUrl('');
      setYouTubeError(null);
      setIsYouTubeDialogOpen(false);
    } catch {
      if (!waitAbort.signal.aborted) setYouTubeError('network');
    } finally {
      if (mountedRef.current) setYouTubeSubmitting(false);
    }
  }, [
    jobSession,
    pairing.connected,
    pairing.tokenRef,
    releaseCover,
    t.defaultTitle,
    youtubeDict,
    youtubeUrl,
  ]);

  useEffect(() => {
    youtubeDialogOpenRef.current = isYouTubeDialogOpen;
    if (!isYouTubeDialogOpen) youtubeWaitAbortRef.current?.abort();
  }, [isYouTubeDialogOpen]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      youtubeWaitAbortRef.current?.abort();
    };
  }, []);

  useEffect(() => {
    if (jobSession.jobTitle) setTitle(jobSession.jobTitle);
  }, [jobSession.jobTitle]);

  // The shared session hook still exposes a video-typed callback for
  // PlayerApp, but its bridge adapter consumes any HTMLMediaElement. Invoke
  // that runtime contract without falsely asserting that audio is video.
  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;
    Reflect.apply(jobSession.attachMediaElement, undefined, [audio]);
  }, [audioSrc, jobSession.attachMediaElement, jobSession.phase]);

  const handleFileChange = useCallback(
    async (event: ChangeEvent<HTMLInputElement>) => {
      const file = event.target.files?.[0];
      event.target.value = '';
      if (!file) return;

      if (!isAudioFile(file)) {
        setError('unsupportedFile');
        return;
      }

      const audio = audioRef.current;
      audio?.pause();
      setIsPlaying(false);
      setCurrentTime(0);
      setDuration(0);
      void jobSession.cancelActiveJob();
      setError(null);
      setIsLocalSource(true);
      setYoutubeVideoId(null);
      setTitle(file.name || '');
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
    [jobSession, releaseCover],
  );

  const handleCueClick = useCallback(
    (cue: SubtitleCue) => {
      const audio = audioRef.current;
      if (!audio) return;
      const target = clampAudioSeekTarget(cue.start, audio.duration);
      audio.currentTime = target;
      setCurrentTime(target);
    },
    [],
  );

  const isSeekable = duration > 0;
  const displayedTime = Number.isFinite(currentTime) ? currentTime : 0;
  const displayedDuration = Number.isFinite(duration) ? duration : 0;
  const coverVideoId = isLocalSource ? null : youtubeVideoId;
  const filePicker = (
    <div className="audio-player__entry-actions">
      <button
        className="audio-player__open-button"
        type="button"
        onClick={() => fileInputRef.current?.click()}
      >
        <FolderOpen size={18} aria-hidden="true" />
        <span>{t.openFile}</span>
      </button>
      <button
        className="audio-player__youtube-button"
        type="button"
        onClick={() => setIsYouTubeDialogOpen(true)}
        disabled={!pairing.connected}
        aria-label={t.youtube}
        title={t.youtube}
      >
        <YouTubeMark width={19} height={19} />
      </button>
      <input
        ref={fileInputRef}
        className="audio-player__file-input"
        type="file"
        accept="audio/*,.m4b,.m4a,.mp3,.wav,.flac,.aac,.opus"
        aria-label={t.fileInput}
        onChange={handleFileChange}
      />
    </div>
  );
  const youtubeDialog = (
    <Dialog
      open={isYouTubeDialogOpen}
      onOpenChange={(open) => {
        setIsYouTubeDialogOpen(open);
        if (open) {
          setYouTubeUrl('');
          setYouTubeError(null);
        }
      }}
    >
      <DialogContent closeLabel={youtubeDict.dialogClose}>
        <DialogHeader>
          <DialogTitle className="entei-magnet-dialog-title">
            <YouTubeMark width={16} height={16} aria-hidden="true" />
            {youtubeDict.youtubeInputTitle}
          </DialogTitle>
        </DialogHeader>
        {pairing.connected ? (
          <div className="entei-youtube-form">
            <Input
              type="url"
              inputMode="url"
              autoComplete="off"
              placeholder={youtubeDict.youtubeInputPlaceholder}
              aria-label={youtubeDict.youtubeInputLabel}
              aria-invalid={youtubeError !== null}
              value={youtubeUrl}
              onChange={(event) => setYouTubeUrl(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && !youtubeSubmitting) {
                  void handleYouTubeSubmit();
                }
              }}
            />
            {youtubeErrorMessage !== null && (
              <p className="entei-youtube-form-error" role="alert">
                {youtubeErrorMessage}
              </p>
            )}
            <Button
              type="button"
              className="entei-youtube-form-submit"
              onClick={() => void handleYouTubeSubmit()}
              disabled={youtubeSubmitting || youtubeUrl.trim() === ''}
              aria-label={youtubeDict.youtubeInputSubmit}
            >
              {youtubeSubmitting ? (
                <TypewriterLoading
                  aria-hidden="true"
                  className="entei-typewriter--btn"
                />
              ) : (
                youtubeDict.youtubeInputSubmit
              )}
            </Button>
          </div>
        ) : null}
      </DialogContent>
    </Dialog>
  );

  if (audioSrc === null) {
    return (
      <section className="audio-player" aria-labelledby="audio-player-title">
        {/* This must stay the first child in both branches so the listener effect survives reconciliation. */}
        <audio
          ref={audioRef}
          src={audioSrc ?? undefined}
          preload="metadata"
          aria-label={`${t.audioElement}: ${displayTitle}`}
        />

        <div className="audio-player__empty-state">
          <h1 id="audio-player-title" className="audio-player__title">
            {t.noTrack}
          </h1>
          {filePicker}
          {youtubeDialog}
          <p className="audio-player__formats">{t.acceptedFormats}</p>
          {errorMessage !== null && (
            <p className="audio-player__status" role="alert">
              {errorMessage}
            </p>
          )}
        </div>
      </section>
    );
  }

  return (
    <section className="audio-player" aria-labelledby="audio-player-title">
      <audio
        ref={audioRef}
        src={audioSrc}
        preload="metadata"
        aria-label={`${t.audioElement}: ${displayTitle}`}
      />

      <h1 id="audio-player-title" className="entei-sr-only">
        {displayTitle}
      </h1>

      <div className="audio-player__entry-bar">
        {filePicker}
        {youtubeDialog}
      </div>

      <div className="audio-player__stage">
        <div className="audio-player__media-panel">
          <div className="audio-player__tabs">
            <ButtonGroup aria-label={t.displayMode}>
              <button
                className="audio-player__tab"
                type="button"
                aria-pressed={view === 'subtitle'}
                onClick={() => setView('subtitle')}
              >
                <Captions size={17} aria-hidden="true" />
                {t.subtitle}
              </button>
              <button
                className="audio-player__tab"
                type="button"
                aria-pressed={view === 'cover'}
                onClick={() => setView('cover')}
              >
                <Image size={17} aria-hidden="true" />
                {t.cover}
              </button>
            </ButtonGroup>
          </div>

          {view === 'cover' ? (
            <div className="audio-player__cover" aria-label={t.coverPanel}>
              <AudioCover
                title={displayTitle}
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
                {t.subtitlePanel}
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
                <p className="audio-player__empty">{t.noSubtitles}</p>
              )}
            </section>
          )}

          <p className="audio-player__now-playing">{displayTitle}</p>

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
                aria-label={t.seek}
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
                aria-label={t.skipBack30}
                title={t.skipBack30}
                onClick={() => skipBy(-30)}
              >
                <RotateCcw size={17} aria-hidden="true" />
                <span>30</span>
              </button>
              <button
                className="audio-player__skip"
                type="button"
                aria-label={t.skipBack10}
                title={t.skipBack10}
                onClick={() => skipBy(-10)}
              >
                <RotateCcw size={17} aria-hidden="true" />
                <span>10</span>
              </button>
              <button
                className="audio-player__control audio-player__control--primary"
                type="button"
                aria-label={isPlaying ? t.pause : t.play}
                title={isPlaying ? t.pause : t.play}
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
                aria-label={t.skipForward10}
                title={t.skipForward10}
                onClick={() => skipBy(10)}
              >
                <RotateCw size={17} aria-hidden="true" />
                <span>10</span>
              </button>
              <button
                className="audio-player__skip"
                type="button"
                aria-label={t.skipForward30}
                title={t.skipForward30}
                onClick={() => skipBy(30)}
              >
                <RotateCw size={17} aria-hidden="true" />
                <span>30</span>
              </button>
            </div>

            <div className="audio-player__bottom-row">
              <span className="audio-player__speed-label">
                <Gauge size={16} aria-hidden="true" /> {t.playbackSpeed}
              </span>
              <select
                className="audio-player__speed"
                value={playbackRate}
                aria-label={t.playbackSpeed}
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

          {errorMessage !== null && (
            <p className="audio-player__status" role="alert">
              {errorMessage}
            </p>
          )}
        </div>

      </div>
    </section>
  );
}
