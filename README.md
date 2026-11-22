# pi-settings

Pi coding agent の個人設定と拡張を置くリポジトリです。`agent/` は Pi のエージェントディレクトリ `~/.pi/agent` と同じ構成にしてあり、中身を `~/.pi/agent` 配下へシンボリックリンクして使います（「有効にする」節）。

## 利用状況

`agent/extensions/usage` がフッターに次を出します。

| プロバイダー | 表示 |
| --- | --- |
| Codex | 5時間・週間の使用率 |
| OpenCode Go | 5時間・週間・月間の使用率 |

`%` は各 API が返す使用率です。`/usage` でリセットまでの時間と取得できなかった理由を見られます。

Codex の 5時間枠は `limit_window_seconds = 18000`、週間枠は `604800` で判定します。その枠がないプランでは、代わりに返ってきた枠（例: 30日）を出します。

### 認証

Pi に保存された資格情報は Pi の `getProviderAuth` 経由で取得するため、OAuth の期限が近いと Pi 自身が通常どおり更新します。Pi 以外（`~/.codex/auth.json`、`OPENCODE_API_KEY`）は読み取るだけで、更新しません。

- Codex: Pi の `openai-codex`、なければ `$CODEX_HOME/auth.json` または `~/.codex/auth.json`
- OpenCode Go: Pi の `opencode-go`、なければ `OPENCODE_API_KEY`

## /exit

`agent/extensions/exit` は `/quit` と同じ終了処理を `/exit` でも呼べるようにします。エージェントの実行中は、終わってから終了します。

## git-guard

`agent/extensions/git-guard` は、Pi が bash で実行する git / gh コマンドを実行前に検査します。Pi には作業が終わるたびに PR まで自動で作らせる運用なので（`agent/AGENTS.md`）、その事故を止める役です。

| コマンド | 扱い |
| --- | --- |
| 既定ブランチ（`origin/HEAD` の指す先。取れなければ `main` / `master`）への commit・push | ブロック |
| force push（`-f` / `--force` / `--force-with-lease` / `+refspec`）、push での削除（`-d` / `--delete` / `:ref` / `--mirror`）、`--no-verify` | ブロック |
| `gh pr merge`、`gh api` での `/pulls/<番号>/merge` | ユーザーの入力に「マージ」「merge」が無ければ、確認ダイアログを出さずにブロックする。あれば確認ダイアログを出し、許可したときだけ実行する（UI のない `--print` などではブロック） |

「マージ」「merge」の判定に使うのは、そのとき実行中の依頼（待機中に入力した文。実行中に追加入力した文も含む）で、`/skill:…` を展開する前の文字列です。普段の作業中に pi が勝手にマージしようとしても、確認ダイアログは出ずに止まります。マージさせたいときは「<PR> をマージして」のように、その一文で依頼してください（pi が聞き返してきて「はい」とだけ答えると、その返事には「マージ」が無いので止まります。pi にはマージ前に聞き返さないよう指示しています）。「マージはしないで」のような否定文でも語が含まれていれば確認ダイアログが出ますが、そこで拒否すれば実行されません。

同じコマンド内で `git checkout -b` / `git switch -c` / `git switch <名前>` したあとの commit・push は、切り替え後のブランチで判定します。

事故防止のための検査で、実行前のコマンド文字列から推測しているだけです。次の形は検査の対象外です（既知の制約）。

- `bash -c` やサブシェルの中に書いたコマンド、変数展開
- 同じコマンド内での `-b` なしの `git checkout <名前>` による切り替え（例：`git checkout main && git merge feat/x && git push` は止まらない）
- 切り替えたあと、同じリポジトリのサブディレクトリへ `cd` してからの commit（切り替え前のブランチで判定するので、誤って止めることがある）

既定ブランチへの push を確実に防ぐには、GitHub 側のブランチ保護（ruleset）を併用します。

## 指示ファイルとスキル

| ファイル | 効く範囲 |
| --- | --- |
| `agent/AGENTS.md` | Pi のグローバル指示。どのディレクトリで Pi を使っても読み込まれる。Codex・OpenCode Go・Anthropic API のどのモデルで使っても通じる書き方にしてある |
| `agent/skills/pr/SKILL.md` | 作業が終わったら目的ごとにコミットし、push して PR を作る（既存の PR は説明を更新する）手順。マージはしない |
| `AGENTS.md`（`CLAUDE.md` はこれへのリンク） | このリポジトリで作業するときだけの指示 |

## 有効にする

`AGENTS.md` と、拡張・スキルのディレクトリを丸ごとリンクしています（張り済み）。`agent/extensions` と `agent/skills` に足したものは、そのまま Pi に読み込まれます。

```sh
ln -s /Users/peipou/Dev/hobby/katoline-org/pi-settings/agent/AGENTS.md ~/.pi/agent/AGENTS.md
ln -s /Users/peipou/Dev/hobby/katoline-org/pi-settings/agent/extensions ~/.pi/agent/extensions
ln -s /Users/peipou/Dev/hobby/katoline-org/pi-settings/agent/skills ~/.pi/agent/skills
```

編集後は Pi を開き直すか `/reload` すると反映されます。リンクで有効にしているので、このリポジトリを `pi install` でパッケージとしても入れると拡張が二重に読み込まれます（`package.json` の `pi` 欄はパッケージとして配る場合のためのものです）。
