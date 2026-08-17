# DenChou Scenes — 自動固定wrapper

> **状態:** 実装済み。code-side自動wrapper / export payload wrapping / tests済み。
> **対象:** Anki note typeが正確に`DenChou`の時だけ使う、採掘scene用のHTML wrapper。

---

## 1. 人間語でいうと

DenChouの1枚のcardへ複数sceneを足す時、各sceneを`<span class="group">…</span>`で自動的に包む仕組み。

```html
<span class="group">最初のscene</span>
<span class="group">次のscene</span>
```

**設定UIはない。** wrapperはcode-sideで固定。ユーザーがHTMLを定義する必要はない。
古いHTMLを包み直さない。新しく採掘したsceneだけを包んで、既存内容の末尾へ追加する。

## 2. 適用範囲

| 条件 | 動作 |
| --- | --- |
| selected Note type = `DenChou` | sentence/sourceを自動wrap |
| それ以外のNote type | 現在のraw export / `<br>` appendを維持 |
| `sentence` | `<span class="group">${value}</span>` |
| `source` → physical `miscInfo` | `<span class="group">${value}</span>` |
| definition / image / audio / word / tags | wrapper対象外（`<br>` append維持） |
| `sentenceFurigana` | 将来予約。field、生成、UI、storageはまだ作らない |

根拠は`apps/web/src/components/player/PlayerApp.tsx:3393-3402`（New mode）と`3745-3768`（Append mode）。

## 3. export契約

### 3.1 New note

DenChouの`sentence` / `source` mapping先fieldに自動wrapされた値を`addNote`する。

```text
<span class="group">${field value}</span>
```

### 3.2 Update latest

現在のlatest updateは置換契約のまま。scene appendには使わない。wrapperなし。

### 3.3 Append to existing cards

DenChouの`sentence` / `source`のみ、`<br>`なしでwrapped incomingを既存HTMLの末尾へ追加する。
それ以外のfield（image / audio / definition等）は従来通り`<br>` separatorを維持。

```text
existing HTML + wrapped incoming scene  (DenChou sentence/source only)
existing <br> incoming                 (DenChou definition/image/audio + すべての非DenChou)
```

DenChouは`.group`側がsceneのレイアウトを管理するため、自動の`<br>` separatorを追加しない。
通常note typeは今の`existing<br>incoming` appendを維持する。

## 4. 実装詳細

| ファイル | 役割 |
| --- | --- |
| `src/features/player/denchou-scene.ts` | 固定wrapper関数: `wrapDenChouField()`, `isDenChouActiveTarget()`, `isDenChouWrapTarget()` |
| `src/components/player/PlayerApp.tsx` | New mode (1428-1438): wrap適用。Append mode (1735-1751): per-field separator |
| `tests/denchou-scene.test.ts` | wrapper関数 + payload構築の単体テスト |

## 5. 非対象

- 複数profile / named preset
- DenChou以外の任意note typeへのwrapper
- Settings UI / configurable HTML（以前実装済みだが削除済み — 自動固定wrapperに移行）
- `sentenceFurigana`のfield mapping・furigana生成
- Mining History
- Video Clip

## 6. 実装gate

1. DenChou新規cardで`sentence`と`miscInfo`が各`<span class="group">`で描画される
2. 同じcardへ2 sceneをappendしても、nested wrapperや二重separatorが出ない
3. 通常note typeはraw export / `<br>` appendのまま変わらない
4. EnteiのMining Previewはcustom HTMLを実行せず、escapeした文字列として扱う
5. test用DenChou cardをAnki上で確認する

## 7. 将来候補: DenChou Word Highlight（deferred）

> **状態:** 設計のみ。現在は実装しない。
> **理由:** `思う`から`思わず`、`思って`、`思った`、`思っちゃう`のような活用形を正しく拾うには、日本語の形態素解析または検証済みのdeinflectionが必要になる。単純な部分一致では別語まで誤highlightする。

### 7.1 目標

DenChouの`sentence`をAnkiへ送る直前に、対象語に対応する字幕surfaceだけをinner HTMLで包む。既存のouter group wrapperの内側に入る。

```html
<span class="group">
  もう来ると<span class="highlight">思う</span>んでまずは生3つで。
</span>
```

```html
<span class="group">
  ただじーっと僕を見つめるあの瞳には<span class="highlight">思わず</span>引き込まれそうになってね。
</span>
```

EnteiのReact UIへHTMLを注入しない。plain textのMining Previewを維持し、HTML生成はAnki payload直前だけに閉じる。

### 7.2 3つの対象別input

| 送信mode | highlightの語彙source | 必要な処理 |
| --- | --- | --- |
| New Card | Mining Previewで入力されたsemantic `word` field | wordをtargetとして字幕の活用surfaceを探す |
| Update latest | `findNotes('added:1')` → `notesInfo`で得た最新DenChou cardの`word` / `reading` field | card由来のword/readingをtargetとして字幕を解析する |
| Append existing | 選択cardごとに`notesInfo`で得た各DenChou cardの`word` / `reading` field | cardごとに異なるtargetでincoming sceneを生成する |

`reading`は現在のAnki field mappingに存在しないため、実装開始時にDenChouのphysical field名`reading`を実カードで再確認する。`sentenceFurigana`は引き続き別の将来scopeであり、このfeatureでは生成しない。

### 7.3 必須pipeline

```text
target word + reading
  → 日本語tokenizer / deinflectionで字幕をtoken化
  → tokenのlemma・readingをtargetと照合
  → 一致したsurfaceだけをHTML escapeした上で
    <span class="highlight">surface</span>に置換
  → outer <span class="group">…</span>を付けてAnkiへ明示送信
```

- exact substringだけの実装は採用しない。`思い出`など別語への誤highlightを避ける。
- `word`または`reading`が空・解析不能ならhighlightなしで通常のDenChou group wrapperを送る。
- range refreshやSentence手編集でtextが変わった時は、古いmatch offsetを使い回さずexport時に再解析する。
- 既存cardのHTMLは再解析・再wrapしない。Appendではincoming sceneだけを生成する。
- image/audio/source以外のfieldへhighlight classを入れない。

### 7.4 実装前gate

1. browser-onlyで動く日本語tokenizer / deinflectionのbundle size、license、offline可否を比較する
2. `word` / `reading` physical fieldを持つ実DenChou cardで`notesInfo` responseを確認する
3. `思う`、`思わず`、`思って`、`思った`、`思っちゃう`のpositive fixtureを作る
4. `思い出`などlemmaが違うnegative fixtureを作る
5. New / latest update / appendでcardごとのhighlight targetが混ざらないことを確認する
6. Yomitan、furigana生成、dictionary popupはこのscopeへ混ぜない

## 8. 関連文書

- 採掘とAnki送信の現在契約: [ANKI_MINER.md](./ANKI_MINER.md)
- Player全体の段階計画: [PLAYER_PHASES.md](./PLAYER_PHASES.md)
