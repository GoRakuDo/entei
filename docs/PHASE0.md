# Entei Phase 0 — Home Hub Foundation

> Enteiへ初めて来たユーザーを迎え、これから使える学習ツールを迷わず選べる「ゲーム拠点型ホームページ」の設計書。

| 項目             | 内容                                                                                                      |
| ---------------- | --------------------------------------------------------------------------------------------------------- |
| 文書状態         | Implementation Approved — Phase 0 code実装済み、runtime colors normalized to OKLCH、Yosia code review待ち |
| 対象URL          | `https://entei.gorakudo.org`                                                                              |
| 対象Phase        | Phase 0 — ホームページと基盤のみ                                                                          |
| 初期表示言語     | Bahasa Indonesia                                                                                          |
| 追加言語         | 日本語 / English                                                                                          |
| 初期保証ブラウザ | Chromium系ブラウザ                                                                                        |
| 最終更新         | 2026-07-20                                                                                                |

この文書は設計の合意を作るためのもの。Yosiaのレビューと承認が終わるまで、アプリ本体の実装には進まない。

## 1. Phase 0の役割

Phase 0は、Audio & Video Playerそのものを作る段階ではない。Enteiの目的と今後の入口を見せる、公開可能なホームページを完成させる段階とする。

Phase 0で達成すること：

1. 初めて訪れたユーザーが、Enteiを「日本語イマージョン学習のためのローカルファーストな道具箱」だと理解できる。
2. 次に作る主機能が **Audio & Video Player** だと迷わず認識できる。
3. **EPUB Reader** は将来追加される機能で、現時点では利用できないと誤解なく伝わる。
4. Bahasa Indonesia・日本語・Englishを切り替えられ、選択した言語が次回訪問時にも保たれる。
5. 小さなスマートフォン画面からデスクトップまで、同じ情報優先度と操作意味を保つ。
6. Phase 1以降を追加しても、ホームページを作り直さずに新しい目的地を接続できる。

この境界は、元企画がホームシェルと動的プレイヤーを分離していること（`園庭プロジェクトの書き下ろし.md:598-664`）と、後半ロードマップがPlayer・Mining・Video Clipを段階化していること（同`:1390-1523`）の両方に合わせている。家にたとえると、Phase 0は玄関と案内板までを完成させ、作業部屋の設備は次のPhaseで入れる。

## 2. スコープと非スコープ

**Phase 0に含めるもの**

- Entei専用の独立したAstroプロジェクト基盤
- `entei.gorakudo.org` 用の静的ホームページ
- Bahasa Indonesia・日本語・Englishの3言語表示
- 言語切替と、version付きローカルPreferenceの保存
- Audio & Video Playerへ進む主導線
- Phase 1開始前だけ使うPlayer準備中ページ
- EPUB Readerの非操作型 `Coming Soon` 表示
- GoRakuDoの実装済み色・フォントを写したEntei用design tokens
- favicon、OG画像、各言語の基本SEO metadata
- キーボード操作、reduced motion、色コントラストを含むアクセシビリティ基盤
- Chromium上でのmobile-firstなresponsive検証

**Phase 0に含めないもの**

- 音声・動画ファイルの読込み、再生、字幕同期
- Screenshot、Audio Clip、Video Clipの生成
- AnkiConnect連携
- WebTorrent、OPFS、IndexedDBによるメディア管理
- EPUBの読込み・表示・進捗保存
- アカウント、クラウド同期、サーバー側DB
- EXP、レベル、クエスト、バッジ、streak、実績表示
- PWA、オフラインキャッシュ、install prompt
- Firefox・Safariを正式保証対象にすること
- GoRakuDoメインサイトのコードやデザインを変更すること

特にゲームらしさは見た目と移動感だけに留める。元企画は学習イベントが揃ってからEXP等を載せる順序を明記している（`園庭プロジェクトの書き下ろし.md:1153-1258`）。実データのないレベル表示を置くと、空のスコアボードだけ先に設置する状態になるため、Phase 0では扱わない。

## 3. 確定しているプロダクト判断

| 判断               | Phase 0での扱い                                    |
| ------------------ | -------------------------------------------------- |
| ホームの役割       | Enteiへユーザーを迎える入口にする                  |
| 見た目のコンセプト | 学習ツールを選ぶ「ゲームの拠点画面」               |
| 主目的地           | Audio & Video Player                               |
| 将来の目的地       | EPUB Readerを見せるが、`Coming Soon` と明示する    |
| 初期言語           | Bahasa Indonesia                                   |
| 追加言語           | 日本語 / English                                   |
| Preference         | ユーザーが選んだ言語をlocalStorageへ保存する       |
| UI方針             | mobile-first                                       |
| 初期ブラウザ       | Chromiumを先に完成・検証する                       |
| 後続ブラウザ       | Chromium安定後にFirefox対応へ進む                  |
| 色                 | GoRakuDoメインサイトで現在使われている値を継承する |
| 主要フォント       | Gen Interface JP Display / Pixelify Sans           |
| 補助フォント       | Gen Interface JP / Noto Serif JP                   |

色とフォントは、文章だけのデザイン案ではなく実装も照合する。`D:\GoRakuDo\src\styles\global.css:15-42,246-273` に実際のtokensとfont aliasesがあり、`D:\GoRakuDo\src\styles\fonts.css:7-17` と `D:\GoRakuDo\package.json:30-46` に実際のfont importsとdependenciesがある。設計図と現物の両方を測ってから同じ部材を注文する、という扱いにする。

## 4. ユーザージャーニー

**初回訪問**

1. ユーザーが `entei.gorakudo.org` を開く。
2. Bahasa Indonesia版が表示される。ブラウザ言語による勝手な切替はしない。
3. 最初の画面内で、Enteiの短い説明と2つの目的地が見える。
4. Audio & Video Playerが次に使う主機能だと、サイズ・順番・文言で判断できる。
5. EPUB Readerは存在を確認できるが、未提供だと同時に理解できる。

**言語を切り替える訪問**

1. ユーザーがヘッダーの言語Selectorを開く。
2. `Bahasa Indonesia` / `日本語` / `English` から選ぶ。
3. URLを変えず、Home内のcopy、`<html lang>`、`title`、`description`を選択localeへ切り替える。
4. 有効なlocaleだけをversion付きPreferenceへ保存する。
5. 再読込みしても同じURL `/` のまま、保存済み言語が表示される。

**再訪問**

1. 保存済みPreferenceがあれば、ルート `/` を開いた直後に対応localeを表示する。
2. Preferenceがない、無効、破損している場合はBahasa Indonesiaを表示する。
3. localStorageが無効でも、Bahasa Indonesiaの静的Homeを表示して操作を続けられる。

**利用前の機能を見る訪問**

- Playerを選ぶと、Phase 0中は404ではなく、次Phaseでここが置き換わることを伝える小さな準備中ページへ進む。
- EPUB Readerは移動先を持たない。`Coming Soon` の状態説明を読めるだけで、押しても何も起きない偽ボタンにはしない。

この設計では、Homeの3言語切替にJavaScriptを使う。JavaScriptが使えない時も、Indonesianの静的Home、Player準備中ページ、Homeへ戻る通常リンクは利用できる。3言語をJavaScriptなしでURL共有・検索できることは、Phase 0の要件から外す。

## 5. 情報設計とURL契約

| URL         | 言語                                                         | Phase 0での役割       | Index方針 |
| ----------- | ------------------------------------------------------------ | --------------------- | --------- |
| `/`         | 初期値: Indonesian。PreferenceによりJapanese / Englishへ切替 | 唯一の正式Home        | index     |
| `/player/`  | 初期値: Indonesian。PreferenceによりJapanese / Englishへ切替 | Player準備中          | noindex   |
| `/tracker/` | 初期値: Indonesian。PreferenceによりJapanese / Englishへ切替 | local-first記録の閲覧 | noindex   |
| `/404.html` | Indonesian                                                   | 未知URLからHomeへ戻す | noindex   |

ルート契約は次のように固定する。

- Home URLは常に `/` とする。`/id/`、`/ja/`、`/en/` は生成・redirect・canonical対象にしない。
- Language SelectorはURLを変えずに画面内のlocaleを切り替える。
- Phase 1でPlayerが完成したら、同じ `/player/` の中身だけを置き換える。Homeのリンク変更は不要にする。
- EPUB ReaderのURLはPhase 0では作らない。未完成ページを検索エンジンやユーザーへ約束しないため。
- `/` のcanonicalは常に `https://entei.gorakudo.org/` にする。言語別URLがないため`hreflang`は出さない。
- 初期HTML、JavaScript無効時、検索エンジンへ返す正本はIndonesianとする。
- 現在localeは、初期HTMLでは`id`、Selectorによる切替後は`document.documentElement.lang`を`ja`または`en`へ更新する。

Astro公式はlocale prefixを使うroutingを提供しているが、それはこのPhaseで必須の仕組みではない（`docs.astro.build/en/guides/internationalization/`）。一方、GoRakuDoの既存`BaseLayout`は `<html lang={lang || 'id'}>` とSEOへの`lang`受渡しを既に行っている（`D:\GoRakuDo\src\layouts\BaseLayout.astro:70-97`）。Enteiでは単一URLを保ちつつ、表示localeに合わせて`lang`を更新する。案内板の言葉だけを変え、玄関の住所は変えない形。

## 6. ホームページの画面構成

ホームは上から次の順番にする。

1. **Skip link**
   - キーボード操作時だけ表示し、Main Hubへ直接移動できる。

2. **Top Bar**
   - 左：Entei wordmark。Homeへのリンクも兼ねる。
    - desktopの黒いTop Bar帯は出さない。Home / Trackerでは上中央に`SVG emblem + Entei | Home | Player | Tracker`のpill navigationを常時置き、通常scrollで画面外へ流す。Playerだけは通常時にpillを隠し、上端hoverを750ms維持した時、またはkeyboard focus時に中央pillだけ出す。Language ComboboxはPlayerに出さず、RightPanelの操作域を塞がない。
   - mobileでは、Home / Trackerで現在言語が見えるLanguage Selectorを保ち、Home / Player / Trackerの移動はfloating Dockへ置く。Playerは現行どおりSelectorを出さない。
   - mobileでは、Top Barはwordmarkと必要なSelectorだけにし、3 destinationはsafe-area対応のfloating bottom Dockへ移す。
   - 詳細なroute、responsive、accessibilityの契約は[`NAVIGATION_BAR.md`](./NAVIGATION_BAR.md)を正とする。

