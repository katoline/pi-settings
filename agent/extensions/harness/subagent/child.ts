import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { type AgentDef, isReadOnlyAgent } from "./agents.ts";

export interface ChildUsage {
  turns: number;
  input: number;
  output: number;
  cost: number;
}

export interface ChildResult {
  agent: string;
  title: string;
  model: string;
  /** 子の最後の返答(親に返す報告) */
  output: string;
  exitCode: number;
  stopReason?: string;
  errorMessage?: string;
  stderr: string;
  usage: ChildUsage;
  aborted: boolean;
  timedOut: boolean;
  /** 書き込み可の役割で動かした（読み取り専用ではない） */
  writable: boolean;
}

export const OUTPUT_CAP = 50 * 1024;

export interface ChildSpec {
  agent: AgentDef;
  task: string;
  title: string;
  model: string;
  /** 固定の指示と、拡張(ガード)の入口のパス */
  extensionPath: string;
  /** 役割の指示を書いた一時ファイル */
  roleFile: string | null;
  /** 作業ディレクトリ。いつも親の cwd（worktree は使わない） */
  cwd: string;
  parentSessionId?: string;
}

/**
 * 子プロセスの起動引数。
 * - 親の拡張は継承せず、ハーネスの拡張(ガードと固定の指示)だけを読み込む。再帰的な呼び出しと、
 *   ほかの拡張の影響を防ぐ(`--no-extensions` の後の `-e` は有効)。
 * - 会話は保存しない(`--no-session`)。標準入力は閉じるので、子はユーザーに質問できない。
 */
export function buildChildArgs(spec: ChildSpec): string[] {
  const args = [
    "--mode",
    "json",
    "-p",
    "--no-session",
    "--no-extensions",
    "-e",
    spec.extensionPath,
    "--no-mcp",
    "--no-skills",
    "--no-prompt-templates",
    "--model",
    spec.agent.model ?? spec.model,
  ];
  if (spec.agent.tools && spec.agent.tools.length > 0)
    args.push("--tools", spec.agent.tools.join(","));
  if (spec.roleFile) args.push("--append-system-prompt", spec.roleFile);
  args.push(`Task: ${spec.task}`);
  return args;
}

/** 子のプロセスの環境変数。ガードは、これで「サブエージェントである」ことを知る(モデルは書き換えられない) */
export function buildChildEnv(spec: ChildSpec, base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return {
    ...base,
    PI_SUBAGENT: "1",
    PI_SUBAGENT_ROLE: spec.agent.name,
    PI_SUBAGENT_MODEL: spec.agent.model ?? spec.model,
    ...(spec.parentSessionId ? { PI_HARNESS_PARENT_SESSION: spec.parentSessionId } : {}),
  };
}

/** `pi` を起動するコマンド。いま動いている Pi と同じものを使う(なければ PATH の pi) */
export function piInvocation(argv1: string | undefined = process.argv[1]): {
  command: string;
  prefix: string[];
} {
  if (argv1 && !argv1.startsWith("/$bunfs/") && existsSync(argv1)) {
    return { command: process.execPath, prefix: [argv1] };
  }
  const exec = path.basename(process.execPath).toLowerCase();
  if (/^(node|bun)(\.exe)?$/.test(exec)) return { command: "pi", prefix: [] };
  return { command: process.execPath, prefix: [] };
}

interface JsonEvent {
  type?: string;
  message?: {
    role?: string;
    content?: { type?: string; text?: string }[];
    stopReason?: string;
    errorMessage?: string;
    model?: string;
    usage?: { input?: number; output?: number; cost?: { total?: number } };
  };
}

export function emptyUsage(): ChildUsage {
  return { turns: 0, input: 0, output: 0, cost: 0 };
}

/** 子の JSON イベントを、結果に取り込む */
export function absorbEvent(result: ChildResult, event: JsonEvent): void {
  if (event.type !== "message_end" || !event.message || event.message.role !== "assistant") return;
  const msg = event.message;
  result.usage.turns++;
  result.usage.input += msg.usage?.input ?? 0;
  result.usage.output += msg.usage?.output ?? 0;
  result.usage.cost += msg.usage?.cost?.total ?? 0;
  if (msg.stopReason) result.stopReason = msg.stopReason;
  if (msg.errorMessage) result.errorMessage = msg.errorMessage;
  const text = (msg.content ?? [])
    .filter((b) => b.type === "text" && typeof b.text === "string")
    .map((b) => b.text as string)
    .join("\n")
    .trim();
  // 最後に、テキストを含むメッセージが、報告
  if (text) result.output = text;
}

export function isFailed(r: ChildResult): boolean {
  return (
    r.exitCode !== 0 ||
    r.aborted ||
    r.timedOut ||
    r.stopReason === "error" ||
    r.stopReason === "aborted"
  );
}

export interface RunOptions {
  invocation: { command: string; prefix: string[] };
  signal?: AbortSignal;
  timeoutMs: number;
  onProgress?: (r: ChildResult) => void;
  baseEnv?: NodeJS.ProcessEnv;
}

