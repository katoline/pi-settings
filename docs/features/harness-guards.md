# ハーネスのガード

## 概要

pi が実行しようとするツール呼び出し（bash・read・write・edit・grep・find・ls）を実行前に判定し、事故につながるものを止める拡張 `harness`（フェーズ 1。今のところ登録しているのはガードだけ）。危ない操作は確認ダイアログを出さずに黙って拒否し、必要ならユーザーが `!` で実行する。PR のマージだけは、ユーザーが依頼したときに確認ダイアログを出す。

## 関連

- コード：`agent/extensions/harness/`
  - `index.ts`（入口）、`guards/register.ts`（pi への接続）、`guards/index.ts`（bash・ファイルツールの判定）
  - `guards/git.ts`・`fs.ts`・`install.ts`・`secrets.ts`・`paths.ts`・`merge.ts`、`lib/shell.ts`（シェルの字句解析）・`git-state.ts`・`config.ts`・`runtime.ts`・`verdict.ts`・`types.ts`、`config.default.json`
  - テスト：`tests/harness-*.test.ts`（`harness-helpers.ts` は共通の設定値）
- 決定：[003](../decisions/003-auto-pr-and-merge-policy.md)（マージ）、[005](../decisions/005-dangerous-ops-silent-block.md)（危ない操作は黙って拒否）、[004](../decisions/004-port-harness.md)（移植）
- 計画：[plan/phase-1-guards.md](../plan/phase-1-guards.md)（完了）、[plan/phase-5-pr-tools.md](../plan/phase-5-pr-tools.md)（マージを専用ツールに置き換える予定）
- 前身の `git-guard` 拡張（`agent/extensions/git-guard/`）はこのガードに置き換えて削除した

## 挙動

判定は「拒否」「マージの依頼ゲート」「許可」の 3 つ。拒否の理由はモデルに返る（何をなぜ止めたか、代わりにどうするか）。

### 拒否

「`!` の案内」が「あり」のものは、ユーザーが自分で実行すれば済む操作（移植元では確認ダイアログだったもの）で、理由の末尾に「必要ならユーザーに `!<コマンド>` で自分で実行してもらうよう伝えてください。」が付く。

| 分類 | 対象 | `!` の案内 |
| --- | --- | --- |
| git：既定ブランチ | 既定ブランチへの commit・push（`HEAD` やリモート省略の push も、現在のブランチで判定）、既定ブランチ上での `git merge` | |
| git：履歴・リモート | force push（`-f` / `--force` / `--force-with-lease` / `+refspec`）、`--no-verify`（commit の `-n` を含む）、`--mirror` / `--all` / `--prune`、リモートブランチの削除（`--delete` / `-d` / `:ref`。マージ済みかどうかにかかわらず常に拒否。マージ済みブランチの削除は GitHub のワークフローが行う）、ブランチ名を変数やコマンド置換で組み立てた push | |
| git：破壊的 | `git commit --amend`、`reset --hard`（`--merge` / `--keep`）、`clean`（`-n` 以外）、`checkout -- .` / `-f`、`restore`（`--staged` のみは許可）、`switch --discard-changes`、`branch -D`（`--delete --force`・`-df` を含む）、`stash drop` / `clear`、`rebase`、`filter-branch`、`reflog expire`、`gc --prune`、`update-ref -d`、`tag -d`、`worktree prune` | あり |
| git：worktree | `worktree remove` の `--force`・相対パス | |
| git：サブエージェント | サブエージェントからの commit・push・merge・pull・cherry-pick・rebase・revert・am・tag・worktree | |
| gh | `gh api` の書き込み（マージの URL を除く。`-X GET` / `--method GET` の明示があれば `-f` / `-F` があっても許可。`gh api graphql` は本文の `query=` に `mutation` を含むとき、または本文が `@ファイル`・変数・コマンド置換で中身を見られないときだけ拒否）、`gh secret` / `variable` / `ruleset` / `ssh-key` / `gpg-key` / `auth`、`gh repo delete` / `archive` / `rename` / `edit` / `transfer`、`gh release create` / `delete` / `edit` / `upload`、サブエージェントからの `gh pr` の書き込み | |
| 削除 | 作業ルートと一時領域の外の `rm` / `rmdir` / `unlink` / `shred` / `trash`、`find -delete` / `-exec rm`、`rsync --delete`、`cd` と組み合わせた削除、`xargs` 経由の削除、変数やコマンド置換で組み立てたパスの削除 | |
| プロセス停止 | `pkill` / `killall` / `fuser -k`、PID（2 以上の数字）と `$(lsof -ti :ポート)` 以外の `kill` | |
| インストール | `sudo` などの権限昇格（`!` の案内の代わりに、実行してほしいコマンドをユーザーに示すよう案内）。`brew install` / `upgrade` / `uninstall` / `reinstall` / `tap` / `untap` / `bundle`（`bundle check` / `list` / `dump` は許可。`--file <path>` は読み飛ばして判定）、`npm` / `pnpm` / `yarn` / `bun` の `-g`、`pip --user`、`pipx`、`uv tool`、`cargo` / `go` / `gem install`、`nix profile`、`nix-env`、`nix-channel`、`home-manager switch`、`nixos-rebuild`、`darwin-rebuild`（`switch` / `activate` / `rollback` / `edit`）、`curl … \| sh` | あり（`sudo` を除く） |
| 保護パス | `~/Dev/seino914/dotfiles`（グローバル環境）と `~/.pi/agent` への書き込み（リダイレクト先、`rm` / `mv` / `cp` / `tee` / `sed` などの引数）。作業ディレクトリがその内側なら許可 | あり |
| 秘密情報 | 秘密ファイル（`.env`・秘密鍵・`auth.json` など。`.env.example` などのテンプレートは除く）の読み取り・出力・変更、環境変数の一覧（`env`・`printenv`・`export -p`・`set` など）、秘密を持つ変数の出力 | |
| ファイルツール | write / edit の、既定ブランチ上でのリポジトリ内の編集と `.git` の中への書き込み。read / write / edit / grep / find / ls の秘密ファイル | |
| 解析不能 | 構文を解析できないコマンド（クォートの閉じ忘れなど）、`eval` や変数で組み立てた `sh -c` | |
| 内部エラー | 判定中の例外（fail-closed） | |