3. **Hub Identity**
   - Pixelify Sansによる短いsystem label。
   - Gen Interface JP Displayによるページ唯一の`h1`。
   - Enteiが何を助ける場所かを説明する1〜2文。
   - 装飾はCSS gradient、grid、軽量SVG emblemまで。大きなstock photoは使わない。

4. **Destination Dock**
   - Audio & Video Playerを、最初・最大・高contrastの主目的地として置く。
   - EPUB Readerを、落ち着いたlocked destinationとして縦に並べる。
   - 両destinationは同じfull-width rectangular shapeで縦に積み、優先度は色・border・内容で示す。
   - Trackerは共通navigationの目的地であり、このDockへ3枚目のtileとして複製しない。

5. **Local-first Note**
   - `No account`、`Media stays on your device` に相当する短い安心材料を置く。
   - 技術説明を長くせず、必要なら後で詳細ページを追加する。

6. **Footer**
   - GoRakuDoメインサイトへ戻る外部リンク。
   - Privacy / Termsは実在するページだけを表示する。
   - Enteiのversionまたはcopyrightを控えめに表示する。

スマートフォンでは自然に縦へ流し、デスクトップではHub IdentityとDestination Dockを左右非対称に置く。ゲームのメニュー画面のように「今いる場所」と「選べる行先」がひと続きに見えればよく、記事サイトのような長いsection列は作らない。

### Home composition record（2026-08-11）: Hero wrapper + MDX Roadmap

- **`entei-main-inner` は BaseLayout の共有インフラ**であり、Home hero に転用してはならない（Player / Tracker の global layout を壊さないため）。
- Home は専用の **`entei-home-hero` wrapper** を追加し、その中に既存 `HubIdentity` + `DestinationDock` を置く（desktop / mobile とも中央寄せ・既存 BaseLayout の共有 desktop grid は変更しない）。
- Hero の下に **MDX による Roadmap section**（`Fitur yang mendatang`）、その下に既存 `LocalFirstNote` の順で並べる。
- **MDX は未導入だった**ため `npm install @astrojs/mdx` で導入し、`astro.config.mjs` の integrations へ `mdx()` を追加した。ローカル MDX 1 ファイル（`src/content/home/future-features.mdx`）を Home が直接 import する（content collection は使わない＝現時点で具体的な利益がないため最小構成）。
- Roadmap 内容はインドネシア語で「イマージョン学習者のための versatile platform 計画」「multiplayer Quest 挑戦」「Context Library（YouTube / Anime Clip から単語の使用文脈を探す）」「ローカルデバイス・無料モデル継続のための支援」を明記し、一時的な**プレーンテキスト支援リンク**（YouTube Join / Trakteer・ボタンやカードにしない）を置く。
- 本 record は Section 6（画面構成）の追記であり、他の PHASE0 section は変更しない。

## 7. Destinationの挙動と状態

**Audio & Video Player — 主目的地**

- Tile全体を通常の`<a>`として操作可能にする。
- 見出し、1文の説明、Player icon（Lucide AudioLines）、現在の開発状態、移動を示す矢印（Lucide ArrowRight）を含める。
- Phase 0中のCTAは「今すぐ再生できる」と誤認させない。`Playerを見る` / `Lihat ruang Player` のようなpreview寄りの表現にする。
- 移動先の準備中ページには、PlayerがPhase 1で追加されることとHomeへ戻るリンクだけを置く。
- 完成日、進捗率、待機リストなど、実在しない約束は置かない。
- Phase 1ではURLとHome側tileを維持し、準備中ページの中身をPlayerへ交換する。

**EPUB Reader — locked destination**

- Player tileに似た外形でも、リンクやクリックhandlerは持たせない。
- `Coming Soon` を常に文字で表示し、lock iconや色だけに状態を依存しない。
- Cursorは通常のままにし、hoverで浮かせたり矢印を出したりしない。
- 低すぎるopacityで「壊れているUI」に見せない。本文とstatusは読めるcontrastを保つ。
- Screen readerにもReader名と未提供状態が連続して伝わる構造にする。
- Tooltipを唯一の説明手段にしない。Touch端末にはhoverがないため。

押せるPlayerは扉、EPUBは「次に建つ部屋」の案内板として扱う。同じ見た目の扉を2つ置いて片方だけ反応しない状態にはしない。GoRakuDoのdesign manualも、hover-onlyな情報と低contrastなdisabled表現を避ける方針を示しており（`D:\GoRakuDo\DESIGN.md:553-588,635-651`）、既存CSSにもfocus-visibleの実装がある（`D:\GoRakuDo\src\styles\global.css:997-1004`）。

## 8. 多言語とPreference設計

使用可能なlocaleは `id | ja | en` の3値だけに固定する。`<html lang>`、翻訳辞書、document metadata、localStorage validationが同じ型を使う。URLはlocaleの入力に使わず、常にHome `/` を保つ。

**翻訳データ**

- UI文字列はcomponent内へ直接散らさず、localeごとのtyped dictionaryへ置く。
- 3言語が同じkey setを持つことをbuildまたはtestで検証する。
- 翻訳keyは画面位置ではなく意味で命名する。例：`destination.player.title`。
- 文全体を翻訳し、語句を連結して日本語やIndonesianの語順を壊さない。
- 日付・数値が加わった時は`Intl`を使い、独自formatを作らない。

**Language Selector**

- Native `<select>`を使い、現在の言語名を省略せず表示する。
- Optionは `Bahasa Indonesia`、`日本語`、`English` と各言語自身の名前で表示する。
- 変更時にURL遷移をせず、同じHome内のcopy、`<html lang>`、`title`、`meta[name="description"]`を更新する。
- Selectのvisible labelを持たせ、custom popupや`aria-current`を作らない。
- 国旗は使わない。言語と国家は1対1ではないため。

**保存形式**

```json
{
  "schemaVersion": 1,
  "locale": "id"
}
```

- Keyは `entei.preferences.v1` とする。
- 読込み・parse・保存はすべて例外を捕捉する。
- `locale`が3値以外なら無視し、`id`へ安全にfallbackする。
- Preferenceがない初回訪問では、ブラウザ言語を推測せず`id`を表示する。
- Preferenceがある再訪時は、初期HTMLの後に保存localeへ切り替える。切替による文字のちらつきが目立たないことを実機確認する。
- Storageが使えない場合も、Selectorによる画面内切替は成功し、永続化だけを諦める。

localStorageはorigin単位なので、`entei.gorakudo.org` のPreferenceは `gorakudo.org` と共有されない。この分離はWeb Storage仕様と元企画のversioned key方針（`園庭プロジェクトの書き下ろし.md:134-143`）に合う。ホテル本館と別館で部屋の鍵が別なのと同じで、意図せずメインサイトの設定を上書きしない。代わりに、URLを共有した相手には相手側のPreferenceまたはIndonesianが表示されるため、言語を固定して共有する用途はPhase 0では扱わない。

## 9. 初期copy deck

以下はlayoutと翻訳keyを具体化するためのdraft。公開前にYosiaが自然さと語調を確認する。

| Key                        | Bahasa Indonesia                                                                                              | 日本語                                                           | English                                                                                        |
| -------------------------- | ------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `hub.systemLabel`          | `ENTEI // MARKAS BELAJAR`                                                                                     | `ENTEI // 学習拠点`                                              | `ENTEI // LEARNING BASE`                                                                       |
| `H1（固定・Dictionary外）` | `園庭`（全言語共通・固定表示）                                                                                | `園庭`（全言語共通・固定表示）                                   | `園庭`（全言語共通・固定表示）                                                                 |
| `hub.lead`                 | `Kami sedang membangun ruang belajar untuk video, audio, dan buku berbahasa Jepang dari perangkatmu sendiri.` | `手元の映像・音声・本から学ぶための場所を、ここに作っています。` | `We're building a learning space around the Japanese videos, audio, and books on your device.` |
| `player.title`             | `Pemutar Audio & Video`                                                                                       | `音声・動画プレイヤー`                                           | `Audio & Video Player`                                                                         |
| `player.description`       | `Ruang untuk belajar dari media lokal dan subtitle milikmu, hadir di tahap berikutnya.`                       | `手元のメディアと字幕から学べる部屋を、次のPhaseで追加します。`  | `A space for learning from your own local media and subtitles, arriving in the next phase.`    |
| `player.cta.phase0`        | `Lihat ruang Player`                                                                                          | `Playerの準備を見る`                                             | `Preview the Player space`                                                                     |
| `player.status.phase0`     | `Tahap berikutnya`                                                                                            | `次のPhase`                                                      | `Next phase`                                                                                   |
| `reader.title`             | `Pembaca EPUB`                                                                                                | `EPUBリーダー`                                                   | `EPUB Reader`                                                                                  |
| `reader.status`            | `Segera hadir`                                                                                                | `Coming Soon`                                                    | `Coming soon`                                                                                  |
| `privacy.local`            | `Tanpa akun. Media tetap di perangkatmu.`                                                                     | `アカウント不要。メディアは端末内に残ります。`                   | `No account. Your media stays on your device.`                                                 |
| `nav.backToGorakudo`       | `Kembali ke GoRakuDo`                                                                                         | `GoRakuDoへ戻る`                                                 | `Back to GoRakuDo`                                                                             |

Copyのルール：

- 「革命的」「究極」「次世代」など、根拠のない大きなmarketing語を使わない。
- Phase 0でまだ使えない機能を現在形で利用可能に見せない。
- 見出しは短く、説明は最大2文にする。
- `local-first` のような技術語だけで済ませず、ユーザーに起きることを平易に書く。
- 3言語で文字量が変わっても、font-sizeを言語ごとに小さくして押し込まない。

## 10. Color system

Phase 0では、GoRakuDoの現在の実装値をEntei側の`tokens.css`へ写す。親projectのCSSをruntime importせず、Enteiを単独でbuild可能にする。各値には参照元とsnapshot日をcommentで残す。

