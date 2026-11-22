import { latestReview, latestVerification, type Plan, type VerificationRecord } from "./plan.ts";

/** PR の本文・保護の判定・CI・マージのゲート（副作用のない純粋な関数） */

// ---- PR 本文 ----
export const BODY_BEGIN = "<!-- harness:begin -->";
export const BODY_END = "<!-- harness:end -->";

export interface PrBodyInput {
  /** 1〜3 文の概要。省略時は、コミットの件名から作る */
  summary?: string;
  /** `git log --format=%s` の各行（古い順） */
  commits: string[];
  /** 計画の直近の検証。無ければ「未検証」 */
  verification?: Pick<VerificationRecord, "command" | "ok" | "summary" | "unverified">;
}

/** 「概要・変更点・確認方法」の固定の形。マーカーで囲んだ、生成部分だけを返す */
export function buildPrBody(input: PrBodyInput): string {
  const summary =
    input.summary?.trim() ||
    (input.commits.length > 0
      ? input.commits.join("、")
      : "変更の概要は、コミットを参照してください。");
  const changes =
    input.commits.length > 0 ? input.commits.map((c) => `- ${c}`).join("\n") : "- (コミットなし)";
  const v = input.verification;
  const verify = !v
    ? "- **未検証**(検証を実行していません)"
    : v.unverified
      ? "- **未検証**(検証コマンドが見つかりませんでした)"
      : `- ${v.ok ? "成功" : "失敗"}: \`${v.command}\`\n  - ${v.summary}`;
  return [
    BODY_BEGIN,
    "## 概要",
    "",
    summary,
    "",
    "## 変更点",
    "",
    changes,
    "",
    "## 確認方法",
    "",
    verify,
    BODY_END,
  ].join("\n");
}

/**
 * 既存の本文の、マーカーの間だけを作り直し、外側(ユーザーが書いた内容)は残す。
 * マーカーが無い本文(手で作った PR など)は、元の本文をそのまま残し、末尾に生成部分を足す
 */
export function applyGeneratedSection(existing: string, generated: string): string {
  const begin = existing.indexOf(BODY_BEGIN);
  const end = existing.indexOf(BODY_END, begin + 1);
  if (begin >= 0 && end > begin) {
    return existing.slice(0, begin) + generated + existing.slice(end + BODY_END.length);
  }
  const trimmed = existing.trimEnd();
  return trimmed ? `${trimmed}\n\n${generated}` : generated;
}

// ---- CI ----
export interface CheckRun {
  name: string;
  /** gh pr checks --json bucket: pass / fail / pending / skipping / cancel */
  bucket: string;
}

/** `error` は、CI の状態を取得できなかった(通信・認証・権限など)。チェックが無い(`none`)とは区別する */
export type ChecksState = "pass" | "fail" | "pending" | "none" | "error";

export function evaluateChecks(checks: readonly CheckRun[]): ChecksState {
  const relevant = checks.filter((c) => c.bucket !== "skipping");
  if (relevant.length === 0) return "none";
  if (relevant.some((c) => c.bucket === "fail" || c.bucket === "cancel")) return "fail";
  if (relevant.some((c) => c.bucket === "pending")) return "pending";
  return "pass";
}

export function parseChecks(json: string): CheckRun[] {
  try {
    const parsed = JSON.parse(json) as { name?: string; bucket?: string }[];
    return parsed.map((c) => ({ name: String(c.name ?? ""), bucket: String(c.bucket ?? "") }));
  } catch {
    return [];
  }
}

/** `gh pr checks` の実行結果(終了コード・標準出力・標準エラー) */
export interface ChecksResult {
  state: ChecksState;
  /** `error` のときの、gh の出力の要約 */
  detail?: string;
}

/**
 * チェックが無いときの gh のメッセージ。gh 2.102.0 で確かめた: チェックの無い PR では、
 * `--json` を付けても標準出力は空、標準エラーに `no checks reported on the '<ブランチ>' branch`、終了コード 1。
 * `--required` 用の `no required checks reported …` も同じ扱いにする
 */
const NO_CHECKS = /^no (required )?checks reported\b/im;

/**
 * `gh pr checks <番号> --json name,bucket` の結果を判定する。
 * - 標準出力が JSON の配列なら、その中身で判定する(実行中・失敗のときは非 0 で返ることがある)
 * - 「チェックが無い」と分かるのは、終了コード 1 で、標準エラーが gh の「no checks reported」のときだけ(`none`)
 * - それ以外(通信・認証・権限・gh が無い・出力が読めない)は `error`。マージを止める理由にする
 */
export function judgeChecksResult(r: ApiResult): ChecksResult {
  const out = r.stdout.trim();
  if (out) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(out);
    } catch {
      parsed = undefined;
    }
    if (Array.isArray(parsed)) return { state: evaluateChecks(parseChecks(out)) };
    return { state: "error", detail: `gh の出力を読めませんでした: ${out.slice(0, 200)}` };
  }
  if (r.code === 1 && NO_CHECKS.test(r.stderr.trim())) return { state: "none" };
  const err = r.stderr.trim();
  return {
    state: "error",
    detail: `終了コード ${r.code}${err ? `: ${err.slice(0, 300)}` : "(出力なし)"}`,
  };
}

export const checksLabel: Record<ChecksState, string> = {
  pass: "成功",
  fail: "失敗",
  pending: "実行中",
  none: "なし",
  error: "取得できず",
};

// ---- ブランチ保護(確かめるだけ。作らない。決定 007) ----
export type ProtectionState = "protected" | "unprotected" | "unknown";

