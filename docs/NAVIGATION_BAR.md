# NAVIGATION_BAR — Entei共通ナビゲーション設計

> **状態:** IMPLEMENTED — デスクトップは中央ブランドピル（Home/Player/Tracker）+ 右端Combobox、モバイルはTopBar + Dock、Playerは上端dwellでピル表示（2026-07-30実装・以降の調整は各コミット参照）。
> **対象:** `Entei/apps/web` の `/`、`/player/`、`/tracker/`。EPUB Readerは対象外。
> **決定日:** 2026-07-30

---

## 1. 人間語でいう共通ナビ

Enteiは、Homeで入口を探し、Playerで学び、Trackerで振り返る3つの部屋を持つ。desktopのHome / Trackerでは、brandを含むpill navigationを上中央へ常時表示する。desktop Playerだけはそのsurfaceを普段隠し、画面上端のhover / keyboard focus時にだけ現す。mobileは今のTopBarとfloating Dockを維持する。

Homeの`DestinationDock`は「今から使う学習機能」を説明する場所のままにする。Trackerを3枚目の大きなtileに追加しない。Trackerは作業を始める扉ではなく、どこからでも戻れる記録室だからである。

```text
Home        → 学習を始める拠点
Player      → mediaとsubtitleを使う部屋
Tracker     → local-firstの記録を振り返る部屋
```

## 2. 確定した情報設計

### 2.1 destinations

| Route       | 見せる名前 | Lucide icon           | 役割                                 | Index   |
| ----------- | ---------- | --------------------- | ------------------------------------ | ------- |
| `/`         | Home       | `House`               | Enteiの拠点へ戻る                    | index   |
| `/player/`  | Player     | `Clapperboard`        | local mediaの再生・学習を開く        | noindex |
| `/tracker/` | Tracker    | `ChartNoAxesCombined` | local-onlyの没入記録と採掘履歴を見る | noindex |

- 3件以外はこのnavへ入れない。EPUB Readerは未提供なのでリンクを作らない。
- ルートを増やす時も、目的地が「常時使う部屋」になった時だけ追加する。Settings、Anki Fields、Mining PreviewのようなPlayer内の操作はnav destinationではない。
- HomeではTrackerを別cardに複製しない。navが唯一のTracker入口である。
- `ChartNoAxesCombined`は、現在install済みの`@lucide/astro`からnamed importできることをsource exportで確認済み。実装時に別iconへ置換しない。

### 2.2 active state

- 現在routeのlinkには`aria-current="page"`を付ける。
- activeはaccent surface / icon / textの組で示す。色だけ、iconだけ、hoverだけには依存しない。
- inactive linkも常に読めるcontrastを保つ。active pageを押しても問題ない通常linkとして残す。

## 3. 1コンポーネントの責務

共通実装は既存の`src/components/home/TopBar.astro`を育てる。`Navbar.astro`と`BottomNavBar.astro`を別々に新設しない。

```text
TopBar.astro
├── desktop Home / Tracker: scroll outする常時pill（brand + Home / Player / Tracker）
├── desktop Player: top-edge hover / focus reveal pill（brand + Home / Player / Tracker）
├── desktopすべて: 設定ボタン（Settingsモーダルをどこからでも開ける）※詳細は後述「設定ボタンの追加（2026-08-07）」
├── desktop Home / Tracker: right edgeにLanguage Combobox React island
└── mobile chrome: brand + optional Language Selector
    └── floating bottom Dock: Home / Tracker / Settings（2026-08-07変更: Playerを除外し、Settingsを追加）
```

route判定・destination link・locale copyは`TopBar.astro`の静的HTMLで成立させる。Language Comboboxだけはshadcnの`Popover + Command`構成を使う小さなReact islandにする。navigation全体をReactへ移さない。

- 見た目は既存のshadcn context（quiet surface、outline、active状態、44px hit area）の密度へ寄せる。
- shadcnに専用のAstro Navbar componentはないため、destinationは`<nav>`と`<a>`のsemanticを使う。buttonをlink代わりにしない。Language Comboboxだけは`role="combobox"`のshadcn triggerを使う。
- iconは`@lucide/astro`のnamed importだけを使う。手書きSVG、emoji、icon fontは入れない。
- `TopBar.astro`のpropsへ現在pathを明示して渡す。component内でURLやbrowser APIを推測しない。
- desktop Language Comboboxはnavの外、viewport右端に置く。destination pillへ入れない。Home / Trackerだけに表示し、Playerにはrenderしない。
- mobileはnative Language Selectorを保つ。mobile Dockは **Home / Tracker / Settings** の3 destination（2026-08-07変更: Playerを除外し、Settingsを追加。Comboboxや4枠目は追加しない）。

### 設定ボタンの追加（2026-08-07設計確定・実装済み）

