import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  checkEnvDump,
  checkSecretsBash,
  checkSecretToolPath,
  isSecretPath,
  redact,
  redactDeep,
} from "../agent/extensions/harness/guards/secrets.ts";
import { invocations, parseShell } from "../agent/extensions/harness/lib/shell.ts";
import { combine, type Verdict } from "../agent/extensions/harness/lib/verdict.ts";
import { FAKE, HOME, input } from "./harness-helpers.ts";

const bash = (cmd: string): Verdict => {
  const parsed = parseShell(cmd);
  return combine([
    checkEnvDump(parsed),
    ...invocations(parsed).map((i) => checkSecretsBash(i, input({}))),
  ]);
};

test("秘密のファイルを判定する(テンプレートは除く)", () => {
  for (const p of [
    ".env",
    ".env.local",
    "app/.env.production",
    "id_rsa",
    "key.pem",
    "a/b/server.key",
    ".npmrc",
    "credentials.json",
    `${HOME}/.ssh/config`,
    `${HOME}/.aws/credentials`,
    `${HOME}/.pi/agent/auth.json`,
    "/proc/1/environ",
    "service-account-prod.json",
  ]) {
    assert.equal(isSecretPath(p), true, p);
  }
  for (const p of [
    ".env.example",
    ".env.sample",
    "id_rsa.pub",
    "src/env.ts",
    "README.md",
    "keyboard.ts",
    ".envrc",
  ]) {
    assert.equal(isSecretPath(p), false, p);
  }
});

test("read / write / edit のパス引数を検査する", () => {
  assert.equal(checkSecretToolPath(".env", input({})).kind, "block");
  assert.equal(checkSecretToolPath("~/.ssh/id_ed25519", input({})).kind, "block");
  assert.equal(checkSecretToolPath(".env.example", input({})).kind, "allow");
  assert.equal(checkSecretToolPath("src/a.ts", input({})).kind, "allow");
});

test("bash から秘密のファイルを読むコマンドを拒否する", () => {
  for (const cmd of [
    "cat .env",
    "head -n 3 .env.local",
    "grep TOKEN .env",
    "cp .env /tmp/x",
    "source .env",
    "base64 ~/.ssh/id_rsa",
    "cat .env*",
    "rg -n KEY --glob '!x' app/.env",
    "git add .env",
    "echo hi > .env",
    "cat /proc/self/environ",
  ]) {
    assert.equal(bash(cmd).kind, "block", cmd);
  }
});

test("環境変数の一覧や、秘密を持つ変数の出力を拒否する", () => {
  for (const cmd of [
    "env",
    "printenv",
    "printenv ANTHROPIC_API_KEY",
    "export -p",
    "declare -p",
    "set",
    'echo "$GITHUB_TOKEN"',
    "printf '%s' $API_KEY",
  ]) {
    assert.equal(bash(cmd).kind, "block", cmd);
  }
});

test("通常のコマンドは許可", () => {
  for (const cmd of [
    "cat README.md",
    "grep -rn foo src",
    "env FOO=1 node a.js",
    "git add .env.example",
    "echo hello",
    "printenv HOME",
    "ls -la",
  ]) {
    assert.equal(bash(cmd).kind, "allow", cmd);
  }
});

test("出力から秘密を秘匿する", () => {
  const samples: [string, string][] = [
    [`key ${FAKE.skAnt} end`, "sk-ant-"],
    [`token ${FAKE.ghp} end`, "ghp_"],
    [FAKE.akia, "AKIA"],
    ["Authorization: Bearer abcdefghijklmnopqrstuvwxyz", "abcdefghijkl"],
    ["jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefghijklmnop", "eyJhbGci"],
    ["postgres://user:hunter2pass@db:5432/x", "hunter2pass"],
    // 形の決まったトークンは、「名前=値」の中にあっても秘匿する
    [`API_KEY=${FAKE.ghp}`, "ghp_"],
    [`{"token": "${FAKE.xoxb}"}`, "xoxb-"],
    [`API_KEY=${FAKE.skAnt}`, "sk-ant-"],
    ["-----BEGIN PRIVATE KEY-----\nMIIabc\n-----END PRIVATE KEY-----", "MIIabc"],
  ];
  for (const [text, secret] of samples) {
    const out = redact(text);
    assert.equal(out.includes(secret), false, `${text} -> ${out}`);
    assert.match(out, /秘匿/);
  }
  assert.equal(redact("普通のログ: 12 files changed"), "普通のログ: 12 files changed");
});