/** 子を動かす前の、空の結果 */
export function initialResult(spec: Pick<ChildSpec, "agent" | "title" | "model">): ChildResult {
  return {
    agent: spec.agent.name,
    title: spec.title,
    model: spec.agent.model ?? spec.model,
    output: "",
    exitCode: 0,
    stderr: "",
    usage: emptyUsage(),
    aborted: false,
    timedOut: false,
    writable: !isReadOnlyAgent(spec.agent),
  };
}

/** 起動する前に中断された依頼の結果(子は起動していない) */
export function abortedResult(spec: Pick<ChildSpec, "agent" | "title" | "model">): ChildResult {
  return { ...initialResult(spec), aborted: true };
}

export function runChild(spec: ChildSpec, options: RunOptions): Promise<ChildResult> {
  const result = initialResult(spec);
  return new Promise((resolve) => {
    const proc = spawn(
      options.invocation.command,
      [...options.invocation.prefix, ...buildChildArgs(spec)],
      {
        cwd: spec.cwd,
        env: buildChildEnv(spec, options.baseEnv ?? process.env),
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let buffer = "";
    const handleLine = (line: string) => {
      if (!line.trim()) return;
      try {
        absorbEvent(result, JSON.parse(line) as JsonEvent);
        options.onProgress?.(result);
      } catch {
        // JSON でない行は無視する
      }
    };
    proc.stdout.on("data", (data: Buffer) => {
      buffer += data.toString();
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) handleLine(line);
    });
    proc.stderr.on("data", (data: Buffer) => {
      if (result.stderr.length < 20000) result.stderr += data.toString();
    });

    const kill = () => {
      proc.kill("SIGTERM");
      setTimeout(() => {
        if (proc.exitCode === null) proc.kill("SIGKILL");
      }, 5000).unref();
    };
    const timer = setTimeout(() => {
      result.timedOut = true;
      kill();
    }, options.timeoutMs);
    const onAbort = () => {
      result.aborted = true;
      kill();
    };
    if (options.signal?.aborted) onAbort();
    else options.signal?.addEventListener("abort", onAbort, { once: true });

    proc.on("error", (error) => {
      clearTimeout(timer);
      result.exitCode = 1;
      result.stderr += String(error);
      resolve(result);
    });
    proc.on("close", (code) => {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
      if (buffer.trim()) handleLine(buffer);
      result.exitCode = code ?? 0;
      if (result.output.length > OUTPUT_CAP) {
        result.output = `${result.output.slice(0, OUTPUT_CAP)}\n\n[出力が上限(${OUTPUT_CAP} バイト)を超えたため、途中で切りました]`;
      }
      resolve(result);
    });
  });
}

/** 同時に動かす数を制限して、順序を保って結果を返す */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await fn(items[i] as T, i);
    }
  });
  await Promise.all(workers);
  return results;
}

/**
 * 読み取り専用の依頼は `limit` 件まで並列に、書き込み可の依頼は 1 件ずつ順番に動かす。
 * 読み取り専用の組と書き込み可の組は、互いに並行してよい。結果は元の順序で返す。
 */
export async function runScheduled<T, R>(
  items: readonly T[],
  limit: number,
  isReadOnly: (item: T) => boolean,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  const readIdx: number[] = [];
  const writeIdx: number[] = [];
  items.forEach((item, i) => {
    (isReadOnly(item) ? readIdx : writeIdx).push(i);
  });
  const run = (idx: number[], n: number) =>
    mapWithConcurrency(idx, n, async (i) => {
      results[i] = await fn(items[i] as T, i);
    });
  await Promise.all([run(readIdx, limit), run(writeIdx, 1)]);
  return results;
}

/** 書き込み可の役割の依頼が、1 件以上成功した（`subagent` ツールの結果の details から判定する） */
export function hasSuccessfulWrite(details: unknown): boolean {
  if (!Array.isArray(details)) return false;
  return details.some((r) => {
    const x = r as Partial<ChildResult> | null;
    return !!x && typeof x === "object" && x.writable === true && !isFailed(x as ChildResult);
  });
}

/**
 * セッションの枝(`sessionManager.getBranch()` のエントリ)に残るツールの結果から、起動したサブエージェントの
 * 件数と費用の合計を数え直す。対象は次の 2 つ。
 * - `subagent`: details が子の結果(`ChildResult`)の配列
 * - `harness_review`: 内部で reviewer を起動する。details の `children` が子の結果の配列
 * 断られた呼び出し(上限超過・未知の役割など)は子の結果が無いので数えない。
 */
export function subagentTotals(entries: readonly unknown[]): { spawns: number; cost: number } {
  let spawns = 0;
  let cost = 0;
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
    spawns += children.length;
    for (const r of children) {
      const c = (r as Partial<ChildResult> | null)?.usage?.cost;
      if (typeof c === "number" && Number.isFinite(c)) cost += c;
    }
  }
  return { spawns, cost };
}
