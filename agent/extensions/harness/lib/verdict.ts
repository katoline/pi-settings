/**
 * ガードの判定（決定 005）。
 * - allow: 通す
 * - block: 黙って拒否する。理由はモデルに返る
 *
 * 移植元にあった「ask（確認ダイアログ）」は無く、該当する操作はすべて block にしている。
 * PR のマージも、bash からは常に block（専用ツール `harness_pr_merge` へ誘導する。決定 003）
 */
export type Verdict = { kind: "allow" } | { kind: "block"; reason: string };

export const ALLOW: Verdict = { kind: "allow" };

/** ユーザーが自分で実行すれば済む操作の拒否理由に付ける案内 */
export const HANDOFF =
  "必要ならユーザーに `!<コマンド>` で自分で実行してもらうよう伝えてください。";

export const block = (reason: string): Verdict => ({ kind: "block", reason });
/** 拒否し、理由の末尾に「ユーザーが `!` で実行する」案内を付ける */
export const blockWithHandoff = (reason: string): Verdict => block(`${reason}${HANDOFF}`);

/** 最初の block を返す。無ければ allow */
export function combine(verdicts: Verdict[]): Verdict {
  return verdicts.find((v) => v.kind === "block") ?? ALLOW;
}
