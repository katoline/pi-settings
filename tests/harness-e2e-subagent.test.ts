/**
 * 統合テスト: 実際の Pi(node_modules の 1.5.2)を RPC モードで起動し、偽のモデル
 * (OpenAI 互換のローカルサーバー)につないで、ハーネスを通しで確かめる。
 *
 * 場面 2（フェーズ 3）: subagent ツールが、独立した `pi` の子プロセスを起動し、子にはハーネスの拡張だけが
 *         読み込まれ、子は読み取り専用のツールだけを持ち、報告が親に返ること。
 * 場面 2b: 書き込み可の役割（worker）が成功すると、親の最終応答に完了の合図が付くこと。
 * ネットワークは使わない。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { FINAL_LINE } from "../agent/extensions/harness/output/final-line.ts";
import { resultsOf, type Step, scenario, scenarioIn } from "./harness-e2e-helpers.ts";

test("実際の Pi で、subagent が独立した子プロセスを起動し、報告が親に返る", {
  timeout: 120_000,
}, async () => {
  const steps: Step[] = [
    {
      tool: "subagent",
      args: {
        tasks: [
          { agent: "scout", title: "README の調査", task: "README.md を読んで、要約してください" },
        ],
      },
    }, // 0: 親
    { text: "README の要約: 設定リポジトリです" }, // 1: 子(scout)の応答
    { text: "子の報告を受け取りました" }, // 2: 親の最終応答
  ];
  const o = await scenario("subagent", steps, "調査を任せてください");
  const { requests } = o;

  // 親: subagent ツールを持つ
  assert.ok(requests[0]?.tools.includes("subagent"));

  // 子: 読み取り専用のツールだけ。subagent も、計画・PR のツールもない(再帰の防止、サブエージェントでは登録しない)
  const child = requests[1];
  assert.ok(child, "子のリクエストがあるはず");
  assert.deepEqual([...child.tools].sort(), ["find", "grep", "ls", "read"]);
  // 子には、サブエージェント用の固定の指示と、役割の指示が渡る
  assert.ok(
    child.messages.includes("メインエージェントから任された作業だけを行うサブエージェントです"),
  );
  assert.ok(child.messages.includes("あなたは、読み取り専用の調査担当です"));
  // 依頼の本文が渡る
  assert.ok(child.messages.includes("README.md を読んで、要約してください"));

  // 親: 子の報告が、ツールの結果として返る(完了の表示つき)
  const result = resultsOf(o, "subagent")[0];
  assert.ok(result, "subagent の結果があるはず");
  assert.equal(result.isError, false);
  assert.match(result.text, /1\/1 件が完了/);
  assert.match(result.text, /README の要約: 設定リポジトリです/);
  assert.match(result.text, /✅ README の調査が完了/);
  assert.ok(
    requests[2]?.messages.includes("README の要約: 設定リポジトリです"),
    "親のモデルに、子の報告が渡る",
  );
  // 読み取り専用の役割だけでは、成果物ができていないので、完了の合図は付かない
  assert.ok(!(o.assistantTexts.at(-1) ?? "").includes(FINAL_LINE));
});

test("実際の Pi で、書き込み可の worker が成功すると、親の最終応答に完了の合図が付く", {
  timeout: 120_000,
}, async () => {
  const steps: Step[] = [
    {
      tool: "subagent",
      args: {
        tasks: [{ agent: "worker", title: "メモの作成", task: "memo.txt を作ってください" }],
      },
    }, // 0: 親
    { tool: "write", args: { path: "memo.txt", content: "メモ\n" } }, // 1: 子(worker)が書き込む
    { text: "memo.txt を作成しました" }, // 2: 子の報告
    { text: "worker の報告を確認しました" }, // 3: 親の最終応答
  ];
  const { outcome: o, cwd } = await scenarioIn("subagent-worker", steps, "実装を任せてください");
  const { requests } = o;

  // 子(worker)は書き込みのツールを持つ（tools 未指定 = 既定のツール）。subagent は持たない
  const child = requests[1];
  assert.ok(child, "子のリクエストがあるはず");
  assert.ok(child.tools.includes("write") && child.tools.includes("edit"));
  assert.ok(!child.tools.includes("subagent"));
  // 子は親と同じ作業ディレクトリで動く
  assert.equal(readFileSync(path.join(cwd, "memo.txt"), "utf8"), "メモ\n");

  const result = resultsOf(o, "subagent")[0];
  assert.match(result?.text ?? "", /1\/1 件が完了/);
  assert.match(result?.text ?? "", /memo\.txt を作成しました/);

  // 親は write・edit を直接呼んでいないが、subagent の書き込み可の成功で、完了の合図が付く
  const last = o.assistantTexts.filter((t) => t.trim()).at(-1) ?? "";
  assert.ok(last.startsWith("worker の報告を確認しました"));
  assert.equal(last.trimEnd().split("\n").at(-1), FINAL_LINE);
  // ツール呼び出しの途中のメッセージには付かない
  assert.ok(!(o.assistantTexts[0] ?? "").includes(FINAL_LINE));
});
