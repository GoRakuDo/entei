import type { Dictionary } from '../types';

/**
 * Bahasa Indonesia dictionary.
 * PHASE0.md Section 9 — initial display language. Static HTML is Indonesian.
 * Copy draft from PHASE0.md, ready for Yosia's naturalness review (9.230).
 */
export const id: Dictionary = {
  hub: {
    systemLabel: 'ENTEI // MARKAS BELAJAR',
    lead: 'Kami sedang membangun ruang belajar untuk video, audio, dan buku berbahasa Jepang dari perangkatmu sendiri.',
  },
  player: {
    title: 'Pemutar Audio & Video',
    description:
      'Ruang untuk belajar dari media lokal dan subtitle milikmu, hadir di tahap berikutnya.',
    cta: 'Lihat ruang Player',
    status: 'Tahap berikutnya',
  },
  reader: {
    title: 'Pembaca EPUB',
    description: 'Ruang baca untuk buku Jepang. Belum tersedia pada tahap ini.',
    status: 'Segera hadir',
  },
  privacy: {
    local: 'Tanpa akun. Media tetap di perangkatmu.',
  },
  nav: {
    backToGorakudo: 'Kembali ke GoRakuDo',
    backToHome: 'Kembali ke Home',
    skipToMain: 'Lewati ke konten utama',
  },
  language: {
    selectLabel: 'Bahasa',
  },
  playerPage: {
    title: 'Player — Tahap berikutnya',
    lead: 'Ruang Player hadir pada Phase 1. Saat ini tidak ada media yang diputar di sini.',
    backToHome: 'Kembali ke Home',
  },
  notFound: {
    title: 'Halaman tidak ditemukan',
    lead: 'URL ini tidak tersedia. Kembali ke Home Entei.',
    backToHome: 'Kembali ke Home',
  },
};
