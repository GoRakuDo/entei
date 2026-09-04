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

| 項目 | 内容 |
|---|---|
| **ベース URL** | `https://api.nadeshiko.co/v1` |
| **認証方式** | `Authorization: Bearer <API_KEY>` |
| **CORS 対応** | `Access-Control-Allow-Origin: *`（OPTIONS / GET / POST） |
| **レートリミット** | 300 リクエスト / 60 秒（スライディングウィンドウ、`RateLimit` / `RateLimit-Policy` ヘッダー） |
| **月間クォータ** | アカウント依存（標準 5,000 件/月、`X-Monthly-Quota-*` ヘッダーおよび `/v1/user/me` で動的取得） |
| **レスポンス形式** | JSON (`application/json`) |

### 主要エンドポイント

#### 1. セグメント（セリフ）検索: `POST /v1/search`

セリフ・単語からアニメやドラマの該当シーンを検索。

- **リクエストボディ:**
  ```json
  {
    "query": "猫",
    "exactMatch": false,
    "take": 10,
    "mode": "RELEVANCE",
    "cursor": null
  }
  ```
- **検索オプション:**
  - `query`: 検索キーワード（漢字・かな・ローマ字・英語対応、ブール演算子 `AND`/`OR`/`NOT` 対応、ワイルドカード対応）
  - `exactMatch`: 完全一致フレーズ検索（デフォルト `false`）
  - `take`: 取得件数（1〜50、デフォルト `10`）
  - `mode`: ソート順序（`RELEVANCE` / `TIME_ASC` / `TIME_DESC` / `RANDOM` 等）
  - `media`: 対象作品の include / exclude フィルター

#### 2. 前後文脈の取得: `GET /v1/media/segments/{segmentPublicId}/context`

検索ヒットしたセリフの前後の会話・文脈セグメントを取得。

#### 3. クォータ・ユーザー情報取得: `GET /v1/user/me`

ユーザーの今月の使用状況（残リクエスト数・リセット日時など）を取得。

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
