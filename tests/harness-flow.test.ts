import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  type ItemInput,
  type Plan,
  pausePlan,
  proposePlan,
} from "../agent/extensions/harness/flow/plan.ts";
import { type FlowDeps, registerFlow } from "../agent/extensions/harness/flow/register.ts";
import type { Runtime } from "../agent/extensions/harness/lib/runtime.ts";
import { FINAL_LINE } from "../agent/extensions/harness/output/final-line.ts";
import { registerOutput } from "../agent/extensions/harness/output/register.ts";
import type { ChildResult } from "../agent/extensions/harness/subagent/child.ts";
import type { RunOutcome } from "../agent/extensions/harness/subagent/run.ts";
import { config, runtime } from "./harness-helpers.ts";

// registerFlow のハンドラ・ツール・コマンドを、偽物の pi と ctx で直接呼ぶ。
// 完了の合図（registerOutput）も同じ偽物に登録して、計画の状態とのつながりを確かめる

type Handler = (event: object, ctx: object) => Promise<unknown>;
type ToolResult = { content: { type: string; text: string }[]; details?: unknown };
interface Tool {
  name: string;
  execute: (
    id: string,
    params: object,
    signal: AbortSignal | undefined,
    onUpdate: undefined,
    ctx: object,
  ) => Promise<ToolResult>;
}
type Command = { handler: (args: string, ctx: object) => Promise<void> };
type Settle = { continue?: boolean; entries?: { customType?: string; content?: string }[] };

const tmp = mkdtempSync(path.join(os.tmpdir(), "harness-flow-test-"));

const ITEMS: ItemInput[] = [
  { id: "a", title: "A", acceptance: "テストが通る" },
  { id: "b", title: "B", acceptance: "README に書く", kind: "task" },
];

function confirmed(items = ITEMS): Plan {
  const r = proposePlan("目的", items, Date.now());
  assert.ok(r.ok);
  return { ...r.value, confirmed: true };
}

/** すべての項目が済んだ（a は保留、b は完了）計画 */
function completed(): Plan {
  const p = confirmed();
  return {
    ...p,
    items: p.items.map((i) =>
      i.id === "a"
        ? { ...i, status: "deferred" as const, reason: "sudo が必要" }
        : { ...i, status: "done" as const, evidence: "README.md:1" },
    ),
  };
}

const child = (over: Partial<ChildResult> = {}): ChildResult => ({
  agent: "reviewer",
  title: "独立レビュー",
  model: "m",
  output: "",
  exitCode: 0,
  stderr: "",
  usage: { turns: 1, input: 0, output: 0, cost: 0 },
  aborted: false,
  timedOut: false,
  writable: false,
  ...over,
});

interface SetupOptions {
  rt?: Partial<Runtime>;
  /** select の答え（plan_propose の確認） */
  answer?: string;
  /** 検証のコマンドの結果（コマンドごと） */
  bash?: (command: string, signal?: AbortSignal) => { isError: boolean; text: string };
  /** 作業ディレクトリに置くファイル */
  files?: Record<string, string>;
  /** git のリポジトリとして振る舞う（harness_review の差分を作る） */
  repo?: boolean;
  /** `git ls-files --error-unmatch flake.nix` が成功する（repo のときだけ） */
  flakeTracked?: boolean;
  review?: (signal?: AbortSignal) => RunOutcome;
  nix?: boolean;
}

