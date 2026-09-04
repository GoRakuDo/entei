# Nadeshiko Integration — 文脈・例文検索仕様（Nadeshiko API 連携）

> **状態:** 設計確定（2026-08-29 UI 配置決定）・CORS 実機検証完了（2026-08-27）・未実装
> **対象:** `Entei/apps/web` の `/player/`
> **決定日:** 2026-08-27（初版）/ 2026-08-29（UI 配置更新）
> **スコープ:** Nadeshiko Public API（`api.nadeshiko.co`）を利用した、単語・例文の文脈検索（アニメ・ドラマのセリフとタイムスタンプ）機能のクライアントサイド（BYOK）連携仕様。

---

## 1. 概要と背景

Entei での学習・Sentence Mining 中に、辞書定義だけでなく「実際のアニメやドラマでどういう文脈で使われているか」の例文・セリフを検索できるようにする。

- **CORS 検証結果（2026-08-27 実機確認済み）:**
  - Nadeshiko API サーバー（`https://api.nadeshiko.co/v1`）側で `Access-Control-Allow-Origin: *` が有効化されていることを確認。
  - 実機検証（curl OPTIONS プリフライトおよび Chrome DevTools からの `fetch`）で `204 No Content` / `access-control-allow-origin: *` / `401 Unauthorized (Auth Required)` の JSON 疎通を確認。
- **アーキテクチャ方針:**
  - **完全クライアントサイド（BYOK: Bring Your Own Key）方式**。
  - Entei はサーバーを持たない（静的サイト＋ローカル完結）ため、ブラウザから直接 Nadeshiko API へ通信する。中継サーバーや EizouDendenshi コンパニオンの Proxy は不要。
  - ユーザー自身の API キーを使用し、GoRakuDo / Entei 側は API キーや検索結果データを一切中継・保存しない。

---

## 2. API 仕様概要

ソース: <https://nadeshiko.co/docs/api/openapi.yaml>（v2.4.12, 2026-08-28 取得・ライブ検証済み）。
以下のテーブルとスキーマは仕様書 v2.4.12 と `https://api.nadeshiko.co` への実機 curl 検証（2026-09-04, 実キー使用）に基づく。

### 2.1 概要テーブル

| 項目 | 内容 |
|---|---|
| **ベース URL** | `https://api.nadeshiko.co/v1` |
| **認証方式** | `Authorization: Bearer <API_KEY>` |
| **CORS 対応** | POST `/v1/search` と GET `/v1/media/segments/{id}/context` はプリフライト＋本レスポンス両方に `Access-Control-Allow-Origin: *` を返す（ブラウザから直接 fetch 可）。GET `/v1/user/me` は本レスポンスに ACAO ヘッダーを返さないため、ブラウザから直接 fetch すると CORS でブロックされる（本仕様 §2.4）。 |
| **レートリミット** | **150 req / 60s**（`UserMe.quota.burst = { max: 150, windowMs: 60000 }`）。429 応答では `Retry-After` ヘッダーで待機秒数を返す。 |
| **月間クォータ** | **5,000 req / month**（`UserMe.quota.limit`、`X-Monthly-Quota-Limit` ヘッダー）。超過時も同じ 429 ステータスで `code: QUOTA_EXCEEDED`。 |
| **レスポンス形式** | JSON (`application/json`) |
| **エラーフォーマット** | `{ code, title, detail, status, type, instance, errors? }`（HTTP Problem Details 風） |

### 2.2 エンドポイント契約

#### 1. セグメント検索: `POST /v1/search`

- **リクエストボディ（v2.4.12 仕様）:**
  ```json
  {
    "query": { "search": "猫", "exactMatch": false },
    "take": 10,
    "cursor": null,
    "sort": { "mode": "RELEVANCE" },
    "filters": { "media": { "include": [], "exclude": [] } },
    "include": ["media"]
  }
  ```
  - `query.search`: 検索式（最大500文字）。ブール演算子 `AND`/`OR`/`NOT`、ワイルドカード、フレーズ引用符対応。
  - `query.exactMatch`: 完全一致フラグ（デフォルト `false`）。
  - `take`: 1〜50（デフォルト `10`）。
  - `sort.mode`: `RELEVANCE` / `ASC` / `DESC` / `TIME_ASC` / `TIME_DESC` / `RANDOM`（デフォルト `RELEVANCE`）。`RANDOM` のみ `sort.seed` で再現可能。
  - `cursor`: ページネーション用不透明トークン。
  - `include`: 現在は `["media"]` のみサポート。

