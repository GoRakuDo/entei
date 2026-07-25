# DenChou Scenes — scene wrapper設計

> **状態:** 設計承認済み・未実装。
> **対象:** Anki note typeが正確に`DenChou`の時だけ使う、採掘scene用のHTML wrapper。

---

## 1. 人間語でいうと

DenChouの1枚のcardへ複数sceneを足す時、各sceneを個別のHTML groupで包む仕組み。

```html
<span class="group">最初のscene</span>
<span class="group">次のscene</span>
```

古いHTMLを包み直さない。新しく採掘したsceneだけを包んで、既存内容の末尾へ追加する。

## 2. 適用範囲

| 条件 | 動作 |
| --- | --- |
| selected Note type = `DenChou` | scene wrapperを使える |
| それ以外のNote type | 現在のraw export / `<br>` appendを維持 |
| `sentence` | 最初にwrapper対象にする |
| `source` → physical `miscInfo` | 最初にwrapper対象にする |
| `sentenceFurigana` | 将来予約。field、生成、UI、storageはまだ作らない |

現在の採掘payloadはsemantic `sentence`と`source`をphysical fieldへmappingする。`source`をDenChouの`miscInfo`へmappingすれば、作品名・話数・時刻をscene単位で包める。根拠は`apps/web/src/components/player/PlayerApp.tsx:490-529`。

## 3. 将来のexport契約

### 3.1 New note

mapping済みの`sentence` / `source`それぞれに、対応するwrapperを適用して`addNote`する。

```text
beforeHtml + field value + afterHtml
```

### 3.2 Update latest

現在のlatest updateは置換契約のまま。scene appendには使わない。

### 3.3 Append to existing cards

選択したcardごとに、新しいsceneだけをwrapper化して追記する。

```text
existing HTML + wrapped incoming scene
```

DenChouは`.group`側がsceneのレイアウトを管理するため、自動の`<br>` separatorを追加しない。通常note typeは今の`existing<br>incoming` appendを維持する。

## 4. 将来のSettings案

複数profileにはしない。Anki Fieldsで`DenChou`を選んだ時だけ、次の欄を表示する。

```ts
type DenChouSceneWrappers = {
  sentence?: { beforeHtml: string; afterHtml: string };
  source?: { beforeHtml: string; afterHtml: string };
};
```

- wrapperはsemantic keyで保存し、physical field名は既存mappingから解決する
- `beforeHtml` / `afterHtml`は空または上限以内のstringだけを許可する
- 意図したAnki HTMLを勝手にsanitize・書き換えしない
- previewでは`dangerouslySetInnerHTML`を使わず、wrapper文字列をescapeして表示する
- wrapperを含む値は明示した`Ankiへ送信`時だけlocalhost AnkiConnectへ送る

## 5. 非対象

- 複数profile / named preset
- DenChou以外の任意note typeへのwrapper
- `sentenceFurigana`のfield mapping・furigana生成
- Mining History
- Video Clip

## 6. 実装gate

1. DenChou新規cardで`sentence`と`miscInfo`が各group HTMLで描画される
2. 同じcardへ2 sceneをappendしても、nested wrapperや二重separatorが出ない
3. 通常note typeはraw export / `<br>` appendのまま変わらない
4. EnteiのMining Previewはcustom HTMLを実行せず、escapeした文字列として扱う
5. test用DenChou cardをAnki上で確認する

## 7. 関連文書

- 採掘とAnki送信の現在契約: [ANKI_MINER.md](./ANKI_MINER.md)
- Player全体の段階計画: [PLAYER_PHASES.md](./PLAYER_PHASES.md)
