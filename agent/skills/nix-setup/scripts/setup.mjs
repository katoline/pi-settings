#!/usr/bin/env node
/**
 * Nix セットアップ（TypeScript 向け）: devShell・direnv・Biome・CI・Dependabot などを、
 * 対象のプロジェクトに作る。既存のファイルは上書きしない。
 *
 * 使い方: node setup.mjs <プロジェクトのディレクトリ> [--dry-run] [--reviewer <GitHubのログイン>]
 */
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const templates = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "templates");
const USAGE =
  "使い方: node setup.mjs <プロジェクトのディレクトリ> [--dry-run] [--reviewer <GitHubのログイン>]";

/** 引数の誤り: 使い方つきで失敗する */
function fail(message) {
  console.error(message);
  console.error(USAGE);
  process.exit(1);
}

/** 引数以外の理由で止める: 使い方は出さない */
function abort(message) {
  console.error(message);
  process.exit(1);
}

// 引数の解析
let dryRun = false;
let reviewer = "";
let dir = "";
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
  const a = argv[i] ?? "";
  if (a === "--dry-run") dryRun = true;
  else if (a === "--reviewer") {
    reviewer = argv[++i] ?? "";
    if (!reviewer || reviewer.startsWith("--")) fail("--reviewer にはログイン名が要ります");
  } else if (a.startsWith("--")) fail(`不明なオプション: ${a}`);
  else if (dir) fail(`ディレクトリは 1 つだけ指定してください: ${a}`);
  else dir = a;
}
if (!dir) fail("プロジェクトのディレクトリを指定してください");
if (reviewer && !/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/.test(reviewer)) {
  fail(`GitHub のログインとして不正です: ${reviewer}`);
}
const target = path.resolve(dir);
if (!existsSync(target)) fail(`ディレクトリがありません: ${target}`);

