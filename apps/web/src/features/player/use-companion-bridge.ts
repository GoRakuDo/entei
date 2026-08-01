/**
 * useCompanionBridge — React binding for the ED-2E companion buffering
 * bridge (see companion-bridge.ts).
 * ---------------------------------------------------------------------------
 * Thin adapter only: all state lives inside the CompanionBridge controller
 * in page memory (never localStorage / IndexedDB / sessionStorage /
 * cookies / URLs / logs). The hook exposes the phase/progress for a future
 * buffering UI and the narrow control surface a source entry flow will
 * call. It is intentionally NOT wired into PlayerApp's normal local-file
 * flow.
 * ---------------------------------------------------------------------------
 */
'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  CompanionBridge,
  type CompanionBridgeMedia,
  type CompanionBridgePhase,
  type CompanionBridgeProgress,
  type CompanionBridgeSource,
} from '@/features/player/companion-bridge';

export interface UseCompanionBridgeResult {
  phase: CompanionBridgePhase;
  progress: CompanionBridgeProgress | null;
  reason: string | null;
  /** media may be null while the player has no element yet (buffering in the
   *  empty state); attach it later via attachMedia(). */
  beginSession: (source: CompanionBridgeSource, media: HTMLMediaElement | null) => void;
  attachMedia: (media: HTMLMediaElement) => void;
  endSession: () => void;
  setPlayIntent: (play: boolean) => void;
  requestSeek: (seconds: number) => void;
}

/** Map an HTMLMediaElement onto the controller's narrow media surface. */
function createMediaAdapter(el: HTMLMediaElement): CompanionBridgeMedia {
  return {
    setSrc: (url: string) => {
      // The companion media gate requires a CORS-mode request with an
      // Origin header (ED-2C measured contract: crossOrigin="anonymous" +
      // token query). Without this, Chrome issues a no-cors request that
      // the companion's ACAO response gets ORB-blocked by.
      el.crossOrigin = 'anonymous';
      el.src = url;
    },
    load: () => el.load(),
    play: () => el.play(),
    seekTo: (seconds: number) => {
      el.currentTime = seconds;
    },
    onLoadedMetadata: (cb: () => void) => {
      el.addEventListener('loadedmetadata', cb);
      return () => el.removeEventListener('loadedmetadata', cb);
    },
    onCanPlay: (cb: () => void) => {
      el.addEventListener('canplay', cb);
      return () => el.removeEventListener('canplay', cb);
    },
    onSeeked: (cb: () => void) => {
      el.addEventListener('seeked', cb);
      return () => el.removeEventListener('seeked', cb);
    },
    onPlaying: (cb: () => void) => {
      el.addEventListener('playing', cb);
      return () => el.removeEventListener('playing', cb);
    },
    onError: (cb: () => void) => {
      el.addEventListener('error', cb);
      return () => el.removeEventListener('error', cb);
    },
  };
}

export function useCompanionBridge(): UseCompanionBridgeResult {
  const [phase, setPhase] = useState<CompanionBridgePhase>('idle');
  const [progress, setProgress] = useState<CompanionBridgeProgress | null>(
    null,
  );
  const [reason, setReason] = useState<string | null>(null);

  const bridgeRef = useRef<CompanionBridge | null>(null);
  if (bridgeRef.current === null) {
    bridgeRef.current = new CompanionBridge(
      {},
      {
        onPhaseChange: (nextPhase, info) => {
          setPhase(nextPhase);
          setProgress(info.progress);
          setReason(info.reason);
        },
      },
    );
  }

  // Unmount / source switch safety: abort polling, timers, and media
  // listeners. All bridge state is page-memory; nothing is persisted.
  useEffect(() => {
    const bridge = bridgeRef.current;
    return () => {
      bridge?.endSession();
    };
  }, []);

  const beginSession = useCallback(
    (source: CompanionBridgeSource, media: HTMLMediaElement | null) => {
      bridgeRef.current?.beginSession(source, media ? createMediaAdapter(media) : null);
    },
    [],
  );

  const attachMedia = useCallback((media: HTMLMediaElement) => {
    bridgeRef.current?.attachMedia(createMediaAdapter(media));
  }, []);

  const endSession = useCallback(() => {
    bridgeRef.current?.endSession();
  }, []);

  const setPlayIntent = useCallback((play: boolean) => {
    bridgeRef.current?.setPlayIntent(play);
  }, []);

  const requestSeek = useCallback((seconds: number) => {
    bridgeRef.current?.requestSeek(seconds);
  }, []);

  return {
    phase,
    progress,
    reason,
    beginSession,
    attachMedia,
    endSession,
    setPlayIntent,
    requestSeek,
  };
}
