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

test("起動時のモデル選択は既定で無効、サブエージェントの上限は既定の値", () => {
  const c = loadConfig("/Users/u", path.join(tmp, "none.json"), {});
  assert.equal(c.selectModelOnStartup, false);
  assert.deepEqual(c.subagent, {
    maxTasks: 8,
    maxConcurrency: 4,
    timeoutSeconds: 900,
    maxTotal: 64,
  });
});

test("selectModelOnStartup と subagent の上書き（一部のキーだけでもよい）", () => {
  const f = path.join(tmp, "sub.json");
  writeFileSync(
    f,
    JSON.stringify({ selectModelOnStartup: true, subagent: { maxConcurrency: 2, maxTotal: 10 } }),
  );
  const c = loadConfig("/Users/u", f, {});
  assert.equal(c.selectModelOnStartup, true);
  assert.deepEqual(c.subagent, {
    maxTasks: 8,
    maxConcurrency: 2,
    timeoutSeconds: 900,
    maxTotal: 10,
  });
});

test("壊れた値（boolean でない・正の整数でない・オブジェクトでない）は無視して既定を使う", () => {
  const f = path.join(tmp, "badsub.json");
  writeFileSync(
    f,
    JSON.stringify({
      selectModelOnStartup: "yes",
      subagent: { maxTasks: 0, maxConcurrency: -1, timeoutSeconds: 1.5, maxTotal: "64" },
    }),
  );
  const c = loadConfig("/Users/u", f, {});
  assert.equal(c.selectModelOnStartup, false);
  assert.deepEqual(c.subagent, {
    maxTasks: 8,
    maxConcurrency: 4,
    timeoutSeconds: 900,
    maxTotal: 64,
  });

  const g = path.join(tmp, "badsub2.json");
  writeFileSync(g, JSON.stringify({ subagent: 5 }));
  assert.equal(loadConfig("/Users/u", g, {}).subagent.maxTasks, 8);
  // 読み込みのたびに、既定の値は共有されない（上書きが次の読み込みに残らない）
  assert.equal(loadConfig("/Users/u", path.join(tmp, "none.json"), {}).subagent.maxTotal, 64);
});

test("flow の上限は既定の値（差し戻し 3 周・継続 200 回・240 分・進捗なし 3 回）", () => {
  const c = loadConfig("/Users/u", path.join(tmp, "none.json"), {});
  assert.deepEqual(c.flow, {
    maxCyclesPerItem: 3,
    maxContinuations: 200,
    maxMinutes: 240,
    maxNoProgress: 3,
  });
});

test("flow の上書き（一部のキーだけでもよい。subagent の上書きと混ざらない）", () => {
  const f = path.join(tmp, "flow.json");
  writeFileSync(
    f,
    JSON.stringify({ flow: { maxContinuations: 50, maxMinutes: 30 }, subagent: { maxTotal: 7 } }),
  );
  const c = loadConfig("/Users/u", f, {});
  assert.deepEqual(c.flow, {
    maxCyclesPerItem: 3,
    maxContinuations: 50,
    maxMinutes: 30,
    maxNoProgress: 3,
  });
  assert.equal(c.subagent.maxTotal, 7);
});

test("flow の壊れた値（0・負・小数・文字列・null・配列）は既定のまま", () => {
  const f = path.join(tmp, "flow-bad.json");
  writeFileSync(
    f,
    JSON.stringify({
      flow: { maxCyclesPerItem: 0, maxContinuations: -1, maxMinutes: 1.5, maxNoProgress: "3" },
    }),
  );
  assert.deepEqual(loadConfig("/Users/u", f, {}).flow, {
    maxCyclesPerItem: 3,
    maxContinuations: 200,
    maxMinutes: 240,
    maxNoProgress: 3,
  });
  for (const flow of [null, [1, 2], "x", 5]) {
    writeFileSync(f, JSON.stringify({ flow }));
    assert.equal(loadConfig("/Users/u", f, {}).flow.maxContinuations, 200);
  }
});

test("loadConfig を重ねて呼んでも、flow の上書きは持ち越さない", () => {
  const f = path.join(tmp, "flow-iso.json");
  writeFileSync(f, JSON.stringify({ flow: { maxNoProgress: 9 } }));
  assert.equal(loadConfig("/Users/u", f, {}).flow.maxNoProgress, 9);
  assert.equal(loadConfig("/Users/u", path.join(tmp, "none.json"), {}).flow.maxNoProgress, 3);
});

test("compactionModel は既定で空。provider/id の形の文字列だけ上書きでき、壊れた値は無視する", () => {
  assert.equal(loadConfig("/Users/u", path.join(tmp, "none.json"), {}).compactionModel, "");
  const ok = path.join(tmp, "cm-ok.json");
  writeFileSync(ok, JSON.stringify({ compactionModel: "opencode-go/deepseek-v4.1-flash" }));
  assert.equal(loadConfig("/Users/u", ok, {}).compactionModel, "opencode-go/deepseek-v4.1-flash");
  for (const bad of ["nomodel", "a/", "/b", 1, null, ["a/b"]]) {
    const f = path.join(tmp, "cm-bad.json");
    writeFileSync(f, JSON.stringify({ compactionModel: bad }));
    assert.equal(loadConfig("/Users/u", f, {}).compactionModel, "", String(bad));
  }
});
