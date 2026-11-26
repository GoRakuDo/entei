# ANKIDROID_MODULE_ARCHITECTURE — AnkiDroid ネイティブ連携モジュール設計書

> **状態:** 設計確定（Android専用ネイティブ統合 / 完全承認版）  
> **対象:** Android版 Entei における AnkiDroid 直接連携、既存 `plugins/tauri-plugin-anki` の Android バックエンド統合（Kotlin / Tauri v2 Mobile Plugin）、ContentProvider 通信、メディア登録、IPCインターフェース  
> **方針:** 外部APK（AnkiconnectAndroid等）やTermux、アプリ内HTTPサーバー（ポート8765）を完全に排除。Tauri v2 Androidのネイティブプラグイン機構を活用し、AnkiDroid公式の ContentProvider API（`FlashCardsContract` / `AddContentApi`）をプロセス間IPCで直接叩くことで、ゼロ構成・低レイテンシ・省電力な採掘体験を実現する。

---

## 1. 概要と設計思想

### 1.1 従来の課題と限界
従来の Android 環境における Anki 連携（AnkiconnectAndroid 等）には以下の構造的な摩擦が存在していた：
1. **外部アプリの依存**: ユーザーが AnkiDroid とは別に非公式の野良 APK（`AnkiconnectAndroid.apk`）を手動インストールし、バックグラウンドサービスを常駐させる必要があった。
2. **HTTP サーバーのオーバーヘッド**: スマホ内部で HTTP サーバー（NanoHTTPD:8765）を稼働させるため、バッテリー消費の増大や OS の Doze モードによる不意のプロセス停止、ポート競合リスクが常に付きまとっていた。
3. **ファイルアクセスの壁**: Android 11（Scoped Storage）以降、別プロセスのアプリが AnkiDroid の内部データディレクトリに直接アクセスすることは OS 仕様上不可能であった。

### 1.2 本モジュールの解決策
Entei の既存プラグイン `plugins/tauri-plugin-anki` 内に **Android 専用バックエンド（Kotlin / Tauri v2 Mobile）** を組み込む：
- **既存 IPC の完全維持（フロントエンド変更ゼロ）**: 新規プラグインを乱立させず、既存の `plugin:anki|anki_request` および `plugin:anki|anki_check_connection` の内部ルーティングを Rust 側で `#[cfg(target_os = "android")]` で分岐。デスクトップならローカル HTTP（ポート 8765 / `client.rs`）、Android なら Kotlin モバイルプラグイン（`mobile.rs` 経由）へ透過的にディスパッチするため、Web フロントエンド（`AnkiConnectClient` / `AnkiExportClient`）は一切の改修を必要としない。
- **プロセス間直接通信**: AnkiDroid 公式の `AddContentApi`（`com.github.ankidroid:Anki-Android`）をプラグイン内部の Gradle 依存として組み込み、Android 標準の `ContentResolver` / `ContentProvider` 経由で AnkiDroid と直接通信する。
- **FileProvider による安全なメディア受け渡し**: 録音音声や動画スクショは、Entei のアプリ内キャッシュから Android 標準の `FileProvider`（`content://` URI）を発行し、`grantUriPermission` で AnkiDroid に一時読み取り権限を付与して引き渡す。

---

## 2. システム全体図

