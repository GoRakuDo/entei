# Jimaku Subs — 日本語字幕の自動ロード・検索（jimaku.cc API 統合）

> 再生中のメディア（アニメ・ドラマ）の日本語字幕を、**jimaku.cc の API** から自動ロード／検索してロードする機能の設計ドキュメント。
>
> 状態: **設計確定（2026-08-15）・未実装**（実装は明日以降）。ユーザー確定事項の一次ソース。

## 1. 目的

ユーザーがアニメ・ドラマの動画を再生するとき、**字幕を手動で探してダウンロードする手間をなくす**。jimaku.cc（コミュニティ字幕ライブラリ）の API を Entei のウェブから直接呼び、再生中メディアに合う日本語字幕を自動で取得・表示する。

- **Entei のウェブから出ずに完結**する（別サイト・別ツール・拡張機能は不要）。
- アニメ（AniList ベース）と **ドラマ（TMDB ベース）の両方**に対応する。
- 字幕データは取得して表示するだけ（アップロードしない・外部に送信しない）。

## 2. 確定スペック（ユーザー確定・2026-08-15）

1. **2 ボタン**を用意する（プレイヤー枠内・サイドパネル近辺）:
   - **自動ロード**: 現在のメディアの**ファイル名**をパース → タイトル+エピソードを自動マッチ → 最上位候補の字幕を取得・表示。失敗時は検索 UI へフォールバック。
   - **検索してからロード**: タイトル検索モーダル（アニメ／ドラマの切替あり）→ 候補一覧 → エピソード選択 → 字幕ファイル一覧 → 選択してロード。
2. **jimaku.cc の API キー**はユーザーが設定モーダルで入力し、**ローカルストレージに保存**する（ユーザー確定・2026-08-16）。jimaku からは字幕の取得（読み取り）のみで、アップロード等の書き込みは行わない。
3. **CORS 対応済み**（実測: `access-control-allow-origin: *`・API エンドポイントは origin エコー）。ブラウザから直接 fetch 可能。
4. 字幕取得後は既存の字幕パイプライン（`subtitle-reader.ts`）に流し、表示・同期機能（sub-to-audio 等）とも併用可能。

## 3. jimaku.cc API 概要（実測・2026-08-15）

### 3.1 認証

- すべての API エンドポイントで **`Authorization` ヘッダー**に API キーを指定。
- アカウントは https://jimaku.cc/account で API キーを生成。
- **字幕ファイルのダウンロード URL は認証不要**（public・`access-control-allow-origin: *` 実測）。

### 3.2 レート制限

- **IP 単位**で制限（25 req / 約1秒の窓・`x-ratelimit-*` ヘッダーで通知）。
- 429 が返ったら `x-ratelimit-reset-after` 秒待って再試行（クライアント側でバックオフ実装必須）。

### 3.3 エンドポイント（OpenAPI 3.0.3・実測済み）

| エンドポイント | パラメータ | 用途 |
|---|---|---|
| `GET /api/entries/search` | `query`（fuzzy）/ `anilist_id` / `tmdb_id` / `anime`（boolean）/ `after` / `before` | 作品エントリ検索 |
| `GET /api/entries/{id}` | — | エントリ詳細（英語名・日本語名・フラグ等） |
| `GET /api/entries/{id}/files?episode={n}` | `episode`（任意） | エピソードの字幕ファイル一覧 |
| `GET /entry/{id}/download/{filename}` | — | 字幕ファイル本体（**認証不要**・CORS `*`） |

**search の重要パラメータ**:
- `anime=true` → アニメのみ・`anime=false` → **ドラマ（Live Action）のみ**（実測で両方動作確認）。
- `query` は **fuzzy search**（ロマ字タイトルで高精度・実測）。
- `anilist_id` はアニメ、`tmdb_id`（`tv:325021` 形式）はドラマの直接検索に使用。

### 3.4 検索結果のエントリ構造（実測）

