# 011: pi では worktree を使わない

- 日付: 2026-11-23
- 状態: 有効

## 背景

グローバル指示（`agent/AGENTS.md`）には、同じリポジトリで他の作業が進行中なら pi が `git worktree add` で専用の worktree を作って作業する、という節があった。取り込み計画のフェーズ 5 にも、移植元の `harness_worktree`（worktree を作ってサブエージェントに渡す）を入れる予定があった。

一方で pi 1.5.2 には worktree の機能が無く、bash ツールは毎回 pi を起動したディレクトリでコマンドを実行する（`cd` は次のコマンドに引き継がれない。`dist/core/tools/bash.js` で確認）。セッションの中で worktree に移って作業するには、毎回 `cd <worktree> && …` と絶対パスを書く必要があり、書き忘れると元のチェックアウトを触る。

## 決定

- pi では worktree で作業しない。グローバル指示から「作業用worktree」節を削除した
- 取り込み計画から `harness_worktree` を外す（フェーズ 5）
- ガードの `git worktree` の判定（`remove --force`・相対パス・`prune` を止める）は事故防止としてそのまま残す。移植元の「ハーネスが作った worktree だけ削除できる」所有チェックは入れない

## 理由

- pi では並行して複数の作業をしない（ユーザーの判断）
- セッションの中で worktree を使うと、元のチェックアウトを触る事故が起きやすい

## 却下した案

- worktree ごとに pi を起動して並行作業する案：並行作業をしないので不要
- フェーズ 5 で `harness_worktree` を入れ、サブエージェントの並行書き込みを隔離する案：同上。書き込みのできるサブエージェントは同時に 1 件にするか、同じファイルを編集しない分け方にする（フェーズ 3）

## 関連

- [features/global-instructions.md](../features/global-instructions.md)
- [plan/phase-3-models-subagents.md](../plan/phase-3-models-subagents.md)、[plan/phase-5-pr-tools.md](../plan/phase-5-pr-tools.md)
