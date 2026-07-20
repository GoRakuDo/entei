# 園庭 Player — 段階プラン

> **状態:** P1 code implementation complete — 手動browser QA待ち。P2-P7はDRAFT。
> **作成日:** 2026-07-20
> **対象:** `Entei/apps/web` の `/player/`。Home Phase 0 は変更しない。
> **P1実装承認:** 2026-07-20にYosiaが明示承認済み。P2以降は各gate通過後に別途承認すること。

---

## 1. まず結論

園庭のPlayerは、**ローカルにある動画と字幕を使って学習するasbplayer相当のPlayer**を目指す。

- asbplayerのstandalone（local media）機能は段階的に含める
- **Streaming Video Integrationだけは最初から入れない**
- Homeは今のAstro + 園庭の独自CSSのまま維持する
- `/player/`だけを、browser-onlyのReact island（「Player部分だけがブラウザで動く部屋」）にする
- shadcn/uiは操作部品の土台として使い、見た目は園庭のOKLCH token・font・game hubらしさで上書きする

これは「asbplayerの画面をそのまま移す」計画ではない。**学習機能の互換性を持ち、園庭のUIで使えるPlayerにする**計画。

---

## 2. 確認済みの根拠

| 事実 | 根拠 | 何を意味するか |
|---|---|---|
| asbplayerはlocal websiteとstreaming extensionを別形態として扱う | `A:\asbplayer\docs\docs\intro.md:30-32` | 家でローカル動画を使う道具と、外部サイトへ入るbrowser extensionは、元から別の部屋として切り離せる。 |
| streaming側だけがtab capture・active tab・全URLへのアクセスを求める | `A:\asbplayer\extension\wxt.config.ts:175-215` | 園庭がextensionを持たなければ、これらの強い権限も持たない。 |
| local Playerの再生modeは5種類で、独立した状態機械になっている | `A:\asbplayer\common\src\model.ts:298-304`、`common\app\services\play-mode-manager.ts:13-119` | 再生modeは見た目のtoggleではなく、順番・競合・resetを持つ機能。後回しではなく専用Phaseでテストする。 |
| 字幕はSRT/VTT/ASSからPGS/TTMLまで複数形式を読める | `A:\asbplayer\common\subtitle-reader\subtitle-reader.ts:165-432` | 初期に日常的な3形式を通し、画像字幕など失敗しやすい形式は別Phaseで安全に足す。 |
| Anki exportはtextだけでなくaudio/image/WebMと新規・更新modeを扱う | `A:\asbplayer\common\anki\anki.ts:177-221, 488-595` | 「Ankiへ送る」だけでは完成ではない。メディア・field mapping・更新・失敗時の扱いを順番に作る必要がある。 |
| 現在のEnteiにはReact/Tailwind/shadcnがない | `Entei/apps/web/package.json:15-29` | Player Phase開始時にだけ必要なUI基盤を追加し、Homeを移行しない。 |
| AstroはReact componentをclient-only islandとして載せられる | Astro公式 docs: `client:only="react"` | DOM API前提のvideo・MediaRecorderをSSRから隔離できる。 |
| shadcn/uiはAstroを公式対応し、Astro componentから利用できる | shadcn公式 Astro template / installation docs | dialog・slider・sheetなどのaccessibility土台を再実装しなくてよい。 |

---

## 3. プロダクト境界

### 3.1 園庭Playerに入れるもの

| 分類 | 入れる機能 | 目標Phase |
|---|---|---:|
| local media | ローカルvideo/audio、drag & drop、File System Accessによる再接続 | P1 / P5 |
| subtitles | selectable subtitle、track、offset、subtitle list、cue seek、SRT/VTT/ASSからYouTube字幕形式・Netflix IMSC・PGS/TTML/BBJSONまでの複数形式 | P1 / P5 |
| learning playback | Normal / Condensed / Auto-pause / Fast-forward / Repeat、rate、keyboard shortcut | P1 / P2 |
| mining | screenshot、audio clip、WebM clip、range調整、dialog-less mining、history | P3 / P5 |
| Anki | connection permission、deck/note type/field mapping、新規・update last・specific update、media upload | P4 |
| settings | profile、shortcut、subtitle appearance、import/export、resume preference | P2 / P5 |
| annotation | Yomitan、local/Anki/WaniKani word status、reading、pitch、frequency | P6 |
| analytics for learning | Word Browser、comprehension/statistics、media内の理解度 | P6 |
| standalone extras | copy history、SRT export、WebSocket client、online subtitle sources | P7 |