function setup(o: SetupOptions = {}) {
  const cwd = mkdtempSync(path.join(tmp, "cwd-"));
  const agentDir = mkdtempSync(path.join(tmp, "agent-"));
  for (const [f, body] of Object.entries(o.files ?? {})) writeFileSync(path.join(cwd, f), body);

  const handlers = new Map<string, Handler[]>();
  const tools = new Map<string, Tool>();
  const commands = new Map<string, Command>();
  const appended: { type: string; data: unknown }[] = [];
  const sent: { message: { customType: string; content: string }; options: unknown }[] = [];
  let active = ["read", "bash", "edit", "write", "ask_user"];
  const pi = {
    on: (name: string, h: Handler) => handlers.set(name, [...(handlers.get(name) ?? []), h]),
    registerTool: (t: Tool) => tools.set(t.name, t),
    registerCommand: (name: string, c: Command) => commands.set(name, c),
    getActiveTools: () => active,
    setActiveTools: (names: string[]) => {
      active = names;
    },
    appendEntry: (type: string, data: unknown) => appended.push({ type, data }),
    sendMessage: (message: { customType: string; content: string }, options: unknown) =>
      sent.push({ message, options }),
    exec: async (cmd: string, args: string[]) => {
      if (cmd !== "git" || !o.repo) return { code: 1, stdout: "", stderr: "" };
      const a = args.join(" ");
      if (a === "rev-parse --show-toplevel") return { code: 0, stdout: `${cwd}\n`, stderr: "" };
      if (a.startsWith("diff --stat")) return { code: 0, stdout: " a.ts | 1 +\n", stderr: "" };
      if (a.startsWith("diff ")) return { code: 0, stdout: "+const x = 1;\n", stderr: "" };
      if (a === "ls-files --error-unmatch flake.nix")
        return { code: o.flakeTracked ? 0 : 1, stdout: "", stderr: "" };
      if (a.startsWith("ls-files")) return { code: 0, stdout: "", stderr: "" };
      return { code: 1, stdout: "", stderr: "" };
    },
  } as unknown as ExtensionAPI;

  const rt = runtime({ agentDir, ...o.rt });
  const reviewTasks: string[] = [];
  const deps: FlowDeps = {
    nixOnPath: () => o.nix ?? false,
    runTasks: async (_rt, tasks, _ctx, signal) => {
      reviewTasks.push(...tasks.map((t) => t.task));
      return o.review?.(signal) ?? { kind: "ran", text: "", results: [child()] };
    },
  };
  registerOutput(pi, rt);
  registerFlow(pi, rt, deps);

  const notes: { text: string; level: string }[] = [];
  const selects: string[] = [];
  const executed: string[] = [];
  /** セッションの枝: 保存したエントリ（appendEntry）を、そのまま並べる */
  const branch = () => appended.map((e) => ({ type: "custom", customType: e.type, data: e.data }));
  const ctx = {
    hasUI: true,
    cwd,
    ui: {
      select: async (title: string) => {
        selects.push(title);
        return o.answer ?? "確定する";
      },
      input: async () => undefined,
      notify: (text: string, level: string) => notes.push({ text, level }),
      setStatus: () => {},
      setWidget: () => {},
    },
    sessionManager: { getBranch: branch, getSessionId: () => "s" },
    executeTool: async (
      _name: string,
      args: { command: string },
      opts?: { signal?: AbortSignal },
    ) => {
      executed.push(args.command);
      const r = o.bash?.(args.command, opts?.signal) ?? { isError: false, text: "ok" };
      return { isError: r.isError, result: { content: [{ type: "text", text: r.text }] } };
    },
  };

  const emit = async (name: string, event: object) => {
    let last: unknown;
    for (const h of handlers.get(name) ?? []) {
      const r = await h(event, ctx);
      if (r !== undefined) last = r;
    }
    return last;
  };
  const tool = (name: string, params: object = {}, signal?: AbortSignal) => {
    const t = tools.get(name);
    assert.ok(t, name);
    return t.execute("id", params, signal, undefined, ctx);
  };
  const toolText = async (name: string, params: object = {}, signal?: AbortSignal) =>
    (await tool(name, params, signal)).content.map((c) => c.text).join("\n");
  const command = (name: string, args: string) =>
    (commands.get(name) as Command).handler(args, ctx);
  /** ユーザーの依頼で実行が始まる */
  const start = () => emit("before_agent_start", { messageType: "user", prompt: "依頼" });
  const settle = (outcome = "completed") =>
    emit("agent_before_settle", { outcome, entries: [] }) as Promise<Settle | undefined>;
  /** 成果物を作る操作（write）の成功を、完了の合図の判定に流す */
  let seq = 0;
  const write = async () => {
    const toolCallId = `w${++seq}`;
    await emit("tool_execution_start", { toolCallId, toolName: "write", args: {} });
    await emit("tool_execution_end", { toolCallId, toolName: "write", isError: false });
  };
  /** 最終応答。完了の合図が付いたか */
  const finalLineAdded = async () => {
    const r = (await emit("message_end", {
      message: { role: "assistant", content: [{ type: "text", text: "報告" }], stopReason: "stop" },
    })) as { message: { content: { text: string }[] } } | undefined;
    return r?.message.content.at(-1)?.text.endsWith(FINAL_LINE) ?? false;
  };
  const lastSaved = () =>
    appended.filter((e) => e.type === "harness-plan").at(-1)?.data as Plan | null | undefined;
  return {
    rt,
    ctx,
    emit,
    tool,
    toolText,
    command,
    start,
    settle,
    write,
    finalLineAdded,
    lastSaved,
    appended,
    sent,
    notes,
    selects,
    executed,
    agentDir,
    reviewTasks,
    hasAskUser: () => active.includes("ask_user"),
    /** 保存済みの計画として枝に置き、session_start で復元する（ツール一覧も決め直す） */
    restoreWith: async (plan: Plan) => {
      appended.push({ type: "harness-plan", data: plan });
      await emit("session_start", { reason: "resume" });
    },
  };
}

