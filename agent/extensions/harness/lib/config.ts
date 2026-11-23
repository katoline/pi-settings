import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseRef } from "../models/catalog.ts";

export interface HarnessConfig {
  /** 削除・書き込みを許す作業ルート */
  workRoots: string[];
  /** 一時領域（`$TMPDIR` と、glob を含むパターン） */
  tempRoots: string[];
  /** 開発中に変更させないグローバル環境（cwd がその中にあるときだけ許す） */
  protectedGlobalPaths: string[];
  /** ハーネス自身と認証情報（cwd がその中にあるときだけ、設定の編集を許す） */
  protectedHarnessPaths: string[];
  /** 既定ブランチとして扱うブランチ名（origin/HEAD の指す先も加える） */
  defaultBranches: string[];
  /** 起動時にメインのモデルを選ぶダイアログを出す（既定 false。`/models` で選ぶ） */
  selectModelOnStartup: boolean;
  /** 要約（compaction）に使うモデル（`provider/id`）。空なら今のモデル */
  compactionModel: string;
  subagent: SubagentLimits;
  flow: FlowLimits;
}

/** 計画・自律ループの上限 */
export interface FlowLimits {
  /** 項目ごとの、差し戻し（検証の失敗・レビューの却下）の上限（周） */
  maxCyclesPerItem: number;
  /** 自動の継続の上限（回） */
  maxContinuations: number;
  /** 計画を始めてからの時間の上限（分） */
  maxMinutes: number;
  /** 進捗がないまま続けてよい回数 */
  maxNoProgress: number;
}

export interface SubagentLimits {
  /** 1 回の呼び出しで任せられる件数 */
  maxTasks: number;
  /** 読み取り専用の役割を同時に動かす数 */
  maxConcurrency: number;
  /** 1 件あたりの時間切れ（秒） */
  timeoutSeconds: number;
  /** このセッションで起動できる合計 */
  maxTotal: number;
}

const SUBAGENT_KEYS = ["maxTasks", "maxConcurrency", "timeoutSeconds", "maxTotal"] as const;

const FLOW_KEYS = ["maxCyclesPerItem", "maxContinuations", "maxMinutes", "maxNoProgress"] as const;

const KEYS = [
  "workRoots",
  "tempRoots",
  "protectedGlobalPaths",
  "protectedHarnessPaths",
  "defaultBranches",
] as const;

const here = path.dirname(fileURLToPath(import.meta.url));

function expandHome(p: string, home: string): string {
  if (p === "~") return home;
  if (p.startsWith("~/")) return path.join(home, p.slice(2));
  return p;
}

const isPositiveInt = (v: unknown): v is number =>
  typeof v === "number" && Number.isInteger(v) && v > 0;

/** pi のエージェントディレクトリ（`PI_CODING_AGENT_DIR`、既定は ~/.pi/agent） */
export function resolveAgentDir(home: string, env: NodeJS.ProcessEnv): string {
  return env.PI_CODING_AGENT_DIR || path.join(home, ".pi", "agent");
}

const isStringArray = (v: unknown): v is string[] =>
  Array.isArray(v) && v.every((x) => typeof x === "string");

/**
 * 既定の設定に、`<Pi の設定ディレクトリ>/harness.json`（既定 ~/.pi/agent/harness.json）の上書きを重ねる。
 * 壊れた上書き（JSON として読めない、型が違うキー）は無視して既定を使う
 */
export function loadConfig(
  home: string = homedir(),
  overridePath?: string,
  env: NodeJS.ProcessEnv = process.env,
): HarnessConfig {
  const merged: HarnessConfig = JSON.parse(
    readFileSync(path.join(here, "..", "config.default.json"), "utf8"),
  );
  // Pi の設定ディレクトリ（`PI_CODING_AGENT_DIR`）に従う。既定は ~/.pi/agent
  const file = overridePath ?? path.join(resolveAgentDir(home, env), "harness.json");
  if (existsSync(file)) {
    try {
      const override: unknown = JSON.parse(readFileSync(file, "utf8"));
      if (override && typeof override === "object") {
        const o = override as Record<string, unknown>;
        for (const key of KEYS) {
          const v = o[key];
          if (isStringArray(v)) merged[key] = v;
        }
        if (typeof o.selectModelOnStartup === "boolean") {
          merged.selectModelOnStartup = o.selectModelOnStartup;
        }
        if (typeof o.compactionModel === "string" && parseRef(o.compactionModel.trim())) {
          merged.compactionModel = o.compactionModel.trim();
        }
        if (o.subagent && typeof o.subagent === "object") {
          const sub = o.subagent as Record<string, unknown>;
          for (const key of SUBAGENT_KEYS) {
            const v = sub[key];
            if (isPositiveInt(v)) merged.subagent[key] = v;
          }
        }
        if (o.flow && typeof o.flow === "object") {
          const flow = o.flow as Record<string, unknown>;
          for (const key of FLOW_KEYS) {
            const v = flow[key];
            if (isPositiveInt(v)) merged.flow[key] = v;
          }
        }
      }
    } catch {
      // 壊れた上書きは使わない
    }
  }
  return {
    ...merged,
    workRoots: merged.workRoots.map((p) => expandHome(p, home)),
    protectedGlobalPaths: merged.protectedGlobalPaths.map((p) => expandHome(p, home)),
    protectedHarnessPaths: merged.protectedHarnessPaths.map((p) => expandHome(p, home)),
  };
}