| Token                       | 実装値                          | Enteiでの主な役割                          |
| --------------------------- | ------------------------------- | ------------------------------------------ |
| `--token-white-base`        | `oklch(95% 0.005 285deg)`       | 主見出し、強い文字                         |
| `--grkd-black-950`          | `oklch(5% 0.005 270deg)`        | Page background                            |
| `--grkd-surface`            | `oklch(17.80% 0.058 275.81deg)` | Top Bar、通常panel                         |
| `--grkd-surface-2`          | `oklch(30.96% 0.150 271.29deg)` | Player tile、elevated surface              |
| `--grkd-purple-500`         | `oklch(57.74% 0.209 273.85deg)` | Primary accent、focus、active border       |
| `--grkd-purple-400`         | `oklch(65% 0.22 273.85deg)`     | Hover、明るいaccent                        |
| `--token-gold-base`         | `oklch(85% 0.15 85deg)`         | System label、locked statusの補助          |
| `--grkd-muted`              | `oklch(85.99% 0.071 282.16deg)` | Secondary text                             |
| `--token-text-global-muted` | `oklch(70% 0.01 270deg)`        | Footer、補足。ただし小文字はcontrast再検証 |

使用ルール：

- 背景は純黒ではなく`--grkd-black-950`を使う。
- Purpleは主操作とfocusへ集中させ、全要素を発光させない。
- Goldは「特別」「状態」の補助に限定し、主CTAの色と競合させない。
- Player tileはEPUB tileより明度差・border・面積の3要素で強くする。色だけで優先度を伝えない。
- `Coming Soon`を薄い灰色だけで示さず、文字とiconを併用する。
- 通常文字は4.5:1以上、大きな文字とUI境界は3:1以上を実測する。OKLCH値から安全だと推測しない。
- Gradientは背景の奥行きにだけ使い、文字そのものの可読性をgradientへ依存させない。
- Outer glowの常用、rainbow gradient、pure whiteの広い面、glass panelの多重化は禁止する。

値の根拠は `D:\GoRakuDo\src\styles\global.css:15-47`。本表の9 tokensは9件とも実装値との一致を照合済み。これは数値の転記が一致した証拠であり、画面上の見え方まで確認した証拠ではない。実装後にcolor managementとcontrastを実画面で測定する。

## 11. Typography system

| Role                 | Font                       | 使用箇所                                    |
| -------------------- | -------------------------- | ------------------------------------------- |
| Body / UI            | `Gen Interface JP`         | 説明、navigation、button、3言語共通の本文   |
| Display              | `Gen Interface JP Display` | Playerなどのdestination title。Hub H1は除く |
| System / Game accent | `Pixelify Sans`            | 短いsystem label、status、Phase表記         |
| Serif accent         | `Noto Serif JP`            | 全言語で固定表示する`園庭`のH1だけ          |

使用ルール：

- `Pixelify Sans`を本文、長文、日本語paragraphへ使わない。ゲーム感は短いlabelのリズムで出す。
- `Gen Interface JP Display`は見出しへ限定し、本文の可読性は`Gen Interface JP`へ任せる。
- `Noto Serif JP`は装飾目的で多用せず、固定`園庭`のH1だけにする。
- `h1`は固定の2文字だけなので、`clamp(4.5rem, 14vw, 9rem)`で拠点名として大きく飾る。長い翻訳文をmobileへ押し込まない。
- Bodyはmobileでも原則`1rem`未満にしない。説明文は`line-height: 1.6`前後を出発点にする。
- System labelは視覚的に大文字化しても、翻訳データそのものを破壊的にuppercase変換しない。
- Headingには`text-wrap: balance`、本文には`text-wrap: pretty`をprogressive enhancementとして使う。
- Webfont読込み前後で目的地tileが大きく跳ねないよう、fallbackとlayout幅を実機確認する。
- Font packageは必要なfamilyとweightだけをproject内へbundleし、外部Google Fonts requestは発生させない。

GoRakuDoの実装は、Display・JP・Pixel用aliasを既に分けている（`D:\GoRakuDo\src\styles\global.css:244-273`）うえ、`Noto Serif JP`と`Pixelify Sans`をlocal packageからimportしている（`D:\GoRakuDo\src\styles\fonts.css:9-17`）。そのため、Yosiaの「NotoSansSreif JP」という表記は、現存するpackage名に合わせて **Noto Serif JP** を指すものとして本書では扱う。違うfontを意図していた場合だけレビュー時に変更する。

## 12. Responsive layout

**Base — 320px以上**

- 1 column。
- desktop Home / Trackerは上中央のbrand pillを常時表示し、右端へshadcn Language Comboboxを置く。desktop Playerは通常時にpillを隠し、上端hoverを750ms維持した時、またはkeyboard focus時に中央pillだけ出す。Language ComboboxはPlayerにrenderしない。mobileのHome / Trackerは既存native Language Selectorを保ち、destinationはfloating Dockへ置く。Player mobileはTopBarを出さずDockだけにし、Homeで保存した言語設定を読む。
- Hub Identityの後にPlayer、EPUBの順で縦配置する。
- Tileの主要操作領域は最低44×44 CSS pxを確保する。
- 左右paddingは`clamp(1rem, 4vw, 1.5rem)`を出発点にする。
- `100vh`へ内容を無理に閉じ込めず、`100dvh`を最低高として自然なscrollを許可する。
- `env(safe-area-inset-*)`を考慮し、notchやbrowser barに操作を隠さない。

**Small tablet — 640px以上**

- 余白とtype scaleを少し拡張する。
- Destinationはまだ1 columnを基本とし、各tile内のiconとcopyを横方向に組める。
- Language optionsを開いてもviewport外へはみ出さない。

**Tablet — 768px以上**

- Hub IdentityとDestination Dockを、内容量を見ながら2 columnへ移行する。
- Destination Dockは縦のフル幅stackを維持し、横並びにはしない。PlayerとEPUBは同じfull-width rectangular shapeで、色・border・内容の差で主従を示す。
- Footerは左右へ分けても、DOM順はmobileと同じに保つ。

**Desktop — 1024px以上**

- Main Hubを左右非対称のgridにする。目安はIdentity `5/12`、Destinations `7/12`。
- Content幅は約`72rem`〜`80rem`で上限を設け、超wide monitorで要素を引き離さない。
- Hoverは追加feedbackとして使えるが、情報や操作をhoverだけに置かない。

**Wide — 1280px以上**

- 文字を際限なく拡大せず、外側の余白で落ち着きを作る。
- Background emblemやgridの余白を広げても、主要copyとCTAの距離は維持する。

検証幅は最低でも`320`、`360`、`390`、`768`、`1024`、`1280`、`1440`pxとする。さらに高さ`568`px前後とmobile landscapeを確認する。GoRakuDoのmanualもmobile-firstと`640/768/1024/1280`の段階を採用しており（`D:\GoRakuDo\DESIGN.md:339-356`）、実装tokenにも44px touch targetがある（`D:\GoRakuDo\src\styles\global.css:298-299`）。

## 13. Motionとinteraction feedback

- 初期表示は、Hub IdentityとDestination Dockを`opacity`と小さな`translate`で1回だけ入場させる。
- 入場時間は概ね`300–500ms`、要素間delayは最大`80ms`程度に留める。
- Button / tileのhover・press・focus feedbackは`120–200ms`を目安にする。
- Player tileはhoverで数px持ち上げてもよいが、layout reflowを起こすpropertyは動かさない。
- Page loadを待たせるsplash screen、ロゴ動画、強制introは作らない。
- Phase 0ではCanvas、WebGL、particle engine、常時動くwave animationを導入しない。
- Backgroundは静的なgradient・grid・noise textureで奥行きを作る。連続animationが必要かは実画面レビュー後に判断する。
- `visibilitychange`後にanimationが重複実行されない構造にする。
- 操作完了をmotionだけで伝えず、状態文字とfocus位置を合わせて更新する。

`prefers-reduced-motion: reduce` では、入場・hover移動・smooth scrollを無効化し、状態変化を即時にする。Decorationを止めても情報階層が失われないことを必須とする。

この制約はGoRakuDo manualのmotion durationとreduced-motion方針（`D:\GoRakuDo\DESIGN.md:360-439`）に合わせつつ、Phase 0の主目的がナビゲーションであることからさらに軽くしている。遊園地の入口らしさは看板と照明で作り、入場するたびに長い演出を見せない考え方。

## 14. Accessibility requirements

目標はWCAG 2.2 AA。最低でも次を満たすまでPhase 0完了としない。

- `header` / `nav` / `main` / `footer` のlandmark構造を保つ。
- mobile Dockとdesktop Home / Trackerのreveal pillの現在routeは`aria-current="page"`で示す。desktop / mobileは排他的に表示し、同じdestinationを二重に読上げさせない。desktop pillはkeyboard focusでも表示する。
- `h1`は1つだけにし、見た目の都合でheading levelを飛ばさない。
- Skip linkをキーボードfocus時に表示する。
- すべての操作を`Tab` / `Shift+Tab` / `Enter` / `Space` / 必要な矢印keyだけで完了できる。
- 順番を人工的に変える正の`tabindex`を使わない。
- Focus ringを消さず、要素と背景の双方に対して3:1以上のcontrastを確保する。
- 初期HTMLへ`<html lang="id">`を設定し、Selector切替後は現在localeへ更新する。
- IndonesianまたはEnglish表示内に短い日本語を出す場合、必要に応じて該当部分へ`lang="ja"`を付ける。
- Destination iconは情報を持つ時だけaccessible nameを与え、純粋な装飾なら`aria-hidden="true"`にする。
- EPUBのlocked状態を色・opacity・lock iconだけで伝えない。
- 本文は4.5:1以上、UI境界と大きな文字は3:1以上を保つ。
- 200% zoomで操作が重ならず、400% zoomまたはCSS viewport相当320pxでも内容順を維持し、横scrollを発生させない。
- Browserの文字拡大で言語名・status・CTAを切らない。
- Viewport metaでpinch zoomを禁止しない。
- `prefers-reduced-motion`、`prefers-contrast`、Windows forced-colorsを確認する。
- Native Language Selectorがkeyboardとscreen readerで現在値・選択肢・変更結果を正しく伝えることを確認する。

自動検査にはaxe/Lighthouseを使うが、scoreだけで完了判定しない。キーボード操作、screen readerの読上げ順、zoomを手動確認する。自動検査はlabelの欠落を見つけられても、押せるtileがlocked tileに見えるかまでは判断できないため。W3C WCAG 2.2仕様（`w3.org/TR/WCAG22/`）とGoRakuDoのaccessibility規則（`D:\GoRakuDo\DESIGN.md:553-588`）の2方向で確認する。

