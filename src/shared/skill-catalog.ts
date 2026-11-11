/**
 * 告诉 AI「本机有哪些 Skill」的名单文本。Cursor SDK 和 Pi 两个引擎共用这一份。
 *
 * 只给名字和一句话说明，完整内容在每个 Skill 目录的 SKILL.md 里，AI 自己判断要不要读。
 * 目录只写一次，条目不重复写路径（目录 + 名字就是路径）。
 * 纯函数、不碰磁盘：扫描目录在 electron/skill-catalog.ts。
 */

export interface CatalogSkill {
  /** 给 AI 看的名字（frontmatter 的 name，没写就是文件夹名） */
  name: string
  /** 相对 Skill 根目录的文件夹路径，如 `foo` 或 `group/foo` */
  folder: string
  description: string
}

export interface CatalogRoot {
  /** Skill 根目录的绝对路径 */
  dir: string
  skills: CatalogSkill[]
}

/** 每条说明最多留这么多字符：够判断用途，尾部多是触发词和例子 */
export const SKILL_DESC_MAX = 120
/** 整份名单的字符预算：超了就从尾部开始降级成只写名字 */
export const SKILL_CATALOG_BUDGET = 10_000

export interface SkillCatalogText {
  /** 空串 = 没有可列的 Skill */
  text: string
  /** 去重后可列的 Skill 总数 */
  count: number
  /** 带说明列出的数量 */
  full: number
  /** 至少列出名字的数量（≤ count；预算连名字都放不下时才会小于 count） */
  listed: number
}

const HEADING = "## 本机 Skill"
const INTRO = "下面这些目录里有 Skill：每个子目录是一个 Skill，其中的 SKILL.md 是完整说明；条目写作「名字：说明」。"

interface Row {
  root: number
  /** `name`，名字和文件夹不一致时是 `name（目录 folder）` */
  label: string
  name: string
  desc: string
}

function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}

function truncate(text: string, max: number): string {
  const one = text.replace(/\s+/g, " ").trim()
  return one.length > max ? `${one.slice(0, max)}…` : one
}

/** 同名只留先出现的目录里那份；每个目录里按名字排序（固定顺序，名单没变文本就不变，缓存才命中） */
function flatten(roots: readonly CatalogRoot[], descMax: number): { rows: Row[]; dirs: string[] } {
  const seen = new Set<string>()
  const rows: Row[] = []
  const dirs: string[] = []
  for (const root of roots) {
    const kept: CatalogSkill[] = []
    for (const s of root.skills) {
      if (!s.name || seen.has(s.name)) continue
      seen.add(s.name)
      kept.push(s)
    }
    if (kept.length === 0) continue
    kept.sort((a, b) => cmp(a.name, b.name) || cmp(a.folder, b.folder))
    const idx = dirs.length
    dirs.push(root.dir)
    for (const s of kept) {
      rows.push({
        root: idx,
        label: s.name === s.folder ? s.name : `${s.name}（目录 ${s.folder}）`,
        name: s.name,
        desc: truncate(s.description, descMax),
      })
    }
  }
  return { rows, dirs }
}

/** 前 full 条带说明，到第 listed 条为止只写名字，其余不列 */
function render(rows: readonly Row[], dirs: readonly string[], full: number, listed: number): string {
  const out: string[] = [HEADING, INTRO]
  for (let d = 0; d < dirs.length; d++) {
    const lines: string[] = []
    const bare: string[] = []
    for (let i = 0; i < rows.length && i < listed; i++) {
      const r = rows[i]
      if (r.root !== d) continue
      if (i < full) lines.push(r.desc ? `- ${r.label}：${r.desc}` : `- ${r.label}`)
      else bare.push(r.label)
    }
    if (bare.length > 0) lines.push(`- 仅列名字：${bare.join("、")}`)
    if (lines.length === 0) continue
    out.push("", `### ${dirs[d]}`, ...lines)
  }
  if (listed < rows.length) out.push("", `（另有 ${rows.length - listed} 个 Skill 未列出）`)
  return out.join("\n")
}

export function buildSkillCatalog(
  roots: readonly CatalogRoot[],
  opts: { budget?: number; descMax?: number } = {},
): SkillCatalogText {
  const budget = opts.budget ?? SKILL_CATALOG_BUDGET
  const { rows, dirs } = flatten(roots, opts.descMax ?? SKILL_DESC_MAX)
  const n = rows.length
  if (n === 0) return { text: "", count: 0, full: 0, listed: 0 }

  // 先试都带说明；放不下就少带几条（从尾部开始降级成只写名字）
  for (let full = n; full >= 0; full--) {
    const text = render(rows, dirs, full, n)
    if (text.length <= budget) return { text, count: n, full, listed: n }
  }
  // 连名字都放不下：少列几个，写明还有多少没列
  for (let listed = n - 1; listed >= 0; listed--) {
    const text = render(rows, dirs, 0, listed)
    if (text.length <= budget) return { text, count: n, full: 0, listed }
  }
  return { text: render(rows, dirs, 0, 0), count: n, full: 0, listed: 0 }
}

/** 名单有变化时补发：开头说明这份替代之前给过的，以免 AI 以为是两份 */
export function withUpdateNotice(text: string): string {
  return text ? `（Skill 名单有变化，下面是最新的，以这份为准）\n${text}` : text
}

export interface SkillInjection {
  text: string
  hash: string
  /** new-ledger：这个账本里还没给过；changed：给过，但名单后来变了 */
  reason: "new-ledger" | "changed"
}

/**
 * 这次拉起会话要不要给 AI 带名单。
 * sentHash = 这个账本里 AI 已经拿到的那一版的指纹（新账本、或上次没送达都是 undefined）。
 * 没有 Skill、或名单没变就不带——后面的轮次靠这个保持安静。
 */
export function planSkillInjection(
  current: { text: string; hash: string; count: number },
  sentHash: string | undefined,
): SkillInjection | undefined {
  if (current.count <= 0 || !current.text) return undefined
  if (sentHash === current.hash) return undefined
  return sentHash
    ? { text: withUpdateNotice(current.text), hash: current.hash, reason: "changed" }
    : { text: current.text, hash: current.hash, reason: "new-ledger" }
}
