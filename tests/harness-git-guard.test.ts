import assert from "node:assert/strict";
import { test } from "node:test";
import {
  checkGh,
  checkGit,
  gitSubcommand,
  switchTarget,
} from "../agent/extensions/harness/guards/git.ts";
import { evaluateBash } from "../agent/extensions/harness/guards/index.ts";
import { mentionsMerge, nextMergeRequested } from "../agent/extensions/harness/guards/merge.ts";
import type { GitProbe } from "../agent/extensions/harness/lib/types.ts";
import { combine, HANDOFF, type Verdict } from "../agent/extensions/harness/lib/verdict.ts";
import { input, inv } from "./harness-helpers.ts";

type Over = Parameters<typeof input>[0];

// ---- 単体（1 コマンドを、与えた git の状態で判定する） ----

function git(cmd: string, over: Over = {}): Verdict {
  return combine(
    inv(cmd)
      .filter((i) => i.name === "git")
      .map((i) => checkGit(i, input(over))),
  );
}
function gh(cmd: string, over: Over = {}): Verdict {
  return combine(
    inv(cmd)
      .filter((i) => i.name === "gh")
      .map((i) => checkGh(i, input(over))),
  );
}
const kind = (v: Verdict) => v.kind;

test("既定ブランチ上の commit は拒否、作業ブランチ上は許可", () => {
  assert.equal(kind(git('git commit -m "x"', { branch: "main" })), "block");
  assert.equal(kind(git('git commit -m "x"', { branch: "master" })), "block");
  assert.equal(kind(git('git commit -m "x"', { branch: "feat/a" })), "allow");
});

test("commit の --no-verify と -n は拒否", () => {
  assert.equal(kind(git('git commit --no-verify -m "x"')), "block");
  assert.equal(kind(git('git commit -n -m "x"')), "block");
  assert.equal(kind(git('git commit -nm "x"')), "block");
  assert.equal(kind(git('git commit -am "fix -n handling"')), "allow");
});

// 方針の違い（決定 005）: 移植元では ask（確認ダイアログ）だった --amend を、黙って拒否にした
test("commit --amend は拒否し、ユーザーが `!` で実行する案内を付ける", () => {
  const v = git("git commit --amend --no-edit");
  assert.equal(kind(v), "block");
  assert.ok((v as { reason: string }).reason.endsWith(HANDOFF));
});

test("既定ブランチへの push は拒否", () => {
  assert.equal(kind(git("git push origin main")), "block");
  assert.equal(kind(git("git push origin HEAD:main")), "block");
  assert.equal(kind(git("git push origin feat/x:refs/heads/master")), "block");
  assert.equal(kind(git("git push", { branch: "main" })), "block");
  assert.equal(kind(git("git push -u origin feat/x")), "allow");
  assert.equal(kind(git("git push")), "allow");
});

test("force push と --no-verify の push は拒否", () => {
  assert.equal(kind(git("git push --force origin feat/x")), "block");
  assert.equal(kind(git("git push -f origin feat/x")), "block");
  assert.equal(kind(git("git push -fu origin feat/x")), "block");
  assert.equal(kind(git("git push --force-with-lease origin feat/x")), "block");
  assert.equal(kind(git("git push --force-with-lease=feat/x origin feat/x")), "block");
  assert.equal(kind(git("git push origin +feat/x")), "block");
  assert.equal(kind(git("git push --no-verify origin feat/x")), "block");
  assert.equal(kind(git("git push --mirror")), "block");
});

// 方針の確定（決定 003）: マージ済みかどうかにかかわらず、push での削除は常に拒否する
test("push でのリモートブランチの削除は、常に拒否する", () => {
  assert.equal(kind(git("git push origin --delete feat/old")), "block");
  assert.equal(kind(git("git push origin :feat/old")), "block");
  assert.equal(kind(git("git push -d origin feat/old")), "block");
  assert.equal(kind(git("git push --mirror")), "block");
});

test("push のブランチ名を動的に組み立てると拒否", () => {
  assert.equal(kind(git('git push origin "$BRANCH"')), "block");
});

