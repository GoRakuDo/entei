# ANKI_MINER — ローカル採掘とAnki Exportの設計

> **状態:** Stage 1（AM-1 / AM-2 / AM-3 / AM-4 / AM-5）+ Stage 1.1（range commit自動素材更新）+ Stage 2 AM-6a/AM-6b（new note / update latest）+ AM-6c（inline append panel with Data Table）はコード完了・実AnkiConnect QA確認済み。
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
  → rangeを離した時だけ素材をローカル再生成
  → modeを選び、Ankiへ送信をユーザーが明示操作
  → New: canAddNotes → addNote
  → Update latest: candidateを検証 → updateNoteFields
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

| 役割                           | shadcn component | 現在の状態    |
| ------------------------------ | ---------------- | ------------- |
| Settings / Mining Preview      | `Dialog`         | 導入済み      |
| tab切替                        | `Tabs`           | 導入済み      |
| Deck / Note type / Field選択   | `Select`         | 導入済み      |
| 新規 / 更新 / append mode選択     | `ToggleGroup`    | 導入済み      |
| field一覧・error一覧の長い領域 | `ScrollArea`     | 導入済み      |
| action                         | `Button`         | 導入済み      |

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
- MP3 re-encode、FFmpeg
- PGS/SUP、TTML/DFXPなど追加subtitle format
- 無音WebM Video Clip（実装済み: [VIDEO_CLIP.md](./VIDEO_CLIP.md)）
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

Stage 1.1ではrange sliderの`onValueCommit`、つまりthumbを離した時だけ、文章・出典・画像・音声を同じrangeからローカル再生成する。drag中はrange表示だけ変え、Anki requestは一切しない。manual Update materials buttonは削除済み。Stage 2の`Ankiへ送信`button（`ToggleGroup` + `Send`）はAM-6a/AM-6b/AM-6cとして実装済み。Stage 1.1、Stage 2、AM-6cの実AnkiConnect QAはYosia確認済み。

### Stage 2 — Anki Export & Update（明示書込み）

| Work unit                     | 目的                                                 | 前提        | 完了条件                            |
| ----------------------------- | ---------------------------------------------------- | ----------- | ----------------------------------- |
| AM-6a New note                | 新カードmodeで`canAddNotes`後に`addNote`する         | Stage 1.1   | user操作以外では書込まない          |
| AM-6b Update latest Anki note | 更新modeでlatest candidateをone-click更新する | AM-5 / AM-4 | target noteの内容を見ずに更新しない |
| AM-6c Append to existing cards | inline Data Tableで選択カードに追記する | AM-5 / AM-4 | append-only（上書きしない） |

Stage 2のmodeはMining Preview内のshadcn `ToggleGroup type="single"`で選ぶ。New / Updateはpersistent（localStorage保存）。Appendはsession-only icon-only（再openで復帰）。`Send` button: New/Updateは新規作成/更新、Appendは選択カードへの追記。Settings Modalを開いた、mappingを保存した、Mineを開始した、rangeを調整しただけでは書き込まない。

---

## 5.x Stage 1A 実装記録（AM-1 + AM-5）

> 実装日: 2026-07-22
> 実装範囲: AM-1 Settings Modal、AM-5 Anki read-only connectionのみ。当時AM-2〜AM-4、Stage 2は未実装であった（後に実装済み、後続の各実装記録を参照）。
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
| 選択ごとに auto-save: deck + note type + sentence が揃った瞬間に localStorage へ保存 / 途中状態は保存しない | ✅ | `isValidPreset` + `saveValidPreset`（deck / note type / field mapping の各選択時に next snapshot が valid なら即保存）                   |
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

### 残るbrowser QA

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
> browser QA: Chromiumでactive cue → local Audio Preview、Preview内clickが背後Playerをresumeしないこと、Preview durationのcue-duration fallbackを確認済み。unsupported browserの表示は実機未確認で、unit / integration testで検証済み。
> 修正記録（2026-07-24）:
>
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
| Dialog click伝播防止       | ✅   | `DialogContent`で`e.stopPropagation()`。全Dialog（Settings / Screenshot / Audio clip）でsurface clickが発火しない                 |
| Preview duration fallback  | ✅   | `audio.duration`がNaN/Infinity/0の時、expected cue durationを表示。後続の`durationchange`で実際の値が上書きされる                 |

```text
npm run test           ✅ 18 files, 469 tests pass
npm run check          ✅ 0 errors, 0 warnings, 0 hints
npm run build          ✅ static build complete
```

---

## 5.w Stage 1 実装記録（AM-4 Mining Preview）

