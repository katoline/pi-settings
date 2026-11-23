import assert from "node:assert/strict";
import { test } from "node:test";
import {
  computeFileLists,
  formatFileLists,
  withPreviousFileLists,
} from "../agent/extensions/harness/compaction/files.ts";
import {
  buildStateBlock,
  buildSummaryPrompt,
  RETENTION_ITEMS,
  STATE_END_MARKER,
  STATE_HEADING,
  SUMMARY_SYSTEM_PROMPT,
  stripAppendedBlocks,
} from "../agent/extensions/harness/compaction/prompt.ts";
import { registerCompaction } from "../agent/extensions/harness/compaction/register.ts";
import {
  addDecision,
  proposePlan,
  recordPr,
  recordReview,
  recordVerification,
} from "../agent/extensions/harness/flow/plan.ts";
import type { Runtime } from "../agent/extensions/harness/lib/runtime.ts";
import { config, runtime } from "./harness-helpers.ts";

test("要約のプロンプト: 残す 5 項目を、この順に、日本語で指定する", () => {
  const prompt = buildSummaryPrompt("会話の本文", "前回の要約");
  let last = -1;
  for (const item of RETENTION_ITEMS) {
    const i = prompt.indexOf(item);
    assert.ok(i > last, item);
    last = i;
  }
  assert.equal(RETENTION_ITEMS.length, 5);
  assert.ok(
    prompt.includes("会話の本文") &&
      prompt.includes("前回の要約") &&
      prompt.includes("<conversation>"),
  );
  assert.ok(!buildSummaryPrompt("x").includes("前回までの要約"));
});

test("要約のプロンプト: 会話を先に、前回の要約、指示の順に置き、追加の指示は最後に入れる", () => {
  const prompt = buildSummaryPrompt("会話の本文", "前回の要約", "  テストの結果を重視  ");
  const order = [
    "<conversation>",
    "会話の本文",
    "</conversation>",
    "<previous-summary>",
    "前回の要約",
    "</previous-summary>",
    RETENTION_ITEMS[0],
    "追加の指示(特に重視すること): テストの結果を重視",
  ];
  let last = -1;
  for (const s of order) {
    const i = prompt.indexOf(s);
    assert.ok(i > last, s);
    last = i;
  }
  assert.ok(prompt.startsWith("<conversation>\n会話の本文\n</conversation>"));
  assert.ok(prompt.endsWith("追加の指示(特に重視すること): テストの結果を重視"));
  for (const none of [undefined, "", "   "]) {
    const p = buildSummaryPrompt("x", undefined, none);
    assert.ok(!p.includes("追加の指示") && !p.includes("<previous-summary>"));
  }
});

test("要約の役割: 会話を続けず、要約だけを書かせる", () => {
  assert.ok(SUMMARY_SYSTEM_PROMPT.includes("会話を続けないこと"));
  assert.ok(SUMMARY_SYSTEM_PROMPT.includes("要約だけを出力すること"));
});

test("前回の要約から、ハーネスの記録とファイルの一覧を切り取る", () => {
  const state = buildStateBlock({
    plan: undefined,
    subagentModel: "m",
    subagentSpawns: 1,
    childCost: 0,
  });
  const files = formatFileLists({ readFiles: ["a.ts"], modifiedFiles: ["b.ts"] });
  assert.equal(stripAppendedBlocks(`## 要約\n本文\n\n${state}${files}`), "## 要約\n本文");
  // pi の標準の要約(記録なし・一覧だけ)
  assert.equal(stripAppendedBlocks(`## Goal\nx${files}`), "## Goal\nx");
  // 見出しが行の途中にあるだけなら切らない。行頭の最後の出現から切る
  assert.equal(
    stripAppendedBlocks(`本文で ${STATE_HEADING} に触れた\n\n${state}`),
    `本文で ${STATE_HEADING} に触れた`,
  );
  assert.equal(stripAppendedBlocks(`${state}${files}`), "");
  assert.equal(stripAppendedBlocks("記録のない要約"), "記録のない要約");
  // 記録は終わりの目印で閉じる
  assert.ok(state.endsWith(`\n\n${STATE_END_MARKER}`));
  // 記録の後ろに別の節が続いても、見出しから目印までだけを切り取る
  assert.equal(
    stripAppendedBlocks(`## 要約\n本文\n\n${state}\n\n## 後ろの節\n残す${files}`),
    "## 要約\n本文\n\n## 後ろの節\n残す",
  );
  // 目印が無い(書き写し漏れ)ときは、行頭の見出しの最後の出現から末尾までを切り取る
  const noMarker = state.replace(STATE_END_MARKER, "").trimEnd();
  assert.equal(stripAppendedBlocks(`本文\n\n${noMarker}\n\n## 後ろ`), "本文");
  assert.equal(stripAppendedBlocks(undefined), undefined);
});

