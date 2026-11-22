import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { fsReader, workingTreeFingerprint } from "../agent/extensions/harness/flow/fingerprint.ts";
import {
  type Plan,
  pausePlan,
  proposePlan,
  recordReview,
  recordVerification,
} from "../agent/extensions/harness/flow/plan.ts";
import {
  applyGeneratedSection,
  BODY_BEGIN,
  BODY_END,
  branchRulesRequirePr,
  buildPrBody,
  evaluateChecks,
  judgeChecksResult,
  judgeProtection,
  type MergeGateInput,
  mergeGate,
  parseChecks,
  parseGithubRemote,
  protectionNotice,
} from "../agent/extensions/harness/flow/pr.ts";
import { registerFlow } from "../agent/extensions/harness/flow/register.ts";
import { renderReport } from "../agent/extensions/harness/flow/report.ts";
import type { Runtime } from "../agent/extensions/harness/lib/runtime.ts";
import { runtime } from "./harness-helpers.ts";

const run = promisify(execFile);

// ---- 純粋な関数 ----

test("buildPrBody: 概要・変更点・確認方法の固定の形で、生成部分をマーカーで囲む", () => {
  const body = buildPrBody({
    summary: "A を直す",
    commits: ["feat: a", "docs: b"],
    verification: { command: "npm run check", ok: true, summary: "1 コマンドが成功" },
  });
  assert.ok(body.startsWith(BODY_BEGIN));
  assert.ok(body.endsWith(BODY_END));
  for (const s of ["## 概要", "A を直す", "## 変更点", "- feat: a", "- docs: b", "## 確認方法"])
    assert.ok(body.includes(s), s);
  assert.ok(body.includes("成功: `npm run check`"));
});

test("buildPrBody: 検証が無ければ未検証。概要を省くとコミットの件名から作る", () => {
  const body = buildPrBody({ commits: ["feat: a", "fix: b"] });
  assert.ok(body.includes("**未検証**"));
  assert.ok(body.includes("feat: a、fix: b"));
  const unverified = buildPrBody({
    commits: [],
    verification: { command: "(検証コマンドなし)", ok: true, unverified: true, summary: "" },
  });
  assert.ok(unverified.includes("**未検証**"));
  assert.ok(unverified.includes("(コミットなし)"));
});

test("applyGeneratedSection: マーカーの間だけを作り直し、外側（ユーザーの記述）を残す", () => {
  const first = buildPrBody({ summary: "旧", commits: ["feat: a"] });
  const existing = `手書きの前置き\n\n${first}\n\nレビュー依頼: Closes #3\n`;
  const next = buildPrBody({ summary: "新", commits: ["feat: a", "fix: b"] });
  const updated = applyGeneratedSection(existing, next);
  assert.ok(updated.startsWith("手書きの前置き\n\n"));
  assert.ok(updated.endsWith("\n\nレビュー依頼: Closes #3\n"));
  assert.ok(updated.includes("新") && updated.includes("- fix: b"));
  assert.ok(!updated.includes("旧"));
  assert.equal(updated.split(BODY_BEGIN).length, 2, "生成部分が重ならない");
  // 同じ内容での再更新は変わらない
  assert.equal(applyGeneratedSection(updated, next), updated);
});

test("applyGeneratedSection: マーカーの無い本文は、そのまま残して末尾に足す。空なら生成部分だけ", () => {
  const generated = buildPrBody({ commits: ["feat: a"] });
  assert.equal(applyGeneratedSection("手書き", generated), `手書き\n\n${generated}`);
  assert.equal(applyGeneratedSection("", generated), generated);
});

test("CI の判定: pass / fail / pending / none（skipping は無視、cancel は失敗）", () => {
  assert.equal(evaluateChecks([]), "none");
  assert.equal(evaluateChecks([{ name: "a", bucket: "skipping" }]), "none");
  assert.equal(evaluateChecks([{ name: "a", bucket: "pass" }]), "pass");
  assert.equal(
    evaluateChecks([
      { name: "a", bucket: "pass" },
      { name: "b", bucket: "pending" },
    ]),
    "pending",
  );
  assert.equal(
    evaluateChecks([
      { name: "a", bucket: "pending" },
      { name: "b", bucket: "fail" },
    ]),
    "fail",
  );
  assert.equal(evaluateChecks([{ name: "a", bucket: "cancel" }]), "fail");
  assert.deepEqual(parseChecks('[{"name":"q","bucket":"pass"}]'), [{ name: "q", bucket: "pass" }]);
  assert.deepEqual(parseChecks("not json"), []);
});

test("judgeChecksResult: チェックが無いと分かるのは、終了コード 1 と gh の「no checks reported」のときだけ", () => {
  const r = (code: number, stdout: string, stderr = "") =>
    judgeChecksResult({ code, stdout, stderr });
  // JSON の配列なら中身で判定する（実行中・失敗は非 0 で返ることがある）
  assert.equal(r(0, '[{"name":"q","bucket":"pass"}]').state, "pass");
  assert.equal(r(8, '[{"name":"q","bucket":"pending"}]').state, "pending");
  assert.equal(r(1, '[{"name":"q","bucket":"fail"}]').state, "fail");
  assert.equal(r(0, "[]").state, "none");
  // gh 2.102.0 の、チェックの無い PR での出力（標準出力は空、終了コード 1）
  assert.deepEqual(r(1, "", "no checks reported on the 'feat/x' branch\n"), { state: "none" });
  assert.equal(r(1, "", "no required checks reported on the 'feat/x' branch").state, "none");
  // それ以外の失敗は error（マージを止める）
  for (const [code, stderr] of [
    [1, "error connecting to api.github.com"],
    [4, "To get started with GitHub CLI, please run:  gh auth login"],
    [1, "GraphQL: Could not resolve to a PullRequest with the number of 7."],
    [1, "HTTP 403: Resource not accessible by integration"],
    [127, "spawn gh ENOENT"],
    [4, "no checks reported on the 'feat/x' branch"],
    [1, ""],
    [0, ""],
  ] as const) {
    const j = r(code, "", stderr);
    assert.equal(j.state, "error", `${code} ${stderr}`);
    assert.match(j.detail ?? "", new RegExp(`終了コード ${code}`));
  }
  // 出力が JSON の配列でなければ error
  assert.equal(r(0, "not json").state, "error");
  assert.equal(r(0, '{"a":1}').state, "error");
});