> 実装日: 2026-07-23
> 実装範囲: AM-4 Mining Preview（素材確認・range調整・range commit自動素材更新・Cancel/Close）。当時はStage 2（AM-6a/AM-6b）のコードまで実装済みで、実AnkiConnect手動書込みQAは未実施だった。後にAM-6cまで実装し、Stage 1.1 / Stage 2 / AM-6cの実AnkiConnect QAもYosia確認済み。range zoom、字幕marker、dock、range commit時の全素材自動更新を含む検証完了。
> 方針: Mine開始時にsnapshot time + activeCueIdをmemory上で固定し、visible Playerを即pause。Screenshot（videoのみ）とAudio（detached `recordAudioClip`）を並行capture。Mining Preview Dialogで確認・range調整（0.1秒step Slider + `onValueCommit`時の自動全素材再生成）。Cancel/Closeでsnapshot timeへseekしてpauseを維持。AM-2/AM-3の単独preview動作は変更しない。

### 実装済みファイル

| ファイル                                        | 目的                                                                                                                                                                                                             |
| ----------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/components/player/MiningPreviewDialog.tsx` | Mining Preview Dialog本体：mapped draft fields（image/audioはpreview-only）、screenshotAspectRatio wrap、audio preview、true two-thumb range slider（`onValueCommit`で自動素材更新）、bottom dock（ZoomOut / ZoomIn）。Stage 2の`ToggleGroup`（New / Update / icon-only Append session-only）+ `Send` button（New/Updateは新規/更新、Appendは選択カードへの追記）。AM-6c inline Data Table: pre-filtered saved note type, checkbox multi-select, 100-bound, selection count/pagination footer, 44px checkbox containment |
| `src/components/player/ui/aspect-ratio.tsx`     | shadcn AspectRatio wrapper（`@radix-ui/react-aspect-ratio` re-export）                                                                                                                                           |
| `src/components/player/ui/slider.tsx`           | shadcn Slider（thumb数をvalue/defaultValueから導出、stable index key）                                                                                                                                           |
| `src/components/player/PlayerControls.tsx`      | Top-rightにPickaxe Mineボタン追加（video/audio、AudioLinesの後・caption modeの前）                                                                                                                               |
| `src/components/player/PlayerApp.tsx`           | AM-4 state + lifecycle所有：snapshot、pause、capture、range、URL revoke、seek-back-on-close、AbortController分離                                                                                                 |
| `src/features/player/audio-clip.ts`             | `recordAudioClip`に`signal?: AbortSignal`追加。AM-4のcancelがstandalone AM-3に影響しない                                                                                                                         |
| `src/features/player/mining-viewport.ts`        | ASB-style range zoom純粋関数：`computeInitialViewport`、`zoomIn`、`zoomOut`、`canZoomIn`、`canZoomOut`、`reframeIfNeeded`                                                                                        |
| `src/features/player/subtitle-interval.ts`      | ASB-style >=50% overlap rule純粋関数：`selectCueTextInRange`。zero-length skip、blank filter、newline join                                                                                                       |
| `src/features/player/anki-export-client.ts`     | Stage 2 typed write client：`canAddNotes`、`addNote`、`storeMediaFile`、`findNotes`、`notesInfo`、`updateNoteFields`、`addTags`。read-only `AnkiConnectClient`とは構造分離。`blobToBase64`、`generateMediaFilename` helper付き |
| `src/components/player/AnkiAppendPanel.tsx`     | AM-6c inline append panel: deck-auto-load on expand, explicit search, TanStack/shadcn Data Table with checkbox multi-select, pre-filtered saved note type, 100-bound, selection count/pagination footer, 44px checkbox containment |
| `src/features/player/video-clip.ts`            | Video Clip recording: pure capability detection, codec order (AV1→VP8→VP9→generic), 45s center-clamp, 60s watchdog, Canvas frame capture → captureStream → silent WebM MediaRecorder, abort/epoch/mounted guards, full lifecycle cleanup |
| `src/components/player/ui/toggle-group.tsx`    | shadcn ToggleGroup/Item (Mining Image/Video mode selection) |
| `src/components/player/ui/data-table.tsx`       | Generic TanStack Data Table wrapper: column defs, sorting, pagination, checkbox row selection, `getRowState` / `footerStart` slots |
| `src/components/player/ui/table.tsx`            | shadcn Table primitives (Table, TableHeader, TableBody, TableRow, TableHead, TableCell) |
| `src/components/player/ui/checkbox.tsx`         | shadcn Checkbox (`@radix-ui/react-checkbox`) |
| `src/components/player/ui/input.tsx`            | shadcn Input |
| `src/i18n/types.ts` + `locales/{en,ja,id}.ts`   | AM-4用辞書キー20個追加 + AM-6c append panel keys |
| `src/styles/player.css`                         | `.entei-mining-*` dialog + image + audio player + range slider（accent selected range）+ bottom dock + input/textarea スタイル群                                                                                 |
| `tests/mining-preview-dialog.test.tsx`          | Component tests: draft fields表示、physical name labels、image/audio preview-only（入力欄なし）、full mapping 5 text controls、true two-thumb slider、Close、no external calls                                   |
| `tests/mining-integration.test.tsx`             | Integration tests: Mine button表示/非表示、disabled、click、snapshot pause/restore、unmount guard、no fetch/localStorage（12 tests）                                                                             |
| `tests/slider-thumb-count.test.tsx`             | Slider thumb count derivation: controlled value、defaultValue、fallback 1、mining 2-thumb（7 tests）                                                                                                             |
| `tests/mining-viewport.test.ts`                 | Pure helper unit tests: initial viewport、zoom in/out、media boundaries、short media、min span、selection invariance、reframe（29 tests）                                                                        |
| `tests/subtitle-interval.test.ts`               | Pure helper unit tests: >=50% overlap rule、boundary、zero-length skip、blank filter、newline join、ordering（15 tests）                                                                                         |
| `tests/anki-export-client.test.ts`              | Stage 2 export client unit tests: all 6 actions request shape、result parsing、error handling（HTTP/malformed/abort/network/api-key/permission）、blobToBase64、generateMediaFilename helpers                        |
| `tests/anki-export-integration.test.ts`         | Stage 2 export lifecycle integration tests: canAddNotes false→zero write、new success order、update first Send zero write、invalid target、confirm update mapped fields only、missing media、session key security、abort |
| `tests/anki-append-selection.test.tsx`          | AM-6c append panel: auto-load saved deck, explicit search, pre-filter saved note type, checkbox select/select-all, indeterminate, append success/partial/fail, abort/double-submit guard, no persistence, CSS contract (46 tests) |

### 設計遵守確認

| 項目                                                       | 状態 | 根拠                                                                                                                                                                                                                                                                                                       |
| ---------------------------------------------------------- | ---- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Pickaxeボタンはvideo/audioのみ                             | ✅   | `mediaType === 'video' \|\| 'audio'` のみレンダリング。nullでは非表示                                                                                                                                                                                                                                      |
| Top-right配置（AudioLines後・caption mode前）              | ✅   | `.entei-controls-top-right` 内で caption mode より前に配置                                                                                                                                                                                                                                                 |
| Mine開始でsnapshot + pause                                 | ✅   | `handleMine` で `snapshotTime = media.currentTime`、即 `media.pause()`                                                                                                                                                                                                                                     |
| Cancel/Closeでsnapshot timeへseek + pause維持              | ✅   | `handleMiningPreviewClose` で `media.currentTime = snapshotTime`、`media.pause()`                                                                                                                                                                                                                          |
| AM-2/AM-3単独preview動作不変                               | ✅   | `handleScreenshot` / `handleAudioClip` は既存のまま。snapshot pauseはAM-4専用                                                                                                                                                                                                                              |
| Screenshotはvideoのみ                                      | ✅   | `mediaType === 'video'` のみcapture。audioではunavailable表示                                                                                                                                                                                                                                              |
| Audio captureはdetached element                            | ✅   | `recordAudioClip` をそのまま使用。visible Playerのseek/rate/mute変更なし                                                                                                                                                                                                                                   |
| Range Sliderは0.1秒step                                    | ✅   | `step={0.1}`。初期値はactive cue start/end                                                                                                                                                                                                                                                                 |
| Range変更はdrag中にrefreshしない                            | ✅   | `onValueChange`は即時UI stateのみ。`onValueCommit`（thumb release / keyboard commit）で`handleRangeCommit`が全素材を自動更新                                                                                                                                                                               |
| Range commit時の自動更新                                    | ✅   | `handleRangeCommit`がcommitted `[start,end]`値でsentence/source/screenshot/audioを一括更新。`canRefresh`（mapped sentence/source/image/audio何れか更新可能）がfalseの時はSlider disabled                                                                                                                                                 |
| Media duration不明時はrange編集不可                        | ✅   | `Number.isFinite(duration)` で判定。Slider非表示、時間ラベルのみ表示                                                                                                                                                                                                                                       |
| URL lifecycle: revoke on replace/close/media/unmount       | ✅   | `replaceMiningScreenshotUrl` / `replaceMiningAudioUrl` でrevoke-before-replace。unmount effectでcleanup                                                                                                                                                                                                    |
| Epoch guard: stale result discard                          | ✅   | `miningEpochRef` モノトニックepoch。media変更・dialog閉・retry置換で進行                                                                                                                                                                                                                                   |
| Double-click guard                                         | ✅   | `isMiningRef` / `isMiningRefreshingRef` でsynchronous防止                                                                                                                                                                                                                                           |
| AbortController分離                                        | ✅   | AM-4専用 `miningAbortControllerRef`。standalone AM-3のcancelActiveRecordingと分離                                                                                                                                                                                                                          |
| Capture失敗はper-material error                            | ✅   | screenshot失敗→`miningHasScreenshotError`、audio失敗→`miningHasAudioError`。available materialは保持                                                                                                                                                                                                       |
| No Anki write / no localStorage / no fetch                 | ✅   | testで `fetch` / `localStorage.setItem` 呼び出しを検証                                                                                                                                                                                                                                                     |
| Dialog click伝播防止継続                                   | ✅   | 既存 `DialogContent` stopPropagation を再利用                                                                                                                                                                                                                                                              |
| `type='button'`                                            | ✅   | Pickaxe・Dialog X Closeは`type="button"`。Update materials buttonは削除済み                                                                                                                                                                                                                                        |
| Lucide Pickaxeのみ                                         | ✅   | `lucide-react` の `Pickaxe` icon。raw SVGなし                                                                                                                                                                                                                                                              |
| OKLCH tokenのみ                                            | ✅   | 新規CSSで `--entei-*` / `oklch()` / `color-mix()` のみ                                                                                                                                                                                                                                                     |
| `prefers-reduced-motion`                                   | ✅   | `.entei-mining-dialog` 各要素に `@media (prefers-reduced-motion: reduce)` で `transition: none`                                                                                                                                                                                                            |
| Touch target >=44px                                        | ✅   | `.entei-mining-audio-play-btn` / `.entei-mining-zoom-btn` は `min-height: var(--entei-touch-min)`                                                                                                                                                                                                        |
| Tabular numbers for time                                   | ✅   | `formatTime` 使用。slider範囲ラベルも `entei-mining-range-time` でtabular                                                                                                                                                                                                                                  |
| Mineはstandalone capture中disabled                         | ✅   | `canMine` に `!isCapturing && !isRecordingAudio` を追加。`handleMine` 先頭でref guard                                                                                                                                                                                                                      |
| AbortSignalはcanplay/seek/record全フェーズで即cancel       | ✅   | `recordAudioClip` 先頭でabort listener登録。`lifecycle.rejectPhase` でPending Promiseを直接reject                                                                                                                                                                                                          |
| AM-4: Anki field mappingでdraft fields制御                 | ✅   | `handleMine`で毎回`readAnkiMinerPreferences()`→`buildDraftFields()`。sentence未マッピング→draft空                                                                                                                                                                                                          |
| AM-4: physical field nameをvisible labelに                 | ✅   | `draftFields[].physicalName`をlabelとして表示                                                                                                                                                                                                                                                              |
| AM-4: sentence/definitionはtextarea、他はinput             | ✅   | `isTextarea`判定で`<textarea>`/`<input type="text">`を分岐                                                                                                                                                                                                                                                 |
| AM-4: 重複physical field名はdedomu（最初のsemantic優先）   | ✅   | `buildDraftFields`内で`Set`でseen tracking、最初のエントリのみ保持                                                                                                                                                                                                                                         |
| AM-4: image/audioはpreview-only（入力欄なし）              | ✅   | `isPreviewOnly`判定でinput/textareaをスキップ。ラベル+プレビューマテリアルのみ表示                                                                                                                                                                                                                         |
| AM-4: image/audio previewはmapping存在時だけ表示           | ✅   | `field.key === 'image'`/`'audio'`のsection内に条件付きレンダリング                                                                                                                                                                                                                                         |
| AM-4: screenshotをAspectRatio 16:9で囲む                   | ✅   | `<AspectRatio ratio={16 / 9}>`でscreenshot画像とskeletonをwrap。object-contain、cropなし                                                                                                                                                                                                                   |
| AM-4: true two-thumb range slider                          | ✅   | Sliderは`value`配列長からthumb数を導出。`[rangeStart, rangeEnd]`で2つのThumbを安定index keyで描画                                                                                                                                                                                                          |
| AM-4: ダイアログclose/new media/unmountでdraft stateクリア | ✅   | `clearMiningPreview()`で`setMiningDraftFields([])`、unmount cleanupでも実行                                                                                                                                                                                                                                |
| AM-4: localStorage/fetch/Anki呼び出しなし                  | ✅   | Previewでは`readAnkiMinerPreferences()`のみ。write/fetchは行わない                                                                                                                                                                                                                                         |
| AM-4: ASB-style range zoom viewport                        | ✅   | `mining-viewport.ts`純粋関数。Mine開始時に選択範囲周辺へviewport `[viewStart, viewEnd]`を自動初期化。Lucide `ZoomIn`/`ZoomOut` 44px icon buttonで半減/倍増。viewportはReact-memory-onlyでlocalStorage非永続化                                                                                              |
| AM-4: zoom時の選択範囲不変                                 | ✅   | zoomIn/zoomOutはviewportのみ変更。`rangeStart`/`rangeEnd`は一切変更しない。Sliderの`min`/`max`にviewportを使用                                                                                                                                                                                             |
| AM-4: 全素材自動更新（range commit）                        | ✅   | `handleRangeCommit`がsentence（`selectCueTextInRange` ASB >=50% rule）、source（`formatTime` label）、screenshot（visible video seek→capture→restore）、audio（`recordAudioClip`）を一括更新。user-edited definition/word/tagsは上書きしない。`onValueCommit`で発火、manual buttonは削除済み |
| AM-4: Range dock + subtitle markers                        | ✅   | Range areaを`.entei-mining-body`の外へbottom dock（`flex-shrink:0`）へ移動。subtitle-boundary marker ticksがviewport内のcue start位置に描画（`aria-hidden`、`pointer-events:none`）。footer Close button削除、Dialog X closeのみ。control row: ZoomOut LEFT / Send CENTER / ZoomIn RIGHT       |
| AM-4 Stage 1.1: Range commit auto-refresh                  | ✅   | Slider `onValueCommit`（thumb release/keyboard commit）が`handleRangeCommit`を呼び出し、committed `[start,end]`値でsentence/source/screenshot/audioを一括refresh。`onValueChange`は即時UI stateのみ（drag中はrefreshしない）。manual Update materials button削除済み。refresh中はSlider/zoom disabled。AbortController/epoch/mounted guard適用。no fetch/localStorage/Anki write |
| AM-6a Stage 2: New note export                             | ✅   | `AnkiExportClient`（write専用）。`handleExportSend`が`canAddNotes`→`storeMediaFile`（image/audio Blob base64）→`addNote`の順で実行。canAddNotes false→upload/addNoteしない。**新カード重複許可**: `options: { allowDuplicate: true, duplicateScope: 'deck', duplicateScopeOptions: { deckName: prefs.deck, checkChildren: false } }`をcanAddNotes/addNote両方へ送信（asbplayer互換）。Update modeは重複オプションなし。API keyはpage-lifetime React memory（localStorage非永続化）。`ToggleGroup type="single"`（New/Update/Append）。Lucide `Send` button。abort/epoch/double-submit guard。**tags**: top-level `prefs.tags`を`parseAnkiTags`で`string[]`化しcanAddNotes/addNote両noteへ渡す（new pathで`addTags`は呼ばない） |
| AM-6b Stage 2: Update latest note                           | ✅   | Update mode one-click Send: `findNotes('added:1')`→max noteId→`notesInfo`→model validation→`storeMediaFile`（if available）→`updateNoteFields`。候補確認ステップ削除（candidate UI/state/i18n全削除）。missing mediaは既存fieldをwipeしない。target model mismatch/no candidate/notesInfo malformed→zero write。Send labelはNew/Update両モードで`Ankiへ送信`固定。**tags**: `updateNoteFields`成功後、`prefs.tags.trim()`非空なら`addTags([noteId], tags)`（additive・失敗はexport error）。空なら呼ばない |
| AM-6c Stage 2: Append to existing cards                     | ✅   | 3つ目icon-only session-only ToggleGroupItem。選択で`AnkiAppendPanel`inline展開。saved deck auto-load → explicit typed search → TanStack/shadcn Data Table (checkbox multi-select, Sentence/Note type/Note ID)。saved note type pre-filter（不一致noteは非表示）。100件bounded。成功ID自動除去、失敗ID保持。append-only: `existing<br>incoming`。media Blob 1回upload再利用。AbortController/epoch/mounted/double-submit guard。no api/media/card/selection persistence。**tags**: field update成功後に`addTags`（update→addTags順）・field更新なし+tags非空はaddTagsのみで成功・addTags失敗はfailed |

### 検証結果

```text
npm run format:check   ✅ pass
npm run test           ✅ 37 files, 872 tests pass
npm run check          ✅ 0 errors, 0 warnings, 0 hints
npm run build          ✅ static build complete
```

### 未解決・browser QA待ち

| 項目                         | 理由                                       |
| ---------------------------- | ------------------------------------------ |
| Mine開始後のsnapshot pause   | ✅ 実local mediaで確認済み                 |
| Cancel/Close後のseek + pause | ✅ 実local mediaで確認済み                 |
| Range slider 0.1秒step       | ✅ 実local mediaで確認済み                 |
| Range zoom viewport          | ✅ ZoomIn / ZoomOutと2 thumbを実機確認済み |
| Range commit時の全素材更新   | ✅ range変更後のcommitで全素材自動更新を実機確認済み |
| 4K動画でのscreenshot         | `captureVideoFrame` 再利用。実機未確認     |

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
| 接続成功・mapping未完 | Deck / Note type / field Select（選択で auto-save、valid 時のみ localStorage へ） | なし   |
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

Tagsはnote field mappingではない。**top-level設定**（`AnkiFieldsTab`のtext input・space区切り・例 `anime n5 eizou`）としてlocalStorageの`tags`に保存し、export時に:
- New note: `note.tags`（`string[]`）へ渡す（`addTags`は呼ばない）
- Update / Append: `updateNoteFields`成功後に**additive `addTags`**（`{ notes: [id], tags: '...' }`）で既存タグへ追加
- 空白のみ/空欄: tag APIは一切呼ばない
- tag文字列はphysical note fieldへ書かない
- **ASB parity（asbplayer common/anki/anki.ts: updateNoteFields → await addTags）**: `updateNoteFields`成功後の`addTags`失敗はcatchしない。Updateはexport全体をfailed扱い（success toast / historyなし）、Appendはそのnoteをfailed扱い（succeededに入れない）。**field更新が先行し得るため、同じAppendの自動再試行はしない**（partial success state・tag-only retry・二重field update対策は設けない）

Deckを変えてもNote typeを勝手に変えない。Note typeを変えたらfield一覧だけを再読込し、存在しなくなったmappingは「未選択」に戻す。auto-saveは有効なpreset（Deck、Note type、Sentence）が揃った時だけ発火する。

### 6.4 MiningはSettings tabを持たない

initial ANKI_MINERでは、capture format・post-mining playback・MP3再encodeをuser settingにしない。Mine操作は常にMining Previewを開く固定動作で、Stage 2のnew / update actionはPreviewのbottom dock内のmode selectorで選ぶ。

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
- range sliderはDialog内で調整できる。drag中は表示だけ更新し、thumbを離した時だけ素材をローカル再生成する（Stage 1.1実装済み）
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
  → valid selection時だけ auto-save（local only・API key は含まない）

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

### 10.2 Stage 1.1のrange commitとStage 2のmode UI

range sliderの動作を2段階に分ける。

```text
onValueChange    drag中のrange表示だけを更新
onValueCommit    thumbを離した時だけ、文章・出典・画像・音声を同じrangeから自動更新
```

これでrangeを細かく探している途中に何度も録音せず、操作を終えた時だけ素材を揃え直せる。`Update materials`buttonは削除済み。

bottom dockには次の順で置く。

```text
[ ToggleGroup: New | Update | 🔍 Append ]    [ Send Ankiへ送信 ]
```

3つのmode controlはshadcn `ToggleGroup type="single"`にする。New/Updateはpersistent（localStorage保存）。Appendはsession-only（icon-only、再openでNew/Updateへ復帰）。Append選択時は`AnkiAppendPanel`がinlineで展開し、auto-load→explicit search→Data Table表示。`Send`buttonはcurrent mapping、Deck、Note type、Anki connectionが検証済みの時だけenabledにする。

`Ankiへ送信`を押した時の意味はmodeごとに異なる。

```text
新カード: canAddNotes → media upload → addNote
カード更新: findNotes('added:1') → max noteId → notesInfo → media upload → updateNoteFields
Append: checked note IDs → revalidate notesInfo → append existing<br>incoming mapped fields → media once
```

### 10.3 新規noteのExport順序（AM-6a）

```text
Ankiへ送信（新カードmode、user gesture）
  → payloadを最終validate
  → canAddNotes
  → mediaのAnki upload準備
  → addNote
  → 成功responseを受ける
  → 成功toast + capture開始位置へ戻してpause
