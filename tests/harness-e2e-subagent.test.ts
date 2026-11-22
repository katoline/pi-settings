/**
 * 統合テスト: 実際の Pi(node_modules の 1.5.2)を RPC モードで起動し、偽のモデル
 * (OpenAI 互換のローカルサーバー)につないで、ハーネスを通しで確かめる。
 *
 * 場面 2（フェーズ 3）: subagent ツールが、独立した `pi` の子プロセスを起動し、子にはハーネスの拡張だけが
 *         読み込まれ、子は読み取り専用のツールだけを持ち、報告が親に返ること。
 * 場面 2b: 書き込み可の役割（worker）が成功すると、親の最終応答に完了の合図が付くこと。
 * ネットワークは使わない。
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { FINAL_LINE } from "../agent/extensions/harness/output/final-line.ts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const piCli = path.join(root, "node_modules/@earendil-works/pi-coding-agent/dist/cli.js");
const extension = path.join(root, "agent/extensions/harness/index.ts");

type Step = { text: string } | { tool: string; args: unknown };
interface Seen {
  messages: string;
  tools: string[];
}

function sse(res: http.ServerResponse, step: Step, n: number) {
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
  const send = (obj: unknown) => res.write(`data: ${JSON.stringify(obj)}\n\n`);
  const base = {
    id: `chatcmpl-${n}`,
    object: "chat.completion.chunk",
    created: 1,
    model: "mock-1",
  };
  if ("text" in step) {
    send({
      ...base,
      choices: [{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null }],
    });
    send({ ...base, choices: [{ index: 0, delta: { content: step.text }, finish_reason: null }] });
    send({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] });
  } else {
    send({
      ...base,
      choices: [
        {
          index: 0,
          delta: {
            role: "assistant",
            tool_calls: [
              {
                index: 0,
                id: `call_${n}`,
                type: "function",
                function: { name: step.tool, arguments: "" },
              },
            ],
          },
          finish_reason: null,
        },
      ],
    });
    send({
      ...base,
      choices: [
        {
          index: 0,
          delta: { tool_calls: [{ index: 0, function: { arguments: JSON.stringify(step.args) } }] },
          finish_reason: null,
        },
      ],
    });
    send({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] });
  }
  send({
    ...base,
    choices: [],
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
  });
  res.write("data: [DONE]\n\n");
  res.end();
}

const tmpRoot = mkdtempSync(path.join(os.tmpdir(), "harness-e2e-"));
after(() => rmSync(tmpRoot, { recursive: true, force: true }));

interface Outcome {
  requests: Seen[];
  toolResults: { name: string; text: string; isError: boolean }[];
  assistantTexts: string[];
  uiTitles: string[];
}

/** 台本どおりに応答する偽のモデルと、実際の Pi を起動し、台本が尽きたら終了する */
async function scenario(name: string, steps: Step[], prompt: string): Promise<Outcome> {
  return await scenarioIn(name, steps, prompt).then((r) => r.outcome);
}

