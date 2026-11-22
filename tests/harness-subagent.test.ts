import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  isReadOnlyAgent,
  loadAgents,
  parseAgentFile,
} from "../agent/extensions/harness/subagent/agents.ts";
import {
  absorbEvent,
  buildChildArgs,
  buildChildEnv,
  type ChildResult,
  type ChildSpec,
  emptyUsage,
  hasSuccessfulWrite,
  isFailed,
  mapWithConcurrency,
  runChild,
  runScheduled,
  subagentTotals,
} from "../agent/extensions/harness/subagent/child.ts";
import {
  doneLine,
  failLine,
  formatReport,
  startLine,
} from "../agent/extensions/harness/subagent/format.ts";
import { registerSubagent } from "../agent/extensions/harness/subagent/register.ts";
import { runtime } from "./harness-helpers.ts";

const agent = { name: "worker", description: "実装", instructions: "指示" };
const spec = (over: Partial<ChildSpec> = {}): ChildSpec => ({
  agent,
  task: "x を実装する",
  title: "x の実装",
  model: "opencode-go/deepseek-v4.1-flash",
  extensionPath: "/ext/index.ts",
  roleFile: "/tmp/role.md",
  cwd: "/work",
  ...over,
});
const tmp = mkdtempSync(path.join(os.tmpdir(), "harness-sub-test-"));

test("役割の定義(先頭部 + 本文)を読む", () => {
  const { meta, body } = parseAgentFile(
    "---\nname: scout\ndescription: 調査\ntools: read, grep\n---\n\n本文です\n",
  );
  assert.deepEqual(meta, { name: "scout", description: "調査", tools: "read, grep" });
  assert.equal(body, "本文です");
  assert.deepEqual(parseAgentFile("先頭部なし"), { meta: {}, body: "先頭部なし" });
});

test("役割のディレクトリを読む(name と description がないものは除く)", () => {
  const dir = path.join(tmp, "agents");
  const fs = dir;
  mkdirSync(fs, { recursive: true });
  writeFileSync(
    path.join(fs, "a.md"),
    "---\nname: a\ndescription: A\ntools: read, ls\n---\nA の指示",
  );
  writeFileSync(path.join(fs, "b.md"), "---\nname: b\n---\nB");
  writeFileSync(path.join(fs, "c.txt"), "無視");
  const agents = loadAgents(fs);
  assert.deepEqual(
    agents.map((x) => x.name),
    ["a"],
  );
  assert.deepEqual(agents[0]?.tools, ["read", "ls"]);
  assert.equal(agents[0]?.instructions, "A の指示");
  assert.deepEqual(loadAgents(path.join(tmp, "nope")), []);
});

test("子の起動引数: ハーネスの拡張だけを読み込み、会話は保存しない", () => {
  const args = buildChildArgs(spec());
  assert.deepEqual(args.slice(0, 8), [
    "--mode",
    "json",
    "-p",
    "--no-session",
    "--no-extensions",
    "-e",
    "/ext/index.ts",
    "--no-mcp",
  ]);
  assert.ok(args.includes("--no-skills") && args.includes("--no-prompt-templates"));
  assert.equal(args[args.indexOf("--model") + 1], "opencode-go/deepseek-v4.1-flash");
  assert.equal(args[args.indexOf("--append-system-prompt") + 1], "/tmp/role.md");
  assert.equal(args.at(-1), "Task: x を実装する");
  assert.ok(!args.includes("--tools"));
});

test("子の起動引数: 役割のツール制限と、役割のモデル指定", () => {
  const args = buildChildArgs(
    spec({ agent: { ...agent, tools: ["read", "grep"], model: "anthropic/claude-haiku-5-5" } }),
  );
  assert.equal(args[args.indexOf("--tools") + 1], "read,grep");
  assert.equal(args[args.indexOf("--model") + 1], "anthropic/claude-haiku-5-5");
});

test("子の環境変数: PI_SUBAGENT=1 と役割を渡す", () => {
  const env = buildChildEnv(spec({ parentSessionId: "s1" }), { PATH: "/bin", PI_SUBAGENT: "0" });
  assert.equal(env.PI_SUBAGENT, "1");
  assert.equal(env.PI_SUBAGENT_ROLE, "worker");
  assert.equal(env.PI_HARNESS_PARENT_SESSION, "s1");
  assert.equal(env.PATH, "/bin");
});