```

`canAddNotes`がfalseなら`addNote`を呼ばない。`addNote`のresponse前に「送信済み」と表示しない。

### 10.4 最後に追加されたAnki noteを更新（AM-6b）

これは「Entei sessionで最後に送ったnote」ではない。AnkiConnectへqueryして、Anki側で最後に追加されたcandidateを見つける。

```text
Update latest
  → findNotes('added:1')
  → 最大note IDをcandidateにする
  → notesInfoでcurrent Note typeを検証
  → 必要ならmediaをupload
  → updateNoteFields
```

asbplayerと同じく、`findNotes('added:1')`の結果から最大note IDを選ぶ。Anki公式の`added:1`は「今日追加されたcard」の検索なので、これは**ASBと同じ“直近追加card”契約**であり、全履歴のglobal sortを作る機能ではない。

園庭では次のcontractにする。

- `findNotes('added:1')`で候補を読む
- 結果があれば最大note IDをlatest candidateにする
- 結果がなければ「今日追加されたAnki cardはない」と表示し、書込みは行わない
- `notesInfo`でcandidateがcurrent Note typeを満たさない時は書込みを行わない
- 候補表示や2回目の確認buttonは持たない。`Ankiへ送信`の1クリックで完了する

### 10.5 AM-6c inline append panel

AM-6cは、New / Update latestと同じToggleGroupの3つ目にある、icon-only・session-onlyのAppend modeである。Modalを閉じて開き直すと、保存済みのNewまたはUpdate latestへ戻る。

**実際の実装**（inline panel）:

```text
Append mode selected → AnkiAppendPanel expands inline
  → auto-load: deck:"<escaped deck>" → bounded 100 results → saved-note-type pre-filter
  → Data Table: checkbox multi-select, Sentence/Note type/Note ID columns
  → explicit typed search replaces default deck results
  → Send: checked note IDs → revalidate notesInfo → append existing<br>incoming
  → append-only: existing + <br> + incoming; empty target = incoming; no overwrite
  → media: Blob stored once, reused markup across cards; upload only if target field exists
  → success: remove succeeded IDs from selection; failed remain for retry
