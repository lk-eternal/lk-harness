/**
 * 同一轮里 Agent 发了多个点选问题，用户全部选完后，一次性交给 Agent 的汇总文本。
 *
 * 飞书和应用内对话共用这一个格式，不管单选多选、一题还是几题：Agent 收到的只是一条用户消息，
 * 题干要跟答案放在一起，否则答案对不上哪个问题。
 *
 * 用户没选完、直接打字把题关掉时，没选的题也进汇总（closed），标成已关闭并只带标题：
 * Agent 据此知道这张卡已经失效，不会再让用户去点。既没答案、也没关闭的条目不进汇总。
 */
export function formatQuestionBatchSummary(entries: ReadonlyArray<{ text: string; answered?: string; closed?: boolean }>): string {
  const blocks: string[] = [];
  for (const e of entries) {
    if (e.answered) blocks.push(`问题 ${blocks.length + 1}：${e.text.trim()}\n回答：${e.answered}`);
    else if (e.closed) blocks.push(`问题 ${blocks.length + 1}：${closedQuestionTitle(e.text)}\n${CLOSED_QUESTION_MARK}`);
  }
  return blocks.join("\n\n");
}

const CLOSED_QUESTION_MARK = "[未作答, 问题已关闭]";
/** 评审卡这类题干动辄上千字，关掉的题整段贴出来没有意义，只留第一行 */
const CLOSED_TITLE_MAX_LEN = 30;

function closedQuestionTitle(text: string): string {
  const firstLine = text
    .split("\n")
    .map((line) => line.replace(/[*`]/g, "").replace(/^[#>\s]+/, "").trim())
    .find((line) => line.length > 0) ?? "";
  return firstLine.length > CLOSED_TITLE_MAX_LEN ? `${firstLine.slice(0, CLOSED_TITLE_MAX_LEN)}…` : firstLine;
}
