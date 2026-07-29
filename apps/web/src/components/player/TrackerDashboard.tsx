/**
 * TrackerDashboard — React client-only island for the /tracker/ page.
 * ---------------------------------------------------------------------------
 * Stage 3B: UI/CSS presentation for the read-only immersion tracker dashboard.
 *
 * Visual goal: calm local-first study record, not a productivity leaderboard.
 * No streaks, ranking, comprehension percentage, or invented stats.
 * Uses real data from the read model only.
 *
 * States:
 *   - pending     → skeleton matching the final page layout (no spinner)
 *   - unavailable → composed state with Lucide icon, no alert
 *   - ready-empty → composed state explaining local playback + Anki exports
 *   - ready       → full dashboard with 4 blocks
 *
 * This component does NOT access IndexedDB during SSR (client:only="react").
 * It does NOT alter tracker DB schemas, read model, hook behavior, or route
 * semantics. All text comes from the i18n dictionary — no hardcoded English.
 * ---------------------------------------------------------------------------
 */

'use client';

import { useState, useEffect } from 'react';
import {
  Clock,
  Film,
  Activity,
  Archive,
  DatabaseZap,
  Clapperboard,
  HardDrive,
  Repeat,
  Pause,
  Rewind,
  Gem,
  Subtitles,
} from 'lucide-react';
import { useTrackerDashboard } from '@/features/player/tracker/useTrackerDashboard';
import type { TrackerDashboardReadModel } from '@/features/player/tracker/tracker-dashboard-read';
import {
  LOCALE_CHANGE_EVENT,
  type LocaleChangeDetail,
} from '@i18n/locale-events';
import { getDictionary } from '@i18n/index';
import type { Dictionary, Locale } from '@i18n/types';

/* ------------------------------------------------------------------------ */
/* Formatting helpers                                                        */
/* ------------------------------------------------------------------------ */

/**
 * Format milliseconds to a compact human-readable duration.
 * Shows seconds for sub-minute values (useful for bucket-level data).
 * Examples: 0 → "0s", 1000 → "1s", 45000 → "45s", 65000 → "1m 5s".
 */