function blank(): ChildResult {
  return {
    agent: "a",
    title: "t",
    model: "m",
    output: "",
    exitCode: 0,
    stderr: "",
    usage: emptyUsage(),
    aborted: false,
    timedOut: false,
    writable: false,
  };
}

test("JSON イベントから、最後の報告と使用量を取り出す", () => {
  const r = blank();
  absorbEvent(r, {
    type: "message_end",
    message: {
      role: "assistant",
      content: [{ type: "text", text: "途中" }],
      usage: { input: 10, output: 2, cost: { total: 0.01 } },
    },
  });
  absorbEvent(r, {
    type: "message_end",
    message: { role: "user", content: [{ type: "text", text: "無視" }] },
  });
  absorbEvent(r, {
    type: "message_end",
    message: {
      role: "assistant",
      content: [{ type: "text", text: "最終報告" }],
      stopReason: "stop",
      usage: { input: 5, output: 3, cost: { total: 0.02 } },
    },
  });
  absorbEvent(r, { type: "message_update" });
  assert.equal(r.output, "最終報告");
  assert.deepEqual(r.usage, { turns: 2, input: 15, output: 5, cost: 0.03 });
  assert.equal(isFailed(r), false);
});

test("テキストのない最後のメッセージ(ツール呼び出し)は、報告を上書きしない", () => {
  const r = blank();
  absorbEvent(r, {
    type: "message_end",
    message: { role: "assistant", content: [{ type: "text", text: "報告" }] },
  });
  absorbEvent(r, {
    type: "message_end",
    message: { role: "assistant", content: [{ type: "toolCall" }] },
  });
  assert.equal(r.output, "報告");
});

test("失敗の判定", () => {
  assert.equal(isFailed({ ...blank(), exitCode: 1 }), true);
  assert.equal(isFailed({ ...blank(), stopReason: "error" }), true);
  assert.equal(isFailed({ ...blank(), timedOut: true }), true);
  assert.equal(isFailed({ ...blank(), aborted: true }), true);
});

test("表示の文言", () => {
  assert.equal(
    startLine("opencode-go/deepseek-v4.1-flash", "認証の調査"),
    "⏳ サブエージェント（opencode-go/deepseek-v4.1-flash）で認証の調査を実行中",
  );
  assert.equal(doneLine("認証の調査"), "✅ 認証の調査が完了");
  assert.match(failLine("認証の調査", "時間切れ"), /^❌ 認証の調査が失敗/);
  const report = formatReport([
    { ...blank(), agent: "scout", title: "調査", output: "結果" },
    { ...blank(), title: "実装", exitCode: 1 },
  ]);
  assert.match(report, /1\/2 件が完了/);
  assert.match(report, /結果/);
});

test("同時実行数を制限し、順序を保つ", async () => {
  let active = 0;
  let peak = 0;
  const out = await mapWithConcurrency([1, 2, 3, 4, 5, 6], 2, async (n) => {
    active++;
    peak = Math.max(peak, active);
    await new Promise((r) => setTimeout(r, 5 * (7 - n)));
    active--;
    return n * 10;
  });
  assert.deepEqual(out, [10, 20, 30, 40, 50, 60]);
  assert.ok(peak <= 2);
});

function fakeChild(body: string) {
  const file = path.join(tmp, `fake-${Math.random().toString(36).slice(2)}.mjs`);
  writeFileSync(file, body);
  return { command: process.execPath, prefix: [file] };
}

test("子プロセスを実行して、報告・使用量・環境変数を受け取る", async () => {
  const invocation = fakeChild(`
    const ev = (m) => console.log(JSON.stringify({ type: "message_end", message: m }));
    ev({ role: "assistant", content: [{ type: "text", text: "ENV=" + process.env.PI_SUBAGENT + ":" + process.env.PI_SUBAGENT_ROLE }],
         usage: { input: 10, output: 5, cost: { total: 0.01 } }, stopReason: "stop" });
  `);
  const r = await runChild(spec({ cwd: tmp }), { invocation, timeoutMs: 10_000 });
  assert.equal(r.output, "ENV=1:worker");
  assert.equal(r.exitCode, 0);
  assert.equal(r.usage.cost, 0.01);
  assert.equal(isFailed(r), false);
});

