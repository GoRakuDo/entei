# EizouDendenshi ↔ AnkiDroid Connect — Android Companion 設計仕様

> **状態:** 設計 v3.0（2026-08-30・AnkiconnectAndroid 依存を全廃・直接 SQLite 書込方式に改版）
> **対象:** EizouDendenshi Android コンパニオン（`eizouden-android-arm64`）に AnkiDroid 連携ブリッジ機能を追加する
> **スコープ:** クライアントは Entei Web / Yomitan / asbplayer の 3 つ全て

---

## 1. 動機と背景

### 現状の問題
- **PC (Windows/macOS/Linux)**: 公式 AnkiConnect（port 8765）で Yomitan/asbplayer/Entei が問題無く繋がる
- **Android (Termux)**: AnkiDroid 公式は **AnkiConnect サーバを公開しない**（セキュリティ上のポリシー）
- v2.0（2026-08-29）で採用していた `AnkiconnectAndroid` (KamWithK) APK は動作するが、**APK をインストールする手間**・**APK がノート DB を直接書き換えることへの不安**・**Entei から見るとメディア保存時にファイル名が変わってしまう**（`storeMediaFile` の戻り値が AnkiDroid 正規化名になる）等の問題が残っていた

### 調査で判明した重要事実（2026-08-29 Exa / Context7 / ankidroid 公式 wiki・issue より）
1. **AnkiDroid の collection.media には 2 つの場所がある。Termux から書き込み可能なのは「legacy」場所のみ**
   - **Legacy（従来）**: `/storage/emulated/0/AnkiDroid/collection.media/` — **Android 8〜15 全バージョンで Termux から直接書き込み可能**
   - **App-private**: `/storage/emulated/0/Android/data/com.ichi2.anki/files/AnkiDroid/` — Android 11+ で他アプリのアクセス禁止
   - AnkiDroid「full」版（F-Droid / GitHub APK）は `MANAGE_EXTERNAL_STORAGE` 権限で **legacy 場所を正式にサポートし続ける**（[AnkiDroid wiki: Full Storage Access](https://github.com/ankidroid/Anki-Android/wiki/Full-Storage-Access), [Issue #13222](https://github.com/ankidroid/Anki-Android/issues/13222)）
2. **Termux のストレージ権限は全バージョンで取得可能**（[Termux Issue #3647](https://github.com/termux/termux-app/issues/3647)）
3. **AnkiDroid のコレクション DB は SQLite ファイル**で、**AnkiDroid プロセス外から読み書き可能**。`collection.anki2` (legacy / schema 11〜18) のテーブル構造（`notes` / `cards` / `col` / `decks` / `models`）は Anki 本家のスキーマとして公開されており、`modernc.org/sqlite` (pure-Go、CGO 不要) 経由で安全に書き込み可能。AnkiDroid は WAL モードで動作しているので、書込みと読込みの競合は SQLite の `busy_timeout` 5 秒で十分吸収できる。
4. **AnkiDroid のメディア再生は「ファイルの物理存在」だけで動く**
   - `[sound:filename]` がフィールドにあれば、`collection.media/filename` が存在するだけで即時再生される
   - メディア DB（`.media.db2`）は**同期用**で、即時再生には不要（Anki Desktop Manual「Manually Adding Media」より）

### 解決策（v3.0 で AnkiconnectAndroid 依存を完全削除）
EizouDendenshi Android コンパニオンが、**AnkiConnect 互換の AnkiDroid ブリッジ**として直接動作する：
- **メディア**: Termux が collection.media へ直接書き込み
- **ノート**: コンパニオン自身が `collection.anki2` を SQLite で開いて直接 INSERT/UPDATE

これで Entei / Yomitan / asbplayer の既存クライアントコードを一切変更せず、接続先 URL を `http://127.0.0.1:36441` に向けるだけで Android 8〜15 で AnkiDroid と自動同期できる。**AnkiconnectAndroid APK のインストールは不要**（v2.0 から要件削減）。

```
  Yomitan / asbplayer / Entei Web (browser, Android)
     │   http://127.0.0.1:36441/v1/anki   ← Entei origin + token gate
     ▼
  eizouden-android-arm64 (Termux) ── anki サブコマンド
     │
     ├─ ① 【メディア】Termux が collection.media へ直接書き込み
     │     /storage/emulated/0/AnkiDroid/collection.media/<deterministic名>
     │
     └─ ② 【ノート】コンパニオン自身が collection.anki2 を SQLite で開いて直接 INSERT/UPDATE
           modernc.org/sqlite (pure-Go、CGO 不要) で busy_timeout=5000
           AnkiDroid 既存 journal_mode (WAL) は尊重（上書きしない）
     │
     ▼
  AnkiDroid（collection.media + collection.anki2）
       ※ アプリ再起動で in-memory model を refresh
       ※ AnkiWeb 同期は usn=-1 で拾われる
```

**得られるもの**
- **AnkiconnectAndroid APK 不要**：外部依存ゼロ、追加インストール不要
- **PC の公式 AnkiConnect と同じ感覚**で Android でも Anki 連携できる
- **メディアは Termux 単独で自動書き込み**（改名されない・衝突しない・手動操作不要）
- **ノート DB は標準 SQLite 経由**：AnkiDroid のバージョン差異（schema 11 vs 18）を autodetect して両方対応

---

## 2. 全体アーキテクチャ

### 2.1 配布
- **`eizouden-android-arm64` に `anki` サブコマンドを内蔵**（追加バイナリ不要）
- **追加 APK: なし**（v3.0 で AnkiconnectAndroid 依存を削除）
- **初回ユーザー操作**: Termux にストレージ権限付与の 1 回だけ（AnkiDroid 側で `legacy` 場所のコレクションを保持）

### 2.2 起動
```bash
# YouTube + Anki ブリッジ（フル機能）
./eizouden-android-arm64 --ytdlp /path/to/yt-dlp --ffmpeg /path/to/ffmpeg

# Anki ブリッジだけ（軽量）
./eizouden-android-arm64 anki \
  --anki-media-dir /storage/emulated/0/AnkiDroid/collection.media \
  --anki-collection /storage/emulated/0/AnkiDroid/collection.anki2 \
  --listen 127.0.0.1:36441
```
- `--anki-media-dir` を指定すると MediaWriter が collection.media を直接書く
- `--anki-collection` を指定すると Collection が collection.anki2 を SQLite で開く
- 両方空 → ブリッジ無効（3 つの `/v1/anki` ルートは登録されない = 既存ユーザーへの破壊的変更なし）
- どちらか片方 → ブリッジは部分有効（status エンドポイントで不足分を明示）

### 2.3 メディア書き込みフロー（①・Termux ダイレクト）
1. Entei は `entei_audio/entei_video/entei_screenshot` の Blob を base64 で送る
2. コンパニオンは **deterministic なファイル名** を自前生成（`generateMediaFilename` を hash ベースに）
3. コンパニオンが `/storage/emulated/0/AnkiDroid/collection.media/<deterministic名>` に**直接ファイルを書く**
4. 存在していれば同名で上書き（AnkiDroid は再ビルド不要で再生に反映）
5. 書いた**ファイル名そのもの**を Entei に返す（改名なし・戻り値そのまま使用可能）

### 2.4 ノート操作フロー（②・直接 SQLite）
- `version6` / `deckNames` / `deckNamesAndIds` / `modelNames` / `modelNamesAndIds` / `modelFieldNames` / `canAddNotes` / `canAddNotesWithErrorDetail` / `addNote` / `updateNoteFields` / `addTags` / `findNotes` / `notesInfo` を **`modernc.org/sqlite` 経由で collection.anki2 に直接実行**
- スキーマ差異（schema 11: `col.decks`/`col.models` JSON vs schema 18: 専用 `decks`/`models` テーブル）は `sqlite_master` で autodetect、両 reader を実装
- コンパニオンは addNote 送信前に以下を正規化:
  - `audio[]/video[]/picture[]` の JSON を **`params.note` 内部にネスト**（AnkiConnect 公式仕様）
  - 各メディアの `filename` を **Termux が書いた deterministic 名** に差し替え
  - 指定されたフィールドに `[sound:stored]` / `<img src="stored">` を append（A:/AnkiconnectAndroid IntegratedAPI.addMedia と同じ意味論）
- ノート DB の挿入は 1 トランザクションで `notes` 行 + N 枚の `cards` 行（モデル tmpls 配列の要素数）+ `col.mod` bump を実行

---

## 3. AnkiConnect 互換 API

公式 AnkiConnect v6 と完全互換（Yomitan/asbplayer は無変更で繋がる）：

| アクション | 互換性 | 経路 |
|---|---|---|
| `version` | ✅ 互換 | コンパニオン直接（"6" を返す） |
| `canAddNotes` | ✅ 互換 | collection.anki2 を csum ベースで SELECT |
| `addNote` | 🔧 拡張（互換） | collection.anki2 に INSERT（`note` + `audio[]`/`video[]`/`picture[]`）。`options.allowDuplicate=false`（既定）で重複検出 → 重複時は `null` 返却（AnkiConnect 公式挙動） |
| `updateNoteFields` | ✅ 互換 | collection.anki2 の notes 行を UPDATE |
| `addTags` | ✅ 互換 | collection.anki2 の notes.tags を UPDATE |
| `findNotes` | ✅ 互換（`added:1` / `nid:…` のみ） | collection.anki2 を SELECT |
| `notesInfo` | ✅ 互換 | collection.anki2 を JOIN |
| `modelNames` / `modelNamesAndIds` / `deckNames` / `deckNamesAndIds` | ✅ 互換 | col.decks / col.models JSON または decks / models テーブルを SELECT |
| `modelFieldNames` | ✅ 互換 | model の `flds` 配列を返す |
| `cardsInfo` / `findCards` / `guiBrowse` / `multi` | ❌ 未対応 | `{"error":"unsupported action: <name>"}` の AnkiConnect 形式エラーを返す |
| `storeMediaFile` | ✅ 互換（**Termux ダイレクトに切替**） | **collection.media へ直接書く** |

> 注：v2.0 で AnkiconnectAndroid に転送していたアクションは、すべて v3.0 で in-process 実装に置換。AnkiconnectAndroid の依存は完全に削除された。

### `addNote` 拡張仕様（AnkiConnect 公式互換）

**`audio` / `video` / `picture` は `params.note` 内部にネストする**（AnkiConnect 公式仕様、FooSoft docs）。コンパニオンは `filename` を deterministic 名に差し替え、指定されたフィールドに enclosure tag を append する：

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

ハンドラが送信前に以下の正規化を行う：
1. 各 `audio/video/picture` エントリの `data` (base64) をデコードし、MediaWriter.Write で `collection.media/` に書く
2. 返り値の `stored` 名（SHA-256 ハッシュ先頭 10 文字 + 元の拡張子）を `entry["filename"]` にセット
3. 各エントリの `fields` 配列に列挙されたフィールド値に enclosure tag を append（audio/video → `[sound:stored]`、picture → `<img src="stored">`）

deckName / modelName は `params.note` 内部と `params` トップレベルの両方を受け付ける（AnkiConnect 公式は top-level、Yomitan / Entei は note 内部）。

---

## 4. deterministic ファイル名（メディア本体）

### v3.0 維持（v2.0 から変更なし）
```go
// internal/anki/media.go GenerateFilename
sum := sha256.Sum256(data)
hash := hex.EncodeToString(sum[:])[:hashPrefixLen] // 先頭 10 hex
return sanitizeComponent(prefix) + "_" + hash + "." + sanitizeComponent(ext)
// 例: entei_audio_a1b2c3d4e5.webm
```
- **同一 Blob → 同一ファイル名** → 再エクスポートで同じファイルに上書き
- **異なる内容 → 別ファイル名** → 意図しない衝突なし
- deterministic → Entei 側で `[sound:filename]` を自前で埋めても、AnkiDroid の collection.media 上の実際のファイル名と一致する

---

## 5. メディア書き込み先の検出（Termux ダイレクト）

### パス検出（自動）
```
1. /storage/emulated/0/AnkiDroid/collection.media     ← legacy 既定
2. /sdcard/AnkiDroid/collection.media                  ← symlink
3. ユーザー設定パス（Entei Settings で上書き可能）
→ 最初に書き込みテストが成功した場所を自動採用
```

### collection.anki2 パス（自動）
- `--anki-collection` 未指定時は **collection.media ディレクトリの一つ上の sibling** として解決
- 例: `/storage/emulated/0/AnkiDroid/collection.media` → `/storage/emulated/0/AnkiDroid/collection.anki2`

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
4. **AnkiDroid が開いている間も collection.anki2 に書き込み可能**（SQLite WAL モード + busy_timeout=5000 で衝突吸収）

### 制約（明示）
- 移行済みアプリ内蔵パスで動かしたい場合は Termux から書けない → コンパニオンは明確なエラーで案内（Play Store 版/移行済みは非対応とマーク）
- AnkiDroid の in-memory model は手動 refresh が必要（**AnkiDroid アプリの再起動**で読み込まれる）。AnkiWeb 同期は `usn=-1` で自動的に拾われる
- 一部の AnkiConnect アクション（`cardsInfo` / `findCards` / `guiBrowse` / `multi`）は未実装（`{"error":"unsupported action: X"}` を返す）

### 同期の注意（重要）
- **AnkiDroid アプリの再起動が必要**：コンパニオンが collection.anki2 に書き込んだ内容は AnkiDroid の次回起動時に読み込まれる。実行中の AnkiDroid セッションには反映されない
- **AnkiWeb 同期**：書き込まれた行は `usn=-1` を持つので、次回 AnkiDroid から AnkiWeb への sync で自動的にアップロードされる（明示的な "sync now" ボタン不要）

---

## 7. Entei Web 側の変更（最小限）

### 7.1 変更 1: `storeMediaFile` → Termux ダイレクト
- コンパニオンの `storeMediaFile` は **collection.media へ直接書き込み** するように変更（v2.0 から維持）
- **戻り値（deterministic ファイル名）を使う**よう修正

### 7.2 変更 2: `addNote` の JSON ネスト修正
- `audio[]/video[]/picture[]` を **`params.note` 内部** に移す（v2.0 から維持）
- コンパニオンは `filename` を deterministic 名に差し替え、指定フィールドに enclosure tag を append

### 7.3 変更 3: 接続先設定
`apps/web/src/features/player/anki-miner-preferences.ts` に追加（v2.0 から維持）:
```ts
interface AnkiConnectionConfig {
  endpoint: string;                       // 既定: http://127.0.0.1:8765 (PC 公式)
  useAnkiconnectAndroidBridge: boolean;   // Android なら true
}
```

### 7.4 後方互換性
- PC の公式 AnkiConnect（:8765）へは**既存の `storeMediaFile` → `addNote` 2ステップ呼び出しを維持**
- 変更は Android / ブリッジ接続時のみ有効

### 7.5 v3.0 で不要になったフラグ
- v2.0 で必要だった `useAnkiconnectAndroidBridge = true` の意味論は v3.0 で「AnkiDroid bridge に直接接続する」と同じになった。フラグ名は変更しない（後方互換のため）

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
- **collection.anki2 への書き込みは in-process**: 外部 HTTP を経由しない（AnkiconnectAndroid APK への 8080 ポートフォワードが消えた）
- **メディアファイル名は sanitize**（`[^a-zA-Z0-9_-]` 除去）でパストラバーサル防止
- **書き込み先パスは whitelist のみ**（検出またはユーザー明示パスのみ・任意パス書き込みは許可しない）
- **ログには capability token / コレクション内容を出さない**（`internal/diag` の redaction discipline に従う）
- **ジャーナルモードは AnkiDroid の既存設定（WAL）を尊重**。コンパニオン起動時に上書きしない（既存セッションの WAL ファイルを保護）

---

## 10. 開発・テスト計画

### Phase 分け
1. **Phase 1（MVP）**: メディア書き込み（Termux ダイレクト・deterministic 名）＋ `version6`。Entei → AnkiDroid の**メディア保存**のみ成功
2. **Phase 2（v3.0 で実装）**: `addNote` / `updateNoteFields` / `addTags` / `findNotes` / `notesInfo` / `canAddNotes` を **直接 SQLite** で実装。AnkiconnectAndroid APK 不要
3. **Phase 3（v3.0 で実装）**: `deckNames` / `modelNames` / `modelFieldNames` を schema 11 / 18 両対応で実装
4. **Phase 4**: Yomitan / asbplayer の Android 実機 E2E テスト

### テスト戦略
- **`internal/anki/collection_test.go`**: テスト内で `collection.anki2` フィクスチャを生成（schema 11 / 18 両方）、real SQLite で CRUD / csum / findNotes / canAddNotes のユニットテスト
- **`internal/api/anki_api_test.go`**: HTTP 経路で `addNote` → notesInfo → cards の end-to-end テスト。`tempdir` に Writer と Collection を構築
- **CI 上**: pure-Go テストなので CI で完全実行可能（android/arm64 実機不要）

### 要実機確認
- AnkiDroid full 版 legacy パスでの書き込み（Android 8 / 11 / 14 の 3 種）
- AnkiDroid 実行中の collection.anki2 書き込みで WAL 衝突しないこと（busy_timeout 5000 で吸収できるか）
- AnkiDroid 再起動後にノートが見えること
- AnkiWeb 同期が `usn=-1` で行を正しく拾うこと

---

## 11. リスクと緩和

| リスク | 影響 | 緩和策 |
|---|---|---|
| AnkiDroid が legacy パスを廃止 | 書けない | F-Droid / GitHub full 版が維持する方針が明言済み。将来廃止時は SAF（Storage Access Framework）へ移行 |
| SQLite WAL 競合で AnkiDroid がロック | 書込み失敗 | busy_timeout=5000、書き込みリトライなし（単発トランザクション）。失敗時は ErrCollectionNotOpen で 503 |
| modernc.org/sqlite の pure-Go オーバーヘッド | 起動時間 + 数 MB バイナリサイズ | 実機 Termux で 50-100ms 程度。許容範囲（バイナリサイズ +8.7MB は許容） |
| スキーマ差異 (schema 11 vs 18) | 読めない | `sqlite_master` で autodetect、両 reader 実装 |
| AnkiDroid の in-memory model に反映されない | ノートが見えない | ユーザーガイドに「AnkiDroid 再起動」と明記。AnkiWeb 同期で永続化 |
| 削除した AnkiconnectAndroid の機能をユーザーが使っていた | 互換性 | addNote/updateNoteFields/addTags/findNotes/notesInfo/canAddNotes は完全に同等実装。cardsInfo/findCards/guiBrowse/multi は unsupported action エラー（ユーザー向けメッセージで明示） |
| Entei 既存 PC ユーザーの破壊的変更 | PC 機能損壊 | 既定 `useAnkiconnectAndroidBridge: false`、明示 opt-in のみ |

---

## 12. バイナリサイズ・依存関係

### 追加された依存関係
- **`modernc.org/sqlite` v1.57.0**（pure-Go SQLite ドライバ、CGO 不要）
  - コンパニオン arm64 クロスコンパイル（`CGO_ENABLED=0`）を維持するために必須
  - 既存の modernc 系列（`libc` / `mathutil` / `memory`）は transitive に更新

### 削除された依存関係
- **なし**（AnkiconnectAndroid は外部 APK であり Go 依存ではなかった）

### バイナリサイズ影響
| 構成 | サイズ |
|---|---|
| ベースライン（v2.0 最終・AnkiconnectAndroid 外部依存） | 約 46.7 MB |
| v3.0（modernc.org/sqlite 追加後） | 約 55.5 MB |
| **差分** | **+8.7 MB** |

modernc.org/sqlite の pure-Go ランタイム（SQLite 全文 + libc 純 Go 実装）が支配的。実機 Termux 起動時間への影響は 50-100ms 程度。

---

## 13. 改訂履歴

### v3.0（2026-08-30）
- **AnkiconnectAndroid 依存を完全削除**（最大変更点）
- コンパニオン自身が AnkiConnect 互換のサーバーとして動作
- `collection.anki2` を直接 SQLite で読み書き（`modernc.org/sqlite` v1.57.0 追加）
- スキーマ 11 / 18 の autodetect + 両 reader 実装
- フラグ体系を整理：`--anki-proxy` 削除、`--anki-collection` 追加、`--anki-media-dir` は維持
- ステータスエンドポイント：`proxyConfigured` → `enabled` + `collectionOpen` + `collectionPath` に拡張

### v2.0（2026-08-29）
- Termux ダイレクト collection.media 書き込み + AnkiconnectAndroid :8080 プロキシ 2 層構成
- `eizouden-android-arm64` 配布物に `anki` サブコマンド内蔵
- メディアは Termux 単独、ノートは AnkiconnectAndroid APK に委任
- → v3.0 で AnkiconnectAndroid 部分のみ廃止

### v1.0（初期構想）
- (取り下げ) AnkiDroid 公式の AnkiConnect 対応待ち