/**
 * Entei i18n — Type Definitions
 * -----------------------------------------------------------------------------
 * PHASE0.md 8.192: locale is fixed to `id | ja | en`. The same type is used by
 * `<html lang>`, translation dictionaries, document metadata, and localStorage
 * validation. URL is never used as a locale input.
 * ---------------------------------------------------------------------------*/

/** Allowed locale values. Initial / fallback locale is `id` (Bahasa Indonesia). */
export type Locale = 'id' | 'ja' | 'en';

/** Language Selector option labels, shown in each language's own name (8.205). */
export const LOCALE_LABELS: Record<Locale, string> = {
  id: 'Bahasa Indonesia',
  ja: '日本語',
  en: 'English',
};

/** Initial / fallback locale when preference is absent, invalid, or corrupted. */
export const DEFAULT_LOCALE: Locale = 'id';

/** localStorage key with schema version suffix (PHASE0.md 8.219). */
export const PREFERENCES_KEY = 'entei.preferences.v1';

/** Current Preference schema version. Bump when the shape changes. */
export const PREFERENCES_SCHEMA_VERSION = 1;

/** Shape of the persisted Preference JSON (PHASE0.md 8.212-217). */
export interface LocalePreference {
  schemaVersion: number;
  locale: Locale;
}

/**
 * Metadata shown in `<title>` and `<meta name="description">` per locale.
 * Updated dynamically by the locale switcher when the user changes language.
 */
export interface DocumentMetadata {
  title: string;
  description: string;
}

/** Full dictionary shape. All three locales must have the same keys. */
export interface Dictionary {
  hub: {
    systemLabel: string;
    lead: string;
  };
  player: {
    title: string;
    description: string;
    cta: string;
    status: string;
  };
  playerUI: {
    selectMediaTitle: string;
    selectMediaDesc: string;
    chooseMedia: string;
    chooseSubtitle: string;
    subtitles: string;
    noSubtitlesLoaded: string;
    shortcuts: string;
    shortcutsTitle: string;
    shortcutsDesc: string;
    showShortcutsAriaLabel: string;
    dialogClose: string;
    subtitleWarnings: string;
    unsupportedFormat: string;
    failedToRead: string;
    failedToLoadAudio: string;
    failedToLoadVideo: string;
    // P1.2: Distinct native decode error labels (never expose raw MediaError.message)
    videoDecodeError: string;
    audioDecodeError: string;
    cuesCount: string;
    seekTo: string;
    playLabel: string;
    pauseLabel: string;
    volumeLabel: string;
    linePrefix: string;
    shortcutPlayPause: string;
    shortcutPrevCue: string;
    shortcutNextCue: string;
    shortcutSeekHome: string;
    shortcutSlowDown: string;
    shortcutSpeedUp: string;
    // P1.1 Custom Controls
    timelineToggle: string;
    timelineShow: string;
    timelineHide: string;
    settingsLabel: string;
    settingsTitle: string;
    settingsSubtitles: string;
    settingsShortcuts: string;
    subtitlesLoadedStatus: string;
    subtitlesNotLoadedStatus: string;
    seekAriaLabel: string;
    muteAriaLabel: string;
    unmuteAriaLabel: string;
    showVolume: string;
    hideVolume: string;
    volumeSliderAriaLabel: string;
    rateLabel: string;
    rateAriaLabel: string;
    fullscreenEnter: string;
    fullscreenExit: string;
    fullscreenError: string;
    fullscreenUnavailable: string;
    controlsShow: string;
    controlsHide: string;
    // P1.3a.2: Caption display mode cycle
    captionModeVisible: string;
    captionModeBlurred: string;
    captionModeHidden: string;
  };
  reader: {
    title: string;
    description: string;
    status: string;
  };
  privacy: {
    local: string;
  };
  nav: {
    backToGorakudo: string;
    backToHome: string;
    skipToMain: string;
  };
  language: {
    selectLabel: string;
  };
  playerPage: {
    title: string;
    lead: string;
    backToHome: string;
  };
  notFound: {
    title: string;
    lead: string;
    backToHome: string;
  };
}
