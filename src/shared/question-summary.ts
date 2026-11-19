/**
 * 同一轮里 Agent 发了多个点选问题，用户全部选完后，一次性交给 Agent 的汇总文本。
 *
 * 飞书和应用内对话共用这一个格式，不管单选多选、一题还是几题：Agent 收到的只是一条用户消息，
 * 题干要跟答案放在一起，否则答案对不上哪个问题。没有已选答案的条目不进汇总。
 */
export function formatQuestionBatchSummary(entries: ReadonlyArray<{ text: string; answered?: string }>): string {
  const blocks: string[] = [];
  for (const e of entries) {
    if (!e.answered) continue;
    blocks.push(`问题 ${blocks.length + 1}：${e.text.trim()}\n回答：${e.answered}`);
  }
  return blocks.join("\n\n");
}
