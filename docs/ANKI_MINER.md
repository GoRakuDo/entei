# ANKI_MINER — ローカル採掘とAnki Exportの設計

> **状態:** Stage 1（AM-1 / AM-2 / AM-3 / AM-5）コード完了。AM-2 browser QA完了。AM-3: Dialogクリック伝播防止・Preview duration fallback修正済み、browser QA待ち。次はAM-4 Mining Preview。
> **対象:** `Entei/apps/web` の `/player/` React islandだけ。Home、公開配信、Streaming Video Integrationは対象外。
> **前提:** local media・字幕・custom controls・選択可能なplayer内字幕はすでにある。
> **決定日:** 2026-07-22

---

## 1. 人間語でいうANKI_MINER

動画の一文を選んで、静止画・音声・文章をその場で確認し、**ユーザーが明示的に押した時だけ**Ankiへ送る段階。

「字幕を見つける」「素材を切り出す」「Ankiへ送る」は別の仕事として扱う。1つのボタンが勝手に全部を行う設計にはしない。

```text
Mine
  → playerを一時停止して対象を固定
  → screenshot / audioをローカル生成
  → Mining Previewで内容を確認・調整
  → Exportをユーザーが明示操作
  → canAddNotes
  → addNote
  → mining前のplayer状態へ戻す
```

## 2. このPhaseを作る理由

元proposalの最初のMVPは、local video / SRT / subtitle listに加えてScreenshot、Audio Clip、AnkiConnect、Deck・Field保存、`addNote`までをPhase 1に置いている。

一方、現在の `PLAYER_PHASES.md` は素材生成をP3、AnkiConnectをP4に分けている。この分割は技術的には正しいが、最初に「実際に1枚カードを作る」まで到達するには遠い。

ANKI_MINERは、元MVPの残りを安全な順序でまとめ直すPhaseである。

| 元proposalの残り    | ANKI_MINERでの扱い                            |
| ------------------- | --------------------------------------------- |
| Screenshot          | ローカルJPEG capture                          |
| Audio Clip          | capability確認済みbrowserでのローカルclip生成 |
| AnkiConnect接続     | read-only設定読込から開始                     |
| Deck・Field設定保存 | active preset 1つをlocalStorageへ保存         |
| addNote             | Previewと`canAddNotes`通過後だけ実行          |

## 3. 確定した設計判断

### 3.1 SettingsはPopoverからModalへ置き換える

現在のSettings iconはkeyboard shortcutだけを表示する小さいPopover。Deck / note type / field mappingは、選択肢・接続状態・エラーを持つためPopoverに収まらない。

Settings iconはshadcn `Dialog`を開く。現在の`Popover`は削除し、shortcut表示はModal内のPlayer tabへ移す。

### 3.2 Modal内は最初は2 tabだけ

```text
Player       再生・keyboard shortcutの参照
Anki Fields  接続、Deck、Note type、field mapping、preset保存
```

Yomitan、annotation、streaming、複数profile、settings import/exportはここへ入れない。未実装の未来設定を空tabとして出さない。

### 3.3 UIはshadcn componentだけで組む

| 役割                            | shadcn component | 現在の状態 |
| ------------------------------- | ---------------- | ---------- |
| Settings / Mining Preview       | `Dialog`         | 導入済み   |
| tab切替                         | `Tabs`           | 導入済み   |
| Deck / Note type / Field選択    | `Select`         | 導入済み   |
| 任意fieldのON/OFF（必要時だけ） | `Switch`         | 追加が必要 |
| field一覧・error一覧の長い領域  | `ScrollArea`     | 導入済み   |
| action                          | `Button`         | 導入済み   |

追加時は `apps/web` からshadcn CLIを使う。`package.json`を手編集してRadix dependencyのversionを推測しない。

### 3.4 最初はactive presetを1つだけ保存する

初期preset名は `Default`。Deck、Note type、field mappingを1組だけ保存する。

複数のnamed preset、切替、import/exportは将来のsettings profile Phaseへ送る。設定がまだ1組しかない時にprofile managerを作らない。

### 3.5 API keyは保存しない

AnkiConnectのAPI keyが必要な環境では、入力欄はsession中だけ使う。localStorage、URL、ログ、exported preset、画面toastに平文で残さない。

---

## 4. 非対象と守る境界

ANKI_MINERは次を含まない。

- Anki noteの削除、tag一括変更、deck移動、model変更
- 複数profile / named preset
- WebM video clip、MP3 re-encode、FFmpeg
- PGS/SUP、TTML/DFXPなど追加subtitle format
- Yomitan dictionary popup、word status、WaniKani、statistics
- Streaming Video Integration、browser extension、WebTorrent、server
- local media / subtitle / filepath / Blob URLの永続保存・外部送信

Ankiへ送る操作以外で、local mediaを外部へuploadしない。Screenshotとaudio clipはbrowser内で生成し、Anki exportを明示した時だけlocalhostのAnkiConnectへ送る。

## 5. 2つの実装stage

### Stage 1 — Mining Foundation（書込みなし）

| Work unit           | 目的                                  | 前提                    | 完了条件                            |
| ------------------- | ------------------------------------- | ----------------------- | ----------------------------------- |
| AM-1 Settings Modal | Anki presetを安全に設定               | current Player controls | Dialog/tab/a11y・設定保存が通る     |
| AM-2 Screenshot     | 現在frameをJPEGとしてpreviewできる    | AM-1なしでも可          | capture/retry/errorが通る           |
| AM-3 Audio Clip     | active cueの音声をpreviewできる       | capability検出          | unsupported browserで正直にfallback |
| AM-4 Mining Preview | 素材とfield payloadを確認する         | AM-2、AM-3              | CancelがAnkiへ何も送らない          |
| AM-5 Anki read-only | permission/version/deck/fieldを読込む | AM-1                    | 書込みなしでmapping保存可能         |

Stage 1ではAnkiConnectから読むだけで、`addNote` / `updateNoteFields`を一度も呼ばない。AM-1 / AM-2 / AM-5は完了済み。AM-3はactive cue音声の単独previewまでを担い、AM-4でrange調整とScreenshot / Audio / field payloadを1つのMining Previewへまとめる。

