# Subtitle Sync — subomatic 統合（字幕タイミング自動同期）

> Entei の字幕タイミングズレ問題を解決する機能。サブタイトル同期エンジン **subomatic**（Apache-2.0・Rust・WASM対応）を Entei に統合し、字幕のタイミングを**音声**または**動画内字幕（参照）**に自動で合わせる。
>
> 状態: **設計確定（2026-08-13）・字幕取得手段確定（2026-08-13）・エンジン実装フェーズ**。ユーザー確定事項の一次ソース。

## 1. 目的

ユーザーがインポート・選択した字幕（SRT/VTT/ASS等）が動画のタイミングとズレている問題を、**手動調整なし**で解決する。2つの同期モードを提供する:

- **sub-to-audio**: 字幕を動画の**音声**（人の声の活動）に合わせる。
- **sub-to-sub**: 字幕を**動画内の字幕**（参照トラック・例: 英語字幕）に合わせる。ユーザーが選択・インポートした字幕を、動画に内蔵された字幕のタイミングに自動で揃える。

## 2. 確定スペック（ユーザー確定・2026-08-13）

1. **同期モードは両方実装する**（sub-to-audio + sub-to-sub）。
2. **sub-to-sub の参照ソース**は**動画に入った字幕**（= 動画に内蔵/紐づく字幕トラック）。例: 動画内の英語字幕を参照として、ユーザーが選択・インポートした字幕を自動でタイミング合わせする。
3. **エンジン**: subomatic（Apache-2.0・クリーンルーム実装・kaegi論文ベース・alass の GPL ソース不使用）を **WASM でブラウザ内実行**。アップロードなし・ローカル完結。
4. **クレジット追加機能は除去する**: subomatic の WASM バインディングは出力字幕の末尾に「Synced with subomatic.github.io」クレジットを追加するが（`lib.rs:19`・web アプリ用）、**Entei 統合ではこの Function を外す**カスタムビルドを行う。
5. **音声デコード**: sub-to-audio はブラウザの **WebAudio API**（`AudioContext` + `decodeAudioData`）でデコードし、モノラル f32 PCM を WASM へ渡す（= ffmpeg 不要・ブラウザ再生できる形式なら何でも対応）。
6. **ライセンス**: Apache-2.0・`NOTICE` 保存義務あり（§4(d)）。Entei への統合は問題なし。サードパーティ（libav 等）は CLI のみで WASM パスは不使用。
7. **Sync モード（設定モーダルの 3 トグル・排他選択）**: **字幕 / 音声 / 自動** の 3 モード。**デフォルトは字幕モード**。
8. **字幕モードの挙動**: 動画内字幕（参照）がない場合、Toast 通知「この動画のベース字幕はないため同期されない」を表示し、**以降何もしない**（= 自動で音声モードにフォールバックしない。ユーザーは手動で音声モードへ切り替えられる）。
9. **自動モードの挙動**: **sub-to-sub を優先**し、動画内字幕がない場合に**自動で sub-to-audio** へフォールバックする。
10. **実装順**: ①エンジン（WASM カスタムビルド + Worker）→ ②データフロー（同期処理の流れ）→ ③設定トグル UI → ④同期ボタン等のフロント UI（**フロント UI は最後**）。
11. **ソース種別ごとの対応（2026-08-13 確定）**:
    - **YouTube 動画**: 検知して**同期ボタンを出さない**（= YouTube の自動字幕タイミングはほぼ正確なため同期不要）。
    - **ローカルファイル**: `decodeAudioData` で高速フルデコード（EizouDendenshi 不要）。
    - **companion 動画（Magnet）の sub-to-sub**: **高速処理可**（字幕ファイル数十 KB の DL だけで完了・動画本体の DL 完了は待たない）。参照字幕は companion の `fetchMagnetSubtitle` で内蔵字幕ファイルを取得（実装済み）。
    - **ローカル動画の sub-to-sub**: MKV 内蔵トラックはブラウザの `video.textTracks` に公開されないため（実測確認）、**参照用の字幕ファイルをユーザーが選択**する。
    - **companion 動画（Magnet）の sub-to-audio**: **動画全体の DL 完了が必要**（音声 PCM は全編必要）。DL 完了待ちの確認ダイアログ → 進捗 % 表示 → 完了後に同期。
