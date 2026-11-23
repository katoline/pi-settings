import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerCompaction } from "./compaction/register.ts";
import { registerFlow } from "./flow/register.ts";
import { registerGuards } from "./guards/register.ts";
import { registerInstructions } from "./instructions/register.ts";
import { createRuntime } from "./lib/runtime.ts";
import { registerModels } from "./models/register.ts";
import { registerOutput } from "./output/register.ts";
import { registerSubagent } from "./subagent/register.ts";
import { registerUsage } from "./usage/register.ts";

/**
 * Pi ハーネスの入口。ルールは、コンテキスト（AGENTS.md）ではなく、ここで登録するフックと
 * ツールで強制する。ガード（フェーズ 1）、固定の指示と完了の合図（フェーズ 2）、モデル選択とサブエージェント（フェーズ 3）、計画・自律ループ・検証・独立レビュー・完了報告（フェーズ 4）、PR の作成・依頼ゲートつきのマージ（フェーズ 5）、利用状況の表示（サブエージェントの費用つき）と日本語の要約（フェーズ 6。どちらもメインだけ）を登録している。
 * サブエージェントとして起動されたとき（PI_SUBAGENT=1）も、同じ拡張が読み込まれ、
 * より厳しい制限が効く。
 */
export default function harness(pi: ExtensionAPI): void {
  const rt = createRuntime();
  registerGuards(pi, rt);
  registerInstructions(pi, rt);
  registerOutput(pi, rt);
  // pi はハンドラを登録順に待つので、起動時のモデル選択のダイアログ(registerModels の session_start)より前に、
  // フッターの利用状況を出す
  registerUsage(pi, rt);
  registerModels(pi, rt);
  registerSubagent(pi, rt);
  registerFlow(pi, rt);
  registerCompaction(pi, rt);
}
