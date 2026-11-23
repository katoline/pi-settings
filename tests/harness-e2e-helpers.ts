/**
 * e2e の共通部品: 実際の Pi(node_modules の 1.5.2)を RPC モードで起動し、偽のモデル
 * (OpenAI 互換のローカルサーバー)につなぐ。台本(steps)の順にモデルが応答し、台本が尽きたら終了する。
 * ネットワークは使わない。
 */
import { spawn } from "node:child_process";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { after } from "node:test";
import { fileURLToPath } from "node:url";

export const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const piCli = path.join(root, "node_modules/@earendil-works/pi-coding-agent/dist/cli.js");
const extension = path.join(root, "agent/extensions/harness/index.ts");

export type Step = { text: string } | { tool: string; args: unknown };

/** モデルに届いたリクエスト 1 件 */
export interface Seen {
  /** 会話の全メッセージ(JSON 文字列。システムプロンプトを含む) */
  messages: string;
  /** システム(developer)メッセージだけ */
  system: string;
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

export interface Outcome {
  requests: Seen[];
  toolResults: { name: string; text: string; isError: boolean }[];
  assistantTexts: string[];
  /** UI の問い合わせ(select・confirm・input)の題名 */
  uiTitles: string[];
  /** 通知(notify)の本文 */
  notifications: string[];
}

export interface ScenarioOptions {
  /** 依頼(プロンプト)。前の依頼が終わるごとに、次を送る */
  prompts?: string[];
  /** 作業ディレクトリとエージェントディレクトリを、起動前に整える */
  prepare?: (dirs: { cwd: string; agentDir: string }) => void;
  /** UI の問い合わせへの応答。値を返すと選択・入力し、null ならキャンセルする(既定はキャンセル) */
  answer?: (title: string, method: string) => string | null;
}

/** 台本どおりに応答する偽のモデルと、実際の Pi を起動し、台本が尽きて最後の依頼が終わったら終了する */
export async function scenarioIn(
  name: string,
  steps: Step[],
  prompt: string,
  options: ScenarioOptions = {},
): Promise<{ outcome: Outcome; cwd: string; agentDir: string }> {
  const prompts = options.prompts ?? [prompt];
  const requests: Seen[] = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => {
      body += c;
    });
    req.on("end", () => {
      const parsed = JSON.parse(body || "{}") as {
        messages?: { role?: string }[];
        tools?: { function?: { name?: string } }[];
      };
      const n = requests.length;
      const messages = parsed.messages ?? [];
      requests.push({
        messages: JSON.stringify(messages),
        system: JSON.stringify(
          messages.filter((m) => m.role === "system" || m.role === "developer"),
        ),
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
  // 役割の定義は、エージェントディレクトリの agents/ から読まれる（リポジトリの agent/agents/ をコピー）。
  // 役割ごとの model（reviewer の Opus など）は、偽のモデルしか無いこの環境では使えないので外し、
  // 子も偽のモデル（下の環境変数 PI_SUBAGENT_MODEL）で動かす
  const agentsDir = path.join(agentDir, "agents");
  cpSync(path.join(root, "agent/agents"), agentsDir, { recursive: true });
  for (const f of readdirSync(agentsDir).filter((n) => n.endsWith(".md"))) {
    const file = path.join(agentsDir, f);
    writeFileSync(file, readFileSync(file, "utf8").replace(/^model:.*\n/m, ""));
  }
  options.prepare?.({ cwd, agentDir });

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

  const outcome: Outcome = {
    requests,
    toolResults: [],
    assistantTexts: [],
    uiTitles: [],
    notifications: [],
  };
  const eventLog: string[] = [];
  let settled = false;
  let settledCount = 0;
  let buffer = "";
  const sendPrompt = (message: string) =>
    proc.stdin.write(`${JSON.stringify({ type: "prompt", message })}\n`);

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
          if (method === "notify") outcome.notifications.push(String(ev.message ?? ""));
          if (method === "select" || method === "confirm" || method === "input") {
            const title = String(ev.title ?? "");
            outcome.uiTitles.push(title);
            const value = options.answer?.(title, method) ?? null;
            const reply =
              value === null
                ? { type: "extension_ui_response", id, cancelled: true }
                : { type: "extension_ui_response", id, value };
            proc.stdin.write(`${JSON.stringify(reply)}\n`);
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
        if (ev.type === "agent_settled") {
          settledCount++;
          const next = prompts[settledCount];
          if (next !== undefined) {
            sendPrompt(next);
          } else if (requests.length >= steps.length) {
            settled = true;
            clearTimeout(timer);
            resolve();
          }
        }
      }
    });
    proc.on("exit", (code) => {
      if (!settled) reject(new Error(`Pi が終了しました(${code}, ${name})\nstderr: ${stderr}`));
    });
  });

  sendPrompt(prompts[0] ?? prompt);
  try {
    await done;
  } finally {
    proc.kill("SIGTERM");
    server.close();
  }
  return { outcome, cwd, agentDir };
}

export const scenario = async (
  name: string,
  steps: Step[],
  prompt: string,
  options: ScenarioOptions = {},
): Promise<Outcome> => (await scenarioIn(name, steps, prompt, options)).outcome;

export const resultsOf = (o: Outcome, name: string) => o.toolResults.filter((r) => r.name === name);
