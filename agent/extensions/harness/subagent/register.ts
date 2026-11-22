import path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { Runtime } from "../lib/runtime.ts";
import { loadAgents } from "./agents.ts";
import { type ChildResult, subagentTotals } from "./child.ts";
import { describeAgents, runSubagentTasks } from "./run.ts";

const TaskSchema = Type.Object({
  agent: Type.String({ description: "役割の名前(scout / planner / worker / reviewer など)" }),
  title: Type.String({
    description: "作業内容を表す短い題名。画面に「<題名>を実行中」と表示される",
  }),
  task: Type.String({
    description: "自己完結した依頼(対象ファイル、設計方針、制約、完了条件)。分かっている事実は渡す",
  }),
});

/**
 * サブエージェント(別プロセス方式)。メインエージェントだけが、`subagent` ツールを使える。
 * 子は、ハーネスの拡張だけを読み込んだ、独立した `pi` プロセス。環境変数 PI_SUBAGENT=1 で、
 * ガードが「commit・push・PR・マージの拒否」などを効かせる。子はいつも親の作業ディレクトリで動く
 * (worktree は使わない)ので、書き込み可の役割は 1 件ずつ順番に動かす。
 */
export function registerSubagent(pi: ExtensionAPI, rt: Runtime): void {
  if (rt.isSubagent) return; // 子は、さらに子を作らない(再帰の防止)
  const agentsDir = path.join(rt.agentDir, "agents");
  // 件数(上限の判定用)と費用の合計は、セッションの枝に残る結果から数え直す(再開・リロード・フォーク・ツリーの移動)
  const restore = (ctx: ExtensionContext) => {
    const totals = subagentTotals(ctx.sessionManager.getBranch());
    rt.subagentSpawns = totals.spawns;
    rt.childCost = totals.cost;
  };
  pi.on("session_start", async (_event, ctx) => restore(ctx));
  pi.on("session_tree", async (_event, ctx) => restore(ctx));

  pi.registerTool({
    name: "subagent",
    label: "サブエージェント",
    description: [
      "重い作業・並列にできる作業を、独立した文脈のサブエージェントに任せる。",
      "`tasks` に 1 件以上の依頼を渡す。読み取り専用の役割は並列に動き、書き込み可の役割は(同じ作業ツリーを使うため)1 件ずつ順番に動く。",
      "書き込み可の役割に、同じファイルを編集させる複数の依頼を渡さない。",
      "1〜2 ファイルの確認や、自明な局所修正は、メインだけで行う。",
      `使える役割: ${describeAgents(loadAgents(agentsDir))}`,
      "子は、いつもこの作業ディレクトリで動き、ユーザーに質問できず、commit・push・PR・マージもできない。報告は、変更ファイル / 検証と結果 / 未解決点で返る。",
    ].join(" "),
    parameters: Type.Object({
      tasks: Type.Array(TaskSchema, {
        minItems: 1,
        // `harness.json` の上書きに合わせる(登録時の値)
        maxItems: rt.config.subagent.maxTasks,
        description: "サブエージェントへの依頼",
      }),
    }),
    executionMode: "sequential",
    async execute(_id, params, signal, onUpdate, ctx) {
      const outcome = await runSubagentTasks(rt, params.tasks, ctx, signal, onUpdate);
      if (outcome.kind === "refused")
        return { content: [{ type: "text" as const, text: outcome.text }], details: undefined };
      return {
        content: [{ type: "text" as const, text: outcome.text }],
        details: outcome.results satisfies ChildResult[],
      };
    },
  });
}
