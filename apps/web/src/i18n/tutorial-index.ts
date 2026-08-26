/**
 * Tutorial Index Dictionaries (id, ja, en)
 * -----------------------------------------------------------------------------
 * Target reading level: middle school / junior high.
 * Avoid technical jargon (minisign, DPAPI, bootstrap, etc.).
 *
 * 2026-08-26
 * ---------------------------------------------------------------------------*/

import type { Locale } from './index';

export interface TutorialIndexItem {
  title: string;
  description: string;
  /** Path segment under /{loc}-tutorial/ — e.g. 'eizoudendenshi' */
  slug: string;
}

export interface TutorialIndexContent {
  metaTitle: string; // e.g. 'Entei — チュートリアル'
  metaDescription: string;
  heading: string; // visible h1, prefix-free
  lead: string;
  itemsLabel: string; // aria-label for the list
}

export const tutorialIndex: Record<
  Locale,
  TutorialIndexContent & { items: TutorialIndexItem[] }
> = {
  id: {
    metaTitle: 'Entei — Panduan & Tutorial',
    metaDescription:
      'Kumpulan panduan dan tutorial langkah demi langkah untuk membantu menyiapkan dan menggunakan fitur-fitur di Entei.',
    heading: 'Panduan & Tutorial',
    lead: 'Kumpulan panduan langkah demi langkah untuk membantu kamu menyiapkan dan menggunakan fitur-fitur Entei.',
    itemsLabel: 'Daftar tutorial',
    items: [
      {
        title: 'Cara memasang EizouDendenshi',
        description:
          'Pasang aplikasi pendamping agar Entei bisa memutar video YouTube dan media lokal di perangkatmu.',
        slug: 'eizoudendenshi',
      },
    ],
  },

  ja: {
    metaTitle: 'Entei — チュートリアル',
    metaDescription:
      'Entei の初期設定や便利な使い方を、やさしい言葉でまとめたチュートリアル一覧です。',
    heading: 'チュートリアル',
    lead: 'Entei の各機能を使うための設定や手順を、わかりやすくまとめたガイド一覧です。',
    itemsLabel: 'チュートリアル一覧',
    items: [
      {
        title: 'EizouDendenshi の入れ方',
        description:
          '連携アプリを入れて、YouTube や手元の動画・音声を Entei でスムーズに再生できるようにします。',
        slug: 'eizoudendenshi',
      },
    ],
  },

  en: {
    metaTitle: 'Entei — Tutorials',
    metaDescription:
      'A collection of step-by-step setup guides to help you get the most out of Entei.',
    heading: 'Tutorials',
    lead: 'A collection of step-by-step guides to help you set up and use features in Entei.',
    itemsLabel: 'Tutorial list',
    items: [
      {
        title: 'How to install EizouDendenshi',
        description:
          'Install the companion app to enable YouTube and local media playback directly inside Entei.',
        slug: 'eizoudendenshi',
      },
    ],
  },
};