```text
[ フロントエンド (React / TypeScript) ]
  ├─ PlayerApp (動画・音声採掘)
  ├─ Yomitan モジュール (辞書ポップアップ採掘)
  └─ Anki 設定画面 (/settings/?group=anki)
              │
              ▼
    tauri-bridge.ts ──► invoke('plugin:anki|anki_request', { action, params })
                     ──► invoke('plugin:anki|anki_check_connection', {})
              │
              ▼
    [ plugins/tauri-plugin-anki (Rust) ]
              │
              ├─ #[cfg(not(target_os = "android"))]
              │     └─ client.rs (HTTP 127.0.0.1:8765) ──► デスクトップ公式 AnkiConnect
              │
              └─ #[cfg(target_os = "android")]
                    └─ mobile.rs ──► run_mobile_plugin_async("anki_request", payload)
                          │
                          ▼
            [ Kotlin ネイティブエンジン (@TauriPlugin class AnkiPlugin) ]
              ├─ DeckApi (デッキ一覧・ID解決)
              ├─ ModelApi (ノートタイプ・フィールド定義・MID解決)
              ├─ NoteApi (カード追加・差分マージ更新・重複判定)
              └─ MediaApi (FileProvider メディア受け渡し)
                          │
                          ▼ (Android ContentProvider IPC)
            [ AnkiDroid アプリ本体 (com.ichi2.anki) ]
              └─ FlashCardsContract (内部 SQLite へ即時反映)
```

---

## 3. コアコンポーネント設計（Kotlin / Tauri v2 Mobile）

### 3.1 Gradle 依存関係 (`plugins/tauri-plugin-anki/android/build.gradle.kts`)
AGP 8+ 仕様に従い、`namespace` は `build.gradle.kts` で宣言し、Tauri モバイルプラグイン必須の依存を揃える：

```kotlin
plugins {
    id("com.android.library")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "org.gorakudo.entei.anki"
    compileSdk = 36

    defaultConfig {
        minSdk = 26
    }
}

repositories {
    google()
    mavenCentral()
    maven { url = uri("https://jitpack.io") }
}

dependencies {
    implementation(project(":tauri-android"))
    implementation("androidx.appcompat:appcompat:1.6.0")
    implementation("com.google.android.material:material:1.7.0")
    implementation("androidx.core:core-ktx:1.12.0")
    implementation("com.google.code.gson:gson:2.10.1")
    // AnkiDroid API (公式 JitPack リポジトリ)
    implementation("com.github.ankidroid:Anki-Android:2.17alpha14")
}
```

### 3.2 パッケージ構造とクラス責務
Tauri v2 公式のモバイルプラグイン規約（`app.tauri.plugin.*`、`app.tauri.annotation.*`）に完全準拠する：
```text
plugins/tauri-plugin-anki/
├── Cargo.toml
├── build.rs
├── src/
│   ├── lib.rs              # プラグイン登録・.setup() でのモバイル登録
│   ├── client.rs           # 既存 デスクトップ HTTP 127.0.0.1:8765 実装
│   └── mobile.rs           # Tauri v2 run_mobile_plugin_async ブリッジ (target_os = "android")
└── android/
    ├── build.gradle.kts
    └── src/main/
        ├── AndroidManifest.xml # package queries / FileProvider 定義 (package属性なし)
        ├── res/xml/
        │   └── anki_file_provider_paths.xml
        └── java/org/gorakudo/entei/anki/
            ├── AnkiPlugin.kt       # @TauriPlugin class AnkiPlugin(activity: Activity) : Plugin(activity)
            ├── DeckApi.kt          # デッキ操作
            ├── ModelApi.kt         # ノートタイプ・フィールド・MID 逆引き
            ├── NoteApi.kt          # カード追加・差分マージ更新・重複判定
            └── MediaApi.kt         # FileProvider メディア連携
```

### 3.3 Tauri v2 モバイルハンドシェイク (`mobile.rs` & `lib.rs`)
Rust 側と Kotlin 側のプラグイン結合は Tauri v2 公式の `register_android_plugin` を使用する：

```rust
// plugins/tauri-plugin-anki/src/mobile.rs
#[cfg(target_os = "android")]
pub const PLUGIN_IDENTIFIER: &str = "org.gorakudo.entei.anki";

#[cfg(target_os = "android")]
pub fn init<R: tauri::Runtime, C: serde::de::DeserializeOwned>(
    _app: &tauri::AppHandle<R>,
    api: tauri::plugin::PluginApi<R, C>,
) -> tauri::Result<tauri::plugin::PluginHandle<R>> {
    api.register_android_plugin(PLUGIN_IDENTIFIER, "AnkiPlugin")
}
```

