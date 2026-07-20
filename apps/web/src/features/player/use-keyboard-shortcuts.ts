/**
 * useKeyboardShortcuts — Player keyboard shortcut handler.
 * ---------------------------------------------------------------------------
 * P1 shortcuts:
 * - Space: toggle play/pause (only outside editable controls)
 * - ArrowLeft: previous cue
 * - ArrowRight: next cue
 * - Home: seek to current cue start
 * - [ : decrease playback speed
 * - ] : increase playback speed
 *
 * Does not hijack typing/form controls.
 * --------------------------------------------------------------------------- */
'use client';

import { useEffect, useCallback, useRef } from 'react';
import type { SubtitleCue } from '@/features/player/subtitle-reader';

interface UseKeyboardShortcutsOptions {
  videoRef: React.RefObject<HTMLMediaElement | null>;
  cues: SubtitleCue[];
  activeCueId: number | null;
  playbackRate: number;
  setPlaybackRate: (rate: number) => void;
  onCueClick: (cue: SubtitleCue) => void;
  enabled: boolean;
}

const PLAYBACK_RATES = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2];

/**
 * Check if the event target is an editable element that should not
 * trigger keyboard shortcuts.
 */
function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName.toLowerCase();
  return (
    tag === 'input' ||
    tag === 'textarea' ||
    tag === 'select' ||
    target.isContentEditable
  );
}

export function useKeyboardShortcuts({
  videoRef,
  cues,
  activeCueId,
  playbackRate,
  setPlaybackRate,
  onCueClick,
  enabled,
}: UseKeyboardShortcutsOptions) {
  // Track the current active cue ID for stable reference in event handler
  const activeCueIdRef = useRef(activeCueId);
  activeCueIdRef.current = activeCueId;

  // Track cues for stable reference
  const cuesRef = useRef(cues);
  cuesRef.current = cues;

  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (!enabled) return;
      if (isEditableTarget(e.target)) return;

      const media = videoRef.current;
      if (!media) return;

      switch (e.key) {
        case ' ': {
          // Space: toggle play/pause
          e.preventDefault();
          if (media.paused) {
            media.play().catch(() => {});
          } else {
            media.pause();
          }
          break;
        }

        case 'ArrowLeft': {
          // ArrowLeft: previous cue
          e.preventDefault();
          const currentId = activeCueIdRef.current;
          const currentCues = cuesRef.current;
          if (currentCues.length === 0) break;

          // Clamp activeCueId to valid index range (handles stale/out-of-range
          // IDs after subtitle file replacement).
          const clampedId =
            currentId !== null &&
            currentId >= 0 &&
            currentId < currentCues.length
              ? currentId
              : 0;

          onCueClick(
            clampedId > 0 ? currentCues[clampedId - 1]! : currentCues[0]!,
          );
          break;
        }

        case 'ArrowRight': {
          // ArrowRight: next cue
          e.preventDefault();
          const currentId = activeCueIdRef.current;
          const currentCues = cuesRef.current;
          if (currentCues.length === 0) break;

          // Clamp activeCueId to valid index range (handles stale/out-of-range
          // IDs after subtitle file replacement).
          const clampedId =
            currentId !== null &&
            currentId >= 0 &&
            currentId < currentCues.length
              ? currentId
              : currentCues.length - 1;

          onCueClick(
            clampedId < currentCues.length - 1
              ? currentCues[clampedId + 1]!
              : currentCues[currentCues.length - 1]!,
          );
          break;
        }

        case 'Home': {
          // Home: seek to current cue start
          e.preventDefault();
          const currentId = activeCueIdRef.current;
          const currentCues = cuesRef.current;
          if (currentId !== null && currentId < currentCues.length) {
            const cue = currentCues[currentId]!;
            media.currentTime = cue.start;
          }
          break;
        }

        case '[': {
          // [ : decrease playback speed
          e.preventDefault();
          const currentIdx = PLAYBACK_RATES.indexOf(playbackRate);
          if (currentIdx > 0) {
            const newRate = PLAYBACK_RATES[currentIdx - 1]!;
            setPlaybackRate(newRate);
            media.playbackRate = newRate;
          }
          break;
        }

        case ']': {
          // ] : increase playback speed
          e.preventDefault();
          const currentIdx = PLAYBACK_RATES.indexOf(playbackRate);
          if (currentIdx < PLAYBACK_RATES.length - 1) {
            const newRate = PLAYBACK_RATES[currentIdx + 1]!;
            setPlaybackRate(newRate);
            media.playbackRate = newRate;
          }
          break;
        }
      }
    },
    [enabled, videoRef, playbackRate, setPlaybackRate, onCueClick],
  );

  useEffect(() => {
    if (!enabled) return;
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [enabled, handleKeyDown]);
}