test("push の値を取るオプションは refspec と取り違えない", () => {
  assert.equal(kind(git("git push -o ci.skip origin feat/x")), "allow");
  assert.equal(kind(git("git push -o ci.skip origin main")), "block");
});

test("-C や -c の前置オプションがあってもサブコマンドを判定できる", () => {
  assert.equal(kind(git('git -C /repo -c user.name=a commit -m "x"', { branch: "main" })), "block");
  const [i] = inv("git -C a -C b -c x=1 push origin feat/x");
  assert.ok(i);
  const call = gitSubcommand(i);
  assert.equal(call?.sub, "push");
  assert.deepEqual(call?.dirs, ["a", "b"]);
});

test("git branch の削除は、-D と同じく --delete --force・-df も拒否する", () => {
  for (const cmd of [
    "git branch -D old",
    "git branch --delete --force old",
    "git branch -d -f old",
    "git branch -df old",
    "git branch -fd old",
  ]) {
    assert.equal(kind(git(cmd)), "block", cmd);
  }
  // マージ済みの削除（-d / --delete のみ）は git 自身が未マージなら失敗する
  assert.equal(kind(git("git branch -d old")), "allow");
  assert.equal(kind(git("git branch -a")), "allow");
});

test("gh api: -X GET の明示があれば -f / -F があっても許可する", () => {
  for (const cmd of [
    "gh api -X GET repos/o/r/pulls -f state=open",
    "gh api --method GET search/issues -F q=x",
    "gh api --method=get repos/o/r/commits -f sha=abc",
  ]) {
    assert.equal(kind(gh(cmd)), "allow", cmd);
  }
  assert.equal(kind(gh("gh api repos/o/r/issues -f title=x")), "block");
  assert.equal(kind(gh("gh api -X POST repos/o/r/issues -f title=x")), "block");
});

test("gh api graphql: 本文（query=）に mutation があるときだけ拒否", () => {
  assert.equal(kind(gh("gh api graphql -f query='query { viewer { login } }'")), "allow");
  assert.equal(
    kind(gh('gh api graphql -F query=\'{ repository(owner: "o", name: "r") { id } }\'')),
    "allow",
  );
  assert.equal(
    kind(
      gh(
        "gh api graphql -f query='mutation { addStar(input: {starrableId: \"x\"}) { clientMutationId } }'",
      ),
    ),
    "block",
  );
  assert.equal(kind(gh("gh api graphql -F query='mutation($id: ID!) { x }' -F id=1")), "block");
  assert.equal(kind(gh("gh api graphql --input q.json")), "block");
  // 中身を見られない本文（ファイル・変数）は拒否
  assert.equal(kind(gh("gh api graphql -F query=@q.graphql")), "block");
  assert.equal(kind(gh('gh api graphql -f query="$Q"')), "block");
  assert.equal(kind(gh("gh api graphql -f query='query { viewer { login } }'")), "allow");
});

// 方針の違い（決定 005）: 移植元では ask だった破壊的な操作を、黙って拒否にした
test("破壊的な操作は拒否し、ユーザーが `!` で実行する案内を付ける", () => {
  for (const cmd of [
    "git reset --hard HEAD~1",
    "git clean -fd",
    "git checkout -- .",
    "git checkout .",
    "git restore src/a.ts",
    "git branch -D old",
    "git stash drop",
    "git rebase main",
    "git switch --discard-changes main",
    "git worktree prune",
    "git tag -d v1",
  ]) {
    const v = git(cmd);
    assert.equal(kind(v), "block", cmd);
    assert.ok((v as { reason: string }).reason.endsWith(HANDOFF), cmd);
  }
});

test("通常の操作は許可", () => {
  for (const cmd of [
    "git status",
    "git diff",
    "git add -A",
    "git switch -c feat/a",
    "git checkout -b feat/a",
    "git restore --staged a.ts",
    "git clean -n",
    "git reset --soft HEAD~1",
    "git stash",
    "git log --oneline",
    "git worktree add ../x",
  ]) {
    assert.equal(kind(git(cmd)), "allow", cmd);
  }
});

