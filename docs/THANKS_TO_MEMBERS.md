# Thanks To Members — アクティブ会員表示

> Entei のホームページ下部に「Thanks To」セクションを追加し、YouTube チャンネルの**アクティブ会員**（= 現在メンバーシップ加入中のユーザー）を、アバター・名前・レベルバッジとともに表示する機能の設計ドキュメント。
>
> 状態: **実装完了（2026-08-12）・本番デプロイ済み**。現在は YouTube Studio のメンバーCSV エクスポートを `import-csv.mjs` で取り込んで表示中（API アクセス申請は Google に送信済み・承認後に `fetch-members.mjs` の自動取得へ切り替え予定）。ユーザー確定事項の一次ソース。

## 1. 目的

YouTube チャンネルのメンバーシップ会員へ感謝を示し、加入を促進する。ホームページの Roadmap セクションの下に、アクティブ会員の一覧を**総額（= レベル別月額 × 滞在月数の合計）の降順**で表示する。

- **総額の大きい会員が最上位**。1 番デカい（= 一番長く・高いレベルで支援してくれている）順に並ぶ。
- 表示は「アバター + 名前 + レベルバッジ」を基本とする（詳細は §5）。**月額・総額は画面に表示しない**（総額は並び順の計算にのみ使用）。
- データは**週次でローカル自動取得**し、デプロイ（ビルド）時に反映する（= 静的サイトのまま維持）。

## 2. 確定スペック（ユーザー確定・2026-08-12）

1. **取得元**: YouTube Data API v3 の `members.list` エンドポイント（= チャンネルオーナー専用・OAuth 2.0 必須）。
2. **取得方式**: Node スクリプトを `scripts/` に置く（EizouDendenshi には**統合しない**）。
3. **秘密情報**: API キー・OAuth クライアント secret・refresh token は**ローカルの gitignore 済みファイル**にのみ保存し、リポジトリ・サイト・ログには一切公開しない。
4. **自動更新**: ビルドスクリプト（`prebuild` フック）が、生成済み JSON のタイムスタンプを確認し、**1 週間を超えていた場合のみ**自動で再取得して JSON を上書きする。
5. **デプロイ反映**: 生成される `members.json` は秘密を含まない（名前・アバター URL・レベル ID・滞在月数のみ）ためコミット可能。デプロイの流れは「ローカルで取得 → コミット → **手動 push → GitHub Actions が認識 → GitHub Pages へ反映**（= GA 環境に秘密を持ち込まない）」。GA が未導入の期間は、コミット済み JSON をそのまま使う。
6. **並び順**: 総額（= Σ（レベル月額 × そのレベルでの滞在月数））の降順。1 番総額が大きい会員が最上位。
7. **実行タイミング**: ローカルでの手動実行（例: `npm run fetch-members`）と、ビルド時の自動チェック（1 週間超過時のみ更新）の 2 経路。
8. **レベル情報の取得**: `membershipsLevels.list` で**自動取得**し、**キャッシュ方式**（毎回 fetch して同一なら即スキップ・変わっていれば更新）。
9. **月額・総額は UI 非表示**: 月額は総額計算の内部用のみ。総額は並び順のソートにのみ使用し、画面には表示しない。
10. **アバターはホットリンク**: `profileImageUrl` をそのまま `<img src>` に使用（ローカル保存しない）。
11. **空状態**: 会員が 0 人・データ未取得時は**セクションごと非表示**。
12. **OAuth Client はユーザーが自動作成**（Google Cloud Console・デスクトップアプリ型・手順は §6 の 1 に記載）。

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
- `members.list` は価格を返さないが、**価格自体はこのエンドポイントで API から取得可能**。レベル数は固定的なので、**キャッシュ方式**（初回に取得して保持・以降は毎回 fetch して同一ならスキップ）で `levels.json` に保持する（= 手動入力不要・ドリフトなし）。

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
- `membershipsDurationAtLevel[].level` は**レベル ID** なので、月額のマッピングは**レベル ID → 月額**の形にする（`members-supporter/levels.json`）。表示名（`displayName`）は `membershipsLevels.list` から得る。
- レベル→月額マッピングは**秘密ではない**（= サイト上で公開している加入情報）のでコミット可能。`membershipsLevels.list` から自動生成する `levels.json` を保持する（形式: `{ id: string, name: string, price: number, currency: string }[]`・ID によるルックアップが直結する配列形式）。

## 4. アーキテクチャ

