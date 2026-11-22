# pi-settings

Pi coding agent の個人設定と拡張を置くリポジトリ。このファイルはこのリポジトリで作業するときの指示で、`CLAUDE.md` はこのファイルへのシンボリックリンク（Claude Code と Pi の両方が同じ内容を読む）。

## 構成

`agent/` は Pi のエージェントディレクトリ `~/.pi/agent` と同じ構成にし、`~/.pi/agent` 配下からシンボリックリンクで参照している（`AGENTS.md`・`extensions/`・`skills/`）。Pi の設定ファイル・拡張・スキルはここに置き、置き場所は Pi のドキュメントのエージェントディレクトリの規約に合わせる。ここでの変更はリンク経由でそのまま手元の Pi に効く。

- `agent/AGENTS.md`：Pi のグローバル指示。全ディレクトリでの Pi の作業に効く。Codex・OpenCode Go・Anthropic API のどのモデルでも通じるよう、特定のエージェント製品のツール名やモデル名を前提にしない。このリポジトリ固有の内容は書かず、本ファイルに書く
- `agent/extensions/<名前>/index.ts`：Pi 拡張（自動で読み込まれる）。追加・削除したら `package.json` の `pi.extensions` と README を合わせる。判定などの純粋ロジックは別ファイルに分けて `*.test.ts` でテストする
- `agent/skills/<名前>/SKILL.md`：Pi のスキル。追加・削除したら README を合わせる
- `agent/AGENTS.md`・`agent/skills/pr`・`agent/extensions/git-guard` は同じ運用（作業ごとに PR を自動作成し、マージはしない）を支えるので、どれかを変えたら他との食い違いを確認する

## 脅威モデル

拡張はどれも自分たちだけが使う Pi の事故防止・補助の部品。外部の入力を受けるのは `usage` 拡張の API 応答のパースだけ。

## 検証

```sh
node --test 'agent/extensions/**/*.test.ts'
```