test("子プロセスが失敗したら、失敗として返す", async () => {
  const invocation = fakeChild("console.error('boom'); process.exit(3);");
  const r = await runChild(spec({ cwd: tmp }), { invocation, timeoutMs: 10_000 });
  assert.equal(r.exitCode, 3);
  assert.match(r.stderr, /boom/);
  assert.equal(isFailed(r), true);
});

test("時間切れで止める", async () => {
  const invocation = fakeChild("setTimeout(() => {}, 60000);");
  const r = await runChild(spec({ cwd: tmp }), { invocation, timeoutMs: 200 });
  assert.equal(r.timedOut, true);
  assert.equal(isFailed(r), true);
});

test("中断(abort)で止める", async () => {
  const invocation = fakeChild("setTimeout(() => {}, 60000);");
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 100);
  const r = await runChild(spec({ cwd: tmp }), {
    invocation,
    timeoutMs: 30_000,
    signal: controller.signal,
  });
  assert.equal(r.aborted, true);
});

test("読み取り専用の役割の判定: tools が指定され、全部が read・grep・find・ls の中にあるときだけ", () => {
  assert.equal(isReadOnlyAgent({ tools: ["read", "grep", "find", "ls"] }), true);
  assert.equal(isReadOnlyAgent({ tools: ["read"] }), true);
  assert.equal(isReadOnlyAgent({}), false); // 未指定 = 既定のツール(書き込みを含む)
  assert.equal(isReadOnlyAgent({ tools: [] }), false);
  assert.equal(isReadOnlyAgent({ tools: ["read", "bash"] }), false);
  assert.equal(isReadOnlyAgent({ tools: ["write"] }), false);
  assert.equal(isReadOnlyAgent({ tools: ["read", "edit"] }), false);
});

test("同梱の役割: scout・planner・reviewer は読み取り専用、worker は書き込み可", () => {
  const agents = loadAgents(path.join(import.meta.dirname, "..", "agent", "agents"));
  const ro = Object.fromEntries(agents.map((a) => [a.name, isReadOnlyAgent(a)]));
  assert.deepEqual(ro, { planner: true, reviewer: true, scout: true, worker: false });
});

test("書き込み可は 1 件ずつ、読み取り専用は上限まで並列、両者は並行し、結果は元の順序", async () => {
  type Item = { id: number; ro: boolean };
  const items: Item[] = [
    { id: 0, ro: false },
    { id: 1, ro: true },
    { id: 2, ro: false },
    { id: 3, ro: true },
    { id: 4, ro: true },
    { id: 5, ro: true },
    { id: 6, ro: false },
  ];
  let activeRo = 0;
  let activeW = 0;
  let peakRo = 0;
  let peakW = 0;
  let both = false;
  const wOrder: number[] = [];
  const out = await runScheduled(
    items,
    2,
    (i) => i.ro,
    async (i) => {
      if (i.ro) peakRo = Math.max(peakRo, ++activeRo);
      else {
        peakW = Math.max(peakW, ++activeW);
        wOrder.push(i.id);
      }
      if (activeRo > 0 && activeW > 0) both = true;
      await new Promise((r) => setTimeout(r, 15));
      if (i.ro) activeRo--;
      else activeW--;
      return i.id * 10;
    },
  );
  assert.deepEqual(out, [0, 10, 20, 30, 40, 50, 60]);
  assert.equal(peakW, 1);
  assert.equal(peakRo, 2);
  assert.ok(both, "読み取り専用と書き込み可は並行してよい");
  assert.deepEqual(wOrder, [0, 2, 6]); // 書き込み可は、渡した順に 1 件ずつ
});

