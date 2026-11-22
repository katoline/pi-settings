# pi-settings

Pi coding agent の個人設定と拡張を置くリポジトリです。`agent/` は Pi のエージェントディレクトリ `~/.pi/agent` と同じ構成にしてあり、中身を `~/.pi/agent` 配下へシンボリックリンクして使います。いま張っているのは `AGENTS.md` だけで、拡張のリンクはまだ張っていません。

## 利用状況

`agent/extensions/usage` がフッターに次を出します。

| プロバイダー | 表示 |
| --- | --- |
| Codex | 5時間・週間の使用率 |
| OpenCode Go | 5時間・週間・月間の使用率 |

`%` は各 API が返す使用率です。`/usage` でリセットまでの時間と取得できなかった理由を見られます。

Codex の 5時間枠は `limit_window_seconds = 18000`、週間枠は `604800` で判定します。その枠がないプランでは、代わりに返ってきた枠（例: 30日）を出します。

### 認証

Pi に保存された資格情報は Pi の `getProviderAuth` 経由で取得するため、OAuth の期限が近いと Pi 自身が通常どおり更新します。Pi 以外（`~/.codex/auth.json`、`OPENCODE_API_KEY`）は読み取るだけで、更新しません。

- Codex: Pi の `openai-codex`、なければ `$CODEX_HOME/auth.json` または `~/.codex/auth.json`
- OpenCode Go: Pi の `opencode-go`、なければ `OPENCODE_API_KEY`

## /exit

`agent/extensions/exit` は `/quit` と同じ終了処理を `/exit` でも呼べるようにします。エージェントの実行中は、終わってから終了します。

## 指示ファイル

| ファイル | 効く範囲 |
| --- | --- |
| `agent/AGENTS.md` | Pi のグローバル指示。`~/.pi/agent/AGENTS.md` からシンボリックリンクで参照し、どのディレクトリで Pi を使っても読み込まれる |
| `AGENTS.md`（`CLAUDE.md` はこれへのリンク） | このリポジトリで作業するときだけの指示 |

グローバル指示は次のリンクで有効にしています（張り済み）。編集後は Pi で `/reload` すると反映されます。

```sh
ln -s /Users/peipou/Dev/hobby/katoline-org/pi-settings/agent/AGENTS.md ~/.pi/agent/AGENTS.md
```

## あとから有効にする

```sh
mkdir -p ~/.pi/agent/extensions
ln -s /Users/peipou/Dev/hobby/katoline-org/pi-settings/agent/extensions/usage ~/.pi/agent/extensions/usage
ln -s /Users/peipou/Dev/hobby/katoline-org/pi-settings/agent/extensions/exit ~/.pi/agent/extensions/exit
```

Pi を開き直すか `/reload` すると読み込まれます。
