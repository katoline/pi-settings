# pi-settings

Pi coding agent の個人設定と拡張を置くリポジトリです。`agent/` は Pi のエージェントディレクトリ `~/.pi/agent` と同じ構成にしてあり、`~/.pi/agent` 配下からシンボリックリンクで参照して使います。

## できること

| 機能 | 内容 | 詳細 |
| --- | --- | --- |
| 利用状況 | フッターに Codex（5時間・週）と OpenCode Go（5時間・週・月）の使用率、Anthropic API ではこのセッションの使用額（サブエージェントの分を含む）を出します。`/usage` でまとめて表示し、サブエージェントの費用の内訳も出します | [docs/features/usage.md](docs/features/usage.md) |
| ハーネスのガード | bash・ファイルツールの実行前に判定し、既定ブランチへの commit・push、force push、`--no-verify`、履歴や作業ツリーを壊す git 操作、プロジェクトの外へのインストール、範囲外の削除、秘密情報の読み取りを、確認ダイアログなしで止めます（必要ならユーザーが `!` で実行します）。出力のトークン類は `[秘匿]` にします。bash からの PR の作成・更新・マージは常に止め、専用ツールへ誘導します | [docs/features/harness-guards.md](docs/features/harness-guards.md) |
| /exit | `/quit` と同じ終了処理を `/exit` でも呼べます | [docs/features/exit.md](docs/features/exit.md) |
| PR の作成・マージ | 作業が終わったら、`harness_pr_create` が作業ブランチを push して PR を作ります（既にあれば、本文の生成部分だけ作り直して更新）。マージは、依頼したときだけ `harness_pr_merge` が使え、CI を待って確認ダイアログを出し、許可されたら merge commit でマージします（ブランチは消しません）。bash からの `gh pr` の作成・更新・マージは拒否します | [docs/features/harness-pr.md](docs/features/harness-pr.md) |
| git-pull スキル | `/skill:git-pull` で、カレントディレクトリのリポジトリ（外なら配下 3 階層まで）をデフォルトブランチに切り替えて fast-forward で最新にします | [docs/features/git-pull-skill.md](docs/features/git-pull-skill.md) |
| ui-compare スキル | `/skill:ui-compare` で、最後のコミットと作業ツリーの画面をヘッドレス Chrome で撮り、修正前後を見比べる HTML を作ります | [docs/features/ui-compare-skill.md](docs/features/ui-compare-skill.md) |
| モデル選択とサブエージェント | `/models` でメインのモデルを（OpenCode Go・Anthropic API・Codex の 2 段階で）選び、`/subagent-model` でサブエージェントのモデルを切り替えます。`subagent` ツールで、別の Pi プロセス（scout・planner・reviewer は読み取り専用、worker は書き込み可）に作業を任せます。書き込み可の役割は同時に 1 件だけです | [docs/features/harness-models-subagents.md](docs/features/harness-models-subagents.md) |
| 計画・自律ループ・検証・独立レビュー | ファイルを変更する依頼を、完了条件つきの計画にして確定ダイアログで確定し（`ask_user`・`plan_propose`）、確定後は質問せずに完了まで進めます（未完了の間は自動で続き、Esc・エラーでの終了・キルスイッチ `~/.pi/agent/harness-off`・上限で止まります。`/plan` で状況・再開・停止・破棄）。完了は、根拠・検証（`harness_verify`）・独立レビュー（`harness_review`）・作業ツリーの指紋で判定し、`plan_report` が完了報告を作ります | [docs/features/harness-flow.md](docs/features/harness-flow.md) |
| 日本語の要約（compaction） | 会話の要約を日本語で作り直し、変更ファイルと検証・検証の結果・PR・サブエージェントの状態・決定事項を必ず残します。末尾に、計画・検証・レビュー・PR・サブエージェントの件数と費用と、読んだファイル・変更したファイルの一覧をモデルを通さずそのまま付けます。`/compact <指示>` の指示も反映します。要約のモデルは設定 `compactionModel` で選べます（空なら今のモデル）。失敗したら pi の標準の要約に任せます | [docs/features/harness-compaction.md](docs/features/harness-compaction.md) |
| 固定の指示と完了の合図 | どのディレクトリで Pi を使っても、拡張がシステムプロンプトの `<harness>` セクションに作業の約束事を差し込みます（Codex・OpenCode Go・Anthropic API のどのモデルでも通じる書き方）。成果物を作る操作をした依頼の最終応答の最後に「🚀作業が完了しました！」を書き足します | [docs/features/harness-instructions.md](docs/features/harness-instructions.md) |

## 有効にする

次のリンクを張っています（張り済み）。編集後は Pi を開き直すか `/reload` すると反映されます。以前張っていた `~/.pi/agent/AGENTS.md` のリンクは廃止しました（指示は拡張が渡します。消し方は [docs/setup/linking.md](docs/setup/linking.md)）。

```sh
R=/Users/peipou/Dev/hobby/katoline-org/pi-settings
ln -s $R/agent/extensions ~/.pi/agent/extensions
ln -s $R/agent/skills ~/.pi/agent/skills
ln -s $R/agent/settings.json ~/.pi/agent/settings.json
ln -s $R/agent/agents ~/.pi/agent/agents
```

`settings.json` は Pi 自身も書き換えます（モデルを切り替えたときなど）。差分が出たら、残したければコミットし、不要なら戻してください。詳しくは [docs/setup/](docs/setup/README.md) を参照してください。

## ドキュメント

計画・決定事項・機能の仕様・設定の詳細は [docs/](docs/README.md) にまとめています。

- [docs/plan/](docs/plan/README.md)：取り込み計画（[pi-coding-agent-settings](https://github.com/katoline/pi-coding-agent-settings) のハーネスの移植）と音声入力の計画
- [docs/decisions/](docs/decisions/README.md)：決定記録
- [docs/features/](docs/features/README.md)：機能の仕様
- [docs/setup/](docs/setup/README.md)：リンク・設定・認証
- [docs/reference/](docs/reference/README.md)：調査結果
