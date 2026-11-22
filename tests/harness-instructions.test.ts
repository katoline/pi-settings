import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { loadInstructions } from "../agent/extensions/harness/instructions/load.ts";
import { registerInstructions } from "../agent/extensions/harness/instructions/register.ts";
import type { Runtime } from "../agent/extensions/harness/lib/runtime.ts";
import { config, HOME } from "./harness-helpers.ts";

type Handler = (event: object, ctx: object) => Promise<unknown>;

function setup(isSubagent: boolean, dir?: string) {
  const handlers = new Map<string, Handler>();
  const pi = { on: (name: string, h: Handler) => handlers.set(name, h) } as unknown as ExtensionAPI;
  const rt: Runtime = { config, isSubagent, home: HOME, tmpdir: "/tmp" };
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

test("main.md は、まだ無いもの（worktree の節・計画やレビューのツール）に触れない", () => {
  const main = loadInstructions("main");
  assert.doesNotMatch(main, /作業用worktree/);
  assert.doesNotMatch(main, /完了の合図/);
  for (const name of [
    "plan_",
    "ask_user",
    "harness_verify",
    "harness_review",
    "harness_pr_",
    "subagent`",
  ]) {
    assert.ok(!main.includes(name), name);
  }
  assert.match(main, /自分で判断したこと/);
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
