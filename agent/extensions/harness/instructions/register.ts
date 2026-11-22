import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { Runtime } from "../lib/runtime.ts";
import { loadInstructions } from "./load.ts";

/**
 * 固定の指示を、AGENTS.md ではなく、ハーネスの中から渡す。
 * システムプロンプトの名前つきセクション（`<harness>`）に書く。全体を置換しないので、他の拡張や
 * pi のプロンプトと共存でき、変わった部分だけがモデルに差分として渡る。
 *
 * ファイルは拡張の読み込み時に 1 度だけ読む。読めなければ pi を止めず、警告して差し込まない。
 */
export function registerInstructions(pi: ExtensionAPI, rt: Runtime, dir?: string): void {
  const kind = rt.isSubagent ? "subagent" : "main";
  let text: string;
  try {
    text = loadInstructions(kind, dir);
  } catch (error) {
    console.warn(
      `[harness] 固定の指示（${kind}.md）を読めないため、差し込みません: ${error instanceof Error ? error.message : String(error)}`,
    );
    return;
  }

  pi.on("before_agent_start", async (event) => {
    const options = event.systemPromptOptions;
    options.sections = { ...(options.sections ?? {}), harness: text };
    return undefined;
  });
}