## 15. SEOとsocial preview

- `site`は本番origin `https://entei.gorakudo.org` に固定する。
- 初期HTMLの`title`と`description`はIndonesianで用意する。Selector切替後のbrowser tabとdescriptionは現在localeへ更新する。
- Canonicalは常に `https://entei.gorakudo.org/` を指す。
- 言語別URLがないため`hreflang`は出さない。
- `/player/`、`/tracker/`、404は`noindex,follow`にする。
- `sitemap.xml`にはindex可能なHome `/`だけを載せる。
- `robots.txt`を静的に配信し、build previewでも内容を確認する。
- Structured dataはPhase 0の実態に合わせて`WebSite`を使う。Playerが未提供のうちから`SoftwareApplication`として機能を宣伝しない。
- Open Graph / Twitter Cardを設定する。
- OG画像は`1200×630`を基準に、Entei wordmark・hub emblem・GoRakuDo paletteだけで構成する。
- OG画像はURLごとに切り替えられないため、Phase 0では言語に依存しない1枚を使う。
- faviconは明るい背景と暗い背景の双方で輪郭が消えないsimple emblemにする。
- `theme-color`はPage backgroundと合わせ、browser chromeだけが不自然に明るくならないようにする。
- 公開前に生成HTMLを直接読み、初期`lang="id"`、canonical、OG URLが絶対URLになっていることを確認する。Selector切替後は`lang`、`title`、descriptionが選択localeへ変わることをbrowserで確認する。

GoRakuDoは現在、static output・site URL・sitemapをconfigで管理し（`D:\GoRakuDo\astro.config.mjs:12-17,49-95`）、BaseLayoutから共通SEO componentへ`lang`やmetadataを渡している（`D:\GoRakuDo\src\layouts\BaseLayout.astro:70-97`）。Enteiではその考え方を再利用するが、親projectの重いSEO componentをそのままcopyせず、Phase 0に必要な項目だけを小さく作る。

## 16. Privacyとsecurity baseline

- Phase 0は完全なstatic outputとし、独自API・server session・databaseを持たない。
- Analytics、advertising、tracking pixel、cookie bannerを導入しない。
- localStorageへ保存するのは`schemaVersion`と`locale`だけ。個人情報、media path、閲覧履歴は保存しない。
- Preference JSONは信用せず、parse後に型と許可値を検証する。
- 翻訳文字列を`innerHTML`へ流さず、通常のtext renderingを使う。
- Font、icon、OG画像はself-hostする。
- GoRakuDoの`global.css:1`にある外部Fluent Emoji font importはコピーしない。Phase 0の要件に不要で、外部originをCSPへ追加する理由がないため。
- 外部script、CDN script、remote widgetを使わない。
- CSPは最低でも`default-src 'self'`を基準に、実際のbuild outputが必要とするdirectiveだけを許可する。
- `frame-ancestors 'none'`、`base-uri 'self'`、`object-src 'none'`を候補にし、hosting先のresponse headerで設定する。
- `Referrer-Policy`、`X-Content-Type-Options: nosniff`、必要最小限の`Permissions-Policy`もhosting環境で検証する。
- HTTPS以外を本番URLとして許可しない。
- Dependencyはlockfileで固定し、release前にauditとlicense確認を行う。
- Phase 0ではService Workerを登録しない。古いassetが残るcache問題をまだ持ち込まないため。

元企画もstrict CSP、HTTPS、外部resource最小化をsecurity方針としている（`園庭プロジェクトの書き下ろし.md:1571-1583`）。さらに実装済みGoRakuDo CSSには第三者font requestが1つ存在する（`D:\GoRakuDo\src\styles\global.css:1`）。「paletteを継承する」と「親CSSを丸ごと取込む」を分けることで、見た目を保ちながら不要な通信だけを持ち込まない。

## 17. 技術基盤とproject境界

Enteiは `D:\GoRakudo_Projects\Entei` だけを変更対象とする。`D:\GoRakuDo` はpalette・font・既存パターンを読む参照元であり、Entei実装のために変更しない。

Phase 0実装時の最小構成案：

```text
Entei/
├─ apps/
│  └─ web/
│     ├─ public/
│     │  ├─ brand/
│     │  └─ og/
│     ├─ src/
│     │  ├─ components/home/
│     │  ├─ i18n/
│     │  ├─ layouts/
│     │  ├─ pages/
│     │  ├─ scripts/
│     │  └─ styles/
│     ├─ tests/
│     ├─ astro.config.mjs
│     └─ package.json
├─ docs/
│  └─ PHASE0.md
├─ package.json
└─ lockfile
```

構成ルール：

- Rootはworkspace管理に使い、Phase 0では`apps/web`だけを作る。
- `packages/core`、`packages/player`、`packages/mining`は最初の利用箇所が生まれるPhaseで追加する。空packageを先に作らない。
- HomeはAstroのstatic HTMLを中心にし、Language Preferenceだけ小さなTypeScript moduleで補助する。
- Vue integrationはPlayer islandを作るPhase 1までinstallしない。Phase 0にはVueが必要な状態管理や動的canvasがないため。
- StylingはTailwind CSS v4 + semantic tokensを第一候補にする。ただしinstall前に、Phase 0の規模ならplain CSSの方が単純かを比較し、Section 23の判断を確定してから採用する。
- TypeScriptはstrict modeを有効にし、`any` castを使わない。
- Homeは1ページだけ生成し、3 localeのdictionaryから画面内copyを切り替える。markupを3回copyしない。
- Locale validation、Preference parse、document metadata更新をそれぞれ1か所へ集約する。
- Asset file名は小文字kebab-case、componentはPascalCase、script/helperはcamelCaseを基本とする。
- Application sourceから`D:\GoRakuDo`の絶対pathをimportしない。CIやhostingにはそのdirectoryが存在しないため。

元企画はmonorepo内でshellとdomain packagesを分ける設計を示している（`園庭プロジェクトの書き下ろし.md:771-832`）。一方、Phase 0で実際に必要なのはweb appだけ。最初から`apps/web`の位置を確保しつつ空のdomain packagesを作らない案なら、将来の移動を避けながらYAGNIも守れる。

Astroの正確なversionは実装開始日に公式releaseとintegration互換性を再確認してlockする。GoRakuDoはAstro 5系を利用中だが、新規projectまで無条件に同versionへ固定する根拠にはしない。

## 18. Brand assets

Phase 0で必要なasset：

| Asset          | 最初の形式                             | 用途                           | Phase 0方針                                             |
| -------------- | -------------------------------------- | ------------------------------ | ------------------------------------------------------- |
| Entei wordmark | Text + font                            | Top Bar / Hub Identity         | Pixelify Sansで開始可能                                 |
| Hub emblem     | Lucide Flame icon via `@lucide/astro`  | Top Bar / Hub Identity         | `@lucide/astro` Flame component, tree-shaken SVG        |
| Player icon    | Lucide AudioLines via `@lucide/astro`  | 主目的地                       | AudioLines communicates both audio and video            |
| EPUB icon      | Lucide BookMarked via `@lucide/astro`  | Coming Soon目的地              | BookMarked communicates reading, gold accent for locked |
| Arrow cue      | Lucide ArrowRight via `@lucide/astro`  | Player tile movement indicator | Decorative, aria-hidden                                 |
| Chevron        | Lucide ChevronDown via `@lucide/astro` | Language Selector dropdown     | Decorative, aria-hidden                                 |
| Favicon set    | SVG + PNG                              | Browser / install surface      | 16pxでも潰れないemblemから生成する                      |
| OG image       | WebPまたはPNG                          | SNS共有                        | `1200×630`、文字を最小限にする                          |
| Subtle texture | 小さなAVIF/WebPまたはCSS               | Background depth               | 無くても成立するprogressive decorationにする            |

Assetルール：

- Emojiを主要iconとして使わない。OSごとに形が変わり、game hubの統一感を保てないため。
- Icon setは`@lucide/astro`からtree-shakenでimportし、必要なiconだけをbundleする。
- 装飾SVGはscreen readerから隠し、意味を持つSVGにはtitleだけでなく周辺textも用意する。
- Raster imageにはwidth/heightを指定し、layout shiftを防ぐ。
- Hero用の大きな人物絵やstock imageはPhase 0のblockerにしない。CSSとvectorだけで最初の世界観を成立させる。
- Audio、video、autoplay soundはHomeに置かない。Player機能と歓迎ページを混同しない。
- Assetはすべてrepository内でversion管理し、remote URLへ依存しない。
- Phase 0のEntei wordmarkはlive textとし、font load失敗時はfallback fontでも読めることを優先する。形を常に固定する役割はHub emblemへ任せ、wordmarkのSVG化は実画面レビューで必要と分かった時だけ行う。

現在 `D:\GoRakudo_Projects` には企画書以外のEntei assetがなく、GoRakuDo側のfont packagesとCSS tokensだけが再利用可能な根拠として確認できている。何もない舞台へ仮のstock写真を置くより、まず照明・看板・2つの入口をvectorで完成させ、専用illustrationが必要だと実画面で分かってから追加する。

## 19. Phase 0 work breakdown

| Unit | 作業               | 成果物                                                | 次へ進む条件                                             |
| ---- | ------------------ | ----------------------------------------------------- | -------------------------------------------------------- |
| 0.0  | 設計合意           | 本書                                                  | Yosiaが内容・未決事項をレビューして承認                  |
| 0.1  | Project scaffold   | Workspace、`apps/web`、基本scripts、lockfile          | clean install、type check、空buildが成功                 |
| 0.2  | Design foundation  | tokens、fonts、BaseLayout、global styles              | Palette照合、font 3言語表示、horizontal overflowなし     |
| 0.3  | i18n foundation    | typed dictionaries、画面内locale切替、Preference      | 1 Home生成、missing key test、保存・破損fallback確認     |
| 0.4  | Home Hub UI        | Top Bar、Hub Identity、Destination Dock、Footer       | mobile/desktop実画面レビュー、keyboard操作、contrast確認 |
| 0.5  | Destination states | Player準備中ページ、EPUB locked表現、404              | Dead linkなし、誤認clickなし、Homeへ戻れる               |
| 0.6  | Public metadata    | SEO、OG、favicon、sitemap、robots、security headers案 | 生成HTML・social preview・header staging確認             |
| 0.7  | Quality gate       | 全test、Lighthouse、axe、manual matrix                | Definition of Doneを全項目通過                           |
| 0.8  | Publish            | Hosting設定、custom domain、HTTPS                     | Yosiaの明示承認後にだけdeployし、本番smoke test成功      |

