/**
 * 提示词里的标签标记：块之间怎么隔开、标签属性值怎么写。
 * 宿主提示词、Skill 名单、每轮信封都用这里的规则，格式只在这一处定。
 */

/** 提示词里块与块之间只隔一个空行；空块不占位，不留空段 */
export function joinPromptBlocks(blocks: readonly string[]): string {
  return blocks.map((b) => b.trim()).filter((b) => b.length > 0).join("\n\n")
}

/** 标签属性值：双引号换成单引号，标签不会被值本身截断 */
export function promptAttr(value: string): string {
  return value.replace(/"/g, "'")
}

/** 每轮信封里用到的标签：原文里出现它们的结束标签会提前截断标签，要中和 */
const ENVELOPE_TAGS = ["turn", "message", "quote", "memory", "item", "history", "task", "node-routing"]
const ENVELOPE_CLOSING_TAG = new RegExp(`</(${ENVELOPE_TAGS.join("|")})(?=[\\s>])`, "gi")

/** 放进标签里的原文：不转义，只把信封标签的结束标签写成 `<\/名字`，其余原样 */
export function promptText(text: string): string {
  return text.replace(ENVELOPE_CLOSING_TAG, "<\\/$1")
}

function pad2(n: number): string {
  return String(n).padStart(2, "0")
}

/** 本机时间，精确到分钟：2026-11-25 10:19 */
export function promptTime(ms: number): string {
  const d = new Date(ms)
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`
}

/** 本机时区：UTC+8、UTC-5、UTC+5:30 */
export function promptUtcOffset(ms: number): string {
  const minutes = -new Date(ms).getTimezoneOffset()
  const sign = minutes < 0 ? "-" : "+"
  const abs = Math.abs(minutes)
  const rest = abs % 60
  return `UTC${sign}${Math.floor(abs / 60)}${rest ? `:${pad2(rest)}` : ""}`
}
