# git-guard

## 概要

pi が bash ツールで実行しようとする git / gh コマンドを実行前に検査し、事故につながるものを止める。PR のマージは、ユーザーが依頼したときだけ確認ダイアログを出す。

## 関連

- コード：`agent/extensions/git-guard/index.ts`（pi への接続）、`check.ts`（判定の純粋ロジック）、`check.test.ts`
- 決定：[003](../decisions/003-auto-pr-and-merge-policy.md)
- 置き換え予定：[plan/phase-1-guards.md](../plan/phase-1-guards.md)、[plan/phase-5-pr-tools.md](../plan/phase-5-pr-tools.md)

## 挙動

| コマンド | 扱い |
| --- | --- |
| 既定ブランチ（`origin/HEAD` の指す先。取れなければ `main` / `master`）への commit・push | 拒否 |
| force push（`-f` / `--force` / `--force-with-lease` / `+refspec`） | 拒否 |
| push での削除（`-d` / `--delete` / `:ref` / `--mirror`） | 拒否 |
| `git commit` / `git push` の `--no-verify`（commit の `-n` を含む） | 拒否 |
| `gh pr merge`、`gh api` の `/pulls/<番号>/merge` | ユーザーの入力に「マージ」「merge」が無ければ、ダイアログを出さずに拒否。あれば確認ダイアログを出し、許可したときだけ実行。UI の無いモード（`--print` など）では拒否 |
| それ以外 | 許可 |

拒否の理由はモデルに返る（何をなぜ止めたか、代わりにどうするか）。

## 処理

- `tool_call` イベントで bash の `command` を検査する
- コマンドを `&&` `||` `;` `|` 改行でセグメントに分け、空白で語に分ける。単純な引用符は 1 語として扱う
- 引用符で囲まれていないリダイレクト（`2>&1`・`> file` など）は語から除く（refspec と取り違えないため）
- 先頭の環境変数代入、git の大域オプション（`-C <dir>` など）を読み飛ばす。`cd <dir>` と `-C` で作業ディレクトリを追う
- 同じコマンド内の `git checkout -b` / `-B`、`git switch -c` / `-C` / `--create`、`git switch <名前>` のあとは、切り替え後のブランチで判定する
- 既定ブランチと現在のブランチは、該当するコマンドがあるときだけ `git symbolic-ref` と `git branch --show-current` で取得する
- マージの依頼：`input` イベントで、ユーザーの生の入力（`/skill:…` の展開前）に「マージ」「merge」があるかを記録する。待機中の新しい入力では置き換え、実行中の追加入力では足す。拡張が送った入力は数えない

## 既知の制約

- 文字列からの推測なので、`bash -c` やサブシェルの中、変数展開は見ていない
- 同じコマンド内での `-b` なしの `git checkout <名前>` による切り替えは追わない（例：`git checkout main && git merge feat/x && git push` は止まらない）
- 切り替えのあとにサブディレクトリへ `cd` してから commit すると、切り替え前のブランチで判定されて誤って止めることがある
- 否定文（「マージはしないで」）でも語があればダイアログになる