test("既定ブランチ上の merge は拒否", () => {
  assert.equal(kind(git("git merge feat/x", { branch: "main" })), "block");
  assert.equal(kind(git("git merge main", { branch: "feat/x" })), "allow");
});

test("サブエージェントは commit・push・merge などを実行できない", () => {
  for (const cmd of [
    "git commit -m x",
    "git push origin feat/x",
    "git merge main",
    "git rebase main",
    "git tag v1",
    "git worktree add ../x",
  ]) {
    assert.equal(kind(git(cmd, { subagent: true })), "block", cmd);
  }
  assert.equal(kind(git("git diff", { subagent: true })), "allow");
  assert.equal(kind(git("git log", { subagent: true })), "allow");
});

// 方針の違い: pi では worktree を使わない（decisions/011）ので、移植元の所有チェックは持ち込まない。--force と相対パスだけ拒否する
test("worktree remove は、絶対パスで --force なしのときだけ許可", () => {
  assert.equal(kind(git("git worktree remove /w/a --force")), "block");
  assert.equal(kind(git("git worktree remove ../a")), "block");
  assert.equal(kind(git("git worktree remove /w/a")), "allow");
});

// 方針の違い（決定 003）: 移植元は gh pr create / edit / merge を専用ツールへ誘導して拒否するが、
// 専用ツールはフェーズ 5。ここでは create / edit は許可し、merge は依頼ゲート（kind: "merge"）にする
test("gh pr create / view / list / edit は許可、merge は依頼ゲート", () => {
  for (const cmd of [
    "gh pr create --title x",
    "gh pr create --base main --title x --body y",
    "gh pr edit 1 --body y",
    "gh pr view 1",
    "gh pr checks 1",
    "gh pr list",
  ]) {
    assert.equal(kind(gh(cmd)), "allow", cmd);
  }
  for (const cmd of [
    "gh pr merge 12 --squash",
    "gh pr merge",
    "gh api -X PUT repos/a/b/pulls/12/merge",
  ]) {
    assert.equal(kind(gh(cmd)), "merge", cmd);
  }
});

test("gh api は GET だけ許可", () => {
  assert.equal(kind(gh("gh api repos/o/r/pulls")), "allow");
  assert.equal(kind(gh("gh api repos/a/b/pulls/1")), "allow");
  assert.equal(kind(gh("gh api -X DELETE repos/o/r/git/refs/heads/x")), "block");
  assert.equal(kind(gh("gh api repos/o/r/issues -f title=x")), "block");
  assert.equal(kind(gh("gh api --method=POST repos/o/r/issues")), "block");
});

test("gh のサブエージェントからの PR 書き込みと、危険なグループは拒否", () => {
  assert.equal(kind(gh("gh pr create --title x", { subagent: true })), "block");
  assert.equal(kind(gh("gh pr comment 1 --body x", { subagent: true })), "block");
  assert.equal(kind(gh("gh pr view 1", { subagent: true })), "allow");
  assert.equal(kind(gh("gh secret set X")), "block");
  assert.equal(kind(gh("gh repo delete o/r --yes")), "block");
  assert.equal(kind(gh("gh release create v1")), "block");
});

test("switchTarget: 切替先を検出できる形だけ返す", () => {
  const target = (cmd: string) => {
    const [i] = inv(cmd);
    const call = i && gitSubcommand(i);
    return call ? switchTarget(call) : undefined;
  };
  assert.equal(target("git checkout -b feat/x"), "feat/x");
  assert.equal(target("git checkout -B feat/x origin/main"), "feat/x");
  assert.equal(target("git switch -c feat/x"), "feat/x");
  assert.equal(target("git switch --create feat/x"), "feat/x");
  assert.equal(target("git switch feat/y"), "feat/y");
  assert.equal(target("git checkout feat/y"), null); // ファイル指定と区別できない
  assert.equal(target("git switch -"), null);
  assert.equal(target("git switch $B"), null);
});

// ---- コマンド全体（旧 git-guard のテストケースを、同じ結果になることを確認して移したもの） ----

/** 現在のブランチが `current` のリポジトリ（null ならリポジトリの外） */
const stateOf =
  (current: string | null): GitProbe =>
  async () => ({
    inRepo: current !== null,
    repoRoot: current === null ? null : "/repo",
    currentBranch: current,
    defaultBranches: new Set(["main", "master"]),
  });