### 3.2 永久に入れないもの — Streaming Video Integration

これは「後で隠す」ではなく、source・dependency・permissionの境界から持ち込まない。

| 除外するもの | 理由 |
|---|---|
| Chrome / Firefox extension | ローカルPlayerだけなら不要。`tabs`、`activeTab`、`tabCapture`などの権限も不要になる。 |
| Netflix / YouTubeなどのsite注入 | 外部サイトのDOM・CSP・仕様変更へ追従する責務を園庭は持たない。 |
| streaming video自動検出 | URL・tab・site adapterを扱うため除外する。 |
| extension overlay / context menu | streaming site上へ出すUIなので除外する。 |
| streaming録音のre-record | local fileのaudio captureとは別の経路なので除外する。 |
| streaming screenshotのcrop / delay workaround | tab captureやsite構造に依存するため除外する。 |

**含め続けるもの:** ダウンロード済みのYouTube字幕ファイル、WebSocket client、local file向けCondensed playbackはstreaming integrationではない。名前だけで一緒に捨てない。

---

## 4. UIとアーキテクチャ方針

### 4.1 UIの責務分け

```text
Astro shell
├── Home（既存。変更しない）
└── /player/
    └── React client-only island
        ├── 園庭 Player feature code
        ├── shadcn/ui（操作とaccessibilityの土台）
        ├── 園庭のOKLCH CSS variables / fonts
        └── browser APIs（video / IndexedDB / File System Access / MediaRecorder）
```

- **shadcn/ui:** Button、Dialog、Sheet、Tabs、Slider、Tooltip、Select、Switch、Scroll Areaなどを使う。
- **園庭:** color、spacing、font、motion、information hierarchyを決める。shadcnのdefault themeをそのまま出さない。
- **Home:** Tailwind migrationをしない。Player feature内から始め、既存Home CSSへのblast radiusを抑える。
- **再利用:** asbplayerの純粋ロジックは、license確認済みの上で参考・移植候補にする。React/MUI画面全体は移植しない。

### 4.2 初期folder案

```text
apps/web/src/
├── pages/player.astro
├── components/player/          # React UI
│   ├── PlayerApp.tsx
│   ├── PlayerViewport.tsx
│   ├── SubtitlePanel.tsx
│   └── ui/                     # shadcn generated components
├── features/player/
│   ├── media-session.ts
│   ├── subtitle-reader.ts
│   ├── playback/
│   ├── mining/
│   ├── anki/
│   └── annotations/
└── styles/player.css
```

最初から独立npm packageにはしない。Player以外で同じcoreを使う実需が出てから切り出す。これはYAGNIを守るため。

---

## 5. Phase P1 — Local Playerの縦切り

### 人間語でいう完成形

**動画を選ぶ → 字幕を選ぶ → 文章を押す → その場面から再生する**が、local fileだけでできる状態。

### 含めるもの

1. `/player/` routeとReact + Tailwind + shadcn/uiの基盤
2. `client:only="react"`でbrowser-only Playerを起動
3. local video/audio file選択、drag & drop
4. object URLの作成・解除。動画を替えた時に古い大きなfileを保持しない
5. SRT / VTT字幕読込。ASSはasbplayerと同じ`ass-compiler` dependencyのlicense・maintenance・Astro compatibilityをP1開始前に確認してから入れる。確認を通せない場合はP5へ送る。
6. selectable subtitle表示、subtitle list、current cue同期、cue click seek
7. play / pause / seek / volume / playback rate
8. 最小keyboard shortcut（play/pause、前後cue、current cue先頭へseek）
9. localStorageで、UI preferenceだけを保存する
10. Player未対応browser / 壊れた字幕 / unsupported formatを、無言で失敗させず画面に出す

### P1では入れないもの

- AnkiConnect・mining・screenshot・audio clip
- Condensed / Auto-pause / Fast-forward / Repeat
- PGS/SUP、TTML/DFXP、WebM clip
- Yomitan / Anki word status / WaniKani / statistics
- Streaming機能全般

### P1のDone条件

