'use client';

import { useEffect, useRef, useState } from 'react';
import {
  ArrowDownFromLine,
  ChevronDown,
  History,
  ImageUp,
  Save,
  SquarePen,
  X,
} from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/player/ui/button';
import { ButtonGroup } from '@/components/player/ui/button-group';
import { Input } from '@/components/player/ui/input';
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from '@/components/player/ui/tabs';
import TrackerDashboard from '@/components/player/TrackerDashboard';
import {
  getAllWatchHistory,
  type WatchHistoryRecord,
} from '@/features/player/watch-history';
import {
  getWatchSessionsForMedia,
  type WatchSessionRecord,
} from '@/features/player/watch-sessions';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/player/ui/dialog';
import {
  PROFILE_AVATAR_MAX_BYTES,
  PROFILE_BIO_MAX_LENGTH,
  getProfileAvatarDataUrlBytes,
  readLocalProfile,
  setLocalProfileAvatar,
  setLocalProfileBio,
  setLocalProfileName,
  truncateProfileBio,
  type LocalProfile,
} from '@/features/player/profile/profile-store';
import {
  LOCALE_CHANGE_EVENT,
  type LocaleChangeDetail,
} from '@i18n/locale-events';
import { getDictionary } from '@i18n/index';
import type { Dictionary, Locale } from '@i18n/types';

const PROFILE_AVATAR_SIZE = 256;

function getInitialLocale(): Locale {
  const lang = document.documentElement.lang;
  if (lang === 'ja' || lang === 'en') return lang;
  return 'id';
}

function processProfileAvatar(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    if (!file.type.startsWith('image/')) {
      reject(new Error('not-an-image'));
      return;
    }

    const objectUrl = URL.createObjectURL(file);
    const image = new Image();
    image.onload = () => {
      URL.revokeObjectURL(objectUrl);
      const sourceSize = Math.min(image.naturalWidth, image.naturalHeight);
      if (sourceSize === 0) {
        reject(new Error('invalid-image'));
        return;
      }

      const canvas = document.createElement('canvas');
      canvas.width = PROFILE_AVATAR_SIZE;
      canvas.height = PROFILE_AVATAR_SIZE;
      const context = canvas.getContext('2d');
      if (context === null) {
        reject(new Error('canvas-unavailable'));
        return;
      }

      const sourceX = (image.naturalWidth - sourceSize) / 2;
      const sourceY = (image.naturalHeight - sourceSize) / 2;
      context.drawImage(
        image,
        sourceX,
        sourceY,
        sourceSize,
        sourceSize,
        0,
        0,
        PROFILE_AVATAR_SIZE,
        PROFILE_AVATAR_SIZE,
      );
      resolve(canvas.toDataURL('image/webp', 0.85));
    };
    image.onerror = () => {
      URL.revokeObjectURL(objectUrl);
      reject(new Error('invalid-image'));
    };
    image.src = objectUrl;
  });
}

function ProfileAvatar({
  profile,
  t,
  isEditing,
  onAvatarChange,
}: {
  profile: LocalProfile;
  t: Dictionary['profile'];
  isEditing: boolean;
  onAvatarChange: (file: File) => Promise<void>;
}) {
  const fileInputRef = useRef<HTMLInputElement>(null);

  const openFilePicker = () => fileInputRef.current?.click();
  const handleFileChange = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (file !== undefined) await onAvatarChange(file);
  };

  return (
    <div className="entei-profile-avatar-frame">
      <img
        className="entei-profile-avatar"
        src={profile.avatar}
        alt={t.avatarAlt}
      />
      {isEditing && (
        <>
          <button
            type="button"
            className="entei-profile-avatar-overlay"
            onClick={openFilePicker}
            aria-label={t.changeAvatar}
          >
            <ImageUp aria-hidden="true" />
          </button>
          <input
            ref={fileInputRef}
            className="entei-profile-file-input"
            type="file"
            accept="image/*"
            onChange={handleFileChange}
            aria-label={t.changeAvatar}
          />
        </>
      )}
    </div>
  );
}

