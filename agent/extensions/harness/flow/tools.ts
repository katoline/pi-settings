import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { Runtime } from "../lib/runtime.ts";
import { isAutonomous } from "./plan.ts";

export const ASK_USER = "ask_user";
export const PR_MERGE = "harness_pr_merge";

/**
 * ハーネスが出し入れするツールを、状態に合わせて 1 か所で決める。
 *
 * - `ask_user`: 計画を確定して自律で進めている間は外す。完了後・一時停止中・計画なしでは出す
 * - `harness_pr_merge`: ユーザーの直近の入力がマージを依頼しているときだけ出す
 *
 * 出し入れを別々の場所で `setActiveTools` すると、一方が相手の変更を上書きして消してしまう。
 * そのため、今のツール一覧から「管理対象のうち不要なもの」を外し、「必要で無いもの」を足す形で、
 * ここだけが組み立てる。管理対象以外のツールはそのまま残す。サブエージェントでは何もしない。
 */
export function syncActiveTools(pi: ExtensionAPI, rt: Runtime): void {
  if (rt.isSubagent) return;
  const wanted = new Map<string, boolean>([
    [ASK_USER, !isAutonomous(rt.plan)],
    [PR_MERGE, rt.mergeRequested],
  ]);
  const active = pi.getActiveTools();
  const next = active.filter((name) => wanted.get(name) !== false);
  for (const [name, want] of wanted) if (want && !next.includes(name)) next.push(name);
  if (next.length !== active.length || next.some((name, i) => name !== active[i])) {
    pi.setActiveTools(next);
  }
}
