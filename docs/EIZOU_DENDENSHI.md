# EizouDendenshi — validated local companion plan

> **状態:** ED-1完了、ED-2A/ED-2BのWindows / Android Chrome manual QA完了、ED-2CのTermux runtime smoke完了。ED-2D Stage A（release delivery tooling: release helper / Termux bootstrap template / 自動test harness）実装済み・harness 66/66 green。**ED-2D Stage B（clean Termux aarch64 gate）は2026-07-31に`eizoudendenshi-v0.2.0-rc.2` pre-releaseで通過済み**（rc.1の302 redirect不追従はrc.2のfetch修正で解決。rc.1自体はgate未通過）。**release identity表示不整合（rc.2: manifest 0.2.0-rc.2 vs banner `EizouDendenshi ED-2B (0.2.0)`）はツーリング修正（`scripts/release.ps1`がvalidated `-Version`を両release binaryへlink time注入、Go + harnessテストでdev default `0.2.0` / banner契約 / manifest-banner一致を固定）の上、`eizoudendenshi-v0.2.0-rc.3`で2026-07-31に実機検証済み** — Termuxでmanifest署名・core署名・signed manifestに対するSHA-256・app-private installがPASSし、foreground bannerが`EizouDendenshi ED-2B (0.2.0-rc.3) listening on http://127.0.0.1:36441`を表示（manifest versionと一致、rc.2の表示不整合はclosed）。**ED-2C growing-media Range contractはWindows / Termux loopbackで通過済み（2026-07-31・実companion binary実測、`503`/`Retry-After` bufferingで未available byteを返さないことを確認）**。**deliveryは未完了**: HTTPS Entei origin・growing mediaの実Chrome progressive再生・audio listening/decode・Windows x64 installerが残っている。
> **Readiness:** Ready with checkpoints

## Outcome

Android Termux（arm64）とWindows CMD（x64）で同じEizouDendenshi local companionを起動し、Enteiへ次の手入力sourceを渡せるようにする。

- YouTube URL: 最大1080pのlocal streamと日本語字幕
- magnet URI: 通常BitTorrent swarmからの前方再生優先stream

Enteiは静的・local-firstのまま。source URL、cookie、media dataをGoRakuDo serverへ送らない。

## Confirmed decisions

| 項目            | 決定                                                                                                                                       |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| companion名     | `EizouDendenshi`                                                                                                                           |
| core runtime    | Go standard library。localhost API、pairing、Range bridge、cleanupを担い、yt-dlp / torrent engineは将来のversion固定helperとして呼ぶ       |
| 正式target      | Windows x64、Android / Termux arm64                                                                                                        |
| 導入            | platform別の署名済みreleaseを初回commandが取得・検証し、そのまま起動してpairing codeを出す                                                 |
| release検証     | launcherへ固定したMinisign公開鍵でassetとmanifestを検証する                                                                                |
| 更新            | release manifest内のcore / yt-dlp / torrent engine versionを固定する。yt-dlp単体の自動更新はしない。更新は新しいEizouDendenshi releaseのみ |
| source配置      | Entei repositoryの`companion/eizoudendenshi/`をcanonical source rootにする。`scripts/`はbuild / release補助だけに使う                      |
| 接続            | `127.0.0.1`だけでlisten。初回pairing code + Entei origin allowlist + local capability token                                                |
| YouTube cookie  | Enteiの初回YouTube URL入力時、Default Cookie未登録なら`cookies.txt` upload modalを出す。upload直後に保存し、同じjobを直ちに開始する        |
| cookie profile  | Default 1個。新uploadは確認後に置換。削除は1操作                                                                                           |
| cookie保存      | Windowsはuser-scoped DPAPI。AndroidはTermux app-private storage。Enteiにはcookie本体を保存しない                                           |
| YouTube画質     | 最大1080pに固定。初期版にquality selectorは作らない                                                                                        |
| YouTube字幕     | 日本語手動字幕を最優先、なければ日本語自動字幕。どちらもなければvideoだけ開く                                                              |
| torrent開始     | 前方再生優先。未取得の後方seekはbuffer表示でpauseし、順方向downloadが到達したら再開                                                        |
| torrent複数file | Enteiの一覧Modalでvideo 1本と任意subtitle 1本を選ぶ                                                                                        |
| media retention | job終了・stop・Cancel・失敗時にsession mediaを全削除。persistent media cacheなし                                                           |