`lib.rs` のプラグインビルダーで `.setup` を接続し、プラグインハンドルを `app.manage` で管理：
```rust
// plugins/tauri-plugin-anki/src/lib.rs
pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("anki")
        .setup(|app, api| {
            #[cfg(target_os = "android")]
            {
                let handle = mobile::init(app, api)?;
                app.manage(handle);
            }
            Ok(())
        })
        // ...
}
```

Kotlin 側クラスは公式アノテーション `@TauriPlugin` を付与し、`activity` を受け取る：
```kotlin
// plugins/tauri-plugin-anki/android/.../AnkiPlugin.kt
@TauriPlugin
class AnkiPlugin(private val activity: Activity) : Plugin(activity) {
    private val context: Context get() = activity.applicationContext
    // @Command fun anki_request(invoke: Invoke) { ... }
    // @Command fun anki_check_connection(invoke: Invoke) { ... }
}
```

---

## 4. API 実装詳細と厳格な契約仕様

### 4.1 デッキ管理 (`DeckApi`)
`AddContentApi.deckList` プロパティを用いてデッキ一覧を抽出する（nullable な `Map<Long, String>?` を安全に受ける）。
- **`deckNames()`**: `api.deckList?.values?.toTypedArray() ?: emptyArray()`
- **`deckNamesAndIds()`**: `api.deckList?.entries?.associate { it.value to it.key } ?: emptyMap()`
- **`getDeckId(name: String)`**: `deckNamesAndIds()[name] ?: throw Exception("Deck not found: $name")`

### 4.2 ノートタイプ管理 (`ModelApi`)
`AddContentApi.getModelList(minNumFields: Int)` および `getFieldList(modelId: Long)` を使用。
- **`modelNames()`**: `api.getModelList(0)?.values?.toTypedArray() ?: emptyArray()`（引数 `0` で全件取得）。
- **`modelNamesAndIds()`**: `api.getModelList(0)?.entries?.associate { it.value to it.key } ?: emptyMap()`
- **`modelFieldNames(modelName: String)`**: ノートタイプ名から内部 `modelId` を解決し、定義されているフィールド一覧（`String[]`）を正確な順序で返却。
- **`getNoteModelId(noteId: Long)`**:
  - `AddContentApi.getNote()` の PROJECTION は `MID` を含まないため、以下の独立クエリで解決する：
  ```kotlin
  val noteUri = Uri.withAppendedPath(FlashCardsContract.Note.CONTENT_URI, noteId.toString())
  val cursor = context.contentResolver.query(noteUri, arrayOf(FlashCardsContract.Note.MID), null, null, null)
  cursor?.use {
      if (it.moveToNext()) return it.getLong(it.getColumnIndexOrThrow(FlashCardsContract.Note.MID))
  }
  return null
  ```

### 4.3 ノート追加・重複チェック (`NoteApi`)

#### ① 重複判定 (`canAddNotes`)
- モデルの第1フィールド名（`api.getFieldList(modelId)?.getOrNull(0) ?: throw Exception("Fields not found for model $modelId")`）を取得。
- 送信されたデータの第1フィールド値（素テキスト）を取り出す。
- `api.findDuplicateNotes(modelId, firstFieldText)` を呼び出し、該当ノートが存在するか確認する（※AnkiDroid 内部でクエリが安全に構築される）。
- `allowDuplicate: true` の場合は、第1フィールドが非空であれば無条件に `true`（追加可能）を返す。

#### ② 新規カード追加 (`addNote`)
- `modelId` と `deckId` を解決。
- フィールドのマップ（`Map<String, String>`）をモデルのフィールド定義配列（`api.getFieldList(modelId)`）の順序に従った配列（`String[]`）へ並び替え（未指定フィールドは `""`）。
- `tags` は `List<String>` から `Set<String>` へ変換。
- `api.addNote(modelId, deckId, fields, tags.toSet())` を呼び出し、生成された `noteId`（`Long`）を返却。