export interface ApiResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** `GET /repos/{owner}/{repo}/rules/branches/{branch}`(ルールセットを含む、そのブランチに効く規則)に、PR 必須の規則があるか */
export function branchRulesRequirePr(json: string): boolean | null {
  try {
    const rules = JSON.parse(json) as { type?: string }[];
    if (!Array.isArray(rules)) return null;
    return rules.some((r) => r.type === "pull_request");
  } catch {
    return null;
  }
}

const isNotFound = (r: ApiResult) => /HTTP 404|Not Found|not protected/i.test(r.stderr + r.stdout);

/**
 * 既定ブランチの保護の状態。ルールセットの規則か、クラシックのブランチ保護のどちらかがあれば保護。
 * どちらも無いと確かめられたときだけ未保護。確かめられない(認証・権限・通信)ときは unknown
 */
export function judgeProtection(rules: ApiResult, classic: ApiResult): ProtectionState {
  const viaRules = rules.code === 0 ? branchRulesRequirePr(rules.stdout) : null;
  if (viaRules === true) return "protected";
  if (classic.code === 0) return "protected";
  const classicNone = isNotFound(classic);
  if (viaRules === false && classicNone) return "unprotected";
  return "unknown";
}

export const protectionNotice = (state: ProtectionState, branch: string): string | null =>
  state === "protected"
    ? null
    : state === "unprotected"
      ? `既定ブランチ(${branch})が GitHub で保護されていません(PR 必須・force push の禁止などが未設定)。ハーネスは設定しません。必要ならユーザーが GitHub の設定で保護してください。`
      : `既定ブランチ(${branch})の保護は、確認できませんでした(gh の認証・権限・通信、または GitHub 以外のリモート)。`;

/** `git remote get-url origin` から owner/repo を取り出す(github.com のみ) */
export function parseGithubRemote(url: string): { owner: string; repo: string } | null {
  const m = /github\.com[:/]([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/.exec(url.trim());
  return m ? { owner: m[1] as string, repo: m[2] as string } : null;
}

// ---- マージのゲート ----
export interface MergeGateInput {
  isSubagent: boolean;
  hasUI: boolean;
  checks: ChecksState;
  /** `checks` が `error` のときの、gh の出力の要約 */
  checksDetail?: string;
  plan: Plan | undefined;
  /** 計画があり、確定済みで、PR のブランチが今のブランチ(計画のゲートを効かせる) */
  planApplies: boolean;
  /** 現在の作業ツリーの指紋(検証・レビューが、最後の変更のあとのものか) */
  fingerprint: string;
  /** ローカルの HEAD が PR の先頭と違う(push 漏れ・未取り込みの変更) */
  headDiffers?: boolean;
}

export interface MergeGate {
  /** マージを止める理由。1 つでもあれば、確認ダイアログも出さずに止める */
  blockers: string[];
  /** 確認ダイアログの本文に注意として出す(止めない。ユーザーが判断する。決定 012) */
  warnings: string[];
}

export function mergeGate(input: MergeGateInput): MergeGate {
  const blockers: string[] = [];
  const warnings: string[] = [];
  if (input.isSubagent) blockers.push("マージは、メインセッションからだけ許可されます。");
  if (!input.hasUI)
    blockers.push(
      "確認用の画面(UI)がないため、マージできません。ユーザーに実行を依頼してください。",
    );
  if (input.checks === "fail")
    blockers.push("CI のチェックが失敗しています。直して、CI を通し直してください。");
  if (input.checks === "pending")
    blockers.push("CI のチェックが、待っても終わりませんでした(上限時間)。");
  if (input.checks === "error")
    blockers.push(
      `CI の状態を取得できませんでした(gh の通信・認証・権限など)。確かめられないため、マージしません。${input.checksDetail ? `(${input.checksDetail})` : ""}`,
    );
  if (input.checks === "none") warnings.push("CI のチェックがありません。");

  const plan = input.plan;
  if (!plan || !input.planApplies) {
    warnings.push(
      plan?.confirmed
        ? "この PR は、確定した計画の作業ブランチのものではありません。検証・レビューの記録を確認できていません。"
        : "確定した計画がありません。検証・レビューの記録を確認できていません。",
    );
    return { blockers, warnings };
  }
  const v = latestVerification(plan);
  if (!v) blockers.push("検証が未実行です(harness_verify)。");
  else if (!v.ok) blockers.push("直近の検証が失敗しています。");
  else if (v.fingerprint !== input.fingerprint)
    blockers.push("最後の検証のあとに、変更がありました。harness_verify をやり直してください。");
  else if (v.unverified) warnings.push("検証コマンドがなく、未検証です。");
  if (plan.items.some((i) => i.review)) {
    const r = latestReview(plan);
    if (!r?.approved) blockers.push("独立レビューが承認されていません(harness_review)。");
    else if (r.fingerprint !== input.fingerprint)
      blockers.push("最後のレビューのあとに、変更がありました。再レビューを受けてください。");
  }
  // 未着手・進行中の項目が残っていれば止める。ただし、計画の最後の項目が進行中なら数えない
  // (マージの項目は計画の最後に置き、in_progress にしてから harness_pr_merge を呼ぶため。
  // 数えると、計画にマージの項目があるとき必ず止まってしまう)
  const last = plan.items.at(-1);
  const open = plan.items.filter(
    (i) => i.status === "pending" || (i.status === "in_progress" && i !== last),
  );
  if (open.length > 0)
    blockers.push(
      `未着手・進行中の項目が ${open.length} 件あります(計画の最後の項目は、進行中なら数えません)。`,
    );
  if (input.headDiffers)
    warnings.push(
      "ローカルの HEAD が PR の先頭と違います(push していない変更、または未取り込みの変更があります)。",
    );
  return { blockers, warnings };
}
