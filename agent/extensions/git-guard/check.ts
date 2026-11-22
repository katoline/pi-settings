import { homedir } from "node:os";
import { resolve } from "node:path";

/** 検出した git / gh コマンドの種類 */
export type DetectionKind = "push" | "commit" | "switch" | "pr-merge" | "api-merge";

export interface Detection {
  kind: DetectionKind;
  /** そのセグメントの作業ディレクトリ（絶対パス） */
  cwd: string;
  /** サブコマンド以降の引数（push / commit は git のサブコマンドの後ろ、gh は pr merge / api の後ろ） */
  args: string[];
}

export interface BranchInfo {
  /** 既定ブランチ名の候補 */
  defaults: string[];
  /** 現在のブランチ（取得できない・detached のときは null） */
  current: string | null;
}

export type Verdict =
  | { action: "allow" }
  | { action: "block"; reason: string }
  | { action: "confirm"; reason: string };

/** 取得に失敗したときの既定ブランチ候補 */
export const FALLBACK_DEFAULTS = ["main", "master"];

/** セグメント単位に分け、単純な引用符を 1 語として扱う */
export function splitSegments(command: string): string[][] {
  const segments: string[][] = [];
  let words: string[] = [];
  let cur = "";
  let has = false;
  // 今の語に引用符が含まれたか（引用符付きの語はリダイレクトとみなさない）
  let quoted = false;
  // 直前の語が宛先を伴わないリダイレクト演算子（`>` `2>` `<` 等）で、次の語がその宛先
  let skipNext = false;
  let quote: string | null = null;
  const endWord = () => {
    if (has) {
      // リダイレクト（`2>&1`・`> out.log`・`>>log`・`&>/dev/null`・`< in` 等）は語から除く。
      // 残すと refspec などの位置引数として数えられてしまうため
      const m = quoted ? null : /^(\d*|&)(>>?|<)(&?)(.*)$/.exec(cur);
      if (skipNext) skipNext = false;
      else if (m) skipNext = m[4] === "";
      else words.push(cur);
    }
    cur = "";
    has = false;
    quoted = false;
  };
  const endSegment = () => {
    endWord();
    skipNext = false;
    if (words.length > 0) segments.push(words);
    words = [];
  };
  for (let i = 0; i < command.length; i++) {
    const c = command[i];
    if (quote) {
      if (c === quote) quote = null;
      else cur += c;
      continue;
    }
    if (c === "'" || c === '"') {
      quote = c;
      has = true;
      quoted = true;
    } else if (c === " " || c === "\t") {
      endWord();
    } else if (c === "\n" || c === ";" || c === "|") {
      endSegment();
      if (c === "|" && command[i + 1] === "|") i++;
    } else if (c === "&" && command[i + 1] === "&") {
      endSegment();
      i++;
    } else {
      cur += c;
      has = true;
    }
  }
  endSegment();
  return segments;
}

function resolveDir(base: string, dir: string): string {
  const d = dir === "~" || dir.startsWith("~/") ? homedir() + dir.slice(1) : dir;
  return resolve(base, d);
}

/** git の値を取る大域オプション */
const GIT_GLOBAL_WITH_VALUE = new Set(["-C", "-c", "--git-dir", "--work-tree", "--namespace", "--exec-path"]);

/** checkout / switch の切替先ブランチ名。検出できない形は null */
function switchTarget(sub: string, args: string[]): string | null {
  const create = sub === "checkout" ? ["-b", "-B"] : ["-c", "-C", "--create", "--force-create"];
  const i = args.findIndex((a) => create.includes(a));
  if (i >= 0) return args[i + 1] && !args[i + 1].startsWith("-") ? args[i + 1] : null;
  // switch <name> の単純形のみ（checkout <name> はファイル指定と区別できないため対象外）
  if (sub === "switch" && args.length === 1 && !args[0].startsWith("-")) return args[0];
  return null;
}

