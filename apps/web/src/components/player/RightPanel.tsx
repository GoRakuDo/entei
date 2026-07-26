/**
 * RightPanel — Tab selector switching between Captions and Mining History.
 * ---------------------------------------------------------------------------
 * Desktop layout: placed inside a ResizablePanel (handled by PlayerApp).
 * Mobile layout: placed vertically below the player.
 * Tab state is NOT persisted; defaults to captions on each mount.
 * ---------------------------------------------------------------------------
 */
'use client';

import { useState, useCallback } from 'react';
import { Captions, History } from 'lucide-react';
import { Button } from '@/components/player/ui/button';
import { SubtitlePanel } from '@/components/player/SubtitlePanel';
import { MiningHistoryPanel } from '@/components/player/MiningHistoryPanel';
import type { SubtitleCue } from '@/features/player/subtitle-reader';
import type { Dictionary } from '@i18n/types';

type RightPanelTab = 'captions' | 'history';

interface RightPanelProps {
  /** Whether the panel is visible at all (controlled by existing toggle). */
  visible: boolean;
  dict: Dictionary['playerUI'];
  /** Subtitle panel props */
  cues: SubtitleCue[];
  activeCueId: number | null;
  onCueClick: (cue: SubtitleCue) => void;
  onSubtitleSelect: (file: File | null) => void;
  subtitleAccept: string;
  /** History panel refresh trigger — increment after a successful Anki send. */
  historyRefreshKey?: number;
}

export function RightPanel({
  visible,
  dict,
  cues,
  activeCueId,
  onCueClick,
  onSubtitleSelect,
  subtitleAccept,
  historyRefreshKey,
}: RightPanelProps) {
  const [activeTab, setActiveTab] = useState<RightPanelTab>('captions');

  const handleTabChange = useCallback((tab: RightPanelTab) => {
    setActiveTab(tab);
  }, []);

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
            subtitlesLabel={dict.subtitles}
            cuesCountLabel={dict.cuesCount}
            noSubtitlesLabel={dict.noSubtitlesLoaded}
            seekToLabel={dict.seekTo}
            chooseSubtitleLabel={dict.chooseSubtitle}
            changeSubtitleLabel={dict.changeSubtitle}
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
