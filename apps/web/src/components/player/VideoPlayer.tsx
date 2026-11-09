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
  /** Keep the video element mounted while the native torrent relay retries
   *  with an explicit src/load so loadeddata can clear the error overlay. */
  keepElementOnError?: boolean;
  /** mpv owns the picture and sound for this source. The HTML element stays
   *  mounted as the timing/transport shim, but WebView2's decode failure on
   *  formats such as HEVC 4:4:4 10-bit / FLAC must neither replace the surface
   *  with an error state nor let the element make sound. */
  nativeRender?: boolean;
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
      keepElementOnError = false,
      nativeRender = false,
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
        // Native render mode: libmpv owns the clock (the 200 ms
        // `mpv_get_time` poll in PlayerApp). The element's own position is
        // a different clock — feeding it into the cue / tracker pipeline made
        // the two fight over the same position and the time display jumped
        // back and forth. The element stays mounted as the frame source for
        // mining captures, but it never reports a position here.
        if (nativeRender) return;
        onTimeUpdate(e.currentTarget.currentTime);
      },
      [onTimeUpdate, nativeRender],
    );

    const handleLoadedData = useCallback(() => {
      onLoaded();
    }, [onLoaded]);

    // Native render mode: libmpv owns the transport state. The element's own
    // play/pause events describe the shim, not the engine, so they must not
    // drive the UI state — the engine's intent does (togglePlayback, mining
    // auto-pause). A stale shim event would otherwise flip the play/pause
    // button while the picture stands still.
    const handlePlay = useCallback(() => {
      if (nativeRender) return;
      onPlay();
    }, [onPlay, nativeRender]);

    const handlePause = useCallback(() => {
      if (nativeRender) return;
      onPause();
    }, [onPause, nativeRender]);

    const handleError = useCallback(
      (e: React.SyntheticEvent<HTMLVideoElement>) => {
        // Native render mode: WebView2 cannot decode formats libmpv handles
        // (HEVC 4:4:4 10-bit, FLAC in MKV). The element is only a shim here,
        // so its decode failure must not replace the surface with an error
        // state — mpv is painting the real picture behind the HTML UI.
        if (nativeRender) return;
        // Capture the MediaError FIRST: load() below resets the element's
        // error state, so classification must read it before the reset.
        const mediaError = e.currentTarget.error;
        // Stop the element on error: pause + drop the src + load() resets
        // the decoder/buffers so a failed (auto)play never leaves buffered
        // audio running — otherwise the next user-initiated play overlaps
        // with the old stream (double audio). The element itself survives
        // (keepElementOnError keeps the relay retry path mounted).
        const el = e.currentTarget;
        el.pause();
        el.removeAttribute('src');
        el.load();
        const classified = classifyMediaError(mediaError, 'video');
        // P1.2: Never surface raw MediaError.message — use localized labels.
        // Decode errors get a distinct label from network/unsupported errors.
        if (classified?.kind === 'decode') {
          onError(decodeErrorLabel);
        } else {
          onError(errorLabel);
        }
      },
      [onError, errorLabel, decodeErrorLabel, nativeRender],
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

    /* The element is shared by the standalone and overlay error paths: with
       keepElementOnError the exact same element stays mounted so the native
       torrent session's recovery (explicit src/load) can drive loadeddata
       and clear the error. crossOrigin="anonymous" makes the
       element fetch its source with CORS instead of no-cors — without it
       the browser issues an opaque no-cors request that ORB (Opaque
       Response Blocking) rejects for a cross-origin media response. */
    const videoElement = (
      <video
        ref={ref}
        src={src}
        muted={nativeRender}
        crossOrigin="anonymous"
        className="entei-player-video"
        onTimeUpdate={handleTimeUpdate}
        onPlay={handlePlay}
        onPause={handlePause}
        onLoadedData={handleLoadedData}
        onError={handleError}
        onKeyDown={handleKeyDown}
        preload="metadata"
        playsInline
        tabIndex={0}
      />
    );

    if (error && !nativeRender) {
      if (keepElementOnError) {
        // Overlay error state: keep the element mounted (torrent recovery
        // needs it) and cover it with the error.
        return (
          <div className="entei-player-video-wrapper">
            {videoElement}
            <div className="entei-player-error-state">
              <p className="entei-player-error-text">{error}</p>
            </div>
          </div>
        );
      }
      return (
        <div className="entei-player-error-state">
          <p className="entei-player-error-text">{error}</p>
        </div>
      );
    }

    return (
      <div className="entei-player-video-wrapper">
        {videoElement}
        {isLoading && !nativeRender && (
          <div className="entei-player-loading-overlay">
            <div className="entei-player-skeleton" />
          </div>
        )}
      </div>
    );
  },
);