function ProfileHeader({
  profile,
  t,
  onProfileChange,
}: {
  profile: LocalProfile;
  t: Dictionary['profile'];
  onProfileChange: (profile: LocalProfile) => void;
}) {
  const [isEditing, setIsEditing] = useState(false);
  const [nameDraft, setNameDraft] = useState(profile.name);
  const [bioDraft, setBioDraft] = useState(profile.bio);
  const [avatarDraft, setAvatarDraft] = useState(profile.avatar);
  const [avatarError, setAvatarError] = useState<string | null>(null);

  useEffect(() => {
    if (!isEditing) {
      setNameDraft(profile.name);
      setBioDraft(profile.bio);
      setAvatarDraft(profile.avatar);
    }
  }, [isEditing, profile]);

  const startEditing = () => {
    setNameDraft(profile.name);
    setBioDraft(profile.bio);
    setAvatarDraft(profile.avatar);
    setAvatarError(null);
    setIsEditing(true);
  };

  const closeEditing = () => {
    setAvatarError(null);
    setIsEditing(false);
    onProfileChange(readLocalProfile());
  };

  const saveProfile = () => {
    const namedProfile = setLocalProfileName(nameDraft);
    const savedProfile = setLocalProfileBio(truncateProfileBio(bioDraft));
    onProfileChange({ ...savedProfile, avatar: avatarDraft || namedProfile.avatar });
    setIsEditing(false);
  };

  const updateBio = (value: string) => {
    setBioDraft(truncateProfileBio(value));
  };

  const updateAvatar = async (file: File) => {
    try {
      const dataUrl = await processProfileAvatar(file);
      if (getProfileAvatarDataUrlBytes(dataUrl) > PROFILE_AVATAR_MAX_BYTES) {
        throw new Error('avatar-too-large');
      }
      const next = setLocalProfileAvatar(dataUrl);
      setAvatarDraft(next.avatar);
      onProfileChange(next);
      setAvatarError(null);
    } catch (error) {
      const message =
        error instanceof Error && error.message === 'avatar-too-large'
          ? t.avatarUploadTooLarge
          : t.avatarUploadError;
      setAvatarError(message);
      toast.error(message);
    }
  };

  return (
    <section className="entei-profile-header" aria-labelledby="profile-title">
      <div className="entei-profile-identity">
        <ProfileAvatar
          profile={{ ...profile, avatar: avatarDraft }}
          t={t}
          isEditing={isEditing}
          onAvatarChange={updateAvatar}
        />

        <div className="entei-profile-fields">
          {isEditing ? (
            <>
              <div className="entei-profile-field">
                <div className="entei-profile-name-controls">
                  <Input
                    id="profile-name"
                    value={nameDraft}
                    onChange={(event) => setNameDraft(event.target.value)}
                    aria-label={t.nameLabel}
                  />
                  <ButtonGroup className="entei-profile-edit-actions entei-profile-edit-actions--desktop">
                    <Button
                      type="button"
                      variant="secondary"
                      className="entei-profile-solid-btn"
                      onClick={saveProfile}
                    >
                      <Save aria-hidden="true" />
                      {t.saveProfile}
                    </Button>
                    <Button
                      type="button"
                      variant="destructive"
                      size="icon"
                      onClick={closeEditing}
                      aria-label={t.closeEdit}
                      title={t.closeEdit}
                    >
                      <X aria-hidden="true" />
                    </Button>
                  </ButtonGroup>
                  <ButtonGroup
                    className="entei-profile-edit-actions entei-profile-edit-actions--mobile"
                    orientation="vertical"
                  >
                    <Button
                      type="button"
                      variant="secondary"
                      className="entei-profile-solid-btn"
                      onClick={saveProfile}
                    >
                      <Save aria-hidden="true" />
                      {t.saveProfile}
                    </Button>
                    <Button
                      type="button"
                      variant="destructive"
                      onClick={closeEditing}
                      aria-label={t.closeEdit}
                      title={t.closeEdit}
                    >
                      <X aria-hidden="true" />
                      {t.closeEdit}
                    </Button>
                  </ButtonGroup>
                </div>
              </div>
              <div className="entei-profile-field entei-profile-bio-field--desktop">
                <textarea
                  id="profile-bio-desktop"
                  className="entei-profile-textarea"
                  value={bioDraft}
                  maxLength={PROFILE_BIO_MAX_LENGTH}
                  onChange={(event) => updateBio(event.target.value)}
                  aria-label={t.bioLabel}
                  aria-describedby="profile-bio-count-desktop"
                  rows={4}
                />
                <span id="profile-bio-count-desktop" className="entei-profile-counter" aria-live="polite">
                  {t.bioCount(bioDraft.length)}
                </span>
              </div>
              {avatarError !== null && (
                <p className="entei-profile-avatar-error" role="alert">
                  {avatarError}
                </p>
              )}
            </>
          ) : (
            <div className="entei-profile-view">
              <div className="entei-profile-view-header">
                <h1 id="profile-title" className="entei-profile-title">
                  {profile.name}
                </h1>
                <Button
                  type="button"
                  variant="secondary"
                  className="entei-profile-solid-btn"
                  onClick={startEditing}
                >
                  <SquarePen aria-hidden="true" />
                  {t.editProfileShort}
                </Button>
              </div>
              {avatarError !== null && (
                <p className="entei-profile-avatar-error" role="alert">
                  {avatarError}
                </p>
              )}
              {profile.bio !== '' && (
                <p className="entei-profile-bio entei-profile-bio--desktop-view">{profile.bio}</p>
              )}
            </div>
          )}
        </div>
        {isEditing && (
          <div className="entei-profile-field entei-profile-bio-field--mobile">
            <textarea
              id="profile-bio"
              className="entei-profile-textarea"
              value={bioDraft}
              maxLength={PROFILE_BIO_MAX_LENGTH}
              onChange={(event) => updateBio(event.target.value)}
              aria-label={t.bioLabel}
              aria-describedby="profile-bio-count"
              rows={4}
            />
            <span id="profile-bio-count" className="entei-profile-counter" aria-live="polite">
              {t.bioCount(bioDraft.length)}
            </span>
          </div>
        )}
        {!isEditing && profile.bio !== '' && (
          <p className="entei-profile-bio entei-profile-bio--mobile-view">{profile.bio}</p>
        )}
      </div>
    </section>
  );
}