#### ③ 既存カードの差分マージ更新 (`updateNoteFields`) 🚨 【重要・データ消失防止】
AnkiDroid の `api.updateNoteFields(noteId, fields: Array<String>)` はカードの全フィールドを**完全置換**するため、必ず以下の「読み取り → 差分マージ → 全置換」を実行する：
```kotlin
fun updateNoteFields(noteId: Long, incomingFields: Map<String, String>): Boolean {
    val modelId = getNoteModelId(noteId) ?: throw Exception("Model not found for note $noteId")
    val allFieldNames = api.getFieldList(modelId) ?: throw Exception("Fields not found for model $modelId")
    
    // 1. 既存の全フィールド値を読み取る
    val existingNote = api.getNote(noteId) ?: throw Exception("Note not found: $noteId")
    val existingFields = existingNote.fields
    
    // 2. モデル定義順の全フィールド配列を構築
    val mergedFields = Array(allFieldNames.size) { i ->
        val fieldName = allFieldNames[i]
        if (incomingFields.containsKey(fieldName)) {
            incomingFields[fieldName] ?: ""
        } else if (i < existingFields.size) {
            existingFields[i]
        } else {
            ""
        }
    }
    
    // 3. 安全にマージされた完全長配列で更新
    return api.updateNoteFields(noteId, mergedFields)
}
```

### 4.4 メディアファイル連携 (`MediaApi`) 🚨 【重要・Scoped Storage 適合】

Android 11 以降の Scoped Storage 制約下で、Entei のアプリ内一時ファイル（録音音声や動画スクショ）を AnkiDroid へ確実に引き渡す：

1. **一時ファイル書き出し**:
   - `params.data` の base64 文字列をバイナリへデコード。
   - `File(context.cacheDir, "anki_media")` 配下に専用ファイル（例: `entei_audio_xxxxxxxxxx.mp3`）を作成し書き込み（0 バイト時は即座にエラー）。
2. **FileProvider URI の発行と権限供与**:
   - `FileProvider.getUriForFile(context, "${context.packageName}.anki.fileprovider", file)` で `content://` URI を発行。
   - `context.grantUriPermission("com.ichi2.anki", fileUri, Intent.FLAG_GRANT_READ_URI_PERMISSION)` を実行。
3. **ContentValues の構築（FILE_URI 必須 ＆ PREFERRED_NAME 拡張子除去）**:
   - `FlashCardsContract.AnkiMedia.FILE_URI` に `fileUri.toString()` を設定（必須）。
   - `preferredName` はファイル名から拡張子を除去し、空白をアンダースコアに置換（先頭ドット等で空文字になった場合はフォールバック `"entei_media"`）。
   - `FlashCardsContract.AnkiMedia.PREFERRED_NAME` に格納。
   - ※ AnkiDroid 側は `ContentResolver.getType(fileUri)` から MIME を引き、`MimeTypeMap` 経由で実拡張子（`.mp3`, `.jpg`, `.webm`）を付与する。
4. **ContentResolver への登録と確定ファイル名の取得**:
   - `contentResolver.insert(FlashCardsContract.AnkiMedia.CONTENT_URI, contentValues)` を実行。
   - `insert` が null を返した場合は `AnkiExportError`（`server-error`）を送出。
   - 戻り値 URI（`file://.../<確定ファイル名>`）から `File(insertedUri.path).name` で確定ファイル名を取得。
   - 返却名は **パスなし・マークアップなし・`[A-Za-z0-9._-]` のみ** の文字列としてフロントエンドへ返却。
   - `finally` ブロックで直ちに `file.delete()` および `context.revokeUriPermission("com.ichi2.anki", fileUri, Intent.FLAG_GRANT_READ_URI_PERMISSION)` を実行。
