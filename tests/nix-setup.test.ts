import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";

const script = path.resolve("agent/skills/nix-setup/scripts/setup.mjs");
const dirs: string[] = [];
// 手元の git 設定（init.defaultBranch・署名など）に結果を左右されないようにする
const env = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };

function tempDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "nix-setup-test-"));
  dirs.push(dir);
  return dir;
}

function project(opts: { git?: boolean; branch?: string } = {}): string {
  const dir = tempDir();
  if (opts.git !== false) gitIn(dir, "init", "-q", "-b", opts.branch ?? "main");
  return dir;
}

function gitIn(dir: string, ...args: string[]) {
  const r = spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", ...args], {
    cwd: dir,
    env,
    encoding: "utf8",
  });
  assert.equal(r.status, 0, r.stderr);
}

function run(dir: string, ...args: string[]) {
  const r = spawnSync("node", [script, dir, ...args], { encoding: "utf8", env });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

const read = (dir: string, rel: string) => readFileSync(path.join(dir, rel), "utf8");
const has = (dir: string, rel: string) => existsSync(path.join(dir, rel));

afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

test("空のプロジェクトでは pnpm 用の全ファイルが作られる", () => {
  const dir = project();
  const r = run(dir, "--reviewer", "octocat");
  assert.equal(r.code, 0);
  for (const f of [
    "flake.nix",
    ".envrc",
    ".gitignore",
    "biome.json",
    "package.json",
    ".github/workflows/ci.yml",
    ".github/dependabot.yml",
    ".github/workflows/delete-merged-branch.yml",
    ".github/workflows/dependabot-review-request.yml",
  ]) {
    assert.ok(has(dir, f), f);
  }
  assert.match(read(dir, "flake.nix"), /nodejs pnpm/);
  assert.match(read(dir, ".envrc"), /use flake/);
  const ci = read(dir, ".github/workflows/ci.yml");
  assert.match(ci, /nix develop -c pnpm install --frozen-lockfile/);
  assert.match(ci, /nix develop -c pnpm run lint/);
  assert.match(ci, /branches: \[main\]/);
  const pkg = JSON.parse(read(dir, "package.json"));
  assert.equal(pkg.private, true);
  assert.equal(pkg.type, "module");
  assert.equal(pkg.scripts.lint, "biome check .");
  assert.equal(pkg.scripts.format, "biome format --write .");
  const biome = JSON.parse(read(dir, "biome.json"));
  assert.equal(biome.vcs.enabled, true);
  assert.equal(biome.vcs.useIgnoreFile, true);
  assert.match(r.out, /次にやること/);
});

test("package-lock.json があれば npm 用になる", () => {
  const dir = project();
  writeFileSync(path.join(dir, "package-lock.json"), "{}");
  assert.equal(run(dir).code, 0);
  assert.doesNotMatch(read(dir, "flake.nix"), /pnpm/);
  const ci = read(dir, ".github/workflows/ci.yml");
  assert.match(ci, /nix develop -c npm ci/);
  assert.match(ci, /nix develop -c npm run lint/);
});

test("yarn.lock があれば CI と lint は作らない", () => {
  const dir = project();
  writeFileSync(path.join(dir, "yarn.lock"), "");
  const r = run(dir);
  assert.equal(r.code, 0);
  assert.ok(!has(dir, ".github/workflows/ci.yml"));
  assert.ok(!has(dir, "biome.json"));
  assert.ok(has(dir, "flake.nix"));
});

test("既存ファイルは無傷でスキップと表示される", () => {
  const dir = project();
  mkdirSync(path.join(dir, ".github/workflows"), { recursive: true });
  const files: Record<string, string> = {
    "flake.nix": "# mine\n",
    ".envrc": "# mine\n",
    "biome.json": "{}\n",
    ".github/dependabot.yml": "# mine\n",
    ".github/workflows/delete-merged-branch.yml": "# mine\n",
    ".github/workflows/dependabot-review-request.yml": "# mine\n",
  };
  for (const [f, c] of Object.entries(files)) writeFileSync(path.join(dir, f), c);
  const r = run(dir, "--reviewer", "octocat");
  assert.equal(r.code, 0);
  for (const [f, c] of Object.entries(files)) {
    assert.equal(read(dir, f), c, f);
    assert.match(r.out, new RegExp(`スキップ: ${f.replaceAll(".", "\\.")}`));
  }
});

test("他の CI があれば ci.yml は作らない", () => {
  const dir = project();
  mkdirSync(path.join(dir, ".github/workflows"), { recursive: true });
  writeFileSync(path.join(dir, ".github/workflows/test.yml"), "# mine\n");
  const r = run(dir);
  assert.ok(!has(dir, ".github/workflows/ci.yml"));
  assert.match(r.out, /すでに他の CI がある/);
});

test("--dry-run は何も書かない", () => {
  const dir = project();
  const r = run(dir, "--dry-run", "--reviewer", "octocat");
  assert.equal(r.code, 0);
  assert.match(r.out, /dry-run/);
  assert.match(r.out, /作成: flake\.nix/);
  assert.ok(!has(dir, "flake.nix"));
  assert.ok(!has(dir, ".github"));
  assert.ok(!has(dir, "package.json"));
});

test("package.json の既存 scripts は変えず、無いキーだけ足す", () => {
  const dir = project();
  writeFileSync(
    path.join(dir, "package.json"),
    JSON.stringify({ name: "x", scripts: { lint: "custom", test: "t" } }),
  );
  run(dir);
  const pkg = JSON.parse(read(dir, "package.json"));
  assert.equal(pkg.scripts.lint, "custom");
  assert.equal(pkg.scripts.test, "t");
  assert.equal(pkg.scripts.format, "biome format --write .");
  assert.equal(pkg.name, "x");
});

test("ESLint があれば biome.json と lint スクリプトを作らない", () => {
  const dir = project();
  writeFileSync(
    path.join(dir, "package.json"),
    JSON.stringify({ name: "x", devDependencies: { eslint: "9.0.0" } }),
  );
  const r = run(dir);
  assert.ok(!has(dir, "biome.json"));
  assert.equal(JSON.parse(read(dir, "package.json")).scripts, undefined);
  assert.match(r.out, /既存の linter（eslint）/);
  // lint スクリプトが無いので CI の lint はコメントになる（初回から落ちないように）
  const ci = read(dir, ".github/workflows/ci.yml");
  assert.match(ci, /^ {6}# - run: nix develop -c pnpm run lint$/m);
  assert.doesNotMatch(ci, /^ {6}- run: nix develop -c pnpm run lint$/m);
  assert.match(r.out, /注意: package\.json に lint スクリプトが無いので、ci\.yml の lint の行/);
  assert.match(r.out, /3\. package\.json に lint スクリプトが無いので、この手順は飛ばす/);

  const dir2 = project();
  writeFileSync(path.join(dir2, "eslint.config.js"), "export default [];\n");
  run(dir2);
  assert.ok(!has(dir2, "biome.json"));
  assert.equal(JSON.parse(read(dir2, "package.json")).scripts.lint, undefined);
});

test("--reviewer が無ければ review-request を作らず、有れば値が入る", () => {
  const dir = project();
  const r = run(dir);
  assert.ok(!has(dir, ".github/workflows/dependabot-review-request.yml"));
  assert.match(r.out, /gh api user --jq \.login/);

  const dir2 = project();
  run(dir2, "--reviewer", "octocat");
  assert.match(read(dir2, ".github/workflows/dependabot-review-request.yml"), /REVIEWER: octocat/);
});

test(".gitignore の追記は重複しない", () => {
  const dir = project();
  writeFileSync(path.join(dir, ".gitignore"), "dist\nnode_modules/");
  run(dir);
  const first = read(dir, ".gitignore");
  assert.equal(first, "dist\nnode_modules/\n.direnv/\n");
  run(dir);
  assert.equal(read(dir, ".gitignore"), first);
});

test("git 未初期化なら失敗する", () => {
  const dir = project({ git: false });
  const r = run(dir);
  assert.equal(r.code, 1);
  assert.match(r.err, /git init/);
  assert.ok(!has(dir, "flake.nix"));
});

test("引数の誤りは使い方つきのエラーになる", () => {
  const dir = project();
  const bad = run(dir, "--bogus");
  assert.equal(bad.code, 1);
  assert.match(bad.err, /使い方/);
  const missing = run(path.join(dir, "none"));
  assert.equal(missing.code, 1);
  assert.match(missing.err, /ディレクトリがありません/);
});

test("ESLint でも lint スクリプトがあれば CI の lint は有効のまま", () => {
  const dir = project();
  writeFileSync(
    path.join(dir, "package.json"),
    JSON.stringify({ name: "x", scripts: { lint: "eslint ." }, devDependencies: { eslint: "9" } }),
  );
  const r = run(dir);
  assert.equal(r.code, 0);
  assert.match(read(dir, ".github/workflows/ci.yml"), /^ {6}- run: nix develop -c pnpm run lint$/m);
  assert.doesNotMatch(r.out, /lint スクリプトが無い/);
});

test("--dry-run でも lint スクリプトの有無で CI の注意が出る", () => {
  const dir = project();
  writeFileSync(path.join(dir, "eslint.config.js"), "export default [];\n");
  const r = run(dir, "--dry-run");
  assert.equal(r.code, 0);
  assert.match(r.out, /lint の行（# - run: nix develop -c pnpm run lint）はコメントにしました/);
  assert.ok(!has(dir, ".github"));
});

test("origin/HEAD があればそのブランチを使い、直す旨の注意は出さない", () => {
  const dir = project({ branch: "feat/x" });
  gitIn(dir, "commit", "-q", "--allow-empty", "-m", "init");
  gitIn(dir, "update-ref", "refs/remotes/origin/develop", "HEAD");
  gitIn(dir, "symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/develop");
  const r = run(dir);
  assert.equal(r.code, 0);
  assert.match(read(dir, ".github/workflows/ci.yml"), /branches: \[develop\]/);
  assert.match(r.out, /CI の push 先ブランチ: develop（origin\/HEAD から）/);
  assert.doesNotMatch(r.out, /branches: \[develop\] を既定ブランチの名前に直して/);
});

test("origin/HEAD が無ければ作業ブランチではなくローカルの main・master を使う", () => {
  const dir = project();
  gitIn(dir, "commit", "-q", "--allow-empty", "-m", "init");
  gitIn(dir, "checkout", "-q", "-b", "feat/x");
  const r = run(dir);
  assert.match(read(dir, ".github/workflows/ci.yml"), /branches: \[main\]/);
  assert.match(
    r.out,
    /CI の push 先ブランチ: main（origin\/HEAD が無いため、ローカルの main ブランチから）/,
  );
  assert.match(
    r.out,
    /注意: ci\.yml の push 先ブランチを main にしました.*branches: \[main\] を既定ブランチの名前に直して/,
  );

  const dir2 = project({ branch: "master" });
  gitIn(dir2, "commit", "-q", "--allow-empty", "-m", "init");
  gitIn(dir2, "checkout", "-q", "-b", "feat/x");
  run(dir2);
  assert.match(read(dir2, ".github/workflows/ci.yml"), /branches: \[master\]/);
});

test("main・master も無ければ init.defaultBranch、それも無ければ main を使う", () => {
  const dir = project({ branch: "feat/x" });
  gitIn(dir, "commit", "-q", "--allow-empty", "-m", "init");
  gitIn(dir, "config", "init.defaultBranch", "trunk");
  const r = run(dir);
  assert.match(read(dir, ".github/workflows/ci.yml"), /branches: \[trunk\]/);
  assert.match(r.out, /CI の push 先ブランチ: trunk（.*init\.defaultBranch から）/);
  assert.match(r.out, /branches: \[trunk\] を既定ブランチの名前に直して/);

  const dir2 = project({ branch: "feat/x" });
  gitIn(dir2, "commit", "-q", "--allow-empty", "-m", "init");
  const r2 = run(dir2);
  assert.match(read(dir2, ".github/workflows/ci.yml"), /branches: \[main\]/);
  assert.match(r2.out, /CI の push 先ブランチ: main（決める手がかりが無いため、既定の main）/);
});

test(".gitignore は先頭・末尾の / の違いを同じものとみなす", () => {
  for (const lines of [
    "/node_modules\n.direnv\n",
    "node_modules\n/.direnv/\n",
    "/node_modules/\n.direnv/\n",
  ]) {
    const dir = project();
    writeFileSync(path.join(dir, ".gitignore"), lines);
    const r = run(dir);
    assert.equal(read(dir, ".gitignore"), lines, lines);
    assert.doesNotMatch(r.out, /作成: \.gitignore/);
  }
  const dir = project();
  writeFileSync(path.join(dir, ".gitignore"), "/node_modules\n");
  run(dir);
  assert.equal(read(dir, ".gitignore"), "/node_modules\n.direnv/\n");
});

test("package.json が不正なら何も書かずに失敗し、使い方は出さない", () => {
  for (const content of ["{bad", "null", "[]"]) {
    const dir = project();
    writeFileSync(path.join(dir, "package.json"), content);
    const r = run(dir, "--reviewer", "octocat");
    assert.equal(r.code, 1, content);
    assert.match(r.err, /package\.json を読めません/);
    assert.doesNotMatch(r.err, /使い方/);
    for (const f of ["flake.nix", ".envrc", ".gitignore", "biome.json", ".github"]) {
      assert.ok(!has(dir, f), `${content}: ${f}`);
    }
    assert.equal(read(dir, "package.json"), content);
  }
});

test("リポジトリのサブディレクトリを指定したら、ルートを示して失敗する", () => {
  const dir = project();
  const sub = path.join(dir, "packages", "app");
  mkdirSync(sub, { recursive: true });
  const r = run(sub);
  assert.equal(r.code, 1);
  assert.match(r.err, /git リポジトリのルートではありません/);
  assert.ok(r.err.includes(`リポジトリのルート（${realpathSync(dir)}）を指定してください`), r.err);
  assert.match(r.err, /git init はしないこと/);
  assert.match(r.err, /モノレポの一部に入れる場合は/);
  assert.doesNotMatch(r.err, /使い方/);
  assert.ok(!has(sub, "flake.nix"));
  assert.ok(!has(sub, ".git"));
  assert.ok(!has(dir, "flake.nix"));
});

test("シンボリックリンク経由でリポジトリのルートを指定しても通る", () => {
  const dir = project();
  const link = path.join(tempDir(), "link");
  symlinkSync(dir, link);
  const r = run(link);
  assert.equal(r.code, 0, r.err);
  assert.ok(has(dir, "flake.nix"));
});

test("Renovate の設定があれば dependabot.yml は作らない", () => {
  for (const f of [
    "renovate.json",
    ".renovaterc",
    ".github/renovate.json5",
    ".gitlab/renovate.json",
  ]) {
    const dir = project();
    mkdirSync(path.dirname(path.join(dir, f)), { recursive: true });
    writeFileSync(path.join(dir, f), "{}\n");
    const r = run(dir);
    assert.equal(r.code, 0);
    assert.ok(!has(dir, ".github/dependabot.yml"), f);
    assert.match(
      r.out,
      new RegExp(
        `スキップ: \\.github/dependabot\\.yml（Renovate の設定がある: ${f.replaceAll(".", "\\.")}）`,
      ),
    );
    assert.match(r.out, /注意: Renovate を使っている/);
    assert.ok(has(dir, ".github/workflows/delete-merged-branch.yml"));
  }
  const dir = project();
  writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "x", renovate: {} }));
  const r = run(dir);
  assert.ok(!has(dir, ".github/dependabot.yml"));
  assert.match(r.out, /package\.json の renovate キー/);
  // Dependabot の PR は来ないので、--reviewer の有無にかかわらずレビュー依頼も作らず、再実行も促さない
  assert.doesNotMatch(r.out, /--reviewer で渡して再実行/);
  const withReviewer = project();
  writeFileSync(path.join(withReviewer, "renovate.json"), "{}\n");
  const r2 = run(withReviewer, "--reviewer", "octocat");
  assert.equal(r2.code, 0, r2.err);
  assert.ok(!has(withReviewer, ".github/workflows/dependabot-review-request.yml"));
  assert.match(
    r2.out,
    /スキップ: \.github\/workflows\/dependabot-review-request\.yml（Renovate を使っているため）/,
  );
});
