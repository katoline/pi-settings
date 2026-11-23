export const CODEX_FIVE_HOUR_SECONDS = 18_000;
export const CODEX_WEEK_SECONDS = 604_800;

export interface UsageWindow {
  id: "5h" | "7d" | "30d" | "other";
  label: string;
  /** 0-100, share already consumed. */
  usedPercent: number;
  resetsAt: number | null;
  limited: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function finiteNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value.trim());
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

export function clampPercent(value: number): number {
  return Math.min(100, Math.max(0, value));
}

export function parseResetAt(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value < 1e12 ? value * 1000 : value;
  }
  if (typeof value === "string" && value.trim()) {
    const trimmed = value.trim();
    if (/^-?\d+(?:\.\d+)?$/.test(trimmed)) return parseResetAt(Number(trimmed));
    const parsed = Date.parse(trimmed);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function windowId(seconds: number | undefined): UsageWindow["id"] {
  if (seconds === CODEX_FIVE_HOUR_SECONDS) return "5h";
  if (seconds === CODEX_WEEK_SECONDS) return "7d";
  if (seconds === 2_592_000) return "30d";
  return "other";
}

function windowLabel(seconds: number | undefined, id: UsageWindow["id"]): string {
  if (id !== "other") return id;
  if (seconds === undefined || seconds <= 0) return "?";
  if (seconds % 86_400 === 0) return `${seconds / 86_400}d`;
  if (seconds % 3600 === 0) return `${seconds / 3600}h`;
  return `${seconds}s`;
}

function parseCodexWindow(value: unknown, now: number): UsageWindow | undefined {
  if (!isRecord(value)) return undefined;
  const used = finiteNumber(value.used_percent);
  if (used === undefined) return undefined;
  const seconds = finiteNumber(value.limit_window_seconds);
  const id = windowId(seconds);
  let resetsAt = parseResetAt(value.reset_at);
  if (resetsAt === null) {
    const after = finiteNumber(value.reset_after_seconds);
    if (after !== undefined && after >= 0) resetsAt = now + after * 1000;
  }
  return {
    id,
    label: windowLabel(seconds, id),
    usedPercent: clampPercent(used),
    resetsAt,
    limited: false,
  };
}

/** Codex usage windows. 5h and weekly are identified by duration, not by primary/secondary order. */
export function parseCodexUsage(payload: unknown, now = Date.now()): UsageWindow[] | null {
  if (!isRecord(payload) || !isRecord(payload.rate_limit)) return null;
  const rateLimit = payload.rate_limit;
  const blocked = rateLimit.allowed === false || rateLimit.limit_reached === true;
  const parsed = [rateLimit.primary_window, rateLimit.secondary_window]
    .map((window) => parseCodexWindow(window, now))
    .filter((window): window is UsageWindow => window !== undefined);
  // Mark each window by its own usage. If blocked but no window reached 100%,
  // the cause is unknown, so mark every window.
  const anyFull = parsed.some((window) => window.usedPercent >= 100);
  const windows = parsed.map((window) => ({
    ...window,
    limited: window.usedPercent >= 100 || (blocked && !anyFull),
  }));
  return windows.length > 0 ? windows : null;
}

function parseGoWindow(
  value: unknown,
  id: Exclude<UsageWindow["id"], "other">,
): UsageWindow | undefined {
  if (!isRecord(value)) return undefined;
  const used = finiteNumber(value.percent);
  if (used === undefined) return undefined;
  const limited = value.status === "rate-limited";
  return {
    id,
    label: id,
    usedPercent: limited ? 100 : clampPercent(used),
    resetsAt: parseResetAt(value.resetsAt),
    limited,
  };
}

/** OpenCode Go used percentages for the rolling 5-hour, weekly, and monthly windows. */
export function parseOpenCodeGoUsage(payload: unknown): UsageWindow[] | null {
  if (!isRecord(payload) || !isRecord(payload.usage)) return null;
  const usage = payload.usage;
  const windows = [
    parseGoWindow(usage.rolling, "5h"),
    parseGoWindow(usage.weekly, "7d"),
    parseGoWindow(usage.monthly, "30d"),
  ].filter((window): window is UsageWindow => window !== undefined);
  return windows.length > 0 ? windows : null;
}

export function formatPercent(value: number): string {
  return `${Math.round(clampPercent(value))}%`;
}

export function formatCountdown(resetsAt: number | null, now = Date.now()): string {
  if (resetsAt === null || !Number.isFinite(resetsAt)) return "";
  const remaining = Math.max(0, resetsAt - now);
  if (remaining < 60_000) return "now";
  const totalMinutes = Math.ceil(remaining / 60_000);
  const days = Math.floor(totalMinutes / (24 * 60));
  const hours = Math.floor((totalMinutes % (24 * 60)) / 60);
  const minutes = totalMinutes % 60;
  if (days > 0) return `${days}d${hours}h`;
  if (hours > 0) return `${hours}h${minutes}m`;
  return `${minutes}m`;
}

function windowById(windows: UsageWindow[], id: UsageWindow["id"]): UsageWindow | undefined {
  return windows.find((window) => window.id === id);
}

function formatWindowSlot(window: UsageWindow | undefined, label: string): string {
  if (!window) return `${label} —`;
  return `${label} ${formatPercent(window.usedPercent)}${window.limited ? "!" : ""}`;
}

/**
 * Footer text for Codex. Shows 5h and weekly when either exists.
 * A plan with only another window, such as a 30-day free window, shows that window instead.
 */
export function formatCodexStatus(windows: UsageWindow[]): string {
  const fiveHour = windowById(windows, "5h");
  const weekly = windowById(windows, "7d");
  if (fiveHour || weekly) {
    return `Codex ${formatWindowSlot(fiveHour, "5h")} ${formatWindowSlot(weekly, "7d")}`;
  }
  if (windows.length === 0) return "Codex —";
  return `Codex ${windows.map((window) => formatWindowSlot(window, window.label)).join(" ")}`;
}

/**
 * セッションのエントリ列から、指定プロバイダーの assistant メッセージと usage エントリの
 * usage.cost.total（USD）を合計する。cost が無い・数値でないものは 0 として扱う。
 */
export function sumProviderCost(entries: readonly unknown[], provider = "anthropic"): number {
  let total = 0;
  for (const entry of entries) {
    if (!isRecord(entry)) continue;
    let holder: Record<string, unknown> | undefined;
    if (entry.type === "message" && isRecord(entry.message) && entry.message.role === "assistant") {
      holder = entry.message;
    } else if (entry.type === "usage") {
      holder = entry;
    }
    if (!holder || holder.provider !== provider) continue;
    const usage = holder.usage;
    const cost =
      isRecord(usage) && isRecord(usage.cost) ? finiteNumber(usage.cost.total) : undefined;
    if (cost !== undefined && cost > 0) total += cost;
  }
  return total;
}

/** USD 金額を $0.42 の形式（小数 2 桁、四捨五入）にする。 */
export function formatUsd(value: number): string {
  const safe = Number.isFinite(value) && value > 0 ? value : 0;
  return `$${safe.toFixed(2)}`;
}

export function formatAnthropicStatus(cost: number): string {
  return `Anthropic このセッション ${formatUsd(cost)}`;
}

/**
 * `/usage` の Anthropic の行。`cost` は、プロバイダーが anthropic のサブエージェントの費用（`subagentCost`）を含んだ額。
 * 同じ額がサブエージェントの行の内訳にも出るので、子の分があれば「うちサブエージェント」として示す（足すと二重になる）。
 */
export function formatAnthropicDetail(cost: number, subagentCost = 0): string {
  const children =
    Number.isFinite(subagentCost) && subagentCost > 0
      ? `うちサブエージェント ${formatUsd(subagentCost)}。`
      : "";
  return `Anthropic API: このセッション ${formatUsd(cost)}（${children}pi の見積もり。残高と請求額は Console で確認）`;
}

export function formatGoStatus(windows: UsageWindow[]): string {
  return `Go ${formatWindowSlot(windowById(windows, "5h"), "5h")} ${formatWindowSlot(windowById(windows, "7d"), "7d")} ${formatWindowSlot(windowById(windows, "30d"), "30d")}`;
}
