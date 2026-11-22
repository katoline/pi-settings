# フェーズ 1：ガード

## 概要

pi が実行しようとするツール呼び出し（bash・read・write・edit など）を実行前に判定し、事故につながるものを止める。今の `git-guard` を置き換える。

## 関連

- 移植元：`agent/extensions/harness/guards/`（index・register・git・fs・install・secrets・paths）、`lib/`（shell・git-state・verdict・types・config・runtime・state）、`config.default.json`
- 移植元のテスト：`tests/{guards-index,git-guard,fs-guard,install-guard,secrets-guard,shell,config,git-state}.test.ts`、`tests/helpers.ts`
- 決定：[005](../decisions/005-dangerous-ops-silent-block.md)、[003](../decisions/003-auto-pr-and-merge-policy.md)
- 今の実装：[features/git-guard.md](../features/git-guard.md)
- 状態：未着手

## タスク

- [ ] ハーネスの骨格：`agent/extensions/harness/index.ts`、ランタイム、設定の読み込み（`config.default.json` に `~/.pi/agent/harness.json` を重ねる）
- [ ] シェルの字句解析（`lib/shell.ts`）：`sh -c` や `$( )` の中まで再帰的に解析、ラッパー（`env`・`timeout`・`xargs` など）を剥がす、変数で組み立てた語は判定不能として扱う
- [ ] 判定の結果は「拒否」と「許可」の 2 つにする。移植元の「許可制（確認ダイアログ）」はすべて黙って拒否にし、理由に「必要ならユーザーに `!<コマンド>` で実行してもらうよう伝える」と書く（決定 005）
- [ ] fail-closed：判定中に例外が起きたら拒否する（pi はフックが例外を投げるとツールを実行してしまうため）
- [ ] git ガード：既定ブランチへの commit・push・merge、force push、`--no-verify`、マージ済みでないリモートブランチの削除、サブエージェントからの commit・push・PR の書き込みを拒否する。移植元で許可制だった `reset --hard`・`rebase`・`--amend` などは拒否にする
- [ ] マージ：bash からの `gh pr merge` と `gh api` でのマージは、フェーズ 5 までは今の `git-guard` と同じ「依頼があれば確認ダイアログ、無ければ黙って拒否」を引き継ぐ（フェーズ 5 で専用ツールに置き換える）
- [ ] 削除・プロセス停止のガード：削除は作業ルートと一時領域の内側だけ。`pkill` / `killall` は拒否、`kill` は PID 指定と `$(lsof -ti :ポート)` だけ
- [ ] インストールのガード：`sudo` は拒否。`brew` / `npm -g` / `pip --user` / `nix profile` / `darwin-rebuild` / `home-manager switch` などは拒否（決定 005）。保護パスへの書き込みも拒否（作業ディレクトリがその内側なら許可）
- [ ] 秘密情報のガード：秘密ファイルの読み取り・出力、環境変数の一覧出力を拒否。ツールの出力に含まれるトークン類を `[秘匿]` に置き換える（`tool_result`）
- [ ] write / edit ツール：既定ブランチ上でのリポジトリ内の編集と、`.git` の中への書き込みを拒否する
- [ ] Mac 向けの設定値：`workRoots`（`~/Dev/kaishi`・`~/Dev/seino914`・`~/Dev/hobby`・`~/Dev/humanoid`）、`tempRoots`（`$TMPDIR`・`/tmp/claude-*`・`/tmp/pi-*`。`/tmp/pi-<uid>` は pi の一時領域で、ui-compare スキルの出力先。Mac の `/tmp` は `/private/tmp` へのリンクなので、実体のパスでも一致することを確かめる）、`protectedGlobalPaths`（`~/Dev/seino914/dotfiles`）、`protectedHarnessPaths`（`~/.pi/agent`）
- [ ] `git-guard` を削除し、そのテストケース（リダイレクト・ブランチ切替の追跡・マージ依頼の判定）を新しいガードのテストに移す
- [ ] `!` で始まるユーザーのコマンドがガードを通らないこと（`user_bash` イベント）を確かめる

## 完了条件

- 移植元のガードのテストが、Mac 用の設定値と「許可制を拒否にした」変更を反映したうえで通る
- 今の `git-guard` のテストケースが同じ結果になる
- 普段の作業（作業ブランチでの commit・push・PR 作成）が止まらない

## 注意

- ガードは文字列の検査で、`python -c` などの間接実行はすり抜ける（移植元でも既知の制約）。事故防止の部品として扱う（脅威モデルはルートの `AGENTS.md`）
