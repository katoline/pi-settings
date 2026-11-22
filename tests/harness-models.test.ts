import assert from "node:assert/strict";
import { test } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createRuntime } from "../agent/extensions/harness/lib/runtime.ts";
import { latestCustomEntry } from "../agent/extensions/harness/lib/state.ts";
import {
  groupModels,
  parseRef,
  refToString,
  SUBAGENT_DEFAULT,
} from "../agent/extensions/harness/models/catalog.ts";
import { registerModels } from "../agent/extensions/harness/models/register.ts";
import { config, runtime } from "./harness-helpers.ts";

const m = (provider: string, id: string) => ({ provider, id });

test("使えるモデルを 3 つのグループに分ける", () => {
  const groups = groupModels(
    [
      m("opencode-go", "deepseek-v4.1-flash"),
      m("opencode-go", "glm-5.2"),
      m("anthropic", "claude-haiku-5-5"),
      m("anthropic", "claude-opus-5-5"),
      m("anthropic", "claude-3-haiku"), // 一覧の 4 つ以外は出さない
      m("anthropic", "claude-fable-5-2"),
      m("anthropic", "claude-sonnet-5-5"),
      m("openai-codex", "gpt-6.1-sol"),
      m("openai", "gpt-6.1-sol"),
      m("openrouter", "x"),
    ],
    (x) => x.provider === "openai",
  );
  assert.deepEqual(
    groups.map((g) => g.key),
    ["opencode-go", "anthropic", "codex"],
  );
  assert.deepEqual(
    groups[0]?.models.map((x) => x.id),
    ["deepseek-v4.1-flash", "glm-5.2"],
  );
  // Anthropic は、Opus 5.5 / Sonnet 5.5 / Fable 5.2 / Haiku 5.5 の順
  assert.deepEqual(
    groups[1]?.models.map((x) => x.id),
    ["claude-opus-5-5", "claude-sonnet-5-5", "claude-fable-5-2", "claude-haiku-5-5"],
  );
  assert.equal(groups[2]?.models.length, 2);
});

test("ChatGPT でサインインしていない openai は Codex に入れない", () => {
  const groups = groupModels([m("openai", "gpt-6.1-sol")], () => false);
  assert.equal(groups.length, 0);
});

test("認証のないプロバイダのグループは出ない", () => {
  const groups = groupModels([m("anthropic", "claude-opus-5-5")]);
  assert.deepEqual(
    groups.map((g) => g.key),
    ["anthropic"],
  );
});

test("provider/id の解析", () => {
  assert.deepEqual(
    parseRef("opencode-go/deepseek-v4.1-flash"),
    m("opencode-go", "deepseek-v4.1-flash"),
  );
  assert.deepEqual(parseRef("openrouter/anthropic/claude"), m("openrouter", "anthropic/claude"));
  assert.equal(parseRef("noslash"), null);
  assert.equal(parseRef("/x"), null);
  assert.equal(parseRef("x/"), null);
  assert.equal(refToString(m("a", "b")), "a/b");
  assert.deepEqual(parseRef(SUBAGENT_DEFAULT), m("opencode-go", "deepseek-v4.1-flash"));
});

test("保存したカスタムエントリの、最新を取り出す", () => {
  const entries = [
    { type: "custom", customType: "x", data: { v: 1 } },
    { type: "message" },
    { type: "custom", customType: "x", data: { v: 2 } },
    { type: "custom", customType: "y", data: { v: 9 } },
  ];
  assert.deepEqual(latestCustomEntry(entries, "x"), { v: 2 });
  assert.equal(latestCustomEntry(entries, "z"), undefined);
  assert.equal(latestCustomEntry([], "x"), undefined);
});

test("ランタイム: サブエージェントのモデルの既定と、環境変数での上書き", () => {
  const d = createRuntime({});
  assert.equal(d.subagentModelDefault, SUBAGENT_DEFAULT);
  assert.equal(d.subagentModel, SUBAGENT_DEFAULT);
  assert.equal(d.subagentSpawns, 0);
  assert.equal(d.childCost, 0);
  assert.equal(d.isSubagent, false);

  const o = createRuntime({ PI_SUBAGENT_MODEL: "anthropic/claude-haiku-5-5" });
  assert.equal(o.subagentModel, "anthropic/claude-haiku-5-5");
  // `provider/id` の形でない値は使わない
  assert.equal(createRuntime({ PI_SUBAGENT_MODEL: "bad" }).subagentModel, SUBAGENT_DEFAULT);
});

test("ランタイム: エージェントディレクトリは PI_CODING_AGENT_DIR、無ければ ~/.pi/agent", () => {
  assert.equal(createRuntime({ PI_CODING_AGENT_DIR: "/x/agent" }).agentDir, "/x/agent");
  assert.match(createRuntime({}).agentDir, /\.pi\/agent$/);
});

type Handler = (event: object, ctx: object) => Promise<unknown>;
type Command = { handler: (args: string, ctx: object) => Promise<void> };

