import path from "node:path";
import { invocations, parseShell } from "../lib/shell.ts";
import type { GitProbe, GuardInput } from "../lib/types.ts";
import { ALLOW, block, combine, type Verdict } from "../lib/verdict.ts";
import { checkFs } from "./fs.ts";
import { checkGh, checkGitCall, GIT_STATE_SUBS, gitSubcommand, switchTarget } from "./git.ts";
import {
  checkInstall,
  checkInstallAll,
  checkProtectedBash,
  checkProtectedWrite,
} from "./install.ts";
import { isInsideOrEqual, isStrictlyInside, nearestExistingDir, resolveDir } from "./paths.ts";
import { checkEnvDump, checkSecretsBash, checkSecretToolPath } from "./secrets.ts";

/**
 * bash ツールのコマンドを、すべてのガードで検査する。
 *
 * git の状態（現在のブランチなど）は `probe` で、コマンド中の `cd` と `git -C` を追った作業ディレクトリごとに
 * 必要になったときだけ取得する。同じコマンド内の `git checkout -b` / `git switch -c` / `git switch <名前>`
 * のあとは、切替後のブランチで判定する。
 */
export async function evaluateBash(
  command: string,
  input: GuardInput,
  probe: GitProbe = async () => input.git,
): Promise<Verdict> {
  const parsed = parseShell(command);
  if (!parsed.ok) {
    return block(
      "コマンドの構文を解析できませんでした（クォートの閉じ忘れなど）。安全のため実行しません。単純なコマンドに分けて、書き直してください。",
    );
  }
  if (parsed.opaque) {
    return block(
      "`eval` や、変数で組み立てた `sh -c` は、中身を判定できないため禁止です。実行したいコマンドを直接書いてください。",
    );
  }
  const invs = invocations(parsed);
  const verdicts: Verdict[] = [checkEnvDump(parsed), checkInstallAll(parsed, invs)];
  // このコマンド内の作業ディレクトリと、切り替えたブランチ（作業ディレクトリごと）
  let cwd = input.env.cwd;
  const switched = new Map<string, string>();
  for (const inv of invs) {
    if (inv.name === "cd" && !inv.nested) {
      const target = inv.args[0];
      if (target && !target.dynamic && target.value !== "-") {
        cwd = resolveDir(cwd, target.value, input.env.home);
      }
    } else if (inv.name === "git") {
      const call = gitSubcommand(inv);
      if (call) {
        const gitCwd = call.dirs.reduce((c, d) => resolveDir(c, d, input.env.home), cwd);
        const target = switchTarget(call);
        if (target) switched.set(gitCwd, target);
        let gitInput = input;
        if (GIT_STATE_SUBS.has(call.sub)) {
          const state = await probe(gitCwd);
          const branch = switched.get(gitCwd);
          gitInput = {
            ...input,
            env: { ...input.env, cwd: gitCwd },
            git: branch === undefined ? state : { ...state, currentBranch: branch },
          };
        }
        verdicts.push(checkGitCall(call, gitInput));
      }
    } else if (inv.name === "gh") {
      verdicts.push(checkGh(inv, input));
    }
    verdicts.push(
      checkFs(inv, input),
      checkInstall(inv),
      checkSecretsBash(inv, input),
      checkProtectedBash(inv, input),
    );
  }
  return combine(verdicts);
}

const WRITE_TOOLS = new Set(["write", "edit"]);
const PATH_TOOLS = new Set(["read", "write", "edit", "grep", "find", "ls"]);

function toolPath(toolInput: Record<string, unknown>): string | null {
  const p = toolInput.path ?? toolInput.file_path ?? toolInput.filePath;
  return typeof p === "string" ? p : null;
}

/**
 * read / write / edit / grep / find / ls ツールを検査する。対象外のツールは許可。
 * write / edit の既定ブランチ・`.git` の判定は、ツールの cwd ではなく、対象ファイルのあるディレクトリ
 * （無ければ存在する最も近い親）のリポジトリの状態（`probe`）で行う
 */
export async function evaluateFileTool(
  toolName: string,
  toolInput: Record<string, unknown>,
  input: GuardInput,
  probe: GitProbe = async () => input.git,
): Promise<Verdict> {
  if (!PATH_TOOLS.has(toolName)) return ALLOW;
  const rawPath = toolPath(toolInput);
  if (rawPath === null) return ALLOW;

  const verdicts: Verdict[] = [checkSecretToolPath(rawPath, input)];
  if (WRITE_TOOLS.has(toolName)) {
    const abs = path.isAbsolute(rawPath)
      ? path.normalize(rawPath)
      : path.resolve(input.env.cwd, rawPath.replace(/^~(?=\/|$)/, input.env.home));
    const resolved = input.fs.resolve(abs);
    verdicts.push(checkProtectedWrite(abs, input));

    // `.git` の中では `git rev-parse` が失敗してリポジトリを判定できないので、
    // probe の結果に関係なく、`.git` というパス要素を含むパスを拒否する
    if (abs.split(path.sep).includes(".git") || resolved.split(path.sep).includes(".git")) {
      verdicts.push(
        block("`.git` の中(フック、設定、オブジェクト)は、ファイルツールで変更できません。"),
      );
    }
    const git = await probe(nearestExistingDir(abs));
    const root = git.repoRoot ? input.fs.resolve(git.repoRoot) : null;
    if (root && isInsideOrEqual(resolved, root)) {
      if (isStrictlyInside(resolved, path.join(root, ".git"))) {
        verdicts.push(
          block("`.git` の中(フック、設定、オブジェクト)は、ファイルツールで変更できません。"),
        );
      }
      const branch = git.currentBranch;
      if (git.inRepo && branch && git.defaultBranches.has(branch)) {
        verdicts.push(
          block(
            `既定ブランチ(${branch})上では、ファイルを変更できません。先に作業ブランチを作成してください: git switch -c <ブランチ名>`,
          ),
        );
      }
    }
  }
  return combine(verdicts);
}
