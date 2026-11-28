import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { isAutonomous } from "../flow/plan.ts";
import type { Runtime } from "../lib/runtime.ts";
import { hasSuccessfulWrite } from "../subagent/child.ts";
import { withFinalLine } from "./final-line.ts";

/** 成功すると成果物ができるツール */
const ARTIFACT_TOOLS = new Set(["write", "edit", "harness_pr_create", "harness_pr_merge"]);
/** 成果物を作る bash コマンド（commit・push。`git -C <dir>` 形式も含む。PR の作成は `harness_pr_create`、マージは `harness_pr_merge`） */
const ARTIFACT_COMMAND = /\b(?:git\s+(?:-C\s+\S+\s+)?(?:commit|push))\b/;

/**
 * 作業が完了したら、最終応答の最後の 1 行を「## ✅ 作業完了」にする。
 * 「完了」は、その依頼の中で成果物を作る操作（ファイルの変更、書き込み可のサブエージェントの成功、commit、push、`harness_pr_create`・`harness_pr_merge` の成功）が成功したこと、
 * またはその依頼の中で計画の完了報告（`plan_report`）を出したこと。
 * ただし、確定した計画を自律で進めている間（未完了で、一時停止していない）は付けない。
 * モデルの書き忘れには頼らず、確定したメッセージを、ハーネスが書き換える。
 */
export function registerOutput(pi: ExtensionAPI, rt: Runtime): void {
  // 今の依頼で成果物を作る操作が成功したか。依頼の実行が始まるとき（before_agent_start）にリセットする。
  // `input` は実行中のステア・後続メッセージでもキュー投入時に発火するので、リセットには使わない
  let touched = false;
  // tool_execution_end には args が無いので、start で控えた呼び出しを toolCallId で突き合わせる
  const pending = new Map<string, { toolName: string; command: string }>();

  pi.on("before_agent_start", async (event) => {
    if (event.messageType === "user") {
      touched = false;
      rt.planCompleted = false;
      pending.clear();
    }
    return undefined;
  });

  pi.on("tool_execution_start", async (event) => {
    const command = String((event.args as { command?: unknown } | undefined)?.command ?? "");
    pending.set(event.toolCallId, { toolName: event.toolName, command });
  });

  pi.on("tool_execution_end", async (event) => {
    const call = pending.get(event.toolCallId);
    pending.delete(event.toolCallId);
    if (event.isError || !call) return;
    if (ARTIFACT_TOOLS.has(call.toolName)) touched = true;
    else if (call.toolName === "bash" && ARTIFACT_COMMAND.test(call.command)) touched = true;
    // subagent は、書き込み可の役割の依頼が 1 件以上成功したときだけ（結果の details で判定する）
    else if (call.toolName === "subagent" && hasSuccessfulWrite(event.result?.details))
      touched = true;
  });

  pi.on("message_end", async (event) => {
    if (rt.isSubagent || !(touched || rt.planCompleted)) return undefined;
    // 計画を自律で進めている間の応答（継続の途中）は、完了ではない。一時停止中・計画なし・完了済みは通常の条件で付ける
    if (isAutonomous(rt.plan)) return undefined;
    const replaced = withFinalLine(event.message as never);
    return replaced ? { message: replaced as never } : undefined;
  });
}