5. **フロントエンドでのマークアップ組み立て**:
   - プラグイン側では HTML マークアップを組まず、生ファイル名のみを返す。
   - フロントエンド（`anki-export-client.ts` の `buildMediaMarkup`）が AnkiDroid 返却確定ファイル名を使って `[sound:確定ファイル名.mp3]` や `<img src="確定ファイル名.jpg">` を組み立てる。

---

## 5. AnkiConnect アクション互換性マッピング表

Entei が利用する AnkiConnect アクションと、本 Android ネイティブプラグインでの実装対応表：

| AnkiConnect アクション | 呼び出し元 | Android ネイティブでの実装方針 | 返却型 / 契約 |
|---|---|---|---|
| `version` | 接続確認・疎通 | 常に `6` を返却（`api.apiHostSpecVersion >= 2` を確認） | `6` (数値) |
| `requestPermission` | 接続確認 Step 2 | Android では ContentProvider 経由のため常に成功扱い | `{ "permission": "granted" }` |
| `deckNames` | 設定・Field Profiles | `DeckApi.deckNames()` | `string[]` |
| `deckNamesAndIds` | 設定・Field Profiles | `DeckApi.deckNamesAndIds()` | `{ [deck: string]: number }` |
| `modelNames` | 設定・Field Profiles | `ModelApi.modelNames()` | `string[]` |
| `modelNamesAndIds` | 設定・Field Profiles | `ModelApi.modelNamesAndIds()` | `{ [model: string]: number }` |
| `modelFieldNames` | 設定・Field Profiles | `ModelApi.modelFieldNames()` | `string[]` |
| `canAddNotes` | 新規カード作成前 | `NoteApi.canAddNotes()`（`allowDuplicate: true` 時は第1フィールド非空判定） | `boolean[]` |
| `addNote` | 新規カード作成 | `NoteApi.addNote()` | `number` (noteId) |
| `updateNoteFields` | 最新カード更新 | `NoteApi.updateNoteFields()`（差分マージ全置換） | `{ "noteId": number }` |
| `addTags` | カード更新・追記後 | `api.updateNoteTags()` + `api.getNote().tags` の Union 合成 | `null` |
| `storeMediaFile` | 画像・音声保存 | `MediaApi.storeMediaFile()`（FileProvider + 確定ファイル名返却） | `string` (確定ファイル名) |
| `findNotes` | 最新カード・重複・追記 | `FlashCardsContract.Note.CONTENT_URI` へのクエリ（クエリ文字列をそのまま selection に渡し、0件・null時は `[]` を返却） | `number[]` |
| `notesInfo` | カード情報取得 | `FlashCardsContract.Note` のクエリ（MID から `api.getFieldList(mid)` で `{ [field]: { value, order } }` を構成） | `AnkiNoteInfo[]` |
| `cardsInfo` | 追記時のデッキ名解決 | `FlashCardsContract.Card` から `Card.DECK_ID` を引き `deckList` からデッキ名を解決 | `AnkiCardInfo[]` |
| `findCards` | 新規カード休止用 | `Note.CONTENT_URI` からカード ID を解決 | `number[]` |
| `suspend` | 新規カード休止 | `AddContentApi` に suspend（queue書込み）API は存在しないため、未対応をログし fail-soft 復帰 | `boolean` (常に true 扱い) |
| `apiReflect` | AnkiDroid 自動判定 | 🚨 **`{ scopes: ["actions"] }` のみを返し `actions` 配列は返さない**（フロントエンドが `Array.isArray(actions) === false` を見て確実に `ankiDroidMode = true` と判定させるため） | `{ "scopes": ["actions"] }` |

---

## 6. AndroidManifest.xml とセキュリティ設定

プラグイン配下（`plugins/tauri-plugin-anki/android/src/main/AndroidManifest.xml`）に以下を宣言する（※`package` 属性は指定せず `build.gradle.kts` の `namespace` で管理する）：