const run = (cmd: string, current: string | null = "feat/x") =>
  evaluateBash(cmd, input({ cwd: "/repo", branch: current }), stateOf(current));

const blocked = [
  "git push -f",
  "git push --force origin feat/x",
  "git push --force-with-lease",
  "git push --force-with-lease=feat/x origin feat/x",
  "git push origin +feat/x",
  "git push -fu origin feat/x",
  "git push -d origin feat/x",
  "git push origin --delete feat/x",
  "git push origin :feat/x",
  "git push --mirror",
  "git push --no-verify",
  "git commit --no-verify -m x",
  "git commit -n -m x",
  "git commit -nm x",
  "git push origin main",
  "git push origin HEAD:main",
  "git push origin feat:main",
  "git push origin HEAD:refs/heads/main",
  "FOO=1 git push --force",
  "cd sub && git push --force",
  "git -C dir push -f",
  "git -c core.x=1 --no-pager push -f",
  "echo hi\ngit push -f",
];
for (const cmd of blocked) {
  test(`block: ${cmd}`, async () => assert.equal((await run(cmd)).kind, "block"));
}

test("block: 既定ブランチ上の push（refspec 省略 / HEAD）", async () => {
  for (const cmd of [
    "git push",
    "git push origin",
    "git push origin HEAD",
    "git push -u origin HEAD",
  ]) {
    assert.equal((await run(cmd, "main")).kind, "block", cmd);
  }
});
test("block: 既定ブランチ上の commit", async () => {
  assert.equal((await run("git commit -m x", "main")).kind, "block");
  assert.equal((await run('git add . && git commit -m "a b"', "main")).kind, "block");
});
test("block: git 情報が取れなくても明示 refspec の main は止める", async () => {
  assert.equal((await run("git push origin main", null)).kind, "block");
});
test("allow: 情報が取れない（リポジトリの外）とき refspec 省略は通す", async () => {
  assert.equal((await run("git push", null)).kind, "allow");
  assert.equal((await run("git commit -m x", null)).kind, "allow");
});
test("block: リポジトリ内でも detached HEAD の push は、行き先を判定できないので止める", async () => {
  const detached: GitProbe = async () => ({
    inRepo: true,
    repoRoot: "/repo",
    currentBranch: null,
    defaultBranches: new Set(["main"]),
  });
  assert.equal((await evaluateBash("git push", input({ cwd: "/repo" }), detached)).kind, "block");
});

const allowed = [
  "git push -u origin feat/x",
  "git push",
  "git push origin HEAD",
  "git commit -m x",
  'git commit -m "fix -n handling"',
  "gh pr create --title x",
  "gh pr view 1",
  "git log --oneline",
  "git status && git diff",
  "gh api repos/a/b/pulls/1",
  "git push --dry-run -n origin feat/x",
];
for (const cmd of allowed) {
  test(`allow: ${cmd}`, async () => assert.equal((await run(cmd)).kind, "allow"));
}

test("merge（依頼ゲート）: gh pr merge / gh api .../merge", async () => {
  for (const cmd of [
    "gh pr merge 12 --squash",
    "gh pr merge",
    "gh api -X PUT repos/a/b/pulls/12/merge",
    "git status && gh pr merge 3",
    "bash -c 'gh pr merge 3'",
  ]) {
    assert.equal((await run(cmd)).kind, "merge", cmd);
  }
});
test("block が merge より優先される", async () => {
  assert.equal((await run("gh pr merge 1 && git push -f")).kind, "block");
});

