import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { nextMergeRequested } from "../guards/merge.ts";
import type { Runtime } from "../lib/runtime.ts";
import { type Plan, type PrRecord, recordPr } from "./plan.ts";
import {
  type ApiResult,
  applyGeneratedSection,
  buildPrBody,
  type ChecksResult,
  checksLabel,
  judgeChecksResult,
  judgeProtection,
  mergeGate,
  parseGithubRemote,
  protectionNotice,
} from "./pr.ts";
import { PR_MERGE, syncActiveTools } from "./tools.ts";

/** テストで短くする、CI を待つ間隔と上限 */
export interface PrDeps {
  checkPollMs?: number;
  /** 実行中のチェックを待つ上限 */
  checkTimeoutMs?: number;
  /** チェックがまだ登録されていない(none)ときに待つ上限 */
  noChecksGraceMs?: number;
}

/** flow が持つ、計画の保存と作業ツリーの指紋 */
export interface FlowBridge {
  save(plan: Plan | undefined, ctx: ExtensionContext): void;
  fingerprint(ctx: ExtensionContext): Promise<string>;
}

const ok = (t: string) => ({ content: [{ type: "text" as const, text: t }], details: undefined });
/** 失敗・拒否。`isError` を立てるので、完了の合図の「成果物を作る操作」には数えない */
const fail = (t: string) => ({
  content: [{ type: "text" as const, text: t }],
  details: undefined,
  isError: true,
});

/** 拒否・ゲートで止めたときに、計画のマージの項目をどう扱うか */
const DEFER_GUIDE = (reason: string) =>
  `計画にマージの項目があれば、plan_update の deferred(理由: ${reason})にして、残りの項目を進めてください。`;

const COMMIT_GUIDE =
  "コミットは、1 コミット = 1 つの目的で分ける(変更とそれに追従する docs・テストは同じコミット。単位はファイルまでで `git add -p` はしない。土台から先に。メッセージは既存の履歴の文体に合わせる。秘密ファイルは add しない)。";

/**
 * PR の作成・更新(`harness_pr_create`)と、依頼ゲートつきのマージ(`harness_pr_merge`)。
 * メインだけが使う(`registerFlow` から呼ぶ)。git・gh は pi.exec で、ホストで実行する。
 *
 * - bash からの `gh pr create / edit / merge` と、`gh api` での PR の書き込みは、ガードが拒否してここへ誘導する
 * - マージは、ユーザーの入力に「マージ」「merge」があるとき(`rt.mergeRequested`)だけツール一覧に出す。
 *   依頼はその実行の間だけ有効で、実行が終わったら(`agent_settled`)消す(決定 012)。
 *   実行時にも依頼を確かめ、確認ダイアログで許可されたときだけ、`gh pr merge <番号> --merge` を行う。
 *   `--delete-branch` は付けない(リモートのマージ済みブランチは GitHub Actions が消す)
 */
