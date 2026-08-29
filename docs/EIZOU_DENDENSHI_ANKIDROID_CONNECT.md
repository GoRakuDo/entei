# EizouDendenshi ↔ AnkiDroid Proxy — Android Companion 設計仕様

> **状態:** 設計草案（v1.0・2026-08-29）
> **対象:** EizouDendenshi Android コンパニオン（`eizouden-android-arm64`）に AnkiConnect 互換の AnkiDroid ブリッジ機能を追加する
> **スコープ:** クライアントは Entei Web / Yomitan / asbplayer の 3 つ全て

---

## 1. 動機と背景

### 現状の問題
- **PC (Windows/macOS/Linux)**: 公式 AnkiConnect（port 8765）で Yomitan/asbplayer/Entei が問題無く繋がる
- **Android (Termux)**: AnkiDroid 公式は **AnkiConnect サーバを公開しない**（セキュリティ上のポリシー）
- 既存の唯一の選択肢 `AnkiconnectAndroid` (KamWithK) は **専用 APK のインストール** が必要で、**Yomitan/asbplayer はその APK 専用 API 形式しか受け付けない**

### 解決策
EizouDendenshi Android コンパニオンに **AnkiconnectAndroid の機能を移植** し、**AnkiConnect 公式と互換性のある API サーバ** として動作させる。Entei / Yomitan / asbplayer の **既存クライアントコードを一切変更せず**、接続先 URL を `http://127.0.0.1:36441` に向けるだけで AnkiDroid と同期できる世界を実現する。

```
Yomitan (Firefox)
   │
asbplayer
   │   既存 AnkiConnect クライアント実装
   │   URL: http://127.0.0.1:36441
   │
   ├──► EizouDendenshi Android Companion (Termux)
   │      │
   │      ├─ AnkiConnect 公式 API 完全互換 (version 6)
   │      │    - canAddNotes / addNote / updateNoteFields / addTags / findNotes
   │      │    - addNote 拡張: audio[] / video[] / picture[] 同時送信
   │      │    - storeMediaFile
   │      │
   │      └─ ContentResolver → AnkiDroid (AddContentApi / FlashCardsContract)
   │
Entei Web
   │   URL: http://127.0.0.1:36441
   │   既存実装 (storeMediaFile + addNote)
```

### 得られるもの
- **PC の公式 AnkiConnect と完全に同じ感覚**で Android でも Anki 連携できる
- ユーザーは「**AnkiDroid のコンテンツ URI への権限付与**」を初回 1 回だけ行えば、あとは既存クライアントがそのまま動く
- 3rd party APK (`AnkiconnectAndroid`) を**インストール不要**

---

## 2. 全体アーキテクチャ

### 2.1 デプロイ
- **追加のバイナリ**: 不要（既存 `eizouden-android-arm64` に `anki` サブコマンドを内蔵）
- **追加のユーザータスク**: 初回のみ AnkiDroid の「**ファイルアクセスの権限を AnkiconnectAndroid に付与**」が必要（AnkiDroid のセキュリティ仕様）
- **既存タスク**: 1 回だけ（AnkiDroid のセットアップウィザードに従う）

### 2.2 プロセス構成
```
[Termux プロセス: eizouden-android-arm64 anki]
    │
    ├─ :36441 (loopback only) ── AnkiConnect 互換 HTTP API
    │
    └─ ContentResolver (system_service:activity)
         │
         └─ com.ichi2.anki/FlashCardsContract.AnkiMedia
              └─ AnkiDroid が内部 SQLite に media URI を INSERT
                   → MediaStore / Anki collection.media に反映
```

### 2.3 必要な Android パーミッション
- **`com.ichi2.anki.permission.READ_WRITE_PERMISSION`**（AnkiDroid 専用権限）
  - 初回ペアリング時に AnkiDroid のパーミッション許可ダイアログが表示される
- **Entei コンパニオンの AndroidManifest** には同パーミッションを宣言（`<uses-permission>` タグで OK）
- **`<queries>` 要素**（Android 11+ の package visibility）:
  ```xml
  <queries>
    <package android:name="com.ichi2.anki" />
    <provider android:authority="com.ichi2.anki.flashcards" />
  </queries>
  ```

