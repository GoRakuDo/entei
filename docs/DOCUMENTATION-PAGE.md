# DOCUMENTATION-PAGE — EizouDendenshi Setup Tutorial Pages

> **状態:** PLAN（実装前）。この文書は `/tutorial/eizoudendenshi` ルート群の設計確定 + 実装計画。
> **作成:** 2026-08-26
> **スコープ:** 中学生でも分かる平易な語彙で、Windows と Android(Termux) への EizouDendenshi 導入手順を説明する静的チュートリアルページ 3 言語分。

---

## 1. 目的

EizouDendenshi companion の初回インストールは「ターミナルにコマンドを貼る」体験で、非技術者には心理的ハードルが高い。
本チュートリアルは **1 つずつ確認しながら進められる手順書** を 3 言語で提供し、インストール完了（pairing code 表示）まで導く。

対象読者の語彙レベル: **中学生**。専門用語（minisign / DPAPI / bootstrap 等）は使わないか、使う場合は 1 行のやさしい言い換えを添える。

## 2. URL 設計（Yosia 指定・2026-08-26 確定）

| locale | URL | 静的出力 |
|---|---|---|
| id (default) | `/id-tutorial/eizoudendenshi/` | `dist/id-tutorial/eizoudendenshi/index.html` |
| ja | `/ja-tutorial/eizoudendenshi/` | `dist/ja-tutorial/eizoudendenshi/index.html` |
| en | `/en-tutorial/eizoudendenshi/` | `dist/en-tutorial/eizoudendenshi/index.html` |

- 既存慣習との整合: Astro directory 出力のため trailing slash 付き（`trailingSlash: 'ignore'`）。`path` prop は `/xx-tutorial/eizoudendenshi/` 形式で canonical 生成に渡す。
- 既存ルート（Home・player）は静的 HTML がインドネシア語という規約がある（BaseLayout 注釈）。チュートリアルは各パスが各言語の静的 HTML を持つ SSG としてこれと棲み分ける。チュートリアルは各パスが各言語の静的 HTML を持つ（SSG なので SEO 上も正しい）。
- 言語間リンク: 各ページ上部に小さな言語切替リンク 3 個（`Bahasa · 日本語 · English`、現在ページは太字 + aria-current="true"）。

## 3. ページ構成

```
src/pages/[locale]-tutorial/eizoudendenshi.astro   ← 動的ルート 1 ファイル
```

- `getStaticPaths()` で 3 locale を列挙 → 各 `/{loc}-tutorial/eizoudendenshi/` を生成。
- 本文は MDX ではなく **コンポーネント + 辞書データ** 方式を採用（下記 §4 の理由）。
- 共有コンポーネント `TutorialSteps.astro` を新設し、ステップ配列を受け取って番号付きカードを描画。

### ページ要素

1. BaseLayout（TopBar + Footer 付き・`showChrome=true`）
2. SeoHead: title/description オーバーライド prop（2026-08-25 実装済み）を使用し 3 言語別メタデータ
3. 言語切替リンク（同一コンテンツの他言語版へ）
4. タイトル + 1 行リード（何ができるようになるか）
5. 「はじめる前に」ボックス（必要なもの: Windows PC or Android 端末、インターネット接続、Entei を開けるブラウザ）
6. プラットフォーム選択タブ風アンカー（Windows / Android）→ 同一ページ内アンカー遷移
7. ステップカード列（番号バッジ + タイトル + 本文 + コードブロック）
8. 最後に「次のステップ」: pairing code を Entei の設定に入れる案内 + Home への戻りリンク

## 4. 本文管理方式: MDX ではなく辞書データ + コンポーネント

MDX 3 ファイル方式も可能だが、以下の理由で **TS 辞書オブジェクト + 汎用レンダリングコンポーネント** を採用:

| 観点 | MDX 3 本 | TS 辞書 + コンポーネント |
|---|---|---|
| 言語間の構造ズレ検知 | 手動レビュー頼み | 型で強制（steps 数・codeBlock 有無を型レベルで統一） |
| 既存 i18n との一貫性 | 別体系になる | `documentMetadata` と同じ Record<Locale, T> パターン |
| コードブロック/バッジ等の装飾 | 各 MDX に生 HTML | コンポーネント側で統一見た目 |
| 翻訳フロー | ファイル丸ごと差替 | オブジェクトの該当 locale だけ編集 |

