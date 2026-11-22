# フェーズ 4：計画・自律ループ・検証・独立レビュー・完了報告

## 概要

合意した計画を、質問せずに最後まで進める仕組みを入れる。「完了」はモデルの申告ではなく、検証とレビューの記録で判定する。

## 関連

- 移植元：`agent/extensions/harness/flow/`（plan・loop・verify・review・report・fingerprint・register）
- 移植元のテスト：`tests/{plan,verify}.test.ts`、`tests/e2e.test.ts` の場面 1
- 決定：[006](../decisions/006-plan-confirm-dialog.md)
- 状態：未着手

## タスク

- [ ] `ask_user`：計画の段階でユーザーに質問する。計画が確定したらツール一覧から外す（`setActiveTools`）
- [ ] `plan_propose`：完了条件つきのチェックリストを出し、「確定 / 修正 / 中止」をダイアログで選ばせる（決定 006）
- [ ] `plan_update` / `plan_note` / `plan_status` / `plan_report`、`/plan`（状況・`resume`・`stop`）
- [ ] 完了のゲート：根拠があり、変更を伴う項目は検証が成功し、レビュー必須の項目は承認済みで、そのときの作業ツリーの指紋（全ファイル内容のハッシュ）が今と一致するときだけ完了にできる
- [ ] 差し戻し：検証の失敗・レビューの却下が 3 回続いた項目は自動で「未完了」にして他を進める
- [ ] 自律ループ：`agent_before_settle` で、未完了の項目がある間は継続させる。止まる条件は完了・Esc・キルスイッチ（`~/.pi/agent/harness-off`）・継続 200 回・240 分・進捗なし 3 回
- [ ] 計画の状態をセッションに保存（`appendEntry`）し、毎回システムプロンプトに載せる
- [ ] `harness_verify`：検証コマンドを `.harness/verify.json` → `package.json` の `check` → `lint`・`typecheck`・`test`・`build` の順に探して実行する。無ければ「未検証」
- [ ] `harness_review`：サブエージェントの reviewer に差分と要件だけを渡す。最終行の `<approved/>` / `<disapproved/>` で判定し、無ければ承認としない
- [ ] 完了報告（`plan_report`）を状態から自動で組み立てる：要件ごとの結果・検証・レビュー・PR・自分で判断したこと・ユーザーへの依頼
- [ ] 指示（main.md）から、`pi --print` を使う独立レビューの手順を外し、`harness_review` に置き換える

## 完了条件

- 移植元の plan / verify のテストと、ループの e2e が通る
- 計画を確定したあとは `ask_user` が無い

## 注意

- 上限値は移植元では固定（設定で変えられない）。必要なら設定に出すかを決める
