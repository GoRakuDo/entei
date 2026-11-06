# MODULE_ARCHITECTURE — プラットフォームモジュール機構 ＆ イマージョンツール棚

> **状態:** 設計確定（第2フェーズ / 第3フェーズ基盤）  
> **対象:** プレイヤー受付API、EizouDenの機能分解（yt-dlp / Torrent）、モジュール管理画面（`/modules/`）、イマージョンツールDrawer（デスクトップ: 左サイド / モバイル: ボトムシート）  
> **方針:** 単一の巨大な外部Goコンパニオンを廃止し、責務ごとに独立したプラグイン（モジュール）として管理する。プレイヤー側は標準データ受け入れAPIで抽象化し、ペアリング認証・CORS・ポート競合を全廃する。

---

## 1. 概要とアーキテクチャ

Entei を「単一の動画プレイヤー」から「モジュール拡張可能なイマージョン学習プラットフォーム」へ昇華させる。

```text
[ ユーザー操作 ]
      │
      ▼
[ イマージョンツール棚 (Drawer) ]
  ├─ 動画プレイヤー (/player/)
  ├─ 音声プレイヤー (/audio-player/)
  └─ モジュール管理 (/modules/)
            │
            ▼
[ モジュール管理システム (localStorage: entei.modules.v1) ]
  ├─ 公式コアモジュール
  │    ├─ yt-dlp モジュール (YouTube音声・動画取得)
  │    ├─ Torrent モジュール (Magnet/Torrent Rangeストリーミング)
  │    └─ Yomitan 辞書モジュール (@gorakudo/yomitan-headless)
  └─ コミュニティモジュール (将来の外部インポート)
            │ (内部IPC / 直結データフロー)
            ▼
[ プレイヤー受付API (EnteiMediaPayload) ]
  └─ PlayerApp / AudioPlayer (画面描画・シーク・字幕・採掘)
```

---

## 2. EizouDen の機能分解（Decoupling）

従来の単一Goバイナリ `EizouDendenshi`（ポート4322でYouTubeとTorrentを同居管理）を解体し、2つの独立したモジュールとして再定義する：

1. **`module-ytdlp` (YouTube / ストリーム取得モジュール)**
   * **責務**: YouTube URLの検証、メタデータ取得、動画および音声ストリームの取得。
   * **提供形態**: 
     - デスクトップ: アプリ内組み込み Rust ワーカー、またはマネージド `yt-dlp` プロセス。
     - モバイル: 軽量なストリームリゾルバ。
   * **設定**: フォーマット優先度（最高画質 / 音声のみ等）、Cookie設定。
2. **`module-torrent` (Torrent / Magnet ストリーミングモジュール)**
   * **責務**: Magnet URI / .torrent ファイルの解決、Sequential / PiecePriorityNow によるストリーミングダウンロード、Rangeリクエスト中継。
   * **提供形態**: Rustネイティブ（`librqbit` ベースのインプロセスエンジン）。
   * **設定**: ダウンロード保存先、同時接続数、シード制限。

### ペアリング認証とCORSの全廃
- モジュールはEnteiアプリの内部プロセス（Tauri IPC / カスタムプロトコル `stream://`）で通信する。
- 外部HTTPポート（`127.0.0.1:4322`）での待受けを行わないため、**6桁ペアリングコード・CORSオリジン制限・Private Network Accessブロックは完全に撤去**される。

---

## 3. プレイヤー標準受付API (`EnteiMediaPayload`)

プレイヤー（動画・音声）は特定ソースの実装詳細を知らず、以下の標準化されたペイロードのみを受け取って再生を開始する：

```typescript
export interface EnteiMediaSubtitleTrack {
  id: string;
  label: string;
  language: string;
  /** 字幕ファイルの内部URL (stream://, blob:, またはインラインテキスト) */
  src: string;
  format: 'vtt' | 'srt' | 'ass';
}

export interface EnteiMediaPayload {
  /** 一意な再生ソース識別子 */
  sourceId: string;
  /** 再生用メディアURL (stream://*, blob:*, またはローカルファイルパス) */
  mediaUrl: string;
  mediaType: 'video' | 'audio';
  title: string;
  duration?: number;
  subtitles?: EnteiMediaSubtitleTrack[];
  posterUrl?: string;
  /** 発行元モジュールの識別子 ('ytdlp' | 'torrent' | 'local-file' など) */
  originModuleId: string;
}
```

実装: `apps/web/src/features/player/media-payload.ts`（型 + 変換ヘルパー `createLocalFilePayload` / `createYouTubePayload` / `createTorrentPayload`）。単体テストは `apps/web/tests/media-payload.test.ts`。

---

