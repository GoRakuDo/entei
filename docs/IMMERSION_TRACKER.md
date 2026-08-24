# IMMERSION_TRACKER — local-first 視聴・没入記録の設計

> **状態:** 実装済み（v1: foundation + dashboard + `/tracker/` read-only）。P6 Statisticsの土台として仕様を固定する。
> **対象:** `Entei/apps/web` の `/player/` React islandで選んだlocal fileだけ。WebTorrent、Home、外部serverは対象外。
> **決定日:** 2026-07-30

---

## 1. 人間語でいうIMMERSION_TRACKER

IMMERSION_TRACKERは、学習者が「どれだけ再生したか」だけでなく、**何を、どんな再生方法で、どの地点を見直しているか**を自分で振り返るためのlocal-first記録である。

これは監視、ランキング、連続視聴の強要、第三者への分析送信のための機能ではない。自分の学習時間と**i+1 Moments**を理解するための個人用ノートである。RightPanelのHistoryは、このTrackerに属する軽い「最近の採掘」listとして残す。

```text
mediaを再生
  → 実際に再生していた時間とmedia timelineの進行をbrowser内で測る
  → speed / play mode / cue区間 / seekを別々に分類する
  → media別・字幕版別・日別・1秒cellの集計だけをIndexedDBへ保存する
  → RightPanelには最近の採掘だけを短く表示する
  → 詳細は将来の`/tracker/` Dashboardで読み、必要なら明示操作でexport / deleteする
```

## 2. なぜ単一の「視聴時間」にしないか

Normal、手動speed、Condensed、Fast-forwardは、時計時間とmedia timelineの進み方が一致しない。

| 指標                                        | 何を表すか                                       | 例: media 30秒を2xで再生 |
| ------------------------------------------- | ------------------------------------------------ | ------------------------ |
| **実視聴時間** (`foregroundWatchMs`)        | visibleな画面で実際に再生していたwall-clock時間  | 15秒                     |
| **教材進行量** (`mediaProgressMs`)          | seek jumpを除いてmedia timeline上で進んだ累積量  | 約30秒                   |
| **unique coverage** (`uniqueCoverageMs`)    | 一度でも通常再生で触れた異なるmedia範囲          | 最大30秒                 |
| **有効接触量** (`effectiveExposureMs`)      | wall-clock時間へ同一箇所の反復減衰を掛けた分析値 | 初回なら15秒             |
| **字幕接触量** (`subtitleExposureMs`)       | cueが存在する区間へ実際に使ったwall-clock時間    | cueとの重なりだけ        |
| **Condensed skip量** (`condensedSkippedMs`) | Condensedが意図して飛ばした無音区間              | 0秒または該当gap         |
| **Fast-forward量** (`fastForwardMediaMs`)   | Fast-forward中に進んだtimeline量                 | 無音を3xで進めた量       |

数字を混ぜて「今日は60分勉強した」とは表示しない。時計時間と教材量は別のものだからである。

### 2.1 mode別の扱い

| 状態                        | 実視聴時間             | 教材進行量               | 字幕接触量    | 補助記録                                   |
| --------------------------- | ---------------------- | ------------------------ | ------------- | ------------------------------------------ |
| Normal / 手動speed          | 再生中のwall-clock差分 | 通常進行したtimeline差分 | cueとの重なり | rate bucket                                |
| Condensed                   | 再生したwall-clock差分 | seekで飛ばしたgapを除く  | cueとの重なり | `condensedSkippedMs`                       |
| Fast-forward                | 再生したwall-clock差分 | 実際のtimeline差分       | cueとの重なり | `fastForwardWallMs` / `fastForwardMediaMs` |
| pause / buffering / capture | 加算しない             | 加算しない               | 加算しない    | playing→paused transitionをi+1 signalへ    |
| user seek                   | 加算しない             | jump部分を加算しない     | 加算しない    | backward seekだけi+1 signal候補へ          |

Fast-forwardで無音を3xにしても、字幕接触量を3倍にはしない。字幕周辺は現在のP2.1契約どおり1xで扱われる。

### 2.2 1秒cellと反復減衰

media位置は最寄りの1秒へ四捨五入する（`12.49s → 12`、`12.50s → 13`）。同じvideo + subtitleの同じ1秒cellを繰り返した時、有効接触量だけを次のように減衰する。