```json
{
  "id": 729,
  "name": "Sousou no Frieren",
  "anilist_id": 154587,
  "tmdb_id": "tv:12345",
  "english_name": "Frieren: Beyond Journey's End",
  "japanese_name": "葬送のフリーレン",
  "flags": { "anime": true, "adult": false, "movie": false, "external": false, "unverified": false },
  "last_modified": "2026-02-14T00:37:40Z"
}
```

**字幕ファイル構造**（`/files` レスポンス）:

```json
{ "url": "https://jimaku.cc/entry/12426/download/...srt", "name": "...", "size": 62379, "last_modified": "..." }
```

## 4. マッチ精度の実測結果（2026-08-15・実ファイル検証）

### 4.1 検索の精度

| クエリ | anime フラグ | 結果 |
|---|---|---|
| `Sousou no Frieren`（ロマ字完全一致） | true | ✅ 完全一致（id:729） |
| `Frieren`（部分） | true | ✅ 候補（Frieren・2nd Season） |
| `Frieren Beyond Journey's End`（英語名） | true | ✗ 空（fuzzy でも完全一致寄り） |
| `Oshi no Ko` | true | ✅ 完全一致 |
| `Oshi no Ko` | false | ✅ 実写版（-The Final Act-）も出る |
| `Meitantei no Mama de Ite`（ドラマ） | false | ✅ 完全一致（id:12426） |
| `Meitantei`（部分） | false | ✅ 候補が出る（Chef wa Meitantei 等） |

### 4.2 実ファイルでの検証（Meitantei EP01）

ユーザーの実際のファイル:
`[MagicStar] Meitantei no Mama de Ite EP01 [WEBDL] [1080p] [TELASA] [JPN_SUB]`

- `query=Meitantei no Mama de Ite&anime=false` → ✅ 完全一致（id:12426）
- `GET /api/entries/12426/files?episode=1` → ✅ **同名ファイルが存在**（`Meitantei.no.Mama.de.Ite.EP01.1080p...MagicStar.srt`・62KB）
- 字幕DL → ✅ HTTP 200・`application/x-subrip`・CORS `*`

**結論**: ロマ字タイトル + エピソード番号をファイル名から正しく抽出できれば、**高精度（ほぼ確実）でマッチ**する。リリースグループ（MagicStar 等）の字幕がそのまま取得できる。

### 4.3 注意点

- **英語タイトルはマッチしない**（fuzzy は完全一致寄り）。ロマ字タイトルを優先すること。
- 日本語タイトルは未実測（ロマ字推奨・必要なら追加検証）。
- エピソード表記の揺れ（`EP01` / `S01E01` / `1x01` / `第1話`）はパーサーで正規化する。

## 5. アーキテクチャ

```
┌─────────────────────────────────────────────────────┐
│  Entei（ブラウザ・React island）                       │
│                                                     │
│  [自動ロード] [検索してからロード]   ← プレイヤー枠内ボタン │
│       │                │                           │
│       ▼                ▼                           │
│  filenameParser    JimakuSearchModal                │
│  （ファイル名→      （タイトル検索・アニメ/ドラマ切替）    │
│   タイトル+EP）        │                           │
│       │                ▼                           │
│       └──────────►  jimaku-client.ts                │
│                     （fetch ラッパー・APIキー・       │
│                       レート制限バックオフ）           │
│                        │                           │
│                        ▼                           │
│                 subtitle テキスト取得                 │
│                        │                           │
│                        ▼                           │
│              subtitle-reader.ts（既存）→ 表示        │
└─────────────────────────────────────────────────────┘
```

### 5.1 依存関係

- 外部パッケージ追加なし（fetch のみ・GraphQL も素の fetch）。
- jimaku.cc / AniList への依存は読み取り専用（アップロード・書き込みなし）。

## 6. 実装フェーズ計画