/** 偽物の pi と ctx で registerModels を登録し、コマンドとイベントを直接呼べるようにする */
function setupModels(over: Parameters<typeof runtime>[0] = {}) {
  const handlers = new Map<string, Handler>();
  const commands = new Map<string, Command>();
  const appended: { type: string; data: unknown }[] = [];
  const mainModels: unknown[] = [];
  const pi = {
    on: (name: string, h: Handler) => handlers.set(name, h),
    registerCommand: (name: string, c: Command) => commands.set(name, c),
    appendEntry: (type: string, data: unknown) => appended.push({ type, data }),
    setModel: async (model: unknown) => {
      mainModels.push(model);
      return true;
    },
  } as unknown as ExtensionAPI;
  const rt = runtime(over);
  registerModels(pi, rt);

  // 登録済み: anthropic の 2 つ。認証済み(getAvailable): opus だけ
  const known = [m("anthropic", "claude-opus-5-5"), m("anthropic", "claude-haiku-5-5")];
  const available = [known[0]];
  const notes: { text: string; level: string }[] = [];
  const selects: string[] = [];
  const ctx = (branch: unknown[] = [], hasUI = true) => ({
    hasUI,
    modelRegistry: {
      getAvailable: () => available,
      find: (provider: string, id: string) =>
        known.find((x) => x?.provider === provider && x.id === id),
      isUsingOAuth: () => false,
    },
    ui: {
      notify: (text: string, level: string) => notes.push({ text, level }),
      select: async (title: string) => {
        selects.push(title);
        return undefined; // キャンセル
      },
    },
    sessionManager: { getBranch: () => branch },
  });
  const command = (name: string, args: string) =>
    (commands.get(name) as Command).handler(args, ctx());
  const emit = (name: string, event: object, c = ctx()) =>
    (handlers.get(name) as Handler)(event, c);
  return { rt, command, emit, ctx, appended, mainModels, notes, selects };
}

const savedModel = (model: string) => ({
  type: "custom",
  customType: "harness-subagent-model",
  data: { model },
});

test("/subagent-model: 認証済みのモデルを直接指定すると、切り替えて保存する", async () => {
  const s = setupModels();
  await s.command("subagent-model", " anthropic/claude-opus-5-5 ");
  assert.equal(s.rt.subagentModel, "anthropic/claude-opus-5-5");
  assert.deepEqual(s.appended, [
    { type: "harness-subagent-model", data: { model: "anthropic/claude-opus-5-5" } },
  ]);
  assert.equal(s.notes.at(-1)?.level, "info");
});

test("/subagent-model reset: 既定に戻して保存する", async () => {
  const s = setupModels({ subagentModel: "anthropic/claude-opus-5-5" });
  await s.command("subagent-model", "reset");
  assert.equal(s.rt.subagentModel, SUBAGENT_DEFAULT);
  assert.deepEqual(s.appended, [
    { type: "harness-subagent-model", data: { model: SUBAGENT_DEFAULT } },
  ]);
});

test("/subagent-model: 見つからない・認証が無い・形式の誤りは、保存せずに error で通知する", async () => {
  for (const [arg, pattern] of [
    ["anthropic/claude-nope", /見つかりません/],
    ["anthropic/claude-haiku-5-5", /認証が未設定/], // 登録はあるが getAvailable に無い
    ["noslash", /`provider\/id` の形ではありません/],
    ["x/", /`provider\/id` の形ではありません/],
  ] as const) {
    const s = setupModels();
    await s.command("subagent-model", arg);
    assert.equal(s.rt.subagentModel, SUBAGENT_DEFAULT, arg);
    assert.deepEqual(s.appended, [], arg);
    assert.equal(s.notes.length, 1, arg);
    assert.equal(s.notes[0]?.level, "error", arg);
    assert.match(s.notes[0]?.text ?? "", pattern, arg);
  }
});

test("/subagent-model: 引数なしで選択をキャンセルすると、保存せずに現在のモデルを表示する", async () => {
  const s = setupModels();
  await s.command("subagent-model", "");
  assert.equal(s.selects.length, 1);
  assert.deepEqual(s.appended, []);
  assert.match(s.notes.at(-1)?.text ?? "", /現在のサブエージェントのモデル/);
});

test("サブエージェントのモデル: 保存した値を session_start・session_tree で戻す", async () => {
  const s = setupModels();
  const branch = [
    savedModel("anthropic/claude-haiku-5-5"),
    savedModel("anthropic/claude-opus-5-5"),
  ];
  await s.emit("session_start", { reason: "resume" }, s.ctx(branch));
  assert.equal(s.rt.subagentModel, "anthropic/claude-opus-5-5");
  await s.emit("session_tree", {}, s.ctx([savedModel("anthropic/claude-haiku-5-5")]));
  assert.equal(s.rt.subagentModel, "anthropic/claude-haiku-5-5");
  // 保存が無い枝・形式の壊れた値は、既定に戻す
  await s.emit("session_tree", {}, s.ctx([]));
  assert.equal(s.rt.subagentModel, SUBAGENT_DEFAULT);
  await s.emit("session_start", { reason: "reload" }, s.ctx([savedModel("bad")]));
  assert.equal(s.rt.subagentModel, SUBAGENT_DEFAULT);
});

test("起動時の選択: selectModelOnStartup が true で、startup・new で、サブエージェントでないときだけ出す", async () => {
  const on = { ...config, selectModelOnStartup: true };
  const cases: {
    over: Parameters<typeof runtime>[0];
    reason: string;
    hasUI?: boolean;
    shown: boolean;
  }[] = [
    { over: { config: on }, reason: "startup", shown: true },
    { over: { config: on }, reason: "new", shown: true },
    { over: { config: on }, reason: "resume", shown: false },
    { over: { config: on }, reason: "reload", shown: false },
    { over: { config: on }, reason: "fork", shown: false },
    { over: { config: on, isSubagent: true }, reason: "startup", shown: false },
    { over: { config: on }, reason: "startup", hasUI: false, shown: false },
    { over: {}, reason: "startup", shown: false }, // 既定は false
  ];
  for (const c of cases) {
    const s = setupModels(c.over);
    await s.emit("session_start", { reason: c.reason }, s.ctx([], c.hasUI ?? true));
    assert.equal(s.selects.length > 0, c.shown, JSON.stringify(c));
    assert.deepEqual(s.mainModels, []); // キャンセルしたので変えない
  }
});
