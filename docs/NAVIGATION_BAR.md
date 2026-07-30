# NAVIGATION_BAR — Entei共通ナビゲーション設計

> **状態:** IMPLEMENTATION PLANNED — route / copy / accessibilityの土台をMimo、UI / CSSをNemotronへ分けて実装する。
> **対象:** `Entei/apps/web` の `/`、`/player/`、`/tracker/`。EPUB Readerは対象外。
> **決定日:** 2026-07-30

---

## 1. 人間語でいう共通ナビ

Enteiは、Homeで入口を探し、Playerで学び、Trackerで振り返る3つの部屋を持つ。共通ナビは、mobileでは常時Dockとして、desktopのHome / TrackerではTopBarへcursorまたはkeyboard focusを置いた時だけ現れるpillとして、この3つの部屋を行き来する案内板である。desktop Playerは没入表示を優先してdestination navigationを出さない。

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
├── desktop Home / Tracker: hover / focus reveal pill（Home / Player / Tracker）
├── desktop Player: destination buttonは表示しない
└── mobile chrome: brand + optional Language Selector
    └── floating bottom Dock: Home / Player / Tracker
```

このcomponentはAstro nativeのままにする。route判定・link・locale copyは静的HTMLで成立し、React islandをnavigationのためだけに増やさない。

- 見た目は既存のshadcn context（quiet surface、outline、active状態、44px hit area）の密度へ寄せる。
- shadcnに専用のAstro Navbar componentはないため、`<nav>`と`<a>`のsemanticを使う。buttonをlink代わりにしない。
- iconは`@lucide/astro`のnamed importだけを使う。手書きSVG、emoji、icon fontは入れない。
- `TopBar.astro`のpropsへ現在pathを明示して渡す。component内でURLやbrowser APIを推測しない。
- Language Selectorの表示条件は維持する。Home / Trackerでは表示、Playerでは現行どおり隠す。

## 4. レスポンシブ契約

### 4.1 desktop / tablet（768px以上）

desktopではdestination buttonを常設しない。Home / Trackerだけ、pointerがTopBar領域へ入った時、またはTopBar内のwordmark / destination linkへkeyboard focusが入った時に、TopBar内から横長pill navigationを表示する。これは画面に常に道案内を貼らず、必要な時だけ天井から案内板を下ろす扱いである。

- reveal対象は`@media (hover: hover) and (pointer: fine)`だけにする。touch / penをhoverとして扱わない。
- hover開始時はpillを表示し、TopBarとpillを含む同じcontainmentからpointerが離れた時だけ短い150〜250msのdelay後に隠す。TopBarからpillへpointerを移す途中で消さない。
- keyboardはhoverに依存しない。pillの`<nav>`と3つの`<a>`は常にDOM・accessibility tree・Tab順に残し、wordmarkまたはdestination linkへのfocus、TopBar全体の`focus-within`中はpillを表示し続ける。
- closed visual stateは`opacity: 0`、小さな`transform`、`pointer-events: none`だけで表す。`display: none`、`visibility: hidden`、`inert`、`aria-hidden`でnavやlinkをfocus pathから外さない。Tabでlinkへ入った瞬間に`focus-within`が成立し、pillを見える状態へ戻す。
- 3 linkはicon + 短い文字を表示する。active pageには`aria-current="page"`を付ける。
- Playerではmediaの有無に関わらずdesktop reveal pillをrenderしない。既存のimmersive表示を維持し、「閉じる」「Homeへ戻る」buttonも新設しない。

### 4.2 mobile portrait（767px以下）

TopBarはbrandと必要なLanguage Selectorだけを保ち、destination linksはviewport下端のfloating Dockへ移す。

- Dockは`position: fixed`でbottom safe areaの上に浮かせる。
- `env(safe-area-inset-bottom)`と既存Entei spacing tokenを足し、iPhoneのhome indicatorやbrowser chromeに重ねない。
- 3 destinationは等しい幅で、iconの下に短いlabelを置く。tap targetは各44×44 CSS px以上。
- ページ本文にはDock高さ + safe-area分のbottom paddingを確保し、最後の操作・footer・Player controlsをDockで隠さない。
- Dockはすべてのpageで同じDOM順 `Home → Player → Tracker` を保つ。視覚順とTab順を入れ替えない。

### 4.3 Player short-height landscape / fullscreen

`/player/`がmobile landscapeかつshort-height immersive state（既存判定: landscape、height 500px以下）へ入った時は、floating Dockを自動で非表示にする。

- Dock、TopBar、footer、RightPanelは表示しない。videoとcustom controlsだけをviewportへ使う既存immersive契約を守る。
- portraitへ戻る、またはshort-height条件から外れるとDockを戻す。
- fullscreen中もDockを表示しない。document fullscreen stateが変わった時に、focusやscroll位置を不必要に動かさない。
- Player以外のmobile landscapeではDockを残す。TrackerとHomeは閲覧・操作を続けられる。

## 5. layout / layerの境界

| Layer            | 役割                                                                   | 制約                                                          |
| ---------------- | ---------------------------------------------------------------------- | ------------------------------------------------------------- |
| TopBar           | brand、optional Language Selector、desktop Home / Trackerのreveal pill | Playerではdesktop pillをrenderしない                          |
| Floating Dock    | mobileだけのroute navigation                                           | dialog / popover / tooltipより下、通常contentより上           |
| Main / Footer    | page固有content                                                        | mobileではDock高さをbottom paddingへ反映                      |
| Player immersive | video + controls                                                       | mobile short landscape / fullscreenではDockを含むchromeを隠す |

Dockへ常時`backdrop-filter`を重ねない。fixed surfaceに限定し、reduced motionでは移動animationなしで表示・非表示を切り替える。色はEntei tokenとOKLCH値だけを使う。

## 6. 多言語とaccessibility

- mobile Dockとdesktop reveal pillの`nav`にはlocaleごとのaccessible nameを与える。desktop / mobileはmedia queryで排他的に表示し、同じdestinationを二重に読上げさせない。
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

1. `TopBar.astro`へroute contractを渡すlayout propsを追加する。desktop Home / Trackerのreveal pillとmobile Dockを同じdestination定義から描画し、Playerではdesktop pillをrenderしない。
2. id / ja / en dictionaryへnavigation copyとaccessible nameを追加する。
3. static active-state markup、`aria-current`、landmark、Player landscape / fullscreen visibility stateのデータ境界を実装する。
4. route / locale / active-state / immersion visibilityのtestを追加する。
5. UIのspacing、色、shadow、motion、responsive CSSを変更しない。

### Stage N2 — visual navigation（Nemotron）

NemotronはUI / CSSだけを担当する。

1. mobile floating Dockとdesktop Home / Trackerのhover / focus reveal pillを、shadcn contextとEntei tokenで整える。desktop Playerにはpillを追加しない。
2. Lucide named iconを視覚的に揃え、desktop / mobileのhit area、active / hover / focus / pressed / reduced-motion stateを仕上げる。
3. `safe-area-inset-bottom`、mobile content bottom padding、Player immersive non-displayをCSSで接続する。
4. Trackerの学習集計 / read model、Playerのresume persistence、i18n型、test logicを変更しない。

### Stage N3 — verification

| Area                   | 合格条件                                                                                                        |
| ---------------------- | --------------------------------------------------------------------------------------------------------------- |
| static                 | Home / Player / Trackerのbuildが通り、SSRでbrowser APIを読まない                                                |
| route                  | 各pageで正しい1件だけが`aria-current="page"`になる                                                              |
| locale                 | id / ja / enで3 nav labelとaccessible nameが切り替わる                                                          |
| desktop Home / Tracker | 768 / 1024 / 1440pxで常設buttonなし、TopBar hover / keyboard focusでpillが現れ、pointerをpillへ移しても消えない |
| desktop Player         | 768 / 1024 / 1440pxでreveal pillをrenderせず、media immersive表示を保つ                                         |
| mobile portrait        | 320 / 360 / 390pxでDockがsafe areaを避け、footer / contentを覆わない                                            |
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
