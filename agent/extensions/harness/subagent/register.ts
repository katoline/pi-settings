import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { Runtime } from "../lib/runtime.ts";
import { type AgentDef, isReadOnlyAgent, loadAgents } from "./agents.ts";
import {
  abortedResult,
  type ChildResult,
  isFailed,
  piInvocation,
  runChild,
  runScheduled,
  subagentTotals,
} from "./child.ts";
import { formatReport, resultLine, startLine } from "./format.ts";

const extensionPath = fileURLToPath(new URL("../index.ts", import.meta.url));

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
  const describeAgents = (agents: AgentDef[]) =>
    agents.length
      ? agents
          .map((a) => `${a.name}(${a.description}${isReadOnlyAgent(a) ? "" : "。書き込み可"})`)
          .join("、")
      : "(役割の定義がありません)";

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
      const limits = rt.config.subagent;
      const reply = (text: string) => ({
        content: [{ type: "text" as const, text }],
        details: undefined,
      });
      if (params.tasks.length > limits.maxTasks) {
        return reply(`一度に任せられるのは ${limits.maxTasks} 件までです。`);
      }
      if (rt.subagentSpawns + params.tasks.length > limits.maxTotal) {
        return reply(
          `このセッションで起動できるサブエージェントの上限(${limits.maxTotal})に達しました。計画を見直してください。`,
        );
      }
      const agents = loadAgents(agentsDir);
      const unknown = params.tasks.find((t) => !agents.some((a) => a.name === t.agent));
      if (unknown)
        return reply(`未知の役割: ${unknown.agent}。使える役割: ${describeAgents(agents)}`);
      rt.subagentSpawns += params.tasks.length;

      const tmp = mkdtempSync(path.join(tmpdir(), "harness-sub-"));
      const running = new Map<number, string>();
      const showWidget = () =>
        ctx.ui.setWidget("harness-subagents", running.size ? [...running.values()] : undefined);
      const invocation = piInvocation();
      const agentOf = (name: string) => agents.find((a) => a.name === name) as AgentDef;
      try {
        const results = await runScheduled(
          params.tasks,
          limits.maxConcurrency,
          (t) => isReadOnlyAgent(agentOf(t.agent)),
          async (t, i) => {
            const agent = agentOf(t.agent);
            // 待っている間に中断されたら、子を起動せず、通知もせずに、中断の結果を返す
            if (signal?.aborted)
              return abortedResult({ agent, title: t.title, model: rt.subagentModel });
            const roleFile = path.join(tmp, `${i}-${agent.name}.md`);
            writeFileSync(roleFile, agent.instructions, { mode: 0o600 });
            const model = agent.model ?? rt.subagentModel;
            const start = startLine(model, t.title);
            running.set(i, start);
            showWidget();
            ctx.ui.notify(start, "info");
            onUpdate?.({
              content: [{ type: "text", text: [...running.values()].join("\n") }],
              details: undefined,
            });
            const result = await runChild(
              {
                agent,
                task: t.task,
                title: t.title,
                model: rt.subagentModel,
                extensionPath,
                roleFile,
                cwd: ctx.cwd,
                parentSessionId: ctx.sessionManager.getSessionId(),
              },
              {
                invocation,
                ...(signal ? { signal } : {}),
                timeoutMs: limits.timeoutSeconds * 1000,
              },
            );
            rt.childCost += result.usage.cost;
            running.delete(i);
            showWidget();
            ctx.ui.notify(resultLine(result), isFailed(result) ? "warning" : "info");
            return result;
          },
        );
        return {
          content: [{ type: "text" as const, text: formatReport(results) }],
          details: results satisfies ChildResult[],
        };
      } finally {
        running.clear();
        showWidget();
        rmSync(tmp, { recursive: true, force: true });
      }
    },
  });
}
