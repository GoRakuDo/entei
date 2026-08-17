# Subtitle Sync — subomatic 統合（字幕タイミング自動同期）

> Entei の字幕タイミングズレ問題を解決する機能。サブタイトル同期エンジン **subomatic**（Apache-2.0・Rust・WASM対応）を Entei に統合し、字幕のタイミングを**音声**または**動画内字幕（参照）**に自動で合わせる。
>
> 状態: **実装完了（2026-08-14・ブランチ `feature/subtitle-sync`・未マージ/未プッシュ）**。ユーザー確定事項の一次ソース。実装記録は §9 参照。

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
    - **companion 動画（Magnet）の sub-to-audio**: **無効化（2026-08-17 確定）**。音声ベースは DL 完了 + 全編 PCM 変換 + VAD が必要で、ストリーミング中の即時同期に不向き。詳細は §10.4。
12. **Magnet での音声ベース無効化（2026-08-17 確定・§10.4 に詳細）**: Magnet 再生中は音声ベースの字幕同期（sub-to-audio）を使えない:
    - 音声モード選択時: Toast「Magnet では音声ベースの同期は利用できません。字幕モードを使用してください」（ローカルは従来どおり）。
    - 自動モード（Magnet 再生中）: 字幕 LazySync（§10）を優先・音声フォールバックなし。
    - 旧仕様の「DL 待ち AlertDialog（2026-08-13）」は**廃止**。

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
         │    └─ Magnet sub-to-audio → 無効化（§10.4・Toast 案内のみ）
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
- **Magnet + 音声モード**: **無効化（§10.4）**。音声モード選択時は Toast 案内のみ（旧「DL 待ち AlertDialog」は廃止）。ローカルは従来どおり sub-to-audio。
- スタイルは既存デザイントークン（OKLCH・DESIGN.md）準拠・DevTools 実測（静的 CSS テストは作らない — プロジェクトルール）。

## 6. 実装手順

**実装順（ユーザー確定・2026-08-13）: ①エンジン → ②データフロー → ③設定トグル UI → ④フロント UI（最後）**

1. **カスタム WASM ビルド**: `A:\subomatic` をフォーク（Entei 配下にコピー or git submodule 判断）→ クレジット除去 → `wasm-pack build` → `apps/web/public/wasm/` へ配置。`NOTICE` を Entei に保持。
2. **Worker**: `sync-worker.ts`（subomatic の `worker.js` パターン踏襲・`onmessage` で `sync_to_audio` / `sync_to_reference` 実行・progress relay）。
3. **音声デコード**: ローカル音声ソースから `AudioContext.decodeAudioData` → モノラル f32 PCM（`app.js:119-130` パターン）。Magnet での sub-to-audio は無効化（§10.4）のため、companion 側 PCM 変換は不要。
4. **sub-to-sub 参照取得**: Magnet → companion 経由で内蔵字幕取得（`fetchMagnetSubtitle`）。ローカル → 参照用字幕ファイルのユーザー選択 UI。
5. **モード解決ロジック**: 設定モード（字幕/音声/自動）× ソース種別（YouTube/ローカル/Magnet）から実行モードを決定（YouTube → 同期ボタン非表示。字幕モードで参照字幕なし → Toast「この動画のベース字幕はないため同期されない」で中断。自動モード → sub-to-sub 優先・なければ sub-to-audio。Magnet + 字幕 → LazySync（§10・DL 済み cue から同期）。Magnet + 音声 → 無効化（§10.4・Toast「Magnet では音声ベースの同期は利用できません。字幕モードを使用してください」）。ローカル + 音声 → sub-to-audio 従来どおり）。
6. **設定トグル UI**: 設定モーダルに Sync モード 3 トグル（字幕/音声/自動・デフォルト字幕・localStorage 永続化・i18n 3言語）。
7. **フロント UI（最後）**: SubtitlePanel に同期ボタン・プログレス・結果反映（i18n 3言語）。
8. **テスト**: ロジック（Worker 契約・PCM 変換・モード解決・プログレス・エラー経路）のみユニットテスト。WASM 自体は subomatic 側のテストで担保。
9. **ドキュメント同期**: 本ドキュメント + PLAYER_PHASES.md 等。

