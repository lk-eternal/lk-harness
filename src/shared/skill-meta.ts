/**
 * SKILL.md 开头 `---` 之间的说明（frontmatter）怎么读。
 * 设置页的 Skill 列表、AI 看到的 Skill 名单、manage_skills 的列表都用这一份，免得各取各的。
 * 不依赖 node 或 DOM：渲染进程、主进程、daemon 都能直接用。
 */

const SUMMARY_MAX = 160

function clean(text: string, max: number): string {
  const one = text.replace(/\s+/g, " ").trim()
  return one.length > max ? `${one.slice(0, max)}…` : one
}

function unquote(v: string): string {
  const t = v.trim()
  if (t.length >= 2 && ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'")))) return t.slice(1, -1)
  return t
}

/** 开头的 frontmatter 行（没有或没闭合就是 null）和它后面的正文 */
function splitFrontmatter(content: string): { lines: string[] | null; body: string } {
  const text = content.replace(/^\uFEFF/, "")
  const fm = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(text)
  if (!fm) return { lines: null, body: text }
  return { lines: fm[1].split(/\r?\n/), body: text.slice(fm[0].length) }
}

/**
 * 第一个叫 key 的字段的值：支持引号，和 `>` / `|` 多行写法（后面缩进的行都算，遇到不缩进的行就是下一个键）。
 * 没写这个字段返回 undefined；写了但是空返回 ""。
 */
function fieldValue(lines: string[], key: string): string | undefined {
  const re = new RegExp(`^${key}[ \\t]*:[ \\t]*(.*)$`)
  for (let i = 0; i < lines.length; i++) {
    const m = re.exec(lines[i])
    if (!m) continue
    const value = m[1].trim()
    if (/^[>|][+-]?\d*$/.test(value)) {
      const parts: string[] = []
      for (let j = i + 1; j < lines.length && (/^[ \t]/.test(lines[j]) || lines[j].trim() === ""); j++) {
        if (lines[j].trim()) parts.push(lines[j].trim())
      }
      return parts.join(" ")
    }
    return unquote(value)
  }
  return undefined
}

/**
 * 一句话说明：先看 frontmatter 的 `description`，没有就取正文第一行有内容的文字（去掉标题的 #）。
 * 取不到返回空串。超过 max 个字符截断并加省略号。
 */
export function skillSummary(content: string, max: number = SUMMARY_MAX): string {
  const { lines, body } = splitFrontmatter(content)
  if (lines) {
    const d = fieldValue(lines, "description")
    if (d) {
      const one = clean(d, max)
      if (one) return one
    }
  }
  for (const line of body.split(/\r?\n/)) {
    const t = line.replace(/^\s*#+\s*/, "").trim()
    if (t && t !== "---") return clean(t, max)
  }
  return ""
}

export interface SkillMeta {
  /** frontmatter 里写的 name；没写是 undefined（调用方用文件夹名） */
  name?: string
  description: string
  /** `disable-model-invocation: true`：作者声明不要自动给模型用（只让用户手动调用） */
  hidden: boolean
}

export function parseSkillMeta(content: string, descMax: number = SUMMARY_MAX): SkillMeta {
  const { lines } = splitFrontmatter(content)
  const name = lines ? fieldValue(lines, "name")?.trim() : undefined
  const hiddenRaw = lines ? fieldValue(lines, "disable-model-invocation")?.trim() : undefined
  return {
    ...(name ? { name } : {}),
    description: skillSummary(content, descMax),
    hidden: hiddenRaw !== undefined && /^(true|yes)$/i.test(hiddenRaw),
  }
}