test("cd と -C で、git の状態を取る作業ディレクトリが変わる", async () => {
  const seen: string[] = [];
  const probe: GitProbe = async (cwd) => {
    seen.push(cwd);
    return await stateOf("feat/x")(cwd);
  };
  const go = (cmd: string) => evaluateBash(cmd, input({ cwd: "/repo" }), probe);
  await go("cd dir && git push");
  await go("git -C other commit -m x");
  await go("cd /a && cd b && git push");
  await go("FOO=1 git push --force");
  assert.deepEqual(seen, ["/repo/dir", "/repo/other", "/a/b", "/repo"]);
});
test("ブランチ情報は該当 cwd で取得される", async () => {
  const seen: string[] = [];
  await evaluateBash("cd dir && git -C sub commit -m x", input({ cwd: "/repo" }), async (cwd) => {
    seen.push(cwd);
    return stateOf("f")(cwd);
  });
  assert.deepEqual(seen, ["/repo/dir/sub"]);
});
test("該当コマンドが無ければ git を呼ばない", async () => {
  let called = 0;
  await evaluateBash(
    "git log && gh pr view 1 && git status",
    input({ cwd: "/repo" }),
    async (cwd) => {
      called++;
      return stateOf(null)(cwd);
    },
  );
  assert.equal(called, 0);
});
test("同一コマンド内のブランチ切替後は新しいブランチで判定する", async () => {
  assert.equal(
    (await run('git checkout -b feat/x && git add a.ts && git commit -m "m"', "main")).kind,
    "allow",
  );
  assert.equal(
    (await run("git switch -c feat/x && git push -u origin HEAD", "main")).kind,
    "allow",
  );
  assert.equal((await run("git switch --create feat/x && git commit -m x", "main")).kind, "allow");
  assert.equal((await run("git switch feat/y && git commit -m x", "main")).kind, "allow");
});
test("既定ブランチへの切替後は block", async () => {
  assert.equal((await run("git switch main && git commit -m x", "feat")).kind, "block");
  assert.equal((await run("git switch main && git push", "feat")).kind, "block");
});
test("別ディレクトリの切替は cwd の判定に影響しない", async () => {
  assert.equal((await run("git -C other checkout -b x && git commit -m y", "main")).kind, "block");
  assert.equal(
    (await run("git -C other checkout -b x && git -C other commit -m y", "main")).kind,
    "allow",
  );
});

test("リダイレクトを refspec と取り違えない", async () => {
  // 既定ブランチ上では、リダイレクト付きでも refspec 省略として止める
  for (const cmd of [
    "git push origin 2>&1",
    "git push origin > /tmp/out.log 2>&1",
    "git push origin &>/dev/null",
    "git push origin >>log",
  ]) {
    assert.equal((await run(cmd, "main")).kind, "block", cmd);
  }
  // 作業ブランチ上の通常の push は通す
  assert.equal((await run("git push -u origin feat/x 2>&1")).kind, "allow");
  assert.equal((await run("git push -u origin feat/x 2>&1 | tail -5")).kind, "allow");
});

test("引用符付きの > / < で始まる引数はリダイレクトとして消さない", async () => {
  assert.equal((await run('git commit -m ">x" -n')).kind, "block");
  assert.equal((await run('git commit -m "<scope>: fix" --no-verify')).kind, "block");
  assert.equal((await run('git commit -m "<scope>: fix" 2>&1')).kind, "allow");
});

test("マージ依頼の判定", () => {
  assert.equal(mentionsMerge("PR #3 をマージして"), true);
  assert.equal(mentionsMerge("please merge it"), true);
  assert.equal(mentionsMerge("/skill:pr"), false);
  assert.equal(mentionsMerge("README を直して"), false);
  // 待機中の新しい依頼は置き換える
  assert.equal(nextMergeRequested(true, "README を直して", false), false);
  assert.equal(nextMergeRequested(false, "マージして", false), true);
  // 実行中の追加入力は足すだけ
  assert.equal(nextMergeRequested(true, "typo も直して", true), true);
  assert.equal(nextMergeRequested(false, "ついでにマージも", true), true);
});

// 3 回目の独立レビューの指摘への回帰テスト：中身を見られない graphql の本文は、直接書くよう案内する
test("gh api graphql の本文が見えないときは、mutation ではなく直接書く案内で止める", () => {
  for (const cmd of ["gh api graphql -F query=@q.graphql", 'gh api graphql -f query="$Q"']) {
    const v = gh(cmd);
    assert.equal(v.kind, "block", cmd);
    assert.ok(v.kind === "block" && v.reason.includes("-f query="), cmd);
  }
});
