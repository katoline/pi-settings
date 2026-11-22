import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { Runtime } from "../lib/runtime.ts";
import { withFinalLine } from "./final-line.ts";

/** 成功すると成果物ができるツール */
const ARTIFACT_TOOLS = new Set(["write", "edit"]);
/** 成果物を作る bash コマンド（commit・push・PR の作成。`git -C <dir>` 形式も含む） */
const ARTIFACT_COMMAND = /\b(?:git\s+(?:-C\s+\S+\s+)?(?:commit|push)|gh\s+pr\s+create)\b/;

/**
 * 作業が完了したら、最終応答の最後の 1 行を「🚀作業が完了しました！」にする。
 * 「完了」は、その依頼の中で成果物を作る操作（ファイルの変更、commit、push、PR の作成）が成功したこと。
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
  });

  pi.on("message_end", async (event) => {
    if (rt.isSubagent || !touched) return undefined;
    const replaced = withFinalLine(event.message as never);
    return replaced ? { message: replaced as never } : undefined;
  });
}