/** git を実行して標準出力を返す。失敗したら空文字 */
function git(args) {
  try {
    return execFileSync("git", args, {
      cwd: target,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return "";
  }
}

// ここから下は何かを書く前の検証。失敗したら 1 つも書かずに止める

// git の判定（このスクリプトは git init をしない）
const toplevel = git(["rev-parse", "--show-toplevel"]);
if (!toplevel) {
  abort(`git が未初期化です: ${target}\n先に git init してから実行してください。`);
}
// macOS の /var → /private/var のようなシンボリックリンクを解決してから比べる
// native は macOS で大文字小文字も実際の名前に揃える（git の --show-toplevel と比べるため）
if (realpathSync.native(toplevel) !== realpathSync.native(target)) {
  abort(
    [
      `指定したディレクトリは git リポジトリのルートではありません: ${target}`,
      `リポジトリのルート（${toplevel}）を指定してください（.github/ はルートに置くものなので）。`,
      "このディレクトリで git init はしないこと（入れ子のリポジトリになる）。",
      "モノレポの一部に入れる場合は、このスクリプトを使わず手で行ってください。",
    ].join("\n"),
  );
}

const created = [];
const skipped = [];
const notes = [];
const has = (rel) => existsSync(path.join(target, rel));

// package.json の検証（不正なら他のファイルを書く前に止める）
const pkgPath = path.join(target, "package.json");
let pkg = null;
if (has("package.json")) {
  try {
    pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
  } catch {
    abort(
      `package.json を読めません（JSON として不正）: ${pkgPath}\n直してから再実行してください。`,
    );
  }
  if (typeof pkg !== "object" || pkg === null || Array.isArray(pkg)) {
    abort(
      `package.json を読めません（中身が JSON のオブジェクトではない）: ${pkgPath}\n直してから再実行してください。`,
    );
  }
}

/** 無ければ作る。あればスキップに記録する */
function writeIfMissing(rel, content) {
  if (has(rel)) {
    skipped.push(`${rel}（すでにある）`);
    return false;
  }
  created.push(rel);
  if (!dryRun) {
    const dest = path.join(target, rel);
    mkdirSync(path.dirname(dest), { recursive: true });
    writeFileSync(dest, content);
  }
  return true;
}

const tpl = (name) => readFileSync(path.join(templates, name), "utf8");

// 1. パッケージマネージャの判定
let pm = "pnpm";
if (has("pnpm-lock.yaml")) pm = "pnpm";
else if (has("package-lock.json")) pm = "npm";
else if (has("yarn.lock") || has("bun.lock") || has("bun.lockb")) pm = "other";
if (pm === "other") {
  notes.push(
    "yarn・bun のプロジェクトです。パッケージマネージャは変えず、CI と lint の設定は作りません（手で整えてください）",
  );
}

// 2. flake.nix
const packages = pm === "pnpm" ? "nodejs pnpm" : "nodejs";
if (
  !writeIfMissing(
    "flake.nix",
    tpl("flake.nix").replace("__NAME__", path.basename(target)).replace("__PACKAGES__", packages),
  )
) {
  notes.push(
    "flake.nix はすでにあるので触っていません。nodejs（pnpm を使うなら pnpm も）が無ければ手で追記してください",
  );
}

// 3. .envrc と .gitignore
writeIfMissing(".envrc", tpl("envrc"));
const ignorePath = path.join(target, ".gitignore");
const ignoreLines = has(".gitignore") ? readFileSync(ignorePath, "utf8").split("\n") : [];
// node_modules・/node_modules・node_modules/・/node_modules/ は同じものとみなす
const normalizeIgnore = (l) => l.trim().replace(/^\//, "").replace(/\/$/, "");
const ignored = new Set(ignoreLines.map(normalizeIgnore));
const missingIgnore = [".direnv/", "node_modules/"].filter((l) => !ignored.has(normalizeIgnore(l)));
if (missingIgnore.length > 0) {
  created.push(`.gitignore（${missingIgnore.join("・")} を追記）`);
  if (!dryRun) {
    const base = has(".gitignore") ? readFileSync(ignorePath, "utf8") : "";
    const sep = base === "" || base.endsWith("\n") ? "" : "\n";
    writeFileSync(ignorePath, `${base}${sep}${missingIgnore.join("\n")}\n`);
  }
}

// 4・5. 既存の linter の確認、biome.json、package.json
const otherLinterFile = readdirSync(target).find((f) =>
  /^(\.eslintrc(\..+)?|eslint\.config\..+|\.prettierrc(\..+)?|prettier\.config\..+)$/.test(f),
);
const deps = { ...(pkg?.dependencies ?? {}), ...(pkg?.devDependencies ?? {}) };
const otherLinterDep = ["eslint", "prettier"].find((d) => d in deps);
const otherLinter = otherLinterFile ?? otherLinterDep;
const wantLint = pm !== "other" && !otherLinter;
if (otherLinter) {
  notes.push(
    `既存の linter（${otherLinter}）があるので、biome.json と lint スクリプトは作りません。ESLint・Prettier から Biome への移行は提案に留めてください`,
  );
}
if (wantLint) writeIfMissing("biome.json", tpl("biome.json.template"));

const lintScripts = wantLint ? { lint: "biome check .", format: "biome format --write ." } : {};
const existingScripts =
  pkg && typeof pkg.scripts === "object" && pkg.scripts !== null ? pkg.scripts : {};
// 処理後の package.json に lint スクリプトがあるか（dry-run でも同じ判定にする）
const hasLintScript = "lint" in existingScripts || "lint" in lintScripts;
if (!pkg) {
  created.push("package.json");
  if (!dryRun) {
    const fresh = {
      name: path.basename(target),
      private: true,
      type: "module",
      scripts: lintScripts,
    };
    writeFileSync(pkgPath, `${JSON.stringify(fresh, null, 2)}\n`);
  }
} else {
  const add = Object.keys(lintScripts).filter((k) => !(k in existingScripts));
  if (add.length > 0) {
    created.push(`package.json（scripts に ${add.join("・")} を追記）`);
    if (!dryRun) {
      const scripts = { ...existingScripts };
      for (const k of add) scripts[k] = lintScripts[k];
      pkg.scripts = scripts;
      writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`);
    }
  } else {
    skipped.push("package.json（足すものなし）");
  }
}

// 6. ci.yml
/** CI の push 先ブランチを決める。現在のブランチ（作業ブランチのことがある）は使わない */
function defaultBranch() {
  const origin = git(["symbolic-ref", "--short", "refs/remotes/origin/HEAD"]).replace(
    /^origin\//,
    "",
  );
  if (origin) return { branch: origin, reason: "origin/HEAD から", sure: true };
  for (const b of ["main", "master"]) {
    if (git(["rev-parse", "--verify", "--quiet", `refs/heads/${b}`])) {
      return {
        branch: b,
        reason: `origin/HEAD が無いため、ローカルの ${b} ブランチから`,
        sure: false,
      };
    }
  }
  const init = git(["config", "init.defaultBranch"]);
  if (init) {
    return {
      branch: init,
      reason:
        "origin/HEAD もローカルの main・master も無いため、git config init.defaultBranch から",
      sure: false,
    };
  }
  return { branch: "main", reason: "決める手がかりが無いため、既定の main", sure: false };
}

const workflowsDir = path.join(target, ".github", "workflows");
const otherCi = existsSync(workflowsDir)
  ? readdirSync(workflowsDir).filter(
      (f) =>
        /\.ya?ml$/.test(f) && !/^(delete-merged-branch|dependabot-review-request)\.ya?ml$/.test(f),
    )
  : [];
let ciBranch = null;
if (pm === "other") {
  skipped.push(".github/workflows/ci.yml（yarn・bun のため）");
} else if (otherCi.length > 0 && !otherCi.includes("ci.yml")) {
  skipped.push(`.github/workflows/ci.yml（すでに他の CI がある: ${otherCi.join("・")}）`);
} else {
  const chosen = defaultBranch();
  const install = pm === "pnpm" ? "pnpm install --frozen-lockfile" : "npm ci";
  let ci = tpl("ci.yml")
    .replaceAll("__BRANCH__", chosen.branch)
    .replaceAll("__INSTALL__", install)
    .replaceAll("__PM__", pm);
  if (!hasLintScript) {
    // lint スクリプトが無いと CI が初回から「Missing script: lint」で落ちるのでコメントにする
    ci = ci.replace(
      `- run: nix develop -c ${pm} run lint`,
      `# - run: nix develop -c ${pm} run lint`,
    );
  }
  if (writeIfMissing(".github/workflows/ci.yml", ci)) {
    ciBranch = chosen;
    if (!chosen.sure) {
      notes.push(
        `ci.yml の push 先ブランチを ${chosen.branch} にしました（${chosen.reason}）。GitHub の既定ブランチが ${chosen.branch} と違えば、.github/workflows/ci.yml の branches: [${chosen.branch}] を既定ブランチの名前に直してください`,
      );
    }
    if (!hasLintScript) {
      notes.push(
        `package.json に lint スクリプトが無いので、ci.yml の lint の行（# - run: nix develop -c ${pm} run lint）はコメントにしました。lint スクリプトを用意したら、その行の先頭の「# 」を消して有効にしてください`,
      );
    }
  }
}

// 7〜9. Dependabot とワークフロー
const renovateFiles = [
  "renovate.json",
  "renovate.json5",
  ".renovaterc",
  ".renovaterc.json",
  ".renovaterc.json5",
  ".github/renovate.json",
  ".github/renovate.json5",
  ".gitlab/renovate.json",
  ".gitlab/renovate.json5",
].filter(has);
const renovate = [
  ...renovateFiles,
  ...(pkg && "renovate" in pkg ? ["package.json の renovate キー"] : []),
];
if (renovate.length > 0) {
  skipped.push(`.github/dependabot.yml（Renovate の設定がある: ${renovate.join("・")}）`);
  notes.push(
    `Renovate を使っている（${renovate.join("・")}）ので、dependabot.yml は作りません（Dependabot と併用すると同じ更新の PR が重複するため）。Dependabot へ移すかは提案に留めてください`,
  );
} else {
  writeIfMissing(".github/dependabot.yml", tpl("dependabot.yml"));
}
writeIfMissing(".github/workflows/delete-merged-branch.yml", tpl("delete-merged-branch.yml"));
if (renovate.length > 0) {
  // Dependabot の PR は来ないので、レビュー依頼のワークフローも作らない
  skipped.push(".github/workflows/dependabot-review-request.yml（Renovate を使っているため）");
} else if (reviewer) {
  writeIfMissing(
    ".github/workflows/dependabot-review-request.yml",
    tpl("dependabot-review-request.yml").replace("__REVIEWER__", reviewer),
  );
} else {
  skipped.push(".github/workflows/dependabot-review-request.yml（--reviewer が無いため）");
  notes.push(
    "dependabot-review-request.yml は作っていません。`gh api user --jq .login` の値を --reviewer で渡して再実行してください",
  );
}

// 10. 結果
console.log(`対象: ${target}${dryRun ? " （dry-run: 何も書いていません）" : ""}`);
console.log(`パッケージマネージャ: ${pm === "other" ? "yarn・bun など（変更しない）" : pm}`);
if (ciBranch) console.log(`CI の push 先ブランチ: ${ciBranch.branch}（${ciBranch.reason}）`);
for (const f of created) console.log(`作成: ${f}`);
for (const f of skipped) console.log(`スキップ: ${f}`);
for (const n of notes) console.log(`注意: ${n}`);
const add = pm === "npm" ? "npm install -D --save-exact" : "pnpm add -D --save-exact";
const lintStep = hasLintScript
  ? `nix develop -c ${pm === "other" ? "<pm>" : pm} run lint が通るまでコードを直す（ルールの無効化・除外で通さない）`
  : "package.json に lint スクリプトが無いので、この手順は飛ばす（既存の検証コマンドがあれば、それが通ることを確かめる）";
console.log(`
次にやること:
1. git add flake.nix .envrc → nix flake lock → git add flake.lock → nix develop -c node --version
2. nix develop -c ${add} @biomejs/biome（Biome を使う場合）
3. ${lintStep}
4. .envrc の内容を確認してから direnv allow
5. プロジェクトの AGENTS.md に検証コマンドを書く
6. nix run nixpkgs#actionlint で .github/workflows を確認する`);
