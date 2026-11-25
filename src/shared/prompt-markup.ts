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
