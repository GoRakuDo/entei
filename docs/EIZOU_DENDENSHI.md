# EizouDendenshi — validated local companion plan

> **状態:** ED-1完了、ED-2A/ED-2BのWindows / Android Chrome manual QA完了、ED-2CのTermux runtime smoke完了。ED-2D Stage A（release delivery tooling: release helper / Termux bootstrap template / 自動test harness）実装済み・harness 66/66 green。**ED-2D Stage B（clean Termux aarch64 gate）は2026-07-31に`eizoudendenshi-v0.2.0-rc.2` pre-releaseで通過済み**（rc.1の302 redirect不追従はrc.2のfetch修正で解決。rc.1自体はgate未通過）。**release identity表示不整合（rc.2: manifest 0.2.0-rc.2 vs banner `EizouDendenshi ED-2B (0.2.0)`）はツーリング修正（`scripts/release.ps1`がvalidated `-Version`を両release binaryへlink time注入、Go + harnessテストでdev default `0.2.0` / banner契約 / manifest-banner一致を固定）の上、`eizoudendenshi-v0.2.0-rc.3`で2026-07-31に実機検証済み** — Termuxでmanifest署名・core署名・signed manifestに対するSHA-256・app-private installがPASSし、foreground bannerが`EizouDendenshi ED-2B (0.2.0-rc.3) listening on http://127.0.0.1:36441`を表示（manifest versionと一致、rc.2の表示不整合はclosed）。**ED-2C growing-media Range contractはWindows / Termux loopbackで通過済み（2026-07-31・実companion binary実測、`503`/`Retry-After` buffering）。Windows Chromeでのgrowing progressive再生も計測済み（2026-07-31・headless Chrome 151、503→error code 4・自動再試行なし・追記のみでは回復せず・明示`load()`+`play()`で206→最後まで再生・reload後seek成功）。** **Android Chromeのgrowing再生は未計測。yt-dlp source job（ED-2F・実download QAは2026-08-01に全面成功）とtorrent job（ED-2G・anacrolix/torrent engine、aria2は全削除）は実装済み。実swarm E2E・headed / Android browser QAは未実施。** **ED-2E buffering bridgeは実装済み（2026-07-31・companion `GET/HEAD /v1/media/status` + Entei bridge controller/hook + Player fixture統合（internal entry・session status UI）+ Go 11 / web 29の自動テストgreen。source dialog UX・`headReady` byte-level検査・production bridge・headed/Android browser QAは未実装/未実施）。** **Persistent pairing credentialは実装済み（2026-08-03・旧page-memory-only契約を置換）** — companion側はopaque tokenをWindows DPAPI / Termux app-private storageへ永続化（`internal/credential`、fail-closed、`GET /v1/pair/status` + `DELETE /v1/pair`新設、pairは200前にpersist）、browser側はopaque tokenだけをlocalStorage envelopeへ保存しmount時にstatus検証、明示reset UI（確認Dialog付きdestructive control）を3 localeで実装。Go（credential + api pairing persist）・web（store + hook + setup reset）の自動テストgreen。**deliveryは未完了**: HTTPS Entei origin・Android Chromeのgrowing再生・audio listening/decode・Windows x64 installerが残っている。
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

> **Historical scope:** このfindingは初期評価（aria2を外部helperとして使う案）の記録。最終設計は外部helperを廃止し、**in-processのanacrolix/torrent engine**（ED-2G・2026-08-02移行完了）を採用した。engineがpiece state・priority・readerを自前で持つため、media HTTP server / on-demand piece priorityの不足はengine内で解消され、aria2依存は全て削除された。
3. yt-dlp公式はformat URL、request header、stdout出力、Netscape cookie file（`--cookies`）を扱えるが、HTTP streaming serverではない。companionがupstream取得とlocalhost Range responseを担う。
4. Androidのapp sandboxはTermuxからChromeのprivate cookie DBを読ませない。したがって`--cookies-from-browser`を共通契約にせず、両platformでユーザー選択の`cookies.txt`を使う。

## Source boundary

### Included

- Enteiでユーザーが明示入力したYouTube URL / magnet URI
- `127.0.0.1`上のcompanion APIとmedia stream
- user-selected Netscape-format `cookies.txt`
- yt-dlpによる最大1080p source取得、字幕候補の検出
- torrent metadata / file list、anacrolix/torrent engineによる選択file download（head bootstrap + verified prefix streaming）

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
2. `Magnet URI`: 実torrent source dialog（ED-2G実装・2026-08-02）— pairing gate → tracker同意 → magnet create → metadata即時file list → video 1本 + subtitle任意選択 → select
3. `YouTube`: Lucide `Youtube` iconのbutton。実URL dialog（ED-2F実装）— pairing gate → URL入力 → job create

ED-1のMagnet dialogはvisual shellのみで、submit時にEizouDendenshi未接続の案内を表示していたが、**ED-2Gで実torrent source dialogへ置き換え済み**（ED-3の共通source entry dialog化はその後も有効なUI整理であり、browser WebTorrent endpointやpeer gateは再利用しない）。

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
5. companionはEntei originだけを許可するlocal capabilityを発行する。**発行されたcredential（opaque token）は、1回の成功pairing後、ユーザーが明示的に削除するまで永続する** — browserのF5 / 再起動でもcompanionの再起動でも維持される。browser storageを消した時やcompanion側credentialをresetした時（`DELETE /v1/pair` / ブラウザのReset pairing操作）だけ再pairingする。