## 4. イマージョンツール棚（Navigation Drawer）

ナビゲーション内の「Player」項目を、ツール全般をまとめた「**イマージョンツール (Immersive Tools / Perkakas Imersi)**」へ拡張する。

### 4.1 UIと呼び出し導線
- **デスクトップ (≥768px)**:
  - 左サイドバーの項目ラベル:
    - 日本語: `イマージョンツール`
    - 英語: `Immersion Tools`
    - インドネシア語: `Perkakas Imersi`
  - アイコン: カチンコ (`Clapperboard`) または ツールボックス (`Wrench` / `Layers`)
  - アクション: クリックすると **左からスッとスライドインするDrawer（サイドシート）** が開く。
- **モバイル (<768px)**:
  - 下部ドック（`DestinationDock`）の真ん中項目。
  - アクション: タップすると **下からスッと競り上がるボトムシートDrawer** が開く。

### 4.2 Drawer 内のコンテンツ棚
Drawerの中には、学習者が使うツールと管理リンクがカードタイルで並ぶ：
1. **動画プレイヤー (`Video Player`)**:
   - `/player/` へのリンク。動画＋字幕＋採掘のメイン環境。
2. **音声プレイヤー (`Audio Player`)**:
   - `/audio-player/` へのリンク。オーディオブック・音楽・YouTube音声専用のYouTubeMusic風環境。
3. **モジュール管理 (`Modul / Modules`)**:
   - `/modules/` へのリンク。モジュールの有効化・設定・追加インポート画面。

---

## 5. モジュール管理画面 (`/modules/`)

### 5.1 データ構造 (`entei.modules.v1`)
```typescript
export interface EnteiModuleManifest {
  id: string;               // 'ytdlp' | 'torrent' | 'yomitan' など
  name: string;
  description: string;
  version: string;
  author: string;
  icon: string;             // Lucide アイコン名 または SVG
  category: 'source' | 'dictionary' | 'mining' | 'tool';
  enabled: boolean;
  builtIn: boolean;         // 公式組み込みか外部インポートか
  settings?: Record<string, unknown>;
}
```

### 5.2 画面仕様
- **有効化トグル**: 各モジュールカードに Switch を配置し、不要な機能は即座にOFFにできる（KISS・軽量性の担保）。
- **設定ボタン**: モジュールごとの専用設定モーダル（Cookie設定やダウンロード先など）。フェーズ2-A ではボタンと導線だけを置き、設定モーダル本体（cookies.txt アップロード、ダウンロード先パスなど）は **フェーズ2-B / 2-C** で実装する。
- **外部モジュール追加**: 「モジュールをインポート」ボタンから、将来的にコミュニティ製プラグイン（URLやファイル）を読み込める拡張スロットを用意。

### 5.3 実行時ゲート（フェーズ2-B で実装済み）
- **モジュール状態によるPlayer実行時ゲート**: 実装済み（フェーズ2-B）。`readModuleState()` / `useModuleState()`（`features/modules/use-module-state.ts`）を Player 島が読み、OFF のモジュールは取得入口そのものを描画しない。
  - `PlayerApp`: `torrent` OFF → Magnet ボタン（`.entei-player-magnet-icon-btn`）を非表示＋Magnet ダイアログを開かない。`ytdlp` OFF → YouTube ボタン（`.entei-player-youtube-icon-btn`）を非表示＋YouTube ダイアログを開かない。実行中に OFF へ切り替わった場合（他タブの `storage` イベント）は、開いていたダイアログも `useEffect` で閉じる。
  - `AudioPlayer`: `ytdlp` OFF → YouTube 入口（`.audio-player__youtube-button` / `.audio-player__source-button` の YouTube 項目）を非表示＋ダイアログを開かない。
  - ローカルファイル選択はビルトイン能力のため常に有効。
  - タブ間の切り替えは `storage` イベントで追従し、同一タブ内はプレイヤー島の再マウント時に読み直す。
- **標準受付API**: `EnteiMediaPayload` と変換ヘルパーを `features/player/media-payload.ts` に実装済み（§3）。変換ヘルパーはプレイヤー側コンポーネントへの接続が未了で、フェーズ2-C（Rustネイティブのストリーミング配線）で `PlayerApp` / `AudioPlayer` の取得経路をこのペイロードへ差し替える。それまでは純粋関数 + 単体テストのみが存在し、既存経路はそのまま維持される。
  - `createLocalFilePayload` の `sourceId` は呼び出し側が発行する object URL 由来（`local-file:<objectUrl>`）で、同じ pick を何度変換しても同一、別 pick では必ず別になる（モジュール内カウンタを持たない）。
  - `createTorrentPayload` は YouTube の videoId を取らない（torrent に videoId は存在しない）。ポスターは呼び出し側が解決済みの `posterUrl` としてのみ受け取る。