### Stage 2 — Anki Export & Update（明示書込み）

| Work unit                     | 目的                                                      | 前提        | 完了条件                            |
| ----------------------------- | --------------------------------------------------------- | ----------- | ----------------------------------- |
| AM-6a New note                | `canAddNotes`後に`addNote`する                            | Stage 1     | user操作以外では書込まない          |
| AM-6b Update latest Anki note | Ankiで最後に追加されたcandidateを表示し、確認後に更新する | AM-5 / AM-4 | target noteの内容を見ずに更新しない |
| AM-6c Update specific note    | 検索・選択したnoteだけを確認後に更新する                  | AM-5 / AM-4 | `noteId`なしにupdateしない          |

Stage 2のすべての書込みはMining Preview内の明示buttonからだけ開始する。Settings Modalを開いた、mappingを保存した、Mineを開始しただけでは書き込まない。

---

## 5.x Stage 1A 実装記録（AM-1 + AM-5）

> 実装日: 2026-07-22
> 実装範囲: AM-1 Settings Modal、AM-5 Anki read-only connectionのみ。AM-2〜AM-4、Stage 2は未実装。
> 実AnkiConnect QA: 完了。auto-connect、接続失敗時の10秒連続retry、復帰後のDeck / Note type読込、CORS案内、設定Modalのdesktop / mobile表示を確認済み。`addNote` / `updateNoteFields`を含む実Anki書込みテストは未承認・未実施。

### 実装済みファイル

| ファイル                                         | 目的                                                                                                                                      |
| ------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `src/components/player/PlayerSettingsDialog.tsx` | Settings iconから開くDialog Modal本体（Player / Anki Fields 2 tab）                                                                       |
| `src/components/player/AnkiFieldsTab.tsx`        | AnkiConnect auto-connect/retry、Deck/Note type/Field mapping、Preset保存                                                                  |
| `src/components/player/ui/tabs.tsx`              | shadcn CLI生成 Tabs                                                                                                                       |
| `src/components/player/ui/select.tsx`            | shadcn CLI生成 Select                                                                                                                     |
| `src/features/player/anki-connect.ts`            | Typed read-only AnkiConnect client（version、requestPermission、deckNames、modelNames、modelFieldNames）                                  |
| `src/features/player/anki-miner-preferences.ts`  | `entei.player.anki-miner.v1` localStorage read/write + validation                                                                         |
| `src/i18n/types.ts` + `locales/{en,ja,id}.ts`    | 全UI状態のtyped翻訳                                                                                                                       |
| `src/styles/player.css`                          | Dialog、Tabs、Anki Fieldsのスタイル（OKLCH token使用）                                                                                    |
| `tests/anki-miner-preferences.test.ts`           | Preferences schema/privacyテスト（25 tests）                                                                                              |
| `tests/anki-connect.test.ts`                     | Anki request/response/errorテスト + forbidden write action検証 + dependency absence + W14 auto-connect lifecycle（59 tests）              |
| `tests/anki-fields-tab-lifecycle.test.ts`        | Component lifecycle integration tests: auto-attempt, retry at 10s, success clears error, unmount blocks retry, endpoint change（5 tests） |

### 設計遵守確認

| 項目                                           | 状態 | 根拠                                                                                                                                      |
| ---------------------------------------------- | ---- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| Settings Popover → Dialog置換                  | ✅   | `PlayerControls.tsx`からPopover削除、Dialog再利用                                                                                         |
| Player tabにshortcut移動                       | ✅   | `PlayerSettingsDialog.tsx`内 `TabsContent value="player"`                                                                                 |
| Anki Fields tab: 読み込みのみ                  | ✅   | `anki-connect.ts`に `addNote` / `canAddNotes` / `updateNoteFields` / `storeMediaFile` / `findNotes` / `notesInfo` なし                    |
| Auto-connect on mount + 10s retry              | ✅   | `AnkiFieldsTab.tsx` useEffect mount + scheduleRetry with RETRY_INTERVAL_MS = 10_000                                                       |
| API key: sessionのみ・非保存                   | ✅   | `AnkiFieldsTab.tsx`の `apiKey` stateのみ。localStorage/key/URL/log/toastに出さない                                                        |
| localStorage key: `entei.player.anki-miner.v1` | ✅   | `anki-miner-preferences.ts` で定義                                                                                                        |
| 保存しないものが保存されていない               | ✅   | testで `apiKey` / `blob` / `path` / `subtitle` / `file` を検証                                                                            |
| Note type変更で無効mappingクリア               | ✅   | `handleModelChange` で `modelFieldNames` 再取得後、存在しないfieldを `''`/nullに                                                          |
| Save Default: deck + note type + sentence必須  | ✅   | `isValidPreset` 再利用 + `modelFields.includes(fields.sentence)`                                                                          |
| Dialog開閉がmediaをpauseしない                 | ✅   | `PlayerSettingsDialog` はplayback操作を持たない                                                                                           |
| OKLCH tokenのみ                                | ✅   | 新規CSSで `--entei-*` / `oklch()` / `color-mix()` のみ（hex/rgb/hsl/namedなし）                                                           |
| Home / mobile player untouched                 | ✅   | `PlayerControls.tsx` のみ変更、layout CSS不変                                                                                             |
| shadcn CLIからTabs/Select追加                  | ✅   | `npx shadcn@latest add tabs select` → 個別 `@radix-ui/react-tabs` + `@radix-ui/react-select` に置換                                       |
| `version` はbare number                        | ✅   | `AnkiVersionResult` = `number`。`{ version: 6 }` ではなく `6`                                                                             |
| ローカライズエラー                             | ✅   | `getLocalizedError` で `AnkiConnectionState` → dictionary key 変換。raw English は `unknown-error` fallback のみ                          |
| 非同期race防止                                 | ✅   | `handleModelChange` で `AbortController` + epoch counter。古い応答を無視                                                                  |
| AbortSignal 全fetch通過                        | ✅   | `AnkiConnectClient.request` → `fetch` に `signal` 渡す。`version`/`requestPermission`/`deckNames`/`modelNames`/`modelFieldNames` 全て対応 |
| Select a11y                                    | ✅   | `React.useId()` で各 `SelectTrigger` に `aria-labelledby`、対応 `label` に `id`                                                           |
| ランタイムresponse guard                       | ✅   | `response.json()` を `unknown` でparse → `isAnkiResponseShape` で `result`/`error` 検証                                                   |
| `requestPermission` requireApiKey              | ✅   | `AnkiPermissionResult` に `requireApiKey?: boolean`。UI で先回り表示                                                                      |
| 不要な `unknown as` cast除去                   | ✅   | `isValidFieldMapping` 通過後は型ガードで `AnkiFieldMapping` として直接アクセス                                                            |

