import assert from "node:assert/strict";
import { test } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { Plan } from "../agent/extensions/harness/flow/plan.ts";
import type { Runtime } from "../agent/extensions/harness/lib/runtime.ts";
import { FINAL_LINE, withFinalLine } from "../agent/extensions/harness/output/final-line.ts";
import { registerOutput } from "../agent/extensions/harness/output/register.ts";
import { runtime } from "./harness-helpers.ts";

type Block = { type: string; text?: string };
type Msg = { role: string; content: Block[]; stopReason?: string };
type Handler = (event: object, ctx: object) => Promise<unknown>;

const assistant = (content: unknown[], stopReason = "stop") => ({
  role: "assistant",
  content,
  stopReason,
});
const text = (t: string) => ({ type: "text", text: t });

function blocks(out: { content?: unknown } | null): Block[] {
  assert.ok(out, "メッセージが書き換えられるはず");
  return out.content as Block[];
}

test("最終応答の最後に、完了の 1 行を足す", () => {
  const out = withFinalLine(assistant([text("完了しました。")]));
  const t = blocks(out)[0]?.text ?? "";
  assert.equal(t.split("\n").at(-1), FINAL_LINE);
  assert.ok(t.startsWith("完了しました。"));
});

test("すでに最後の行が完了の 1 行なら、変更しない", () => {
  assert.equal(withFinalLine(assistant([text(`報告\n\n${FINAL_LINE}\n`)])), null);
});

test("末尾の空行は整えたうえで足す", () => {
  assert.equal(
    blocks(withFinalLine(assistant([text("報告\n\n\n")])))[0]?.text,
    `報告\n\n${FINAL_LINE}`,
  );
});

test("テキストがなければ、テキストのブロックを足す", () => {
  const out = withFinalLine(assistant([{ type: "thinking", thinking: "..." }]));
  assert.equal(blocks(out).at(-1)?.text, FINAL_LINE);
});

test("ツール呼び出しがあるメッセージ、エラー、中断、toolUse、ユーザー発言には付けない", () => {
  assert.equal(withFinalLine(assistant([text("x"), { type: "toolCall", name: "bash" }])), null);
  assert.equal(withFinalLine(assistant([text("x")], "error")), null);
  assert.equal(withFinalLine(assistant([text("x")], "aborted")), null);
  assert.equal(withFinalLine(assistant([text("x")], "toolUse")), null);
  assert.equal(withFinalLine({ role: "user", content: [text("x")] }), null);
});

test("最後のテキストのブロックだけを書き換え、ほかは保つ", () => {
  const content = blocks(
    withFinalLine(assistant([text("前"), { type: "thinking", thinking: "t" }, text("後")])),
  );
  assert.equal(content[0]?.text, "前");
  assert.equal(content[2]?.text, `後\n\n${FINAL_LINE}`);
});

function setup(isSubagent = false, over: Partial<Runtime> = {}) {
  const handlers = new Map<string, Handler>();
  const pi = { on: (name: string, h: Handler) => handlers.set(name, h) } as unknown as ExtensionAPI;
  const rt: Runtime = runtime({ isSubagent, ...over });
  registerOutput(pi, rt);
  const call = (name: string, event: object) => handlers.get(name)?.(event, {});
  let seq = 0;
  return {
    rt,
    /** 依頼の実行が始まる（input は実行中のキュー投入でも発火するので、リセットには関係しない） */
    start: () => call("before_agent_start", { messageType: "user", prompt: "依頼" }),
    startCustom: () => call("before_agent_start", { messageType: "custom" }),
    input: (streamingBehavior?: string) =>
      call("input", { type: "input", text: "x", source: "interactive", streamingBehavior }),
    /** 実際の pi と同じく、start には args があり、end には無い */
    tool: async (toolName: string, args: object = {}, isError = false, result?: object) => {
      const toolCallId = `c${++seq}`;
      await call("tool_execution_start", { toolCallId, toolName, args });
      await call("tool_execution_end", { toolCallId, toolName, isError, result });
    },
    end: (m: Msg) => call("message_end", { message: m }) as Promise<{ message: Msg } | undefined>,
  };
}

const finalText = (r: { message: Msg } | undefined) => r?.message.content.at(-1)?.text ?? "";
const msg = (t = "報告") => assistant([text(t)]) as Msg;

test("成果物を作る操作の後の最終応答にだけ付く", async () => {
  for (const [name, args] of [
    ["write", {}],
    ["edit", {}],
    ["bash", { command: "git commit -m x" }],
    ["bash", { command: "git -C /repo commit -m x" }],
    ["bash", { command: "git push -u origin feat/x" }],
    ["bash", { command: "gh pr create --title x" }],
  ] as const) {
    const h = setup();
    await h.start();
    await h.tool(name, args);
    assert.ok(finalText(await h.end(msg())).endsWith(FINAL_LINE), name);
  }
});

test("前の依頼で編集し、新しい依頼で commit・push・PR 作成だけをしても付く", async () => {
  const h = setup();
  await h.start();
  await h.tool("write");
  await h.end(msg());
  await h.start();
  assert.equal(await h.end(msg("答え")), undefined);
  await h.tool("bash", { command: "git commit -m x" });
  await h.tool("bash", { command: "git push" });
  await h.tool("bash", { command: "gh pr create --title x" });
  assert.ok(finalText(await h.end(msg())).endsWith(FINAL_LINE));
});

