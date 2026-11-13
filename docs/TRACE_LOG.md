# TRACE_LOG.md — ユーザー操作 → システム反応のジャーナル

「誰が・いつ・どの画面で・何を押して・システムがどう反応したか」を、あとから
ファイル1つで再生できるレベルで記録する仕組み。不具合報告を記憶ではなくログから
追跡するための基盤で、機能そのものではありません。

対象は Home（Feeds）・Profile・Player・Audio Player・Modules の全画面と、
Tauri IPC・コンパニオン通信（HTTP）。

---

## 1. 保存先とローテーション

| 項目 | 値 |
| --- | --- |
| ディレクトリ | `<app_log_dir>/traces/` |
| Windows | `%LOCALAPPDATA%\org.gorakudo.entei\logs\traces\` |
| macOS | `~/Library/Logs/org.gorakudo.entei/traces/` |
| Linux | `$XDG_DATA_HOME/org.gorakudo.entei/logs/traces/` |
| Android | `<app data>/logs/traces/` |
| ファイル名 | `trace-YYYY-MM-DD.log`（UTC の日付ごと） |
| 形式 | JSONL（1行 = 1 JSON オブジェクト） |
| 保持 | 24時間。超過したファイルは自動削除 |

ローテーションの実体（`src-tauri/src/trace.rs`）:

- 書き込み時に、ディレクトリ内の `trace-*.log` の **mtime が24時間より古い**ものを削除する。
  当日ファイルは常に新しいので残り、前日ファイルは丸24時間経過した時点で消える。
- 掃除は最大1分に1回（`PURGE_INTERVAL_MS`）に間引く。全バッチで `read_dir` しない。
- 起動時にも1回掃除する（`trace::purge_on_startup`）。アプリを開いたまま何も
  操作しなくても前日分が残り続けることはない。
- `trace-` で始まり `.log` で終わるファイル以外は絶対に触らない。

1行の上限は 8 KiB。超えたエントリは `area` / `event` だけ残し `data` を
`{"truncated": true}` に差し替える（壊れた JSON 行を作らないため）。
`area` / `event` は96文字で文字単位に切る（UTF-8 を割らない）。

### 読み方

```powershell
# 直近の再生エラーだけ
Select-String -Path "$env:LOCALAPPDATA\org.gorakudo.entei\logs\traces\trace-*.log" -Pattern '"event":"media_error"'

# 1セッション分を抜き出す（sid はエントリごとに入る）
Select-String -Path "$env:LOCALAPPDATA\org.gorakudo.entei\logs\traces\trace-*.log" -Pattern '"sid":"s1a2b3c4"'
```

---

## 2. フロントエンド（`apps/web/src/features/trace/trace-logger.ts`）

```ts
trace('player', 'seek', { from: 12.4, to: 88.1 });
traceError('player', 'media_error', error, { name: 'ep01.mkv' });
await traceSpan('ipc', 'stream_youtube', () => streamYouTubeDirect(url));
```

- `trace(area, event, data?)` — 意味のある操作を記録する。
- `traceError(area, event, error, data?)` — 失敗を Error ごと記録する。
- `traceSpan(area, event, fn)` — Promise を包み、成功/失敗と所要msを記録する。
- `tracedInvoke(cmd, args)` — Tauri コマンドを実行しつつ IPC を記録する。
- `traceModule(moduleId, event, data?)` — モジュール自身のイベントを記録する
  （`area: 'module'` + `data.module: moduleId`）。書き込むかどうかはモジュール側の
  判断で、Yomitan は `general.debugInfo`（設定の「Show debug information」）が
  ON のときだけ書く（`features/yomitan/yomitan-preferences.ts` の `traceYomitan()`）。
  `general.showAdvanced` / `general.showDebug` はホストが常に ON に固定し、
  設定UIからは非表示（`LOCKED_OPTION_PATHS`）。

area の対応（`modules` と `module` は別物なので混同しない）:

| area | 誰が書くか |
| --- | --- |
| `modules` | Modules ページのUI操作（トグル、ダッシュボード表示） |
| `module` | モジュール本体が自分自身について書く（`data.module` で判別） |

送信は 0.8 秒ごとのバッチ（最大64件）で `trace_log` コマンドへ。キューは500件で
頭から捨てる（`getTraceDroppedCount()` で件数を確認できる）。書き込み失敗時は
1回だけ再キューし、2回失敗したら諦めてコンソールに落とす — トレースが本体を
止めることはない。

ブラウザ単体ビルド（Tauri 外）には書き込み先が無いため、メモリ上のリング
バッファ（`window.__enteiTrace.recent()`）とコンソール1行サマリにフォールバックする。

### 秘匿情報

`data` は必ず `sanitize()` を通る。

- キー名が `token|secret|password|apikey|api_key|authorization|cookie|credential`
  → 値は `[redacted]`。
- 文字列内の `token=…` / `key=…` など → `[redacted]` に置換。
- `magnet:?…` は `xt=urn:btih:` の先頭12桁（short infohash）だけ残し、`dn` / `tr` /
  `xs` など**すべてのパラメータ値を `[redacted]`** にする。私設トラッカーの
  passkey（`&tr=https://user:PASSKEY@…`）と完全な infohash はファイルに残らない
  （Rule #1771）。`tracedInvoke` の引数も同じ `sanitize()` を通るので、
  `plugin:torrent|add_torrent` の `magnetUri` も同じ扱いになる。