### マージの依頼ゲート

`gh pr merge` と `gh api` の `/pulls/<番号>/merge`（`sh -c` や `$( )` の中も含む）：

- ユーザーの入力に「マージ」「merge」が無ければ、ダイアログを出さずに拒否
- あれば `ctx.ui.confirm` で確認し、許可されたら実行、拒否されたら止める
- UI の無いモード（`--print` など）とサブエージェントでは、依頼があっても拒否
- 同じコマンドに拒否の対象が混ざっていれば、拒否が優先

### 許可

上のどれにも当たらないもの。普段の作業は止まらない：作業ブランチでの `git add`・`git commit -m`・`git push -u origin feat/x`、`gh pr create` / `view` / `list` / `edit`、ローカルの `npm install`、作業ルートと一時領域（`/private/tmp/claude-*`・`/private/tmp/pi-*` を含む）の内側のファイルの削除、`git switch -c` などの作業ブランチの作成。

## 処理

- `tool_call` イベントで判定する。bash は `command`、それ以外は `path`（`file_path`）を見る。1 本の try/catch で包み、例外は拒否にする（pi はフックが例外を投げるとツールを実行してしまうため）
- bash：`lib/shell.ts` でコマンドを字句解析する。`;` `&&` `||` `|` `&` 改行で分け、`sh -c` と `eval`（静的な文字列）と `$( )`・バッククォートの中まで再帰的に解析する。`env` / `timeout` / `nohup` / `time` / `xargs` などのラッパーを剥がし、パス付きの呼び出し（`/bin/rm`）は基本名で見る。リダイレクト（`2>&1`・`> file`）とヒアドキュメントの本体はコマンドの引数に数えない。変数やコマンド置換で組み立てた語は「動的」として、判定できないものは拒否する
- git の状態は、必要なコマンド（commit・push・merge）のときだけ `git rev-parse` / `branch --show-current` / `symbolic-ref` で取る。毎回取り直す。write / edit は、ツールの cwd ではなく、対象ファイルのあるディレクトリ（無ければ存在する最も近い親）のリポジトリの状態で、既定ブランチ上かを判定する。`.git` の中（`.git` というパス要素を含むパス）は、`.git` の中では `git rev-parse` が失敗するため、git の状態に関係なく拒否する。コマンド内の `cd <dir>` と `git -C <dir>` を追い、その作業ディレクトリの状態で判定する
- 同じコマンド内の `git checkout -b` / `-B`、`git switch -c` / `-C` / `--create`、`git switch <名前>` のあとは、切り替え後のブランチで判定する（例：`git switch -c feat/x && git commit` は既定ブランチ上でも通る）
- 既定ブランチ：設定の `defaultBranches` に、`origin/HEAD` の指す先を加える
- パスの判定は、存在する最も深い祖先の実パスに解決してから行う（symlink の回避を防ぐ。Mac の `/tmp` は `/private/tmp` へのリンクなので、一時領域の `/tmp/claude-*` などのパターンも、先頭の固定部分を実パスにして照合する）
- マージの依頼：`input` イベントで、ユーザーの生の入力（`/skill:…` の展開前）に「マージ」「merge」があるかを記録する。待機中の新しい入力では置き換え、実行中の追加入力（steer / followUp）では足す。拡張が送った入力は数えない
- `tool_result` イベントで、ツールの出力に含まれる形の決まったトークン（秘密鍵ブロック・`sk-ant-…`・`sk-proj-…` / `sk-svcacct-…` / `sk-admin-…`・`sk-…`・GitHub トークン（`ghp_` など・`github_pat_…`）・`AKIA…`・Slack の `xox*`・JWT・同じ行の `Bearer <トークン>`・URL 内のパスワード `scheme://user:pass@`（`${VAR}`・`<password>`・`{pass}` などのプレースホルダーは実際の値ではないので残す））を `[秘匿]` に置き換える。**秘匿するのは形の決まったトークンだけ**。`password=hunter2` のような形の決まらない秘密は、「名前=値」から推測せず秘匿しない（ソースコードを書き換えないため。秘密ファイルの読み取り自体はガードが止める）。`structuredContent` は JSON 文字列ではなく値を走査して置き換える
- `!` で始まるユーザーのコマンド（`user_bash` イベント）は `tool_call` を通らないので、ガードの対象外（決定 005 の前提。確認結果は [reference/pi-api-notes.md](../reference/pi-api-notes.md)）

