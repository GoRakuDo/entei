'use client';

import { useEffect, useState } from 'react';
import { Dices, History, Save } from 'lucide-react';
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
  PROFILE_AVATAR_COUNT,
  PROFILE_BIO_MAX_LENGTH,
  createRandomProfileName,
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

function getInitialLocale(): Locale {
  const lang = document.documentElement.lang;
  if (lang === 'ja' || lang === 'en') return lang;
  return 'id';
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
  const [nameDraft, setNameDraft] = useState(profile.name);

  useEffect(() => {
    setNameDraft(profile.name);
  }, [profile.name]);

  const saveName = () => {
    onProfileChange(setLocalProfileName(nameDraft));
  };

  const rerollName = () => {
    const next = setLocalProfileName(createRandomProfileName());
    setNameDraft(next.name);
    onProfileChange(next);
  };

  const updateBio = (value: string) => {
    onProfileChange(setLocalProfileBio(truncateProfileBio(value)));
  };

  const selectAvatar = (avatar: number) => {
    onProfileChange(setLocalProfileAvatar(avatar));
  };

  return (
    <section className="entei-profile-header" aria-labelledby="profile-title">
      <div className="entei-profile-identity">
        <div className="entei-profile-avatar-frame">
          <img
            className="entei-profile-avatar"
            src={`/avatars/${profile.avatar}.webp`}
            alt={t.avatarOption(profile.avatar)}
          />
        </div>

        <div className="entei-profile-fields">
          <div className="entei-profile-title-row">
            <div>
              <div className="entei-profile-eyebrow">{t.localOnlyBadge}</div>
              <h1 id="profile-title" className="entei-profile-title">
                {t.title}
              </h1>
            </div>
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
              <Button type="button" variant="secondary" onClick={saveName}>
                <Save aria-hidden="true" />
                {t.saveName}
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
              value={profile.bio}
              maxLength={PROFILE_BIO_MAX_LENGTH}
              onChange={(event) => updateBio(event.target.value)}
              aria-describedby="profile-bio-count"
              rows={4}
            />
            <span id="profile-bio-count" className="entei-profile-counter" aria-live="polite">
              {t.bioCount(profile.bio.length)}
            </span>
          </div>
        </div>
      </div>

      <fieldset className="entei-profile-avatar-picker">
        <legend className="entei-profile-label">{t.avatarLabel}</legend>
        <div className="entei-profile-avatar-grid">
          {Array.from({ length: PROFILE_AVATAR_COUNT }, (_, index) => index + 1).map(
            (avatar) => (
              <Button
                key={avatar}
                type="button"
                variant={profile.avatar === avatar ? 'default' : 'outline'}
                className="entei-profile-avatar-option"
                aria-label={t.avatarOption(avatar)}
                aria-pressed={profile.avatar === avatar}
                onClick={() => selectAvatar(avatar)}
              >
                <img
                  src={`/avatars/${avatar}.webp`}
                  alt=""
                  aria-hidden="true"
                  loading="lazy"
                />
              </Button>
            ),
          )}
        </div>
      </fieldset>
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