12. **Magnet sub-to-audio の DL 待ち UI（2026-08-13 確定）**: ストリーミング動画では音声ベース同期が即時不可能なため、**shadcn AlertDialog**（Radix AlertDialog）で確認:
    - 文言: 「ストリーミング動画のため音声ベースの字幕同期は不可能です。もう少しデータ取得完了まで待ってもらえます？」
    - ボタン: **「キャンセル」** / **「はい、大丈夫です」**
    - 「はい」→ ボタンが **DL 進捗 %** に変化（companion の `available/total` をポーリング・既存 `/v1/media/status` 利用）: `[キャンセル] [23%] → [30%] → [35%] → … → 100%`（23% は例示・実際は `available/total` から算出した実進捗率を表示）
    - 100% 到達 → 同期実行（companion PCM 変換 → WASM）・「キャンセル」→ 何もしない

## 3. subomatic 調査結果（2026-08-13・ローカル `A:\subomatic` + GitHub 確認）

### 3.1 プロジェクト構成

| クレート | 役割 |
|---|---|
| `subomatic-core` | 純 Rust・`#![forbid(unsafe_code)]`・ネイティブ/WASM 両対応。字幕モデル・フォーマットアダプタ・VAD・同期エンジン |
| `subomatic-cli` | CLI（libav FFI リンクで音声デコード） |
| `subomatic-wasm` | wasm-bindgen バインディング（ブラウザ向け） |
| `web/` | ブラウザアプリ（static HTML/JS + WASM） |

### 3.2 同期エンジン（コア）

- **1つの統一動的計画法（DP）**。`split_penalty` で 1 つのグローバルシフト（= ffsubsync 相当）とピースワイズシフト（= alass 相当・広告/カット吸収）を切り替え。
- fps ドリフトスキャン（23.976/24/25/29.97）でフレームレート差も吸収。
- 入力は**区間集合**（参照の活動スパン + 字幕の各行スパン）。エンジンは PCM を直接見ない（VAD は外側）。

### 3.3 VAD（音声活動検出・sub-to-audio 用）

| VAD | 特徴 |
|---|---|
| `EnergyVad`（`vad: "energy"`） | 依存なし RMS エネルギー検出・高速・簡易。音楽/効果音が多い音声では誤検出しやすい |
| `EarshotVad`（`vad: ""` または `"earshot"`） | 純 Rust のニューラル音声検出（FFT + mel 特徴）。**既定**・より高精度 |

### 3.4 WASM API（`lib.rs` 確認済み）

```js
// sub-to-sub: 字幕を参照字幕に合わせる
sync_to_reference(input, format, referenceText, referenceFormat, fps, outFormat, onProgress)

// sub-to-audio: 字幕を音声 PCM に合わせる
sync_to_audio(input, format, samples: Float32Array, sampleRate, fps, outFormat, vad, onProgress)
// vad: "energy"（高速） / "" or "earshot"（高精度・既定）
// onProgress(stage, fraction): "speech" → "align" の 2 フェーズ・0.0〜1.0
```

- `format` / `outFormat`: `"srt"` / `"vtt"` / `"sub"` / `"ass"` / `"ssa"`（大文字小文字不問・`""` で入力形式を維持）
- `fps`: MicroDVD 用（`is_valid_fps` チェック）
- **クレジット**: 出力末尾に `Synced with subomatic.github.io` を 1 秒ギャップ + 3 秒間で追加（`lib.rs:19-22,132,157`）→ **Entei では除去**

### 3.5 Web 側の音声デコード（`web/app.js` 確認済み）

```js
const Ctx = window.AudioContext || window.webkitAudioContext;
const audio = await ctx.decodeAudioData(bytes);   // ブラウザがデコード
const channel = audio.getChannelData(c);           // f32 PCM
// → モノラル化して Worker へ転送 → WASM 実行
```

### 3.6 Worker 構成（`web/worker.js` 確認済み）

