import type { HarnessConfig } from "../agent/extensions/harness/lib/config.ts";
import type { Runtime } from "../agent/extensions/harness/lib/runtime.ts";
import { invocations, parseShell } from "../agent/extensions/harness/lib/shell.ts";
import type { GuardInput } from "../agent/extensions/harness/lib/types.ts";

export const HOME = "/Users/u";

/** config.default.json の Mac 向けの値（`~` は HOME に展開済み） */
export const config: HarnessConfig = {
  workRoots: [
    `${HOME}/Dev/kaishi`,
    `${HOME}/Dev/seino914`,
    `${HOME}/Dev/hobby`,
    `${HOME}/Dev/humanoid`,
  ],
  tempRoots: ["$TMPDIR", "/tmp/claude-*", "/tmp/pi-*"],
  protectedGlobalPaths: [`${HOME}/Dev/seino914/dotfiles`],
  protectedHarnessPaths: [`${HOME}/.pi/agent`],
  defaultBranches: ["main", "master"],
  selectModelOnStartup: false,
  compactionModel: "",
  subagent: { maxTasks: 8, maxConcurrency: 4, timeoutSeconds: 900, maxTotal: 64 },
  flow: { maxCyclesPerItem: 3, maxContinuations: 200, maxMinutes: 240, maxNoProgress: 3 },
};

/** テスト用のランタイム。必要な項目だけ上書きする */
export function runtime(over: Partial<Runtime> = {}): Runtime {
  return {
    config,
    isSubagent: false,
    home: HOME,
    tmpdir: "/tmp",
    agentDir: `${HOME}/.pi/agent`,
    subagentModel: "opencode-go/deepseek-v4.1-flash",
    subagentModelDefault: "opencode-go/deepseek-v4.1-flash",
    subagentSpawns: 0,
    childCost: 0,
    plan: undefined,
    planCompleted: false,
    mergeRequested: false,
    mergeDeclined: false,
    ...over,
  };
}

/** Mac の `/tmp` は `/private/tmp` へのリンク。実体のパスに解決する偽物の fs */
export const macFs = {
  resolve: (p: string): string => (p === "/tmp" || p.startsWith("/tmp/") ? `/private${p}` : p),
};

export function input(over: {
  subagent?: boolean;
  cwd?: string;
  branch?: string | null;
  inRepo?: boolean;
}): GuardInput {
  return {
    env: {
      isSubagent: over.subagent ?? false,
      cwd: over.cwd ?? `${HOME}/Dev/seino914/app`,
      home: HOME,
      tmpdir: "/tmp",
    },
    config,
    git: {
      inRepo: over.inRepo ?? true,
      repoRoot: over.inRepo === false ? null : (over.cwd ?? `${HOME}/Dev/seino914/app`),
      currentBranch: over.branch === undefined ? "feat/x" : over.branch,
      defaultBranches: new Set(["main", "master"]),
    },
    fs: { resolve: (p: string) => p },
  };
}

export const inv = (cmd: string) => {
  const found = invocations(parseShell(cmd));
  if (found.length === 0) throw new Error(`解析できません: ${cmd}`);
  return found;
};

// テスト用のダミーのトークン。秘匿の確認に使う。/pr のフックの秘密情報の検査
// （~/.claude/hooks/lib/scan-secrets.sh）に当たらないよう、トークンの形をファイルに書かず、実行時に組み立てる
const join = (...parts: string[]) => parts.join("");
export const FAKE = {
  ghp: join("gh", "p_", "abcdefghijklmnopqrstuvwxyz0123456789"),
  skAnt: join("sk-", "ant-", "api03-abcdefghijklmnopqrstuvwx"),
  akia: join("AK", "IA", "ABCDEFGHIJKLMNOP"),
  xoxb: join("xo", "xb-", "1234567890-abcdefghij"),
  skProj: join("sk-", "proj-", "AbCdEfGhIjKlMnOp_QrStUvWx-1234567890"),
  skSvcacct: join("sk-", "svcacct-", "AbCdEfGhIjKlMnOpQrSt_uvwx-12345"),
  skAdmin: join("sk-", "admin-", "AbCdEfGhIjKlMnOpQrStUvWx_1234"),
};
