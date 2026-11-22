# フェーズ 2：固定の指示と完了の合図

## 概要

pi のグローバル指示を `agent/AGENTS.md`（コンテキストファイル）から、拡張がシステムプロンプトの `<harness>` セクションへ差し込む形に移す。完了の合図（最終行「🚀作業が完了しました！」）はモデルに書かせず、拡張が書き足す。

## 関連

- 移植元：`agent/extensions/harness/instructions/`（main.md・subagent.md・load・register）、`output/`（final-line・register）
- 移植元のテスト：`tests/final-line.test.ts`
- 決定：[002](../decisions/002-provider-neutral-instructions.md)
- 機能の仕様：[features/harness-instructions.md](../features/harness-instructions.md)
- 状態：完了（2026-11-23）

## タスク

- [x] `instructions/main.md`：今の `agent/AGENTS.md` の内容を土台に、移植元の main.md から、今あるものに関わる自律実行のルール（計画にない判断は既定で進めて「自分で判断したこと」に書く・ユーザーにしかできないことは保留して最後にまとめて依頼する）だけを取り入れた。PDCA の各ツールの使い方・サブエージェントへの任せ方・計画報告は、ツールを入れるフェーズ 3〜5 で足す。プロバイダーに依存しない書き方（決定 002）
- [x] `instructions/subagent.md`：サブエージェント用（任された作業だけ、commit や PR は親に任せる、質問できないので既定で進めて未解決点に書く）
- [x] `before_agent_start` で `systemPromptOptions.sections.harness` に差し込む（メインは main.md、サブエージェントは subagent.md）。ファイルは読み込み時に読み、読めなければ警告して差し込まない。移植元にあった `dropContextFiles` と役割ごとの指示（`composeInstructions`）は入れていない（フェーズ 3 で必要なら足す）
- [x] 完了の合図：`message_end` で、成果物を作る操作（`write`・`edit`、bash の `git commit`・`git push`・`gh pr create`）が成功したときの最終応答の末尾に「🚀作業が完了しました！」を書き足す。ツール呼び出しを含むメッセージ・エラー・中断・サブエージェントには付けない。計画の完了（`planCompleted`）はフェーズ 4、PR のツールはフェーズ 5 で条件に足す
- [x] `agent/AGENTS.md` を削除した（中身は main.md に移した）。`~/.pi/agent/AGENTS.md` のリンクはユーザーが削除する（[setup/linking.md](../setup/linking.md)）。完了の合図の節は main.md に入れていない
- [x] まだ無いツール（計画・検証・PR）に触れる記述は、そのツールを入れるフェーズで足す

## 完了条件

- [x] 指示が `<harness>` セクションで渡ることをテストで確かめる（`tests/harness-instructions.test.ts`）
- [x] 最終行が、完了した応答にだけ付く（`tests/harness-output.test.ts`）

## 注意

- フェーズ 4・5 で使うツールの説明は、そのフェーズで main.md に足す
