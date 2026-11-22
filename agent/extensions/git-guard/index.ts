import { isToolCallEventType, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { FALLBACK_DEFAULTS, judge, nextMergeRequested, type BranchInfo } from "./check.ts";

/** bash で実行される git / gh コマンドのうち、事故につながるものを実行前に止める */
export default function gitGuardExtension(pi: ExtensionAPI): void {
  // ユーザーがマージを依頼したか。マージ時の確認ダイアログはこのときだけ出し、
  // 依頼が無いマージは黙ってブロックする（普段の作業で確認ダイアログを出さないため）
  let mergeRequested = false;

  pi.on("input", async (event) => {
    // 拡張が送った入力はユーザーの依頼ではないので数えない。
    // event.text は /skill:… の展開前なので、スキル本文中の「マージ」には反応しない
    if (event.source !== "extension") {
      mergeRequested = nextMergeRequested(mergeRequested, event.text, event.streamingBehavior !== undefined);
    }
    return { action: "continue" };
  });

  const run = async (cwd: string, args: string[]): Promise<string | null> => {
    try {
      const r = await pi.exec("git", args, { cwd, timeout: 5000 });
      return r.code === 0 ? r.stdout.trim() : null;
    } catch {
      return null;
    }
  };

  // 既定ブランチと現在ブランチを取得する。git リポジトリでなければ null
  const getInfo = async (cwd: string): Promise<BranchInfo | null> => {
    const current = await run(cwd, ["branch", "--show-current"]);
    const head = await run(cwd, ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"]);
    if (current === null && head === null) return null;
    return {
      defaults: head ? [head.replace(/^origin\//, "")] : FALLBACK_DEFAULTS,
      current: current || null,
    };
  };

  pi.on("tool_call", async (event, ctx) => {
    if (!isToolCallEventType("bash", event)) return undefined;
    const command = event.input.command;
    const verdict = await judge(command, ctx.cwd, getInfo);

    if (verdict.action === "block") return { block: true, reason: verdict.reason };
    if (verdict.action === "confirm") {
      if (!mergeRequested) {
        return {
          block: true,
          reason:
            "ユーザーの直近の依頼に「マージ」「merge」が含まれていないため、PR のマージを止めました。マージはせず、PR の作成までで止めて URL を報告してください。" +
            "ユーザーがマージを望んでいる場合は、「<PR> をマージして」のように依頼し直してもらうよう伝えてください。",
        };
      }
      if (!ctx.hasUI) {
        return { block: true, reason: `${verdict.reason}確認用の UI がないためブロックしました。ユーザーに実行を依頼してください。` };
      }
      const ok = await ctx.ui.confirm("PR マージの確認", `${verdict.reason}\n\n  ${command}\n\n実行を許可しますか？`);
      if (!ok) return { block: true, reason: "ユーザーが PR のマージを拒否しました。" };
    }
    return undefined;
  });
}