/** コマンド文字列から git push / commit・gh pr merge / api merge を検出する */
export function detect(command: string, initialCwd: string): Detection[] {
  const result: Detection[] = [];
  let cwd = initialCwd;
  for (const seg of splitSegments(command)) {
    let i = 0;
    while (i < seg.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(seg[i])) i++;
    const words = seg.slice(i);
    if (words.length === 0) continue;
    const head = words[0];

    if (head === "cd") {
      const target = words[1];
      if (target && target !== "-") cwd = resolveDir(cwd, target);
      continue;
    }

    if (head === "git") {
      let segCwd = cwd;
      let j = 1;
      while (j < words.length && words[j].startsWith("-")) {
        const w = words[j];
        if (w === "-C" && words[j + 1] !== undefined) {
          segCwd = resolveDir(segCwd, words[j + 1]);
          j += 2;
        } else if (GIT_GLOBAL_WITH_VALUE.has(w)) {
          j += 2;
        } else {
          j += 1;
        }
      }
      const sub = words[j];
      const args = words.slice(j + 1);
      if (sub === "push") result.push({ kind: "push", cwd: segCwd, args });
      else if (sub === "commit") result.push({ kind: "commit", cwd: segCwd, args });
      else if (sub === "checkout" || sub === "switch") {
        const name = switchTarget(sub, args);
        if (name) result.push({ kind: "switch", cwd: segCwd, args: [name] });
      }
      continue;
    }

    if (head === "gh") {
      let j = 1;
      while (j < words.length && words[j].startsWith("-")) j += 1;
      if (words[j] === "pr" && words[j + 1] === "merge") {
        result.push({ kind: "pr-merge", cwd, args: words.slice(j + 2) });
      } else if (words[j] === "api") {
        const args = words.slice(j + 1);
        if (args.some((a) => /\/pulls\/\d+\/merge/.test(a))) {
          result.push({ kind: "api-merge", cwd, args });
        }
      }
    }
  }
  return result;
}

/** push の値を取るオプション（次の語を読み飛ばす） */
const PUSH_WITH_VALUE = new Set(["-o", "--push-option", "--repo", "--receive-pack", "--exec"]);
/** commit の値を取る短いオプション */
const COMMIT_VALUE_LETTERS = "mFCctS";

interface PushParse {
  force: boolean;
  del: boolean;
  noVerify: boolean;
  /** remote を除いた refspec */
  refspecs: string[];
}

function parsePush(args: string[]): PushParse {
  const p: PushParse = { force: false, del: false, noVerify: false, refspecs: [] };
  const positional: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith("--")) {
      const name = a.split("=")[0];
      if (name === "--force" || name === "--force-with-lease" || name === "--force-if-includes") p.force = true;
      else if (name === "--delete" || name === "--mirror") p.del = true;
      else if (name === "--no-verify") p.noVerify = true;
      else if (PUSH_WITH_VALUE.has(a)) i++;
    } else if (/^-[A-Za-z]+$/.test(a)) {
      if (a.includes("f")) p.force = true;
      if (a.includes("d")) p.del = true;
      if (a === "-o") i++;
    } else {
      positional.push(a);
    }
  }
  p.refspecs = positional.slice(1);
  return p;
}

function parseCommit(args: string[]): { noVerify: boolean } {
  let noVerify = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith("--")) {
      if (a === "--no-verify") noVerify = true;
      else if (["--message", "--file", "--author", "--date", "--template"].includes(a)) i++;
    } else if (/^-[A-Za-z]+$/.test(a)) {
      if (a.includes("n")) noVerify = true;
      if (COMMIT_VALUE_LETTERS.includes(a[a.length - 1])) i++;
    }
  }
  return { noVerify };
}

const block = (reason: string): Verdict => ({ action: "block", reason });

