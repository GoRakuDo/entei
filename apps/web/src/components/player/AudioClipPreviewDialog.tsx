/**
 * AudioClipPreviewDialog — AM-3 preview for recorded audio clips.
 * ---------------------------------------------------------------------------
 * Shows a custom audio preview with play/pause + timestamp.
 * No raw browser `<audio controls>` bar. Uses a hidden `<audio>` element.
 * States: recording, error, success.
 * Controlled via Dialog onOpenChange. Cleanup revokes object URL on close.
 * --------------------------------------------------------------------------- */

'use client';

import { useEffect, useState, useCallback } from 'react';
import { Play, Pause, AudioLines, RotateCcw } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/player/ui/dialog';
import { formatTime } from '@/features/player/control-helpers';

interface AudioClipPreviewDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  audioUrl: string | null;
  expectedDuration: number;
  error: boolean;
  onRetry: () => void;
  onClose: () => void;
  isRecording: boolean;
  dict: {
    audioClipPreviewTitle: string;
    audioClipRecording: string;
    audioClipRetry: string;
    audioClipClose: string;
    audioClipError: string;
    audioClipNoPreview: string;
    audioClipPlay: string;
    audioClipPause: string;
    dialogClose: string;
  };
}

/** Determine if a number is a usable finite positive duration. */
function isValidDuration(d: number): boolean {
  return typeof d === 'number' && Number.isFinite(d) && d > 0;
}

export function AudioClipPreviewDialog({
  open,
  onOpenChange,
  audioUrl,
  expectedDuration,
  error,
  onRetry,
  onClose,
  isRecording,
  dict,
}: AudioClipPreviewDialogProps) {
  const [audioElement, setAudioElement] = useState<HTMLAudioElement | null>(
    null,
  );
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(() =>
    isValidDuration(expectedDuration) ? expectedDuration : 0,
  );

  const hasAudio = audioUrl !== null;
  const hasError = error;

  // Sync playback state from the hidden audio element
  useEffect(() => {
    const audio = audioElement;
    if (!audio) return;

    const onPlay = () => setIsPlaying(true);
    const onPause = () => setIsPlaying(false);
    const onTimeUpdate = () => setCurrentTime(audio.currentTime);
    const onDurationChange = () => {
      if (isValidDuration(audio.duration)) {
        setDuration(audio.duration);
      }
    };
    const onLoadedMetadata = () => {
      if (isValidDuration(audio.duration)) {
        setDuration(audio.duration);
      }
    };
    const onEnded = () => setIsPlaying(false);

    audio.addEventListener('play', onPlay);
    audio.addEventListener('pause', onPause);
    audio.addEventListener('timeupdate', onTimeUpdate);
    audio.addEventListener('durationchange', onDurationChange);
    audio.addEventListener('loadedmetadata', onLoadedMetadata);
    audio.addEventListener('ended', onEnded);

    return () => {
      audio.removeEventListener('play', onPlay);
      audio.removeEventListener('pause', onPause);
      audio.removeEventListener('timeupdate', onTimeUpdate);
      audio.removeEventListener('durationchange', onDurationChange);
      audio.removeEventListener('loadedmetadata', onLoadedMetadata);
      audio.removeEventListener('ended', onEnded);
    };
  }, [audioElement]);

  // Reset state when URL changes or dialog opens
  useEffect(() => {
    if (open) {
      setCurrentTime(0);
      setIsPlaying(false);
      setDuration(isValidDuration(expectedDuration) ? expectedDuration : 0);
      if (audioElement) {
        audioElement.currentTime = 0;
      }
    }
  }, [open, audioUrl, expectedDuration, audioElement]);

  const togglePlay = useCallback(() => {
    const audio = audioElement;
    if (!audio) return;
    if (audio.paused) {
      audio.play().catch(() => {
        // ignore autoplay restriction
      });
    } else {
      audio.pause();
    }
  }, [audioElement]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="entei-audio-clip-dialog"
        closeLabel={dict.dialogClose}
      >
        <DialogHeader>
          <DialogTitle>{dict.audioClipPreviewTitle}</DialogTitle>
          <DialogDescription>
            {hasError ? dict.audioClipError : ''}
          </DialogDescription>
        </DialogHeader>

        <div className="entei-audio-clip-body">
          {isRecording && (
            <div
              className="entei-audio-clip-recording"
              role="status"
              aria-live="polite"
            >
              <AudioLines
                className="entei-audio-clip-recording-icon"
                aria-hidden
              />
              <span>{dict.audioClipRecording}</span>
            </div>
          )}

          {hasError && !isRecording && (
            <div className="entei-audio-clip-error" role="alert">
              <p>{dict.audioClipError}</p>
            </div>
          )}

          {hasAudio && !hasError && !isRecording && (
            <div className="entei-audio-clip-player">
              {/* Hidden audio element — no native controls */}
              <audio
                ref={setAudioElement}
                src={audioUrl}
                preload="metadata"
                className="entei-audio-clip-native"
                data-testid="audio-clip-audio"
              />

              <div className="entei-audio-clip-controls">
                <button
                  type="button"
                  className="entei-audio-clip-play-btn"
                  onClick={togglePlay}
                  aria-label={
                    isPlaying ? dict.audioClipPause : dict.audioClipPlay
                  }
                  title={isPlaying ? dict.audioClipPause : dict.audioClipPlay}
                >
                  {isPlaying ? (
                    <Pause size={20} aria-hidden />
                  ) : (
                    <Play size={20} aria-hidden />
                  )}
                </button>

                <span className="entei-audio-clip-time" aria-live="off">
                  {formatTime(currentTime)} / {formatTime(duration)}
                </span>
              </div>
            </div>
          )}

          {!hasAudio && !hasError && !isRecording && (
            <div className="entei-audio-clip-placeholder">
              <p>{dict.audioClipNoPreview}</p>
            </div>
          )}
        </div>

        <div className="entei-audio-clip-footer">
          {hasError && !isRecording && (
            <button
              type="button"
              className="entei-dialog-footer-btn entei-dialog-footer-btn--primary"
              onClick={onRetry}
              disabled={isRecording}
              aria-label={
                isRecording ? dict.audioClipRecording : dict.audioClipRetry
              }
              title={
                isRecording ? dict.audioClipRecording : dict.audioClipRetry
              }
            >
              <RotateCcw size={16} aria-hidden />
              {dict.audioClipRetry}
            </button>
          )}
          <button
            type="button"
            className="entei-dialog-footer-btn"
            onClick={onClose}
          >
            {dict.audioClipClose}
          </button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