- WASM はメインスレッドで動かさず **Worker で実行**（同期・数秒の可能性があるためページ応答性維持）。
- `AudioContext` は Worker で使えないため、**デコードはメインスレッド**・PCM のみ Worker へ転送。
- `init()` を即時実行して WASM を事前ロード。

## 4. Entei 統合アーキテクチャ

```text
[Entei /player/]
  SubtitlePanel
    └─ 「同期」ボタン（字幕選択時・動画再生中）
         ├─ モード: 字幕 / 音声 / 自動（§2 の 7-9 参照）
         ├─ ソース種別で分岐（§2 の 11-12）:
         │    ├─ YouTube → 同期ボタン非表示
         │    ├─ ローカル → WebAudio デコード → モノラル f32 PCM
         │    ├─ Magnet sub-to-sub → companion 字幕 DL（数十 KB・DL 完了不要）→ 直接 sync_to_reference
         │    └─ Magnet sub-to-audio → AlertDialog 確認 → DL% 待ち → companion PCM 変換
         └─ sync-worker（Web Worker）
              └─ subomatic WASM（custom build・クレジット除去）
                   ├─ sync_to_audio / sync_to_reference
                   └─ onProgress("speech"/"align") → プログレス表示
    └─ 結果: 同期済み字幕を表示・必要なら保存（i18n 済み）
```

### 4.1 資産配置

- `apps/web/public/wasm/` — カスタムビルドした `subomatic_wasm.js` / `.wasm` / `.worker.js` 等
- Worker コードは React 側（`src/`）に配置

### 4.2 カスタムビルド（クレジット除去）

subomatic の `crates/subomatic-wasm/src/lib.rs` をフォーク・変更:

- `CREDIT_TEXT` / `CREDIT_GAP_MS` / `CREDIT_DURATION_MS` 定数と `append_credit()` 呼び出し（`sync_to_reference_impl` / `sync_to_audio_impl`）を削除
- ビルド: `wasm-pack build crates/subomatic-wasm --target web --out-dir <Entei>/apps/web/public/wasm`
- ライセンス遵守: Apache-2.0 の `NOTICE` を Entei 内に保持（`THIRD_PARTY_NOTICES` 等）

## 5. UI 仕様

### 5.1 Sync モード設定（設定モーダル・優先実装は UI の中でも後）

- 設定モーダル（SettingsTabs）に **Sync モード**の 3 トグル（排他）を追加:
  - **字幕**（デフォルト）— sub-to-sub
  - **音声** — sub-to-audio
  - **自動** — sub-to-sub 優先 → 動画内字幕なければ自動で sub-to-audio
- 既定は**字幕モード**（localStorage に永続化、既存の設定パターンに倣う）。
- 字幕モードで動画内字幕がない場合: Toast 通知「**この動画のベース字幕はないため同期されない**」（i18n 3 言語）→ 以降何もしない。
- 自動モード: 動画内字幕があるなら sub-to-sub、なければ sub-to-audio を自動選択。

- **場所**: SubtitlePanel（字幕パネル）に「同期」ボタン/アクションを追加（= ④フロント UI・最後に実装）。
- **sub-to-sub の参照選択**: **Magnet** は companion 経由で取得した内蔵字幕ファイルの一覧から参照を選ぶ。**ローカル**は参照用の字幕ファイルをユーザーが選択（MKV 内蔵トラックはブラウザから読めないため）。ユーザーがロードした字幕が参照に合わせて同期される。
- **プログレス**: `onProgress` を表示（TypewriterLoading 等の既存パターン）。フェーズはモードで異なる: **sub-to-audio** は `"speech"` → `"align"` の2フェーズ、**sub-to-sub** は `"align"` の1フェーズのみ。
- **結果**: 同期済み字幕でプレイヤー字幕を差し替え。保存は「適用」ボタン（メモリ内 or エクスポート）。
- **エラー時**: 既存のエラートースト/フォールバック表示。
- **Magnet + 音声モードの DL 待ちダイアログ**: ストリーミング動画のため音声ベース同期が即時不可能な場合、**shadcn AlertDialog**（Radix AlertDialog）を表示:
  - タイトル/本文: 「ストリーミング動画のため音声ベースの字幕同期は不可能です。もう少しデータ取得完了まで待ってもらえます？」
  - ボタン: 「キャンセル」 / 「はい、大丈夫です」
  - 「はい」→ ボタンが **DL 進捗 %** に変化（`[キャンセル] [23%] → [30%] → [35%] → …`・companion の `available/total` をポーリング・23% は例示で実際は実進捗率）
  - 100% 到達 → 同期実行（companion PCM 変換 → WASM）・「キャンセル」→ 何もしない
