# MODULE_ARCHITECTURE — プラットフォームモジュール機構 ＆ イマージョンツール棚

> **状態:** 設計確定（第2フェーズ / 第3フェーズ基盤）  
> **対象:** プレイヤー受付API、EizouDenの機能分解（yt-dlp / Torrent）、モジュール管理画面（`/modules/`）、イマージョンツールDrawer（デスクトップ: 左サイド / モバイル: ボトムシート）、プレイヤー内蔵ネイティブデコーダー（第9章）  
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

`CORE_MODULES`（`apps/web/src/features/modules/modules-store.ts`）の `version` は実体のバージョンを表示する（ダミー値ではない）:

| id | version | 実体の根拠 |
| --- | --- | --- |
| `ytdlp` | `2026.07.04` | 同梱 yt-dlp helper（`bundle.resources`）の `--version`（§8.1.1） |
| `torrent` | `9.1.0` | `librqbit` crate（`plugins/tauri-plugin-torrent/Cargo.toml` の `9.1` が解決する実バージョン、`Cargo.lock` 実測）。8.1.1 から上げた理由は §7.2 の Windows DHT 停止バグ（`librqbit-dht` 5.3.1 → 9.1.0 で修正済み） |
| `yomitan` | `0.1.1` | `@gorakudo/yomitan-headless` の公開バージョン |

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
- **`add_torrent(magnet_uri)`**: `librqbit` の `AddTorrentOptions { list_only: true }` で **メタデータ（info dictionary、数 KB）だけ** を解決してファイル一覧を返す。torrent はセッションに追加しないため、この段階では **ディスクへの書き込みもダウンロードも 0 bytes**（フォルダ・空ファイルすら作らない）。67 GB のシリーズを丸ごと持つ magnet でも、一覧を見ている間のコストはメタデータだけ。**解決はコマンドではなく専用タスクが所有する**（`resolve_metadata`）ため、コールド DHT でピア探索に数十秒かかってもコマンドが失敗しない: `add_torrent` は `METADATA_INITIAL_WAIT` = 20 s だけ待ち、温まった swarm なら同じ応答でファイル表を返し、間に合わなければ空の file 一覧で即返す。その後は `get_torrent_status` が `state: "metadata"` のまま file 一覧を埋める。解決の総予算は `METADATA_TIMEOUT` = 120 s で、超えた場合だけ `state: "error"` + 理由を返す（旧実装は 30 s でコマンド自体を失敗させ、実測 30009 ms の `metadata resolution timed out` として dialog が空入力に戻っていた）。
- **`select_torrent_files(id, video_index, subtitle_index)`**: **ダウンロードを開始するのはここだけ**。解決済みの `.torrent` bytes から `only_files`（選択した動画＋字幕）を指定してセッションに追加するので、他のエピソード・特典・サントラは最初から対象外。**playback の readiness ゲートは `relay.rs` 側**にあり、コマンドは `Initializing` 中でもループバック URL を即返す（relay がブラウザの最初の range 要求を `wait_streamable` で park し、streamable になった時点で `206` を返す）。`Initializing` 中の relay が `503` を返すと `<video>` は再試行せず永久停止する（Chrome は error code 4）ため、URL は relay の park 経由でしか再生に到達しない。コマンド側で残る待機は **best-effort の MKV header scan だけ**で、`TRACK_SCAN_TIMEOUT` = 20 s（うち header 読みは `HEADER_READ_TIMEOUT` = 10 s）に収める。間に合わなければ `mkv_tracks` を付けずに返し、エンジン既定のトラック選択に任せる。メタデータ未解決の entry に対する select はエラー（ファイル一覧が存在しない）。
- **`inspect_torrent_tracks(id, file_index)`**: 選択済みファイルの container header を再読込して MKV トラック一覧と日本語自動選択トラック番号だけを返す単独コマンド（メタデータのみの entry は空レポート）。
- **`cancel_torrent(id)`**: `Session::delete(id, delete_files: true)` でストリーミングキャッシュを削除する（プラグイン自身の書き込みのみで、ユーザーのメディアには触れない）。
- **キャッシュのライフサイクル**: ダウンロード先は `app.path().app_cache_dir()/torrent`（解決できなければ `app_local_data_dir()/torrent`、最後に Windows は `%LOCALAPPDATA%\GoRakuDo\Entei\torrent`）。Tauri の `PathResolver` 基準なので Android では `<app data>/cache` になる。**起動時（`setup`）に前回の残存物を全削除**し（新パスに加えて、旧バージョンが残した `app_local_data_dir()/torrent` も別パスであれば 1 度だけ purge して回収する）、**終了時（`RunEvent::Exit`）にも best-effort で全削除**するため、クラッシュや強制終了で残っても次の起動で回収される。
- **`relay.rs`**: `127.0.0.1` のエフェメラルポートに axum をバインドし、`GET /stream/<session>` で選択ファイルを配信する。リクエスト毎に `librqbit` の `FileStream`（seek 可能な `AsyncRead`）を生成して要求オフセットへシークし、`Content-Range`/`Content-Length` 付きの `206` を返す。`AsyncReadExt::take` で閉区間レンジを要求長で打ち切るため、`bytes=0-1023` が EOF まで流れることはない。未取得 piece の読み出しは piece 到着まで park して再開する（シーク先が未 DL でも失敗しない）。
- **`build.rs` / `permissions/default.toml`**: `add_torrent` / `get_torrent_status` / `select_torrent_files` / `inspect_torrent_tracks` / `cancel_torrent` の 5 コマンドを登録し、`default` 権限セットに `allow-*` を揃える（`src-tauri/capabilities/default.json` は `torrent:default` のみ参照）。
- 公開面は既存どおり 127.0.0.1 のみ。infohash・tracker・peer・ファイルパスは webview に返さない（パスは basename のみ）。