test("書き込み可の成功の判定", () => {
  const w = { ...blank(), writable: true };
  assert.equal(hasSuccessfulWrite([w]), true);
  assert.equal(hasSuccessfulWrite([{ ...blank() }, w]), true);
  assert.equal(hasSuccessfulWrite([{ ...w, exitCode: 1 }]), false);
  assert.equal(hasSuccessfulWrite([{ ...w, timedOut: true }]), false);
  assert.equal(hasSuccessfulWrite([{ ...w, stopReason: "error" }]), false);
  assert.equal(hasSuccessfulWrite([blank()]), false); // 読み取り専用だけ
  assert.equal(hasSuccessfulWrite(undefined), false);
  assert.equal(hasSuccessfulWrite("x"), false);
  assert.equal(hasSuccessfulWrite([null]), false);
});

test("子のプロセスの結果に、書き込み可かどうかが入る", async () => {
  const invocation = fakeChild("process.exit(0);");
  const ro = { ...agent, tools: ["read", "ls"] };
  assert.equal(
    (await runChild(spec({ cwd: tmp }), { invocation, timeoutMs: 10_000 })).writable,
    true,
  );
  assert.equal(
    (await runChild(spec({ cwd: tmp, agent: ro }), { invocation, timeoutMs: 10_000 })).writable,
    false,
  );
});

interface RegisteredTool {
  name: string;
  description: string;
  parameters: { properties: { tasks: { items: { properties: Record<string, unknown> } } } };
  execute: (...a: unknown[]) => Promise<{ content: { text: string }[]; details: unknown }>;
}

function register(over: Parameters<typeof runtime>[0] = {}) {
  const agentDir = path.join(tmp, `agentdir-${Math.random().toString(36).slice(2)}`);
  mkdirSync(path.join(agentDir, "agents"), { recursive: true });
  writeFileSync(
    path.join(agentDir, "agents", "scout.md"),
    "---\nname: scout\ndescription: 調査\ntools: read, grep, find, ls\n---\n調査",
  );
  writeFileSync(
    path.join(agentDir, "agents", "worker.md"),
    "---\nname: worker\ndescription: 実装\n---\n実装",
  );
  const tools: RegisteredTool[] = [];
  const handlers = new Map<string, Handler>();
  const pi = {
    registerTool: (t: RegisteredTool) => tools.push(t),
    on: (name: string, h: Handler) => handlers.set(name, h),
  } as unknown as ExtensionAPI;
  const rt = runtime({ agentDir, ...over });
  registerSubagent(pi, rt);
  const notified: string[] = [];
  const ctx = {
    cwd: tmp,
    ui: { setWidget: () => {}, notify: (text: string) => notified.push(text) },
    sessionManager: { getSessionId: () => "s" },
  };
  const run = (tasks: unknown[], signal?: AbortSignal) =>
    tools[0]?.execute("id", { tasks }, signal, undefined, ctx) as Promise<{
      content: { text: string }[];
      details: unknown;
    }>;
  /** セッションのイベントを、枝 `branch` で呼ぶ */
  const emit = (name: string, branch: unknown[]) =>
    (handlers.get(name) as Handler)({}, { sessionManager: { getBranch: () => branch } });
  return { tools, rt, run, emit, notified };
}

type Handler = (event: object, ctx: object) => Promise<unknown>;

const task = (agent: string) => ({ agent, title: "t", task: "x" });

test("subagent ツール: 子では登録しない。cwd の引数は無く、説明に直列化と役割の種別を書く", () => {
  assert.equal(register({ isSubagent: true }).tools.length, 0);
  const { tools } = register();
  const tool = tools[0];
  assert.equal(tool?.name, "subagent");
  assert.deepEqual(Object.keys(tool?.parameters.properties.tasks.items.properties ?? {}).sort(), [
    "agent",
    "task",
    "title",
  ]);
  assert.match(tool?.description ?? "", /1 件ずつ順番/);
  assert.match(tool?.description ?? "", /同じファイルを編集させる複数の依頼を渡さない/);
  assert.match(tool?.description ?? "", /worker\(実装。書き込み可\)/);
  assert.match(tool?.description ?? "", /scout\(調査\)/);
});

