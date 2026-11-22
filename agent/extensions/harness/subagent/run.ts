import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentToolUpdateCallback, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Runtime } from "../lib/runtime.ts";
import { type AgentDef, isReadOnlyAgent, loadAgents } from "./agents.ts";
import {
  abortedResult,
  type ChildResult,
  isFailed,
  piInvocation,
  runChild,
  runScheduled,
} from "./child.ts";
import { formatReport, resultLine, startLine } from "./format.ts";

const extensionPath = fileURLToPath(new URL("../index.ts", import.meta.url));

export interface SubagentTask {
  agent: string;
  title: string;
  task: string;
}

export const describeAgents = (agents: AgentDef[]): string =>
  agents.length
    ? agents
        .map((a) => `${a.name}(${a.description}${isReadOnlyAgent(a) ? "" : "。書き込み可"})`)
        .join("、")
    : "(役割の定義がありません)";

export type RunOutcome =
  /** 上限超過・未知の役割などで、子を起動しなかった（件数に数えない） */
  { kind: "refused"; text: string } | { kind: "ran"; text: string; results: ChildResult[] };

/**
 * サブエージェントの依頼を実行する。`subagent` ツールと、`harness_review`（reviewer を起動する）が共有する。
 * 起動した件数と費用は `rt` に積む（再開時は、セッションの枝に残る結果から数え直す）。
 */
export async function runSubagentTasks(
  rt: Runtime,
  tasks: readonly SubagentTask[],
  ctx: ExtensionContext,
  signal: AbortSignal | undefined,
  onUpdate?: AgentToolUpdateCallback<unknown>,
): Promise<RunOutcome> {
  const limits = rt.config.subagent;
  const refuse = (text: string): RunOutcome => ({ kind: "refused", text });
  if (tasks.length > limits.maxTasks) {
    return refuse(`一度に任せられるのは ${limits.maxTasks} 件までです。`);
  }
  if (rt.subagentSpawns + tasks.length > limits.maxTotal) {
    return refuse(
      `このセッションで起動できるサブエージェントの上限(${limits.maxTotal})に達しました。計画を見直してください。`,
    );
  }
  const agents = loadAgents(path.join(rt.agentDir, "agents"));
  const unknown = tasks.find((t) => !agents.some((a) => a.name === t.agent));
  if (unknown) return refuse(`未知の役割: ${unknown.agent}。使える役割: ${describeAgents(agents)}`);
  rt.subagentSpawns += tasks.length;

  const tmp = mkdtempSync(path.join(tmpdir(), "harness-sub-"));
  const running = new Map<number, string>();
  const showWidget = () =>
    ctx.ui.setWidget("harness-subagents", running.size ? [...running.values()] : undefined);
  const invocation = piInvocation();
  const agentOf = (name: string) => agents.find((a) => a.name === name) as AgentDef;
  try {
    const results = await runScheduled(
      tasks,
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
    return { kind: "ran", text: formatReport(results), results };
  } finally {
    running.clear();
    showWidget();
    rmSync(tmp, { recursive: true, force: true });
  }
}
