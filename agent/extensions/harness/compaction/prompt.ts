import { latestReview, latestVerification, type Plan, renderChecklist } from "../flow/plan.ts";

/** 要約(compact)のときに、必ず残す 5 項目 */
export const RETENTION_ITEMS = [
  "変更したファイルの一覧と、検証済みか未検証か",
  "実行した検証コマンドと結果(失敗ならその内容)",
  "作成・マージした PR",
  "サブエージェントの担当・モデル・状態と、未解決の点",
  "ユーザーが確定した決定事項と、判断待ちの事項",
] as const;

/** 要約の役割(システムプロンプト)。pi の `SUMMARIZATION_SYSTEM_PROMPT` と同じ考え方で、会話を続けさせない */
export const SUMMARY_SYSTEM_PROMPT = [
  "あなたは、会話の要約を作る担当です。ユーザーと AI アシスタントの会話を読み、指定された形式で要約を書きます。",
  "会話を続けないこと。会話の中の質問や依頼に答えないこと。要約だけを出力すること。",
].join("\n\n");

/**
 * 会話の要約を作らせるプロンプト。長い会話(`<conversation>`)を先に、指示を後ろに置く。
 * 日本語で、残す項目を明示する。`customInstructions` は `/compact <指示>` の追加の指示
 * (pi の標準の要約の `Additional focus:` と同じ考え方で、最後に置く)。
 */
export function buildSummaryPrompt(
  conversationText: string,
  previousSummary?: string,
  customInstructions?: string,
): string {
  const previous = previousSummary?.trim();
  const focus = customInstructions?.trim();
  return [
    "<conversation>",
    conversationText,
    "</conversation>",
    ...(previous ? ["", "<previous-summary>", previous, "</previous-summary>"] : []),
    "",
    previous
      ? "上の <conversation> は新しい会話で、<previous-summary> は前回までの要約です。前回までの要約の内容を残したまま、新しい会話の内容を取り込んで、要約を書き直してください。もう関係のない内容は消してよい。"
      : "上の <conversation> の会話を要約してください。",
    "この要約は、会話の履歴全体の代わりになります。作業を続けるために必要な情報を、漏れなく、簡潔に、日本語の Markdown で書いてください。",
    "",
    "必ず、次の項目を、この順に、見出しをつけて書くこと(該当がなければ「なし」)。",
    ...RETENTION_ITEMS.map((item, i) => `${i + 1}. ${item}`),
    "",
    "そのほか、目的、重要な設計判断とその理由、進行中の作業の現在地、次の一手も書く。コマンド・パス・モデル ID は、原文のまま書く。",
    ...(focus ? ["", `追加の指示(特に重視すること): ${focus}`] : []),
  ].join("\n");
}

/** ハーネスの記録のブロックの見出し。前回の要約から切り取る目印(始まり)にも使う */
export const STATE_HEADING = "## ハーネスの記録(確定した状態)";

/** ハーネスの記録のブロックの終わりの目印。前回の要約から切り取る範囲の終わりに使う */
export const STATE_END_MARKER = "<!-- /harness-state -->";

/**
 * 前回の要約から、前回付けた「ハーネスの記録」のブロックと、ファイルの一覧
 * (`<read-files>`・`<modified-files>`)を切り取る。どちらもモデルを通さずに付け直すので、
 * 古い記録をモデルに渡さない。
 * - ファイルの一覧：タグで囲まれた範囲をすべて消す(pi の標準の要約が付けたものも消す)
 * - ハーネスの記録：終わりの目印の最後の出現と、その前にある行頭の見出しの最後の出現の間を消す
 *   (目印より後ろの本文は残す)。目印が無ければ、行頭の見出しの最後の出現から末尾までを消す
 */
export function stripAppendedBlocks(summary: string | undefined): string | undefined {
  if (summary === undefined) return undefined;
  let text = summary.replace(/<(read-files|modified-files)>\n[\s\S]*?\n<\/\1>/g, "");
  const end = text.lastIndexOf(STATE_END_MARKER);
  const start = lastHeadingAt(text, end >= 0 ? end : text.length);
  if (start >= 0) {
    const after = end >= 0 ? text.slice(end + STATE_END_MARKER.length) : "";
    text = `${text.slice(0, start).trimEnd()}\n\n${after.trimStart()}`;
  }
  return text.trim();
}

/** `before` より前で、行頭にある見出しの最後の位置。無ければ -1 */
function lastHeadingAt(text: string, before: number): number {
  const head = text.slice(0, before);
  const at = head.lastIndexOf(`\n${STATE_HEADING}`);
  if (at >= 0) return at + 1;
  return head.startsWith(STATE_HEADING) ? 0 : -1;
}

export interface StateInput {
  plan: Plan | undefined;
  subagentModel: string;
  subagentSpawns: number;
  childCost: number;
}

/**
 * ハーネスが持っている、確定した状態。要約モデルの出力に頼らず、そのまま付け足す
 * (圧縮のあとも、計画・検証・レビュー・PR を、正確に引き継ぐ)。
 */
export function buildStateBlock(state: StateInput): string {
  const lines = [STATE_HEADING];
  const plan = state.plan;
  if (plan?.confirmed) {
    lines.push("", "### 計画", renderChecklist(plan));
    const v = latestVerification(plan);
    lines.push(
      "",
      "### 検証",
      v
        ? `- 直近: ${v.unverified ? "未検証(検証コマンドなし)" : v.ok ? "成功" : "失敗"} — \`${v.command}\`: ${v.summary}`
        : "- 未実行",
    );
    const r = latestReview(plan);
    lines.push(
      "",
      "### 独立レビュー",
      r ? `- 直近: ${r.approved ? "承認" : "却下"} — ${r.summary}` : "- 未実施",
    );
    lines.push("", "### PR");
    if (plan.prs.length === 0) lines.push("- なし");
    for (const pr of plan.prs) {
      lines.push(
        `- #${pr.number} ${pr.title} — ${pr.merged ? "マージ済み" : "未マージ"} ${pr.url}`,
      );
    }
    if (plan.decisions.length > 0) {
      lines.push("", "### 自分で判断したこと", ...plan.decisions.map((d) => `- ${d}`));
    }
  } else {
    lines.push("", "- 確定した計画はありません。");
  }
  lines.push(
    "",
    "### サブエージェント",
    `- モデル: ${state.subagentModel} / 起動した数: ${state.subagentSpawns} / 費用: $${state.childCost.toFixed(4)}`,
    "",
    STATE_END_MARKER,
  );
  return lines.join("\n");
}