export function registerPrTools(
  pi: ExtensionAPI,
  rt: Runtime,
  flow: FlowBridge,
  deps: PrDeps = {},
): void {
  if (rt.isSubagent) return;
  const pollMs = deps.checkPollMs ?? 15_000;
  const checkTimeoutMs = deps.checkTimeoutMs ?? 20 * 60_000;
  const noChecksGraceMs = deps.noChecksGraceMs ?? 60_000;

  // ---- マージの依頼 ----
  // 拡張が送った入力はユーザーの依頼ではないので数えない。event.text は /skill:… の展開前なので、
  // スキル本文中の「マージ」には反応しない
  pi.on("input", async (event) => {
    if (event.source !== "extension") {
      rt.mergeRequested = nextMergeRequested(
        rt.mergeRequested,
        event.text,
        event.streamingBehavior !== undefined,
      );
      syncActiveTools(pi, rt);
    }
    return { action: "continue" };
  });

  // 依頼は、その実行(steer・followUp を含む)の間だけ有効。実行が終わったら消し、ツール一覧から外す。
  // `/plan resume` は input を通らずに実行を始めるので、前の実行の依頼が残っていると、
  // 依頼の無い実行でマージできてしまう(決定 003 の「依頼が無ければダイアログも出さない」に反する)
  // 確認ダイアログの拒否の記録も、依頼と一緒に戻す
  pi.on("agent_settled", async () => {
    if (!rt.mergeRequested && !rt.mergeDeclined) return;
    rt.mergeRequested = false;
    rt.mergeDeclined = false;
    syncActiveTools(pi, rt);
  });

  // ---- git・gh ----
  async function run(cmd: "git" | "gh", cwd: string, args: string[], timeout = 30_000) {
    try {
      return await pi.exec(cmd, args, { cwd, timeout, maxBuffer: 8 * 1024 * 1024 });
    } catch (error) {
      // コマンドが無い・cwd が無いなど。失敗として扱う
      return {
        code: 127,
        stdout: "",
        stderr: error instanceof Error ? error.message : String(error),
        killed: false,
      };
    }
  }
  const git = (cwd: string, args: string[], timeout?: number) => run("git", cwd, args, timeout);
  const gh = (cwd: string, args: string[], timeout?: number) => run("gh", cwd, args, timeout);
  const out = async (cwd: string, args: string[]) => {
    const r = await git(cwd, args);
    return r.code === 0 ? r.stdout.trim() : "";
  };

  /** 既定ブランチの名前(origin/HEAD の指す先、無ければ設定の候補のうち origin にあるもの) */
  async function defaultBranches(root: string): Promise<{ names: Set<string>; base: string }> {
    const names = new Set(rt.config.defaultBranches);
    const head = await out(root, ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"]);
    let base = head.startsWith("origin/") ? head.slice("origin/".length) : "";
    if (base) names.add(base);
    else {
      for (const name of rt.config.defaultBranches) {
        const r = await git(root, [
          "rev-parse",
          "--verify",
          "--quiet",
          `refs/remotes/origin/${name}`,
        ]);
        if (r.code === 0) {
          base = name;
          break;
        }
      }
    }
    return { names, base: base || (rt.config.defaultBranches[0] ?? "main") };
  }

  /** 既定ブランチが保護されているか(ルールセットとブランチ保護)を確かめる。作らない(決定 007) */
  async function checkProtection(root: string, base: string) {
    const remote = parseGithubRemote(await out(root, ["remote", "get-url", "origin"]));
    if (!remote) return protectionNotice("unknown", base);
    const slug = `${remote.owner}/${remote.repo}`;
    const branch = encodeURIComponent(base);
    const toApi = (r: ApiResult): ApiResult => ({
      code: r.code,
      stdout: r.stdout,
      stderr: r.stderr,
    });
    const rules = toApi(await gh(root, ["api", `repos/${slug}/rules/branches/${branch}`]));
    const classic = toApi(await gh(root, ["api", `repos/${slug}/branches/${branch}/protection`]));
    return protectionNotice(judgeProtection(rules, classic), base);
  }

  // ---- harness_pr_create ----
  pi.registerTool({
    name: "harness_pr_create",
    label: "PR を作成・更新",
    description:
      "今の作業ブランチを push し(`git push -u origin <ブランチ>`。force はしない)、PR を作る。すでにあれば更新する。確認は出さない。本文は、コミットの一覧と計画の直近の検証結果から、概要・変更点・確認方法の固定の形で作る(生成部分は harness のマーカーで囲み、更新では、その外側に書かれた内容を残す)。先にコミットを済ませておく(未コミットの変更があると拒否する)。既定ブランチ上・detached HEAD・git の外では使えない。PR を作る前に、既定ブランチが GitHub で保護されているかを確かめ、未保護なら結果に知らせる(設定はしない)。",
    parameters: Type.Object({
      title: Type.String({ description: "PR の題名(1 つの目的)" }),
      summary: Type.Optional(
        Type.String({ description: "概要(1〜3 文)。省略するとコミットの件名から作る" }),
      ),
    }),
    executionMode: "sequential",
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const title = params.title.trim();
      if (!title) return fail("題名(title)が空です。");
      const root = await out(ctx.cwd, ["rev-parse", "--show-toplevel"]);
      if (!root) return fail("git のリポジトリの外では、PR を作れません。");
      const branch = await out(root, ["branch", "--show-current"]);
      if (!branch) {
        return fail(
          "ブランチ上にいません(detached HEAD)。作業ブランチを作って、切り替えてください: git switch -c <ブランチ名>(feat/… など)",
        );
      }
      const { names, base } = await defaultBranches(root);
      if (names.has(branch)) {
        return fail(
          `既定ブランチ(${branch})上では、PR を作れません。作業ブランチを作って、変更を移してください: git switch -c <ブランチ名>(feat/… など)。そのあと、変更をコミットしてから、もう一度呼んでください。${COMMIT_GUIDE}`,
        );
      }
      const dirty = await out(root, ["status", "--porcelain"]);
      if (dirty) {
        return fail(
          `コミットされていない変更があります。先にコミットしてから、PR を作ってください。${COMMIT_GUIDE}\n\n${dirty.slice(0, 500)}`,
        );
      }

      // 既定ブランチとの差分のコミット(古い順)
      let logged = await git(root, ["log", "--format=%s", `origin/${base}..HEAD`]);
      if (logged.code !== 0) logged = await git(root, ["log", "--format=%s", `${base}..HEAD`]);
      const known = logged.code === 0;
      const commits = known ? logged.stdout.split("\n").filter(Boolean).reverse() : [];
      if (known && commits.length === 0) {
        return fail(
          `既定ブランチ(${base})との差分のコミットがありません。変更をコミットしてから、PR を作ってください。`,
        );
      }

      const notice = await checkProtection(root, base);

      const pushed = await git(root, ["push", "-u", "origin", branch], 120_000);
      if (pushed.code !== 0) {
        return fail(`push に失敗しました: ${pushed.stderr.trim().slice(0, 500)}`);
      }

      const verification = rt.plan?.verifications.at(-1);
      const generated = buildPrBody({
        ...(params.summary ? { summary: params.summary } : {}),
        commits,
        ...(verification ? { verification } : {}),
      });

      const listed = await gh(root, [
        "pr",
        "list",
        "--head",
        branch,
        "--state",
        "open",
        "--json",
        "number,url,body",
        "--limit",
        "1",
      ]);
      let existing: { number: number; url: string; body?: string } | undefined;
      try {
        existing = (
          JSON.parse(listed.stdout || "[]") as { number: number; url: string; body?: string }[]
        )[0];
      } catch {
        existing = undefined;
      }

      let number: number;
      let url: string;
      if (existing) {
        const edited = await gh(root, [
          "pr",
          "edit",
          String(existing.number),
          "--title",
          title,
          "--body",
          applyGeneratedSection(existing.body ?? "", generated),
        ]);
        if (edited.code !== 0)
          return fail(`PR を更新できませんでした: ${edited.stderr.trim().slice(0, 500)}`);
        number = existing.number;
        url = existing.url;
      } else {
        const created = await gh(root, [
          "pr",
          "create",
          "--base",
          base,
          "--head",
          branch,
          "--title",
          title,
          "--body",
          generated,
        ]);
        if (created.code !== 0)
          return fail(`PR を作れませんでした: ${created.stderr.trim().slice(0, 500)}`);
        url = created.stdout.trim().split("\n").at(-1) ?? "";
        number = Number(/\/pull\/(\d+)/.exec(url)?.[1] ?? 0);
      }

      if (rt.plan) {
        const record: PrRecord = { number, url, title, merged: false };
        if (notice) record.warning = notice;
        flow.save(recordPr(rt.plan, record), ctx);
      }
      return ok(
        `PR を${existing ? "更新" : "作成"}しました: #${number} ${url}${notice ? `\n\n注意: ${notice}` : ""}\nマージは、ユーザーが依頼したときだけ行います。依頼が無ければ、この URL を報告して止めてください。`,
      );
    },
  });

  // ---- harness_pr_merge ----
  const sleep = (ms: number, signal: AbortSignal | undefined) =>
    new Promise<void>((resolve) => {
      const timer = setTimeout(done, ms);
      function done() {
        clearTimeout(timer);
        signal?.removeEventListener("abort", done);
        resolve();
      }
      signal?.addEventListener("abort", done, { once: true });
    });

  /** CI が終わるまで待つ。上限時間・中断あり。終わらなければ、そのときの状態を返す */
  async function waitForChecks(
    root: string,
    number: number,
    signal: AbortSignal | undefined,
  ): Promise<ChecksResult | "aborted"> {
    const started = Date.now();
    for (;;) {
      // 中断は、CI の判定より先に見る(中断後に gh を呼ばない。待ちの間に CI が通っても進めない)
      if (signal?.aborted) return "aborted";
      const r = await gh(root, ["pr", "checks", String(number), "--json", "name,bucket"]);
      if (signal?.aborted) return "aborted";
      // チェックが無い(まだ登録されていない)と分かるときだけ none。取れないときは error で止める
      const result = judgeChecksResult(r);
      const { state } = result;
      if (state === "pass" || state === "fail" || state === "error") return result;
      const elapsed = Date.now() - started;
      if (state === "pending" && elapsed >= checkTimeoutMs) return result;
      if (state === "none" && elapsed >= noChecksGraceMs) return result;
      await sleep(pollMs, signal);
    }
  }

  pi.registerTool({
    name: PR_MERGE,
    label: "PR をマージ",
    description:
      "PR をマージする(merge commit。ブランチは消さない)。ユーザーがマージを依頼した実行でだけ使える。CI の完了を待ち(上限時間あり)、CI の失敗・実行中・状態を取得できない、計画の検証・レビューの未達・未着手と進行中の項目があれば止める(計画の最後に置いたマージの項目は、in_progress にしてから呼ぶ。進行中で数えないのは最後の項目だけ)。確認ダイアログで拒否されたら、その実行の中では、呼び直してもダイアログを出さずに止める。マージの前に、ユーザーに確認ダイアログを出し、許可されたときだけ行う(チャットでマージしてよいかを聞き返さない)。番号を省略すると、今のブランチの PR。",
    parameters: Type.Object({
      number: Type.Optional(
        Type.Number({ description: "PR の番号。省略すると、今のブランチの PR" }),
      ),
    }),
    // 依頼が無い実行では、ツール一覧に出さない(`syncActiveTools`)
    defaultActive: false,
    executionMode: "sequential",
    async execute(_id, params, signal, onUpdate, ctx) {
      // 実行時にも、依頼の有無を確かめる(ツール一覧の出し入れだけに頼らない)
      if (!rt.mergeRequested) {
        return fail(
          "ユーザーの直近の依頼に「マージ」「merge」が含まれていないため、マージしません。PR の URL を報告して止めてください。マージを望む場合は、ユーザーが依頼し直します。",
        );
      }
      // 同じ実行の中で一度拒否されたら、ダイアログを繰り返し出さない
      if (rt.mergeDeclined) {
        return fail(
          `この依頼ではユーザーがマージを拒否しました。マージしません(ダイアログも出しません)。${DEFER_GUIDE("ユーザーがマージを拒否した")}マージを望む場合は、ユーザーが改めて依頼します。`,
        );
      }
      if (!ctx.hasUI) {
        return fail(
          "確認用の画面(UI)がないため、マージできません。ユーザーに実行を依頼してください。",
        );
      }
      const root = await out(ctx.cwd, ["rev-parse", "--show-toplevel"]);
      if (!root) return fail("git のリポジトリの外です。");
      const current = await out(root, ["branch", "--show-current"]);

      let number = params.number;
      if (!number) {
        const r = await gh(root, [
          "pr",
          "list",
          "--head",
          current,
          "--state",
          "open",
          "--json",
          "number",
          "--limit",
          "1",
        ]);
        try {
          number = (JSON.parse(r.stdout || "[]") as { number: number }[])[0]?.number;
        } catch {
          number = undefined;
        }
      }
      if (!number)
        return fail("PR が見つかりません。先に harness_pr_create で PR を作ってください。");

      const viewed = await gh(root, [
        "pr",
        "view",
        String(number),
        "--json",
        "number,url,title,state,headRefName,headRefOid",
      ]);
      let info: {
        number: number;
        url: string;
        title: string;
        state: string;
        headRefName: string;
        headRefOid: string;
      };
      try {
        info = JSON.parse(viewed.stdout);
      } catch {
        return fail(`PR #${number} を取得できませんでした: ${viewed.stderr.trim().slice(0, 300)}`);
      }
      if (info.state !== "OPEN")
        return fail(`PR #${number} は open ではありません(${info.state})。`);

      onUpdate?.({
        content: [{ type: "text", text: `#${number} の CI を待っています…` }],
        details: undefined,
      });
      const waited = await waitForChecks(root, number, signal);
      if (waited === "aborted") return fail("中断されたため、マージしません。");
      const checks = waited.state;

      const planApplies = rt.plan?.confirmed === true && info.headRefName === current;
      const gate = mergeGate({
        isSubagent: rt.isSubagent,
        hasUI: ctx.hasUI,
        checks,
        ...(waited.detail ? { checksDetail: waited.detail } : {}),
        plan: rt.plan,
        planApplies,
        fingerprint: planApplies ? await flow.fingerprint(ctx) : "",
        headDiffers: planApplies && (await out(root, ["rev-parse", "HEAD"])) !== info.headRefOid,
      });
      if (gate.blockers.length > 0) {
        return fail(
          `マージしません:\n${gate.blockers.map((r) => `- ${r}`).join("\n")}\n\nこの実行の中で解消できない理由なら、${DEFER_GUIDE("上の止めた理由")}`,
        );
      }

      const notes = gate.warnings.length
        ? `\n\n注意:\n${gate.warnings.map((w) => `- ${w}`).join("\n")}`
        : "";
      const allowed = await ctx.ui.confirm(
        "PR のマージの確認",
        `#${info.number} ${info.title}\n${info.url}\n\nCI: ${checksLabel[checks]}${notes}\n\nmerge commit でマージします(ブランチは削除しません)。許可しますか？`,
      );
      if (!allowed) {
        rt.mergeDeclined = true;
        return fail(
          `ユーザーがマージを許可しませんでした。マージしません。この依頼の中では、もう一度呼んでもマージしません。${DEFER_GUIDE("ユーザーがマージを拒否した")}`,
        );
      }

      const merged = await gh(root, ["pr", "merge", String(number), "--merge"], 120_000);
      if (merged.code !== 0) {
        return fail(`マージできませんでした: ${merged.stderr.trim().slice(0, 500)}`);
      }
      if (rt.plan) {
        const previous = rt.plan.prs.find((p) => p.number === info.number);
        flow.save(
          recordPr(rt.plan, {
            ...previous,
            number: info.number,
            url: info.url,
            title: info.title,
            merged: true,
          }),
          ctx,
        );
      }
      return ok(
        `#${info.number} をマージしました(merge commit)。ブランチは削除していません(リモートのマージ済みブランチは GitHub Actions が消します)。`,
      );
    },
  });
}
