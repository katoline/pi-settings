/**
 * scripts/install.sh のテスト。一時ディレクトリを PI_CODING_AGENT_DIR にして実行し、実際のホームには触れない。
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

const root = realpathSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."));
const script = path.join(root, "scripts/install.sh");
const NAMES = ["extensions", "skills", "agents", "settings.json"];

const tmpRoot = mkdtempSync(path.join(os.tmpdir(), "install-test-"));
after(() => rmSync(tmpRoot, { recursive: true, force: true }));

let counter = 0;
/** 空の配置先（まだ作られていない agent ディレクトリ）の場所を返す */
const freshAgentDir = () => path.join(tmpRoot, `case-${counter++}`, "agent");

const run = (agentDir: string, ...args: string[]) => {
  const r = spawnSync("bash", [script, ...args], {
    env: { ...process.env, PI_CODING_AGENT_DIR: agentDir, HOME: path.join(tmpRoot, "home") },
    encoding: "utf8",
  });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr, all: r.stdout + r.stderr };
};

test("--dry-run は何も作らず、予定を表示する", () => {
  const agentDir = freshAgentDir();
  const r = run(agentDir, "--dry-run");
  assert.equal(r.status, 0);
  assert.equal(existsSync(agentDir), false);
  for (const name of NAMES) {
    assert.ok(
      r.stdout.includes(`${path.join(agentDir, name)} -> ${path.join(root, "agent", name)}`),
      name,
    );
  }
});

test("配置すると、4 つのリンクがリポジトリを指す", () => {
  const agentDir = freshAgentDir();
  const r = run(agentDir);
  assert.equal(r.status, 0, r.all);
  for (const name of NAMES) {
    const dest = path.join(agentDir, name);
    assert.ok(lstatSync(dest).isSymbolicLink(), name);
    assert.equal(readlinkSync(dest), path.join(root, "agent", name));
  }
  assert.deepEqual(readdirSync(agentDir).sort(), [...NAMES].sort());
});

test("2 回目は exit 0 で何も変えない", () => {
  const agentDir = freshAgentDir();
  assert.equal(run(agentDir).status, 0);
  const r = run(agentDir);
  assert.equal(r.status, 0, r.all);
  assert.equal(r.stdout.match(/済み:/g)?.length, NAMES.length);
  assert.ok(!r.stdout.includes("リンク:"));
  for (const name of NAMES) {
    assert.equal(readlinkSync(path.join(agentDir, name)), path.join(root, "agent", name));
  }
});

test("既存のファイルがあると競合として exit 1 になり、そのファイルは無傷", () => {
  const agentDir = freshAgentDir();
  mkdirSync(agentDir, { recursive: true });
  const mine = path.join(agentDir, "settings.json");
  writeFileSync(mine, '{"mine":true}\n');
  const r = run(agentDir);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /競合:.*settings\.json/);
  assert.equal(readFileSync(mine, "utf8"), '{"mine":true}\n');
  assert.equal(lstatSync(mine).isSymbolicLink(), false);
  // 競合以外は配置される
  for (const name of ["extensions", "skills", "agents"]) {
    assert.ok(lstatSync(path.join(agentDir, name)).isSymbolicLink(), name);
  }
});

test("既存のディレクトリも競合で、中身は無傷", () => {
  const agentDir = freshAgentDir();
  mkdirSync(path.join(agentDir, "skills"), { recursive: true });
  writeFileSync(path.join(agentDir, "skills", "keep.txt"), "x");
  const r = run(agentDir);
  assert.equal(r.status, 1);
  assert.equal(readFileSync(path.join(agentDir, "skills", "keep.txt"), "utf8"), "x");
  assert.equal(lstatSync(path.join(agentDir, "skills")).isSymbolicLink(), false);
});

test("別の場所へのリンクも競合で、リンクは変わらない", () => {
  const agentDir = freshAgentDir();
  mkdirSync(agentDir, { recursive: true });
  const elsewhere = path.join(tmpRoot, "elsewhere");
  mkdirSync(elsewhere);
  symlinkSync(elsewhere, path.join(agentDir, "agents"));
  const r = run(agentDir);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /競合:.*agents.*別の場所/);
  assert.equal(readlinkSync(path.join(agentDir, "agents")), elsewhere);
});

test("不明な引数はエラーで、使い方を表示し、何も作らない", () => {
  const agentDir = freshAgentDir();
  const r = run(agentDir, "--bogus");
  assert.equal(r.status, 2);
  assert.match(r.stderr, /使い方/);
  assert.equal(existsSync(agentDir), false);
});

test("AGENTS.md があれば警告だけして、消さない", () => {
  const agentDir = freshAgentDir();
  mkdirSync(agentDir, { recursive: true });
  const agentsMd = path.join(agentDir, "AGENTS.md");
  writeFileSync(agentsMd, "old");
  const r = run(agentDir);
  assert.equal(r.status, 0, r.all);
  assert.match(r.stderr, /警告:.*AGENTS\.md/);
  assert.equal(readFileSync(agentsMd, "utf8"), "old");
});
