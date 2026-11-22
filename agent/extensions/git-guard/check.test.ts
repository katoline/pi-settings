import assert from "node:assert/strict";
import test from "node:test";
import { detect, judge, mentionsMerge, nextMergeRequested, type BranchInfo } from "./check.ts";

const info = (current: string | null, defaults = ["main"]) => async (): Promise<BranchInfo | null> => ({ defaults, current });
const run = (cmd: string, current: string | null = "feat/x") => judge(cmd, "/repo", info(current));

const blocked = [
  "git push -f", "git push --force origin feat/x", "git push --force-with-lease", "git push --force-with-lease=feat/x origin feat/x",
  "git push origin +feat/x", "git push -fu origin feat/x",
  "git push -d origin feat/x", "git push origin --delete feat/x", "git push origin :feat/x", "git push --mirror",
  "git push --no-verify", "git commit --no-verify -m x", "git commit -n -m x", "git commit -nm x",
  "git push origin main", "git push origin HEAD:main", "git push origin feat:main", "git push origin HEAD:refs/heads/main",
  "FOO=1 git push --force", "cd sub && git push --force", "git -C dir push -f", "git -c core.x=1 --no-pager push -f",
  "echo hi\ngit push -f",
];
for (const cmd of blocked) {
  test(`block: ${cmd}`, async () => assert.equal((await run(cmd)).action, "block"));
}

test("block: 既定ブランチ上の push（refspec 省略 / HEAD）", async () => {
  for (const cmd of ["git push", "git push origin", "git push origin HEAD", "git push -u origin HEAD"]) {
    assert.equal((await run(cmd, "main")).action, "block", cmd);
  }
});
test("block: 既定ブランチ上の commit", async () => {
  assert.equal((await run("git commit -m x", "main")).action, "block");
  assert.equal((await run('git add . && git commit -m "a b"', "main")).action, "block");
});
test("block: git 情報が取れなくても明示 refspec の main は止める", async () => {
  const v = await judge("git push origin main", "/x", async () => null);
  assert.equal(v.action, "block");
});
test("allow: 情報が取れないとき refspec 省略は通す", async () => {
  assert.equal((await judge("git push", "/x", async () => null)).action, "allow");
  assert.equal((await judge("git commit -m x", "/x", async () => null)).action, "allow");
});

const allowed = [
  "git push -u origin feat/x", "git push", "git push origin HEAD", "git commit -m x", 'git commit -m "fix -n handling"',
  "gh pr create --title x", "gh pr view 1", "git log --oneline", "git status && git diff", "gh api repos/a/b/pulls/1", "git push --dry-run -n origin feat/x",
];
for (const cmd of allowed) {
  test(`allow: ${cmd}`, async () => assert.equal((await run(cmd)).action, "allow"));
}

test("confirm: gh pr merge / gh api .../merge", async () => {
  for (const cmd of ["gh pr merge 12 --squash", "gh pr merge", "gh api -X PUT repos/a/b/pulls/12/merge", "git status && gh pr merge 3"]) {
    assert.equal((await run(cmd)).action, "confirm", cmd);
  }
});
test("block が confirm より優先される", async () => {
  assert.equal((await run("gh pr merge 1 && git push -f")).action, "block");
});

test("detect: cd と -C で作業ディレクトリが変わる", () => {
  assert.equal(detect("cd dir && git push", "/repo")[0].cwd, "/repo/dir");
  assert.equal(detect("git -C other commit -m x", "/repo")[0].cwd, "/repo/other");
  assert.equal(detect("cd /a && cd b && git push", "/repo")[0].cwd, "/a/b");
  assert.equal(detect("FOO=1 git push --force", "/repo")[0].kind, "push");
});
test("ブランチ情報は該当 cwd で取得される", async () => {
  const seen: string[] = [];
  await judge("cd dir && git -C sub commit -m x", "/repo", async (cwd) => (seen.push(cwd), { defaults: ["main"], current: "f" }));
  assert.deepEqual(seen, ["/repo/dir/sub"]);
});
test("該当コマンドが無ければ git を呼ばない", async () => {
  let called = 0;
  await judge("git log && gh pr view 1", "/repo", async () => (called++, null));
  assert.equal(called, 0);
});

test("同一コマンド内のブランチ切替後は新しいブランチで判定する", async () => {
  assert.equal((await run('git checkout -b feat/x && git add a.ts && git commit -m "m"', "main")).action, "allow");
  assert.equal((await run("git switch -c feat/x && git push -u origin HEAD", "main")).action, "allow");
  assert.equal((await run("git switch --create feat/x && git commit -m x", "main")).action, "allow");
  assert.equal((await run("git switch feat/y && git commit -m x", "main")).action, "allow");
});
test("既定ブランチへの切替後は block", async () => {
  assert.equal((await run("git switch main && git commit -m x", "feat")).action, "block");
  assert.equal((await run("git switch main && git push", "feat")).action, "block");
});
test("別ディレクトリの切替は cwd の判定に影響しない", async () => {
  assert.equal((await run("git -C other checkout -b x && git commit -m y", "main")).action, "block");
  assert.equal((await run("git -C other checkout -b x && git -C other commit -m y", "main")).action, "allow");
});

test("リダイレクトを refspec と取り違えない", async () => {
  // 既定ブランチ上では、リダイレクト付きでも refspec 省略として止める
  for (const cmd of ["git push origin 2>&1", "git push origin > /tmp/out.log 2>&1", "git push origin &>/dev/null", "git push origin >>log"]) {
    assert.equal((await run(cmd, "main")).action, "block", cmd);
  }
  // 作業ブランチ上の通常の push は通す
  assert.equal((await run("git push -u origin feat/x 2>&1")).action, "allow");
  assert.equal((await run("git push -u origin feat/x 2>&1 | tail -5")).action, "allow");
});

test("引用符付きの > / < で始まる引数はリダイレクトとして消さない", async () => {
  assert.equal((await run('git commit -m ">x" -n')).action, "block");
  assert.equal((await run('git commit -m "<scope>: fix" --no-verify')).action, "block");
  assert.equal((await run('git commit -m "<scope>: fix" 2>&1')).action, "allow");
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