- **未実装（フェーズ2-B後半 / 2-C に延期）**: モジュール別の詳細設定ダイアログ（cookies.txt アップロード、ダウンロード先パス等）はまだ作らない。`PlayerApp` / `AudioPlayer` の既存取得経路をアダプター経由へ全面リファクタリングする作業も、Rust ネイティブモジュール（フェーズ2-C）と同時に行う（現状はペイロードAPIを用意し、既存経路はそのまま維持）。

---

## 6. 実装フェーズ計画

1. **フェーズ2-A（導線と棚）**:
   - イマージョンツールDrawer（デスクトップ: 左スライド / モバイル: ボトムシート）の実装。
   - `/modules/` モジュール管理ページの雛形作成。
2. **フェーズ2-B（データフローAPI化）**:
   - `EnteiMediaPayload` 受付アダプターの実装 — **実装済み**（`features/player/media-payload.ts`、変換ヘルパー: `createLocalFilePayload` / `createYouTubePayload` / `createTorrentPayload`）。
   - モジュール状態によるPlayer streamの実行時ゲート（OFFのモジュールは取得経路を拒否） — **実装済み**（`useModuleState` + PlayerApp / AudioPlayer の入口ゲート）。
   - 既存 `PlayerApp` / `AudioPlayer` をアダプター経由にリファクタリング — フェーズ2-C と同時（Rustネイティブの実体が入ってから差し替える）。
   - モジュール別詳細設定ダイアログ（Cookieアップロード、ダウンロード先パス等）の実装 — 未着手。
3. **フェーズ2-C（Rustネイティブ統合）**:
   - Tauri core 側に `module-ytdlp` および `module-torrent` を実装。
   - 旧Goコンパニオン（EizouDendenshi）およびペアリング/CORSコードの完全退役。

---

## 7. フェーズ2-C 実装記録: Torrent モジュール直結ストリーミング（コード実装済み）

デスクトップ（Tauri）では Go コンパニオンもペアリングトークンも使わず、Magnet の追加から `<video>` 再生までをインプロセスで完結させる。

### 7.1 Rust 側（`plugins/tauri-plugin-torrent`）
- **`select_torrent_files(id, video_index, subtitle_index)`**: 選択ファイルだけにダウンロードを絞り（`librqbit` の `update_only_files`、best-effort）、動画の先頭 1 byte がディスクに載るまで待って（`FIRST_BYTE_TIMEOUT` = 20 s、タイムアウトはエラーにしない）ループバック URL を返す。container header が無い状態で `<video>` を開くと Chrome/WebView2 が約 30 s で諦めるため、待機はモーダルのローディング内に閉じ込める。
- **`relay.rs`**: `127.0.0.1` のエフェメラルポートに axum をバインドし、`GET /stream/<session>` で選択ファイルを配信する。リクエスト毎に `librqbit` の `FileStream`（seek 可能な `AsyncRead`）を生成して要求オフセットへシークし、`Content-Range`/`Content-Length` 付きの `206` を返す。`AsyncReadExt::take` で閉区間レンジを要求長で打ち切るため、`bytes=0-1023` が EOF まで流れることはない。未取得 piece の読み出しは piece 到着まで park して再開する（シーク先が未 DL でも失敗しない）。
- **`build.rs` / `permissions/default.toml`**: `select_torrent_files` を追加（`allow-select-torrent-files`）。
- 公開面は既存どおり 127.0.0.1 のみ。infohash・tracker・peer・ファイルパスは webview に返さない（パスは basename のみ）。

### 7.2 フロント側
- `features/player/tauri-bridge.ts`: `addTorrentDirect` / `getTorrentStatusDirect` / `selectTorrentFilesDirect` / `cancelTorrentDirect`（`plugin:torrent|*`）。返り値は形状検証してから UI へ渡す。
- `components/player/MagnetInput.tsx`: `isTauri()` で分岐。トークン不要・companion fetch 無しで create →（メタデータ未解決なら 5 s × 6 回ポーリング）→ ファイル表 → `Pilih & putar` → `onJobAccepted(jobId, name, '', { videoUrl, subtitleUrl })`。プラグインはフラットなパス一覧を返すため `synthesizeEntries()` でフォルダ/ファイル行を合成し、フォルダ移動はメモリ上の一覧をフィルタするだけ（ジョブの再作成も IPC 往復もしない）。
- `features/player/use-companion-job-session.ts`: `beginDirectTorrentSession()` を追加。companion ブリッジを起動せず relay URL をそのまま `jobMediaUrl`/`subtitleUrl` として公開し、phase は `ready`、`cancelActiveJob()` は `cancel_torrent` を呼ぶ。
- `components/player/PlayerApp.tsx`: `handleMagnetJobAccepted` の第4引数 `direct` で直結経路へ分岐（字幕が無い場合のみ JIMAKU 自動ロード）。

