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
    changeSubtitle: 'Ganti',
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
    // AM-1: Settings Modal tabs
    settingsTabPlayer: 'Player',
    settingsTabAnki: 'Field Anki',
    // AM-5: Anki Fields tab
    ankiConnect: 'Hubungkan Anki',
    ankiConnectDesc:
      'Hubungkan ke Anki melalui AnkiConnect untuk mengekspor kartu. Anki harus berjalan secara lokal.',
    ankiEndpointLabel: 'URL AnkiConnect',
    ankiStatusConnected: 'Terhubung',
    ankiStatusRetrying: 'Menghubungkan',
    ankiConnecting: 'Menghubungkan ke Anki…',
    ankiErrorUnavailable:
      'Anki tidak dapat dijangkau. Pastikan Anki berjalan dengan AnkiConnect terpasang.',
    ankiErrorCors:
      'Browser memblokir koneksi. Periksa pengaturan izin origin AnkiConnect.',
    ankiErrorCorsHint:
      'Tambahkan https://entei.gorakudo.org ke origins CORS yang diizinkan AnkiConnect. Anki harus berjalan.',
    ankiErrorPermission: 'Izin ditolak oleh AnkiConnect.',
    ankiErrorApiKey: 'AnkiConnect memerlukan kunci API.',
    ankiErrorUnknown: 'Terjadi kesalahan tak terduga.',
    ankiApiKeyLabel: 'Kunci API',
    ankiApiKeyPlaceholder: 'Masukkan kunci API AnkiConnect',
    ankiDeckLabel: 'Dek',
    ankiDeckPlaceholder: 'Pilih dek',
    ankiNoDecks: 'Tidak ada dek ditemukan',
    ankiNoteTypeLabel: 'Tipe Catatan',
    ankiNoteTypePlaceholder: 'Pilih tipe catatan',
    ankiNoNoteTypes: 'Tidak ada tipe catatan ditemukan',
    ankiFieldSentence: 'Kalimat',
    ankiFieldDefinition: 'Definisi',
    ankiFieldImage: 'Gambar',
    ankiFieldAudio: 'Audio',
    ankiFieldWord: 'Kata',
    ankiFieldSource: 'Sumber',
    ankiFieldTags: 'Tag',
    ankiFieldRequired: 'wajib',
    ankiFieldOptional: 'opsional',
    ankiSavePreset: 'Simpan Preset Default',
    ankiPresetSaved: 'Preset disimpan',
    ankiPresetInvalid:
      'Pilih dek, tipe catatan, dan field kalimat untuk menyimpan.',
    ankiNoFields: 'Tidak ada field untuk tipe catatan ini',
    ankiSelectNoteTypeFirst: 'Pilih tipe catatan untuk melihat field',
    // AM-2: Screenshot capture
    screenshotCaptureLabel: 'Ambil gambar',
    screenshotPreviewTitle: 'Pratinjau Gambar',
    screenshotRetry: 'Coba lagi',
    screenshotClose: 'Tutup',
    screenshotError: 'Gagal mengambil gambar.',
    screenshotErrorMetadata:
      'Videonya belum siap. Tunggu sampai mulai diputar.',
    screenshotNoPreview: 'Tidak ada pratinjau.',
    screenshotCapturing: 'Sedang mengambil gambar…',
    // AM-3: Audio clip capture
    audioClipCaptureLabel: 'Rekam klip audio',
    audioClipPreviewTitle: 'Pratinjau Klip Audio',
    audioClipRetry: 'Coba lagi',
    audioClipClose: 'Tutup',
    audioClipError: 'Gagal merekam klip audio.',
    audioClipErrorNoCue: 'Tidak ada subtitle aktif.',
    audioClipErrorUnsupported:
      'Perekaman klip audio tidak didukung di browser ini.',
    audioClipNoPreview: 'Tidak ada pratinjau.',
    audioClipRecording: 'Sedang merekam klip audio…',
    audioClipPlay: 'Putar',
    audioClipPause: 'Jeda',
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
