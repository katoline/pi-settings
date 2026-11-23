import assert from "node:assert/strict";
import test from "node:test";
import { formatSubagentDetail, subagentCosts } from "../agent/extensions/harness/usage/children.ts";
import {
  formatAnthropicDetail,
  formatAnthropicStatus,
  formatCodexStatus,
  formatGoStatus,
  formatUsd,
  parseCodexUsage,
  parseOpenCodeGoUsage,
  sumProviderCost,
} from "../agent/extensions/harness/usage/parse.ts";
import { registerUsage } from "../agent/extensions/harness/usage/register.ts";
import { runtime } from "./harness-helpers.ts";

const msg = (provider: string, total?: number) => ({
  type: "message",
  message: { role: "assistant", provider, usage: total === undefined ? {} : { cost: { total } } },
});

test("sumProviderCost は空なら 0", () => {
  assert.equal(sumProviderCost([]), 0);
});

test("sumProviderCost は Anthropic 以外を除外し usage エントリも含める", () => {
  const entries = [
    msg("anthropic", 0.1),
    msg("openai-codex", 5),
    {
      type: "message",
      message: { role: "user", provider: "anthropic", usage: { cost: { total: 9 } } },
    },
    { type: "usage", provider: "anthropic", usage: { cost: { total: 0.05 } } },
    { type: "usage", provider: "openai", usage: { cost: { total: 7 } } },
  ];
  assert.ok(Math.abs(sumProviderCost(entries) - 0.15) < 1e-9);
});

test("sumProviderCost は cost が無い・不正なエントリを 0 とみなす", () => {
  assert.equal(
    sumProviderCost([
      msg("anthropic"),
      msg("anthropic", Number.NaN),
      null,
      "x",
      { type: "message" },
    ]),
    0,
  );
});

test("formatUsd は小数 2 桁に丸める", () => {
  assert.equal(formatUsd(0), "$0.00");
  assert.equal(formatUsd(0.424), "$0.42");
  assert.equal(formatUsd(0.426), "$0.43");
  assert.equal(formatUsd(12.3), "$12.30");
  assert.equal(formatUsd(Number.NaN), "$0.00");
});

test("Anthropic の表示文言", () => {
  assert.equal(formatAnthropicStatus(0.42), "Anthropic このセッション $0.42");
  assert.ok(formatAnthropicDetail(0).startsWith("Anthropic API: このセッション $0.00"));
  assert.ok(!formatAnthropicDetail(0.5).includes("うちサブエージェント"));
  assert.ok(
    formatAnthropicDetail(0.5, 0.2).startsWith(
      "Anthropic API: このセッション $0.50（うちサブエージェント $0.20。",
    ),
  );
});

test("parses Codex 5-hour and weekly windows without assuming order", () => {
  const windows = parseCodexUsage(
    {
      rate_limit: {
        allowed: true,
        primary_window: { used_percent: 9, limit_window_seconds: 604_800, reset_at: 1_700_000_000 },
        secondary_window: {
          used_percent: 41,
          limit_window_seconds: 18_000,
          reset_after_seconds: 120,
        },
      },
    },
    1_600_000_000_000,
  );
  assert.deepEqual(
    windows?.map((window) => window.id),
    ["7d", "5h"],
  );
  assert.equal(windows?.[1]?.usedPercent, 41);
  assert.equal(formatCodexStatus(windows ?? []), "Codex 5h 41% 7d 9%");
});

test("shows a non-weekly Codex window when 5h and weekly are absent", () => {
  const windows = parseCodexUsage({
    rate_limit: {
      primary_window: { used_percent: 0, limit_window_seconds: 2_592_000, reset_at: 1_797_703_054 },
      secondary_window: null,
    },
  });
  assert.equal(windows?.[0]?.id, "30d");
  assert.equal(formatCodexStatus(windows ?? []), "Codex 30d 0%");
});

