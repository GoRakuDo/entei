# WebTorrent — Phase 3 Local Peer Streaming 設計

> **状態:** **withdrawn — ED-1で撤去完了（2026-07-31）。** `webtorrent` dependency、browser ESM bundle、Service Worker、adapter / types、browser peer UI、WT-specific tests / i18n（runtime / peer系）はrepositoryから削除済み。Magnet URI dialogのvisual shellはunavailable state（EizouDendenshi未接続案内）付きで残る。撤去内容は[EizouDendenshi staged delivery](./EIZOU_DENDENSHI.md#staged-delivery)を参照。regular BitTorrent / YouTubeは[EizouDendenshi](./EIZOU_DENDENSHI.md)のWindows / Termux localhost companionへ移す。以下はWT-1のhistorical record。
> **対象:** original proposalのPhase 3。`PLAYER_PHASES.md`のP3 Miningとは別の番号体系なので、以後は`WT-1`〜`WT-5`で呼ぶ。
> **境界:** torrent内のローカルメディアをbrowserで再生する機能。外部配信siteへの注入、tab capture、browser extensionは永久に対象外。

---

## 1. 人間語でいうと（historical）

ユーザーがmagnet URIを貼ると、園庭はbrowserから実際に接続できたWebRTC peerを確認する。

1 WebRTC peer以上なら、torrent内の再生可能mediaを既存Playerで再生する。WT-1は再生可能mediaが1本の場合だけ選択画面を挟まず、そのまま再生を始める。torrent内字幕の読込みと複数media選択はWT-2で追加する。

```text
magnet URI
  → WebRTC peer確認（1以上）
  → torrent内mediaを判定
  → 既存 <video> / <audio> へstream URLを渡す
  → 既存Player controlsを使う
```

これは「動画サイトから取る」機能ではない。ユーザーが指定したtorrentのpeerとbrowserが直接通信する機能。

---

## 2. 固定v1契約

### 2.1 入力

- 入力は**magnet URIのみ**。`.torrent`ファイル、HTTP torrent URL、検索機能は入れない。
- 入力値をlocalStorage、URL、Analytics、ログへ保存しない。
- `magnet:`形式でない値は接続を始めず、3言語の入力エラーを表示する。

### 2.2 1-peer 接続gate

browserはpeerの実装種別を安全に識別できない。そのため、`WebTorrent Desktop`、`webtorrent-hybrid`、browser seed、WebRTC対応web seedという**候補種別を数える**のではなく、実際にbrowserが接続できたWebRTC peerを`torrent.numPeers`で数える。

| 条件                             | 動作                                             |
| -------------------------------- | ------------------------------------------------ |
| WebRTC非対応                     | 接続を開始しない。local file Playerを案内する    |
| 接続済みpeerが0（30秒以内）      | 接続確認中を表示し、ファイル一覧や再生は出さない |
| 接続済みpeerが0（30秒超過）      | peer不足エラー。torrent sessionをdestroy         |
| 接続済みpeerが1以上              | torrent内容の判定へ進む                          |
| peer不足 / tracker失敗 / no-peer | torrentをdestroyし、エラーを表示する             |

**Peer gate deadline:** torrent metadata取得後に30秒のpeer gate timerが開始する。この時間内に`numPeers >= 1`に到達しない場合、`PEER_INSUFFICIENT` codeでdestroyし、正確なpeer不足copyを表示する。

peer数は「その瞬間に接続できた共有相手」の数であり、3つの**完全seed**や特定pieceの保有を保証しない。開始後にpeerが減った時は再生を壊さずbuffering状態として表示する。

peer不足時のcopy:

| Locale | 表示文                                                                             |
| ------ | ---------------------------------------------------------------------------------- |
| id     | `Maaf, jumlah pembagi file ini tidak mencukupi. Coba magnet URI lain.`             |
| ja     | `すみません、そのファイルの共有者数が足りません。別のmagnet URIを試してください。` |
| en     | `Sorry, this file does not have enough sharers. Try another magnet URI.`           |

### 2.3 torrent内容の決定

| torrent内容        | 動作                                                     |
| ------------------ | -------------------------------------------------------- |
| 再生可能mediaが0本 | mediaなしエラー。torrent sessionを破棄                   |
| video/audioが1本   | 直ちにmediaをstreamする。Subtitle panelは既存empty state |
| video/audioが複数  | WT-1では停止し、WT-2の内容選択を案内する                 |

- media候補は現在の`media-url.ts`のadmission matrixを正とする。torrentだから対応formatを広げない。
- torrent内字幕の取得・既存`subtitle-reader`への受渡しはWT-2の範囲。WT-1では右Panelの既存字幕file pickerを使う。
- browser codecが非対応なら、torrent接続が成功しても既存のdecode errorを表示する。torrent containerをbrowser内変換しない。

### 2.4 再生開始

WebTorrentのService Worker serverを起動し、選択されたfileの公開`streamURL`を既存のvisible `<video>` / `<audio>`へ渡す。

- 完全downloadを待たず、browserのrange requestに応じて必要pieceを取得する。
- seekは既存Playerのseek sliderを使う。必要なpieceの取得待ちはbuffering UIで表現する。
- sessionの停止、media変更、page leave、unmountではtorrent / Worker communication / object URL相当の参照を確実に破棄する。
- 新規Service Workerが5秒以内に現在のtabをcontrolできない場合は、spinnerを無期限に残さず、再読み込みして再試行する3言語copyを表示する。

---

## 3. 現在の園庭からのアーキテクチャ

現在の`/player/`は`client:only="react"`のbrowser-only islandであり、WebRTC、Service Worker、media APIをSSRへ持ち込まずに追加できる。WT-1では`webtorrent`とService Workerをこのbrowser境界に追加した。

```text
PlayerApp
├── LocalMediaSession（現在）
│   └── File → blob URL → <video>/<audio>
└── TorrentMediaSession（WT-1で追加）
    ├── magnet URI → WebTorrent client
    ├── Service Worker stream server
    ├── peer / progress / buffering state
    ├── WT-2: torrent file selection
    └── stream URL → 同じ <video>/<audio>
```

`PlayerApp`は「local fileかtorrentか」の入口だけを分け、字幕表示、caption mode、row Mine、Mining Preview、Anki exportは既存経路を再利用する。torrent専用の第2 Playerや第2 Mining flowは作らない。

---

## 4. 段階実装

### WT-1 — 接続とstreaming最小版

1. `npm install webtorrent`で依存を追加する。
2. 園庭origin上でWebTorrent公式browser ESM bundleをraw static assetとして配り、Service Workerをregisterする。
3. magnet inputとWebRTC support / peer count / tracker error UIを作る。
4. `numPeers >= 1`を通過したtorrentだけから、1本のmediaの公開`streamURL`を既存Playerへ渡す。
5. local mediaへ切り替えた時にtorrentを停止・破棄する。

**実機確認済み:** 公式Sintel magnetで5 WebRTC peerを確認し、単一`Sintel.mp4`の再生開始と14:48動画の途中再生をChromiumで確認。

**残留gate:** pause / seek / media切替 / 0 peer copy / page leave cleanup / production browser。

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

IMMERSION_TRACKER v1はlocal fileだけを対象とし、WebTorrent再生を計測しない。将来WebTorrent trackingを設計する場合も、Tracker IndexedDB（Mining archiveを含む）とtorrent piece cacheは別物として維持する。

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

**WT-1 コードコンプリート:** `webtorrent`公式browser ESMをraw static assetとしてVite dev / static buildの両方で配信し、Service Workerのcontrol確立後にbrowser stream serverを開始する。937 tests、astro check 0 errors、static build成功。

**実機確認済み:** Chromiumで公式Sintel magnetが5 WebRTC peerに到達し、Service Worker経由で`Sintel.mp4`（14:48）を実再生した。1つのWSS tracker失敗は他tracker経由のpeer接続と再生を止めなかった。

**残留gate:** 以下は未確認または後続WTの範囲:

| ケース                   | 確認すること                                             |
| ------------------------ | -------------------------------------------------------- |
| WebRTC非対応             | 接続しない、local fallback copy                          |
| 0 peer（30秒超過）       | peer不足エラーcopy、session破棄                          |
| 1 peer以上 + media 1本   | ✅ ChromiumでSintel.mp4を実再生                          |
| media/subtitle複数       | WT-2: Modalで選んだものだけ使用                          |
| seek                     | 該当区間をbufferし、既存subtitleとMineの時刻が一致       |
| peer離脱                 | 再生停止ではなくbuffering / recovery表示                 |
| media切替 / page leave   | torrent destroy、通信とWorker参照のcleanup               |
| privacy                  | peer通信 / uploadの事前説明と明示開始操作                |
| Service Worker streaming | ✅ localhost Chromiumで`file.streamURL` + SWが動画を返す |
| GitHub Pages初回訪問     | 新規Service Worker登録直後のtab controlとstreaming       |
| Worker control timeout   | 5秒後に無期限spinnerではなく再読み込み案内を表示         |

---

## 7. 根拠（historical）

| 事実                                                                                      | 根拠                                                                                                 | 意味                                                     |
| ----------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| original Phase 3はWebTorrent→字幕→buffer→IndexedDB→PWAの順                                | `園庭プロジェクトの書き下ろし.md:560-565`                                                            | peer streamingをlocal Playerの後段として追加する         |
| `/player/`はbrowser-only React island                                                     | `apps/web/src/pages/player/index.astro:14-15`                                                        | WebRTC / Service WorkerをSSRから隔離できる               |
| static GitHub Pages向け構成                                                               | `apps/web/astro.config.mjs:13-25`                                                                    | Service Workerをstatic assetとしてhostでき、serverは不要 |
| WebTorrent browser streamingはService Worker + `createServer()` + `file.streamTo()`が必要 | [WebTorrent公式API](https://webtorrent.io/docs)                                                      | package追加だけではstreamingにならない                   |
| browser版はWebRTC peerだけに接続                                                          | [WebTorrent公式 Get Started](https://github.com/webtorrent/webtorrent/blob/HEAD/docs/get-started.md) | 通常BitTorrent seedだけのmagnetは受入対象にできない      |
| 動画は完全download前に再生・seekでき、必要pieceをon-demand取得する                        | 同公式Get Started                                                                                    | WT-3はon-demandを基礎にしてから優先bufferを足す          |
| local-only copyはWebTorrent前に再レビューする                                             | `docs/PHASE0.md:632,652`                                                                             | peer通信を隠してlocal-onlyとは言わない                   |

通常BitTorrent swarmをWindows / Termuxのlocalhost companionから扱う後継案は[EizouDendenshi](./EIZOU_DENDENSHI.md)を参照する。browser-only WT-1/WT-2を置き換え、WebRTC非対応magnetを含む手入力sourceの別boundaryとして扱う。