function formatDuration(ms: number): string {
  if (ms <= 0) return '0s';
  const totalSec = Math.floor(ms / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

/**
 * Format a timeline second offset as M:SS or H:MM:SS.
 * Examples: 0 → "0:00", 30 → "0:30", 65 → "1:05", 3661 → "1:01:01".
 */
function formatTimeline(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  if (h > 0) {
    return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  }
  return `${m}:${String(s).padStart(2, '0')}`;
}

/* ------------------------------------------------------------------------ */
/* Locale hook                                                               */
/* ------------------------------------------------------------------------ */

function getInitialLocale(): Locale {
  const lang = document.documentElement.lang;
  if (lang === 'ja' || lang === 'en') return lang;
  return 'id';
}

/* ------------------------------------------------------------------------ */
/* Skeleton (pending state)                                                  */
/* ------------------------------------------------------------------------ */

function TrackerSkeleton() {
  return (
    <div
      data-testid="tracker-dashboard-pending"
      className="entei-tracker-skeleton"
      aria-busy="true"
    >
      {/* Header skeleton */}
      <div className="entei-tracker-skeleton-header">
        <div className="entei-tracker-skeleton-line entei-tracker-skeleton-line--title" />
        <div className="entei-tracker-skeleton-line entei-tracker-skeleton-line--subtitle" />
      </div>

      {/* Today skeleton */}
      <div className="entei-tracker-skeleton-block">
        <div className="entei-tracker-skeleton-line entei-tracker-skeleton-line--section" />
        <div className="entei-tracker-skeleton-line entei-tracker-skeleton-line--hero" />
        <div className="entei-tracker-skeleton-grid">
          {Array.from({ length: 5 }, (_, i) => (
            <div
              key={i}
              className="entei-tracker-skeleton-line entei-tracker-skeleton-line--metric"
            />
          ))}
        </div>
      </div>

      {/* Media skeleton */}
      <div className="entei-tracker-skeleton-block">
        <div className="entei-tracker-skeleton-line entei-tracker-skeleton-line--section" />
        <div className="entei-tracker-skeleton-line entei-tracker-skeleton-line--row" />
        <div className="entei-tracker-skeleton-line entei-tracker-skeleton-line--row" />
      </div>

      {/* Moments skeleton */}
      <div className="entei-tracker-skeleton-block">
        <div className="entei-tracker-skeleton-line entei-tracker-skeleton-line--section" />
        <div className="entei-tracker-skeleton-line entei-tracker-skeleton-line--row" />
        <div className="entei-tracker-skeleton-line entei-tracker-skeleton-line--row" />
      </div>

      {/* Archive skeleton */}
      <div className="entei-tracker-skeleton-block">
        <div className="entei-tracker-skeleton-line entei-tracker-skeleton-line--section" />
        <div className="entei-tracker-skeleton-line entei-tracker-skeleton-line--row" />
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------------ */
/* Unavailable state                                                         */
/* ------------------------------------------------------------------------ */

function TrackerUnavailable({
  reason,
  t,
}: {
  reason: string;
  t: Dictionary['trackerDashboard'];
}) {
  return (
    <div data-testid="tracker-dashboard-unavailable" className="entei-tracker-state">
      <DatabaseZap
        size={48}
        className="entei-tracker-state-icon"
        aria-label={t.unavailableIconLabel}
        role="img"
      />
      <h2 className="entei-tracker-state-title">{t.unavailableTitle}</h2>
      <p className="entei-tracker-state-desc">{t.unavailableDesc}</p>
      <p className="entei-tracker-state-desc entei-tracker-state-reason">
        {reason}
      </p>
    </div>
  );
}

/* ------------------------------------------------------------------------ */
/* Ready-empty state                                                         */
/* ------------------------------------------------------------------------ */

function TrackerReadyEmpty({
  t,
}: {
  t: Dictionary['trackerDashboard'];
}) {
  return (
    <div data-testid="tracker-dashboard-empty" className="entei-tracker-state">
      <Clapperboard
        size={48}
        className="entei-tracker-state-icon"
        aria-label={t.emptyIconLabel}
        role="img"
      />
      <h2 className="entei-tracker-state-title">{t.emptyTitle}</h2>
      <p className="entei-tracker-state-desc">{t.emptyDesc}</p>
    </div>
  );
}

/* ------------------------------------------------------------------------ */
/* Today summary                                                             */
/* ------------------------------------------------------------------------ */

function TodaySummary({
  model,
  t,
}: {
  model: TrackerDashboardReadModel;
  t: Dictionary['trackerDashboard'];
}) {
  const today = model.today;

  return (
    <section
      data-testid="tracker-today"
      className="entei-tracker-section entei-tracker-today"
      aria-label={t.todaySectionLabel}
    >
      <div className="entei-tracker-section-header">
        <Clock size={16} className="entei-tracker-section-icon" aria-hidden="true" />
        <h2 className="entei-tracker-section-title">
          {t.todayLabel} — {t.todayDate(today.localDay)}
        </h2>
      </div>

      {/* Hero metric: foreground watch */}
      <div className="entei-tracker-today-hero">
        <span className="entei-tracker-today-hero-label">{t.foregroundWatch}</span>
        <span
          className="entei-tracker-today-hero-value"
          data-testid="today-foreground"
          aria-label={`${t.foregroundWatch}: ${formatDuration(today.foregroundWatchMs)}`}
        >
          {formatDuration(today.foregroundWatchMs)}
        </span>
      </div>

      {/* Secondary metrics */}
      <dl className="entei-tracker-today-grid">
        <div className="entei-tracker-metric">
          <dt className="entei-tracker-metric-label">{t.mediaProgress}</dt>
          <dd
            className="entei-tracker-metric-value"
            data-testid="today-media-progress"
          >
            {formatDuration(today.mediaProgressMs)}
          </dd>
        </div>
        <div className="entei-tracker-metric">
          <dt className="entei-tracker-metric-label">{t.subtitleExposure}</dt>
          <dd
            className="entei-tracker-metric-value"
            data-testid="today-subtitle"
          >
            {formatDuration(today.subtitleExposureMs)}
          </dd>
        </div>
        <div className="entei-tracker-metric">
          <dt className="entei-tracker-metric-label">{t.condensedSkipped}</dt>
          <dd
            className={`entei-tracker-metric-value ${
              today.condensedSkippedMs > 0
                ? ''
                : 'entei-tracker-metric-value--muted'
            }`}
            data-testid="today-condensed"
          >
            {formatDuration(today.condensedSkippedMs)}
          </dd>
        </div>
        <div className="entei-tracker-metric">
          <dt className="entei-tracker-metric-label">{t.fastForwardWall}</dt>
          <dd
            className={`entei-tracker-metric-value ${
              today.fastForwardWallMs > 0
                ? ''
                : 'entei-tracker-metric-value--muted'
            }`}
            data-testid="today-ff-wall"
          >
            {formatDuration(today.fastForwardWallMs)}
          </dd>
        </div>
        <div className="entei-tracker-metric">
          <dt className="entei-tracker-metric-label">{t.fastForwardMedia}</dt>
          <dd
            className={`entei-tracker-metric-value ${
              today.fastForwardMediaMs > 0
                ? ''
                : 'entei-tracker-metric-value--muted'
            }`}
            data-testid="today-ff-media"
          >
            {formatDuration(today.fastForwardMediaMs)}
          </dd>
        </div>
      </dl>
    </section>
  );
}

/* ------------------------------------------------------------------------ */
/* Media list                                                                */
/* ------------------------------------------------------------------------ */

function MediaList({
  model,
  t,
}: {
  model: TrackerDashboardReadModel;
  t: Dictionary['trackerDashboard'];
}) {
  return (
    <section
      data-testid="tracker-media-list"
      className="entei-tracker-section"
      aria-label={t.mediaSectionLabel}
    >
      <div className="entei-tracker-section-header">
        <Film size={16} className="entei-tracker-section-icon" aria-hidden="true" />
        <h2 className="entei-tracker-section-title">{t.mediaLabel}</h2>
      </div>

      {model.mediaList.length === 0 ? (
        <p className="entei-tracker-empty-section" data-testid="media-list-empty">
          {t.mediaEmpty}
        </p>
      ) : (
        <ul className="entei-tracker-media-list">
          {model.mediaList.map(({ media, learningSets }) => (
            <li
              key={media.mediaId}
              className="entei-tracker-media-item"
              data-testid={`media-item-${media.mediaId}`}
            >
              <div className="entei-tracker-media-row">
                <span className="entei-tracker-media-name">
                  {media.displayName}
                </span>
                <span className="entei-tracker-media-meta">
                  {media.firstSeenDay} — {media.lastSeenDay}
                </span>
                <span className="entei-tracker-media-meta">
                  {formatDuration(media.totals.foregroundWatchMs)}
                </span>
              </div>

              {learningSets.length > 0 && (
                <ul className="entei-tracker-ls-list">
                  {learningSets.map((ls) => (
                    <li
                      key={ls.learningSetId}
                      className="entei-tracker-ls-item"
                      data-testid={`ls-item-${ls.learningSetId}`}
                    >
                      <Subtitles
                        size={12}
                        aria-hidden="true"
                        className="entei-tracker-ls-icon"
                      />
                      <span className="entei-tracker-ls-id">{ls.subtitleId}</span>
                      <span className="entei-tracker-ls-total">
                        {formatDuration(ls.totals.foregroundWatchMs)}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/* ------------------------------------------------------------------------ */
/* i+1 Moments                                                               */
/* ------------------------------------------------------------------------ */

function Moments({
  model,
  t,
}: {
  model: TrackerDashboardReadModel;
  t: Dictionary['trackerDashboard'];
}) {
  return (
    <section
      data-testid="tracker-moments"
      className="entei-tracker-section"
      aria-label={t.momentsSectionLabel}
    >
      <div className="entei-tracker-section-header">
        <Activity size={16} className="entei-tracker-section-icon" aria-hidden="true" />
        <h2 className="entei-tracker-section-title">{t.momentsLabel}</h2>
      </div>

      {model.moments.length === 0 ? (
        <p className="entei-tracker-empty-section" data-testid="moments-empty">
          {t.momentsEmpty}
        </p>
      ) : (
        <ul className="entei-tracker-moments-list">
          {model.moments.map((group) => (
            <li
              key={group.learningSetId}
              className="entei-tracker-moment-group"
              data-testid={`moment-group-${group.learningSetId}`}
            >
              <div className="entei-tracker-moment-group-header">
                {group.learningSetId}
              </div>
              <ul className="entei-tracker-bucket-list">
                {group.buckets.map((b) => {
                  const range = `${formatTimeline(b.bucketStart)}–${formatTimeline(
                    b.bucketEnd,
                  )}`;
                  return (
                    <li
                      key={b.bucketStart}
                      className="entei-tracker-bucket"
                      data-testid={`bucket-${group.learningSetId}-${b.bucketStart}`}
                    >
                      <span
                        className="entei-tracker-bucket-range"
                        aria-label={t.momentsColumnBucket}
                      >
                        {range}
                      </span>
                      <div className="entei-tracker-bucket-signals">
                        <span
                          className={`entei-tracker-signal ${
                            b.foregroundWatchMs > 0 ? '' : 'entei-tracker-signal--zero'
                          }`}
                          aria-label={`${t.momentsColumnWatch}: ${formatDuration(
                            b.foregroundWatchMs,
                          )}`}
                        >
                          <Clock size={12} aria-hidden="true" />
                          {formatDuration(b.foregroundWatchMs)}
                        </span>
                        <span
                          className={`entei-tracker-signal ${
                            b.passCount > 0 ? '' : 'entei-tracker-signal--zero'
                          }`}
                          aria-label={`${t.bucketPasses}: ${b.passCount}`}
                        >
                          <Repeat size={12} aria-hidden="true" />
                          {b.passCount}
                        </span>
                        <span
                          className={`entei-tracker-signal ${
                            b.pauseCount > 0 ? '' : 'entei-tracker-signal--zero'
                          }`}
                          aria-label={`${t.bucketPauses}: ${b.pauseCount}`}
                        >
                          <Pause size={12} aria-hidden="true" />
                          {b.pauseCount}
                        </span>
                        <span
                          className={`entei-tracker-signal ${
                            b.manualBackwardSeekCount > 0
                              ? ''
                              : 'entei-tracker-signal--zero'
                          }`}
                          aria-label={`${t.bucketSeeks}: ${b.manualBackwardSeekCount}`}
                        >
                          <Rewind size={12} aria-hidden="true" />
                          {b.manualBackwardSeekCount}
                        </span>
                        <span
                          className={`entei-tracker-signal ${
                            b.mineCount > 0 ? '' : 'entei-tracker-signal--zero'
                          }`}
                          aria-label={`${t.bucketMines}: ${b.mineCount}`}
                        >
                          <Gem size={12} aria-hidden="true" />
                          {b.mineCount}
                        </span>
                      </div>
                    </li>
                  );
                })}
              </ul>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/* ------------------------------------------------------------------------ */
/* Mining archive                                                            */
/* ------------------------------------------------------------------------ */

function MiningArchive({
  model,
  t,
}: {
  model: TrackerDashboardReadModel;
  t: Dictionary['trackerDashboard'];
}) {
  return (
    <section
      data-testid="tracker-archive"
      className="entei-tracker-section"
      aria-label={t.archiveSectionLabel}
    >
      <div className="entei-tracker-section-header">
        <Archive size={16} className="entei-tracker-section-icon" aria-hidden="true" />
        <h2 className="entei-tracker-section-title">{t.archiveLabel}</h2>
      </div>

      {model.archive.length === 0 ? (
        <p className="entei-tracker-empty-section" data-testid="archive-empty">
          {t.archiveEmpty}
        </p>
      ) : (
        <ul className="entei-tracker-archive-list">
          {model.archive.map((entry) => (
            <li
              key={entry.id}
              className="entei-tracker-archive-item"
              data-testid={`archive-${entry.id}`}
            >
              <div className="entei-tracker-archive-meta">
                <span className="entei-tracker-archive-name">
                  {entry.displayName}
                </span>
                <span className="entei-tracker-archive-range">
                  [{formatTimeline(entry.rangeStart)}–{formatTimeline(entry.rangeEnd)}]
                </span>
                <time className="entei-tracker-archive-date" dateTime={entry.localDay}>
                  {entry.localDay}
                </time>
              </div>
              <p className="entei-tracker-archive-sentence">{entry.sentence}</p>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/* ------------------------------------------------------------------------ */
/* Ready dashboard                                                           */
/* ------------------------------------------------------------------------ */

function TrackerReady({
  model,
  t,
}: {
  model: TrackerDashboardReadModel;
  t: Dictionary['trackerDashboard'];
}) {
  const isEmpty =
    model.mediaList.length === 0 &&
    model.moments.length === 0 &&
    model.archive.length === 0;

  if (isEmpty) {
    return <TrackerReadyEmpty t={t} />;
  }

  return (
    <div data-testid="tracker-dashboard-ready" className="entei-tracker-dashboard">
      {/* Header: restrained, left-aligned, no hero */}
      <header className="entei-tracker-header">
        <div className="entei-tracker-header-top">
          <h1 className="entei-tracker-title">{t.title}</h1>
          <span className="entei-tracker-local-badge">
            <HardDrive size={12} aria-hidden="true" />
            {t.localOnlyBadge}
          </span>
        </div>
        <p className="entei-tracker-subtitle">{t.subtitle}</p>
      </header>

      <TodaySummary model={model} t={t} />
      <MediaList model={model} t={t} />
      <Moments model={model} t={t} />
      <MiningArchive model={model} t={t} />
    </div>
  );
}

/* ------------------------------------------------------------------------ */
/* Main component                                                            */
/* ------------------------------------------------------------------------ */

export default function TrackerDashboard() {
  const [locale, setLocale] = useState<Locale>(getInitialLocale);
  const state = useTrackerDashboard();

  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent<LocaleChangeDetail>).detail;
      if (detail?.locale) {
        setLocale(detail.locale);
      }
    };
    window.addEventListener(LOCALE_CHANGE_EVENT, handler);
    return () => window.removeEventListener(LOCALE_CHANGE_EVENT, handler);
  }, []);

  const dict = getDictionary(locale);
  const t = dict.trackerDashboard;

  if (state.status === 'pending') {
    return (
      <div className="entei-tracker-root">
        <TrackerSkeleton />
      </div>
    );
  }

  if (state.status === 'unavailable') {
    return (
      <div className="entei-tracker-root">
        <TrackerUnavailable reason={state.reason} t={t} />
      </div>
    );
  }

  return (
    <div className="entei-tracker-root">
      <TrackerReady model={state.model} t={t} />
    </div>
  );
}