### 検証結果

```text
npm run format:check   ✅ pass
npm run test           ✅ 14 files, 416 tests pass
npm run check          ✅ 0 errors, 0 warnings
npm run build          ✅ static build complete
```

---

## 5.y Stage 1A 実装記録（AM-2 Screenshot capture）

> 実装日: 2026-07-23
> 実装範囲: AM-2 Screenshot capture のみ。Anki書込み（Stage 2）は未承認・未実施。desktop Chromiumでlocal MKVのcurrent frame → JPEG Previewの実機QAは完了。4K縮小などのedge caseは継続確認対象。
> 方針: 現在のvideo frame → local JPEG Blob → preview dialog。capture/retry/errorの閉路。pause/seek/subtitle状態は変更しない。

### 実装済みファイル

| ファイル                                            | 目的                                                                                                                                                                                                                                                                                                                         |
| --------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/features/player/screenshot-capture.ts`         | Typed browser utility: video frame → canvas → JPEG Blob。canvas factory injectable for JSDOM                                                                                                                                                                                                                                 |
| `src/components/player/ScreenshotPreviewDialog.tsx` | Radix Dialogベースのpreview。image / error / Retry / Close。mobile sheet + desktop modal対応                                                                                                                                                                                                                                 |
| `src/components/player/PlayerControls.tsx`          | Top-rightにCameraボタン追加（video-only）。`canScreenshot` disabled state対応                                                                                                                                                                                                                                                |
| `src/components/player/PlayerApp.tsx`               | Blob/object URL state + lifecycle管理。新規mediaでpreview無効化。unmount revoke                                                                                                                                                                                                                                              |
| `src/i18n/types.ts` + `locales/{en,ja,id}.ts`       | AM-2用辞書キー6個追加                                                                                                                                                                                                                                                                                                        |
| `src/styles/player.css`                             | `.entei-screenshot-*` dialog + image + error + footer + button スタイル群                                                                                                                                                                                                                                                    |
| `tests/screenshot-capture.test.ts`                  | Utility unit tests: dimensions / scale / no upscale / zero-dims / context-null / drawImage例外 / toBlob-null / BLOB_ENCODE_FAILED / MIME/quality（19 tests）                                                                                                                                                                 |
| `tests/screenshot-integration.test.tsx`             | Component tests: Camera video-only visibility / disabled / capturing-disabled / click / dialog image/error/retry/close / no-preview placeholder / URL lifecycle / unmount safety / media invalidation / StrictMode lifecycle / sync double-click guard / no URL for stale result / caller-level rejection safety（20 tests） |

### 設計遵守確認

| 項目                                           | 状態 | 根拠                                                                                                                   |
| ---------------------------------------------- | ---- | ---------------------------------------------------------------------------------------------------------------------- |
| Cameraボタンはvideo-only                       | ✅   | `mediaType === 'video'` のみレンダリング。audio/nullでは非表示                                                         |
| Top-right配置（caption/timeline/settingsの前） | ✅   | `.entei-controls-top-right` 内で caption mode より前に配置                                                             |
| Captureはpause/seek/subtitleを変更しない       | ✅   | `handleScreenshot` は `videoRef.current` から直接draw。playback stateは触らない                                        |
| JPEG policy固定値                              | ✅   | `MAX_CAPTURE_DIMENSION = 1920`、`JPEG_QUALITY = 0.9`。アスペクト比維持・upscaleなし。setting化なし                     |
| `toDataURL`不使用                              | ✅   | `canvas.toBlob('image/jpeg', 0.9)` のみ使用                                                                            |
| Canvas injectable                              | ✅   | `CanvasFactory` interface + `defaultCanvasFactory`。JSDOMテストでmock factory注入                                      |
| Blob null → typed error                        | ✅   | `ScreenshotError` に `BLOB_NULL` code。rejectではなくresult型で返す                                                    |
| PlayerAppがURL lifecycle所有                   | ✅   | `screenshotUrlRef` + `replaceScreenshotUrl` でrevoke-before-replace。`unmount` でcleanup                               |
| localStorage/media永続化なし                   | ✅   | Blob/URLはReact stateのみ。localStorage/key/URL/logに残さない                                                          |
| 新規mediaでpreview無効化                       | ✅   | `handleMediaSelect` で `clearScreenshot()` 呼び出し                                                                    |
| Metadata未 ready → disabled                    | ✅   | `isVideoMetadataReady` state。loadeddata後にtrue。button titleで `screenshotErrorMetadata` 表示                        |
| `type='button'`                                | ✅   | Camera・Retry・Close 全て `type="button"`                                                                              |
| Lucide Cameraのみ                              | ✅   | `lucide-react` の `Camera` icon。raw SVGなし                                                                           |
| OKLCH tokenのみ                                | ✅   | 新規CSSで `--entei-*` / `oklch()` / `color-mix()` のみ（hex/rgb/hsl/namedなし）                                        |
| `prefers-reduced-motion`                       | ✅   | `.entei-screenshot-btn` / `.entei-screenshot-image` に `@media (prefers-reduced-motion: reduce)` で `transition: none` |
| 既存Settings/Anki retry動作不変                | ✅   | `PlayerControls`・`PlayerApp` の既存prop・handler・effectは変更なし                                                    |
| Unmount URL leak防止                           | ✅   | `mountedRef` でunmount後はstate更新・URL作成をスキップ。Strict Mode対応                                                |
| 新規media race防止                             | ✅   | `captureEpochRef` モノトニックepoch。media変更・dialog閉・retry置換でepoch進行。stale結果はdiscard                     |
| 連続ダブルクリック防止                         | ✅   | `isCapturing` state/ref。Camera・Retryボタンをcapturing中disabled。title/ariaで `screenshotCapturing` 表示             |
| error.message非表示                            | ✅   | Dialogでは `hasScreenshotError` booleanのみ。typed internal `ScreenshotError` はutility/tests/debug用に残存            |
| `_screenshotBlob` state削除                    | ✅   | BlobはURL作成に必要な間だけlocal変数で保持。React stateには残さない                                                    |
| `screenshotNoPreview` ローカライズ             | ✅   | placeholderテキストをhardcodeから辞書キーへ置き換え                                                                    |

### 検証結果

```text
npm run format:check   ✅ pass
npm run test           ✅ 14 files, 416 tests pass
npm run check          ✅ 0 errors, 0 warnings
npm run build          ✅ static build complete
```

### 未解決・browser QA待ち

| 項目                        | 理由                                           |
| --------------------------- | ---------------------------------------------- |
| 4K動画での縮小動作確認      | `computeCaptureDimensions` の数学的検証は通過  |
| `toBlob` callback実際のBlob | jsdomではmock化。実ブラウザでのMIME/type確認   |
| fullscreen/immersive表示    | CSSはmedia query対応済み。実機レイアウト未確認 |
| 連続captureのURL revoke     | コードレビューと単体テストで確認。実機未確認   |

---

## 5.z Stage 1 実装記録（AM-3 Audio Clip）

> 実装日: 2026-07-24
> 実装範囲: 現在activeなsubtitle cueのstart / endだけを、asbplayer方式の別`HTMLAudioElement`からbrowser-native audio Blobへ録音してpreviewする。Anki書込み、range editor、MP3 / FFmpeg、download、historyは未実装。
> browser QA: 未実施。`MediaRecorder`、`captureStream` / `mozCaptureStream`、enabled audio track、Opus MIMEが揃うbrowserでのみ有効化する。
> 修正記録（2026-07-24）:
> - Dialogクリック伝播防止: Radix Dialog portal内のクリックがReact treeをbubbleしてPlayerAppのsurface click handlerを発火していた。`DialogContent`で`onClick`に`stopPropagation`を挟んで全Dialog利用箇所を保護。
> - Preview duration表示修正: `audio.duration`がNaN/Infinity/0の時にexpected cue duration `(end - start)` をfallback表示。`durationchange`イベントでbrowserが後から正しいdurationを報告した時に上書き。

| 項目                       | 状態 | 根拠                                                                                                                              |
| -------------------------- | ---- | --------------------------------------------------------------------------------------------------------------------------------- |
| visible Playerを変更しない | ✅   | detached audio elementだけをcue startへseekしてrecord。Playerのtimestamp / pause / rateを触らない                                 |
| 軽量native formatのみ      | ✅   | `audio/webm;codecs=opus`を優先、`audio/ogg;codecs=opus`をfallback。MP3再encodeなし                                                |
| capability fallback        | ✅   | API、MIME、enabled audio trackを確認し、失敗時はlocalized error / Retry。偽の成功Blobを作らない                                   |
| cleanup                    | ✅   | stop / cancel / timeout / media変更 / Dialog close / unmountでrecorder、両stream track、timer、temporary audio、preview URLを解放 |
| async race防止             | ✅   | recording ref、epoch、mounted guardでdouble click・stale完了・unmountを遮断                                                       |
| 保存・外部送信なし         | ✅   | Blobとpreview object URLはmemoryのみ。localStorage / network / Anki writeなし                                                     |
| Dialog click伝播防止       | ✅   | `DialogContent`で`e.stopPropagation()`。全Dialog（Settings / Screenshot / Audio clip）でsurface clickが発火しない                |
| Preview duration fallback  | ✅   | `audio.duration`がNaN/Infinity/0の時、expected cue durationを表示。後続の`durationchange`で実際の値が上書きされる                  |

```text
npm run test           ✅ 18 files, 469 tests pass
npm run check          ✅ 0 errors, 0 warnings, 0 hints
npm run build          ✅ static build complete
```

---

### Stage 1A ビジュアルリデザイン（AM-1 Workspace）

> リデザイン日: 2026-07-22
> 対象: PlayerSettingsDialog / AnkiFieldsTab / player.css のみ。機能・プロトコル・テスト・翻訳は変更なし。

| 項目                               | 状態 | 根拠                                                                                                                                                                    |
| ---------------------------------- | ---- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Breakpoint別の固定Dialog高さ       | ✅   | mobileは`100dvh`、tabletは最大`36rem`、desktopは最大`34rem`。余った内容はpanel内scrollに限定                                                                            |
| Mobile sheet-like                  | ✅   | `width: 100%`、`height: 100dvh`、`border-radius: 0`、`inset: 0`。open中はTopBarを非表示・非操作化してclose buttonを守る                                                 |
| 水平Tabs strip（全viewport共通）   | ✅   | `.entei-settings-tabs-list` を常に`flex-direction: row`、mobileはinline 24px / desktopは32px。左寄せcontent-width                                                       |
| 下部アクセントunderline            | ✅   | Active tabの`::after`で5px accent line。45px tab stripのshared dividerに0.5pxずつ跨げて配置。白pillなし                                                                 |
| TabsTrigger overlap 修正           | ✅   | 親は45px（44px tab + divider 1px）、上下paddingなし。`h-9` / `justify-center` / pill borderを上書き                                                                     |
| Content panel full-width           | ✅   | `.entei-settings-panel` に`overflow-y: auto` + mobile 24px / desktop `24px 32px` padding。左railなし                                                                    |
| Header固定 + close spacing         | ✅   | `.entei-dialog-header` に `flex-shrink: 0` + `padding-right: 3.5rem`                                                                                                    |
| Player shortcuts dense list        | ✅   | `.entei-settings-shortcuts-list` を flex column + `.entei-settings-shortcut-row` を `border-bottom` 区切り + `hover background`。kbd は `surface` background + `border` |
| Anki connection row (desktop grid) | ✅   | `.entei-anki-connect-row` を `grid-template-columns: 1fr auto` + `align-items: end`                                                                                     |
| Anki mapping grid                  | ✅   | Desktop で `.entei-anki-mapping-grid` を `repeat(2, 1fr)`。Sentence は `:first-child` で `grid-column: 1 / -1`                                                          |
| Save area分離                      | ✅   | `.entei-anki-save-area` で `border-top` 区切り + 明確なbottom action                                                                                                    |
| 接続status badge                   | ✅   | manual Connect buttonは廃止。成功はgreen `Plug` + text、失敗 / 再接続中はred `PlugZap` + text。失敗時は10秒ごとに連続retry                                              |
| Input calm surface                 | ✅   | `background-color: var(--entei-surface)`、`border: 1px solid oklch(100% 0 0deg / 0.12)`                                                                                 |
| 全タッチターゲット >=44px          | ✅   | `min-height: var(--entei-touch-min)`（44px）を input/button/select に適用                                                                                               |
| 水平スクロールなし                 | ✅   | `min-width: 0` + `overflow-x: hidden`（Radix Portal 内は別）                                                                                                            |
| reduced-motion                     | ✅   | `@media (prefers-reduced-motion: reduce)` で transition 無効化                                                                                                          |
| OKLCH tokenのみ                    | ✅   | 新規CSSで `--entei-*` / `oklch()` / `color-mix()` のみ                                                                                                                  |
| 実ブラウザ / 実AnkiConnect QA      | ✅   | desktop / mobile Modal、Tab geometry、Dialog高さ固定、Dropdown scroll、connection failure（`ERR_CONNECTION_REFUSED`）、10秒retry、復帰後のgreen `Plug`を確認            |

---

## 6. Settings Modalの仕様（AM-1）

### 6.1 開閉とfocus

Player frame右上のSettings iconを押すとModalを開く。現在のSettings Popoverは残さない。

- `Dialog`はfocus trap、Escape close、triggerへのfocus returnを持つ既存wrapperを再利用する
- Modalを開くだけではplayerをpauseしない。設定確認中も元の再生状態を変えない
- Modalのtab切替はplayer state、media、subtitle、Ankiへ副作用を起こさない
- Dialogを閉じる時、接続中のread-only requestはAbortSignalまたはrequest epochで古い応答を捨てる
- Export confirmationはSettings Modalではなく、後のMining Preview Dialogに置く

### 6.2 Player tab

初期内容は現在Settings Popoverにあるkeyboard shortcut参照を移すだけ。

このtabには「未実装の再生mode設定」を先回りで追加しない。P2のCondensed / Auto-pause / RepeatはP2の実装時に追加する。

### 6.3 Anki Fields tab — 画面状態

| 状態                  | 表示                                                       | 書込み |
| --------------------- | ---------------------------------------------------------- | ------ |
| 未接続                | 接続説明、auto-connect開始                                 | なし   |
| 接続中                | status badge (connecting)、PlugZap icon                    | なし   |
| 接続失敗              | localized原因、10秒retry、CORS案内                         | なし   |
| 接続成功・mapping未完 | Deck / Note type / field Select、Save preset               | なし   |
| 保存済み              | active `Default` preset、最後の検証時刻（session表示だけ） | なし   |

最初に表示するfield mappingは以下。

| payload               | mapping    | 必須性 |
| --------------------- | ---------- | ------ |
| 選択文章              | Sentence   | 必須   |
| 意味・definition      | Definition | 任意   |
| JPEG                  | Image      | 任意   |
| Audio Clip            | Audio      | 任意   |
| 対象語                | Word       | 任意   |
| media名やsource label | Source     | 任意   |
| tags                  | Tags       | 任意   |

Deckを変えてもNote typeを勝手に変えない。Note typeを変えたらfield一覧だけを再読込し、存在しなくなったmappingは「未選択」に戻してSaveを無効化する。

### 6.4 MiningはSettings tabを持たない

initial ANKI_MINERでは、capture format・post-mining playback・MP3再encodeをuser settingにしない。Mine操作は常にMining Previewを開く固定動作で、Stage 2のnew / update actionもPreview footerで選ぶ。

実需が出た時だけSettings ModalへMining tabを追加する。未使用の設定tabを先に出さない。

---

## 7. AM-4以降のmining中player状態

### 7.1 state snapshot

AM-4のMine操作を開始した瞬間に次をmemory上でsnapshotする。これはlocalStorageへ保存しない。AM-2 ScreenshotとAM-3 Audio Clipの単独previewではこのsnapshotを使わず、visible Playerを変更しない。

```ts
type MiningPlaybackSnapshot = {
  currentTime: number;
  activeCueId: number | null;
};
```

`currentTime`はcaptureの開始点を固定するための値であり、「ページを開き直した時のresume timestamp」ではない。

### 7.2 開始から終了まで

```text
1. Mine操作（AM-4の専用trigger）
2. active cue / selected rangeがあるかvalidate
3. snapshotを作る
4. media.pause()
5. screenshot / audioをlocal生成
6. Mining Preview Dialogを開く
7. Cancel / Export success / Export failure
8. snapshot currentTimeへseekしてpauseのまま戻す
```

AM-4のPreviewを開く前にpauseする理由は、複数素材を同じ対象で確認する間にsceneが変わらないようにするため。カメラで写真を撮る瞬間に被写体を止めるのと同じ。AM-3単独clipはasbplayer方式の別audio elementを使うため、このvisible Player pauseは行わない。

### 7.3 AM-4終了時は常にcapture開始位置でpause

Cancel、Export成功、Export失敗、capture失敗の全てで、playerはsnapshotの`currentTime`へ戻してpauseのままにする。

Mining後に勝手に再生を始めない。続きを見たい時はユーザーがcustom Play buttonを押す。これは一文を確認・送信した直後に次の字幕へ流れてしまうのを防ぐ固定動作であり、SettingsやlocalStorageの選択肢にはしない。

### 7.4 Preview Dialog中の制約

- player本体を操作するためのshortcutはDialog内のinput/buttonでは発火しない
- Dialogを閉じるまでrangeを変えない。変更したい場合はCancelしてplayerへ戻る
- Escape / CancelはAnki requestを送らない
- Export処理中は二重submitを防ぎ、Cancelは「送信済み」を取り消す意味ではない

---

## 8. Screenshot / Audio Capture

### 8.1 Screenshot（AM-2）

現在のvideo frameをcanvasへ描画し、JPEG Blobを作る。

```text
active video element
  → canvas sizeを実video dimensionへ合わせる
  → drawImage(video)
  → canvas.toBlob('image/jpeg')
  → local preview URL