| 種別 | 確認 |
|---|---|
| unit | SRT/VTT parsing、cue sorting、offset、object URL cleanupをtestする。ASSはdependency確認を通した時だけ同じPhaseへ追加する。 |
| browser | 実local `.mp4` + `.srt`、`.vtt`でsubtitle click seekを確認する。ASSはdependency確認を通した時だけ同じPhaseへ追加する。 |
| keyboard | Mouseなしでplay/pause・cue移動・focus移動ができる |
| responsive | desktop / tablet / mobileでvideoとsubtitle listが重ならない |
| safety | 選んだlocal mediaは外部uploadしない。network requestをDevToolsで確認する |
| regression | Homeの57 test、Player test、`astro check`、buildがすべて通る |

### P1 gate

P1を終えても、「機能を増やす」前に実local mediaで以下が通るまでP2へ進まない。

- 30分以上のvideoを読み込み、seekを繰り返しても操作不能にならない
- subtitle fileを差し替えても前のtrackが残らない
- Playerを離れた時にobject URL / event listenerが解放される
- ページrefresh後、media本体を勝手に復元しようとして失敗しない

---

## 6. Phase P2 — 学習再生と設定

### 目標

「字幕の空白を飛ばす」「一文ごとに止める」「一文を繰り返す」が、再生状態を壊さず使える。

### 含めるもの

- Normal / Condensed / Auto-pause / Fast-forward / Repeat
- CondensedとFast-forwardの競合解決
- Auto-pauseの開始/終了設定
- subtitle trackごとの対象指定
- subtitle offsetの保存とreset
- custom keyboard shortcutと競合表示
- subtitle appearance（位置・size・alignment）
- settings profile、settings import/exportの土台
- clipboardへcurrent subtitleをcopyする機能

### 根拠と注意

asbplayerではCondensedとFast-forwardが競合する（`play-mode-manager.ts:15-16`）。さらにAuto-pause/Repeat/Condensedはcue終了時に相互作用するため、`playback-mode-effects.test.ts:127-256`のように状態遷移をunit testで固定する。

### P2のDone条件

- 5 modeすべてを単独・組み合わせでtestする
- Condensed / Fast-forward同時ONを許さない
- rateをFast-forward解除時に元へ戻す
- keyboard shortcut変更後もbrowser標準shortcutを不用意に奪わない
- localStorage failure / private modeでもPlayerが起動する

---

## 7. Phase P3 — Mining素材と履歴

### 目標

字幕を選んで、カードに入れる文章・静止画・音声を**ローカルで確認**できる。

### 含めるもの

- mining dialog（shadcn Dialog）
- selected rangeのslider
- sentence / track / definition / word / source / tagsの編集
- JPEG screenshot capture
- browser-native WebM/Opus audio clip生成とpreview/download。P3では再encodeを増やさない。
- surrounding subtitles
- IndexedDB mining history
- historyから再選択、audio/image download、SRT section export

### 先にJPEG + audioを作る理由

MediaRecorderは比較的広く使えるが、`HTMLMediaElement.captureStream()`はbrowser互換性が限定的。P3は壊れにくいJPEG + browser-native audioを先に通し、WebM **video** clipとMP3再encode（asbplayerの`lamejs`相当）はP5でcapability check付きにする。

### P3のDone条件

- range変更に応じてsentenceとaudioが更新される
- capture失敗がcard dataを壊さず、再試行できる
- history上限を越えた時の削除順をtestする
- local mediaを外部uploadしない

---

## 8. Phase P4 — AnkiConnect

### 目標

Ankiを明示的に許可した人だけが、preview済みのcardをAnkiへ送れる。

### 接続の順番

```text
Player設定を開く
  → requestPermission
  → version確認
  → API keyの要否（必須かどうか）を確認
  → deck / note type / field一覧を読込
  → userがmappingを確認
  → mining dialogでpreview
  → userがExportを押す
  → media upload + note create/update
  → 成功/失敗を明示表示
```

### 含めるもの

- `requestPermission`、`version`、API keyの扱い
- deck / note type / field mapping
- add note、Open in Anki、update last、update specific
- audio / image / WebM media upload
- duplicate・field mismatch・Anki未起動・CORS denialの表示
- failed exportで生成済みmediaを残さないcleanup
- actual Anki profileを使うintegration test（Yosia承認後のみ）

