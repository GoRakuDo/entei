# EizouDendenshi ↔ AnkiDroid Connect — Android Companion 設計仕様

> **状態:** 設計 v4.5（2026-09-01・Yomitan 完全互換: `multi` / `cardsInfo` / `guiBrowse` / `findNotes front:` を追加・`NoteInfo.Cards` を `[]int64` に統一）
> **対象:** EizouDendenshi Android コンパニオン（`eizouden-android-arm64`）に AnkiDroid 連携ブリッジ機能を追加する
> **スコープ:** クライアントは Entei Web / Yomitan / asbplayer の 3 つ全て

---

## 1. 動機と背景

### 現状の問題
- **PC (Windows/macOS/Linux)**: 公式 AnkiConnect（port 8765）で Yomitan/asbplayer/Entei が問題無く繋がる
- **Android (Termux)**: AnkiDroid 公式は **AnkiConnect サーバを公開しない**（セキュリティ上のポリシー）
- v2.0（2026-08-29）で採用していた `AnkiconnectAndroid` (KamWithK) APK は動作するが、**APK をインストールする手間**・**APK がノート DB を直接書き換えることへの不安**・**Entei から見るとメディア保存時にファイル名が変わってしまう**（`storeMediaFile` の戻り値が AnkiDroid 正規化名になる）等の問題が残っていた