> **Pairing persistence（2026-08-03実装）:** 旧契約（pairing / tokenはpage-memoryのみ・reload＝再pair）は廃止された。詳細は[「Persistent pairing credential」](#persistent-pairing-credential2026-08-03実装)を参照。

### YouTube

1. ユーザーがYouTube URLをEnteiへ貼る。
2. Default Cookieがなければ`cookies.txt` modalを直ちに表示する。
3. Enteiは選択fileをpair済みlocalhost APIへ送る。file本体をブラウザーstorageへ書かない。
4. companionはDPAPI / Termux private storageへDefault Cookieを保存し、現在のjobを開始する。
5. companionは最大1080p sourceを取得し、手動日本語字幕、次に自動日本語字幕を解決する。
6. Enteiはlocalhost stream URLを既存Playerへ渡す。日本語字幕がなければ既存empty subtitle stateを表示する。

### Torrent

1. ユーザーがmagnet URIをEnteiへ貼る。
2. companionがcanonical magnet（xt + 安全なtracker）でanacrolix/torrent engineを起動し、**metadata取得直後に**（payload完了前）sanitized file一覧を返す。
3. 複数fileならEnteiがvideo 1本と任意subtitle 1本の選択Modalを出す。eligible videoが無ければ終端generic error（"no playable video"）。
4. 選択後、engineは選択fileの**head bootstrap**（先頭window 4 MiBをPiecePriorityHighに昇格 + 専用bootstrap readerがbyte 0を要求）で先頭pieceからverified contiguous prefixを成長させ、companionは**verified prefix内のRangeだけ206**、越えるRangeは`503 + Retry-After`で応答する（fabricated bodyなし）。
5. 未取得位置へのseekはEnteiがbuffer animationとpauseを表示する。prefixがその位置へ届いた時（bridgeの明示`load()`再適用）だけ再開する。

## Security and data contract

- listenerは`127.0.0.1` / loopbackだけ。`0.0.0.0`、LAN、tunnelは使わない。
- CORSは`https://entei.gorakudo.org`と開発用`http://localhost:4321`だけを明示許可する。`*`は使わない。
- Android ChromeのLAN DevTools QAでは、そのruntime固有の明示origin（例: 開発機のLAN dev-server origin）を`--allow-origin`でprocess起動時に一時追加する。これは開発専用オーバーライドであり、release allowlistのエントリには**絶対に追加しない**。値はメモリ内のみで永続化しない。
- pairing前・tokenなし・Origin不一致のstate-changing requestは拒否する。
- **Pairing credentialの永続化（2026-08-03実装）:** companion側はopaque tokenだけをplatform別のuser-private storageへ保持する — WindowsはDPAPI（`golang.org/x/sys/windows` `CryptProtectData`/`CryptUnprotectData`、user-scoped、`%LOCALAPPDATA%\GoRakuDo\EizouDendenshi\credential.bin`にatomic書き込み）、Android/TermuxはTermux app-private storage（`$PREFIX/var/lib/eizouden/credential.bin`、mode 0600、atomic書き込み、symlink拒否）。schema-versioned envelope（`{"version":1,"token":…}`）に**tokenのみ**を保持し、pairing code・source URL・magnet・media・cookieは決して保存しない。破損 / 復号失敗 / profile不一致はfail-closed（credentialを受け入れず、fresh code + tokenを生成、詳細を漏らさない）。成功した最初のpairは**200を返す前に**tokenを永続化し、永続化失敗はpair request自体を失敗させる（token応答なし）。`GET /v1/pair/status?token=…`（Origin + token gate）はreload検証用の非センシティブacknowledgementのみを返し、token / code / path / storage errorを一切echoしない。`DELETE /v1/pair?token=…`（Origin + token gate）はpersisted credentialを削除し（best effort・in-memory無効化が正）、tokenをrotateし、fresh pairing codeを発行する。jobs / mediaは決して削除しない。
- browser側はopaque tokenだけをschema-versioned localStorage envelope（`entei.eizou.pairing` = `{v:1, token}`）へ保存する。cookie file、cookie内容、media Blob、magnet、source URLをIndexedDB / localStorageへ保存しない。mount時にstatus endpointでtokenを再検証する（200 → connected、401/403 → 保存tokenをclearしてunpaired表示、companion不達 → token保持のままdisconnected表示）。
- Default CookieはWindowsではDPAPI、AndroidではTermux app-private storageで保持する。cookie値、YouTube URL、authorization headerをlog / analytics / crash reportへ出さない。
- Default Cookieの置換と削除は明示操作にする。削除はcompanion側の保存値も消す。
- session mediaは正常終了、stop、Cancel、error、companion shutdownで削除する。削除失敗は次回起動時cleanup queueで再試行する。

## Persistent pairing credential（2026-08-03実装）

旧契約「pairing / tokenはpage-memoryのみ・reload＝再pair」は**廃止**された。1回の成功pairing後、credentialは**ユーザーが明示的に削除するまで**、browserのF5 / 再起動とcompanionの再起動の両方で永続する。

### Companion側（`companion/eizoudendenshi/internal/credential`）

- 狭いStore抽象（`Load` / `Save` / `Delete`）に**tokenとschema versionだけ**を保持。pairing code、source URL、magnet、media、cookieは一切保存しない。API unit testは`MemStore` fakeで決定的に動作する。
- **Windows:** `golang.org/x/sys/windows`の`CryptProtectData` / `CryptUnprotectData`（`CRYPTPROTECT_UI_FORBIDDEN`、user-scoped）でDPAPI暗号化し、`%LOCALAPPDATA%\GoRakuDo\EizouDendenshi\credential.bin`へatomic書き込み（temp + rename）。bootstrapと同じuser-private root。profile不一致 / 復号失敗 / 破損contentは**fail-closed**（credentialを受け入れず、fresh first-pair code + tokenを生成、詳細を漏らさない）。
- **Android / Termux:** DPAPIは使わず、Termux app-private storage（`$PREFIX/var/lib/eizouden/credential.bin` — bootstrapがcoreをinstallする場所と同じ）へmode 0600 + atomic書き込み。symlink / path traversal / 破損値はfail-closed。GOOS別build tag（`store_windows.go` / `store_android.go` / `store_other.go`）。
- `EIZOUDEN_CREDENTIAL_DIR` env overrideはharness / test専用（自動実行が実profileへ書き込まないように）。
- **startup:** 有効なsaved tokenをload。無い / 破損 / 復号不可ならfresh code + tokenを生成。
- **pair:** 成功した最初のpairは**200を返す前に**tokenを永続化。永続化失敗はpair request自体を失敗させ（token応答なし・codeは消費しないので再試行可）、既存のone-time OTP挙動（code→token、single-use）はpersistent pairが存在する前の経路として維持される。
- **`GET /v1/pair/status?token=…`（新規）:** Origin + token gate。固定acknowledgement `{"status":"paired"}`のみを返し、token / code / path / storage errorを一切echoしない。server pairing stateを作らない（reload検証用の純粋なread）。
- **`DELETE /v1/pair?token=…`（新規）:** Origin + token gate。persisted credentialを削除（best effort — in-memory無効化が正）、tokenをrotate、**fresh pairing codeを即時発行**（reset callbackでterminalへ印刷されるため、companion再起動なしでpairing dialogが動く）。jobs / mediaは決して削除しない。clear contractは`internal/api/pairing_persist_test.go`で固定。

### Browser側（`apps/web/src/features/player/`）

- `companion-pairing-store.ts`: schema-versioned（`{v:1, token}`）・validation付き・exception-safeなlocalStorageモジュール。**opaque tokenのみ**を永続化し、pairing code / URL / magnet / media / cookieは保存しない。malformed / schema不一致 / storage不能はすべてunpairedとして安全に振る舞う。
- `use-companion-pairing.ts`: Player mount時に保存tokenを読み、status endpointへtoken query（200 → connected、401/403 → 保存tokenをclearしてunpaired表示、不達 → token保持のままdisconnected）。pair成功時はtokenだけを永続化して接続。resetはcompanion `DELETE`を先に呼び、**network成否に関わらず**browser storageとmemoryをclear（graceful divergence: browserは常にunpaired終了、companion不達時はcompanion側credentialはCLI / 他のpaired browserからリセット可能）。
- `EizouDendenshiSetup`: connected時に明示的なdestructive reset control（Lucide `Unplug` + shadcn destructive Button）→確認Dialog（shadcn Dialog）。status indicator自体は非interactive（誤操作でresetされない）。reload検証中のstatusは「Checking…」表示（false "Disconnected"を出さない）。
- 明示的に保存tokenがinvalid（companion側がreset / delete済み）の場合はbrowser tokenをclearしてunpaired表示。reload検証はserver pairing stateを作らない。

## 組み込みアップデータ（共通CLI option 3、2026-08-04実装）

`grkd-edds`（およびcore直の`cli`モード）に`3. Update EizouDendenshi`を追加した。実装は`companion/eizoudendenshi/internal/update`（stdlibのみ、新規依存なし）。

- **release feed:** `https://api.github.com/repos/GoRakuDo/entei/releases?per_page=20` をHTTPSで照会（60秒timeout・最大5 redirect・redirect先はHTTPS限定）。tagが`eizoudendenshi-v`で始まる**non-draft** releaseのうち**`published_at`が最新のもの**を選ぶ（lexicalなrc比較はしない）。prereleaseは含める（最新releaseは常にprereleaseであり、`/releases/latest`はprereleaseを除外するため使わない）。asset名の欠落 / 重複 / 安全でない名前、非HTTPS asset URLはfail-closed。
- **検証:** まずsigned manifestを**binaryへpinされた公開鍵**（`scripts/release.ps1 -PublicKeyFile`で両coreへ`-ldflags -X eizoudendenshi/internal/update.PinnedPublicKey=<RW...>`注入。dev `build`はplaceholderのままで、updaterは`updater unavailable`でfail-closed。response / env由来の任意鍵は絶対に信頼しない）でMinisign検証し、manifest構造（format / formatVersion / semver / helper contract / artifact）を厳密検証。manifestの`version`は選択したtagのsuffix（例:`0.2.0-rc.22`）と一致必須。その後platform artifactそれぞれをMinisign検証＋signed manifestのSHA-256照合してから、**private staging dirへ**DL（apply前に一切install rootへ書き込まない）。
- **verifier:** Windowsは`<install root>\tools\minisign.exe`（bootstrap導入済み）を優先、無ければPATHの`minisign` — どちらもversion 0.12チェック必須。TermuxはPATHの`minisign` + versionチェック。pin済み公開鍵は**private temp fileのみへ**書き、`minisign -Vm <file> -p <keyfile>`をargvのみで起動（shell補間なし）、出力はcaptureして印刷しない。
- **適用:** 現在の実行ファイルを内部`--apply-update` child modeで起動し、**staging path・parent PID・対象pathだけ**を渡す。Windowsではchildを実行中実行ファイルの**%TEMP%配下のコピー**から起動する（childはcore targetをrenameする必要があるが、Windowsでは実行中イメージのrename/削除は共有違反で失敗する。POSIX renameなら実行中イメージのまま起動可能なためTermuxは従来どおり。コピーはstaging外に置き、前回の残骸は次回更新時にsweepする）。parentは先にexitし、childはboundedにparent exitを待ってから、検証済みcore/helpersを**backup+rollback**で置換（失敗時は旧coreを保持）、新しいcoreをCLI modeで起動してexit。Windowsはcore + `yt-dlp` + `ffmpeg`（archiveは署名・hash検証後にのみ展開し、`ffmpeg.exe`だけを安全に取り出す）を更新し、既存helperのpath / 名前（`helpers\`配下）を維持。Termuxは`android/arm64` coreのみ更新し、Termux package helpers（`python-yt-dlp` / `ffmpeg`）には一切触れない（既存のsigned helper bootstrap / pkg契約の管理下のまま）。
- **更新しても再pairingは不要（設計上の不変条件）:** updaterはstagedファイルとcore/helper対象しか触らない。`credential.bin`（Windows DPAPI / Termux app-private）、credential directory、browser localStorage、pairing / OTP状態は**読みも書きもrotateも削除もされない**。`DELETE /v1/pair`は呼ばれず、新しいOTPは発行されず、tokenはrotateされない。したがって更新後もWeb側の保存tokenとcompanion側のpersisted credentialでそのまま認証される。これは`TestApplyStagedPreservesCredential`（apply後もcredential.binがbyte一致）と`TestRestartWithSameFileStoreKeepsToken`（同一credential fileで再起動した新processが既存tokenをそのまま受け付ける）で固定している。更新はCLI menuからのみ実行でき、server process稼働中の更新経路は存在しない。
- **出力:** option 3は安全なstatusだけを表示する（`checking` / `already up to date` / `verified and restarting` / generic failure）。release URL・鍵・local path・token・magnet・raw errorは一切印刷しない。
- **実測状況:** Windowsの更新パイプライン一式は2026-08-04に実release（rc.22）でライブ検証済み — 実GitHub feed、実Minisign 0.12、実pin鍵でmanifest + core + yt-dlp + ffmpegの署名 / SHA-256検証が通り、harness install rootで実core/helpersの適用と新coreの再起動まで確認した。**未検証:** 実ユーザーprofileでの`grkd-edds`経由更新（実credential.binあり）、更新後のbrowser永続化のE2E、Termux実機での更新経路（unit testのみ）。

### 既知の指摘（2026-08-04コードレビューのLOW findings）

プロジェクト運用により、reviewerのLOW指摘はAPPROVEでもここへ記録する。いずれも現時点の正しさ・安全性に影響しない。

1. `apply.go` の `sweepUpdaterCopies` は`%TEMP%`のwildcard globを使う。2つのupdateが同時に走ると互いのin-flightコピーを掃除しうるが、fail-closedで現実的に稀（single user / single session）。並行更新対応が必要になるまでper-process lockは追加しない。
2. `apply.go` の `copyExecutableForChild` はbinary全体をメモリへ読む（`os.ReadFile` + `os.WriteFile`）。現在のcoreサイズ（~20-30MB）では問題ない。binaryが~100MBを超える将来に`io.Copy`へ切替。
3. `apply.go` の `updaterCopyName` はglobal `math/rand`（Go 1.20+でauto-seed）。pin済みGo 1.26.4では問題なし。awareness用。
4. `apply_test.go` の `TestCopyExecutableForChildSweepsStaleCopies` は実`%TEMP%`へ書く（production globと一致）。次回の`copyExecutableForChild`呼び出しがsweepするためself-healing。
5. `apply_test.go` の `TestCopyExecutableForChildCopiesToTemp` の変数名`staging`は紛らわしい（cosmetic only）。
6. `update_test.go` のchild dispatch env guardコメントは`TestSpawnApplyWindowsRealSelfReplace`を明示的に指名できる（cosmetic only）。
7. Magnet UI（`MagnetInput.tsx`）のネストフォルダーのみの構造（フォルダーの中がさらにフォルダーだけでvideoがleafに無い場合）は、フォルダーを開き続けるだけで無限ループにはならないが空状態のUXが未定義。backendが正しいtorrentではleafにfileが存在するため現実では起きない。将来のedge caseとしてdepth guardまたは「このフォルダーに動画なし」の空状態メッセージが対策候補（コード変更不要と判断）。
8. Magnet UIテスト（`magnet-input.test.tsx`）のmock folder ID `'d0'` は実フォーマット（`folderID()` = `'d'` + SHA-256 8 hex）と異なる（cosmetic only）。
9. Magnet tableの行高は `td/tr` の `height: 2.25rem`（36px）で揃えているが、tableレイアウトではheightは最小高さとして働き、CSS仕様上table cell/rowの `max-height` は無効。将来行内容が20px content area（padding 8px×2込み）を超えると行が膨張しうる。`overflow: hidden` のsafety netは意図的に追加せず、このLOWとして記録（2026-08-04レビュー）。

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


### Progressive torrent streaming（実装済み・anacrolix engine・実機browser/swarm gate未実施）

ED-2Gのtorrent jobはanacrolix/torrent engine（v1.61・loopback-only・Seed=false / NoUpload）で実装されている。**aria2は全廃止**（外部helper契約・`--aria2` flag・helper payload・テストは全て削除済み）。

- **metadata → 即時handoff**: canonical magnet（xt + 安全なtracker）を`engine.Start`（bounded metadata fetch、default 2m）に渡すと、**metadata取得直後に**sanitized file list（opaque id / basename / extension / byteSize / kind）が利用可能になる（payload完了を待たない）。eligible videoが無ければ終端generic error（"no playable video"）。metadata timeout（2分） exceeded時は"metadata timed out"エラーでsessionを自動解放し、UIはinput状態へ復帰して同じmagnetの再試行が可能になる。2分はDHT/tracker lookup通常完了時間（10-30秒）とcompanionの5秒poll intervalから上限を設定した値。anacrolix clientの内部状態がstale（同magnetのcancel直後retry等）でGotInfo()が発火しない場合も同様に2分でタイムアウトし、無限spinnerを防ぐ。anacrolix側のstale state自体が解消されたかは未確認であり、timeout + session自動解放によるrecoveryが確実な手段。file listはtorrent metadata由来（engineの`DisplayPath` basename + extension classify）で、stdlibのbencode parserやpiece hashの独自抽出は使わない。
- **head priority / bootstrap reader（2026-08-03実装）**: 選択（video 1本 + optional subtitle 1本）成功後、選択videoの先頭window（`bootstrapWindowBytes` = 4 MiB、fileの先頭piece indexとtorrentのpiece lengthから導出・file端でclamp）を`types.PiecePriorityHigh`に昇格し、さらに専用bootstrap reader（`StartBootstrap` — byte 0へSeek + 1バイトReadでdemandを維持、`SetReadahead(bootstrapWindowBytes)`）が先頭pieceの取得を要求する。これにより**verified contiguous prefixは常にfile先頭から成長する**。bootstrap readerはjob終了とcompleteの両方でcancelされ、state machineをブロックしない（独立goroutine）。
- **availability = verified contiguous prefix**: 決してファイルallocated sizeやzero-probingではなく、**torrent自身のpiece SHA-1と照合したverified contiguous prefixのみ**（multi-fileでglobal pieceが他fileに跨る場合は検証不能 → 誠実にbuffering継続）。
- **HTTP契約**: verified prefix内に完全に収まるRangeのみ`206`（`bytes=0-`もprefixまで206）、prefixを跨ぐ/越えるRangeは`503 + Retry-After`、complete後はgrowing serv（200/206）。fabricated bodyなし。既存ED-2C fixture/grow契約は不変。
- **status**: 選択前は`buffering`（503）、選択後streamingはverified prefix > 0かつservable sourceがあれば`playable`（bridgeがURLを割当てる契機）、`available == total`で`complete`。
- **safe-early handoff predicate**（`structurallyPlayable`）: MP4/ISO-BMFFはcomplete ftyp+moovがverified prefix内に完全に収まり、stsd video codecがbrowser-decodeable（avc1/avc3/vp09/av01。hvc1/hev1等は拒否）かつverified sample boundaryが存在すること。Matroska/MKVはEBML header + Segment + complete Tracks（decodeable video TrackEntry: V_MPEG4/ISO/AVC, V_VP9, V_AV1。HEVC/unknown/audio-only拒否）+ completeな最初のClusterにvideo blockが含まれること。partial / truncated要素は誠実にbuffering継続。fixed byte thresholdなし。MKV random-seek capabilityは主張しない。
- **Web bridge**: `playable`でmedia URLをsurfaceし、再生中もstatus poll継続。media error / seek超過時はprefix追いつき後に明示`load()`再適用（bounded）。
- **companion controls修復**: callback refsがlocal mediaType stateではなくdisplayMediaTypeでsharedMediaRefをgateするよう修正（companion videoでtimestamp 00:00/00:00・Play/Pause no-opを解消）。
- **未実施gate**: 実browser（headed Chrome）でのprefix-206 stream挙動・mid-play 503→reload復旧・MKV early-start計測、実swarm progressive再生（PSMUX）。
### 共通CLIと初回helper導入（実装済み・実機gate未実施）

Windows / Termuxともに、初回bootstrap後の入口は同じ`eizouden` CLIに統一する。CLIは現在起動中のcompanionへ接続するためのUIではなく、local companionの運用入口である。起動時はrelease versionを色付きheaderで表示し、選択肢は増やさない。

```text
EizouDendenshi vX.Y.Z

1. Get New Pairing Code
2. Service Status

Option:
```

- **Get New Pairing Code:** 既存のpairing codeを再利用・保存せず、そのCLI起動で新しいcodeを表示してforeground companionを開始する。pairing code自体は永続化されない。tokenは**user-private credential storeへ永続化される**（Windows DPAPI / Termux app-private — 下記[Persistent pairing credential](#persistent-pairing-credential2026-08-03実装)参照）。既に有効なpersisted credentialがあれば同じtokenが再発行され、なければfresh tokenが生成される。
- **Service Status:** core、yt-dlp、ffmpeg、torrent engineの導入済み / version / 実行可能状態だけを表示する。path、cookie、token、URL、job内容は表示しない。
- CLIは`Start` / `Stop`などの追加menuを持たない。foreground companionは通常の`Ctrl+C`で停止する。
- launcher commandは両platformで**`grkd-edds`**に統一する。Windowsではbootstrapがuser-private install rootを**current userのPATHだけ**へ重複なく登録し、以後PowerShell / CMDから`grkd-edds`だけでCLIを開けるようにする（machine PATHは変更しない）。Termuxでは`$PREFIX/bin/grkd-edds`を導入する。初回bootstrap / 更新成功後は、このlauncherを自動でCLIとして開始する。

**実装（2026-08-02）:** `eizouden cli`（Go、共通）がmenuを描画（stdoutがterminalのときだけANSI color、それ以外はplain）。option 1は既存のserver起動経路を再利用（fresh pairing code・Ctrl+C停止）、option 2はcore/yt-dlp/ffmpeg/torrent engineのinstalled/version/readinessのみ表示（path/cookie/token/URL/job内容は出さない。helper pathはWindows launcherが絶対pathを渡し、Termuxは固定command名を解決）。無効入力は再prompt、EOFは安全exit。**Windows**: bootstrapがuser-private rootに`grkd-edds.cmd` launcherをinstall（core CLI mode + 絶対helper path; 旧`eizouden.cmd`は削除）し、install rootを**現在ユーザーのみ**のPATHへ冪等登録（大文字小文字を無視したsegment照合・重複なし・既存segment保持・machine PATH不変・8192文字超は安全にスキップ）。bootstrap完了後は`grkd-edds`（2択CLI）を自動起動し、Get New Pairing Codeがcompanionを起動する。companionの**既定bindは`127.0.0.1:4322`固定**（Entei Playerのpairing/Magnet/bridgeクライアントが4322へ接続する契約; テスト/開発は`--addr 127.0.0.1:0`で明示的にephemeral化）。4322が使用中の場合は既存listenerをkillせず、ユーザー可読なcollisionエラーで終了する。既存terminalのPATHは自動再読込されないため、bootstrap自身のプロセス環境も更新して即時利用可能にする（新規terminalでは解決される）。**Termux**: `$PREFIX/bin/grkd-edds`（旧`eizouden` launcherは削除、profile編集なし）。**manifest contract v3**: helper artifact map（Windows）＋固定Termux package map（python-yt-dlp/ffmpeg、minimum versionはmanifest管理）。Windows bootstrapはv2/v3を受け入れ、helper-enabled Termux bootstrap（`eizouden-bootstrap-helper.sh`）はv3必須（v1/v2はfail closed; 既存v1 core-only Termux bootstrapは不変）。Termux helper導入は公式pkgのみ・version要件確認後にcore install・app-private launcherを`$PREFIX/bin`へ。harness検証済み（Termux 91/91・Windows 98/98）。**未実施gate**: Termux実機でのclean install＋helper CLI gate、Windows実機でのCLI/launcher手動gate。

Windowsは既存のhelper contract v2 / v3により、Minisign検証済みrelease artifactをuser-private rootへ導入する。Termuxも同じ利用可能状態を目指すが、helper binaryをWindows assetから流用しない。Termux公式repoの`python-yt-dlp`、`ffmpeg`をbootstrapが必要時だけ導入し（**aria2はanacrolix/torrent engineへの移行でhelperから全削除済み**）、release manifestが定めるminimum versionを満たすか確認する。manifest不一致・package install失敗・version不足ではcoreを起動せずfail closedする。helperのsilent self-update、global install、browser storageへのhelper state保存は行わない。

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

**残りのdelivery gate:** HTTPSでdeployされたEntei origin、Android Chromeのgrowing progressive再生、audio listening/decode、Windows x64 installer。Stage B（Android / Termux clean install）・release identity表示修正（rc.3）・growing media Range contract（loopback）は通過済み。growing mediaのRange contractは[後述のED-2C節](#ed-2c-growing-media-range-pocloopback通過済みwindows-chrome計測済みandroid-chrome未検証)でWindows / Termux loopback実測済み、Windows Chromeの実ブラウザ計測も通過済み（2026-07-31）。

## ED-2C growing-media Range PoC（loopback通過済み・Windows Chrome計測済み・Android Chrome未検証）

> **Historical scope:** 本節はdownloaderなしのED-2C PoCの記録（2026-07-31計測）。`503 + Retry-After`契約自体は現在も有効（torrentのverified-prefix streamingやgrowing sourceで使用）だが、「downloaderなし（yt-dlp / aria2 / ffmpegをinstall・実行・呼出しない）」というPoC境界は歴史的記述であり、その後yt-dlp（ED-2F）・anacrolix torrent engine（ED-2G）が実装された。PoC内容の事実は変更していない。

download中など**成長中のメディア**（known total + available prefix）に対する明示的で安全なHTTP contractを、downloaderなしで確立するPoC。`internal/media`のsource抽象で、available byte数を時間経過とともに増やせる決定的fixture（`MemSource`）と、実際の追記ファイルを裏に持つ`FileSource`を提供する。**契約はWindows / Termux loopbackで実companion binaryにより実測済み（2026-07-31）、Windows Chromeでの実ブラウザ計測も通過済み（2026-07-31）**。Android Chrome / 端末でのprogressive再生計測とbridge実装は別gateとして必要（完了は主張しない）。

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

### 実測記録（2026-07-31、Windows headless Chrome実ブラウザ計測 — growing file）

実companion binary + 実ブラウザでgrowing fileのprogressive再生挙動を計測した。probe pageはEntei dev server origin `http://localhost:4321/probe.html`（開発用一時QAページ、計測後に削除）、companionは`127.0.0.1:4322`。fixtureはvalidな4秒H.264/AAC faststart MP4（total 161958 byte・初期available 124479 byte = 77%）。ブラウザはWindows headless Chrome 151（UA `HeadlessChrome/151.0.0.0`）。video要素は`crossOrigin="anonymous"` + token query param（Origin gateは`http://localhost:4321`で通過、pair 200）。表示ありのWindows Chromeは別途未計測である。

| ステップ | 観測結果 |
|---|---|
| `Range: bytes=0-`（fetch probe） | `503` + `Retry-After: 1`、JSON body `available: 124479 / total: 161958` |
| `video.load()`（available 77%時） | リクエストちょうど1回（`Range: bytes=0-`）→ `503` → `error` code 4（`MEDIA_ELEMENT_ERROR: Format error`）、`networkState` 3（NETWORK_NO_SOURCE） |
| 30秒無操作観測 | 追加リクエストなし — **Chromeはmediaの`503`を自動再試行しない**（`Retry-After`はmedia stackにhonorされない） |
| tail追記でファイル完了後、12秒以上観測 | 依然`error` code 4・リクエストなし — **追記だけでは要素は回復しない** |
| error状態（duration NaN）で`currentTime = 1.5` | リクエストなし・`seeked`イベントなし（値がsetされるだけでfetchされない） |
| 明示`video.load()` + `play()`（完了後） | `206` → `loadedmetadata`（dur 4）→ `seeked` → `canplay` → `playing` → 最後まで再生 |
| ページreload後、1.5秒へseek（ファイル完了済み） | `206` → seek成功（`seeked`、再生OK） |

**bridgeへの含意（明示記録）:** Chromeのmedia elementはgrowing fileの`503`に対して自動再試行も`Retry-After`尊重もせず、一度`error` code 4でfailし、ファイル完了後も自力では回復しない。したがってproduction bridgeは**Chromeの自動再試行に依存できない**前提で設計する — playable prefixが揃うまでEntei側でbuffering表示 + `503` bodyの`available` / `total`に基づくretry / backoffを行い、**playableなprefixがavailableになった時点で明示的に`src` / `load()`をリセットして**再生を再開する。

計測後、一時probe page / server / binary / fixture / Chrome profileはすべて削除した。

### TOCTOU

`Available()`は**リクエスト毎に1回だけ**snapshotし、served windowはそのsnapshotから導出して決して跨がない。加えてsource自身が`ReadAt`で境界を強制し、availabilityはmonotonic（append-only契約）— 並行writerがunavailable byteを配信することは構造的に不可能。エラー応答 / logにdisk pathは出ない。

### 未実装（PoC境界）

- downloaderなし（yt-dlp / aria2 / ffmpegのinstall・実行・呼出なし）。
- production bridgeは未実装。**Windows Chromeのgrowing progressive再生は2026-07-31に計測済み**（503→error code 4・自動再試行なし・追記のみでは回復しない・明示`load()`+`play()`で206再生・reload後seek成功）。**Android Chromeのgrowing playbackは未計測**。bridgeは「Chromeの自動再試行に依存できない」前提で、buffering表示 + availabilityベースのretry/backoff + playable prefix到達時の明示`src`/`load()`リセットが必要。

 ## ED-2E companion buffering bridge（実装済み: status endpoint + bridge controller/hook・browser QA未実施）

> **Historical scope:** 本節はED-2E時点（2026-07-31）の実装記録。下記「未実装（意図的スコープ外）」と「yt-dlp / aria2 / downloader、Entei UI、releaseは対象外」は**当時のED-2Eスコープ**を記録したものであり、その後の進捗（ED-2F: yt-dlp source job + 実download QA 2026-08-01 + YouTube URL入力実装、ED-2G: anacrolix torrent engine + Magnet UI 2026-08-02、persistent pairing 2026-08-03）により現在の状態ではない。status endpoint / bridge controllerの契約自体は現在も有効。

ED-2CのWindows Chrome実測（2026-07-31）は、growing fileを直接`<video>`へ渡す契約に**実ブラウザの制約**を追加した: media elementは`503`を自動再試行せず、一度`error` code 4でfailし、ファイル完了後も自力では回復しない（明示`load()`+`play()`でのみ回復）。本節はこの事実を前提に、Entei側がgrowing sourceを安全に扱うための**bridge契約**である。

### 実装状況（2026-07-31）

- **実装済み（Go companion）:** `GET/HEAD /v1/media/status`（origin + capability gate、`Cache-Control: no-store`、HEAD mirror、OPTIONS preflight、metadata-only body: `state`/`available`/`total`/`headReady`/`retryAfter`）。`internal/api/status.go` + `internal/api/status_test.go`（11テスト）。`headReady`は契約どおり**常にfalse**（byte-level moov検査は未実装）。
- **実装済み（Entei controller/hook）:** `apps/web/src/features/player/companion-bridge.ts`（controller）+ `use-companion-bridge.ts`（React hook）。単一in-flight poll・epoch/AbortController cancel・backoff（`max(Retry-After, 1s)` → ×2 → cap 30s・availability進捗でreset）・bounded failure → disconnected/error・401/403 → `rePairRequired`・`complete`ゲートの明示`src`/`load()`→ metadata/canplay → pendingSeek → intent play・media error時のstatus再確認 + bounded explicit reset。**stateはすべてページメモリのみ**（localStorage / IndexedDB / sessionStorage / cookies / URL / logsに一切書かない）。`tests/companion-bridge.test.ts`（17テスト）。
- **実装済み（Entei Player fixture統合）:** `use-companion-fixture-session.ts`（bridge lifecycleをPlayerAppへ接続: completeゲートで`fixtureMediaUrl`を導出 → 既存video refへattach → src/load・pendingSeek・play intentを保持。media switch / unmountでendSession）+ `companion-fixture-entry.ts`（**internal dev/QA専用エントリ** — pairing tokenはページメモリのまま、明示的にfixture sessionを開始する登録方式。UIに露出しないため誤解を招くuser featureとしてshipされない。Magnet / YouTubeボタンは引き続き非機能）+ `CompanionFixtureSessionStatus.tsx`（session active時のみのbuffering進捗 / error / re-pair UI。local file flow・mining / Anki / tracker無干渉）。`tests/companion-fixture-session.test.tsx`（12テスト: pairing token単独ではsource開始しない・buffering中はURL非assign・complete → src/load・seek/intent・401/403 → rePairRequired・end/media switch cleanup・local flow非表示）。
- **未実装（意図的スコープ外）:** source dialog UX（fixture sessionはinternal entry経由のみ。Magnet / YouTubeボタンはユーザー向けsourceとして機能しない）、`headReady` byte-level検査、yt-dlp / aria2、production bridge / job-source、Streaming Video Integration。
- **未実施:** headed Windows Chrome / Android Chromeの実ブラウザQA（本タスクでは自動テストのみ実行。QA手順は下記gates節）。

yt-dlp / aria2 / downloader、Entei UI、releaseは対象外。

### 目的と境界

- bridge = Entei player内のsource session層。companionのstatusをpollし、playableになった時点で明示的にvideo要素をリセットして再生を開始する。
- 対象はlocalhost companion sourceのみ。**Streaming Video Integration除外は維持**（browser extension / site DOM / tab capture / LAN・public listen / GoRakuDo proxy / persistent media cacheは引き続き永久除外 — 「Permanently excluded」節のまま）。

### 状態遷移

| state | 意味 | 遷移 |
|---|---|---|
| `idle` | source未投入 | source submit → `pairing` |
| `pairing` | 未pair | pair成功 → `buffering` |
| `buffering` | growing中。status pollで進捗表示 | `complete`検出 → `ready` / poll・source error → `error` / user cancel → `idle` / companion不達 → `disconnected` |
| `ready` | ファイル完了。src割当 | loadedmetadata後、intentに応じてplay → `playing` |
| `playing` | 再生中 | pause / 完了 / error |
| `error` | 失敗 | 明示再試行 → `buffering` / cancel → `idle` |
| `disconnected` | companion不達 | 復旧検知 → `buffering` / 経過上限 → `error` |

**不変条件:** `buffering → ready`は**statusが`complete`を報告した時だけ**。`ready`以降のvideo errorはstatusを再確認し、`complete`なら明示`load()`リセット（実測済みの唯一の回復経路）、未完なら`buffering`へ戻す。

### status/progress endpoint契約（実装済み — `GET/HEAD /v1/media/status?token=`）

`GET /v1/media/status?token=<capability token>` — `/v1/media/fixture`と同一のOrigin gate + token gate。200 JSON bodyは**metadataのみ**:

```json
{"state":"buffering","available":124479,"total":161958,"headReady":false,"retryAfter":1}
```

| field | 型 | 意味 |
|---|---|---|
| `state` | string | `disabled`（source未設定）/ `buffering`（`available < total`）/ `complete`（`available == total`）/ `error` |
| `available` | int64 | 現在availableなbyte数（monotonic、`0 <= n <= total`） |
| `total` | int64 | 既知の最終byte数 |
| `headReady` | bool | **情報提供のみ・src割当のgateにしない。** faststart MP4のmoov + codec initがavailable prefix内に完全収まるか（byte-level検査、downloader不要）。この検査は未実装・未計測であり、77% available時にChromeの`bytes=0-`が503でfailした実測からも、direct `<video>`のreadinessは**`complete`のみ**が安全 |
| `retryAfter` | int | 現在の503応答と同じRetry-Afterヒント（PoCでは1） |

- `Cache-Control: no-store`、HEADはGET mirror、OPTIONS preflight（GET / HEAD / OPTIONS）。
- **path / filename / token / pairing情報は一切含めない**（既存503 bodyと同じ非secret原則、`growing.go`の`bufferingBody`を拡張した形）。
- token無効 → 401、Origin不一致 → 403（既存gate準拠・CORS headerなし）。

### ポーリング / backoff規則

- **単一in-flight poll（並行retry禁止）**: setTimeout連鎖（setInterval不使用）+ epoch guard + in-flight ref。source切替・cancelはAbortControllerでabort（PlayerApp既存のepoch / AbortController supersessionパターンを再利用 — `miningEpochRef`等）。
- 間隔: `max(Retry-After, 1s)`から指数backoff（2倍、cap 30s）。`available`が前回より増えたらbase間隔へリセット。
- 上限: 連続失敗（poll error / `error` state）が上限回数、または経過上限（例: 10分）で`error`へ遷移（定数はQAで確定）。
- 503 bodyのavailable / totalとstatus endpointは同一情報源（companionのavailability snapshot）。

### ready遷移（明示src reset / load / play）

1. `complete`確認 → `src = media URL（token query付き）`を設定（既存`mediaUrl` state → `VideoPlayer`の`src` propへ流す経路をそのまま使う）。
2. `load()` → `loadedmetadata`（または`canplay`）を待つ。
3. pendingSeekがあれば適用（`currentTime`設定・`seeked`待ち — 既存`seekVideoSafely`パターン）。
4. 再生intentがplayなら`play()`。

**ユーザーintent保存:** source submitは「再生したい」intent（t=0から）。buffering中にpause → ready後も自動再生しない。buffering中にplay → ready後自動再生。buffering中のseek操作（cue click等）はpendingSeekとして保持し、loadedmetadata後に適用して**失わない**。buffering中はControls disabled（既存`isLoading || error`ガードに`buffering`を追加）。

### 永続化制限（Entei側）

- source session state（state / available / total / pendingSeek / phase）は**ページメモリのみ**。
- **2026-08-03更新:** pairing tokenだけは永続する — opaque localStorage envelope（`entei.eizou.pairing` = `{v:1, token}`）へ保存され、Player mount時に`GET /v1/pair/status`で再検証される（200 → connected、401/403 → clear + unpaired、不達 → token保持 + disconnected）。**reload後の再pairは不要になった**（旧契約「reload後は再pair」は廃止）。media URL・進捗・cookie・magnet・source URLはlocalStorage / IndexedDB / sessionStorage / cookiesへ一切保存しない。既存prefs（volume / playbackRate / layout等）へbridge状態を混ぜない。

### disconnect / re-pair

- poll失敗（network error / refused）→ `disconnected`。statusを低頻度（例: 5s固定）で再試行し、復旧検知で`buffering`へ。長時間不達で`error`。
- 401 / 403（token無効 = companion再起動 or 再pair）→ 既存pairing UIで再pairし、source sessionを再投入（ユーザー操作）。
- companion死亡時は再生中メディアも停止（session mediaはcompanionプロセス内 — 既存契約どおり）。

### QA / test gates（自動テストは通過済み・実ブラウザQAは未実施）

**Go（companion）:** status endpointのunit + httptest — state遷移（disabled / buffering / complete / error）、secrets非漏洩、HEAD mirror、preflight、401 / 403、monotonic availability。既存growingテスト（`growing_test.go`）に追加。

**ポーリング（Entei側）:** backoff数列・並行pollゼロ・cancel / epoch supersession・disconnect→re-pair遷移をfake status serverでテスト。

**Windows headed Chrome（実装後の実機QA）:**
- 実companion + 決定growing fixture（total 161958 / 初期available 124479等）で**headed Chrome**の実ユーザー操作QA — buffering表示 → complete検出 → 自動load/play、seek intent保持、disconnect/re-pair、cancel。**headedは未計測**（これまでの計測はheadless — headedでの挙動確認が本gateの目的）。
- **スクリプト / 自動実行するブラウザQAはPSMUX detached-session規則に従う**: セッション名`entei-qa-chrome-<short-id>`、`psmux new-session -d -s <name> -- pwsh -NoProfile -File <runner>`（即時return）、進捗は`psmux capture-pane -p -t <name>`、完了後`psmux kill-session -t <name>` + セッション不在・temp dir削除・PID残留なしを検証。runnerは自分が起動したPIDのみtry/finallyで終了。agent terminalでpersistent processをforeground起動しない。
- 終了後: companion PID停止・fixture削除・一時Chrome profile削除。

**Android Chrome:** Termux aarch64 + LAN dev origin（`--allow-origin`は開発専用・release allowlistへ入れない）+ DevTools手動手順。growing fixtureでbuffering→ready遷移、disconnect/re-pairを確認。cleanup: companion PID停止・wake lock解放・fixture削除。**Windows Chromeと同一挙動かは未計測** — bridgeは自動再試行に依存しない設計のため挙動差は許容し、QAでパリティを確認する。

### 未決定事項（open decisions）

- `headReady`のbyte-level検査（moov parse）をPoC companionへ実装するか、downloader-backed sourceの段階で導入するか。
- ポーリング定数（base 1s / cap 30s / 失敗上限 / 経過上限）は実装時QAで確定。
- audio source（m4a等）も同一契約で扱うか（契約はmedia一般だがQAはvideo先行）。
- future fast-path（`headReady`を活かすMSE等）は503契約下で未検証 — out of scope。

## ED-2F YouTube local source job foundation（companion Go実装・実download QAは2026-08-01に通過）

loopback companion専用のYouTube source jobの基盤（create / read / cancel）。すでに実測済みのstatus bridgeへ後から接続するjob境界を、production指向で最小実装した。**GoRakuDo proxy / browser / site統合なし、cookieなし**。**実yt-dlp download QAは2026-08-01に全面成功済み**（下記「実QA記録」）。ユーザー向けYouTube URL入力は2026-08-02に実装済み（後述のCLI節とMagnet UI節を参照。本節のエンドポイント契約は不変）。aria2は本機能に関与しない（anacrolix移行で全削除済み）。

### エンドポイント（`--ytdlp`設定時のみ登録）

- `POST /v1/source/jobs` — body `{"url": "…"}`でjob作成（201）。既存jobがあると**409 conflict**（one active session）。
- `GET /v1/source/jobs/{id}` — redactedなjob状態（200 / 404）。
- `POST /v1/source/jobs/{id}/cancel` — cancel + session解放（200 / 404）。
- 全route: `/v1/media/*`と同じexact-Origin + capability token gate（Origin無し/不一致 → 403、token無し/不正 → 401）、OPTIONS preflight、`no-store`。
- レスポンスは**metadata only**: `{id, state, error?, media:{available,total,headReady}}`。URL・ローカルpath・helper command line・helper stderr・credentialは一切出さない。job idはopaque random hex。

### 状態遷移とstatus mapping

`queued → downloading → buffering → complete`、終端 `error` / `cancelled`。`/v1/media/status`はactive jobを優先: queued/downloading/buffering → `buffering`（available=現在のdisk bytes、totalはhelper完了まで0）、complete → `complete`（available=total）、error → `error`、cancelled → 設定済みsourceへfall through。`/v1/media/fixture`はcomplete jobのmediaをgrowing contractで配信（200/206）、downloading中は503 buffering、error jobはgeneric 404。static fixture / grow contractの既存テストは無変更でgreen。

### helper契約

- `--ytdlp <path>`でhelperをpinned（起動時validation、requestから導出しない）。未設定ならjob endpoint自体が未登録（404）。
- `exec.Command` + **固定argv**で起動。validated URLだけが最後のargv要素（user由来はURLのみ）。**shellは一切使わない**。
- 固定ポリシー: 1080p cap（`bv*[height<=1080]+ba/b[height<=1080]/b`）、`--no-playlist`、job private temp dirへ直接出力。quality selector / user optionなし。
- URL validation: https限定のexact host formのみ（`youtube.com` / `www` / `m` / `music` / `youtu.be`、strict 11文字video id）。spawn前にそれ以外を全拒否。
- `--job-timeout`（default 30m）とcancelでprocess treeをkill（process group / Windowsは`taskkill /T`）、`cmd.Wait`でreap（zombieなし）。job fileはprivate `entei-job-*` temp dirに置き、cancel / failureで削除。complete jobはsessionをcancelするまでmediaを保持。**user fileには一切触れない**。

### subtitles境界

本phaseでは**実装しない**。subtitle flagも渡さずavailability queryもしない。cookieなしで安全にqueryできる場合のみ記録する方針は、helper metadata出力のparseという別の安全・決定的ステップが必要なため延期（有効化前に再レビュー必須）。日本語字幕の選択/取得も同様に未実装。

### テスト

`internal/youtube`（URL validation）、`internal/job`（manager: 固定argv injectionなし・one-active conflict・cancel/cleanup zombieなし・timeout・error redaction・growing→complete mapping・Close）、`internal/api`（endpoint: gates・redaction・conflict・read/cancel・status/fixture mapping）— すべて**fake executable helper**（network / 実yt-dlp不使用）。`go test -race ./...` green。

### 実QA記録（2026-08-01・実yt-dlp・PSMUX detached）

**helper更新（許可済み・Python 3.11環境のみ）**: python311 -m pip install --upgrade yt-dlp で 2025.03.31 → 2026.07.04 に更新（他環境/globalは不変更）。**実download QAが全面成功**（同一実URL・短い公開テスト動画）: job受付201 → downloading → complete(available==total=474489)、helper argv固定ポリシーを実機で確認（1080p cap selector・--no-playlist・URLは最後のargv要素・shell不使用・parent chain eizouden→wrapper→python）、/v1/media/status complete・/v1/media/fixture 200（474489実bytes）+ **Range 206**（head/midとも実bytes）、ffprobeで**AV1 320x240 + Opus・19.028s**の実media確認（ffmpeg merge動作）、**Chromeで実media再生確認**（/v1/media/fixture URLをvideo要素に渡し、loadedmetadata/canplay/playing・currentTime前進・errorなし）。cancelはcomplete job / mid-download両方で200・session解放・GET後404・**orphan 0**・job dir削除。redaction sweepでURL/token/path/stderr漏れゼロ。**実欠陥を追加検出・修正**: mid-download cancelでkill直後のos.RemoveAllが死亡過程のhelper（python/ffmpeg）のopen handleで失敗しjob dirがリークするraceを実QAで再現 → emoveAllBestEffort（bounded retry 5s）を全cleanup pathに適用 + fake helperのhold modeをopen handle保持に強化し回帰テストで固定（TestNoJobTempDirLeakOnError/TestNoJobTempDirLeakOnCancel）。 **残りgate**: cookie/saved-profile・subtitles・Android/headed Windows browser QA・production bridge接続（URL UIとjob-to-bridge接続は実装済み）。


### 実QA記録（2026-08-01・helper更新前・失敗クラス）

実companion（`--ytdlp` pinned helper）で実URLのjob API QAを実施。**helper環境の失敗クラス**: 本マシンのPython314 yt-dlp.exe shimはinterpreter欠落で動作せず、既存Python311 + yt_dlp 2025.03.31は現在のYouTube playerのnsig/SSAP変更に未対応でNo video formats found! → 実downloadは全てrror "download failed"（redacted）。YouTube自体のblock/bot-checkではない（extraction開始は成功）。実機で確認済み: job受付（201・URL validation通過）、状態遷移（queued→downloading→error）、helper argvの固定ポリシー（1080p cap selector・`--no-playlist`・URLは最後のargv要素・shell不使用・parent chain eizouden→wrapper→python）、downloading中の/v1/media/status buffering mapping + /v1/media/fixture 503、cancel（session解放・tree kill・orphan 0）、broken-helper（spawn失敗）のerror path + status rror + fixture 404、全responseのredaction（URL/token/path/stderr漏れゼロ）。**実欠陥を検出・修正**: Windowsでhelper stderr logのopen handleがos.RemoveAllを失敗させ、job private temp dir（raw helper出力を含む）がerror/cancelでリークする欠陥を実QAで再現 → log closeを全cleanup pathでRemoveAll前に実行する修正 + リーク回帰テスト2件（TestNoJobTempDirLeakOnError / TestNoJobTempDirLeakOnCancel）。**未検証（helper更新後に再QA必要・install/更新は行わない方針）**: complete media（available==total・Range 206実bytes）・buffering中のgrowing available・cookie / subtitles・UI接続。


### 残るgate（主張しない）

cookie / saved-profile、subtitles、Android / headed Windows Chromeのbrowser QA、production bridge接続（URL UIとjob-to-bridge接続は後述の通り実装済み）。

## ED-2G torrent job foundation（companion backend実装）

status/media bridgeと共有するproduction指向のanacrolix/torrentローカルtorrent job境界。**GoRakuDo proxy / browser WebTorrent / extension・site統合 / LAN・public bindなし**。Magnet UI（React Player）は2026-08-02に実装済み（下記記録）。aria2は全廃止（helper契約・flag・テスト削除済み）。

### エンドポイント（torrent manager設定時のみ登録）

- `POST /v1/source/torrents` — body `{"magnet": "…"}`で作成（201）。**最大2 concurrent torrent sessions**（3作目でoldest-first eviction、evicted sessionは`errorCode: "torrent_concurrency_limit"`を30秒TTL付きで返す）。YouTube active中はtorrent createを409で拒否（cross-kind混合禁止）。YouTube remains one-session。**per-job Engine/Client**（anacrolix v1.61 issue #1048回避）。
- `GET /v1/source/torrents/{id}` — redacted state（evicted sessionもTTL内は読み取り可能）。`POST …/cancel` — cancel + session解放（evicted jobに対してidempotent）。
- `GET /v1/source/torrents/{id}/files` — **metadata取得直後（payload完了前）の**sanitized file list（opaque id / basename / extension / byteSize / kindのみ。絶対path・magnet・tracker・raw engine出力は出さない）。
- `POST /v1/source/torrents/{id}/select` — **video 1本 + optional subtitle 1本**契約。success時のみservable mediaになる（verified prefix streaming開始）。
- 全route: exact-Origin + capability token gate、OPTIONS preflight、`no-store`。

### Magnet validation

`magnet:?xt=urn:btih:`（40 hex / 32 base32）のみ受理し、決定的40小文字hexへcanonicalize。**安全な`tr=` announce trackerのみ保持**（下記Tracker policy。dn / xl / webseed等は全て破棄）。それ以外（任意URL・file path・malformed）はspawn前に拒否。エラーはgenericでmagnet / trackerをechoしない。

**Tracker policy（2026-08-02実装）**: 最大5個・各512文字以内・scheme udp/http/httpsのみ・userinfo / fragment / IP literal host（public/private・v4/v6）・localhost・port 1-65535外・非ASCII / control / whitespace・不正path（先頭スラッシュなし・backslash）を全て拒否。**1つでもunsafeなtrがあればmagnet全体を拒否**（silently dropしない・fail-closed）。DNS解決はしない。canonical trackerはscheme/host小文字化・dedup・決定的sort順で`tr=`として保持し、canonical magnet全体（xt + trackers）はengineへ渡る。`http`は平文announceのtradeoff（infohash + ユーザーIPがtracker運営者 / on-path observerに露出）を文書化した上で許可。trackerはAPI snapshot / error / log / docs出力に一切出さない。**Privacy**: trackerは第三者が運営するエンドポイントであり、実ダウンロード時にはユーザーIPがtrackerおよびtorrent peers（PEX/DHT）に露出し、trackerはinfohashを知る。この同意UIは将来フェーズ。

### engine契約

- anacrolix/torrent engine（v1.61）が**per-job Engine/Client**で起動。各torrent sessionが独自の`torrent.Client`を`EngineFactory`経由で生成し、anacrolix v1.61 issue #1048（同一Clientで同じinfohashをDrop後に再追加するとstale tracker weakrefが残る問題）を回避。loopback-only（`ListenHost` = loopback・random port）。`Seed=false` / `NoUpload=true`（seedingなし）。engine loggerはdiscard（cancel時のread失敗ノイズをcompanion stderrへ出さない）。
- canonicalized magnet（xt + trackers）を`engine.Start`（bounded metadata fetch、default 2m）へ渡し、`GotInfo()` = metadata取得でhandleを得る。metadata取得直後にsanitized file listが利用可能（payload完了を待たない）。metadata timeout（2分） exceeded時は"metadata timed out"エラーでsessionを自動解放し、同じmagnetの再試行が可能になる。stale state自体の解消は未確認。
- 選択後、`--seed-time=0`相当のdownload only・original source bytes only（remux/transcodeなし）。piece dataはengineのsession-private storage（defaultはOS temp領域）に置かれ、cancel / fail / session終了でtorrent sessionをdropし解放される。**user fileには一切触れない**。
- **head bootstrap（2026-08-03実装）**: 選択videoの先頭4 MiB windowを`types.PiecePriorityHigh`へ昇格（fileの先頭piece index + piece lengthから導出・file端clamp）+ 専用bootstrap reader（`StartBootstrap`・`SetReadahead(4 MiB)`）がbyte 0を要求 → **verified contiguous prefixが先頭から成長**。HTTP ReadAtはリクエスト毎に独立reader（Seek + Read・30s context timeout）で、並行Rangeの位置状態を共有しない。

### File list → selection → media bridge

**metadata取得直後**にfile list + classify（Player native allowlistと一致: video mp4/webm/ogv/ogg/mkv/m4v/avi・audio mp3/wav/flac/aac/m4a/opus/m4b・subtitle srt/vtt/assのみ、PGS/XMLなし）。**eligible videoが無ければ終端generic error**（"no playable video"）。`/v1/media/status`はselection前まで`buffering`（fixture 503）、selection後は`streaming`（verified prefix > 0かつservable sourceがあれば`playable` → bridgeがURL割当て。verified prefix内Rangeのみ206、越えるRangeは503+Retry-After）、`available == total`で`complete`（206 Range）。**selection前にmediaはservedしない**。前方/成長中playback（verified-prefix streaming）は実装済みで、実swarm / 実browserでの検証が残るgateである（詳細は上記[Progressive torrent streaming](#progressive-torrent-streaming実装済みanacrolix-engine実機browserswarm-gate未実施)節）。

### テスト

`internal/torrent`（magnet validation・manager: Engine interface / injectionなし・**2 concurrent sessions + oldest-first eviction + eviction TTL expiration**・file list sanitization・selection制約 / no-eligible-video error・redaction・cancel / timeout / session cleanup + temp dir leakなし・**head bootstrap windowの純関数とStartBootstrap lifecycle**・**evicted engine closed exactly once（no double-close）**・**concurrent create/cancel/evict race safety**）+ `internal/api`（torrent endpoints: gates・redaction・create / read / files / select / cancel・**selection前後（buffering / streaming / complete）のstatus / fixture mapping**・**cross job-kind conflict（YouTube×torrent）**・preflight）— すべて決定的fake Engine（swarm / network不使用）。`go test -race -count=5 ./...` green。

### 残るgate（主張しない）

実swarm / network download QA（将来はPSMUX detached sessionのみ）と、Android / headed Windows Chrome browser QA（verified-prefix streamingの実機挙動含む）。

**Magnet UI実装済み（ED-2G・React Player・2026-08-02）**: Magnetボタンは実torrent source dialogを開く — pairing gate（unpairedはpairing-required表示のみ）、**memory-only tracker同意チェックボックス必須**（IP露出の明示文言）、magnet create（POST /v1/source/torrents）、redacted status polling、sanitized file list表示 + **video 1つ必須 + subtitle任意（srt/vtt/assのみ）**の選択、select submit、close/unmountでのjob cancel。bridge sessionはsource `kind`（youtube/torrent）でcancel endpointを振り分けるよう一般化。**final E2E（実playback含む）は未実施**。

**旧aria2実swarm QA記録（2026-08-02・anacrolix移行前）**: rc.6 bootstrap-installed aria2 1.37.0 + 固定argvで、archive.org PD映画torrentとDebian公式netinst torrent（source classのみ・copyrightなし）を認証APIで201 → queued → downloadingまで確認したが、当時はcanonical magnetがtrackerを剥がす設計で、どちらのswarmもDHT/PEXでは到達できず**bounded window内で0 bytes（peer/metadata timeout失敗クラス・workaroundなし）**。cancel / cleanupは実測（job dir 0・process 0・session解放）。**Tracker有効実swarm QA（2026-08-02）: 最小swarmのpeer/metadata timeout**。安全なtracker付きmagnet（Big Buck Bunny / Blender Foundation CC-BY / 10秒1080p clip / archive.org、http tracker bt1/bt2.archive.org:6969）を201受理し、canonical magnetはtracker保持のまま最終argv要素として渡り、aria2はannounce成功（tracker HTTP 200、Complete: 1 seeder）したが、唯一のpeer接続がmetadata転送前に切断され、bounded window内で0 bytes（文書化済みのpeer/metadata timeoutクラス・workaroundなし）。files/selection/complete/Range/playback gateは未計測のまま。**anacrolix/torrent engineへの移行完了後、aria2依存は全て削除済み。** 実swarm testはanacrolix engineで再実施が必要（実際の環境ではまだ未確認なので、残りはE2Eテストだけ）。

## Required PoC checkpoints

この5つは実装の前提。どれかが失敗したら、full implementationへ進まず設計を戻す。

1. **Cross-origin loopback:** Windows ChromeとAndroid Chrome LAN dev originから、pairing済み`127.0.0.1:4322` APIを実測済み。HTTPS Entei本番originはED-2Cで確認する。
2. **CORS-clean media:** Windows ChromeとAndroid Chromeで静的fixtureのRange responseを`<video crossOrigin="anonymous">`へ渡し、canvas `toBlob`、captureStream、MediaRecorderがtaintなしで動くことを実測済み。growing mediaはED-2Cで確認する（**Range contractは2026-07-31にWindows / Termux loopbackで実測通過済み。Windows Chromeのgrowing progressive再生も2026-07-31に計測済み**（503→error code 4・自動再試行なし・追記のみでは回復せず・明示`load()`+`play()`で206→最後まで再生・reload後seek成功）。**Android Chrome / 端末でのgrowing progressive再生計測は未実施**）。
3. **YouTube cookie path:** user-uploaded Netscape cookie fileで最大1080p videoを取得し、手動日本語→自動日本語のfallbackと「字幕なしvideo」を検証する。cookie削除・job失敗・cancel後にcookieをlog / browser storageへ残さない。
4. **Forward torrent:** public regular BitTorrent swarmで冒頭再生、未取得後方seek時のbuffer、順方向piece到達後のresume、stop後のmedia cleanupをWindows / Androidで確認する。
5. **Delivery:** Minisign不一致releaseを拒否する。Windows x64 / Termux arm64でclean install→自動start→pairingを実測する。**Termux arm64側は2026-07-31にrc.2で通過済み、release identity表示修正はrc.3（2026-07-31）で実機検証済み。Windows x64はinstaller未実装のため未実測。**

## Staged delivery

| Stage | 内容                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | hard gate                                                                                     |
| ----- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| ED-0  | この設計書・既存WebTorrent文書をwithdrawal planへ同期                                                                                                                                                                                                                                                                                                                                                                                                                                  | documentation review                                                                          |
| ED-1  | **完了済み:** browser WebTorrent runtime、Service Worker、`webtorrent` dependency、browser peer UIを撤去。Magnet URI dialogのvisual shellは残し、submit時はEizouDendenshi未接続の案内を表示する（接続は開始しない）。ED-3で共通source dialogへ切り替える                                                                                                                                                                                                                               | browser WebTorrent runtime / dependency / peer testが残らない。接続を偽装するsubmitを作らない |
| ED-2A | **完了済み:** Go stdlibのloopback-only companion skeleton。6桁pairing code、**2026-08-03以降はpersistent token**（当初はmemory-only token。現在はuser-private credential storeへ永続化 — 下記[Persistent pairing credential](#persistent-pairing-credential2026-08-03実装)）、exact CORS、health / pair API、Windows x64 / Android arm64 cross-build                                                                                                                                                                                                                                                                                                                  | Windows / Android cross-build、unit / vet、Mimo review APPROVE                                |
| ED-2B | **完了済み:** token query付き静的fixture Range endpoint。Windows Chromeからpairing、206 Range、exact ACAO、no-store、canvas `toBlob`、captureStream、MediaRecorderを実測                                                                                                                                                                                                                                                                                                               | background server cleanup、fixture削除、Mimo review APPROVE                                   |
| ED-2C | **部分完了:** Termux `go1.26.5 android/arm64`でpure-Go binaryを実行し、background loopback pairing / Range `206` smokeとcleanupを実測。Android Chrome LAN dev originからpair / Range `206` / detached video / canvas `toBlob` / captureStream / MediaRecorderを実測（静的fixture）。`--allow-origin`は開発専用でrelease allowlistへ入れない。**growing mediaのRange contractはWindows / Termux loopbackで通過済み（2026-07-31・downloaderなし・`503`/`Retry-After` buffering）。Windows Chromeのgrowing progressive再生も計測済み（2026-07-31・503→error code 4・自動再試行なし・追記のみでは回復せず・明示`load()`+`play()`で206再生・reload後seek成功）。Android Chromeのgrowing再生・bridge実装は未検証/未実装**。HTTPS Entei origin、Minisign deliveryは未実装 | Checkpoint 1 / 2のHTTPS部分・Android Chromeでのgrowing progressive検証と、checkpoint 5 |
| ED-2D | **Stage A 完了・Stage B（Android/Termux arm64）通過済み（2026-07-31）:** `companion/eizoudendenshi/`でrelease helper（`scripts/release.ps1`: windows/amd64 + android/arm64 build、version付きmanifest、detached Minisign署名、keyは明示arg/envのみ）、Termux bootstrap template（`scripts/termux-bootstrap.sh`: HTTPS限定・pinned key fail-closed・Termux/aarch64検証・前提pkgのみ導入・private temp・署名/SHA-256検証後にapp-private atomic install・foreground pairing・helper contract fail-closed・GitHub Release assetの302 redirectを追うfetch）、自動test harness（`scripts/test-release.ps1`: 一時Minisign鍵のみ`A:\Temp\opencode`使用、成功install + release identity（banner version = manifest version / plain buildはdev default維持）+ tampered manifest/binary/missing sig/wrong arch/unsafe URL等のfailure-before-installを66/66 greenで検証）。Windows x64 installerは未実装。**rc.1 clean Termux installでGitHub Release assetの302 redirect不追従を実証→fetch修正済み（`--location` + `--max-redirs 5` + `--proto-redir =https`）→新規immutable rc.2でStage B通過済み（2026-07-31）** | **Stage B（Android/Termux arm64通過済み・2026-07-31・rc.2）: clean Termux aarch64実機でAPK後のbootstrap commandだけからpairing code表示まで到達**（実HTTPS release base・実pinned key・実ELF install + exec・manifest / binary Minisign verify PASS・signed manifestに対するSHA-256 PASS・install bytes 6291752 / SHA-256 `d4cf15b544cffbaf60b1f1a35b8d0751436ef6456edca3a31e921fd9f15046b7`がGitHub asset digestと一致・`eizouden-bootstrap` temp dir残存なし）。rc.1はredirect不追従で失敗（gate未通過）。**release identity表示不整合（rc.2: manifest 0.2.0-rc.2 vs banner `EizouDendenshi ED-2B (0.2.0)`）はツーリング側で修正済み**（`scripts/release.ps1`がvalidated `-Version`を両binaryへlink time注入、Go + harnessテストでdev default / banner契約を固定）**。`rc.3`（2026-07-31）の実機検証でclosed**（banner `EizouDendenshi ED-2B (0.2.0-rc.3)`がmanifest versionと一致）。**delivery完了は主張しない**: Windows x64 installer・HTTPS Entei origin・growing media・audio listening/decodeが残る |
| ED-2E | **実装済み（2026-07-31）:** companion `GET/HEAD /v1/media/status`（origin + token gate、no-store、HEAD/OPTIONS parity、metadata-only: `state`/`available`/`total`/`headReady`/`retryAfter`、static fixture不変・growingはmonotonic snapshot・source failureはfail-closed generic — Go 11 tests green）+ Entei bridge（`companion-bridge.ts` controller + `use-companion-bridge.ts` hook: 単一in-flight chained poll・epoch/AbortController cancel・backoff（`max(Retry-After,1s)`→×2→30s cap・進捗でreset）・bounded failure → disconnected/error・401/403 → `rePairRequired`・`complete`ゲートの明示src/load→metadata/canplay→pendingSeek→intent play・media error再確認 + bounded explicit reset・**session stateはページメモリのみ（2026-08-03以降、pairing tokenだけは永続化 — opaque localStorage envelope + companion credential store）** — web 17 tests green）。**未実装**: source dialog UX（fixture統合はinternal entryのみ・Magnet / YouTubeは非機能）・`headReady` byte-level検査・production bridge。**未実施**: headed Windows Chrome / Android Chrome browser QA | Go + web自動テストgreen（Go 11・web 29・browser QAは別gate） |
| ED-2F | **実装済み（companion Go foundation）:** YouTube local source job（`internal/youtube` URL validation + `internal/job` manager: 固定argv・shell不使用・1080p cap・one active session 409・cancel/timeoutでprocess tree kill + reap・private temp dir lifecycle・metadata-only redaction）。`POST/GET /v1/source/jobs(/{id})(/cancel)`（origin + token gate・OPTIONS preflight）。`/v1/media/status` / `/v1/media/fixture`はactive jobを優先してmapping（buffering/complete/error・503/404）し、static fixture / grow contract既存テストは不変。`--ytdlp` / `--job-timeout` flag。fake helperによるGoテストgreen（youtube + job + api、`go test -race ./...`）。**未実装**: 実yt-dlp download QA・user-facing YouTube URL入力・cookie / saved-profile・production bridge接続 | Go自動テストgreen（`go test -race ./...`・youtube / job / api）。実download QA・browser QAは別gate |
| ED-2G | **実装済み・コード側完了:** anacrolix/torrent engine torrent local job（`internal/torrent`: btih magnet validation・安全なtracker保持・**per-job Engine/Client**（v1.61 #1048回避）・loopback-only・no seeding・private session・**max 2 concurrent torrent sessions + oldest-first eviction + 30s TTL**・evicted snapshotに`errorCode`（`torrent_concurrency_limit`）・YouTube×torrent cross-kind conflict（409）・**head bootstrap（4 MiB head window PiecePriorityHigh + StartBootstrap reader）・verified-prefix streaming**・cancel/timeout cleanup・metadata-only redaction）+ file list / selection（**metadata取得直後にlist**・video 1 + subtitle 1契約・Player native allowlist一致・no-eligible-videoは終端error）。`POST/GET /v1/source/torrents(/{id})(/cancel)(/files)(/select)`（origin + token gate・OPTIONS preflight）。status / fixtureはselection前`buffering`（503）・selection後`streaming`（verified prefix 206 / 503+Retry-After・`playable`）→`complete`（206）でmapping。**errorCodeはstatus responseに含まれ（`activeTorrentStatus`）、frontend bridge/ MagnetInputでlocalized error messageにマッピング**。aria2依存は全て削除済み。**実際の環境ではまだ未確認なので、残りはE2Eテストだけ** | Go自動テストgreen（`go test -race -count=5 ./...`・torrent / api）。最終E2Eでまとめて確認 |
| ED-3  | 3-button source entry、共通Magnet / YouTube dialog、shadcn Input OTP pairing、Default Cookie modalを実装                                                                                                                                                                                                                                                                                                                                                                               | pairing済みlocalhost companionとの実機接続                                                    |
| ED-4  | YouTube source / Japanese subtitle、forward torrent file selection / buffer / cleanupを順に接続                                                                                                                                                                                                                                                                                                                                                                                        | Required PoC checkpoints 3, 4                                                                 |

ED-1時点のMagnet URI buttonはvisual shellとして表示し、submit時はEizouDendenshi未接続の案内を表示するものだった（送信先のない接続を偽装しない）。**現在は置き換え済み**: Magnet buttonは実torrent source dialog（ED-2G・2026-08-02）、YouTube buttonは実URL dialog（ED-2F）として機能する。ED-3の共通source entry dialog化は将来のUI整理として残る。

## Torrent engine移行方針（承認済み・実装済み・実swarm E2Eは未実施）

### 比較した3案と採用順位

| 順位 | 参照先 | Enteiへの判断 |
| --- | --- | --- |
| 1 | [BitPlay](https://github.com/aculix/bitplay) | **torrent engineの設計を採用する。** Go内で`anacrolix/torrent`を直接使い、選択fileのReader・seek位置のpiece優先・readaheadをengine自身へ渡す。 |
| 2 | [TorrServer](https://github.com/yourok/TorrServer) | **streaming戦略だけを参考にする。** 再生位置中心のpriority window、readahead、idle session cleanupを取り入れる。TorrServer本体、LAN/public bind、永続cache、DLNA、検索、GStreamer runtimeは持ち込まない。 |
| 3 | [torrent-stream-server](https://github.com/KiraLT/torrent-stream-server) | **UIフローのみ参考。** Node / Express / WebTorrentのruntimeはEizouDendenshiへ導入しない。 |

### 決定

aria2 torrent subsystemは`anacrolix/torrent` engineへ完全置換した。aria2はYouTube download helperとして不要となり、全flag・config・helper payload・release contract・テストから削除済み。yt-dlp / ffmpegは維持。現在のpairing、**persistent token（2026-08-03以降: user-private credential storeへ永続化・旧memory-only契約は廃止）**、exact CORS、loopback-only bind、Range API、session-only cleanup、Magnet UI、YouTube job、CLI、署名release/bootstrapは維持する。

```text
維持: pairing / persistent token / CORS / localhost Range API / YouTube / CLI / release bootstrap

完了: aria2 torrent process + file polling + 外部SHA-1 prefix verifier + --aria2 flag + helper contract
   → anacrolix/torrent engine + selected-file Reader + seek priority + readahead
```

### 移行後のtorrent contract（実装済み）

1. Magnet metadataを取得し（`engine.Start`・bounded）、**metadata取得直後に**sanitized file listを表示する（payload完了を待たない）。
2. ユーザーがvideo 1本と任意subtitle 1本を選ぶ。
3. 選択file以外はdownload priorityを持たない。選択videoの先頭4 MiB windowを`PiecePriorityHigh`へ昇格し、bootstrap readerがbyte 0のdemandを維持（`StartBootstrap`・readahead 4 MiB） — **verified contiguous prefixが先頭から成長する**。
4. HTTP Rangeはverified prefix内のみ206で応答し、未取得Rangeは明示的な`503 + Retry-After` bufferingにする。偽bytes・file-size推測・zero probingはしない（既存ED-2C growing契約と同一）。
5. stop / cancel / timeout / idle時はtorrent sessionとsession-only mediaを削除する。seedはしない。

この移行で、file境界をまたぐpieceやseek先のpriorityをaria2のfile pollingから推測せず、engineが持つpiece stateで正確に扱う。MP4/MKVのnative decode可否は引き続きbrowser E2Eで測定し、transcodeや永続cacheは追加しない。

**状態:** コード側で実装済み。anacrolix/torrent engineへの完全移行、aria2全flag・helper payload・release contract削除完了。実際の環境ではまだ未確認なので、残りはE2Eテストだけ。

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
- Magnet URI dialogのvisual shellはED-1でも残したが、**ED-2G（2026-08-02）で実torrent source dialogへ置き換え済み**（submitは実jobを作成する）。browser WebTorrent endpointやpeer gateは再利用しない。
- [WEBTORRENT_STREAMING.md](./WEBTORRENT_STREAMING.md)はhistorical withdrawal recordとして残し、browser WT-2以降は実装しない。

## Readiness verdict

**Ready with checkpoints.**

product boundary、platform target、credential lifecycle、release検証、YouTube字幕、torrentのforward-only seek contractは決定済み。Windows / Android Chromeの静的fixtureではloopback CORS、Range、canvas capture、MediaRecorderまで実証済み。TermuxではAndroid arm64 binaryのloopback pairing / Range smokeまで通過した。ED-2D Stage Aではrelease helper / Termux bootstrap template / 自動test harnessを実装し、tampered manifest / binary、署名欠落、wrong arch、unsafe URL、helper contract不一致がinstall前に拒否されることを一時鍵で66/66検証した。**rc.1のTermux clean-installでGitHub Release assetの302 redirectを追わないbootstrap不具合が判明**し、fetchを`--location` + bounded `--max-redirs` + HTTPS-only redirectへ修正した。**修正後の`eizoudendenshi-v0.2.0-rc.2`でED-2D Stage B（clean Termux aarch64実機のbootstrap→pairing到達）は2026-07-31に通過済み**（manifest / binaryのMinisign検証・signed manifestに対するSHA-256検証・app-private install・foreground pairing・install bytesとdigestがGitHub assetと一致）。ただしrelease manifest（0.2.0-rc.2）とbinary banner（`EizouDendenshi ED-2B (0.2.0)`）の**release identity表示不整合**を確認した。この表示不整合はツーリング側で修正し（`scripts/release.ps1`がvalidated `-Version`を両release binaryへlink timeに注入、Go + harnessテストでdev default `0.2.0`・banner契約・manifestとbannerの一致を固定）、**`rc.3`（2026-07-31）の実機検証でclosed** — Termuxでmanifest署名・core署名・signed SHA-256・app-private installがPASSし、foreground bannerが`EizouDendenshi ED-2B (0.2.0-rc.3)`を表示してmanifest versionと一致した。HTTPS Entei origin、Android Chromeのgrowing progressive再生、audio listening/decode、Windows x64 installerは未実証 — **delivery完了は主張しない**。growing mediaのRange contractは**ED-2CでWindows / Termux loopback実測通過済み（2026-07-31）**（downloaderなし・`503`/`Retry-After` buffering）。**Windows Chromeでのgrowing progressive再生計測は2026-07-31に通過済み**（503→error code 4・自動再試行なし・追記のみでは回復せず・明示`load()`+`play()`で206→最後まで再生・reload後seek成功）。**Android Chromeのgrowing再生は未計測。yt-dlp source job（ED-2F・実download QA 2026-08-01通過）とtorrent job（ED-2G・anacrolix engine・aria2全削除）は実装済み。実swarm E2E・headed / Android browser QAは未実施**。**ED-2E buffering bridgeは実装済み（2026-07-31）** — companion `GET/HEAD /v1/media/status`（Go 11テスト）とEntei bridge controller/hook（web 17テスト）がgreen。`complete`ゲートの明示src reset/load/play・pendingSeek/intent保持・単一in-flight backoff poll・401/403 → re-pair・session stateはpage-memoryのみ（tokenの永続化は2026-08-03以降のpersistent pairing契約へ移行）。**未実装**: source dialog UX（fixture sessionはinternal QA entry経由のみ）・`headReady` byte-level検査・production bridge。**未実施**: headed Windows Chrome / Android Chromeの実ブラウザQA。**ED-2F YouTube local source job foundationは実装済み（companion Go・fake helperでgo test -race green）**: internal/youtube URL validation + internal/job manager（固定argv・shell不使用・1080p cap・one active session 409・cancel/timeoutでtree kill + reap・private temp dir・metadata-only redaction）+ POST/GET /v1/source/jobs(/{id})(/cancel)（origin + token gate）とstatus/fixtureへのjob mapping。--ytdlp / --job-timeout。**実yt-dlp download QAは2026-08-01に全面成功・user-facing YouTube URL入力は実装済み（後述記録）。cookie / saved-profile・subtitlesは未実装**。**ED-2G torrent job foundationは実装済み（companion Go・anacrolix/torrent engine・fake Engineでgo test -race green）**: internal/torrent magnet validation（btihのみ・安全なtracker保持）+ manager（Engine interface・one-active session（YouTubeと共通）・metadata→file list→selection→streaming/complete・cancel/timeoutでsession drop + cleanup・metadata-only redaction）+ head bootstrap（4 MiB head window PiecePriorityHigh + StartBootstrap reader・verified-prefix streaming）+ file list / selection（metadata取得直後にlist・video 1 + subtitle 1・Player native allowlist一致・no-eligible-videoは終端error）+ POST/GET /v1/source/torrents(/{id})(/cancel)(/files)(/select)。status / fixtureはselection前buffering（503）・selection後streaming（verified prefix 206 / 503・playable）→complete（206）。--torrent-timeout。**Magnet UIは実装済み（2026-08-02）。残りは実swarm download E2E・Android / headed Windows browser QA**。**ED-2D Windows x64 helper-enabled release + bootstrapは実装済み（tooling / harness green・clean実機QAはgate）**: scripts/windows-bootstrap.ps1（HTTPS-only・pinned key fail-closed・$env:LOCALAPPDATA\GoRakuDo\EizouDendenshi user-private root・per-artifact Minisign + signed-manifest SHA-256検証後にatomic置換・verified installはversion+hashでreuse・archiveは検証後extract + expected filename strict・--ytdlp/--ffmpeg絶対pathでcore起動（**aria2はanacrolix移行でhelperから全削除**）・ffmpegはprocess-scoped PATH（永続PATH変更なし））+ scripts/release.ps1の-HelpersFile（explicit local入力のみ・vendor downloadなし・**v2/v3 helper契約（helpers: yt-dlp / ffmpegのみ）**はTermux v1と共存しTermuxは不変で66/66 green）+ scripts/test-windows-bootstrap.ps1 harness（**106/106** green: install/reuse/missing-fetch/tamper各fail-closed/version mismatch置換/unsafe名/unknown key/v1拒否/PATH不変/temp cleanup）。**残るgate**: clean Windows実機bootstrap・実swarm E2E（anacrolix engine）・Android/headed Windows browser QA。**Windows first-run verifier trust bootstrap実装済み**: windows-bootstrap.ps1はminisign非搭載の一般ユーザーでも、Eizou release artifact download前にpinned official minisign 0.12 win64 ZIP（URL + SHA-256 37b60034… + member minisign-win64/x86_64/minisign.exe + version固定）をHTTPS bounded redirectsで取得し、hash verify→extract→version check→private rootへのatomic install（reuseはrecorded SHA + version contract、PATH executableは一切trustしない）。harnessは**70/70 green**（V1 first-run auto-fetch / V2 reuse / V3 tampered ZIP hash拒否 / V4 wrong archive / V5 unavailable / V6 PATH・global installなし + T1-T16）。**rc.5（初回verifier auto-setupを初めて搭載）のclean Windows gateは実測FAIL**: 公開`eizoudendenshi-v0.2.0-rc.5` bootstrapは一般初回実行（EIZOU_WIN_MINISIGN_MIRROR未定義）で`Test-Path -LiteralPath $env:...`が$null binding errorをthrow（PowerShellの`$env:X -ne ''`は$nullでTRUEのため）→ verifier取得前にクラッシュ（harnessはmirror envを常に設定していたため70/70では検出不能だった）。最小修正（$null guard）+ static regression checkをrepoに適用、harnessは**71/71**。**clean Windows gateはrc.5では成立せず、修正版rc.6+で再実施が必要**。**rc.6向け修正（未リリース・未ゲート通過主張なし）**: ①archive helperは抽出後、strict runtime filename（aria2c.exe / ffmpeg.exe）でprivate helpers\ ディレクトリにatomic install（release artifactはlogical archive名のままdownload/verify、helpers-state.jsonはartifact/version/SHA→runtime名+runtime SHAを記録、coreへは絶対runtime path `--ytdlp <...>\yt-dlp-windows-amd64.exe` / `--aria2 <...>\aria2c.exe`を渡し、process-scoped PATHはffmpeg.exeをliteralに含むruntime dirを前置）。rc.5のmalformed/legacy（archive-name）stateは検出・置換されreuseされない。②もう1つの実バグ: pwsh 7では`-OutFile`単独でInvoke-WebRequestが$nullを返すため、production（no-mirror）fetchのHTTPS-redirectチェックが無応答になり毎回失敗していた（-PassThruで修正）。Windows harnessは**81/81**（true unset-env regression＝実pinned official verifier fetch + deterministic download-unavailable含む）。**rc.6 clean Windows gate: PASSED（実測 2026-08-02）**。公開済みimmutable `eizoudendenshi-v0.2.0-rc.6` GitHub assets（ローカルmirrorなし・PATHにminisignなし・mirror envなし・fresh private root）で: true first runがofficial pinned verifier（Minisign 0.12）を取得・検証し、manifest/core/3 helpersをprivate install、coreは絶対runtime helper pathで起動。installed versionはmanifest契約と一致（yt-dlp 2026.07.04 / aria2 1.37.0 / ffmpeg 2026-07-27-git-a757b708ae-essentials_build-www.gyan.dev）。helpersはruntime名（aria2c.exe / ffmpeg.exe）で物理配置されarchive名実行ファイルはrootに無し。同一rootでの2回目実行はverifier/helpersをreuse（再取得なし）。persistent PATH / global install変更なし、cleanup完了確認済み。

## Next action

ED-2D Stage B（clean Termux aarch64 gate）は2026-07-31に`eizoudendenshi-v0.2.0-rc.2`で通過済み。**release identity表示不整合（manifest 0.2.0-rc.2 vs banner `EizouDendenshi ED-2B (0.2.0)`）の修正はbuild-time version injection（`scripts/release.ps1`のlink time `-Version`注入 + Go / harnessテスト）で実装し、`eizoudendenshi-v0.2.0-rc.3`の実機検証（2026-07-31）でclosed** — Termuxでmanifest署名・core署名・signed SHA-256・app-private installがPASSし、foreground bannerが`EizouDendenshi ED-2B (0.2.0-rc.3) listening on http://127.0.0.1:36441`を表示した。**Persistent pairing credential redesignは2026-08-03に実装済み**（旧page-memory-only契約を置換: companion `internal/credential` + `GET /v1/pair/status` / `DELETE /v1/pair`、browser localStorage envelope + mount検証 + 明示reset UI、Go / web自動テストgreen — 本節冒頭の状態行と[Persistent pairing credential](#persistent-pairing-credential2026-08-03実装)参照）。次のactionは、①ED-2C残りのHTTPS Entei origin・**Android Chromeでのgrowing progressive再生**・audio listening/decodeを検証する（growingのRange contractはloopback通過済み、**Windows Chromeのgrowing計測は2026-07-31に完了**、Android Chromeの実ブラウザ計測が残る。bridge実装は完了済み）、②Windows x64 installerを実装する、③**persistent pairingの実機QA**（Windows実機でのDPAPI credential round trip・companion再起動後のreload再検証・reset flow、Termuxでのapp-private credential・headed browser検証）、④**torrentの実swarm E2E**（max 2 torrent sessions + oldest-first eviction + 30s TTL + per-job Client + YouTube cross-kind conflictのanacrolix engineでmetadata→file list→selection→verified-prefix streaming→completeを実swarmで確認。aria2時代のpeer/metadata timeout記録はanacrolix engineで再実施する必要がある）。その後ED-3のInput OTP / 共通source UIへ進む。

## Peer transport開放（根本原因修正・2026-08-04実装・未commit）

**根本原因**: anacrolix v1.61はuTP socketとDHT serverを同じUDP socketで動かし、そのsocketを**外向きdial**にも使う。`cfg.ListenHost = torrent.LoopbackListenHost`（loopback bind）のままだとDHTクエリ・uTP peer接続・udp tracker announceが外部へ一切届かず、HTTP tracker / TCP peerだけが生き残る — udp tracker主体のmagnet（nyaa等）ではmetadataが永遠に取得できない。

**修正**: `clientConfig()` から `ListenHost` 設定を削除し、anacrolix default（空 = 全インターフェースbind）に戻す。`ListenPort = 0`（ランダム）、`Seed = false`、`NoUpload = true` は維持。

**セキュリティ境界（不変）**:

- HTTP APIは引き続きloopback専用（`127.0.0.1:4322`、コマンド側でenforce）。peer transport開放はAPI listenerに一切影響しない。
- `NoUpload = true` / `Seed = false` — アップロード・seedはしない。
- metadata-only → 選択後のみpayload契約は不変（未選択ファイルはpriority None）。
- **Windows**: 初回起動時にephemeral listen portのファイアウォールプロンプトが出る可能性がある。拒否しても外向きUDPが通るネットワークではDHT / udp tracker / uTPは機能する（受信は制限される）。
- anacrolixの生Sloggerは引き続き`io.Discard`（生ログはpeer IP等を含みうるためファイルへ書かない）。

**検証**: real anacrolix clientで`Listeners()[0].Addr()`が`0.0.0.0:port`/`[::]:port`（loopbackでない）ことを`TestClientConfigBindsAllInterfaces`で固定。既存storage / manager / APIテストは全回帰なし。

## ファイル診断ログ（2026-08-04実装・未commit）

「裏で何を実行するか」をファイルへ出力する`internal/diag`パッケージ（stdlibのみ）。

**場所と運用**:

- Windows: `%LOCALAPPDATA%\GoRakuDo\EizouDendenshi\eizouden.log`
- Android/Termux: `$PREFIX/var/log/eizouden.log`
- harness/test override: `EIZOUDEN_LOG_DIR` env（productionでは未設定）
- 上限1 MiB。超過時は`eizouden.log.1`へ回転（前回分は上書き）して新規開始。mode 0600、append。
- ログパスはAPI応答・CLI出力・エラーメッセージへ一切出さない。CLI Service Statusは`log: enabled/disabled`のみ表示。

**書かれるもの（redaction済み）**:

- 起動/終了（version・platform）、APIリクエスト（`method path status`、**query除去済み** — `?token=`は絶対に書かない）、pairing成功/失敗のみ、torrent jobライフサイクル（job ID・**短縮infohash（先頭12 hex + `…`）**・file数・video有無・select file ID・errorCode）、10秒ごとのengine診断（peer / active / seeder数、DHT node数、DHT announce成功/試行数）。

**絶対に書かれないもの**: magnet全文・tracker URL（`tr=`）・infohash全文・token・pairing code・cookie・ローカル絶対パス・API URL・helper path・credential。anacrolix生ログはファイルへ書かない（peer IPを含みうるため）。

**テスト**: `internal/diag`単体（書込み/回転/Close/ShortInfohash/DefaultDir）、redaction test（fake engineで実job実行 → magnet・`tr=`・64hex token・`127.0.0.1:4322`・`C:\`・pairing codeがログに無いことを実ログで確認、`?token=` がリクエストログに無いことも確認）、transport test（real anacrolix clientでnon-loopback bind確認）。全Go package回帰green、`go test -race ./...`・`go vet`・`gofmt -l` clean、release harness 91/91・Windows bootstrap harness 106/106。実機E2Eは未実施。
