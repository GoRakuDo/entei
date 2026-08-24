# Jimaku Subs — 日本語字幕の自動ロード・検索（jimaku.cc API 統合）

> 再生中のメディア（アニメ・ドラマ）の日本語字幕を、**jimaku.cc の API** から自動ロード／検索してロードする機能の設計ドキュメント。
>
> 状態: **設計確定（2026-08-15）・実装済み（feature/jimaku-subs ブランチ・P1–P4 完了）**。ユーザー確定事項の一次ソース。

## 1. 目的

ユーザーがアニメ・ドラマの動画を再生するとき、**字幕を手動で探してダウンロードする手間をなくす**。jimaku.cc（コミュニティ字幕ライブラリ）の API を Entei のウェブから直接呼び、再生中メディアに合う日本語字幕を自動で取得・表示する。

- **Entei のウェブから出ずに完結**する（別サイト・別ツール・拡張機能は不要）。
- アニメ（AniList ベース）と **ドラマ（TMDB ベース）の両方**に対応する。
- 字幕データは取得して表示するだけ（アップロードしない・外部に送信しない）。

## 2. 確定スペック（ユーザー確定・2026-08-15 / 16 インタビューで確定）

### 2.1 UI 構成

1. **自動ロードの ON/OFF** は、設定モーダルの「字幕」タブ内に **「JIMAKU.CC」見出し**を追加し、そこに配置する:
   - **API キー入力欄**（localStorage に保存・ユーザー確定 2026-08-16。jimaku からは字幕の**取得（読み取り）のみ**で、アップロード等の書き込みは行わない）
   - **shadcn Switch**（自動ロード ON/OFF・localStorage に永続化・**初期値 ON**）
2. **検索ボタン**（検索してからロード）は、**既存の字幕タイミングズレ同期ボタンの隣**（サイドパネル）に配置する。
3. 自動ロード専用ボタンは**置かない**（Switch の ON/OFF で制御）。

### 2.2 自動ロード

1. **対象ソース**: ローカルファイル + Magnet のみ。**YouTube は自動ロードしない**（検索ボタンからの手動は可能）。
2. **トリガー**: ① ローカルでメディアを選択した時 ② Magnet から動画をプレイヤーに渡した瞬間。ただし **Magnet モーダルで字幕も選択された場合は自動ロードしない**（既に字幕があるため）。
3. **字幕が既に表示されている場合は自動ロードしない**（字幕が無い時だけ実行・手動選択を尊重）。
4. **処理フロー**:
   - `mediaName`（再生中メディアのファイル名/タイトル）をパース → タイトル + エピソード番号を抽出
   - **2段階検索**: まず `anime=true` で検索 → ヒットしなければ `anime=false` で再検索（実測: ドラマは `anime=false` 指定が必須）
   - **完全一致判定**: 検索結果の**最上位エントリの `name` フィールド（ロマ字タイトル）が、パースしたタイトルと正規化して同一**の場合のみ「完全一致」→ **即差し替え**（成功時は無表示・Toast なし）。`english_name` / `japanese_name` は比較に使わない。シーズン別エントリ（例: "Frieren" vs "Frieren 2nd Season"）は別作品として扱い、パースタイトルと完全一致しない場合は曖昧としてフォールバック。
   - 最上位が一致しない・タイトルが曖昧（シーズン別エントリ等）・EP 抽出不可 → **検索モーダルを自動で開く**（パースタイトルをプリフィル・アニメ/ドラマ切替は最後に試した方）
   - マッチ成功でも**日本語ファイルが 0 件**なら → 検索モーダルにフォールバック（非日本語も含めて全ファイル表示）
   - 取得した字幕は**既存字幕を差し替え**（`setCues` + `subtitleTextRef`）
5. **自動ロードは字幕の取得のみ**。タイミング同期（sub-to-audio 等）はユーザーが手動で同期ボタンを押す。
6. **API キー未設定時**: Toast で案内を**最大 7 回**表示（localStorage で回数カウント・以降は静か）。
7. **レート制限（429）**: Toast で通知（例: 「jimaku の制限に達しました。少し待ってからお試しください」）・リトライなし・ユーザーは後で手動検索。

### 2.3 検索モーダル（検索してからロード）

