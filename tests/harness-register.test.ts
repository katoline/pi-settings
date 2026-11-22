import assert from "node:assert/strict";
import { test } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerGuards } from "../agent/extensions/harness/guards/register.ts";
import type { Runtime } from "../agent/extensions/harness/lib/runtime.ts";
import { FAKE, HOME, runtime } from "./harness-helpers.ts";

type Result = { block?: boolean; reason?: string; content?: { text: string }[] } | undefined;
type Handler = (event: object, ctx: object) => Promise<Result>;

/** 偽物の pi に登録し、イベントを直接呼べるようにする。git は現在のブランチ `branch` のリポジトリ */
function setup(branch = "feat/x") {
  const handlers = new Map<string, Handler>();
  const pi = {
    on: (name: string, h: Handler) => handlers.set(name, h),
    exec: async (_cmd: string, args: string[]) => {
      const key = args.join(" ");
      if (key === "rev-parse --show-toplevel") return { code: 0, stdout: "/repo\n" };
      if (key === "branch --show-current") return { code: 0, stdout: `${branch}\n` };
      return { code: 1, stdout: "" };
    },
  } as unknown as ExtensionAPI;
  const rt: Runtime = runtime();
  registerGuards(pi, rt);
  const call = (name: string) => handlers.get(name) as Handler;
  return { call };
}

const bashCall = (command: string) => ({ toolName: "bash", input: { command } });
const confirms: string[] = [];
const ctxWith = (answer: boolean, hasUI = true) => ({
  cwd: `${HOME}/Dev/seino914/app`,
  hasUI,
  ui: {
    confirm: async (title: string) => {
      confirms.push(title);
      return answer;
    },
  },
});

test("普段のコマンドは通り、確認ダイアログも出ない", async () => {
  const { call } = setup();
  confirms.length = 0;
  for (const cmd of ["git commit -m x", "git push -u origin feat/x", "gh pr view 3"]) {
    assert.equal(await call("tool_call")(bashCall(cmd), ctxWith(true)), undefined, cmd);
  }
  assert.equal(confirms.length, 0);
});

test("危ない操作は、確認ダイアログを出さずに拒否し、`!` で実行する案内を返す", async () => {
  const { call } = setup();
  confirms.length = 0;
  const r = await call("tool_call")(bashCall("git reset --hard"), ctxWith(true));
  assert.equal(r?.block, true);
  assert.match(r?.reason ?? "", /`!<コマンド>` で自分で実行してもらう/);
  assert.equal(confirms.length, 0);
});

// フェーズ 5: bash からの PR の作成・更新・マージは、依頼の有無にかかわらず、確認ダイアログを出さずに拒否する。
// マージの依頼の判定と確認ダイアログは harness_pr_merge（tests/harness-pr.test.ts）
test("bash からのマージ・PR の作成は、確認ダイアログを出さずに拒否する（ガードは入力の依頼を見ない）", async () => {
  const { call } = setup();
  confirms.length = 0;
  // ガードは `input` を購読しない（依頼の判定は harness_pr_merge 側）
  assert.equal(call("input"), undefined);
  for (const cmd of [
    "gh pr merge 3 --squash",
    "gh api -X PUT repos/a/b/pulls/3/merge",
    "gh pr create --title x",
  ]) {
    const r = await call("tool_call")(bashCall(cmd), ctxWith(true));
    assert.equal(r?.block, true, cmd);
    assert.match(r?.reason ?? "", /harness_pr_(merge|create)/);
  }
  assert.equal(confirms.length, 0);
});

test("fail-closed: 判定中に例外が起きたら拒否する", async () => {
  const { call } = setup();
  // input が null で、bash の判定の前に TypeError になる
  const r = await call("tool_call")({ toolName: "bash", input: null }, ctxWith(true));
  assert.equal(r?.block, true);
  assert.match(r?.reason ?? "", /内部エラー/);
});

test("write / edit: 既定ブランチ上では拒否する（git の状態を取る）", async () => {
  const onMain = setup("main");
  const r = await onMain.call("tool_call")(
    { toolName: "write", input: { path: "src/a.ts" } },
    { ...ctxWith(true), cwd: "/repo" },
  );
  assert.equal(r?.block, true);
  const onFeat = setup("feat/x");
  assert.equal(
    await onFeat.call("tool_call")(
      { toolName: "write", input: { path: "src/a.ts" } },
      { ...ctxWith(true), cwd: "/repo" },
    ),
    undefined,
  );
});

test("tool_result: 出力のトークン類を [秘匿] に置き換える", async () => {
  const { call } = setup();
  const r = await call("tool_result")(
    { content: [{ type: "text", text: `token ${FAKE.ghp} end` }] },
    {},
  );
  assert.match(r?.content?.[0]?.text ?? "", /\[秘匿\]/);
  assert.equal(
    await call("tool_result")({ content: [{ type: "text", text: "ok" }] }, {}),
    undefined,
  );
});
