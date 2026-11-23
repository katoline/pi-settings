import { uuidv7 } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { convertToLlm, serializeConversation } from "@earendil-works/pi-coding-agent";
import type { Runtime } from "../lib/runtime.ts";
import { parseRef } from "../models/catalog.ts";
import { computeFileLists, formatFileLists, withPreviousFileLists } from "./files.ts";
import {
  buildStateBlock,
  buildSummaryPrompt,
  SUMMARY_SYSTEM_PROMPT,
  stripAppendedBlocks,
} from "./prompt.ts";

/**
 * 要約(compact)のときに、必ず残す項目を指定する。
 * 要約は、日本語で、5 項目(変更ファイルと検証、検証の結果、PR、サブエージェントの状態、決定事項)を
 * 明示して作らせ、そのうえで、ハーネスが持つ確定した状態(計画・検証・レビュー・PR)と、
 * 読んだファイル・変更したファイルの一覧を、そのまま付け足す。`/compact <指示>` の指示もプロンプトに入れる。
 * 要約のモデルや認証が使えないとき・失敗したとき・出力の上限で切れたときは、Pi の標準の要約に任せる。
 */
export function registerCompaction(pi: ExtensionAPI, rt: Runtime): void {
  if (rt.isSubagent) return;
  pi.on("session_before_compact", async (event, ctx) => {
    const { preparation, signal, branchEntries, customInstructions } = event;
    const configured = rt.config.compactionModel ? parseRef(rt.config.compactionModel) : null;
    const model =
      (configured && ctx.modelRegistry.find(configured.provider, configured.id)) || ctx.model;
    if (!model) return undefined;
    const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
    if (!auth.ok) return undefined;

    const messages = [...preparation.messagesToSummarize, ...preparation.turnPrefixMessages];
    // 前回付けた記録とファイルの一覧は付け直すので、古いものをモデルに渡さない
    const prompt = buildSummaryPrompt(
      serializeConversation(convertToLlm(messages)),
      stripAppendedBlocks(preparation.previousSummary),
      customInstructions,
    );
    try {
      // pi の標準の要約と同じく streamSimple で呼ぶ。出力の上限は渡さず、pi-ai がモデルの上限を
      // 文脈の窓に合わせて削る(clampMaxTokensToContext)。complete は削らないので使わない
      const response = await ctx.modelRegistry
        .streamSimple(
          model,
          {
            systemPrompt: SUMMARY_SYSTEM_PROMPT,
            messages: [
              {
                role: "user" as const,
                content: [{ type: "text" as const, text: prompt }],
                timestamp: Date.now(),
              },
            ],
          },
          { signal, cacheRetention: "none", sessionId: uuidv7() },
        )
        .result();
      if (response.stopReason === "aborted") return undefined;
      if (response.stopReason === "error") {
        throw new Error(response.errorMessage || "要約モデルがエラーを返しました");
      }
      // 出力の上限で切れた要約は不完全なので、保存しない(pi の標準の要約と同じ扱い)
      if (response.stopReason === "length") {
        throw new Error("要約が出力の上限で途中で切れました");
      }
      const summary = response.content
        .filter((c): c is { type: "text"; text: string } => c.type === "text")
        .map((c) => c.text)
        .join("\n")
        .trim();
      if (!summary) return undefined;
      const state = buildStateBlock({
        plan: rt.plan,
        subagentModel: rt.subagentModel,
        subagentSpawns: rt.subagentSpawns,
        childCost: rt.childCost,
      });
      // pi の標準の要約と同じ一覧と書式。拡張の要約の details は pi が引き継がないので、枝から読む
      const files = computeFileLists(withPreviousFileLists(preparation.fileOps, branchEntries));
      return {
        compaction: {
          summary: `${summary}\n\n${state}${formatFileLists(files)}`,
          firstKeptEntryId: preparation.firstKeptEntryId,
          tokensBefore: preparation.tokensBefore,
          usage: response.usage,
          details: { readFiles: files.readFiles, modifiedFiles: files.modifiedFiles },
        },
      };
    } catch (error) {
      if (!signal.aborted) {
        ctx.ui.notify(
          `要約に失敗したため、標準の要約を使います: ${error instanceof Error ? error.message : String(error)}`,
          "warning",
        );
      }
      return undefined;
    }
  });
}
