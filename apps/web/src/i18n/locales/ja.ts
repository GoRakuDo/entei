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
