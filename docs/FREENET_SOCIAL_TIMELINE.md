# FREENET_SOCIAL_TIMELINE — 分散型イマージョンSNS ＆ プラットフォーム計画

> **状態:** 第1フェーズ設計確定
> **対象:** Entei ホーム（`/`）、Freenet P2P分散ネットワーク連携、および全4フェーズ計画
> **方針:** 中央集権サーバーを一切持たず、P2P（Freenet）上で世界中の学習者が学習記録・採掘成果・感想を共有できる検閲耐性SNSプラットフォームを構築する。

---

## 1. 全体ロードマップ（全4フェーズ計画）

- **第1フェーズ【分散SNSホーム ＆ Freenet基盤】（本仕様）**
  - ホーム画面（`/`）を「みんなのイマージョンタイムライン」に刷新。
  * Freenetコントラクトと連携し、サーバーレス・P2Pで学習活動（視聴・採掘・投稿）を分散同期。
- **第2フェーズ【Tauriアプリ化 ＆ EizouDen Rust統合】**
  - デスクトップ（Windows/Mac/Linux）およびAndroid（APK）向けTauri v2基盤を構築。
  - 外部Goバイナリ（Sidecar）を廃止し、動画取得・ストリーミングエンジンをRustネイティブに統合（単一実行ファイル/単一APK化）。
- **第3フェーズ【開発者向けモジュール機構 ＆ Yomitanプラグイン】**
  - Obsidian風のTypeScriptプラグイン仕組み（`manifest.json` + `main.js`）を開通。
  - 公式第1号プラグインとして `@gorakudo/yomitan-headless` を内蔵し、字幕ホバー辞書検索・採掘をプラグイン化。
- **第4フェーズ【ネイティブAnkiDroid直結 ＆ プラットフォーム公開】**
  - Android版にて、ContentProvider（`FlashCardsContract`）を直叩きするプラグインを実装。HTTPサーバー不要・1タップ直接採掘を実現。
  - 一般開発者向けプラグイン公開・コミュニティマーケットプレイスを解禁。

---

## 2. 第1フェーズ：分散型イマージョンSNSホーム（`/`）設計

### 2.1 目的
従来の静的なランディングページから、アプリを開いた瞬間に世界中の日本語学習者の生きた活動がリアルタイムに流れる「没入型ソーシャルフィード」へと生まれ変わらせる。

### 2.2 フィードに流れる3種類のカード種別

1. **イマージョン視聴カード (`ImmersionSessionCard`)**
   - 誰が・何の作品を・何分間視聴したかを自動またはワンタップで共有。
   - 表示要素: ユーザーアバター、ユーザー名、作品タイトル、エピソード番号、ポスター画像、視聴時間（例: `42分間イマージョン達成`）、視聴日時。
2. **採掘（Mining）成果カード (`MinedSentenceCard`)**
   - 学習者が作品からAnkiへ採掘したセリフ・表現を共有（他の学習者にとっても有益なi+1例文になる）。
   - 表示要素: ユーザーアバター、ユーザー名、採掘単語、対象セリフ文、作品名、タイムスタンプ、（可能であれば音声プレビュー）。
3. **学習者ポスト・感想カード (`CommunityPostCard`)**
   - 作品の感想や学習の気づきを自由に投稿（最大360文字）。
   - 上部の投稿フォーム（`FeedComposer`）から直接投稿可能。

### 2.3 UIレイアウト構造（OKLCHデザイン準拠）

- **デスクトップ (≥768px)**:
  - 2カラムまたは3カラムレイアウト：
    - **中央メインカラム**: 投稿作成フォーム（`FeedComposer`）＋ 無限スクロールSNSタイムライン（`TimelineFeed`）。
    - **サイドカラム**: 自分の本日のイマージョンサマリー、クイックプレイヤー起動ボタン、トレンド作品一覧。