test("ブランチ保護の判定: ルールセットかクラシックの保護があれば保護。確かめられなければ unknown", () => {
  const ok = (stdout: string) => ({ code: 0, stdout, stderr: "" });
  const notFound = { code: 1, stdout: "", stderr: "gh: Branch not protected (HTTP 404)" };
  const denied = { code: 1, stdout: "", stderr: "gh: Resource not accessible (HTTP 403)" };
  assert.equal(branchRulesRequirePr('[{"type":"pull_request"}]'), true);
  assert.equal(branchRulesRequirePr("[]"), false);
  assert.equal(branchRulesRequirePr("x"), null);
  assert.equal(judgeProtection(ok('[{"type":"pull_request"}]'), notFound), "protected");
  assert.equal(judgeProtection(ok("[]"), ok("{}")), "protected");
  assert.equal(judgeProtection(ok("[]"), notFound), "unprotected");
  assert.equal(judgeProtection(denied, notFound), "unknown");
  assert.equal(judgeProtection(ok("[]"), denied), "unknown");
  assert.equal(protectionNotice("protected", "main"), null);
  assert.match(protectionNotice("unprotected", "main") ?? "", /保護されていません/);
  assert.match(protectionNotice("unknown", "main") ?? "", /確認できませんでした/);
  assert.deepEqual(parseGithubRemote("git@github.com:o/r.git"), { owner: "o", repo: "r" });
  assert.deepEqual(parseGithubRemote("https://github.com/o/r"), { owner: "o", repo: "r" });
  assert.equal(parseGithubRemote("/tmp/bare.git"), null);
});

// ---- マージのゲート ----

function confirmedPlan(reviewItem = false): Plan {
  const r = proposePlan(
    "目的",
    [{ id: "a", title: "A", acceptance: "x", review: reviewItem }],
    Date.now(),
  );
  assert.ok(r.ok);
  return { ...r.value, confirmed: true };
}
const done = (p: Plan): Plan => ({
  ...p,
  items: p.items.map((i) => ({ ...i, status: "done" as const, evidence: "e" })),
});
const verified = (p: Plan, fp = "fp"): Plan =>
  recordVerification(p, { command: "c", ok: true, fingerprint: fp, summary: "s" });

const gateInput = (over: Partial<MergeGateInput> = {}): MergeGateInput => ({
  isSubagent: false,
  hasUI: true,
  checks: "pass",
  plan: undefined,
  planApplies: false,
  fingerprint: "fp",
  ...over,
});

test("マージのゲート: 計画なし・CI なしは止めず、注意として出す", () => {
  const noPlan = mergeGate(gateInput());
  assert.deepEqual(noPlan.blockers, []);
  assert.equal(noPlan.warnings.length, 1);
  assert.match(noPlan.warnings[0] ?? "", /計画がありません/);
  const noCi = mergeGate(gateInput({ checks: "none" }));
  assert.deepEqual(noCi.blockers, []);
  assert.ok(noCi.warnings.some((w) => /CI のチェックがありません/.test(w)));
  // 確定した計画はあるが、PR のブランチが違う
  const other = mergeGate(gateInput({ plan: confirmedPlan(), planApplies: false }));
  assert.deepEqual(other.blockers, []);
  assert.match(other.warnings.join(""), /作業ブランチのものではありません/);
});

test("マージのゲート: サブエージェント・UI なし・CI の失敗と実行中は止める（注意との区別）", () => {
  assert.equal(mergeGate(gateInput({ isSubagent: true })).blockers.length, 1);
  assert.match(mergeGate(gateInput({ hasUI: false })).blockers.join(""), /UI/);
  assert.match(mergeGate(gateInput({ checks: "fail" })).blockers.join(""), /失敗/);
  assert.match(mergeGate(gateInput({ checks: "pending" })).blockers.join(""), /終わりません/);
  assert.deepEqual(mergeGate(gateInput({ checks: "pass" })).blockers, []);
  // CI の状態を取得できないときは止める（「CI なし」の注意にはしない）
  const err = mergeGate(gateInput({ checks: "error", checksDetail: "終了コード 4: auth" }));
  assert.match(err.blockers.join(""), /CI の状態を取得できませんでした.*終了コード 4: auth/);
  assert.ok(!err.warnings.some((w) => /CI のチェックがありません/.test(w)));
});

test("マージのゲート: 計画の最後のマージの項目が進行中なら通り、ほかに未着手・進行中の項目があれば止める", () => {
  const r = proposePlan(
    "目的",
    [
      { id: "a", title: "A", acceptance: "x" },
      { id: "pr", title: "PR を作る", acceptance: "x", kind: "task" },
      { id: "merge", title: "マージする", acceptance: "マージ済み", kind: "task" },
    ],
    Date.now(),
  );
  assert.ok(r.ok);
  const base: Plan = { ...r.value, confirmed: true };
  const status = (p: Plan, s: Record<string, "pending" | "in_progress" | "done">): Plan => ({
    ...p,
    items: p.items.map((i) => ({ ...i, status: s[i.id] ?? i.status, evidence: "e" })),
  });
  const apply = (plan: Plan) => mergeGate(gateInput({ plan, planApplies: true }));

  // マージの項目だけが進行中: 通る
  const mergeInProgress = verified(status(base, { a: "done", pr: "done", merge: "in_progress" }));
  assert.deepEqual(apply(mergeInProgress).blockers, []);
  // ほかに未着手の項目がある: 止まる
  const otherPending = verified(status(base, { a: "done", pr: "pending", merge: "in_progress" }));
  assert.match(apply(otherPending).blockers.join(""), /未着手・進行中の項目が 1 件/);
  // 最後でない項目が進行中: 止まる（数えないのは最後の項目だけ）
  const otherInProgress = verified(
    status(base, { a: "in_progress", pr: "done", merge: "in_progress" }),
  );
  assert.match(apply(otherInProgress).blockers.join(""), /未着手・進行中の項目が 1 件/);
  const onlyOtherInProgress = verified(
    status(base, { a: "done", pr: "in_progress", merge: "done" }),
  );
  assert.match(apply(onlyOtherInProgress).blockers.join(""), /未着手・進行中の項目が 1 件/);
  // マージの項目が未着手のまま: 止まる（着手時に in_progress にしてから呼ぶ）
  const mergePending = verified(status(base, { a: "done", pr: "done" }));
  assert.match(apply(mergePending).blockers.join(""), /未着手・進行中の項目が 1 件/);
});