```text
1回目: wall-clock contribution × 1.0
2回目: wall-clock contribution × 0.5
3回目: wall-clock contribution × 0.25
N回目: wall-clock contribution × 0.5^(N - 1)
```

- `foregroundWatchMs`と`mediaProgressMs`は減らさない。減衰は`effectiveExposureMs`だけに適用する
- 同じcellを連続して再生中に複数の`timeupdate`が来ても、同一passとして反復回数を1回しか増やさない
- そのcellの`lastSeenAt`から7日間空いた時だけ、次回を再び1回目（`×1.0`）として扱う
- resetはmedia全体ではなく、各1秒cell単位
- 2xでmedia 2秒をwall-clock 1秒で通過した場合、2つのcellへ0.5秒ずつ配る。cell合計が実時間を超えないようにする
- UIでは1秒cellを直接並べず、30秒単位のi+1 Momentsへ集約する

## 3. 既存Playerとの接続点

既存のPlayerはすでにmodeを実行時に明示しているため、後から推測する必要はない。

- `PlayerApp.tsx` のCondensedは長いgapを明示的なseekとして処理する
- `PlayerApp.tsx` のFast-forwardは字幕外を3x、字幕付近を1xへ切り替える
- `PlayerControls.tsx` はmedia elementの`timeupdate`からcurrent timeを同期している

Trackerは`timeupdate`の発火回数を数えない。`playing`、`pause`、`ended`、`seeking`、`seeked`、`ratechange`、mode変更、subtitle変更、`visibilitychange`、`pagehide`で区切った**再生segment**の差分を集計する。

```text
segment開始: performance.now + media.currentTime + rate + mode
segment終了: performance.now + media.currentTime
  → wall-clock差分
  → timeline差分
  → 1秒cellへwall-clockを分配
  → cue intervalとの重なり
  → programmatic Condensed seek / user seekの区別
```

`timeupdate`はUI同期の補助とheartbeatに使う。保存単位ではない。各segmentには連続pass IDを持たせ、同じcell内でeventが複数回発火しても反復回数を水増ししない。

## 4. local-first / privacy契約

### 4.1 browser外へ出さないもの

以下はIMMERSION_TRACKERから一切送信・同期・共有しない。

- media file本体、audio / video / image Blob
- 字幕file、Yomitan lookup内容
- file path、File System Access handle
- AnkiConnect API key、Anki card内容、deck名
- raw playback event log

**唯一の本文例外:** ユーザーがMining Previewから明示してAnki exportに成功した時だけ、その送信済みsentenceをMining archiveへlocal保存する。通常再生中の字幕、検索・scanした単語、Anki card本文は保存しない。

### 4.2 保存先と消去

- 保存先はbrowser profile内のIndexedDBだけ
- Enteiにはapplication backend、analytics endpoint、server-side cacheを追加しない
- browserのsite dataを消すとTracker dataも消える
- 実装時に「全消去」「media単位削除」「期間単位削除」を提供する
- 自動expiryは設けない。ユーザーが消すまで無期限に保持する
- quota不足時は記録を停止してcleanup導線を出し、古いrecordを勝手に削除しない
- backup / export / importはdeferred。v1では同じbrowser profile内だけに留める

## 5. media identity

画面にはユーザーが選んだ**ファイル名**を表示する。ただしfilenameだけをprimary keyにしない。同名の別fileやrenameがあり得るためである。

```text
mediaId = SHA-256(
  installation-local salt + byte size + first 1MiB + last 1MiB
)

subtitleId = SHA-256(subtitle file content)

learningSetId = mediaId + subtitleId
# 字幕なしの場合は mediaId + no-subtitle
```

- `installation-local salt` はTracker IndexedDB内だけに保存し、別browser / 別deviceへ持ち出さない
- file全体をhashしない。先頭・末尾のsampleだけを読み、数GBのvideoで再生開始を遅くしない
- filenameをidentityへ含めないため、rename後も同じsample fingerprintなら同一videoとして扱う
- subtitle本文はhash後に保存せず、digestだけを保持する
- 同じvideoの`字幕なし / subtitle A / subtitle B`は1つのmedia親項目の内側へまとめる。ただし反復回数・7日reset・i+1 Momentsはlearning setごとに分離する
- v1はlocal fileだけ。WebTorrent mediaへ仮IDを作ったり、後からmergeしたりしない
- directory path、File System Access handleは保存しない
- 将来backupを設計する時にportable identity、salt migration、重複mergeを別途決める。v1のidentityをdevice間でportableだと主張しない