function formatWatchedAt(timestamp: number, locale: Locale): string {
  return new Intl.DateTimeFormat(locale, {
    dateStyle: 'medium',
  }).format(new Date(timestamp));
}

function formatWatchDuration(milliseconds: number, t: Dictionary['profile']): string {
  const totalSeconds = Math.max(0, Math.round(milliseconds / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  return t.watchDuration(hours, minutes, seconds);
}

function WatchSessionDrawer({
  record,
  locale,
  t,
  open,
  onOpenChange,
}: {
  record: WatchHistoryRecord | null;
  locale: Locale;
  t: Dictionary['profile'];
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [sessions, setSessions] = useState<WatchSessionRecord[] | null>(null);
  const [expandedSessionId, setExpandedSessionId] = useState<string | null>(null);

  useEffect(() => {
    if (!open || !record) return;
    let active = true;
    setSessions(null);
    setExpandedSessionId(null);
    void getWatchSessionsForMedia(record.mediaId).then((next) => {
      if (active) setSessions(next);
    });
    return () => {
      active = false;
    };
  }, [open, record]);

  const displayTitle =
    record && locale === 'ja' && record.titleNative
      ? record.titleNative
      : record?.title ?? '';
  const totalWatchMs = sessions?.reduce((total, session) => total + session.watchMs, 0) ?? 0;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="entei-profile-watch-sessions-drawer"
        closeLabel={t.watchSessionClose}
      >
        <DialogHeader>
          <DialogTitle>{t.watchSessionsTitle}</DialogTitle>
          <DialogDescription>
            {displayTitle}
            {sessions !== null && (
              <span className="entei-profile-watch-sessions-summary">
                {t.watchSessionsSummary(
                  sessions.length,
                  formatWatchDuration(totalWatchMs, t),
                )}
              </span>
            )}
          </DialogDescription>
        </DialogHeader>
        {sessions === null ? (
          <p className="entei-profile-watch-sessions-status" role="status" aria-busy="true">
            {t.watchSessionsLoading}
          </p>
        ) : sessions.length === 0 ? (
          <p className="entei-profile-watch-sessions-status">{t.watchSessionsEmpty}</p>
        ) : (
          <ol className="entei-profile-watch-session-list">
            {sessions.map((session) => {
              const expanded = expandedSessionId === session.sessionId;
              return (
                <li key={session.sessionId} className="entei-profile-watch-session">
                  <button
                    type="button"
                    className="entei-profile-watch-session-trigger"
                    aria-expanded={expanded}
                    onClick={() =>
                      setExpandedSessionId(expanded ? null : session.sessionId)
                    }
                  >
                    <span>
                      <span className="entei-profile-watch-session-date">
                        {t.watchSessionDate(formatWatchedAt(session.startedAt, locale))}
                      </span>
                      <span className="entei-profile-watch-session-meta">
                        {t.watchSessionDuration(formatWatchDuration(session.watchMs, t))}
                        {' · '}
                        {t.watchSessionEpisode(session.episode)}
                      </span>
                    </span>
                    <ChevronDown
                      size={18}
                      aria-hidden="true"
                      className={expanded ? 'entei-profile-watch-session-chevron--open' : ''}
                    />
                  </button>
                  {expanded && (
                    <div className="entei-profile-watch-session-details">
                      <h3>{t.watchSessionSentences}</h3>
                      {session.minedSentences.length === 0 ? (
                        <p>{t.watchSessionSentencesEmpty}</p>
                      ) : (
                        <ul>
                          {session.minedSentences.map((sentence, index) => (
                            <li key={`${session.sessionId}-${index}`}>{sentence}</li>
                          ))}
                        </ul>
                      )}
                    </div>
                  )}
                </li>
              );
            })}
          </ol>
        )}
      </DialogContent>
    </Dialog>
  );
}

function HistoryCard({
  record,
  locale,
  t,
  onClick,
}: {
  record: WatchHistoryRecord;
  locale: Locale;
  t: Dictionary['profile'];
  onClick: () => void;
}) {
  const [posterFailed, setPosterFailed] = useState(false);
  const posterSrc =
    record.posterStatus === 'ready' ? (record.posterUrl ?? undefined) : undefined;
  const showPoster = posterSrc !== undefined && !posterFailed;
  const displayTitle =
    locale === 'ja' && record.titleNative ? record.titleNative : record.title;
  const letter = displayTitle.trim().slice(0, 1).toUpperCase() || '？';
  const posterClassName =
    record.source === 'youtube'
      ? 'entei-profile-history-poster entei-profile-history-poster--youtube'
      : record.source === 'audio'
        ? 'entei-profile-history-poster entei-profile-history-poster--audio'
        : 'entei-profile-history-poster';

  return (
    <button
      type="button"
      className="entei-profile-history-card"
      onClick={onClick}
    >
      <div className={posterClassName} aria-hidden={showPoster}>
        {showPoster && posterSrc !== undefined ? (
          <img
            src={posterSrc}
            alt=""
            loading="lazy"
            decoding="async"
            onError={() => setPosterFailed(true)}
          />
        ) : (
          <span className="entei-profile-history-letter">{letter}</span>
        )}
      </div>
      <div className="entei-profile-history-card-body">
        <h3 title={displayTitle}>{displayTitle}</h3>
        <p>{t.contentHistoryEpisode(record.episode)}</p>
        <p>{t.contentHistoryWatchedAt(formatWatchedAt(record.watchedAt, locale))}</p>
      </div>
    </button>
  );
}

function isMobileHistoryLayout(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(max-width: 767px)').matches
  );
}

function HistorySection({
  records,
  locale,
  t,
  source,
  heading,
  onHistoryCardClick,
  desktopInitialCount,
  mobileInitialCount,
}: {
  records: WatchHistoryRecord[];
  locale: Locale;
  t: Dictionary['profile'];
  source: WatchHistoryRecord['source'];
  heading: string;
  onHistoryCardClick: (record: WatchHistoryRecord) => void;
  desktopInitialCount: number;
  mobileInitialCount: number;
}) {
  const [isMobile, setIsMobile] = useState(isMobileHistoryLayout);
  const [page, setPage] = useState(1);

  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return;
    const mediaQuery = window.matchMedia('(max-width: 767px)');
    const handleChange = (event: MediaQueryListEvent) =>
      setIsMobile(event.matches);
    mediaQuery.addEventListener('change', handleChange);
    return () => mediaQuery.removeEventListener('change', handleChange);
  }, []);

  const initialCount = isMobile ? mobileInitialCount : desktopInitialCount;
  const visibleCount = initialCount + (page - 1) * initialCount;
  const visibleRecords = records.slice(0, visibleCount);
  const hasMore = visibleRecords.length < records.length;
  const headingId = `profile-history-${source}-heading`;

  return (
    <section className="entei-profile-history-section" aria-labelledby={headingId}>
      <div className="entei-profile-history-section-header">
        <h2 id={headingId}>{heading}</h2>
        <span>{records.length}</span>
      </div>
      {records.length === 0 ? (
        <p className="entei-profile-history-section-empty">
          {t.contentHistorySectionEmpty}
        </p>
      ) : (
        <>
          <div
            className={`entei-profile-history-grid${source === 'youtube' ? ' entei-profile-history-grid--youtube' : source === 'audio' ? ' entei-profile-history-grid--audio' : ''}`}
          >
            {visibleRecords.map((record) => (
              <HistoryCard
                key={record.mediaId}
                record={record}
                locale={locale}
                t={t}
                onClick={() => onHistoryCardClick(record)}
              />
            ))}
          </div>
          {hasMore && (
            <Button
              type="button"
              variant="secondary"
              className="entei-profile-history-load-more entei-profile-solid-btn"
              onClick={() => setPage((current) => current + 1)}
            >
              <ArrowDownFromLine aria-hidden="true" />
              {t.contentHistoryLoadMore}
            </Button>
          )}
        </>
      )}
    </section>
  );
}

