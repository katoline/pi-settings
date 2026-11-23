# モデル選択とサブエージェント

## 概要

メインのモデルを OpenCode Go・Anthropic API・Codex から選べるようにし（`/models`）、作業を別の pi プロセス（サブエージェント）に任せられるようにする（`subagent` ツール、フェーズ 3）。サブエージェントのモデルは `/subagent-model` で切り替える。

## 関連

- コード：`agent/extensions/harness/models/`（`catalog.ts`・`register.ts`）、`subagent/`（`agents.ts`・`child.ts`・`format.ts`・`register.ts`・`run.ts`。子を起動する本体は `run.ts` の `runSubagentTasks`で、`subagent` ツールと `harness_review` が共有する）、`lib/state.ts`、`agent/agents/`（`scout.md`・`planner.md`・`worker.md`・`reviewer.md`）、`agent/settings.json`（`enabledModels`）
- テスト：`tests/harness-models.test.ts`・`tests/harness-subagent.test.ts`・`tests/harness-config.test.ts`・`tests/harness-output.test.ts`・`tests/harness-e2e-subagent.test.ts`（偽のモデルで実際の pi を起動する）
- 決定：[011](../decisions/011-no-worktree.md)（worktree を使わない）、[002](../decisions/002-provider-neutral-instructions.md)
- 計画：[plan/phase-3-models-subagents.md](../plan/phase-3-models-subagents.md)（完了）
- 独立レビューでの reviewer の使われ方：[harness-flow.md](harness-flow.md)
- 指示：[harness-instructions.md](harness-instructions.md)（`main.md` の「サブエージェント」の節、`subagent.md`）
- 設定：[setup/settings.md](../setup/settings.md)（`enabledModels`・`harness.json`）、[setup/linking.md](../setup/linking.md)（`agents` のリンク）

## コマンド

| コマンド | 内容 |
| --- | --- |
| `/models` | メインのモデルを、プロバイダー → モデルの 2 段階で選ぶ。グループは OpenCode Go（`opencode-go` の全モデル）、Anthropic API（`claude-opus-5-5`・`claude-sonnet-5-5`・`claude-fable-5-2`・`claude-haiku-5-5`）、Codex（`openai-codex`、または ChatGPT でサインインした `openai`）。認証が済んでいないグループは出ない。`/models <provider>/<id>` で直接指定もできる |
| `/subagent-model` | サブエージェントのモデルを、同じ 2 段階で選ぶ。`/subagent-model <provider>/<id>` で直接指定、`reset` で既定に戻す。直接指定は `/models` と同じく、モデルが見つからない・認証が未設定（`getAvailable` に無い）・`provider/id` の形でないときは、保存せずにエラーで通知する。引数なしでキャンセルすると現在のモデルを表示する。選んだモデルは `pi.appendEntry` でセッションに保存し、`session_start`・`session_tree` で復元する |

- サブエージェントの既定は `opencode-go/deepseek-v4.1-flash`。環境変数 `PI_SUBAGENT_MODEL`（`provider/id` の形）で上書きできる
- 起動時のメインのモデル選択は、設定 `selectModelOnStartup` が `true` のときだけ（既定 `false`。確認ダイアログを増やさないため）。再開・リロード・フォークでは出ない

## subagent ツール

`subagent` ツールは、メインだけが持つ（子では登録しない。再帰の防止）。引数は `tasks`（1〜`subagent.maxTasks` 件。既定 8）で、各要素は `agent`（役割）・`title`（題名）・`task`（自己完結した依頼）。`cwd` の引数は無く、子はいつも親の作業ディレクトリで動く（worktree を使わない。[011](../decisions/011-no-worktree.md)）。

子プロセスの起動：

```
pi --mode json -p --no-session --no-extensions -e <harness の index.ts> --no-mcp --no-skills --no-prompt-templates --model <モデル> [--tools <役割の tools>] [--append-system-prompt <役割の指示の一時ファイル>] "Task: <依頼>"
```

- 環境変数：`PI_SUBAGENT=1`（ガードが「サブエージェントである」と知る）、`PI_SUBAGENT_ROLE`、`PI_SUBAGENT_MODEL`、`PI_HARNESS_PARENT_SESSION`
- 標準入力は閉じるので、子はユーザーに質問できない。子はハーネスの拡張だけを読み込み、ガード（commit・push・PR・マージの拒否など）と `subagent.md` の指示が効く
- 役割の指示は一時ファイルに書いて `--append-system-prompt` に渡す（pi はこの引数にファイルのパスを受ける）
- 表示：開始時に「⏳ サブエージェント（モデル）で<題名>を実行中」、終了時に「✅ <題名>が完了」または「❌ <題名>が失敗(理由)」。実行中の一覧はウィジェットにも出す
- 返す報告：全件の報告（役割・成否・ターン数・トークン・費用・最後の返答）を 1 つにまとめる。ツールの結果の `details` には子の結果（`ChildResult`）の配列を入れる
- 中断（Esc など）されたら、まだ起動していない依頼は子を起動せず、通知もせずに、中断の結果（`aborted: true`）として返す