## Territory findings

1. [`WEBTORRENT_STREAMING.md`](./WEBTORRENT_STREAMING.md) のWT-1はbrowser WebRTC peerだけを対象にしていた。通常TCP/uTP BitTorrent swarmはbrowserだけでは接続できない。EizouDendenshiはこの不足を端末内のtorrent clientで補う。
2. aria2公式はBitTorrent downloadと`--stream-piece-selector=inorder` / `geom`を提供する。一方でmedia HTTP serverやseek地点へのon-demand piece priorityは提供しない。companionのRange bridgeが必要になる。
3. yt-dlp公式はformat URL、request header、stdout出力、Netscape cookie file（`--cookies`）を扱えるが、HTTP streaming serverではない。companionがupstream取得とlocalhost Range responseを担う。
4. Androidのapp sandboxはTermuxからChromeのprivate cookie DBを読ませない。したがって`--cookies-from-browser`を共通契約にせず、両platformでユーザー選択の`cookies.txt`を使う。

## Source boundary

### Included

- Enteiでユーザーが明示入力したYouTube URL / magnet URI
- `127.0.0.1`上のcompanion APIとmedia stream
- user-selected Netscape-format `cookies.txt`
- yt-dlpによる最大1080p source取得、字幕候補の検出
- torrent metadata / file list、aria2前方piece download

### Permanently excluded

- browser extension、active tab検知、site DOM注入、host permission
- browser session / Chrome cookie DBの自動読取り
- tab capture、streaming site上のoverlay、site固有adapter
- LAN / public IPへのlisten、GoRakuDo proxy、remote media cache
- persistent media cache、cookieやURLを含むtelemetry / log

手入力sourceをlocalhostへ渡すだけなので、既存の「Streaming Video Integrationを除外する」境界は維持する。

## Entei source entry UI

EizouDendenshiがPoCを通過してから、Player empty stateは次の3つの入口を並べる。

1. `Pilih Media`: 既存local file picker
2. `Magnet URI`: ED-1のMagnet dialog visual shellを表示し、magnet URI fieldを出す
3. `YouTube`: Lucide `Youtube` iconの新button。同じ共通source dialogへ切り替えてYouTube URL fieldを出す

ED-1のMagnet dialogはvisual shellのみで、submit時にEizouDendenshi未接続の案内を表示する。ED-3で共通source entry dialogへ切り替え、browser WebTorrent endpointやpeer gateは再利用しない。

### Pairing UI

source submit前にcompanionがunpairedなら、同じdialog flow内でpairing codeを求める。code入力はshadcn `InputOTP`を使う。

- `InputOTP`、`InputOTPGroup`、`InputOTPSlot`を使う
- clipboard pasteとkeyboard focus移動を標準挙動として保つ
- invalid codeは`aria-invalid`で示し、cookie / source URLをerror文へ含めない
- component追加は実装時に`npx shadcn@latest add input-otp`で行う。package.jsonを手編集しない

Pairing成功後だけ、現在入力済みのmagnet / YouTube URLをcompanionへ送る。unpaired状態でsource jobを黙って開始しない。

## UX flow

### First install and pairing

1. ユーザーがWindows CMDまたはTermuxでplatform別の一発install commandを実行する。
2. launcherはrelease asset / manifestのMinisign署名を検証する。
3. EizouDendenshiが`127.0.0.1`で起動し、pairing codeをterminalへ表示する。
4. EnteiのCompanion接続UIへcodeを一度入力する。
5. companionはEntei originだけを許可するlocal capabilityを発行する。browser storageを消した時やcompanion側credentialをresetした時は再pairingする。

### YouTube

1. ユーザーがYouTube URLをEnteiへ貼る。
2. Default Cookieがなければ`cookies.txt` modalを直ちに表示する。
3. Enteiは選択fileをpair済みlocalhost APIへ送る。file本体をブラウザーstorageへ書かない。
4. companionはDPAPI / Termux private storageへDefault Cookieを保存し、現在のjobを開始する。
5. companionは最大1080p sourceを取得し、手動日本語字幕、次に自動日本語字幕を解決する。
6. Enteiはlocalhost stream URLを既存Playerへ渡す。日本語字幕がなければ既存empty subtitle stateを表示する。

### Torrent

