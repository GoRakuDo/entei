# Thanks To Members — アクティブ会員表示

> Entei のホームページ下部に「Thanks To」セクションを追加し、YouTube チャンネルの**アクティブ会員**（= 現在メンバーシップ加入中のユーザー）を、アバター・名前・レベル・総額とともに表示する機能の設計ドキュメント。
>
> 状態: **設計確定（2026-08-12）・未実装**。ユーザー確定事項の一次ソース。

## 1. 目的

YouTube チャンネルのメンバーシップ会員へ感謝を示し、加入を促進する。ホームページの Roadmap セクションの下に、アクティブ会員の一覧を**総額（= レベル別月額 × 滞在月数の合計）の降順**で表示する。

- **総額の大きい会員が最上位**。1 番デカい（= 一番長く・高いレベルで支援してくれている）順に並ぶ。
- 表示は「アバター + 名前 + レベルバッジ + 総額」を基本とする（詳細は §5）。
- データは**週次でローカル自動取得**し、デプロイ（ビルド）時に反映する（= 静的サイトのまま維持）。

## 2. 確定スペック（ユーザー確定・2026-08-12）

1. **取得元**: YouTube Data API v3 の `members.list` エンドポイント（= チャンネルオーナー専用・OAuth 2.0 必須）。
2. **取得方式**: Node スクリプトを `scripts/` に置く（EizouDendenshi には**統合しない**）。
3. **秘密情報**: API キー・OAuth クライアント secret・refresh token は**ローカルの gitignore 済みファイル**にのみ保存し、リポジトリ・サイト・ログには一切公開しない。
4. **自動更新**: ビルドスクリプト（`prebuild` フック）が、生成済み JSON のタイムスタンプを確認し、**1 週間を超えていた場合のみ**自動で再取得して JSON を上書きする。
5. **デプロイ反映**: 生成される `members.json` は秘密を含まない（名前・アバター URL・レベル・滞在月数・総額のみ）ためコミット可能。GitHub Pages 等の CI ビルドはコミット済み JSON をそのまま使用する（= CI に秘密を持ち込まない）。
6. **並び順**: 総額（= Σ（レベル月額 × そのレベルでの滞在月数））の降順。1 番総額が大きい会員が最上位。
7. **実行タイミング**: ローカルでの手動実行（例: `npm run fetch-members`）と、ビルド時の自動チェック（1 週間超過時のみ更新）の 2 経路。

## 3. API の事実（公式ドキュメント確認済み・2026-08-12）

### 3.1 `members.list` エンドポイント

- `GET /youtube/v3/members?part=snippet&mode=all_current&maxResults=1000`（`maxResults` は既定 5・上限 1000）
- 認可: OAuth 2.0 + scope `https://www.googleapis.com/auth/youtube.channel-memberships.creator`
- フィルタ: `mode`（`all_current` 既定 / `updates`）・`hasAccessToLevel`・`filterByMemberChannelId`・ページング（`pageToken`）
- エラー: `channelMembershipsNotEnabled`（メンバーシップ未有効）等
- **1000 人超のチャンネルは `nextPageToken` でページングして全件取得する**（`maxResults=1000` は 1 ページの上限）。

### 3.1b `membershipsLevels.list` エンドポイント（レベル名・価格の取得元）

- `GET /youtube/v3/membershipsLevels?part=snippet` — チャンネルのメンバーシップレベル一覧を返す（同じ OAuth scope）。
- `snippet.levelDetails.displayName` — レベルの表示名
- `snippet.monthlyPrice` — `{ currency, value }`（月額・通貨）
- `members.list` は価格を返さないが、**価格自体はこのエンドポイントで API から取得可能**。ただしレベル数は固定的なので、ローカル設定（`levels.mjs`）で持つ方がシンプル（= 実装時はローカル設定を優先し、`membershipsLevels.list` は確認用/初回生成用として使う）。

### 3.2 レスポンスに含まれる情報（member リソース）

| フィールド | 内容 |
|---|---|
| `memberDetails.displayName` | 会員の表示名 |
| `memberDetails.profileImageUrl` | 会員のプロフィール画像 URL |
| `membershipsDetails.highestAccessibleLevelDisplayName` | 最上位レベルの表示名 |
| `membershipsDetails.accessibleLevels` | アクセス可能なレベル一覧 |
| `membershipsDetails.membershipsDuration.memberSince` | 加入日時 |
| `membershipsDetails.membershipsDuration.memberTotalDurationMonths` | 総滞在月数 |
| `membershipsDetails.membershipsDurationAtLevel[]` | **レベル別の滞在期間**（`level` = **レベル ID**（例: `level_1_ID`・名前ではない）・`memberSince`・`memberTotalDurationMonths`） |

### 3.3 総額の計算

```text
総額 = Σ（各レベルの月額 × そのレベルでの滞在月数）
```

