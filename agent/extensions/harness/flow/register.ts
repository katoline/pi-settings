import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import type {
  AgentBeforeSettleEventResult,
  ExtensionAPI,
  ExtensionContext,
  ExtensionToolContext,
  SessionBoundaryDraft,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { Runtime } from "../lib/runtime.ts";
import { latestCustomEntry } from "../lib/state.ts";
import { isFailed } from "../subagent/child.ts";
import { runSubagentTasks } from "../subagent/run.ts";
import { fsReader, parseNul, workingTreeFingerprint } from "./fingerprint.ts";
import { completionMessage, continuationMessage, decideContinuation } from "./loop.ts";
import {
  addDecision,
  clonePlan,
  isActive,
  isAutonomous,
  isComplete,
  openItems,
  type Plan,
  pausePlan,
  proposePlan,
  recordReview,
  recordRework,
  recordVerification,
  renderChecklist,
  resumePlan,
  type UpdateInput,
  updateItem,
} from "./plan.ts";
import { type PrDeps, registerPrTools } from "./pr-tools.ts";
import { renderReport } from "./report.ts";
import { buildRereviewNote, buildReviewTask, parseVerdict } from "./review.ts";
import { ASK_USER, syncActiveTools } from "./tools.ts";
import { isOnPath, resolveVerifyCommands, summarizeOutput } from "./verify.ts";

const PLAN_ENTRY = "harness-plan";
/** 計画の状態をモデルに渡すカスタムメッセージの種類（システムプロンプトには載せない） */
export const PLAN_STATE_MESSAGE = "harness-plan-state";

const text = (t: string) => ({ content: [{ type: "text" as const, text: t }], details: undefined });
const outcomeText = (o: { result: { content: { type: string; text?: string }[] } }) =>
  o.result.content
    .filter((c) => c.type === "text")
    .map((c) => c.text ?? "")
    .join("\n");

/** テストで差し替える依存(既定は本物) */
export interface FlowDeps {
  /** reviewer の起動(`harness_review`) */
  runTasks?: typeof runSubagentTasks;
  /** `nix` が PATH にあるか(`harness_verify` の devShell の判定) */
  nixOnPath?: () => boolean;
  /** PR のツールの、CI を待つ間隔と上限 */
  pr?: PrDeps;
}

/**
 * 計画・自律ループ・検証・独立レビュー。メインエージェントだけが使う(サブエージェントには登録しない)。
 *
 * - Plan: `ask_user` で、要件と判断をすべてユーザーと確認し、`plan_propose` で確定する。
 *   確定したら、`ask_user` をツールから外す(確定後は質問せずに進める)。一時停止中は戻す。
 * - Do/Check/Act: `plan_update` の完了は、根拠・検証・レビューのゲートを通ったときだけ。
 * - ループ: `agent_before_settle` で、未完了の項目がある間、継続を要求する。上限・無進捗・中断・
 *   キルスイッチで止まる。
 * - 計画の状態は、システムプロンプトには載せない(依頼ごとに変わると、その後ろの会話全体の
 *   プロンプトキャッシュが効かなくなる)。依頼の開始時に、表示しないカスタムメッセージで渡す。
 */
export function registerFlow(pi: ExtensionAPI, rt: Runtime, deps: FlowDeps = {}): void {
  if (rt.isSubagent) return;

  const limits = rt.config.flow;
  const killSwitchPath = path.join(rt.agentDir, "harness-off");
  const runTasks = deps.runTasks ?? runSubagentTasks;
  const nixOnPath =
    deps.nixOnPath ?? (() => isOnPath("nix", process.env.PATH, existsSync, path.delimiter));
  const killSwitchOn = () => existsSync(killSwitchPath);
  // この計画で、完了報告を促したか(促しを無視されても、繰り返さない)。報告済みかどうかは計画に保存する
  let completionPrompted = false;

  // ---- 状態の保存・復元 ----
  const syncTools = () => syncActiveTools(pi, rt);

  function showStatus(ctx: ExtensionContext) {
    const plan = rt.plan;
    if (!plan?.confirmed) {
      ctx.ui.setStatus("harness-plan", undefined);
      return;
    }
    const done = plan.items.filter((i) => i.status === "done").length;
    const mark = plan.paused ? " ⏸" : isComplete(plan) ? " ✔" : " ▶";
    ctx.ui.setStatus("harness-plan", `計画 ${done}/${plan.items.length}${mark}`);
  }

  /** 計画を保存する。`undefined` は破棄(`/plan clear`)で、`null` を保存して、復元で「計画なし」に戻す */
  function save(plan: Plan | undefined, ctx: ExtensionContext) {
    rt.plan = plan;
    pi.appendEntry(PLAN_ENTRY, plan ?? null);
    syncTools();
    showStatus(ctx);
  }

  function restore(ctx: ExtensionContext) {
    const saved = latestCustomEntry<Plan | null>(ctx.sessionManager.getBranch(), PLAN_ENTRY);
    rt.plan = saved?.version === 1 ? saved : undefined;
    completionPrompted = false;
    syncTools();
    showStatus(ctx);
  }

  async function gitRoot(ctx: ExtensionContext): Promise<string | null> {
    const r = await pi.exec("git", ["rev-parse", "--show-toplevel"], {
      cwd: ctx.cwd,
      timeout: 5000,
    });
    return r.code === 0 ? r.stdout.trim() : null;
  }

  /** 作業ツリーの指紋。git のリポジトリの外では、常に同じ値(変更の検出はできない) */
  async function fingerprint(ctx: ExtensionContext): Promise<string> {
    const root = await gitRoot(ctx);
    if (!root) return "no-repo";
    const r = await pi.exec(
      "git",
      ["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
      { cwd: root, timeout: 15000 },
    );
    if (r.code !== 0) return "no-repo";
    return workingTreeFingerprint({
      listFiles: async () => parseNul(r.stdout),
      read: fsReader(root),
    });
  }

  // ---- PR の作成・マージ ----
  registerPrTools(pi, rt, { save, fingerprint }, deps.pr);

  // ---- Plan: 確認と確定 ----
  pi.registerTool({
    name: ASK_USER,
    label: "ユーザーに質問",
    description:
      "Plan の段階で、要件・完了条件・判断の基準・迷ったときの扱い・細かい仕様の選択を、ユーザーと確認する。計画が確定したあとは、このツールは使えない(質問せずに進める)。",
    parameters: Type.Object({
      question: Type.String({ description: "質問(1 つの論点に絞る)" }),
      options: Type.Optional(
        Type.Array(Type.String(), { description: "選択肢。なければ、自由な入力" }),
      ),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      if (!ctx.hasUI)
        return text(
          "対話の画面がないため、ユーザーに質問できません。妥当な既定で進め、plan_note で記録してください。",
        );
      const answer = params.options?.length
        ? await ctx.ui.select(params.question, params.options)
        : await ctx.ui.input(params.question);
      return text(
        answer ? `ユーザーの回答: ${answer}` : "ユーザーは回答しませんでした(キャンセル)。",
      );
    },
  });

  pi.registerTool({
    name: "plan_propose",
    label: "計画を提出",
    description:
      "ファイルを変更する依頼で、要件と判断をユーザーと確認し終えたら、完了条件つきのチェックリストを提出する(質問への回答だけの依頼では使わない)。付随作業(検証、独立レビュー、記録や README、PR の作成 = harness_pr_create)も項目に入れる。マージ(harness_pr_merge)は、ユーザーが依頼に含めたときだけ項目に入れ、計画の最後に置く(着手時に in_progress にしてから harness_pr_merge を呼び、マージが済んだら、その結果を根拠に done にする)。ユーザーが確定すると、以後は、質問せずに完了まで進める。",
    parameters: Type.Object({
      goal: Type.String({ description: "目的(1〜2 文)" }),
      items: Type.Array(
        Type.Object({
          id: Type.String({ description: "短い識別子(例: 1、api、readme)" }),
          title: Type.String(),
          acceptance: Type.String({
            description: "完了条件。確認できる形で(コマンド、ファイル、挙動)",
          }),
          kind: Type.Optional(
            Type.Union([Type.Literal("change"), Type.Literal("task")], {
              description:
                "change: ファイルを変更する(検証が必要)/ task: 調査・記録など。既定は change",
            }),
          ),
          review: Type.Optional(
            Type.Boolean({ description: "挙動に関わる変更で、独立レビューが必要なら true" }),
          ),
        }),
        { minItems: 1 },
      ),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const proposed = proposePlan(params.goal, params.items, Date.now());
      if (!proposed.ok) return text(`計画を受け付けられません: ${proposed.error}`);
      if (!ctx.hasUI) return text("対話の画面がないため、計画をユーザーに確認できません。");
      // 確定済みで未完了の計画があれば、確定すると置き換わることを、ダイアログの本文で示す
      const current = rt.plan;
      const replacing = isActive(current)
        ? `\n\n⚠ 確定すると、未完了の計画「${current.goal}」(未着手・進行中 ${openItems(current).length} 件${current.paused ? "、一時停止中" : ""})を置き換えます。`
        : "";
      // 確定のダイアログは残す(決定 006)
      const choice = await ctx.ui.select(
        `計画の確認\n\n${renderChecklist(proposed.value)}${replacing}`,
        ["確定する", "修正を依頼する", "中止する"],
      );
      if (choice === "修正を依頼する") {
        const feedback = await ctx.ui.input("修正の指示");
        return text(
          `ユーザーが修正を求めています: ${feedback ?? "(指示なし)"}\n確認し直して、plan_propose を出し直してください。`,
        );
      }
      if (choice !== "確定する")
        return text(
          "ユーザーが計画を確定しませんでした。作業を始めずに、ユーザーの指示を待ってください。",
        );
      completionPrompted = false;
      rt.planCompleted = false;
      save({ ...proposed.value, confirmed: true }, ctx);
      return text(
        `計画が確定しました。以後は、ユーザーに質問せず、完了まで進めてください(ask_user は使えなくなりました)。\n\n${renderChecklist(proposed.value)}`,
      );
    },
  });

  // ---- Do: 項目の更新 ----
  pi.registerTool({
    name: "plan_update",
    label: "計画の項目を更新",
    description:
      "項目の状態を更新する。項目に着手するときは、先に in_progress にする(検証の失敗・レビューの却下は、進行中の項目の差し戻しに数える)。done は、根拠(evidence)が必要。変更を伴う項目は、最後の変更のあとに harness_verify が通っていること、レビューが必要な項目は harness_review が承認されていることが要る。ユーザーにしかできないこと(sudo、秘密情報の用意など)と、自分の変更と関係ない既存の失敗で検証が通らない項目は、deferred(理由つき)で保留にして、他の項目を進める。",
    parameters: Type.Object({
      id: Type.String(),
      status: Type.Union([
        Type.Literal("in_progress"),
        Type.Literal("done"),
        Type.Literal("deferred"),
      ]),
      evidence: Type.Optional(
        Type.String({ description: "done の根拠(file:line、コマンドの出力)" }),
      ),
      reason: Type.Optional(Type.String({ description: "deferred の理由" })),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      if (!rt.plan) return text("計画がありません。");
      let update: UpdateInput;
      if (params.status === "done") update = { status: "done", evidence: params.evidence ?? "" };
      else if (params.status === "deferred")
        update = { status: "deferred", reason: params.reason ?? "" };
      else update = { status: "in_progress" };
      const result = updateItem(rt.plan, params.id, update, {
        fingerprint: await fingerprint(ctx),
      });
      if (!result.ok) return text(`更新できません: ${result.error}`);
      save(result.value, ctx);
      const tail = isComplete(result.value)
        ? "\n\nすべての項目が済みました。plan_report を呼んで、完了報告を出してください。"
        : "";
      return text(`更新しました。\n\n${renderChecklist(result.value)}${tail}`);
    },
  });

  pi.registerTool({
    name: "plan_note",
    label: "判断を記録",
    description:
      "計画で決めていない判断を、計画の方針に沿う妥当な既定で進めたときに、その内容を記録する(完了報告の「自分で判断したこと」に載る)。",
    parameters: Type.Object({ note: Type.String() }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      if (!rt.plan) return text("計画がありません。");
      save(addDecision(rt.plan, params.note), ctx);
      return text("記録しました。");
    },
  });

  pi.registerTool({
    name: "plan_status",
    label: "計画の状況",
    description: "チェックリストの現在の状況を見る。",
    parameters: Type.Object({}),
    async execute() {
      return text(rt.plan ? renderChecklist(rt.plan) : "計画がありません。");
    },
  });

  pi.registerTool({
    name: "plan_report",
    label: "完了報告",
    description:
      "すべての項目が済んだら、固定の形の完了報告を作る。その出力を、そのまま最終の報告として書く。",
    parameters: Type.Object({}),
    async execute(_id, _params, _signal, _onUpdate, ctx) {
      if (!rt.plan) return text("計画がありません。");
      if (!isComplete(rt.plan)) {
        return text(
          `未着手・進行中の項目が残っています。続けてください。\n\n${renderChecklist(rt.plan)}`,
        );
      }
      // この依頼の中で報告した(完了の合図の条件)。報告済みは計画に保存し、完了の促しを繰り返さない
      rt.planCompleted = true;
      const report = renderReport(rt.plan);
      if (!rt.plan.reported) save({ ...clonePlan(rt.plan), reported: true }, ctx);
      return text(report);
    },
  });

  // ---- Check: 検証 ----
  pi.registerTool({
    name: "harness_verify",
    label: "検証",
    description:
      "プロジェクトの検証コマンド(lint・型チェック・テスト・ビルド)を実行する。変更のあとに必ず実行する。コマンドは、.harness/verify.json、package.json の check、lint・typecheck・test・build の順に決まる(verify.json が無く、git で追跡済みの flake.nix があり nix が使えるときは、package.json のコマンドを nix develop -c で実行する)。見つからなければ「未検証」として記録される。テストの skip・削除や、ルールの無効化で通すことは禁止。",
    parameters: Type.Object({}),
    async execute(_id, _params, signal, _onUpdate, ctx: ExtensionToolContext) {
      const repoRoot = await gitRoot(ctx);
      const root = repoRoot ?? ctx.cwd;
      // git の外、または flake.nix が追跡されていなければ、devShell で包まない
      const flakeTracked =
        repoRoot !== null &&
        (
          await pi.exec("git", ["ls-files", "--error-unmatch", "flake.nix"], {
            cwd: repoRoot,
            timeout: 5000,
          })
        ).code === 0;
      const commands = resolveVerifyCommands(
        {
          read: (f) => {
            try {
              return readFileSync(path.join(root, f), "utf8");
            } catch {
              return null;
            }
          },
          exists: (f) => existsSync(path.join(root, f)),
        },
        { nixOnPath: nixOnPath(), flakeTracked },
      );
      const fp = await fingerprint(ctx);
      if (commands.length === 0) {
        if (rt.plan) {
          save(
            recordVerification(rt.plan, {
              command: "(検証コマンドなし)",
              ok: true,
              unverified: true,
              fingerprint: fp,
              summary: "検証コマンドが見つかりません",
            }),
            ctx,
          );
        }
        return text(
          "検証コマンドが見つかりません。**未検証**として記録しました(完了報告に「未検証」と書かれます)。.harness/verify.json に commands を書くと、検証できます。",
        );
      }
      const lines: string[] = [];
      let allOk = true;
      for (const command of commands) {
        if (signal?.aborted) break;
        const outcome = await ctx.executeTool(
          "bash",
          { command, timeout: 600 },
          signal ? { signal } : undefined,
        );
        const ok = !outcome.isError;
        allOk &&= ok;
        lines.push(
          `${ok ? "成功" : "失敗"}: ${command}${ok ? "" : `\n${summarizeOutput(outcomeText(outcome))}`}`,
        );
      }
      // 中断は、成功にも差し戻しにもしない(失敗として記録するだけ)
      const aborted = signal?.aborted === true;
      if (aborted) allOk = false;
      const summary = lines.join("\n");
      let message = `${aborted ? "検証は中断されました(成功とは扱いません。差し戻しには数えません)" : allOk ? "検証に成功しました" : "検証に失敗しました。直して、やり直してください"}\n\n${summary}`;
      if (rt.plan) {
        let plan = recordVerification(rt.plan, {
          command: commands.join(" && "),
          ok: allOk,
          ...(aborted ? { aborted: true } : {}),
          fingerprint: fp,
          summary: aborted
            ? `中断${summary ? `: ${summarizeOutput(summary, 300)}` : ""}`
            : allOk
              ? `${commands.length} コマンドが成功`
              : summarizeOutput(summary, 300),
        });
        if (!allOk && !aborted) {
          const rework = recordRework(plan, "検証の失敗", limits);
          plan = rework.plan;
          for (const item of rework.gaveUp) {
            message += `\n\n項目 ${item.id} は、${item.cycles} 周で収まらなかったため、未完了にしました。他の項目を進めてください。`;
          }
        }
        save(plan, ctx);
      }
      return text(message);
    },
  });

  // ---- Check: 独立レビュー ----
  async function diffAgainstBase(
    ctx: ExtensionContext,
  ): Promise<{ baseRef: string; stat: string; diff: string } | null> {
    const root = await gitRoot(ctx);
    if (!root) return null;
    const run = async (args: string[]) => {
      const r = await pi.exec("git", args, {
        cwd: root,
        timeout: 30000,
        maxBuffer: 32 * 1024 * 1024,
      });
      return r.code === 0 ? r.stdout : "";
    };
    const originHead = (await run(["symbolic-ref", "--short", "refs/remotes/origin/HEAD"])).trim();
    const defaultRef = originHead || "origin/main";
    const mergeBase = (await run(["merge-base", "HEAD", defaultRef])).trim();
    const baseRef = mergeBase || "HEAD";
    const stat = await run(["diff", "--stat", baseRef]);
    let diff = await run(["diff", baseRef]);
    const untracked = parseNul(await run(["ls-files", "--others", "--exclude-standard", "-z"]));
    for (const file of untracked.slice(0, 50)) {
      try {
        const body = readFileSync(path.join(root, file), "utf8").slice(0, 20000);
        diff += `\n+++ 新規ファイル: ${file}\n${body
          .split("\n")
          .map((l) => `+${l}`)
          .join("\n")}\n`;
      } catch {
        // 読めないファイルは省く
      }
    }
    return {
      baseRef: mergeBase ? `${defaultRef}(merge-base ${mergeBase.slice(0, 8)})` : "HEAD",
      stat,
      diff,
    };
  }

  pi.registerTool({
    name: "harness_review",
    label: "独立レビュー",
    description:
      "挙動に関わる変更を、新しいコンテキストの読み取り専用のレビュー担当(reviewer)に、差分と要件だけを渡してレビューさせる(ドキュメントのみ・数行の自明な修正は不要)。最終行のマーカーで判定し、マーカーがない・エラーは承認にならない。採否は、メインエージェントが判断する。再レビューは、直した差分だけを対象にする。",
    parameters: Type.Object({
      requirements: Type.Optional(
        Type.String({ description: "要件。省略すると、計画の完了条件を使う" }),
      ),
    }),
    async execute(_id, params, signal, onUpdate, ctx) {
      const material = await diffAgainstBase(ctx);
      if (!material) return text("git のリポジトリの外では、差分を作れません。");
      if (!material.diff.trim()) return text("差分がありません。レビューの対象がありません。");
      const requirements =
        params.requirements?.trim() ||
        (rt.plan
          ? rt.plan.items
              .map((i) => `- ${i.id}: ${i.title}\n  完了条件: ${i.acceptance}`)
              .join("\n")
          : "");
      if (!requirements)
        return text("要件がありません。requirements を渡すか、計画を確定してください。");
      // 前回の判定は、判定なし(undetermined)を飛ばした直近の「判定あり」のレビューで決める
      const previous = rt.plan?.reviews.findLast((r) => !r.undetermined);
      let task = buildReviewTask({
        requirements,
        baseRef: material.baseRef,
        diffStat: material.stat,
        diff: material.diff,
      });
      // 前回(判定あり)が却下のときだけ、前回の指摘を渡す
      if (previous && !previous.approved) task += buildRereviewNote(previous.summary);
      const fp = await fingerprint(ctx);
      // subagent ツールと同じ仕組みで reviewer を起動する。件数と費用は rt に積まれ、結果の details
      // (children)に子の結果を残すので、再開時は subagentTotals が数え直す
      const run = await runTasks(
        rt,
        [{ agent: "reviewer", title: "独立レビュー", task }],
        ctx,
        signal,
        onUpdate,
      );
      if (run.kind === "refused")
        return text(`レビューを実行できません(承認とは扱いません): ${run.text}`);
      const child = run.results[0];
      const output = child?.output ?? "";
      const verdict = !child || isFailed(child) || signal?.aborted ? "none" : parseVerdict(output);
      const approved = verdict === "approved";
      let message = `${approved ? "レビューは承認されました。" : verdict === "disapproved" ? "レビューで指摘がありました。採否を判断し、直す指摘は直して、再レビューを受けてください(直さない指摘は、理由を添えて「対象外」として記録します)。" : "レビューの判定を得られませんでした(最終行のマーカーなし、エラー、中断、または時間切れ)。承認とは扱いません。差し戻しには数えません。"}\n\n${run.text}`;
      if (rt.plan) {
        let plan = recordReview(rt.plan, {
          approved,
          ...(verdict === "none" ? { undetermined: true } : {}),
          fingerprint: fp,
          summary: summarizeOutput(output, 500),
        });
        // 差し戻しに数えるのは、却下(`<disapproved/>`)だけ
        if (verdict === "disapproved") {
          const rework = recordRework(plan, "レビューの差し戻し", limits);
          plan = rework.plan;
          for (const item of rework.gaveUp) {
            message += `\n\n項目 ${item.id} は、${item.cycles} 周で収まらなかったため、未完了にしました。他の項目を進めてください。`;
          }
        }
        save(plan, ctx);
      }
      return {
        content: [{ type: "text" as const, text: message }],
        details: { verdict, children: run.results },
      };
    },
  });

  // ---- 自律ループ ----
  function request(
    ctx: ExtensionContext,
    plan: Plan,
    entries: SessionBoundaryDraft[],
    content: string,
    customType: string,
  ): AgentBeforeSettleEventResult {
    save(plan, ctx);
    return {
      entries: [...entries, { type: "custom_message", customType, content, display: false }],
      continue: true,
    };
  }

  pi.on("agent_before_settle", async (event, ctx) => {
    const plan = rt.plan;
    // エラーで終わった実行は、続けない。未完了の計画は一時停止にして、知らせる
    if (event.outcome === "error") {
      if (isAutonomous(plan)) {
        save(pausePlan(plan, "エラーで終了"), ctx);
        ctx.ui.notify(
          "エラーで終了したため、自律ループを一時停止しました。/plan resume で再開できます。",
          "warning",
        );
      }
      return undefined;
    }
    const killSwitch = killSwitchOn();
    // キルスイッチがある間は続けない。自律中の計画は一時停止にして、ask_user と完了の合図を戻す
    if (killSwitch && isAutonomous(plan)) {
      save(pausePlan(plan, "キルスイッチ"), ctx);
      ctx.ui.notify(
        "キルスイッチがあるため、自律ループを一時停止しました。ファイルを消して /plan resume で再開できます。",
        "warning",
      );
      return undefined;
    }
    const decision = decideContinuation({ plan, now: Date.now(), limits, killSwitch });
    if (decision.continue) {
      return request(ctx, decision.plan, event.entries, decision.message, "harness-continue");
    }
    if (decision.reason === "limit") {
      save(decision.plan, ctx);
      ctx.ui.notify(
        `自律ループを止めました: ${decision.detail}\n/plan resume で再開できます。`,
        "warning",
      );
      return undefined;
    }
    // 完了していて、まだ報告していないときだけ、1 回促す
    if (decision.reason === "complete" && plan && !plan.reported && !completionPrompted) {
      completionPrompted = true;
      return request(ctx, plan, event.entries, completionMessage(), "harness-complete");
    }
    return undefined;
  });

  // 中断(Esc)では継続しない。一時停止にして、再開できるようにする
  pi.on("agent_settled", async (event, ctx) => {
    const plan = rt.plan;
    if (event.aborted && plan?.confirmed && !isComplete(plan) && !plan.paused) {
      save(pausePlan(plan, "中断(Esc)"), ctx);
      ctx.ui.notify(
        "中断したため、自律ループを一時停止しました。/plan resume で再開できます。",
        "info",
      );
    }
  });

  pi.on("session_start", async (_event, ctx) => restore(ctx));
  pi.on("session_tree", async (_event, ctx) => restore(ctx));

  // 圧縮や長い会話のあとでも、計画を見失わないよう、依頼の開始時に計画の状態を渡す。
  // システムプロンプトには載せない(依頼ごとに変わると、その後ろの会話全体のキャッシュが効かなくなる)。
  // 表示しないカスタムメッセージとして、会話の末尾に足す。ユーザーの依頼で始まる実行だけに渡す
  // (`/plan resume` の開始メッセージと、ループの継続メッセージには、状態が入っている)
  pi.on("before_agent_start", async (event) => {
    const plan = rt.plan;
    if (event.messageType !== "user" || !isActive(plan)) return undefined;
    return {
      message: {
        customType: PLAN_STATE_MESSAGE,
        content: `確定済みの計画(状態):\n${renderChecklist(plan)}${
          plan.paused ? `\n\n一時停止中: ${plan.pausedReason ?? ""}` : ""
        }`,
        display: false,
      },
    };
  });

  pi.registerCommand("plan", {
    description:
      "計画の状況を見る。/plan resume で再開、/plan stop で一時停止、/plan clear で計画を破棄する",
    handler: async (args, ctx) => {
      const sub = args.trim();
      const plan = rt.plan;
      if (!plan) {
        ctx.ui.notify("計画はありません。", "info");
        return;
      }
      if (sub === "resume") {
        if (isComplete(plan)) {
          ctx.ui.notify("計画は、すべて済んでいます。", "info");
          return;
        }
        const resumed = resumePlan(plan, Date.now());
        // 再開の実行は input を通らない。実行が始まらなかった依頼(認証切れなど)や拒否の記録を
        // 持ち越さないよう、マージの依頼を戻す(ツール一覧は save の syncActiveTools で直る)
        rt.mergeRequested = false;
        rt.mergeDeclined = false;
        save(resumed, ctx);
        pi.sendMessage(
          {
            customType: "harness-continue",
            content: continuationMessage(resumed, limits.maxCyclesPerItem),
            display: false,
          },
          { triggerTurn: true },
        );
        ctx.ui.notify("自律ループを再開しました。", "info");
        return;
      }
      if (sub === "stop") {
        save(pausePlan(plan, "ユーザーが止めました"), ctx);
        ctx.ui.notify("自律ループを止めました。/plan resume で再開できます。", "info");
        return;
      }
      if (sub === "clear") {
        // 破棄を保存する(再開・ツリーの移動でも戻らない)。ask_user を戻し、状態の差し込みもやめる
        completionPrompted = false;
        save(undefined, ctx);
        ctx.ui.notify("計画を破棄しました。", "info");
        return;
      }
      ctx.ui.notify(
        `${renderChecklist(clonePlan(plan))}${plan.paused ? `\n\n一時停止中: ${plan.pausedReason ?? ""}` : ""}`,
        "info",
      );
    },
  });
}
