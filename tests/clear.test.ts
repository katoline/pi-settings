import assert from "node:assert/strict";
import { test } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import clearExtension from "../agent/extensions/clear/index.ts";

type Command = { handler: (args: string, ctx: object) => Promise<void> };

function setup(cancelled: boolean) {
  const commands = new Map<string, Command>();
  clearExtension({
    registerCommand: (name: string, c: Command) => commands.set(name, c),
  } as unknown as ExtensionAPI);
  const calls: string[] = [];
  const notes: { text: string; level: string }[] = [];
  const ctx = {
    waitForIdle: async () => {
      calls.push("waitForIdle");
    },
    newSession: async () => {
      calls.push("newSession");
      return { cancelled };
    },
    ui: { notify: (text: string, level: string) => notes.push({ text, level }) },
  };
  return { command: commands.get("clear") as Command, ctx, calls, notes };
}

test("/clear: 実行中のターンの終了を待ってから、新しいセッションを始める", async () => {
  const s = setup(false);
  await s.command.handler("", s.ctx);
  assert.deepEqual(s.calls, ["waitForIdle", "newSession"]);
  assert.deepEqual(s.notes, []);
});

test("/clear: 拡張に取り消されたら warning で通知する", async () => {
  const s = setup(true);
  await s.command.handler("", s.ctx);
  assert.equal(s.notes.length, 1);
  assert.equal(s.notes[0]?.level, "warning");
});
