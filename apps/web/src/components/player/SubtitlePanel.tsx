/**
 * SubtitlePanel — Scrollable subtitle cue list.
 * ---------------------------------------------------------------------------
 * Uses shadcn ScrollArea for the cue list scroll container.
 * Scroll-to-active-cue queries the Radix viewport element.
 * ul > li > button semantics; aria-current on active cue.
 * Reduced-motion: reads matchMedia directly in scroll effect.
 * --------------------------------------------------------------------------- */

'use client';

import { useEffect, useRef, useCallback } from 'react';
import { BookOpen } from 'lucide-react';
import type { SubtitleCue } from '@/features/player/subtitle-reader';
import { ScrollArea } from './ui/scroll-area';

interface SubtitlePanelProps {
  cues: SubtitleCue[];
  activeCueId: number | null;
  onCueClick: (cue: SubtitleCue) => void;
  subtitlesLabel?: string;
  cuesCountLabel?: string;
  noSubtitlesLabel?: string;
  seekToLabel?: string;
}

export function SubtitlePanel({
  cues,
  activeCueId,
  onCueClick,
  subtitlesLabel = 'Subtitles',
  cuesCountLabel = 'cues',
  noSubtitlesLabel = 'No subtitles loaded. Add an SRT or VTT file.',
  seekToLabel = 'Seek to',
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
      root.querySelector<HTMLElement>(
        '[data-radix-scroll-area-viewport]',
      ) ?? root;

    const activeEl = viewport.querySelector(
      `[data-cue-id="${activeCueId}"]`,
    );
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

  if (cues.length === 0) {
    return (
      <div className="entei-subtitle-panel">
        <div className="entei-subtitle-panel-header">
          <span className="entei-subtitle-panel-title">{subtitlesLabel}</span>
        </div>
        <div className="entei-subtitle-empty">
          <BookOpen size={24} className="entei-player-audio-icon" />
          <p className="entei-subtitle-empty-text">{noSubtitlesLabel}</p>
        </div>
      </div>
    );
  }

  return (
    <div className="entei-subtitle-panel">
      <div className="entei-subtitle-panel-header">
        <span className="entei-subtitle-panel-title">{subtitlesLabel}</span>
        <span className="entei-subtitle-panel-count">
          {cues.length} {cuesCountLabel}
        </span>
      </div>
      <ScrollArea
        ref={scrollRootRef}
        className="entei-subtitle-scroll-area"
      >
        <ul className="entei-subtitle-list">
          {cues.map((cue) => {
            const isActive = cue.id === activeCueId;
            const timeStr = formatTime(cue.start);
            return (
              <li key={cue.id} className="entei-subtitle-cue-item">
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
              </li>
            );
          })}
        </ul>
      </ScrollArea>
    </div>
  );
}

function formatTime(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  if (h > 0) {
    return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  }
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}
