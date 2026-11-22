import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  fsReader,
  parseNul,
  workingTreeFingerprint,
} from "../agent/extensions/harness/flow/fingerprint.ts";
import {
  buildReviewTask,
  DIFF_CAP,
  parseVerdict,
} from "../agent/extensions/harness/flow/review.ts";
import {
  detectPackageManager,
  detectVerifyCommands,
  isOnPath,
  resolveVerifyCommands,
  summarizeOutput,
  useDevShell,
} from "../agent/extensions/harness/flow/verify.ts";

const files = (map: Record<string, string>) => ({
  read: (f: string) => map[f] ?? null,
  exists: (f: string) => f in map,
});

test("検証コマンド: 明示した設定が最優先", () => {
  const cmds = detectVerifyCommands(
    files({
      ".harness/verify.json": '{"commands":["make check","./t.sh"]}',
      "package.json": '{"scripts":{"check":"x"}}',
    }),
  );
  assert.deepEqual(cmds, ["make check", "./t.sh"]);
});

test("devShell: verify.json が無く、追跡済みの flake.nix があり、nix が PATH にあるときだけ nix develop -c で実行する", () => {
  const pkg = { "package.json": '{"scripts":{"lint":"a","test":"b"}}' };
  const flake = { ...pkg, "flake.nix": "{}" };
  const on = { nixOnPath: true, flakeTracked: true };
  assert.equal(useDevShell(files(flake), on), true);
  assert.deepEqual(resolveVerifyCommands(files(flake), on), [
    "nix develop -c npm run lint",
    "nix develop -c npm test",
  ]);
  // nix が無い・flake.nix が無いときは、そのまま
  const noNix = { ...on, nixOnPath: false };
  assert.equal(useDevShell(files(flake), noNix), false);
  assert.deepEqual(resolveVerifyCommands(files(flake), noNix), ["npm run lint", "npm test"]);
  assert.equal(useDevShell(files(pkg), on), false);
  assert.deepEqual(resolveVerifyCommands(files(pkg), on), ["npm run lint", "npm test"]);
  // flake.nix が git で追跡されていない（作った直後・git の外）ときは、そのまま
  const untracked = { ...on, flakeTracked: false };
  assert.equal(useDevShell(files(flake), untracked), false);
  assert.deepEqual(resolveVerifyCommands(files(flake), untracked), ["npm run lint", "npm test"]);
  // verify.json に書かれたコマンドは、flake.nix があってもそのまま実行する（壊れていても devShell にしない）
  const explicit = { ...flake, ".harness/verify.json": '{"commands":["make check"]}' };
  assert.equal(useDevShell(files(explicit), on), false);
  assert.deepEqual(resolveVerifyCommands(files(explicit), on), ["make check"]);
  assert.equal(useDevShell(files({ ...flake, ".harness/verify.json": "{" }), on), false);
  // コマンドが無ければ空のまま（未検証）
  assert.deepEqual(resolveVerifyCommands(files({ "flake.nix": "{}" }), on), []);
});

test("PATH に実行ファイルがあるかの判定", () => {
  const exists = (f: string) => f === "/nix/var/bin/nix";
  assert.equal(isOnPath("nix", "/usr/bin:/nix/var/bin/", exists), true);
  assert.equal(isOnPath("nix", "/usr/bin:/bin", exists), false);
  assert.equal(isOnPath("nix", undefined, exists), false);
  assert.equal(isOnPath("nix", "", exists), false);
});

test("検証コマンド: check スクリプトがあれば、それだけ", () => {
  assert.deepEqual(
    detectVerifyCommands(files({ "package.json": '{"scripts":{"check":"x","test":"y"}}' })),
    ["npm run check"],
  );
});

test("検証コマンド: lint・typecheck・test・build を、あるものだけ、この順に", () => {
  const cmds = detectVerifyCommands(
    files({ "package.json": '{"scripts":{"build":"b","test":"t","lint":"l","dev":"d"}}' }),
  );
  assert.deepEqual(cmds, ["npm run lint", "npm test", "npm run build"]);
});

