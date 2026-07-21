/**
 * VideoPlayer — Video element WITHOUT native controls (P1.1).
 * Custom controls are provided by PlayerControls via PlayerApp.
 */
'use client';

import { forwardRef, useCallback } from 'react';
import { classifyMediaError } from '@/features/player/media-url';

interface VideoPlayerProps {
  src: string;
  isLoading: boolean;
  error: string | null;
  errorLabel?: string;
  decodeErrorLabel?: string;
  onTimeUpdate: (time: number) => void;
  onPlay: () => void;
  onPause: () => void;
  onLoaded: () => void;
  onError: (error: string) => void;
}

export const VideoPlayer = forwardRef<HTMLVideoElement, VideoPlayerProps>(
  function VideoPlayer(
    {
      src,
      isLoading,
      error,
      errorLabel = 'Failed to load video',
      decodeErrorLabel = 'Video playback error',
      onTimeUpdate,
      onPlay,
      onPause,
      onLoaded,
      onError,
    },
    ref,
  ) {
    const handleTimeUpdate = useCallback(
      (e: React.SyntheticEvent<HTMLVideoElement>) => {
        onTimeUpdate(e.currentTarget.currentTime);
      },
      [onTimeUpdate],
    );

    const handleLoadedData = useCallback(() => {
      onLoaded();
    }, [onLoaded]);

    const handleError = useCallback(
      (e: React.SyntheticEvent<HTMLVideoElement>) => {
        const mediaError = e.currentTarget.error;
        const classified = classifyMediaError(mediaError, 'video');
        // P1.2: Never surface raw MediaError.message — use localized labels.
        // Decode errors get a distinct label from network/unsupported errors.
        if (classified?.kind === 'decode') {
          onError(decodeErrorLabel);
        } else {
          onError(errorLabel);
        }
      },
      [onError, errorLabel, decodeErrorLabel],
    );

    /* Guard #4: Prevent Space/Enter on focused video element from
       double-firing global play/pause or browser default behavior.
       The custom PlayerControls handle playback; video focus is for
       accessibility only. */
    const handleKeyDown = useCallback(
      (e: React.KeyboardEvent<HTMLVideoElement>) => {
        if (e.key === ' ' || e.key === 'Enter') {
          e.preventDefault();
          e.stopPropagation();
        }
      },
      [],
    );

    if (error) {
      return (
        <div className="entei-player-error-state">
          <p className="entei-player-error-text">{error}</p>
        </div>
      );
    }

    return (
      <div className="entei-player-video-wrapper">
        <video
          ref={ref}
          src={src}
          className="entei-player-video"
          onTimeUpdate={handleTimeUpdate}
          onPlay={onPlay}
          onPause={onPause}
          onLoadedData={handleLoadedData}
          onError={handleError}
          onKeyDown={handleKeyDown}
          preload="metadata"
          playsInline
          tabIndex={0}
        />
        {isLoading && (
          <div className="entei-player-loading-overlay">
            <div className="entei-player-skeleton" />
          </div>
        )}
      </div>
    );
  },
);
