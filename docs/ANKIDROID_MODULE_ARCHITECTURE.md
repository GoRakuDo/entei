# ANKIDROID_MODULE_ARCHITECTURE — AnkiDroid ネイティブ連携モジュール設計書

> **状態:** 設計確定（Android専用ネイティブ統合）  
> **対象:** Android版 Entei における AnkiDroid 直接連携、`tauri-plugin-ankidroid`（Kotlin / JNI）、ContentProvider 通信、メディア登録、IPCインターフェース  
> **方針:** 外部APK（AnkiconnectAndroid等）やTermux、アプリ内HTTPサーバー（ポート8765）を完全に排除。Tauri v2 Androidのネイティブプラグイン機構を活用し、AnkiDroid公式の ContentProvider API（`FlashCardsContract` / `AddContentApi`）をプロセス間IPCで直接叩くことで、ゼロ構成・低レイテンシ・省電力な採掘体験を実現する。

---

## 1. 概要と設計思想

### 1.1 従来の課題と限界
従来の Android 環境における Anki 連携（AnkiconnectAndroid 等）には以下の構造的な摩擦が存在していた：
1. **外部アプリの依存**: ユーザーが AnkiDroid とは別に非公式の野良 APK（`AnkiconnectAndroid.apk`）を手動インストールし、バックグラウンドサービスを常駐させる必要があった。
2. **HTTP サーバーのオーバーヘッド**: スマホ内部で HTTP サーバー（NanoHTTPD:8765）を稼働させるため、バッテリー消費の増大や OS の Doze モードによる不意のプロセス停止、ポート競合リスクが常に付きまとっていた。
3. **ファイルアクセスの壁**: Android 11（Scoped Storage）以降、別プロセスのアプリが AnkiDroid の内部データディレクトリに直接アクセスすることは OS 仕様上不可能であった。

### 1.2 本モジュールの解決策
Entei アプリ内部に **Android 専用ネイティブプラグイン（`tauri-plugin-ankidroid`）** を内包する：
- **プロセス間直接通信**: AnkiDroid 公式の `AddContentApi` ライブラリ（`com.github.ankidroid:Anki-Android`）を Gradle 依存として組み込み、Android 標準の `ContentResolver` / `ContentProvider` 経由で AnkiDroid と直接通信する。
- **外部APK・ポート8765の全廃**: HTTP サーバーを一切介さないため、ネットワーク権限・CORS・ポート競合が原理的にゼロになる。
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
    tauri-bridge.ts (統一インターフェース)
              │
              ├─ [PC デスクトップ (Windows / Mac / Linux)]
              │     └─ Local HTTP (127.0.0.1:8765) ──► 公式 AnkiConnect
              │
              └─ [モバイル (Android)]
                    └─ Tauri IPC (JNI 呼び出し)
                          │
                          ▼
            [ tauri-plugin-ankidroid (Rust ↔ Kotlin) ]
              ├─ DeckManager (デッキ一覧・ID解決)
              ├─ ModelManager (ノートタイプ・フィールド定義)
              ├─ NoteManager (カード追加・更新・重複チェック)
              └─ MediaManager (FileProvider メディア書き出し)
                          │
                          ▼ (Android ContentProvider IPC)
            [ AnkiDroid アプリ本体 (com.ichi2.anki) ]
              └─ FlashCardsContract (内部 SQLite へ即時反映)
```

---

## 3. コアコンポーネント設計（Kotlin / Java）

`A:\AnkiconnectAndroid` の実績ある実装をベースに、Tauri v2 プラグインアーキテクチャ（`io.tauri.plugin.Plugin`）へ純化・移植する。

### 3.1 依存関係 (`build.gradle.kts`)
```kotlin
dependencies {
    implementation("com.github.ankidroid:Anki-Android:2.17alpha14")
    implementation("androidx.core:core-ktx:1.12.0")
    implementation("com.google.code.gson:gson:2.10.1")
}
```

### 3.2 モジュール構造
```text
plugins/tauri-plugin-ankidroid/
├── Cargo.toml
├── src/
│   ├── lib.rs              # Tauri コマンド定義・ディスパッチ
│   └── models.rs           # リクエスト/レスポンス型定義
└── android/
    ├── build.gradle.kts
    └── src/main/java/org/gorakudo/entei/ankidroid/
        ├── AnkiDroidPlugin.kt     # Tauri プラグインエントリーポイント
        ├── DeckApi.kt             # デッキ操作
        ├── ModelApi.kt            # ノートタイプ・フィールド操作
        ├── NoteApi.kt             # カード追加・更新・重複判定
        └── MediaApi.kt            # FileProvider メディア連携
