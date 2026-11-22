import type { HarnessConfig } from "./config.ts";
import type { GitState } from "./types.ts";

export interface GitExecResult {
  code: number;
  stdout: string;
}
/** git を実行する関数（テストでは偽物を渡す） */
export type GitExec = (args: string[]) => Promise<GitExecResult>;

const trim = (r: GitExecResult) => (r.code === 0 ? r.stdout.trim() : "");

/**
 * cwd の git の状態を調べる。既定ブランチは、設定の名前（main / master）に、
 * `origin/HEAD` の指す先を加える。マージ済みのリモートブランチは、push の削除を判定するときだけ調べる。
 */
export async function probeGitState(exec: GitExec, config: HarnessConfig): Promise<GitState> {
  const repoRoot = trim(await exec(["rev-parse", "--show-toplevel"])) || null;
  const defaults = new Set(config.defaultBranches);
  if (!repoRoot) {
    return {
      inRepo: false,
      repoRoot: null,
      currentBranch: null,
      defaultBranches: defaults,
    };
  }
  const branch = trim(await exec(["branch", "--show-current"])) || null;
  const originHead = trim(await exec(["symbolic-ref", "--short", "refs/remotes/origin/HEAD"]));
  if (originHead.startsWith("origin/")) defaults.add(originHead.slice("origin/".length));

  return {
    inRepo: true,
    repoRoot,
    currentBranch: branch,
    defaultBranches: defaults,
  };
}
