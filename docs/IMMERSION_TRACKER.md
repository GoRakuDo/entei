# IMMERSION_TRACKER — local-first 視聴・没入記録の設計

> **状態:** DRAFT — 未実装。P6 Statisticsの土台として仕様だけを固定する。
> **対象:** `Entei/apps/web` の `/player/` React island。browser内のlocal media / WebTorrent mediaを対象にし、Home・AnkiConnect・外部serverは対象外。
> **決定日:** 2026-07-30

---

## 1. 人間語でいうIMMERSION_TRACKER

IMMERSION_TRACKERは、学習者が「どれだけ再生したか」だけでなく、**何を、どんな再生方法で、どの地点を見直しているか**を自分で振り返るためのlocal-first記録である。

これは監視、ランキング、連続視聴の強要、第三者への分析送信のための機能ではない。自分の学習時間とreview hotspotを理解するための個人用ノートである。RightPanelのHistoryは、このTrackerに属する軽い「最近の採掘」listとして残す。

```text
mediaを再生
  → 実際に再生していた時間とmedia timelineの進行をbrowser内で測る
  → speed / play mode / cue区間 / seekを別々に分類する
  → media別・日別・30秒単位の集計だけをIndexedDBへ保存する
  → RightPanelには最近の採掘だけを短く表示する
  → 詳細は将来の`/tracker/` Dashboardで読み、必要なら明示操作でexport / deleteする
```

## 2. なぜ単一の「視聴時間」にしないか

Normal、手動speed、Condensed、Fast-forwardは、時計時間とmedia timelineの進み方が一致しない。

| 指標                                        | 何を表すか                               | 例: 30秒を2xで再生 |
| ------------------------------------------- | ---------------------------------------- | ------------------ |
| **実視聴時間** (`foregroundWatchMs`)        | 画面を開いて実際に再生していた時計時間   | 30秒               |
| **教材進行量** (`mediaProgressMs`)          | media timeline上で通常再生により進んだ量 | 約60秒             |
| **字幕接触量** (`subtitleExposureMs`)       | cueが存在する区間を通過した量            | cueとの重なりだけ  |
| **Condensed skip量** (`condensedSkippedMs`) | Condensedが意図して飛ばした無音区間      | 0秒または該当gap   |
| **Fast-forward量** (`fastForwardMediaMs`)   | Fast-forward中に進んだtimeline量         | 無音を3xで進めた量 |

数字を混ぜて「今日は60分勉強した」とは表示しない。時計時間と教材量は別のものだからである。

### 2.1 mode別の扱い

| 状態                        | 実視聴時間             | 教材進行量               | 字幕接触量    | 補助記録                                   |
| --------------------------- | ---------------------- | ------------------------ | ------------- | ------------------------------------------ |
| Normal / 手動speed          | 再生中のwall-clock差分 | 通常進行したtimeline差分 | cueとの重なり | rate bucket                                |
| Condensed                   | 再生したwall-clock差分 | seekで飛ばしたgapを除く  | cueとの重なり | `condensedSkippedMs`                       |
| Fast-forward                | 再生したwall-clock差分 | 実際のtimeline差分       | cueとの重なり | `fastForwardWallMs` / `fastForwardMediaMs` |
| pause / buffering / capture | 加算しない             | 加算しない               | 加算しない    | 必要ならpause回数だけhotspotへ             |
| user seek                   | 加算しない             | jump部分を加算しない     | 加算しない    | backward seekだけhotspot候補へ             |

Fast-forwardで無音を3xにしても、字幕接触量を3倍にはしない。字幕周辺は現在のP2.1契約どおり1xで扱われる。

## 3. 既存Playerとの接続点

既存のPlayerはすでにmodeを実行時に明示しているため、後から推測する必要はない。

- `PlayerApp.tsx` のCondensedは長いgapを明示的なseekとして処理する
- `PlayerApp.tsx` のFast-forwardは字幕外を3x、字幕付近を1xへ切り替える
- `PlayerControls.tsx` はmedia elementの`timeupdate`からcurrent timeを同期している

Trackerは`timeupdate`の発火回数を数えない。`playing`、`pause`、`ended`、`seeking`、`seeked`、`ratechange`、mode変更、`visibilitychange`、`pagehide`で区切った**再生segment**の差分を集計する。

```text
segment開始: performance.now + media.currentTime + rate + mode
segment終了: performance.now + media.currentTime
  → wall-clock差分
  → timeline差分
  → cue intervalとの重なり
  → programmatic Condensed seek / user seekの区別
```

`timeupdate`はUI同期の補助とheartbeatに使う。保存単位ではない。

## 4. local-first / privacy契約

### 4.1 browser外へ出さないもの

以下はIMMERSION_TRACKERから一切送信・同期・共有しない。

