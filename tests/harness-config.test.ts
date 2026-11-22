import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { loadConfig } from "../agent/extensions/harness/lib/config.ts";

const tmp = mkdtempSync(path.join(os.tmpdir(), "harness-config-"));
after(() => rmSync(tmp, { recursive: true, force: true }));

test("既定の設定は、Mac 向けの値を持ち、~ を展開する（作業ルート・一時領域・保護パス・既定ブランチ）", () => {
  const c = loadConfig("/Users/u", path.join(tmp, "none.json"), {});
  assert.deepEqual(c.workRoots, [
    "/Users/u/Dev/kaishi",
    "/Users/u/Dev/seino914",
    "/Users/u/Dev/hobby",
    "/Users/u/Dev/humanoid",
  ]);
  assert.deepEqual(c.tempRoots, ["$TMPDIR", "/tmp/claude-*", "/tmp/pi-*"]);
  assert.deepEqual(c.protectedHarnessPaths, ["/Users/u/.pi/agent"]);
  assert.ok(c.protectedGlobalPaths.includes("/Users/u/Dev/seino914/dotfiles"));
  assert.deepEqual(c.defaultBranches, ["main", "master"]);
});

test("上書きの設定は、既定に重なる", () => {
  const f = path.join(tmp, "o.json");
  writeFileSync(f, JSON.stringify({ workRoots: ["~/x"] }));
  const c = loadConfig("/Users/u", f, {});
  assert.deepEqual(c.workRoots, ["/Users/u/x"]);
  assert.deepEqual(c.defaultBranches, ["main", "master"]);
});

test("壊れた上書きは無視して、既定を使う", () => {
  const f = path.join(tmp, "broken.json");
  writeFileSync(f, "{ not json");
  const c = loadConfig("/Users/u", f, {});
  assert.ok(c.workRoots.includes("/Users/u/Dev/seino914"));
});

test("PI_CODING_AGENT_DIR の harness.json を読む", () => {
  const dir = path.join(tmp, "agentdir");
  mkdirSync(dir);
  writeFileSync(path.join(dir, "harness.json"), JSON.stringify({ defaultBranches: ["trunk"] }));
  const c = loadConfig("/Users/u", undefined, { PI_CODING_AGENT_DIR: dir });
  assert.deepEqual(c.defaultBranches, ["trunk"]);
});

test("型が違う上書きのキーは無視して、既定を使う", () => {
  const f = path.join(tmp, "badtype.json");
  writeFileSync(f, JSON.stringify({ workRoots: "~/x", defaultBranches: [1] }));
  const c = loadConfig("/Users/u", f, {});
  assert.ok(c.workRoots.includes("/Users/u/Dev/hobby"));
  assert.deepEqual(c.defaultBranches, ["main", "master"]);
});
