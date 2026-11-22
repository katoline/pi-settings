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

## pi が書き換える場面

- `/model` やモデルの切り替え：`defaultProvider` / `defaultModel`（pi 1.5.2 の `agent-session.js` で確認）
- pi を更新した後の初回起動：`lastChangelogVersion`
- `/settings` で変えた設定

pi はロックを取ってから `writeFileSync` でリンク先に書き込む（`settings-manager.js` で確認）。リンクは壊れない。ロックファイルは `~/.pi/agent` 側にできる。

## 足す予定

- `enabledModels`（使えるモデルを Go・Anthropic の 4 モデル・Codex に絞る）：[plan/phase-3-models-subagents.md](../plan/phase-3-models-subagents.md)