test("parses OpenCode Go used percentages", () => {
  const windows = parseOpenCodeGoUsage({
    usage: {
      rolling: { status: "ok", percent: 42, resetsAt: "2026-11-19T22:52:17.000Z" },
      weekly: { status: "ok", percent: 17, resetsAt: "2026-11-23T00:00:00.000Z" },
      monthly: { status: "rate-limited", percent: 91, resetsAt: "2026-11-20T05:32:10.000Z" },
    },
  });
  assert.equal(formatGoStatus(windows ?? []), "Go 5h 42% 7d 17% 30d 100%!");
});

test("marks only the exhausted Codex window as limited", () => {
  const windows = parseCodexUsage({
    rate_limit: {
      allowed: false,
      limit_reached: true,
      primary_window: { used_percent: 20, limit_window_seconds: 18_000, reset_at: 1_700_000_000 },
      secondary_window: {
        used_percent: 100,
        limit_window_seconds: 604_800,
        reset_at: 1_700_000_000,
      },
    },
  });
  assert.equal(formatCodexStatus(windows ?? []), "Codex 5h 20% 7d 100%!");
});

test("marks every Codex window as limited when blocked with no exhausted window", () => {
  const windows = parseCodexUsage({
    rate_limit: {
      limit_reached: true,
      primary_window: { used_percent: 20, limit_window_seconds: 18_000, reset_at: 1_700_000_000 },
      secondary_window: {
        used_percent: 30,
        limit_window_seconds: 604_800,
        reset_at: 1_700_000_000,
      },
    },
  });
  assert.equal(formatCodexStatus(windows ?? []), "Codex 5h 20%! 7d 30%!");
});

const child = (model: string, cost: number) => ({
  model,
  usage: { turns: 1, input: 1, output: 1, cost },
});
const toolResult = (toolName: string, details: unknown) => ({
  type: "message",
  message: { role: "toolResult", toolName, details },
});

test("subagentCosts: プロバイダーごとに集計する（subagent と harness_review の children、details 無しは数えない）", () => {
  const entries = [
    toolResult("subagent", [child("anthropic/haiku", 0.25), child("opencode-go/flash", 0.5)]),
    toolResult("harness_review", { verdict: {}, children: [child("anthropic/sonnet", 0.25)] }),
    toolResult("subagent", undefined),
    toolResult("harness_review", { verdict: {} }),
    toolResult("bash", [child("anthropic/x", 9)]),
    {
      type: "message",
      message: { role: "assistant", provider: "anthropic", usage: { cost: { total: 9 } } },
    },
    toolResult("subagent", [{ model: "broken", usage: { cost: Number.NaN } }]),
  ];
  const t = subagentCosts(entries);
  assert.equal(t.count, 4);
  assert.equal(t.cost, 1);
  assert.deepEqual(t.byProvider, {
    anthropic: { count: 2, cost: 0.5 },
    "opencode-go": { count: 1, cost: 0.5 },
    unknown: { count: 1, cost: 0 },
  });
});

test("subagentCosts: 捨てた分岐のエントリも、渡されたエントリは全部数える。空なら 0", () => {
  assert.deepEqual(subagentCosts([]), { count: 0, cost: 0, byProvider: {} });
  const t = subagentCosts([toolResult("subagent", [child("openai-codex/gpt", 0.1)])]);
  assert.equal(t.byProvider["openai-codex"]?.cost, 0.1);
});

test("formatSubagentDetail: 件数・内訳・見積もりの注記を出す", () => {
  const line = formatSubagentDetail(
    subagentCosts([
      toolResult("subagent", [child("anthropic/a", 0.3), child("opencode-go/b", 0.12)]),
    ]),
  );
  assert.equal(
    line,
    "サブエージェント: $0.42（2 件、内訳: anthropic $0.30 / opencode-go $0.12。OpenCode Go・Codex はサブスクのため、額は pi の見積もり）",
  );
  assert.ok(formatSubagentDetail(subagentCosts([])).startsWith("サブエージェント: $0.00（0 件。"));
});

