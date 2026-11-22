# フェーズ 1：ガード

## 概要

pi が実行しようとするツール呼び出し（bash・read・write・edit など）を実行前に判定し、事故につながるものを止める。前身の `git-guard` を置き換えた（`git-guard` は削除済み）。

## 関連

- 移植元：`agent/extensions/harness/guards/`（index・register・git・fs・install・secrets・paths）、`lib/`（shell・git-state・verdict・types・config・runtime・state）、`config.default.json`
- 移植元のテスト：`tests/{guards-index,git-guard,fs-guard,install-guard,secrets-guard,shell,config,git-state}.test.ts`、`tests/helpers.ts`
- 決定：[005](../decisions/005-dangerous-ops-silent-block.md)、[003](../decisions/003-auto-pr-and-merge-policy.md)
- 実装の仕様：[features/harness-guards.md](../features/harness-guards.md)
- 状態：完了（2026-11-23）

## タスク

- [x] ハーネスの骨格：`agent/extensions/harness/index.ts`、ランタイム、設定の読み込み（`config.default.json` に `~/.pi/agent/harness.json` を重ねる）。ランタイムはガードが使う分（設定・サブエージェントか・home・tmpdir）だけで、計画・モデルなどの状態は後のフェーズで足す。設定のキーもガード用の 5 つだけ。型が違う上書きのキーは無視する
- [x] シェルの字句解析（`lib/shell.ts`）：`sh -c` や `$( )` の中まで再帰的に解析、ラッパー（`env`・`timeout`・`xargs` など）を剥がす、変数で組み立てた語は判定不能として扱う
- [x] 判定の結果は「拒否」と「許可」にする（マージだけ第 3 の「依頼ゲート」。下のマージの項目）。移植元の「許可制（確認ダイアログ）」はすべて黙って拒否にし、理由に「必要ならユーザーに `!<コマンド>` で実行してもらうよう伝える」と書く（決定 005）
- [x] fail-closed：判定中に例外が起きたら拒否する（pi はフックが例外を投げるとツールを実行してしまうため）
- [x] git ガード：既定ブランチへの commit・push・merge、force push、`--no-verify`、push でのリモートブランチの削除（マージ済みかどうかにかかわらず常に。決定 003）、サブエージェントからの commit・push・PR の書き込みを拒否する。移植元で許可制だった `reset --hard`・`rebase`・`--amend` などは拒否にする
- [x] マージ：bash からの `gh pr merge` と `gh api` でのマージは、フェーズ 5 までは今の `git-guard` と同じ「依頼があれば確認ダイアログ、無ければ黙って拒否」を引き継ぐ（フェーズ 5 で専用ツールに置き換える）
- [x] 削除・プロセス停止のガード：削除は作業ルートと一時領域の内側だけ。`pkill` / `killall` は拒否、`kill` は PID 指定と `$(lsof -ti :ポート)` だけ
- [x] インストールのガード：`sudo` は拒否。`brew` / `npm -g` / `pip --user` / `nix profile` / `darwin-rebuild` / `home-manager switch` などは拒否（決定 005）。保護パスへの書き込みも拒否（作業ディレクトリがその内側なら許可）
- [x] 秘密情報のガード：秘密ファイルの読み取り・出力、環境変数の一覧出力を拒否。ツールの出力に含まれるトークン類を `[秘匿]` に置き換える（`tool_result`）
- [x] write / edit ツール：既定ブランチ上でのリポジトリ内の編集と、`.git` の中への書き込みを拒否する
- [x] Mac 向けの設定値：`workRoots`（`~/Dev/kaishi`・`~/Dev/seino914`・`~/Dev/hobby`・`~/Dev/humanoid`）、`tempRoots`（`$TMPDIR`・`/tmp/claude-*`・`/tmp/pi-*`。`/tmp/pi-<uid>` は pi の一時領域で、ui-compare スキルの出力先。Mac の `/tmp` は `/private/tmp` へのリンクなので、実体のパスでも一致することを確かめる）、`protectedGlobalPaths`（`~/Dev/seino914/dotfiles`）、`protectedHarnessPaths`（`~/.pi/agent`）
- [x] `git-guard` を削除し、そのテストケース（リダイレクト・ブランチ切替の追跡・マージ依頼の判定）を新しいガードのテストに移す
- [x] `!` で始まるユーザーのコマンドがガードを通らないこと（`user_bash` イベント）を確かめる：`tool_call` を通らないことを `dist/` のコードで確認した（[reference/pi-api-notes.md](../reference/pi-api-notes.md)）

## 移植元から変えた点・実際の内容

- git ガードは、判定を `Verdict`（`allow` / `block` / `merge`）にまとめた。`merge` は `gh pr merge` と `gh api …/pulls/<番号>/merge` で、`guards/register.ts` が依頼の有無（`input` イベント）と `ctx.ui.confirm` で処理する。移植元の専用ツールへの誘導（`harness_pr_create` / `harness_pr_merge`）は無く、`gh pr create` / `edit` は許可する
- 今の `git-guard` の判定は、`guards/index.ts` の `evaluateBash` が移植元のシェル解析の上で再現する（コマンド内の `cd` / `git -C` の追跡、`git checkout -b` / `git switch` のあとの切替後のブランチでの判定）。git の状態は必要なコマンドのときだけ、毎回取り直す（移植元の 1.5 秒のキャッシュは、直前の切替を見逃すので外した）
- `git push` の判定に、短いオプションの結合（`-fu`・`-d`）と値を取るオプション（`-o`）の読み飛ばしを足した（今の `git-guard` のケース）。リポジトリの外での refspec 省略の push は止めない（今の `git-guard` と同じ）
- `git worktree remove` の「このハーネスが作った worktree だけ」は持ち込まなかった。pi では worktree を使わない方針（[decisions/011](../decisions/011-no-worktree.md)）なので、所有チェックは入れない。`--force` なしで絶対パスのときだけ許可する
- `tempRoots` の `/tmp/claude-*` などのパターンは、先頭の固定部分（`/tmp`）を実パスに解決してから照合する（移植元は `/private/tmp` の実体のパスに一致しなかった）
- `findSecretFiles`（使われていない）は持ち込まなかった
- push でのリモートブランチの削除は、移植元の「マージ済みなら許可」をやめて常に拒否にした（マージ済みブランチの削除は GitHub のワークフローが行う）。このため `git branch -r --merged` の取得は外した
- 独立レビューを受けて直した点：`$( )` の中のヒアドキュメント本体を読み飛ばす、出力の秘匿を形の決まったトークンだけにする（汎用の「名前=値」は外した）、write / edit の既定ブランチ判定を対象ファイルのリポジトリで行う、`git branch --delete --force` / `-df`・`brew bundle` の拒否、`gh api` の GET 明示と graphql の扱い、git のメッセージ（`-m` / `-F`）を秘密ファイルのパスとして扱わない
- `darwin-rebuild`（`switch` / `activate` / `rollback` / `edit`）をインストールのガードに足した

## 完了条件

- 移植元のガードのテストが、Mac 用の設定値と「許可制を拒否にした」変更を反映したうえで通る
- 今の `git-guard` のテストケースが同じ結果になる
- 普段の作業（作業ブランチでの commit・push・PR 作成）が止まらない

## 注意

- ガードは文字列の検査で、`python -c` などの間接実行はすり抜ける（移植元でも既知の制約）。事故防止の部品として扱う（脅威モデルはルートの `AGENTS.md`）