- **TopBarナビに「設定」ボタン**（Lucide `Settings`、44px hit area）を追加し、**どのページからでもプレイヤー設定モーダル（EizouDen タブを含む）を開ける**ようにする。
- desktop: pill（Home / Player / Tracker）の右側 or 適切な位置に Settings ボタン。Player の top-edge hover pill には含めない（Player 内は既存の Settings アイコンで開く）。
- mobile: floating bottom Dock を **Home / Tracker / Settings** に変更（Player ボタンを除外。Player への導線は /player/ の直接URL・ホームのカード等で維持）。Dock のDOM順も Home → Tracker → Settings に統一（視覚順とTab順を入れ替えない）。
- 設定モーダルは共通コンポーネント化し、TopBarのボタンと Player 内の設定アイコンの両方から開ける。

## 4. レスポンシブ契約

### 4.1 desktop / tablet（768px以上）

desktopの黒いTopBar帯は撤去する。Home / Trackerでは、`[SVG emblem + Entei | Home | Player | Tracker]`を上中央に常時表示し、通常document flowでscroll outさせる。sticky / fixedにしない。

- Home / Trackerのdestination pillは上中央に置く。brandはpillの最初のHome linkとしてまとめ、`Home / Player / Tracker`を続ける。3 linkはicon + 短い文字を表示し、active pageには`aria-current="page"`を付ける。
- desktop Language Comboboxはpillへ入れず、viewport右端へ置く。Combobox triggerのwidthはlocale名でlayout shiftしない固定幅とし、popover contentはtriggerへanchorする。
- Playerは通常時、desktop pillを表示しない。pointerがPlayer viewportの上端central trigger zoneへ入った時、またはkeyboard focusがnav pathへ入った時だけ、中央pillをrevealする。Language ComboboxはPlayerでrenderしない。RightPanelのCaptions / Context tab（`captions` = 字幕/Subtitle/Captions、`context` = ニュアンス検索/Konteks/Context、`apps/web/src/components/player/RightPanel.tsx:23` の `RightPanelTab = 'captions' | 'context'`）やtop-right controlsを塞がないためである。
- Playerのreveal対象は`@media (hover: hover) and (pointer: fine)`だけにする。top-edge trigger zoneへpointerが**750ms連続で留まった時だけ**pillを表示し、通り過ぎただけでは表示しない。pillとtrigger zoneを同じcontainmentに置き、top-edgeからpillへpointerを移す途中で消さない。leave時は150〜250ms後に隠す。keyboard focus時は待機なしで即表示する。
- keyboardはhoverに依存しない。Playerのpill、Combobox trigger、destination linkはDOM・accessibility tree・Tab順に残し、`focus-within`中は表示する。closed visual stateは`opacity`、小さな`transform`、`pointer-events`だけで表し、`display: none`、`visibility: hidden`、`inert`、`aria-hidden`でfocus pathを断たない。
- Playerのnavはmediaを覆う一時surfaceであり、media selection・custom controls・immersive / fullscreen behaviorを変えない。

### 4.2 mobile portrait（767px以下）

Home / TrackerのTopBarはbrandと必要なLanguage Selectorだけを保ち、destination linksはviewport下端のfloating Dockへ移す。Player mobileはTopBarを表示せず、destinationはDockだけにする。

- Dockは`position: fixed`でbottom safe areaの上に浮かせる。
- `env(safe-area-inset-bottom)`と既存Entei spacing tokenを足し、iPhoneのhome indicatorやbrowser chromeに重ねない。
- 3 destinationは等しい幅で、iconの下に短いlabelを置く。tap targetは各44×44 CSS px以上。
- ページ本文にはDock高さ + safe-area分のbottom paddingを確保し、最後の操作・footer・Player controlsをDockで隠さない。
- Dockはすべてのpageで同じDOM順 `Home → Tracker → Settings` を保つ。視覚順とTab順を入れ替えない（2026-08-07変更: Playerを除外し、Settingsを追加）。
- Player mobileでTopBarを隠してもDockは残す。Home / TrackerのTopBarはmobile language selectionの入口として維持する。

### 4.3 Player short-height landscape / fullscreen

`/player/`がmobile landscapeかつshort-height immersive state（既存判定: landscape、height 500px以下）へ入った時は、floating Dockを自動で非表示にする。

- Dock、TopBar、footer、RightPanelは表示しない。videoとcustom controlsだけをviewportへ使う既存immersive契約を守る。
- portraitへ戻る、またはshort-height条件から外れるとDockを戻す。
- fullscreen中もDockを表示しない。document fullscreen stateが変わった時に、focusやscroll位置を不必要に動かさない。
- Player以外のmobile landscapeではDockを残す。TrackerとHomeは閲覧・操作を続けられる。

## 5. layout / layerの境界

| Layer            | 役割                                                                   | 制約                                                          |
| ---------------- | ---------------------------------------------------------------------- | ------------------------------------------------------------- |
| TopBar           | mobile chrome。desktop Home / Trackerではscroll outするbrand pill、Playerではreveal pill | desktopは黒い全幅帯を持たない |
| Language Combobox | desktop右端のlocale選択 | Home / Trackerだけ。Playerにはrenderしない |
| Floating Dock    | mobileだけのroute navigation                                           | dialog / popover / tooltipより下、通常contentより上           |
| Main / Footer    | page固有content                                                        | mobileではDock高さをbottom paddingへ反映                      |
| Player immersive | video + controls                                                       | mobile short landscape / fullscreenではDockを含むchromeを隠す |