## 設定値

`agent/extensions/harness/config.default.json` に、`~/.pi/agent/harness.json`（`PI_CODING_AGENT_DIR` があればそのディレクトリの `harness.json`）の上書きを重ねる。キー単位の置き換えで、文字列の配列でないキーと壊れた JSON は無視する。`~` は先頭だけ展開する（`tempRoots` は展開しない）。

| キー | 既定値 | 意味 |
| --- | --- | --- |
| `workRoots` | `~/Dev/kaishi`・`~/Dev/seino914`・`~/Dev/hobby`・`~/Dev/humanoid` | 削除を許す作業ルート（ルート自身は含まない） |
| `tempRoots` | `$TMPDIR`・`/tmp/claude-*`・`/tmp/pi-*` | 削除を許す一時領域。`/tmp/pi-<uid>` は pi の一時領域（ui-compare スキルの出力先）。ルート自身は含まない |
| `protectedGlobalPaths` | `~/Dev/seino914/dotfiles` | 開発中に変更させないグローバル環境（作業ディレクトリがその内側なら許可） |
| `protectedHarnessPaths` | `~/.pi/agent` | ハーネスと認証情報の置き場所（同上。設定の編集はリポジトリのほうで行う） |
| `defaultBranches` | `main`・`master` | 既定ブランチとして扱う名前 |

環境変数 `PI_SUBAGENT=1` で起動されたときは、サブエージェント向けの制限（git の書き込み・`gh pr` の書き込み・`git worktree`）が効く。サブエージェントを起動する機能はフェーズ 3 で入る。

## 既知の制約

- 文字列の検査なので、`python -c` やスクリプト経由の間接実行はすり抜ける。事故防止の部品として扱う（脅威モデルはルートの `AGENTS.md`）
- `git checkout <名前>`（`-b` なし）による切り替えは追わない（ファイル指定と区別できないため）。`git checkout main && git merge feat/x && git push` のようなコマンドは、`git merge` の時点では現在のブランチで判定される
- `cd` はサブシェル（`( )`）を区別せず、`sh -c` の中の `cd` は外側の続きとして扱う。ブランチ判定の作業ディレクトリが実際とずれることがある。`cd` 以外のコマンドの相対パスは、ツールの作業ディレクトリ基準で判定する
- 否定文（「マージはしないで」）でも語があればダイアログになる（拒否すれば実行されない）
- 保護パスの判定は、書き込み系コマンドの引数に含まれるパスで行う。`git -C ~/Dev/seino914/dotfiles status` のような読み取りも、作業ディレクトリがその外なら拒否される
- `git worktree remove` が許可されるのは、`--force` なしで絶対パスを指定したとき。pi では worktree を使わない方針（[decisions/011](../decisions/011-no-worktree.md)）なので、移植元の「このハーネスが作った worktree だけ」の所有チェックは入れない
- git の引数のうち commit メッセージ（`-m` / `--message` / `-F` / `--file` の値）は、秘密ファイルのパスとして見ない
- `git push` の引数が動的（変数・コマンド置換）だと拒否する。detached HEAD の `git push`（refspec 省略）も、行き先を判定できないので拒否する。リポジトリの外では git 自身が失敗するので止めない
- `gh pr merge` は専用ツール（フェーズ 5）ができるまで、依頼ゲートつきで bash から許可する
- 画像など、テキスト以外のツール出力は秘匿しない