- media file本体、audio / video / image Blob
- 字幕file、Yomitan lookup内容
- magnet URI、torrent tracker情報、peer情報、IP address
- AnkiConnect API key、Anki card内容、deck名
- raw playback event log

**唯一の本文例外:** ユーザーがMining Previewから明示してAnki exportに成功した時だけ、その送信済みsentenceをMining archiveへlocal保存する。通常再生中の字幕、検索・scanした単語、Anki card本文は保存しない。

WebTorrentを使う場合も、Tracker自身はpeer通信へ参加・追加送信しない。WebTorrentのIP露出は別機能のprivacy境界であり、Trackerの通信ではない。

### 4.2 保存先と消去

- 保存先はbrowser profile内のIndexedDBだけ
- Enteiにはapplication backend、analytics endpoint、server-side cacheを追加しない
- browserのsite dataを消すとTracker dataも消える
- 実装時に「全消去」「media単位削除」「期間単位削除」を提供する
- export / importは将来の明示操作だけ。自動backup / cloud syncはしない

## 5. media identity

画面にはユーザーが選んだ**ファイル名**を表示する。ただしfilenameだけをprimary keyにしない。同名の別fileがあり得るためである。

```text
mediaId = SHA-256(
  installation-local salt + source kind + filename + byte size + lastModified + MIME type
)
```

- `installation-local salt` はTracker IndexedDB内だけに保存し、別browser / 別deviceへ持ち出さない
- file本文をhashしない。大きなvideoを読むために再生開始を遅くしない
- local fileをrenameした場合は別mediaとして扱われる。このv1制約を隠さない
- torrent mediaはmagnet URI / info hashを保存しない。取得できるfilename・size・kindだけで同じlocal identity規則を使う
- directory path、File System Access handleは保存しない

## 6. IndexedDB schema v1

raw eventを無期限に溜めない。読むための集計だけを保存し、容量・privacy・migrationを小さく保つ。

### 6.1 `media`

| field                                    | 内容                                         |
| ---------------------------------------- | -------------------------------------------- |
| `mediaId`                                | installation-localなfingerprint              |
| `displayName`                            | UIに表示するfilename                         |
| `sourceKind`                             | `local` / `webtorrent`                       |
| `byteSize` / `lastModified` / `mimeType` | file識別の補助metadata。取得不能な値は`null` |
| `firstSeenDay` / `lastSeenDay`           | 日別表示用のlocal date                       |
| `totals`                                 | media単位の各時間・skip・hotspot集計         |

### 6.2 `media_daily`

keyは`mediaId + localDay`。同じmediaをある日にどのように見たかを保持する。

```ts
interface MediaDailyAggregate {
  mediaId: string;
  localDay: string; // YYYY-MM-DD in the user's local timezone, never UTC
  foregroundWatchMs: number;
  mediaProgressMs: number;
  subtitleExposureMs: number;
  condensedSkippedMs: number;
  fastForwardWallMs: number;
  fastForwardMediaMs: number;
  rateBuckets: Record<string, number>;
  manualBackwardSeekCount: number;
  mineCount: number;
}
```

`mineCount`は将来、Mining Previewを開いた回数だけを数える候補である。字幕本文・Anki送信結果・card IDは保存しない。

### 6.3 `daily`

keyは`localDay`。全mediaの`media_daily`を足した日別Dashboard用cacheである。

- 日付変更をまたぐsegmentはlocal midnightで分割する
- `daily`はsource of truthではない。修復が必要なら`media_daily`から再集計できる

### 6.4 `hotspots`

keyは`mediaId + bucketStartMs`。bucketはmedia timelineの30秒単位で固定する。

| field                     | 内容                             |
| ------------------------- | -------------------------------- |
| `foregroundWatchMs`       | この地点を実際に再生していた時間 |
| `subtitleExposureMs`      | cueと重なった量                  |
| `pauseCount`              | このbucket内のpause回数          |
| `manualBackwardSeekCount` | 手動で戻った回数                 |
| `mineCount`               | 将来のmine回数                   |

これは「理解できない地点」と断定しない。UIでは**Review hotspots（見直しが多い地点）**と呼ぶ。好きな台詞を繰り返している可能性もあるため。

### 6.5 `mining_archive`

明示Anki exportに成功した採掘だけを残す、Tracker内の軽いarchiveである。現在のMining Historyをここへ統合する。

| field                     | 内容                                                   |
| ------------------------- | ------------------------------------------------------ |
| `id`                      | auto-increment keyとは別のstable local ID              |
| `mediaId`                 | `media` recordへの参照。対応できない古いrecordは`null` |
| `displayName`             | 履歴listで表示するfilename snapshot                    |
| `rangeStart` / `rangeEnd` | export成功時の選択range                                |
| `sentence`                | ユーザーが明示して送信したsentenceだけ                 |
| `localDay`                | 成功した日のlocal date                                 |

