# 園庭 Player — 段階プラン

> **状態:** P1 local Player基盤、P1.1 custom controls、P1.2 media admission、P1.3a ASS / selectable captions、P1 same-start cue merge maintenance fix、ANKI_MINERのAM-1〜AM-6c（New / Update latest / inline append panel）はコード完了。DenChou Scenes（code-side自動固定wrapper / payload wrapping）はコード完了。Video Clip（Image/Video ToggleGroup / silent WebM capture）はコード完了。AM-3にDialogクリック伝播防止・Preview duration fallback修正を適用済み。P2.1（Normal / Condensed / Fast-forward）はコード完了、手動browser QA待ち。P1.3b（XML/platform subtitle）とP1.4（PGS/SUP image subtitle）は現在のプロダクト範囲として意図的にdeferred — PGS image cuesはtext-selectable/Yomitan-scannableではないため。P2.2-P7はDRAFT。
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

| 事実                                                                | 根拠                                                                                          | 何を意味するか                                                                                          |
| ------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| asbplayerはlocal websiteとstreaming extensionを別形態として扱う     | `A:\asbplayer\docs\docs\intro.md:30-32`                                                       | 家でローカル動画を使う道具と、外部サイトへ入るbrowser extensionは、元から別の部屋として切り離せる。     |
| streaming側だけがtab capture・active tab・全URLへのアクセスを求める | `A:\asbplayer\extension\wxt.config.ts:175-215`                                                | 園庭がextensionを持たなければ、これらの強い権限も持たない。                                             |
| local Playerの再生modeは5種類で、独立した状態機械になっている       | `A:\asbplayer\common\src\model.ts:298-304`、`common\app\services\play-mode-manager.ts:13-119` | 再生modeは見た目のtoggleではなく、順番・競合・resetを持つ機能。後回しではなく専用Phaseでテストする。    |
| 字幕はSRT/VTT/ASSからPGS/TTMLまで複数形式を読める                   | `A:\asbplayer\common\subtitle-reader\subtitle-reader.ts:165-432`                              | 初期に日常的な3形式を通し、画像字幕など失敗しやすい形式は別Phaseで安全に足す。                          |
| Anki exportはtextだけでなくaudio/image/WebMと新規・更新modeを扱う   | `A:\asbplayer\common\anki\anki.ts:177-221, 488-595`                                           | 「Ankiへ送る」だけでは完成ではない。メディア・field mapping・更新・失敗時の扱いを順番に作る必要がある。 |
| 現在のEnteiにはReact/Tailwind/shadcnがない                          | `Entei/apps/web/package.json:15-29`                                                           | Player Phase開始時にだけ必要なUI基盤を追加し、Homeを移行しない。                                        |
| AstroはReact componentをclient-only islandとして載せられる          | Astro公式 docs: `client:only="react"`                                                         | DOM API前提のvideo・MediaRecorderをSSRから隔離できる。                                                  |
| shadcn/uiはAstroを公式対応し、Astro componentから利用できる         | shadcn公式 Astro template / installation docs                                                 | dialog・slider・sheetなどのaccessibility土台を再実装しなくてよい。                                      |

---

## 3. プロダクト境界

### 3.1 園庭Playerに入れるもの

| 分類                   | 入れる機能                                                                                                                               | 目標Phase |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- | --------: |
| local media            | ローカルvideo/audio、drag & drop、File System Accessによる再接続                                                                         |   P1 / P5 |
| subtitles              | selectable subtitle、track、offset、subtitle list、cue seek、SRT/VTT/ASSからYouTube字幕形式・Netflix IMSC・PGS/TTML/BBJSONまでの複数形式 |   P1 / P5 |
| learning playback      | Normal / Condensed / Auto-pause / Fast-forward / Repeat、rate、keyboard shortcut                                                         |   P1 / P2 |
| mining                 | screenshot、audio clip、WebM clip、range調整、dialog-less mining、history                                                                |   P3 / P5 |
| Anki                   | connection permission、deck/note type/field mapping、新規・update last・specific update、media upload                                    |        P4 |
| settings               | profile、shortcut、subtitle appearance、import/export、resume preference                                                                 |   P2 / P5 |
| annotation             | Yomitan、local/Anki/WaniKani word status、reading、pitch、frequency                                                                      |        P6 |
| analytics for learning | Word Browser、comprehension/statistics、media内の理解度                                                                                  |        P6 |
| standalone extras      | copy history、SRT export、WebSocket client、online subtitle sources                                                                      |        P7 |

### 3.2 永久に入れないもの — Streaming Video Integration

これは「後で隠す」ではなく、source・dependency・permissionの境界から持ち込まない。

| 除外するもの                                  | 理由                                                                                  |
| --------------------------------------------- | ------------------------------------------------------------------------------------- |
| Chrome / Firefox extension                    | ローカルPlayerだけなら不要。`tabs`、`activeTab`、`tabCapture`などの権限も不要になる。 |
| Netflix / YouTubeなどのsite注入               | 外部サイトのDOM・CSP・仕様変更へ追従する責務を園庭は持たない。                        |
| streaming video自動検出                       | URL・tab・site adapterを扱うため除外する。                                            |
| extension overlay / context menu              | streaming site上へ出すUIなので除外する。                                              |
| streaming録音のre-record                      | local fileのaudio captureとは別の経路なので除外する。                                 |
| streaming screenshotのcrop / delay workaround | tab captureやsite構造に依存するため除外する。                                         |

**含め続けるもの:** ダウンロード済みのYouTube字幕ファイル、WebSocket client、local file向けCondensed playbackはstreaming integrationではない。名前だけで一緒に捨てない。

### 3.3 mining / Ankiの実装順

mining素材とAnki exportの大枠はP3 / P4に残す。ただし、元MVPへ早く安全に到達するための実装順は`docs/ANKI_MINER.md`を正とする。現在はAM-1〜AM-6cがコード完了している。`addNote` / note更新はMining Preview内の明示した`Ankiへ送信`でのみ実行し、実AnkiConnect書込みの残る手動QAは専用test deckで行う。

### 3.4 original Phase 3 — WebTorrent local peer streaming

