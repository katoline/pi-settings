import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { probeGitState } from "../lib/git-state.ts";
import { type Runtime, realFs } from "../lib/runtime.ts";
import type { GitProbe, GitState, GuardInput } from "../lib/types.ts";
import type { Verdict } from "../lib/verdict.ts";
import { evaluateBash, evaluateFileTool } from "./index.ts";
import { redact, redactDeep } from "./secrets.ts";

const toResult = (verdict: Verdict) =>
  verdict.kind === "block" ? { block: true, reason: verdict.reason } : undefined;

/**
 * ガードを Pi のフックに接続する。
 *
 * - `tool_call` は、1 本の **fail-closed** のラッパーで包む。Pi は、フックが例外を投げると、
 *   ゲートを通さずにツールを実行してしまうため、例外は必ず block に変換する。
 * - 危ない操作は黙って拒否する（決定 005）。確認ダイアログは出さない。PR の作成・マージは、
 *   bash からは常に拒否し、専用ツール（`harness_pr_create`・`harness_pr_merge`）へ誘導する（決定 003）。
 *   マージの依頼の判定と確認ダイアログは、`flow/pr-tools.ts` が担う。
 * - `!` で始まるユーザーのコマンドは `user_bash` イベントで、`tool_call` を通らない（ガードの対象外）。
 */
export function registerGuards(pi: ExtensionAPI, rt: Runtime): void {
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

  pi.on("tool_call", async (event, ctx) => {
    try {
      const toolInput = event.input as Record<string, unknown>;
      if (event.toolName === "bash") {
        const command = String(toolInput.command ?? "");
        const input = guardInput(ctx.cwd);
        return toResult(await evaluateBash(command, input, probe));
      }
      // write / edit は、対象ファイルのリポジトリの git の状態（既定ブランチ上か）を probe で取る
      return toResult(
        await evaluateFileTool(event.toolName, toolInput, guardInput(ctx.cwd), probe),
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
