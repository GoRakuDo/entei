'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { cancelTorrentDirect } from '@/features/player/tauri-bridge';

/** A torrent already selected through the native Tauri plugin. */
export interface TorrentSessionSource {
  torrentId: string;
  videoUrl: string;
  subtitleUrl?: string | null;
}

const MEDIA_RESET_LIMIT = 3;
const MEDIA_RESET_DELAY_MS = 600;

/**
 * Owns a selected native torrent relay for the lifetime of its player surface.
 * Session state stays in memory and is cancelled when the surface is released.
 */
export function useTorrentSession() {
  const [source, setSource] = useState<TorrentSessionSource | null>(null);
  const sourceRef = useRef<TorrentSessionSource | null>(null);
  const attachedRef = useRef(false);
  const resetCountRef = useRef(0);
  const lastPositionRef = useRef(0);
  const wasPlayingRef = useRef(false);
  const resetTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cleanupMediaRef = useRef<(() => void) | null>(null);

  const clearMedia = useCallback(() => {
    cleanupMediaRef.current?.();
    cleanupMediaRef.current = null;
    attachedRef.current = false;
  }, []);

  const endSession = useCallback(() => {
    clearMedia();
    sourceRef.current = null;
    setSource(null);
    resetCountRef.current = 0;
    lastPositionRef.current = 0;
    wasPlayingRef.current = false;
  }, [clearMedia]);

  const beginSession = useCallback(
    (next: TorrentSessionSource) => {
      endSession();
      sourceRef.current = next;
      setSource(next);
    },
    [endSession],
  );

  const cancelActiveSession = useCallback(async () => {
    const current = sourceRef.current;
    endSession();
    if (!current) return;
    try {
      await cancelTorrentDirect(current.torrentId);
    } catch {
      // The torrent may already have been cancelled or the app may be closing.
    }
  }, [endSession]);

  const attachMediaElement = useCallback((element: HTMLVideoElement | null) => {
    const current = sourceRef.current;
    if (!element || !current || attachedRef.current) return;
    attachedRef.current = true;

    let resumeAt = 0;
    let resumePlayback = false;

    const onTimeUpdate = () => {
      const position = element.currentTime;
      if (Number.isFinite(position) && position > 0) {
        lastPositionRef.current = position;
      }
    };
    const onPlaying = () => {
      wasPlayingRef.current = true;
    };
    const onPause = () => {
      if (!element.error) wasPlayingRef.current = false;
    };
    const onResume = () => {
      if (resumeAt <= 0 && !resumePlayback) return;
      const position = resumeAt;
      const shouldPlay = resumePlayback;
      resumeAt = 0;
      resumePlayback = false;
      if (position > 0) {
        try {
          element.currentTime = position;
        } catch {
          // The relay may not have exposed a seekable range yet.
        }
      }
      if (!shouldPlay) return;
      try {
        void element.play().catch(() => {
          // Autoplay policy may refuse an automatic recovery resume.
        });
      } catch {
        // No media pipeline is available (for example, in a test DOM).
      }
    };
    const onLoaded = () => {
      resetCountRef.current = 0;
    };
    const onError = () => {
      if (sourceRef.current !== current || resetCountRef.current >= MEDIA_RESET_LIMIT) {
        return;
      }
      if (resetTimerRef.current !== null) return;
      resetCountRef.current += 1;
      resumeAt = lastPositionRef.current;
      resumePlayback = wasPlayingRef.current;
      resetTimerRef.current = setTimeout(() => {
        resetTimerRef.current = null;
        if (sourceRef.current !== current) return;
        element.src = current.videoUrl;
        element.load();
      }, MEDIA_RESET_DELAY_MS);
    };

    element.addEventListener('timeupdate', onTimeUpdate);
    element.addEventListener('playing', onPlaying);
    element.addEventListener('pause', onPause);
    element.addEventListener('loadedmetadata', onResume);
    element.addEventListener('canplay', onResume);
    element.addEventListener('loadeddata', onLoaded);
    element.addEventListener('error', onError);
    cleanupMediaRef.current = () => {
      element.removeEventListener('timeupdate', onTimeUpdate);
      element.removeEventListener('playing', onPlaying);
      element.removeEventListener('pause', onPause);
      element.removeEventListener('loadedmetadata', onResume);
      element.removeEventListener('canplay', onResume);
      element.removeEventListener('loadeddata', onLoaded);
      element.removeEventListener('error', onError);
      if (resetTimerRef.current !== null) {
        clearTimeout(resetTimerRef.current);
        resetTimerRef.current = null;
      }
    };
  }, []);

  useEffect(
    () => () => {
      const current = sourceRef.current;
      clearMedia();
      sourceRef.current = null;
      if (current) {
        void cancelTorrentDirect(current.torrentId).catch(() => {
          // The app is closing or the torrent was already cancelled.
        });
      }
    },
    [clearMedia],
  );

  return {
    active: source !== null,
    id: source?.torrentId ?? null,
    mediaUrl: source?.videoUrl ?? null,
    subtitleUrl: source?.subtitleUrl ?? null,
    beginSession,
    cancelActiveSession,
    endSession,
    attachMediaElement,
  };
}