```

- local Blob mediaを対象にする。cross-origin streaming captureは対象外
- video metadata未読込、canvas context不取得、`toBlob()`がnullの時はlocalized errorとRetryを出す
- Previewを閉じたらpreview object URLをrevokeする
- JPEG quality / max dimensionは固定安全値から始め、設定UIは後回しにする

### 8.2 Audio Clip（AM-3）

AM-3は**現在activeなsubtitle cueだけ**をbrowser-nativeの軽量formatで生成する。range調整はAM-4へ残す。asbplayerと同じく、visible Playerをpause / seek / rate変更せず、同じlocal Blob URLを一時的な別`HTMLAudioElement`へ渡す。`MediaRecorder.isTypeSupported()`で実行browserの最適なMIME（優先`audio/webm;codecs=opus`、fallback `audio/ogg;codecs=opus`）を検出し、余計なMP3変換・二重record・format toggleを行わない。

```text
capability check
  → active cueのstart/endを決める
  → 同じlocal Blob URLの別audio elementをcue startへseek
  → detached audio streamのaudio trackだけをcapture
  → MediaRecorderでrecord
  → stop / Blob化
  → Previewで再生
```

- `MediaRecorder`、`captureStream` / `mozCaptureStream`、対応MIME、enabled audio trackのどれかがないbrowserではAudio Clip欄を「このbrowserでは利用不可」と表示し、Screenshot・text exportは続けられる
- unsupported環境で空audioや偽の成功を作らない
- MP3 re-encode、MP3再録音、WebM **video** clip、FFmpegは対象外
- native recordingはclip durationぶんのcapture時間を必要とするが、終了後の追加encode passを作らない
- detached audioはclip終了、Cancel、失敗、media変更、unmountの全経路でpause / `src`解除 / `load()` / stream track停止を行う。visible Playerのtimestamp・pause・rateは変更しない

---

## 9. AnkiConnect read-only接続（AM-5）

### 9.1 接続順序

```text
Auto-connect on AnkiFieldsTab mount
  → version / reachability確認
  → requestPermission（対応時）
  → API key必須かを検出
  → deckNames
  → modelNames
  → userがNote typeを選択
  → modelFieldNames
  → field mappingをvalidate
  → Save preset（local only）