各Unitは次の順序で閉じる。

1. そのUnitだけを実装する。
2. Unit固有testと共通checkを実行する。
3. 実画面または生成物を確認する。
4. code-reviewerへ変更理由・対象file・期待挙動を渡してblind-spot reviewする。
5. Findingがあれば修正し、同じcheckを再実行する。
6. 本書末尾のImplementation Logへ実測結果を追記する。
7. Yosiaへ結果と次Unitの可否を短く報告する。

Commit、push、PR、deployは外部または履歴へ副作用を持つため、Unit完了だけを理由に自動実行しない。Yosiaからその操作が明示された時だけ行う。

## 20. Verification matrix

**Buildとcode quality**

- Clean checkout相当からpackage managerのfrozen installが成功する。
- Format checkが成功する。
- Lintがerror 0で終了する。
- Astro / TypeScript checkがerror 0で終了する。
- Unit testがすべて成功する。
- Production buildがwarningを隠さず成功する。
- Production previewで全routeを直接開ける。

**i18n / Preference**

- `/`が初期HTMLで`lang="id"`とIndonesian copyを持つ。
- 3 dictionaryのkey setが一致する。
- `id → ja → en → id`の順に切り替え、URLが常に`/`のまま、copy・`lang`・title・descriptionが一致する。
- Reload後も選択localeが保たれる。
- `entei.preferences.v1`が空、壊れたJSON、未知locale、古いschemaでもHomeが落ちない。
- localStorageをblockしてもSelectorによる画面内切替は動く。
- JavaScriptを無効にしてもIndonesianのHome、Player準備中、Homeへ戻る通常リンクを利用できる。
- 保存localeを持つ再訪時も、初期Indonesianからの切替が視覚的に目立たない。

**Viewport / visual**

- Chromiumの`320×568`、`360×800`、`390×844`、`768×1024`、`1024×768`、`1280×800`、`1440×900`で確認する。
- Mobile portraitとlandscapeの双方でhorizontal scrollがない。
- 3言語すべてでtitle、status、CTAが切れない。
- Language Selectorがviewport外へ出ない。
- PlayerとEPUBの優先度がgrayscale表示でも判別できる。
- Font load前後のlayout shiftが目立たない。

**Accessibility**

- KeyboardだけでSkip link、Language Selector、Player、GoRakuDo linkへ到達できる。
- Focus orderがDOMの読上げ順と一致する。
- NVDA + ChromiumでHome、Player、Coming Soon状態が意味の通る順に読まれる。
- 200% / 400% zoomを通過する。
- `prefers-reduced-motion`で不要なanimationが止まる。
- axeにcritical / serious issueがない。

**Performance**

- Production buildを対象にLighthouse mobileを3回実行し、中央値を記録する。
- Performance 90以上、Accessibility 95以上、Best Practices 95以上、SEO 95以上を目標gateとする。
- LCP 2.5秒以下、CLS 0.1以下を目標にする。
- Phase 0でclient framework runtimeを配信しない。
- First viewportの単一imageを200KB以下にし、不要なthird-party requestを0にする。
- Slow 4G profileでもloading indicatorが必要なほどHome操作を待たせない。

**SEO / security / release**

- Generated HTML内の初期`lang="id"`・canonical・OG・robotsを目視確認する。`hreflang`が出力されないことも確認する。
- Sitemapに準備中ページが混ざらない。
- CSP違反とmixed content errorがbrowser consoleにない。
- Security headersをstagingの実responseで確認する。
- 404、asset URL、trailing slashを本番同等環境で確認する。
- 公開後は本番URLをmobile Chromiumとdesktop Chromiumの両方からsmoke testする。

FirefoxはこのPhase 0の正式pass gateへ入れない。Chromium版の完了後に同じmatrixをFirefoxへ流し、差分を別Unitとして記録する。

## 21. Definition of Done

**Implementation Ready**

- [x] 本書の未決事項が解消され、YosiaがPhase 0実装を承認した。
- [x] Hosting先とpackage managerが決まった。
- [ ] Home copyの3言語draftが公開可能な文として承認された。
- [x] Wordmark / emblemの最初の方向が決まった。

**Implementation Complete**

- [x] `D:\GoRakudo_Projects\Entei`内だけでclean installとbuildが成功する。
- [x] Home URLは`/`だけであり、Indonesian / Japanese / Englishのcopyを画面内で切り替えられる。
- [x] Language Preferenceがversion付きで保存され、異常値から安全にfallbackする。
- [x] Player主導線が`/player/`の準備中ページへ繋がり、404にならない。
- [x] EPUB Readerが読める`Coming Soon`状態で、偽の操作を持たない。
- [x] GoRakuDoの実装済みpaletteと指定font rolesが反映されている。
- [ ] Mobile-first layoutが検証matrixの全Chromium viewportを通過した。
- [ ] Keyboard、screen reader、zoom、reduced motion、contrast確認を通過した。
- [x] SEO、social preview、sitemap、robots、security header案が揃った。
- [ ] Test・build・Lighthouse・axeの実測結果がImplementation Logへ残っている。
- [ ] Code reviewerの未解決findingが0件である。
- [x] Entei外のprojectに意図しない変更がない。

**Phase 0 Complete**

- [ ] Yosiaがpublishを明示承認した。
- [ ] `https://entei.gorakudo.org` が有効なHTTPSで公開されている。
- [ ] 本番でHomeの3言語切替、Player準備中、404、asset、Preferenceをsmoke testした。
- [ ] 本番responseのsecurity headersとcanonical URLを確認した。
- [ ] 公開したcommitと検証日時をImplementation Logへ記録した。

「画面ができた」はImplementation Complete、「ユーザーが安全に入口へ来られる」はPhase 0 Complete。鍵を渡す前の内覧と、実際に玄関を開ける作業を別のgateにする。

## 22. Risksとtrade-offs

| 論点             | 採用案                     | 得るもの                                      | 代償 / 対応                                                           |
| ---------------- | -------------------------- | --------------------------------------------- | --------------------------------------------------------------------- |
| 多言語表示       | 単一URL + client-side切替  | URLと構造を小さく保ち、Preferenceと自然に繋ぐ | 言語固定の共有・言語別SEO・JSなし切替は扱わない。初期HTMLはIndonesian |
| Preference       | localStorage               | Account不要で再訪を快適にする                 | Origin限定・削除可能。保存不能でも画面内切替は動かす                  |
| 初回言語         | Indonesian固定             | Main audienceを明確にする                     | Browser言語への自動最適化はしない。明示Selectorを常時見せる           |
| Player導線       | `/player/`準備中ページ     | Dead linkを避け、URLをPhase 1へ引継げる       | 未完成機能へ誘導するため、CTAをpreview表現にする                      |
| EPUB導線         | URLなし・非操作            | 誤認clickと空pageを避ける                     | Feature discoveryだけに留まり、詳細説明はできない                     |
| GoRakuDo palette | 値をsnapshot copy          | Entei単独buildとscope分離                     | 親palette更新は自動反映されない。意図した時だけdrift auditする        |
| Font             | 指定familyをself-host      | Brand consistencyとprivacy                    | Japanese font payloadが大きい。使用weightとnetwork waterfallを測る    |
| Framework        | Astro static、Vueは後置    | Phase 0 JSを小さくする                        | Phase 1でVue integration作業が発生するが、利用箇所と同時に検証できる  |
| Game feel        | Layout・type・statusで表現 | Fake scoreなしで世界観を作る                  | 派手さは控えめ。実イベント追加後にgamificationを拡張する              |
| Browser          | Chromiumを先に保証         | Test matrixを深く回せる                       | Firefox差分は後続Unitとして明示的に返済する                           |
| Security headers | Hosting responseで設定     | CSP等を正しい層で強制できる                   | Hosting先未決のため、具体設定は0.6までblockされる                     |

注意点として、`Media stays on your device` はLocal File中心のPhaseでは正しいが、将来EizouDendenshiのregular BitTorrentを追加するとpeer通信の説明が別途必要になる。EizouDendenshi Phaseへ入る時にprivacy copyを再レビューし、Phase 0の短い約束が広すぎないか確認する。browser WebTorrentはED-1で撤去済みであり、後継のWindows / Termux localhost companionは[EizouDendenshi](./EIZOU_DENDENSHI.md)を正とする。

現時点でPhase 0の技術実現性は約90%と見る。根拠は、元企画にstatic shellとclient-side機能の境界が既にあること、Astroが静的HTMLを中心にclient-side scriptを追加できること。残る10%は、hostingのsecurity header対応、保存locale切替時のちらつき、実font payload、実機contrast、3言語copyの自然さをまだ測っていない分。

## 23. Reviewで決める項目