### 上限

| 設定 | 既定 | 意味 |
| --- | --- | --- |
| `subagent.maxTasks` | 8 | 1 回の呼び出しで任せられる件数 |
| `subagent.maxConcurrency` | 4 | 読み取り専用の役割を同時に動かす数 |
| `subagent.timeoutSeconds` | 900 | 1 件あたりの時間切れ（SIGTERM、5 秒後に SIGKILL） |
| `subagent.maxTotal` | 64 | このセッションで起動できる合計 |

上限超過・未知の役割は、子を起動せずに断りのメッセージを返す（エラーにはしない）。`harness.json` で上書きできる（[setup/settings.md](../setup/settings.md)）。ツールの引数スキーマの `maxItems` も、拡張の読み込み時の `subagent.maxTasks` から作る。

`maxTotal` の判定に使う合計の件数（`Runtime.subagentSpawns`）は、`session_start`・`session_tree` で、セッションの枝（`sessionManager.getBranch()`）に残る `subagent` の結果と、`harness_review` の結果（`details.children`）から数え直す（純粋関数 `subagentTotals`。子の結果の配列の長さを足す）。再開・`/reload`・フォーク・ツリーの移動でも 0 に戻らない。新しいエントリは書き足さない。

## 役割

役割の定義は `<エージェントディレクトリ>/agents/*.md`（`PI_CODING_AGENT_DIR`、既定 `~/.pi/agent`。リポジトリの `agent/agents/` からリンクする）。先頭の `---` で囲んだ `name`・`description`・`tools`（カンマ区切り、任意）・`model`（任意）と、本文（役割の指示）。

| 役割 | 内容 | `tools` |
| --- | --- | --- |
| `scout` | 調査。関係するパス・依存・慣習・リスクを返す | `read, grep, find, ls`（読み取り専用） |
| `planner` | 計画。独立にテストできる単位への分割と完了条件を提案する | 同上 |
| `reviewer` | 独立レビュー。最終行に `<approved/>` か `<disapproved/>` を返す。メインが `harness_review` で、差分と要件だけを渡して呼ぶ（[harness-flow.md](harness-flow.md)） | 同上 |
| `worker` | 実装・検証 | 未指定（既定のツール。書き込み可） |

## 書き込み可の役割の直列化

worktree で隔離しないため、同じ作業ツリーに複数の子が同時に書き込むと衝突する。そこで、役割を次のように分ける（純粋関数 `isReadOnlyAgent`）。

- 読み取り専用：`tools` が指定されていて、その全部が `read`・`grep`・`find`・`ls` の中にある
- 書き込み可：それ以外（`tools` 未指定を含む）

1 回の呼び出しの中で、読み取り専用は `maxConcurrency` まで並列、書き込み可は 1 件ずつ渡した順に動かす（`runScheduled`）。読み取り専用の組と書き込み可の組は並行してよい。ツールの説明と `main.md` に、書き込み可の役割は 1 件ずつ動くこと・同じファイルを複数の依頼で編集させないことを書いている。

## 費用の集計

子の `message_end` の `usage.cost` を `ChildResult.usage` に集め、終了ごとに `Runtime.childCost`（サブエージェントの費用の合計）に足す。件数と同じく、`session_start`・`session_tree` でセッションの枝の `subagent` の結果（各要素の `usage.cost` の合計）から数え直す。`Runtime.childCost` は、要約（compaction）のハーネスの記録に使う（[harness-compaction.md](harness-compaction.md)）。フッターと `/usage` の表示は `Runtime.childCost` を使わず、`usage/children.ts` でセッションの全エントリ（捨てた分岐も含む）から、プロバイダーごとに数える（[usage.md](usage.md)）。

## 完了の合図との関係

`subagent` の実行で、書き込み可の役割の依頼が 1 件以上成功したときも、成果物を作る操作に数える（[harness-instructions.md](harness-instructions.md)）。

## 既知の制約

- 別プロセス方式は暫定（移植元でも同じ）
- 書き込み可の直列化は 1 回の呼び出しの中だけ。`subagent` ツールの呼び出し自体は順番に実行される（`executionMode: "sequential"`）ので、呼び出しをまたいで書き込み可が重なることはない。メインが同時に `edit` などで同じファイルを編集することは防がない（指示で、同じファイルを任せない分け方にする）
- 子のガードはメインと同じ拡張で、サブエージェントでは commit・push・PR・マージ・`git worktree` を拒否する。それ以外の書き込みは、作業ルートなどのガードの範囲で許される
- 役割の `model` を指定すると `/subagent-model` より優先する
- セッションの合計の件数と費用は、枝に残る `subagent` の結果の `details` から数え直す。断られた呼び出し（上限超過・未知の役割。`details` が無い）は数えない。ツールが例外で終わった呼び出しも `details` が残らないので、再開後は数えない
- `harness.json` の `subagent.maxTasks` を変えたら、引数スキーマの上限に反映するには `/reload` か再起動が要る（呼び出し時の件数の判定は、その時点の設定で行う）
