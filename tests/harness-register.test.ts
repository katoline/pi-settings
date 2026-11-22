import assert from "node:assert/strict";
import { test } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerGuards } from "../agent/extensions/harness/guards/register.ts";
import type { Runtime } from "../agent/extensions/harness/lib/runtime.ts";
import { config, FAKE, HOME } from "./harness-helpers.ts";

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
  const rt: Runtime = { config, isSubagent: false, home: HOME, tmpdir: "/tmp" };
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
const userInput = (text: string, extra: object = {}) => ({
  type: "input",
  text,
  source: "interactive",
  ...extra,
});

test("普段のコマンドは通り、確認ダイアログも出ない", async () => {
  const { call } = setup();
  confirms.length = 0;
  for (const cmd of ["git commit -m x", "git push -u origin feat/x", "gh pr create --title x"]) {
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

test("マージ: 依頼が無ければ、ダイアログを出さずに拒否", async () => {
  const { call } = setup();
  confirms.length = 0;
  const r = await call("tool_call")(bashCall("gh pr merge 3 --squash"), ctxWith(true));
  assert.equal(r?.block, true);
  assert.equal(confirms.length, 0);
});

test("マージ: 依頼があれば確認ダイアログを出し、許可されたら通す・拒否されたら止める", async () => {
  const { call } = setup();
  await call("input")(userInput("PR 3 をマージして"), {});
  confirms.length = 0;
  assert.equal(
    await call("tool_call")(bashCall("gh pr merge 3 --squash"), ctxWith(true)),
    undefined,
  );
  assert.equal(confirms.length, 1);
  const denied = await call("tool_call")(
    bashCall("gh api -X PUT repos/a/b/pulls/3/merge"),
    ctxWith(false),
  );
  assert.equal(denied?.block, true);
  assert.equal(confirms.length, 2);
});

test("マージ: 依頼があっても UI が無ければ拒否", async () => {
  const { call } = setup();
  await call("input")(userInput("merge it"), {});
  const r = await call("tool_call")(bashCall("gh pr merge 3"), ctxWith(true, false));
  assert.equal(r?.block, true);
});

test("マージの依頼: 拡張が送った入力は数えない。待機中の入力は置き換え、実行中の追加入力は足す", async () => {
  const { call } = setup();
  const merge = () => call("tool_call")(bashCall("gh pr merge 3"), ctxWith(true));
  await call("input")(userInput("マージして", { source: "extension" }), {});
  assert.equal((await merge())?.block, true);
  await call("input")(userInput("マージして"), {});
  assert.equal(await merge(), undefined);
  // 実行中の追加入力は足すだけ（依頼は消えない）
  await call("input")(userInput("typo も直して", { streamingBehavior: "steer" }), {});
  assert.equal(await merge(), undefined);
  // 待機中の新しい入力は置き換える
  await call("input")(userInput("README を直して"), {});
  assert.equal((await merge())?.block, true);
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