| 優先                                 | 未決事項                   | 本書のdefault案                                                                                                                                                                                                                                                                                                           | 決める期限                     |
| ------------------------------------ | -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------ |
| Confirmed                            | Hosting / deploy先         | **GitHub Pages**（custom domain `entei.gorakudo.org`）。Yosiaが明示承認後にdeploy。deploy automation（GitHub Actions）は未導入                                                                                                                                                                                            | Unit 0.1前 → 解決済            |
| Confirmed                            | Package manager            | **npm** 11.15.0（GoRakuDoはbun使用中だが、PHASE0.md default案のnpmを採用）                                                                                                                                                                                                                                                | Unit 0.1前 → 解決済            |
| Confirmed                            | Astro major version        | **Astro 7.1.1**（2026-07-19時点のlatest stable）。GoRakuDoはAstro 5.13.0使用中だが、新規projectなので最新安定版でlock                                                                                                                                                                                                     | Unit 0.1前 → 解決済            |
| Confirmed                            | 多言語URL                  | Homeは`/`だけにし、languageは画面内で切り替える。`/ja/`と`/en/`は生成しない                                                                                                                                                                                                                                               | 決定済み                       |
| Confirmed                            | Player tileのPhase 0動作   | `/player/`の小さな準備中ページへ繋ぐ。`noindex,follow`。実装済み                                                                                                                                                                                                                                                          | Unit 0.4前 → 解決済            |
| Confirmed                            | Styling baseline           | **Plain CSS + Astro scoped styles**を採用。Tailwind v4と比較し、Phase 0は3ページ（Home, Player, 404）のみでutility classを大量使用しないため、依存最小のplain CSSが適切と判断。Design tokensの値自体はGoRakuDoと同一（snapshot copy）で視覚的一貫性を担保。Phase 1以降で必要になればTailwind導入可能                      | Unit 0.1前 → 解決済            |
| Confirmed                            | 保存localeの初期切替       | `<head>`内inline script（is:inline）でlocalStorage読込み、saved localeが`ja/en`の場合は`<html lang>`更新 + `data-entei-locale`設定 + `.entei-hydrating` class追加（body `visibility:hidden`）。module scriptがcopy更新後にclass削除。2秒safety timeoutでmodule script失敗時もbody表示。実機でのちらつき実測は手動確認必要 | Unit 0.3前 → 解決済            |
| Confirmed                            | 「NotoSansSreif JP」の意図 | 現在のdependencyにある`Noto Serif JP`として扱う。`@fontsource/noto-serif-jp@5.3.0`をinstall済み                                                                                                                                                                                                                           | Unit 0.2前 → 解決済            |
| Confirmed                            | Hub emblem                 | 1色SVG emblem（六角形 + 炎マーク）を作成。`public/brand/favicon.svg` + `public/brand/emblem.svg` + inline `HubEmblem.astro` component                                                                                                                                                                                     | Unit 0.4前 → 解決済            |
| Important                            | 3言語copy                  | Section 9をYosiaが自然な表現へ調整する。現在はdraft copyを実装に反映済み                                                                                                                                                                                                                                                  | Unit 0.4前 → Yosia review待ち  |
| Before publish                       | Footerのlegal links        | 実在するGoRakuDo側pageだけをlinkする。Phase 0ではGoRakuDo外部linkのみ配置、legal page linkは未配置                                                                                                                                                                                                                        | Unit 0.6前                     |
| Before publish                       | Security header設定方法    | Hostingのresponse headerで設定し、stagingで実測する。CSP `default-src 'self'`、`frame-ancestors 'none'`、`base-uri 'self'`、`object-src 'none'`を候補。GitHub Pagesではresponse header制御が限定的なため、`<meta>` tagでのCSPも検討                                                                                       | Unit 0.6前                     |
| ~~Before WebTorrent production release~~（ED-1で撤去） | `privacy.local` copy       | browser WebTorrentはED-1で撤去済みのため当該gateは解除。EizouDendenshi（ED-2+）導入時にloopback peer通信の説明を再レビューする                                                                                                                                                                                     | ED-1で解除                    |

Review時は各行のdefault案をそのまま承認するか、右側へ変更案を書けばよい。全部を同時に決める必要はなく、`決める期限`に達する前までに確定すれば作業を止めずに進められる。

## 24. Evidence map

| 種別                      | Source                                                           | この文書で確認した事実                                                           |
| ------------------------- | ---------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| Product vision            | `D:\GoRakudo_Projects\園庭プロジェクトの書き下ろし.md:3-12`      | Browser内で学習素材を作りAnkiへ送る自立型ツールという中心目的                    |
| Architecture              | 同`:598-767`                                                     | Astro shell、Vue island、local processing、layer分離の方向                       |
| Storage                   | 同`:134-143`                                                     | localStorage keyをversion付きにする方針                                          |
| Future gamification       | 同`:1153-1258`                                                   | Learning eventを先に作り、EXP等は後から載せる順序                                |
| Roadmap                   | 同`:1390-1523`                                                   | Player、Mining、Video Clipを段階化する後半roadmap                                |
| Security                  | 同`:1571-1583`                                                   | HTTPS、CSP、外部resource最小化の方針                                             |
| Visual direction          | `D:\GoRakuDo\DESIGN.md:25-45,635-651`                            | Dark / Editorial / Japanese-minimal方向と禁止事項。ただし文書冒頭ではdraft扱い   |
| Implemented palette       | `D:\GoRakuDo\src\styles\global.css:15-47`                        | 本番codeへ入るOKLCH token値                                                      |
| Implemented font roles    | 同`:244-273`                                                     | Gen Interface JP Display、Gen Interface JP、Noto Serif JP、Pixelify Sans aliases |
| Font imports              | `D:\GoRakuDo\src\styles\fonts.css:7-17`                          | Gen Interface JP、Noto Serif JP、Pixelify Sansがlocal packageから読み込まれる    |
| Dependencies              | `D:\GoRakuDo\package.json:30-46`                                 | Astro 5系、Tailwind CSS v4、font packagesを現在使用中                            |
| Existing locale semantics | `D:\GoRakuDo\src\layouts\BaseLayout.astro:70-97`                 | Default `id`とSEO componentへの`lang`受渡し                                      |
| Existing build style      | `D:\GoRakuDo\astro.config.mjs:12-17,49-102`                      | Static output、site URL、sitemap、Tailwind Vite pluginの実例                     |
| Astro i18n                | `https://docs.astro.build/en/guides/internationalization/`       | Locale prefix routingはAstroが提供する選択肢であり、Phase 0で採用しないこと      |
| Astro client script       | `https://docs.astro.build/en/guides/client-side-scripts/`        | Static HTMLへ小さなbrowser scriptを追加し、frameworkなしでDOM操作できること      |
| Web Storage               | `https://developer.mozilla.org/docs/Web/API/Window/localStorage` | localStorageがorigin単位で永続することと例外条件                                 |
| Accessibility             | `https://www.w3.org/TR/WCAG22/`                                  | Contrast、keyboard、reflow等のAA基準                                             |

優先順位は **現在動いているsource code → 公式仕様 → design document → 提案** とする。たとえば`DESIGN.md`と`global.css`の値が違う場合、Enteiへ「現在のメインサイトと同じ色」を持ってくる目的では`global.css`を採る。Menu表と実際の料理が違う時、今食べている味へ合わせる考え方。

Line番号は2026-07-19時点のsnapshot。参照元が更新された時は、行番号だけでなくtoken名・component名・実値でも再照合する。

## 25. Implementation gateとlog

**現在のgate：`IMPLEMENTATION COMPLETE`**

- 許可済み：`Entei/docs/PHASE0.md`の作成・レビュー対応 + Phase 0 application code実装。code-reviewer reviewは完了し、最終判定は`APPROVE`。
- 実施済み：Yosia承認済みの初回source commit / push（`8f54861`）。
- 未許可：追加のgit commit / push、PR作成、DNS設定、deploy本番。
- 次の状態：Yosiaがpublishを明示承認し、本番deploy + smoke testを終えた時に`PHASE 0 COMPLETE`へ変更する。

Implementation Logには、意図や予定ではなく実際に完了したことだけを書く。Commandは全文dumpではなく、実行command・終了code・重要なsummary・artifact pathを残す。

