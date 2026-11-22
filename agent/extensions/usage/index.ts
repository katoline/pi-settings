import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  formatAnthropicDetail,
  formatAnthropicStatus,
  formatCodexStatus,
  formatCountdown,
  formatGoStatus,
  formatPercent,
  parseCodexUsage,
  parseOpenCodeGoUsage,
  sumProviderCost,
  type UsageWindow,
} from "./parse.ts";

const STATUS_KEY = "usage";
const REQUEST_TIMEOUT_MS = 12_000;
const FAST_REFRESH_MS = 60_000;
const TIMER_SLACK_MS = 5_000;
const GO_USAGE_URL = "https://opencode.ai/zen/go/v1/usage";
const CODEX_USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";

type ProviderName = "codex" | "go";

type ProviderState<T> =
  | { kind: "loading" }
  | { kind: "missing"; message: string }
  | { kind: "error"; message: string }
  | { kind: "ready"; data: T };

interface UsageState {
  codex: ProviderState<UsageWindow[]>;
  go: ProviderState<UsageWindow[]>;
}

const INITIAL_STATE: UsageState = {
  codex: { kind: "loading" },
  go: { kind: "loading" },
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function decodeJwtPayload(token: string): Record<string, unknown> | undefined {
  const part = token.split(".")[1];
  if (!part) return undefined;
  try {
    const json = Buffer.from(part, "base64url").toString("utf8");
    const payload: unknown = JSON.parse(json);
    return isRecord(payload) ? payload : undefined;
  } catch {
    return undefined;
  }
}

function tokenExpired(token: string, now = Date.now()): boolean {
  const exp = decodeJwtPayload(token)?.exp;
  return typeof exp === "number" && Number.isFinite(exp) && exp * 1000 <= now + 60_000;
}

function codexAccountId(token: string, explicit?: string): string | undefined {
  if (explicit?.trim()) return explicit.trim();
  const claim = decodeJwtPayload(token)?.["https://api.openai.com/auth"];
  if (!isRecord(claim)) return undefined;
  const accountId = claim.chatgpt_account_id;
  return typeof accountId === "string" && accountId.trim() ? accountId.trim() : undefined;
}

async function readJson(path: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    return undefined;
  }
}

function plainSecret(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() && !value.startsWith("!") ? value.trim() : undefined;
}

async function providerApiKey(ctx: ExtensionContext, provider: string): Promise<string | undefined> {
  try {
    const resolved = await ctx.modelRegistry.getProviderAuth(provider);
    return plainSecret(resolved?.auth.apiKey);
  } catch {
    return undefined;
  }
}

async function requestJson(
  url: string,
  headers: Record<string, string>,
  signal: AbortSignal,
): Promise<{ ok: true; payload: unknown } | { ok: false; status: number | "timeout" | "failed" }> {
  try {
    const response = await fetch(url, {
      method: "GET",
      headers,
      redirect: "error",
      signal: AbortSignal.any([signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]),
    });
    if (!response.ok) return { ok: false, status: response.status };
    return { ok: true, payload: await response.json() };
  } catch (error) {
    const name = error instanceof Error ? error.name : "";
    if (name === "TimeoutError" || name === "AbortError") return { ok: false, status: "timeout" };
    return { ok: false, status: "failed" };
  }
}

function httpMessage(status: number | "timeout" | "failed"): string {
  if (status === 401) return "login expired";
  if (status === "timeout") return "timed out";
  if (status === "failed") return "request failed";
  return `HTTP ${status}`;
}