On failure: continuous retry every 10 seconds until connected or unmount
On endpoint/API key change: immediate reconnect
```

browser originのpermission実装差で`requestPermission`が失敗する時は、失敗を隠さず`version`でreachabilityを確認して原因を表示する。AnkiConnectのorigin許可やCORS設定を勝手に変更しない。

### 9.2 接続で扱う情報

localStorageへ保存してよいもの:

- AnkiConnect URL（明示的にユーザーが変更を許可した場合だけ）
- deck、note type、field mapping

保存しないもの:

- API key
- local file path、File、Blob URL、subtitle本文、audio/image Blob
- 最後に検索したtarget note ID、specific updateの検索語、Anki response payload

API key必須ならinputは`type="password"`で、接続requestのmemory中だけ利用する。画面を閉じる・refreshする・接続を失敗する時に破棄する。

---

## 10. Mining PreviewとExplicit Export（AM-4 / Stage 2）

### 10.1 Preview payload

Previewは最低限、以下を明示表示する。

```ts
type MiningPreview = {
  sentence: string;
  cueStart: number;
  cueEnd: number;
  screenshot: Blob | null;
  audio: Blob | null;
  deck: string;
  noteType: string;
  fields: Record<string, string>;
  tags: string[];
};
```

`fields`はuserが選んだmappingから作る。必須Sentence mappingがない、Deck / Note typeが未選択、fieldが存在しない場合はExportをdisabledにして、何を設定すればよいか表示する。

### 10.2 Stage 2の3つのExport action

Mining Previewのfooterは、current mappingとAnki connectionが検証済みの時だけ次のactionを出す。

```text
新規カードとして追加
最後に追加されたAnki noteを確認して更新
既存Anki noteを選んで更新
```

どのactionでも、実際の書込みbuttonの直前にtarget / modeを文章で出す。

```text
「Deck: ReCall Deck / Note type: 語義 に新規noteを追加します」
「Ankiで最後に追加された note #123… を更新します」
「選択した note #456… を更新します」
```

### 10.3 新規noteのExport順序（AM-6a）

```text
Export button（user gesture）
  → payloadを最終validate
  → canAddNotes
  → mediaのAnki upload準備
  → addNote
  → 成功responseを受ける
  → 成功toast + capture開始位置へ戻してpause
