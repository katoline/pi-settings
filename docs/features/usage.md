# 利用状況（usage）

## 概要

フッターに各プロバイダーの利用状況を出す。`/usage` でまとめて表示する。

## 関連

- コード：`agent/extensions/usage/index.ts`（pi への接続・取得）、`parse.ts`（応答の解析と書式の純粋ロジック）、`parse.test.ts`
- 決定：[009](../decisions/009-anthropic-usage-session-cost.md)
- 認証：[setup/providers.md](../setup/providers.md)
- 統合予定：[plan/phase-6-usage-compaction.md](../plan/phase-6-usage-compaction.md)

## 表示

| プロバイダー | 表示 | 出どころ |
| --- | --- | --- |
| Codex | 5 時間・週の使用率とリセットまでの時間 | `GET https://chatgpt.com/backend-api/wham/usage`（非公式） |
| OpenCode Go | 5 時間・週・月の使用率 | `GET https://opencode.ai/zen/go/v1/usage`（非公式） |
| Anthropic API | この pi セッションで Anthropic のモデルに使った額（USD） | pi がメッセージごとに記録する費用（`usage.cost.total`）の合計。外部 API は呼ばない |

- フッターの Anthropic の額は、今のモデルのプロバイダーが `anthropic` のときだけ付く
- `/usage` は 3 つすべてを出し、取得できなかった理由とリセットまでの時間も出す。Anthropic は使っていなければ $0.00

## 処理

- Codex と Go は 60 秒ごとに取得する（リクエストのタイムアウトは 12 秒）
- Codex の窓は `limit_window_seconds` で判定する（18000 = 5 時間、604800 = 週）。その窓が無いプランでは、返ってきた窓（例：30 日）を出す
- Anthropic の額は、セッションの全エントリ（`getEntries()`。`/tree` で捨てた分岐も含む。捨てた分岐の分も課金済みのため。pi 本体のフッターと同じ数え方）の assistant メッセージと `type: "usage"` エントリのうち、プロバイダーが `anthropic` のものを合計する。小数 2 桁に丸める
- 更新は `turn_end`・`agent_end`・`model_select`・`session_start`。`message_end` は pi がメッセージを保存する前に呼ばれるので使わない
- 認証は Pi に保存された資格情報を `getProviderAuth` で取る（OAuth の期限が近ければ pi が更新する）。無ければ Codex は `$CODEX_HOME/auth.json` / `~/.codex/auth.json`、Go は `OPENCODE_API_KEY` を読むだけ（更新しない）

## 既知の制約

- Codex と Go のエンドポイントは非公式で、形が変わると「取得できない」と表示される（作業は止まらない）
- Anthropic の額は pi の見積もり。残高とアカウント全体の請求額は Console で確認する。要約（compaction）とブランチ要約の費用はプロバイダーが記録されないため含まない
- サブエージェントの費用はまだ含まない（[plan/phase-6-usage-compaction.md](../plan/phase-6-usage-compaction.md)）