test("検証コマンド: ロックファイルでパッケージマネージャを決める", () => {
  assert.equal(detectPackageManager(files({ "pnpm-lock.yaml": "" })), "pnpm");
  assert.equal(detectPackageManager(files({ "yarn.lock": "" })), "yarn");
  assert.equal(detectPackageManager(files({ "bun.lock": "" })), "bun");
  assert.equal(detectPackageManager(files({})), "npm");
  assert.deepEqual(
    detectVerifyCommands(
      files({ "package.json": '{"scripts":{"test":"t"}}', "pnpm-lock.yaml": "" }),
    ),
    ["pnpm run test"],
  );
});

test("検証コマンド: 見つからない・壊れている場合は空(未検証)", () => {
  assert.deepEqual(detectVerifyCommands(files({})), []);
  assert.deepEqual(detectVerifyCommands(files({ "package.json": "{ broken" })), []);
  assert.deepEqual(detectVerifyCommands(files({ "package.json": '{"scripts":{"dev":"d"}}' })), []);
  assert.deepEqual(detectVerifyCommands(files({ ".harness/verify.json": "{ broken" })), []);
});

test("出力の要約は、末尾を残す", () => {
  assert.equal(summarizeOutput("short"), "short");
  const long = `${"a".repeat(1000)}END`;
  const s = summarizeOutput(long, 20);
  assert.ok(s.endsWith("END") && s.length <= 22);
});

test("指紋: 内容が同じなら同じ。変更・追加・削除で変わる。順序によらない", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "harness-fp-"));
  mkdirSync(path.join(dir, "src"));
  writeFileSync(path.join(dir, "a.txt"), "A");
  writeFileSync(path.join(dir, "src/b.txt"), "B");
  const fp = (list: string[]) =>
    workingTreeFingerprint({ listFiles: async () => list, read: fsReader(dir) });
  const base = await fp(["a.txt", "src/b.txt"]);
  assert.equal(await fp(["src/b.txt", "a.txt"]), base);
  writeFileSync(path.join(dir, "a.txt"), "A2");
  const changed = await fp(["a.txt", "src/b.txt"]);
  assert.notEqual(changed, base);
  writeFileSync(path.join(dir, "c.txt"), "C");
  assert.notEqual(await fp(["a.txt", "src/b.txt", "c.txt"]), changed);
  assert.equal(await fp(["a.txt", "src/b.txt", "gone.txt"]), changed); // 存在しないファイルは無視
});

test("指紋: 名前の付け替え(同じ内容)でも変わる", async () => {
  const mk = (name: string) =>
    workingTreeFingerprint({ listFiles: async () => [name], read: () => Buffer.from("X") });
  assert.notEqual(await mk("a"), await mk("b"));
});

test("git ls-files -z の出力を分ける", () => {
  assert.deepEqual(parseNul("a\0b c\0"), ["a", "b c"]);
});

test("レビューの判定: マーカーがない・エラーは承認しない", () => {
  assert.equal(parseVerdict("問題なし\n<approved/>"), "approved");
  assert.equal(parseVerdict("src/a.ts:3 バグ\n<disapproved/>"), "disapproved");
  assert.equal(parseVerdict("問題なし(マーカーなし)"), "none");
  assert.equal(parseVerdict(""), "none");
  assert.equal(parseVerdict("<approved/> しかし <disapproved/>"), "disapproved");
  assert.equal(parseVerdict("<approved />"), "approved");
  // 最終行で判定する。本文の途中のマーカー（指摘の引用など）は見ない
  assert.equal(parseVerdict("<approved/>\nやはり直すべき点があります"), "none");
  assert.equal(parseVerdict("`<disapproved/>` と書くべきか迷った\n指摘あり"), "none");
  assert.equal(parseVerdict("指摘あり\n<approved/>\n\n  \n"), "approved");
  assert.equal(parseVerdict("<approved/>\n指摘あり\n<disapproved/>"), "disapproved");
});

test("レビューの依頼: 要件と差分だけを渡し、マーカーの出力を要求する", () => {
  const task = buildReviewTask({
    requirements: "R1: x",
    baseRef: "origin/main",
    diffStat: "1 file",
    diff: "+a",
  });
  for (const s of [
    "R1: x",
    "origin/main",
    "```diff",
    "+a",
    "<approved/>",
    "<disapproved/>",
    "再現経路",
  ])
    assert.ok(task.includes(s), s);
  const big = buildReviewTask({
    requirements: "r",
    baseRef: "b",
    diffStat: "",
    diff: "x".repeat(DIFF_CAP + 10),
  });
  assert.match(big, /途中で切りました/);
});
