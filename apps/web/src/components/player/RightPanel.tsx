/**
 * RightPanel — Tab selector switching between Captions and Mining History.
 * ---------------------------------------------------------------------------
 * Desktop layout: placed inside a ResizablePanel (handled by PlayerApp).
 * Mobile layout: placed vertically below the player.
 * Tab state is NOT persisted; defaults to captions on each mount.
 * ---------------------------------------------------------------------------
 * Tracker ON/OFF switch at top of History tab uses shadcn Switch and
 * persists via localStorage (entei.tracker.enabled). Default ON.
 * ---------------------------------------------------------------------------
 */
'use client';

import { useState, useCallback } from 'react';
import { Captions, History } from 'lucide-react';
import { Button } from '@/components/player/ui/button';
import { Switch } from '@/components/player/ui/switch';
import { SubtitlePanel } from '@/components/player/SubtitlePanel';
import { MiningHistoryPanel } from '@/components/player/MiningHistoryPanel';
import type { SubtitleCue } from '@/features/player/subtitle-reader';
import type { Dictionary } from '@i18n/types';
import { isTrackerEnabled, setTrackerEnabled, flushCurrentSegment } from '@/features/player/tracker/tracker-enabled';
import type { SegmentAccumulatorState } from '@/features/player/tracker/types';

type RightPanelTab = 'captions' | 'history';

interface RightPanelProps {
  /** Whether the panel is visible at all (controlled by existing toggle). */
  visible: boolean;
  dict: Dictionary['playerUI'];
  /** Subtitle panel props */
  cues: SubtitleCue[];
  /** Companion job (YouTube/Magnet): subtitles still being fetched. */
  isLoadingSubtitles?: boolean;
  activeCueId: number | null;
  onCueClick: (cue: SubtitleCue) => void;
  onSubtitleSelect: (file: File) => void;
  subtitleAccept: string;
  /** History panel refresh trigger — increment after a successful Anki send. */
  historyRefreshKey?: number;
  /** AM-4 Row Mining: callback to mine a specific cue. */
  onMineCue?: (cue: SubtitleCue) => void;
  /** AM-4 Row Mining: whether row mining is available (media loaded, not capturing). */
  canMineRow?: boolean;
  /** AM-4 Row Mining: whether mining capture is currently in flight. */
  isMining?: boolean;
  /** Tracker accumulator state for flushing when toggling OFF. */
  trackerAccumulator?: SegmentAccumulatorState;
  /** Callback to flush tracker accumulator when switching OFF. */
  onTrackerFlush?: (cells: Map<string, import('@/features/player/tracker/types').ExposureCell>, totals: import('@/features/player/tracker/types').TimeTotals, learningSetId: string) => Promise<void>;
  /** Current learning set ID for flush context. */
  trackerLearningSetId?: string;
}

