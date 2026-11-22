import type { Invocation } from "../lib/shell.ts";
import type { GuardInput } from "../lib/types.ts";
import {
  ALLOW,
  block,
  blockWithHandoff,
  combine,
  mergeGate,
  type Verdict,
} from "../lib/verdict.ts";

export interface GitCall {
  sub: string;
  args: string[];
  /** サブコマンドより後ろの語に、変数やコマンド置換で組み立てたものがある */
  dynamic: boolean;
  /** `-C <dir>` の値（指定順。変数で決まるものは含まない） */
  dirs: string[];
}

/** `git` の前置オプション（-C、-c など）を読み飛ばして、サブコマンドと残りの引数を返す */
export function gitSubcommand(inv: Invocation): GitCall | null {
  const words = inv.args;
  let i = 0;
  const dirs: string[] = [];
  const withValue = new Set(["-C", "-c", "--git-dir", "--work-tree", "--namespace", "--exec-path"]);
  while (i < words.length) {
    const v = words[i]?.value ?? "";
    if (withValue.has(v)) {
      const next = words[i + 1];
      if (v === "-C" && next && !next.dynamic) dirs.push(next.value);
      i += 2;
      continue;
    }
    if (v.startsWith("-")) {
      i++;
      continue;
    }
    break;
  }
  const sub = words[i];
  if (!sub) return null;
  const rest = words.slice(i + 1);
  return {
    sub: sub.value,
    args: rest.map((w) => w.value),
    dynamic: rest.some((w) => w.dynamic) || sub.dynamic,
    dirs,
  };
}

/**
 * checkout / switch の切替先ブランチ名。検出できない形は null。
 * `git checkout <名前>` はファイル指定と区別できないため対象外（新規作成の -b / -B と `git switch <名前>` だけ）
 */
export function switchTarget(call: GitCall): string | null {
  const { sub, args } = call;
  if (call.dynamic) return null;
  if (sub !== "checkout" && sub !== "switch") return null;
  const create = sub === "checkout" ? ["-b", "-B"] : ["-c", "-C", "--create", "--force-create"];
  const i = args.findIndex((a) => create.includes(a));
  if (i >= 0) {
    const next = args[i + 1];
    return next && !next.startsWith("-") ? next : null;
  }
  const only = args[0];
  if (sub === "switch" && args.length === 1 && only !== undefined && !only.startsWith("-"))
    return only;
  return null;
}

const FORCE_FLAGS = new Set(["-f", "--force", "--force-with-lease", "--force-if-includes"]);
/** push の値を取るオプション（次の語を読み飛ばす） */
const PUSH_WITH_VALUE = new Set(["-o", "--push-option", "--repo", "--receive-pack", "--exec"]);