1. **入力欄 2 つ**: タイトル + エピソード番号。タイトル欄は**現在のメディア名（`mediaName`）をプリフィル**。エピソード番号欄が空なら**全ファイルを表示**。
2. **アニメ/ドラマ切替**: モーダル内に **ToggleGroup（単一選択）** を配置・**localStorage に永続化**（次回も同じ状態）。
3. **字幕フィルタ**: 日本語のみ。**非日本語判定に当たったファイルだけ除外**し、判定が当たらないファイルは「日本語の可能性が高い」として表示に含める（jimaku は基本日本語字幕）。判定基準（P1 で検証・確定予定）: ファイル名に言語タグを含む場合のみ非日本語と判定する — 例: `[EN]`・`[English]`・`.eng.`・`en-US`・`eng` 等の英語タグ、`[SPA]`・`[ESP]`・`[FR]`・`[CHI]`・`[KR]` 等他言語タグ。`ja` / `jpn` / `[JP]` は日本語として表示。言語タグが無いファイルは日本語とみなす。日本語が 0 件の場合は非日本語も含めて表示。
4. **ファイル形式**: 非圧縮（.srt/.ass/.ssa/.vtt 等）のみ表示・圧縮（.zip/.7z/.rar）は除外。※ `.ssa` は ASS パーサー（ass-compiler）で処理できることを P1 で検証する。
5. **表示**: 作品エントリ選択後にファイル一覧（取得順・そのまま表示）。**EP 欄を変更したら自動でファイル一覧を再取得**。
6. **サイズ**: モーダル内は最大高さ + 内部スクロール（詳細は実装後にユーザーが実機で調整）。

## 3. jimaku.cc API 概要（実測・2026-08-15）

### 3.1 認証

- すべての API エンドポイントで **`Authorization` ヘッダー**に API キーを指定。
- アカウントは https://jimaku.cc/account で API キーを生成。
- **字幕ファイルのダウンロード URL は認証不要**（public・`access-control-allow-origin: *` 実測）。

### 3.2 レート制限

- **IP 単位**で制限（25 req / 約1秒の窓・`x-ratelimit-*` ヘッダーで通知）とされているが、**実測では事実上発動しない**（後述 §8 参照）。
- **429 は型付きエラー `rate-limit` にマップされ、レート制限 Toast として表示されるだけ**（`jimaku-client.ts` 実装）。**自動リトライは行わない（設計上・バックオフなし）** — フィールドテスト 2026-08-23、バースト時も 429 は 0 件。
- 回復は **ユーザーの手動リトライ**（検索モーダルからの再検索）のみ。自動ロード時も即時リトライはせず Toast 通知のみ（2.2.7 参照）。

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
- 日本語タイトルは概ね有効だがカタカナ表記ゆれで0件になる場合がある（§8 実測・2026-08-23 参照）。ロマ字タイトルを優先すること。
- エピソード表記の揺れ（`EP01` / `S01E01` / `1x01` / `第1話`）はパーサーで正規化する。

## 5. アーキテクチャ

```
┌─────────────────────────────────────────────────────┐
│  Entei（ブラウザ・React island）                       │
│                                                     │
│  設定モーダル「字幕」タブ: JIMAKU.CC 見出し            │
│    [APIキー入力] [自動ロード Switch]（localStorage）    │
│                                                     │
│  サイドパネル: [同期ボタン][検索ボタン]                 │
│       │                │                           │
│  Switch ON時           ▼                           │
│  メディア選択/         JimakuSearchModal              │
│  Magnet渡し時          （タイトル+EP入力・             │
│       ▼              アニメ/ドラマSwitch・            │
│  filenameParser      候補一覧・ファイル一覧）          │
│  （ファイル名→           │                           │
│   タイトル+EP）         ▼                           │
│       │              jimaku-client.ts               │
│       └──────────►  （fetch ラッパー・APIキー・        │
│                      レート制限 429→Toast）           │
│                        │                           │
│                        ▼                           │
│                 subtitle テキスト取得                 │
│                        │                           │
│                        ▼                           │
│              subtitle-reader.ts（既存）→ 表示        │
└─────────────────────────────────────────────────────┘
```

### 5.1 依存関係

- 外部パッケージ追加なし（fetch のみ・GraphQL は使用しない — 検索は jimaku の fuzzy search で完結）。
- jimaku.cc への依存は読み取り専用（アップロード・書き込みなし）。

