// ── Agent 撤回自己发出的点选题 ─────────────────────────────────────────
// Agent 发了题、后来换了思路不再需要：用题号（发题时告诉它的）把本轮发出、用户还没作答的题关掉。
// 飞书卡片和应用内对话各存各的题，「这道题能不能撤、撤不了是为什么」由这里统一判定，两边说法一致。

/** 撤回后题上显示的说明（沿用「关闭」的显示：按钮收起，底部写一行说明） */
export const WITHDRAW_NOTE = "AI 已撤回";

export type WithdrawOutcome = "withdrawn" | "answered" | "closed" | "unknown";

export interface WithdrawTarget {
  answered?: string;
  closedNote?: string;
}

/**
 * 这道题此刻能不能撤：没找到（不是本轮发的题号）、已经关了、用户已经选了（用户的选择不能被吞掉，保留），都不撤；其余可撤。
 */
export function withdrawOutcome(question: WithdrawTarget | undefined): WithdrawOutcome {
  if (!question) return "unknown";
  if (question.closedNote) return "closed";
  if (question.answered) return "answered";
  return "withdrawn";
}

export interface WithdrawResult {
  no: number;
  outcome: WithdrawOutcome;
}

function noList(results: readonly WithdrawResult[], outcome: WithdrawOutcome): string {
  return results.filter((r) => r.outcome === outcome).map((r) => r.no).join("、");
}

/** 撤回结果写给 Agent 看：撤了哪些，没撤的是为什么 */
export function formatWithdrawReport(results: readonly WithdrawResult[]): string {
  const lines: string[] = [];
  const withdrawn = noList(results, "withdrawn");
  const answered = noList(results, "answered");
  const closed = noList(results, "closed");
  const unknown = noList(results, "unknown");
  if (withdrawn) lines.push(`已撤回题号 ${withdrawn}。`);
  if (answered) lines.push(`题号 ${answered} 用户已经作答，没有撤回，答案会和本轮其余的答案一起交给你。`);
  if (closed) lines.push(`题号 ${closed} 早已关闭，不用撤回。`);
  if (unknown) lines.push(`没找到题号 ${unknown}：只能撤回本轮自己发出的题。`);
  return lines.join("\n");
}
