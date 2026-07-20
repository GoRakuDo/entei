/**
 * PlayerApp — Main React component for the Entei Player.
 * ---------------------------------------------------------------------------
 * P1 scope: local-only vertical slice.
 *
 * Fixes applied:
 * - #1: Latest URL tracked in ref, revoked exactly once on unmount.
 * - #2: Shared HTMLMediaElement ref for both video/audio; active cue clears
 *       when media time is outside every cue.
 * - #3: Volume applied after media element mount for both video and audio.
 * - #4: All raw SVG replaced with lucide-react icons.
 * - #5: SubtitlePanel handles prefers-reduced-motion + aria-current (in SubtitlePanel).
 * - #6: KeyboardShortcutsHelp uses Radix Dialog (in KeyboardShortcutsHelp).
 * - #8: Listens for entei:locale-change CustomEvent, uses typed dictionary.
 * - #9: Persists volume/playbackRate via player preferences module.
 * - #10: isLoading starts false (no media selected), becomes true when
 *   selecting supported media, and is cleared by loadedmetadata or error.
 *        media does not create/leak an object URL.
 * --------------------------------------------------------------------------- */
'use client';

import { useState, useCallback, useRef, useEffect } from 'react';
import {
  type SubtitleCue,
  parseSubtitle,
} from '@/features/player/subtitle-reader';
import {
  createMediaUrl,
  revokeUrl,
  MEDIA_ACCEPT,
  SUBTITLE_ACCEPT,
  isVideoFile,
  isAudioFile,
  isSubtitleFile,
  getFileExtension,
} from '@/features/player/media-url';
import {
  readPlayerPreferences,
  writePlayerPreferences,
} from '@/features/player/preferences';
import {
  type LocaleChangeDetail,
  LOCALE_CHANGE_EVENT,
} from '@i18n/locale-events';
import type { Dictionary } from '@i18n/types';
import { getDictionary } from '@i18n/index';
import { MediaPicker } from '@/components/player/MediaPicker';
import { SubtitlePicker } from '@/components/player/SubtitlePicker';
import { VideoPlayer } from '@/components/player/VideoPlayer';
import { SubtitlePanel } from '@/components/player/SubtitlePanel';
import { KeyboardShortcutsHelp } from '@/components/player/KeyboardShortcutsHelp';
import { Slider } from '@/components/player/ui/slider';
import { useKeyboardShortcuts } from '@/features/player/use-keyboard-shortcuts';
import {
  Play,
  Pause,
  Music,
  AlertTriangle,
} from 'lucide-react';

/**
 * Derive initial locale from document. This runs once at mount.
 * The locale-switcher script (vanilla) has already applied the correct locale
 * to the DOM by the time React hydrates.
 */
function getInitialLocale(): 'id' | 'ja' | 'en' {
  const lang = document.documentElement.lang;
  if (lang === 'ja' || lang === 'en') return lang;
  return 'id';
}

function getDictionaryFor(locale: 'id' | 'ja' | 'en'): Dictionary {
  return getDictionary(locale);
}