```

`canAddNotes`がfalseなら`addNote`を呼ばない。`addNote`のresponse前に「送信済み」と表示しない。

### 10.4 最後に追加されたAnki noteを更新（AM-6b）

これは「Entei sessionで最後に送ったnote」ではない。AnkiConnectへqueryして、Anki側で最後に追加されたcandidateを見つけ、何のcardかを確認してから更新する。

```text
Update latest
  → findNotesでrecently-added candidateを検索
  → candidate IDの順序を確定
  → notesInfoでdeck / note type / mapped fields / tagsを読む
  → Mining Previewにtarget cardを表示
  → userが「このnoteを更新」を明示
  → updateNoteFields
```

asbplayerと同じく、`findNotes('added:1')`の結果から最大note IDを選ぶ。Anki公式の`added:1`は「今日追加されたcard」の検索なので、これは**ASBと同じ“直近追加card”契約**であり、全履歴のglobal sortを作る機能ではない。

園庭では次のcontractにする。

- `findNotes('added:1')`で候補を読む
- 結果があれば最大note IDをlatest candidateにする
- 結果がなければ「今日追加されたAnki cardはない」と表示し、書込みは行わない
- `notesInfo`でdeck / note type / mapped fields / tagsを読み、candidateがcurrent Note typeと必要なSentence fieldを満たさない時は更新をdisabledにする
- targetをMining Previewで確認するまで`updateNoteFields`を呼ばない

この仕様はASBの“Update last card”と同じ発見方法を保ちつつ、園庭ではtarget内容を見せずに更新しないためのUI境界を追加する。

### 10.5 specific Anki noteを更新（AM-6c）

specific updateはuserの検索語またはnote IDから始める。

```text
Search existing note
  → findNotes(query)
  → bounded candidate list
  → notesInfo
  → userが1 noteを選択
  → targetのdeck / note type / mapped field preview
  → 「このnoteを更新」button
  → updateNoteFields(noteId, mapped fields)