### 2.4 Termux 上での制約と回避策
- **問題 1**: Termux アプリは **AnkiDroid の FileProvider URI に直接アクセスできない**（com.ichi2.anki 以外）
  - **回避策**: `Intent.FLAG_GRANT_READ_URI_PERMISSION` 付きで `FileProvider` URI を生成し、AnkiDroid に渡す前に `grantUriPermission` を呼ぶ
  - これは AnkiconnectAndroid の `MediaAPI.java` (line 49-50) と同じ実装
- **問題 2**: AnkiDroid の ContentResolver は `com.ichi2.anki.flashcards` Authority を露出
  - **回避策**: `addNote` 等の API 呼び出しで `AnkiDroid-Api` 内部仕様に依存しない（公式 `FlashCardsContract` のみ使用）

---

## 3. 既存コードベースとの統合

### 3.1 既存 eizouden-android-arm64 への追加

| 既存 | 追加 |
|---|---|
| `--ytdlp PATH` | そのまま |
| `--ffmpeg PATH` | そのまま |
| `cli` サブコマンド | `anki` サブコマンドを追加 |

#### 起動例
```bash
# YouTube + Anki ブリッジ（フル機能）
./eizouden-android-arm64 --ytdlp /path/to/yt-dlp --ffmpeg /path/to/ffmpeg

# Anki ブリッジだけ（軽量、yt-dlp / ffmpeg 不要）
./eizouden-android-arm64 anki \
  --anki-package com.ichi2.anki \
  --listen 127.0.0.1:36441
```

### 3.2 既存 AnkiConnect コンパチ API

公式 AnkiConnect v6 と完全互換のエンドポイント（Yomitan/asbplayer は無変更で繋がる）:

| アクション | 互換性 | 用途 |
|---|---|---|
| `version6` | ✅ AnkiConnect 互換 | ヘルスチェック |
| `canAddNotes` | ✅ AnkiConnect 互換 | 重複チェック |
| `addNote` | 🔧 **拡張** (互換) | note + audio[]/video[]/picture[] 同時送信 |
| `updateNoteFields` | ✅ AnkiConnect 互換 | 既存フィールド更新 |
| `addTags` | ✅ AnkiConnect 互換 | タグ追加 |
| `findNotes` | ✅ AnkiConnect 互換 | 検索 |
| `notesInfo` | ✅ AnkiConnect 互換 | ノート情報取得 |
| `cardsInfo` | ✅ AnkiConnect 互換 | カード情報取得 |
| `findCards` | ✅ AnkiConnect 互換 | カード検索 |
| `storeMediaFile` | ✅ AnkiConnect 互換（**hash 命名に変更**） | メディア保存 |

### 3.3 `addNote` 拡張仕様（AnkiconnectAndroid 互換 + AnkiConnect 公式互換）

公式 AnkiConnect 6.x の `addNote` は `params.audio` / `params.video` / `params.picture` を**実は既にサポートしている**（AnkiConnect docs: https://foosoft.net/projects/anki-connect/#note-actions）。

これに乗っかる形で、Yomitan/asbplayer/Entei 全てが同じリクエスト形式を使える:

```json
POST /v1/anki/action
Content-Type: application/json
{
  "action": "addNote",
  "version": 6,
  "params": {
    "note": {
      "deckName": "Mining",
      "modelName": "Basic",
      "fields": {
        "Front": "猫",
        "Back": "cat"
      },
      "tags": ["mining", "anime"],
      "options": {
        "allowDuplicate": false,
        "duplicateScope": "deck"
      }
    },
    "audio":  [
      {
        "filename": "entei_audio_abc123.webm",
        "data": "<base64>",
        "fields": ["Front"]
      }
    ],
    "video":  [
      {
        "filename": "entei_video_abc456.webm",
        "data": "<base64>",
        "fields": ["Back"]
      }
    ],
    "picture":[
      {
        "filename": "entei_screenshot_xyz789.jpg",
        "data": "<base64>",
        "fields": ["Back"]
      }
    ]
  }
}
```