1. ユーザーがmagnet URIをEnteiへ貼る。
2. companionがmetadataとfile一覧を返す。
3. 複数fileならEnteiがvideo 1本と任意subtitle 1本の選択Modalを出す。
4. aria2は前方pieceを優先してdownloadし、companionは既取得byte範囲だけRange responseする。
5. 未取得位置へのseekはEnteiがbuffer animationとpauseを表示する。順方向downloadがその位置へ届いた時だけ再開する。

## Security and data contract

- listenerは`127.0.0.1` / loopbackだけ。`0.0.0.0`、LAN、tunnelは使わない。
- CORSは`https://entei.gorakudo.org`と開発用`http://localhost:4321`だけを明示許可する。`*`は使わない。
- Android ChromeのLAN DevTools QAでは、そのruntime固有の明示origin（例: 開発機のLAN dev-server origin）を`--allow-origin`でprocess起動時に一時追加する。これは開発専用オーバーライドであり、release allowlistのエントリには**絶対に追加しない**。値はメモリ内のみで永続化しない。
- pairing前・tokenなし・Origin不一致のstate-changing requestは拒否する。
- Default CookieはWindowsではDPAPI、AndroidではTermux app-private storageで保持する。cookie値、YouTube URL、authorization headerをlog / analytics / crash reportへ出さない。
- Enteiはcookie file、cookie内容、media Blob、magnet、source URLをIndexedDB / localStorageへ保存しない。
- Default Cookieの置換と削除は明示操作にする。削除はcompanion側の保存値も消す。
- session mediaは正常終了、stop、Cancel、error、companion shutdownで削除する。削除失敗は次回起動時cleanup queueで再試行する。

## Delivery contract

各releaseはplatformごとにversion固定のmanifestを持つ。一般ユーザーはTermux APKを入れた後、1つのbootstrap commandだけを実行する。Go compilerはQA / 開発用であり、一般ユーザーへ導入しない。

| platform               | artifact                                    | installer responsibility                                               |
| ---------------------- | ------------------------------------------- | ---------------------------------------------------------------------- |
| Windows x64            | Minisign署名済みcore binary                 | signature / manifest検証、user-scoped install、即起動                  |
| Android / Termux arm64 | Minisign署名済み`android/arm64` core binary | Termux確認、bootstrap dependency導入、signature / manifest検証、即起動 |

### Termux general-user bootstrap