```

- `noteId`がない、複数candidateのどれもuserが選んでいない、target Note typeが非互換ならupdate buttonを出さない
- Search queryはAnki query syntaxとして扱う。deck名 / field名 / user textを連結する時はescapeし、raw queryを勝手に書き換えない
- candidate listはページングまたは安全な上限を持ち、巨大collectionの全note detailを一括で取らない

### 10.6 update payloadの契約

`updateNoteFields`へ渡すのはcurrent previewでmapping済みのfieldだけ。Audio / screenshot captureが失敗したからといって既存fieldを空文字で消さない。

初期policyは**mapped fieldを現在のpreview値で置換**する。append、field clear、tag置換、deck移動は別の明示機能が必要なのでStage 2には含めない。

### 10.7 cleanup

- Cancel、validation failure、capture failure、Anki failureではpreview object URLをrevokeする
- Ankiへuploadしたmediaのcleanup可否はAnkiConnect APIの実際のresponseを確認してから設計する。推測でdelete actionを呼ばない
- failed Exportはretry可能にするが、同じclickのrequestを二重送信しない

---

## 11. localStorage data contract

ANKI_MINERは既存の`entei.player.prefs.v1`へ無関係なAnki設定を混ぜない。新しいversioned keyを使う。

```text
entei.player.anki-miner.v1
```

```ts
type AnkiFieldMapping = {
  sentence: string;
  definition: string | null;
  image: string | null;
  audio: string | null;
  word: string | null;
  source: string | null;
  tags: string | null;
};

type AnkiMinerPreferencesV1 = {
  schemaVersion: 1;
  presetName: 'Default';
  ankiConnectUrl: string;
  deck: string | null;
  noteType: string | null;
  fields: AnkiFieldMapping;
};
```

### 11.1 validation

- `schemaVersion`が違う、JSONが壊れている、localStorageがthrowする場合は安全な初期値を返す
- required `sentence` mappingが空ならpresetは「未完」と表示し、Export不可
- field名が現在選んだNote typeのfield一覧にない時は保存前に明示する
- old keyがないことはエラーではない。初回状態として扱う

### 11.2 privacy

保存値はUI設定だけ。以下は絶対に保存しない。

```text
API key
File / path / Blob URL
subtitle本文・active cue・timestamp
screenshot / audio Blob
Anki response payload / card ID
```

## 12. component / module構成

```text
apps/web/src/
├── components/player/
│   ├── PlayerSettingsDialog.tsx       # Settings iconのModal本体
│   ├── AnkiFieldsTab.tsx              # read-only接続 + mapping
│   ├── MiningPreviewDialog.tsx        # capture結果と明示Export
│   ├── AnkiNoteTargetPicker.tsx       # Stage 2: latest / specific target確認
│   └── ui/
│       ├── tabs.tsx                   # shadcn CLI生成
│       ├── select.tsx                 # shadcn CLI生成
│       ├── input.tsx                  # Stage 2: specific note query
│       ├── command.tsx                # Stage 2: bounded candidate list
│       └── switch.tsx                 # shadcn CLI生成（必要になった時だけ）
├── features/player/
│   ├── anki-miner-preferences.ts      # localStorage schema / validation
│   ├── anki-connect.ts                # typed request client、read/write分離
│   ├── screenshot-capture.ts          # canvas → JPEG Blob
│   ├── audio-clip.ts                  # capability / MediaRecorder
│   ├── mining-session.ts              # snapshot / fixed pause restore
│   ├── mining-payload.ts              # mapping → preview / canAddNotes payload
│   └── anki-note-target.ts            # Stage 2: candidate discovery / validation
└── tests/
    ├── anki-miner-preferences.test.ts
    ├── mining-session.test.ts
    ├── mining-payload.test.ts
    ├── screenshot-capture.test.ts
    ├── audio-clip.test.ts
    └── anki-note-target.test.ts