## 6. IndexedDB schema v1

raw eventを無期限に溜めない。読むための集計だけを保存し、容量・privacy・migrationを小さく保つ。

### 6.1 `media`

| field                          | 内容                                              |
| ------------------------------ | ------------------------------------------------- |
| `mediaId`                      | installation-local salt付きsample fingerprint     |
| `displayName`                  | UIに表示する最新filename                          |
| `byteSize` / `mimeType`        | local file metadata                               |
| `firstSeenDay` / `lastSeenDay` | 日別表示用のlocal date                            |
| `totals`                       | 全subtitle版を合算したraw時間・skip・coverage集計 |

### 6.2 `learning_sets`

同じvideoのsubtitle版を区別する。subtitle変更時は現在segmentを閉じ、新しいlearning setでsegmentを開始する。

| field           | 内容                                        |
| --------------- | ------------------------------------------- |
| `learningSetId` | `mediaId + subtitleId`から作るlocal key     |
| `mediaId`       | 親mediaへの参照                             |
| `subtitleId`    | subtitle digest。字幕なしは`no-subtitle`    |
| `totals`        | このsubtitle版だけの時間・coverage・i+1集計 |

### 6.3 `media_daily`

keyは`learningSetId + localDay`。同じvideo + subtitle版をある日にどのように見たかを保持する。

```ts
interface MediaDailyAggregate {
  mediaId: string;
  learningSetId: string;
  localDay: string; // YYYY-MM-DD in the user's local timezone, never UTC
  foregroundWatchMs: number;
  mediaProgressMs: number;
  uniqueCoverageMs: number;
  effectiveExposureMs: number;
  subtitleExposureMs: number;
  condensedSkippedMs: number;
  fastForwardWallMs: number;
  fastForwardMediaMs: number;
  rateBuckets: Record<string, number>; // 分析内訳。i+1判定には使わない
  manualBackwardSeekCount: number;
  mineCount: number;
}
```

`mineCount`はAnki送信成功時だけ増やす。Mining Preview open / cancelは数えない。字幕本文・Anki response・card IDはこのaggregateへ保存しない。

### 6.4 `daily`

keyは`localDay`。全mediaの`media_daily`を足した日別Dashboard用cacheである。

- 日付変更をまたぐsegmentはlocal midnightで分割する
- `daily`はsource of truthではない。修復が必要なら`media_daily`から再集計できる

### 6.5 `exposure_cells`

keyは`learningSetId + roundedSecond`。実際に触れた1秒だけを疎に保存し、raw event logは持たない。

| field                     | 内容                                            |
| ------------------------- | ----------------------------------------------- |
| `roundedSecond`           | `Math.round(media.currentTime)`で得るtimeline秒 |
| `foregroundWatchMs`       | この秒へ実際に使ったwall-clock累積              |
| `effectiveExposureMs`     | 反復減衰後のwall-clock累積                      |
| `passCount`               | 7日window内の連続pass回数                       |
| `lastSeenAt`              | このcell固有の7日reset判定時刻                  |
| `hasCoverage`             | unique coverage再計算用flag                     |
| `subtitleExposureMs`      | cueと重なったwall-clock累積                     |
| `pauseCount`              | この秒でplaying→pausedになった回数              |
| `manualBackwardSeekCount` | 手動で戻った回数                                |
| `mineCount`               | Anki送信成功回数                                |

UIは1秒cellを30秒bucketへ集約し、**i+1 Moments**として表示する。これはKrashenの`i+1`を操作logだけで確定するscoreではなく、学習者が少し先の表現へ出会った可能性を振り返る候補である。反復・pause・manual backward seek・mineを1つの難易度scoreへ合算せず、signal別に見せる。

### 6.6 `mining_archive`

明示Anki exportに成功した採掘だけを残す、Tracker内の軽いarchiveである。現在のMining Historyをここへ統合する。