- スタイルは既存デザイントークン（OKLCH・DESIGN.md）準拠・DevTools 実測（静的 CSS テストは作らない — プロジェクトルール）。

## 6. 実装手順

**実装順（ユーザー確定・2026-08-13）: ①エンジン → ②データフロー → ③設定トグル UI → ④フロント UI（最後）**

1. **カスタム WASM ビルド**: `A:\subomatic` をフォーク（Entei 配下にコピー or git submodule 判断）→ クレジット除去 → `wasm-pack build` → `apps/web/public/wasm/` へ配置。`NOTICE` を Entei に保持。
2. **Worker**: `sync-worker.ts`（subomatic の `worker.js` パターン踏襲・`onmessage` で `sync_to_audio` / `sync_to_reference` 実行・progress relay）。
3. **音声デコード**: ローカル音声ソースから `AudioContext.decodeAudioData` → モノラル f32 PCM（`app.js:119-130` パターン）。companion 動画は DL 完了後に companion 側 PCM 変換（§2 の 11-12 参照）。
4. **sub-to-sub 参照取得**: Magnet → companion 経由で内蔵字幕取得（`fetchMagnetSubtitle`）。ローカル → 参照用字幕ファイルのユーザー選択 UI。
5. **モード解決ロジック**: 設定モード（字幕/音声/自動）× ソース種別（YouTube/ローカル/Magnet）から実行モードを決定（YouTube → 同期ボタン非表示。字幕モードで参照字幕なし → Toast「この動画のベース字幕はないため同期されない」で中断。自動モード → sub-to-sub 優先・なければ sub-to-audio。Magnet + 字幕 → companion 字幕 DL（数十 KB）→ 直接 sync_to_reference。Magnet + 音声 → AlertDialog → DL% 待ち → companion PCM）。
6. **設定トグル UI**: 設定モーダルに Sync モード 3 トグル（字幕/音声/自動・デフォルト字幕・localStorage 永続化・i18n 3言語）。
7. **フロント UI（最後）**: SubtitlePanel に同期ボタン・プログレス・結果反映（i18n 3言語）。
8. **テスト**: ロジック（Worker 契約・PCM 変換・モード解決・プログレス・エラー経路）のみユニットテスト。WASM 自体は subomatic 側のテストで担保。
9. **ドキュメント同期**: 本ドキュメント + PLAYER_PHASES.md 等。

## 7. 未確定事項（要確認）

- [x] **sub-to-sub の「動画内字幕」の取得手段 — 確定（2026-08-13・実測済み）**: **Magnet 動画**は companion の `fetchMagnetSubtitle`（実装済み）で内蔵字幕ファイルを取得。**ローカル動画**は MKV 内蔵の字幕トラックが `video.textTracks` に公開されないことを実測確認（Chromium は Matroska の字幕トラックを無視）→ **参照用の字幕ファイルをユーザーが選択**する形にフォールバック。
- [ ] 同期結果の保存方法（プレイヤーセッション内のみ / ファイル書き出し）
- [ ] subomatic のフォーク配置（Entei リポジトリ内コピー / 別リポジトリ）
- [ ] earshot（ニューラル VAD）の WASM サイズ・実行時間の実測

## 8. ライセンス・禁止事項

- subomatic は **Apache-2.0**（`NOTICE` の保持義務）。Entei への統合は許可。`NOTICE` を必ず同梱する。
- **alass の GPL ソースは使用しない**（subomatic はクリーンルーム実装・Entei 側でも踏襲）。
- libav は CLI 専用（WASM パスでは不使用）— Entei ブラウザ側には関係なし。
- 音声・字幕データを外部にアップロードしない（ローカル完結・WASM 実行）。
