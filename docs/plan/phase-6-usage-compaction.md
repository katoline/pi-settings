# フェーズ 6：利用状況の統合と要約（compaction）

## 概要

`usage` 拡張をハーネスに統合し、サブエージェントの費用も合算する。要約（compaction）を日本語にし、作業の状態を確実に引き継ぐ。

## 関連

- 移植元：`agent/extensions/harness/usage/`（parse・register）、`compaction/`（prompt・register）
- 移植元のテスト：`tests/{usage,compaction}.test.ts`
- 決定：[009](../decisions/009-anthropic-usage-session-cost.md)
- 今の実装：[features/usage.md](../features/usage.md)
- 状態：未着手

## タスク

- [ ] `usage` をハーネスに移す。Codex の窓の判定（`limit_window_seconds`）など、今の実装の振る舞いを保つ
- [ ] Anthropic のセッション使用額（実装済み）に、サブエージェントの費用（フェーズ 3）を足す。集計は `Runtime.childCost`（フェーズ 3 で実装済み。サブエージェントの終了ごとに費用を足している）を使う
- [ ] 要約：`session_before_compact` で日本語の要約に置き換える。必ず残す 5 項目（変更ファイルと検証の有無・検証の結果・PR・サブエージェントの状態・決定事項と判断待ち）
- [ ] 要約の末尾に、ハーネスの記録（計画・検証・レビュー・PR）をモデルを通さずそのまま付ける
- [ ] 要約用のモデルを設定（`compactionModel`）で選べるようにする。空なら今のモデル

## 完了条件

- パーサーと要約プロンプトのテストが通る
- 今の `usage` のテストが同じ結果になる