| Date       | Unit | 実際の変更                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | Verification evidence                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | Review                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | Commit / Deploy                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| ---------- | ---- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 2026-07-19 | 0.0  | `Entei/docs/PHASE0.md`を新規作成                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | 企画書、GoRakuDo code、公式仕様を照合。Application実装・testは未実施                                                                                                                                                                                                                                                                                                                                                                                                                          | code-reviewer APPROVE（focus-visible行番号、copyの現在形、色照合記述、WebTorrent gate、Tailwind判定、wordmark fallbackの6点を確認・修正済み。アプリケーション実装・testは未実施）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | なし                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| 2026-07-19 | 0.0  | Home多言語設計をlocale別URLから単一URLのclient-side切替へ更新                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | Astro公式i18n / client-side script仕様、旧route要件の残存検索、reviewer再確認。Application実装・testは未実施                                                                                                                                                                                                                                                                                                                                                                                  | 単一URL client-side多言語設計のdocument review完了。最終stale表記「3言語ルート」→「3言語表示」修正確認済み。Application実装・testは未実施。                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | なし                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| 2026-07-19 | 0.1  | Project scaffold作成：root workspace + `apps/web` 構造、npm 11.15.0、Astro 7.1.1 + `@astrojs/sitemap` 3.7.3 + `@astrojs/check` 0.9.9 + TypeScript 6.0.3、font packages（gen-interface-jp 0.8.0, @fontsource/pixelify-sans 5.3.0, @fontsource/noto-serif-jp 5.3.0）、Vitest 4.1.10 + jsdom 29.1.1。`astro.config.mjs` site=`https://entei.gorakudo.org`, output=static, base=unset（custom domain対象）, sitemap filterでHomeのみindex                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | `npm install` → exit 0（362 packages, 0 vulnerabilities）。空build成功（3 routes: `/`, `/player/`, `/404.html`）                                                                                                                                                                                                                                                                                                                                                                              | 未実施（Yosia別途review）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | なし                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| 2026-07-19 | 0.2  | Design foundation実装：`src/styles/tokens.css`（GoRakuDo global.css:15-47 の9 tokenをsnapshot copy、参照元comment付き）、`src/styles/fonts.css`（self-hosted: Gen Interface JP 400/600, Gen Interface JP Display 700, Pixelify Sans 400/700, Noto Serif JP 400。外部Fluent Emoji importは除外）、`src/styles/global.css`（reset, FOUC prevention `html.entei-hydrating body { visibility: hidden }`, focus-visible, skip link, reduced-motion, high-contrast, forced-colors）。Fluent Emoji外部font importは持ち込まず（PHASE0.md 16.409）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | `astro check` → exit 0（0 errors, 0 warnings, 0 hints）。build成功。CSS内に外部HTTP参照なし（SVG名前空間data URIのみ）                                                                                                                                                                                                                                                                                                                                                                        | 未実施（Yosia別途review）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | なし                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| 2026-07-19 | 0.3  | i18n foundation実装：`src/i18n/types.ts`（Locale = `'id'                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | 'ja'                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | 'en'`, LocalePreference { schemaVersion: 1, locale }）、`src/i18n/locales/{id,ja,en}.ts` typed dictionaries（key set同一性test検証済み）、`src/i18n/index.ts`（isLocale type guard, getDictionary, getMetadata, dictionaries, documentMetadata）、`src/i18n/preferences.ts`（readPreference, validatePreference, writePreference, getSavedLocale — 全例外捕捉、localStorage不可用時もsafe fallback）、`src/scripts/locale-switcher.ts`（module script: applyLocale, switchLocale, revealPage, pageshow event for bfcache）。FOUC回避: `<head>` inline script でlocalStorage読込み、saved locale非idの場合は`<html lang>`更新 + `.entei-hydrating` class追加（body hidden）。module scriptがcopy更新後にclass削除。2秒safety timeoutでmodule script失敗時もbody表示 | `npm run test` → exit 0（37 tests, 2 test files passed）。test内容: Locale type guard（3値のみ許可）、LOCALE_LABELS、PREFERENCES_KEY、PREFERENCES_SCHEMA_VERSION、dictionary key parity（3言語同一key set）、validatePreference（有効/無効locale、schemaVersion、非object値）、readPreference（empty, corrupted JSON, unknown locale, old schema, valid ja/en/id）、getSavedLocale（default fallback, corrupted, saved locale, unknown locale fallback）、writePreference（round-trip, overwrite, schemaVersion 1）、localStorage不可用時のfallback（3 test）。build成功、生成HTMLで`<html lang="id">`確認 | 未実施（Yosia別途review）。ちらつき実測は手動確認必要 | なし |
| 2026-07-19 | 0.4  | Home Hub UI実装：`src/components/home/TopBar.astro`（wordmark live text + HubEmblem inline SVG, Language Selector always visible, sticky top bar with backdrop-blur）、`src/components/home/HubIdentity.astro`（system label Pixelify Sans, h1 Gen Interface JP Display clamp(2.5rem→5.5rem), lead text, gradient background depth）、`src/components/home/DestinationDock.astro`（Player tile: full `<a>` to `/player/`, elevated surface-2, purple accent, arrow, hover lift — EPUB Reader: `aria-disabled="true"` + `inert`, no link/click/cursor change, gold accent lock icon + "Coming Soon" text, NOT low opacity — 3:2 asymmetric grid at 768px+, NOT three equal cards）、`src/components/home/LocalFirstNote.astro`（short privacy reassurance）、`src/components/home/SiteFooter.astro`（GoRakuDo external link, copyright, no legal page links yet）、`src/components/LanguageSelector.astro`（native `<select>`, 3 options in own names, visible label, 44px min touch target, no flags, no custom popup）、`src/components/icons/HubEmblem.astro` + `PlayerIcon.astro` + `ReaderIcon.astro`（inline SVG, aria-hidden, no emoji）、`src/layouts/BaseLayout.astro`（landmarks header/main/footer, skip link first in DOM, single h1 enforced by page structure, focus-visible, FOUC inline script in `<head>`）                           | `astro check` → 0 errors。build成功。生成HTML確認: skip link present, landmarks correct, Language Selector with native names, Player link to `/player/`, EPUB `aria-disabled="true" inert`、module script at end of body                                                                                                                                                                                                                                                                      | 未実施（Yosia別途review）。mobile/desktop実画面review, keyboard操作, screen reader読上げ確認は手動必要                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | なし                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| 2026-07-19 | 0.5  | Destination states実装：`src/pages/player/index.astro`（`/player/` noindex, Indonesian initial, locale switcher shared with Home, small ready-state page with Home link, no fake progress/waitlist）、`src/pages/404.astro`（Indonesian only, noindex, no locale switcher, simpler layout, Home link, JS-disabled usable）。Dead linkなし、EPUBは`inert` + `aria-disabled`で偽click防止                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | `astro check` → 0 errors。build成功。生成HTML確認: `/player/index.html` `noindex,follow` + canonical `https://entei.gorakudo.org/player/`、`/404.html` `noindex,follow` + Indonesian title "Halaman tidak ditemukan"                                                                                                                                                                                                                                                                          | 未実施（Yosia別途review）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | なし                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| 2026-07-19 | 0.6  | Public metadata実装：`src/components/SeoHead.astro`（canonical always `https://entei.gorakudo.org/` for Home, noindex for /player/ and 404, OG/Twitter Card, WebSite structured data — no SoftwareApplication claim, theme-color #0d0d12 matches page bg）、`public/brand/favicon.svg` + `public/brand/emblem.svg`（1-color SVG emblem, works on light/dark bg）、`public/og/og-image.svg`（1200×630 language-neutral, emblem + gradient only, no text in image）、`public/robots.txt`（Allow /, Disallow /player/, Sitemap URL）、`public/CNAME`（`entei.gorakudo.org`）、`@astrojs/sitemap` filter for Home only。`site`=`https://entei.gorakudo.org`, `base`=unset（custom domain）。GitHub Pages deploy automation（GitHub Actions）は未導入                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | build成功。生成HTML確認: Home `index,follow` + canonical `https://entei.gorakudo.org/` + OG locale `id_ID` + no hreflang。Player `noindex,follow`。404 `noindex,follow`。`sitemap-0.xml` にHome `/` のみ記載、`/player/` は除外。OG image URL絶対パス確認                                                                                                                                                                                                                                     | 未実施（Yosia別途review）。OG image SVG → PNG/WebP raster変換は pre-deploy TODO。Security header staging実測は pre-deploy TODO                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | なし                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| 2026-07-19 | 0.7  | Quality gate実行：format check, test, astro check, build 全て成功。Lighthouse / axe / 手動accessibility / browser viewport matrix は未実施（browser環境が必要なため）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | `npm run format:check` → exit 0（All matched files use Prettier code style）。`npm run test` → exit 0（37 tests passed, 2 test files）。`npm run check` → exit 0（0 errors, 0 warnings, 0 hints, 23 files）。`npm run build` → exit 0（3 pages built in 3.91s, sitemap-index.xml created）。JS bundle: 4.9KB（tiny client script, PHASE0.md 12要件満たす）。CSS: 403.8KB（font @font-face宣言多数、実際のwoff2 fileはbrowserが遅延load）。HTML: 20.6KB（3 pages合計）                         | 未実施（Yosia別途review）。Lighthouse mobile 3回中央値、axe critical/serious issue 0、NVDA + Chromium読上げ、200%/400% zoom、Chromium全viewport matrix（320/360/390/768/1024/1280/1440）、`prefers-reduced-motion`確認は手動必要                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | なし                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| 2026-07-20 | 0.7  | code-reviewer REQUEST_CHANGES 対応（P1×4 + P2×6）。P1: (1) LanguageSelector chevron data-URI SVG strokeを`%23c8beda`へ修正（invalid OKLCH encoding排除）。(2) DestinationDock EPUB Readerから`inert`削除、`aria-disabled="true"`のみで非interactive維持、重複sr-only text削除。(3) locale-switcher pageshow handlerが`getCurrentLocale()`（dataset削除後に`id`へfallback）を使うbug修正→`getSavedLocale()`へ変更でsaved JA/ENがbfcache復帰時にIndonesianへrevertしない。(4) global.css bodyへ`display:flex; flex-direction:column`追加でsticky footer動作。P2: (5) DestinationDock/LocalFirstNote/404からhardcoded English aria-label削除。(6) LanguageSelector `aria-label`削除、`<label for>`のみでaccessible name、labelに`data-i18n`追加で動的更新。(7) 404からcanonical link削除（noindex page）。(8) Noto Serif JP import/token/dependency削除（Phase 0未使用、YAGNI）。`@fontsource/noto-serif-jp` uninstall実施。(9) tokens.css unconditional `forced-color-adjust:none`削除、media query内`auto`のみ残存。(10) `tests/locale-switcher.test.ts`新規追加：resolveKey（7 test）、applyLocale DOM更新（6 test）、switchLocale persistence（3 test）、persisted pageshow JA/EN復帰（4 test）。locale-switcher.tsの`applyLocale`/`switchLocale`/`resolveKey`をexport化。PHASE0.md Section 11 typography table更新（Noto Serif JP → Phase 0未使用） | `npm run format:check` → exit 0（All matched files use Prettier code style）。`npm run test` → exit 0（57 tests passed, 3 test files）。`npm run check` → exit 0（0 errors, 0 warnings, 0 hints, 24 files）。`npm run build` → exit 0（3 pages built in 3.57s, sitemap-index.xml created）。生成HTML検証: 404 canonicalなし、Home `inert`なし、reader `aria-disabled="true"`のみ、chevron stroke `%23c8beda`確認、English aria-label 0件、LanguageSelector `aria-label`なし `<label for>`のみ | 未実施（Yosia別途re-review）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | なし                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| 2026-07-20 | 0.7  | reviewer最終P2対応：TopBar wordmarkのhardcoded English `aria-label`削除、READMEのNoto Serif JP記述を実装済みfontへ更新。                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | 再実行：`npm run format:check` → exit 0、`npm run test` → exit 0（57 tests / 3 files）、`npm run check` → exit 0（0 errors / warnings / hints、24 files）、`npm run build` → exit 0（3 pages built、sitemap生成）。                                                                                                                                                                                                                                                                           | code-reviewer APPROVE（P0/P1/P2 0件）。手動Chromium QAは未実施。                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | なし                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| 2026-07-20 | 0.4  | Mobile Hero spacingを`32px / 24px`へ縮小し、`768px`以上のみ従来の`64px / 48px`へ戻した。H1を翻訳対象から外し、全localeで`lang="ja"`付き固定`園庭`をNoto Serif JPで表示する形へ変更。未使用になった`hub.title`を型・3辞書から削除し、`@fontsource/noto-serif-jp`を再install。                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | `npm run format:check` → exit 0。`npm run test` → exit 0（57 tests / 3 files）。`npm run check` → exit 0（0 errors / warnings / hints、24 files）。`npm run build` → exit 0（3 pages built、sitemap生成）。生成Homeに固定`園庭`、`lang="ja"`、Noto Serif token/importを確認。                                                                                                                                                                                                                 | code-reviewer APPROVE。P2の設計書表記（固定H1はDictionary外、Display fontはHub H1を除く）も修正済み。                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | なし                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| 2026-07-20 | 0.4  | DesktopのLocal-first noteを、2列gridの左下から2列をまたぐfooter直前の中央へ移動。mobileはDestination Dock直後の自然な文書順を維持。                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | `npm run format:check` → exit 0。`npm run test` → exit 0（57 tests / 3 files）。`npm run check` → exit 0（0 errors / warnings / hints、24 files）。`npm run build` → exit 0（3 pages built、sitemap生成）。生成CSSに`.entei-home-local-note`のdesktop grid selectorを確認。                                                                                                                                                                                                                   | code-reviewer APPROVE。手動Chromiumでの実位置確認は未実施。                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | なし                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| 2026-07-20 | 0.7  | Entei sourceをGitHub `GoRakuDo/entei` の`main`へ初回push。remoteの既存MPL-2.0 LICENSEを維持し、`.codesight/`などのlocal生成物は`.gitignore`で除外。                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | commit `8f54861` (`Implement Phase 0 home hub`) を`origin/main`へpush。post-pushで`HEAD`と`origin/main`が同一SHAであることを確認。`.github/workflows`は存在しないためdeploy workflowなし。                                                                                                                                                                                                                                                                                                    | pre-commit reviewer APPROVE。deployは未実施。                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | `8f54861` / `https://github.com/GoRakuDo/entei`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| 2026-07-20 | 0.4  | UI iconを`@lucide/astro`へ移行：HubEmblem→Flame、PlayerIcon→AudioLines、ReaderIcon→BookMarked、inline Player arrow→ArrowRight、LanguageSelector chevron→ChevronDown。DestinationDock layoutをfull-width vertical stackに変更（768px+の3:2 gridを廃止）。PlayerとEPUBは同じfull-width rectangular shapeで縦積み、色・border・内容の差で主従を示す。`@lucide/astro` 1.25.0を`apps/web`へinstall                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | `npm install @lucide/astro --workspace=web` → added 1 package, 0 vulnerabilities。`npm run format:check` → exit 0（All matched files use Prettier code style）。`npm run test` → exit 0（57 tests / 3 files）。`npm run check` → exit 0（0 errors, 0 warnings, 0 hints）。`npm run build` → exit 0（3 pages built in 5.55s, sitemap-index.xml created）。生成HTML確認: Lucide icons inlined in output, no inline SVG data URIs for icons                                                      | 未実施（Yosia別途review）。手動Chromium QAは未実施                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | なし                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| 2026-07-20 | 0.4  | DestinationDock UI correction: tall vertical cards → compact horizontal row layout. CSS Grid row interior `[Icon] [Text column] [Arrow slot]` replaces column-stacked content. Reduced padding (`space-16/space-24` from `space-24/space-32`). Removed `.entei-destination-head` wrapper; icon is a direct grid child. Reader card uses `.entei-destination-content` div with matching grid for equal outer geometry. EPUB non-interactive constraints preserved: no `<a>`/`<button>`, `aria-disabled="true"`, `cursor: default` on all children, no hover lift, "Coming Soon" text visible. Hover lift moved from article to link element to avoid lifting the inert EPUB card.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | `npm run format:check` → exit 0。`npm run test` → exit 0（57 tests / 3 files）。`npm run check` → exit 0（0 errors, 0 warnings, 0 hints, 24 files）。`npm run build` → exit 0（3 pages built in 6.78s, sitemap-index.xml created）。                                                                                                                                                                                                                                                          | 未実施（Yosia別途review）。手動Chromium QAは未実施                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | なし                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| 2026-07-20 | 0.4  | Equal-height fix: added `grid-auto-rows: 1fr` to `.entei-destinations` and `height: 100%` to `.entei-destination`, `.entei-destination-link`, `.entei-destination-content`. Previous row heights were unequal (Player ~164px, EPUB ~116px) because grid children did not stretch to fill the `1fr` row. The `1fr` row height is now enforced, and `height: 100%` on each level propagates it to the visible background/border containers.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | `npm run format:check` → exit 0（All matched files use Prettier code style）。`npm run test` → exit 0（57 tests / 3 files）。`npm run check` → exit 0（0 errors, 0 warnings, 0 hints, 24 files）。`npm run build` → exit 0（3 pages built in 5.57s, sitemap-index.xml created）。                                                                                                                                                                                                             | 未実施（Yosia別途review）。手動Chromium QA（row height一致確認）は未実施                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | なし                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |

| 2026-07-20 | 0.6 | Yosia提供の`E:\Libraries\Documents\logo_black.svg`を正式brand assetとして`public/brand/favicon.svg`と`public/brand/emblem.svg`へ反映。Top BarのHubEmblemもLucide Flameからbrand emblemへ置換。各pathの明示black fillがroot fillを上書きするため、両SVG内へ`path { fill: #f5f5f7 !important; }`を追加し、dark UIとbrowser chromeで明るく表示する。`viewBox="0 0 2048 2048"`も追加。Player / Reader / Arrow / Select chevronのLucide iconは維持し、OG WebP/PNGはYosia提供待ちのまま。 | source fileの存在とbrand asset directoryを確認後、2ファイルへ同一sourceをコピー。`npm run format:check` → exit 0。`npm run test` → exit 0（57 tests / 3 files）。`npm run check` → exit 0（0 errors / warnings / hints、24 files）。`npm run build` → exit 0（3 pages built、sitemap生成）。 | code-reviewer APPROVE。dark/light browser chrome上のfavicon視認性は手動QAで確認。 | `e3f685f` |
| 2026-07-20 | 0.7 | Color-format normalization: all shipped runtime color values normalized to OKLCH. Changes: (1) `public/og/og-image.svg` — converted `#ffffff`→`oklch(95% 0.005 285deg)`, `#7a4ee5`→`oklch(57.74% 0.209 273.85deg)`, `#0d0d12`→`oklch(5% 0.005 270deg)`. (2) `public/brand/favicon.svg` + `public/brand/emblem.svg` — converted internal style `#f5f5f7`→`oklch(95% 0.005 285deg) !important`, converted all path `fill="#000000"`→`fill="oklch(5% 0.005 270deg)"` (8 path attributes across 2 files). (3) `src/components/SeoHead.astro` — `theme-color` `#0d0d12`→`oklch(5% 0.005 270deg)`, mask-icon `color="#7a4ee5"`→`oklch(57.74% 0.209 273.85deg)`. (4) `src/pages/404.astro` — `theme-color` `#0d0d12`→`oklch(5% 0.005 270deg)`. Post-edit grep confirmed zero hex/rgb/rgba/hsl/hsla color values in shipped `apps/web/src` and `apps/web/public` (excluding non-color false positives like `white-space`, CSS system colors, `transparent`, URLs, hashes). | `grep "#[0-9a-fA-F]{3,8}" -g *.astro -g *.css -g *.svg -g *.ts -g *.js -g *.html apps/web/src apps/web/public` → no output (zero matches). `grep "rgba?\(\|hsla?\("` same scope → no output. `npm run format:check` → exit 0（Prettier reformatted SeoHead.astro）. `npm run test` → exit 0（57 tests passed, 3 test files）. `npm run check` → exit 0（0 errors, 0 warnings, 0 hints, 24 files）. `npm run build` → exit 0（3 pages built in 7.53s, sitemap-index.xml created）。Manual visual QA (OKLCH rendering in Chromium dark/light chrome, OG image color accuracy, favicon visibility) remains pending。 | code-reviewer APPROVE。手動Chromium QAは未実施 | `e3f685f` |
| 2026-07-20 | 0.8 | Yosia手動Chromium QA完了。操作・accessibility、Homeのresponsive visual、Header brand logo / faviconを確認済み。 | Yosia確認：すべてOK。 | Yosia確認済み。コード変更なし。 | `e3f685f` |
| 2026-07-30 | navigation design | 共通navigation設計を[`NAVIGATION_BAR.md`](./NAVIGATION_BAR.md)へ新設・更新。desktopは常設buttonなし、Home / TrackerのTop Bar hover / keyboard focus時だけpill navigationを出し、Playerではdestination navigationを出さない。mobileはHome / Player / Trackerのfloating Dockを使う。TrackerをHome Destination Dockへ複製しない境界、Player short-height landscape / fullscreenでDockを隠す契約を固定。 | 現行`TopBar.astro`、`BaseLayout.astro`、`PlayerLayout.astro`、Player landscape契約を照合。アプリケーション実装・testは未実施。 | document review待ち。 |

今後の追記template：

```md
| YYYY-MM-DD | 0.x | 変更した範囲 | `command` → exit 0 / 実機結果 | APPROVE または修正内容 | SHA / URL / なし |
```

Testをまだ実行していない時は`未実施`と書き、成功したように埋めない。Deployしていない時はproduction URLを結果欄へ書かない。

## 26. Yosia review guide

最初は次の順で見ると判断しやすい。

1. **Section 1–5**：Phase 0の範囲と、単一URLの言語切替が意図どおりか。
2. **Section 6–9**：Homeの入口、Player、EPUB、3言語copyが意図どおりか。
3. **Section 10–13**：色、font、responsive、motionの方向がGoRakuDoらしいか。
4. **Section 17–20**：技術構成、作業順、検証量が重すぎたり軽すぎたりしないか。
5. **Section 23**：未決事項のdefault案を採用するか。

特に確認してほしい5点：

- [x] Player tileはPhase 0でも押せて、準備中ページへ進む形でよい。
- [x] Home URLは`/`だけにし、保存localeも同じ画面内で復元する。
- [x] Font名は`Noto Serif JP`でよい。
- [ ] Section 9のBahasa Indonesia / 日本語 / English copyは、公開前に改善する。
- [x] Game hubは、Yosia提供のbrand SVGとCSS背景で開始する。

copy以外のPhase 0実装・手動QAは完了。公開前にcopyとOG WebP/PNGを確定し、Yosiaがpublishを承認した後にdeployへ進む。

## 開発記録（2026-08-07）: Astro 7.2 更新 + incrementalBuild 有効化

- `apps/web/package.json` の astro を **`^7.1.1` → `^7.2.0`** へ更新（npm install astro@latest）。
- `astro.config.mjs` に **`experimental: { incrementalBuild: true }`** を追加（Astro 7.2 の experimental incremental static builds: コード/データが変わらない prerender ページの再生成をスキップ）。
- **現時点での効果**: Entei は全ルート静的（`/` `/player/` `/tracker/` `/404`）で `getStaticPaths` を使わないため **cacheKey が無い＝従来どおり常にレンダー**（挙動変化なし・有効化のみ）。
- **将来**: `getStaticPaths` を使うルートで `cacheKey`（例: content collection の `entry.digest`）を返すと、該当ページだけの差分再レンダーでビルド高速化可能。キャッシュは `node_modules/.astro/`（CI が永続化すれば再利用可）。
- experimental フラグは Astro minor 更新で名前変更/削除の可能性 → その時は config の該当行を除去。
- 検証: `npm run build`（4ページ・約8.6s）、`npm test` 1453、`astro check` 0/0/0 通過。
