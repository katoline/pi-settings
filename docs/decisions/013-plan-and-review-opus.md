# 013: 設計・計画とレビューのサブエージェントは Claude Opus 5.5 で動かす

- 日付: 2026-11-23
- 状態: 有効

## 背景

サブエージェントのモデルは、既定で OpenCode Go の DeepSeek V4.1 Flash（`/subagent-model` で変更可）。設計・計画の planner と、独立レビュー（`harness_review`）の reviewer もこれを引き継いでいた。計画は作業全体の出来を、レビューは完了の判定とマージのゲートを左右するので、判断の質が大事になる。

## 決定

ユーザーの方針（2026-11-23）：設計・計画とレビューは Opus 5.5、それ以外（調査・実装など）は DeepSeek V4.1 Flash。

| 役割 | モデル | 指定のしかた |
| --- | --- | --- |
| `planner`（設計・計画） | Claude Opus 5.5 | `agent/agents/planner.md` に `model: anthropic/claude-opus-5-5` |
| `reviewer`（独立レビュー） | Claude Opus 5.5 | `agent/agents/reviewer.md` に同じ指定 |
| `scout`（調査）・`worker`（実装） | DeepSeek V4.1 Flash | 指定しない（`/subagent-model` の既定に従う） |

役割の `model` は `/subagent-model` より優先する。

メインのセッションは、既定のモデル（DeepSeek V4.1 Flash）のまま、計画を立てるときとサブエージェントを管理する（オーケストレーションする）ときに、ユーザーが `/models` で Opus 5.5 に切り替える（自動では切り替えない）。メインが Opus でも実装を抱え込まないよう、指示（`instructions/main.md` の「サブエージェント」）で、実装とテストは `worker`、複数ファイルの調査は `scout` に任せ、メインは要件・計画・依頼・確認・最終判断に専念させる。

## 理由

- 計画とレビューは、読む量に比べて書く量が少なく、回数も計画の項目ごとに限られる。強いモデルの費用に見合う
- 実装と違うモデルでレビューすると、実装したモデルと同じ癖の見落としを避けやすい

## 注意

- Anthropic の従量課金になる。費用はフッターの Anthropic の額と `/usage` のサブエージェントの内訳に出る（[features/usage.md](../features/usage.md)）
- Anthropic の認証が無い・切れているときは、planner と reviewer の起動が失敗する。レビューは「判定なし」になる（承認としない）。そのときは `/login` するか、役割の定義の `model` を一時的に外す
- メインのセッション自身が立てる計画（`plan_propose`）は、メインのモデルで作られる。計画の前に `/models` で Opus に切り替えるのを忘れると、DeepSeek で計画が立つ
- reviewer を Codex の GPT-6.2 Astra に変える可能性がある（未定）。変えるなら `model: openai-codex/gpt-6.2-astra` にする。GPT-6.2 Astra は pi 1.6.0 で追加されたので、pi の更新（今は 1.5.2）が先に要る

## 却下した案

- `/subagent-model` を Opus にする：調査・実装まで従量の Opus になり、費用がかさむ

## 関連

- [features/harness-models-subagents.md](../features/harness-models-subagents.md)・[features/harness-flow.md](../features/harness-flow.md)