### 安全ルール

- 設定読込はread-onlyでも、export / updateは必ずuserの明示操作からだけ行う
- API keyはログ・URL・exported settingsへ平文で出さない
- production originでは最初にAnkiConnect permission dialogを出す
- `addNote`成功前に「送信済み」と表示しない

### 根拠

asbplayerはexport時にfield mapping・audio/image encoding・新規/更新modeをまとめて扱う（`anki.ts:488-595`）。AnkiConnect側はorigin permissionを先に要求し、API keyが必須かどうかも返す仕様なので、この順番を崩さない。

---

## 9. Phase P5 — 高度なlocal mediaと復元

### 含めるもの

- PGS/SUP image subtitles
- NFIMSC、DFXP/TTML、BBJSON、downloaded YouTube subtitle formats
- WebM clip capture（`MediaRecorder.isTypeSupported()`で検出）
- MP3再encode preference（asbplayerの`lamejs`相当）。P3のbrowser-native audioを必要な人だけMP3へ変換できるようにする。
- audio track selection
- File System Access APIによるsession reconnect
- directory / multi-file drag & drop
- advanced subtitle filters、HTML/ruby処理
- settings profile完成、settings import/export完成

### Browser差分の扱い

WebMを「あるはず」と決め打ちしない。利用可能なcodecをruntimeで確認し、無理なbrowserではJPEG + audioへ自然にfall backする。

### P5のDone条件

- 各formatにfixture testを持つ
- PGS worker failureでUIが固まらない
- File System Accessがないbrowserでも通常file pickerへfall backする
- WebM非対応環境では、機能をdisabled理由付きで出す

---

## 10. Phase P6 — 注釈・単語状態・統計

### 含めるもの

- Yomitan APIとの接続、word lookup
- local word status
- Anki card情報からのknown / learning / unknown表示
- WaniKani sync（tokenはlocalだけに保存）
- reading / pitch accent / frequency annotation
- Word Browser
- media内comprehension / statistics
- statistics generationとlarge subtitle collectionの性能対策

### 注意

このPhaseは一番データ量が増える。Playerが読む字幕を毎回全解析しないよう、IndexedDB cacheのversion・invalidate条件・上限を先に設計する。

---

## 11. Phase P7 — standalone parityと仕上げ

### 含めるもの

- WebSocket client（local external control）
- online subtitle source search/download
- copy historyのSRT export、bulk操作
- light/dark preferenceの必要性を再評価
- 全shortcut一覧とcustomization
- full settings profile migration
- asbplayer standalone feature matrixの最終照合
- 1時間以上のlocal media session、large subtitle file、Anki実データでの回帰QA

### parityの判定方法

「機能数が同じ」ではなく、asbplayerの**local website** feature matrixを1項目ずつ `included / intentionally different / not applicable` にする。`streaming-only`だけが`not applicable`として残る状態を目標にする。

---

## 12. asbplayerのコード利用とlicense

- asbplayerはMIT License（`A:\asbplayer\LICENSE.md:1-13`）。
- sourceを直接移植するfileにはMIT copyright / license noticeを残す。
- 園庭全体のMPL-2.0を勝手にMITへ変えない。
- 最初はtestで守られている純粋ロジック（subtitle parse、playback effects、Anki payload）から比較する。
- React/MUIの画面を丸ごとcopyしない。園庭PlayerのUIは新規に組む。

---

## 13. リスクと先回り

| リスク | なぜ起きるか | 先回り |
|---|---|---|
| large videoでmemoryが増える | Blob URLやevent listenerが残る | P1からdisposeをtestし、route離脱時もcleanupする |
| browserごとにWebMが違う | codec/capture APIの支持が均一ではない | P5まで必須にせずfeature detection + fallbackを持つ |
| Ankiへ意図せず書き込む | UIとexport処理が近すぎる | previewと明示Exportを分離し、success response後だけ完了表示する |
| custom shortcutがbrowser操作と衝突 | Player shortcutは多い | defaultは少数、衝突検出・reset・editable listをP2で入れる |
| annotation cacheが肥大化する | 字幕・token・Anki dataは増える | IndexedDB schema version、上限、clear UI、migration testをP6で持つ |
| Homeの見た目が壊れる | Tailwind/shadcn導入がglobalへ漏れる | Player scopeから導入し、Home screenshot regressionをP1 gateにする |

