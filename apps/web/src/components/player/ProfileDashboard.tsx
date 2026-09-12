'use client';

import { useEffect, useRef, useState } from 'react';
import { Dices, History, ImageUp, Save, X } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/player/ui/button';
import { Input } from '@/components/player/ui/input';
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from '@/components/player/ui/tabs';
import TrackerDashboard from '@/components/player/TrackerDashboard';
import {
  PROFILE_AVATAR_MAX_BYTES,
  PROFILE_BIO_MAX_LENGTH,
  createRandomProfileName,
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

  const rerollName = () => {
    setNameDraft(createRandomProfileName());
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
              <div className="entei-profile-edit-actions">
                <Button type="button" variant="secondary" onClick={saveProfile}>
                  <Save aria-hidden="true" />
                  {t.saveProfile}
                </Button>
                <Button type="button" variant="ghost" onClick={closeEditing}>
                  <X aria-hidden="true" />
                  {t.closeEdit}
                </Button>
              </div>

              <div className="entei-profile-field">
                <label className="entei-profile-label" htmlFor="profile-name">
                  {t.nameLabel}
                </label>
                <div className="entei-profile-name-controls">
                  <Input
                    id="profile-name"
                    value={nameDraft}
                    onChange={(event) => setNameDraft(event.target.value)}
                    aria-describedby="profile-name-help"
                  />
                  <Button
                    type="button"
                    variant="outline"
                    size="icon"
                    onClick={rerollName}
                    aria-label={t.rerollName}
                    title={t.rerollName}
                  >
                    <Dices aria-hidden="true" />
                  </Button>
                </div>
                <span id="profile-name-help" className="entei-profile-help">
                  {t.nameHelp}
                </span>
              </div>

              <div className="entei-profile-field">
                <label className="entei-profile-label" htmlFor="profile-bio">
                  {t.bioLabel}
                </label>
                <textarea
                  id="profile-bio"
                  className="entei-profile-textarea"
                  value={bioDraft}
                  maxLength={PROFILE_BIO_MAX_LENGTH}
                  onChange={(event) => updateBio(event.target.value)}
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
                <Button type="button" variant="secondary" onClick={startEditing}>
                  {t.editProfile}
                </Button>
              </div>
              {profile.bio !== '' && (
                <p className="entei-profile-bio">{profile.bio}</p>
              )}
              {avatarError !== null && (
                <p className="entei-profile-avatar-error" role="alert">
                  {avatarError}
                </p>
              )}
            </div>
          )}
        </div>
      </div>
    </section>
  );
}

function ContentHistoryPlaceholder({ t }: { t: Dictionary['profile'] }) {
  return (
    <div className="entei-profile-empty-state" data-testid="profile-content-history-empty">
      <History size={40} aria-hidden="true" />
      <h2>{t.contentHistoryEmptyTitle}</h2>
      <p>{t.contentHistoryEmptyDesc}</p>
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
        <TabsList variant="line" className="entei-profile-tabs-list" aria-label={t.tabsLabel}>
          <TabsTrigger value="stats">{t.immersionStats}</TabsTrigger>
          <TabsTrigger value="history">{t.contentHistory}</TabsTrigger>
        </TabsList>
        <TabsContent value="stats" className="entei-profile-tab-content">
          <TrackerDashboard />
        </TabsContent>
        <TabsContent value="history" className="entei-profile-tab-content">
          <ContentHistoryPlaceholder t={t} />
        </TabsContent>
      </Tabs>
    </div>
  );
}