- 滞在月数は `membershipsDurationAtLevel[].memberTotalDurationMonths` を使用。
- `membershipsDurationAtLevel[].level` は**レベル ID** なので、月額のマッピングは**レベル ID → 月額**の形にする（`scripts/entei-members/levels.mjs`）。表示名（`displayName`）は `membershipsLevels.list` かローカル設定から得る。
- レベル→月額マッピングは**秘密ではない**（= サイト上で公開している加入情報）のでコミット可能。ただし**月額の通貨・実際の値はユーザーから提供を受けてから確定**（未確定・要入力）。

`levels.mjs` の推奨インターフェース（= ID によるルックアップが直結する配列形式）:

```js
// scripts/entei-members/levels.mjs（秘密ではない・コミット可）
export const LEVELS = [
  { id: 'level_1_ID', name: 'Level 1', price: 50000, currency: 'IDR' },
  { id: 'level_2_ID', name: 'Level 2', price: 100000, currency: 'IDR' },
  { id: 'level_3_ID', name: 'Level 3', price: 250000, currency: 'IDR' },
];
```

※ 実際のレベル ID・名前・月額はユーザーから提供を受けてから確定（未確定・要入力）。

## 4. アーキテクチャ

```text
[ローカルマシン]
  scripts/entei-members/
    fetch-members.mjs      … 取得スクリプト（Node・Esm）
    oauth.mjs              … OAuth 2.0 フロー（初回のみブラウザ同意 → refresh token 保存）
    levels.mjs             … レベル ID → 月額マッピング（コミット可・要ユーザー入力）
    .secrets/              … gitignore 済み（client secret・refresh token）
  apps/web/src/content/home/members.json  … 生成物（コミット可・秘密なし）

[ビルド時]
  npm run build
    └─ prebuild: node scripts/entei-members/fetch-members.mjs
         └─ members.json の fetchedAt を確認
              ├─ 1 週間以内 → 何もしない
              └─ 1 週間超過 → OAuth refresh → members.list 取得 → 総額計算・降順ソート → JSON 上書き

[デプロイ]
  GitHub Pages（CI）
    └─ コミット済み members.json をそのまま使用（CI に秘密なし）
```

## 5. UI 仕様（Thanks To セクション）

- **場所**: ホームページの Roadmap（`future-features.mdx`）の下・LocalFirstNote の前。
- **見出し**: 「Thanks To」+ サブテキスト（i18n: id/en/ja）。
- **表示内容**（会員ごと）:
  - アバター画像（`profileImageUrl`）
  - 表示名（`displayName`）
  - レベルバッジ（`highestAccessibleLevelDisplayName`）
  - 総額（計算値・通貨表示）
- **並び**: 総額降順（1 番大きいのが最上位）。
- **スタイル**: 既存デザイントークン（OKLCH・DESIGN.md）に準拠。グリッド/チップ表示の詳細は実装時に DevTools で調整（静的 CSS テストは作らない — プロジェクトルール）。
- **空状態**: 会員が 0 人・データ未取得時はセクション自体を非表示（または「準備中」表示を出すかは実装時決定）。

## 6. 実装手順（見積もり）

1. **前提確認**: ユーザーからレベル名と月額（通貨含む）を収集 → `levels.mjs` に反映。
2. **OAuth 準備**: Google Cloud Console で OAuth Client（デスクトップアプリ型）作成・scope 追加。初回の同意フローで refresh token を `scripts/entei-members/.secrets/` に保存（gitignore 済み）。
3. **取得スクリプト**: `fetch-members.mjs` 実装（OAuth refresh → `members.list` 全ページ取得 → 総額計算 → 降順ソート → `members.json` 書き出し + `fetchedAt` 記録）。
4. **prebuild フック**: `package.json` の `prebuild` にスクリプト追加（1 週間超過時のみ更新）。
5. **UI 実装**: Thanks To セクションの Astro コンポーネント + i18n + スタイル（DESIGN.md 準拠・DevTools 実測）。
6. **テスト**: ロジック（総額計算・ソート・1 週間判定）のみユニットテスト。UI は DevTools 実測。

## 7. 未確定事項（要ユーザー入力）

- [ ] **レベル ID・レベル名・月額**（通貨・実際の値）→ `levels.mjs`（ID キーの配列形式）に反映
- [ ] 総額の通貨表示フォーマット（例: `Rp 50.000` / `¥ 500`）
- [ ] アバターの表示方法（ホットリンク vs ローカル保存）
- [ ] 会員 0 人時の表示（非表示 or 準備中）
- [ ] 手動実行コマンド名（例: `npm run fetch-members`）

## 8. 禁止事項

- OAuth client secret・refresh token をリポジトリ・サイト・ログ・チャットに公開しない（= EizouDendenshi の Minisign private key と同じ扱い・#1733 準拠の精神）。
- EizouDendenshi（companion）には統合しない（= ユーザー確定）。
- Pure Black / Pure White の不使用・OKLCH のみ（= DESIGN.md・#1621）を UI 実装で維持。
