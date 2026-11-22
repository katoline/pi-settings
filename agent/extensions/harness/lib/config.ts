import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

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
}

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
  const agentDir = env.PI_CODING_AGENT_DIR || path.join(home, ".pi", "agent");
  const file = overridePath ?? path.join(agentDir, "harness.json");
  if (existsSync(file)) {
    try {
      const override: unknown = JSON.parse(readFileSync(file, "utf8"));
      if (override && typeof override === "object") {
        for (const key of KEYS) {
          const v = (override as Record<string, unknown>)[key];
          if (isStringArray(v)) merged[key] = v;
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