```xml
<manifest xmlns:android="http://schemas.android.com/apk/res/android">

    <!-- 1. AnkiDroid データベースへの読み書き権限 -->
    <uses-permission android:name="com.ichi2.anki.permission.READ_WRITE_DATABASE" />

    <!-- 2. Android 11+ パッケージ可視性 (これがないと resolveContentProvider が null になり未インストール扱いになる) -->
    <queries>
        <package android:name="com.ichi2.anki" />
    </queries>

    <application>
        <!-- 3. メディア受け渡し用 FileProvider -->
        <provider
            android:name="androidx.core.content.FileProvider"
            android:authorities="${applicationId}.anki.fileprovider"
            android:exported="false"
            android:grantUriPermissions="true">
            <meta-data
                android:name="android.support.FILE_PROVIDER_PATHS"
                android:resource="@xml/anki_file_provider_paths" />
        </provider>
    </application>
</manifest>
```

### `res/xml/anki_file_provider_paths.xml`
```xml
<?xml version="1.0" encoding="utf-8"?>
<paths>
    <!-- アプリのキャッシュ内 anki_media サブディレクトリのみ提供を許可 -->
    <cache-path name="anki_media_cache" path="anki_media/" />
</paths>
```

---

## 7. フェイルソフトと接続チェック設計

1. **`anki_check_connection` コマンドの Android 実装**:
   - デスクトップの `AnkiClient::check_connection_once`（HTTP:8765）は Android では使えないため、`#[cfg(target_os = "android")]` で Kotlin プラグインの `anki_check_connection` コマンドへディスパッチする。
   - Kotlin 側で `api.apiHostSpecVersion >= 2`、パーミッション有無、`api.deckList`、`api.getModelList(0)` の取得を順次検証し、`AnkiConnectionState { connected: Boolean, error: Option<String> }` を返却する。
2. **AnkiDroid 未インストール / 旧バージョンの検知**:
   - `api.apiHostSpecVersion` をチェック。
   - `-1`（未インストール）または `1`（古いバージョン）の場合は、`AnkiExportError`（`kind: 'network'`）として「AnkiDroid がインストールされているか確認してください（ContentProvider Spec 2 以上が必要です）」と親切にトースト通知する。
3. **権限（Permission）未許可時のフェイルソフト**:
   - `AddContentApi.READ_WRITE_PERMISSION` が未付与の場合は、アプリをクラッシュさせず「AnkiDroid へのアクセス権限がありません。設定から許可してください」とトーストで案内する。
   - ※実際の権限要求ダイアログは、後日新設する専用の「アプリオンボーディング画面」で実行する。

---

## 8. 段階的な実装ロードマップ

- **フェーズ 1: プラグインの骨組みと Gradle / Mobile 統合**
  - `plugins/tauri-plugin-anki` に Android ソースセット（Kotlin）を新設
  - `build.gradle.kts` に `Anki-Android` API、`queries`、`FileProvider` を配備
  - `mobile.rs` で `register_android_plugin` と `run_mobile_plugin_async` を実装
  - `anki_check_connection` および `version` の接続疎通確認を開通
- **フェーズ 2: コア API の Kotlin 実装**
  - `DeckApi`, `ModelApi`, `NoteApi`（差分マージ `updateNoteFields`、`findDuplicateNotes`）
  - `MediaApi`（FileProvider + `FILE_URI` + 拡張子除去 + 確定ファイル名返却）
  - `addTags`（Union 更新）と `apiReflect`（`actions` 非配列返却）
- **フェーズ 3: エクスポートフローの結合確認**
  - `PlayerApp.tsx` からの動画スクショ・セリフ音声の AnkiDroid 登録検証
  - Yomitan モジュールからのカード追加検証
- **フェーズ 4: アプリオンボーディング画面の実装（後日別タスク）**
  - 初回起動時の AnkiDroid 権限要求フロー UI の構築