### 7.2 フロント側
- `features/player/tauri-bridge.ts`: `addTorrentDirect` / `getTorrentStatusDirect` / `selectTorrentFilesDirect` / `cancelTorrentDirect`（`plugin:torrent|*`）。返り値は形状検証してから UI へ渡す。
- `components/player/MagnetInput.tsx`: `isTauri()` で分岐。トークン不要・companion fetch 無しで create →（メタデータ未解決なら 5 s × 24 回 = 120 s ポーリング。プラグインの `METADATA_TIMEOUT` と一致させ、旧 5 s × 6 回 = 30 s ではコールド DHT の正常な解決を打ち切っていた）→ ファイル表 → `Pilih & putar` → `onJobAccepted(jobId, name, '', { videoUrl, subtitleUrl })`。プラグインはフラットなパス一覧を返すため `synthesizeEntries()` でフォルダ/ファイル行を合成し、フォルダ移動はメモリ上の一覧をフィルタするだけ（ジョブの再作成も IPC 往復もしない）。プラグインが `state: "error"` を返した場合は理由が metadata timeout なら `magnetInputErrorMetadataTimeout` の Toast を出す。
- `features/player/use-companion-job-session.ts`: `beginDirectTorrentSession()` を追加。companion ブリッジを起動せず relay URL をそのまま `jobMediaUrl`/`subtitleUrl` として公開し、phase は `ready`、`cancelActiveJob()` は `cancel_torrent` を呼ぶ。**direct モードは media error 回復を自前で持つ**（companion ブリッジ側の回復と同じ実測済み経路）: `error` で `DIRECT_MEDIA_RESET_DELAY_MS` = 600 ms 後に同じ relay URL へ `src` を再設定して `load()` し、`loadeddata` 成功で予算を戻す（上限 `DIRECT_MEDIA_RESET_LIMIT` = 3 回。枯渇後は error として表面化させ、無限リロードにしない）。復帰位置は `timeupdate` で記録した最終位置から `loadedmetadata` / `canplay` で復元し、エラー前に再生中だった場合だけ `play()` で再開する（`el.currentTime` は使えない — プレイヤー側の error 処理が先に `src` を外して `load()` するため 0 に戻っている）。unmount 時はリスナーと保留中のリセットタイマーを解放する。
- `components/player/PlayerApp.tsx`: `handleMagnetJobAccepted` の第4引数 `direct` で直結経路へ分岐（字幕が無い場合のみ JIMAKU 自動ロード）。

### 7.2.1 Windows で DHT が即死して `metadata resolution timed out` になる不具合（修正済み）

実機（Tauri debug ビルド + MCP bridge）で `plugin:torrent|get_torrent_status` を直接叩いたところ、人気 torrent（`b8b448b3…5985e8`）でも `state: "error"` / `metadata resolution timed out after 120s` になっていた。

