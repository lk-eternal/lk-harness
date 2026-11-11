/** 设置页「项目」里能被直接跳到的位置（从别处跳进来用，比如新建项目对话框里的「去项目模板」） */
export type ProjectsSubTab = "list" | "templates" | "settings"

export const PROJECTS_SUB_TABS: readonly ProjectsSubTab[] = ["list", "templates", "settings"]

export function isProjectsSubTab(v: unknown): v is ProjectsSubTab {
  return PROJECTS_SUB_TABS.some((t) => t === v)
}

/**
 * 跳进设置页时的目标，写成「一级标签」或「一级标签:子页」。
 * 外面一直只传一个字符串给设置页（`onSettings("channel")`），子页跟在冒号后面，已有的调用不用改。
 */
export const PROJECT_TEMPLATES_TARGET = "projects:templates"

export function splitSettingsTarget(raw: string | undefined): { tab: string; sub?: string } {
  const text = (raw ?? "").trim()
  const at = text.indexOf(":")
  if (at < 0) return { tab: text }
  const sub = text.slice(at + 1).trim()
  return sub ? { tab: text.slice(0, at).trim(), sub } : { tab: text.slice(0, at).trim() }
}

/**
 * 一次「请跳到某处」的请求。每次都是新对象：「项目」标签靠对象引用变化响应，
 * 所以用户先手动点到别处、再从新建项目对话框跳过来（同一处第二次请求）也能跳过去。
 */
export interface ProjectsJump {
  sub: ProjectsSubTab
}

/** 设置页收到跳转目标后，算出要对「项目」标签发的请求；目标不是「项目」或位置不认识就返回 undefined */
export function projectsJumpFor(target: { tab: string; sub?: string }): ProjectsJump | undefined {
  if (target.tab !== "projects" || !isProjectsSubTab(target.sub)) return undefined
  return { sub: target.sub }
}

// ── 窄窗口 ───────────────────────────────────────────────────────────────────

/**
 * 「项目」页内容区窄于这个宽度（像素）就算窄：模板往下点到快捷操作时，左栏、快捷操作列表、编辑区三栏放不下，
 * 这时把最左边那栏收起来（快捷操作列表顶上有「返回」），只留后两栏。
 * 取值：左栏 192 + 快捷操作列表 208 + 间距 32 + 编辑区至少 ~390。应用默认窗口 900 宽，设置页内容区约 750，正好落在窄这边。
 */
export const NARROW_LAYOUT_PX = 820

/** 宽度为 0（页面被藏起来）不是「窄」，是「不知道」，调用方遇到 0 要保持原状 */
export function isNarrowLayout(width: number): boolean {
  return width > 0 && width < NARROW_LAYOUT_PX
}

// ── 「项目」页现在选中的是什么 ─────────────────────────────────────────────

/** 模板这一栏里选中的：模板信息本身，或其中一个快捷操作（含「正在新建」） */
export type TemplateLeaf = { kind: "info" } | { kind: "action"; id: string } | { kind: "new-action" }

export type ProjectsSel =
  | { kind: "projects-home" }
  | { kind: "project"; id: string }
  | { kind: "templates-home" }
  | { kind: "template"; id: string; leaf: TemplateLeaf }
  | { kind: "new-template" }
  | { kind: "settings" }

export type ProjectsSection = "projects" | "templates" | "settings"

export function sectionOfSel(sel: ProjectsSel): ProjectsSection {
  switch (sel.kind) {
    case "projects-home":
    case "project":
      return "projects"
    case "settings":
      return "settings"
    default:
      return "templates"
  }
}

export function selForJump(sub: ProjectsSubTab): ProjectsSel {
  if (sub === "templates") return { kind: "templates-home" }
  if (sub === "settings") return { kind: "settings" }
  return { kind: "projects-home" }
}

export function sameSel(a: ProjectsSel, b: ProjectsSel): boolean {
  if (a.kind !== b.kind) return false
  if (a.kind === "project" && b.kind === "project") return a.id === b.id
  if (a.kind === "template" && b.kind === "template") {
    if (a.id !== b.id || a.leaf.kind !== b.leaf.kind) return false
    return a.leaf.kind === "action" && b.leaf.kind === "action" ? a.leaf.id === b.leaf.id : true
  }
  return true
}

export interface SelContext {
  projectIds: readonly string[]
  templates: readonly { id: string; actionIds: readonly string[] }[]
}

/**
 * 数据重新读回来后，把选中的东西对到现状：项目被删了回到项目首页，模板被删了回到模板首页，
 * 快捷操作被删了落到模板信息。不会留下指向不存在东西的选中。
 */
export function resolveSel(sel: ProjectsSel, ctx: SelContext): ProjectsSel {
  if (sel.kind === "project") {
    return ctx.projectIds.includes(sel.id) ? sel : { kind: "projects-home" }
  }
  if (sel.kind === "template") {
    const t = ctx.templates.find((x) => x.id === sel.id)
    if (!t) return { kind: "templates-home" }
    if (sel.leaf.kind === "action" && !t.actionIds.includes(sel.leaf.id)) return { kind: "template", id: sel.id, leaf: { kind: "info" } }
    return sel
  }
  return sel
}

/** 第一次读到数据时：停在项目首页、又有项目，就直接选中第一个，省得用户面对一块空白 */
export function landingSel(sel: ProjectsSel, projectIds: readonly string[]): ProjectsSel {
  return sel.kind === "projects-home" && projectIds.length > 0 ? { kind: "project", id: projectIds[0] } : sel
}