test("ファイルの一覧: pi の標準の要約と同じく、変更したものは読んだ一覧から除き、昇順にする", () => {
  const lists = computeFileLists({
    read: new Set(["z.ts", "a.ts", "b.ts"]),
    written: new Set(["c.ts"]),
    edited: new Set(["b.ts"]),
  });
  assert.deepEqual(lists, { readFiles: ["a.ts", "z.ts"], modifiedFiles: ["b.ts", "c.ts"] });
  assert.equal(
    formatFileLists(lists),
    "\n\n<read-files>\na.ts\nz.ts\n</read-files>\n\n<modified-files>\nb.ts\nc.ts\n</modified-files>",
  );
  assert.equal(
    formatFileLists({ readFiles: [], modifiedFiles: ["x"] }),
    "\n\n<modified-files>\nx\n</modified-files>",
  );
  assert.equal(formatFileLists({ readFiles: [], modifiedFiles: [] }), "");
});

test("ファイルの一覧: 枝のすべての compaction エントリの details を足し合わせる", () => {
  const ops = { read: new Set(["new.ts"]), written: new Set<string>(), edited: new Set(["e.ts"]) };
  // 拡張の要約 → pi の標準の要約(拡張の一覧を持たない) → 拡張の要約、の順
  const entries = [
    {
      type: "compaction",
      fromHook: true,
      details: { readFiles: ["first.ts"], modifiedFiles: ["first-mod.ts"] },
    },
    { type: "message" },
    { type: "compaction", details: { readFiles: ["std.ts"], modifiedFiles: ["std-mod.ts"] } },
    { type: "message" },
    {
      type: "compaction",
      fromHook: true,
      details: { readFiles: ["r.ts", 1], modifiedFiles: ["m.ts"] },
    },
    { type: "message" },
  ];
  assert.deepEqual(computeFileLists(withPreviousFileLists(ops, entries)), {
    readFiles: ["first.ts", "new.ts", "r.ts", "std.ts"],
    modifiedFiles: ["e.ts", "first-mod.ts", "m.ts", "std-mod.ts"],
  });
  // details が無い・形が違う前回は何も足さない(元の fileOps は変えない)
  const none = withPreviousFileLists(ops, [{ type: "compaction" }, null]);
  assert.deepEqual(computeFileLists(none), { readFiles: ["new.ts"], modifiedFiles: ["e.ts"] });
  assert.deepEqual([...ops.read], ["new.ts"]);
});

test("確定した状態: 計画・検証・レビュー・PR・判断・サブエージェントをそのまま載せる", () => {
  const r = proposePlan("目的", [{ id: "a", title: "実装", acceptance: "テスト" }], 0);
  assert.ok(r.ok);
  let plan = { ...r.value, confirmed: true };
  plan = recordVerification(plan, {
    command: "npm test",
    ok: true,
    fingerprint: "f",
    summary: "成功",
  });
  plan = recordReview(plan, { approved: false, fingerprint: "f", summary: "src/a.ts:3 バグ" });
  plan = recordPr(plan, { number: 9, url: "https://x/9", title: "feat: a", merged: false });
  plan = addDecision(plan, "既定の branch 名にした");
  const block = buildStateBlock({
    plan,
    subagentModel: "opencode-go/deepseek-v4.1-flash",
    subagentSpawns: 3,
    childCost: 0.12,
  });
  for (const s of [
    "ハーネスの記録",
    "目的: 目的",
    "成功 — `npm test`",
    "却下 — src/a.ts:3 バグ",
    "#9 feat: a — 未マージ",
    "既定の branch 名にした",
    "deepseek-v4.1-flash / 起動した数: 3 / 費用: $0.1200",
  ]) {
    assert.ok(block.includes(s), s);
  }
});

