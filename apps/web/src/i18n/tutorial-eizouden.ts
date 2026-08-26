/**
 * EizouDendenshi Setup Tutorial Dictionaries (id, ja, en)
 * -----------------------------------------------------------------------------
 * Target reading level: middle school / junior high.
 * Avoid technical jargon (minisign, DPAPI, bootstrap, etc.).
 *
 * Install commands use short domain URLs:
 * - Windows: irm https://entei.gorakudo.org/eizouden-install.ps1 | iex
 * - Android: curl -fsSL https://entei.gorakudo.org/eizouden-install.sh | bash
 *
 * 2026-08-27
 * ---------------------------------------------------------------------------*/

import type { Locale } from './types';

export interface TutorialStep {
  /** Step heading (1 sentence) */
  title: string;
  /** Explanation body (\n\n for paragraphs) */
  body: string;
  /** Optional copyable terminal command */
  code?: string;
  /** Optional note below the code block */
  codeNote?: string;
  /** Optional tip box */
  tip?: string;
}

export interface TutorialContent {
  metaTitle: string;
  metaDescription: string;
  /** Visible page h1 (metaTitle stays for <title>/SEO only). */
  heading: string;
  lead: string;
  prerequisitesHeading: string;
  prerequisites: string[];
  /** Security caution shown right after the prerequisites box. */
  caution: string;
  windowsHeading: string;
  androidHeading: string;
  windowsSteps: TutorialStep[];
  androidSteps: TutorialStep[];
  nextHeading: string;
  nextBody: string;
  copyLabel: string;
  copiedLabel: string;
}

// Short domain URLs served by public/eizouden-install.* wrappers which delegate
// to the latest signed STABLE bootstrap (auto-resolved via GitHub API releases/latest, 2026-08-27).
const WIN_INSTALL_CMD =
  'irm https://entei.gorakudo.org/eizouden-install.ps1 | iex';

const ANDROID_INSTALL_CMD =
  'curl -fsSL https://entei.gorakudo.org/eizouden-install.sh | bash';

const LAUNCH_CMD = 'grkd-edds';

