/**
 * 統合テスト（配置）: scripts/install.sh で配置したエージェントディレクトリから、実際の pi（node_modules の 1.5.2）が
 * `-e` なしで拡張を読み込み、コマンドを登録することを RPC（get_commands）で確かめる。
 *
 * ガード・計画・自律ループ・サブエージェント・最終行の通しの確認は harness-e2e-*.test.ts にある。
 *
 * pi は settings.json（リンク先）に defaultProvider などを書くことがあるので、リポジトリの追跡ファイルを
 * 書き換えないよう、agent/ と scripts/ を一時ディレクトリにコピーし、そのコピーの install.sh で配置する
 * （node_modules だけはシンボリックリンクで共有する）。実際の ~/.pi は読まない・書かない（HOME も一時ディレクトリ）。
 * ネットワークは使わない。
 */
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const piCli = path.join(root, "node_modules/@earendil-works/pi-coding-agent/dist/cli.js");

const tmpRoot = mkdtempSync(path.join(os.tmpdir(), "install-e2e-"));
const procs: ReturnType<typeof spawn>[] = [];
after(() => {
  for (const p of procs) p.kill("SIGKILL");
  rmSync(tmpRoot, { recursive: true, force: true });
});

interface Command {
  name: string;
  source: string;
  sourceInfo?: { path?: string };
}

test("install.sh で配置したエージェントディレクトリから、拡張が読み込まれ、コマンドが登録される", {
  timeout: 90_000,
}, async () => {
  // リポジトリの一時コピー（追跡ファイルを書き換えさせない）
  const repo = path.join(tmpRoot, "repo");
  mkdirSync(repo);
  cpSync(path.join(root, "agent"), path.join(repo, "agent"), { recursive: true });
  cpSync(path.join(root, "scripts"), path.join(repo, "scripts"), { recursive: true });
  symlinkSync(path.join(root, "node_modules"), path.join(repo, "node_modules"));

  const home = path.join(tmpRoot, "home");
  const agentDir = path.join(tmpRoot, "agent");
  const cwd = path.join(tmpRoot, "work");
  for (const d of [home, cwd]) mkdirSync(d);
  const env = {
    ...process.env,
    HOME: home,
    PI_CODING_AGENT_DIR: agentDir,
    PI_OFFLINE: "1",
    PI_TELEMETRY: "0",
  };

  const install = spawnSync("bash", [path.join(repo, "scripts/install.sh")], {
    env,
    encoding: "utf8",
  });
  assert.equal(install.status, 0, install.stdout + install.stderr);

  // 接続先のない偽のモデル（プロンプトは送らないので、実際には呼ばれない）。認証・設定も一時ディレクトリに閉じる
  writeFileSync(
    path.join(agentDir, "models.json"),
    JSON.stringify({
      providers: {
        mock: {
          baseUrl: "http://127.0.0.1:9/v1",
          api: "openai-completions",
          apiKey: "dummy",
          models: [{ id: "mock-1", name: "Mock" }],
        },
      },
    }),
  );
  writeFileSync(
    path.join(agentDir, "harness.json"),
    JSON.stringify({ selectModelOnStartup: false }),
  );

  // -e も --no-extensions も付けない: 自動探索（agentDir/extensions）だけで読み込まれる
  const proc = spawn(
    process.execPath,
    [
      piCli,
      "--mode",
      "rpc",
      "--offline",
      "--no-session",
      "--no-skills",
      "--no-prompt-templates",
      "--model",
      "mock/mock-1",
    ],
    { cwd, env, stdio: ["pipe", "pipe", "pipe"] },
  );
  procs.push(proc);
  let stderr = "";
  proc.stderr.on("data", (d) => {
    stderr += d;
  });

  const commands = await new Promise<Command[]>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`時間切れ\nstderr: ${stderr}`)), 60_000);
    let buffer = "";
    proc.stdout.on("data", (data: Buffer) => {
      buffer += data.toString();
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        let ev: {
          type?: string;
          command?: string;
          success?: boolean;
          data?: { commands?: Command[] };
        };
        try {
          ev = JSON.parse(line);
        } catch {
          continue;
        }
        if (ev.type === "response" && ev.command === "get_commands") {
          clearTimeout(timer);
          if (ev.success) resolve(ev.data?.commands ?? []);
          else reject(new Error(`get_commands が失敗しました: ${line}`));
        }
      }
    });
    proc.on("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`pi が終了しました(${code})\nstderr: ${stderr}`));
    });
    proc.stdin.write(`${JSON.stringify({ type: "get_commands" })}\n`);
  });

  const extensionCommands = commands.filter((c) => c.source === "extension");
  const names = extensionCommands.map((c) => c.name);
  for (const name of ["models", "subagent-model", "plan", "usage", "exit"]) {
    assert.ok(names.includes(name), `/${name} が登録されているはず（実際: ${names.join(", ")}）`);
  }
  // 読み込み元は、配置したリンク（agentDir/extensions 経由）であって、-e の指定ではない
  for (const name of ["models", "subagent-model", "plan", "usage", "exit"]) {
    const p = extensionCommands.find((c) => c.name === name)?.sourceInfo?.path ?? "";
    assert.ok(
      p.startsWith(path.join(agentDir, "extensions")) ||
        p.startsWith(path.join(repo, "agent/extensions")),
      `/${name} の読み込み元: ${p}`,
    );
  }
});