## 7. 未確定事項（要確認）

- [x] **sub-to-sub の「動画内字幕」の取得手段 — 確定（2026-08-13・実測済み）**: **Magnet 動画**は companion の `fetchMagnetSubtitle`（実装済み）で内蔵字幕ファイルを取得。**ローカル動画**は MKV 内蔵の字幕トラックが `video.textTracks` に公開されないことを実測確認（Chromium は Matroska の字幕トラックを無視）→ **参照用の字幕ファイルをユーザーが選択**する形にフォールバック。
- [ ] 同期結果の保存方法（プレイヤーセッション内のみ / ファイル書き出し）— 現状はセッション内反映のみ
- [ ] subomatic のフォーク配置（Entei リポジトリ内コピー / 別リポジトリ）
- [x] earshot（ニューラル VAD）の WASM サイズ — **実測済み: 234,656 bytes（0.22 MB）**。実行時間は実機テストで 3 分音声が数十秒で完了（VAD + align フェーズ）を確認。

## 8. ライセンス・禁止事項

- subomatic は **Apache-2.0**（`NOTICE` の保持義務）。Entei への統合は許可。`NOTICE` を必ず同梱する。
- **alass の GPL ソースは使用しない**（subomatic はクリーンルーム実装・Entei 側でも踏襲）。
- libav は CLI 専用（WASM パスでは不使用）— Entei ブラウザ側には関係なし。
- 音声・字幕データを外部にアップロードしない（ローカル完結・WASM 実行）。

## 9. 実装記録（2026-08-14・ブランチ `feature/subtitle-sync`）

### 9.1 実装済み（コミット一覧・全てローカル・未マージ/未プッシュ）

| コミット | 内容 |
|---|---|
| `4f98f77` | Sync モード仕様（字幕/音声/自動・実装順）をドキュメント化 |
| `78c47fa` | ソース種別対応（YouTube/ローカル/Magnet）と DL 待ちダイアログ仕様 |
| `e948a9a` | **ステージ①**: subomatic WASM エンジン + Worker + クライアントヘルパー |
| `2ad53e2` | **ステージ2a**: 音声デコード（16kHz モノラル）+ モード解決ロジック |
| `46b51df` | **ステージ2b**: companion PCM エンドポイント + Magnet ヘルパー |
| `07a4f7b` | **ステージ③**: Sync モード設定トグル + 字幕設定の永続化バグ修正 |
| `1abebad` | 参照字幕の取得手段確定（Magnet=companion / ローカル=ユーザー選択） |
| `d3c2d88` | **ステージ4a**: 同期ボタン UI（RotateCwFadingClock）+ lucide-react 更新 |
| `809df1d` | **ステージ4b**: 同期ロジック接続（plan 分岐・Toast・DL 待ち Dialog） |
| `45fec29` | **WASM バグ修正**: init 呼び出し・fps デフォルト 25・キャッシュバスター |

### 9.2 実機テストで発見・修正したバグ（2026-08-14・`45fec29`）

1. **`__wbindgen_free` エラー** — Worker の `loadWasm()` が WASM 初期化（`__wbg_init`）を呼ばず、生の wasm インスタンスのエクスポートを直接呼んでいた。wasm-bindgen のラッパーは初期化後に**トップレベルのラッパー関数**（`sync_to_audio` / `sync_to_reference`）を使う必要がある（生インスタンスを呼ぶと戻り値が `[0,0,1028,1]` のような配列になり文字列が壊れる）。
2. **`fps must be positive and finite, got 0`** — fps 未指定時に Worker が 0 を渡し、Rust の `check_fps` が拒否。デフォルト 25 に設定（クライアント `subtitle-sync.ts` と Worker の二重バリデーション）。
3. **ブラウザキャッシュ** — public/ 配下の raw JS（worker）がブラウザにキャッシュされ、修正が反映されなかった。`?v=2` キャッシュバスター（`SUBTITLE_SYNC_WORKER_VERSION` 定数・BUMP コメント付き）を追加。**注意: worker.js を変更したら `SUBTITLE_SYNC_WORKER_VERSION` をインクリメントすること**（忘れるとブラウザが古い worker を使い続ける）。
4. **字幕設定の永続化バグ（副産物）** — `SettingsTabs` が `SubtitleAppearanceSettings`（`fontSize` 等）を `PlayerPreferences`（`subtitleFontSize` 等）に**キー名変換せずスプレッド**していたため、字幕設定が一切保存されていなかった。明示的マッピングで修正（`07a4f7b` に含む）。