調査で判明した事実:
- **`peers_live` は証拠にならない**: `metadata_status()` はメタデータ段階で `peers_live: 0` を固定で返す（`Active` に昇格して初めて実値を返す）。この 0 は DHT 失敗の証拠ではない。
- 同じマシンの生 DHT クライアント（KRPC `get_peers`）では同 infohash のピアが **37 件** 見つかった。Windows Firewall も全プロファイル無効。つまり回線・DHT・swarm は正常。
- `librqbit` 8.1.1 を単体で動かすと session 生成直後に `ERROR librqbit_dht: framer quit: … error reading from UDP socket … os error 10054` で **DHT ワーカータスクが永久終了**していた。10054 = `WSAECONNRESET`。Windows は「送った先の UDP ポートが閉じている（ICMP port unreachable）」を次回 `recv_from` のエラーとして返すため、`librqbit-dht` 5.3.1 の framer はそれを致命的エラーとして扱い DHT 全体を止めていた（ルーティングテーブルは空のまま → `get_peers` は何も返さない → メタデータ永久未解決）。
- **`librqbit-dht` 9.1.0 でこの不具合は上流修正済み**（`is_datagram_error()` が `WSAECONNRESET` / `WSAENETRESET` / `WSAEMSGSIZE` を無視して `continue` する）。9.0.1 には未修正。

対応: `plugins/tauri-plugin-torrent/Cargo.toml` の `librqbit` を `8.1` → `9.1` に上げ、9 系の API 差分（`stream()` が `async`、`ListOnlyResponse.info` が `ValidatedTorrentMetaV1Info`、`TorrentStatsState::Initializing { paused }`、`PeerStats.live` が `u32`）に追随した。`SessionOptions` は既定（DHT 有効 + 永続化）のまま変更していない — 原因は設定不足ではなくライブラリ側のバグだったため。

実機検証（Tauri debug ビルド、MCP bridge の `execute_js` 経由で `plugin:torrent|*` を直接実行）:
- `add_torrent` が **4.0 s** でメタデータ解決（`[VCB-Studio] K-ON!` / 1372 ファイル）。修正前は 120 s タイムアウト。
- `select_torrent_files` が relay URL と MKV トラック表（HEVC 映像 + 字幕）を返却。
- `get_torrent_status` が `state: "live"`, **`peers_live: 4`**, `progress_bytes > 0` を報告（= ピア接続と実データ取得を実測）。

### 7.3 既知の指摘（Known issues / Low findings）
1. **LazySync（字幕同期）は未対応**: 参照字幕の取得は companion の `/v1/source/torrents/{id}/subtitle` 前提のため、直結モードでは字幕表示はできても同期参照の自動取得は行わない（手動同期のみ）。
2. **torrent 内蔵字幕の自動抽出は無し**: 字幕はファイル一覧から手動選択する方式のみ（companion の自動検出に相当する処理は未実装）。
3. **relay は無認証**: 127.0.0.1 のエフェメラルポート + CORS `*` で、プロセス外からは到達できないが同一マシンの他プロセスからは読める（旧 companion と同じ前提）。
4. **シーク先の piece 優先度は librqbit のストリーム実装依存**: 未 DL 領域へのシークは piece 到着まで待つ。初回 byte 待ちで Chrome のタイムアウトは回避しているが、シーク後の体感は回線と swarm 次第。
5. **実環境 E2E は一部確認済み**: Rust unit 27 件は pass。実機（Tauri debug ビルド）で `add_torrent` → 1372 ファイルのメタデータ解決（4.0 s）、`select_torrent_files` → relay URL + MKV トラック表、`get_torrent_status` → `peers_live: 4` / 実データ取得までを MCP bridge 経由で確認済み（§7.2.1）。**未確認**: WebView2 の `<video>` での実再生（映像表示・シーク・字幕選択）と、実 UI の Magnet モーダル操作経路。

---

## 8. フェーズ2-C 実装記録: YouTube モジュール（`plugins/tauri-plugin-ytdlp`）

デスクトップ（Tauri）では YouTube 取得もインプロセスで完結する。companion の job / pairing token は使わない。

### 8.1 yt-dlp 実行ファイルの解決順

`ytdlp_binary()` は次の順で解決する（2026-08-20 修正・アプリ内蔵バイナリ対応）:

1. `EIZOUDEN_YTDLP_PATH`（明示 override）
2. **アプリに同梱した yt-dlp（`bundle.resources`）** — 下記 8.1.1
3. EizouDendenshi が導入した検証済み helper
   — Windows: `%LOCALAPPDATA%\GoRakuDo\EizouDendenshi\helpers\yt-dlp-windows-amd64.exe` →
   `…\helpers\yt-dlp.exe`（存在するものだけ採用。companion の update plan は `helpers\` 配下に
   release asset 名のまま配置するため、この 2 つが実在しうる名前）
4. `PATH` 上の `yt-dlp.exe` / `yt-dlp`

**背景（実測）**: Windows の `PATH` 先頭に python の Scripts 配下のランチャー
`…\Python314\Scripts\yt-dlp.exe` が存在する環境では、`--version` が**出力なしで exit 1**
（python モジュール未導入のため実行不能）になり、companion を使わないデスクトップ経路だけ
yt-dlp 呼び出しが失敗していた。実際に動く実体は
`%LOCALAPPDATA%\GoRakuDo\EizouDendenshi\helpers\yt-dlp-windows-amd64.exe`（実測 `--version` =
`2026.07.04`）にあるため、helper を先に探す。Termux は `pkg` 管理の `yt-dlp` が `PATH` にあるため
候補を持たない。

### 8.1.1 アプリ内蔵（完全スタンドアロン）

新しい PC に Entei を入れるだけで YouTube 再生が動くよう、Windows ビルドには yt-dlp 本体を同梱する。
Python も EizouDendenshi も `PATH` 設定も不要。

**プラットフォーム分割の原則（2026-08-20 修正）**: 同梱は**プラットフォーム別 config で行う**。
Windows インストーラだけが Windows 版 exe を持ち、Android APK には Windows 実行ファイルが
**一切入らない**。

| 項目 | Windows | Android (APK) / その他 |
| --- | --- | --- |
| 実体の配置 | `src-tauri/resources/windows/yt-dlp.exe` | 配置しない |
| バンドル宣言 | `src-tauri/tauri.windows.conf.json` の `bundle.resources: ["resources/windows/*"]` | なし（base `tauri.conf.json` に `resources` キー自体が存在しない） |
| インストール後の実体 | `<resource dir>/resources/windows/yt-dlp.exe` | — |
| 解決関数 | `bundled_candidates()` が Windows でのみ候補を返す | `bundled_candidates()` は空を返す |

- **base `tauri.conf.json` は `resources` を持たない**: ここに書くと全プラットフォームの
  バンドルに 18MB の Windows exe が混入する（APK が肥大し、実行不能なバイナリを配ることになる）。
  そのため base から撤去し、Windows 専用宣言だけを `tauri.windows.conf.json` に置く。
  Tauri v2 は `tauri.<platform>.conf.json` を JSON Merge Patch（RFC 7396）で合成するため、
  `bundle.resources` 配列は**丸ごと置換**される（追記ではない）。base 側に配列を残すと
  二重定義になるので base は無指定にしてある。
- **解決順（`bundled_candidates()` / `#[cfg(windows)]` のみ）**:
  1. プラグイン `setup()` で `app.path().resolve("resources", BaseDirectory::Resource)` を
     `OnceLock` に一度だけ保存したディレクトリ配下の `windows\yt-dlp.exe`
  2. 同じディレクトリ直下の `yt-dlp.exe`（プラットフォーム分割前の旧レイアウト互換）
  3. 実行ファイルと同じディレクトリの `resources\windows\yt-dlp.exe`、次に `resources\yt-dlp.exe`
     （インストーラ無しの portable 展開向け）
  4. **debug ビルドのみ**: 相対パス `src-tauri/resources/windows/yt-dlp.exe` と
     `resources/windows/yt-dlp.exe`（`tauri dev` は CWD が `src-tauri`。出荷ビルドでは起動
     ディレクトリの stray な `yt-dlp.exe` を拾わないよう debug 限定にしてある）
- **旧バグの修正**: 以前は `dir.join("resources")` と二重に連結して
  `<resource dir>/resources/resources/yt-dlp.exe` を探していた（`dir` 自体が既に `resources`）。
  `dir.join("windows").join(YTDLP_EXE_NAME)` と `dir.join(YTDLP_EXE_NAME)` に修正した。
- 見つかったものだけ採用するので、同梱が欠けたビルドでも従来どおり helper / `PATH` へ
  サイレントにフォールバックする（起動失敗にしない）。