function ContentHistoryGrid({
  locale,
  t,
  onHistoryCardClick,
}: {
  locale: Locale;
  t: Dictionary['profile'];
  onHistoryCardClick: (record: WatchHistoryRecord) => void;
}) {
  const [records, setRecords] = useState<WatchHistoryRecord[] | null>(null);

  useEffect(() => {
    let active = true;
    void getAllWatchHistory().then((next) => {
      if (active) setRecords(next);
    });
    return () => {
      active = false;
    };
  }, []);

  if (records === null) {
    return (
      <div className="entei-profile-empty-state" role="status" aria-busy="true">
        <History size={40} aria-hidden="true" />
        <p>{t.contentHistoryLoading}</p>
      </div>
    );
  }

  if (records.length === 0) {
    return (
      <div className="entei-profile-empty-state" data-testid="profile-content-history-empty">
        <History size={40} aria-hidden="true" />
        <h2>{t.contentHistoryEmptyTitle}</h2>
        <p>{t.contentHistoryEmptyDesc}</p>
      </div>
    );
  }

  const localRecords = records.filter((record) => record.source === 'local');
  const youtubeRecords = records.filter((record) => record.source === 'youtube');
  const audioRecords = records.filter((record) => record.source === 'audio');
  return (
    <div data-testid="profile-content-history-grid">
      <HistorySection
        records={localRecords}
        locale={locale}
        t={t}
        source="local"
        heading={t.contentHistoryLocalSection}
        onHistoryCardClick={onHistoryCardClick}
        desktopInitialCount={15}
        mobileInitialCount={6}
      />
      <HistorySection
        records={youtubeRecords}
        locale={locale}
        t={t}
        source="youtube"
        heading={t.contentHistoryYouTubeSection}
        onHistoryCardClick={onHistoryCardClick}
        desktopInitialCount={6}
        mobileInitialCount={6}
      />
      <HistorySection
        records={audioRecords}
        locale={locale}
        t={t}
        source="audio"
        heading={t.contentHistoryListeningSection}
        onHistoryCardClick={onHistoryCardClick}
        desktopInitialCount={15}
        mobileInitialCount={6}
      />
    </div>
  );
}