test("マージのゲート: 計画があるとき、検証・レビュー・未着手の項目の未達を止める", () => {
  const apply = (plan: Plan, over: Partial<MergeGateInput> = {}) =>
    mergeGate(gateInput({ plan, planApplies: true, ...over }));
  const base = done(confirmedPlan());
  // 通る
  assert.deepEqual(apply(verified(base)).blockers, []);
  assert.deepEqual(apply(verified(base)).warnings, []);
  // 検証なし・失敗・古い
  assert.match(apply(base).blockers.join(""), /検証が未実行/);
  assert.match(
    apply(
      recordVerification(base, { command: "c", ok: false, fingerprint: "fp", summary: "" }),
    ).blockers.join(""),
    /検証が失敗/,
  );
  assert.match(apply(verified(base, "old")).blockers.join(""), /最後の検証のあとに/);
  // 未検証（検証コマンドなし）は止めず、注意
  const unverified = recordVerification(base, {
    command: "(なし)",
    ok: true,
    unverified: true,
    fingerprint: "fp",
    summary: "",
  });
  const u = apply(unverified);
  assert.deepEqual(u.blockers, []);
  assert.match(u.warnings.join(""), /未検証/);
  // 未着手・進行中
  const open = { ...verified(confirmedPlan()) };
  assert.match(apply(open).blockers.join(""), /未着手・進行中の項目が 1 件/);
  // レビュー
  const rv = verified(done(confirmedPlan(true)));
  assert.match(apply(rv).blockers.join(""), /レビューが承認されていません/);
  const approved = recordReview(rv, { approved: true, fingerprint: "fp", summary: "" });
  assert.deepEqual(apply(approved).blockers, []);
  const stale = recordReview(rv, { approved: true, fingerprint: "old", summary: "" });
  assert.match(apply(stale).blockers.join(""), /最後のレビューのあとに/);
  // ローカルの HEAD が PR の先頭と違う
  assert.match(apply(verified(base), { headDiffers: true }).warnings.join(""), /HEAD が PR の先頭/);
});

test("完了報告の PR の欄に、記録した PR と注意が出る", () => {
  const plan = {
    ...done(confirmedPlan()),
    prs: [
      {
        number: 4,
        url: "https://example.com/pull/4",
        title: "T",
        merged: false,
        warning: "未保護",
      },
    ],
  };
  const report = renderReport(plan);
  assert.match(
    report,
    /## PR\n- #4 T — 未マージ https:\/\/example.com\/pull\/4\n {2}- 注意: 未保護/,
  );
});

// ---- 実際の git と bare の origin（gh は差し替える）----

type ExecOut = { code: number; stdout: string; stderr: string; killed: boolean };
type GhCall = string[];
type GhHandler = (args: string[]) => Partial<ExecOut>;

const gitEnv = {
  ...process.env,
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@example.com",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@example.com",
};