export const tutorialEizouden: Record<Locale, TutorialContent> = {
  id: {
    metaTitle: 'Entei — Cara Pasang EizouDendenshi',
    metaDescription:
      'Panduan langkah demi langkah yang mudah untuk memasang EizouDendenshi di Windows dan Android (Termux).',
    heading: 'Cara memasang EizouDendenshi',
    lead: 'Panduan ini membantu kamu memasang EizouDendenshi di komputer Windows atau ponsel Android agar Entei bisa memutar video dan audio lokal.',
    prerequisitesHeading: 'Sebelum Memulai',
    prerequisites: [
      'Komputer Windows (64-bit) atau perangkat Android',
      'Koneksi internet untuk mengunduh program',
      'Browser web untuk membuka situs Entei',
    ],
    caution:
      'Jika muncul peringatan keamanan saat proses instalasi, jangan pernah melanjutkan. Salin perintah hanya dari halaman ini dan dari rilis resmi GitHub GoRakuDo.',
    windowsHeading: 'Panduan untuk Windows',
    androidHeading: 'Panduan untuk Android (Termux)',
    windowsSteps: [
      {
        title: 'Buka PowerShell',
        body: 'Klik tombol Start di Windows, ketik "powershell", lalu klik "Windows PowerShell". Jendela berlayar biru atau hitam akan terbuka.',
      },
      {
        title: 'Salin Perintah Instalasi',
        body: 'Salin perintah di bawah ini dengan menekan tombol Salin di sebelah kanan atau tandai teks lalu tekan Ctrl+C:',
        code: WIN_INSTALL_CMD,
        codeNote:
          'Perintah ini akan mengunduh dan menyiapkan EizouDendenshi secara otomatis.',
      },
      {
        title: 'Tempel di PowerShell dan Tekan Enter',
        body: 'Klik kanan di dalam jendela PowerShell untuk menempelkan perintah, lalu tekan Enter pada keyboard. Proses unduh dan pemeriksaan keaslian program akan berjalan otomatis (sekitar 1–2 menit).',
        tip: 'Pemeriksaan keaslian adalah cara otomatis untuk memastikan program ini benar-benar asli dari GoRakuDo dan aman digunakan.',
      },
      {
        title: 'Tunggu Sampai Selesai',
        body: 'Tunggu hingga muncul pesan selesai di layar. Layar akan menampilkan petunjuk bahwa program sudah siap dijalankan.',
      },
      {
        title: 'Jalankan dan Lihat Kode Pairing',
        body: 'Jalankan perintah di bawah ini. Layar akan menampilkan kode unik berisi 6 digit angka. Simpan kode ini untuk langkah berikutnya.',
        code: LAUNCH_CMD,
      },
    ],
    androidSteps: [
      {
        title: 'Pasang Aplikasi Termux',
        body: 'Pasang aplikasi Termux melalui F-Droid. Jangan gunakan versi Google Play Store karena versi tersebut sudah usang dan tidak diperbarui lagi.',
        tip: 'Buka f-droid.org di browser ponselmu, cari "Termux", lalu unduh dan pasang berkasnya.',
      },
      {
        title: 'Buka Aplikasi Termux',
        body: 'Buka aplikasi Termux yang baru dipasang. Layar hitam terminal akan muncul. Jangan khawatir, ini tampilan normal.',
      },
      {
        title: 'Salin Perintah Instalasi',
        body: 'Salin perintah instalasi Android berikut:',
        code: ANDROID_INSTALL_CMD,
        codeNote:
          'Perintah ini akan menyiapkan paket yang diperlukan dan memasang EizouDendenshi.',
      },
      {
        title: 'Tempel dan Jalankan',
        body: 'Tekan dan tahan pada layar Termux, pilih menu "Paste", lalu tekan tombol Enter pada keyboard ponsel. Tunggu beberapa menit hingga proses selesai.',
      },
      {
        title: 'Nyalakan EizouDendenshi',
        body: 'Ketik perintah di bawah ini di Termux lalu tekan Enter untuk menyalakan program:',
        code: LAUNCH_CMD,
      },
      {
        title: 'Lihat Kode Pairing',
        body: 'Layar akan menampilkan kode pairing unik. Biarkan Termux tetap terbuka dan gunakan kode ini di Entei.',
      },
    ],
    nextHeading: 'Langkah Selanjutnya: Hubungkan ke Entei',
    nextBody:
      'Di situs Entei, buka Pengaturan → bagian "EizouDendenshi" → "Pengaturan OTP", lalu masukkan kode 6 angka yang tampil.\n\nSetelah terhubung, kamu bisa langsung memutar video YouTube dan media lokal di Entei!',
    copyLabel: 'Salin perintah',
    copiedLabel: 'Tersalin!',
  },

  ja: {
    metaTitle: 'Entei — EizouDendenshi の入れ方',
    metaDescription:
      'Windows や Android（Termux）に EizouDendenshi を入れる手順を、やさしい言葉で説明します。',
    heading: 'EizouDendenshi の入れ方',
    lead: 'このページでは、Windows パソコンや Android スマホに EizouDendenshi を入れて、Entei で動画や音声を再生できるようにする手順を説明します。',
    prerequisitesHeading: 'はじめる前に',
    prerequisites: [
      'Windows パソコン（64ビット）または Android 端末',
      'インターネット接続（プログラムのダウンロードに使います）',
      'Entei を開く Web ブラウザ',
    ],
    caution:
      'インストール中に警告が出たら絶対に続行しないでください。コマンドはこのページと GoRakuDo 公式 GitHub リリースからのみコピーしてください。',
    windowsHeading: 'Windows での手順',
    androidHeading: 'Android（Termux）での手順',
    windowsSteps: [
      {
        title: 'PowerShell を開く',
        body: 'スタートボタンをクリックして「powershell」と入力し、「Windows PowerShell」をクリックします。青または黒の画面が出れば準備完了です。',
      },
      {
        title: 'インストールコマンドをコピーする',
        body: '下のコードの右側にあるコピーボタンを押すか、文字を選んで Ctrl+C でコピーします:',
        code: WIN_INSTALL_CMD,
        codeNote:
          'このコマンドを実行すると、必要なファイルが自動でダウンロードされます。',
      },
      {
        title: 'PowerShell に貼り付けて Enter を押す',
        body: 'PowerShell の画面内で右クリックすると貼り付けができます。キーボードの Enter キーを押すと、ダウンロードと本物かチェックが自動で始まります（1〜2分かかります）。',
        tip: '「本物かチェック」とは、GoRakuDo 公式のプログラムかどうかを機械的に確かめる仕組みです。改ざんされていた場合は自動で止まるので安心です。',
      },
      {
        title: '完了の表示を待つ',
        body: '画面に完了メッセージが出るまで待ちます。最後に grkd-edds というコマンドで起動できる旨が表示されれば成功です。',
      },
      {
        title: '起動してペアリングコードを確認する',
        body: '下のコマンドを実行して Enter を押します。画面に6桁の数字（コード）が表示されます。このコードを次のステップで使います。',
        code: LAUNCH_CMD,
      },
    ],
    androidSteps: [
      {
        title: 'Termux アプリを入れる',
        body: 'F-Droid から「Termux」をインストールします。Google Play ストアのものは古いので使わないでください。',
        tip: 'スマホのブラウザで f-droid.org を開き、「Termux」を検索してアプリをダウンロード・インストールしてください。',
      },
      {
        title: 'Termux を開く',
        body: 'インストールした Termux を起動します。黒い画面（ターミナル）が表示されますが、びっくりしなくて大丈夫です。',
      },
      {
        title: 'インストールコマンドをコピーする',
        body: '以下の Android 用インストールコマンドをコピーします:',
        code: ANDROID_INSTALL_CMD,
        codeNote: '必要なツールと EizouDendenshi をまとめて準備します。',
      },
      {
        title: '貼り付けて実行する',
        body: 'Termux の画面を長押しして「Paste」を選び、キーボードの Enter を押します。ダウンロードと本物かチェックが終わるまで数分待ちます。',
      },
      {
        title: 'EizouDendenshi を起動する',
        body: 'Termux で下のコマンドを入力して Enter を押します:',
        code: LAUNCH_CMD,
      },
      {
        title: 'ペアリングコードを確認する',
        body: '画面にペアリングコードが表示されます。Termux を開いたままにして、次のステップへ進みます。',
      },
    ],
    nextHeading: '次のステップ: Entei と接続する',
    nextBody:
      'Entei サイトの設定 →「映像伝電子」の「OTP セットアップ」に、表示された6桁の数字を入れます。\n\n接続できると、YouTube の動画や手元のメディアを Entei でスムーズに再生できるようになります！',
    copyLabel: 'コマンドをコピー',
    copiedLabel: 'コピーしました!',
  },

  en: {
    metaTitle: 'Entei — How to Install EizouDendenshi',
    metaDescription:
      'A simple, step-by-step guide to installing EizouDendenshi on Windows and Android (Termux).',
    heading: 'How to install EizouDendenshi',
    lead: 'Follow this step-by-step guide to set up EizouDendenshi on your Windows PC or Android device, allowing Entei to play local videos and audio.',
    prerequisitesHeading: 'Before You Begin',
    prerequisites: [
      'A 64-bit Windows PC or an Android device',
      'An internet connection to download the program',
      'A web browser to open the Entei website',
    ],
    caution:
      'If a security warning appears during installation, never continue. Copy commands only from this page and from the official GoRakuDo GitHub releases.',
    windowsHeading: 'Windows Setup',
    androidHeading: 'Android (Termux) Setup',
    windowsSteps: [
      {
        title: 'Open PowerShell',
        body: 'Click the Start button, type "powershell", and click "Windows PowerShell". A blue or black window will open.',
      },
      {
        title: 'Copy the Installation Command',
        body: 'Copy the command below by clicking the Copy button on the right, or select the text and press Ctrl+C:',
        code: WIN_INSTALL_CMD,
        codeNote:
          'This command automatically downloads and prepares EizouDendenshi.',
      },
      {
        title: 'Paste into PowerShell and Press Enter',
        body: 'Right-click inside the PowerShell window to paste the command, then press Enter. The download and integrity check will run automatically (takes about 1–2 minutes).',
        tip: 'The integrity check automatically verifies that the program is genuine from GoRakuDo and has not been altered.',
      },
      {
        title: 'Wait for Completion',
        body: 'Wait for the success message to appear. It will tell you that the program is ready to run with the command grkd-edds.',
      },
      {
        title: 'Start and Check the Pairing Code',
        body: 'Run the command below and press Enter. A 6-digit number will appear on screen. Keep this code for the next step.',
        code: LAUNCH_CMD,
      },
    ],
    androidSteps: [
      {
        title: 'Install the Termux App',
        body: 'Install Termux from F-Droid. Do not use the Google Play Store version, as it is outdated and no longer maintained.',
        tip: 'Open f-droid.org in your phone browser, search for "Termux", and download/install the app.',
      },
      {
        title: 'Open Termux',
        body: 'Open the newly installed Termux app. A black terminal screen will appear—no need to worry, this is normal.',
      },
      {
        title: 'Copy the Installation Command',
        body: 'Copy the Android installation command below:',
        code: ANDROID_INSTALL_CMD,
        codeNote: 'This command sets up required tools and installs EizouDendenshi.',
      },
      {
        title: 'Paste and Run',
        body: 'Tap and hold (long press) on the Termux screen, choose "Paste", and press Enter on your keyboard. Wait a few minutes for the download and integrity check to finish.',
      },
      {
        title: 'Start EizouDendenshi',
        body: 'Type the command below in Termux and press Enter:',
        code: LAUNCH_CMD,
      },
      {
        title: 'Check the Pairing Code',
        body: 'A pairing code will be displayed on screen. Keep Termux open and proceed to the next step in Entei.',
      },
    ],
    nextHeading: 'Next Step: Connect to Entei',
    nextBody:
      'On the Entei site, open Settings → the EizouDendenshi section → "OTP Setup", then enter the 6-digit code shown.\n\nOnce connected, you can enjoy seamless playback of YouTube videos and local media directly inside Entei!',
    copyLabel: 'Copy command',
    copiedLabel: 'Copied!',
  },
};