export default function ProfileDashboard() {
  const [locale, setLocale] = useState<Locale>(getInitialLocale);
  const [profile, setProfile] = useState<LocalProfile>(() => readLocalProfile());
  const [selectedHistoryRecord, setSelectedHistoryRecord] =
    useState<WatchHistoryRecord | null>(null);

  useEffect(() => {
    const handler = (event: Event) => {
      const detail = (event as CustomEvent<LocaleChangeDetail>).detail;
      if (detail?.locale) setLocale(detail.locale);
    };
    window.addEventListener(LOCALE_CHANGE_EVENT, handler);
    return () => window.removeEventListener(LOCALE_CHANGE_EVENT, handler);
  }, []);

  const t = getDictionary(locale).profile;

  return (
    <div className="entei-profile-root" data-testid="profile-dashboard">
      <ProfileHeader profile={profile} t={t} onProfileChange={setProfile} />

      <Tabs defaultValue="stats" className="entei-profile-tabs">
        <TabsList className="entei-profile-tabs-list" aria-label={t.tabsLabel}>
          <TabsTrigger value="stats">{t.immersionStats}</TabsTrigger>
          <TabsTrigger value="history">{t.contentHistory}</TabsTrigger>
        </TabsList>
        <TabsContent value="stats" className="entei-profile-tab-content">
          <TrackerDashboard />
        </TabsContent>
        <TabsContent value="history" className="entei-profile-tab-content">
          <ContentHistoryGrid
            locale={locale}
            t={t}
            onHistoryCardClick={setSelectedHistoryRecord}
          />
        </TabsContent>
      </Tabs>
      <WatchSessionDrawer
        record={selectedHistoryRecord}
        locale={locale}
        t={t}
        open={selectedHistoryRecord !== null}
        onOpenChange={(open) => {
          if (!open) setSelectedHistoryRecord(null);
        }}
      />
    </div>
  );
}