```text
[ローカルマシン]
  members-supporter/
    fetch-members.mjs      … 取得スクリプト（Node・Esm）
    oauth.mjs              … OAuth 2.0 フロー（初回のみブラウザ同意 → refresh token 保存）
    levels.json            … レベル ID → 月額マッピング（`membershipsLevels.list` から自動生成・コミット可）
    .secrets/              … gitignore 済み（client secret・refresh token）
  apps/web/src/content/home/members.json  … 生成物（コミット可・秘密なし）

[ビルド時]
  npm run build
    └─ prebuild: node members-supporter/fetch-members.mjs
         ├─ .secrets/ が無い（= GitHub Actions 環境）→ スキップ（コミット済み JSON を使用）
         └─ .secrets/ が有る（= ローカル）→ members.json の fetchedAt を確認
              ├─ 1 週間以内 → 何もしない
              └─ 1 週間超過 → OAuth refresh → members.list + membershipsLevels.list 取得
                    → levels.json と比較（同一ならスキップ）→ 総額計算・降順ソート → JSON 上書き

[デプロイ]
  手動 push → GitHub Actions が認識 → GitHub Pages へ反映
    └─ GA はコミット済み members.json をそのまま使用（GA に秘密なし）
    └─ GA 未導入の間は、コミット済み JSON がそのまま公開される
```

## 5. UI 仕様（Thanks To セクション）

- **場所**: ホームページの Roadmap（`future-features.mdx`）の下・LocalFirstNote の前。
- **見出し**: 「Thanks To」+ サブテキスト（i18n: id/en/ja）。
- **表示内容**（会員ごと）:
  - アバター画像（`profileImageUrl`）
  - 表示名（`displayName`）
  - レベルバッジ（`highestAccessibleLevelDisplayName`）
- **非表示**: 月額・総額は表示しない（総額は並び順の計算にのみ使用）。
- **並び**: 総額降順（1 番大きいのが最上位）。
- **スタイル**: 既存デザイントークン（OKLCH・DESIGN.md）に準拠。グリッド/チップ表示の詳細は実装時に DevTools で調整（静的 CSS テストは作らない — プロジェクトルール）。
- **空状態**: 会員が 0 人・データ未取得時は**セクション自体を非表示**（プレースホルダーは出さない）。

## 6. 実装手順（見積もり）

1. **OAuth 準備（ユーザー作業）**: Google Cloud Console で OAuth Client（デスクトップアプリ型）作成。scope: `https://www.googleapis.com/auth/youtube.channel-memberships.creator`。初回の同意フロー（ブラウザ承認）で refresh token を `members-supporter/.secrets/` に保存（gitignore 済み）。
2. **取得スクリプト**: `fetch-members.mjs` 実装（OAuth refresh → `members.list` 全ページ取得 → `membershipsLevels.list` 取得 → levels キャッシュ比較 → 総額計算 → 降順ソート → `members.json` 書き出し + `fetchedAt` 記録）。`.secrets/` が無い環境（GA）では即スキップ。
3. **prebuild フック**: `package.json` の `prebuild` にスクリプト追加（1 週間超過時のみ更新・秘密なし環境ではスキップ）。
4. **gitignore**: `members-supporter/.secrets/` を `.gitignore` に追加。
5. **UI 実装**: Thanks To セクションの Astro コンポーネント + i18n + スタイル（DESIGN.md 準拠・DevTools 実測）。会員 0 人・未取得時は非表示。
6. **テスト**: ロジック（総額計算・ソート・1 週間判定・levels キャッシュ比較）のみユニットテスト。UI は DevTools 実測。

## 7. 未確定事項（要ユーザー入力）

- [ ] 同額時の並び順（名前順 or 加入順）— 実装時に軽く確認すればよい
- [ ] 手動実行コマンド名（例: `npm run fetch-members`）
- [ ] OAuth 審査の要否（個人利用ならテスト状態で動く見込み・公開アプリ化時に確認）

## 8. 配布URL

Entei サイト（https://entei.gorakudo.org）経由の短いインストールURL。中身は署名検証付き bootstrap への委譲（ラッパー方式）。

| プラットフォーム | コマンド |
|---|---|
| Termux | `curl -fsSL https://entei.gorakudo.org/eizouden-install.sh \| bash` |
| Windows | `irm https://entei.gorakudo.org/eizouden-install.ps1 \| iex` |

**運用ルール**: 新しい EizouDendenshi release（rc.XX）が出たら、`apps/web/public/eizouden-install.sh` と `eizouden-install.ps1` の GitHub release URL（`eizoudendenshi-v0.2.0-rc.XX` 部分）を更新すること。ラッパー自体は未署名で良い（= 委譲先の実 bootstrap が Minisign 検証済みのため・ラッパーが改竄されても実 bootstrap の署名検証が守る）。

## 9. 禁止事項

- OAuth client secret・refresh token をリポジトリ・サイト・ログ・チャットに公開しない（= EizouDendenshi の Minisign private key と同じ扱い・#1733 準拠の精神）。
- EizouDendenshi（companion）には統合しない（= ユーザー確定）。
- Pure Black / Pure White の不使用・OKLCH のみ（= DESIGN.md・#1621）を UI 実装で維持。
