# Video Clip — 無音WebM Mining設計

> **状態:** 実装済み（Image/Video ToggleGroup選択、自動JPEG/WebMキャプチャ）。
> **対象:** local videoのMining rangeから、無音WebM clipを作り、既存のpicture/image mappingへ送る。

---

## 1. 人間語でいうと

現在のScreenshot JPEGの代わりに、選んだ字幕rangeの短い無音動画をAnki cardへ付ける機能。

Audio Clipは既存の`sentenceAudio` mappingへ独立して送る。Video Clipへ音声trackを合成しない。

```text
Mining range
  → local videoをhidden capture videoでseek / 再生
  → canvasへframeを描画
  → canvas.captureStream + MediaRecorder
  → 無音 .webm Blob
  → Mining Previewでvideo preview
  → picture/image fieldへ <video ...> を送る
```

## 2. asbplayerとの対応

asbplayerのlocal-file WebM fragmentを、extension / streaming層なしで参照する。

| 契約 | asbplayer evidence | Entei方針 |
| --- | --- | --- |
| WebM source | `common/src/webm-file-media-fragment-data.ts` | pure capture logicだけを参考/移植する |
| capture経路 | canvas → `captureStream()` → `MediaRecorder` | 同じ。visible Playerを録画sourceにしない |
| codec順 | AV1 → VP8 → VP9 → generic WebM | 同じ順で`MediaRecorder.isTypeSupported()`をprobe |
| 最大clip長 | ASB defaultは`mediaFragmentMaxClipLength: 10000` ms | 園庭では45秒。長いrangeはASB同様に中心基準でclamp |
| Anki markup | `<video autoplay loop muted playsinline src="...">` | 同じ。既存picture/image mappingへ入れる |

asbplayerはMIT (`A:\asbplayer\LICENSE.md:1-13`)。直接移植した純粋logicには該当copyright / permission noticeを残す。園庭全体のMPL-2.0を置換しない。

## 3. 固定v1契約

### 3.1 Browser capability

次をすべて満たす時だけVideo Clipを有効にする。

1. local mediaがvideoである
2. `HTMLCanvasElement.prototype.captureStream`がある
3. `MediaRecorder`がある
4. AV1 / VP8 / VP9 / generic WebMのいずれかを`MediaRecorder.isTypeSupported()`が受ける
5. canvas 2D contextとvideo dimensionsが有効

1つでも満たさなければVideo Clip UIを出さず、現在のJPEG Screenshot + Audio Clipを維持する。FFmpeg、MP4 re-encode、silent fallback fileは作らない。

### 3.2 Recording

- **出力:** 無音`video/webm` Blob
- **最大clip長:** 45秒。rangeが長い時はASB式にrange中央を基準にclamp
- **encode watchdog:** 60秒。これはclipの長さではない
- **codec順:** `video/webm;codecs=av1` → `vp8` → `vp9` → `video/webm`
- **frame capture:** `captureStream(0)` + `requestFrame()`を優先し、なければ固定frame rateへfallback
- **source:** 元のvisible Playerと独立したtemporary `HTMLVideoElement`。visible Playerのtimestamp / pause / rateを変えない
- **競合:** Screenshot / Audio Clip / Video Clipは同時captureしない。既存のabort / epoch / mounted guardと同じ所有権を持つ
- **cleanup:** recorder stop、全MediaStream track stop、hidden video pause / src解除、timeout解除、temporary Blob URL revokeをcancel / media変更 / Dialog close / unmountの全経路で行う

### 3.3 PreviewとAnki export

- Mining PreviewはJPEG image previewの代わりにnative `<video muted controls>` previewを表示する
- picture/image field mappingがある時だけWebM Blobを`storeMediaFile`する
- New / latest Update / Appendの既存export modeを使う
- export markupは`<video autoplay loop muted playsinline src="filename.webm"></video>`
- Appendは既存picture fieldを壊さず、通常のmedia append規約で末尾へ追加する
- picture/image mappingがない時はWebMを生成・uploadしない

## 4. 非対象

- WebM内へaudio trackをmixする
- MP4 / FFmpeg / browser内transcode
- streaming site capture、extension、tab capture
- 45秒超clipの設定UI
- Video Clip単独のAnki field mapping（既存picture/image mappingを使う）
- PGS/SUPやYomitan/furiganaとの統合

## 5. 実装順

1. `video-clip.ts`: capability / codec選択 / 45秒range解決のpure functions + unit tests
2. detached video + canvas frame loop + MediaRecorder + 60秒watchdog + teardown
3. Mining PreviewへVideo Clip skeleton / native video previewを追加。JPEGとVideo Clipの状態を排他的にする
4. Anki exportで既存picture/image fieldにWebM markupを扱えるようにする
5. Chromiumのreal local fileでmanual QA。unsupported browserではJPEG fallbackを確認

## 6. 実装gate

1. 3〜45秒のlocal MP4 / MKVから無音WebMを作れ、preview再生できる
2. 45秒超rangeが中心基準で45秒にclampされる
3. codec非対応、seek失敗、frame stall、60秒timeout、cancel、media変更、Dialog close、unmountでresource leakがない
4. visible Playerのtimestamp / pause / rateがcapture中も変わらない
5. New / latest Update / AppendでAnkiのpicture fieldに`<video>` markupが正しく入る
6. video capabilityなし / audio-only mediaではJPEG Screenshot + Audio Clipの既存動作を壊さない

## 7. 関連文書

- 現在の採掘 / Anki export: [ANKI_MINER.md](./ANKI_MINER.md)
- Player全体の段階計画: [PLAYER_PHASES.md](./PLAYER_PHASES.md)
