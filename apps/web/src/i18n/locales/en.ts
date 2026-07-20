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