| field                     | 内容                                      |
| ------------------------- | ----------------------------------------- |
| `id`                      | auto-increment keyとは別のstable local ID |
| `mediaId`                 | `media` recordへの参照                    |
| `learningSetId`           | export時のvideo + subtitle版への参照      |
| `displayName`             | 履歴listで表示するfilename snapshot       |
| `rangeStart` / `rangeEnd` | export成功時の選択range                   |
| `sentence`                | ユーザーが明示して送信したsentenceだけ    |
| `localDay`                | 成功した日のlocal date                    |

保存しないものは、画像・audio・WebM Blob、Anki card ID、deck名、note type、API key、export mode、Anki response全文である。

Trackerの記録開始点は実装切替時とし、それ以前のMining Historyは移行しない。旧`entei-mining-history` DBの削除方針は2026-07-30にユーザー承認済み。ただし実装時も、新しいTracker DBのopen・初期化成功を確認し、削除対象を示して直前確認を得てから削除する。`unknown` date / media recordや、移行日を採掘日と偽るrecordは作らない。

## 7. 計測の境界

### 加算する時

- media elementが`playing`である
- documentがvisibleである
- user seek / Condensed seek / mining captureの途中ではない

v1の`foregroundWatchMs`は、画面を開いている時だけの数値にする。hidden / minimized中は、audioが再生されていても加算しない。将来の別機能候補として、Passive Listening Playerでbackground listeningを独立計測する。

### 加算しない時

- pause、ended、error、buffering
- Settings / Mining Previewが開き、mediaが止まっている時間
- media変更後の古いevent
- seek jumpそのもの

Condensedによるjumpは`condensedSkippedMs`へ、手動backward seekは`manualBackwardSeekCount`へ明示的に分類する。seek差分を視聴量へ混ぜない。

pause原因は区別しない。手動Pause、Mining開始、mobile字幕blur解除、将来機能によるpauseをすべて、**playing→pausedへ変わったtransition**として1回数える。同じpaused状態で`pause()`が再度呼ばれても増やさない。bufferingは`paused` transitionではないためpause signalへ入れない。

### Tracker ON / OFF

- Trackerはdefault ON
- RightPanelのHistory tab上部にshadcn `Switch`と明示した`ON / OFF` labelを置く
- OFF状態はlocalStorageへ保存し、reload後もユーザーの選択を維持する
- OFFへ切り替えた瞬間に現在segmentをflushして計測停止、ONへ戻した瞬間から新segmentを開始する
- OFFは新規記録だけを止め、既存dataを削除しない。削除は別操作

## 8. 初期Dashboard

初期UIはランキングやstreakを出さない。

### 8.1 Player RightPanel — Recent mining

`Captions | History`の`History`はIMMERSION_TRACKERの一部とする。上部にTracker `ON / OFF` Switchを置き、その下には最新のMining archiveを短く並べるだけとする。filename・range・sentence以外の統計や編集UIは置かない。

### 8.2 将来の`/tracker/` page

Playerの横へ分析を詰め込まない。学習者が自分の状況を読む次の詳細画面は、将来の専用`/tracker/` pageに分ける。

1. **Today / period summary** — 実視聴・教材進行・字幕接触・Condensed skip・Fast-forward利用
2. **Media detail** — filename別の累計、日別推移、rate / mode内訳
3. **i+1 Moments** — 1秒cellを30秒へまとめ、反復 / pause / backward seek / Anki送信成功をsignal別に表示。クリックseekは後続Phaseで決める
4. **Mining archive** — 明示export済みsentenceをmedia / dayと結び、詳細を読む。RightPanelはこの一覧の簡易viewだけ

「理解度%」「生産性score」「連続日数による煽り」はv1に入れない。数値の意味が不明瞭なまま、行動だけを最適化させない。

## 9. 容量・migration・失敗時の扱い

- DBは`immersion-tracker`とし、実装切替前のMining Historyは移行しない。新DBの初期化成功後に旧DBを削除する
- IndexedDB schema versionを明示し、Tracker開始後のupgradeで既存Tracker recordを消さない
- raw event logを保存しないため、保存量はmedia数・視聴日数・実際に触れた1秒cell数で上限が見通せる
- write失敗は再生を止めない。未flush segmentはmemoryに残し、次のheartbeat / lifecycle eventで再試行する
- `pagehide`、media変更、pause、visibility変更でflushする。短いheartbeatも使い、突然tabが閉じても全sessionを失わないようにする
- quota error時はTracker UIにlocal-onlyの説明とcleanup導線を出す。勝手に古い記録を削除しない
- 自動expiryは行わない。ユーザーが削除するまで無期限に保持する

