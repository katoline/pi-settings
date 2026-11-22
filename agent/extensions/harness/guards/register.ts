import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { probeGitState } from "../lib/git-state.ts";
import { type Runtime, realFs } from "../lib/runtime.ts";
import type { GitProbe, GitState, GuardInput } from "../lib/types.ts";
import type { Verdict } from "../lib/verdict.ts";
import { evaluateBash, evaluateFileTool } from "./index.ts";
import { nextMergeRequested } from "./merge.ts";
import { redact, redactDeep } from "./secrets.ts";

/**
 * ガードを Pi のフックに接続する。
 *
 * - `tool_call` は、1 本の **fail-closed** のラッパーで包む。Pi は、フックが例外を投げると、
 *   ゲートを通さずにツールを実行してしまうため、例外は必ず block に変換する。
 * - 危ない操作は黙って拒否する（決定 005）。確認ダイアログを出すのは PR のマージだけで、
 *   ユーザーが依頼したときに限る（決定 003）。
 * - `!` で始まるユーザーのコマンドは `user_bash` イベントで、`tool_call` を通らない（ガードの対象外）。
 */
export function registerGuards(pi: ExtensionAPI, rt: Runtime): void {
  // ユーザーがマージを依頼したか。マージ時の確認ダイアログはこのときだけ出し、
  // 依頼が無いマージは黙ってブロックする（普段の作業で確認ダイアログを出さないため）
  let mergeRequested = false;

  pi.on("input", async (event) => {
    // 拡張が送った入力はユーザーの依頼ではないので数えない。
    // event.text は /skill:… の展開前なので、スキル本文中の「マージ」には反応しない
    if (event.source !== "extension") {
      mergeRequested = nextMergeRequested(
        mergeRequested,
        event.text,
        event.streamingBehavior !== undefined,
      );
    }
    return { action: "continue" };
  });

  // git の状態は毎回取り直す（直前のツール呼び出しでブランチが変わっていることがあるため）
  const probe: GitProbe = (cwd) =>
    probeGitState(async (args) => {
      try {
        const r = await pi.exec("git", args, { cwd, timeout: 5000 });
        return { code: r.code, stdout: r.stdout };
      } catch {
        // 存在しないディレクトリなど。リポジトリの外として扱う
        return { code: 1, stdout: "" };
      }
    }, rt.config);

  // git の状態が要らない検査（bash は必要なコマンドのときだけ evaluateBash が取る）に渡す、未調査の状態
  const unknownGit = (): GitState => ({
    inRepo: false,
    repoRoot: null,
    currentBranch: null,
    defaultBranches: new Set(rt.config.defaultBranches),
  });

  function guardInput(cwd: string): GuardInput {
    return {
      env: { isSubagent: rt.isSubagent, cwd, home: rt.home, tmpdir: rt.tmpdir },
      config: rt.config,
      git: unknownGit(),
      fs: realFs,
    };
  }

  async function decide(verdict: Verdict, ctx: ExtensionContext, subject: string) {
    if (verdict.kind === "allow") return undefined;
    if (verdict.kind === "block") return { block: true, reason: verdict.reason };
    // merge
    if (!mergeRequested) {
      return {
        block: true,
        reason:
          "ユーザーの直近の依頼に「マージ」「merge」が含まれていないため、PR のマージを止めました。マージはせず、PR の作成までで止めて URL を報告してください。" +
          "ユーザーがマージを望んでいる場合は、「<PR> をマージして」のように依頼し直してもらうよう伝えてください。",
      };
    }
    if (!ctx.hasUI) {
      return {
        block: true,
        reason: `${verdict.reason}確認用の UI がないためブロックしました。ユーザーに実行を依頼してください。`,
      };
    }
    const ok = await ctx.ui.confirm(
      "PR マージの確認",
      `${verdict.reason}\n\n  ${subject}\n\n実行を許可しますか？`,
    );
    if (!ok) return { block: true, reason: "ユーザーが PR のマージを拒否しました。" };
    return undefined;
  }

  pi.on("tool_call", async (event, ctx) => {
    try {
      const toolInput = event.input as Record<string, unknown>;
      if (event.toolName === "bash") {
        const command = String(toolInput.command ?? "");
        const input = guardInput(ctx.cwd);
        return await decide(await evaluateBash(command, input, probe), ctx, command);
      }
      // write / edit は、対象ファイルのリポジトリの git の状態（既定ブランチ上か）を probe で取る
      return await decide(
        await evaluateFileTool(event.toolName, toolInput, guardInput(ctx.cwd), probe),
        ctx,
        `${event.toolName}: ${String(toolInput.path ?? "")}`,
      );
    } catch (error) {
      // fail-closed: ガードの内部エラーでは、実行させない
      const message = error instanceof Error ? error.message : String(error);
      return {
        block: true,
        reason: `ハーネスのガードで内部エラーが起きたため、安全のため実行を止めました（${message}）。`,
      };
    }
  });

  // モデルの入力側でも、秘密を断つ
  pi.on("tool_result", async (event) => {
    let changed = false;
    const content = event.content.map((item) => {
      if (item.type !== "text") return item;
      const text = redact(item.text);
      if (text !== item.text) changed = true;
      return { ...item, text };
    });
    const structured =
      event.structuredContent === undefined
        ? undefined
        : (redactDeep(event.structuredContent) as typeof event.structuredContent);
    if (
      structured !== undefined &&
      JSON.stringify(structured) !== JSON.stringify(event.structuredContent)
    ) {
      changed = true;
    }
    if (!changed) return undefined;
    return { content, ...(structured === undefined ? {} : { structuredContent: structured }) };
  });
}