- **モバイル (<768px)**:
  - 1カラムの縦長SNSレイアウト。上部にクイック投稿バー、下にカードフィード。下部には既存の浮遊Pillドック（`DestinationDock`）を維持。

---

## 3. Freenet P2P分散同期アーキテクチャ

### 3.1 ゼロサーバー・プライバシー原則
- 企業や中央管理者が運営するリレーサーバー・データベースは一切設置しない。
- ユーザーアカウントは「ログイン/パスワード」ではなく、ローカルの公開鍵/秘密鍵ペア（またはFreenetのコントラクトアドレス）で自律的に識別する。
- すべての投稿・視聴記録・プロフィールはFreenetのStateとしてネットワーク全体にゴシップ（分散共有）される。

### 3.2 コントラクト設計

1. **ユーザープロフィール・コントラクト (`UserProfileContract`)**
   - 各ユーザー固有のState。`name`、`bio`、`avatar`、公開鍵署名を保持（`docs/PROFILE.md` のデータモデルをFreenet Stateへマッピング）。
2. **タイムライン・インデックス・コントラクト (`TimelineFeedContract`)**
   - コミュニティ全体の最新投稿・アクティビティ参照ハッシュのリングバッファ（最新N件の投稿IDリスト）。
   - 各ノードが購読（`subscribe`）し、新しい活動が書き込まれるとP2Pで即時リアルタイム通知される。

### 3.3 クライアント接続レイヤー
- **Web環境**: `@freenetorg/freenet-stdlib` SDKを用い、ローカルノード（WebSocket API）と通信。ノード未起動時のフォールバックとしてローカルキャッシュフィードを表示。
- **Tauri環境（第2フェーズ以降）**: Tauriアプリ内部でRustクライアント（または埋め込みFreenetノード）が透過的に接続し、完全ゼロ設定で稼働。

---

## 4. 既存サブシステムとの統合

- **`docs/PROFILE.md`**: ローカルの `entei.profile.v1` をFreenetの `UserProfileContract` と相互同期可能にする。
- **`docs/AUDIO_PLAYER.md` & `PlayerApp.tsx`**: 視聴セッション完了時、およびAnki採掘完了時に、本人のオプトイン設定（「タイムラインに共有する」トグル）に基づき自動的にフィードカードを生成してコントラクトへプッシュする。
- **`docs/NAVIGATION_BAR.md`**: TopBar および DestinationDock の「Home」を「Timeline / ホーム」として位置づけを更新する。

---

## 5. 実装記録（第1フェーズ UI 先行分）

モックアップ（コンポーザー＋タイムライン）に基づく UI を Home に実装した。ネットワーク同期はまだ無く、投稿は端末内に留まる。

| 追加ファイル | 役割 |
| --- | --- |
| `apps/web/src/components/home/TimelineFeed.tsx` | Home の React 島。コンポーザー（`FeedComposer` 相当）＋投稿リスト（`TimelineFeed` 相当）を1アイランドで担当 |
| `apps/web/src/features/timeline/timeline-store.ts` | 型・シード投稿・`entei.timeline.v1` 永続化・相対時刻整形・ハンドル生成 |
| `apps/web/src/styles/timeline.css` | OKLCH トークンのみ使用した見た目（区切り線は `oklch(1 0 0 / 0.1)`） |
| `apps/web/tests/timeline-store.test.ts` / `timeline-feed.test.tsx` | 純ロジックと島の振る舞い |

