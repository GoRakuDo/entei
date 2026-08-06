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
 * P1.1: Also excludes <button>, [role="button"], [role="slider"], [role="switch"],
 * [role="checkbox"] from Space/Enter triggering global play/pause.
 * --------------------------------------------------------------------------- */
'use client';

import { useEffect, useCallback, useRef } from 'react';
import type { SubtitleCue } from '@/features/player/subtitle-reader';
import {
  isControlTarget,
  clampSeek,
  PLAYBACK_RATES,
} from '@/features/player/control-helpers';

interface UseKeyboardShortcutsOptions {
  videoRef: React.RefObject<HTMLMediaElement | null>;
  cues: SubtitleCue[];
  activeCueId: number | null;
  playbackRate: number;
  setPlaybackRate: (rate: number) => void;
  onCueClick: (cue: SubtitleCue) => void;
  enabled: boolean;
}

export { PLAYBACK_RATES } from '@/features/player/control-helpers';

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
  const activeCueIdRef = useRef(activeCueId);
  activeCueIdRef.current = activeCueId;

  const cuesRef = useRef(cues);
  cuesRef.current = cues;

  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (!enabled) return;

      // P1.1: Exclude editable targets AND control targets (button, slider, etc.)
      // to prevent Space/Enter from double-firing play/pause.
      if (isEditableTarget(e.target) || isControlTarget(e.target)) return;

      const media = videoRef.current;
      if (!media) return;

      switch (e.key) {
        case ' ': {
          e.preventDefault();
          if (media.paused) {
            media.play().catch(() => {});
          } else {
            media.pause();
          }
          break;
        }

        case 'ArrowLeft': {
          e.preventDefault();
          const currentId = activeCueIdRef.current;
          const currentCues = cuesRef.current;
          if (currentCues.length === 0) break;

          // P3: Intentional direction-aware behavior — when there is no valid
          // active cue (null, out-of-range), ArrowLeft always starts from the
          // first cue (index 0). This is asymmetric with ArrowRight which
          // starts from the last cue, matching the directional intent: Left
          // means "go toward the beginning", Right means "go toward the end".
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
          e.preventDefault();
          const currentId = activeCueIdRef.current;
          const currentCues = cuesRef.current;
          if (currentCues.length === 0) break;

          // P3: ArrowRight starts from the last cue when active is invalid,
          // matching directional intent — "go toward the end".
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
          e.preventDefault();
          const currentId = activeCueIdRef.current;
          const currentCues = cuesRef.current;
          if (currentId !== null && currentId < currentCues.length) {
            const cue = currentCues[currentId]!;
            media.currentTime = clampSeek(cue.start, media.duration);
          }
          break;
        }

        case '[': {
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