```

---

## 4. API 実装詳細

### 4.1 デッキ管理 (`DeckApi`)
`AddContentApi.getDeckList()` を用いてデッキ一覧を抽出する。
- **`deckNames()`**: 登録されている全デッキ名（`String[]`）を返却。
- **`getDeckId(name: String)`**: デッキ名から対応する AnkiDroid の内部 `deck_id`（`Long`）を逆引き。存在しない場合は新規デッキとして作成またはエラーハンドリング。

### 4.2 ノートタイプ管理 (`ModelApi`)
`AddContentApi.getModelList()` および `getFieldList(modelId)` を使用。
- **`modelNames()`**: 登録されている全ノートタイプ名（`String[]`）を返却。
- **`modelFieldNames(modelName: String)`**: ノートタイプ名から内部 `model_id` を解決し、定義されているフィールド一覧（`String[]`、例: `word`, `reading`, `sentence`, `picture`, `sentenceAudio` 等）を正確な順序で返却。

### 4.3 ノート追加・重複チェック (`NoteApi`)
`AddContentApi.addNote()` および `FlashCardsContract.Note` を使用。
- **`canAddNotes(notes: List<NoteData>)`**:
  - 重複チェックを実行。
  - 重要: Android 環境における NPE（NullPointerException）を防止するため、`checkAllModels: false` かつ対象モデルを明確にしてクエリする。
- **`addNote(note: NoteData)`**:
  - `modelId` と `deckId` を解決。
  - フィールドのマップ（`Map<String, String>`）をモデルのフィールド順序に従った配列（`String[]`）へ並び替え。
  - `AddContentApi.addNote(modelId, deckId, fields, tags)` を呼び出し、生成された `noteId`（`Long`）を即座に返却。
- **`updateNoteFields(noteId: Long, fields: Map<String, String>)`**:
  - 対象カードの現在の `modelId` を特定。
  - 送信されたフィールド値のみを更新配列へマージし、`AddContentApi.updateNoteFields(noteId, fields)` を実行。

### 4.4 メディアファイル連携 (`MediaApi`)
Android 11 以降の Scoped Storage 制約を完全に回避するための最重要コンポーネント。
```text
[ Entei アプリキャッシュ (cacheDir) ]
  └─ 一時ファイル生成: audio_xxxx.mp3 / pic_xxxx.jpg
            │
            ▼
[ FileProvider (androidx.core.content.FileProvider) ]
  └─ 安全な content:// URI を発行
            │
            ▼
[ grantUriPermission("com.ichi2.anki", uri, FLAG_GRANT_READ_URI_PERMISSION) ]
  └─ AnkiDroid プロセスに一時読み取り権限を供与
            │
            ▼
[ ContentResolver.insert(FlashCardsContract.AnkiMedia.CONTENT_URI, values) ]
  └─ AnkiDroid がメディアを自身の collection.media へ取り込み
            │
            ▼
[ AnkiDroid から戻り値 URI (例: content://.../audio_xxxx_1.mp3) を受領 ]
  └─ 実際に AnkiDroid 内で確定したファイル名をフロントエンドへ返却
```

- **メディア名のサフィックス問題対策**:
  AnkiDroid はメディア重複時に `filename_1.ext` のように末尾へ数値を付加する場合がある。
  Entei のフロントエンドは、送信時のリクエスト名ではなく `MediaApi` が返却した**確定ファイル名**を使って HTML マークアップ（`[sound:filename_1.mp3]` 等）を構築する（既存の Web 版 AnkiDroid handling 契約と完全一致）。

---

## 5. フロントエンドとの IPC 契約 (`tauri-bridge.ts`)

フロントエンドは実行時環境を `isAndroid()` で自動判別し、同一のシグネチャで呼び出す。

```typescript
// tauri-bridge.ts の透過的ルーティング
export async function ankiAddNoteDirect(params: {
  note: AnkiNoteData;
}): Promise<number> {
  if (isAndroid()) {
    // Android ネイティブプラグインを直通呼び出し (ContentProvider)
    return await invoke<number>('plugin:ankidroid|add_note', { params });
  } else {
    // デスクトップはローカル HTTP AnkiConnect (ポート 8765)
    return await ankiClient.addNote(params.note);
  }
}
```

---

## 6. 権限（Permission）とライフサイクル設計

### 6.1 必要なパーミッション (`AndroidManifest.xml`)
```xml
<uses-permission android:name="com.ichi2.anki.permission.READ_WRITE_DATABASE" />
```

### 6.2 オンボーディング画面との境界
ユーザーからの指示に基づき、権限要求ロジックは採掘実行時ではなく、**後日新設される専用の「アプリオンボーディング画面（初回セットアップウィザード）」** に集約する：
- **初期状態**: `hasAnkiDroidPermission()` を呼び出してパーミッションの有無のみを確認。
- **オンボーディング時**:
  1. 「AnkiDroid 連携の有効化」ステップでユーザーに説明を表示。
  2. ボタン押下時に OS の標準パーミッションダイアログ（`ActivityCompat.requestPermissions`）を呼び出し。
  3. 許可されたら即座にデッキ一覧・モデル一覧を初期キャッシュ。
- **未許可時のフェイルソフト**:
  権限がない状態で採掘や設定を開いた場合は、エラーでクラッシュさせず「AnkiDroid のアクセス権限が必要です。設定から許可してください」と親切なトーストまたは案内バナーを表示する。

---

## 7. 実装ロードマップ

- **フェーズ 1: プラグインの骨組みと Gradle 統合**
  - `tauri-plugin-ankidroid` クレート新設
  - Android 側 `build.gradle.kts` に `Anki-Android` API を導入
  - `FlashCardsContract` パーミッションの宣言
- **フェーズ 2: コア API の Kotlin 移植**
  - `DeckApi`, `ModelApi`, `NoteApi` の実装
  - `FileProvider` を用いた `MediaApi`（画像・音声）の実装
- **フェーズ 3: フロントエンド IPC 直結**
  - `tauri-bridge.ts` に Android 用フォールバックを透過的に配線
  - `/settings/?group=anki` でのデッキ・モデル動的取得の確認
- **フェーズ 4: アプリオンボーディング画面の実装（後日別タスク）**
  - 初回起動時・設定画面からの AnkiDroid 権限付与フローの UI 構築