- **200 レスポンス:**
  ```json
  {
    "segments": [
      {
        "publicId": "wy1hTtMJg6Jf",
        "position": 642,
        "status": "ACTIVE",
        "startTimeMs": 719343,
        "endTimeMs": 723055,
        "contentRating": "SAFE",
        "episode": 5,
        "externalVideoId": null,
        "mediaPublicId": "izs1jikMfEFq",
        "textJa": { "content": "猫! 猫 猫 猫...", "highlight": "<em>猫</em>!...", "tokens": [] },
        "textEn": { "content": "Please get it off!", "isMachineTranslated": false, "highlight": null },
        "textEs": { "content": "¡Gato!", "isMachineTranslated": false, "highlight": null },
        "urls": { "imageUrl": "...", "audioUrl": "...", "videoUrl": "..." }
      }
    ],
    "includes": {
      "media": {
        "izs1jikMfEFq": { "publicId": "...", "nameJa": "...", "nameRomaji": "...", "nameEn": "..." }
      }
    },
    "pagination": { "hasMore": true, "estimatedTotalHits": 1233, "estimatedTotalHitsRelation": "EXACT", "cursor": "eyJ..." }
  }
  ```
  - `segments[].publicId` がそのセグメントの安定 ID。
  - `segments[].textJa.content` が原文、`textEn.content` / `textEs.content` が英訳・西訳。
  - `segments[].text*.highlight` は検索マッチした語に `<em>` タグが付いた HTML。
  - `includes.media[mediaPublicId].nameJa` / `nameEn` / `nameRomaji` を作品名表示のソースとする（なければ `textJa` のみ表示）。
  - `startTimeMs` を 1000 で割って秒換算、UI のタイムスタンプ表示は `m:ss` / `h:mm:ss` フォーマット。

#### 2. 前後文脈の取得: `GET /v1/media/segments/{segmentPublicId}/context`

- **クエリパラメータ:**
  - `take`: 前後のセグメント数（1〜30、デフォルト `3`）。
  - `include[]`: `media` を推奨（作品名表示用）。
  - `contentRating[]`: 含むコンテンツレーティング（省略時は全）。
- **200 レスポンス:**
  ```json
  {
    "segments": [ /* Segment[] — 中心 + 前後を時間順で連結したフラットリスト */ ],
    "includes": { "media": { "...": "..." } }
  }
  ```
  旧版は `{ segment, context: [] }` の入れ子を返していたが、v2.4.12 ではフラットな `segments[]` のみ。クライアントは `publicId === requestedId` の要素を中心、それ以外を前後文脈として扱う。

#### 3. クォータ・ユーザー情報: `GET /v1/user/me`

- **200 レスポンス:**
  ```json
  {
    "user": { "username": "tanaka_san", "createdAt": "2024-03-15T10:00:00.000Z", "role": "USER" },
    "quota": {
      "used": 342,
      "limit": 5000,
      "remaining": 4658,
      "periodYyyymm": 202602,
      "periodStart": "2026-02-01T00:00:00.000Z",
      "periodEnd": "2026-02-28T23:59:59.999Z",
      "tier": { "id": "plus", "displayName": "Plus" },
      "burst": { "max": 150, "windowMs": 60000 }
    }
  }
  ```
  - `quota.limit` / `quota.remaining` / `quota.periodEnd` を UI に表示。
  - `quota.tier` はアカウントがティア無し / オーバーライド時は `null`。

### 2.3 旧契約（v2.4.12 以前）— 失効

> **注意:** 以下の旧仕様は失効。現行クライアント（`apps/web/src/features/nadeshiko/nadeshiko-client.ts`）は v2.4.12 契約のみサポートする。

- **旧 POST /v1/search リクエスト**: フラット形式 `{ query: "猫", exactMatch, take, mode, cursor }`（`query` が生文字列）。v2.4.12 では `query` はオブジェクト必須。
- **旧 GET /v1/search レスポンス**: `{ results: [{ id, workName, line, englishTranslation, timestamp, timestampLabel }] }`。現行は `{ segments, includes, pagination }`。
- **旧 GET /v1/media/segments/{id}/context レスポンス**: `{ segment, context }`。現行は `{ segments[] }`。
- **旧 GET /v1/user/me レスポンス**: フラットな `{ remainingRequests, monthlyLimit, resetAt }`。現行は `{ user, quota: { ... } }` の入れ子。
- **旧レートリミット表記**: 旧文書では「300 req / 60s」と記載していたが、v2.4.12 仕様書では **150 req / 60s** に修正されている。実機の `RateLimit` レスポンスヘッダーは一部キーで 300 を返すが、仕様と `quota.burst.max` の両方が 150 を示しているため、本仕様書では 150 を採用する。

### 2.4 CORS — ブラウザーからの直接呼び出しの制限

Entei はブラウザから `api.nadeshiko.co` へ直接 fetch する（サーバー不要・BYOK）。

- `POST /v1/search` と `GET /v1/media/segments/{id}/context`: OPTIONS プリフライトと実レスポンスの両方に `Access-Control-Allow-Origin: *` が付与される。ブラウザから問題なく呼び出せる。
- `GET /v1/user/me`: OPTIONS プリフライトは 200 を返すが `Access-Control-Allow-Origin` を含まない。実レスポンス（200 / 401 いずれも）にも ACAO が付かない。**結果として、ブラウザから `/user/me` を fetch すると CORS ブロックされ、本体もステータスも読み取れない。** したがって、Entei の設定タブでクォータを表示する経路は現状では常時「ネットワークエラー」表示となる（仕様上、これは設計通りの挙動）。プロキシは設置しない。