test("subagent ツール: 未知の役割・件数の上限・セッションの合計の上限は、子を起動せずに断る", async () => {
  const a = register();
  assert.match((await a.run([task("nobody")]))?.content[0]?.text ?? "", /未知の役割: nobody/);
  assert.equal(a.rt.subagentSpawns, 0);

  const b = register();
  const nine = Array.from({ length: 9 }, () => task("scout"));
  assert.match((await b.run(nine))?.content[0]?.text ?? "", /一度に任せられるのは 8 件まで/);

  const c = register({ subagentSpawns: 63 });
  assert.match((await c.run([task("scout"), task("scout")]))?.content[0]?.text ?? "", /上限\(64\)/);
  assert.equal(c.rt.subagentSpawns, 63);
});

test("subagent ツール: 件数の上限(maxItems)は、登録時の設定 maxTasks から作る", () => {
  const schema = (t: RegisteredTool | undefined) =>
    (t?.parameters.properties.tasks as { maxItems?: number } | undefined)?.maxItems;
  assert.equal(schema(register().tools[0]), 8);
  const { config } = runtime();
  const three = register({ config: { ...config, subagent: { ...config.subagent, maxTasks: 3 } } });
  assert.equal(schema(three.tools[0]), 3);
});

test("subagent ツール: 中断済みなら、子を起動せず、通知もせずに、中断の結果を返す", async () => {
  const s = register();
  const controller = new AbortController();
  controller.abort();
  const r = await s.run([task("scout"), task("worker")], controller.signal);
  const details = r.details as ChildResult[];
  assert.equal(details.length, 2);
  assert.ok(details.every((d) => d.aborted && d.usage.turns === 0 && d.output === ""));
  assert.deepEqual(
    details.map((d) => d.agent),
    ["scout", "worker"],
  );
  assert.deepEqual(s.notified, []);
  assert.match(r.content[0]?.text ?? "", /0\/2 件が完了/);
  assert.match(r.content[0]?.text ?? "", /中断/);
});

const toolResult = (toolName: string, details: unknown) => ({
  type: "message",
  message: { role: "toolResult", toolName, content: [], details, isError: false },
});
const withCost = (cost: number): ChildResult => ({ ...blank(), usage: { ...emptyUsage(), cost } });

test("セッションの枝から、サブエージェントの件数と費用を数え直す", () => {
  const entries = [
    { type: "message", message: { role: "user", content: "x" } },
    toolResult("subagent", [withCost(0.01), withCost(0.02)]),
    toolResult("subagent", undefined), // 断られた呼び出し(details が無い)は数えない
    toolResult("bash", [withCost(9)]), // ほかのツールは数えない
    { type: "custom", customType: "subagent", data: [withCost(9)] },
    toolResult("subagent", [withCost(0.03), { ...blank(), usage: undefined }, null]),
  ];
  const t = subagentTotals(entries);
  assert.equal(t.spawns, 5);
  assert.ok(Math.abs(t.cost - 0.06) < 1e-9);
  assert.deepEqual(subagentTotals([]), { spawns: 0, cost: 0 });
});

test("harness_review の結果（details.children）も、件数と費用に数え直す", () => {
  const entries = [
    toolResult("subagent", [withCost(0.01)]),
    toolResult("harness_review", { verdict: "approved", children: [withCost(0.02)] }),
    toolResult("harness_review", { verdict: "none", children: [withCost(0.03), withCost(0.04)] }),
    toolResult("harness_review", undefined), // 断られた・差分なし（details が無い）は数えない
    toolResult("harness_review", { verdict: "none" }), // children が無い
    toolResult("harness_review", [withCost(9)]), // 配列の details は subagent の形式。数えない
  ];
  const t = subagentTotals(entries);
  assert.equal(t.spawns, 4);
  assert.ok(Math.abs(t.cost - 0.1) < 1e-9);
});

test("subagent ツール: 件数と費用は、session_start・session_tree で枝から戻す", async () => {
  const s = register({ subagentSpawns: 40, childCost: 5 });
  await s.emit("session_start", [toolResult("subagent", [withCost(0.5), withCost(0.25)])]);
  assert.equal(s.rt.subagentSpawns, 2);
  assert.equal(s.rt.childCost, 0.75);
  await s.emit("session_tree", []);
  assert.equal(s.rt.subagentSpawns, 0);
  assert.equal(s.rt.childCost, 0);
});
