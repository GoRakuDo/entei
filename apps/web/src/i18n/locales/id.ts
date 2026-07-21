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
  playerUI: {
    selectMediaTitle: 'Pilih media untuk diputar',
    selectMediaDesc:
      'Pilih file video atau audio dari perangkat Anda, lalu tambahkan subtitle SRT atau VTT.',
    chooseMedia: 'Pilih Media',
    chooseSubtitle: 'Pilih Subtitle',
    subtitles: 'Subtitle',
    noSubtitlesLoaded: 'Belum ada subtitle. Tambahkan file SRT atau VTT.',
    shortcuts: 'Pintasan',
    shortcutsTitle: 'Pintasan Keyboard',
    shortcutsDesc:
      'Pintasan keyboard untuk mengontrol pemutaran dan navigasi subtitle.',
    showShortcutsAriaLabel: 'Tampilkan pintasan keyboard',
    dialogClose: 'Tutup',
    subtitleWarnings: 'Peringatan',
    unsupportedFormat: 'Format tidak didukung',
    failedToRead: 'Gagal membaca file',
    failedToLoadAudio:
      'Gagal memuat audio. Format mungkin tidak didukung oleh browser.',
    failedToLoadVideo:
      'Gagal memuat video. Format mungkin tidak didukung oleh browser.',
    videoDecodeError:
      'Error pemutaran video. File mungkin berisi codec video yang tidak didukung.',
    audioDecodeError:
      'Error pemutaran audio. File mungkin berisi codec audio yang tidak didukung.',
    cuesCount: 'cue',
    seekTo: 'Lompat ke',
    playLabel: 'Putar',
    pauseLabel: 'Jeda',
    volumeLabel: 'Volume',
    linePrefix: 'Baris',
    shortcutPlayPause: 'Putar / Jeda',
    shortcutPrevCue: 'Cue sebelumnya',
    shortcutNextCue: 'Cue berikutnya',
    shortcutSeekHome: 'Lompat ke awal cue',
    shortcutSlowDown: 'Perlambat',
    shortcutSpeedUp: 'Percepat',
    // P1.1 Custom Controls
    timelineToggle: 'Alihkan panel subtitle',
    timelineShow: 'Tampilkan panel subtitle',
    timelineHide: 'Sembunyikan panel subtitle',
    settingsLabel: 'Pengaturan',
    settingsTitle: 'Pengaturan Player',
    settingsSubtitles: 'Subtitle',
    settingsShortcuts: 'Pintasan Keyboard',
    subtitlesLoadedStatus: 'Subtitle dimuat',
    subtitlesNotLoadedStatus: 'Belum ada subtitle',
    seekAriaLabel: 'Lompat',
    muteAriaLabel: 'Senyapkan',
    unmuteAriaLabel: 'Aktifkan suara',
    showVolume: 'Tampilkan volume',
    hideVolume: 'Sembunyikan volume',
    volumeSliderAriaLabel: 'Volume',
    rateLabel: 'Kecepatan',
    rateAriaLabel: 'Kecepatan pemutaran',
    fullscreenEnter: 'Layar penuh',
    fullscreenExit: 'Keluar layar penuh',
    fullscreenError: 'Tidak dapat masuk layar penuh',
    fullscreenUnavailable: 'Layar penuh tidak tersedia',
    controlsShow: 'Tampilkan kontrol',
    controlsHide: 'Sembunyikan kontrol',
    // P1.3a.2: Caption display mode cycle
    captionModeVisible: 'Subtitel: terlihat',
    captionModeBlurred: 'Subtitel: buram',
    captionModeHidden: 'Subtitel: tersembunyi',
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
