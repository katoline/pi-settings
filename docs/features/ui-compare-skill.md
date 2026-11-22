# ui-compare スキル

## 概要

`/skill:ui-compare [修正内容の説明] [--base <rev>]` で起動し、基準コミット（既定 HEAD）と作業ツリーの画面をヘッドレス Chrome で撮って、修正前後を見比べる HTML を一時領域に作り、`file://` の URL を返す。モデルが自動で使うことはない（`disable-model-invocation: true`）。

## 関連

- コード：`agent/skills/ui-compare/`（`SKILL.md`・`ui-compare.sh`・`capture.mjs`・`build.mjs`・`template.html`）
- 移植元：Claude Code 用の `seino914/dotfiles` の `.claude/skills/ui-compare`（2026-11-22 に移植）

## 処理

1. モデルが `--base`・撮る URL パス（`--path`。変更されたファイルとルーティングから決める。30 ページまで）・開発サーバーの起動コマンド（`--cmd`。`{port}` を含む）・`--slug`・`--title` を決める
2. `ui-compare.sh`：
   - 修正前は `git archive` で一時ディレクトリへ展開し、依存を入れて開発サーバーを起動する（作業ツリー・index・ref には書き込まない）
   - 修正後は作業ツリーで開発サーバーを起動する。既存の開発サーバーが 1 つ動いていればそれを使い、2 つ以上なら終了コード 3 で中止する（どれを使うかユーザーに聞く）
   - `flake.nix` があれば devShell 経由で動かす
3. `capture.mjs`：Chrome を CDP（WebSocket）で操作し、各パス × 幅（既定 375・1280）を撮って変化率を出す
4. `build.mjs`：`template.html` から比較用の HTML を作る
5. 開発サーバーはプロセスグループごと止め、作業用の一時ディレクトリは消す

依存は bash・git・curl・Node（22 以上）・Chrome（既定 `/Applications/Google Chrome.app`。`UI_COMPARE_CHROME` で変えられる）。

## pi 向けに変えた点（移植元との違い）

- 出力先：Claude Code の一時領域（`/private/tmp/claude-<uid>`）から、それと並ぶ pi の一時領域 `/private/tmp/pi-<uid>/<プロジェクト>/ui-compare/<日付_時刻>_<slug>/` に変えた（この Mac では `/private/tmp/pi-501/`）。フォルダは本人だけが読み書きできる権限（700）で作る。`UI_COMPARE_OUT_DIR` で変えられる
- `SKILL.md`：`${CLAUDE_SKILL_DIR}`・`allowed-tools`・`model`・`argument-hint` を外した。AskUserQuestion の代わりに「ユーザーに聞いて答えを待つ（ターンを終える）」、`run_in_background` の代わりに「`timeout` を付けない」と書いた。PR を作らないことを明記した

## 既知の制約

- 修正前側には git 管理外のもの（LFS の実体・submodule・ビルド済みの `dist/` 等）が無いので、修正前側だけ欠けたりエラーになったりしうる
- 修正後側の開発サーバーは作業ツリーで動くので、キャッシュ（`.next/` 等）を作り、`next-env.d.ts` 等を書き換えることがある
- 出力は一時領域なので再起動等で消える

## 確認したこと（2026-11-22）

- スクリプトの構文（`bash -n`）と `--help` の表示
- 実際の撮影の通し確認は未確認（使い捨てのリポジトリでのコミットを作れなかったため）。初回はユーザーが実際のプロジェクトで試す
