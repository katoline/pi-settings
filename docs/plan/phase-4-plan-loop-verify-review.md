# フェーズ 4：計画・自律ループ・検証・独立レビュー・完了報告

## 概要

合意した計画を、質問せずに最後まで進める仕組みを入れる。「完了」はモデルの申告ではなく、検証とレビューの記録で判定する。

## 関連

- 移植元：`agent/extensions/harness/flow/`（plan・loop・verify・review・report・fingerprint・register）
- 移植元のテスト：`tests/{plan,verify}.test.ts`、`tests/e2e.test.ts` の場面 1
- 決定：[006](../decisions/006-plan-confirm-dialog.md)
- 状態：完了（2026-11-23）
- 機能の仕様：[features/harness-flow.md](../features/harness-flow.md)

## タスク

- [x] `ask_user`：計画の段階でユーザーに質問する。計画が確定したらツール一覧から外す（`setActiveTools`）
- [x] `plan_propose`：完了条件つきのチェックリストを出し、「確定 / 修正 / 中止」をダイアログで選ばせる（決定 006）
- [x] `plan_update` / `plan_note` / `plan_status` / `plan_report`、`/plan`（状況・`resume`・`stop`・`clear`）
- [x] 完了のゲート：根拠があり、変更を伴う項目は検証が成功し、レビュー必須の項目は承認済みで、そのときの作業ツリーの指紋（全ファイル内容のハッシュ）が今と一致するときだけ完了にできる
- [x] 差し戻し：検証の失敗・レビューの却下が累計 3 回に達した項目は自動で「未完了」にして他を進める（中断・判定なしは数えない）
- [x] 自律ループ：`agent_before_settle` で、未完了の項目がある間は継続させる。止まる条件は完了・Esc・エラーでの終了・キルスイッチ（`~/.pi/agent/harness-off`）・継続 200 回・240 分・進捗なし 3 回
- [x] 計画の状態をセッションに保存（`appendEntry`）し、依頼の開始時にメッセージとして渡す（システムプロンプトには載せない。プロンプトキャッシュを崩さないため。`before_agent_start` の戻り値の `message`、`display: false`）
- [x] `harness_verify`：検証コマンドを `.harness/verify.json` → `package.json` の `check` → `lint`・`typecheck`・`test`・`build` の順に探して実行する。無ければ「未検証」。`verify.json` が無く、追跡済みの `flake.nix` と `nix` があれば `nix develop -c` で実行する
- [x] `harness_review`：サブエージェントの reviewer に差分と要件だけを渡す。最終行の `<approved/>` / `<disapproved/>` で判定し、無ければ承認としない
- [x] 完了報告（`plan_report`）を状態から自動で組み立てる：要件ごとの結果・検証・レビュー・PR・自分で判断したこと・ユーザーへの依頼
- [x] 指示（main.md）から、`pi --print` を使う独立レビューの手順を外し、`harness_review` に置き換える

## 完了条件

- 移植元の plan / verify のテストと、ループの e2e が通る
- 計画を確定したあとは `ask_user` が無い

## 注意

- 上限値は移植元では固定だったが、`config.default.json` の `flow`（`maxCyclesPerItem`・`maxContinuations`・`maxMinutes`・`maxNoProgress`）に出し、`harness.json` で上書きできる（[setup/settings.md](../setup/settings.md)）
- 移植元との違い：計画の状態はシステムプロンプトに載せない／PR のツールと `plan.prs` への記録は持ち込まない（フェーズ 5）／worktree に関わるものは持ち込まない／`/plan resume` は継続の回数と経過時間の起点も戻す／レビューの判定は最終行のマーカー
- `harness_review` の子の件数・費用は、結果の `details.children` から数え直す（`subagentTotals`）
