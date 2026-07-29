/**
 * IMMERSION_TRACKER — React data hook for the /tracker/ dashboard page.
 * ---------------------------------------------------------------------------
 * Stage 3A: Client-only lifecycle for loading the tracker read model.
 *
 * States:
 *   - pending: initial mount, IndexedDB read in progress
 *   - ready: model loaded successfully (may be empty if no data)
 *   - unavailable: IndexedDB unavailable or open failed (local-only error)
 *
 * Design:
 *   - Loads only on mount (no polling, no writes, no deletion).
 *   - Never accesses IndexedDB during SSR (client:only guard).
 *   - Returns a typed state — errors are surfaced as state, not thrown.
 * ---------------------------------------------------------------------------
 */

import { useState, useEffect } from 'react';
import {
  getTrackerDashboard,
  type TrackerDashboardReadModel,
} from './tracker-dashboard-read';

/* ------------------------------------------------------------------------ */
/* Hook state types                                                          */
/* ------------------------------------------------------------------------ */

export interface TrackerDashboardPending {
  status: 'pending';
}

export interface TrackerDashboardReady {
  status: 'ready';
  model: TrackerDashboardReadModel;
}

export interface TrackerDashboardUnavailable {
  status: 'unavailable';
  reason: string;
}

export type TrackerDashboardState =
  | TrackerDashboardPending
  | TrackerDashboardReady
  | TrackerDashboardUnavailable;

/* ------------------------------------------------------------------------ */
/* Hook                                                                      */
/* ------------------------------------------------------------------------ */

/**
 * React hook that loads the tracker dashboard read model on mount.
 *
 * Returns a discriminated union state:
 *   - `{ status: 'pending' }` — loading
 *   - `{ status: 'ready', model }` — data loaded (model may be empty)
 *   - `{ status: 'unavailable', reason }` — IndexedDB unavailable
 *
 * No polling, no writes, no cleanup beyond state transitions.
 */
export function useTrackerDashboard(): TrackerDashboardState {
  const [state, setState] = useState<TrackerDashboardState>({
    status: 'pending',
  });

  useEffect(() => {
    let cancelled = false;

    async function load() {
      try {
        const model = await getTrackerDashboard();
        if (cancelled) return;

        if (model.available) {
          setState({ status: 'ready', model });
        } else {
          setState({
            status: 'unavailable',
            reason: 'IndexedDB unavailable or tracker database not initialized',
          });
        }
      } catch (err) {
        if (cancelled) return;
        setState({
          status: 'unavailable',
          reason:
            err instanceof Error ? err.message : 'Unexpected error loading tracker data',
        });
      }
    }

    load();

    return () => {
      cancelled = true;
    };
  }, []);

  return state;
}
