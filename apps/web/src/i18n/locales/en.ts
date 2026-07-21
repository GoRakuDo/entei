import type { Dictionary } from '../types';

/**
 * English dictionary.
 * PHASE0.md Section 9 — copy draft, ready for Yosia's naturalness review.
 */
export const en: Dictionary = {
  hub: {
    systemLabel: 'ENTEI // LEARNING BASE',
    lead: "We're building a learning space around the Japanese videos, audio, and books on your device.",
  },
  player: {
    title: 'Audio & Video Player',
    description:
      'A space for learning from your own local media and subtitles, arriving in the next phase.',
    cta: 'Preview the Player space',
    status: 'Next phase',
  },
  playerUI: {
    selectMediaTitle: 'Select media to play',
    selectMediaDesc:
      'Choose a video or audio file from your device, then add SRT or VTT subtitles.',
    chooseMedia: 'Choose Media',
    chooseSubtitle: 'Choose Subtitles',
    subtitles: 'Subtitles',
    noSubtitlesLoaded: 'No subtitles loaded. Add an SRT or VTT file.',
    shortcuts: 'Shortcuts',
    shortcutsTitle: 'Keyboard Shortcuts',
    shortcutsDesc:
      'Keyboard shortcuts for controlling playback and navigating subtitles.',
    showShortcutsAriaLabel: 'Show keyboard shortcuts',
    dialogClose: 'Close',
    subtitleWarnings: 'Warnings',
    unsupportedFormat: 'Unsupported format',
    failedToRead: 'Failed to read file',
    failedToLoadAudio:
      'Failed to load audio. The format may not be supported by your browser.',
    failedToLoadVideo:
      'Failed to load video. The format may not be supported by your browser.',
    videoDecodeError:
      'Video playback error. The file may contain an unsupported video codec.',
    audioDecodeError:
      'Audio playback error. The file may contain an unsupported audio codec.',
    cuesCount: 'cues',
    seekTo: 'Seek to',
    playLabel: 'Play',
    pauseLabel: 'Pause',
    volumeLabel: 'Volume',
    linePrefix: 'Line',
    shortcutPlayPause: 'Play / Pause',
    shortcutPrevCue: 'Previous cue',
    shortcutNextCue: 'Next cue',
    shortcutSeekHome: 'Seek to current cue start',
    shortcutSlowDown: 'Decrease speed',
    shortcutSpeedUp: 'Increase speed',
    // P1.1 Custom Controls
    timelineToggle: 'Toggle subtitle panel',
    timelineShow: 'Show subtitle panel',
    timelineHide: 'Hide subtitle panel',
    settingsLabel: 'Settings',
    settingsTitle: 'Player Settings',
    settingsSubtitles: 'Subtitles',
    settingsShortcuts: 'Keyboard Shortcuts',
    subtitlesLoadedStatus: 'Subtitles loaded',
    subtitlesNotLoadedStatus: 'No subtitles loaded',
    seekAriaLabel: 'Seek',
    muteAriaLabel: 'Mute',
    unmuteAriaLabel: 'Unmute',
    showVolume: 'Show volume',
    hideVolume: 'Hide volume',
    volumeSliderAriaLabel: 'Volume',
    rateLabel: 'Speed',
    rateAriaLabel: 'Playback speed',
    fullscreenEnter: 'Fullscreen',
    fullscreenExit: 'Exit fullscreen',
    fullscreenError: 'Could not enter fullscreen',
    fullscreenUnavailable: 'Fullscreen not available',
    controlsShow: 'Show controls',
    controlsHide: 'Hide controls',
  },
  reader: {
    title: 'EPUB Reader',
    description:
      'A reading room for Japanese books. Not available in this phase.',
    status: 'Coming soon',
  },
  privacy: {
    local: 'No account. Your media stays on your device.',
  },
  nav: {
    backToGorakudo: 'Back to GoRakuDo',
    backToHome: 'Back to Home',
    skipToMain: 'Skip to main content',
  },
  language: {
    selectLabel: 'Language',
  },
  playerPage: {
    title: 'Player — Next phase',
    lead: 'The Player arrives in Phase 1. No media plays here yet.',
    backToHome: 'Back to Home',
  },
  notFound: {
    title: 'Page not found',
    lead: 'This URL does not exist. Return to the Entei Home.',
    backToHome: 'Back to Home',
  },
};
