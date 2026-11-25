/**
 * 同一轮里 Agent 发了多个点选问题，用户全部选完后，一次性交给 Agent 的汇总文本。
 *
 * 飞书和应用内对话共用这一个格式，不管单选多选、一题还是几题：Agent 收到的只是一条用户消息，
 * 题干要跟答案放在一起，否则答案对不上哪个问题。
 *
 * 用户没选完、直接打字时，系统会把没选的题关掉，这些题也进汇总（closed），只带标题并标明
 * 「用户未作答、系统自动关闭」：Agent 据此知道卡已失效、不是用户主动关的，不会再让用户去点。
 * 既没答案、也没关闭的条目不进汇总。
 */
export function formatQuestionBatchSummary(entries: ReadonlyArray<{ text: string; answered?: string; closed?: boolean }>): string {
  const blocks: string[] = [];
  for (const e of entries) {
    if (e.answered) blocks.push(`问题 ${blocks.length + 1}：${e.text.trim()}\n回答：${e.answered}`);
    else if (e.closed) blocks.push(`问题 ${blocks.length + 1}：${closedQuestionTitle(e.text)}\n${CLOSED_QUESTION_MARK}`);
  }
  return blocks.join("\n\n");
}

const CLOSED_QUESTION_MARK = "[用户未作答, 系统已自动关闭]";
/** 评审卡这类题干动辄上千字，关掉的题整段贴出来没有意义，只留第一行 */
const CLOSED_TITLE_MAX_LEN = 30;

function closedQuestionTitle(text: string): string {
  const firstLine = text
    .split("\n")
    .map((line) => line.replace(/[*`]/g, "").replace(/^[#>\s]+/, "").trim())
    .find((line) => line.length > 0) ?? "";
  return firstLine.length > CLOSED_TITLE_MAX_LEN ? `${firstLine.slice(0, CLOSED_TITLE_MAX_LEN)}…` : firstLine;
}