| フェーズ | 内容 | 完了条件 |
|---|---|---|
| **P1: 基盤** | `jimaku-client.ts`（fetch ラッパー・APIキー・レート制限バックオフ・エラー処理）・`filenameParser`（ファイル名→タイトル+EP） | 単体テスト・実APIで検索可能 |
| **P2: 自動ロード** | メディア選択時にファイル名パース → 自動検索 → 最上位候補の字幕取得・表示・失敗時フォールバック | 実ファイルで自動ロード動作 |
| **P3: 検索 UI** | 検索モーダル（タイトル検索・アニメ/ドラマ切替・候補一覧・EP選択・ファイル一覧・ロード） | 手動検索→ロード動作 |
| **P4: 設定** | 設定モーダルに jimaku API キー入力欄（localStorage 保存） | キー保存・接続確認 |

## 7. 参考: asb-auto-subs 拡張の仕組み（調査済み・2026-08-15）

`https://github.com/GodPepe7/asb-auto-subs`（`A:\asb-auto-subs` にローカルクローン）は jimaku から自動字幕を取得するブラウザ拡張。

**データフロー**:
1. `webNavigation.onHistoryStateUpdated` で hianime/miruro のエピソードページ遷移を検出
2. ページ DOM からタイトル・エピソード・AniList ID を抽出（`injectScript`）
3. タイトル → AniList ID（`graphql.anilist.co`・CORS OK の公共 API）
4. `GET /api/entries/search?anilist_id={id}` → エントリ
5. `GET /api/entries/{id}/files?episode={n}` → 字幕一覧
6. `chrome.downloads` で保存（**拡張専用 API・Entei では fetch に置換**）

**Entei への適用**: サイト検出（hianime/miruro）と `chrome.downloads` は使わない。**ファイル名ベースのパース**（SubMiner 方式）と **fetch での字幕取得**に置き換える。

### 7.1 ファイル名パーサーの参考（SubMiner・jimaku 統合の実装）

SubMiner（mpv 統合・jimaku 対応プレイヤー）のファイル名パース仕様:
- シーズン+EP: `S01E03`・`1x03`
- EP のみ: `E03`・`EP03`・`Title - 03 -`
- 括弧タグ: `[SubGroup]`・`[1080p]`・`[HEVC]` を除去
- 年タグ: `(2024)` を除去
- ドット・アンダースコア: スペースとして扱う

## 8. 残課題（要確認）

- [ ] 日本語タイトルでのマッチ精度（未実測・必要なら追加検証）
- [ ] **自動ロードの失敗時 UX**（P1 実装前に詳細化する）: 失敗の種別ごとの挙動を定義する必要がある
  - マッチなし（タイトルが jimaku に存在しない）→ 検索 UI を開き、パース済みタイトルをプリフィル
  - ネットワークエラー / API キー未設定 → エラー Toast を表示（検索 UI は開かない）
  - 候補が複数ある場合 → 候補一覧 UI（自動ロードは最上位を採用し、候補リストも併せて表示）
- [ ] ファイル名パーサーの対象範囲（ローカル / Magnet / YouTube のどれを対象にするか）
- [ ] ボタンの配置（プレイヤー枠内の正確な位置・アイコン）
- [ ] **CSP（Content Security Policy）**: Entei の本番 CSP（PHASE0.md の `default-src 'self'` 基準）はクロスオリジン fetch をブロックするため、`connect-src` に `https://jimaku.cc`（必要なら `https://graphql.anilist.co`）を追加する必要がある。P1 で既存 CSP ヘッダーを確認する。
- [ ] **DL エンドポイントのレート制限**: 字幕 DL（`/entry/{id}/download/*`）が API エンドポイントと同じ IP 単位レート制限プールを共有するか未確認。複数エピソード連続 DL で 429 が起きる可能性があるため、P1 で実測確認し、必要ならバックオフ対象に含める。
- [ ] **字幕形式の対応**: jimaku が返す字幕形式（SRT/VTT/ASS 等）が既存の `subtitle-reader.ts` で処理できることを P1 で検証する（未対応形式があれば方針を決める）。

## 9. 禁止事項

- jimaku.cc の **アップロード・書き込み API は使わない**（読み取り専用）。
- API キーをログ・URL・エラー表示に**出さない**（Anki キーと同じ扱い）。
- レート制限を無視した連続リクエストはしない（429 バックオフ必須）。
- 字幕データの再配布・アップロードはしない（取得して表示するだけ）。
