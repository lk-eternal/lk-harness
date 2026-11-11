/**
 * 设置页「Skills」一级一级往下点的导航：目录 → Skill → 文件 → 编辑区。
 * 这里只放不依赖界面的判断，能在 node 里直接测。
 */

/** 目录这一级的显示名。磁盘目录是按 AI 工具分的，用工具名比 `~/.pi/agent/skills` 一眼就能认 */
const ROOT_NAMES: Record<string, string> = {
  cursor: "Cursor",
  agents: "Agents",
  pi: "Pi",
  claude: "Claude Code",
  codex: "Codex",
}

export interface SkillRootLike {
  id: string
  label: string
  skillCount: number
}

/** 不认识的目录（以后新增的）就直接显示路径 */
export function rootDisplayName(root: Pick<SkillRootLike, "id" | "label">): string {
  return ROOT_NAMES[root.id] ?? root.label
}

/** 第一次进来停在哪个目录：优先有 Skill 的，省得用户先面对一片空；都没有就第一个 */
export function pickInitialRoot(roots: readonly SkillRootLike[]): string | null {
  return (roots.find((r) => r.skillCount > 0) ?? roots[0])?.id ?? null
}

// ── 分栏 ────────────────────────────────────────────────────────────────────

/**
 * 内容区宽度（像素）达到这个值，选中 Skill 后目录、Skill、文件三个列表加编辑区能同时放下：
 * 三列各约 176 + 间距 + 编辑区至少 ~380。
 */
export const SKILLS_WIDE_PX = 960
/**
 * 低于 WIDE 但达到这个值：放得下两个列表加编辑区，最左的目录列先收起来。
 * 应用默认窗口 900 宽，设置页内容区约 750，落在这一档；再窄（最小窗口 780，内容区约 636）就只留文件一列。
 */
export const SKILLS_MID_PX = 700

export interface SkillColumns {
  roots: boolean
  skills: boolean
  files: boolean
  /** 最左边那个列表顶上的「返回」：回到哪里。null 表示不需要（最左已经是目录） */
  back: "roots" | "skills" | null
}

/**
 * 现在该显示哪几列。没选 Skill 时右边的编辑区是空的，目录和 Skill 两列总是都在；
 * 选了 Skill 才需要文件这一列，放不下的时候从最左边开始收。
 * 宽度 ≤ 0 是页面被藏起来、量不到，不是「窄」，按默认窗口那一档处理。
 */
export function skillsColumns(width: number, hasSkill: boolean): SkillColumns {
  if (!hasSkill) return { roots: true, skills: true, files: false, back: null }
  if (width >= SKILLS_WIDE_PX) return { roots: true, skills: true, files: true, back: null }
  if (width <= 0 || width >= SKILLS_MID_PX) return { roots: false, skills: true, files: true, back: "roots" }
  return { roots: false, skills: false, files: true, back: "skills" }
}

// ── 列表里每个 Skill 的一句话说明 ────────────────────────────────────────────

// 说明的解析和 AI 看到的 Skill 名单、manage_skills 的列表共用同一份
export { skillSummary } from "../../../shared/skill-meta"

// ── 文件树 ──────────────────────────────────────────────────────────────────

/** 文件列表里「SKILL.md」单独占第一行，树里就不再重复出现它（只去掉最上层的那个） */
export function withoutSkillMd(children: readonly SkillTreeNode[] | undefined): SkillTreeNode[] {
  return (children ?? []).filter((n) => !(n.type === "file" && n.name === "SKILL.md"))
}
