# PROFILE — ローカルデバイスプロフィール

> **状態:** 設計整理（実装は別タスク）
> **対象:** Entei の `/profile/` ページ
> **スコープ:** 現在はこのブラウザ／デバイス内だけで完結するプロフィール。Freenet 同期は後回し。

## 1. 目的

`/profile/` は、Entei を使う人が自分のローカルデバイス上のプロフィールを確認・編集するためのページである。

この段階ではアカウント、サーバー保存、Freenet 同期を導入しない。プロフィール情報は利用中のブラウザの localStorage に保存し、同じデバイス上の Entei で再利用する。

## 2. データ仕様

### 2.1 保存先

- localStorage key: `entei.profile.v1`
- 保存形式: JSON
- 保存データ:

```ts
interface LocalProfile {
  schemaVersion: 1;
  name: string;
  bio: string; // 最大360文字（JS .length 基準、超過分は貼り付け時に切り詰め）
  avatar: string; // `/avatars/N.webp` または image data URL
}
```

`avatar` は通常 `/avatars/1.webp` から `/avatars/15.webp` までのいずれかのパスを保持する。画像をアップロードした場合は、クライアント側で256px正方形にcover-crop・縮小した `data:image/...` を保持し、デコード後のサイズは約200KB以下に制限する。`schemaVersion` と key は維持し、旧形式の `avatar: number` は読み取り時に対応する `/avatars/N.webp` へ移行して保存し直す。

### 2.2 初回作成

プロフィールがまだ保存されていない初回アクセス時は、次の値を生成して直ちに保存する。

- `schemaVersion`: `1`。
- `name`: `Kitsune-XXXX` のような形式のランダム名。末尾4文字はランダムな英数字。
- `bio`: 空文字列。
- `avatar`: `/avatars/1.webp`〜`/avatars/15.webp` からランダムに1つ。

初回生成後は、ページを再読み込みしても同じプロフィールを表示する。保存値が壊れている場合（JSON parse 失敗・avatar の形式不正・bio が文字列でない等）は例外安全に読み、初期値で再生成する（`jimaku-preferences.ts` の読み取り方針に準拠）。旧数値アバターは、schemaVersion 1 のまま対応する bundled path へ移行する。

### 2.3 編集と永続化

- 初期表示は view mode とし、名前（大きく表示）・bio（空文字列なら何も描画しない）を表示する。
- 「編集」から edit mode に入り、名前 Input・保存/キャンセル操作、bio textarea・文字数カウンター、アバターUIを表示する。保存または閉じると view mode に戻る。
- edit mode ではアバター全体の暗いオーバーレイ（中央の `ImageUp` アイコン）をクリックして `accept="image/*"` の file picker を開く。view mode のアバターは静的に表示する。
- 選択画像はブラウザ内の canvas で最大256px正方形のcover-cropに変換し、約200KBを超える場合は保存せずエラーを表示する。
- 名前、自己紹介、アバターの変更は、ローカルデバイス内でのみ永続化する。

## 3. 画面構成

ページは次の2段構成とする（元モックは一時ファイルのため本文にワイヤーフレームを残す）。

```text
+----------------+  ユーザー名
|                |  自己紹介文（最大360文字）
|  アバター正方形  |
|                |
+----------------+
+----------------------------------+------------------+
|  イマージョン統計（選択中）      |  コンテンツ履歴  |
+----------------------------------+------------------+
```

### 3.1 上段: プロフィールヘッダー

- 初期表示は view mode。左側に正方形のアバター、右側に大きなユーザー名と右上のアイコン付き「編集」ボタン、空でなければ最大6行の自己紹介文を表示する。
- 「編集」ボタンで edit mode に切り替え、名前・自己紹介・アバターを同じプロフィールヘッダー内から編集できる。
- アバター候補15個のグリッドは表示しない。edit mode ではアバター全体のオーバーレイから画像を選択し、view mode ではアバターを静的に表示する。

### 3.2 下段: 2つのタブ

1. **イマージョン統計**
   - 既存の Tracker Dashboard を表示する。
2. **コンテンツ履歴**
   - 視聴済み作品のポスターを並べた MyAnimeList 風グリッドを表示する。
   - 各カード: ポスター画像・作品名・最終視聴話数・最終視聴日。クリックで詳細は開かない（v1）。
   - データ源は §7 の視聴履歴ストア。ポスターURLは §8 の外部取得で解決し、IndexedDB にキャッシュする。

## 4. ルートとナビ

- `/profile/` は noindex のプロフィールページで、desktop TopBar の pill では **Profile → Player → Settings** の順に Profile destination として表示する。
- モバイル Dockには Profile を追加しない。Dockの順序は Home → Player → Settings を維持する。
- 旧 `/tracker/` は独立ページとして廃止し、静的 noindex redirect で `/profile/` へ誘導する。既存ブックマークや古いリンクを404にしない。

## 5. `/tracker/` との関係（統計データの要約）

TrackerDashboard は独立した `/tracker/` ページから退役し、プロフィールページの「イマージョン統計」タブに常駐する。`/tracker/` は `/profile/` への redirect のみを提供する。

`/profile/` の「イマージョン統計」タブでは、統計ロジックを複製せず、既存の `TrackerDashboard` またはその `useTrackerDashboard` hook を再利用する。これにより、プロフィール内タブが既存のローカル記録を同じ read model から表示できる。

```text
/player/ の再生記録（実視聴・教材進行・字幕接触を分離計測、詳細は IMMERSION_TRACKER.md §2）
  → ブラウザ内 IndexedDB のみ保存（サーバー送信なし、詳細は §4）
  → /profile/ の「イマージョン統計」タブにある TrackerDashboard（Today 概要・メディア別・i+1 Moments・採掘履歴、詳細は §8）
  → 旧 /tracker/ は /profile/ へ redirect
```