保存しないものは、画像・audio・WebM Blob、Anki card ID、deck名、note type、API key、export mode、Anki response全文である。

既存の`entei-mining-history` DBは、Tracker実装時にrecordを失わないmigration / import経路を用意してから統合する。実装前の現在は既存Historyを変更しない。

## 7. 計測の境界

### 加算する時

- media elementが`playing`である
- documentがvisibleである
- user seek / Condensed seek / mining captureの途中ではない

v1の`foregroundWatchMs`は、画面を開いている時だけの数値にする。background audioを学習時間として別計上するかは、audio-first利用の実データを見てから別仕様にする。

### 加算しない時

- pause、ended、error、buffering
- Settings / Mining Previewが開きcaptureで止めている時間
- media変更後の古いevent
- seek jumpそのもの

Condensedによるjumpは`condensedSkippedMs`へ、手動backward seekは`manualBackwardSeekCount`へ明示的に分類する。seek差分を視聴量へ混ぜない。

## 8. 初期Dashboard

初期UIはランキングやstreakを出さない。

### 8.1 Player RightPanel — Recent mining

`Captions | History`の`History`はIMMERSION_TRACKERの一部とする。ここには最新のMining archiveを短く並べるだけで、filename・range・sentence以外の統計や編集UIは置かない。

### 8.2 将来の`/tracker/` page

Playerの横へ分析を詰め込まない。学習者が自分の状況を読む次の詳細画面は、将来の専用`/tracker/` pageに分ける。

1. **Today / period summary** — 実視聴・教材進行・字幕接触・Condensed skip・Fast-forward利用
2. **Media detail** — filename別の累計、日別推移、rate / mode内訳
3. **Review hotspots** — 30秒bucketのpause / backward seek / mine頻度。クリックseekは後続Phaseで決める
4. **Mining archive** — 明示export済みsentenceをmedia / dayと結び、詳細を読む。RightPanelはこの一覧の簡易viewだけ

「理解度%」「生産性score」「連続日数による煽り」はv1に入れない。数値の意味が不明瞭なまま、行動だけを最適化させない。

## 9. 容量・migration・失敗時の扱い

- DBは`immersion-tracker`とし、既存Mining Historyはnon-destructive migrationを通して`mining_archive`へ統合する
- IndexedDB schema versionを明示し、upgradeで既存recordを消さない
- raw event logを保存しないため、保存量はmedia数・視聴日数・30秒bucket数で上限が見通せる
- write失敗は再生を止めない。未flush segmentはmemoryに残し、次のheartbeat / lifecycle eventで再試行する
- `pagehide`、media変更、pause、visibility変更でflushする。短いheartbeatも使い、突然tabが閉じても全sessionを失わないようにする
- quota error時はTracker UIにlocal-onlyの説明とcleanup導線を出す。勝手に古い記録を削除しない

## 10. verification gate

実装時は少なくとも次をunit / integration / real browserで確認する。

- 1x、0.5x、2xでwall-clockとtimeline量が分離される
- Condensedのprogrammatic seekが`condensedSkippedMs`だけへ入る
- Fast-forwardの3x無音と1x字幕が別bucketへ入る
- manual seek / rewindが教材進行量を二重加算しない
- pause、buffering、Mining capture、modal open時間を視聴時間へ入れない
- tab hidden / visible、pagehide、media変更でsegmentを二重writeしない
- 同名・別size fileが別mediaとして並ぶ
- renameが別mediaとして現れるv1制約をUIで説明する
- clear media / clear period / clear allが他のlocal data（Anki mapping、subtitle preference）を消さない。Trackerのclear allは`mining_archive`を含むTracker dataだけを消す
- tracker write failureがvideo再生、Anki export、WebTorrent再生を妨げない

## 11. 実装順

1. pure segment accumulatorとmode/seek分類のunit test
2. IndexedDB adapter + migration / deletion API
3. 既存Mining Historyを`mining_archive`へnon-destructive migrationし、RightPanelをRecent miningの簡易viewとして接続
4. media別・日別aggregate writeとlifecycle flush
5. `/tracker/`のToday summary / Media detail / Mining archive read-only UI
6. Review hotspots UI
7. user-controlled JSON export / import

Ankiのknown / learning状態、Yomitan lookup、WaniKani、subtitle本文を使う理解度推定は、このv1が実利用で安定してから別設計にする。

## 12. 関連document

- [PLAYER_PHASES.md](./PLAYER_PHASES.md) — P6 annotation / statisticsのphase境界
- [ANKI_MINER.md](./ANKI_MINER.md) — mining / Anki exportのlocal-only境界
- [WEBTORRENT_STREAMING.md](./WEBTORRENT_STREAMING.md) — WebTorrentのpeer privacy境界
