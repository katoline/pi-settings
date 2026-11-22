import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

export type InstructionKind = "main" | "subagent";

/** 固定の指示の本文（Markdown）を読む。ファイルは、編集しやすいよう、コードと分けている。読めなければ例外 */
export function loadInstructions(kind: InstructionKind, dir: string = here): string {
  return readFileSync(path.join(dir, `${kind}.md`), "utf8").trim();
}