---

## 14. 実装開始前の確認項目

P1を始める前に、Yosiaが決めるのはこの2点だけでいい。

1. **互換性の意味**
   推奨は「asbplayer local websiteと同じ学習機能を持つが、UIは園庭」。元のMUI画面をpixel単位で再現する必要はない。

2. **P1の最初のmedia fixture**
   権利的に安全な短い `.mp4` + `.srt` / `.vtt` をtest fixtureとして使う。ASSはdependency確認を通した時だけ追加する。実運用mediaはrepositoryへ入れない。

それ以外はP1の実装中に増やさず、Phaseごとのgateで決める。

---

## 15. P1 実装ログ

> **日付:** 2026-07-20
> **状態:** P1 実装完了 + reviewer findings 修正済み — 手動 browser QA 待ち

### 実装サマリー

| 項目 | 状態 | 備考 |
|---|---|---|
| React integration | ✅ | `@astrojs/react`, `react`, `react-dom` |
| Tailwind CSS v4 | ✅ | `@tailwindcss/vite` plugin (scoped via `[data-entei-player-root]`) |
| shadcn/ui | ✅ | Button, Dialog (Radix), ScrollArea, Slider |
| PlayerLayout.astro | ✅ | BaseLayout の desktop grid を持たない full-width layout |
| Subtitle parser (SRT/VTT) | ✅ | Single `stripTags` helper (duplicate merged) |
| Media URL lifecycle | ✅ | Simplified: `createMediaUrl(file, prevUrl)` returns string, revokes inline |
| Keyboard shortcuts | ✅ | Shared `HTMLMediaElement` ref for both video/audio |
| React PlayerApp | ✅ | Full i18n (id/ja/en) via `entei:locale-change` CustomEvent |
| Player preferences | ✅ | Typed, schema-validated, exception-safe localStorage for volume/rate |
| Radix Dialog | ✅ | KeyboardShortcutsHelp uses `@radix-ui/react-dialog` |
| Unit tests | ✅ | 141 tests（既存Home 57 + Player parser / URL lifecycle / preference / locale event / keyboard cue navigation tests） |

### Reviewer findings 修正状況

| # | Finding | Status | Evidence |
|---|---|---|---|
| 1 | Stale unmount cleanup | ✅ | `activeUrlRef` tracks URL; unmount effect revokes it; `createMediaUrl` revokes old inline |
| 2 | Cue seek for video+audio | ✅ | `sharedMediaRef` synced to active element; `handleCueClick` uses it; `handleTimeUpdate` clears `activeCueId` via `?? null` |
| 3 | Volume for video+audio | ✅ | `useEffect` applies `volume` to `sharedMediaRef` on `[volume, mediaUrl, mediaType]` change |
| 4 | No raw SVG | ✅ | All `<svg>` replaced with lucide-react (`Play`, `Pause`, `Music`, `AlertTriangle`, `Keyboard`, `X`, `BookOpen`) |
| 5 | SubtitlePanel a11y | ✅ | scroll時に`matchMedia`を直接確認し、reduced motionでは`instant`。active cueへ`aria-current="true"` |
| 6 | Radix Dialog | ✅ | `@radix-ui/react-dialog` Dialog with `DialogOverlay`, `DialogContent`, focus trap, Escape, return focus |
| 7 | Duplicate tag stripping | ✅ | Single `stripTags()` function used by both SRT and VTT parsers |
| 8 | Locale i18n | ✅ | `playerUI` keys in Dictionary (id/ja/en); `entei:locale-change` CustomEvent; PlayerApp listens with cleanup |
| 9 | Player preferences | ✅ | `features/player/preferences.ts` — schema v1, `readPlayerPreferences()`, `writePlayerPreferences()`, exception-safe |
| 10 | Loading state | ✅ | `setIsLoading(true)` before URL creation; only cleared by `handleLoaded`/`handleError`; unsupported files rejected before `createMediaUrl` |
| 11 | Tailwind scope | ✅ | `@layer base` scoped to `[data-entei-player-root]`; no body reset; no hex/rgb/hsl colors |

### 導入したパッケージ

