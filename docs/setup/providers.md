# プロバイダーと認証

## 概要

pi で使う 3 つのプロバイダーの認証方法と、利用状況の取得元。認証情報（`~/.pi/agent/auth.json` など）はリポジトリに置かない。

## 関連

- [features/usage.md](../features/usage.md)
- 決定：[009](../decisions/009-anthropic-usage-session-cost.md)

## 一覧

| プロバイダー | pi の ID | 認証 | 利用状況 |
| --- | --- | --- | --- |
| Codex（ChatGPT Plus / Pro） | `openai-codex` | pi の `/login openai-codex`（OAuth）。無ければ `$CODEX_HOME/auth.json` / `~/.codex/auth.json` を読む | 5 時間・週の使用率（`wham/usage`、非公式） |
| OpenCode Go（サブスク） | `opencode-go` | pi に保存したキー、または環境変数 `OPENCODE_API_KEY` | 5 時間・週・月の使用率（`zen/go/v1/usage`、非公式） |
| Anthropic API | `anthropic` | API キー | この pi セッションの使用額（pi の見積もり） |

## 注意

- Codex の使用率は、pi 1.x の `/login openai`（ChatGPT でサインイン）のトークンでは取得できない。`/login openai-codex` を使う（取り込み元の調査による。未確認）
- OpenCode Go で使える Claude は Haiku 5.5 だけ。Opus・Sonnet・Fable は Anthropic API で使う（取り込み元の調査による）
- Claude Pro / Max のサブスクは、pi のような第三者のハーネスでは従量課金（extra usage）になるため、Anthropic は API キーで使う（取り込み元の調査による）
- Anthropic の残高を取る API は無い。アカウント全体の使用額（Usage and Cost Analytics API）は Admin API キーが必要で、個人の Console アカウントでは使えない（2026-11-22 に公式ドキュメントで確認）
- 今の既定のモデルは OpenCode Go の `deepseek-v4.1-flash`（[settings.md](settings.md)）
