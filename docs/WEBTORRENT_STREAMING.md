# WebTorrent — Phase 3 Local Peer Streaming 設計

> **状態:** 設計承認済み・未実装。
> **対象:** original proposalのPhase 3。`PLAYER_PHASES.md`のP3 Miningとは別の番号体系なので、以後は`WT-1`〜`WT-5`で呼ぶ。
> **境界:** torrent内のローカルメディアをbrowserで再生する機能。外部配信siteへの注入、tab capture、browser extensionは永久に対象外。

---

## 1. 人間語でいうと

ユーザーがmagnet URIを貼ると、園庭はbrowserから実際に接続できたWebRTC peerを確認する。

3 peer以上なら、torrent内の動画と字幕を選び、既存Playerで再生する。動画が1本、字幕が0本または1本だけなら選択画面を挟まず、そのまま再生を始める。

```text
magnet URI
  → WebRTC peer確認（3以上）
  → torrent内ファイルを列挙
  → video + subtitleを決定
  → 既存 <video> へstreamTo
  → 既存の字幕表示 / Mine / Anki exportを使う
```

これは「動画サイトから取る」機能ではない。ユーザーが指定したtorrentのpeerとbrowserが直接通信する機能。

---

## 2. 固定v1契約

### 2.1 入力

- 入力は**magnet URIのみ**。`.torrent`ファイル、HTTP torrent URL、検索機能は入れない。
- 入力値をlocalStorage、URL、Analytics、ログへ保存しない。
- `magnet:`形式でない値は接続を始めず、3言語の入力エラーを表示する。

### 2.2 3-peer 接続gate

browserはpeerの実装種別を安全に識別できない。そのため、`WebTorrent Desktop`、`webtorrent-hybrid`、browser seed、WebRTC対応web seedという**候補種別を数える**のではなく、実際にbrowserが接続できたWebRTC peerを`torrent.numPeers`で数える。

| 条件 | 動作 |
| --- | --- |
| WebRTC非対応 | 接続を開始しない。local file Playerを案内する |
| 接続済みpeerが0〜2 | 接続確認中を表示し、ファイル一覧や再生は出さない |
| 接続済みpeerが3以上 | torrent内容の判定へ進む |
| peer不足 / tracker失敗 / no-peer | torrentをdestroyし、エラーを表示する |

peer数は「その瞬間に接続できた共有相手」の数であり、3つの**完全seed**や特定pieceの保有を保証しない。開始後にpeerが減った時は再生を壊さずbuffering状態として表示する。

peer不足時のcopy:

| Locale | 表示文 |
| --- | --- |
| id | `Maaf, jumlah pembagi file ini tidak mencukupi. Coba magnet URI lain.` |
| ja | `すみません、そのファイルの共有者数が足りません。別のmagnet URIを試してください。` |
| en | `Sorry, this file does not have enough sharers. Try another magnet URI.` |

### 2.3 torrent内容の決定

| torrent内容 | 動作 |
| --- | --- |
| 再生可能mediaが0本 | mediaなしエラー。torrent sessionを破棄 |
| video/audioが1本、字幕が0本 | 直ちにmediaをstreamする。Subtitle panelは既存empty state |
| video/audioが1本、字幕が1本 | 直ちにmediaをstreamし、その字幕を既存parserへ渡す |
| video/audioまたは字幕が複数 | 内容選択Modalを出し、mediaは1本、字幕は0または1本をユーザーが決める |

- media候補は現在の`media-url.ts`のadmission matrixを正とする。torrentだから対応formatを広げない。
- 字幕候補は現在のSRT / VTT / ASSだけ。torrent内字幕もtextとして読める形式だけを既存`subtitle-reader`へ渡す。
- browser codecが非対応なら、torrent接続が成功しても既存のdecode errorを表示する。torrent containerをbrowser内変換しない。

### 2.4 再生開始

WebTorrentのService Worker serverを起動し、選択されたfileを既存のvisible `<video>` / `<audio>`へ`streamTo()`する。

- 完全downloadを待たず、browserのrange requestに応じて必要pieceを取得する。
- seekは既存Playerのseek sliderを使う。必要なpieceの取得待ちはbuffering UIで表現する。
- sessionの停止、media変更、page leave、unmountではtorrent / Worker communication / object URL相当の参照を確実に破棄する。

---

## 3. 現在の園庭からのアーキテクチャ

現在の`/player/`は`client:only="react"`のbrowser-only islandであり、WebRTC、Service Worker、media APIをSSRへ持ち込まずに追加できる。一方で、現dependencyには`webtorrent`もService Workerもまだない。

```text
PlayerApp
├── LocalMediaSession（現在）
│   └── File → blob URL → <video>/<audio>
└── TorrentMediaSession（WT-1で追加）
    ├── magnet URI → WebTorrent client
    ├── Service Worker stream server
    ├── peer / progress / buffering state
    ├── torrent file selection
    └── stream URL → 同じ <video>/<audio>
```