// ---- 1. 完了報告は 1 回だけ（報告済みを計画に保存する）----

test("完了報告: plan_report で報告済みを保存し、次の依頼・再開のあとも完了の促しを出さない", async () => {
  const h = setup({ rt: { plan: completed() } });
  await h.start();
  const report = await h.toolText("plan_report");
  assert.match(report, /# 完了報告: 目的/);
  assert.equal(h.lastSaved()?.reported, true);
  assert.equal(h.rt.plan?.reported, true);
  // 報告した依頼の最終応答には、合図が付く
  assert.equal(await h.finalLineAdded(), true);
  assert.equal(await h.settle(), undefined);

  // 次の依頼（「ありがとう」）: 促さない。合図も付かない
  await h.start();
  assert.equal(await h.settle(), undefined);
  assert.equal(await h.finalLineAdded(), false);

  // 再開（session_start）・ツリーの移動（session_tree）: 保存から戻し、促さない
  await h.emit("session_start", { reason: "resume" });
  assert.equal(h.rt.plan?.reported, true);
  await h.start();
  assert.equal(await h.settle(), undefined);
  await h.emit("session_tree", {});
  await h.start();
  assert.equal(await h.settle(), undefined);
});

test("完了報告: 完了していて未報告なら 1 回だけ促し、無視されても繰り返さない", async () => {
  const h = setup({ rt: { plan: completed() } });
  await h.start();
  const first = await h.settle();
  assert.equal(first?.continue, true);
  assert.equal(first?.entries?.at(-1)?.customType, "harness-complete");
  assert.equal(await h.settle(), undefined);
  await h.start();
  assert.equal(await h.settle(), undefined);
  // 報告していなければ、合図の「計画の完了」にはならない
  assert.equal(await h.finalLineAdded(), false);
});

test("完了報告: 項目が残っていれば断り、報告済みにしない", async () => {
  const h = setup({ rt: { plan: confirmed() } });
  assert.match(await h.toolText("plan_report"), /未着手・進行中の項目が残っています/);
  assert.equal(h.rt.plan?.reported, undefined);
  assert.equal(h.rt.planCompleted, false);
});

// ---- 2・3. 差し戻しの数え方（harness_verify・harness_review から）----

const pkg = { "package.json": '{"scripts":{"check":"biome check ."}}' };

test("harness_verify: 失敗は差し戻しに数える。進行中の項目が無ければ、次に取り組む項目に数える", async () => {
  const h = setup({
    rt: { plan: confirmed() },
    files: pkg,
    bash: () => ({ isError: true, text: "落ちた" }),
  });
  const msg = await h.toolText("harness_verify");
  assert.match(msg, /検証に失敗しました/);
  assert.deepEqual(h.executed, ["npm run check"]);
  const p = h.lastSaved();
  assert.equal(p?.verifications.at(-1)?.ok, false);
  assert.deepEqual(
    p?.items.map((i) => i.cycles),
    [1, 0],
  );
  // 累計 3 回で未完了にして、次へ進む
  await h.toolText("harness_verify");
  const third = await h.toolText("harness_verify");
  assert.match(third, /項目 a は、3 周で収まらなかったため、未完了にしました/);
  assert.equal(h.rt.plan?.items[0]?.status, "unfinished");
});

test("harness_verify: 成功は差し戻しに数えない", async () => {
  const h = setup({ rt: { plan: confirmed() }, files: pkg });
  assert.match(await h.toolText("harness_verify"), /検証に成功しました/);
  assert.equal(h.rt.plan?.verifications.at(-1)?.ok, true);
  assert.deepEqual(
    h.rt.plan?.items.map((i) => i.cycles),
    [0, 0],
  );
});

test("harness_verify: 中断は記録するが、成功にも差し戻しにもしない", async () => {
  // 実行前に中断済み: コマンドを実行しない
  const before = setup({ rt: { plan: confirmed() }, files: pkg });
  const ac = new AbortController();
  ac.abort();
  assert.match(await before.toolText("harness_verify", {}, ac.signal), /中断されました/);
  assert.deepEqual(before.executed, []);
  const v = before.rt.plan?.verifications.at(-1);
  assert.equal(v?.ok, false);
  assert.equal(v?.aborted, true);
  assert.deepEqual(
    before.rt.plan?.items.map((i) => i.cycles),
    [0, 0],
  );

  // 実行中に中断（コマンドは中断のエラーで返る）
  const during = new AbortController();
  const h = setup({
    rt: { plan: confirmed() },
    files: pkg,
    bash: () => {
      during.abort();
      return { isError: true, text: "aborted" };
    },
  });
  await h.toolText("harness_verify", {}, during.signal);
  assert.equal(h.rt.plan?.verifications.at(-1)?.aborted, true);
  assert.equal(h.rt.plan?.items[0]?.cycles, 0);
});

test("harness_verify: verify.json が無く、追跡済みの flake.nix と nix があれば nix develop -c で実行する", async () => {
  const flake = { ...pkg, "flake.nix": "{}" };
  const h = setup({
    rt: { plan: confirmed() },
    files: flake,
    nix: true,
    repo: true,
    flakeTracked: true,
  });
  await h.toolText("harness_verify");
  assert.deepEqual(h.executed, ["nix develop -c npm run check"]);
  // 追跡されていない flake.nix・git の外では包まない
  const untracked = setup({ files: flake, nix: true, repo: true, flakeTracked: false });
  await untracked.toolText("harness_verify");
  assert.deepEqual(untracked.executed, ["npm run check"]);
  const outside = setup({ files: flake, nix: true });
  await outside.toolText("harness_verify");
  assert.deepEqual(outside.executed, ["npm run check"]);
  // verify.json に書かれたコマンドは、そのまま実行する
  const explicit = setup({ files: flake, nix: true, repo: true, flakeTracked: true });
  mkdirSync(path.join(explicit.ctx.cwd, ".harness"));
  writeFileSync(
    path.join(explicit.ctx.cwd, ".harness", "verify.json"),
    '{"commands":["make check"]}',
  );
  await explicit.toolText("harness_verify");
  assert.deepEqual(explicit.executed, ["make check"]);
});

const ran = (...results: ChildResult[]): RunOutcome => ({ kind: "ran", text: "結果", results });

test("harness_review: 却下だけを差し戻しに数え、判定なし（マーカーなし・失敗・時間切れ）は数えない", async () => {
  const cases: {
    name: string;
    result: ChildResult;
    approved: boolean;
    cycles: number;
    undetermined: boolean;
  }[] = [
    {
      name: "却下",
      result: child({ output: "指摘\n<disapproved/>" }),
      approved: false,
      cycles: 1,
      undetermined: false,
    },
    {
      name: "承認",
      result: child({ output: "なし\n<approved/>" }),
      approved: true,
      cycles: 0,
      undetermined: false,
    },
    {
      name: "マーカーなし",
      result: child({ output: "見ました" }),
      approved: false,
      cycles: 0,
      undetermined: true,
    },
    {
      name: "子の失敗",
      result: child({ output: "<disapproved/>", exitCode: 1 }),
      approved: false,
      cycles: 0,
      undetermined: true,
    },
    {
      name: "時間切れ",
      result: child({ timedOut: true }),
      approved: false,
      cycles: 0,
      undetermined: true,
    },
    {
      name: "子の中断",
      result: child({ aborted: true }),
      approved: false,
      cycles: 0,
      undetermined: true,
    },
  ];
  for (const c of cases) {
    const h = setup({ rt: { plan: confirmed() }, repo: true, review: () => ran(c.result) });
    const r = await h.tool("harness_review");
    const rec = h.rt.plan?.reviews.at(-1);
    assert.equal(rec?.approved, c.approved, c.name);
    assert.equal(rec?.undetermined === true, c.undetermined, c.name);
    assert.equal(h.rt.plan?.items[0]?.cycles, c.cycles, c.name);
    assert.ok(r.details, c.name); // 子の結果は details に残す（件数・費用の数え直し）
  }
});

test("harness_review: 呼び出しの中断（signal.aborted）は、出力に却下があっても数えない", async () => {
  const ac = new AbortController();
  const h = setup({
    rt: { plan: confirmed() },
    repo: true,
    review: () => {
      ac.abort();
      return ran(child({ output: "<disapproved/>" }));
    },
  });
  const msg = await h.toolText("harness_review", {}, ac.signal);
  assert.match(msg, /判定を得られませんでした/);
  assert.equal(h.rt.plan?.reviews.at(-1)?.undetermined, true);
  assert.equal(h.rt.plan?.items[0]?.cycles, 0);
});

test("harness_review: 起動を断られたら、記録も差し戻しもしない", async () => {
  const h = setup({
    rt: { plan: confirmed() },
    repo: true,
    review: () => ({ kind: "refused", text: "上限" }),
  });
  assert.match(await h.toolText("harness_review"), /レビューを実行できません/);
  assert.equal(h.rt.plan?.reviews.length, 0);
  assert.equal(h.rt.plan?.items[0]?.cycles, 0);
});

test("ループ: 検証の記録が増えるだけでは進捗にならず、上限で止めて保存する", async () => {
  // 中断した検証を繰り返す（差し戻しにも数えない）→ 項目の状態が変わらないので、無進捗で止まる
  const h = setup({ rt: { plan: confirmed() }, files: pkg });
  const ac = new AbortController();
  ac.abort();
  const stops: (Settle | undefined)[] = [];
  for (let i = 0; i < config.flow.maxNoProgress + 1; i++) {
    await h.toolText("harness_verify", {}, ac.signal);
    stops.push(await h.settle());
  }
  assert.equal(stops.at(-1), undefined);
  assert.ok(stops.slice(0, -1).every((s) => s?.continue === true));
  assert.equal(h.lastSaved()?.paused, true);
  assert.match(h.lastSaved()?.pausedReason ?? "", /進捗のないまま/);
  assert.equal(h.notes.at(-1)?.level, "warning");
  assert.ok(h.hasAskUser()); // 止めた計画では、ask_user が戻る
});

test("ループ: 継続の回数の上限で止めたら、一時停止を保存して通知する", async () => {
  const plan = { ...confirmed(), continuations: config.flow.maxContinuations };
  const h = setup({ rt: { plan } });
  assert.equal(await h.settle(), undefined);
  assert.equal(h.lastSaved()?.paused, true);
  assert.match(h.lastSaved()?.pausedReason ?? "", /継続の上限/);
  assert.match(h.notes.at(-1)?.text ?? "", /\/plan resume/);
});

test("ループ: 未完了の間は継続を要求し、メッセージに「着手時に in_progress」を書く", async () => {
  const h = setup({ rt: { plan: confirmed() } });
  const r = await h.settle();
  assert.equal(r?.continue, true);
  assert.equal(r?.entries?.at(-1)?.customType, "harness-continue");
  assert.match(
    r?.entries?.at(-1)?.content ?? "",
    /着手するときは、先に plan_update で in_progress/,
  );
  assert.equal(h.lastSaved()?.continuations, 1);
});

// ---- 7. エラーで終わった実行 ----

test("agent_before_settle: outcome が error なら継続せず、計画を一時停止にして通知する", async () => {
  const h = setup();
  await h.restoreWith(confirmed());
  assert.ok(!h.hasAskUser());
  assert.equal(await h.settle("error"), undefined);
  assert.equal(h.lastSaved()?.paused, true);
  assert.equal(h.lastSaved()?.pausedReason, "エラーで終了");
  assert.equal(h.notes.at(-1)?.level, "warning");
  assert.ok(h.hasAskUser());
  // 完了済みの計画では、完了の促しも出さない（保存もしない）
  const done = setup({ rt: { plan: completed() } });
  assert.equal(await done.settle("error"), undefined);
  assert.equal(done.appended.length, 0);
});

// ---- Esc・/plan ----

test("agent_settled: Esc で中断したら一時停止にし、ask_user を戻す", async () => {
  const h = setup();
  await h.restoreWith(confirmed());
  assert.ok(!h.hasAskUser());
  await h.emit("agent_settled", { aborted: false });
  assert.equal(h.appended.length, 1);
  await h.emit("agent_settled", { aborted: true });
  assert.equal(h.lastSaved()?.paused, true);
  assert.equal(h.lastSaved()?.pausedReason, "中断(Esc)");
  assert.ok(h.hasAskUser());
  // 一時停止中は継続しない
  assert.equal(await h.settle(), undefined);
});

test("/plan stop・resume: 止めると ask_user が戻り、再開すると外して続きを促す", async () => {
  const h = setup({ rt: { plan: confirmed() } });
  await h.emit("session_start", { reason: "startup" }); // 保存が無い枝 → 計画なし
  assert.equal(h.rt.plan, undefined);
  h.rt.plan = confirmed();

  await h.command("plan", "stop");
  assert.equal(h.lastSaved()?.paused, true);
  assert.ok(h.hasAskUser());

  await h.command("plan", "resume");
  assert.equal(h.lastSaved()?.paused, false);
  assert.ok(!h.hasAskUser());
  assert.equal(h.sent.at(-1)?.message.customType, "harness-continue");
  assert.deepEqual(h.sent.at(-1)?.options, { triggerTurn: true });

  // 済んだ計画は再開しない
  const done = setup({ rt: { plan: completed() } });
  await done.command("plan", "resume");
  assert.equal(done.sent.length, 0);
  assert.match(done.notes.at(-1)?.text ?? "", /すべて済んでいます/);
});

test("/plan clear: 計画を破棄して保存し、ask_user を戻し、状態の差し込みをやめる（復元しても戻らない）", async () => {
  const h = setup({ rt: { plan: confirmed() } });
  await h.emit("session_start", { reason: "startup" });
  h.rt.plan = confirmed();
  await h.command("plan", "stop");
  await h.command("plan", "clear");
  assert.equal(h.rt.plan, undefined);
  assert.equal(h.lastSaved(), null);
  assert.ok(h.hasAskUser());
  assert.equal(await h.start(), undefined);
  assert.equal(await h.settle(), undefined);
  await h.emit("session_start", { reason: "resume" });
  assert.equal(h.rt.plan, undefined);
  // 計画が無ければ、何もしない
  await h.command("plan", "clear");
  assert.match(h.notes.at(-1)?.text ?? "", /計画はありません/);
});

// ---- 4. 止めた計画と、完了の合図・置き換えの確認 ----

test("完了の合図: 一時停止中・計画なし・完了済みなら、write の成功で付く。自律で進めている間は付かない", async () => {
  for (const [name, plan, expected] of [
    ["自律で進行中", confirmed(), false],
    ["一時停止中", pausePlan(confirmed(), "ユーザーが止めました"), true],
    ["計画なし", undefined, true],
    ["完了済み", completed(), true],
  ] as const) {
    const h = setup({ rt: { plan } });
    await h.start();
    await h.write();
    assert.equal(await h.finalLineAdded(), expected, name);
  }
});

test("plan_propose: 確定済みで未完了の計画があれば、置き換えることを確認の本文に書く", async () => {
  const fresh = setup();
  await fresh.tool("plan_propose", { goal: "新しい目的", items: ITEMS });
  assert.doesNotMatch(fresh.selects[0] ?? "", /置き換え/);
  assert.equal(fresh.rt.plan?.goal, "新しい目的");
  assert.ok(!fresh.hasAskUser());

  const h = setup({ rt: { plan: pausePlan(confirmed(), "x") } });
  await h.tool("plan_propose", { goal: "新しい目的", items: ITEMS });
  assert.match(h.selects[0] ?? "", /未完了の計画「目的」.*を置き換えます/);
  assert.match(h.selects[0] ?? "", /一時停止中/);
  assert.equal(h.rt.plan?.goal, "新しい目的");
  assert.equal(h.rt.plan?.paused, false);

  // 完了済みの計画は「未完了」ではないので、書かない
  const done = setup({ rt: { plan: completed() } });
  await done.tool("plan_propose", { goal: "次", items: ITEMS });
  assert.doesNotMatch(done.selects[0] ?? "", /置き換え/);
});

test("キルスイッチがある間は継続せず、自律中の計画を一時停止にして ask_user と完了の合図を戻す", async () => {
  const h = setup();
  await h.restoreWith(confirmed());
  assert.ok(!h.hasAskUser());
  writeFileSync(path.join(h.agentDir, "harness-off"), "");
  assert.equal(await h.settle(), undefined);
  assert.equal(h.lastSaved()?.paused, true);
  assert.equal(h.lastSaved()?.pausedReason, "キルスイッチ");
  assert.equal(h.notes.at(-1)?.level, "warning");
  assert.ok(h.hasAskUser());
  await h.start();
  await h.write();
  assert.equal(await h.finalLineAdded(), true);
  // 一時停止中・完了済みの計画では、保存し直さない（完了の促しも出さない）
  const saved = h.appended.length;
  assert.equal(await h.settle(), undefined);
  assert.equal(h.appended.length, saved);
  const done = setup({ rt: { plan: completed() } });
  writeFileSync(path.join(done.agentDir, "harness-off"), "");
  assert.equal(await done.settle(), undefined);
  assert.equal(done.appended.length, 0);
});

test("harness_review: 前回の指摘は、判定なしを飛ばした直近の「判定あり」のレビューで渡すか決める", async () => {
  const outputs = ["指摘 X\n<disapproved/>", "マーカーなし", "<approved/>", "マーカーなし", "見た"];
  const h = setup({
    rt: { plan: confirmed() },
    repo: true,
    review: () => ran(child({ output: outputs.shift() ?? "" })),
  });
  await h.tool("harness_review"); // 却下
  await h.tool("harness_review"); // 判定なし（直前の判定ありは却下 → 指摘を渡す）
  await h.tool("harness_review"); // 承認（直前の判定ありは、判定なしを飛ばして却下 → 指摘を渡す）
  await h.tool("harness_review"); // 判定なし（直前の判定ありは承認 → 渡さない）
  await h.tool("harness_review"); // 判定なしを飛ばして承認 → 渡さない
  const tasks = h.reviewTasks; // runTasks に渡った依頼の本文
  assert.equal(tasks.length, 5);
  assert.doesNotMatch(tasks[0] ?? "", /## 前回の指摘/);
  assert.match(tasks[1] ?? "", /## 前回の指摘\n指摘 X/);
  assert.match(tasks[2] ?? "", /## 前回の指摘\n指摘 X/);
  assert.doesNotMatch(tasks[3] ?? "", /## 前回の指摘/);
  assert.doesNotMatch(tasks[4] ?? "", /## 前回の指摘/);
});