function stripRef(ref: string): string {
  return ref.replace(/^refs\/heads\//, "").replace(/^\+/, "");
}

function isDefault(name: string, input: GuardInput): boolean {
  return input.git.defaultBranches.has(name);
}

const SUBAGENT_DENIED_GIT = new Set([
  "commit",
  "push",
  "merge",
  "pull",
  "cherry-pick",
  "rebase",
  "revert",
  "am",
  "tag",
]);

const subagentReason = (what: string) =>
  `${what} はサブエージェントからは実行できません。変更は親（メインセッション）に任せ、変更したファイルと検証結果を報告してください。`;

function checkPush(args: string[], dynamic: boolean, input: GuardInput): Verdict {
  const flags: string[] = [];
  const positional: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i] ?? "";
    if (a.startsWith("-") && a !== "-") {
      flags.push(a);
      if (PUSH_WITH_VALUE.has(a)) i++;
    } else {
      positional.push(a);
    }
  }
  const refspecs = positional.slice(1); // 最初の引数はリモート名
  // `-fu` のような短いオプションの結合も見る
  const shortHas = (letter: string) =>
    flags.some((f) => /^-[A-Za-z]+$/.test(f) && f.includes(letter));

  if (
    flags.some(
      (f) =>
        FORCE_FLAGS.has(f) ||
        f.startsWith("--force-with-lease=") ||
        f.startsWith("--force-if-includes="),
    ) ||
    shortHas("f") ||
    refspecs.some((r) => r.startsWith("+"))
  ) {
    return block("force push は禁止です。履歴を書き換えず、新しいコミットを追加してください。");
  }
  if (flags.includes("--no-verify")) {
    return block("`--no-verify` は禁止です。フックが失敗する原因を直してください。");
  }
  if (flags.some((f) => f === "--mirror" || f === "--all" || f === "--prune")) {
    return block(
      "`--mirror` / `--all` / `--prune` は、既定ブランチやほかのブランチを壊しうる（リモートブランチの削除も含む）ため禁止です。ブランチ名を指定してください。",
    );
  }
  if (dynamic) {
    return block(
      "push のブランチ名を変数やコマンド置換で組み立てないでください。具体的なブランチ名を書いてください。",
    );
  }
  // リモートブランチの削除は、マージ済みかどうかにかかわらず常に拒否する（決定 003）。
  // マージ済みブランチの削除は GitHub のワークフローが行う
  const deleting =
    flags.includes("--delete") || shortHas("d") || refspecs.some((r) => r.startsWith(":"));
  if (deleting) {
    return block(
      "push によるリモートブランチの削除（--delete / -d / :ref）は禁止です。マージ済みのブランチは GitHub のワークフローが削除します。",
    );
  }
  const targets: string[] = [];
  const current = input.git.currentBranch;
  // リポジトリの外では現在のブランチが無い。git 自身が失敗するので、ここでは止めない
  const unknownCurrent = !input.git.inRepo;
  if (refspecs.length === 0) {
    if (current) targets.push(current);
    else if (!unknownCurrent) {
      return block(
        "現在のブランチを判定できないため、push を許可できません。ブランチ名を明示してください。",
      );
    }
  }
  for (const spec of refspecs) {
    const dst = spec.includes(":") ? (spec.split(":")[1] as string) : spec;
    if (dst === "HEAD" || dst === "") {
      if (current) targets.push(stripRef(current));
      else if (!unknownCurrent) {
        return block("push 先のブランチを判定できません。ブランチ名を明示してください。");
      }
      continue;
    }
    targets.push(stripRef(dst));
  }
  const hitDefault = targets.find((t) => isDefault(t, input));
  if (hitDefault) {
    return block(
      `既定ブランチ（${hitDefault}）への直接の push は禁止です。作業ブランチへ push し、PR 経由で取り込んでください。`,
    );
  }
  return ALLOW;
}

function checkCommit(args: string[], input: GuardInput): Verdict {
  // `-n` は commit では --no-verify。`-nm` のような結合も見る（値は別の語なので、英字だけの語に限る）
  if (args.includes("--no-verify") || args.some((a) => /^-[a-zA-Z]*n[a-zA-Z]*$/.test(a))) {
    return block("`--no-verify` は禁止です。フックが失敗する原因を直してください。");
  }
  const branch = input.git.currentBranch;
  if (input.git.inRepo && branch && isDefault(branch, input)) {
    return block(
      `既定ブランチ（${branch}）への直接の commit は禁止です。先に作業ブランチを作成してください: git switch -c <ブランチ名>`,
    );
  }
  if (args.includes("--amend")) {
    return blockWithHandoff("`git commit --amend` は履歴を書き換えるため実行できません。");
  }
  return ALLOW;
}

