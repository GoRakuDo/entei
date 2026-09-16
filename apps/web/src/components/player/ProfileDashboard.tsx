'use client';

import { useEffect, useRef, useState } from 'react';
import { History, ImageUp, Save, SquarePen, X } from 'lucide-react';
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
                  <ButtonGroup className="entei-profile-edit-actions">
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
                </div>
              </div>
              <div className="entei-profile-field">
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
                <p className="entei-profile-bio">{profile.bio}</p>
              )}
            </div>
          )}
        </div>
      </div>
    </section>
  );
}

function formatWatchedAt(timestamp: number, locale: Locale): string {
  return new Intl.DateTimeFormat(locale, {
    dateStyle: 'medium',
  }).format(new Date(timestamp));
}

function HistoryCard({
  record,
  locale,
  t,
}: {
  record: WatchHistoryRecord;
  locale: Locale;
  t: Dictionary['profile'];
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
      : 'entei-profile-history-poster';

  return (
    <article className="entei-profile-history-card">
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
    </article>
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
  desktopInitialCount,
  mobileInitialCount,
}: {
  records: WatchHistoryRecord[];
  locale: Locale;
  t: Dictionary['profile'];
  source: WatchHistoryRecord['source'];
  heading: string;
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
            className={`entei-profile-history-grid${source === 'youtube' ? ' entei-profile-history-grid--youtube' : ''}`}
          >
            {visibleRecords.map((record) => (
              <HistoryCard key={record.mediaId} record={record} locale={locale} t={t} />
            ))}
          </div>
          {hasMore && (
            <Button
              type="button"
              variant="secondary"
              className="entei-profile-history-load-more"
              onClick={() => setPage((current) => current + 1)}
            >
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
}: {
  locale: Locale;
  t: Dictionary['profile'];
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
  return (
    <div data-testid="profile-content-history-grid">
      <HistorySection
        records={localRecords}
        locale={locale}
        t={t}
        source="local"
        heading={t.contentHistoryLocalSection}
        desktopInitialCount={15}
        mobileInitialCount={6}
      />
      <HistorySection
        records={youtubeRecords}
        locale={locale}
        t={t}
        source="youtube"
        heading={t.contentHistoryYouTubeSection}
        desktopInitialCount={6}
        mobileInitialCount={6}
      />
    </div>
  );
}

export default function ProfileDashboard() {
  const [locale, setLocale] = useState<Locale>(getInitialLocale);
  const [profile, setProfile] = useState<LocalProfile>(() => readLocalProfile());

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
          <ContentHistoryGrid locale={locale} t={t} />
        </TabsContent>
      </Tabs>
    </div>
  );
}