Dockへ常時`backdrop-filter`を重ねない。fixed surfaceに限定し、reduced motionでは移動animationなしで表示・非表示を切り替える。色はEntei tokenとOKLCH値だけを使う。

## 6. 多言語とaccessibility

- mobile Dockとdesktop pillの`nav`にはlocaleごとのaccessible nameを与える。desktop / mobileはmedia queryで排他的に表示し、同じdestinationを二重に読上げさせない。
- desktop Comboboxはshadcn公式の`Popover + Command` patternに従う。triggerは現在localeを読み上げ、open state、keyboard選択、選択済みitemを伝える。locale変更後は既存`entei:locale-change` eventで静的nav copyとCombobox表示値を同時に更新する。
- destination名、`aria-label`、現在ページの説明はid / ja / en dictionariesへ同時追加する。
- iconは文字labelがある場合は`aria-hidden="true"`にする。iconだけのcontrolを作らない。
- Skip linkは常にnavigationより前のDOM順を維持し、mainへ直接移動できる。
- `Tab`、`Shift+Tab`、`Enter`で全linkを使えること。Space専用操作や正の`tabindex`を入れない。
- `prefers-reduced-motion`ではDockのenter / exit transitionを止める。
- 200% zoom、400% reflow、320px幅で、Dock itemのlabelが切れず横scrollも出ないこと。
- forced-colors / high-contrastではcurrent pageとkeyboard focusが判別できること。

## 7. 実装分担と順序

### Stage N1 — navigation contract（Mimo）

Mimoは非visual部分だけを担当する。

1. `TopBar.astro`へroute contractを渡す。desktop Home / Trackerはscroll outする常時brand pill + right-edge Combobox、Playerは750ms dwell後のtop-edge reveal pillだけ、mobile Home / Trackerは既存chrome + Dock、PlayerはDockだけを同じdestination定義から描画する。
2. id / ja / en dictionaryへnavigation copyとaccessible nameを追加する。
3. static active-state markup、`aria-current`、landmark、Player landscape / fullscreen visibility stateのデータ境界を実装する。
4. route / locale / active-state / immersion visibilityのtestを追加する。
5. shadcn Comboboxを必要な公式componentだけで追加し、locale selectionを既存`entei:locale-change`契約へ接続する。UIのspacing、色、shadow、motion、responsive CSSはStage N2で扱う。

### Stage N2 — visual navigation（Nemotron）

NemotronはUI / CSSだけを担当する。

1. desktop Home / Trackerのscroll-out brand pill + right-edge Combobox、desktop Playerの750ms dwell後top-edge reveal pill、mobile Home / TrackerのTopBar + DockとPlayerのDock-only chromeをEntei tokenで整える。
2. Lucide named iconを視覚的に揃え、desktop / mobileのhit area、active / hover / focus / pressed / reduced-motion stateを仕上げる。
3. `safe-area-inset-bottom`、mobile content bottom padding、Player immersive non-displayをCSSで接続する。
4. Trackerの学習集計 / read model、Playerのresume persistence、i18n型、test logicを変更しない。

### Stage N3 — verification

| Area                   | 合格条件                                                                                                        |
| ---------------------- | --------------------------------------------------------------------------------------------------------------- |
| static                 | Home / Player / Trackerのbuildが通り、SSRでbrowser APIを読まない                                                |
| route                  | 各pageで正しい1件だけが`aria-current="page"`になる                                                              |
| locale                 | id / ja / enで3 nav labelとaccessible nameが切り替わる                                                          |
| desktop Home / Tracker | 768 / 1024 / 1440pxでbrand pillが上中央に常時あり、scroll outする。Language Comboboxは右端にあり、locale名変更でlayout shiftしない |
| desktop Player         | 768 / 1024 / 1440pxで通常はpillなし。top-edge hoverを750ms維持、またはkeyboard focusで中央pillだけが現れ、Comboboxはrenderせずmedia immersive表示を保つ |
| mobile portrait        | 320 / 360 / 390pxでDockがsafe areaを避け、footer / contentを覆わない。PlayerはTopBarなし、Home / Trackerはlanguage selectionを含むTopBarあり |
| Player landscape       | 955×400相当でTopBar / Dock / footer / RightPanelが消え、portraitで復帰する                                      |
| accessibility          | keyboard、200% zoom、400% reflow、reduced-motion、forced-colorsを確認する                                       |

## 8. 今回は入れないもの

- EPUB Readerへのnav link
- Menu overlay、hamburger、nested navigation
- navigation位置・Dock可視状態のlocalStorage保存
- desktop Player内の将来のcontextual Tracker button
- React hydrationだけを目的にしたNavbar island
- bottom Dockのユーザーによる常時非表示設定
- route遷移時の大きなpage animation

これらは行き先が増える、または実際の操作上必要になった時に改めて判断する。今は3つの部屋を迷わず行き来できれば十分である。