original proposalのWebTorrent Phaseは、ここでいうP3 Miningとは別の後続Phase。WT-1は実装済みで、magnet URIだけを受け、実際に接続できたWebRTC peerが1以上の場合だけ単一torrent mediaの公開stream URLを既存Playerへ渡す。Chromiumで公式Sintel magnet（5 peer、14:48動画）を実再生済み。torrent内字幕・複数media選択はWT-2、privacy copy reviewとproduction browser QAは残留gate。詳細なpeer gate、Service Worker、cache / PWAの順序は[WEBTORRENT_STREAMING.md](./WEBTORRENT_STREAMING.md)を正とする。これは外部配信siteへ注入するStreaming Video Integrationではない。

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

| 種別       | 確認                                                                                                                       |
| ---------- | -------------------------------------------------------------------------------------------------------------------------- |
| unit       | SRT/VTT parsing、cue sorting、offset、object URL cleanupをtestする。ASSはdependency確認を通した時だけ同じPhaseへ追加する。 |
| browser    | 実local `.mp4` + `.srt`、`.vtt`でsubtitle click seekを確認する。ASSはdependency確認を通した時だけ同じPhaseへ追加する。     |
| keyboard   | Mouseなしでplay/pause・cue移動・focus移動ができる                                                                          |
| responsive | desktop / tablet / mobileでvideoとsubtitle listが重ならない                                                                |
| safety     | 選んだlocal mediaは外部uploadしない。network requestをDevToolsで確認する                                                   |
| regression | Homeの57 test、Player test、`astro check`、buildがすべて通る                                                               |

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

### P2.1 — 最初の実装範囲（3モード）

最初はASBの全5 modeを一度に移植しない。Normal / Condensed / Fast-forwardだけを実装し、Auto-pause / RepeatはP2.2以降へ残す。これによりcue終了時のpause / repeat状態機械を初回scopeから外し、字幕のない区間の扱いを先に安定させる。

| mode         | 契約                                                                                                                  |
| ------------ | --------------------------------------------------------------------------------------------------------------------- |
| Normal       | Condensed / Fast-forwardを解除する。既存の手動playback rateへ戻す。                                                   |
| Condensed    | 再生中に次cueまでのgapが**1,000ms超**なら、次cue開始へseekする。pause中、Mine / media capture中、seek中はjumpしない。 |
| Fast-forward | 字幕が表示中または字幕端から600ms以内は**1x**。字幕のないgapでは**3x**。解除時は既存の手動playback rateへ戻す。       |

- CondensedとFast-forwardは排他。片方を有効にするともう片方を解除する。
- Normalは常に選べるリセット状態。Condensed / Fast-forwardを両方OFFにした時もNormalへ戻す。
- mode stateのlocalStorage保存、shortcut、Auto-pause、RepeatはこのP2.1実装には含めない。必要性を実機確認してからP2.2で決める。

### P2.1のDone条件

- Normal / Condensed / Fast-forwardをそれぞれ実media + subtitleで確認する
- Condensedが1,000ms以下のgapをseekしないこと、Fast-forwardが字幕中に必ず1xへ戻ることをunit testで固定する
- Condensed / Fast-forward同時ONを許さない
- Mine / capture中、pause中にCondensedがseekしない
- Fast-forward解除後に既存の手動playback rateへ戻る

> **実装記録（2026-07-28）:** Shadcn Radio Groupをrate Popoverのrate grid下へ追加。Normal / Condensed / Fast-forwardはsession-only stateで、Condensedは1,000ms超の無音gapをseek、Fast-forwardは字幕中/端600ms以内を1x、その他を3xにする。秒の浮動小数誤差を避けるためgap差はmsへ丸めてstrict `>`比較する。unit test 33件、全test / check / buildは通過。実mediaでの操作・spacing QAは残る。

### P2.2以降の拡張候補

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

- mining dialog（shadcn Dialog）— AM-4で基盤完成
- selected rangeのslider — AM-4でactive cue範囲のみ対応。arbitrary sentence selectionは将来
- sentence / track / definition / word / source / tagsの編集 — AM-4ではsentenceはread-only。field editingはStage 2以降
- JPEG screenshot capture — AM-2で完了
- browser-native WebM/Opus audio clip生成とpreview — AM-3/AM-4で完了。downloadは未実装
- surrounding subtitles — 未実装
- IndexedDB mining history — 未実装
- historyから再選択、audio/image download、SRT section export — 未実装

### 先にJPEG + audioを作る理由

MediaRecorderは比較的広く使えるが、`HTMLMediaElement.captureStream()`はbrowser互換性が限定的。P3は壊れにくいJPEG + browser-native lightweight audioを先に通し、WebM **video** clipだけをP5でcapability check付きにする。MP3再encode（asbplayerの`lamejs`相当）は、余計な低速処理を増やすため園庭では実装しない。

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
  → version / reachability確認
  → requestPermission（対応時）
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
- duplicate許可ポリシー: 新カードはdeck scopeで重複許可（`allowDuplicate: true`, `duplicateScope: 'deck'`, `checkChildren: false`）。Update modeは重複オプションなし
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
- browser-native lightweight audioをそのまま維持する。MP3再encode preferenceは作らない。
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

| リスク                             | なぜ起きるか                          | 先回り                                                             |
| ---------------------------------- | ------------------------------------- | ------------------------------------------------------------------ |
| large videoでmemoryが増える        | Blob URLやevent listenerが残る        | P1からdisposeをtestし、route離脱時もcleanupする                    |
| browserごとにWebMが違う            | codec/capture APIの支持が均一ではない | P5まで必須にせずfeature detection + fallbackを持つ                 |
| Ankiへ意図せず書き込む             | UIとexport処理が近すぎる              | previewと明示Exportを分離し、success response後だけ完了表示する    |
| custom shortcutがbrowser操作と衝突 | Player shortcutは多い                 | defaultは少数、衝突検出・reset・editable listをP2で入れる          |
| annotation cacheが肥大化する       | 字幕・token・Anki dataは増える        | IndexedDB schema version、上限、clear UI、migration testをP6で持つ |
| Homeの見た目が壊れる               | Tailwind/shadcn導入がglobalへ漏れる   | Player scopeから導入し、Home screenshot regressionをP1 gateにする  |

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