test("registerUsage: サブエージェントでは何も登録しない。メインではフックとコマンドを登録する", () => {
  const events: string[] = [];
  const commands: string[] = [];
  const pi = {
    on: (name: string) => events.push(name),
    registerCommand: (name: string) => commands.push(name),
  };
  registerUsage(pi as never, runtime({ isSubagent: true }));
  assert.deepEqual([events, commands], [[], []]);
  registerUsage(pi as never, runtime());
  assert.ok(events.includes("turn_end") && commands.includes("usage"));
});

// ---- registerUsage のフックとコマンド（偽の pi・ctx。Codex・Go の取得は差し替え、外部 API は呼ばない） ----

type UsageHandler = (event: unknown, ctx: unknown) => unknown;

function setupUsage() {
  const handlers = new Map<string, UsageHandler>();
  const commands = new Map<string, (args: string, ctx: unknown) => Promise<void>>();
  const pi = {
    on: (name: string, fn: UsageHandler) => handlers.set(name, fn),
    registerCommand: (
      name: string,
      cmd: { handler: (args: string, ctx: unknown) => Promise<void> },
    ) => commands.set(name, cmd.handler),
  };
  const fetched: string[] = [];
  registerUsage(pi as never, runtime(), {
    loadCodex: async () => {
      fetched.push("codex");
      return { kind: "missing", message: "no codex" };
    },
    loadGo: async () => {
      fetched.push("go");
      return { kind: "missing", message: "no go" };
    },
  });
  return { handlers, commands, fetched };
}

// 親の Anthropic $0.10、子は anthropic $0.25・opencode-go $0.50
const usageEntries = [
  msg("anthropic", 0.1),
  msg("opencode-go", 3),
  toolResult("subagent", [child("anthropic/haiku", 0.25), child("opencode-go/flash", 0.5)]),
];

function usageCtx(provider: string | undefined) {
  const statuses: Array<string | undefined> = [];
  const notices: string[] = [];
  const ctx = {
    hasUI: true,
    model: provider ? { provider, id: "m" } : undefined,
    sessionManager: { getEntries: () => usageEntries },
    ui: {
      setStatus: (_key: string, text: string | undefined) => statuses.push(text),
      notify: (m: string) => notices.push(m),
    },
  };
  return { ctx, statuses, notices };
}

const tick = () => new Promise((resolve) => setImmediate(resolve));

test("registerUsage: フッターの Anthropic の額に、プロバイダーが anthropic の子の費用を足す。今のモデルで出し分ける", async () => {
  const { handlers, fetched } = setupUsage();
  const anthropic = usageCtx("anthropic");
  try {
    handlers.get("session_start")?.({ reason: "startup" }, anthropic.ctx);
    await tick();
    handlers.get("turn_end")?.({}, anthropic.ctx);
    assert.deepEqual(fetched.sort(), ["codex", "go"]);
    assert.equal(anthropic.statuses.at(-1), "Codex ! │ Go ! │ Anthropic このセッション $0.35");

    const codex = usageCtx("openai-codex");
    handlers.get("model_select")?.({}, codex.ctx);
    assert.equal(codex.statuses.at(-1), "Codex ! │ Go !");

    const none = usageCtx(undefined);
    handlers.get("turn_end")?.({}, none.ctx);
    assert.equal(none.statuses.at(-1), "Codex ! │ Go !");
  } finally {
    // setInterval を止める
    handlers.get("session_shutdown")?.({}, anthropic.ctx);
  }
});

test("registerUsage: /usage は Anthropic の行（子の分の注記つき）とサブエージェントの行を出す", async () => {
  const { commands } = setupUsage();
  const { ctx, notices } = usageCtx("openai-codex");
  await commands.get("usage")?.("", ctx);
  assert.equal(notices.length, 1);
  const lines = notices[0]?.split("\n") ?? [];
  assert.deepEqual(lines.slice(0, 3), ["Usage", "Codex: no codex", "Go: no go"]);
  assert.ok(
    lines[3]?.startsWith("Anthropic API: このセッション $0.35（うちサブエージェント $0.25。"),
    String(lines[3]),
  );
  assert.ok(
    lines[4]?.startsWith(
      "サブエージェント: $0.75（2 件、内訳: opencode-go $0.50 / anthropic $0.25。",
    ),
    String(lines[4]),
  );
});