**コンパニオンの処理フロー**:
1. `note` パラメータから `deckName` / `modelName` / `fields` / `tags` を抽出
2. `audio[]`/`video[]`/`picture[]` の各エントリについて:
   a. `_cacheDir/` に `filename` で一旦保存（FileProvider URI 化）
   b. `addContent` ContentProvider 経由で AnkiDroid に登録 → **実際に collection.media にコピーされる**
   c. **公式 AnkiConnect 形式の `[sound:filename]` / `<img src="filename">` / `<video src="filename">` 文字列を `fields` に自動 append**
3. `fields` を AnkiDroid の `NoteAPI.addNote()` で INSERT
4. noteId を返却

### 3.4 `storeMediaFile` 拡張（AnkiconnectAndroid 互換）

```json
POST /v1/anki/action
{
  "action": "storeMediaFile",
  "version": 6,
  "params": {
    "filename": "entei_audio_abc123.webm",
    "data": "<base64>"
  }
}
```

**コンパニオンの処理フロー**:
1. `_cacheDir/<filename>` にファイルを書く
2. `FileProvider.getUriForFile()` で URI 化
3. `grantUriPermission("com.ichi2.anki", uri, FLAG_GRANT_READ_URI_PERMISSION)` で AnkiDroid に読取権限を付与
4. `FlashCardsContract.AnkiMedia` ContentProvider に INSERT
5. 戻り値: **AnkiDroid が内部で正規化した最終ファイル名**（`abc123.webm` のような衝突回避形式）
   - **重要**: 戻り値を必ず Entei Web に返すこと（Entei Web が `[sound:filename]` 文字列に埋め込む）
   - **同一 Blob を 2 回送っても同じファイル名に収束**（AnkiDroid 内部の衝突回避ロジック任せ）

---

## 4. Entei Web 側の変更（最小限）

### 4.1 変更点: 既存 `addNote` 呼び出しを `note` + `audio` + `video` + `picture` 同時送信に変更

**現状（修正前）**:
```ts
// step 1: storeMediaFile (各メディア)
// step 2: addNote (fields に [sound:filename] を手動で埋める)
```

**改善後**:
```ts
// step 1: addNote 1 ショットで note + 全メディアを同時送信
const result = await client.addNote({
  note: { deckName, modelName, fields, tags, options },
  audio:  [{ filename, data: base64, fields: ['Front'] }],
  video:  [{ filename, data: base64, fields: ['Back'] }],
  picture:[{ filename, data: base64, fields: ['Back'] }],
});
```

### 4.2 新規設定: 「Anki 接続先の URL」と「AnkiDroid Bridge を使うか」

`apps/web/src/features/player/anki-miner-preferences.ts` に追加:
```ts
interface AnkiConnectionConfig {
  /** AnkiConnect API URL. 既存ユーザー = http://127.0.0.1:8765 (公式). 新規ユーザー = http://127.0.0.1:36441 (EizouDendenshi AnkiDroid Bridge) */
  endpoint: string;
  /** AnkiDroid ユーザーは true にすると audio/video/picture 配列を addNote に同時送信 (PC AnkiConnect は false = 自動判定で上書き) */
  useAnkiconnectAndroidBridge: boolean;
}
```

- 既定値: `endpoint: 'http://127.0.0.1:8765'`、`useAnkiconnectAndroidBridge: false`
- ユーザーが AnkiDroid ブリッジ経由で送信したい場合、Settings → Anki で「**Use EizouDendenshi Companion (Android)**」を選択 → 自動的に `endpoint: 'http://127.0.0.1:36441'` ＆ `useAnkiconnectAndroidBridge: true`

### 4.3 後方互換性
- 既存の `storeMediaFile` → `addNote` の 2 ステップ呼び出しは**そのまま動く**（既存ユーザーへの破壊的変更なし）
- AnkiConnect 公式の 4 アクションが既存フィールド仕様（`[sound:filename]`）で動作することも保証

---

## 5. 互換性マトリクス

| クライアント | 公式 AnkiConnect サーバ (PC) | EizouDendenshi Android Companion |
|---|---|---|
| **Entei Web (現在の実装)** | ✅ 動作中 | ✅ 動作（4.2 設定切替で新形式に） |
| **Yomitan (PC)** | ✅ 動作中 | ✅ 動作（Yomitan 設定で URL 変更のみ） |
| **Yomitan (Android/Firefox)** | ❌ 動かない | ✅ 動作（Firefox Android ＋ port forward） |
| **asbplayer (PC)** | ✅ 動作中 | ✅ 動作（asbplayer 設定で URL 変更のみ） |
| **asbplayer (Android)** | ❌ 動かない | ✅ 動作（要検証） |

