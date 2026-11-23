import { parseRef } from "../models/catalog.ts";
import { formatUsd } from "./parse.ts";

export interface ProviderCost {
  /** 子の件数 */
  count: number;
  /** pi の見積もり（USD） */
  cost: number;
}

export interface SubagentCosts {
  count: number;
  cost: number;
  /** プロバイダー（`model` の `provider/id` の前半。読めなければ "unknown"）ごとの集計 */
  byProvider: Record<string, ProviderCost>;
}

const SUBSCRIPTION_NOTE = "OpenCode Go・Codex はサブスクのため、額は pi の見積もり";

/**
 * セッションの全エントリから、サブエージェントの費用をプロバイダーごとに数える。
 * 数え方は `subagentTotals`（subagent/child.ts）と同じ。対象は次の 2 つ。
 * - `subagent` のツール結果：details が子の結果の配列
 * - `harness_review` のツール結果：details の `children` が子の結果の配列
 * details が無い（断られた呼び出し）ものは数えない。費用が有限の数でない子は件数だけ数える。
 */
export function subagentCosts(entries: readonly unknown[]): SubagentCosts {
  const out: SubagentCosts = { count: 0, cost: 0, byProvider: {} };
  for (const e of entries) {
    const entry = e as {
      type?: string;
      message?: { role?: string; toolName?: string; details?: unknown };
    } | null;
    const msg = entry?.type === "message" ? entry.message : undefined;
    if (msg?.role !== "toolResult") continue;
    let children: unknown;
    if (msg.toolName === "subagent") children = msg.details;
    else if (msg.toolName === "harness_review")
      children = (msg.details as { children?: unknown } | null | undefined)?.children;
    else continue;
    if (!Array.isArray(children)) continue;
    for (const r of children) {
      const child = r as { model?: unknown; usage?: { cost?: unknown } } | null;
      const provider =
        (typeof child?.model === "string" ? parseRef(child.model)?.provider : undefined) ??
        "unknown";
      const c = child?.usage?.cost;
      const cost = typeof c === "number" && Number.isFinite(c) ? c : 0;
      const slot = out.byProvider[provider] ?? { count: 0, cost: 0 };
      out.byProvider[provider] = slot;
      slot.count += 1;
      slot.cost += cost;
      out.count += 1;
      out.cost += cost;
    }
  }
  return out;
}

/** `/usage` の 1 行。例：`サブエージェント: $0.42（3 件、内訳: anthropic $0.30 / opencode-go $0.12。…）` */
export function formatSubagentDetail(costs: SubagentCosts): string {
  const parts = Object.entries(costs.byProvider)
    .sort((a, b) => b[1].cost - a[1].cost || a[0].localeCompare(b[0]))
    .map(([provider, v]) => `${provider} ${formatUsd(v.cost)}`);
  const breakdown = parts.length > 0 ? `、内訳: ${parts.join(" / ")}` : "";
  return `サブエージェント: ${formatUsd(costs.cost)}（${costs.count} 件${breakdown}。${SUBSCRIPTION_NOTE}）`;
}
