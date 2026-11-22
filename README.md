# pi-settings

Pi coding agent の個人設定と拡張を置くリポジトリです。`agent/` は Pi のエージェントディレクトリ `~/.pi/agent` と同じ構成にしてあり、`~/.pi/agent` 配下からシンボリックリンクで参照して使います。

## できること

| 機能 | 内容 | 詳細 |
| --- | --- | --- |
| 利用状況 | フッターに Codex（5時間・週）と OpenCode Go（5時間・週・月）の使用率、Anthropic API ではこのセッションの使用額を出します。`/usage` でまとめて表示します | [docs/features/usage.md](docs/features/usage.md) |
| ハーネスのガード | bash・ファイルツールの実行前に判定し、既定ブランチへの commit・push、force push、`--no-verify`、履歴や作業ツリーを壊す git 操作、プロジェクトの外へのインストール、範囲外の削除、秘密情報の読み取りを、確認ダイアログなしで止めます（必要ならユーザーが `!` で実行します）。出力のトークン類は `[秘匿]` にします。PR のマージは、依頼したときだけ確認ダイアログを出します | [docs/features/harness-guards.md](docs/features/harness-guards.md) |
| /exit | `/quit` と同じ終了処理を `/exit` でも呼べます | [docs/features/exit.md](docs/features/exit.md) |
| pr スキル | 作業が終わったら、目的ごとにコミットして PR を作ります（マージはしません） | [docs/features/pr-skill.md](docs/features/pr-skill.md) |
| git-pull スキル | `/skill:git-pull` で、カレントディレクトリのリポジトリ（外なら配下 3 階層まで）をデフォルトブランチに切り替えて fast-forward で最新にします | [docs/features/git-pull-skill.md](docs/features/git-pull-skill.md) |
| ui-compare スキル | `/skill:ui-compare` で、最後のコミットと作業ツリーの画面をヘッドレス Chrome で撮り、修正前後を見比べる HTML を作ります | [docs/features/ui-compare-skill.md](docs/features/ui-compare-skill.md) |
| グローバル指示 | どのディレクトリで Pi を使っても読み込まれる指示です。Codex・OpenCode Go・Anthropic API のどのモデルでも通じる書き方にしてあります | [docs/features/global-instructions.md](docs/features/global-instructions.md) |

## 有効にする

次のリンクを張っています（張り済み）。編集後は Pi を開き直すか `/reload` すると反映されます。

```sh
R=/Users/peipou/Dev/hobby/katoline-org/pi-settings
ln -s $R/agent/AGENTS.md ~/.pi/agent/AGENTS.md
ln -s $R/agent/extensions ~/.pi/agent/extensions
ln -s $R/agent/skills ~/.pi/agent/skills
ln -s $R/agent/settings.json ~/.pi/agent/settings.json
```

`settings.json` は Pi 自身も書き換えます（モデルを切り替えたときなど）。差分が出たら、残したければコミットし、不要なら戻してください。詳しくは [docs/setup/](docs/setup/README.md) を参照してください。

## ドキュメント

計画・決定事項・機能の仕様・設定の詳細は [docs/](docs/README.md) にまとめています。

- [docs/plan/](docs/plan/README.md)：取り込み計画（[pi-coding-agent-settings](https://github.com/katoline/pi-coding-agent-settings) のハーネスの移植）と音声入力の計画
- [docs/decisions/](docs/decisions/README.md)：決定記録
- [docs/features/](docs/features/README.md)：機能の仕様
- [docs/setup/](docs/setup/README.md)：リンク・設定・認証
- [docs/reference/](docs/reference/README.md)：調査結果