- **配置**: `apps/web/src/pages/index.astro` は旧ヒーロー・Roadmap・ThanksTo・LocalFirstNote・Footerを撤去し、`<TimelineFeed client:load />` のみをレンダリング。デスクトップは中央寄せ読み列（最大 42rem）、モバイルは共有ガター（1rem）で端まで使う。
- **UI調整（2026-11-04）**: アバターフレームを尖った六角形から滑らかな「角丸六角形（SVG ベジェ曲線 clipPath）」に変更。アクションボタン・Publishボタンの高さをすっきり引き締まった 32px（Pill型）に統一し、左右パディング（16px / 24px）でバランスを最適化。Home の下部余白（padding-bottom）を縮小し、`showFooter={false}` でフッターを非表示化。
- **永続化**: ローカル投稿と Like 状態のみ `entei.timeline.v1` に保存。シード投稿はコード側に残すため、コピー変更が既存ユーザーにも反映される。
- **状態**: `Like` はトグル＋永続化、`Share` は投稿本文をクリップボードへコピー、`Comment` は返信 UI が未実装のためコンポーザーへフォーカスする（死んだボタンを作らないため）。
- **i18n**: `Dictionary.timeline` を id/ja/en に追加。相対時刻は `Intl.RelativeTimeFormat` に任せ、単位名の翻訳キーを持たない。
- **フィード挙動（2026-11-04 追加）**: ① **最新順** — `mergeTimelinePosts` はローカル投稿とシードを結合した全件を `createdAt` 降順で厳密にソートする（配列位置ではなく実時刻。同時刻は安定ソートでローカル→シード）。② **Pull-to-Refresh（モバイル）** — ページ最上部でフィードを下へ引くと指の移動量に追従してインジケータが開き（上限 96px）、`PULL_REFRESH_THRESHOLD = 60px` を超えて離すとストア再読込（`now` 更新・localStorage 再同期・先頭 5 件にリセット）が走る。タッチリスナーは `passive: false` で張り、引いている間だけ `preventDefault()` する。③ **無限スクロール** — 初期表示 `INITIAL_VISIBLE_POSTS = 5` 件、フィード末尾の sentinel（`<ul>` の外・`aria-hidden`）が `IntersectionObserver`（`rootMargin: 200px`）で見えたら `LOAD_MORE_STEP = 5` 件ずつ追加し、全件表示後は `entei-timeline-end` の終端ラベルを出す。④ **デスクトップ新着ポーリング** — `NEW_POSTS_POLL_INTERVAL_MS = 30_000` の間隔と他タブの `storage` イベントでストアを差分チェックし（`matchMedia('(min-width: 768px)')` が真のときのみ）、未表示の投稿は画面へ流し込まずコンポーザー直下のピル `entei-timeline-new-posts`（`新しいポストを{n}件表示`）に留める。クリックで採用して `window.scrollTo({ top: 0, behavior: 'smooth' })` により先頭へ戻る。現時点のポーリング元はローカルストアだが、このフックが後続フェーズの Freenet 同期の差込口になる。
- **未実装（意図的）**: `ImmersionSessionCard` / `MinedSentenceCard`、サイドカラム（本日のイマージョン概要・トレンド作品）、Freenet コントラクト同期。いずれも後続フェーズ。

### 既知の指摘（Known issues / Low findings）

プロジェクト規約（#1772）により記録：
1. `timeline-store.ts` の破損ポスト個別フィルタリング（`filter(isTimelinePost)`）および `<ul>` の `role="list"` に対する専用単体テストケースが未追加（実装自体は修正完了済み・動作確認済み）。次回テスト拡充時にアサーションを追加する。
2. タイムラインのアクションボタン（Comment/Like/Share/Publish）はユーザー指定により `min-height: 32px` に統一（プロジェクトの一般的な 44px タッチ規約より視覚的なコンパクトさを優先、WCAG 2.2 AA の 24px は上回る）。
3. 旧Home専用コンポーネント（`HubIdentity.astro` / `DestinationDock.astro` / `LocalFirstNote.astro` / `future-features.mdx`）は参照ゼロのファイルとして残存（削除はユーザー確認後に実施）。
4. `TimelineFeed.tsx` の pull-to-refresh 表示で、`aria-live="polite"` が `aria-hidden` 切り替えと同居しているため、スクリーンリーダーの読み上げが一部環境で不安定になる余地がある。将来のアクセシビリティ見直し時に常設の `role="status"` を `sr-only` に分離する。
