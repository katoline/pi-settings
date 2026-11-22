/**
 * 統合テスト（フェーズ 4）: 実際の Pi(node_modules の 1.5.2)を RPC モードで起動し、偽のモデルにつないで、
 * 計画・自律ループ・検証・独立レビュー・完了報告を通しで確かめる。仕組みは harness-e2e-helpers.ts。
 *
 * 場面 1: 拡張の読み込み、ガードによる拒否、計画の確定（ダイアログは UI 応答で確定）、自律ループの継続、
 *         確定後の ask_user の除去、完了報告、最終行の付与。
 * 場面 1b: キルスイッチでは継続せず、次の依頼で、計画の状態がシステムプロンプトではなく、メッセージとして
 *          モデルに届くこと。
 * 場面 1c: 変更を伴う項目が、検証・レビュー（reviewer の子プロセス）を通って完了になること。
 * ネットワークは使わない。
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { FINAL_LINE } from "../agent/extensions/harness/output/final-line.ts";
import { resultsOf, type Step, scenario, scenarioIn } from "./harness-e2e-helpers.ts";

const confirmPlan = (title: string) => (title.includes("計画の確認") ? "確定する" : null);

test("実際の Pi で、ガード・計画・自律ループ・最終行が動く", { timeout: 120_000 }, async () => {
  const steps: Step[] = [
    { tool: "bash", args: { command: "git push --force origin main" } }, // 0: ガードが拒否する
    {
      tool: "plan_propose",
      args: {
        goal: "テスト",
        items: [{ id: "1", title: "調査", acceptance: "README を確認した", kind: "task" }],
      },
    }, // 1: ユーザーが確定する
    { tool: "plan_update", args: { id: "1", status: "in_progress" } }, // 2
    { text: "着手しました" }, // 3: 未完了なので、ハーネスが継続を要求する
    { tool: "plan_update", args: { id: "1", status: "done", evidence: "README.md:1" } }, // 4
    { text: "全部終わりました" }, // 5: 完了報告を促す継続
    { tool: "plan_report", args: {} }, // 6
    { text: "報告します" }, // 7: 最終応答。最終行が付く
  ];
  const o = await scenario("flow-loop", steps, "作業してください", { answer: confirmPlan });
  const { requests, assistantTexts } = o;

  // 1. ガード: force push は、実行されずに拒否される(理由がモデルに返る)
  const bash = resultsOf(o, "bash")[0];
  assert.ok(bash, "bash の結果があるはず");
  assert.equal(bash.isError, true);
  assert.match(bash.text, /force push は禁止/);

  // 2. 計画: ユーザーに確認し、確定する
  assert.ok(o.uiTitles.some((t) => t.includes("計画の確認")));
  assert.match(resultsOf(o, "plan_propose")[0]?.text ?? "", /計画が確定しました/);

  // 3. 自律ループ: 未完了のまま応答が終わっても、ハーネスが継続を要求する(ユーザーの入力なしで)
  assert.ok(
    requests[4]?.messages.includes("確定した計画は、まだ完了していません"),
    "継続のメッセージがモデルに渡る",
  );
  assert.ok(requests[4]?.messages.includes("次に取り組む項目: 1"));

  // 4. 確定後は ask_user が使えない。確定前は使える
  assert.ok(requests[0]?.tools.includes("ask_user"), "確定前は ask_user がある");
  assert.ok(!requests[4]?.tools.includes("ask_user"), "確定後は ask_user を外す");
  for (const tool of [
    "plan_propose",
    "plan_update",
    "plan_note",
    "plan_status",
    "plan_report",
    "harness_verify",
    "harness_review",
    "subagent",
  ]) {
    assert.ok(requests[0]?.tools.includes(tool), tool);
  }
  // PR の作成のツールはある。マージのツールは、依頼が無い実行では出ない。worktree のツールは持たない
  assert.ok(requests[0]?.tools.includes("harness_pr_create"));
  assert.ok(!requests[0]?.tools.includes("harness_pr_merge"));
  assert.ok(!requests[0]?.tools.includes("harness_worktree"));

  // 5. 完了: すべての項目が済んだら、完了報告を促し、固定の形の報告を作る
  assert.ok(
    requests[6]?.messages.includes("完了報告") || requests[6]?.messages.includes("plan_report"),
  );
  const report = resultsOf(o, "plan_report")[0]?.text ?? "";
  for (const s of ["完了報告", "要件ごとの結果", "根拠: README.md:1", "未検証"])
    assert.ok(report.includes(s), s);
  assert.ok(!report.includes("## PR"), "PR の記録が無ければ、PR の欄は出さない");

  // 6. 最終応答の最後の 1 行が、完了の 1 行になる。途中の応答には付かない
  const last = assistantTexts.filter((t) => t.trim()).at(-1) ?? "";
  assert.equal(last.trimEnd().split("\n").at(-1), FINAL_LINE);
  assert.ok(last.startsWith("報告します"));
  assert.ok(!assistantTexts[3]?.includes(FINAL_LINE));
});

test("実際の Pi で、キルスイッチでは継続せず、計画の状態はメッセージとして次の依頼に届く（システムプロンプトには載らない）", {
  timeout: 120_000,
}, async () => {
  const steps: Step[] = [
    {
      tool: "plan_propose",
      args: {
        goal: "テスト",
        items: [{ id: "1", title: "調査", acceptance: "README を確認した", kind: "task" }],
      },
    }, // 0: 1 つ目の依頼。ユーザーが確定する
    { text: "確定しました" }, // 1: キルスイッチがあるので、継続されずに終わる
    { text: "続きです" }, // 2: 2 つ目の依頼
  ];
  const o = await scenario("flow-state", steps, "計画を立ててください", {
    prompts: ["計画を立ててください", "続けてください"],
    answer: confirmPlan,
    // キルスイッチ（<エージェントディレクトリ>/harness-off）
    prepare: ({ agentDir }) => writeFileSync(path.join(agentDir, "harness-off"), ""),
  });
  const { requests } = o;

  // キルスイッチ: 未完了の計画があっても、ハーネスは継続を要求しない（リクエストは 3 回だけ）
  assert.equal(requests.length, 3);
  assert.ok(!requests.some((r) => r.messages.includes("確定した計画は、まだ完了していません")));
  // 確定後は ask_user が外れる。キルスイッチで止めた計画は一時停止になり、次の依頼では ask_user が戻る
  assert.ok(requests[0]?.tools.includes("ask_user"));
  assert.ok(!requests[1]?.tools.includes("ask_user"));
  assert.ok(requests[2]?.tools.includes("ask_user"));
  assert.ok(requests[2]?.messages.includes("一時停止中: キルスイッチ"));

  // 計画の状態: 次の依頼で、メッセージとしてモデルに届く。システムプロンプトには載らない
  const marker = "確定済みの計画(状態)";
  assert.ok(!requests[0]?.messages.includes(marker), "確定前には届かない");
  assert.ok(requests[2]?.messages.includes(marker), "次の依頼で、計画の状態がモデルに届く");
  assert.ok(requests[2]?.messages.includes("[ ] 1: 調査"));
  assert.ok(!requests[2]?.system.includes(marker), "システムプロンプトには載らない");
  assert.ok(!requests[2]?.system.includes("[ ] 1: 調査"));
  // システムプロンプトは、依頼のあいだで変わらない（プロンプトキャッシュを崩さない）
  assert.ok(requests[0]?.system.includes("ハーネスの固定の指示"));
  assert.equal(requests[2]?.system, requests[1]?.system);

  // 未完了のまま終わった応答には、完了の合図は付かない
  assert.ok(!o.assistantTexts.some((t) => t.includes(FINAL_LINE)));
});

test("実際の Pi で、変更を伴う項目は、検証とレビュー（reviewer の子プロセス）を通って完了になる", {
  timeout: 120_000,
}, async () => {
  const git = (cwd: string, ...args: string[]) =>
    execFileSync("git", ["-c", "commit.gpgsign=false", ...args], { cwd, stdio: "pipe" });
  const steps: Step[] = [
    {
      tool: "plan_propose",
      args: {
        goal: "メモを作る",
        items: [
          {
            id: "1",
            title: "メモの作成",
            acceptance: "memo.txt がある",
            kind: "change",
            review: true,
          },
        ],
      },
    }, // 0
    { tool: "plan_update", args: { id: "1", status: "in_progress" } }, // 1
    { tool: "write", args: { path: "memo.txt", content: "メモ\n" } }, // 2
    { tool: "plan_update", args: { id: "1", status: "done", evidence: "memo.txt:1" } }, // 3: 検証前なので断られる
    { tool: "harness_verify", args: {} }, // 4
    { tool: "harness_review", args: {} }, // 5: 親が呼ぶ
    { text: "memo.txt を追加しています。問題ありません。\n<approved/>" }, // 6: 子(reviewer)の応答
    { tool: "plan_update", args: { id: "1", status: "done", evidence: "memo.txt:1" } }, // 7
    { tool: "plan_report", args: {} }, // 8
    { text: "完了しました" }, // 9
  ];
  const { outcome: o } = await scenarioIn("flow-verify-review", steps, "メモを作ってください", {
    answer: confirmPlan,
    prepare: ({ cwd }) => {
      git(cwd, "init", "-q");
      // 既定ブランチ上ではガードがファイルの変更を止めるので、作業ブランチにする
      git(cwd, "checkout", "-q", "-b", "feat/memo");
      writeFileSync(path.join(cwd, "README.md"), "# w\n");
      mkdirSync(path.join(cwd, ".harness"));
      writeFileSync(path.join(cwd, ".harness/verify.json"), '{"commands":["true"]}');
      git(cwd, "add", ".");
      git(cwd, "-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "-q", "-m", "init");
    },
  });
  const { requests } = o;

  // 検証前の完了は、ゲートが断る
  const updates = resultsOf(o, "plan_update");
  assert.match(updates[1]?.text ?? "", /更新できません: 検証が未実行/);
  // 検証: .harness/verify.json のコマンドが実行される
  const verify = resultsOf(o, "harness_verify")[0];
  assert.match(verify?.text ?? "", /検証に成功しました/);
  assert.match(verify?.text ?? "", /成功: true/);
  // レビュー: 子は読み取り専用で、差分と要件だけを受け取る。判定は最終行のマーカー
  const child = requests[6];
  assert.ok(child, "reviewer のリクエストがあるはず");
  assert.deepEqual([...child.tools].sort(), ["find", "grep", "ls", "read"]);
  assert.ok(child.messages.includes("メモの作成"));
  assert.ok(child.messages.includes("完了条件: memo.txt がある"));
  assert.ok(child.messages.includes("新規ファイル: memo.txt"));
  const review = resultsOf(o, "harness_review")[0];
  assert.match(review?.text ?? "", /レビューは承認されました/);
  // 検証・レビューのあとの完了は通る
  assert.match(updates[2]?.text ?? "", /更新しました/);
  assert.match(updates[2]?.text ?? "", /plan_report/);
  // 完了報告に、検証とレビューの結果が載る
  const report = resultsOf(o, "plan_report")[0]?.text ?? "";
  for (const s of ["成功: `true`", "承認:", "根拠: memo.txt:1"]) assert.ok(report.includes(s), s);
  const last = o.assistantTexts.filter((t) => t.trim()).at(-1) ?? "";
  assert.equal(last.trimEnd().split("\n").at(-1), FINAL_LINE);
});
