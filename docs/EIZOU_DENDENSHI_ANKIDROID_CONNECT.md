# EizouDendenshi ↔ AnkiDroid Connect — Android Companion 設計仕様

> **状態:** 設計草案 v2.0（2026-08-29・Android 8〜15 全対応の方針に改版）
> **対象:** EizouDendenshi Android コンパニオン（`eizouden-android-arm64`）に AnkiDroid 連携ブリッジ機能を追加する
> **スコープ:** クライアントは Entei Web / Yomitan / asbplayer の 3 つ全て

---

## 1. 動機と背景

### 現状の問題
- **PC (Windows/macOS/Linux)**: 公式 AnkiConnect（port 8765）で Yomitan/asbplayer/Entei が問題無く繋がる
- **Android (Termux)**: AnkiDroid 公式は **AnkiConnect サーバを公開しない**（セキュリティ上のポリシー）
- 既存の選択肢 `AnkiconnectAndroid` (KamWithK) は **専用 APK のインストール** が必要で、**Entei から見るとメディア保存時にファイル名が変わってしまう**（`storeMediaFile` の戻り値が AnkiDroid 正規化名になる）

### 調査で判明した重要事実（2026-08-29 Exa / Context7 / ankidroid 公式 wiki・issue より）
1. **AnkiDroid の collection.media には 2 つの場所がある。Termux から書き込み可能なのは「legacy」場所のみ**
   - **Legacy（従来）**: `/storage/emulated/0/AnkiDroid/collection.media/` — **Android 8〜15 全バージョンで Termux から直接書き込み可能**
   - **App-private**: `/storage/emulated/0/Android/data/com.ichi2.anki/files/AnkiDroid/` — Android 11+ で他アプリのアクセス禁止
   - AnkiDroid「full」版（F-Droid / GitHub APK）は `MANAGE_EXTERNAL_STORAGE` 権限で **legacy 場所を正式にサポートし続ける**（[AnkiDroid wiki: Full Storage Access](https://github.com/ankidroid/Anki-Android/wiki/Full-Storage-Access), [Issue #13222](https://github.com/ankidroid/Anki-Android/issues/13222)）
2. **Termux のストレージ権限は全バージョンで取得可能**（[Termux Issue #3647](https://github.com/termux/termux-app/issues/3647)）
3. **AnkiDroid のメディア再生は「ファイルの物理存在」だけで動く**
   - `[sound:filename]` がフィールドにあれば、`collection.media/filename` が存在するだけで即時再生される
   - メディア DB（`.media.db2`）は**同期用**で、即時再生には不要（Anki Desktop Manual「Manually Adding Media」より）

### 解決策（2 層構成に改版）
EizouDendenshi Android コンパニオンに **AnkiConnect 互換の AnkiDroid ブリッジ** を追加する。メディアは **Termux が直接 collection.media へ書き込み**、ノート操作（DB への INSERT）は AnkiconnectAndroid（:8080）が担当する。これで Entei / Yomitan / asbplayer の既存クライアントコードを一切変更せず、接続先 URL を `http://127.0.0.1:36441` に向けるだけで Android 8〜15 で AnkiDroid と自動同期できる。

```
Yomitan / asbplayer / Entei Web (browser, Android)
   │   http://127.0.0.1:36441/v1/anki   ← Entei origin + token gate
   ▼
eizouden-android-arm64 (Termux) ── anki サブコマンド
   │
   ├─ ① 【メディア】Termux が collection.media へ直接書き込み
   │     /storage/emulated/0/AnkiDroid/collection.media/<deterministic名>
   │
   └─ ② 【ノート】AnkiconnectAndroid (:8080) に HTTP プロキシ
         （注: ノート作成の権限は APK が持つ。メディアは関与しない）
   │
   ▼
AnkiconnectAndroid APK（初回 1 回だけインストール → AnkiDroid への DB 書込権限を持つ）
   │  Android framework (Context / 権限 / FlashCardsContract)
   ▼
AnkiDroid（collection.media + note DB）
```

**得られるもの**
- **PC の公式 AnkiConnect と同じ感覚**で Android でも Anki 連携できる
- **メディアは Termux 単独で自動書き込み**（改名されない・衝突しない・手動操作不要）
- ノート作成は既存の AnkiconnectAndroid が権限を持って実行 → Termux には Android アプリ権限が不要

---

## 2. 全体アーキテクチャ

### 2.1 配布
- **`eizouden-android-arm64` に `anki` サブコマンドを内蔵**（追加バイナリ不要）
- **追加 APK**: AnkiconnectAndroid のみ（初回インストールが必要。ノート書込権限を担うため）
- **初回ユーザー操作**: ①AnkiconnectAndroid をインストール＆権限許可 → ②Termux にストレージ権限付与 の 2 回だけ

### 2.2 起動
```bash
# YouTube + Anki ブリッジ（フル機能）
./eizouden-android-arm64 --ytdlp /path/to/yt-dlp --ffmpeg /path/to/ffmpeg

# Anki ブリッジだけ（軽量）
./eizouden-android-arm64 anki \
  --anki-proxy http://127.0.0.1:8080 \
  --anki-media-dir /storage/emulated/0/AnkiDroid/collection.media \
  --listen 127.0.0.1:36441
```

### 2.3 メディア書き込みフロー（①・Termux ダイレクト）
1. Entei は `entei_audio/entei_video/entei_screenshot` の Blob を base64 で送る
2. コンパニオンは **deterministic なファイル名** を自前生成（`generateMediaFilename` を hash ベースに）
3. コンパニオンが `/storage/emulated/0/AnkiDroid/collection.media/<deterministic名>` に**直接ファイルを書く**
4. 存在していれば同名で上書き（AnkiDroid は再ビルド不要で再生に反映）
5. 書いた**ファイル名そのもの**を Entei に返す（改名なし・戻り値そのまま使用可能）

### 2.4 ノート操作フロー（②・AnkiconnectAndroid プロキシ）
- `canAddNotes` / `addNote` / `updateNoteFields` / `addTags` / `findNotes` / `notesInfo` を `http://127.0.0.1:8080` へ**そのままプロキシ**
- コンパニオンは送信前に以下を正規化:
  - `audio[]/video[]/picture[]` の JSON を **`params.note` 内部にネスト**（AnkiConnect 公式仕様）
  - 各メディアの `filename` を **Termux が書いた deterministic 名** に差し替え
- ノート DB の挿入は AnkiconnectAndroid の権限で実行

---

## 3. AnkiConnect 互換 API

公式 AnkiConnect v6 と完全互換（Yomitan/asbplayer は無変更で繋がる）：

| アクション | 互換性 | 経路 |
|---|---|---|
| `version6` | ✅ 互換 | コンパニオン直接 |
| `canAddNotes` | ✅ 互換 | AnkiconnectAndroid :8080 へプロキシ |
| `addNote` | 🔧 拡張（互換） | :8080 へプロキシ（`note` + `audio[]`/`video[]`/`picture[]`） |
| `updateNoteFields` | ✅ 互換 | :8080 へプロキシ |
| `addTags` | ✅ 互換 | :8080 へプロキシ |
| `findNotes` | ✅ 互換 | :8080 へプロキシ |
| `notesInfo` | ✅ 互換 | :8080 へプロキシ |
| `cardsInfo` | ✅ 互換 | :8080 へプロキシ |
| `findCards` | ✅ 互換 | :8080 へプロキシ |
| `storeMediaFile` | ✅ 互換（**Termux ダイレクトに切替**） | **collection.media へ直接書く** |

### `addNote` 拡張仕様（AnkiConnect 公式互換）

**`audio` / `video` / `picture` は `params.note` 内部にネストする**（AnkiConnect 公式仕様、FooSoft docs）。コンパニオンは `filename` を deterministic 名に差し替える：

```json
POST /v1/anki
{
  "action": "addNote",
  "version": 6,
  "params": {
    "note": {
      "deckName": "Mining",
      "modelName": "Basic",
      "fields": { "Front": "猫", "Back": "cat" },
      "tags": ["mining", "anime"],
      "options": { "allowDuplicate": false, "duplicateScope": "deck" },
      "audio":  [ { "filename": "entei_audio_hashh.webm", "data": "<b64>", "fields": ["Front"] } ],
      "video":  [ { "filename": "entei_video_hashh.webm", "data": "<b64>", "fields": ["Back"] } ],
      "picture":[ { "filename": "entei_shot_hashh.jpg",  "data": "<b64>", "fields": ["Back"] } ]
    }
  }
}
```

---

## 4. deterministic ファイル名（メディア本体）

### 現行のバグ（今回のリグレッション）
```ts
async function generateMediaFilename(prefix, ext) {
  const timestamp = Date.now().toString(36);
  const random = Math.random().toString(36).slice(2, 8);  // ← 毎回変わる
  return `${safePrefix}_${timestamp}_${random}.${safeExt}`;
}
```
`Math.random()` が毎回違うため、**同じ動画を再エクスポートするたびに別ファイル名** になり、Anki コレクションが肥大化＋古いファイルが残る（スクショの `entei_audio_mterczve_...` と `entei_audio_mterd0ge_...` の 2 重発生）。

### 修正（content-hash 命名）
```ts
export function generateMediaFilename(prefix: string, ext: string, content: Blob | Uint8Array) {
  // media の content hash (SHA-256) を短縮 — 同一 Blob → 常に同一ファイル名
  const hash = sha256Short(content);           // 先頭 10 hex
  return `${prefix}_${hash}.${ext}`;           // e.g. entei_audio_a1b2c3d4e5.webm
}
```
- **同一 Blob → 同一ファイル名** → 再エクスポートで同じファイルに上書き
- **異なる内容 → 別ファイル名** → 意図しない衝突なし
- deterministic → Entei 側で `[sound:filename]` を自前で埋めても、AnkiconnectAndroid の戻り値と一致する

---

## 5. メディア書き込み先の検出（Termux ダイレクト）

### パス検出（自動）
```
1. /storage/emulated/0/AnkiDroid/collection.media     ← legacy 既定
2. /sdcard/AnkiDroid/collection.media                  ← symlink
3. ユーザー設定パス（Entei Settings で上書き可能）
→ 最初に書き込みテストが成功した場所を自動採用
```

### 書き込み可否の検査（起動時）
- ディレクトリが存在・`access(W_OK)` が通るか
- 実際に一時ファイルを書いて→消す（書き込みテスト）
- 失敗したら分かりやすいエラー: 「AnkiDroid の collection.media に書けません。AnkiDroid のコレクション場所を legacy（`/storage/emulated/0/AnkiDroid/`）にしてください」

### Android バージョン別 権限
| Android | Termux の権限取得 | collection.media への書き込み |
|---|---|---|
| 8〜10 | Settings → Termux → Storage | ✅（legacy storage） |
| 11〜12 | Settings → Termux → Files and media → Manage all files | ✅（`MANAGE_EXTERNAL_STORAGE`） |
| 13〜15 | Settings → Special app access → All files access → Termux | ✅（`MANAGE_EXTERNAL_STORAGE`） |

---

## 6. 前提条件と制約

### 前提（ドキュメントに明記）
1. **AnkiDroid は F-Droid / GitHub「full」版** を使用（Play Store 版は legacy パスを持たず、`Android/data` 配下は Termux から書けない）
2. **コレクション場所が legacy**（`/storage/emulated/0/AnkiDroid/`）。ユーザーが「migrate」ボタンを押してアプリ内蔵パスに移してないこと
3. **Termux にストレージ権限を付与**（初回 1 回）

### 制約（明示）
- 移行済みアプリ内蔵パスで動かしたい場合は Termux から書けない → コンパニオンは明確なエラーで案内（Play Store 版/移行済みは非対応とマーク）
- `AnkiconnectAndroid` APK が未インストールの場合、ノート作成（canAddNotes/addNote 等）は不可 → エラーで案内

---

## 7. Entei Web 側の変更（最小限）

### 7.1 変更 1: `storeMediaFile` → Termux ダイレクト
- コンパニオンの `storeMediaFile` は **collection.media へ直接書き込み** するように変更
- **戻り値（deterministic ファイル名）を使う**よう修正（`PlayerApp.tsx:3597-3616` など）

### 7.2 変更 2: `addNote` の JSON ネスト修正
- `audio[]/video[]/picture[]` を **`params.note` 内部** に移す
- コンパニオンは `filename` を deterministic 名に差し替えるため、Entei 側で名前を書き換える必要なし

### 7.3 変更 3: 接続先設定
`apps/web/src/features/player/anki-miner-preferences.ts` に追加:
```ts
interface AnkiConnectionConfig {
  endpoint: string;                       // 既定: http://127.0.0.1:8765 (PC 公式)
  useAnkiconnectAndroidBridge: boolean;   // Android なら true
}
```
- 既定 `endpoint: 'http://127.0.0.1:8765'`、`useAnkiconnectAndroidBridge: false`
- Android 向けに「接続先を127.0.0.1:36441 / ブリッジを使う」に切り替え

### 7.4 後方互換性
- PC の公式 AnkiConnect（:8765）へは**既存の `storeMediaFile` → `addNote` 2ステップ呼び出しを維持**
- 変更は Android / ブリッジ接続時のみ有効（`useAnkiconnectAndroidBridge` が true のときだけ）

---

## 8. 互換性マトリクス

| クライアント | 公式 AnkiConnect (PC :8765) | EizouDendenshi Android Bridge (:36441) |
|---|---|---|
| **Entei Web** | ✅ 既存 | ✅ 新設定切替 |
| **Yomitan (PC)** | ✅ 既存 | ✅ URL 変更のみ |
| **Yomitan (Android Firefox)** | ❌ | ✅ URL 変更のみ |
| **asbplayer (PC)** | ✅ 既存 | ✅ URL 変更のみ |
| **asbplayer (Android)** | ❌ | ✅（要検証） |

---

## 9. セキュリティ

- **既存パターン踏襲**: `127.0.0.1:36441` only・capability token gate・Origin gate は既存 `internal/credential` を流用
- **AnkiconnectAndroid プロキシは外部へ暴露しない**: 127.0.0.1 から → 127.0.0.1:8080 への閉域ループのみ
- **メディアファイル名は sanitize**（`[^a-zA-Z0-9_-]` 除去）でパストラバーサル防止
- **書き込み先パスは whitelist のみ**（検出またはユーザー明示パスのみ・任意パス書き込みは許可しない）

---

## 10. 開発・テスト計画

### Phase 分け
1. **Phase 1（MVP）**: メディア書き込み（Termux ダイレクト・deterministic 名）＋ `version6`。Entei → AnkiDroid の**メディア保存**のみ成功
2. **Phase 2**: `canAddNotes` / `addNote` / `updateNoteFields` / `addTags` を AnkiconnectAndroid :8080 へプロキシ
3. **Phase 3**: `findNotes` / `notesInfo` / `cardsInfo` / `findCards` をプロキシ（全 AnkiConnect v6 互換）
4. **Phase 4**: Yomitan / asbplayer の Android 実機 E2E テスト

### 要実機確認
- AnkiDroid full 版 legacy パスでの書き込み（Android 8 / 11 / 14 の 3 種）
- AnkiconnectAndroid の `addNote` が `audio[]/video[]/picture[]` を受け取るか
- deterministic 名のメディアが同期時に正しく検知されるか（Check Media 後）

---

## 11. リスクと緩和

| リスク | 影響 | 緩和策 |
|---|---|---|
| AnkiDroid が legacy パスを廃止 | 書けない | F-Droid / GitHub full 版が維持する方針が明言済み。将来廃止時は SAF（Storage Access Framework）へ移行 |
| AnkiconnectAndroid の JSON 解釈が公式と微妙に違う | ノート作成失敗 | プロキシ時に正規化＋実機テスト |
| AnkiDroid のメディア同期が deterministic 名を検知しない | 同期で消える | Check Media の仕様を確認。必要なら `.media.db2` への登録も検討 |
| Termux のストレージ権限が Android バージョンで変わる | 書けない | 8〜15 の権限取得手順をガイドに同梱 |
| Entei 既存 PC ユーザーの破壊的変更 | PC 機能損壊 | 既定 `useAnkiconnectAndroidBridge: false`、明示 opt-in のみ |
