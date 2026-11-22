/**
 * ガードの判定（決定 005）。
 * - allow: 通す
 * - block: 黙って拒否する。理由はモデルに返る
 * - merge: PR のマージ。ユーザーの依頼があるときだけ確認ダイアログを出す（決定 003）
 *
 * 移植元にあった「ask（確認ダイアログ）」は無く、該当する操作はすべて block にしている
 */
export type Verdict =
  | { kind: "allow" }
  | { kind: "block"; reason: string }
  | { kind: "merge"; reason: string };

export const ALLOW: Verdict = { kind: "allow" };

/** ユーザーが自分で実行すれば済む操作の拒否理由に付ける案内 */
export const HANDOFF =
  "必要ならユーザーに `!<コマンド>` で自分で実行してもらうよう伝えてください。";

export const block = (reason: string): Verdict => ({ kind: "block", reason });
/** 拒否し、理由の末尾に「ユーザーが `!` で実行する」案内を付ける */
export const blockWithHandoff = (reason: string): Verdict => block(`${reason}${HANDOFF}`);
export const mergeGate = (reason: string): Verdict => ({ kind: "merge", reason });

/** block が最優先、次に merge。merge が複数ある場合は理由をまとめる */
export function combine(verdicts: Verdict[]): Verdict {
  const blocked = verdicts.find((v) => v.kind === "block");
  if (blocked) return blocked;
  const merges = verdicts.filter(
    (v): v is Extract<Verdict, { kind: "merge" }> => v.kind === "merge",
  );
  if (merges.length > 0) return mergeGate(merges.map((m) => m.reason).join("\n"));
  return ALLOW;
}