/** scenario の本体。作業ディレクトリも返す */
async function scenarioIn(
  name: string,
  steps: Step[],
  prompt: string,
): Promise<{ outcome: Outcome; cwd: string }> {
  const requests: Seen[] = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => {
      body += c;
    });
    req.on("end", () => {
      const parsed = JSON.parse(body || "{}") as {
        messages?: unknown;
        tools?: { function?: { name?: string } }[];
      };
      const n = requests.length;
      requests.push({
        messages: JSON.stringify(parsed.messages ?? []),
        tools: (parsed.tools ?? []).map((t) => t.function?.name ?? ""),
      });
      sse(res, steps[n] ?? { text: "(終了)" }, n);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;

  const base = path.join(tmpRoot, name);
  const agentDir = path.join(base, "agent");
  const cwd = path.join(base, "work");
  mkdirSync(agentDir, { recursive: true });
  mkdirSync(cwd, { recursive: true });
  writeFileSync(
    path.join(agentDir, "models.json"),
    JSON.stringify({
      providers: {
        mock: {
          baseUrl: `http://127.0.0.1:${port}/v1`,
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
  // 役割の定義は、エージェントディレクトリの agents/ から読まれる（リポジトリの agent/agents/ をコピー）
  cpSync(path.join(root, "agent/agents"), path.join(agentDir, "agents"), { recursive: true });

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
      "--no-mcp",
      "--no-extensions",
      "-e",
      extension,
      "--model",
      "mock/mock-1",
    ],
    {
      cwd,
      env: {
        ...process.env,
        PI_CODING_AGENT_DIR: agentDir,
        PI_OFFLINE: "1",
        PI_TELEMETRY: "0",
        PI_SUBAGENT_MODEL: "mock/mock-1",
      },
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  let stderr = "";
  proc.stderr.on("data", (d) => {
    stderr += d;
  });

  const outcome: Outcome = { requests, toolResults: [], assistantTexts: [], uiTitles: [] };
  const eventLog: string[] = [];
  let settled = false;
  let buffer = "";

  const done = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(
      () =>
        reject(
          new Error(
            `時間切れ(${name})\nstderr: ${stderr}\nrequests: ${requests.length}\nevents: ${eventLog.slice(-30).join(" ")}\ntools: ${JSON.stringify(outcome.toolResults).slice(0, 1500)}`,
          ),
        ),
      100_000,
    );
    proc.stdout.on("data", (data: Buffer) => {
      buffer += data.toString();
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.trim()) continue;
        let ev: Record<string, unknown>;
        try {
          ev = JSON.parse(line);
        } catch {
          continue;
        }
        eventLog.push(
          `${String(ev.type)}${ev.toolName ? `:${String(ev.toolName)}` : ""}${ev.method ? `:${String(ev.method)}` : ""}`,
        );
        if (ev.type === "extension_ui_request") {
          const id = String(ev.id);
          const method = String(ev.method);
          if (method === "select" || method === "confirm" || method === "input") {
            outcome.uiTitles.push(String(ev.title ?? ""));
            proc.stdin.write(
              `${JSON.stringify({ type: "extension_ui_response", id, cancelled: true })}\n`,
            );
          }
        }
        if (ev.type === "tool_execution_end") {
          const result = ev.result as { content?: { type: string; text?: string }[] } | undefined;
          outcome.toolResults.push({
            name: String(ev.toolName),
            text: (result?.content ?? []).map((c) => c.text ?? "").join("\n"),
            isError: Boolean(ev.isError),
          });
        }
        if (ev.type === "message_end") {
          const m = ev.message as
            | { role?: string; content?: { type: string; text?: string }[] }
            | undefined;
          if (m?.role === "assistant") {
            outcome.assistantTexts.push(
              (m.content ?? [])
                .filter((c) => c.type === "text")
                .map((c) => c.text ?? "")
                .join("\n"),
            );
          }
        }
        if (ev.type === "agent_settled" && requests.length >= steps.length) {
          settled = true;
          clearTimeout(timer);
          resolve();
        }
      }
    });
    proc.on("exit", (code) => {
      if (!settled) reject(new Error(`Pi が終了しました(${code}, ${name})\nstderr: ${stderr}`));
    });
  });

  proc.stdin.write(`${JSON.stringify({ type: "prompt", message: prompt })}\n`);
  try {
    await done;
  } finally {
    proc.kill("SIGTERM");
    server.close();
  }
  return { outcome, cwd };
}

const resultsOf = (o: Outcome, name: string) => o.toolResults.filter((r) => r.name === name);

test("実際の Pi で、subagent が独立した子プロセスを起動し、報告が親に返る", {
  timeout: 120_000,
}, async () => {
  const steps: Step[] = [
    {
      tool: "subagent",
      args: {
        tasks: [
          { agent: "scout", title: "README の調査", task: "README.md を読んで、要約してください" },
        ],
      },
    }, // 0: 親
    { text: "README の要約: 設定リポジトリです" }, // 1: 子(scout)の応答
    { text: "子の報告を受け取りました" }, // 2: 親の最終応答
  ];
  const o = await scenario("subagent", steps, "調査を任せてください");
  const { requests } = o;

  // 親: subagent ツールを持つ
  assert.ok(requests[0]?.tools.includes("subagent"));

  // 子: 読み取り専用のツールだけ。subagent も、計画・PR のツールもない(再帰の防止、サブエージェントでは登録しない)
  const child = requests[1];
  assert.ok(child, "子のリクエストがあるはず");
  assert.deepEqual([...child.tools].sort(), ["find", "grep", "ls", "read"]);
  // 子には、サブエージェント用の固定の指示と、役割の指示が渡る
  assert.ok(
    child.messages.includes("メインエージェントから任された作業だけを行うサブエージェントです"),
  );
  assert.ok(child.messages.includes("あなたは、読み取り専用の調査担当です"));
  // 依頼の本文が渡る
  assert.ok(child.messages.includes("README.md を読んで、要約してください"));

  // 親: 子の報告が、ツールの結果として返る(完了の表示つき)
  const result = resultsOf(o, "subagent")[0];
  assert.ok(result, "subagent の結果があるはず");
  assert.equal(result.isError, false);
  assert.match(result.text, /1\/1 件が完了/);
  assert.match(result.text, /README の要約: 設定リポジトリです/);
  assert.match(result.text, /✅ README の調査が完了/);
  assert.ok(
    requests[2]?.messages.includes("README の要約: 設定リポジトリです"),
    "親のモデルに、子の報告が渡る",
  );
  // 読み取り専用の役割だけでは、成果物ができていないので、完了の合図は付かない
  assert.ok(!(o.assistantTexts.at(-1) ?? "").includes(FINAL_LINE));
});

test("実際の Pi で、書き込み可の worker が成功すると、親の最終応答に完了の合図が付く", {
  timeout: 120_000,
}, async () => {
  const steps: Step[] = [
    {
      tool: "subagent",
      args: {
        tasks: [{ agent: "worker", title: "メモの作成", task: "memo.txt を作ってください" }],
      },
    }, // 0: 親
    { tool: "write", args: { path: "memo.txt", content: "メモ\n" } }, // 1: 子(worker)が書き込む
    { text: "memo.txt を作成しました" }, // 2: 子の報告
    { text: "worker の報告を確認しました" }, // 3: 親の最終応答
  ];
  const { outcome: o, cwd } = await scenarioIn("subagent-worker", steps, "実装を任せてください");
  const { requests } = o;

  // 子(worker)は書き込みのツールを持つ（tools 未指定 = 既定のツール）。subagent は持たない
  const child = requests[1];
  assert.ok(child, "子のリクエストがあるはず");
  assert.ok(child.tools.includes("write") && child.tools.includes("edit"));
  assert.ok(!child.tools.includes("subagent"));
  // 子は親と同じ作業ディレクトリで動く
  assert.equal(readFileSync(path.join(cwd, "memo.txt"), "utf8"), "メモ\n");

  const result = resultsOf(o, "subagent")[0];
  assert.match(result?.text ?? "", /1\/1 件が完了/);
  assert.match(result?.text ?? "", /memo\.txt を作成しました/);

  // 親は write・edit を直接呼んでいないが、subagent の書き込み可の成功で、完了の合図が付く
  const last = o.assistantTexts.filter((t) => t.trim()).at(-1) ?? "";
  assert.ok(last.startsWith("worker の報告を確認しました"));
  assert.equal(last.trimEnd().split("\n").at(-1), FINAL_LINE);
  // ツール呼び出しの途中のメッセージには付かない
  assert.ok(!(o.assistantTexts[0] ?? "").includes(FINAL_LINE));
});