| 項目                      | 状態 | 備考                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| ------------------------- | ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| React integration         | ✅   | `@astrojs/react`, `react`, `react-dom`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| Tailwind CSS v4           | ✅   | `@tailwindcss/vite` plugin (scoped via `[data-entei-player-root]`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| shadcn/ui                 | ✅   | Button, Dialog (Radix), ScrollArea, Slider, Popover (Radix)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| PlayerLayout.astro        | ✅   | BaseLayout の desktop grid を持たない full-width layout                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| Subtitle parser (SRT/VTT) | ✅   | Single `stripTags` helper (duplicate merged)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| Subtitle parser (ASS)     | ✅   | `ass-compiler` v0.1.1 (MIT) — dialogue timing + plain text extraction                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| Media URL lifecycle       | ✅   | Simplified: `createMediaUrl(file, prevUrl)` returns string, revokes inline                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| Keyboard shortcuts        | ✅   | Shared `HTMLMediaElement` ref for both video/audio                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| React PlayerApp           | ✅   | Full i18n (id/ja/en) via `entei:locale-change` CustomEvent                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| Player preferences        | ✅   | Typed, schema-validated, exception-safe localStorage for volume/rate                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| Panel layout persistence  | ✅   | Typed, schema-validated, exception-safe localStorage for desktop panel widths (main/side %); `entei.player.panel-layout.v1` key; no media/subtitle/anki/credential data stored                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| Radix Dialog              | ✅   | KeyboardShortcutsHelp uses `@radix-ui/react-dialog`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| Unit tests                | ✅   | 872 tests（37 files：既存Home、Player parser / URL lifecycle / preference / locale event / keyboard cue navigation / control-helpers / caption mode、AnkiConnect read-only / lifecycle / screenshot capture / screenshot integration / audio clip / mining preview / mining integration / slider thumb count / mining viewport / subtitle interval / anki export client / anki export integration / background connection / anki-append-panel tests / denchou-scene tests / anki-miner-preferences tests / video-clip tests / media-mode-switch tests / right-panel-resizable tests / panel-layout tests / file-open-integration tests / player-layout-class tests / subtitle-panel-row-mining tests） |

### Reviewer findings 修正状況

| #   | Finding                  | Status | Evidence                                                                                                                                   |
| --- | ------------------------ | ------ | ------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | Stale unmount cleanup    | ✅     | `activeUrlRef` tracks URL; unmount effect revokes it; `createMediaUrl` revokes old inline                                                  |
| 2   | Cue seek for video+audio | ✅     | `sharedMediaRef` synced to active element; `handleCueClick` uses it; `handleTimeUpdate` clears `activeCueId` via `?? null`                 |
| 3   | Volume for video+audio   | ✅     | `useEffect` applies `volume` to `sharedMediaRef` on `[volume, mediaUrl, mediaType]` change                                                 |
| 4   | No raw SVG               | ✅     | All `<svg>` replaced with lucide-react (`Play`, `Pause`, `Music`, `AlertTriangle`, `Keyboard`, `X`, `BookOpen`)                            |
| 5   | SubtitlePanel a11y       | ✅     | scroll時に`matchMedia`を直接確認し、reduced motionでは`instant`。active cueへ`aria-current="true"`                                         |
| 6   | Radix Dialog             | ✅     | `@radix-ui/react-dialog` Dialog with `DialogOverlay`, `DialogContent`, focus trap, Escape, return focus                                    |
| 7   | Duplicate tag stripping  | ✅     | Single `stripTags()` function used by both SRT and VTT parsers                                                                             |
| 8   | Locale i18n              | ✅     | `playerUI` keys in Dictionary (id/ja/en); `entei:locale-change` CustomEvent; PlayerApp listens with cleanup                                |
| 9   | Player preferences       | ✅     | `features/player/preferences.ts` — schema v1, `readPlayerPreferences()`, `writePlayerPreferences()`, exception-safe                        |
| 10  | Loading state            | ✅     | `setIsLoading(true)` before URL creation; only cleared by `handleLoaded`/`handleError`; unsupported files rejected before `createMediaUrl` |
| 11  | Tailwind scope           | ✅     | `@layer base` scoped to `[data-entei-player-root]`; no body reset; no hex/rgb/hsl colors                                                   |

### 導入したパッケージ

```json
{
  "@astrojs/react": "^6.0.1",
  "react": "^19.x",
  "react-dom": "^19.x",
  "tailwindcss": "^4.x",
  "@tailwindcss/vite": "^4.x",
  "@radix-ui/react-dialog": "^1.x",
  "@radix-ui/react-popover": "^1.x",
  "@radix-ui/react-scroll-area": "^1.x",
  "@radix-ui/react-slider": "^1.x",
  "ass-compiler": "0.1.1",
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
│   ├── PlayerControls.tsx              # P1.1: Custom control layer (video+audio)
│   ├── MediaPicker.tsx                 # Video/audio file picker
│   ├── SubtitlePicker.tsx              # Subtitle file picker
│   ├── VideoPlayer.tsx                 # Video element (no native controls)
│   ├── SubtitlePanel.tsx               # Scrollable list, aria-current, reduced-motion
│   ├── KeyboardShortcutsHelp.tsx       # Radix Dialog shortcuts help
│   └── ui/
│       ├── button.tsx                  # shadcn Button
│       ├── dialog.tsx                  # shadcn Dialog (Radix)
│       ├── popover.tsx                 # shadcn Popover (Radix)
│       ├── scroll-area.tsx             # shadcn ScrollArea
│       └── slider.tsx                  # shadcn Slider
├── features/player/
│   ├── subtitle-reader.ts              # SRT/VTT/ASS parser (single stripTags + ass-compiler)
│   ├── media-url.ts                    # Object URL lifecycle (simplified API)
│   ├── preferences.ts                  # Typed localStorage (vol/rate, schema v1)
│   ├── panel-layout.ts                 # Desktop panel width persistence (main/side %, schema v1)
│   ├── control-helpers.ts              # P1.1: formatTime, clampSeek, toggleMute, visibility, fullscreen, isControlTarget
│   └── use-keyboard-shortcuts.ts       # Keyboard shortcut hook (excludes control targets)
├── lib/utils.ts                        # cn() utility
├── scripts/locale-switcher.ts          # Dispatches entei:locale-change CustomEvent
├── i18n/
│   ├── types.ts                        # Dictionary type with playerUI keys
│   └── locales/{id,en,ja}.ts           # 3-language player UI copy
└── styles/player.css                   # Tailwind + Player styles (scoped base)
```

### P1 gate 準備

| 種別       | 結果 | コメント                                                                                      |
| ---------- | ---- | --------------------------------------------------------------------------------------------- |
| format     | ✅   | `npm run format:check` pass                                                                   |
| test       | ✅   | 872 tests pass（37 files）                                                                    |
| type       | ✅   | `npm run check` pass (0 errors, 0 warnings, 0 hints)                                          |
| build      | ✅   | `npm run build` pass（3 pages、最終再実行 13.54s）                                            |
| safety     | ✅   | external network uploadなし。AnkiConnectはuser設定のlocalhost endpointへread-only requestのみ |
| regression | ✅   | Home の 57 test すべて pass                                                                   |
| browser    | ⬜   | 実 local media での手動確認が必要                                                             |
| ASS QA     | ⬜   | 実 .ass ファイルでの browser 確認が必要                                                       |

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
16. **Mineボタン** → active cueなしでdisabled; video/audioで表示; クリックでPlayer pause
17. **Mining Preview** → sentence/source/screenshot/audioが正しく表示; Cancelでsnapshot timeへseek+pause
18. **Range slider** → 0.1秒stepで動作; Update materialsで明示的re-record; 無効rangeでdisabled
19. **Mining Preview 音声** → Play/Pauseがvisible Playerに影響しない; duration fallback表示
20. **Range zoom** → Mine開始時に選択範囲周辺へviewport自動focus; ZoomIn/ZoomOut 44px buttonで半減/倍増; 選択範囲は不変; capture/update中はdisabled
21. **Update materials** → Range変更後のexplicit button動作; sentence/source/screenshot/audio全て更新; definition/word/tagsは保持; unmapped fieldはskip; visible video seek→capture→restore

---

## 16. P1.1 Custom Control Layer

> **決定日:** 2026-07-21
> **状態:** code implementation complete + reviewer APPROVE — 手動 browser QA待ち
> **目的:** browser native controlsを、園庭のlocal-first Player UIへ置き換える。P2の学習playback modeは含めない。

### 16.1 境界

| 含める                                                                     | 今回は含めない                                       |
| -------------------------------------------------------------------------- | ---------------------------------------------------- |
| video/audioの再生・pause、seek、現在/総時間、mute/volume、rate、fullscreen | Condensed / Auto-pause / Fast-forward / Repeat（P2） |
| `Timeline`による字幕panelのshow/hide                                       | video上の字幕overlay（将来設計）                     |
| `Settings`からの字幕差し替え・shortcut参照                                 | Anki、mining、streaming integration                  |
| desktopのcontrol auto-hide、touch/keyboardでの再表示                       | Picture-in-Picture、casting、download menu           |

native `<video controls>`は撤去する。browserが描くcontrol UIをCSSで装飾することは対象にしない。

### 16.2 レイアウト契約

```text
┌ media file name ────────────────────────── [Timeline] [Settings] ┐
│                                                                    │
│                               media                                │
│                                                                    │
│ ─────────────────────── seek timeline ────────────────────────── │
│ [Play/Pause]  04:33 / 48:04              [Volume] [Gauge] [Full] │
└──────────────────────────────────────────────────────────────────┘
```

- 左上: 選択中media名。overflowはellipsis、full nameは`title`で参照可能にする。
- 右上: `Timeline`は`entei-subtitle-panel`の表示を切替える。desktopで隠した時は空白columnを残さずmedia areaを拡幅する。`Settings`は字幕ファイル差し替えとshortcut一覧をまとめる。字幕未読込時はSettings iconに小さな状態dotを表示する。Timelineは無効化せず、empty panelを表示できる。
- 下端: custom seek Slider。pointer/keyboard操作で現在位置を更新し、現在時間とmetadata由来の総時間をtabular numeralで表示する。
- 右下: `Volume2`/`VolumeX`でmute toggle。desktopはhover/focusでvolume Sliderを表示し、touchではicon activationでSliderを開く。`Gauge`は既存shortcut/preferenceと同じ0.25 / 0.5 / 0.75 / 1 / 1.25 / 1.5 / 1.75 / 2xのrate popover。`Maximize2`/`Minimize2`は実fullscreen stateを表す。
- mobile portraitはcontrol layerをvideo内に重ねるが、字幕panelは動画下のまま。short-height landscapeは既存immersive規則を維持し、字幕panel toggleは表示しない。

### 16.3 interactionとaccessibility

- pointerが2.5秒動かなければcontrol layerだけをfade-outする（reduced motionでは即時）。touch/mobileでもdesktopと同じタイミングでauto-hideする。hidden時は`pointer-events: none`も同時に付け、video clickを妨げない。paused、pointer hover、touch、keyboard focus、error時は隠さない。`ended`ではtimerを解除してcontrolsを即表示する。opacity/transformだけをanimateし、reduced motionでは即時に切替える。
- **touch/mobile bare surface tap = control visibility toggle。** hidden → show, shown → hide。play/pause toggleは行わない。controls non-visible中にsurface tapでreavealし、visibleなPause buttonでpauseする。paused時もcontrolsは表示状態を維持（unless userがtapでhide）。desktop bare surface clickではcontrol reveal + play/pause toggle。`surfaceClickEffect(isTouchDevice, isVisible)`でpolicyを分岐する。
- control button/Slider操作はevent propagationを止め、意図しないtoggleを防ぐ。window shortcut側も`button`、`role="button"`、`role="slider"`を対象外にし、Space/Enterでcontrolを操作した時にplay/pauseを二重発火させない。
- すべてLucide named importを使う: `Timeline`、`Settings`、`Play`、`Pause`、`Volume2`、`VolumeX`、`Gauge`、`Maximize2`、`Minimize2`。個別importなのでunused iconをbundleへ入れない。
- buttonは44px以上、`type="button"`、localeごとの`aria-label`を持つ。toggleには`aria-pressed` / `aria-expanded`を使う。PopoverはRadixのfocus管理を使う。Settings内のshortcut参照はinline listであり、既存Radix DialogをPopover内へネストしない。
- `requestFullscreen()`はbutton activation内でだけ呼び、`fullscreenchange`で`Minimize2`へ同期する。request failureはinline feedbackで伝え、browserのEsc/F11によるexitも正しく反映する。

### 16.4 実装構造

| 部品                     | 責務                                                                                                                                               |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `VideoPlayer`            | native `controls`を外す。wrapper refとmedia eventを上位へ渡す。                                                                                    |
| `PlayerControls`（新規） | video/audio共通のcontrol layer。time、seek、volume、rate、fullscreenを扱う。`isPlaying`をpropで受け、visibility timer/stateはcomponent内で閉じる。 |
| `PlayerApp`              | media/playback stateの唯一の所有者。subtitle panel visibilityとlayout classを管理する。                                                            |
| Radix Popover（追加）    | Settings、volume、rateのkeyboard-safe popover。packageは実装時にnpmで追加する。                                                                    |
| `playerUI` dictionaries  | 追加ラベルをid/ja/enで同時に定義する。                                                                                                             |

audioも同じ`PlayerControls`を使う。video専用はfullscreenとpointer上のplay/pauseだけで、audioにnative UIを残さない。

### 16.5 完了条件

| 検証           | 合格条件                                                                                                                                                 |
| -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| unit           | time format、seek clamp、rate/mute/control visibility、fullscreen state helper、controlへfocusしたSpace/Enterがglobal shortcutを発火しないことをtestする |
| build          | format / test / check / static buildがpass                                                                                                               |
| desktop manual | playback、seek、volume hover/focus、rate、subtitle toggle、settings、fullscreen enter/exit、keyboard shortcutを確認                                      |
| mobile manual  | portrait controls/touch、landscape immersive、no horizontal overflow、字幕panel非overlayを確認                                                           |
| a11y manual    | Tab順、Slider keyboard操作、focus-visible、popover Escape/return focus、reduced-motionを確認                                                             |
| privacy        | local Blob URL以外へmedia/metadataを送らない。panel layoutは2つのpercentage数値のみ保存（media/subtitle/anki/credential dataなし）                       |

### P1.1 実装状況

| 部品                              | 状態 | 備考                                                                                                                                    |
| --------------------------------- | ---- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `PlayerControls` (新規)           | ✅   | video/audio共通のcustom control layer                                                                                                   |
| `VideoPlayer` controls撤去        | ✅   | native `controls`属性削除、custom layerに置換                                                                                           |
| `PlayerApp` subtitle panel toggle | ✅   | `isSubtitlePanelVisible` + layout class (`--no-panel`)                                                                                  |
| Radix Popover (追加)              | ✅   | `@radix-ui/react-popover` Settings/rate popover用                                                                                       |
| `control-helpers.ts` (新規)       | ✅   | formatTime, clampSeek, toggleMute, nextControlsVisibility, isFullscreenAvailable, isDocumentFullscreen, isControlTarget, PLAYBACK_RATES |
| `isControlTarget` keyboard guard  | ✅   | button/slider/switch/role=button等をglobal shortcut対象外に                                                                             |
| i18n playerUI追加                 | ✅   | 22 new keys in id/ja/en (control labels, aria, fullscreen, etc.)                                                                        |
| Control layer CSS                 | ✅   | Gradient overlays, visibility, seek/volume/rate/fullscreen, landscape immersive                                                         |
| No-panel layout                   | ✅   | `.entei-player-layout--no-panel` hides subtitle panel grid column                                                                       |
| Reduced motion                    | ✅   | Transition: none on controls/volume popup; skeleton frozen                                                                              |
| Landscape immersive               | ✅   | Custom controls render inside fullscreen surface                                                                                        |
| Unit tests                        | ✅   | 35 new tests in `control-helpers.test.ts` (format, seek, mute, visibility, fullscreen, control target, rate)                            |
| Verification                      | ✅   | format ✅ / test ✅ (176) / check ✅ (0/0/0) / build ✅（3 pages、最終再実行 13.33s）/ reviewer ✅                                      |

### P1.1 Reviewer Fixes (post-audit)

| Item                           | 状態 | 内容                                                                                                                                                                                   |
| ------------------------------ | ---- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P1 media listener reattachment | ✅   | `mediaKey` prop (media URL) added to PlayerControls; listener effect depends on it so listeners reattach on video↔audio switch or new file; `currentTime`/`duration` reset immediately |
| P2 cue click reveals controls  | ✅   | `PlayerControlsHandle` exposed via `forwardRef`/`useImperativeHandle`; `handleCueClick` calls `controlsHandleRef.current?.show()`                                                      |
| P3 ArrowLeft/Right documented  | ✅   | Source comment explains intentional direction-aware behavior: invalid cue → first (Left) / last (Right)                                                                                |

### P1.1 手動 QA が必要なもの（browser gate）

1. playback/seek/volume hover→reveal/rate/subtitle toggle → desktop
2. Settings popover → subtitle replacement + shortcut inline list
3. fullscreen enter/exit (Esc/F11) → icon sync (Maximize2↔Minimize2)
4. keyboard shortcut → Space/Enter on Slider/ボタンでplay/pause二重発火なし
5. portrait controls → video内に重ね表示、subtitle panelは動画下
6. landscape immersive (955×400) → controls visible、subtitle panel非表示、Timeline button非表示
7. settings dot → subtitle未読込時にdot表示、subtitle読込後に消失
8. reduced motion → controls fade即時切替、skeleton静止

---

## 17. asbplayer Local File Format Parity Plan

> **決定日:** 2026-07-21
> **状態:** P1.2 code implementation complete・manual browser QA pending
> **目的:** `app.asbplayer.dev`と同じlocal fileの受け入れ範囲・subtitle readerを園庭へ移植する。Streaming Video Integrationとbrowser内FFmpeg変換は含めない。

### 17.1 先に確定した事実

asbplayer自身はlocal fileをBlob URLとしてnative `<video>`へ渡している（`A:\asbplayer\common\app\components\VideoPlayer.tsx:1912-1920`）。MKVを独自decoderやFFmpegで変換しているわけではない。

| browser / container   | asbplayer公式compatibility             | 園庭の扱い                                                          |
| --------------------- | -------------------------------------- | ------------------------------------------------------------------- |
| Chromium + MP4        | ✓                                      | parity対象                                                          |
| Chromium + MKV        | ✓                                      | parity対象。direct Blob playbackを試す                              |
| Chromium + H.265/HEVC | modern GPU + hardware acceleration時 ✓ | direct Blob playbackを試す。software decodeを約束しない             |
| Firefox + MKV         | 記載なし                               | ファイルは選択可能にするが、native playback failureを正直に表示する |
| AC3 / DTS             | 記載なし                               | codec非対応として扱う。変換はしない                                 |

これは「ファイル拡張子を受け入れる」と「browserがcontainer内codecをdecodeできる」を分ける契約。`canPlayType()`は選択前の補助ヒントに留め、実際の`loadedmetadata` / `error`を最終判定にする。

### 17.2 asbplayerのfile type matrix

asbplayerの実コード`A:\asbplayer\common\app\components\App.tsx:111-130`をsource of truthとする。

| 種別                  | extension                                                        | 園庭のstage |
| --------------------- | ---------------------------------------------------------------- | ----------- |
| video                 | `.mkv`, `.mp4`, `.m4v`, `.avi`, `.webm`                          | P1.2        |
| audio                 | `.mp3`, `.m4a`, `.aac`, `.flac`, `.ogg`, `.wav`, `.opus`, `.m4b` | P1.2        |
| basic text subtitle   | `.srt`, `.ass`, `.vtt`, `.nfvtt`                                 | P1.3a       |
| platform XML subtitle | `.ytxml`, `.ytsrv3`, `.dfxp`, `.ttml2`, `.nfimsc`, `.bbjson`     | P1.3b       |
| image subtitle        | `.sup` (PGS)                                                     | P1.4        |

園庭の現在P1はvideo `.mp4/.webm/.ogv/.ogg/.mkv`、audio `.mp3/.wav/.ogg/.flac/.aac/.m4a`、subtitle `.srt/.vtt`だけ。これはasbplayerと同一ではないため、P1.2-P1.4で追いつける。

### 17.3 P1.2 — Media admission parity

**目的:** asbplayerと同じfile picker / drag-and-drop extension matrixを持ち、Chromiumでdirect MKV playbackを妨げない。

- `media-url.ts`のvideo/audio extension tableと`accept`を17.2へ統一する。MIME typeだけで拒否しない。
- local `File → Blob URL → native media element`経路を維持する。media本体・path・Blob URLをstorageやnetworkへ出さない。
- unsupported extension、native decode failure、metadata failureを別々のlocalized messageで表示する。
- `.mkv`/`.avi`を「全browserで再生できる」とは表示しない。Chromiumのsupported codecなら再生し、非対応codecはnative failureを表示する。
- test: video/audio extension全件、unknown extension、MIMEなしFile、Blob URL cleanup、video→audio→video切替を守る。

**P1.2 Done:** Windows ChromiumでH.264/AAC MKV、MP4、WebM、各audio extensionのselection/playback試験を実施。Firefox / mobileは対応codecに依存することをQA matrixへ記録する。

**P1.2 implementation record (2026-07-21):** code implementation complete. `media-url.ts` now uses typed, case-insensitive video/audio extension sets and derives the picker accept list from them. It preserves existing Entei extensions while adding asbplayer's `.m4v/.avi/.opus/.m4b`; rejected files exit before Blob URL creation. Native video/audio failures map to owner-controlled id/ja/en labels rather than browser `MediaError.message`. 225 automated tests, `astro check` 0 diagnostics, and static build 3 pages passed. Actual MKV/AVI/audio browser QA remains required and is not claimed complete.

### 17.4 P1.3a — Text subtitle parity

**対象:** `.srt/.subrip`, `.vtt/.nfvtt`, `.ass`。

- asbplayerの`SubtitleReader`（`subtitle-reader.ts:165-251`）を、園庭の`SubtitleCue` modelと既存cue panelへ移植する。
- SRTはnumeric timestamp、VTT/NFVTTはcue orderingとclass除去、ASSはdialogue timingと`\\N` linebreakを再現する。
- asbplayer依存の`@qgustavor/srt-parser`、`videojs-vtt.js`、`ass-compiler`は、実装開始時にlicense/versionを確認してnpm経由で追加する。package versionを手編集しない。
- textはDOMへunsafe HTMLとして渡さない。現在のplain text panel契約を維持し、HTML/ruby表示はP6 annotationまで広げない。

**P1.3a implementation record (2026-07-21):** ASS text subtitle parsing implemented. `ass-compiler` v0.1.1 (MIT license, author Zhenye Wei) installed via npm workspace. `subtitle-reader.ts` extended: `detectFormat` recognizes `[Script Info]` header; `parseASS` compiles dialogue timing, extracts plain text from `slices[].fragments[].text`, strips override tags (`{\...}`), normalizes `\\N`/`\\n` linebreaks to spaces, and applies shared whitespace/tag normalization. `SUBTITLE_EXTENSIONS` and `SUBTITLE_ACCEPT` in `media-url.ts` include `.ass` (case-insensitive). Compiler failures and malformed dialogue are caught and returned as `SubtitleParseResult.errors`. 246 automated tests (including 12 ASS-specific tests for timing, linebreaks, tag stripping, sort/id reassign, malformed input, `SUBTITLE_ACCEPT`, and direct `isSubtitleFile`/MIME assertions for ASS), `astro check` 0 diagnostics, and static build 3 pages passed. **Not implemented:** ASS visual typesetting (position/color/outline/shadow/karaoke/border), NFVTT/XML/PGS formats. Actual browser `.ass` file QA remains required and is not claimed complete.

**P1.3a.1 implementation record (2026-07-21):** Selectable subtitle overlay over video implemented. `SubtitleOverlay` component renders active subtitle as normal DOM text inside `.entei-player-surface` with `data-entei-subtitle-overlay` attribute, `user-select: text`, and `pointer-events: auto` — compatible with user-installed Yomitan text scanner. PlayerApp surface click handler ignores events inside `[data-entei-subtitle-overlay]`, preserving document-level event propagation for content scripts. `findActiveCue(cues, time)` extracted as single source of truth for active-cue derivation (inclusive start, exclusive end); used by both `handleTimeUpdate` and the overlay. Overlay uses OKLCH token contrast (semi-transparent black background, white text), positioned bottom-center above controls (z-index 15; controls layer is z-index 10 with `pointer-events:none` container so overlay receives hover/tap/selection). 11 unit tests for `findActiveCue` covering boundary conditions, overlap behavior, and edge cases. 270 total tests, `astro check` 0 diagnostics, build 3 pages passed. **Not implemented:** P6 word-status/dictionary integration, dictionary popup rendering, Anki mining. **Manual QA pending:** desktop Yomitan scan/selection, touch text selection behavior, fullscreen/landscape overlay visibility, non-Japanese subtitle scanning.

**P1.3a.2 implementation record (2026-07-21):** Caption display modes implemented. `CaptionDisplayMode` union type (`'visible' | 'blurred' | 'hidden'`) and `nextCaptionDisplayMode` pure transition function added to `control-helpers.ts`. `SubtitleOverlay` extended to accept `displayMode` — `hidden` renders no DOM, `blurred` applies CSS `filter: blur(6px)` and reveals on hover/tap. `SubtitleControls` cycle button added to top-right (left of Timeline): `ClosedCaption` (visible) → `Captions` (blurred) → `CaptionsOff` (hidden). Desktop: pointer hover reveals overlay text, pointer leave starts 1s restore timer; timer cancelled on re-entry. Mobile: tap blurred overlay pauses media + reveals text + shows controls; blur stays removed while paused; playback resume restores blur immediately. `SubtitleOverlay` filters pointer enter/leave by `event.pointerType === 'mouse'` via `shouldTriggerBlurHover()` — touch/pen events never schedule the 1s restore timer, preventing premature re-blur on mobile. Re-blur uses `isPlaybackResume(wasPlaying, isPlaying)` transition detection — only fires on actual false→true isPlaying transition (user-initiated resume), not during the render where isPlaying is still true after a touch-tap pause. `handleSurfaceClick` continues to ignore `[data-entei-subtitle-overlay]` targets. PlayerApp manages `captionDisplayMode` state and `isOverlayRevealed` with timer cleanup on unmount/mode change. Three locale dictionaries (id/ja/en) extended with `captionModeVisible`/`captionModeBlurred`/`captionModeHidden`. CSS: `.entei-subtitle-overlay--blurred .entei-subtitle-overlay-text` uses `filter: blur(6px)`, revealed state clears filter via `[data-overlay-revealed]` attribute. `prefers-reduced-motion`: blur state changes are instant (no animation). 16 new tests (transition cycle, constant value, pointer-type policy, playback resume detection). 278 total tests, `astro check` 0 diagnostics, build 3 pages passed. **Manual QA pending:** desktop Yomitan scan through blurred/revealed text, mobile tap-to-reveal + pause + resume reblur, fullscreen/landscape overlay behavior, cycle button responsiveness.

**P1.3a.3 implementation record (2026-07-21):** Caption display mode persisted to localStorage via existing `entei.player.prefs.v1` schema. `PlayerPreferences` interface extended with `captionDisplayMode: CaptionDisplayMode` field. Schema version retained at v1 — `captionDisplayMode` is optional in persisted JSON for backwards compatibility; old v1 payloads without the field read as `'visible'`; invalid values also fall back to `'visible'`. `PlayerApp` initializes `captionDisplayMode` from `readPlayerPreferences()` at mount. `handleCycleCaptionMode` writes updated mode together with current volume/rate inside the `setCaptionDisplayMode` functional updater, avoiding stale closures. Volume/rate handlers also preserve the current caption mode when writing. Exception-safe: unavailable/throwing localStorage and corrupted JSON return defaults. 10 new tests (defaults, old v1 payload, each valid mode, invalid mode fallback, corrupt/throwing storage, write payload key assertion, no media data). 288 total tests, `astro check` 0 diagnostics, build 3 pages passed. **Manual QA pending:** select mode → reload → restored; old preference file → defaults to visible.

**Subtitle selection relocation (2026-07-21):** Moved subtitle file picker from Settings popover into SubtitlePanel. When no subtitles loaded: empty state includes actionable "Choose Subtitles" button. When subtitles loaded: compact "Change" picker in panel header. Removed SubtitlePicker and status dot from Settings popover (Settings retains keyboard shortcut reference only). SubtitlePanel accepts `onSubtitleSelect`, `subtitleAccept`, `chooseSubtitleLabel`, `changeSubtitleLabel` props. i18n: added `changeSubtitle` key (en: "Change", id: "Ganti", ja: "変更"). PlayerControls no longer receives `hasSubtitles` or `onSubtitleSelect` props. **Manual QA pending:** empty state button works, change button in header works, Settings popover has no subtitle section.

**P1 same-start cue merge maintenance fix (2026-07-25):** Two subtitle bugs fixed. (1) `normalizeCues()` added — adjacent source cues sharing the exact same start time are merged into one cue, preserving source order, joining nonempty text with a single space, ending at max(end). This fixes exporter-created `<br>`/multi-cue splits where two lines at the same displayed time (e.g. `お母さん 来てたんだ。` + `ああ…。` at 02:30) produced separate cues, but `findActiveCue()` only returned the first. Applied to all three parsers (SRT/VTT/ASS) after sort. Sort changed from `start || end` to `start` only, preserving source order for equal-start inputs. (2) Literal `<br>`, `<br/>`, `<br />` in SRT/VTT now normalized to a single space BEFORE generic HTML tag stripping, preventing words from gluing together. `stripTags()` now applies `<br>` normalization first (case-insensitive). ASS `\\N`/`\\n` handling unaffected (separate normalizer runs before `stripTags`). 19 new tests (same-start merge × 9, `<br>` normalization × 8, findActiveCue merged text, three-cue merge). 713 total tests, `astro check` 0 diagnostics, build 3 pages passed. **P1.3b/P1.4 deferred** at this gate: XML/platform subtitles and PGS/SUP image subtitles removed from immediate roadmap (see sections 17.5/17.6 for rationale). **Manual QA pending:** verify merged cue text appears correctly in subtitle panel and overlay for multi-line same-start SRT/VTT files.

**Desktop immersive layout (2026-07-22):** When media is loaded on desktop (≥1024px), `entei-player-immersive` class is applied to `<html>` via `useEffect` + `matchMedia`. CSS hides TopBar/SiteFooter, removes main padding, fills `100dvh`, and removes gap between video and panel. The active two-column grid explicitly places media at `minmax(0, 1fr)` / column 1 and SubtitlePanel at `380px` / column 2; when the panel is hidden, media spans the only column. The full-height chain is `media-area → surface → video-wrapper → video`, with `object-fit: contain`, so controls reach the viewport bottom without cropping the source. SubtitlePanel fills viewport height with independent scroll. Empty picker state remains normal. Cleans up on unmount/no media. Mobile portrait and short-height landscape unaffected. **Manual QA pending:** desktop video fills viewport, panel scrolls, no blank footer/scroll region, fullscreen/overlay selection works.

### 17.5 P1.3b — XML / platform subtitle parity（deferred）

> **判定:** 2026-07-25 P1 same-start cue merge完了時にdeferred。P1.3bとP1.4は現在のプロダクト範囲から外す。
> **理由:** XML/platform形式（`.ytxml`, `.ytsrv3`, `.dfxp`, `.ttml2`, `.nfimsc`, `.bbjson`）はasbplayerのstreaming ecosystemに依存する形式であり、local file-only Playerの範囲では使用頻度が極めて低い。PGS/SUP（P1.4）は画像字幕であり、text-selectableでもYomitan-scannableでもない。両者とも将来の yt-dlp によるlocal file acquisitionとの組み合わせで再評価する。

**対象:** `.ytxml`, `.ytsrv3`, `.dfxp`, `.ttml2`, `.nfimsc`, `.bbjson`。

- asbplayerのparser分岐（`subtitle-reader.ts:253-430`）をformat単位で移植する。
- `fast-xml-parser` path（YouTube系）とDOMParser path（DFXP/TTML）、Netflix IMSCのtick-rate / ruby token dataを分ける。
- malformed XML / JSONはcueを半端に作らず、file名とformatを含むlocalized errorへ落とす。
- formatごとのfixtureとtimestamp / linebreak / overlapping cue testを追加する。

**将来の再評価条件:** browser-only Playerではyt-dlpを直接呼び出せない。yt-dlpとの連携にはlocal companion / desktop boundaryが必要。このacquisition pathが確立された時に、対応するsubtitle形式の実装を再開する。

### 17.6 P1.4 — PGS/SUP image subtitle parity（deferred）

> **判定:** 2026-07-25 P1 same-start cue merge完了時にdeferred。PGS image cuesはtext-selectableではなく、Yomitan text scannerのscan対象にもならないため、local text-focused Playerの範囲では実装しない。
> **理由:** PGS/SUPは画像字幕。EnteiのPlayerはtext-selectable subtitle + Yomitan overlay scanを主目的としており、画像字幕はこのuse-caseに合致しない。将来のyt-dlp acquisitionとの組み合わせで再評価する。

**対象:** `.sup`のみ。

- asbplayerと同様に`pgs-parser`をWorker内で実行し、`File.stream()`と`OffscreenCanvas`でPNG image cueへ変換する（`pgs-parser-worker.ts:3-55`）。main threadで大きなPGSをdecodeしない。
- `SubtitleCue`をtext/image unionへ広げる。現在の字幕panelではimage cueをtimeline itemとして表示するが、video overlay字幕は今回追加しない。
- `OffscreenCanvas` / transferable streamがないbrowserは、file全体を黙って読むfallbackを作らず、対応不可を明示する。
- Worker terminate、Blob / data URL cleanup、large file cancellationをtest / manual QAする。

### 17.7 恒久除外と将来候補

| 項目                                     | 判定     | 理由                                                                       |
| ---------------------------------------- | -------- | -------------------------------------------------------------------------- |
| Streaming Video Integration              | 恒久除外 | 園庭のscope外                                                              |
| browser内MKV reencode / FFmpeg           | 今回除外 | asbplayer現行Webの実装でもなく、大容量WASMとmemory costが別featureになる   |
| MKV内部subtitle track extraction         | 今回除外 | asbplayer release noteでもfuture work。external `.sup` supportと混同しない |
| browser extension / native player helper | 恒久除外 | local web Playerの独立性を壊す                                             |

DenChouのmulti-scene card向けHTML wrapperは、字幕format parityや複数profileではなく、Mining / Anki export拡張として別管理する。code-side自動固定wrapper / payload wrapping / testsは実装済み。詳細は[DENCHOU_SCENES.md](./DENCHOU_SCENES.md)を参照。無音WebM Video Clipは[VIDEO_CLIP.md](./VIDEO_CLIP.md)で実装済み（Image/Video ToggleGroup、自動JPEG/WebMキャプチャ）。

### 17.8 移植とlicenseの契約

asbplayerはMIT（`A:\asbplayer\LICENSE.md:1-13`）。純粋parser codeを直接移植する場合は、該当fileにMIT copyright / permission noticeを残す。園庭全体のMPL-2.0を置換しない。

### 17.9 実装順とgate

1. **P1.2:** media extension parity + native capability/error contract
2. **P1.3a:** SRT/VTT/ASS text parity
3. **P1.3b:** XML / platform subtitle parity
4. **P1.4:** PGS/SUP Worker image subtitle parity
5. 各stageでparser unit test、actual file browser QA、Home regression、code reviewer APPROVEを通す

---

## 18. 次のアクション

1. P1.3b / P1.4はdeferred — 現在のプロダクト範囲外。将来のyt-dlp acquisition path確立時に再開。
2. P1 same-start cue merge maintenance fix完了（713 tests）。次のgate通過後にP2実装を明示承認した時だけ学習再生modeと設定へ進む。
3. P1の残るformat QA（SRT/VTT/ASS + cue merge確認）をbrowser gateで実施する。