test("ソースコードは秘匿しない（read した内容が化けて edit の oldText が一致しなくなるのを防ぐ）", () => {
  const code = [
    "decodeJwtPayload(token: string)",
    "const tokens = isRecord(stored)",
    "const apiKey = process.env.API_KEY",
    "inputTokens: response.inputTokens",
    "const SECRET_VAR = /\\$\\{?[A-Za-z_]*(KEY|TOKEN|SECRET|PASSWORD)[A-Za-z_]*/i;",
    "const password = getPassword(user)",
    "secret: string",
    "const TOKEN_RE = /^[A-Za-z0-9_-]{20,}$/;",
    "secretKey: Uint8Array = new Uint8Array(32)",
    "password: hashPasswordSha256(input)",
    'tokenUrl: "http://localhost:8080/oauth/token"',
  ].join("\n");
  assert.equal(redact(code), code);
});

test("このリポジトリのソースを読んでも、秘匿で内容が変わらない", () => {
  for (const f of [
    "agent/extensions/usage/index.ts",
    "agent/extensions/harness/guards/secrets.ts",
  ]) {
    const text = readFileSync(new URL(`../${f}`, import.meta.url), "utf8");
    assert.equal(redact(text), text, f);
  }
});

test("git のメッセージ（-m / --message / -F の値）は秘密ファイルのパスとして扱わない", () => {
  for (const cmd of [
    'git commit -m "fix: load cert.pem"',
    'git commit -am "update .env handling"',
    'git commit --message "rotate id_rsa"',
    'git commit --message="rotate id_rsa"',
  ]) {
    assert.equal(bash(cmd).kind, "allow", cmd);
  }
  // パスの引数は従来どおり拒否
  assert.equal(bash("git add cert.pem").kind, "block");
  assert.equal(bash('git commit -m "x" .env').kind, "block");
});

// 方針（ユーザーの決定）: 秘匿するのは形の決まったトークンだけ。「名前=値」からの推測はしない
test("形の決まらない秘密（password=hunter2 など）は、名前=値の形でも秘匿しない", () => {
  for (const text of [
    "password=hunter2",
    'password: "supersecret1234567890"',
    "API_KEY=abcdef1234567890wxyz",
    "token: abcdefghijklmnop1234",
  ]) {
    assert.equal(redact(text), text);
  }
});

test("structuredContent は値を走査して秘匿する（バックスラッシュや引用符があっても壊れない）", () => {
  const original = {
    path: "C:\\dir\\file",
    re: '/^\\d+\\"x"$/',
    nested: [{ out: `token ${FAKE.ghp} \\ end` }, 3, null, true],
  };
  const out = redactDeep(original) as typeof original;
  assert.equal(out.path, original.path);
  assert.equal(out.re, original.re);
  assert.equal((out.nested[0] as { out: string }).out, "token [秘匿] \\ end");
  assert.deepEqual(out.nested.slice(1), [3, null, true]);
  assert.equal(JSON.stringify(redactDeep("plain")), '"plain"');
});

// 3 回目の独立レビューの指摘への回帰テスト
test("URL 内のパスワードは実際の値だけを秘匿し、プレースホルダーは残す", () => {
  for (const text of [
    "postgres://postgres:${POSTGRES_PASSWORD}@db:5432/app",
    "const url = `postgres://${user}:${pass}@${host}/db`;",
    "mongodb+srv://admin:<password>@cluster0.example.net/",
    "redis://user:{pass}@localhost:6379",
  ]) {
    assert.equal(redact(text), text, text);
  }
  assert.equal(
    redact("postgres://app:s3cretValue@db:5432/app"),
    "postgres://app:[秘匿]@db:5432/app",
  );
});

test("OpenAI の sk-proj- / sk-svcacct- / sk-admin- 形式を秘匿する", () => {
  for (const key of [FAKE.skProj, FAKE.skSvcacct, FAKE.skAdmin]) {
    const out = redact(`OPENAI_API_KEY=${key}`);
    assert.ok(!out.includes(key), key);
    assert.ok(out.includes("[秘匿]"), key);
  }
});

test("Bearer は同じ行のトークンだけを秘匿し、次の行は書き換えない", () => {
  const yaml = "token_type: Bearer\n  access_token_lifetime_seconds: 3600";
  assert.equal(redact(yaml), yaml);
  assert.equal(
    redact("Authorization: Bearer abcdefghijklmnop1234"),
    "Authorization: Bearer [秘匿]",
  );
});
