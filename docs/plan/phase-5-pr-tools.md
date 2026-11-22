# フェーズ 5：PR の作成・依頼ゲートつきマージ

## 概要

git と GitHub への書き込みを専用ツールにまとめる。PR は確認なしで作り、マージはユーザーが依頼したときだけ確認して行う。

## 関連

- 移植元：`agent/extensions/harness/flow/`（pr・git-tools）
- 移植元のテスト：`tests/{pr,git-tools}.test.ts`
- 決定：[003](../decisions/003-auto-pr-and-merge-policy.md)、[007](../decisions/007-no-auto-branch-protection.md)、[011](../decisions/011-no-worktree.md)（移植元の `harness_worktree` は取り込まない）
- 今の実装：[features/pr-skill.md](../features/pr-skill.md)、[features/harness-guards.md](../features/harness-guards.md)
- 状態：未着手

## タスク

- [ ] `harness_pr_create`：push して PR を作成・更新する（確認なし）。既定ブランチ上・未コミットの変更があるときは拒否。本文は「概要・変更点・確認方法（検証結果）」の固定の形
- [ ] ブランチ保護：PR 作成の前に既定ブランチが保護されているかを確かめるが、作らない。未保護ならツールの結果と完了報告で知らせて先へ進む（決定 007）
- [ ] `harness_pr_merge`：ユーザーの入力に「マージ」「merge」がある実行でだけツール一覧に出す（`setActiveTools`）。実行時に確認ダイアログを出し、許可されたらマージする。移植元のゲート（CI 成功・検証が最新・レビュー承認・未着手の項目なし）も残す。方式は merge commit
- [ ] bash からの `gh pr merge` と `gh api` でのマージは常に拒否し、`harness_pr_merge` へ誘導する（フェーズ 1 の暫定の依頼ゲートを置き換える）
- [ ] bash からの `gh pr create` / `gh pr edit` を拒否し、`harness_pr_create` へ誘導する
- [ ] `pr` スキル（`agent/skills/pr/`）を削除し、指示（main.md）の PR 手順を専用ツールに置き換える

- [ ] PR の記録：`harness_pr_create`・`harness_pr_merge` が、計画の状態の `plan.prs`（`recordPr`。`flow/plan.ts` に型と関数は用意済み）に番号・URL・題名・マージ済みかを記録する。完了報告（`plan_report`、`flow/report.ts`）の「PR」の欄は、`plan.prs` に記録があるときだけ出す作りになっているので、記録を入れれば埋まる
- [ ] 計画のツールの説明・継続のメッセージ・`main.md` の PR の手順を、PR のツールに合わせる（フェーズ 4 では `pr` スキルで作る前提で、PR のツールには触れていない）

## 完了条件

- 依頼の無い実行では `harness_pr_merge` が見えず、依頼のある実行でだけ確認ダイアログが出る（テスト）
- 実際の git と bare の origin を使うテストで、PR 作成の拒否条件が働く

## 注意

- 実際の GitHub での動作（PR の作成・マージ）は、ユーザーが実機で確かめる