将来ページ数が増えたら content collection 化を再検討する（現時点では YAGNI）。

### データ構造

```ts
// src/i18n/tutorial-eizouden.ts （新ファイル）
export interface TutorialStep {
  title: string;        // ステップ見出し（1 文）
  body: string;         // 説明文（複数文 OK・\n\n で段落分割）
  code?: string;        // コピーして貼るコマンド（任意）
  codeNote?: string;    // コードの下の補足（「これを実行すると…」）
  tip?: string;         // 💡 補足ボックス（任意）
}

export interface TutorialContent {
  metaTitle: string;
  metaDescription: string;
  lead: string;                       // ページ冒頭の 1 行
  prerequisitesHeading: string;
  prerequisites: string[];            // 「はじめる前に」箇条書き
  windowsHeading: string;
  androidHeading: string;
  windowsSteps: TutorialStep[];
  androidSteps: TutorialStep[];
  nextHeading: string;
  nextBody: string;
}
export const tutorialEizouden: Record<Locale, TutorialContent>;
```

## 5. コンテンツ内容（各言語で同構造・下記は論理内容）

> **配布バージョンについて:** このページの短縮コマンド（entei.gorakudo.org/eizouden-install.*）は GitHub API（`/repos/GoRakuDo/entei/releases/latest`）を経由して最新の安定版（stable）リリースへ自動追従します。バージョン固定なし・リリース毎の更新不要です。将来チャンネル分離が実装された後は明示的なチャンネル選択へ拡張される可能性があります（docs/EIZOU_DENDENSHI.md「配布チャンネル分離」参照）。

### Windows (x64) — 5 ステップ

1. **PowerShell を開く**
   スタートボタン → 「powershell」と入力 →「Windows PowerShell」をクリック。（黒い画面が出れば OK）
2. **インストールコマンドをコピーする**
   下のコードをコピー（右側のコピーボタン or ドラッグして Ctrl+C）:
   `irm https://entei.gorakudo.org/eizouden-install.ps1 | iex`
3. **PowerShell に貼り付けて Enter**
   右クリックで貼り付けできる。自動でダウンロードと署名確認が始まる（1〜2 分）。
   💡 「署名確認」= 本物のプログラムかどうかを機械的にチェックすること。改ざんされていたら途中で止まるので安心。
4. **「Done」的な完了表示を待つ**
   最後に `grkd-edds` というコマンドで起動できる、と表示されれば成功。
5. **起動してペアリングコードを確認**
   `grkd-edds` を実行 → 画面に 8 桁程度のコードが出る。これを次のステップで Entei に入力する。

### Android (Termux, arm64) — 6 ステップ

1. **Termux を入れる**
   F-Droid から「Termux」をインストール（Play Store 版は古いので使わない）。
2. **Termux を開く**
   黒い画面（ターミナル）が出る。驚かなくて大丈夫。
3. **インストールコマンドをコピーする**
   `curl -fsSL https://entei.gorakudo.org/eizouden-install.sh | bash`
4. **貼り付けて実行**
   Termux 画面を長押し → Paste → Enter。ダウンロードと署名確認が自動（数分）。
5. **起動する**
   `grkd-edds` を実行。
6. **ペアリングコードを確認**
   画面に出たコードを Entei の設定（Companion 接続）へ入力して完了。

### 「次のステップ」（共通）

Entei サイト → 設定（歯車）→ Companion 接続 → コード入力。これで YouTube / Magnet がローカル再生できるようになる。

> **注意書き（全プラットフォーム共通・security トーン統一）:** インストール中に警告が出たら絶対に続行しない。コマンドはこのページ（entei.gorakudo.org）からコピーする。GitHub の latest release から動的に取得される署名付き bootstrap へ委譲される。

## 6. UI コンポーネント

新規: `src/components/home/TutorialSteps.astro`