async function loadCodex(ctx: ExtensionContext, signal: AbortSignal): Promise<ProviderState<UsageWindow[]>> {
  const fromPi = await providerApiKey(ctx, "openai-codex");
  let token = fromPi && !tokenExpired(fromPi) ? fromPi : undefined;
  let accountId = token ? codexAccountId(token) : undefined;

  if (!token) {
    const home = process.env.CODEX_HOME || join(homedir(), ".codex");
    const stored = await readJson(join(home, "auth.json"));
    const tokens = isRecord(stored) && isRecord(stored.tokens) ? stored.tokens : undefined;
    const access = plainSecret(tokens?.access_token);
    const storedAccount = plainSecret(tokens?.account_id);
    if (access && !tokenExpired(access)) {
      token = access;
      accountId = codexAccountId(access, storedAccount);
    }
  }

  if (!token) return { kind: "missing", message: "login with Codex or /login openai-codex" };

  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    Accept: "application/json",
  };
  if (accountId) headers["ChatGPT-Account-Id"] = accountId;
  const result = await requestJson(CODEX_USAGE_URL, headers, signal);
  if (!result.ok) return { kind: "error", message: httpMessage(result.status) };
  const windows = parseCodexUsage(result.payload);
  return windows ? { kind: "ready", data: windows } : { kind: "error", message: "malformed response" };
}

async function loadGo(ctx: ExtensionContext, signal: AbortSignal): Promise<ProviderState<UsageWindow[]>> {
  let key = await providerApiKey(ctx, "opencode-go");
  if (!key) key = plainSecret(process.env.OPENCODE_API_KEY);
  if (!key) {
    const stored = await readJson(join(homedir(), ".pi", "agent", "auth.json"));
    const entry = isRecord(stored) ? stored["opencode-go"] : undefined;
    key = isRecord(entry) ? plainSecret(entry.key) : undefined;
  }
  if (!key) return { kind: "missing", message: "login with /login opencode-go" };

  const result = await requestJson(GO_USAGE_URL, {
    Authorization: `Bearer ${key}`,
    Accept: "application/json",
    // Cloudflare rejects the default client signature on this endpoint.
    "User-Agent": "opencode/1.0",
  }, signal);
  if (!result.ok) return { kind: "error", message: httpMessage(result.status) };
  const windows = parseOpenCodeGoUsage(result.payload);
  return windows ? { kind: "ready", data: windows } : { kind: "error", message: "malformed response" };
}

function formatStatus(state: UsageState, anthropicCost: number | undefined): string {
  const codex = state.codex.kind === "ready"
    ? formatCodexStatus(state.codex.data)
    : state.codex.kind === "loading" ? "Codex …" : "Codex !";
  const go = state.go.kind === "ready"
    ? formatGoStatus(state.go.data)
    : state.go.kind === "loading" ? "Go …" : "Go !";
  const base = `${codex} │ ${go}`;
  return anthropicCost === undefined ? base : `${base} │ ${formatAnthropicStatus(anthropicCost)}`;
}

function formatWindowDetail(window: UsageWindow, now: number): string {
  const reset = formatCountdown(window.resetsAt, now);
  const limited = window.limited ? " rate limited" : "";
  return `${window.label} ${formatPercent(window.usedPercent)} used${reset ? ` · ${reset}` : ""}${limited}`;
}

function formatDetails(state: UsageState, anthropicCost: number, now = Date.now()): string {
  const lines = ["Usage"];
  const add = (title: string, state: ProviderState<UsageWindow[]>) => {
    if (state.kind === "loading") lines.push(`${title}: loading`);
    else if (state.kind === "ready") lines.push(`${title}: ${state.data.map((window) => formatWindowDetail(window, now)).join(" · ")}`);
    else lines.push(`${title}: ${state.message}`);
  };
  add("Codex", state.codex);
  add("Go", state.go);
  lines.push(formatAnthropicDetail(anthropicCost));
  return lines.join("\n");
}

