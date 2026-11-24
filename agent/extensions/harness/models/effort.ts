/** pi の思考レベル(= エフォート)。弱い順 */
export const EFFORT_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type EffortLevel = (typeof EFFORT_LEVELS)[number];

const isEffortLevel = (text: string): text is EffortLevel =>
  (EFFORT_LEVELS as readonly string[]).includes(text);

export type EffortParse = { ok: true; level: EffortLevel } | { ok: false; message: string };

/**
 * `/effort <level>` の引数を、モデルが対応するレベルの中から選ぶ。
 * 大文字小文字は区別しない。対応しないレベルは、近い値に丸めず、断る(pi の `setThinkingLevel` は黙って丸めるため)。
 */
export function parseEffort(arg: string, supported: readonly string[]): EffortParse {
  const text = arg.trim().toLowerCase();
  if (!isEffortLevel(text)) {
    return {
      ok: false,
      message: `${arg.trim()} は不明なエフォートです(${EFFORT_LEVELS.join(" / ")})。`,
    };
  }
  if (!supported.includes(text)) {
    return {
      ok: false,
      message: `このモデルは ${text} に対応していません(対応: ${supported.join(" / ")})。`,
    };
  }
  return { ok: true, level: text };
}

/** 選択肢の並びを、弱い順にそろえる(pi-ai が返す順に依らない) */
export function sortEfforts(levels: readonly string[]): EffortLevel[] {
  return EFFORT_LEVELS.filter((l) => levels.includes(l));
}
