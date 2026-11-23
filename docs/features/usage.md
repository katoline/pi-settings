# 利用状況（usage）

## 概要

フッターに各プロバイダーの利用状況を出す。`/usage` でまとめて表示する。

## 関連

- コード：`agent/extensions/harness/usage/register.ts`（pi への接続・取得。`harness/index.ts` が登録）、`parse.ts`（応答の解析と書式の純粋ロジック）、`children.ts`（サブエージェントの費用の集計と書式）。テストは `tests/harness-usage.test.ts`
- 場所：フェーズ 6 で `agent/extensions/usage/` から `harness/usage/` へ移した（`package.json` の `pi.extensions` からは外した）。表示・更新のタイミング・認証は変えていない
- 決定：[009](../decisions/009-anthropic-usage-session-cost.md)
- 認証：[setup/providers.md](../setup/providers.md)
- 計画：[plan/phase-6-usage-compaction.md](../plan/phase-6-usage-compaction.md)
- 要約：[harness-compaction.md](harness-compaction.md)

## 表示

| プロバイダー | 表示 | 出どころ |
| --- | --- | --- |
| Codex | 5 時間・週の使用率とリセットまでの時間 | `GET https://chatgpt.com/backend-api/wham/usage`（非公式） |
| OpenCode Go | 5 時間・週・月の使用率 | `GET https://opencode.ai/zen/go/v1/usage`（非公式） |
| Anthropic API | この pi セッションで Anthropic のモデルに使った額（USD） | pi がメッセージごとに記録する費用（`usage.cost.total`）の合計。外部 API は呼ばない |

- フッターの Anthropic の額は、今のモデルのプロバイダーが `anthropic` のときだけ付く。プロバイダーが `anthropic` のサブエージェントの費用も含む
- `/usage` は 3 つすべてを出し、取得できなかった理由とリセットまでの時間も出す。Anthropic は使っていなければ $0.00
- `/usage` の Anthropic の行も、フッターと同じく、プロバイダーが `anthropic` のサブエージェントの費用を含む。子の分があれば「うちサブエージェント $X」と示す。例：`Anthropic API: このセッション $0.35（うちサブエージェント $0.25。pi の見積もり。残高と請求額は Console で確認）`
- `/usage` には、サブエージェントの行も出る。例：`サブエージェント: $0.42（3 件、内訳: anthropic $0.30 / opencode-go $0.12。OpenCode Go・Codex はサブスクのため、額は pi の見積もり）`
- 内訳の `anthropic` の額は、Anthropic の行の「うちサブエージェント」と同じ額。Anthropic の行とサブエージェントの行を足すと、その分が二重になる
- サブエージェント（`PI_SUBAGENT=1`）では登録しない（子のフッターは見えないため。子は `--no-extensions` でハーネスだけを読み込む）

## 処理

- Codex と Go は 60 秒ごとに取得する（リクエストのタイムアウトは 12 秒）
- Codex の窓は `limit_window_seconds` で判定する（18000 = 5 時間、604800 = 週）。その窓が無いプランでは、返ってきた窓（例：30 日）を出す
- Anthropic の額は、セッションの全エントリ（`getEntries()`。`/tree` で捨てた分岐も含む。捨てた分岐の分も課金済みのため。pi 本体のフッターと同じ数え方）の assistant メッセージと `type: "usage"` エントリのうち、プロバイダーが `anthropic` のものを合計する。小数 2 桁に丸める
- サブエージェントの費用は、セッションの全エントリ（捨てた分岐も含む）の `subagent`・`harness_review` のツール結果の `details`（`harness_review` は `details.children`）にある子の結果から、子の `model`（`provider/id`）と `usage.cost` でプロバイダーごとに数える（件数は `subagentTotals` と同じ数え方）。`details` が無い結果（断られた呼び出し）は数えない。プロバイダーが読めない子は `unknown`
- 更新は `turn_end`・`agent_end`・`model_select`・`session_start`。`message_end` は pi がメッセージを保存する前に呼ばれるので使わない
- `harness/index.ts` で、`registerModels` より前に登録する。pi は同じイベントのハンドラを登録順に待つので、起動時のモデル選択のダイアログ（`registerModels` の `session_start`）の間も、フッターが出る
- Codex・Go の取得は、`registerUsage` の第 3 引数で差し替えられる（テスト用。省略時は上のエンドポイントから取る）
- 認証は Pi に保存された資格情報を `getProviderAuth` で取る（OAuth の期限が近ければ pi が更新する）。無ければ Codex は `$CODEX_HOME/auth.json` / `~/.codex/auth.json`、Go は `OPENCODE_API_KEY` を読むだけ（更新しない）

## 既知の制約

- Codex と Go のエンドポイントは非公式で、形が変わると「取得できない」と表示される（作業は止まらない）
- Anthropic の額は pi の見積もり。残高とアカウント全体の請求額は Console で確認する。要約（compaction）とブランチ要約の費用は、pi がプロバイダーを付けずに記録する（`usage` だけ）ので含まない。ハーネスの要約が返す `usage` も同じで、pi 本体のフッターの合計には入るが、この額には入らない
- サブエージェントの費用も pi の見積もり。OpenCode Go・Codex の子はサブスクの範囲なので、実際の請求ではない
- 子の費用は、結果が保存された `turn_end` の後に数える。実行中の子の費用は、終わるまで反映されない
