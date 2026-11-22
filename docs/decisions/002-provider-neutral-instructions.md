# 002: グローバル指示はプロバイダーに依存しない 1 本にする

- 日付: 2026-11-22
- 状態: 有効

## 背景

pi は Codex（OpenAI）・OpenCode Go・Anthropic API のモデルを切り替えて使う。Claude Code 用の指示（`~/.claude/CLAUDE.md`）は Agent ツール・AskUserQuestion・sonnet / opus などの Claude 固有の前提を含む。

## 決定

- pi のグローバル指示は 1 本にし、どのプロバイダーのモデルが読んでも通じる書き方にする
- 特定製品のツール名・モデル名・フックを前提にしない
- プロバイダーごとの追記を拡張で出し分ける案は採らない

## 理由

- 1 本なら管理が単純で、モデルを切り替えても挙動がそろう
- プロバイダーごとに書き分ける具体的な中身が今のところない

## 却下した案

- 共通の指示＋プロバイダー別の追記を拡張で差し込む案（ユーザーが共通 1 本を選択）

## 関連

- [features/global-instructions.md](../features/global-instructions.md)
- 取り込み後は指示を拡張の `<harness>` セクションへ移す：[plan/phase-2-instructions-output.md](../plan/phase-2-instructions-output.md)
