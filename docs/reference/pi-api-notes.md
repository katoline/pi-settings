# pi 1.5.2 の API の要点

## 概要

このリポジトリで使う、または使う予定の pi の API と挙動。出典は pi 同梱のドキュメント（`~/.pi/agent/install/releases/1.5.2/node_modules/@earendil-works/pi-coding-agent/docs/`）と、必要に応じて `dist/` のコード。

## 関連

- [plan/](../plan/README.md)

## 置き場所と読み込み

- エージェントディレクトリは `~/.pi/agent`（環境変数 `PI_CODING_AGENT_DIR` で変えられる）
- 指示ファイル：`<agent-dir>/AGENTS.md`（または `CLAUDE.md` など）がどこでも読まれる。加えて作業ディレクトリとその親の `AGENTS.md` / `CLAUDE.md` も読まれる。`-nc` で無効
- `<agent-dir>/SYSTEM.md` はシステムプロンプトを置き換え、`APPEND_SYSTEM.md` は追記する
- 拡張：`<agent-dir>/extensions/*.ts`、`*/index.ts`、`*/package.json`（`pi.extensions`）を自動で読む。1 階層だけ
- スキル：`<agent-dir>/skills/` 配下の `SKILL.md` を再帰的に探す。frontmatter の `name` と `description` で、モデルが必要なときに読む。`/skill:<名前>` で強制できる
- pi にはサブエージェントとプランモードが組み込まれていない（拡張で作る）

## 拡張のイベント（使っているもの・使う予定のもの）

| イベント | 用途 | 要点 |
| --- | --- | --- |
| `tool_call` | ガード | 実行前に呼ばれる。`{ block: true, reason }` で止める。`event.input` を書き換えられる。**フックが例外を投げるとツールは実行される**ので、判定は try/catch で拒否に倒す |
| `tool_result` | 出力の秘匿 | ツールの結果を書き換えられる |
| `input` | マージ依頼の判定 | ユーザーの生の入力（`/skill:…` の展開前）。`event.source`（`interactive` / `rpc` / `extension`）、`event.streamingBehavior`（待機中は `undefined`） |
| `user_bash` | — | ユーザーが `!` で実行するコマンド。`tool_call` は通らない（決定 005 の前提。実装時に確認） |
| `before_agent_start` | 固定の指示 | `systemPromptOptions.sections.<名前>` に名前つきセクションを差し込める |
| `agent_before_settle` | 自律ループ | 止まる直前に呼ばれ、継続を要求できる |
| `message_end` | 完了の合図・使用額 | 確定したメッセージ。書き換えられる |
| `session_before_compact` | 要約 | 要約を差し替えられる |
| `session_start` / `model_select` / `agent_end` | 状態の更新 | `session_start` の `reason` は `startup` / `reload` / `new` / `resume` / `fork` |

## 拡張の API

- `pi.registerCommand`・`pi.registerTool`・`pi.registerShortcut`・`pi.setActiveTools` / `pi.getActiveTools`・`pi.appendEntry`・`pi.exec(cmd, args, { cwd, timeout })`
- `ctx.ui.confirm` / `select` / `input`（ダイアログ）、`ctx.ui.notify`・`setStatus`・`setWidget`・`setEditorText` / `getEditorText` / `pasteToEditor`
- `ctx.hasUI`：TUI と RPC では true、`--print` と JSON モードでは false
- `ctx.model`・`ctx.modelRegistry`（`getProviderAuth`・`complete`・`streamSimple`）・`ctx.sessionManager`（`getBranch()`）

## CLI

- `pi --print`（`-p`）・`--mode json`・`--no-session`・`--tools <一覧>`（例：`read,grep,find,ls` で読み取り専用）・`--no-extensions`・`-e <拡張>`・`--model`・`--append-system-prompt`
- `pi --help` は読み込んだ拡張のオプションも表示する（拡張の読み込みエラーの簡易確認に使える）

## 設定ファイルの書き込み

- `settings.json` はロック（`proper-lockfile`、`realpath: false`）を取ってから `writeFileSync` で書く。シンボリックリンクならリンク先が更新される
- モデルを切り替えると `defaultProvider` / `defaultModel` が書き換わる