### 7.3 既知の指摘（Known issues / Low findings）
1. **LazySync（字幕同期）は未対応**: 参照字幕の取得は companion の `/v1/source/torrents/{id}/subtitle` 前提のため、直結モードでは字幕表示はできても同期参照の自動取得は行わない（手動同期のみ）。
2. **torrent 内蔵字幕の自動抽出は無し**: 字幕はファイル一覧から手動選択する方式のみ（companion の自動検出に相当する処理は未実装）。
3. **relay は無認証**: 127.0.0.1 のエフェメラルポート + CORS `*` で、プロセス外からは到達できないが同一マシンの他プロセスからは読める（旧 companion と同じ前提）。
4. **シーク先の piece 優先度は librqbit のストリーム実装依存**: 未 DL 領域へのシークは piece 到着まで待つ。初回 byte 待ちで Chrome のタイムアウトは回避しているが、シーク後の体感は回線と swarm 次第。
5. **実環境 E2E は未確認**: ここまではコード実装と自動テスト（Rust unit 6 件 / MagnetInput 54 件、`astro check` 0 error）のみ。実際の WebView2 での magnet 再生確認はまだ行っていない。

---

## 8. フェーズ2-C 実装記録: YouTube モジュール（`plugins/tauri-plugin-ytdlp`）

デスクトップ（Tauri）では YouTube 取得もインプロセスで完結する。companion の job / pairing token は使わない。

### 8.1 yt-dlp 実行ファイルの解決順

`ytdlp_binary()` は次の順で解決する（2026-08-14 修正）:

1. `EIZOUDEN_YTDLP_PATH`（明示 override）
2. EizouDendenshi が導入した検証済み helper
   — Windows: `%LOCALAPPDATA%\GoRakuDo\EizouDendenshi\helpers\yt-dlp-windows-amd64.exe` →
   `…\helpers\yt-dlp.exe`（存在するものだけ採用。companion の update plan は `helpers\` 配下に
   release asset 名のまま配置するため、この 2 つが実在しうる名前）
3. `PATH` 上の `yt-dlp.exe` / `yt-dlp`

**背景（実測）**: Windows の `PATH` 先頭に python の Scripts 配下のランチャー
`…\Python314\Scripts\yt-dlp.exe` が存在する環境では、`--version` が**出力なしで exit 1**
（python モジュール未導入のため実行不能）になり、companion を使わないデスクトップ経路だけ
yt-dlp 呼び出しが失敗していた。実際に動く実体は
`%LOCALAPPDATA%\GoRakuDo\EizouDendenshi\helpers\yt-dlp-windows-amd64.exe`（実測 `--version` =
`2026.07.04`）にあるため、helper を先に探す。Termux は `pkg` 管理の `yt-dlp` が `PATH` にあるため
候補を持たない。

### 8.2 ダイアログのエラー表示（Toast 統一）

`YouTubeInput` / `MagnetInput` / `AudioPlayer` のダイアログ本文にあったインラインエラー段落
（`.entei-youtube-form-error` / `.entei-magnet-error` / `.entei-magnet-empty-error`）は撤去し、
エラーは `notifyCompanionError`（Sonner Toast）で通知する。`error` state は `aria-invalid` の
マーク用に残すが、本文にはテキストを出さない（DESIGN.md 8.6 / 8.8）。理由は「メッセージの出現・
消滅でモーダルの高さとボタン位置が動く」ことの防止。

### 8.3 既知の指摘（Known issues / Low findings）

1. **Toast の id は固定**: `notifyCompanionError` は既定で同一 id で置換するため、種類の違う
   エラーが連続すると前の Toast は上書きされる（積み上げない設計）。メディア入力ダイアログは
   第2引数に専用 id（`youtube-input-error` / `magnet-input-error`）を渡し、汎用の
   companion job エラーと衝突させない。
2. **インラインエラーは対象外ダイアログあり**: メディアソース・プレイヤー系ダイアログ
   （YouTube / Magnet / Audio input 等）は本文にインラインエラー段落を出さず Toast へ統一する
   （DESIGN.md 8.8）。既存の mining / pairing プレビューダイアログは個別再設計までインライン
   バリデーション表示を残す。
3. **実環境 E2E は未確認**: `cargo check` / `cargo test`（plugin 14 件）と web テストのみ。
   WebView2 実機での YouTube 再生確認は未実施。