- 文字列は300文字、配列・オブジェクトは40要素、深さ4で打ち切る。
- コントロールのラベル（`aria-label` / `title` / テキスト）は60文字で切る。
  字幕ブロックのようにラベルが字幕全文になる要素でも本文は残らない。
- `Error` は `{ name, message }` に畳む。

コンパニオンの capability token、Nadeshiko / jimaku の API キー、cookies.txt の
内容はファイルに残らない。

### 自動レイヤー（`src/scripts/trace-boot.ts` が両レイアウトで install）

`BaseLayout`（Home / Profile / Modules）と `PlayerLayout`（Player / Audio Player）が
`trace-boot.ts` を読み込むため、island が `trace()` を呼ばなくても以下は記録される。

| レイヤー | 記録内容 |
| --- | --- |
| `ui` click | 押されたコントロールのラベル（`data-trace` → `aria-label` → `title` → テキスト、60文字で切る）、tag、id、route |
| `ui` key | 修飾キー以外のキー入力。テキスト入力欄の中身は記録しない |
| `companion` http | method、path（origin とクエリは捨てる）、status、所要ms、失敗理由。同じ (method, path, status) は5秒に1回まで（ポーリングで埋めない）。失敗は常に記録 |
| `ipc` invoke | コマンド名、引数（sanitize済）、所要ms、成否 |
| `app` | `boot`、`pagehide`、`visibility`、`popstate`、`window_error`、`unhandled_rejection` |

IPC は `__TAURI_INTERNALS__.invoke` を差し替えず、`tauri-bridge.ts` 経由の
`tracedInvoke` で記録する（Tauri は `invoke` を `Object.defineProperty` で
非 writable に定義するため、ページ側からは monkey-patch できない）。

### Tauri コマンド（`src-tauri/src/trace.rs`）

| コマンド | 役割 |
| --- | --- |
| `trace_log(entries)` | エントリのバッチを追記する（`async`、UI スレッドを塞がない） |
| `trace_dir_path()` | 実際のログディレクトリを返す（QA・サポート用） |

アプリ内コマンドなので `capabilities/default.json` の追加権限は不要
（Tauri v2 は `invoke_handler` 登録コマンドを既定で許可し、ACL は
`tauri_build::AppManifest` を定義した場合にのみ適用される）。

---

## 3. 明示イベント一覧

### Home（Feeds）

| event | 主な data |
| --- | --- |
| `feed_ready` | posts / likes / comments 件数、プロフィール名の有無 |
| `post_publish` | postId、本文長、投稿者、累計件数 |
| `like_toggle` | postId、liked、累計いいね数 |
| `post_open` / `post_close` | postId |
| `comment_publish` | postId、commentId、本文長、スレッド件数 |
| `share` | postId、成否 |
| `new_posts_click` | 採用件数、累計件数 |
| `refresh` / `load_more` | 件数、ステップ |