### 9.3 実機検証結果（2026-08-14・ローカル動画 + 実際のドラマクリップ）

- **エンジン動作**: Worker 直接テストで reference / audio 両モードが正常動作（progress フェーズ完走・同期済み字幕の文字列が返る）。
- **実動画（Meitantei・人の声入り・3 分クリップ）での sub-to-audio**: +5 秒ずらした字幕を読み込み → 同期ボタン → **字幕タイミングが音声に合わせて修正された**（cue 3570→3558・最初の cue が 00:11→00:00 に移動）。
- **earshot（ニューラル VAD）**: speech → align フェーズが動作。WASM サイズ 234KB。
- テスト用の一時ファイル（public/ の mp4/srt）は削除済み。

### 9.4 残タスク（4c・任意）

- onProgress の詳細表示（speech/align フェーズを UI に表示）
- ローカル参照字幕の選択 UI（sub-to-sub・ローカル動画用）
- 同期結果の保存（現状はセッション内反映のみ）

## 10. LazySync（Magnet 専用・DL 済み部分から即座に同期）

### 10.1 コンセプト

Magnet ストリーミング再生中に、動画の内蔵字幕トラックの「**DL 済み部分**」の cue を
即座に取得して字幕同期を行う方式。字幕全体の DL 完了を待たずに同期を開始できる。

- 対象: **Magnet（torrent）動画のみ**。ローカル動画は従来方式のまま（変更なし）。
- 前提: MKV の字幕クラスタは**時系列（再生順）にインターリーブ**されているため、
  DL 済みの先頭部分から順次 cue が読める。
- 目的: 「同期ボタン → DL 完了待ち → 同期」という待ち時間をなくし、
  再生と並行して段階的に同期を進める。

### 10.2 フロー

```
Magnet で動画選択 → 再生開始（既存・progressive・serveTorrentMedia）
  └─ probe で内蔵字幕トラックの存在を確認（先頭メタデータ + Cues・数 MB）
  └─ 字幕同期ボタン押下 → LazySync 開始
       1. companion: 「DL 済み字幕 cue」を抽出
          （Cues から字幕クラスタ位置を特定 → piece 優先 DL → DL 済み範囲の cue のみ）
       2. web: cue を取得 → ズレ字幕の対応 cue と比較 → オフセット推定
       3. オフセットを字幕全体に適用（setCues でシフト表示）
       4. DL が進む → より多くの cue でオフセットを更新（累積的に精度向上）
  └─ オフセットが安定したら完了（Magnet は成功 Toast を出さない・静かに同期）
```

### 10.3 技術詳細

**companion（Go・eizoudendenshi）**

- 既存の mkvgo 内蔵トラック抽出（`SubtitleContent`・Cues ベース直接ジャンプ）を
  「**DL 済み範囲の cue のみ**」に拡張する:
  - `AvailablePrefix()`（SHA-1 検証済み prefix）までを抽出対象とする。
  - `SelectedComplete()` の全完了ゲートは使わず、DL 済み prefix の cue を返す。
- **字幕トラックの piece を優先 DL**:
  - Cues から字幕クラスタの位置を特定し、該当 piece を `PiecePriorityHigh` に昇格。
  - 再生用 Reader とは別に「字幕 piece を要求する Reader」を設ける（DL を引き寄せる）。
  - 字幕 piece はビデオ/オーディオと混在するため、優先 DL しても字幕全体には
    ほぼ全編の piece が必要。ただし**ビデオ piece より先行して揃う**ため、
    DL 完了待ちの体感を大きく減らせる（※ torrent クライアントの
    rarest-first 等の piece 選択ポリシーにより、優先 DL の効果は環境依存）。
- 字幕が 0 cue（DL 済み部分に字幕なし）の場合は cue なし（従来の 404 相当）→
  web が待機状態（DL 進行中）を表示。

**web（apps/web）**