test("確定した計画がなければ、その旨を書く", () => {
  const block = buildStateBlock({
    plan: undefined,
    subagentModel: "m",
    subagentSpawns: 0,
    childCost: 0,
  });
  assert.ok(block.includes("確定した計画はありません"));
});

// ---- session_before_compact のハンドラ（偽の pi・ctx） ----

type Handler = (event: unknown, ctx: unknown) => Promise<unknown>;

function setup(over: Partial<Runtime> = {}) {
  const handlers = new Map<string, Handler>();
  const pi = { on: (name: string, fn: Handler) => handlers.set(name, fn) };
  const rt = runtime(over);
  registerCompaction(pi as never, rt);
  return { handlers, rt };
}

interface CtxOpts {
  model?: { provider: string; id: string; contextWindow?: number; maxTokens?: number } | undefined;
  found?: Record<string, { provider: string; id: string }>;
  authOk?: boolean;
  response?: unknown;
  throws?: Error;
}

function fakeCtx(o: CtxOpts = {}) {
  const calls: {
    complete: Array<{
      model: unknown;
      prompt: string;
      systemPrompt?: string;
      options: Record<string, unknown>;
    }>;
    notices: string[];
    /** 出力の上限を文脈の窓に合わせて削らない modelRegistry.complete を呼んだ回数(0 であるべき) */
    unclamped: number;
  } = {
    complete: [],
    notices: [],
    unclamped: 0,
  };
  const ctx = {
    model:
      "model" in o
        ? o.model
        : { provider: "anthropic", id: "current", contextWindow: 200000, maxTokens: 32000 },
    modelRegistry: {
      find: (p: string, id: string) => o.found?.[`${p}/${id}`],
      getApiKeyAndHeaders: async () => (o.authOk === false ? { ok: false } : { ok: true }),
      complete: async () => {
        calls.unclamped += 1;
        throw new Error("complete は使わない");
      },
      // pi の streamSimple と同じく、結果は result() で受け取る
      streamSimple: (
        model: unknown,
        context: { systemPrompt?: string; messages: Array<{ content: Array<{ text: string }> }> },
        options: Record<string, unknown>,
      ) => {
        calls.complete.push({
          model,
          prompt: context.messages[0]?.content[0]?.text ?? "",
          systemPrompt: context.systemPrompt,
          options,
        });
        return {
          result: async () => {
            if (o.throws) throw o.throws;
            return (
              o.response ?? {
                stopReason: "stop",
                content: [{ type: "text", text: "日本語の要約" }],
                usage: { cost: { total: 0.01 } },
              }
            );
          },
        };
      },
    },
    ui: { notify: (m: string) => calls.notices.push(m) },
  };
  return { ctx, calls };
}

const usedModelId = (calls: { complete: Array<{ model: unknown }> }): string | undefined =>
  (calls.complete[0]?.model as { id?: string } | undefined)?.id;

interface EventOpts {
  aborted?: boolean;
  previousSummary?: string;
  customInstructions?: string;
  fileOps?: { read: Set<string>; written: Set<string>; edited: Set<string> };
  branchEntries?: unknown[];
}

const event = (o: EventOpts | boolean = {}) => {
  const opts = typeof o === "boolean" ? { aborted: o } : o;
  return {
    preparation: {
      messagesToSummarize: [{ role: "user", content: "やって", timestamp: 1 }],
      turnPrefixMessages: [],
      previousSummary: opts.previousSummary,
      firstKeptEntryId: "e9",
      tokensBefore: 1234,
      fileOps: opts.fileOps ?? { read: new Set(), written: new Set(), edited: new Set() },
    },
    branchEntries: opts.branchEntries ?? [],
    customInstructions: opts.customInstructions,
    signal: opts.aborted ? AbortSignal.abort() : new AbortController().signal,
  };
};

