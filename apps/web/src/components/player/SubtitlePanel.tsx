/**
 * SubtitlePanel — Scrollable subtitle cue list.
 * ---------------------------------------------------------------------------
 * Uses shadcn ScrollArea for the cue list scroll container.
 * Scroll-to-active-cue queries the Radix viewport element.
 * ul > li > button semantics; aria-current on active cue.
 * Reduced-motion: reads matchMedia directly in scroll effect.
 * Row mining: each cue row has an optional Pickaxe button for mining that cue.
 *
 * Virtual windowing: a real movie carries thousands of cues, so mounting
 * every row made the panel take seconds to mount and to remount on every
 * Captions ⇄ Context tab switch. Only the rows near the viewport are mounted
 * now; the rest are replaced by two spacers. See
 * `features/player/use-cue-virtual-list.ts` for the scrolling contract and
 * `features/player/cue-virtual-window.ts` for the pure window math.
 * --------------------------------------------------------------------------- */

'use client';

import { useEffect, useCallback } from 'react';
import type { SubtitleCue } from '@/features/player/subtitle-reader';
import { formatTime } from '@/features/player/control-helpers';
import { useCueVirtualList } from '@/features/player/use-cue-virtual-list';
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
  const {
    listRef,
    scrollRootRef,
    window: virtualWindow,
    spacers,
    scrollToCue,
  } = useCueVirtualList({ cues, enabled: cues.length > 0 });

  const handleCueClick = useCallback(
    (cue: SubtitleCue) => {
      onCueClick(cue);
    },
    [onCueClick],
  );

  // Programmatic scroll to active cue.
  // Desktop: the Radix viewport is the scroll container — the active cue is
  // allowed to drift inside a comfortable middle band and is smoothly
  // recentered once it leaves that band, so the dialogue stays in the middle
  // of the panel instead of slowly walking out of view.
  // Mobile: the page itself scrolls (sticky media area + tabs bar above the
  // visible subtitle area), so the window is scrolled to keep the active cue
  // centered in the visible subtitle area below those headers.
  // When the active cue is outside the mounted window the hook forces the
  // window to contain it and corrects the position against its real
  // geometry — the estimate never decides the final position.
  useEffect(() => {
    if (activeCueId === null) return;
    scrollToCue(activeCueId);
  }, [activeCueId, scrollToCue]);

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

  const visibleCues = cues.slice(
    virtualWindow.startIndex,
    virtualWindow.endIndex,
  );

  return (
    <div className="entei-subtitle-panel">
      <ScrollArea ref={scrollRootRef} className="entei-subtitle-scroll-area">
        <ul
          className="entei-subtitle-list"
          ref={listRef}
          style={{
            paddingTop: `${spacers.top}px`,
            paddingBottom: `${spacers.bottom}px`,
          }}
        >
          {visibleCues.map((cue, offset) => {
            const isActive = cue.id === activeCueId;
            const timeStr = formatTime(cue.start);
            const mineDisabled = !canMineRow || isMining;
            const cueIndex = virtualWindow.startIndex + offset;
            return (
              <li
                key={cue.id}
                className="entei-subtitle-cue-item"
                data-cue-index={cueIndex}
                // Virtual list: only part of the set is mounted, so the
                // assistive-technology position has to be stated explicitly.
                aria-setsize={cues.length}
                aria-posinset={cueIndex + 1}
              >
                <div
                  className={`entei-subtitle-cue-row${isActive ? ' entei-subtitle-cue-row--active' : ''}`}
                >
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
                        isMining
                          ? mineCapturingLabel
                          : mineDisabled
                            ? mineRowDisabledLabel
                            : mineRowLabel
                      }
                      title={
                        isMining
                          ? mineCapturingLabel
                          : mineDisabled
                            ? mineRowDisabledLabel
                            : mineRowLabel
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