- **実測**: `cargo check --manifest-path src-tauri/Cargo.toml` 実行後、`tauri-build` が
  `src-tauri/target/debug/resources/windows/yt-dlp.exe` を生成することを確認済み
  （= `tauri.windows.conf.json` が実際に読まれ、glob が解決されている）。
  同梱 exe 単体の `--version` は `2026.07.04`。

### 8.1.2 Android（APK）は別方式

APK には Windows 版のような「実行ファイルを同梱して spawn する」手段が使えない。

- **同梱なしの保証**: base `tauri.conf.json` は `bundle.resources` を持たず、
  `tauri.windows.conf.json` は Windows ターゲットでのみ合成される。したがって APK には
  `yt-dlp.exe` が**物理的に入らない**。加えて `bundled_candidates()` は
  `#[cfg(windows)]` の外では空の `Vec` を返すので、Windows exe を探しにいくコードパスも存在しない。
- **制約**: Android 10 以降のアプリ専用ディレクトリは W^X 制約（`noexec`）で、ダウンロードした
  ELF バイナリを子プロセスとして exec できない。`yt-dlp.exe` を `assets/` に入れて
  `Runtime.exec` する設計は成立しない。
- **方式**: Chaquopy で Python ランタイムを APK に同梱し、yt-dlp を Python パッケージとして
  埋め込む。ネイティブ依存は `.so`（JNI ライブラリ）として `jniLibs/` に置き、Java/Kotlin から
  は Python モジュール経由で呼ぶ。
- **帰結**: プラットフォームごとに取得層の実装が分かれる（Windows: Rust プラグインが
  同梱 exe を spawn / Android: Python ランタイムを in-process 呼び出し）。共通なのは
  「ネットワークから yt-dlp を落としてこない」「ユーザーに Python を要求しない」という
  **自己完結の原則**だけで、プレイヤー側の受付 API（`EnteiMediaPayload`）は共通のまま。
- **状態**: Android 側は未実装（設計のみ）。

### 8.1.3 ディスクフットプリント（キャッシュのライフサイクル）

- `get_video_info` / `stream_youtube` はどちらもメタデータ取得のみ（`--dump-json` / `-g`）で、動画データはディスクに書かない。
- それでも yt-dlp 自身のキャッシュや一時ファイルがユーザー共通領域に残らないよう、全呼び出しに `--no-cache-dir` と `--paths temp:<dir>` を付与する。`<dir>` はプラグイン専用の `app.path().app_cache_dir()/ytdlp`（解決できなければ `app_local_data_dir()/ytdlp`）で、Tauri の `PathResolver` 基準なので **Android では `<app data>/cache`** になる。
- このディレクトリは **起動時（`setup`）に全削除**、**終了時（`RunEvent::Exit`）にも best-effort で全削除** する。クラッシュや OS による強制終了で残っても、次の起動で必ず回収される。

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
3. **実環境 E2E は未確認**: `cargo check`（`src-tauri`）+ `cargo test`（plugin 16 件）と
   web テストのみ。WebView2 実機での YouTube 再生確認は未実施。

---

## 9. プレイヤー内蔵ネイティブデコーダー＆自動トラック・字幕同期仕様

> **状態:** 設計確定（方針決定 / 実装前）  
> **決定:** 動画デコードは「差し替え可能な任意モジュール」ではなく、**プレイヤー本体に直接組み込む**。
> モジュール機構（第1〜8章）は取得層（yt-dlp / Torrent / 辞書）に限定し、再生エンジンは
> コア Player の一部として扱う。

### 9.1 コアPlayer直結（外部モジュール化しない）

再生エンジンは `EnteiMediaPayload` を受けるコア Player の中に常時存在する。ON/OFF できる
アドオンではないため、モジュール管理画面（`/modules/`）の一覧には現れない。

| プラットフォーム | 再生エンジン | 主な設定 |
| --- | --- | --- |
| 全プラットフォーム共通（Windows / macOS / Linux / Android） | ネイティブ `libmpv`（Android は `libmpv.so` + `mpv-client-cross` JNI） | `hwdec: auto` / `vo: gpu-next`（Android は `vo: gpu` + `hwdec: mediacodec`） |