## 10. verification gate

実装時は少なくとも次をunit / integration / real browserで確認する。

- 1x、0.5x、2xでwall-clockとtimeline量が分離される
- 2xでmedia 2秒をwall-clock 1秒で通過した時、2つのcellへ0.5秒ずつ配られ、合計が1秒になる
- 同じ10秒を3回見た時、raw実視聴は全量、effective exposureだけ`1.0 / 0.5 / 0.25`で減衰する
- 各1秒cellの最終接触から7日未満では減衰を継続し、7日後はそのcellだけ`×1.0`へresetする
- 12.49秒→12、12.50秒→13の四捨五入境界を固定する
- 同一pass内の複数`timeupdate`でpassCountを二重加算しない
- Condensedのprogrammatic seekが`condensedSkippedMs`だけへ入る
- Fast-forwardの3x無音と1x字幕が別bucketへ入る
- manual seek / rewindが教材進行量を二重加算しない
- pause、buffering、Mining capture中の停止時間を視聴時間へ入れない
- pause原因を問わずplaying→paused transitionを1回だけ数え、bufferingや重複`pause()`は数えない
- tab hidden / visible、pagehide、media変更でsegmentを二重writeしない
- tab hidden中のbackground audioを視聴時間へ入れない
- 同名・別sample fileが別mediaになり、renameした同一sample fileは同じmediaになる
- subtitle本文digestの一致 / 不一致 / no-subtitleでlearning setが正しく分かれる
- subtitle変更時に古いsegmentを閉じ、新learning setで開始する
- WebTorrent再生ではTracker recordを作らない
- OFF切替でflush後に停止し、reload後もOFFを維持する。ON復帰は新segmentから開始する
- Anki送信成功だけが`mineCount`と`mining_archive`を増やし、Preview open / cancelは増やさない
- clear media / clear period / clear allが他のlocal data（Anki mapping、subtitle preference）を消さない。Trackerのclear allは`mining_archive`を含むTracker dataだけを消す
- tracker write failureがvideo再生やAnki exportを妨げない
- 新Tracker DBの初期化成功前に旧Mining History DBを削除せず、削除直前のユーザー確認なしに実行しない

## 11. 実装順

1. pure segment accumulator、1秒cell、反復減衰、mode / seek / pause分類のunit test
2. local video sample fingerprint + subtitle digest + learning set identity
3. IndexedDB adapter + deletion API。新DB初期化成功後、削除対象を示してユーザーへ直前確認し、旧Mining History DBを削除
4. media別・subtitle版別・日別aggregate writeとlifecycle flush
5. default ON / persisted OFF SwitchとRightPanel Recent miningを新`mining_archive`へ接続
6. `/tracker/`のToday summary / Media detail / Mining archive read-only UI
7. i+1 Moments UI

Ankiのknown / learning状態、Yomitan lookup、WaniKani、subtitle本文を使う理解度推定は、このv1が実利用で安定してから別設計にする。backup / export / import、portable identity、salt migration、WebTorrent tracking、Passive Listeningもdeferredとする。

## 12. 関連document

- [PLAYER_PHASES.md](./PLAYER_PHASES.md) — P6 annotation / statisticsのphase境界
- [ANKI_MINER.md](./ANKI_MINER.md) — mining / Anki exportのlocal-only境界
- [WEBTORRENT_STREAMING.md](./WEBTORRENT_STREAMING.md) — v1 Tracker対象外のWebTorrent境界

## 実装メモ（2026-08-07）: メディア表示名（displayName）

UIに表示するメディア名（IMMERSION_TRACKER.md:118 / :149 の `displayName`）は、ソース別に:
- **Torrent（Magnet）**: 選択 torrent ファイルの **basename（ファイル名）**
- **YouTube**: **動画タイトル**（companion が yt-dlp の `--print-to-file "%(title)s" title.txt` で取得 → job Snapshot / `/v1/media/status` の `title` → web が `jobTitle` として取得 → `setMediaName(title)`、Torrent は影響なし）

primary key は引き続き fingerprint / digest（filename は display 専用）。YouTube title のポーリングは有界（5回×2秒、job error/cancelled で即停止、ネットワークエラーは別カウンターで上限5）。