export function RightPanel({
  visible,
  dict,
  cues,
  isLoadingSubtitles = false,
  activeCueId,
  onCueClick,
  onSubtitleSelect,
  subtitleAccept,
  historyRefreshKey,
  onMineCue,
  canMineRow,
  isMining,
  trackerAccumulator,
  onTrackerFlush,
  trackerLearningSetId,
}: RightPanelProps) {
  const [activeTab, setActiveTab] = useState<RightPanelTab>('captions');
  const [trackerEnabled, setTrackerEnabledState] = useState<boolean>(() => isTrackerEnabled());

  const handleTabChange = useCallback((tab: RightPanelTab) => {
    setActiveTab(tab);
  }, []);

  const handleTrackerToggle = useCallback(async (enabled: boolean) => {
    setTrackerEnabledState(enabled);
    setTrackerEnabled(enabled);

    // When toggling OFF, flush the current segment before stopping tracking
    if (!enabled && trackerAccumulator && onTrackerFlush && trackerLearningSetId) {
      await flushCurrentSegment(trackerAccumulator, (cells, totals) =>
        onTrackerFlush(cells, totals, trackerLearningSetId)
      );
    }
  }, [trackerAccumulator, onTrackerFlush, trackerLearningSetId]);

  if (!visible) return null;

  const tabBar = (
    <div
      className="entei-right-panel-tabs"
      role="tablist"
      aria-label={dict.rightPanelTabsLabel}
    >
      <Button
        variant={activeTab === 'captions' ? 'default' : 'ghost'}
        size="sm"
        className="entei-right-panel-tab"
        role="tab"
        aria-pressed={activeTab === 'captions'}
        aria-selected={activeTab === 'captions'}
        aria-controls="right-panel-captions"
        aria-label={dict.rightPanelTabCaptions}
        title={dict.rightPanelTabCaptions}
        onClick={() => handleTabChange('captions')}
      >
        <Captions size={16} aria-hidden="true" />
        <span className="entei-right-panel-tab-label">
          {dict.rightPanelTabCaptions}
        </span>
      </Button>
      <Button
        variant={activeTab === 'history' ? 'default' : 'ghost'}
        size="sm"
        className="entei-right-panel-tab"
        role="tab"
        aria-pressed={activeTab === 'history'}
        aria-selected={activeTab === 'history'}
        aria-controls="right-panel-history"
        aria-label={dict.rightPanelTabHistory}
        title={dict.rightPanelTabHistory}
        onClick={() => handleTabChange('history')}
      >
        <History size={16} aria-hidden="true" />
        <span className="entei-right-panel-tab-label">
          {dict.rightPanelTabHistory}
        </span>
      </Button>
    </div>
  );

  const trackerSwitch = (
    <div className="entei-tracker-switch-row" role="group" aria-labelledby="tracker-switch-label">
      <span id="tracker-switch-label" className="entei-tracker-switch-label">
        {dict.trackerLabel}
      </span>
      <div className="entei-tracker-switch-control">
        <span className="entei-tracker-switch-state" aria-hidden="true">
          {trackerEnabled ? dict.trackerOn : dict.trackerOff}
        </span>
        <Switch
          role="switch"
          aria-label={dict.trackerAriaLabel}
          aria-describedby={trackerEnabled ? 'tracker-enabled-desc' : 'tracker-disabled-desc'}
          checked={trackerEnabled}
          onCheckedChange={handleTrackerToggle}
        />
        {trackerEnabled && (
          <span id="tracker-enabled-desc" className="sr-only">
            {dict.trackerEnabledAriaDescription}
          </span>
        )}
        {!trackerEnabled && (
          <span id="tracker-disabled-desc" className="sr-only">
            {dict.trackerDisabledAriaDescription}
          </span>
        )}
      </div>
    </div>
  );

  return (
    <div className="entei-right-panel-inner">
      {tabBar}
      {activeTab === 'captions' && (
        <div
          id="right-panel-captions"
          role="tabpanel"
          aria-label={dict.rightPanelTabCaptions}
          className="entei-right-panel-content"
        >
          <SubtitlePanel
            cues={cues}
            activeCueId={activeCueId}
            onCueClick={onCueClick}
            onSubtitleSelect={onSubtitleSelect}
            subtitleAccept={subtitleAccept}
            noSubtitlesLabel={dict.noSubtitlesLoaded}
            isLoadingSubtitles={isLoadingSubtitles}
            preparingSubtitlesLabel={dict.preparingSubtitles}
            seekToLabel={dict.seekTo}
            chooseSubtitleLabel={dict.chooseSubtitle}
            onMineCue={onMineCue}
            canMineRow={canMineRow}
            isMining={isMining}
            mineRowLabel={dict.mineRowLabel}
            mineRowDisabledLabel={dict.mineRowDisabled}
            mineCapturingLabel={dict.mineButtonCapturing}
          />
        </div>
      )}
      {activeTab === 'history' && (
        <div
          id="right-panel-history"
          role="tabpanel"
          aria-label={dict.rightPanelTabHistory}
          className="entei-right-panel-content"
        >
          {trackerSwitch}
          <MiningHistoryPanel
            emptyLabel={dict.historyEmpty}
            unavailableLabel={dict.historyUnavailable}
            sentenceLabel={dict.historySentence}
            rangeLabel={dict.historyRange}
            refreshKey={historyRefreshKey}
          />
        </div>
      )}
    </div>
  );
}
