/**
 * SubtitlePanel — Scrollable subtitle cue list.
 * ---------------------------------------------------------------------------
 * Uses shadcn ScrollArea for the cue list scroll container.
 * Scroll-to-active-cue queries the Radix viewport element.
 * ul > li > button semantics; aria-current on active cue.
 * Reduced-motion: reads matchMedia directly in scroll effect.
 * Row mining: each cue row has an optional Pickaxe button for mining that cue.
 * --------------------------------------------------------------------------- */

'use client';

import { useEffect, useRef, useCallback } from 'react';
import type { SubtitleCue } from '@/features/player/subtitle-reader';
import { formatTime } from '@/features/player/control-helpers';
import { ScrollArea } from './ui/scroll-area';
import { SubtitlePicker } from './SubtitlePicker';
import { TypewriterLoading } from './TypewriterLoading';
import { Pickaxe } from 'lucide-react';

interface SubtitlePanelProps {
  cues: SubtitleCue[];
  activeCueId: number | null;
  onCueClick: (cue: SubtitleCue) => void;
  onSubtitleSelect?: (file: File) => void;
  subtitleAccept?: string;
  noSubtitlesLabel?: string;
  seekToLabel?: string;
  chooseSubtitleLabel?: string;
  /** While true (companion job subtitles still being fetched) the empty
   *  state is replaced with a centered loading indicator. */
  isLoadingSubtitles?: boolean;
  /** Localized label for the loading state. */
  preparingSubtitlesLabel?: string;
  /** AM-4 Row Mining: callback to mine a specific cue. */
  onMineCue?: (cue: SubtitleCue) => void;
  /** Whether row mining is available (media loaded, not capturing). */
  canMineRow?: boolean;
  /** Whether mining capture is currently in flight. */
  isMining?: boolean;
  /** Localized label for the mine button. */
  mineRowLabel?: string;
  /** Localized label when mining is unavailable. */
  mineRowDisabledLabel?: string;
  /** Localized label when mining is in progress. */
  mineCapturingLabel?: string;
}

export function SubtitlePanel({
  cues,
  activeCueId,
  onCueClick,
  onSubtitleSelect,
  subtitleAccept,
  noSubtitlesLabel = 'No subtitles loaded. Add an SRT or VTT file.',
  seekToLabel = 'Seek to',
  chooseSubtitleLabel = 'Choose Subtitles',
  isLoadingSubtitles = false,
  // English default matches the existing inline-label pattern (e.g.
  // noSubtitlesLabel): the panel is a pure presentation component and
  // the caller (RightPanel) always passes the localized dictionary value.
  preparingSubtitlesLabel = 'Preparing subtitles…',
  onMineCue,
  canMineRow,
  isMining,
  mineRowLabel = 'Mine this cue',
  mineRowDisabledLabel = 'Mining unavailable',
  mineCapturingLabel = 'Mining…',
}: SubtitlePanelProps) {
  // Ref on the ScrollArea root — query viewport inside for scroll checks.
  const scrollRootRef = useRef<HTMLDivElement>(null);

  const handleCueClick = useCallback(
    (cue: SubtitleCue) => {
      onCueClick(cue);
    },
    [onCueClick],
  );

  // Programmatic scroll to active cue.
  // Queries the Radix ScrollArea viewport for visibility and scrollIntoView.
  useEffect(() => {
    if (activeCueId === null) return;
    const root = scrollRootRef.current;
    if (!root) return;

    // Radix ScrollArea viewport is the actual scrollable element.
    const viewport =
      root.querySelector<HTMLElement>('[data-radix-scroll-area-viewport]') ??
      root;

    const activeEl = viewport.querySelector(`[data-cue-id="${activeCueId}"]`);
    if (!activeEl) return;

    const containerRect = viewport.getBoundingClientRect();
    const elRect = activeEl.getBoundingClientRect();
    const isVisible =
      elRect.top >= containerRect.top && elRect.bottom <= containerRect.bottom;

    if (isVisible) return;

    const prefersReduced =
      typeof window !== 'undefined' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const behavior = prefersReduced ? 'instant' : 'smooth';
    activeEl.scrollIntoView({ block: 'nearest', behavior });
  }, [activeCueId]);

  if (cues.length === 0 && isLoadingSubtitles) {
    // Companion job (YouTube/Magnet): subtitles are still being fetched
    // (bounded retry in PlayerApp). Replace the otherwise empty state
    // with a centered loading indicator so the panel does not look broken
    // during the multi-second gap.
    return (
      <div className="entei-subtitle-panel">
        <div
          className="entei-subtitle-preparing"
          role="status"
          aria-label={preparingSubtitlesLabel}
        >
          <TypewriterLoading
            aria-hidden="true"
            className="entei-typewriter--panel"
          />
          <p className="entei-subtitle-preparing-text">
            {preparingSubtitlesLabel}
          </p>
        </div>
      </div>
    );
  }

  if (cues.length === 0) {
    return (
      <div className="entei-subtitle-panel">
        <div className="entei-subtitle-empty">
          {onSubtitleSelect && subtitleAccept && (
            <SubtitlePicker
              onSelect={onSubtitleSelect}
              accept={subtitleAccept}
              label={chooseSubtitleLabel}
            />
          )}
          <p className="entei-subtitle-empty-text">{noSubtitlesLabel}</p>
        </div>
      </div>
    );
  }

  return (
    <div className="entei-subtitle-panel">
      <ScrollArea ref={scrollRootRef} className="entei-subtitle-scroll-area">
        <ul className="entei-subtitle-list">
          {cues.map((cue) => {
            const isActive = cue.id === activeCueId;
            const timeStr = formatTime(cue.start);
            const mineDisabled = !canMineRow || isMining;
            return (
              <li key={cue.id} className="entei-subtitle-cue-item">
                <div className="entei-subtitle-cue-row">
                  <button
                    type="button"
                    className={`entei-subtitle-cue${isActive ? ' entei-subtitle-cue--active' : ''}`}
                    onClick={() => handleCueClick(cue)}
                    aria-current={isActive ? 'true' : undefined}
                    aria-label={`${seekToLabel} ${timeStr} \u2014 ${cue.text}`}
                    data-cue-id={cue.id}
                  >
                    <span className="entei-subtitle-cue-time">
                      {formatTime(cue.start)}
                    </span>
                    <span className="entei-subtitle-cue-text">{cue.text}</span>
                  </button>
                  {onMineCue && (
                    <button
                      type="button"
                      className="entei-subtitle-cue-mine"
                      onClick={(e) => {
                        e.stopPropagation();
                        if (!mineDisabled) onMineCue(cue);
                      }}
                      disabled={mineDisabled}
                      aria-label={
                        isMining ? mineCapturingLabel : mineDisabled ? mineRowDisabledLabel : mineRowLabel
                      }
                      title={
                        isMining ? mineCapturingLabel : mineDisabled ? mineRowDisabledLabel : mineRowLabel
                      }
                    >
                      <Pickaxe size={16} aria-hidden="true" />
                    </button>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      </ScrollArea>
    </div>
  );
}