- props: `{ steps: TutorialStep[] }`
- 各ステップ = カード（既存 `.entei-thanks-to-card` 系の surface token 流用）:
  - 左に番号バッジ（円形・accent 背景）
  - タイトル（display font・bold）
  - body（`\n\n` で split → `<p>` 複数）
  - code がある場合: `<pre><code>` + コピー button（navigator.clipboard、フォールバック無し・失敗時は選択可能テキストのまま）
  - tip がある場合: 左ボーダー強調の note box（💡 prefix は CSS ::before でなく本文に含める。絵文字はユーザー指示時のみ方針のため、tip box 自体は色とアイコン Lucide `Lightbulb` で表現）
- プラットフォーム見出し（windows/android）はページ側で `id` アンカー付き h2

コピー button の a11y: `aria-label={dict 由来の "Salin perintah"}`、コピー後 `Copied!` ラベルへ 2 秒切替。3 言語文言を TutorialContent に追加（`copyLabel`, `copiedLabel`）。

## 7. i18n / メタデータ

- `documentMetadata` には触れない（Home 専用のまま）。SeoHead オーバーライド prop に TutorialContent.metaTitle/metaDescription を渡す。
- **SEO 方針（2026-08-26 インタビュー確定）:** index,follow で公開する（noindex は player のようなアプリ画面向けの措置で、手順書ドキュメントは検索流入が目的に合う）。sitemap へ 3 ページ分 + hreflang (id/ja/en) を掲載する。
  - 例 ja: `Entei — EizouDendenshi の入れ方` / description: 「Windows と Android に EizouDendenshi を入れる手順を、やさしい言葉で説明します。」
- 言語切替リンクは `<a hreflang>` + `aria-current` 付き。hreflang 属性は SEO 上は任意だが付与（コスト 0）。

## 8. 実装フェーズ

| Phase | 内容 | 完了条件 |
|---|---|---|
| **T1: データ+コンポーネント+sitemap** | `tutorial-eizouden.ts` 辞書 3 言語 + `TutorialSteps.astro` + 動的ルート page + astro.config.mjs の sitemap filter 拡張（3 tutorial URL 追加・hreflang i18n 設定・lastmod 固定値の見直し） | check/build green・3 URL 生成確認・sitemap に 3 URL × hreflang 出力 |
| **T2: コピー button + polish** | clipboard copy・copied state・tip box スタイル | 手動 QA（Chrome）|
| **T3: レビュー+公開** | code-reviewer APPROVE → commit/push → GA deploy | 本番 3 URL 到達確認 |

T1+T2 を 1 回の Executor ハンドオフで実施、T3 は通常フロー。

## 9. 検証チェックリスト（実装後）

- [ ] `dist/id-tutorial/eizoudendenshi/index.html` / `ja-` / `en-` の 3 ファイル生成
- [ ] 各 `<title>` が locale 固有（Home 重複なし）
- [ ] 言語切替リンクが相互に正しい URL を指す
- [ ] コードブロックの文字列が 3 言語で完全一致（URL の typo = インストール壊れるため、単一ソースから展開）
- [ ] コピー button 動作（clipboard 書き込み + Copied 表示）
- [ ] 中学生語彙チェック: minisign/DPAPI/bootstrap/signature 等の出現回数 = 0（やさしい言い換えのみ）
- [ ] a11y: 番号バッジが aria-hidden、ステップ構造が ol/li、コピー button に aria-label
- [ ] レスポンシブ: 375px 幅でコードブロック横スクロール可（overflow-x）
- [ ] インストールコマンドの URL が短縮ドメイン（entei.gorakudo.org/eizouden-install.*）を指し、最新 stable へ自動委譲される
- [ ] dist/sitemap*.xml に 3 tutorial URL が載り、hreflang alternates が出力される

## 10. 将来拡張（スコープ外・メモ）

- 配布チャンネル分離実装後（docs/EIZOU_DENDENSHI.md「配布チャンネル分離」）、本ページのインストール手順と更新案内を明示的な channel 選択対応版へ改訂する。現行はラッパーが GitHub API（`/releases/latest`）から最新 stable を自動解決する仕組みとなっており、channel 分離実装までこの運用を継続する。

- スクリーンショット画像の埋め込み（画像は重いのでテキスト先行）
- FAQ セクション（エラー時の対処）
- 他チュートリアル（Player の使い方等）への汎化 → その時点で content collection 化を再検討
