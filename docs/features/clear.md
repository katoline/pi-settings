# /clear

## 概要

会話を空にして、新しいセッションを始める（Claude Code・Codex の `/clear` と同じ使い方）。組み込みの `/new` と同じ動きで、これまでのセッションは `/resume` で開き直せる。

## 関連

- コード：`agent/extensions/clear/index.ts`
- テスト：`tests/clear.test.ts`、`tests/harness-e2e-install.test.ts`（登録の確認）

## 挙動と処理

- `pi.registerCommand("clear")` で登録し、`ctx.waitForIdle()` で実行中のターンの終了を待ってから `ctx.newSession()` を呼ぶ
- 拡張が新しいセッションを取り消した（`cancelled`）ときは、警告で通知する
- 起動時のモデル選択（`selectModelOnStartup`）が有効なら、`/new` と同じく `/clear` のあとも選択ダイアログが出る（[harness-models-subagents.md](harness-models-subagents.md)）