`PlayerApp`は「local fileかtorrentか」の入口だけを分け、字幕表示、caption mode、row Mine、Mining Preview、Anki exportは既存経路を再利用する。torrent専用の第2 Playerや第2 Mining flowは作らない。

---

## 4. 段階実装

### WT-1 — 接続とstreaming最小版

1. `npm install webtorrent`で依存を追加する。
2. 園庭origin上のService Workerをbundle / registerし、WebTorrentのbrowser stream serverを初期化する。
3. magnet inputとWebRTC support / peer count / tracker error UIを作る。
4. `numPeers >= 3`を通過したtorrentだけから、1本のmediaを`streamTo()`する。
5. local mediaへ切り替えた時にtorrentを停止・破棄する。

**Done:** WebRTC対応の短い合法test torrentで、再生開始・pause・seek・media切替・peerなしerror・page leave cleanupを実機確認する。

### WT-2 — torrent内字幕と内容選択

1. torrent file listをModalで安全に表示する。
2. single media + 0/1 subtitleを自動選択する。
3. 複数候補ではuserがmedia 1本とsubtitle 0/1本を選ぶ。
4. 選んだtext subtitleを既存parserへ流す。

**Done:** single / multiple / no media / unsupported subtitleの4ケースで、既存SubtitlePanel・overlay・row Mineが正しいcueを使う。

### WT-3 — 対象区間の事前buffer

最初のversionはbrowserのrange requestによるon-demand取得を使う。これだけで再生開始とseekは成立する。

追加bufferは、active cueの前後区間を優先するUXとして後から導入する。WebTorrentの内部selectionへprivate fieldで触れず、公開APIと実torrentのnetwork traceで「不要な全downloadを起こさない」ことを確認してから入れる。

### WT-4 — IndexedDB cache

Mining HistoryのIndexedDBと、torrent piece cacheは別物。

- v1 streamingはmemory-only。media Blob全体をIndexedDBへ保存しない。
- 永続cacheを足す時はchunk store、quota、LRU eviction、容量表示、userによる全削除をまとめて設計する。
- cache失敗は再生を止めず、memory streamingへfallbackする。

### WT-5 — PWA

Service WorkerはWT-1のstreamingに必要だが、それだけでtorrent mediaがoffline再生可能になるわけではない。PWAではまずapp shellだけをoffline対応し、mediaのoffline保証はWT-4のcache contractを完了してから表現する。

---

## 5. Privacy / security gate

WebTorrent開始は、現在のlocal-only copyを再レビューしてからにする。

- magnet URI内のtracker URLとpeer通信により、third partyへ通信が発生する。
- download中はbrowserがupload / seedにも参加する。
- peer数、download/upload speed、torrent metadataは画面内の一時stateだけに置く。Analyticsやserver logは作らない。
- trackerをhardcodeで増やさない。magnetに含まれるWSS trackerだけを初期候補にし、追加tracker policyは別途承認する。
- CSPは`connect-src`と`worker-src`の見直しが必要。GitHub Pagesのresponse header制約も含め、実deploy前に確認する。

---

## 6. Done gate / 実機QA

| ケース | 確認すること |
| --- | --- |
| WebRTC非対応 | 接続しない、local fallback copy |
| 0〜2 peer | file listを出さず、所定のpeer不足copy |
| 3 peer以上 + media 1本 + subtitle 1本 | 自動stream、字幕自動load |
| media/subtitle複数 | Modalで選んだものだけ使用 |
| seek | 該当区間をbufferし、既存subtitleとMineの時刻が一致 |
| peer離脱 | 再生停止ではなくbuffering / recovery表示 |
| media切替 / page leave | torrent destroy、通信とWorker参照のcleanup |
| privacy | peer通信 / uploadの事前説明と明示開始操作 |

---

## 7. 根拠

| 事実 | 根拠 | 意味 |
| --- | --- | --- |
| original Phase 3はWebTorrent→字幕→buffer→IndexedDB→PWAの順 | `園庭プロジェクトの書き下ろし.md:560-565` | peer streamingをlocal Playerの後段として追加する |
| `/player/`はbrowser-only React island | `apps/web/src/pages/player/index.astro:14-15` | WebRTC / Service WorkerをSSRから隔離できる |
| static GitHub Pages向け構成 | `apps/web/astro.config.mjs:13-25` | Service Workerをstatic assetとしてhostでき、serverは不要 |
| WebTorrent browser streamingはService Worker + `createServer()` + `file.streamTo()`が必要 | [WebTorrent公式API](https://webtorrent.io/docs) | package追加だけではstreamingにならない |
| browser版はWebRTC peerだけに接続 | [WebTorrent公式 Get Started](https://github.com/webtorrent/webtorrent/blob/HEAD/docs/get-started.md) | 通常BitTorrent seedだけのmagnetは受入対象にできない |
| 動画は完全download前に再生・seekでき、必要pieceをon-demand取得する | 同公式Get Started | WT-3はon-demandを基礎にしてから優先bufferを足す |
| local-only copyはWebTorrent前に再レビューする | `docs/PHASE0.md:632,652` | peer通信を隠してlocal-onlyとは言わない |
