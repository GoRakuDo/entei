import type { Dictionary } from '../types';

/**
 * Japanese dictionary.
 * PHASE0.md Section 9 — copy draft, ready for Yosia's naturalness review.
 */
export const ja: Dictionary = {
  hub: {
    systemLabel: 'ENTEI // 学習拠点',
    lead: '手元の映像・音声・本から学ぶための場所を、ここに作っています。',
  },
  player: {
    title: '音声・動画プレイヤー',
    description:
      '手元のメディアと字幕から学べる部屋を、次のPhaseで追加します。',
    cta: 'Playerの準備を見る',
    status: '次のPhase',
  },
  playerUI: {
    selectMediaTitle: '再生するメディアを選択',
    selectMediaDesc:
      'デバイスから動画または音声ファイルを選択し、SRTまたはVTTの字幕を追加します。',
    chooseMedia: 'メディアを選択',
    chooseSubtitle: '字幕を選択',
    subtitles: '字幕',
    noSubtitlesLoaded:
      '字幕が読み込まれていません。SRTまたはVTTファイルを追加してください。',
    shortcuts: 'ショートカット',
    shortcutsTitle: 'キーボードショートカット',
    shortcutsDesc: '再生操作と字幕ナビゲーションのキーボードショートカット。',
    showShortcutsAriaLabel: 'キーボードショートカットを表示',
    dialogClose: '閉じる',
    subtitleWarnings: '警告',
    unsupportedFormat: 'サポートされていない形式',
    failedToRead: 'ファイルの読み取りに失敗しました',
    failedToLoadAudio:
      '音声の読み込みに失敗しました。ブラウザがこの形式に対応していない可能性があります。',
    failedToLoadVideo:
      '動画の読み込みに失敗しました。ブラウザがこの形式に対応していない可能性があります。',
    videoDecodeError:
      '動画再生エラー。対応していない動画コーデックが含まれている可能性があります。',
    audioDecodeError:
      '音声再生エラー。対応していない音声コーデックが含まれている可能性があります。',
    cuesCount: '件',
    seekTo: 'シーク先',
    playLabel: '再生',
    pauseLabel: '一時停止',
    volumeLabel: '音量',
    linePrefix: '行',
    shortcutPlayPause: '再生 / 一時停止',
    shortcutPrevCue: '前のcue',
    shortcutNextCue: '次のcue',
    shortcutSeekHome: '現在のcueの先頭へシーク',
    shortcutSlowDown: '速度を下げる',
    shortcutSpeedUp: '速度を上げる',
    // P1.1 Custom Controls
    timelineToggle: '字幕パネル切替',
    timelineShow: '字幕パネルを表示',
    timelineHide: '字幕パネルを非表示',
    settingsLabel: '設定',
    settingsTitle: 'プレイヤー設定',
    settingsSubtitles: '字幕',
    settingsShortcuts: 'キーボードショートカット',
    subtitlesLoadedStatus: '字幕を読み込み済み',
    subtitlesNotLoadedStatus: '字幕未読み込み',
    seekAriaLabel: 'シーク',
    muteAriaLabel: 'ミュート',
    unmuteAriaLabel: 'ミュート解除',
    showVolume: '音量を表示',
    hideVolume: '音量を非表示',
    volumeSliderAriaLabel: '音量',
    rateLabel: '速度',
    rateAriaLabel: '再生速度',
    fullscreenEnter: 'フルスクリーン',
    fullscreenExit: 'フルスクリーン終了',
    fullscreenError: 'フルスクリーンに切り替えられませんでした',
    fullscreenUnavailable: 'フルスクリーンは利用できません',
    controlsShow: 'コントロールを表示',
    controlsHide: 'コントロールを非表示',
    // P1.3a.2: Caption display mode cycle
    captionModeVisible: '字幕：表示',
    captionModeBlurred: '字幕：ぼかし',
    captionModeHidden: '字幕：非表示',
  },
  reader: {
    title: 'EPUBリーダー',
    description: '日本語の本を読むための部屋。このPhaseではまだ使えません。',
    status: 'Coming Soon',
  },
  privacy: {
    local: 'アカウント不要。メディアは端末内に残ります。',
  },
  nav: {
    backToGorakudo: 'GoRakuDoへ戻る',
    backToHome: 'Homeへ戻る',
    skipToMain: 'メインコンテンツへスキップ',
  },
  language: {
    selectLabel: '言語',
  },
  playerPage: {
    title: 'Player — 次のPhase',
    lead: 'PlayerはPhase 1で追加します。今はここでメディアは再生できません。',
    backToHome: 'Homeへ戻る',
  },
  notFound: {
    title: 'ページが見つかりません',
    lead: 'このURLは存在しません。EnteiのHomeへ戻ります。',
    backToHome: 'Homeへ戻る',
  },
};
