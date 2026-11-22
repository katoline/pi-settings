import { realpathSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import type { Plan } from "../flow/plan.ts";
import { parseRef, SUBAGENT_DEFAULT } from "../models/catalog.ts";
import { type HarnessConfig, loadConfig, resolveAgentDir } from "./config.ts";
import type { FsProbe } from "./types.ts";

/** ハーネス全体で共有する、実行時の事実（このフェーズではガードが使うものだけ） */
export interface Runtime {
  config: HarnessConfig;
  /** サブエージェント（子プロセス）として起動された */
  isSubagent: boolean;
  home: string;
  tmpdir: string;
  /** pi のエージェントディレクトリ（役割の定義 `agents/` はこの下） */
  agentDir: string;
  /** いまのサブエージェントのモデル（`provider/id`。`/subagent-model` で変わる） */
  subagentModel: string;
  /** サブエージェントのモデルの既定（環境変数 `PI_SUBAGENT_MODEL`、無ければ DeepSeek V4.1 Flash） */
  subagentModelDefault: string;
  /** このセッションで起動したサブエージェントの数（上限の判定用） */
  subagentSpawns: number;
  /** サブエージェントの費用の合計（ドル。表示はフェーズ 6） */
  childCost: number;
  /** 確定した（または提案中の）計画。セッションのエントリに保存し、復元する */
  plan: Plan | undefined;
  /** 計画の完了報告（`plan_report`）を出した。完了の合図の条件。新しい依頼・計画の確定で戻る */
  planCompleted: boolean;
}

export function createRuntime(env: NodeJS.ProcessEnv = process.env): Runtime {
  const home = homedir();
  const fromEnv = env.PI_SUBAGENT_MODEL?.trim();
  const subagentModelDefault = fromEnv && parseRef(fromEnv) ? fromEnv : SUBAGENT_DEFAULT;
  return {
    config: loadConfig(home, undefined, env),
    isSubagent: env.PI_SUBAGENT === "1",
    home,
    tmpdir: env.TMPDIR || tmpdir(),
    agentDir: resolveAgentDir(home, env),
    subagentModel: subagentModelDefault,
    subagentModelDefault,
    subagentSpawns: 0,
    childCost: 0,
    plan: undefined,
    planCompleted: false,
  };
}

/** 存在する最も深い祖先の実パスを解決し、残りを連結する（未作成のパスでも、symlink を辿った先で判定できる） */
export const realFs: FsProbe = {
  resolve(p: string): string {
    const abs = path.resolve(p);
    const rest: string[] = [];
    let probe = abs;
    for (;;) {
      try {
        return path.join(realpathSync(probe), ...rest);
      } catch {
        const parent = path.dirname(probe);
        if (parent === probe) return abs;
        rest.unshift(path.basename(probe));
        probe = parent;
      }
    }
  },
};
