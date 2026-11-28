# pi-settings

pi coding agent（`@earendil-works/pi-coding-agent` 1.5.2）の個人設定と拡張を置くリポジトリです。`agent/` は pi のエージェントディレクトリ `~/.pi/agent` と同じ構成にしてあり、`scripts/install.sh` でシンボリックリンクを張って使います。

## できること

主な機能は拡張 `harness` にまとまっています。詳しい仕様は各リンク先を見てください。

| 機能 | 内容 | 詳細 |
| --- | --- | --- |
| ガード | 既定ブランチへの commit・push、force push、`--no-verify`、履歴を壊す git 操作、プロジェクト外へのインストール、範囲外の削除、秘密情報の読み取りを、確認ダイアログなしで止めます。出力のトークン類は `[秘匿]` にします | [harness-guards.md](docs/features/harness-guards.md) |
| 固定の指示と完了の合図 | 作業の約束事を、どのディレクトリでもシステムプロンプトに差し込みます。成果物を作った依頼の最後に「## ✅ 作業完了」を書き足します | [harness-instructions.md](docs/features/harness-instructions.md) |
| モデル選択とサブエージェント | `/models`・`/subagent-model` でモデルを選び、`/effort` でエフォート（思考レベル）を設定し、`subagent` ツールで別の pi プロセスに作業を任せます | [harness-models-subagents.md](docs/features/harness-models-subagents.md) |
| 計画と自律ループ | ファイルを変更する依頼を、完了条件つきの計画にして確定してから、完了まで質問せずに進めます。`/plan` で状況の確認・再開・停止・破棄ができます | [harness-flow.md](docs/features/harness-flow.md) |
| 検証と独立レビュー | 完了は、根拠・検証（`harness_verify`）・独立レビュー（`harness_review`）で判定し、完了報告を作ります | [harness-flow.md](docs/features/harness-flow.md) |
| PR の作成とマージ | 作業が終わったら `harness_pr_create` で PR を作ります。マージは依頼されたときだけ、CI を待って確認ダイアログを出してから行います | [harness-pr.md](docs/features/harness-pr.md) |
| 利用状況と要約 | フッターに使用率や使用額を出し、`/usage` でまとめて見られます。会話の要約は日本語で作り直します | [usage.md](docs/features/usage.md)・[harness-compaction.md](docs/features/harness-compaction.md) |
| /exit | `/quit` と同じ終了処理を `/exit` でも呼べます | [exit.md](docs/features/exit.md) |
| /clear | 会話を空にして新しいセッションを始めます（`/new` と同じ） | [clear.md](docs/features/clear.md) |
| git-pull スキル | `/skill:git-pull` で、リポジトリをデフォルトブランチに切り替えて最新にします | [git-pull-skill.md](docs/features/git-pull-skill.md) |
| ui-compare スキル | `/skill:ui-compare` で、修正前後の画面を見比べる HTML を作ります | [ui-compare-skill.md](docs/features/ui-compare-skill.md) |
| nix-setup スキル | `/skill:nix-setup` で、TypeScript プロジェクトに Nix の devShell・direnv・Biome・CI・Dependabot などを用意します | [nix-setup.md](docs/features/nix-setup.md) |

## 導入

```sh
git clone <このリポジトリ> && cd pi-settings
scripts/install.sh --dry-run   # 何をするか確認する（何も変えない）
scripts/install.sh             # ~/.pi/agent にリンクを張る
```

そのあと、pi を開き直すか、pi の中で `/reload` します。同じ名前のファイルが既にあるときは、上書きせずに知らせて終了します（内容を確認して手で移してください）。詳しくは [docs/setup/linking.md](docs/setup/linking.md) を見てください。

API キーは pi の `/login` などで設定します。キーや OAuth トークンが入る `auth.json` はリポジトリに置きません（[docs/setup/providers.md](docs/setup/providers.md)）。

`settings.json` は pi 自身も書き換えます。差分が出たら、残したければコミットし、不要なら戻してください。

## 構成

| パス | 中身 |
| --- | --- |
| `agent/extensions/` | pi の拡張（`harness`・`exit`・`clear`） |
| `agent/skills/` | pi のスキル（`git-pull`・`ui-compare`・`nix-setup`） |
| `agent/agents/` | サブエージェントの役割の定義 |
| `agent/settings.json` | pi のユーザー設定 |
| `scripts/` | 配置スクリプト `install.sh` |
| `tests/` | テスト（ユニットテストと、実際の pi を使う e2e） |
| `docs/` | 計画・決定記録・機能の仕様・設定・調査結果（[docs/README.md](docs/README.md)） |
| `AGENTS.md` | このリポジトリで作業するときの指示（`CLAUDE.md` はそのリンク） |

## 開発

```sh
nix develop -c npm run check
```

biome・`tsc --noEmit`・テストを順に実行します。詳しくは [docs/setup/development.md](docs/setup/development.md) を見てください。