```json
{
  "@astrojs/react": "^6.0.1",
  "react": "^19.x",
  "react-dom": "^19.x",
  "tailwindcss": "^4.x",
  "@tailwindcss/vite": "^4.x",
  "@radix-ui/react-dialog": "^1.x",
  "@radix-ui/react-scroll-area": "^1.x",
  "@radix-ui/react-slider": "^1.x",
  "class-variance-authority": "^0.7.x",
  "clsx": "^2.x",
  "tailwind-merge": "^3.x",
  "lucide-react": "^1.25.0"
}
```

### ファイル構成

```text
apps/web/src/
├── layouts/PlayerLayout.astro          # BaseLayout grid 不使用
├── pages/player/index.astro            # React client:only island
├── components/player/
│   ├── PlayerApp.tsx                   # Main React — i18n, refs, lifecycle
│   ├── MediaPicker.tsx                 # Video/audio file picker
│   ├── SubtitlePicker.tsx              # Subtitle file picker
│   ├── VideoPlayer.tsx                 # Video element with controls
│   ├── SubtitlePanel.tsx               # Scrollable list, aria-current, reduced-motion
│   ├── KeyboardShortcutsHelp.tsx       # Radix Dialog shortcuts help
│   └── ui/
│       ├── button.tsx                  # shadcn Button
│       ├── dialog.tsx                  # shadcn Dialog (Radix)
│       ├── scroll-area.tsx             # shadcn ScrollArea
│       └── slider.tsx                  # shadcn Slider
├── features/player/
│   ├── subtitle-reader.ts              # SRT/VTT parser (single stripTags)
│   ├── media-url.ts                    # Object URL lifecycle (simplified API)
│   ├── preferences.ts                  # Typed localStorage (vol/rate, schema v1)
│   └── use-keyboard-shortcuts.ts       # Keyboard shortcut hook (HTMLMediaElement ref)
├── lib/utils.ts                        # cn() utility
├── scripts/locale-switcher.ts          # Dispatches entei:locale-change CustomEvent
├── i18n/
│   ├── types.ts                        # Dictionary type with playerUI keys
│   └── locales/{id,en,ja}.ts           # 3-language player UI copy
└── styles/player.css                   # Tailwind + Player styles (scoped base)
```

### P1 gate 準備

| 種別 | 結果 | コメント |
|---|---|---|
| format | ✅ | `npm run format:check` pass |
| test | ✅ | 141 tests pass（8 files） |
| type | ✅ | `npm run check` pass (0 errors, 0 warnings, 0 hints) |
| build | ✅ | `npm run build` pass（3 pages、最終再実行 7.35s） |
| safety | ✅ | No network request, no upload, no external dependency fetch |
| regression | ✅ | Home の 57 test すべて pass |
| browser | ⬜ | 実 local media での手動確認が必要 |

### 手動 QA が必要なもの（browser gate）

1. `.mp4` + `.srt` / `.vtt` で再生 → 動作確認
2. `.mp3` + `.srt` で audio プレイヤー → 動作確認
3. 30分以上の video → 長時間再生安定性
4. Subtitle file 差し替え → 前の track が残らないか
5. Player 離脱 → object URL が解放されるか
6. Page refresh → media 本体を復元しないか
7. `prefers-reduced-motion` → scroll が即座に実行されるか
8. 800px 未満 → single column レイアウト確認
9. locale selector 切り替え → React UI のテキストが切り替わるか
10. 44px touch target → ボタンのタップサイズ確認
11. media metadata読込中 → video/audio skeletonとreduced-motion時の静止状態を確認
12. shortcut Dialog → focus trap、Escapeで閉じる、triggerへfocusが戻るか
13. **mobile portrait** → videoがTopBarの下でedge-to-edge表示; picker/subtitle panelはgutter付き
14. **mobile landscape** (955×400 emulation) → TopBar/footer/picker/subtitle非表示; videoが100vw×100dvh表示; portraitに戻すと全要素復帰
15. **long filename** → 長いmedia/subtitleファイル名でhorizontal scrollが発生しない; labelがellipsis表示; button title属性で全名を確認可能

---

## 16. 次のアクション

1. YosiaがP1の手動browser QAを実local mediaで通す
2. P1 gateが揃ったことを記録する
3. YosiaがP2実装を明示承認した時だけ、学習再生modeと設定へ進む