> この問題は将来 Nadeshiko 側で CORS が修正されれば自然に解消する。それまでは「設定タブのクォータ表示はベストエフォート」と位置付ける。

---

## 3. Entei での連携・UI 導線設計（2026-08-29 確定）

### 3.1 タブ配置: 履歴タブを「ニュアンス検索」タブへ置換

Player の RightPanel（`apps/web/src/components/player/RightPanel.tsx`）のタブを **2 つ構成のまま**、既存の「履歴（History / Riwayat）」タブを **Nadeshiko 文脈検索タブへ置き換える**:

| ロケール | 旧タブ名 | 新タブ名 |
|---|---|---|
| **ja** | 履歴 | **ニュアンス検索** |
| **id** | Riwayat | **Konteks** |
| **en** | History | **Context** |

- **アイコン**: Lucide `BrainCircuit`（`@lucide/astro` 互換の `@lucide/react` から）を Captions タブと同様に 16px で表示。
- **置き換え後のタブ構成**:
  1. `captions`（字幕 / Subtitle）— 既存のまま
  2. `context`（ニュアンス検索 / Konteks / Context）— Nadeshiko 検索 UI（新設）

### 3.2 履歴コンテンツの移設先: Tracker Dashboard

既存の「履歴」タブの中身は **削除せずに**、以下の通り移設する:

- **移設先**: `/tracker/` の React Dashboard（`apps/web/src/pages/tracker/` 配下の React client-only Dashboard）。
- **移設する要素**:
  1. **Tracker ON / OFF スイッチ**（`trackerSwitch` — 現在 RightPanel の history タブ内で表示）
  2. **採掘履歴リスト**（`MiningHistoryPanel` — empty / unavailable / sentence / range の 4 つのラベル付き）
- **RightPanel 側の変更後の状態**:
  - `history` タブ（`RightPanelTab` 型・`right-panel-history` DOM ID・`dict.rightPanelTabHistory` ラベル）を削除。
  - Tracker ON / OFF スイッチと `MiningHistoryPanel` は RightPanel から外れ、Tracker Dashboard へ引っ越し。
  - `handleTabChange` / `activeTab` / `RightPanelTab` 型は `'captions' | 'context'` の 2 値に縮小。
- **Tracker スイッチの責務 (player-side)**:
  - このフラグは **次のセグメント開始時のみ** 効く（`tracker-runtime.startSegment` が `isTrackerEnabled()` で早期 return する）。
  - 進行中のセグメントは **常に正常に終了し flush される**（`endSegment` / `pagehide` flush は無条件実行）。
  - つまり player タブで再生中にダッシュボード側で OFF にしても、現在のセグメントのデータは失われない。新しいセグメントから記録が止まるだけ。

### 3.3 Nadeshiko 検索タブの中身（新規実装）

`context` タブを選択すると、RightPanel 内に Nadeshiko 検索 UI が表示される:

- **検索フォーム**:
  - 入力欄（単語・フレーズ）
  - 検索ボタン（Lucide `Search` アイコン）
  - 検索中は TypewriterLoading（既存の同期ボタンと同じパターン）
- **検索結果リスト**:
  - 各結果カードに「アニメ / ドラマ作品名」「セリフ本文」「英語翻訳」「タイムスタンプ」を表示
  - 結果クリックで前後文脈（`context` エンドポイント）を展開表示
- **空 / エラー状態**:
  - 検索結果ゼロ: 「用例が見つかりませんでした」（`contextEmpty` 等、新規 i18n キー）
  - API キー未設定: 「設定で Nadeshiko API キーを入力してください」（`contextKeyMissing` 等）
  - 429: 「レートリミットに達しました。`{秒}`秒後に再試行してください」（`contextRateLimited` 等）

### 3.4 API キー管理（Settings）

- 設定モーダル（`apps/web/src/components/player/SettingsTabs.tsx`）内に **「Nadeshiko」** 設定項目を追加。
- ユーザーが自身の Nadeshiko API キーを入力・保存（`localStorage` キー例: `entei.nadeshiko.api-key.v1`）。
- クォータ状態（`GET /v1/user/me`）の確認表示（残リクエスト数 / リセット日時）。

---

## 4. セキュリティ & プライバシー原則

1. **Local-First / BYOK 徹底**:
   - Entei 側サーバーは一切存在せず、ブラウザと Nadeshiko 間で直接通信。
2. **クォータ尊重**:
   - レートリミット（429）や月間上限のエラーレスポンスを丁寧にハンドリングし、上限回避などの ToS 違反動作は一切行わない。