export default function usageExtension(pi: ExtensionAPI): void {
  let alive = false;
  let state: UsageState = { ...INITIAL_STATE };
  let timer: ReturnType<typeof setInterval> | undefined;
  const lastFetch: Record<ProviderName, number> = { codex: 0, go: 0 };
  const inflight = new Map<ProviderName, { controller: AbortController; promise: Promise<void> }>();

  // このセッションで Anthropic に使った額（USD）。取得できなければ 0。
  // /tree で戻っても捨てた分岐の分は課金済みなので、今の分岐（getBranch）ではなく全エントリを合計する（pi 本体のフッターと同じ）
  const anthropicCost = (ctx: ExtensionContext): number => {
    try {
      return sumProviderCost(ctx.sessionManager.getEntries());
    } catch {
      return 0;
    }
  };

  const render = (ctx: ExtensionContext): void => {
    if (!alive || ctx.hasUI === false) return;
    const cost = ctx.model?.provider === "anthropic" ? anthropicCost(ctx) : undefined;
    ctx.ui.setStatus(STATUS_KEY, formatStatus(state, cost));
  };

  const refresh = async (ctx: ExtensionContext, force: boolean): Promise<void> => {
    if (!alive) return;
    const now = Date.now();
    const jobs: Array<Promise<void>> = [];

    const schedule = <T>(
      name: ProviderName,
      intervalMs: number,
      load: (ctx: ExtensionContext, signal: AbortSignal) => Promise<ProviderState<T>>,
    ): void => {
      // Timers can fire slightly early, so leave some slack to avoid skipping a cycle.
      if (!force && now - lastFetch[name] < intervalMs - TIMER_SLACK_MS) return;
      inflight.get(name)?.controller.abort();
      const controller = new AbortController();
      lastFetch[name] = now;
      const promise = load(ctx, controller.signal)
        .catch((): ProviderState<T> => ({ kind: "error", message: "internal error" }))
        .then((next) => {
          // A newer fetch for this provider or stop() replaces or clears the entry.
          if (!alive || inflight.get(name)?.controller !== controller) return;
          state = { ...state, [name]: next };
          render(ctx);
        })
        .finally(() => {
          if (inflight.get(name)?.controller === controller) inflight.delete(name);
        });
      inflight.set(name, { controller, promise });
      jobs.push(promise);
    };

    schedule("codex", FAST_REFRESH_MS, loadCodex);
    schedule("go", FAST_REFRESH_MS, loadGo);
    await Promise.all(jobs);
  };

  const stop = (): void => {
    if (timer !== undefined) {
      clearInterval(timer);
      timer = undefined;
    }
    for (const entry of inflight.values()) entry.controller.abort();
    inflight.clear();
  };

  pi.on("session_start", (_event, ctx) => {
    alive = true;
    state = { ...INITIAL_STATE };
    lastFetch.codex = 0;
    lastFetch.go = 0;
    render(ctx);
    refresh(ctx, true).catch(() => {});
    timer ??= setInterval(() => {
      refresh(ctx, false).catch(() => {});
    }, FAST_REFRESH_MS);
  });

  pi.on("agent_end", (_event, ctx) => {
    render(ctx);
    refresh(ctx, true).catch(() => {});
  });

  // message_end は pi がメッセージをセッションに保存する前に呼ばれるため、保存後に走る turn_end で再描画する
  pi.on("turn_end", (_event, ctx) => {
    render(ctx);
  });

  pi.on("model_select", (_event, ctx) => {
    render(ctx);
  });

  pi.on("session_shutdown", (_event, ctx) => {
    alive = false;
    stop();
    ctx.ui.setStatus(STATUS_KEY, undefined);
  });

  pi.registerCommand("usage", {
    description: "Show Codex, OpenCode Go and Anthropic usage",
    handler: async (_args, ctx) => {
      alive = true;
      await refresh(ctx, true);
      // A forced refresh from agent_end may replace our fetch, so wait until nothing is in flight.
      while (inflight.size > 0) {
        await Promise.all([...inflight.values()].map((entry) => entry.promise));
      }
      ctx.ui.notify(formatDetails(state, anthropicCost(ctx)), "info");
    },
  });
}