## 6. 実装フェーズ計画

| フェーズ | 内容 | 完了条件 |
|---|---|---|
| **P1: 基盤** | `jimaku-client.ts`（fetch ラッパー・APIキー・429→Toast・エラー処理）・`filenameParser`（ファイル名→タイトル+EP）・`jimaku-preferences.ts`（APIキー・Switch・Toast回数・アニメ/ドラマ切替の localStorage 永続化） | 単体テスト・実APIで検索可能 |
| **P2: 設定 UI** | 設定モーダル「字幕」タブに JIMAKU.CC 見出し（APIキー入力 + 自動ロード Switch） | キー保存・Switch 永続化 |
| **P3: 自動ロード** | Switch ON 時: メディア選択/Magnet 渡しでファイル名パース → 2段階検索 → 完全一致なら即差し替え・曖昧/失敗は検索モーダルを自動オープン（プリフィル+最後の切替）・キー未設定 Toast 7回 | 実ファイルで自動ロード動作 |
| **P4: 検索 UI** | 検索モーダル（タイトル+EP 入力・アニメ/ドラマ Switch 永続化・日本語フィルタ・非圧縮のみ・候補一覧・ファイル一覧・EP変更で再取得・最大高さ+スクロール）・検索ボタンを同期ボタンの隣に配置 | 手動検索→ロード動作 |

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

- [x] 日本語タイトルでのマッチ精度（**実測済み 2026-08-23**）: fuzzy search は日本語タイトルで概ね有効（葬送のフリーレン/推しの子/ぼっち・ざ・ろっくの3/4で1位正解）。失敗パターンはカタカナ表記ゆれ（`サニーボーイ` → jimaku 登録名 `Sonny Boy` で0件）。ロマジも万能ではない（`Oshi no Ko` で77件に膨張しノイズ増）。正式タイトルがロマジの作品はロマジで検索するのが正解。マッチ失敗時は検索モーダル自動オープン（P3 実装済み）が実質の答えで、追加実装なし。
- [x] **CSP（Content Security Policy）**: **調査済み 2026-08-23 — 対応不要**。Entei 本番（GitHub Pages）では response header による CSP 強制は不可（Pages は custom header 非対応）で、layouts にも `<meta http-equiv>` CSP は未設置。つまり強制 CSP 機構が存在せず、`connect-src` 追加も起きない。jimaku.cc 側は CORS 対応済み（§3 実測・DL URL は `access-control-allow-origin: *`）のため browser 直 fetch 可能。PHASE0.md の CSP は design 制約（外部 script/font を持ち込まない方針）であり、将来 Hosting 先を変えて response header CSP を導入する時の宿題として PHASE0.md 側に残る。
- [x] **DL エンドポイントのレート制限**: **実測済み 2026-08-23** — 検索 API を 30 連打（遅延なし）+ 字幕 DL（public・HEAD）を 12+15 連打しても 429 は 1 件も発生せず、`retry-after` も出ない。実用範囲（自動ロード 1-2 リクエスト/メディア・検索モーダルでの手動検索）ではレート制限は事実上の非問題。**クライアントは 429 を型付きエラー `rate-limit` にマップしレート制限 Toast を出すのみ。自動リトライ（バックオフ）は実装せず、回復はユーザーの手動再検索（設計上・§3.2 参照）**。フィールドテスト 2026-08-23、バースト時も 429 は 0 件。
- [ ] **字幕形式の対応**: jimaku が返す字幕形式（SRT/VTT/ASS 等）が既存の `subtitle-reader.ts` で処理できることを P1 で検証する（未対応形式があれば方針を決める）。
- [ ] **検索モーダルの実機調整**: 内部スクロールの高さ等は実装後にユーザーが実機で調整（2026-08-16 確定）。

## 9. 禁止事項

- jimaku.cc の **アップロード・書き込み API は使わない**（読み取り専用）。
- API キーをログ・URL・エラー表示に**出さない**（Anki キーと同じ扱い）。
- レート制限を無視した連続リクエストはしない。429 発生時は型付きエラー `rate-limit` として Toast 表示し、自動リトライ（バックオフ）は行わずユーザーの手動再検索で回復する（§3.2 参照）。
- 字幕データの再配布・アップロードはしない（取得して表示するだけ）。