### 調査で判明した重要事実（2026-08-29 Exa / Context7 / ankidroid 公式 wiki・issue より）
1. **AnkiDroid の collection.media には 3 つの場所がある。v4.2 以降は Termux から書き込み可能な「Android/media」場所を既定で使う**
   - **Android/media（既定・推奨）**: `/storage/emulated/0/Android/media/com.ichi2.anki/files/AnkiDroid/collection.media/` — AnkiDroid（F-Droid / GitHub full 版）インストール直後の既定ディレクトリで、**termux-setup-storage + Termux へのメディア権限付与だけで Android 11+ でも Termux から直接書き込み可能**（`MANAGE_EXTERNAL_STORAGE` 不要、実機検証済み 2026-08-31）
   - **Legacy（従来）**: `/storage/emulated/0/AnkiDroid/collection.media/` — Android 8〜10 では既定で Termux から直接書き込み可能。Android 11+ では `MANAGE_EXTERNAL_STORAGE` 付与が必要
   - **App-private**: `/storage/emulated/0/Android/data/com.ichi2.anki/files/AnkiDroid/` — Android 11+ で他アプリのアクセス禁止（書き込み不可）
   - AnkiDroid「full」版（F-Droid / GitHub APK）は `MANAGE_EXTERNAL_STORAGE` 権限で **legacy 場所も正式にサポートし続ける**（[AnkiDroid wiki: Full Storage Access](https://github.com/ankidroid/Anki-Android/wiki/Full-Storage-Access), [Issue #13222](https://github.com/ankidroid/Anki-Android/issues/13222)）
2. **Termux のストレージ権限は全バージョンで取得可能**（[Termux Issue #3647](https://github.com/termux/termux-app/issues/3647)）
3. **AnkiDroid のコレクション DB は SQLite ファイル**で、**AnkiDroid プロセス外から読み書き可能**。`collection.anki2` (legacy / schema 11〜18) のテーブル構造（`notes` / `cards` / `col` / `decks` / `models`）は Anki 本家のスキーマとして公開されており、`modernc.org/sqlite` (pure-Go、CGO 不要) 経由で安全に書き込み可能。AnkiDroid は WAL モードで動作しているので、書込みと読込みの競合は SQLite の `busy_timeout` 5 秒で十分吸収できる。
4. **AnkiDroid のメディア再生は「ファイルの物理存在」だけで動く**
   - `[sound:filename]` がフィールドにあれば、`collection.media/filename` が存在するだけで即時再生される
   - メディア DB（`.media.db2`）は**同期用**で、即時再生には不要（Anki Desktop Manual「Manually Adding Media」より）

### 解決策（v3.0 で AnkiconnectAndroid 依存を完全削除）
EizouDendenshi Android コンパニオンが、**AnkiConnect 互換の AnkiDroid ブリッジ**として直接動作する：
- **メディア**: Termux が collection.media へ直接書き込み
- **ノート**: コンパニオン自身が `collection.anki2` を SQLite で開いて直接 INSERT/UPDATE

これで Entei / Yomitan / asbplayer の既存クライアントコードを一切変更せず、接続先 URL を `http://127.0.0.1:8765`（公式 AnkiConnect と同じポート）に向けるだけで Android 8〜15 で AnkiDroid と自動同期できる。**AnkiconnectAndroid APK のインストールは不要**。

```
  Yomitan / asbplayer / Entei Web (browser, Android)
     │   POST http://127.0.0.1:8765   ← raw AnkiConnect 互換（Entei 既定エンドポイントと同一）
     ▼
  eizouden-android-arm64 (Termux) ── anki サブコマンド
     │
     ├─ ① 【メディア】Termux が collection.media へ直接書き込み
     │     /storage/emulated/0/Android/media/com.ichi2.anki/files/AnkiDroid/collection.media/<deterministic名>
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
- **初回ユーザー操作**: Termux にストレージ権限付与の 1 回だけ（AnkiDroid 側で Android/media 場所のコレクションを保持 — インストール直後の既定）

### 2.2 起動
```bash
# 通常起動（grkd-edds メニュー / 自動起動 — フラグを渡さない既定パス）
./eizouden-android-arm64
# → MediaWriter probe が /storage/emulated/0/Android/media/com.ichi2.anki/files/AnkiDroid/collection.media を検出し、
#   sibling の collection.anki2 が存在すればブリッジを自動 wire。Anki ブリッジ ON。

# 明示的にオーバーライドしたい場合（例：app-private storage に置いたコレクション）
./eizouden-android-arm64 \
  --anki-collection /storage/emulated/0/Android/data/com.ichi2.anki/files/AnkiDroid/collection.anki2

# 任意：API key（未指定 = 無認証）
./eizouden-android-arm64 --anki-api-key secret-key

# Anki ブリッジ + YouTube（フル機能）
./eizouden-android-arm64 \
  --ytdlp /path/to/yt-dlp --ffmpeg /path/to/ffmpeg
```
- `--anki-collection` **未指定（既定）**：
  1. **MediaWriter** をプローブ（AnkiDroid collection.media の auto-detect — Android/media 優先、sibling collection.anki2 が既にあればそちらを採用）
  2. **sibling の collection.anki2 を stat** — 存在すれば Collection をそのパスで開く
  3. **raw AnkiConnect 互換リスナーを 127.0.0.1:8765 にバインド** → Entei / Yomitan / asbplayer は URL 設定不要
  - プローブ失敗 OR sibling collection.anki2 不在（AnkiDroid が app-private storage に移行したケース）→ ブリッジ無効（8765 bind すらしない、diag に 1 行 warn ログ）
- `--anki-collection <path>`（v4.1 での役割は **OVERRIDE 専用**）：指定したパスをそのまま Collection として開く（auto-derive を上書き）。非標準の置き場所向け
- `--anki-api-key <key>`（任意）：body `key` フィールドが一致しないと全アクションを拒否（constant-time compare）
- **Collection オープン失敗** → raw リスナーはバインドして走りつつ dispatch が `{"error":"anki collection not available"}` を返す（ログには警告）

> **v4.1 変更点（v4.0 の regression 修正）**: v4.0 では `--anki-collection` が opt-in フラグになり、空ならブリッジ完全無効だった。これにより `grkd-edds` メニュー起動（フラグを一切渡さない経路）で 8765 がバインドされず「Disconnected」になる regression が出た。v3.0 の本来の契約は「AnkiDroid の legacy collection が検出されたらブリッジ ON」だったので、v4.1 で auto-derive をデフォルトに戻し、`--anki-collection` は非標準配置向けのオーバーライド専用に役割を変更した。

### 2.3 メディア書き込みフロー（①・Termux ダイレクト）
1. Entei は `entei_audio/entei_video/entei_screenshot` の Blob を base64 で送る
2. コンパニオンは **deterministic なファイル名** を自前生成（`generateMediaFilename` を hash ベースに）
3. コンパニオンが `/storage/emulated/0/Android/media/com.ichi2.anki/files/AnkiDroid/collection.media/<deterministic名>` に**直接ファイルを書く**
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

## 3. AnkiConnect 互換 API（raw listener のみ）

公式 AnkiConnect v6 と完全互換（Yomitan/asbplayer は無変更で繋がる）。**v4.0 で /v1/anki/* の 3 ルートは全廃**し、公式 AnkiConnect と同じ **127.0.0.1:8765** に raw listener を出してそこが唯一の Anki サーフェスになった。

- **エンドポイント:** `http://127.0.0.1:8765`（公式 AnkiConnect と同じポート）
- **メソッド・パス:** `POST /`（AnkiConnect クライアントは全パスに POST する。ハンドラはパスを見ず、エンベロープの JSON 形状だけでディスパッチする）
- **リクエスト・ ** **`{action, version, params, key?}`** の AnkiConnect エンベロープ
- **レスポンス・ ** **`HTTP 200 + {"result": <値>, "error": <文字列|null>}`**（HTTP ステータスは常に 200。クライアントは `error` フィールドを見る）
- **CORS:** `Access-Control-Allow-Origin: *`、allow POST + OPTIONS、allow `Content-Type`（Yomitan の extension origin もそのまま通る）。loopback bind だけに依存した脅威モデル（§9）

### アクション互換表

| アクション | 互換性 | 経路 |
|---|---|---|
| `version` | ✅ 互換 | コンパニオン直接（"6" を返す） |
| `canAddNotes` | ✅ 互換 | collection.anki2 を csum ベースで SELECT |
| `addNote` | 🔧 拡張（互換） | collection.anki2 に INSERT（`note` + `audio[]`/`video[]`/`picture[]`）。`options.allowDuplicate=false`（既定）で重複検出 → 重複時は `{"result":null,"error":null}`（AnkiConnect 公式挙動） |
| `updateNoteFields` | ✅ 互換 | collection.anki2 の notes 行を UPDATE |
| `addTags` | ✅ 互換 | collection.anki2 の notes.tags を UPDATE |
| `findNotes` | ✅ 互換（`added:1` / `nid:…` / `front:<value>`） | collection.anki2 を SELECT（v4.5 で `front:` 追加・Yomitan `_fieldsToQuery` 形状） |
| `notesInfo` | ✅ 互換 | collection.anki2 を JOIN（v4.5 で `cards` を `[]int64` に統一） |
| `modelNames` / `modelNamesAndIds` / `deckNames` / `deckNamesAndIds` | ✅ 互換 | col.decks / col.models JSON または decks / models テーブルを SELECT |
| `modelFieldNames` | ✅ 互換 | model の `flds` 配列を返す |
| `cardsInfo` | ✅ 互換（v4.5） | collection.anki2 を SELECT（入力順保持・未知 ID はスキップ） |
| `multi` | ✅ 互換（v4.5） | サブアクションを位置順にディスパッチ・エラーは全体エンベロープに昇格（AnkiconnectAndroid と等価） |
| `guiBrowse` | ✅ 互換（v4.5） | `nid:<int>` 直接カード取得 / その他クエリは FindNotes→CardIDsForNoteIDs 経路 |
| `findCards` | ❌ 未対応 | `{"result":null,"error":"unsupported action: findCards"}` を返す（HTTP 200） |
| `storeMediaFile` | ✅ 互換 | collection.media へ直接書く（AnkiDroid 正規化名ではなく Termux 独自 deterministic 名を返す） |

> 注：v2.0 で AnkiconnectAndroid に転送していたアクションは、すべて v3.0 で in-process 実装に置換し、v4.0 で **raw 8765 listener を唯一のサーフェス** に統一。AnkiconnectAndroid の依存は v3.0 で完全に削除された。

### `addNote` 拡張仕様（AnkiConnect 公式互換）

**`audio` / `video` / `picture` は `params.note` 内部にネストする**（AnkiConnect 公式仕様、FooSoft docs）。コンパニオンは `filename` を deterministic 名に差し替え、指定されたフィールドに enclosure tag を append する：

```json
POST http://127.0.0.1:8765/
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
3. 各エントリの ` `fields` 配列に列挙されたフィールド値に enclosure tag を append（audio/video → `[sound:stored]`、picture → `<img src="stored">`）

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

### パス検出（自動） — v4.2（2026-08-31、Android/media 優先）

```
1. /storage/emulated/0/Android/media/com.ichi2.anki/files/AnkiDroid/collection.media   ← 既定（Android/media）
2. /storage/emulated/0/AnkiDroid/collection.media                                       ← legacy フォールバック
3. /sdcard/AnkiDroid/collection.media                                                    ← symlink フォールバック
4. ユーザー設定パス（Entei Settings で上書き可能）
→ 最初に書き込みテストが成功した場所を自動採用
```

**v4.2 の選定根拠**：Android 11+ の scoped storage は Termux から
`/storage/emulated/0/AnkiDroid/` への書き込みを、`MANAGE_EXTERNAL_STORAGE`
（設定 → 特殊アプリアクセス → すべてのファイルアクセス）が付与されていない
限りブロックする。`/storage/emulated/0/Android/media/com.ichi2.anki/files/` は
共有メディアの対となる置き場で、AnkiDroid の Settings → Advanced →
AnkiDroid directory をここに向けた状態なら **termux-setup-storage + AnkiDroid
のメディア権限付与だけ** で Termux から直接書き込み可能（実機で
mkdir + write + ls 検証済み、2026-08-31）。`MANAGE_EXTERNAL_STORAGE` を
要求しないため、クリーンインストール + 標準権限だけで完結する。

AnkiDroid のデフォルトディレクトリは F-Droid / GitHub full 版で
`/storage/emulated/0/Android/media/com.ichi2.anki/files/AnkiDroid/` を
指す。インストール直後の AnkiDroid コレクションをここに向けたまま運用すれば、
追加設定ゼロで Termux コンパニオンから直接書き込みできる。

### セットアップ手順（Android/media パスを採用する場合）

1. **AnkiDroid をインストール**（F-Droid / GitHub full 版）
2. **AnkiDroid を起動** → ウィザード完了後、最初のコレクションが
   `/storage/emulated/0/Android/media/com.ichi2.anki/files/AnkiDroid/` に
   作られる（既定）。`Settings → Advanced → AnkiDroid directory` で
   確認できる
3. **Termux で `termux-setup-storage`** を実行（初回 1 回）
4. **AnkiDroid のメディア権限を Termux に付与**：
   設定 → アプリ → Termux → 権限 → ファイルとメディア → 許可
5. **eizouden-android-arm64 を起動**：`./eizouden-android-arm64`
   （フラグなし）。プローブが Android/media パスを最初に試し、成功すれば
   ブリッジ ON。失敗したら legacy /sdcard にフォールバック

### セットアップ手順（legacy パスを維持する場合）

Android 8〜10、または `MANAGE_EXTERNAL_STORAGE` を手動付与する
セットアップを採っている場合は従来通り：

1. **AnkiDroid** の `Settings → Advanced → AnkiDroid directory` を
   `/storage/emulated/0/AnkiDroid/` に設定（必要な場合のみ。Android 8〜10
   では既定が legacy のことがある）
2. **Termux** に `MANAGE_EXTERNAL_STORAGE` を付与（Android 11+）：
   設定 → 特殊アプリアクセス → すべてのファイルアクセス → Termux
3. **Termux で `termux-setup-storage`** を実行

この場合、②のプローブで legacy がそのまま一致する。

### collection.anki2 パス（v4.1 で auto-derive 既定に戻す、v4.2 で Android/media 対応）
- **既定（`--anki-collection` 未指定）**: プローブした collection.media の **sibling**（=`<media-dir>/../collection.anki2`）を自動採用
  - Android/media プローブ成功時：sibling は
    `/storage/emulated/0/Android/media/com.ichi2.anki/files/AnkiDroid/collection.anki2`
    → 存在すればブリッジ ON
  - legacy プローブ成功時：sibling は
    `/storage/emulated/0/AnkiDroid/collection.anki2` → 存在すればブリッジ ON
  - sibling が不在 → diag に 1 行 warn ログ（"AnkiDroid may be migrated to app-private storage"）を出してブリッジ無効
- **`--anki-collection <path>`**: 上記 auto-derive を **OVERRIDE** する。非標準の置き場所（app-private storage のテストや、デュアルコレクション等）向け
- v4.0 で一旦 opt-in 化（空 = 無効）していたが、メニュー/自動起動経路でフラグを渡せないためにブリッジが dead になる regression が判明。v4.1 で v3.0 の auto-derive 契約に戻した
- **v4.2 で Android/media 候補を追加**：Android 11+ のスコープドストレージ下の
  Termux 直接書き込み経路として、Android/media パスを候補リストの先頭に追加
  （実機で書込み検証済み）
- v4.0 廃止項目：`--anki-media-dir`（MediaWriter の probe 自動検出に一本化済み）

### FUSE roundtrip（Android/media ロック回避）— v4.3（2026-08-31）

**根因（実機検証済み）**: コレクションが `/storage/emulated/0/Android/media/com.ichi2.anki/files/AnkiDroid/collection.anki2`（FUSE マウント）にある場合、Android FUSE の `fcntl(F_SETLK)` はクロスUID のロック要求に **EAGAIN** を返す。SQLite はこれをロック衝突と解釈するため、**あらゆるアクセス**が `database is locked (SQLITE_BUSY)` になる（`busy_timeout` では解消できない）。

**実機エビデンス（2026-08-31）**:
- FUSE 上の collection.anki2 を直接 SQLite で開く → `SQLITE_BUSY`（全アクセス失敗）
- `cp src work`（ext4 の作業ディレクトリへコピー）→ work コピーへの SQLite INSERT/UPDATE/DELETE → **全て成功**
- `cp work src`（FUSE へ writeback）→ **成功**
- → **コピー → work で操作 → writeback が唯一の viable 経路**

**実装（`internal/anki/fuse_roundtrip.go` + `OpenCollectionWithWorkDir`）**:
1. 従来通り**直接オープン**を試行（busy_timeout=5000 のプラグマ付き）
2. オープンが busy/locked エラー（エラー文字列に `"database is locked"` または `"SQLITE_BUSY"` を含む）で失敗し、かつ work ディレクトリが指定されている場合のみ、**FUSE roundtrip にフォールバック**: ファイルを work ディレクトリ（ext4・ロック可能）へコピーして、そのコピーを同じプラグマで開く。`Path()` は元の FUSE パスを返し続ける（コレクションの識別は変わらない）
3. **Close() で writeback**: `PRAGMA wal_checkpoint(TRUNCATE)`（best-effort、WAL を本体にマージ）→ work DB をクローズ → work ファイルを FUSE の元パスへコピー → work ファイル削除。writeback 失敗時は work コピーを**残して**エラーを返す。この復旧用コピーは**次回起動時に上書き破棄されない**：`CopyIn` は既存の work ファイルを src と比較し、サイズまたは mtime が異なる場合は**切り詰めず** `<base>.recovery-<unix-ts>` へリネームして退避し、退避先パスをエラーで通知してから新規コピーを作る。退避ファイルは手動で元パスへ復元できるが、work 側の基本ファイル名（`collection.anki2`）は次回の `CopyIn` で再利用されるため、復元はその前に実施すること

- **work ディレクトリ既定**: `--anki-work-dir` 未指定時、Android では `<os.TempDir()>/eizouden-anki-work`（Termux の app-private = `/data/data/...` = ext4 で非 FUSE）を自動採用。Android 以外では空 = roundtrip 無効（従来の直接オープンのみ）
- **`--anki-work-dir <path>`**: 任意の ext4 パスを明示指定（既定の自動解決を上書き）
- **制約**: roundtrip 中は AnkiDroid を閉じておくこと（`-wal`/`-shm` サイドカーはコピー対象外のため、AnkiDroid 実行中の書き込みは roundtrip に反映されない。§6 の「アプリ再起動が必要」と同様の前提）

### 書き込み可否の検査（起動時）
- ディレクトリが存在・`access(W_OK)` が通るか
- 実際に一時ファイルを書いて→消す（書き込みテスト）
- 失敗したら分かりやすいエラー: 「AnkiDroid の collection.media に書けません。AnkiDroid のコレクション場所を `/storage/emulated/0/Android/media/com.ichi2.anki/files/AnkiDroid/` にして、Termux にメディア権限を付与してください」

### Android バージョン別 権限（v4.2 で Android/media 経路を追加）
| Android | Termux の権限取得 | Android/media への書き込み | legacy への書き込み |
|---|---|---|---|
| 8〜10 | Settings → Termux → Storage | ✅（legacy storage） | ✅（legacy storage） |
| 11〜12 | Settings → Termux → Files and media → Allow media access | ✅（追加権限不要） | ✅ のみ（`MANAGE_EXTERNAL_STORAGE` 必要） |
| 13〜15 | Settings → Apps → Termux → Permissions → Files and media → Allow | ✅（追加権限不要） | ✅ のみ（`MANAGE_EXTERNAL_STORAGE` 必要） |

Android 11+ では **Android/media 経路を既定で使う**ことで `MANAGE_EXTERNAL_STORAGE` の手動付与を不要にする。

---

## 6. 前提条件と制約

### 前提（ドキュメントに明記）— v4.2（2026-08-31）
1. **AnkiDroid は F-Droid / GitHub「full」版** を使用（Play Store 版は legacy パスを持たず、`Android/data` 配下は Termux から書けない）
2. **コレクション場所が Android/media**（既定）：
   `/storage/emulated/0/Android/media/com.ichi2.anki/files/AnkiDroid/`。
   F-Droid / GitHub full 版をインストール直後の既定でここに作られる。
   **Android 11+ ではここを使うこと**（`MANAGE_EXTERNAL_STORAGE` の手動付与を回避できる）。
   legacy（`/storage/emulated/0/AnkiDroid/`）は Android 8〜10、または
   手動で `MANAGE_EXTERNAL_STORAGE` を付与するセットアップを維持したい場合の
   フォールバック。
3. **Termux にストレージ権限を付与**（初回 1 回）：
   Android 8〜10 → `termux-setup-storage` + Settings → Termux → Storage
   Android 11+ → `termux-setup-storage` + Settings → Apps → Termux →
   Permissions → Files and media → Allow
4. **AnkiDroid が開いている間も collection.anki2 に書き込み可能**（SQLite WAL モード + busy_timeout=5000 で衝突吸収）

### 制約（明示）
- 移行済みアプリ内蔵パスで動かしたい場合は Termux から書けない → コンパニオンは明確なエラーで案内（Play Store 版/移行済みは非対応とマーク）
- AnkiDroid の in-memory model は手動 refresh が必要（**AnkiDroid アプリの再起動**で読み込まれる）。AnkiWeb 同期は `usn=-1` で自動的に拾われる
- `findCards` は未実装（`{"error":"unsupported action: findCards"}` を返す。AnkiconnectAndroid 自体も findCards は未実装 = 同等のため不影响）

### 同期の注意（重要）
- **AnkiDroid アプリの再起動が必要**：コンパニオンが collection.anki2 に書き込んだ内容は AnkiDroid の次回起動時に読み込まれる。実行中の AnkiDroid セッションには反映されない
- **AnkiWeb 同期**：書き込まれた行は `usn=-1` を持つので、次回 AnkiDroid から AnkiWeb への sync で自動的にアップロードされる（明示的な "sync now" ボタン不要）

---

## 7. Entei Web 側の変更（ゼロコンフィグ達成）

### 7.1 v4.0 でゼロコンフィグ達成
- **Entei Web の Anki endpoint はデフォルトで `http://127.0.0.1:8765`**（公式 AnkiConnect と同じ）
- **コンパニオン v4.0 が raw 8765 listener を提供する**ので、Entei は **設定スイッチ不要・URL 設定不要** でそのまま Android 上の AnkiDroid と話せる
- PC の公式 AnkiConnect（:8765）と Android の EizouDendenshi raw listener（:8765）が **同一 URL** で提供されるので、クライアント側のコードパスを全く切り替える必要がない

### 7.2 変更 1: `storeMediaFile` → Termux ダイレクト（v3.0 から維持）
- コンパニオンの `storeMediaFile` は **collection.media へ直接書き込み**（v3.0 から維持）
- **戻り値（deterministic ファイル名）を使う** こと

### 7.3 変更 2: `addNote` の JSON ネスト修正（v3.0 から維持）
- `audio[]/video[]/picture[]` を **`params.note` 内部** に移す
- コンパニオンは `filename` を deterministic 名に差し替え、指定フィールドに enclosure tag を append

### 7.4 後方互換性
- PC の公式 AnkiConnect（:8765） へもそのまま繋がる（コードパス切り替え不要）
- Android で**ブリッジを起動していない**端末では Entei は "Disconnected" のまま（v3.0 と同じ・現状の PC ユーザーへの影響ゼロ）

### 7.5 v3.0 / v4.0 で不要になったフラグ・設定
- v2.0 で必要だった `useAnkiconnectAndroidBridge = true` の意味論は v3.0 で「AnkiDroid bridge に直接接続する」と同じになり、**v4.0 で完全に消えた**（raw listener が常にデフォルト URL で提供されるため、クライアント側の設定スイッチが不要になった）
- v3.0 の `--anki-media-dir` は **v4.0 で廃止**（MediaWriter はプローブで自動検出するのみ。ユーザーが明示指定するケースは存在しない）

---

## 8. 互換性マトリクス

| クライアント | 公式 AnkiConnect (PC :8765) | EizouDendenshi raw listener (:8765, 端末上) |
|---|---|---|
| **Entei Web** | ✅ 既存（変更なし） | ✅ **ゼロコンフィグ**・デフォルト URL そのまま |
| **Yomitan (PC)** | ✅ 既存 | ✅ URL 変更不要（PC 上の AnkiConnect がそのまま） |
| **Yomitan (Android Firefox)** | ❌ 不可 | ✅ URL 変更不要（8765 のまま） |
| **asbplayer (PC)** | ✅ 既存 | ✅ URL 変更不要 |
| **asbplayer (Android)** | ❌ 不可 | ✅ URL 変更不要 |

---

## 9. セキュリティ

- **raw listener は `127.0.0.1:8765` only**: loopback bind に依存した脅威モデル。`0.0.0.0` への bind はコンパニオン起動時に拒否する
- **raw listener は CORS  permissive**（`Access-Control-Allow-Origin: *`、allow POST + OPTIONS、allow `Content-Type`）: loopback bind だけの隔離に依存。**AnkiconnectAndroid / 公式 AnkiConnect plugin と同じ脅威モデル** で、ブラウザ拡張（Yomitan）の extension origin もそのまま通る
- **コレクション操作をヘイストする token gate はもうない**: v4.0 で `/v1/anki/*` の token gate は全廃。認証は **`--anki-api-key` body key**（任意）に一本化。設定しなければ無認証（AnkiconnectAndroid と同じ）
- **collection.anki2 への書き込みは in-process**: 外部 HTTP を経由しない（AnkiconnectAndroid APK への 8080 ポートフォワードも v3.0 で消えた）
- **メディアファイル名は sanitize**（`[^a-zA-Z0-9_-]` 除去）でパストラバーサル防止
- **書き込み先パスは whitelist のみ**（--anki-collection 明示パスのみ・任意パス書き込みは許可しない。MediaWriter の collection.media 検出も auto-detect の whitelist 候補のみ）
- **ログには API key / コレクション内容を出さない**（`internal/diag` の redaction discipline に従う。`--anki-api-key` 値はログにも起動バナーにも出さない）
- **ジャーナルモードは AnkiDroid の既存設定（WAL）を尊重**。コンパニオン起動時に上書きしない（既存セッションの WAL ファイルを保護）

### 9.1 CORS-permissive の正当化

「loopback bind だけだから `*` で良い」という判断は以下の根拠：

1. **AnkiconnectAndroid が同じ posture** （公式 APK も CORS `*`）
2. **公式 AnkiConnect plugin が同じ posture**（ブラウザ拡張を前提にしている）
3. **loopback bind だけなのでオフホストからは到達不能**（そもそも攻撃面がプロセスのあるマシン内に閉じる）
4. **`--anki-api-key` を設定すれば任意 origin に露出して body key なしでは全部拒否される**（デフォルト off・明示 opt-in）

これに対し、**/v1/* の他の token-gated ルートは Origin allowlist を厳格に守る**（ED-3 の既存 ・仕様は raw listener とは独立）。

---

## 10. 開発・テスト計画

### Phase 分け
1. **Phase 1（MVP）**: メディア書き込み（Termux ダイレクト・deterministic 名）＋ `version6`。Entei → AnkiDroid の**メディア保存**のみ成功
2. **Phase 2（v3.0 で実装）**: `addNote` / `updateNoteFields` / `addTags` / `findNotes` / `notesInfo` / `canAddNotes` を **直接 SQLite** で実装。AnkiconnectAndroid APK 不要
3. **Phase 3（v3.0 で実装）**: `deckNames` / `modelNames` / `modelFieldNames` を schema 11 / 18 両対応で実装
4. **Phase 4**: Yomitan / asbplayer の Android 実機 E2E テスト

### テスト戦略
- **`internal/anki/collection_test.go`**: テスト内で `collection.anki2` フィクスチャを生成（schema 11 / 18 両方）、real SQLite で CRUD / csum / findNotes / canAddNotes のユニットテスト
- **`internal/api/anki_connect_test.go`**: raw 8765 listener の HTTP 経路で `addNote` → notesInfo → cards の end-to-end テスト。`tempdir` に Writer と Collection を構築。version / storeMediaFile / canAddNotes / findNotes / updateNoteFields / OPTIONS preflight / API key gate / EADDRINUSE tolerance / bridge-disabled no-op をピン
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
| 削除した AnkiconnectAndroid の機能をユーザーが使っていた | 互換性 | addNote/updateNoteFields/addTags/findNotes/notesInfo/canAddNotes/cardsInfo/multi/guiBrowse は完全に同等実装。`findCards` のみ unsupported action エラー（AnkiconnectAndroid 自体も未実装のため同等） |
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

### v4.5（2026-09-01）: Yomitan 完全互換 — `multi` / `cardsInfo` / `guiBrowse` / `findNotes front:` 追加
- **症状**: Yomitan のカード追加ボタン（+）が表示されない。ステータスは `Connected`・フィールド読込みも成功するも、サーバの `getAnkiNoteInfo` が throw して `ankiError` にセット → display-anki.js `_updateSaveButtons` が `button.hidden = true` にする動作
- **根本原因**: Yomitan の `getAnkiNoteInfo` はポップアップ表示時に (a) `findNoteIds` を返し、(b) `multi` で各フィールドを `findNotes` して重複検出、(c) ノート+カード詳細を `notesInfo` + `cardsInfo` で取得、というフローを取る。我々の raw listener には `multi` と `cardsInfo` が無く、(b) で必ず throw していた。加えて `notesInfo.cards` を `[]CardInfo`（オブジェクト配列）で返していたが、Yomitan の `_normalizeArray(result.cards, -1, 'number')` は number[] しか受け付けず、これも `_normalizeNoteInfoArray` の中で throw して上記ボタンを隠れさせていた
- **修正**:
  - **`multi` アクション追加**：サブアクションを位置順でディスパッチし、各サブの生結果を返す。サブアクションエラーは検出された順に伝搬し、残りのサブアクションは実行されない — クライアントはエラーエンベロープを受け取り `findRoute throws` と同じように batch 全体を失敗と見る。AnkiconnectAndroid の `findRoute` ベース実装と同じ
  - **`cardsInfo` アクション追加**：1 カード 1 SELECT で入力順を維持（1 個の `IN(...)` だと並べ直しが必要になるため）。未知 ID はスキップ。`CardInfo` は `cardId` / `noteId` / `deckId` / `ord` / `queue` / `type` / `due` / `ivl` / `factor` / `reps` / `lapses` / `left` / `odue` / `odid` / `flags` の AnkiConnect フルセット
  - **`NoteInfo.Cards` を `[]int64`（フラットなカード ID）に変更**：これが上記 Yomitan `_normalizeArray` が throw していた一次要因。AnkiConnect ワイヤ仕様 `cards: [cardId, ...]` に揃えた。カードレベル状態は別途 `cardsInfo(notesInfo[].cards)` で取得 — これが Yomitan の `_notesCardsInfo` フローと等価
  - **`FindNotes` に `front:` クエリ対応**：Yomitan の `_fieldsToQuery` が `"front:<value>"`（outer ダブルクォート包み）を送出するため、quoted と bare 両方を受理。大小無視、`%` / `_` / `\` を LIKE メタとしてエスケープ。実機のメモでも入力値でパターン一致
  - **`guiBrowse` アクション追加**：`nid:<int>` は fast-path で `cardsForNote` に直結（Yomitan の `guiBrowseNote` はこの形状）。その他の FindNotes 対応クエリ（`added:1` / `front:<value>` / `nid:<id-list>`）は `FindNotes` + `CardIDsForNoteIDs` で展開。**カード ID を返す**（Yomitan の `_normalizeArray(..., 'number')` がカード ID を期待する・ノート ID を返すとボタン押下先がバスる）
- **対応完了アクション一覧**: `version` / `deckNames(AndIds)` / `modelNames(AndIds)` / `modelFieldNames` / `canAddNotes(WithErrorDetail)` / `addNote` / `updateNoteFields` / `addTags` / `findNotes` / `notesInfo` / `cardsInfo` / `multi` / `guiBrowse` / `storeMediaFile`
- **AnkiconnectAndroid と未実装の差分**: `findCards` のみ未対応（AnkiconnectAndroid 自体も `findCards` は未実装）。`addNotes` / `apiReflect` / `suspend` / `sync` / `guiEditNote` は AnkiconnectAndroid も未実装のため同等
- **テスト追加**:
  - `internal/anki/collection_test.go`: `TestCardIDsForNoteIDs`（6 ケース・集合 + 順不同処理）
  - `internal/api/anki_connect_test.go`: `TestRawAnkiGuiBrowse`（2 カード照合）、 `TestRawAnkiGuiBrowseRequiresParams`、`TestRawAnkiGuiBrowseEmptyQuery`、`TestRawAnkiGuiBrowseGeneralQueryFallthrough`
- **コード変更点**:
  - `internal/anki/collection.go`: `CardInfo` 拡張（NoteID 追加・フィールド名統一 IVL/ODID）、 `CardIDsForNoteIDs(noteIDs []int64) ([]int64, error)` 追加、 `cardsForNote` を `CardsForNote` にエクスポート、 `FindNotes` に `front:` 経路追加
  - `internal/api/anki_connect.go`: `multi` / `cardsInfo` / `guiBrowse` ケース追加、 `parseGuiBrowseNIDQuery` ヘルパー追加
- **dependencies**: 変更なし（pure-Go ライブラリ追加なし）

### v4.4（2026-09-01）
- **AnkiDroid 2.16+ 上の `modelFieldNames` 系 API を全て動作可能に**：v4.3 のスキーマ検出では collection.anki2 を `OpenCollection` で開けなくなり、（a）`notetypes.config` を `{flds, tmpls}` JSON と仮定して SELECT して `no such column: fields` で落とす、（b）`notetypes.name` / `decks.name` / `fields.name` / `templates.name` が全て `COLLATE unicase` なのに modernc.org/sqlite が UNICASE を登録しないため name 列を SELECT しただけで `no such collation sequence: unicase` で落とす、の 2 連鎖で deck/model の name 引き当てが完全に dead だったのを根本修正
- **`internal/anki/unicase.go` 新設**：Anki/ICU 流の case-insensitive コンパレーターを `modernc.org/sqlite` に `UNICASE` 名で登録。`strings.ToLower` で case-fold したものを単純比較する ICU-ASCII 互換実装（diacritic folding は未対応——ブリッジのサーフェスでは deck 名 "Default" / model 名 "Basic" 等 ASCII 文字列のみなので不要）。`sync.Once` で多重登録ガード
- **`openCollectionDSN` で `ensureUnicaseCollation()` を `sql.Open` の直前で呼び出し**：modernc の `RegisterCollationUtf8` は「登録以降に新規オープンされたコネクションにだけ有効」という仕様なので、sql.Open より前で呼ぶのが必須。本修正により real-device collection.anki2 の `SELECT id, name FROM notetypes` / `SELECT id, name FROM decks` / `SELECT name FROM fields WHERE ntid = ?` 等の name 列スキャン全てが成功
- **`notetypes` 系のスキーマ誤認を修正**：v4.3 は実機のスキーマを 5 列だけ（`id, name, mtime_secs, usn, config`）と判定していたが、ankitects/anki `rslib/src/storage/upgrades/schema15_upgrade.sql` を参照した結果、`fields` と `templates` が独立した `NOT ROWID` テーブルとして存在し、flds/tmpls データは `notetypes.config`（Protobuf blob）ではなくそちらに格納されていることが判明。`config` は `Notetype.Config` Protobuf（`css`/`latexPre`/`latexPost`/`kind`/`sort_field_idx`/`reqs` 等）で、ブリッジが読まないフィールドだけが格納されている。よって `notetypes.config` をデコードするロジック自体を廃止し、field names は `SELECT name FROM fields WHERE ntid = ? ORDER BY ord`、template count は `SELECT COUNT(*) FROM templates WHERE ntid = ?` で直接読むように変更。Protobuf デコーダー依存を追加せずにブリッジ成立
- **`ModelFieldNames` / `ModelTemplateCount` を `modernNotetypes` でディスパッチ**：`notetypes` テーブルが検出された時のみ `fieldNamesFromNotetypes` / `templateCountFromNotetypes` を使い、それ以外の legacy / `models` テーブル系は従来通り JSON パスを使う。`modelJSONFromNotetypes` は呼び出しポイントがなくなったので将来の誤用向けにエラー文言だけを残して存続
- **`newNotetypesCollectionFixture` を REAL スキーマで再構築**：`notetypes(id, name COLLATE unicase, mtime_secs, usn, config BLOB)` + `fields(ntid, ord, name COLLATE unicase, config BLOB, PK(ntid, ord)) WITHOUT ROWID` + `templates(ntid, ord, name COLLATE unicase, mtime_secs, usn, config BLOB, PK(ntid, ord)) WITHOUT ROWID` + `decks(id, name COLLATE unicase, mtime_secs, usn, common BLOB, kind BLOB)`。config/common/kind BLOB は Protobuf 風の最小プレースホルダ（`0x0a 0x00` 等）で NOT NULL 制約を満たすのみ
- **テスト追加** (`internal/anki/unicase_test.go`)：`TestUnicaseCollationRegistered`（CREATE TABLE … COLLATE unicase + WHERE name = ? が case-insensitive にマッチ）+ `TestUnicaseOrdering`（ORDER BY name COLLATE unicase が大文字小文字をまたいで安定）+ `TestEnsureUnicaseCollationIdempotent`（sync.Once の多重呼び出し安全性）。`internal/anki/collection_test.go` に `TestModelIDsViaUnicaseNameLookup`（notetypes.name を SELECT するエンドツーエンド）と `TestModelJSONFromNotetypesUnreachable`（誤用防止エラー文言）を追加
- **新規依存なし**：klauspost/compress/zstd は追加せず（config を decode しないため不要）。`golang.org/x/text/collate` も追加せず（単純な case-folded comparator で全 surface が動く）

### v4.3（2026-08-31）
- **Android/media 上の collection.anki2 ロック問題を FUSE roundtrip で解消**: Android FUSE のクロスUID `fcntl(F_SETLK)` が EAGAIN を返すため、`/storage/emulated/0/Android/media/com.ichi2.anki/files/AnkiDroid/collection.anki2` を直接 SQLite で開くと**どんなアクセスでも** `SQLITE_BUSY` になる（実機検証済み 2026-08-31）。`cp src work` → work で SQLite 全操作 → `cp work src` のパターンが実機で成功したため、これを公式経路として実装
- **`internal/anki/fuse_roundtrip.go` 新設**: `FuseRoundtrip`（workDir）× `CopyIn`（FUSE→ext4 作業コピー）/ `CopyOut`（writeback + work 削除。失敗時は work を残してエラー）
- **`OpenCollectionWithWorkDir(path, workDir)` 追加**: 直接オープン → busy/locked エラー時のみ roundtrip フォールバック。`OpenCollection(path)` は `WithWorkDir(path, "")` の薄いラッパに変更（従来挙動不変）。`isBusyLockError` ヘルパーでエラー文字列（"database is locked" / "SQLITE_BUSY"）を判定
- **`Collection.Close()` に writeback を追加**: roundtrip 時は `PRAGMA wal_checkpoint(TRUNCATE)`（best-effort）→ work DB クローズ → `CopyOut` で FUSE 元パスへ書き戻し。DB クローズ失敗時は writeback をスキップし work コピーを復旧用に残す
- **`--anki-work-dir` フラグ追加**: 既定空 = Android では `os.TempDir()/eizouden-anki-work` を自動採用、他プラットフォームでは roundtrip 無効
- **テスト追加** (`internal/anki/fuse_roundtrip_test.go`): CopyIn→work で SQLite 書込→CopyOut→src 検証 + work 削除確認（実 DB ラウンドトリップ）、直接オープン優先、`workDir=""` パススルー（エラー不変・work ディレクトリ無作成）、Windows 限定で EXCLUSIVE ロックによる実フォールバック（SQLITE_BUSY → roundtrip → writeback → src にノート反映）、`isBusyLockError` 文字列マトリクス
- **`cmd/eizouden/main_test.go`**: `resolveAnkiBridge` に workDir 引数を追加（6 呼び出し更新）+ work dir passthrough サブテスト
- **§5 に「FUSE roundtrip（Android/media ロック回避）」節を追加**

### v4.2（2026-08-31）
- **collection.media 候補に Android/media 経路を追加**：プローブ候補リストの先頭に `/storage/emulated/0/Android/media/com.ichi2.anki/files/AnkiDroid/collection.media` を追加（実機で mkdir + write + ls 検証済み）
- **動機**: Android 11+ の scoped storage は `MANAGE_EXTERNAL_STORAGE`（設定 → 特殊アプリアクセス → すべてのファイルアクセス）が付与されない限り Termux から `/storage/emulated/0/AnkiDroid/` への書き込みをブロックする。`/storage/emulated/0/Android/media/com.ichi2.anki/files/...` は AnkiDroid が既定で使う共有メディアの置き場で、AnkiDroid のメディア権限を Termux に付与するだけで直接書き込み可能（`MANAGE_EXTERNAL_STORAGE` 不要）。Android 11+ のクリーンインストールでも追加の手動権限付与なしにブリッジが成立するようにした
- **プローブ順序**: Android/media → legacy (`/storage/emulated/0/AnkiDroid/`) → /sdcard symlink → ユーザー override の順で試行。Android/media が解決した時点で以降の legacy フォールバックは走らない
- **エラー文言**: プローブ全失敗時のエラーを `Ensure AnkiDroid uses the legacy /storage/emulated/0/AnkiDroid/ path` から `Ensure AnkiDroid uses the /storage/emulated/0/Android/media/com.ichi2.anki/files/AnkiDroid path` に更新（実線上でユーザーに提示する推奨パスを Android/media に揃えた）
- **`media_probe_android.go` コメント更新**: なぜ Android/media を優先するか（Android 11+ のスコープドストレージ、MANAGE_EXTERNAL_STORAGE 不要、AnkiDroid Settings → Advanced → AnkiDroid directory で設定可能な点）をピン
- **テスト追加** (`internal/anki/media_probe_android_test.go`、`//go:build android || linux`): Android/media 候補が先頭に来ていることのピン、`probeOneDir` がリテラルパスを返すこと、sibling 算出が正しい場所に着くこと、空候補時のエラーメッセージが collection.media を含むこと
- **§5 / §6 のドキュメント更新**: パス検出テーブル、Android バージョン別 権限マトリクス、セットアップ手順（Android/media 経路 + legacy 経路）、前提条件のすべてを Android/media 優先に書き換え

### v4.1（2026-08-31）
- **v4.0 の regression を修正**：auto-derive をデフォルトに戻した。`--anki-collection` 未指定時の動作を v3.0 と同じ「プローブ成功 ＋ sibling collection.anki2 存在 → ブリッジ ON」に復元
- **動機**: v4.0 で `grkd-edds` メニュー起動（フラグ非経由）経路でブリッジが完全に dead になっていた。cmdline に `eizouden-android-arm64 cli` としか出ず、`resolveAnkiBridge("")` が常に nil を返していた。v3.0 の本来の価値提案（AnkiconnectAndroid を消しても cards が動く）は auto-derive が既定で成立して初めて意味を持つので、v4.1 で既定を戻した
- **`--anki-collection` の役割変更**: v4.0 では opt-in（指定時のみ ON）だったが、v4.1 では **OVERRIDE 専用**（auto-derive で拾えない非標準パスをユーザーが明示する場合のみ使用）
- **明示的 disable なし**。ブリッジを完全に切りたい状況は通常ない（auto-derive が失敗する＝コレクションがそもそも存在しない＝ブリッジ OFF と等価）ので、専用フラグは追加しなかった
- **diag ログを 1 行追加**: probe 失敗時「collection.media probe failed: ...」/ sibling 不在時「no collection.anki2 next to media dir ... — AnkiDroid may be migrated to app-private storage」。それぞれ diag に `[WARN] anki:` プレフィックスで出る
- **`ankiStatusLine` の文言更新**: `disabled (--anki-collection not set)` → `disabled (no AnkiDroid collection detected)`。v4.1 では空フラグ＝無効ではなくなったため
- **テスト追加** (`cmd/eizouden/main_test.go`): auto-derive の 4 経路（probe ok + sibling あり / probe ok + sibling なし / probe 失敗 / 明示 override）と明示 override 時の probe エラー無視 / API key passthrough の 6 subtest
- **コード変更点**: `resolveAnkiBridge` に probe 関数を注入引数として追加（`resolveYtdlp` と同じパターン）。本番プローブは `defaultAnkiProbe`（`anki.NewMediaWriter("")` の薄いラッパ）。テストは t.TempDir() の fake probe を差し込む

### v4.0（2026-08-31）
- **/v1/anki/* の 3 ルートを全廃**（最大の簡素化）。Entei はデフォルトで `http://127.0.0.1:8765` を叩いており、/v1/anki/action を誰もう使っていなかったため、token-gated の複製サーフェスを raw 1 本に集約
- **raw AnkiConnect 互換リスナーを 127.0.0.1:8765 に新設**：post は `POST /` のみ受け付ける（パスは無視・エンベロープの JSON 形状だけでディスパッチ）。レスポンスは **HTTP 200 + `{result, error}`**（ステータス 200 固定・クライアントは `error` フィールドを見る）。CORS は `Access-Control-Allow-Origin: *`
- **フラグ体系を整理**：`--anki-media-dir` 廃止（MediaWriter は auto-detect のみ）、`--anki-api-key` 追加（body key 認証・任意）、`--anki-collection` は唯一の有効フラグに
- **Entei Web ゼロコンフィグ達成**：クライアント側の URL 設定・コードパス切り替え不要
- **EADDRINUSE tolerance**：`127.0.0.1:8765` にすでに別プロセス（公式 AnkiConnect 等）がバインドしていても、`1 行の警告ログ`を出して残りの機能（ペアリング・メディア・YouTube 等）はそのまま提供を続ける。コンパニオンがクラッシュしないことが最優先
- **テストファイル名変更**：`internal/api/anki_api_test.go` → `internal/api/anki_connect_test.go`（raw サーフェスのみをピン）

### v3.0（2026-08-30）
- **AnkiconnectAndroid 依存を完全削除**（最大変更点）
- コンパニオン自身が AnkiConnect 互換のサーバーとして動作
- `collection.anki2` を直接 SQLite で読み書き（`modernc.org/sqlite` v1.57.0 追加）
- スキーマ 11 / 18 の autodetect + 両 reader 実装
- フラグ体系を整理：`--anki-proxy` 削除、`--anki-collection` 追加、`--anki-media-dir` は維持
- ステータスエンドポイント：`proxyConfigured` → `enabled` + `collectionOpen` + `collectionPath` に拡張

### Test evidence (v4.2, 2026-08-31)

実クライアントフローのシミュレーション（`internal/api/anki_e2e_test.go`）。real TCP socket (httptest) 上で `srv.handleRawAnkiConnect` を実走させ、Yomitan / Entei の実際の呼び出し順序と CORS Origin を 1 リクエストごとに検証する。

- Scenario 1 — Yomitan flow: 10 アクションを exact order で（version → deckNames → modelNames → modelFieldNames → canAddNotes → addNote → findNotes → notesInfo → updateNoteFields → addTags）。全リクエストに `Origin: https://entei.gorakudo.org` を付与し、うち 2 リクエストは `Origin: chrome-extension://abc`（Yomitan の拡張 Origin）。全レスポンスで `Access-Control-Allow-Origin: *` を assert。DB write proof：updateNoteFields / addTags 後に notesInfo を再取得してフィールド・タグの変更を観測。`TestE2EYomitanFlow`
- Scenario 2 — Entei mining flow: 単一 addNote で audio + video + picture を抱えた AM-6 のデプロイ形。3 つの決定論的ファイル名（`anki.GenerateFilenameFromProvided`）が `notesInfo` の Front/Back フィールド内 markup（`[sound:...]` / `<img src="...">`）に現れ、かつ collection.media に同一ファイルが存在することを assert。storeMediaFile ラウンドトリップ：`pre.webm` を送って hash ベース名（≠ "pre.webm"）が返り、ファイルが存在し、`[sound:<storedName>]` を埋め込んだ addNote の notesInfo が storedName をエコー。`TestE2EEnteiMiningFlow`
- Scenario 3 — failure surfaces: unknown action → `{result:null, error:non-empty}`、`allowDuplicate:false` 同 first field 2 回目 → `{result:null, error:null}`、GET → 200 + AnkiConnect envelope（panic なし）、`Host: evil.example.com` → 403。`TestE2EFailureSurfaces`
- Scenario 4 — real listener round-trip: ephemeral port を pre-bind → `s.rawAnkiAcceptedHosts` に addr 登録 → `StartRawAnkiConnectListener(addr)` → real `http.Client` で version + addNote を実線に送信して両方成功 → `coll.NotesInfo` で DB write proof。`TestE2EStartRawAnkiConnectListenerRoundTrip`

実行: `go test ./internal/api/ -run 'TestE2E' -v -count=1` → 4 PASS。`go test ./internal/api/... ./internal/anki/... ./cmd/eizouden/... -count=1` → 全 PASS。

### v2.0（2026-08-29）
- Termux ダイレクト collection.media 書き込み + AnkiconnectAndroid :8080 プロキシ 2 層構成
- `eizouden-android-arm64` 配布物に `anki` サブコマンド内蔵
- メディアは Termux 単独、ノートは AnkiconnectAndroid APK に委任
- → v3.0 で AnkiconnectAndroid 部分のみ廃止

### v1.0（初期構想）
- (取り下げ) AnkiDroid 公式の AnkiConnect 対応待ち