async function sh(cmd: string, args: string[], cwd: string): Promise<ExecOut> {
  try {
    const r = await run(cmd, args, { cwd, env: gitEnv, maxBuffer: 8 * 1024 * 1024 });
    return { code: 0, stdout: r.stdout, stderr: r.stderr, killed: false };
  } catch (error) {
    const e = error as { code?: number; stdout?: string; stderr?: string };
    return {
      code: typeof e.code === "number" ? e.code : 1,
      stdout: e.stdout ?? "",
      stderr: e.stderr ?? "",
      killed: false,
    };
  }
}
const git = async (cwd: string, ...args: string[]) => {
  const r = await sh("git", args, cwd);
  assert.equal(r.code, 0, `git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout.trim();
};

const tmp = mkdtempSync(path.join(os.tmpdir(), "harness-pr-test-"));

/** bare の origin と、そのクローン（origin の URL は GitHub 風。push だけ bare に向ける） */
async function makeRepo() {
  const dir = mkdtempSync(path.join(tmp, "repo-"));
  const bare = path.join(dir, "origin.git");
  const work = path.join(dir, "work");
  await git(dir, "init", "--bare", "-b", "main", bare);
  await git(dir, "clone", bare, work);
  await git(work, "config", "commit.gpgsign", "false");
  writeFileSync(path.join(work, "a.txt"), "a\n");
  await git(work, "add", "-A");
  await git(work, "commit", "-m", "初期");
  await git(work, "branch", "-M", "main");
  await git(work, "push", "-u", "origin", "main");
  await git(work, "remote", "set-head", "origin", "main");
  await git(work, "remote", "set-url", "origin", "https://github.com/o/r.git");
  await git(work, "config", `url.${bare}.pushInsteadOf`, "https://github.com/o/r.git");
  return { bare, work };
}

type PrTiming = { checkPollMs?: number; checkTimeoutMs?: number; noChecksGraceMs?: number };

interface Harness {
  rt: Runtime;
  tools: Map<string, (params: object, signal?: AbortSignal) => Promise<ToolOut>>;
  handlers: Map<string, ((event: object) => Promise<unknown>)[]>;
  commands: Map<string, (args: string) => Promise<void>>;
  sent: { customType: string }[];
  ghCalls: GhCall[];
  confirms: { title: string; message: string }[];
  saved: Plan[];
  active: () => string[];
  setPlan(plan: Plan | undefined): void;
}
type ToolOut = {
  content: { type: string; text: string }[];
  isError?: boolean;
  details?: unknown;
};

/** registerFlow を、実際の git（cwd で実行）と差し替えた gh で動かす */
function harness(
  cwd: string,
  o: {
    gh?: GhHandler;
    hasUI?: boolean;
    confirm?: boolean;
    rt?: Partial<Runtime>;
    pr?: PrTiming;
    gitStub?: (args: string[]) => Partial<ExecOut> | undefined;
  } = {},
): Harness {
  const handlers = new Map<string, ((event: object) => Promise<unknown>)[]>();
  const tools = new Map<string, (params: object, signal?: AbortSignal) => Promise<ToolOut>>();
  const commands = new Map<string, (args: string) => Promise<void>>();
  const sent: { customType: string }[] = [];
  const ghCalls: GhCall[] = [];
  const confirms: { title: string; message: string }[] = [];
  const saved: Plan[] = [];
  let active = ["read", "bash", "edit", "write", "ask_user", "harness_pr_merge"];
  const rt = runtime({ agentDir: mkdtempSync(path.join(tmp, "agent-")), ...o.rt });
  const ctx = {
    hasUI: o.hasUI ?? true,
    cwd,
    ui: {
      confirm: async (title: string, message: string) => {
        confirms.push({ title, message });
        return o.confirm ?? true;
      },
      select: async () => "確定する",
      input: async () => undefined,
      notify: () => {},
      setStatus: () => {},
      setWidget: () => {},
    },
    sessionManager: {
      getBranch: () => saved.map((p) => ({ type: "custom", customType: "harness-plan", data: p })),
      getSessionId: () => "s",
    },
  };
  const pi = {
    on: (name: string, h: (event: object, ctx: object) => Promise<unknown>) =>
      handlers.set(name, [...(handlers.get(name) ?? []), (e) => h(e, ctx)]),
    registerTool: (t: {
      name: string;
      execute: (
        id: string,
        p: object,
        s: AbortSignal | undefined,
        u: undefined,
        c: object,
      ) => Promise<ToolOut>;
    }) => tools.set(t.name, (p, s) => t.execute("id", p, s, undefined, ctx)),
    registerCommand: (name: string, def: { handler: (args: string, c: object) => Promise<void> }) =>
      commands.set(name, (args) => def.handler(args, ctx)),
    getActiveTools: () => active,
    setActiveTools: (names: string[]) => {
      active = names;
    },
    appendEntry: (_type: string, data: Plan) => {
      if (data) saved.push(data);
    },
    sendMessage: (m: { customType: string }) => {
      sent.push(m);
    },
    exec: async (cmd: string, args: string[], opts: { cwd: string }): Promise<ExecOut> => {
      if (cmd === "gh") {
        ghCalls.push(args);
        const r = o.gh?.(args) ?? {};
        return { code: 0, stdout: "", stderr: "", killed: false, ...r };
      }
      const stub = o.gitStub?.(args);
      if (stub) return { code: 0, stdout: "", stderr: "", killed: false, ...stub };
      return sh(cmd, args, opts.cwd);
    },
  } as unknown as ExtensionAPI;
  registerFlow(pi, rt, {
    pr: { checkPollMs: 1, checkTimeoutMs: 20, noChecksGraceMs: 10, ...o.pr },
  });
  return {
    rt,
    tools,
    handlers,
    commands,
    sent,
    ghCalls,
    confirms,
    saved,
    active: () => active,
    setPlan: (plan) => {
      rt.plan = plan;
    },
  };
}

const call = (h: Harness, name: string, params: object = {}, signal?: AbortSignal) => {
  const t = h.tools.get(name);
  assert.ok(t, name);
  return t(params, signal);
};
const textOf = (r: ToolOut) => r.content.map((c) => c.text).join("\n");
const emit = async (h: Harness, name: string, event: object) => {
  for (const fn of h.handlers.get(name) ?? []) await fn(event);
};
/** ユーザーが入力する */
const say = (h: Harness, text: string, extra: object = {}) =>
  emit(h, "input", { type: "input", text, source: "interactive", ...extra });

async function branchOff(work: string, name = "feat/x") {
  await git(work, "switch", "-c", name);
  writeFileSync(path.join(work, `${name.replace("/", "-")}.txt`), "x\n");
  await git(work, "add", "-A");
  await git(work, "commit", "-m", "feat: x を追加");
}

const PR_URL = "https://github.com/o/r/pull/7";
const createGh: GhHandler = (args) => {
  const a = args.join(" ");
  if (a.startsWith("api ") && a.includes("/rules/branches/"))
    return { stdout: '[{"type":"pull_request"}]' };
  if (a.startsWith("api ")) return { code: 1, stderr: "gh: Branch not protected (HTTP 404)" };
  if (a.startsWith("pr list")) return { stdout: "[]" };
  if (a.startsWith("pr create")) return { stdout: `${PR_URL}\n` };
  return {};
};

test("harness_pr_create: 既定ブランチ上・未コミット・detached HEAD・差分なし・git の外は拒否し、直し方を返す", async () => {
  const { work } = await makeRepo();
  const h = harness(work);

  // 既定ブランチ上
  const onMain = await call(h, "harness_pr_create", { title: "t" });
  assert.equal(onMain.isError, true);
  assert.match(textOf(onMain), /既定ブランチ\(main\)上では/);
  assert.match(textOf(onMain), /git switch -c/);
  assert.match(textOf(onMain), /1 コミット = 1 つの目的/);

  // 作業ブランチでも、差分のコミットが無い
  await git(work, "switch", "-c", "feat/empty");
  const empty = await call(h, "harness_pr_create", { title: "t" });
  assert.equal(empty.isError, true);
  assert.match(textOf(empty), /差分のコミットがありません/);

  // 未コミットの変更
  writeFileSync(path.join(work, "dirty.txt"), "d\n");
  const dirty = await call(h, "harness_pr_create", { title: "t" });
  assert.equal(dirty.isError, true);
  assert.match(textOf(dirty), /コミットされていない変更/);
  assert.match(textOf(dirty), /dirty\.txt/);
  assert.match(textOf(dirty), /git add -p/);

  // detached HEAD
  await git(work, "add", "-A");
  await git(work, "commit", "-m", "feat: d");
  await git(work, "checkout", "--detach");
  const detached = await call(h, "harness_pr_create", { title: "t" });
  assert.equal(detached.isError, true);
  assert.match(textOf(detached), /detached HEAD/);

  // git の外
  const outside = mkdtempSync(path.join(tmp, "outside-"));
  const out = await call(harness(outside), "harness_pr_create", { title: "t" });
  assert.equal(out.isError, true);
  assert.match(textOf(out), /git のリポジトリの外/);

  // どの拒否でも、push も gh の呼び出しも起きない
  assert.deepEqual(h.ghCalls, []);
  assert.equal(
    (await sh("git", ["branch", "--list"], path.join(work, "..", "origin.git"))).stdout.includes(
      "feat",
    ),
    false,
  );
});

test("harness_pr_create: origin/HEAD が指す既定ブランチ（設定にない名前）上でも拒否する", async () => {
  const { work } = await makeRepo();
  await git(work, "switch", "-c", "trunk");
  await git(work, "update-ref", "refs/remotes/origin/trunk", "HEAD");
  await git(work, "symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/trunk");
  const r = await call(harness(work), "harness_pr_create", { title: "t" });
  assert.equal(r.isError, true);
  assert.match(textOf(r), /既定ブランチ\(trunk\)上/);
});

test("harness_pr_create: push（force なし・upstream 設定）して PR を作り、本文は固定の形。計画に記録する", async () => {
  const { work, bare } = await makeRepo();
  await branchOff(work);
  await git(work, "commit", "--allow-empty", "-m", "docs: 追従");
  const h = harness(work, { gh: createGh });
  const plan = verified(done(confirmedPlan()));
  h.setPlan(plan);

  const r = await call(h, "harness_pr_create", { title: "x を追加", summary: "x を足す" });
  assert.notEqual(r.isError, true);
  assert.match(textOf(r), /PR を作成しました: #7 https:\/\/github\.com\/o\/r\/pull\/7/);
  assert.doesNotMatch(textOf(r), /注意/);

  // push された（bare にブランチがある。upstream が設定された）
  assert.ok((await git(bare, "branch", "--list", "feat/x")).includes("feat/x"));
  assert.equal(await git(work, "rev-parse", "--abbrev-ref", "feat/x@{upstream}"), "origin/feat/x");

  // gh pr create の引数と本文
  const create = h.ghCalls.find((a) => a[0] === "pr" && a[1] === "create") as string[];
  assert.ok(create);
  assert.equal(create[create.indexOf("--base") + 1], "main");
  assert.equal(create[create.indexOf("--head") + 1], "feat/x");
  assert.equal(create[create.indexOf("--title") + 1], "x を追加");
  const body = create[create.indexOf("--body") + 1] ?? "";
  assert.ok(body.startsWith(BODY_BEGIN) && body.endsWith(BODY_END));
  assert.ok(body.includes("x を足す"));
  // コミットは古い順
  assert.ok(body.indexOf("- feat: x を追加") < body.indexOf("- docs: 追従"));
  assert.ok(body.includes("成功: `c`"));

  // 計画に記録（merged: false）
  assert.deepEqual(h.saved.at(-1)?.prs, [
    { number: 7, url: PR_URL, title: "x を追加", merged: false },
  ]);
  assert.equal(h.rt.plan?.prs.length, 1);
});

test("harness_pr_create: 既にある PR は更新し、マーカーの外側（ユーザーの記述）を残す。計画が無ければ記録しない", async () => {
  const { work } = await makeRepo();
  await branchOff(work);
  const existing = `前置き\n\n${buildPrBody({ summary: "旧", commits: ["古い"] })}\n\nCloses #1`;
  const h = harness(work, {
    gh: (args) => {
      if (args[0] === "pr" && args[1] === "list")
        return {
          stdout: JSON.stringify([
            { number: 5, url: "https://github.com/o/r/pull/5", body: existing },
          ]),
        };
      return createGh(args);
    },
  });
  const r = await call(h, "harness_pr_create", { title: "改題", summary: "新" });
  assert.match(textOf(r), /PR を更新しました: #5/);
  assert.equal(
    h.ghCalls.some((a) => a[1] === "create"),
    false,
  );
  const edit = h.ghCalls.find((a) => a[0] === "pr" && a[1] === "edit") as string[];
  assert.equal(edit[2], "5");
  const body = edit[edit.indexOf("--body") + 1] ?? "";
  assert.ok(body.startsWith("前置き\n\n"));
  assert.ok(body.endsWith("\n\nCloses #1"));
  assert.ok(body.includes("新") && !body.includes("旧"));
  assert.ok(body.includes("**未検証**"), "計画が無ければ未検証");
  assert.equal(h.saved.length, 0);
});

test("harness_pr_create: 既定ブランチが未保護・確認できなければ、結果と計画に知らせて先へ進む（設定はしない）", async () => {
  const { work } = await makeRepo();
  await branchOff(work);
  const unprotected: GhHandler = (args) => {
    const a = args.join(" ");
    if (a.startsWith("api ") && a.includes("/rules/branches/")) return { stdout: "[]" };
    return createGh(args);
  };
  const h = harness(work, { gh: unprotected });
  h.setPlan(confirmedPlan());
  const r = await call(h, "harness_pr_create", { title: "t" });
  assert.notEqual(r.isError, true);
  assert.match(textOf(r), /注意: 既定ブランチ\(main\)が GitHub で保護されていません/);
  assert.match(h.saved.at(-1)?.prs[0]?.warning ?? "", /保護されていません/);
  // 確かめるだけ: 書き込みの gh api は呼ばない
  assert.ok(
    h.ghCalls
      .filter((a) => a[0] === "api")
      .every((a) => !a.includes("-X") && !a.includes("POST") && !a.includes("--input")),
  );

  // 認証・権限で確かめられない
  const { work: work2 } = await makeRepo();
  await branchOff(work2);
  const h2 = harness(work2, {
    gh: (args) => (args[0] === "api" ? { code: 1, stderr: "gh: auth required" } : createGh(args)),
  });
  const r2 = await call(h2, "harness_pr_create", { title: "t" });
  assert.notEqual(r2.isError, true);
  assert.match(textOf(r2), /確認できませんでした/);
});

test("harness_pr_create: push に失敗したら、PR は作らない", async () => {
  const { work, bare } = await makeRepo();
  await branchOff(work);
  await git(
    work,
    "config",
    `url.${path.join(bare, "missing")}.pushInsteadOf`,
    "https://github.com/o/r.git",
  );
  await git(work, "config", "--unset-all", `url.${bare}.pushInsteadOf`);
  const h = harness(work, { gh: createGh });
  const r = await call(h, "harness_pr_create", { title: "t" });
  assert.equal(r.isError, true);
  assert.match(textOf(r), /push に失敗/);
  assert.equal(
    h.ghCalls.some((a) => a[0] === "pr"),
    false,
  );
});

// ---- 偽の pi・ctx: ツール一覧の出し入れとマージ ----

test("harness_pr_merge: 依頼の無い実行ではツール一覧に無く、依頼のある実行でだけ出る", async () => {
  const h = harness("/nowhere");
  await emit(h, "session_start", { reason: "startup" });
  assert.ok(!h.active().includes("harness_pr_merge"), "既定は出さない");
  assert.ok(h.active().includes("bash"));

  await say(h, "README を直して");
  assert.ok(!h.active().includes("harness_pr_merge"));
  await say(h, "PR 7 をマージして");
  assert.ok(h.active().includes("harness_pr_merge"));
  // 拡張が送った入力は依頼ではない（状態を変えない）
  await say(h, "マージ", { source: "extension" });
  assert.ok(h.active().includes("harness_pr_merge"));
  // 実行中の追加入力は足すだけ
  await say(h, "typo も", { streamingBehavior: "steer" });
  assert.ok(h.active().includes("harness_pr_merge"));
  // 次の依頼にマージが無ければ外れる
  await say(h, "ありがとう");
  assert.ok(!h.active().includes("harness_pr_merge"));
  // /skill: の展開前の生の入力で判定する
  await say(h, "/skill:foo");
  assert.ok(!h.active().includes("harness_pr_merge"));
  await say(h, "merge it");
  assert.ok(h.active().includes("harness_pr_merge"));
});

test("ツール一覧の出し入れ: ask_user と harness_pr_merge は互いの変更を消さず、ほかのツールは残す", async () => {
  const plan = confirmedPlan();
  const h = harness("/nowhere", { rt: { plan } });
  // 確定した計画を復元: ask_user を外す。merge は出さない
  h.saved.push(plan);
  await emit(h, "session_start", { reason: "resume" });
  assert.ok(!h.active().includes("ask_user"));
  assert.ok(!h.active().includes("harness_pr_merge"));

  // マージの依頼: merge を足しても、ask_user は戻らない
  await say(h, "マージして");
  assert.ok(h.active().includes("harness_pr_merge"));
  assert.ok(!h.active().includes("ask_user"));

  // 計画が完了（ask_user を戻す）: merge は残る
  h.saved.push(done(plan));
  await emit(h, "session_tree", {});
  assert.ok(h.active().includes("ask_user"));
  assert.ok(h.active().includes("harness_pr_merge"));
  for (const keep of ["read", "bash", "edit", "write"]) assert.ok(h.active().includes(keep), keep);

  // 計画が再び自律: ask_user だけ外れ、merge は残る
  h.saved.push(plan);
  await emit(h, "session_tree", {});
  assert.ok(!h.active().includes("ask_user"));
  assert.ok(h.active().includes("harness_pr_merge"));
  // 依頼が消えれば merge だけ外れる
  await say(h, "続けて");
  assert.ok(!h.active().includes("harness_pr_merge"));
  assert.ok(!h.active().includes("ask_user"));
});

test("harness_pr_merge: 依頼はその実行の間だけ。実行が終わると（agent_settled）消え、ツール一覧から外れる", async () => {
  const h = harness("/nowhere");
  await emit(h, "session_start", { reason: "startup" });
  await say(h, "PR 7 をマージして");
  assert.equal(h.rt.mergeRequested, true);
  assert.ok(h.active().includes("harness_pr_merge"));
  // 中断で終わっても、普通に終わっても消える
  await emit(h, "agent_settled", { type: "agent_settled", aborted: false });
  assert.equal(h.rt.mergeRequested, false);
  assert.ok(!h.active().includes("harness_pr_merge"));
  for (const keep of ["read", "bash", "edit", "write"]) assert.ok(h.active().includes(keep), keep);
  // 実行時の確認でも止まる（ダイアログも出さない）
  const r = await call(h, "harness_pr_merge", {});
  assert.equal(r.isError, true);
  assert.match(textOf(r), /「マージ」「merge」が含まれていない/);
  assert.equal(h.confirms.length, 0);

  await say(h, "merge して");
  await emit(h, "agent_settled", { type: "agent_settled", aborted: true });
  assert.equal(h.rt.mergeRequested, false);
  assert.ok(!h.active().includes("harness_pr_merge"));
});

test("harness_pr_merge: 実行中の steer・followUp で依頼が加わると、依頼の無い状態から有る状態に変わる", async () => {
  for (const streamingBehavior of ["steer", "followUp"] as const) {
    const h = harness("/nowhere");
    await emit(h, "session_start", { reason: "startup" });
    await say(h, "README を直して");
    assert.equal(h.rt.mergeRequested, false);
    assert.ok(!h.active().includes("harness_pr_merge"));
    await say(h, "終わったらマージもして", { streamingBehavior });
    assert.equal(h.rt.mergeRequested, true, streamingBehavior);
    assert.ok(h.active().includes("harness_pr_merge"), streamingBehavior);
    // その実行が終われば消える
    await emit(h, "agent_settled", { type: "agent_settled", aborted: false });
    assert.ok(!h.active().includes("harness_pr_merge"), streamingBehavior);
  }
});

test("harness_pr_merge: /plan resume で始めた実行（input を通らない）では出ない。前の実行の依頼は残らない", async () => {
  const r = proposePlan(
    "目的",
    [
      { id: "a", title: "A", acceptance: "x" },
      { id: "merge", title: "マージする", acceptance: "マージ済み", kind: "task" },
    ],
    Date.now(),
  );
  assert.ok(r.ok);
  const plan: Plan = { ...r.value, confirmed: true };
  const h = harness("/nowhere");
  h.saved.push(plan);
  await emit(h, "session_start", { reason: "startup" });
  // マージを依頼した実行が、中断で一時停止になって終わる
  await say(h, "計画どおり進めて、最後にマージして");
  assert.ok(h.active().includes("harness_pr_merge"));
  h.saved.push(pausePlan(plan, "中断(Esc)"));
  await emit(h, "session_tree", {});
  await emit(h, "agent_settled", { type: "agent_settled", aborted: true });

  // /plan resume: 続きを促すメッセージで新しい実行を始める（input は通らない）
  const resume = h.commands.get("plan");
  assert.ok(resume);
  await resume("resume");
  assert.equal(h.sent.at(-1)?.customType, "harness-continue");
  assert.equal(h.rt.plan?.paused, false);
  assert.equal(h.rt.mergeRequested, false);
  assert.ok(!h.active().includes("harness_pr_merge"));
  const merge = await call(h, "harness_pr_merge", {});
  assert.equal(merge.isError, true);
  assert.equal(h.confirms.length, 0);
  // ユーザーが改めて依頼すれば出る
  await say(h, "マージして");
  assert.ok(h.active().includes("harness_pr_merge"));
});

test("/plan resume は、実行が始まらずに残った依頼と拒否の記録を戻す", async () => {
  const plan = pausePlan(confirmedPlan(), "エラーで終了");
  const h = harness("/nowhere");
  h.saved.push(plan);
  await emit(h, "session_start", { reason: "startup" });
  // 依頼は数えたが、実行が始まらなかった（認証切れなど。agent_settled は来ない）
  await say(h, "マージして");
  h.rt.mergeDeclined = true;
  assert.ok(h.active().includes("harness_pr_merge"));

  const plan_ = h.commands.get("plan");
  assert.ok(plan_);
  await plan_("resume");
  assert.equal(h.rt.mergeRequested, false);
  assert.equal(h.rt.mergeDeclined, false);
  assert.ok(!h.active().includes("harness_pr_merge"));
  assert.ok(!h.active().includes("ask_user"), "再開した計画は自律で進む");
});

const mergeGh =
  (over: { checks?: string; state?: string; head?: string; branch?: string } = {}): GhHandler =>
  (args) => {
    const a = args.join(" ");
    if (a.startsWith("pr list")) return { stdout: '[{"number":7}]' };
    if (a.startsWith("pr view"))
      return {
        stdout: JSON.stringify({
          number: 7,
          url: PR_URL,
          title: "x を追加",
          state: over.state ?? "OPEN",
          headRefName: over.branch ?? "feat/x",
          headRefOid: over.head ?? "abc",
        }),
      };
    if (a.startsWith("pr checks")) {
      return over.checks === "none"
        ? { code: 1, stderr: "no checks reported" }
        : { stdout: over.checks ?? '[{"name":"q","bucket":"pass"}]' };
    }
    return {};
  };
/** git の呼び出しを、現在のブランチ・HEAD だけ偽にする（ほかは cwd で実際に実行する） */
const gitStub = (args: string[]) => {
  const a = args.join(" ");
  if (a === "rev-parse HEAD") return { stdout: "abc\n" };
  return undefined;
};

async function mergeSetup(
  o: {
    gh?: GhHandler;
    hasUI?: boolean;
    confirm?: boolean;
    plan?: Plan | ((fp: string) => Plan);
    pr?: PrTiming;
    request?: boolean;
  } = {},
) {
  const { work } = await makeRepo();
  await branchOff(work);
  const h = harness(work, {
    gh: o.gh ?? mergeGh(),
    hasUI: o.hasUI ?? true,
    confirm: o.confirm ?? true,
    gitStub,
    ...(o.pr ? { pr: o.pr } : {}),
  });
  await emit(h, "session_start", { reason: "startup" });
  if (o.request !== false) await say(h, "PR 7 をマージして");
  const fp = await workingTreeFingerprint({
    listFiles: async () =>
      (await git(work, "ls-files", "--cached", "--others", "--exclude-standard", "-z"))
        .split("\0")
        .filter(Boolean),
    read: fsReader(work),
  });
  if (o.plan) h.setPlan(typeof o.plan === "function" ? o.plan(fp) : o.plan);
  return { h, work, fp };
}
const merged = (h: Harness) => h.ghCalls.filter((a) => a[0] === "pr" && a[1] === "merge");

test("harness_pr_merge: 実行時にも依頼を確かめる（依頼が無ければ、ダイアログも出さずマージしない）", async () => {
  const { h } = await mergeSetup({ request: false });
  const r = await call(h, "harness_pr_merge", {});
  assert.equal(r.isError, true);
  assert.match(textOf(r), /「マージ」「merge」が含まれていない/);
  assert.equal(h.confirms.length, 0);
  assert.equal(merged(h).length, 0);
});

test("harness_pr_merge: 確認ダイアログで拒否すればマージしない", async () => {
  const { h } = await mergeSetup({ confirm: false });
  const r = await call(h, "harness_pr_merge", {});
  assert.equal(r.isError, true);
  assert.match(textOf(r), /許可しませんでした/);
  assert.equal(h.confirms.length, 1);
  assert.equal(merged(h).length, 0);
});

test("harness_pr_merge: 拒否したら、同じ実行の中ではダイアログを出さずに止める。実行が終わって改めて依頼されれば、また出す", async () => {
  const { h } = await mergeSetup({ confirm: false });
  const first = await call(h, "harness_pr_merge", {});
  assert.equal(first.isError, true);
  assert.match(textOf(first), /許可しませんでした/);
  assert.match(textOf(first), /plan_update の deferred\(理由: ユーザーがマージを拒否した\)/);
  assert.equal(h.confirms.length, 1);
  assert.equal(h.rt.mergeDeclined, true);

  // 同じ実行の中で呼び直す（自律ループの継続など）: ダイアログを出さない。gh も呼ばない
  const ghBefore = h.ghCalls.length;
  const again = await call(h, "harness_pr_merge", {});
  assert.equal(again.isError, true);
  assert.match(textOf(again), /この依頼ではユーザーがマージを拒否しました/);
  assert.match(textOf(again), /deferred/);
  assert.equal(h.confirms.length, 1);
  assert.equal(h.ghCalls.length, ghBefore);
  // 同じ実行の中の追加入力でマージを言っても、拒否は残る
  await say(h, "やっぱりマージして", { streamingBehavior: "steer" });
  await call(h, "harness_pr_merge", {});
  assert.equal(h.confirms.length, 1);

  // 実行が終わると、依頼と一緒に拒否の記録も戻る
  await emit(h, "agent_settled", { type: "agent_settled", aborted: false });
  assert.equal(h.rt.mergeDeclined, false);
  // 改めて依頼されれば、またダイアログを出す
  await say(h, "PR 7 をマージして");
  const retry = await call(h, "harness_pr_merge", {});
  assert.match(textOf(retry), /許可しませんでした/);
  assert.equal(h.confirms.length, 2);
  assert.equal(merged(h).length, 0);
});

test("harness_pr_merge: ゲートで止めたときの結果に、計画のマージの項目を deferred にする案内を書く", async () => {
  const { h } = await mergeSetup({ gh: mergeGh({ checks: '[{"name":"q","bucket":"fail"}]' }) });
  const r = await call(h, "harness_pr_merge", {});
  assert.equal(r.isError, true);
  assert.match(textOf(r), /plan_update の deferred\(理由: 上の止めた理由\)/);
  // ゲートで止めたのは拒否ではないので、記録しない
  assert.equal(h.rt.mergeDeclined, false);
});

test("harness_pr_merge: 許可すれば `gh pr merge <番号> --merge` を、--delete-branch なしで呼ぶ。ダイアログに PR の情報と注意を出す", async () => {
  const { h } = await mergeSetup({});
  const r = await call(h, "harness_pr_merge", {});
  assert.notEqual(r.isError, true);
  assert.deepEqual(merged(h), [["pr", "merge", "7", "--merge"]]);
  assert.ok(!h.ghCalls.flat().includes("--delete-branch"));
  const dialog = h.confirms[0];
  assert.ok(dialog);
  for (const s of ["#7", "x を追加", PR_URL, "CI: 成功", "注意", "確定した計画がありません"])
    assert.ok(dialog.message.includes(s), s);
  assert.match(textOf(r), /ブランチは削除していません/);
  // 計画が無ければ記録しない
  assert.equal(h.saved.length, 0);
});

test("harness_pr_merge: 計画が確定済みで PR のブランチが今のブランチなら、ゲートを通り、plan.prs にマージ済みで記録する", async () => {
  const { h } = await mergeSetup({
    plan: (fp) => ({
      ...verified(done(confirmedPlan()), fp),
      prs: [{ number: 7, url: PR_URL, title: "旧題", merged: false, warning: "未保護" }],
    }),
  });
  const r = await call(h, "harness_pr_merge", { number: 7 });
  assert.notEqual(r.isError, true);
  assert.equal(merged(h).length, 1);
  assert.doesNotMatch(h.confirms[0]?.message ?? "", /注意/);
  assert.deepEqual(h.saved.at(-1)?.prs, [
    { number: 7, url: PR_URL, title: "x を追加", merged: true, warning: "未保護" },
  ]);
});

test("harness_pr_merge: 計画があって検証・項目が未達なら止める（ダイアログも出さない）", async () => {
  const { h } = await mergeSetup({ plan: confirmedPlan() });
  const r = await call(h, "harness_pr_merge", {});
  assert.equal(r.isError, true);
  assert.match(textOf(r), /マージしません/);
  assert.match(textOf(r), /検証が未実行/);
  assert.match(textOf(r), /未着手・進行中の項目が 1 件/);
  assert.equal(h.confirms.length, 0);
  assert.equal(merged(h).length, 0);

  // 検証が古い（検証のあとに変更があった）
  const stale = await mergeSetup({ plan: () => verified(done(confirmedPlan()), "old") });
  const r2 = await call(stale.h, "harness_pr_merge", {});
  assert.match(textOf(r2), /最後の検証のあとに/);
  assert.equal(merged(stale.h).length, 0);
});

test("harness_pr_merge: 別のブランチの PR には計画のゲートを効かせず、注意として出す", async () => {
  const { h } = await mergeSetup({
    plan: confirmedPlan(),
    gh: mergeGh({ branch: "feat/other" }),
  });
  const r = await call(h, "harness_pr_merge", {});
  assert.notEqual(r.isError, true);
  assert.match(h.confirms[0]?.message ?? "", /作業ブランチのものではありません/);
  assert.equal(merged(h).length, 1);
});

test("harness_pr_merge: CI の失敗・実行中（待っても終わらない）は止める。CI なしは注意として出して進む", async () => {
  const failed = await mergeSetup({ gh: mergeGh({ checks: '[{"name":"q","bucket":"fail"}]' }) });
  const r1 = await call(failed.h, "harness_pr_merge", {});
  assert.equal(r1.isError, true);
  assert.match(textOf(r1), /CI のチェックが失敗/);
  assert.equal(failed.h.confirms.length, 0);
  assert.equal(merged(failed.h).length, 0);

  const pending = await mergeSetup({
    gh: mergeGh({ checks: '[{"name":"q","bucket":"pending"}]' }),
  });
  const r2 = await call(pending.h, "harness_pr_merge", {});
  assert.equal(r2.isError, true);
  assert.match(textOf(r2), /終わりません/);
  assert.ok(pending.h.ghCalls.filter((a) => a[1] === "checks").length > 1, "待ち直している");
  assert.equal(merged(pending.h).length, 0);

  const none = await mergeSetup({ gh: mergeGh({ checks: "none" }) });
  const r3 = await call(none.h, "harness_pr_merge", {});
  assert.notEqual(r3.isError, true);
  assert.match(none.h.confirms[0]?.message ?? "", /CI のチェックがありません/);
  assert.equal(merged(none.h).length, 1);
});

test("harness_pr_merge: 実行中の CI が終われば進む。中断できる", async () => {
  let n = 0;
  const flip: GhHandler = (args) => {
    if (args[0] === "pr" && args[1] === "checks") {
      n++;
      return { stdout: `[{"name":"q","bucket":"${n < 3 ? "pending" : "pass"}"}]` };
    }
    return mergeGh()(args);
  };
  const ok = await mergeSetup({ gh: flip, pr: { checkTimeoutMs: 5000 } });
  assert.notEqual((await call(ok.h, "harness_pr_merge", {})).isError, true);
  assert.equal(merged(ok.h).length, 1);

  const aborted = await mergeSetup({
    gh: mergeGh({ checks: '[{"name":"q","bucket":"pending"}]' }),
    pr: { checkTimeoutMs: 60_000 },
  });
  const ac = new AbortController();
  const pendingCall = call(aborted.h, "harness_pr_merge", {}, ac.signal);
  setTimeout(() => ac.abort(), 20);
  const r = await pendingCall;
  assert.equal(r.isError, true);
  assert.match(textOf(r), /中断/);
  assert.equal(merged(aborted.h).length, 0);
});

test("harness_pr_merge: CI の状態を取得できない（通信・認証など）ときは、待たずに止める（CI なしの扱いにしない）", async () => {
  for (const failure of [
    { code: 1, stderr: "error connecting to api.github.com" },
    { code: 4, stderr: "gh auth login" },
  ]) {
    const h = (
      await mergeSetup({
        gh: (args) => (args[0] === "pr" && args[1] === "checks" ? failure : mergeGh()(args)),
      })
    ).h;
    const r = await call(h, "harness_pr_merge", {});
    assert.equal(r.isError, true);
    assert.match(textOf(r), /CI の状態を取得できませんでした/);
    assert.match(textOf(r), new RegExp(`終了コード ${failure.code}`));
    assert.equal(h.ghCalls.filter((a) => a[1] === "checks").length, 1, "待ち直さない");
    assert.equal(h.confirms.length, 0);
    assert.equal(merged(h).length, 0);
  }
});

test("harness_pr_merge: 中断は CI の判定より先に見る（中断後は gh を呼ばず、CI が通っていても進めない）", async () => {
  // 呼ぶ前に中断されている: gh pr checks を呼ばない
  const before = await mergeSetup({});
  const ac = new AbortController();
  ac.abort();
  const r1 = await call(before.h, "harness_pr_merge", {}, ac.signal);
  assert.equal(r1.isError, true);
  assert.match(textOf(r1), /中断/);
  assert.equal(before.h.ghCalls.filter((a) => a[1] === "checks").length, 0);
  assert.equal(before.h.confirms.length, 0);
  assert.equal(merged(before.h).length, 0);

  // gh pr checks の実行中に中断され、その結果は成功: 判定せずに止める
  const ac2 = new AbortController();
  const during = await mergeSetup({
    gh: (args) => {
      if (args[0] === "pr" && args[1] === "checks") {
        ac2.abort();
        return { stdout: '[{"name":"q","bucket":"pass"}]' };
      }
      return mergeGh()(args);
    },
  });
  const r2 = await call(during.h, "harness_pr_merge", {}, ac2.signal);
  assert.equal(r2.isError, true);
  assert.match(textOf(r2), /中断/);
  assert.equal(during.h.confirms.length, 0);
  assert.equal(merged(during.h).length, 0);

  // 待ちの間に中断され、次の確認では CI が通る: gh を呼び直さずに止める
  let n = 0;
  const ac3 = new AbortController();
  const sleeping = await mergeSetup({
    gh: (args) => {
      if (args[0] === "pr" && args[1] === "checks") {
        n++;
        if (n === 1) setTimeout(() => ac3.abort(), 5);
        return { stdout: `[{"name":"q","bucket":"${n === 1 ? "pending" : "pass"}"}]` };
      }
      return mergeGh()(args);
    },
    pr: { checkPollMs: 60_000, checkTimeoutMs: 120_000 },
  });
  const r3 = await call(sleeping.h, "harness_pr_merge", {}, ac3.signal);
  assert.equal(r3.isError, true);
  assert.match(textOf(r3), /中断/);
  assert.equal(n, 1, "中断後に gh pr checks を呼ばない");
  assert.equal(merged(sleeping.h).length, 0);
});

test("harness_pr_merge: UI が無ければ止める。open でない PR・PR が無いときも止める", async () => {
  const noUi = await mergeSetup({ hasUI: false });
  const r = await call(noUi.h, "harness_pr_merge", {});
  assert.equal(r.isError, true);
  assert.match(textOf(r), /UI/);
  assert.equal(noUi.h.confirms.length, 0);
  assert.equal(merged(noUi.h).length, 0);

  const closed = await mergeSetup({ gh: mergeGh({ state: "MERGED" }) });
  assert.match(textOf(await call(closed.h, "harness_pr_merge", {})), /open ではありません/);
  assert.equal(merged(closed.h).length, 0);

  const none = await mergeSetup({ gh: () => ({ stdout: "[]" }) });
  assert.match(textOf(await call(none.h, "harness_pr_merge", {})), /PR が見つかりません/);
});

test("サブエージェントには、PR のツールも入力の購読も登録しない", () => {
  const h = harness("/nowhere", { rt: { isSubagent: true } });
  assert.equal(h.tools.size, 0);
  assert.equal(h.handlers.size, 0);
});
