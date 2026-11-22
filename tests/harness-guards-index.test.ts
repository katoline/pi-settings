import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { evaluateBash, evaluateFileTool } from "../agent/extensions/harness/guards/index.ts";
import type { GitProbe } from "../agent/extensions/harness/lib/types.ts";
import { HANDOFF } from "../agent/extensions/harness/lib/verdict.ts";
import { HOME, input, macFs } from "./harness-helpers.ts";

type Over = Parameters<typeof input>[0];
const bash = async (cmd: string, over: Over = {}) => (await evaluateBash(cmd, input(over))).kind;
const file = async (tool: string, p: string, over: Over = {}) =>
  (await evaluateFileTool(tool, { path: p }, input(over))).kind;

test("通常の開発コマンドは許可", async () => {
  for (const cmd of [
    "npm test",
    "node --test",
    "git status && git diff",
    "git add -A && git commit -m 'feat: x'",
    "ls -la src | head",
    "grep -rn TODO src",
    "mkdir -p out && echo ok > out/a.txt",
    "gh pr view 1",
    "rm -rf dist",
  ]) {
    assert.equal(await bash(cmd), "allow", cmd);
  }
});

test("普段の作業（作業ブランチでの commit・push、PR 作成、ローカルの npm install、削除）は止まらない", async () => {
  for (const cmd of [
    "git add -A",
    'git commit -m "feat: 追加"',
    // エージェントがよく使う、ヒアドキュメントでメッセージを渡す形
    "git commit -m \"$(cat <<'EOF'\nfeat: 追加\n\nCo-Authored-By: x\nEOF\n)\"",
    "git push -u origin feat/x",
    "git push -u origin feat/x 2>&1 | tail -5",
    // 本体に引用符・括弧があるヒアドキュメント（`$( )` の中）
    "git commit -m \"$(cat <<'EOF'\nfix: it's a test\nEOF\n)\"",
    "gh pr create --title t --body \"$(cat <<'EOF'\n## Summary\n1) first\nEOF\n)\"",
    'git commit -m "$(cat <<EOF\nfix (a)\nEOF\n)"',
    'git commit -m "$(cat <<-EOF\n\tfix: it\'s\n\tEOF\n)"',
    'git commit -m "$(cat <<"EOF"\nfix: it\'s\nEOF\n)"',
    "gh pr create --base main --title 'feat: x' --body \"$(cat <<'EOF'\nbody\nEOF\n)\"",
    "gh pr view 1",
    "gh pr view --json title,body",
    "gh pr list --head feat/x --state open --json number,url",
    "gh pr edit 1 --title x",
    "git fetch origin && git switch -c feat/y origin/main",
    "npm install",
    "npm install lodash",
    "nix develop -c npm run check",
    `rm -rf ${HOME}/Dev/hobby/katoline-org/pi-settings/dist`,
    "rm -rf dist build",
  ]) {
    assert.equal(await bash(cmd, { branch: "feat/x" }), "allow", cmd);
  }
});

test("/private/tmp/pi-501 と /tmp/claude-* 配下の削除は止まらない（Mac の /tmp は実体が /private/tmp）", async () => {
  const i = input({});
  i.fs = macFs;
  i.env.tmpdir = "/var/folders/zz/abc/T";
  for (const cmd of [
    "rm -rf /private/tmp/pi-501/ui-compare/shots",
    "rm -rf /tmp/pi-501/ui-compare/shots",
    "rm -rf /private/tmp/claude-501/x/scratchpad/src",
    "rm -rf /var/folders/zz/abc/T/x",
    "rm -rf $TMPDIR/x",
  ]) {
    assert.equal((await evaluateBash(cmd, i)).kind, "allow", cmd);
  }
});

test("複数のガードにまたがる危険なコマンドを拒否する", async () => {
  for (const cmd of [
    "git push --force origin main",
    "sudo rm -rf /",
    "cat .env",
    "env",
    "rm -rf /",
    "pkill node",
    "echo $(cat .env)",
    "bash -c 'git push origin main'",
    "git commit --no-verify -m x",
  ]) {
    assert.equal(await bash(cmd), "block", cmd);
  }
});

// 方針の違い（決定 005）: 移植元では ask（確認ダイアログ）だったものは、すべて block になる
test("許可制だった操作は、黙って拒否し、理由の末尾に `!` で実行する案内が付く", async () => {
  for (const cmd of [
    "npm install -g x",
    "brew install x",
    "darwin-rebuild switch --flake .",
    "git reset --hard",
    "git rebase main",
    "git commit --amend",
    `echo x > ${HOME}/Dev/seino914/dotfiles/a.nix`,
    `cp a ${HOME}/.pi/agent/settings.json`,
  ]) {
    const v = await evaluateBash(cmd, input({}));
    assert.equal(v.kind, "block", cmd);
    assert.ok((v as { reason: string }).reason.endsWith(HANDOFF), cmd);
  }
});

test("解析できないコマンドと opaque な実行は拒否する", async () => {
  assert.equal(await bash("echo 'unclosed"), "block");
  assert.equal(await bash('sh -c "$CMD"'), "block");
  assert.equal(await bash("eval $X"), "block");
});

test("サブエージェントは、書き込みの Git 操作ができない", async () => {
  assert.equal(await bash("git commit -m x", { subagent: true }), "block");
  assert.equal(await bash("git push origin feat/x", { subagent: true }), "block");
  assert.equal(await bash("git diff", { subagent: true }), "allow");
});

test("グローバル環境（dotfiles）の中で作業しているときは、その中への書き込みを許す", async () => {
  const cwd = `${HOME}/Dev/seino914/dotfiles`;
  assert.equal(await bash(`echo x > ${cwd}/a.nix`, { cwd }), "allow");
});

