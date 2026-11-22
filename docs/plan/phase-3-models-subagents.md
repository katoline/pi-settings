# フェーズ 3：モデル選択とサブエージェント

## 概要

メインのモデルを Codex・OpenCode Go・Anthropic API から選べるようにし、作業を別の pi プロセス（サブエージェント）に任せられるようにする。

## 関連

- 移植元：`agent/extensions/harness/models/`（catalog・register）、`subagent/`（agents・child・format・register）、`agent/agents/`（scout・planner・worker・reviewer）、`agent/settings.json`（`enabledModels`）
- 移植元のテスト：`tests/{models,subagent}.test.ts`、`tests/e2e.test.ts` の場面 2
- 状態：未着手

## タスク

- [ ] `/models`：プロバイダー → モデルの 2 段階で選ぶ。グループは OpenCode Go（`opencode-go` の全モデル）、Anthropic API（`claude-opus-5-5`・`claude-sonnet-5-5`・`claude-fable-5-2`・`claude-haiku-5-5`）、Codex（`openai-codex`）
- [ ] 起動時のモデル選択（`selectModelOnStartup`）は既定で無効にする（確認ダイアログを増やさないため。`/models` で選ぶ）
- [ ] `agent/settings.json` に `enabledModels` を足す（リンク済みなのでそのまま効く。[setup/settings.md](../setup/settings.md)）
- [ ] `subagent` ツール：別の `pi` プロセスを起動する（`--mode json -p --no-session --no-extensions -e <harness>`）。1 回 8 件まで・同時 4 件・1 件 15 分・セッション合計 64 件。表示は「⏳ …を実行中」「✅ …が完了」
- [ ] 子プロセスは環境変数 `PI_SUBAGENT=1` で見分け、ガードを厳しくする（commit・push・PR の書き込みを拒否）
- [ ] 4 つの役割を `agent/agents/` に置く：scout（調査）・planner（計画）・reviewer（レビュー）は読み取り専用、worker（実装）は書き込み可
- [ ] `/subagent-model`：サブエージェントのモデルを切り替える。既定は OpenCode Go の DeepSeek V4.1 Flash
- [ ] サブエージェントの費用を集計する（フェーズ 6 で利用状況に足す）
- [ ] `agent/agents/` のリンクを足す（[setup/linking.md](../setup/linking.md)）

## 完了条件

- 偽のモデルを使う e2e で、子プロセスが起動し、報告が親に返る
- 子では読み取り専用の役割に書き込みツールが無い

## 注意

- 移植元でもサブエージェントの方式は暫定（別プロセス方式）