/** 作業ツリーや履歴を壊す操作（移植元では許可制だったもの。決定 005 で拒否にした） */
function destructiveGit(sub: string, args: string[]): Verdict {
  const has = (...f: string[]) => f.some((x) => args.includes(x));
  // `-df` のような短いオプションの結合
  const shortHas = (letter: string) =>
    args.some((a) => /^-[A-Za-z]+$/.test(a) && a.includes(letter));
  const deny = (what: string) => blockWithHandoff(`${what}は実行できません。`);
  switch (sub) {
    case "reset":
      return has("--hard", "--merge", "--keep")
        ? deny("`git reset --hard` は作業ツリーの変更を破棄するため、")
        : ALLOW;
    case "clean":
      return has("-n", "--dry-run")
        ? ALLOW
        : deny("`git clean` は追跡されていないファイルを削除するため、");
    case "checkout": {
      const discards = has("--", ".", "-f", "--force");
      return discards ? deny("`git checkout` による変更の破棄は、") : ALLOW;
    }
    case "restore": {
      const stagedOnly = has("--staged") && !has("--worktree", "-W");
      return stagedOnly ? ALLOW : deny("`git restore` は作業ツリーの変更を破棄するため、");
    }
    case "switch":
      return has("-f", "--force", "--discard-changes")
        ? deny("`git switch --discard-changes` は変更を破棄するため、")
        : ALLOW;
    case "branch":
      // `-D`、`-d` と `-f` / `--force` の組み合わせ（`--delete --force`・`-df` などの結合も）
      return has("-D") ||
        shortHas("D") ||
        ((has("-d", "--delete") || shortHas("d")) && (has("-f", "--force") || shortHas("f")))
        ? deny("`git branch -D` は未マージのブランチを削除するため、")
        : ALLOW;
    case "stash":
      return args[0] === "drop" || args[0] === "clear"
        ? deny("`git stash drop` / `clear` は退避した変更を失うため、")
        : ALLOW;
    case "rebase":
      return deny("`git rebase` は履歴を書き換えるため、");
    case "filter-branch":
    case "filter-repo":
      return deny("履歴を書き換える操作は、");
    case "reflog":
      return args[0] === "expire" || args[0] === "delete"
        ? deny("reflog を削除する操作は、")
        : ALLOW;
    case "gc":
      return args.some((a) => a.startsWith("--prune"))
        ? deny("`git gc --prune` は到達不能なオブジェクトを削除するため、")
        : ALLOW;
    case "update-ref":
      return has("-d") ? deny("参照を削除する操作は、") : ALLOW;
    case "tag":
      return has("-d", "--delete") ? deny("タグを削除する操作は、") : ALLOW;
    default:
      return ALLOW;
  }
}

function checkWorktree(args: string[], dynamic: boolean): Verdict {
  const action = args[0];
  if (action === "prune") {
    return blockWithHandoff(
      "`git worktree prune` は worktree の記録を削除するため実行できません。",
    );
  }
  if (action !== "remove") return ALLOW;
  if (args.includes("--force") || args.includes("-f")) {
    return block(
      "`git worktree remove --force` は禁止です。未保存の成果物がある場合は、削除せずに、理由とパスを報告してください。",
    );
  }
  const target = args.slice(1).find((a) => !a.startsWith("-"));
  if (!target || dynamic || !target.startsWith("/")) {
    return block(
      "`git worktree remove` は、メインのチェックアウトから、絶対パスを直接指定してください。",
    );
  }
  return ALLOW;
}

/** 呼び出し側（index.ts）が git の状態を取る必要があるサブコマンド */
export const GIT_STATE_SUBS = new Set(["commit", "push", "merge"]);

export function checkGit(inv: Invocation, input: GuardInput): Verdict {
  const parsed = gitSubcommand(inv);
  if (!parsed) return ALLOW;
  return checkGitCall(parsed, input);
}

export function checkGitCall(call: GitCall, input: GuardInput): Verdict {
  const { sub, args, dynamic } = call;

  if (input.env.isSubagent && SUBAGENT_DENIED_GIT.has(sub)) {
    return block(subagentReason(`\`git ${sub}\``));
  }

  const verdicts: Verdict[] = [];
  switch (sub) {
    case "commit":
      verdicts.push(checkCommit(args, input));
      break;
    case "push":
      verdicts.push(checkPush(args, dynamic, input));
      break;
    case "merge": {
      const branch = input.git.currentBranch;
      if (branch && isDefault(branch, input)) {
        verdicts.push(
          block(
            "既定ブランチ上での直接の merge は禁止です。作業ブランチで PR を作り、PR 経由で取り込んでください。",
          ),
        );
      }
      break;
    }
    case "worktree":
      if (input.env.isSubagent) verdicts.push(block(subagentReason("`git worktree`")));
      else verdicts.push(checkWorktree(args, dynamic));
      break;
    default:
      break;
  }
  verdicts.push(destructiveGit(sub, args));
  return combine(verdicts);
}