test("ハンドラ: 今のモデルで要約し、末尾にハーネスの記録を付け、usage を返す", async () => {
  const { handlers } = setup({ subagentSpawns: 2, childCost: 0.5 });
  const { ctx, calls } = fakeCtx();
  const r = (await handlers.get("session_before_compact")?.(event(), ctx)) as {
    compaction: { summary: string; firstKeptEntryId: string; tokensBefore: number; usage: unknown };
  };
  assert.equal(usedModelId(calls), "current");
  assert.ok(calls.complete[0]?.prompt.includes("<conversation>"));
  assert.ok(r.compaction.summary.startsWith("日本語の要約"));
  assert.ok(r.compaction.summary.includes("ハーネスの記録"));
  assert.ok(r.compaction.summary.includes("起動した数: 2"));
  assert.equal(r.compaction.firstKeptEntryId, "e9");
  assert.equal(r.compaction.tokensBefore, 1234);
  assert.deepEqual(r.compaction.usage, { cost: { total: 0.01 } });
  assert.equal(calls.complete[0]?.systemPrompt, SUMMARY_SYSTEM_PROMPT);
  assert.equal(calls.unclamped, 0);
});

test("ハンドラ: /compact の追加の指示をプロンプトに入れる", async () => {
  const { handlers } = setup();
  const { ctx, calls } = fakeCtx();
  await handlers.get("session_before_compact")?.(
    event({ customInstructions: "PR の状態を重視" }),
    ctx,
  );
  assert.ok(calls.complete[0]?.prompt.endsWith("追加の指示(特に重視すること): PR の状態を重視"));
});

test("ハンドラ: ファイルの一覧を末尾に付け、details に返す。前回の拡張の要約の一覧も引き継ぐ", async () => {
  const { handlers } = setup();
  const { ctx } = fakeCtx();
  const r = (await handlers.get("session_before_compact")?.(
    event({
      fileOps: {
        read: new Set(["a.ts", "b.ts"]),
        written: new Set(["c.ts"]),
        edited: new Set(["b.ts"]),
      },
      branchEntries: [
        {
          type: "compaction",
          fromHook: true,
          details: { readFiles: ["old.ts"], modifiedFiles: ["d.ts"] },
        },
      ],
    }),
    ctx,
  )) as { compaction: { summary: string; details: unknown } };
  assert.deepEqual(r.compaction.details, {
    readFiles: ["a.ts", "old.ts"],
    modifiedFiles: ["b.ts", "c.ts", "d.ts"],
  });
  assert.ok(
    r.compaction.summary.endsWith(
      "起動した数: 0 / 費用: $0.0000\n\n<!-- /harness-state -->\n\n<read-files>\na.ts\nold.ts\n</read-files>\n\n<modified-files>\nb.ts\nc.ts\nd.ts\n</modified-files>",
    ),
  );
});

test("ハンドラ: 前回の要約から、古い記録とファイルの一覧を切り取ってモデルに渡す", async () => {
  const { handlers } = setup();
  const { ctx, calls } = fakeCtx();
  const oldState = buildStateBlock({
    plan: undefined,
    subagentModel: "old-model",
    subagentSpawns: 9,
    childCost: 1,
  });
  await handlers.get("session_before_compact")?.(
    event({
      previousSummary: `前回の本文\n\n${oldState}\n\n<read-files>\nold.ts\n</read-files>`,
    }),
    ctx,
  );
  const prompt = calls.complete[0]?.prompt ?? "";
  assert.ok(prompt.includes("<previous-summary>\n前回の本文\n</previous-summary>"));
  assert.ok(!prompt.includes(STATE_HEADING) && !prompt.includes("old-model"));
  assert.ok(!prompt.includes("<read-files>"));
});