描画は Player の**透明な HTML/CSS UI オーバーレイの背面**で行う。つまり既存の React UI
（シークバー・字幕パネル・採掘ボタン・設定モーダル）はそのまま被さり、映像面だけが
ネイティブに置き換わる。UI 側の実装は「映像要素の差し替え」だけを見ればよく、
トラック選択やデコード可否を UI が知る必要はない。

**なぜ libmpv 一本化なのか（重複コードの完全排除とKISS）:**

1. **二重開発の完全撲滅**: デスクトップ用と Android 用で別々のエンジン（ExoPlayer vs mpv）を
   作ると、音声トラック選定や字幕同期（`sub-delay`）のロジックが二重化してバグの温床になる。
   `libmpv` に一本化することで、全 OS で同一の C/Rust API（`--alang`、`--slang`、`--sub-delay`）が
   100% そのまま動作する！
2. **HEVC / H.265 / 10bit の黒画面**（Android で頻発）を根本から解消する。Android でも
   `libmpv` 経由でハードウェアデコーダー（`MediaCodec`）を直接叩けるため、ブラウザ WebView の
   `<video>` のような黒画面・音声のみ現象（CONSTRAINTS #1885）が消滅する。
3. **4K 高ビットレートのカクつき**を解消する。ブラウザ経由のソフトウェアデコードではなく
   GPU ハードウェアデコードパスに直接乗せる。
4. **CPU 使用率をほぼ 0% に落とす**。GPU / `MediaCodec` にデコードを任せ、JS スレッドは
   UI と字幕ロジックに専念できる。

### 9.2 日本語音声・字幕の自動選択（MKV マルチトラック問題の解決）

Chromium では `HTMLMediaElement.audioTracks` が flag 裏で無効（CONSTRAINTS #1884）、かつ
MKV の内蔵トラックが `video.textTracks` に公開されない（CONSTRAINTS #1824）。そのため従来は
**最初の音声トラック（多くの場合 English dub）が強制され、切り替える API も無い**状態だった。

ネイティブエンジンではファイル／Torrent のヘッダー到着時点でトラックメタデータを評価し、
自動選択する。

| 対象 | 評価元 | 自動選択ルール |
| --- | --- | --- |
| 音声 | MKV の音声トラックメタデータ（`language` / `title` / トラック名） | mpv の `--alang=ja,jpn`（音声言語優先リスト）で選択し、解決されたトラック ID を `aid` に反映 |
| 字幕 | 内蔵字幕トラックのメタデータ | mpv の `--slang=ja,jpn`（字幕言語優先リスト）で選択し、解決されたトラック ID を `sid` に反映。混在する英語字幕は無視 |

- 判定は**ヘッダー到着時点**で行うため、ダウンロード完了を待たずに正しいトラックで再生が始まる。
- 一致トラックが存在しない場合はエンジン既定（先頭トラック）へ静かにフォールバックし、
  再生自体は失敗させない。
- 自動選択の結果はあくまで初期値であり、ユーザーが明示的に切り替えた場合はそちらを優先する。

### 9.3 サブミリ秒字幕同期（LazySync の進化）

従来の LazySync は JS 側で音声を解析するため、解析コストと精度のトレードオフを抱えていた。
ネイティブバックエンドでは**音声波形のタイミング／タイムコードを直接読む**ため、重い
クライアントサイド解析を挟まない。

- メディア開始時にオフセット（例: 10 秒遅れ）を算出し、その値（秒単位・サブミリ秒の
  小数精度・負値も可）をそのまま mpv の `--sub-delay=<sec>` に渡して反映する。
  符号変換や丸めは行わない。
- 結果として字幕が発話に即座にスナップし、同期処理によるスタッタ（引っかかり）が発生しない。
- 同期モードの保存キー（`entei.player.prefs.v1` の `subtitleSyncMode`）と UI 上の
  選択肢（`subtitle` / `audio` / `auto`）は従来どおりで、算出エンジンだけがネイティブに変わる。

### 9.4 実装状況と境界

- **状態**: 本節は設計確定（方針決定）。ネイティブエンジンの実装は未着手。
- **境界**: 取得層（`module-ytdlp` / `module-torrent` / Yomitan）は第2章のとおり独立モジュールの
  ままで、本節の変更はコア Player 内部に閉じる。
- **未確認**: `libmpv` / `Media3` の実機での再生・シーク・トラック選択・`sub-delay` 反映は
  実環境 E2E 未検証。