const PR_WRITE = new Set([
  "create",
  "edit",
  "merge",
  "ready",
  "close",
  "reopen",
  "review",
  "comment",
  "lock",
  "unlock",
  "update-branch",
]);
const GH_BLOCKED_GROUPS = new Set(["secret", "variable", "ruleset", "ssh-key", "gpg-key", "auth"]);

const MERGE_REASON = "PR のマージを実行しようとしています。";

export function checkGh(inv: Invocation, input: GuardInput): Verdict {
  const words = inv.args.map((w) => w.value);
  const group = words.find((w) => !w.startsWith("-"));
  if (!group) return ALLOW;
  const action = words.slice(words.indexOf(group) + 1).find((w) => !w.startsWith("-"));

  if (input.env.isSubagent && group === "pr" && action && PR_WRITE.has(action)) {
    return block(subagentReason(`\`gh pr ${action}\``));
  }
  // マージは依頼ゲートつき（決定 003）。依頼の有無の判定と確認ダイアログは register.ts
  if (group === "pr" && action === "merge") return mergeGate(MERGE_REASON);
  if (group === "pr") return ALLOW;
  if (group === "api") {
    if (words.some((w) => /\/pulls\/\d+\/merge/.test(w))) return mergeGate(MERGE_REASON);
    // メソッドが GET と明示されていれば、`-f` / `-F`（GET ではクエリ）があっても読み取り
    const explicitGet = words.some(
      (w, i) =>
        ((w === "-X" || w === "--method") && (words[i + 1] ?? "").toUpperCase() === "GET") ||
        (w.startsWith("--method=") && w.slice(9).toUpperCase() === "GET"),
    );
    if (explicitGet) return ALLOW;
    // GraphQL は `-f query=…` で POST する。本文に mutation があるときだけ拒否する
    if (words.includes("graphql")) {
      const bodies = inv.args.filter(
        (w, i) =>
          /^(-f|-F|--field|--raw-field)$/.test(inv.args[i - 1]?.value ?? "") &&
          w.value.startsWith("query="),
      );
      // `@ファイル` や変数・コマンド置換で渡された本文は、中身を見られないので拒否する
      const opaque = bodies.some((b) => b.dynamic || b.value.startsWith("query=@"));
      if (opaque) {
        return block(
          "`gh api graphql` のクエリを、ファイル（`@…`）・変数・コマンド置換で渡すと中身を確かめられないため止めました。読み取りのクエリなら `-f query='…'` に直接書いてください（mutation は禁止です）。",
        );
      }
      if (words.includes("--input") || bodies.some((b) => /mutation/i.test(b.value))) {
        return block(
          "`gh api graphql` の mutation（書き込み）は禁止です。`gh pr` などの専用のコマンドを使ってください。",
        );
      }
      return ALLOW;
    }
    const mutating =
      words.some(
        (w, i) => (w === "-X" || w === "--method") && (words[i + 1] ?? "").toUpperCase() !== "GET",
      ) ||
      words.some((w) => w.startsWith("--method=") && w.slice(9).toUpperCase() !== "GET") ||
      words.some(
        (w) =>
          w === "-f" || w === "-F" || w === "--field" || w === "--raw-field" || w === "--input",
      );
    if (mutating) {
      return block(
        "`gh api` による書き込み（POST・PUT・PATCH・DELETE）は禁止です。`gh pr` などの専用のコマンドを使ってください。",
      );
    }
    return ALLOW;
  }
  if (GH_BLOCKED_GROUPS.has(group)) {
    return block(`\`gh ${group}\` はリポジトリや認証の設定を変えるため禁止です。`);
  }
  if (
    group === "repo" &&
    action &&
    ["delete", "archive", "rename", "edit", "transfer"].includes(action)
  ) {
    return block(`\`gh repo ${action}\` は禁止です。`);
  }
  if (group === "release" && action && ["create", "delete", "edit", "upload"].includes(action)) {
    return block(`\`gh release ${action}\` は禁止です。`);
  }
  return ALLOW;
}