## 6. 将来の別タスク

以下は今回のローカルプロフィール実装には含めない。

- Freenet へのプロフィール接続・同期
- 複数デバイス間のプロフィール共有
- AniList / AniChart とのコンテンツ情報同期
- プロフィールの公開範囲、アカウント、サーバー側保存

これらはローカル保存の境界、同期方式、外部サービス連携の仕様を個別に確認したうえで、別タスクとして設計・実装する。

## 7. 視聴履歴ストア（コンテンツ履歴のデータ源）

- IndexedDB（Tracker と同じ DB、別 object store `watch_history`）に保存する。localStorage には置かない（件数が増えるため）。
- 1レコード: `{ mediaId, title, episode, watchedAt, source: 'local', anilistId | null, tmdbId | null, posterStatus: 'pending' | 'ready' | 'none' }`。v1 はローカルファイルのみを対象とし、job session（Magnet / YouTube）は将来対応に延期する。
- 書き込み時機: `/player/` でメディアを開いた時ではなく、**ある程度再生が進んだ時**（例: 視聴開始から60秒経過または全体の5%到達の早い方）に1回だけ記録し、同一 `mediaId` は `episode`・`watchedAt` を上書き更新する。Tracker の fingerprint（§5要約の mediaId）をそのまま主キーに使い、新しい ID 体系は作らない。
- jimaku 照合で得た `anilist_id` / `tmdb_id` があれば同時に保存する（照合なしでも title + episode だけで履歴には残る）。
- 削除は Tracker の clear 操作に連動させ、単独の全消去ボタンは置かない（v1）。

## 8. ポスター画像の外部取得

- **アニメ**: AniList 公開 GraphQL（`https://graphql.anilist.co`、ブラウザ直叩き・CORS `*` 実測・APIキー不要）。jimaku 結果の `anilist_id` で `Media { title { romaji } coverImage { large } }` を取得する。
- **ドラマ（実写）**: 中継 `https://entei-tmdb-relay.yosiakefas-id.workers.dev`（TMDB APIキー秘匿済み・疎通済み）で解決する。jimaku 結果の `tmdb_id`（`tv:xxxxx` / `movie:xxxxx` 形式）があれば `/tv/:id`・`/movie/:id`、なければ `/search?q=&type=tv|movie` を呼ぶ。画像は公式 CDN（`https://image.tmdb.org/t/p/w185/...`、直リンク実測 200・CORS `*`）を直表示する。
- 取得したポスター URL は `watch_history` レコードに保存し、`<img loading="lazy">` で遅延表示する。失敗時はリトライせず文字カードに倒す（jimaku の 429 方針と同様）。
- レート配慮: ポスター解決は履歴表示時ではなく **記録時（§7）に1回だけ** 行い、結果を保存する。一覧表示では保存済み URL のみ使う。

## 9. 夜の便（取り置き更新・6時間ごと）

- 目的: Cloudflare 無料枠を節約するため、既知作品のポスター解決を同梱 JSON で済ませ、新規分だけ中継に聞く。
- 仕組み: 中継（`entei-tmdb-relay`）に KV（Cloudflare の小さな伝言メモ）を付け、昼の問い合わせ（タイトル・種別・ID）を記録する。6時間ごとの Cron が KV を読み、新規分だけ TMDB に聞いて取り置き JSON（`apps/web/public/data/tmdb-poster-cache.json`、Entei 倉庫に同梱）に書き足す。
- 表示順: 同梱 JSON → なければ中継 → どちらもなければ文字カード。JSON に載った分は中継を使わない。
- KV に入れるのは作品の問い合わせ情報のみ（APIキー等の秘密は入れない）。無料枠（読み取り1日10万）で足りる見込み。

## 10. 履歴グリッドの2段構成（アニメ・ドラマ＋YouTube）

- 上段「アニメ・ドラマ」: `source: 'local'` を1つの展示欄にまとめる。初回表示はデスクトップ15件（5列×3行）・モバイル6件（2列×3行）、超過分は Load More ボタンで追加表示する。
- 下段「YouTube」: `source: 'youtube'` の展示欄。初回表示はデスクトップ6件（3列×2行）・モバイル6件（1列×6行）、超過分は Load More で追加表示する。サムネは公式 `https://i.ytimg.com/vi/{videoId}/hqdefault.jpg`（鍵不要・直表示）、videoId は視聴 URL から抜く。タイトルは `jobTitle` を使う。
- YouTube の記録はローカルと同じく再生が進んだ時に1回だけ（60秒または5%）。`mediaId` は `youtube:{videoId}` とし、Tracker fingerprint とは別体系にする。

## 11. 作品別セッション棚（履歴カード → Drawer 詳細）

- 1回の区切り: プレイヤーから離れる・タブを閉じる・リフレッシュ・ファイル替えの4つ。一時停止や巻き戻しは同じ回の中。
- 記録: `{ sessionId, mediaId, startedAt, endedAt, watchMs, episode, minedSentences: string[] }` を Tracker と同じ DB の別 store `watch_sessions` に貯める。文は時刻で近い回に寄せる。
- 表示: 履歴カードを押すと Drawer（スマホは下から・パソコンは横から）。上段に総回数・総時間、下段に1回ごとの行、行を押すと送った文が出る。クリックは no-op のままだった v1 から詳細化する。
- 将来よその人の棚も同じ Drawer 部品で開く。公開範囲の設計は別タスク。