- **cue マッチングはテキスト不要（時間的近傍ペアリング・2026-08-17 確定）**:
  各参照 cue（内蔵字幕）について、ズレ字幕の cue を ±5 秒以内（
  `LAZY_SYNC_MATCH_WINDOW_MS = 5000`）で探索し、開始時間差が最小のペアを
  採用。**言語・翻訳が異なっても同期できる**（同じ台詞は同じ時間帯に表示
  されるため・ローカルの subomatic と同原理）。`normalizeCueText` は不使用。
- **同期タイミング（ffsubsync 方式の品質ゲート・2026-08-17 確定）**:
  - 初回同期: DL 済み cue が **5 個以上**（`LAZY_SYNC_MIN_REF_CUES`）に達したら。
  - 品質ゲート: マッチ数が **3 未満**（`LAZY_SYNC_MIN_MATCHES`）なら適用しない
    （DL 進行でマッチ増加の可能性があるため待機継続・旧「言語不一致で即エラー」は廃止）。
  - オフセット閾値: **±100ms 未満**（`LAZY_SYNC_MIN_OFFSET_MS`）は「すでに同期済み」
    として適用しない（Magnet は成功 Toast を出さない・ffsubsync
    `--suppress-output-if-offset-less-than` 相当）。
  - オフセット上限: **60 秒超**（`LAZY_SYNC_MAX_OFFSET_MS`）は異常値として適用しない
    （ffsubsync `--max-offset-seconds=60` 相当・防御として実装）。
- オフセット推定: マッチした cue の「開始時間差」の**中央値**（`estimateOffsetMs`・
  外れ値に頑健）。※ VFR や途中でドリフトが変わるファイルでは一定オフセット仮定が
  崩れ精度が落ちる（LazySync は「クイック同期」・高精度は DL 完了後の subomatic）。
- オフセット適用: ズレ字幕全体をオフセットでシフト（`setCues` で再表示・毎回
  ORIGINAL ベース cue に適用し累積ドリフトを防ぐ）。
- 更新: ポーリング（3 秒）で DL 済み cue が増えるたびに再計算（ffsubsync の
  multi-segment 相当・増えた行でオフセット更新）。待機の上限は 12 分
  （`LAZY_SYNC_MAX_WAIT_POLLS = 240`・超過時は Toast）。
- 完了: オフセットが安定（変化 ≤ 50ms）したら**成功 Toast は出さない**
  （Magnet は毎回出ると邪魔なため・2026-08-17 確定）・以後も静かに更新を継続。
  ローカル（従来のボタン同期・applySyncedSubtitle）は成功 Toast「字幕同期成功!」を維持。

### 10.4 Magnet での音声ベース無効化

Magnet 再生では**音声ベースの字幕同期（sub-to-audio）を無効化**する。

- 理由: 音声ベースは「DL 完了 + 全編 PCM 変換 + VAD」が必要。
  DL 済み部分だけでは VAD（音声活動検出）が不正確で、同期精度が出ない。
- 挙動:
  - 音声モード選択時（Magnet 再生中）: Toast「Magnet では音声ベースの
    同期は利用できません。字幕モードを使用してください」（ローカルは従来どおり）。
  - 自動モード（Magnet 再生中）: 字幕 LazySync を優先・音声フォールバックなし。
- ローカル動画は従来どおり音声ベース（sub-to-audio）を使用可能。

### 10.5 ローカル動画は従来どおり（変更なし）

- 字幕ベース: 字幕全体の sub-to-sub（mkvgo 抽出 + subomatic 全体比較・既存）。
- 音声ベース: sub-to-audio（decodeAudioData / companion PCM・既存）。
- LazySync は Magnet 専用（ローカルには適用しない）。

### 10.6 実装ステップ

1. **companion**: DL 済み字幕 cue の抽出（ウィンドウ抽出・piece 優先・別 Reader）。
2. **web**: LazySync フロー（cue 取得・オフセット推定・適用・更新）+
   Magnet の音声ベース無効化（音声モード Toast・自動モードの音声フォールバック除去）。
3. **テスト**: companion（DL 済み prefix の cue 抽出・piece 優先）+ web
   （オフセット推定・適用・更新・Magnet 音声無効化）。
4. **レビュー → リリース → 実機確認**。
