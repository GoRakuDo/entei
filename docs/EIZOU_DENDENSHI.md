# EizouDendenshi — validated local companion plan

> **状態:** 設計検証済み・未実装。実装開始は下記PoC checkpointを通過してから。
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
| 正式target      | Windows x64、Android / Termux arm64                                                                                                        |
| 導入            | platform別の署名済みreleaseを初回commandが取得・検証し、そのまま起動してpairing codeを出す                                                 |
| release検証     | launcherへ固定したMinisign公開鍵でassetとmanifestを検証する                                                                                |
| 更新            | release manifest内のcore / yt-dlp / torrent engine versionを固定する。yt-dlp単体の自動更新はしない。更新は新しいEizouDendenshi releaseのみ |
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

1. [`WEBTORRENT_STREAMING.md`](./WEBTORRENT_STREAMING.md) のWT-1はbrowser WebRTC peerだけを対象にする。通常TCP/uTP BitTorrent swarmはbrowserだけでは接続できない。EizouDendenshiはこの不足を端末内のtorrent clientで補う。
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
2. `Magnet URI`: 既存Magnet dialogのvisual shellを再利用し、magnet URI fieldを出す
3. `YouTube`: Lucide `Youtube` iconの新button。同じdialog shellを再利用し、YouTube URL fieldへ切り替える

browser WebTorrentのMagnet dialogをそのままconnection UIとして残してはいけない。dialogはEizouDendenshiの共通source entryへ名前とsubmit contractを切り替える。

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
- pairing前・tokenなし・Origin不一致のstate-changing requestは拒否する。
- Default CookieはWindowsではDPAPI、AndroidではTermux app-private storageで保持する。cookie値、YouTube URL、authorization headerをlog / analytics / crash reportへ出さない。
- Enteiはcookie file、cookie内容、media Blob、magnet、source URLをIndexedDB / localStorageへ保存しない。
- Default Cookieの置換と削除は明示操作にする。削除はcompanion側の保存値も消す。
- session mediaは正常終了、stop、Cancel、error、companion shutdownで削除する。削除失敗は次回起動時cleanup queueで再試行する。

## Delivery contract

各releaseはplatformごとにversion固定のmanifestを持つ。

| platform               | artifact                                                | installer responsibility                  |
| ---------------------- | ------------------------------------------------------- | ----------------------------------------- |
| Windows x64            | Windows companion binary + pinned helper set            | Minisign検証、user-scoped install、即起動 |
| Android arm64 / Termux | Termux companion binary + validated helper/runtime path | Minisign検証、Termux環境検査、即起動      |

core、yt-dlp、torrent engineのversionはrelease manifestへ固定する。YouTube側の変更で更新が必要な時は、新しいEizouDendenshi releaseをMinisign署名で配布する。起動時のsilent self-updateはしない。

## Required PoC checkpoints

この5つは実装の前提。どれかが失敗したら、full implementationへ進まず設計を戻す。

1. **Cross-origin loopback:** Windows ChromeとAndroid Chromeから、HTTPS Entei / localhost devの両方でpairing済み`127.0.0.1` APIを呼べる。CORS・mixed-content・preflightを実測する。
2. **CORS-clean media:** companionのRange responseを既存`<video>`へ渡し、canvas screenshot / Video Clip / audio miningがtaintなしで動く。`Range`、`Content-Range`、origin header、`crossOrigin`を実機確認する。
3. **YouTube cookie path:** user-uploaded Netscape cookie fileで最大1080p videoを取得し、手動日本語→自動日本語のfallbackと「字幕なしvideo」を検証する。cookie削除・job失敗・cancel後にcookieをlog / browser storageへ残さない。
4. **Forward torrent:** public regular BitTorrent swarmで冒頭再生、未取得後方seek時のbuffer、順方向piece到達後のresume、stop後のmedia cleanupをWindows / Androidで確認する。
5. **Delivery:** Minisign不一致releaseを拒否する。Windows x64 / Termux arm64でclean install→自動start→pairingを実測する。

## Staged delivery

| Stage | 内容                                                                                                                                           | hard gate                                                                            |
| ----- | ---------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| ED-0  | この設計書・既存WebTorrent文書をwithdrawal planへ同期                                                                                          | documentation review                                                                 |
| ED-1  | browser WebTorrent runtime、Service Worker、dependency、browser peer UIを撤去する。Magnet dialogはreusable visual shellとしてadapter依存を外す | browser WebTorrent code / dependency / testが残らない。未接続source submitを作らない |
| ED-2  | Windows x64 / Termux arm64のloopback、Range、CORS-clean media、Minisign delivery PoC                                                           | Required PoC checkpoints 1, 2, 5                                                     |
| ED-3  | 3-button source entry、共通Magnet / YouTube dialog、shadcn Input OTP pairing、Default Cookie modalを実装                                       | pairing済みlocalhost companionとの実機接続                                           |
| ED-4  | YouTube source / Japanese subtitle、forward torrent file selection / buffer / cleanupを順に接続                                                | Required PoC checkpoints 3, 4                                                        |

ED-1からED-3の間は、Magnet / YouTube buttonを見せて送信先のないplaceholderにしない。source entry UIはED-3でcompanionと同時に有効化する。

## Deferred

- 未取得seek位置を最優先に取得するpiece priority engine
- 1080p以外のquality selector
- named multiple cookie profiles
- persistent media cache / offline download library
- cookie自動import、browser session直接読取り、root-only mode
- torrent upload policy / seeding controls beyond client default
- PGSやYouTube独自XML字幕formatのreader対応

## Browser WebTorrent withdrawal

現在のWT-1はbrowser WebRTC peerだけを対象にしている。EizouDendenshiをregular BitTorrent / YouTubeのlocal companionとして採用するため、browser WebTorrentを拡張しない。

- ED-0時点ではWT-1 codeはまだrepositoryに残る。実装済みと誤認して新機能を追加しない。
- ED-1で`webtorrent` dependency、browser ESM bundle、Service Worker、adapter / types、browser peer lifecycle、WT-specific tests / i18nを撤去する。
- Magnet dialogのvisual shellだけはED-3のcommon source dialogに再利用する。browser WebTorrent endpointやpeer gateは再利用しない。
- [WEBTORRENT_STREAMING.md](./WEBTORRENT_STREAMING.md)はhistorical withdrawal recordとして残し、browser WT-2以降は実装しない。

## Readiness verdict

**Ready with checkpoints.**

product boundary、platform target、credential lifecycle、release検証、YouTube字幕、torrentのforward-only seek contractは決定済み。一方、Android / Windowsのloopback CORS、growing Range mediaとcapture API、Termuxでversion固定helperを配布する実現性はまだ実証されていない。最初にPoCだけを独立して通す。

## Next action

`EizouDendenshi`のrepository / runtimeを作る前に、Cross-origin loopback + CORS-clean mediaの小さなWindows / Android PoCを作り、既存Entei Playerのcapture機能がlocalhost streamでも維持されるかを確認する。