test("ファイルツール: 秘密のファイルは読めない・書けない", async () => {
  assert.equal(await file("read", ".env"), "block");
  assert.equal(await file("write", ".env.local"), "block");
  assert.equal(await file("edit", `${HOME}/.ssh/config`), "block");
  assert.equal(await file("read", ".env.example"), "allow");
  assert.equal(await file("grep", "src"), "allow");
});

test("ファイルツール: 既定ブランチ上では書き込めない。読み取りはできる", async () => {
  assert.equal(await file("write", "src/a.ts", { branch: "main" }), "block");
  assert.equal(await file("edit", "src/a.ts", { branch: "master" }), "block");
  assert.equal(await file("read", "src/a.ts", { branch: "main" }), "allow");
  assert.equal(await file("write", "src/a.ts", { branch: "feat/x" }), "allow");
});

test("ファイルツール: リポジトリの外（/tmp など）は、既定ブランチ上でも書ける", async () => {
  assert.equal(await file("write", "/tmp/note.txt", { branch: "main" }), "allow");
});

test("ファイルツール: .git の中は書けない", async () => {
  assert.equal(await file("write", ".git/hooks/pre-commit"), "block");
  assert.equal(await file("edit", ".git/config"), "block");
});

test("ファイルツール: グローバル環境と ~/.pi/agent への書き込みは拒否", async () => {
  assert.equal(await file("write", `${HOME}/Dev/seino914/dotfiles/home.nix`), "block");
  assert.equal(await file("write", `${HOME}/.pi/agent/settings.json`), "block");
});

test("対象外のツールは許可", async () => {
  assert.equal((await evaluateFileTool("subagent", { task: "x" }, input({}))).kind, "allow");
});

test("ファイルツール: 既定ブランチの判定は、cwd ではなく対象ファイルのリポジトリで行う", async () => {
  const repo = mkdtempSync(path.join(os.tmpdir(), "harness-repo-"));
  try {
    mkdirSync(path.join(repo, "src"));
    const seen: string[] = [];
    const probeAt =
      (branch: string): GitProbe =>
      async (cwd) => {
        seen.push(cwd);
        return {
          inRepo: true,
          repoRoot: repo,
          currentBranch: branch,
          defaultBranches: new Set(["main", "master"]),
        };
      };
    // cwd はリポジトリの外（~/Dev/hobby）。対象ファイルのリポジトリが main にいる
    const outside = input({ cwd: `${HOME}/Dev/hobby`, inRepo: false });
    const edit = (p: string, branch: string) =>
      evaluateFileTool("edit", { path: p }, outside, probeAt(branch));
    assert.equal((await edit(path.join(repo, "src/a.ts"), "main")).kind, "block");
    assert.equal((await edit(path.join(repo, "src/a.ts"), "feat/x")).kind, "allow");
    // ファイルもディレクトリも未作成なら、存在する最も近い親（src）で判定する
    seen.length = 0;
    assert.equal((await edit(path.join(repo, "src/new/dir/b.ts"), "main")).kind, "block");
    assert.deepEqual(seen, [path.join(repo, "src")]);
    // 逆に、cwd がリポジトリ（main）の中でも、対象が別の（作業ブランチの）リポジトリなら許可
    const inMain = input({ cwd: `${HOME}/Dev/hobby/other`, branch: "main" });
    assert.equal(
      (
        await evaluateFileTool(
          "write",
          { path: path.join(repo, "src/a.ts") },
          inMain,
          probeAt("feat/x"),
        )
      ).kind,
      "allow",
    );
    // .git の中は、対象のリポジトリで判定する
    assert.equal((await edit(path.join(repo, ".git/config"), "feat/x")).kind, "block");
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("ファイルツール: .git の中は、実際のリポジトリと git でも拒否される（git rev-parse が失敗する場所）", async () => {
  const repo = mkdtempSync(path.join(os.tmpdir(), "harness-realgit-"));
  try {
    execFileSync("git", ["init", "-q", repo]);
    // 作業ブランチにして、拒否の理由が既定ブランチではなく .git であることを確かめられるようにする
    execFileSync("git", ["-C", repo, "checkout", "-q", "-b", "feat/x"]);
    const { probeGitState } = await import("../agent/extensions/harness/lib/git-state.ts");
    const { config } = await import("./harness-helpers.ts");
    const { realFs } = await import("../agent/extensions/harness/lib/runtime.ts");
    const probe: GitProbe = (cwd) =>
      probeGitState(async (args) => {
        try {
          const out = execFileSync("git", args, { cwd, stdio: ["ignore", "pipe", "ignore"] });
          return { code: 0, stdout: out.toString() };
        } catch {
          return { code: 128, stdout: "" };
        }
      }, config);
    // 前提: .git の中では rev-parse が失敗する
    assert.equal((await probe(path.join(repo, ".git/hooks"))).repoRoot, null);
    const base = { ...input({ cwd: repo }), fs: realFs };
    for (const p of [".git/hooks/pre-commit", ".git/config", ".git/info/exclude"]) {
      for (const target of [p, path.join(repo, p)]) {
        for (const tool of ["write", "edit"]) {
          const v = await evaluateFileTool(tool, { path: target }, base, probe);
          assert.equal(v.kind, "block", `${tool} ${target}`);
        }
      }
    }
    // .gitignore などの通常のファイルは許可
    const ok = await evaluateFileTool("write", { path: ".gitignore" }, base, probe);
    assert.equal(ok.kind, "allow");
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});
