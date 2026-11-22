# フェーズ 2：固定の指示と完了の合図

## 概要

pi のグローバル指示を `agent/AGENTS.md`（コンテキストファイル）から、拡張がシステムプロンプトの `<harness>` セクションへ差し込む形に移す。完了の合図（最終行「🚀作業が完了しました！」）はモデルに書かせず、拡張が書き足す。

## 関連

- 移植元：`agent/extensions/harness/instructions/`（main.md・subagent.md・load・register）、`output/`（final-line・register）
- 移植元のテスト：`tests/final-line.test.ts`
- 決定：[002](../decisions/002-provider-neutral-instructions.md)
- 今の指示：[features/global-instructions.md](../features/global-instructions.md)
- 状態：未着手

## タスク

- [ ] `instructions/main.md`：今の `agent/AGENTS.md` の内容と、移植元の main.md（PDCA と各ツールの使い方、自律実行のルール、サブエージェントへの任せ方）を合わせる。プロバイダーに依存しない書き方にする（決定 002）
- [ ] `instructions/subagent.md`：サブエージェント用（任された作業だけ、commit や PR は親に任せる、質問できないので既定で進めて未解決点に書く）
- [ ] `before_agent_start` で `systemPromptOptions.sections.harness` に差し込む（メインは main.md、サブエージェントは subagent.md）
- [ ] 完了の合図：`message_end` で、成果物を作る操作をした（または計画が完了した）ときの最終応答の末尾に「🚀作業が完了しました！」を書き足す。ツール呼び出しを含むメッセージ・エラー・中断には付けない
- [ ] `agent/AGENTS.md` と `~/.pi/agent/AGENTS.md` のリンクを廃止する（中身は main.md に移したため）。`AGENTS.md` から完了の合図の指示を外す
- [ ] まだ無いツール（計画・検証・PR）に触れる記述は、そのツールを入れるフェーズで足す

## 完了条件

- 指示が `<harness>` セクションで渡ることをテストで確かめる
- 最終行が、完了した応答にだけ付く（テスト）

## 注意

- フェーズ 4・5 で使うツールの説明は、そのフェーズで main.md に足す