test("ハンドラ: 窓と出力の上限が同じモデルでも、上限を渡さず、文脈の窓に合わせて削る経路(streamSimple)で呼ぶ", async () => {
  const { handlers } = setup();
  const { ctx, calls } = fakeCtx({
    model: { provider: "opencode-go", id: "small", contextWindow: 262144, maxTokens: 262144 },
  });
  await handlers.get("session_before_compact")?.(event(), ctx);
  assert.equal(calls.complete.length, 1);
  assert.equal(calls.unclamped, 0);
  const options = calls.complete[0]?.options ?? {};
  assert.ok(!("maxTokens" in options), "maxTokens を渡すと pi-ai の既定(モデルの上限)を上書きする");
  assert.equal(options.cacheRetention, "none");
});

test("ハンドラ: 出力の上限で切れた要約は失敗として通知し、標準の要約に任せる", async () => {
  const { handlers } = setup();
  const { ctx, calls } = fakeCtx({
    response: { stopReason: "length", content: [{ type: "text", text: "途中まで" }] },
  });
  assert.equal(await handlers.get("session_before_compact")?.(event(), ctx), undefined);
  assert.equal(calls.notices.length, 1);
  assert.ok(calls.notices[0]?.includes("出力の上限で途中で切れました"));
});

test("ハンドラ: 設定の compactionModel があればそのモデルを使う", async () => {
  const { handlers } = setup({
    config: { ...config, compactionModel: "opencode-go/summarizer" },
  });
  const { ctx, calls } = fakeCtx({
    found: { "opencode-go/summarizer": { provider: "opencode-go", id: "summarizer" } },
  });
  await handlers.get("session_before_compact")?.(event(), ctx);
  assert.equal(usedModelId(calls), "summarizer");
});

test("ハンドラ: 設定のモデルが見つからなければ今のモデルにする", async () => {
  const { handlers } = setup({ config: { ...config, compactionModel: "x/none" } });
  const { ctx, calls } = fakeCtx();
  await handlers.get("session_before_compact")?.(event(), ctx);
  assert.equal(usedModelId(calls), "current");
});

test("ハンドラ: 使えるモデルが無い・認証が無いときは標準の要約に任せる（通知なし）", async () => {
  const { handlers } = setup();
  const none = fakeCtx({ model: undefined });
  assert.equal(await handlers.get("session_before_compact")?.(event(), none.ctx), undefined);
  assert.equal(none.calls.complete.length, 0);
  const noAuth = fakeCtx({ authOk: false });
  assert.equal(await handlers.get("session_before_compact")?.(event(), noAuth.ctx), undefined);
  assert.equal(noAuth.calls.complete.length, 0);
});

test("ハンドラ: 失敗したら標準の要約に任せ、警告を通知する", async () => {
  const { handlers } = setup();
  const { ctx, calls } = fakeCtx({ throws: new Error("boom") });
  assert.equal(await handlers.get("session_before_compact")?.(event(), ctx), undefined);
  assert.equal(calls.notices.length, 1);
  assert.ok(calls.notices[0]?.includes("boom"));
});

test("ハンドラ: モデルがエラーを返したときも通知し、空の要約は標準に任せる", async () => {
  const { handlers } = setup();
  const err = fakeCtx({ response: { stopReason: "error", errorMessage: "rate", content: [] } });
  assert.equal(await handlers.get("session_before_compact")?.(event(), err.ctx), undefined);
  assert.ok(err.calls.notices[0]?.includes("rate"));
  const empty = fakeCtx({ response: { stopReason: "stop", content: [] } });
  assert.equal(await handlers.get("session_before_compact")?.(event(), empty.ctx), undefined);
});

test("ハンドラ: 中断されたときは通知しない", async () => {
  const { handlers } = setup();
  const { ctx, calls } = fakeCtx({ throws: new Error("aborted") });
  assert.equal(await handlers.get("session_before_compact")?.(event(true), ctx), undefined);
  assert.equal(calls.notices.length, 0);
  const stopped = fakeCtx({ response: { stopReason: "aborted", content: [] } });
  assert.equal(await handlers.get("session_before_compact")?.(event(), stopped.ctx), undefined);
  assert.equal(stopped.calls.notices.length, 0);
});

test("サブエージェントでは登録しない", () => {
  const { handlers } = setup({ isSubagent: true });
  assert.equal(handlers.size, 0);
});