**ED-2D Stage A** のbootstrap template（`companion/eizoudendenshi/scripts/termux-bootstrap.sh`）はTermux上で次を順に行う。実装は済み、**clean Termux実機でのgate（Stage B）は2026-07-31に`eizoudendenshi-v0.2.0-rc.2`で通過済み**（実測記録は後述の[「ED-2D Stage B gate 実測記録」](#ed-2d-stage-b-gate-実測記録2026-07-31-eizoudendenshi-v020-rc2)）。

1. Termux環境と`aarch64`を確認する（実Termux prefix、Linux、aarch64、`pkg`存在）。
2. verifier / download前提のみ（`minisign`・`curl`・`coreutils`）をTermux公式repoから導入する。
3. release base URL（明示入力・**HTTPS限定**）からrelease manifestを取得し、bootstrapへ固定したMinisign公開鍵で**manifest署名**を検証する。未固定のtemplate（`REPLACE_ME...`）はfail closed。
4. manifestを検証する（format / formatVersion / version / helper contract / `android/arm64` artifact）。helper contractがこのtemplateの対応範囲（v1・helper要求なし）と厳密一致しないmanifestは**install前に拒否（fail closed）**。helper（`python-yt-dlp`等）は本templateでは導入しない。
5. `android/arm64` core binaryの**署名**と、signed manifestに対する**SHA-256**を検証してから、検証済みcoreをTermux app-private storage（`$PREFIX/var/lib/eizouden`）へatomicに置き、pairing codeを表示してforeground起動する。全downloadはprivate temp dir（mode 700、exit時cleanup）経由。
6. `termux-wake-lock`要求は **Stage B以降の項目**として延期した。実装時もAndroidのbattery unrestricted / wake-lock許可はOS画面でユーザーが承認する必要があり、silentに迂回しない。

release assetはGitHub Release assetとして配布され、そのURLは**302 redirect**（release CDNへ）を返す。bootstrapのfetchはcurl `--location`でredirectを追い、`--max-redirs 5`で上限を固定し、`--proto-redir =https`でredirect先もHTTPSのみに制限する（fail-closed維持）。redirectを追わないcurlは302の応答bodyをそのまま保存するため、続くMinisign検証が必ず失敗する — rc.1のTermux clean-installで実証済み、rc.2のclean Termux gate（2026-07-31）でredirect追随経路の通過を実証済み。test harnessはこの契約をstatic checkで固定している（`scripts/test-release.ps1`）。

core binaryはMinisignで**厳密にversion固定**する。将来のYouTube / torrent helperはTermux公式repoから導入し、release manifestのhelper contractで最低versionを検査する（helper要求のあるmanifestは現行templateが拒否するため、導入機能はhelper対応stageで追加する）。Termux repoのcurrent packageを使うためhelperを完全固定したrelease assetとしては扱わない。yt-dlp側の互換性変更が必要になった時は、新しいEizouDendenshi releaseで必要最低version / 導入条件を更新する。起動時のsilent self-updateはしない。

最初のbootstrap command自身はMinisign verifierの導入前に実行されるtrust bootstrapである。`curl | sh`で未検証remote shellを実行する形にはせず、公開鍵を含む短いcopy-paste commandとして配布する。

### ED-2D Stage B gate 実測記録（2026-07-31, `eizoudendenshi-v0.2.0-rc.2`）

**PASS（Android / Termux arm64）:** GitHub pre-release `eizoudendenshi-v0.2.0-rc.2`をfresh Termux reinstallで実施。bootstrapはGitHub releaseから全物を取得し、以下をすべて確認した。

- release manifestのMinisign検証 **PASS**、`android/arm64` core binaryのMinisign検証 **PASS**、signed manifestに対するSHA-256検証 **PASS**。
- 検証済みcoreが`/data/data/com.termux/files/usr/var/lib/eizouden/eizouden-android-arm64`へinstallされ、foreground起動でpairing codeを表示した。
- SSHでinstall済みbytes=6291752、SHA-256=`d4cf15b544cffbaf60b1f1a35b8d0751436ef6456edca3a31e921fd9f15046b7`を確認し、GitHub asset digestと一致。`eizouden-bootstrap`のtemp dir残存は0。
- rc.1の302 redirect不追従はrc.2で修正済み。**rc.1自体はgateを通過していない**（fail-closedの順序のみ実証された）。

### ED-2D Stage B gate 実測記録（2026-07-31, `eizoudendenshi-v0.2.0-rc.3` — release identity表示修正の実機検証）

**PASS（Android / Termux arm64）:** GitHub pre-release `eizoudendenshi-v0.2.0-rc.3`のbootstrapで以下を確認した。

- release manifestのMinisign検証 **PASS**、`android/arm64` core binaryのMinisign検証 **PASS**、signed manifestに対するSHA-256検証 **PASS**、app-private install成功。
- foreground bannerが`EizouDendenshi ED-2B (0.2.0-rc.3) listening on http://127.0.0.1:36441`を表示し、**banner versionがmanifest versionと一致**。rc.2で確認された表示不整合（manifest `0.2.0-rc.2` vs banner `EizouDendenshi ED-2B (0.2.0)`）はclosed。

**rc.2の表示不整合の修正経緯:** rc.2ではmanifest / release versionが`0.2.0-rc.2`なのにbinary bannerが`EizouDendenshi ED-2B (0.2.0)`を表示していた。署名・install・pairing gateを無効化しないが、GA前に修正が必要だった表示不整合は、**`scripts/release.ps1`がvalidated `-Version`を両binaryへlink timeに注入するbuild-time version injectionでツーリング側を修正**し（Goテストでdev default `0.2.0`とbanner契約を固定、test harnessでstartup bannerがrequested release versionを表示しmanifest versionと一致することを検証）、上記`rc.3`の実機検証（2026-07-31）でclosed。

**残りのdelivery gate:** HTTPSでdeployされたEntei origin、growing mediaの実Chrome progressive再生、audio listening/decode、Windows x64 installer。Stage B（Android / Termux clean install）・release identity表示修正（rc.3）・growing media Range contract（loopback）は通過済み。growing mediaのRange contractは[後述のED-2C節](#ed-2c-growing-media-range-pocloopback通過済み実chrome未検証)でWindows / Termux loopback実測済み。

## ED-2C growing-media Range PoC（loopback通過済み・実Chrome未検証）

download中など**成長中のメディア**（known total + available prefix）に対する明示的で安全なHTTP contractを、downloaderなしで確立するPoC。`internal/media`のsource抽象で、available byte数を時間経過とともに増やせる決定的fixture（`MemSource`）と、実際の追記ファイルを裏に持つ`FileSource`を提供する。**契約はWindows / Termux loopbackで実companion binaryにより実測済み（2026-07-31）**。実Chrome / 端末でのprogressive再生計測は別gateとして必要（完了は主張しない）。

### source抽象（`internal/media`）

- `GrowingSource`: `Total()`（既知の最終サイズ）+ `Available()`（現在のavailable byte数、`0 <= n <= Total`）+ `ReadAt`（呼出時点のavailabilityを超えるbyteは返さない）。
- `MemSource`: 決定的インメモリfixture。`SetAvailable`でavailabilityを進める（monotonic・append-onlyの形。downloader不要）。
- `FileSource`: CLI用のファイル裏付けsource。`Stat`による現在サイズがavailable、`--grow-total`が最終サイズ。writerはappend-only前提（truncate / 書換は契約外）。

### HTTP contract（`--grow-fixture`使用時の`/v1/media/fixture`）

| 条件 | 応答 |
|---|---|
| GET/HEAD・Rangeなし・`Available == Total` | `200` 全body、`Content-Length: Total` |
| GET/HEAD・Rangeなし・`Available < Total` | `503` + `Retry-After: 1`、JSON body |
| `[0, Available)` 内に完全に収まるRange | `206` 厳密window、`Content-Range: bytes a-b/Total` |
| `Available` を跨ぐ/越えるRange（start `< Total`） | `503` + `Retry-After: 1`、JSON body |
| `Total` 以降から始まるRange | `416`、`Content-Range: bytes */Total`（恒久的のみ） |
| 不完全時のsuffix range（`bytes=-n`） | `503`（最終表現の末尾n byteを指すため必然的にunavailable） |
| 不正 / 非`bytes` / 複数Rangeヘッダ | 無視（Rangeなし扱い。multipartは対象外） |

503 bodyはmetadataのみ（path / token / pairing dataは一切含めない）:

```json
{"error":"buffering","available":100,"total":2048}
```

全応答で`Cache-Control: no-store`、`Accept-Ranges: bytes`、`Access-Control-Expose-Headers: Content-Range, Accept-Ranges, Content-Length, Retry-After`。HEADはGETのstatus / headersをbodyなしでmirrorする。

### なぜ`503 + Retry-After`か（tradeoff）

- **truncated `206`**（windowのavailable分だけ返す）: playerが不完全bodyを実ファイルと誤認＝破損。禁止。
- **not-yet-availableに`416`**: `416`は*恒久*不満足の意味論で、client / cacheがfinal扱いする恐れ。`start >= Total`（本当に永久）のみ`416`とする。
- **`200` + available prefix / zero-byte成功**: `Content-Length < Total`で完全性を偽装。禁止。
- **availableまでrequestをblock**: connection / handlerを無期限占有し、HTTPとして「まだ」の回答にならない。禁止。
- **`425 Too Early`**: early data用の別意味論・対応が乏しい。不採用。

`503` + `Retry-After`は標準の「後で再試行」シグナルで、JSON bodyの`available` / `total`によりEntei側が再試行判断（progressからのbackoff算出など）ができる。`Retry-After: 1`はPoC固定値（将来downloader裏付けsourceでprogressから算出可能）。

### 実測記録（2026-07-31、Windows / Termux loopback）

同じ決定的growing-fileシナリオを**実companion binary**でWindows loopbackとTermux（Android/arm64）loopbackの両方で実行した。fixtureはtotal 200・初期available 100、token / origin gateは満たした状態。両platformで同一結果:

| リクエスト | 応答 |
|---|---|
| `Range: bytes=0-49` | `206`、`Content-Range: bytes 0-49/200`、body 50 byte |
| `Range: bytes=0-150`（availability跨ぎ） | `503`、`Retry-After: 1`、50 byteの安全なJSON buffering body（media byteなし） |
| `Range: bytes=100-150`（完全にunavailable） | 同様の`503` + `Retry-After: 1` — **`416`ではない** |
| 200 byteまで追記後 `Range: bytes=0-150` | `206`、`Content-Range: bytes 0-150/200`、body 151 byte |
| `Range: bytes=200-` | `416`、`Content-Range: bytes */200`、bodyなし |

計測後、一時server / binary / fixtureは両platformで削除し、Termuxのwake lockは解放した。

Goテストは契約全体（境界exact end・跨ぎ・完全unavailable・suffix・`416`は恒久のみ・HEAD mirror・不正Range無視・secrets非漏洩）と、availabilityが並行変化する決定的テストをカバーし、`go test -race ./...` green。**`503`-vs-`416` safety contractは実機で成立**: `start >= Total`のみ`416`で、跨ぎ / 完全unavailableは常に明示的retryable `503` — truncated `206` / zero-byte偽成功 / blockは一切ない。

### TOCTOU

`Available()`は**リクエスト毎に1回だけ**snapshotし、served windowはそのsnapshotから導出して決して跨がない。加えてsource自身が`ReadAt`で境界を強制し、availabilityはmonotonic（append-only契約）— 並行writerがunavailable byteを配信することは構造的に不可能。エラー応答 / logにdisk pathは出ない。

### 未実装（PoC境界）

- downloaderなし（yt-dlp / aria2 / ffmpegのinstall・実行・呼出なし）。
- 実Chromeでのprogressive再生・seek policy・production bridgeは未実装・未計測 — loopbackのcontract通過はこれらに**及ばない**。gate完了はWindows / Termuxでの別途**実ブラウザ**計測後にのみ主張する。

## Required PoC checkpoints

この5つは実装の前提。どれかが失敗したら、full implementationへ進まず設計を戻す。

1. **Cross-origin loopback:** Windows ChromeとAndroid Chrome LAN dev originから、pairing済み`127.0.0.1:4322` APIを実測済み。HTTPS Entei本番originはED-2Cで確認する。
2. **CORS-clean media:** Windows ChromeとAndroid Chromeで静的fixtureのRange responseを`<video crossOrigin="anonymous">`へ渡し、canvas `toBlob`、captureStream、MediaRecorderがtaintなしで動くことを実測済み。growing mediaはED-2Cで確認する（**Range contractは2026-07-31にWindows / Termux loopbackで実測通過済み。実Chrome / 端末でのprogressive再生計測は未実施**）。
3. **YouTube cookie path:** user-uploaded Netscape cookie fileで最大1080p videoを取得し、手動日本語→自動日本語のfallbackと「字幕なしvideo」を検証する。cookie削除・job失敗・cancel後にcookieをlog / browser storageへ残さない。
4. **Forward torrent:** public regular BitTorrent swarmで冒頭再生、未取得後方seek時のbuffer、順方向piece到達後のresume、stop後のmedia cleanupをWindows / Androidで確認する。
5. **Delivery:** Minisign不一致releaseを拒否する。Windows x64 / Termux arm64でclean install→自動start→pairingを実測する。**Termux arm64側は2026-07-31にrc.2で通過済み、release identity表示修正はrc.3（2026-07-31）で実機検証済み。Windows x64はinstaller未実装のため未実測。**

## Staged delivery

| Stage | 内容                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | hard gate                                                                                     |
| ----- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| ED-0  | この設計書・既存WebTorrent文書をwithdrawal planへ同期                                                                                                                                                                                                                                                                                                                                                                                                                                  | documentation review                                                                          |
| ED-1  | **完了済み:** browser WebTorrent runtime、Service Worker、`webtorrent` dependency、browser peer UIを撤去。Magnet URI dialogのvisual shellは残し、submit時はEizouDendenshi未接続の案内を表示する（接続は開始しない）。ED-3で共通source dialogへ切り替える                                                                                                                                                                                                                               | browser WebTorrent runtime / dependency / peer testが残らない。接続を偽装するsubmitを作らない |
| ED-2A | **完了済み:** Go stdlibのloopback-only companion skeleton。6桁pairing code、memory-only token、exact CORS、health / pair API、Windows x64 / Android arm64 cross-build                                                                                                                                                                                                                                                                                                                  | Windows / Android cross-build、unit / vet、Mimo review APPROVE                                |
| ED-2B | **完了済み:** token query付き静的fixture Range endpoint。Windows Chromeからpairing、206 Range、exact ACAO、no-store、canvas `toBlob`、captureStream、MediaRecorderを実測                                                                                                                                                                                                                                                                                                               | background server cleanup、fixture削除、Mimo review APPROVE                                   |
| ED-2C | **部分完了:** Termux `go1.26.5 android/arm64`でpure-Go binaryを実行し、background loopback pairing / Range `206` smokeとcleanupを実測。Android Chrome LAN dev originからpair / Range `206` / detached video / canvas `toBlob` / captureStream / MediaRecorderを実測。`--allow-origin`は開発専用でrelease allowlistへ入れない。**growing mediaのRange contractはWindows / Termux loopbackで通過済み（2026-07-31・downloaderなし・`503`/`Retry-After` buffering・実Chrome progressive再生は未検証）**。HTTPS Entei origin、Minisign deliveryは未実装 | Checkpoint 1 / 2のHTTPS部分・growingの実Chrome progressive検証と、checkpoint 5                                         |
| ED-2D | **Stage A 完了・Stage B（Android/Termux arm64）通過済み（2026-07-31）:** `companion/eizoudendenshi/`でrelease helper（`scripts/release.ps1`: windows/amd64 + android/arm64 build、version付きmanifest、detached Minisign署名、keyは明示arg/envのみ）、Termux bootstrap template（`scripts/termux-bootstrap.sh`: HTTPS限定・pinned key fail-closed・Termux/aarch64検証・前提pkgのみ導入・private temp・署名/SHA-256検証後にapp-private atomic install・foreground pairing・helper contract fail-closed・GitHub Release assetの302 redirectを追うfetch）、自動test harness（`scripts/test-release.ps1`: 一時Minisign鍵のみ`A:\Temp\opencode`使用、成功install + release identity（banner version = manifest version / plain buildはdev default維持）+ tampered manifest/binary/missing sig/wrong arch/unsafe URL等のfailure-before-installを66/66 greenで検証）。Windows x64 installerは未実装。**rc.1 clean Termux installでGitHub Release assetの302 redirect不追従を実証→fetch修正済み（`--location` + `--max-redirs 5` + `--proto-redir =https`）→新規immutable rc.2でStage B通過済み（2026-07-31）** | **Stage B（Android/Termux arm64通過済み・2026-07-31・rc.2）: clean Termux aarch64実機でAPK後のbootstrap commandだけからpairing code表示まで到達**（実HTTPS release base・実pinned key・実ELF install + exec・manifest / binary Minisign verify PASS・signed manifestに対するSHA-256 PASS・install bytes 6291752 / SHA-256 `d4cf15b544cffbaf60b1f1a35b8d0751436ef6456edca3a31e921fd9f15046b7`がGitHub asset digestと一致・`eizouden-bootstrap` temp dir残存なし）。rc.1はredirect不追従で失敗（gate未通過）。**release identity表示不整合（rc.2: manifest 0.2.0-rc.2 vs banner `EizouDendenshi ED-2B (0.2.0)`）はツーリング側で修正済み**（`scripts/release.ps1`がvalidated `-Version`を両binaryへlink time注入、Go + harnessテストでdev default / banner契約を固定）**。`rc.3`（2026-07-31）の実機検証でclosed**（banner `EizouDendenshi ED-2B (0.2.0-rc.3)`がmanifest versionと一致）。**delivery完了は主張しない**: Windows x64 installer・HTTPS Entei origin・growing media・audio listening/decodeが残る |
| ED-3  | 3-button source entry、共通Magnet / YouTube dialog、shadcn Input OTP pairing、Default Cookie modalを実装                                                                                                                                                                                                                                                                                                                                                                               | pairing済みlocalhost companionとの実機接続                                                    |
| ED-4  | YouTube source / Japanese subtitle、forward torrent file selection / buffer / cleanupを順に接続                                                                                                                                                                                                                                                                                                                                                                                        | Required PoC checkpoints 3, 4                                                                 |

ED-1のMagnet URI buttonはvisual shellとして表示し、submit時はEizouDendenshi未接続の案内を表示する（送信先のない接続を偽装しない）。source entryの本機能はED-3でcompanionと同時に有効化する。YouTube buttonはED-3まで追加しない。

## Deferred

- 未取得seek位置を最優先に取得するpiece priority engine
- 1080p以外のquality selector
- named multiple cookie profiles
- persistent media cache / offline download library
- cookie自動import、browser session直接読取り、root-only mode
- torrent upload policy / seeding controls beyond client default
- PGSやYouTube独自XML字幕formatのreader対応

## Browser WebTorrent withdrawal

WT-1はbrowser WebRTC peerだけを対象にしていた。EizouDendenshiをregular BitTorrent / YouTubeのlocal companionとして採用するため、browser WebTorrentを拡張せずED-1で撤去した（完了済み）。

- ED-1で`webtorrent` dependency、browser ESM bundle、Service Worker、adapter / types、browser peer lifecycle、WT-specific tests / i18n（runtime / peer系）を撤去した。
- Magnet URI dialogのvisual shellはED-1でも残す。submitはmagnet URIをlocal検証するだけで接続を開始せず、EizouDendenshi未接続の案内を表示する。ED-3で共通source entry dialogへ切り替える。browser WebTorrent endpointやpeer gateは再利用しない。
- [WEBTORRENT_STREAMING.md](./WEBTORRENT_STREAMING.md)はhistorical withdrawal recordとして残し、browser WT-2以降は実装しない。

## Readiness verdict

**Ready with checkpoints.**

product boundary、platform target、credential lifecycle、release検証、YouTube字幕、torrentのforward-only seek contractは決定済み。Windows / Android Chromeの静的fixtureではloopback CORS、Range、canvas capture、MediaRecorderまで実証済み。TermuxではAndroid arm64 binaryのloopback pairing / Range smokeまで通過した。ED-2D Stage Aではrelease helper / Termux bootstrap template / 自動test harnessを実装し、tampered manifest / binary、署名欠落、wrong arch、unsafe URL、helper contract不一致がinstall前に拒否されることを一時鍵で66/66検証した。**rc.1のTermux clean-installでGitHub Release assetの302 redirectを追わないbootstrap不具合が判明**し、fetchを`--location` + bounded `--max-redirs` + HTTPS-only redirectへ修正した。**修正後の`eizoudendenshi-v0.2.0-rc.2`でED-2D Stage B（clean Termux aarch64実機のbootstrap→pairing到達）は2026-07-31に通過済み**（manifest / binaryのMinisign検証・signed manifestに対するSHA-256検証・app-private install・foreground pairing・install bytesとdigestがGitHub assetと一致）。ただしrelease manifest（0.2.0-rc.2）とbinary banner（`EizouDendenshi ED-2B (0.2.0)`）の**release identity表示不整合**を確認した。この表示不整合はツーリング側で修正し（`scripts/release.ps1`がvalidated `-Version`を両release binaryへlink timeに注入、Go + harnessテストでdev default `0.2.0`・banner契約・manifestとbannerの一致を固定）、**`rc.3`（2026-07-31）の実機検証でclosed** — Termuxでmanifest署名・core署名・signed SHA-256・app-private installがPASSし、foreground bannerが`EizouDendenshi ED-2B (0.2.0-rc.3)`を表示してmanifest versionと一致した。HTTPS Entei origin、growing mediaの実機progressive再生、audio listening/decode、Windows x64 installerは未実証 — **delivery完了は主張しない**。growing mediaのRange contractは**ED-2CでWindows / Termux loopback実測通過済み（2026-07-31）**（downloaderなし・`503`/`Retry-After` buffering）。実Chromeでのprogressive再生計測は未実施。

## Next action

ED-2D Stage B（clean Termux aarch64 gate）は2026-07-31に`eizoudendenshi-v0.2.0-rc.2`で通過済み。**release identity表示不整合（manifest 0.2.0-rc.2 vs banner `EizouDendenshi ED-2B (0.2.0)`）の修正はbuild-time version injection（`scripts/release.ps1`のlink time `-Version`注入 + Go / harnessテスト）で実装し、`eizoudendenshi-v0.2.0-rc.3`の実機検証（2026-07-31）でclosed** — Termuxでmanifest署名・core署名・signed SHA-256・app-private installがPASSし、foreground bannerが`EizouDendenshi ED-2B (0.2.0-rc.3) listening on http://127.0.0.1:36441`を表示した。次のactionは、①ED-2C残りのHTTPS Entei origin・growing mediaの実Chrome progressive再生・audio listening/decodeを検証する（growingのRange contractはloopback通過済み、実Chrome計測が残る）、②Windows x64 installerを実装する。その後ED-3のInput OTP / 共通source UIへ進む。
