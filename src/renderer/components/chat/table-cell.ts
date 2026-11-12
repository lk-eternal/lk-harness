/**
 * 对话 Markdown 表格里「内容很短的单元格」（时间、状态、序号、是/否…）不换行。
 *
 * 表格是浏览器的自动布局：列宽在「最小宽度」和「最大宽度」之间按各列的富余量分。
 * 中文每个字之后都能断行，短列的最小宽度只有一个字，而旁边的长文字列富余量大得多，
 * 结果「09:24」被挤成 `09:2` / `4`，「已改」被挤成竖排。
 * 短单元格标成不换行后，这一列的最小宽度就是它自己的宽度，不会再被挤。
 */

/** 显示宽度不超过这个值的单元格不换行（中日韩字符算 2，约等于 6 个汉字 / 12 个英文字符） */
export const SHORT_CELL_MAX_WIDTH = 12

// 中日韩表意文字、假名、谚文、全角标点：一个字占两个英文字符的宽度
const WIDE_CHAR = /[\u1100-\u115f\u2e80-\ua4cf\uac00-\ud7a3\uf900-\ufaff\ufe30-\ufe6f\uff00-\uff60\uffe0-\uffe6]/u

/** 文字的显示宽度：中日韩字符算 2，其余算 1 */
export function displayWidth(text: string): number {
  let width = 0
  for (const ch of text) width += WIDE_CHAR.test(ch) ? 2 : 1
  return width
}

/** 这个单元格的文字短到不该换行吗（空单元格不算，没东西可保护） */
export function isShortCell(text: string): boolean {
  const trimmed = text.trim()
  return trimmed !== "" && displayWidth(trimmed) <= SHORT_CELL_MAX_WIDTH
}