/** refspec の宛先ブランチ名（refs/heads/ は除く）。空なら null */
function refspecDest(spec: string): string | null {
  const s = spec.replace(/^\+/, "");
  const dest = s.includes(":") ? s.slice(s.lastIndexOf(":") + 1) : s;
  return dest.replace(/^refs\/heads\//, "") || null;
}

/** 検出結果 1 件を判定する。ブランチ情報は必要になったときだけ getInfo で取得する */
export async function evaluate(det: Detection, getInfo: (cwd: string) => Promise<BranchInfo | null>): Promise<Verdict> {
  switch (det.kind) {
    case "pr-merge":
    case "api-merge":
      return { action: "confirm", reason: "PR のマージを実行しようとしています。" };

    case "switch":
      return { action: "allow" };

    case "commit": {
      if (parseCommit(det.args).noVerify) {
        return block("git commit の --no-verify / -n は禁止です。フックを通して、失敗したら原因を直してください。");
      }
      const info = await getInfo(det.cwd);
      if (info?.current && info.defaults.includes(info.current)) {
        return block(`既定ブランチ ${info.current} 上での commit は禁止です。作業ブランチを切ってから commit してください。`);
      }
      return { action: "allow" };
    }

    case "push": {
      const p = parsePush(det.args);
      if (p.force || p.refspecs.some((r) => r.startsWith("+"))) {
        return block("git push の force（-f / --force / --force-with-lease / + refspec）は禁止です。通常の push で解決できないか見直してください。");
      }
      if (p.del || p.refspecs.some((r) => r.startsWith(":"))) {
        return block("git push によるリモートブランチの削除（--delete / -d / :ref / --mirror）は禁止です。削除が必要ならユーザーに依頼してください。");
      }
      if (p.noVerify) {
        return block("git push の --no-verify は禁止です。フックを通して、失敗したら原因を直してください。");
      }
      const info = await getInfo(det.cwd);
      const defaults = info?.defaults ?? FALLBACK_DEFAULTS;
      const current = info?.current ?? null;
      const msg = (b: string) => `既定ブランチ ${b} への push は禁止です。作業ブランチへ push し、PR 経由で取り込んでください。`;
      if (p.refspecs.length === 0) {
        if (current && defaults.includes(current)) return block(msg(current));
        return { action: "allow" };
      }
      for (const r of p.refspecs) {
        let dest = refspecDest(r);
        if (dest === "HEAD") dest = current;
        if (dest && defaults.includes(dest)) return block(msg(dest));
      }
      return { action: "allow" };
    }
  }
}

/** コマンド全体を判定する。block を優先し、無ければ最初の confirm を返す */
export async function judge(
  command: string,
  initialCwd: string,
  getInfo: (cwd: string) => Promise<BranchInfo | null>,
): Promise<Verdict> {
  let confirm: Verdict | null = null;
  // このコマンド内で切り替えたブランチ（作業ディレクトリごと）
  const switched = new Map<string, string>();
  const infoWithSwitch = async (cwd: string): Promise<BranchInfo | null> => {
    const s = switched.get(cwd);
    if (s === undefined) return getInfo(cwd);
    const info = await getInfo(cwd);
    return { defaults: info?.defaults ?? FALLBACK_DEFAULTS, current: s };
  };
  for (const det of detect(command, initialCwd)) {
    if (det.kind === "switch") {
      switched.set(det.cwd, det.args[0]);
      continue;
    }
    const v = await evaluate(det, infoWithSwitch);
    if (v.action === "block") return v;
    if (v.action === "confirm" && !confirm) confirm = v;
  }
  return confirm ?? { action: "allow" };
}

/** ユーザーの入力がマージを依頼しているか（「マージ」「merge」を含むか） */
export function mentionsMerge(text: string): boolean {
  return /マージ|merge/i.test(text);
}

/**
 * ユーザー入力を受けたときの「マージを依頼された」状態を返す。
 * 待機中の入力は新しい依頼なので置き換え、実行中の追加入力（steer / followUp）は今の状態に足す
 */
export function nextMergeRequested(prev: boolean, text: string, duringRun: boolean): boolean {
  return duringRun ? prev || mentionsMerge(text) : mentionsMerge(text);
}