export default function PlayerApp() {
  // --- Locale (Fix #8) ---
  const [locale, setLocale] = useState<'id' | 'ja' | 'en'>(getInitialLocale);
  const dictRef = useRef<Dictionary>(getDictionaryFor(locale));
  dictRef.current = getDictionaryFor(locale);

  // Listen for locale changes from the vanilla locale-switcher
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent<LocaleChangeDetail>).detail;
      if (detail?.locale) {
        setLocale(detail.locale);
        dictRef.current = detail.dictionary;
      }
    };
    window.addEventListener(LOCALE_CHANGE_EVENT, handler);
    return () => window.removeEventListener(LOCALE_CHANGE_EVENT, handler);
  }, []);

  // --- Preferences (Fix #9) ---
  const prefsRef = useRef(readPlayerPreferences());

  // --- Media state ---
  // #1: Single active URL tracked in ref for unmount cleanup.
  const activeUrlRef = useRef<string | null>(null);
  const [mediaUrl, setMediaUrl] = useState<string | null>(null);
  const [mediaType, setMediaType] = useState<'video' | 'audio' | null>(null);
  const [mediaName, setMediaName] = useState<string>('');
  // #10: isLoading starts false (no media selected). Set true when a supported
  // file is chosen; cleared only by loadedmetadata or error.
  const [isLoading, setIsLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  // --- Subtitle state ---
  const [cues, setCues] = useState<SubtitleCue[]>([]);
  const [subtitleErrors, setSubtitleErrors] = useState<
    { line: number; message: string }[]
  >([]);
  const [subtitleName, setSubtitleName] = useState('');
  const [activeCueId, setActiveCueId] = useState<number | null>(null);

  // --- Playback state ---
  const [isPlaying, setIsPlaying] = useState(false);
  const [playbackRate, setPlaybackRate] = useState(prefsRef.current.playbackRate);
  const [volume, setVolume] = useState(prefsRef.current.volume);

  // --- Refs ---
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const mediaContainerRef = useRef<HTMLDivElement>(null);
  // #2: Shared ref for keyboard shortcuts and cue seeking.
  const sharedMediaRef = useRef<HTMLMediaElement | null>(null);

  // #1: Cleanup on unmount — revoke the actual active URL tracked in ref.
  useEffect(() => {
    return () => {
      revokeUrl(activeUrlRef.current);
      activeUrlRef.current = null;
    };
  }, []);

  // #2: Keep sharedMediaRef synced to the current active media element.
  useEffect(() => {
    if (mediaType === 'video') {
      sharedMediaRef.current = videoRef.current;
    } else if (mediaType === 'audio') {
      sharedMediaRef.current = audioRef.current;
    } else {
      sharedMediaRef.current = null;
    }
  }, [mediaType, mediaUrl]);

  // #3: Apply volume after media element mount.
  useEffect(() => {
    const media = sharedMediaRef.current;
    if (!media) return;
    media.volume = volume;
  }, [volume, mediaUrl, mediaType]);

  // #3: Apply playback rate after media element mount.
  useEffect(() => {
    const media = sharedMediaRef.current;
    if (!media) return;
    media.playbackRate = playbackRate;
  }, [playbackRate, mediaUrl, mediaType]);

  // --- Handle media file selection (Fix #10) ---
  const handleMediaSelect = useCallback(
    (file: File) => {
      // #10: Validate format BEFORE creating object URL.
      let type: 'video' | 'audio' | null = null;
      if (isVideoFile(file)) {
        type = 'video';
      } else if (isAudioFile(file)) {
        type = 'audio';
      } else {
        // #10: Do not create/leak an object URL for unsupported files.
        setLoadError(
          `${dictRef.current.playerUI.unsupportedFormat}: .${getFileExtension(file)}`,
        );
        setIsLoading(false);
        return;
      }

      setIsLoading(true);
      setLoadError(null);
      setActiveCueId(null);

      // #1: Create new URL and revoke old one atomically.
      const oldUrl = activeUrlRef.current;
      const newUrl = createMediaUrl(file, oldUrl);
      activeUrlRef.current = newUrl;
      setMediaUrl(newUrl);
      setMediaType(type);
      setMediaName(file.name);
      // #10: isLoading remains true until loadedmetadata or error fires.
    },
    [],
  );

  // --- Handle subtitle file selection ---
  const handleSubtitleSelect = useCallback((file: File) => {
    setSubtitleErrors([]);

    if (!isSubtitleFile(file)) {
      const p = dictRef.current.playerUI;
      setSubtitleErrors([
        {
          line: 0,
          message: `${p.unsupportedFormat}: .${getFileExtension(file)}`,
        },
      ]);
      return;
    }

    const reader = new FileReader();
    reader.onload = (e) => {
      const content = e.target?.result;
      if (typeof content !== 'string') {
        setSubtitleErrors([
          { line: 0, message: dictRef.current.playerUI.failedToRead },
        ]);
        return;
      }

      const result = parseSubtitle(content);
      setCues(result.cues);
      setSubtitleErrors(result.errors);
      setSubtitleName(file.name);
      setActiveCueId(null);
    };
    reader.onerror = () => {
      setSubtitleErrors([
        { line: 0, message: dictRef.current.playerUI.failedToRead },
      ]);
    };
    reader.readAsText(file);
  }, []);

  // --- Handle seeking to a cue (#2: works for both video and audio) ---
  const handleCueClick = useCallback(
    (cue: SubtitleCue) => {
      const media = sharedMediaRef.current;
      if (!media) return;
      media.currentTime = cue.start;
      media.play().catch(() => {
        // Autoplay may be blocked — ignore
      });
    },
    [],
  );

  // --- Handle time update (#2: clears active cue when outside all cues) ---
  const handleTimeUpdate = useCallback(
    (time: number) => {
      const active = cues.find(
        (cue) => time >= cue.start && time < cue.end,
      );
      setActiveCueId(active?.id ?? null);
    },
    [cues],
  );

  // --- Handle playback state changes ---
  const handlePlay = useCallback(() => setIsPlaying(true), []);
  const handlePause = useCallback(() => setIsPlaying(false), []);

  // --- Handle media loaded (#10) ---
  const handleLoaded = useCallback(() => {
    setIsLoading(false);
    setLoadError(null);
  }, []);

  // --- Handle media error (#10) ---
  const handleError = useCallback((error: string) => {
    setIsLoading(false);
    setLoadError(error);
  }, []);

  // --- Persist volume changes (Fix #9) ---
  const handleVolumeChange = useCallback((val: number) => {
    setVolume(val);
    writePlayerPreferences({ volume: val, playbackRate: prefsRef.current.playbackRate });
    prefsRef.current = { ...prefsRef.current, volume: val };
  }, []);

  // --- Persist playback rate changes (Fix #9) ---
  const handlePlaybackRateChange = useCallback((rate: number) => {
    setPlaybackRate(rate);
    writePlayerPreferences({ volume: prefsRef.current.volume, playbackRate: rate });
    prefsRef.current = { ...prefsRef.current, playbackRate: rate };
  }, []);

  // --- Keyboard shortcuts (#2: sharedMediaRef for both video/audio) ---
  useKeyboardShortcuts({
    videoRef: sharedMediaRef,
    cues,
    activeCueId,
    playbackRate,
    setPlaybackRate: handlePlaybackRateChange,
    onCueClick: handleCueClick,
    enabled: true,
  });

  // --- Drag and drop ---
  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
  }, []);

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      e.stopPropagation();

      const files = Array.from(e.dataTransfer.files);
      for (const file of files) {
        if (isSubtitleFile(file)) {
          handleSubtitleSelect(file);
        } else if (isVideoFile(file) || isAudioFile(file)) {
          handleMediaSelect(file);
        }
      }
    },
    [handleMediaSelect, handleSubtitleSelect],
  );

  const dict = dictRef.current.playerUI;
  const hasMedia = mediaUrl !== null;

  return (
    <div
      ref={mediaContainerRef}
      className="entei-player-container"
      onDragOver={handleDragOver}
      onDrop={handleDrop}
      data-entei-player-root=""
    >
      {/* --- Empty state: file pickers --- */}
      {!hasMedia && (
        <div className="entei-player-empty">
          <div className="entei-player-empty-inner">
            <h2 className="entei-player-empty-title">
              {dict.selectMediaTitle}
            </h2>
            <p className="entei-player-empty-desc">{dict.selectMediaDesc}</p>
            <div className="entei-player-pickers">
              <MediaPicker
                onSelect={handleMediaSelect}
                accept={MEDIA_ACCEPT}
                label={dict.chooseMedia}
              />
              <SubtitlePicker
                onSelect={handleSubtitleSelect}
                accept={SUBTITLE_ACCEPT}
                label={dict.chooseSubtitle}
                disabled
              />
            </div>
          </div>
        </div>
      )}

      {/* --- Active state: media + subtitles --- */}
      {hasMedia && (
        <div className="entei-player-layout">
          {/* Media area */}
          <div className="entei-player-media-area">
            {mediaType === 'video' && (
              <VideoPlayer
                ref={videoRef}
                src={mediaUrl}
                isLoading={isLoading}
                error={loadError}
                fallbackErrorLabel={dict.failedToLoadVideo}
                onTimeUpdate={handleTimeUpdate}
                onPlay={handlePlay}
                onPause={handlePause}
                onLoaded={handleLoaded}
                onError={handleError}
              />
            )}
            {mediaType === 'audio' && (
              <div className="entei-player-audio-area">
                <div className="entei-player-audio-visual">
                  <div className="entei-player-audio-icon">
                    <Music size={64} />
                  </div>
                  <p className="entei-player-audio-name">{mediaName}</p>
                </div>
                {/* Hidden audio element for playback */}
                <audio
                  ref={audioRef}
                  src={mediaUrl}
                  onTimeUpdate={(e) =>
                    handleTimeUpdate(e.currentTarget.currentTime)
                  }
                  onPlay={handlePlay}
                  onPause={handlePause}
                  onLoadedData={handleLoaded}
                  onError={(e) => {
                    const mediaError = e.currentTarget.error;
                    handleError(
                      mediaError?.message ?? dict.failedToLoadAudio,
                    );
                  }}
                  preload="metadata"
                />
                {/* Audio controls */}
                <div className="entei-player-audio-controls">
                  <button
                    className="entei-player-btn"
                    onClick={() => {
                      const media = audioRef.current;
                      if (!media) return;
                      if (isPlaying) {
                        media.pause();
                      } else {
                        media.play().catch(() => {});
                      }
                    }}
                    aria-label={isPlaying ? dict.pauseLabel : dict.playLabel}
                  >
                    {isPlaying ? <Pause size={20} /> : <Play size={20} />}
                  </button>
                  <span className="entei-player-volume-label">
                    {dict.volumeLabel}
                  </span>
                  <Slider
                    className="entei-player-volume-slider"
                    value={[volume]}
                    onValueChange={(vals) => handleVolumeChange(vals[0] ?? 0)}
                    min={0}
                    max={1}
                    step={0.01}
                    aria-label={dict.volumeLabel}
                  />
                </div>
                {/* Loading overlay for audio */}
                {isLoading && (
                  <div className="entei-player-loading-overlay entei-player-audio-loading">
                    <div className="entei-player-skeleton entei-player-skeleton--audio" />
                  </div>
                )}
              </div>
            )}

            {/* Subtitle picker + shortcuts row */}
            <div className="entei-player-subtitle-row">
              <SubtitlePicker
                onSelect={handleSubtitleSelect}
                accept={SUBTITLE_ACCEPT}
                label={subtitleName || dict.chooseSubtitle}
                compact
              />
              <KeyboardShortcutsHelp
                label={dict.shortcuts}
                dialogTitle={dict.shortcutsTitle}
                dialogDescription={dict.shortcutsDesc}
                showAriaLabel={dict.showShortcutsAriaLabel}
                closeLabel={dict.dialogClose}
                shortcuts={[
                  { key: 'Space', desc: dict.shortcutPlayPause },
                  { key: '\u2190', desc: dict.shortcutPrevCue },
                  { key: '\u2192', desc: dict.shortcutNextCue },
                  { key: 'Home', desc: dict.shortcutSeekHome },
                  { key: '[', desc: dict.shortcutSlowDown },
                  { key: ']', desc: dict.shortcutSpeedUp },
                ]}
              />
            </div>
          </div>

          {/* Subtitle panel (always shown when media is loaded) */}
          <SubtitlePanel
            cues={cues}
            activeCueId={activeCueId}
            onCueClick={handleCueClick}
            subtitlesLabel={dict.subtitles}
            cuesCountLabel={dict.cuesCount}
            noSubtitlesLabel={dict.noSubtitlesLoaded}
            seekToLabel={dict.seekTo}
          />

          {/* Subtitle errors / warnings */}
          {subtitleErrors.length > 0 && (
            <div className="entei-player-errors">
              <p className="entei-player-errors-title">
                <AlertTriangle size={14} className="entei-player-errors-icon" />
                {dict.subtitleWarnings}:
              </p>
              <ul className="entei-player-errors-list">
                {subtitleErrors.map((err, i) => (
                  <li key={i}>
                    {err.line > 0 ? `${dict.linePrefix} ${err.line}: ` : ''}
                    {err.message}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
