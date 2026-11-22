import type { HarnessConfig } from "./config.ts";

/** ガードの入力。実行環境の事実は、呼び出し側（register.ts）が集めて渡す。 */
export interface GuardEnv {
  /** サブエージェント（子プロセス）として起動されている */
  isSubagent: boolean;
  cwd: string;
  home: string;
  tmpdir: string;
}

export interface GitState {
  /** cwd のリポジトリ。リポジトリの外なら false */
  inRepo: boolean;
  /** リポジトリのルート（`git rev-parse --show-toplevel`） */
  repoRoot: string | null;
  currentBranch: string | null;
  /** 既定ブランチ（設定の名前と、origin/HEAD の指す先） */
  defaultBranches: ReadonlySet<string>;
}

export interface FsProbe {
  /** 存在する最も深い祖先の実パスを解決し、残りを連結して返す（symlink の回避を防ぐ） */
  resolve(path: string): string;
}

/** cwd の git の状態を取る */
export type GitProbe = (cwd: string) => Promise<GitState>;

export interface GuardInput {
  env: GuardEnv;
  config: HarnessConfig;
  /** env.cwd（ツールの作業ディレクトリ）の git の状態 */
  git: GitState;
  fs: FsProbe;
}
