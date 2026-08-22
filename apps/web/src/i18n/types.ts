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
  };
  playerUI: {
    selectMediaTitle: string;
    selectMediaDesc: string;
    chooseMedia: string;
    chooseSubtitle: string;
    changeSubtitle: string;
    subtitles: string;
    noSubtitlesLoaded: string;
    /** Shown while companion subtitles are still being fetched. */
    preparingSubtitles: string;
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
    /** Generic settings title for the global (TopBar) settings dialog. */
    settingsTitleGlobal: string;
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
    // AM-1: Settings Modal tabs
    settingsTabShortcut: string;
    settingsTabAnki: string;
    // P2.1: Subtitle Appearance Settings tab
    settingsTabSubtitle: string;
    subtitleAppearance: string;
    subtitleFontSize: string;
    subtitleTextColor: string;
    subtitleBackgroundColor: string;
    subtitleBackgroundOpacity: string;
    subtitleBackgroundPadding: string;
    subtitleVerticalPosition: string;
  subtitleReset: string;
  subtitleSyncMode: string;
  subtitleSyncSubtitle: string;
  subtitleSyncAudio: string;
  subtitleSyncAuto: string;
  subtitleSyncSubtitleDesc: string;
  subtitleSyncAudioDesc: string;
  subtitleSyncAutoDesc: string;
  subtitleSyncButton: string;
  subtitleSyncButtonLabel: string;
  subtitleSyncSuccess: string;
  subtitleSyncNoReference: string;
  subtitleSyncNoSubtitle: string;
  /** LazySync toggle ON state (Magnet only, docs SUBTITLE_SYNC.md §10). */
  subtitleSyncLazyOn: string;
  /** LazySync toggle OFF state (Magnet only). */
  subtitleSyncLazyOff: string;
  /** LazySync active button label shown while Magnet sync is on (docs
   *  §10.3): the static "activated" text replaces the PROCESSING
   *  typewriter. */
  subtitleSyncLazyActive: string;
  /** Magnet + audio mode: audio-based sync is unavailable (§10.4). */
  subtitleSyncAudioUnavailable: string;
  subtitleSyncWaitTitle: string;
  subtitleSyncWaitDesc: string;
  subtitleSyncWaitCancel: string;
  subtitleSyncWaitConfirm: string;
  subtitleSyncProgress: string;
    // EizouDen (2026-08-07): YouTube download mode settings tab
    settingsTabEizouDen: string;
    settingsEizouDenContentHeading: string;
    ytModeQuality: string;
    ytModeSpeed: string;
    ytModeQualityDesc: string;
    ytModeSpeedDesc: string;
    ytModeToastFormat: string;
    /** Short mode name for the quality toast's {mode} placeholder
     *  (localized: "Speed"/"スピード"/"Quality"/「画質」 etc.). */
    ytModeLabelSpeed: string;
    ytModeLabelQuality: string;
    // AM-5: Anki Fields tab
    ankiConnect: string;
    ankiConnectDesc: string;
    ankiEndpointLabel: string;
    ankiStatusConnected: string;
    ankiStatusRetrying: string;
    ankiConnecting: string;
    ankiErrorUnavailable: string;
    ankiErrorCors: string;
    ankiErrorCorsHint: string;
    ankiErrorPermission: string;
    ankiErrorApiKey: string;
    ankiErrorUnknown: string;
    ankiApiKeyLabel: string;
    ankiApiKeyPlaceholder: string;
    ankiDeckLabel: string;
    ankiDeckPlaceholder: string;
    ankiNoDecks: string;
    ankiNoteTypeLabel: string;
    ankiNoteTypePlaceholder: string;
    ankiNoNoteTypes: string;
    ankiFieldSentence: string;
    ankiFieldDefinition: string;
    ankiFieldImage: string;
    ankiFieldAudio: string;
    ankiFieldWord: string;
    ankiFieldSource: string;
    ankiFieldTags: string;
    ankiTagsPlaceholder: string;
    ankiFieldRequired: string;
    ankiFieldOptional: string;
    ankiDenChouPresetTitle: string;
    ankiDenChouPresetDesc: string;
    ankiDenChouPresetApply: string;
    ankiNoFields: string;
    ankiSelectNoteTypeFirst: string;
    // AM-2: Screenshot capture
    screenshotCaptureLabel: string;
    screenshotPreviewTitle: string;
    screenshotRetry: string;
    screenshotClose: string;
    screenshotError: string;
    screenshotErrorMetadata: string;
    screenshotNoPreview: string;
    screenshotCapturing: string;
    // AM-3: Audio clip capture
    audioClipCaptureLabel: string;
    audioClipPreviewTitle: string;
    audioClipRetry: string;
    audioClipClose: string;
    audioClipError: string;
    audioClipErrorNoCue: string;
    audioClipErrorUnsupported: string;
    audioClipNoPreview: string;
    audioClipRecording: string;
    audioClipPlay: string;
    audioClipPause: string;
    // AM-4: Mining Preview
    mineButtonLabel: string;
    mineButtonCapturing: string;
    mineButtonDisabled: string;
    mineRowLabel: string;
    mineRowDisabled: string;
    // File open
    fileOpenLabel: string;
    miningPreviewTitle: string;
    miningPreviewSentence: string;
    miningPreviewSource: string;
    miningPreviewScreenshot: string;
    miningPreviewAudio: string;
    miningPreviewRange: string;
    miningPreviewCancel: string;
    miningPreviewClose: string;
    miningPreviewScreenshotUnavailable: string;
    miningPreviewAudioError: string;
    miningPreviewScreenshotError: string;
    miningPreviewCapturing: string;
    miningPreviewRefreshing: string;
    miningPreviewRangeInvalid: string;
    miningZoomIn: string;
    miningZoomOut: string;
    // AM-6a/b: Export controls
    exportModeNew: string;
    exportModeUpdate: string;
    exportSendNew: string;
    exportNoCandidate: string;
    exportSuccess: string;
    exportError: string;
    exportSendDisabledNoConnection: string;
    exportSendDisabledInvalidPreset: string;
    exportSendDisabledNoSentence: string;
    exportSendDisabledRequestActive: string;
    exportRejectedCanAdd: string;
    miningExportAddedToast: string;
    miningExportUpdatedToast: string;
    appendSelectLabel: string;
    appendDialogTitle: string;
    appendDialogDescription: string;
    appendSearchPlaceholder: string;
    appendSearchButton: string;
    appendSearching: string;
    appendNoResults: string;
    appendSearchError: string;
    appendWordLabel: string;
    appendSentenceLabel: string;
    appendDeckLabel: string;
    appendSuccess: string;
    appendPartialFailure: string;
    appendAllFailed: string;
    appendSelectedCount: (count: number) => string;
    mediaModeImage: string;
    mediaModeVideo: string;
    mediaModeUnsupported: string;
    rightPanelTabsLabel: string;
    rightPanelTabCaptions: string;
    rightPanelTabHistory: string;
    historyEmpty: string;
    historyUnavailable: string;
    historySentence: string;
    historyRange: string;
    // P2.1: Play mode
    playModeNormal: string;
    playModeCondensed: string;
    playModeFastForward: string;
    playModeLabel: string;
    // ED-1: Magnet URI dialog — visual shell (no torrent runtime)
    magnetInputLabel: string;
    magnetInputPlaceholder: string;
    magnetInputLabelTitle: string;
    magnetErrorInvalid: string;
    magnetInputSubmit: string;
    magnetInputUnpairedBody: string;
    magnetConsentLabel: string;
    magnetInputErrorRepair: string;
    magnetInputErrorConflict: string;
    magnetInputErrorNetwork: string;
    magnetInputErrorGeneric: string;
    magnetInputErrorMetadataTimeout: string;
    magnetInputErrorEvicted: string;
    magnetInputErrorV2Unsupported: string;
    magnetInputSubmitting: string;
    magnetCheckMetadata: string;
    magnetFilesTitle: string;
    magnetFilesBody: string;
    magnetNoVideoError: string;
    magnetSelectSubmit: string;
    magnetCancel: string;
    // ED-2G: File browser table headers and labels
    magnetTableFileName: string;
    magnetTableSize: string;
    magnetFileKindVideo: string;
    magnetFileKindSubtitle: string;
    magnetFileKindFolder: string;
    magnetFileKindOther: string;
    magnetTableNavUp: string;
    magnetNoVideosInFolder: string;
    // ED-3: EizouDendenshi setup section + pairing (no yt-dlp/downloads)
    eizouSetupLabel: string;
    eizouSetupTitle: string;
    eizouDisconnected: string;
    eizouSetupImageAlt: string;
    eizouConnected: string;
    eizouChecking: string;
    eizouResetButton: string;
    eizouResetTitle: string;
    eizouResetDesc: string;
    eizouResetConfirm: string;
    eizouResetCancel: string;
    eizouPairingTitle: string;
    eizouPairingOtpLabel: string;
    eizouPairingOtpInvalid: string;
    eizouPairingSubmit: string;
    eizouPairingConnecting: string;
    eizouPairingErrorNetwork: string;
    eizouPairingErrorInvalidCode: string;
    eizouPairingErrorGeneric: string;
    companionStreamNotReady: string;
    companionPreparingVideo: string;
    /** Toast shown when a companion job fails (state=error). */
    companionJobError: string;
    /** Player-area fallback shown when a companion job errors. */
    companionJobFailed: string;
    // ED-2F: real YouTube URL source dialog (paired companion only)
    /** Firefox-unsupported toast (player blocks Firefox for video playback). */
    firefoxUnsupported: string;
    youtubeInputLabel: string;
    youtubeInputTitle: string;
    youtubeInputPlaceholder: string;
    youtubeInputSubmit: string;
    youtubeInputErrorInvalid: string;
    youtubeInputErrorRepair: string;
    youtubeInputErrorConflict: string;
    youtubeInputErrorNetwork: string;
    youtubeInputErrorGeneric: string;
    youtubeInputSubmitting: string;
    // Tracker (IMMERSION_TRACKER Stage 2b)
    trackerLabel: string;
    trackerOn: string;
    trackerOff: string;
    trackerAriaLabel: string;
    trackerEnabledAriaDescription: string;
    trackerDisabledAriaDescription: string;
  };
  reader: {
    title: string;
    description: string;
    status: string;
  };
  privacy: {
    local: string;
  };
  thanksTo: {
    heading: string;
    sub: string;
  };
  nav: {
    backToGorakudo: string;
    backToHome: string;
    skipToMain: string;
    /** Visible label for Home destination in nav */
    destinationHome: string;
    /** Visible label for Player destination in nav */
    destinationPlayer: string;
    /** Visible label for Tracker destination in nav */
    destinationTracker: string;
    /** Visible label for Settings destination in nav (opens settings modal) */
    destinationSettings: string;
    /** Accessible name for desktop reveal-pill nav landmark */
    desktopNavLabel: string;
    /** Accessible name for mobile floating dock nav landmark */
    mobileDockLabel: string;
  };
  language: {
    selectLabel: string;
    /** Label for the desktop Language Combobox trigger */
    comboboxLabel: string;
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
  trackerDashboard: {
    title: string;
    subtitle: string;
    localOnlyBadge: string;
    todayLabel: string;
    todayDate: (date: string) => string;
    foregroundWatch: string;
    mediaProgress: string;
    subtitleExposure: string;
    condensedSkipped: string;
    fastForwardWall: string;
    fastForwardMedia: string;
    mediaLabel: string;
    mediaEmpty: string;
    learningSetLabel: string;
    momentsLabel: string;
    momentsEmpty: string;
    bucketPasses: string;
    bucketPauses: string;
    bucketSeeks: string;
    bucketMines: string;
    archiveLabel: string;
    archiveEmpty: string;
    // Loading / unavailable / empty states
    loadingAriaBusy: string;
    unavailableTitle: string;
    unavailableDesc: string;
    unavailableIconLabel: string;
    emptyTitle: string;
    emptyDesc: string;
    emptyIconLabel: string;
    // Table headers / labels
    mediaColumnFile: string;
    mediaColumnFirstSeen: string;
    mediaColumnLastSeen: string;
    mediaColumnWatchTime: string;
    mediaColumnProgress: string;
    mediaColumnSubtitleExp: string;
    momentsColumnBucket: string;
    momentsColumnWatch: string;
    momentsColumnPasses: string;
    momentsColumnPauses: string;
    momentsColumnSeeks: string;
    momentsColumnMines: string;
    archiveColumnFile: string;
    archiveColumnRange: string;
    archiveColumnSentence: string;
    archiveColumnDate: string;
    // Units / formatting
    unitMs: string;
    unitSec: string;
    // Accessibility
    todaySectionLabel: string;
    mediaSectionLabel: string;
    momentsSectionLabel: string;
    archiveSectionLabel: string;
  };
}