### Profile

| event | 主な data |
| --- | --- |
| `tab_change` | tab（`stats` / `history`） |
| `history_load_start` / `history_load_complete` | 総件数と source 別内訳 |
| `history_load_failed` | Error |
| `history_load_more` | source、表示済み件数、総件数 |
| `history_card_open` | mediaId、source、title |

### Player

| event | 主な data |
| --- | --- |
| `mount` | Tauri 判定、viewport |
| `media_select` / `media_select_rejected` / `media_select_blocked` | ファイル名、種別、MIME、サイズ、拒否理由 |
| `subtitle_select` / `subtitle_select_rejected` | ファイル名、サイズ、拡張子 |
| `magnet_dialog` | open |
| `magnet_submit` | 成否、desktop/companion、長さ、トラッカー有無 |
| `magnet_play_click` | videoId、字幕有無、モード |
| `magnet_job_accepted` | jobId、ファイル名、音声/字幕トラック番号、direct か |
| `youtube_submit` | 成否、モード、videoId、品質 |
| `youtube_stream_accepted` / `youtube_stream_rejected` | videoId、タイトル、duration、日本語字幕の有無、拒否理由 |
| `media_loaded` | ファイル名、duration |
| `play` / `pause` | 再生位置 |
| `seek` | from → to、playMode（スライダー・字幕クリック・モード由来の跳びをすべて拾う） |
| `ended` | ファイル名、duration |
| `cue_click` | cueId、start/end、クランプ有無、ストリーミング有無 |
| `playback_rate` / `play_mode` | 変更前後 |
| `media_error` | ファイル名、位置、メッセージ |
| `mine_start` | cueId、範囲、行マイニングか、ファイル名 |
| `export_start` / `export_success` / `export_failed` / `export_aborted` | mode、deck、ノートタイプ、タグ数、素材の有無 |

### Audio Player

`file_select` / `file_rejected` / `youtube_submit` / `seek` / `ended` / `error`。

### Modules

| event | 主な data |
| --- | --- |
| `dashboard_ready` | 起動時の有効状態、インポート可否（現状は常に false） |
| `module_toggle` | moduleId、切替後、有効件数 |

### Module（`area: 'module'`、`general.debugInfo` が ON のときだけ）

| event | 主な data |
| --- | --- |
| `settings_hydrated` | source（`db` / `cache`）、profile 数 |
| `settings_hydrate_failed` | Error（DB を読めずキャッシュで継続） |
| `settings_read_failed` | Error（localStorage が壊れている／使えない） |
| `settings_cache_failed` | Error（localStorage に書けない） |
| `settings_mirror_failed` | Error（SQLite へのミラー失敗、localStorage は正） |

---

## 4. 拡張するとき

1. 画面固有の意味を持つ操作は `trace('<area>', '<event>', {...})` を明示的に置く。
   自動レイヤーは「押した」しか分からない。
2. `data` には id・件数・成否・所要ms を入れる。本文やタイトルは短く切って入れる。
3. 秘密情報は自分で消さない。`sanitize()` が落とすので、キー名を素直に書けばよい。
4. 新しい area を足すときは `TraceArea` に追加し、この表も更新する。

---

## 5. テスト

- `src-tauri/src/trace.rs` の `#[cfg(test)]`
  - 日付スタンプ、ラベル切り詰め、巨大ペイロードの縮退、
  - **実ディレクトリへの JSONL 追記**（行数・ts 補完・追記で truncate しないこと）、
  - **24時間超過ファイルだけを消す**（当日ファイルと無関係ファイルは残る）。
- `apps/web/tests/trace-logger.test.ts`
  - `sanitize()` の秘匿キー/URL/長さ/Error 処理、
  - キューの上限と破棄件数、`routeArea()` のルート対応、
  - `traceModule()` の area / `data.module` タグと sanitize。
- `apps/web/tests/yomitan-preferences.test.ts`
  - `general.debugInfo` OFF では 1 行も書かない、ON で `area: 'module'` を書き、
    API キーは `[redacted]` になること。
