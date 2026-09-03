/**
 * RightPanel — Tab selector switching between Captions and Nadeshiko Search.
 * ---------------------------------------------------------------------------
 * Desktop layout: placed inside a ResizablePanel (handled by PlayerApp).
 * Mobile layout: placed vertically below the player.
 * Tab state is NOT persisted; defaults to captions on each mount.
 * ---------------------------------------------------------------------------
 * The Tracker ON/OFF switch + MiningHistoryPanel moved to the Tracker
 * dashboard (/tracker/) per docs/NADESHIKO_INTEGRATION.md §3.2.
 * ---------------------------------------------------------------------------
 */
'use client';

import { useState, useCallback } from 'react';
import { Captions, BrainCircuit, RotateCwFadingClock, Search } from 'lucide-react';
import { Button } from '@/components/player/ui/button';
import { SubtitlePanel } from '@/components/player/SubtitlePanel';
import { NadeshikoPanel } from '@/components/player/NadeshikoPanel';
import { TypewriterLoading } from '@/components/player/TypewriterLoading';
import type { SubtitleCue } from '@/features/player/subtitle-reader';
import type { Dictionary } from '@i18n/types';

type RightPanelTab = 'captions' | 'context';

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
  /** Subtitle sync (stage 4a): click handler + availability. */
  onSyncSubtitle?: () => void;
  canSyncSubtitle?: boolean;
  isSyncingSubtitle?: boolean;
  /** Subtitle sync mode (subtitle / audio / auto). The button shows the
   *  TypewriterLoading while syncing only for non-audio modes — audio sync
   *  keeps the icon + label because the DL-wait dialog reports progress. */
  syncMode?: 'subtitle' | 'audio' | 'auto';
  /** Magnet source: the sync button becomes a LazySync toggle (docs
   *  SUBTITLE_SYNC.md §10) instead of the classic click-to-sync button. */
  isMagnet?: boolean;
  /** LazySync toggle state (Magnet only): true = active / colored. */
  lazySyncOn?: boolean;
  /** LazySync toggle click handler (Magnet only). */
  onToggleLazySync?: () => void;
  /** Hide the sync button entirely (YouTube source — design §2-11). */
  hideSyncSubtitle?: boolean;
  /** P4 jimaku: opens the search modal (title pre-filled from media name). */
  onOpenJimakuSearch?: () => void;
  /** AM-4 Row Mining: callback to mine a specific cue. */
  onMineCue?: (cue: SubtitleCue) => void;
  /** AM-4 Row Mining: whether row mining is available (media loaded, not capturing). */
  canMineRow?: boolean;
  /** AM-4 Row Mining: whether mining capture is currently in flight. */
  isMining?: boolean;
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
  onSyncSubtitle,
  canSyncSubtitle = false,
  isSyncingSubtitle = false,
  syncMode = 'subtitle',
  isMagnet = false,
  lazySyncOn = false,
  onToggleLazySync,
  hideSyncSubtitle = false,
  onOpenJimakuSearch,
  onMineCue,
  canMineRow,
  isMining,
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
        variant={activeTab === 'context' ? 'default' : 'ghost'}
        size="sm"
        className="entei-right-panel-tab"
        role="tab"
        aria-pressed={activeTab === 'context'}
        aria-selected={activeTab === 'context'}
        aria-controls="right-panel-context"
        aria-label={dict.contextTabLabel}
        title={dict.contextTabLabel}
        onClick={() => handleTabChange('context')}
      >
        <BrainCircuit size={16} aria-hidden="true" />
        <span className="entei-right-panel-tab-label">
          {dict.contextTabLabel}
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
          <div className="entei-right-panel-actions">
            {!hideSyncSubtitle && (
              isMagnet ? (
                /* Magnet: LazySync toggle — colored while on, click toggles.
                 * The on-state shows the static "activated" label instead of
                 * a typewriter (docs §10.3). */
                <button
                  type="button"
                  className={
                    lazySyncOn
                      ? 'entei-subtitle-sync-button entei-subtitle-sync-button--active'
                      : 'entei-subtitle-sync-button'
                  }
                  onClick={onToggleLazySync}
                  aria-label={lazySyncOn ? dict.subtitleSyncLazyOn : dict.subtitleSyncLazyOff}
                  aria-pressed={lazySyncOn}
                  title={lazySyncOn ? dict.subtitleSyncLazyOn : dict.subtitleSyncLazyOff}
                  disabled={!canSyncSubtitle}
                >
                  <RotateCwFadingClock size={16} aria-hidden="true" />
                  <span>
                    {lazySyncOn
                      ? dict.subtitleSyncLazyActive
                      : dict.subtitleSyncLazyOff}
                  </span>
                </button>
              ) : (
                /* Local media: classic click-to-sync button (unchanged). */
                <button
                  type="button"
                  className="entei-subtitle-sync-button"
                  onClick={onSyncSubtitle}
                  aria-label={dict.subtitleSyncButtonLabel}
                  title={dict.subtitleSyncButton}
                  disabled={!canSyncSubtitle || isSyncingSubtitle}
                >
                  {isSyncingSubtitle && syncMode !== 'audio' ? (
                    <TypewriterLoading
                      text="PROCESSING"
                      className="entei-typewriter--btn"
                      aria-hidden="true"
                    />
                  ) : (
                    <>
                      <RotateCwFadingClock size={16} aria-hidden="true" />
                      <span>{dict.subtitleSyncButton}</span>
                    </>
                  )}
                </button>
              )
            )}
            {onOpenJimakuSearch && (
              <button
                type="button"
                className="entei-subtitle-sync-button entei-jimaku-search-button"
                onClick={onOpenJimakuSearch}
                aria-label={dict.jimakuSearchOpenButton}
                title={dict.jimakuSearchOpenButton}
              >
                <Search size={16} aria-hidden="true" />
                <span>{dict.jimakuSearchOpenButton}</span>
              </button>
            )}
          </div>
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
      {activeTab === 'context' && (
        <div
          id="right-panel-context"
          role="tabpanel"
          aria-label={dict.contextTabLabel}
          className="entei-right-panel-content"
        >
          <NadeshikoPanel dict={dict} />
        </div>
      )}
    </div>
  );
}