```

- saved Note typeと違うnoteはData Tableへ表示しない。表示されたnoteは全て選択できる
- `noteId`がない、または選択済みnoteがない時はSendをdisabledにする
- Search queryはAnki query syntaxとして扱う。deck名 / field名 / user textを連結する時はescapeし、raw queryを勝手に書き換えない
- candidate listはページングまたは安全な上限を持ち、巨大collectionの全note detailを一括で取らない

### 10.6 update payloadの契約

> **設計時の記録。** 以下は旧仕様（replace-only policy）。AM-6c appendはappend-only (`existing<br>incoming`) に変更済み。AM-6a/AM-6bは置換動作のまま。

`updateNoteFields`へ渡すのはcurrent previewでmapping済みのfieldだけ。Audio / screenshot captureが失敗したからといって既存fieldを空文字で消さない。

- AM-6a（新カード）: `addNote`で新規作成（overwrite概念なし）
- AM-6b（更新）: `updateNoteFields`で既存fieldを**置換**
- AM-6c（append）: `updateNoteFields`で既存fieldに`<br>` + incomingを**追記**（置換しない）

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

**Panel layout persistence (`entei.player.panel-layout.v1`):** Desktop side-panel width ratios are persisted separately as two percentage numbers (mainPct, sidePct). No media name/path, subtitle data, history data, Anki data, credentials, or active tab is stored. Corrupt/out-of-range values default to 76%/24%. See `src/features/player/panel-layout.ts`.

## 12. component / module構成

```text
apps/web/src/
├── components/player/
│   ├── PlayerSettingsDialog.tsx       # Settings iconのModal本体
│   ├── AnkiFieldsTab.tsx              # read-only接続 + mapping
│   ├── MiningPreviewDialog.tsx        # capture結果、range commit、自動素材更新、明示Export + AM-6c ToggleGroup/inline panel
│   ├── AnkiAppendPanel.tsx            # AM-6c inline Data Table: deck-auto-load, search, checkbox multi-select
│   ├── PlayerControls.tsx             # Top-right controls: Mine button etc.
│   └── ui/
│       ├── tabs.tsx                   # shadcn CLI生成
│       ├── select.tsx                 # shadcn CLI生成
│       ├── toggle-group.tsx           # shadcn CLI生成: New / Update / Append mode選択
│       ├── toggle.tsx                 # shadcn CLI生成
│       ├── input.tsx                  # shadcn CLI生成: append search
│       ├── checkbox.tsx               # shadcn CLI生成: Data Table row selection
│       ├── dialog.tsx                 # shadcn CLI生成
│       ├── data-table.tsx             # TanStack Data Table wrapper
│       ├── table.tsx                  # shadcn CLI生成: Table/TableHeader/TableBody/TableRow/TableHead/TableCell
│       ├── scroll-area.tsx            # shadcn CLI生成
│       ├── slider.tsx                 # shadcn CLI生成: range slider
│       ├── aspect-ratio.tsx           # shadcn CLI生成: screenshot 16:9
│       ├── badge.tsx                  # shadcn CLI生成
│       ├── button.tsx                 # shadcn CLI生成
│       ├── popover.tsx                # shadcn CLI生成
│       ├── toast.tsx                  # shadcn CLI生成
│       └── separator.tsx              # shadcn CLI生成
├── features/player/
│   ├── anki-miner-preferences.ts      # localStorage schema / validation
│   ├── anki-connect.ts                # typed request client、read/write分離
│   ├── anki-export-client.ts          # Stage 2 write client: addNote/updateNoteFields/findNotes/notesInfo
│   ├── screenshot-capture.ts          # canvas → JPEG Blob
│   ├── audio-clip.ts                  # capability / MediaRecorder
│   ├── mining-session.ts              # snapshot / fixed pause restore
│   ├── mining-payload.ts              # mapping → preview / canAddNotes payload
│   ├── mining-viewport.ts             # ASB-style range zoom
│   └── subtitle-interval.ts           # ASB-style >=50% overlap rule
└── tests/                             # 37 test files, 872 tests
```

`PlayerApp`はmedia / playback stateの唯一の所有者のままにする。Anki tabやMining Previewがvideo refを直接勝手に操作しない。必要な操作はtyped callbackで`PlayerApp`へ依頼する。

## 13. shadcn導入手順

Dialog / Button / ScrollArea / Slider / Popover / Tabs / Selectに加え、ToggleGroup / Input / Checkbox / Tableも導入済み。

- `ToggleGroup`: New / Update / Append mode選択
- `Input`: AM-6c append search
- `Checkbox`: AM-6c Data Table row selection
- `Table`: shadcn Table primitives (Table / TableHeader / TableBody / TableRow / TableHead / TableCell)
- `Badge`: status display

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
| mining playback  | AM-4: capture後にsnapshot timestampへ戻りpause、Cancel / success / failureで同じ、二重完了なし            |
| screenshot       | metadataなし、canvas不可、`toBlob` null / throw、成功Blob cleanup、stale / unmount / double-click guard   |
| audio capability | MediaRecorderなし、MIMEなし、enabled trackなし、active cue終端、seek順序、duration fallback、cleanup      |
| Anki request     | version error、permission/API key、deck/model/field load、`canAddNotes` false、`addNote` error            |
| latest target    | 当日candidate、candidateなし、最大note ID、target Note type不一致、`notesInfo` error、one-click update（確認ステップなし） |
| append panel    | deck auto-load、explicit search、saved note type pre-filter、checkbox select/select-all、append success/partial/fail、abort guard、no persistence |
| update request   | mapped fieldsだけ送信、`updateNoteFields` error、既存fieldを空で消さない |

### 14.2 browser manual gate

| 状況                  | pass条件                                                                                                                              |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| Settings Modal        | ✅ Settings icon → focusがModalへ、Escape → iconへ戻る                                                                                |
| Anki未起動            | ✅ localized error、playerは壊れず、書込みなし                                                                                        |
| origin permission拒否 | ✅ CORS案内が読め、auto-retryで勝手に設定を変えない                                                                                   |
| mapping               | ✅ Deck / Note type変更でfield一覧が正しく更新される                                                                                  |
| Screenshot            | ✅ local videoでframe一致、Closeでpreview URL解放                                                                                     |
| Audio                 | ✅ Chromiumでactive cue Preview再生、Modal clickで背後Playerをresumeしない、cue duration表示が正しい。unsupported browser実機は未確認 |
| mining preview        | ✅ AM-4: range zoom / marker / dock / Update materials、Cancelでcapture開始timestampへ戻りpauseを実機確認                             |
| range commit          | ✅ Stage 1.1: thumbを離した時だけ全素材を自動更新。drag中は録音・Anki requestなし                                                     |
| Export                | ✅ Stage 2: `canAddNotes` falseで`addNote`ゼロ回、成功response後だけ成功表示                                                          |
| Update latest         | ✅ AM-6b: `findNotes('added:1')` → max noteId → one-click update。candidateなしなら書込みゼロ |
| Append panel          | ✅ AM-6c: inline Data Table、deck auto-load、explicit search、checkbox multi-select、append-only、成功ID自動除去 |
| privacy               | DevTools Networkでmedia / Blob / subtitle本文が外部送信されない                                                                       |

### 14.3 実Anki gate

Stage 1.1、Stage 2、AM-6cの実AnkiConnect QAはYosia確認済み。今後の新しいAnki書込み機能は、実装前に対象Deckと書込み範囲を再確認する。

## 15. 採用しない選択肢

| 選択肢                                | 採用しない理由                                          |
| ------------------------------------- | ------------------------------------------------------- |
| Settings Popoverへmappingを追加       | 縦長・接続error・Selectが収まらず、focus管理も悪化する  |
| `Mine`で即`addNote`                   | 誤Deck / 誤field / capture失敗を確認できない            |
| API keyをlocalStorageへ保存           | browser storageでは秘密を守れない                       |
| 複数presetを最初から実装              | active mapping 1つの実需確認前にprofile managerを増やす |
| Audio Clipを全browser必須にする       | native capture API / codec対応に差がある                |
| Screenshot / audioを外部serviceへ送る | local-firstとprivacy契約に反する                        |

### 15.1 将来候補: DenChou Scenes

DenChouのmulti-scene cardへ新しいsceneだけをHTML group wrapperで追記する拡張は、複数profileとは別の機能として扱う。通常note typeのraw export / `<br>` appendは変えない。code-side自動固定wrapper（`<span class="group">…</span>`）、New note/Append payload wrapping、872 testsが実装済み。活用形を扱うWord Highlightはdeferred。詳細な適用範囲、export契約、実装gateは[DENCHOU_SCENES.md](./DENCHOU_SCENES.md)を正とする。

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
| asbplayerは`added:1`候補の最大note IDをupdate last対象にする          | `A:\asbplayer\common\anki\anki.ts:545-582`                       | Enteiも`added:1`最大noteIdを採用。候補確認ステップは廃止、one-click update。AM-6cはinline Data Table + checkbox multi-select |
| AnkiConnectは`findNotes` / `notesInfo` / `updateNoteFields`を提供する | AnkiConnect official docs（Context7, 2026-07-22）                | candidate確認後のspecific updateを実装                                          |
| Anki公式の`added:1`は今日追加されたcard creation検索                  | Anki Manual Search（Exa, 2026-07-22）                            | ASBと同じlatest candidate発見に使い、candidateなしなら更新しない                |
| audio captureはbrowser capability差がある                             | `A:\asbplayer\common\audio-clip\audio-clip.ts:61,317,436-440`    | capability gate + honest fallback                                               |
| AnkiConnectは`version`、model / field APIを提供する                   | AnkiConnect official docs（Context7, 2026-07-22）                | read-only設定から開始し、`canAddNotes`を先に通す                                |
| 現planもPreviewと明示Exportを安全条件にする                           | `docs/PLAYER_PHASES.md:235-263`                                  | auto exportを禁止                                                               |
