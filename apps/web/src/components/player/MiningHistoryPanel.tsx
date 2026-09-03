/**
 * MiningHistoryPanel — Read-only display of successful Anki send history.
 * ---------------------------------------------------------------------------
 * Reads from the tracker's mining_archive via tracker-archive-read helper.
 * Newest-first, no delete, no media preview, no re-export.
 * Pass `refreshKey` to re-fetch after a new write.
 * Distinguishes empty history from IndexedDB unavailable.
 * ---------------------------------------------------------------------------
 */
'use client';

import { useState, useEffect } from 'react';
import {
  getTrackerHistoryEntries,
  type TrackerHistoryReadResult,
} from '@/features/player/tracker/tracker-archive-read';

interface MiningHistoryPanelProps {
  emptyLabel: string;
  unavailableLabel: string;
  sentenceLabel: string;
  rangeLabel: string;
  /** Increment to re-fetch entries from DB. */
  refreshKey?: number;
}

export function MiningHistoryPanel({
  emptyLabel,
  unavailableLabel,
  sentenceLabel,
  rangeLabel,
  refreshKey,
}: MiningHistoryPanelProps) {
  const [result, setResult] = useState<TrackerHistoryReadResult | null>(null);
  const [autoRefreshKey, setAutoRefreshKey] = useState(0);

  useEffect(() => {
    let cancelled = false;
    getTrackerHistoryEntries()
      .then((r) => {
        if (!cancelled) setResult(r);
      })
      .catch(() => {
        if (!cancelled) setResult({ ok: false, reason: 'error' });
      });
    return () => {
      cancelled = true;
    };
  }, [refreshKey, autoRefreshKey]);

  // Listen for cross-component archive writes (player Anki export).
  // Refetches the list without requiring the caller to wire a refreshKey.
  useEffect(() => {
    const handler = () => setAutoRefreshKey((n) => n + 1);
    window.addEventListener('entei:tracker-archive-changed', handler);
    return () => {
      window.removeEventListener('entei:tracker-archive-changed', handler);
    };
  }, []);

  // Loading state
  if (result === null) {
    return (
      <div className="entei-history-loading" aria-busy>
        <div className="entei-mining-skeleton" />
      </div>
    );
  }

  // IndexedDB unavailable or error
  if (!result.ok) {
    return (
      <div className="entei-history-unavailable" role="status">
        <p>{unavailableLabel}</p>
      </div>
    );
  }

  // Empty history
  if (result.entries.length === 0) {
    return (
      <div className="entei-history-empty" role="status">
        <p>{emptyLabel}</p>
      </div>
    );
  }

  return (
    <div className="entei-history-list" role="list" aria-label="Mining history">
      {result.entries.map((entry) => (
        <div key={entry.id} className="entei-history-item" role="listitem">
          {entry.sentence && (
            <p className="entei-history-sentence">
              <span className="entei-history-label">{sentenceLabel}:</span>{' '}
              {entry.sentence}
            </p>
          )}
          <p className="entei-history-range">
            <span className="entei-history-label">{rangeLabel}:</span>{' '}
            {formatSeconds(entry.rangeStart)} – {formatSeconds(entry.rangeEnd)}
          </p>
        </div>
      ))}
    </div>
  );
}

function formatSeconds(s: number): string {
  const mins = Math.floor(s / 60);
  const secs = Math.floor(s % 60);
  return `${mins}:${secs.toString().padStart(2, '0')}`;
}
