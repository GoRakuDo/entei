/**
 * VideoPlayer — Video element with native controls.
 */
'use client';

import { forwardRef, useCallback } from 'react';

interface VideoPlayerProps {
  src: string;
  isLoading: boolean;
  error: string | null;
  fallbackErrorLabel?: string;
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
      fallbackErrorLabel = 'Failed to load video',
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
        onError(mediaError?.message ?? fallbackErrorLabel);
      },
      [onError, fallbackErrorLabel],
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
          preload="metadata"
          playsInline
          controls
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
