import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { loadInstructions } from "../agent/extensions/harness/instructions/load.ts";
import { registerInstructions } from "../agent/extensions/harness/instructions/register.ts";
import type { Runtime } from "../agent/extensions/harness/lib/runtime.ts";
import { runtime } from "./harness-helpers.ts";

type Handler = (event: object, ctx: object) => Promise<unknown>;

function setup(isSubagent: boolean, dir?: string) {
  const handlers = new Map<string, Handler>();
  const pi = { on: (name: string, h: Handler) => handlers.set(name, h) } as unknown as ExtensionAPI;
  const rt: Runtime = runtime({ isSubagent });
  registerInstructions(pi, rt, dir);
  return handlers;
}

const run = async (handlers: Map<string, Handler>, sections?: Record<string, string>) => {
  const options: { sections?: Record<string, string> } = sections ? { sections } : {};
  await handlers.get("before_agent_start")?.({ systemPromptOptions: options }, {});
  return options.sections;
};

test("メインでは sections.harness に main.md が入り、既存の sections は消えない", async () => {
  const sections = await run(setup(false), { other: "x" });
  assert.equal(sections?.harness, loadInstructions("main"));
  assert.equal(sections?.other, "x");
});

test("サブエージェントでは subagent.md が入る", async () => {
  const sections = await run(setup(true));
  assert.equal(sections?.harness, loadInstructions("subagent"));
  assert.match(sections?.harness ?? "", /変更ファイル/);
});

test("main.md は、計画・検証・レビューのツールを書き、まだ無いもの（worktree・PR のツール・pi --print の手順）に触れない", () => {
  const main = loadInstructions("main");
  assert.doesNotMatch(main, /作業用worktree/);
  assert.doesNotMatch(main, /完了の合図/);
  assert.doesNotMatch(main, /pi --print/);
  for (const name of ["harness_pr_", "harness_worktree"]) {
    assert.ok(!main.includes(name), name);
  }
  for (const name of [
    "ask_user",
    "plan_propose",
    "plan_update",
    "plan_note",
    "plan_report",
    "harness_verify",
    "harness_review",
  ]) {
    assert.ok(main.includes(name), name);
  }
  assert.match(main, /自分で判断したこと/);
  // ファイルを変更しない依頼では、計画を作らない
  assert.match(main, /計画を作らずに/);
});

test("main.md は、subagent ツールの使い方（役割・自己完結した依頼・書き込み可は 1 件ずつ・子ができないこと）を書く", () => {
  const main = loadInstructions("main");
  assert.match(main, /# サブエージェント/);
  assert.ok(main.includes("`subagent`"));
  for (const role of ["scout", "planner", "reviewer", "worker"])
    assert.ok(main.includes(role), role);
  assert.match(main, /自己完結/);
  assert.match(main, /1 件ずつ順番/);
  assert.match(main, /同じファイルを複数の依頼で編集させない/);
  assert.match(main, /質問・commit・push・PR・マージができない/);
  assert.match(main, /自分で確かめてから完了/);
  // 独立レビューは harness_review で行う（pi --print の手順は無い）
  assert.match(main, /# 独立レビュー[\s\S]*`harness_review` を呼ぶ/);
});

test("指示ファイルが読めなければ、例外を出さず、差し込まない", async () => {
  const empty = mkdtempSync(path.join(tmpdir(), "pi-harness-"));
  const warn = console.warn;
  const warned: string[] = [];
  console.warn = (m: string) => warned.push(m);
  try {
    const handlers = setup(false, empty);
    assert.equal(handlers.has("before_agent_start"), false);
    assert.equal(warned.length, 1);
  } finally {
    console.warn = warn;
  }
  writeFileSync(path.join(empty, "main.md"), "  本文\n");
  assert.equal(loadInstructions("main", empty), "本文");
});
