# settings.json

## 概要

pi のユーザー設定。`agent/settings.json` に置き、`~/.pi/agent/settings.json` からリンクしている。pi 自身も書き換えるので、差分が出たらコミットするか戻す。

## 関連

- 決定：[008](../decisions/008-link-settings-json.md)
- pi の設定の一覧：pi 同梱の `docs/settings.md`（`~/.pi/agent/install/releases/<版>/node_modules/@earendil-works/pi-coding-agent/docs/settings.md`）

## 今のキー

| キー | 値 | 意味 |
| --- | --- | --- |
| `lastChangelogVersion` | `1.5.2` | 最後に変更履歴を表示した pi の版（pi が書く） |
| `defaultProvider` | `opencode-go` | 起動時のプロバイダー（モデルを切り替えると pi が書き換える） |
| `defaultModel` | `deepseek-v4.1-flash` | 起動時のモデル（同上） |
| `enabledModels` | `opencode-go/*`・Anthropic の 4 モデル（`claude-opus-5-5`・`claude-sonnet-5-5`・`claude-fable-5-2`・`claude-haiku-5-5`）・`openai-codex/*` | pi の `/model` などで選べるモデルを、Go・Anthropic の 4 モデル・Codex に絞る。ハーネスの `/models` はこれと別に、認証が済んだモデルを 3 グループに分けて出す（[features/harness-models-subagents.md](../features/harness-models-subagents.md)） |

## pi が書き換える場面

- `/model` やモデルの切り替え：`defaultProvider` / `defaultModel`（pi 1.5.2 の `agent-session.js` で確認）
- pi を更新した後の初回起動：`lastChangelogVersion`
- `/settings` で変えた設定

pi はロックを取ってから `writeFileSync` でリンク先に書き込む（`settings-manager.js` で確認）。リンクは壊れない。ロックファイルは `~/.pi/agent` 側にできる。

## ハーネスの設定（harness.json）

`settings.json` とは別に、ハーネスの設定を `~/.pi/agent/harness.json`（`PI_CODING_AGENT_DIR` の下）で上書きできる。フェーズ 3 で足したキー：

| キー | 既定 | 意味 |
| --- | --- | --- |
| `selectModelOnStartup` | `false` | 起動時にメインのモデルを選ぶダイアログを出す。確認ダイアログを増やさないため既定は無効（`/models` で選ぶ） |
| `subagent.maxTasks` | 8 | 1 回の呼び出しで任せられる件数（`subagent` ツールの引数スキーマの上限もこの値から作る） |
| `subagent.maxConcurrency` | 4 | 読み取り専用の役割を同時に動かす数 |
| `subagent.timeoutSeconds` | 900 | 1 件あたりの時間切れ |
| `subagent.maxTotal` | 64 | このセッションで起動できる合計（再開・`/reload`・フォークでも、セッションの枝に残る結果から数え直す） |

フェーズ 4 で足したキー（計画・自律ループの上限。[features/harness-flow.md](../features/harness-flow.md)）：

| キー | 既定 | 意味 |
| --- | --- | --- |
| `flow.maxCyclesPerItem` | 3 | 項目ごとの差し戻し（検証の失敗・レビューの却下）の上限（累計の回数。中断と判定なしは数えない）。達した項目は自動で「未完了」 |
| `flow.maxContinuations` | 200 | 自律ループの自動の継続の上限（回） |
| `flow.maxMinutes` | 240 | 計画の確定（再開）からの時間の上限（分） |
| `flow.maxNoProgress` | 3 | 進捗がないまま続けてよい回数 |

キルスイッチは設定ではなく、ファイル `~/.pi/agent/harness-off`（`PI_CODING_AGENT_DIR` の下）。ある間は自律ループが継続しない。

フェーズ 6 で足したキー（[features/harness-compaction.md](../features/harness-compaction.md)）：

| キー | 既定 | 意味 |
| --- | --- | --- |
| `compactionModel` | `""` | 要約（compaction）に使うモデル（`provider/id`、例 `opencode-go/deepseek-v4.1-flash`）。空なら今のモデル。`provider/id` の形でない文字列・文字列でない値は無視して既定（空） |

型が違う値（boolean でない・正の整数でない）は無視して既定を使う。`subagent`・`flow` は、キーごとに正の整数だけ採用する。