---

## 6. セキュリティ

### 6.1 既存パターン踏襲
- **Origin gate**: `http://127.0.0.1:36441` のみ listen（外部バインド禁止）
- **Capability token gate**: 既存 `internal/credential` で永続化された opaque token を `Authorization: Bearer <token>` で検証
- **API key 検証**: AnkiConnect 公式と同じ `key` パラメータをサポート（Entei 設定のキーと照合）

### 6.2 追加対策
- **キャッシュディレクトリ**: `_cacheDir/entei-anki/<filename>`（アプリ固有）
- **キャッシュ自動削除**: AnkiDroid INSERT 成功後 1 分以内に OS のガベージコレクタ任せ（FileProvider 経由の読取完了後）
- **ContentProvider 権限スコープ**: AnkiDroid に `FLAG_GRANT_READ_URI_PERMISSION` を AnkiDroid パッケージのみに付与

---

## 7. 開発・テスト計画

### 7.1 段階
1. **Phase 1 (MVP)**: AnkiConnect 公式互換の 4 アクション（`addNote` / `canAddNotes` / `storeMediaFile` / `version6`）のみ。Entei Web から Android へエクスポート成功。
2. **Phase 2**: 全 AnkiConnect v6 互換（`findNotes` / `notesInfo` / `updateNoteFields` / `addTags` / `cardsInfo` / `findCards`）。
3. **Phase 3**: Yomitan / asbplayer 互換性テスト（E2E）。他ツールからの接続検証。
4. **Phase 4**: パフォーマンス最適化（並列メディアアップロード、ContentProvider batch INSERT）。

### 7.2 テストマトリクス
| | AnkiConnect 公式 (PC) | AnkiDroid (Android) |
|---|---|---|
| **Entei Web** | 既存テストで動作 | Phase 1 追加テスト |
| **Yomitan** | E2E 既存 | Phase 3 で新規 |
| **asbplayer** | E2E 既存 | Phase 3 で新規 |

### 7.3 配布・アップデート
- **バイナリサイズ影響**: 既存 21.7MB → +5〜8MB 程度（Android SDK 依存の AnkiDroid 連携部分）
- **リリースサイクル**: 既存 eizouden-android-arm64 リリースに同梱。Versioning は `0.4.0-rc.1` → `0.4.0`（minor bump）

---

## 8. 将来の拡張（スコープ外）

- **iOS 対応**: AnkiMobile は ContentProvider を提供しないため、別設計（WebSocket bridge to iOS Share Extension 等）が必要
- **既存 AnkiConnect (PC) と同じ使用感での自動マイグレーション**: 検出したらエンドポイント自動切替
- **Conflict 解決**: AnkiDroid + EizouDendenshi 双方が同じノートを編集した場合の競合解決

---

## 9. リスクと緩和

| リスク | 影響 | 緩和策 |
|---|---|---|
| AnkiDroid のバージョン間で `FlashCardsContract` 仕様が変わる | API 呼び出しが失敗 | バージョン検出 → フォールバック API へ動的切替 |
| Termux アプリから `grantUriPermission` が動かない Android バージョン | メディアが AnkiDroid にコピーされない | FileProvider の代替 (EXTRA_STREAM) 経由を実装 |
| AnkiDroid の `READ_WRITE_PERMISSION` 許可を取り消された | 突然エクスポートが失敗 | 検出時にフロントへ UI 通知 + 設定で再許可手順を提示 |
| メディアファイルサイズが AnkiDroid の limit を超える | `storeMediaFile` がエラー | クライアント側で事前サイズチェック + 自動スキップ |
| `com.ichi2.anki` パッケージが端末に入っていない | 全機能停止 | 起動時に detection → 分かりやすいエラーで早期終了 |
| Entei 既存ユーザー（PC）の破壊的変更 | PC 機能の損壊 | デフォルト `useAnkiconnectAndroidBridge: false`、明示的 opt-in のみ |