test("質問への回答だけ・読むだけ・失敗した操作では付かない", async () => {
  const h = setup();
  await h.start();
  assert.equal(await h.end(msg("答え")), undefined);
  await h.tool("read");
  await h.tool("bash", { command: "git status" });
  await h.tool("write", {}, true);
  await h.tool("bash", { command: "git commit -m x" }, true);
  assert.equal(await h.end(msg("答え")), undefined);
});

test("ツール呼び出しを含むメッセージには付かない", async () => {
  const h = setup();
  await h.start();
  await h.tool("write");
  const m = assistant([text("続ける"), { type: "toolCall", name: "bash" }], "toolUse") as Msg;
  assert.equal(await h.end(m), undefined);
});

test("二重には付かない", async () => {
  const h = setup();
  await h.start();
  await h.tool("write");
  assert.equal(await h.end(msg(`報告\n\n${FINAL_LINE}`)), undefined);
});

test("サブエージェントには付かない", async () => {
  const h = setup(true);
  await h.start();
  await h.tool("write");
  assert.equal(await h.end(msg()), undefined);
});

test("実行中の steer / followUp の input ではリセットされず、次の実行の開始でリセットされる", async () => {
  const h = setup();
  await h.start();
  await h.tool("write");
  await h.input("steer");
  await h.input("followUp");
  assert.ok(finalText(await h.end(msg())).endsWith(FINAL_LINE));
  await h.start();
  assert.equal(await h.end(msg("答え")), undefined);
});

test("custom メッセージによる実行の開始ではリセットしない", async () => {
  const h = setup();
  await h.start();
  await h.tool("write");
  await h.startCustom();
  assert.ok(finalText(await h.end(msg())).endsWith(FINAL_LINE));
});

const child = (over: object) => ({
  agent: "a",
  title: "t",
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
const subagentResult = (...rs: object[]) => ({ content: [], details: rs.map(child) });

test("書き込み可のサブエージェントの依頼が成功したら付く", async () => {
  const h = setup();
  await h.start();
  await h.tool("subagent", {}, false, subagentResult({ writable: false }, { writable: true }));
  assert.ok(finalText(await h.end(msg())).endsWith(FINAL_LINE));
});

test("読み取り専用だけ・書き込み可でも失敗・isError・details なしのサブエージェントでは付かない", async () => {
  const h = setup();
  await h.start();
  await h.tool("subagent", {}, false, subagentResult({ writable: false }));
  await h.tool("subagent", {}, false, subagentResult({ writable: true, exitCode: 1 }));
  await h.tool("subagent", {}, false, subagentResult({ writable: true, timedOut: true }));
  await h.tool("subagent", {}, true, subagentResult({ writable: true }));
  await h.tool("subagent", {}, false, { content: [], details: undefined }); // 上限超過などの断り
  await h.tool("subagent", {}, false); // 結果なし
  assert.equal(await h.end(msg("答え")), undefined);
});

// ---- 計画の完了（plan_report を呼んだ）----
const plan = (statuses: ("pending" | "in_progress" | "done")[], confirmed = true): Plan => ({
  version: 1,
  goal: "g",
  confirmed,
  items: statuses.map((status, i) => ({
    id: String(i),
    title: "t",
    acceptance: "a",
    kind: "task" as const,
    review: false,
    status,
    cycles: 0,
  })),
  paused: false,
  continuations: 0,
  startedAt: 0,
  progressKey: "",
  noProgress: 0,
  decisions: [],
  verifications: [],
  reviews: [],
  prs: [],
});

test("計画の完了報告（plan_report）を出した依頼の最終応答には、ファイルを変更していなくても付く", async () => {
  const h = setup(false, { plan: plan(["done"]), planCompleted: true });
  await h.start(); // 依頼が始まると戻る
  assert.equal(h.rt.planCompleted, false);
  assert.equal(await h.end(msg()), undefined);
  h.rt.planCompleted = true; // この依頼の中で plan_report が呼ばれた
  assert.ok(finalText(await h.end(msg())).endsWith(FINAL_LINE));
});

test("確定した計画に未着手・進行中の項目がある間は、変更をしていても付けない", async () => {
  for (const statuses of [["done", "in_progress"], ["pending"]] as const) {
    const h = setup(false, { plan: plan([...statuses]) });
    await h.start();
    await h.tool("write");
    assert.equal(await h.end(msg("着手しました")), undefined, statuses.join());
  }
  // 項目が済めば付く。未確定の計画は、判定に影響しない
  const h = setup(false, { plan: plan(["done", "done"]) });
  await h.start();
  await h.tool("write");
  assert.ok(finalText(await h.end(msg())).endsWith(FINAL_LINE));
  const unconfirmed = setup(false, { plan: plan(["pending"], false) });
  await unconfirmed.start();
  await unconfirmed.tool("write");
  assert.ok(finalText(await unconfirmed.end(msg())).endsWith(FINAL_LINE));
});

test("計画の完了でも、サブエージェントには付かない。完了報告のない・失敗した計画でも成果物がなければ付かない", async () => {
  const sub = setup(true, { plan: plan(["done"]), planCompleted: true });
  assert.equal(await sub.end(msg()), undefined);
  const none = setup(false, { plan: plan(["done"]) });
  await none.start();
  assert.equal(await none.end(msg("答え")), undefined);
});