```

`PlayerApp`はmedia / playback stateの唯一の所有者のままにする。Anki tabやMining Previewがvideo refを直接勝手に操作しない。必要な操作はtyped callbackで`PlayerApp`へ依頼する。

## 13. shadcn導入手順

Dialog / Button / ScrollArea / Slider / Popoverに加え、Tabs / Selectも導入済み。AM-2以降で既存componentを再利用する。

`Switch`は任意field表示を本当にtoggle化する判断をした時だけ追加する。Stage 2でspecific update検索UIを実装する時だけ、`Input` / `Command`もshadcn CLIで追加する。

生成後に行うこと:

1. generated componentのimport pathを`@/components/player/ui/`に揃える
2. EnteiのOKLCH tokenへstyleをマップする
3. generated CSS utilityを無目的に大量追加しない
4. existing `Dialog` wrapperのfocus / Escape / return-focus契約を壊さない
5. `npm run check`でReact / Astro typeを確認する

## 14. testと検証

### 14.1 unit

| 対象             | 最低test                                                                                                  |
| ---------------- | --------------------------------------------------------------------------------------------------------- |
| Anki preference  | default、旧version、壊れたJSON、invalid enum、API key非保存                                               |
| field mapping    | required sentence、存在しないfield、optional field、payload生成                                           |
| mining playback  | capture後にsnapshot timestampへ戻りpause、Cancel / success / failureで同じ、二重完了なし                  |
| screenshot       | metadataなし、canvas不可、`toBlob` null、成功Blob cleanup                                                 |
| audio capability | MediaRecorderなし、MIMEなし、supported MIME、range終了、cleanup                                           |
| Anki request     | version error、permission/API key、deck/model/field load、`canAddNotes` false、`addNote` error            |
| latest target    | 当日candidate、candidateなし、最大note ID、target Note type不一致、`notesInfo` error、更新button disabled |
| specific target  | query escape、候補上限、未選択target、`noteId`欠落、`notesInfo` mismatch                                  |
| update request   | target preview必須、mapped fieldsだけ送信、`updateNoteFields` error、既存fieldを空で消さない              |

### 14.2 browser manual gate

| 状況                  | pass条件                                                                               |
| --------------------- | -------------------------------------------------------------------------------------- |
| Settings Modal        | ✅ Settings icon → focusがModalへ、Escape → iconへ戻る                                 |
| Anki未起動            | ✅ localized error、playerは壊れず、書込みなし                                         |
| origin permission拒否 | ✅ CORS案内が読め、auto-retryで勝手に設定を変えない                                    |
| mapping               | ✅ Deck / Note type変更でfield一覧が正しく更新される                                   |
| Screenshot            | local videoでframe一致、Cancelでpreview URL解放                                        |
| Audio                 | supported Chromiumでpreview再生、unsupported browserで正直な表示                       |
| mining playback       | Cancel・成功・失敗の全てでcapture開始timestampへ戻りpauseのまま                        |
| Export                | `canAddNotes` falseで`addNote`ゼロ回、成功response後だけ成功表示                       |
| Update latest         | targetのdeck / note type / fieldsを見て明示確認後だけ更新。candidateなしなら書込みゼロ |
| Update specific       | 検索結果から1 noteを選んだ時だけ更新。別Note typeは更新不可                            |
| privacy               | DevTools Networkでmedia / Blob / subtitle本文が外部送信されない                        |

### 14.3 実Anki gate

実Anki profileへの`addNote` / `updateNoteFields`は、Yosiaが明示的に承認した後だけ行う。

test用Deck / test用Note typeを作り、production deckへ試験noteを送らない。これは削除やcleanupを伴うため、実行直前に対象Deckを再確認する。

## 15. 採用しない選択肢

| 選択肢                                | 採用しない理由                                          |
| ------------------------------------- | ------------------------------------------------------- |
| Settings Popoverへmappingを追加       | 縦長・接続error・Selectが収まらず、focus管理も悪化する  |
| `Mine`で即`addNote`                   | 誤Deck / 誤field / capture失敗を確認できない            |
| API keyをlocalStorageへ保存           | browser storageでは秘密を守れない                       |
| 複数presetを最初から実装              | active mapping 1つの実需確認前にprofile managerを増やす |
| Audio Clipを全browser必須にする       | native capture API / codec対応に差がある                |
| Screenshot / audioを外部serviceへ送る | local-firstとprivacy契約に反する                        |

## 16. 実装開始gate

AM-1を始める前に、以下だけを確認する。

1. Settings Modalのtab名は `Player` / `Anki Fields` で確定
2. initial presetは `Default` 1つ
3. mining actionは初期版ではPreview固定
4. Mining終了時はcapture開始timestampへ戻してpauseのまま
5. Audio Clipはnative lightweight formatだけで、MP3変換をしない
6. API keyはsession限定・非保存
7. real Anki profileへ書込むintegration testは後の明示承認まで行わない

上の6点が承認されたら、Stage 1のAM-1 Settings Modalから実装する。Stage 2はStage 1のread-only connection / Preview QAを通してから開始する。

---

## 17. 根拠

| 事実                                                                  | 根拠                                                             | 設計への反映                                                                    |
| --------------------------------------------------------------------- | ---------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| SettingsはDialog Modal + Player / Anki Fields tab                     | `apps/web/src/components/player/PlayerSettingsDialog.tsx:55-120` | mappingとread-only connectionをModalへ配置                                      |
| 既存Dialogはfocus trap / Escape / return-focusを持つ                  | `apps/web/src/components/player/ui/dialog.tsx:1-6`               | Modal基盤を再利用                                                               |
| asbplayerはAnki / Miningを別tabにする                                 | `A:\asbplayer\common\components\SettingsForm.tsx:433-489`        | Enteiは実需があるAnki Fieldsだけを初期Modalへ置く                               |
| asbplayerはDeck→Note type→fieldを選択する                             | `A:\asbplayer\common\components\AnkiSettingsTab.tsx:486-558`     | mapping依存を同じ順で扱う                                                       |
| asbplayerはmining後のplayer状態やMP3再encodeを設定できる              | `A:\asbplayer\common\components\MiningSettingsTab.tsx:129-228`   | Enteiでは両方を不採用にし、fixed pause restore + native lightweight audioにする |
| asbplayerは`added:1`候補の最大note IDをupdate last対象にする          | `A:\asbplayer\common\anki\anki.ts:545-582`                       | Enteiもtarget表示・確認を挟んで採用                                             |
| AnkiConnectは`findNotes` / `notesInfo` / `updateNoteFields`を提供する | AnkiConnect official docs（Context7, 2026-07-22）                | candidate確認後のspecific updateを実装                                          |
| Anki公式の`added:1`は今日追加されたcard creation検索                  | Anki Manual Search（Exa, 2026-07-22）                            | ASBと同じlatest candidate発見に使い、candidateなしなら更新しない                |
| audio captureはbrowser capability差がある                             | `A:\asbplayer\common\audio-clip\audio-clip.ts:61,317,436-440`    | capability gate + honest fallback                                               |
| AnkiConnectは`version`、model / field APIを提供する                   | AnkiConnect official docs（Context7, 2026-07-22）                | read-only設定から開始し、`canAddNotes`を先に通す                                |
| 現planもPreviewと明示Exportを安全条件にする                           | `docs/PLAYER_PHASES.md:235-263`                                  | auto exportを禁止                                                               |
