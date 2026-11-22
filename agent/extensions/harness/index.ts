import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerGuards } from "./guards/register.ts";
import { createRuntime } from "./lib/runtime.ts";

/**
 * Pi ハーネスの入口。ルールは、コンテキスト（AGENTS.md）ではなく、ここで登録するフックと
 * ツールで強制する。今はガード（フェーズ 1）だけを登録している。
 * サブエージェントとして起動されたとき（PI_SUBAGENT=1）も、同じ拡張が読み込まれ、
 * より厳しい制限が効く。
 */
export default function harness(pi: ExtensionAPI): void {
  const rt = createRuntime();
  registerGuards(pi, rt);
}
