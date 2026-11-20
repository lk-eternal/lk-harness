// ── AI 管理项目相关配置（manage_project 的 settings / repo / template / update）的纯逻辑 ──
// 校验、合并、生成要保存的内容都在这里，不碰磁盘和配置；宿主（electron/project-admin.ts）只负责把结果落盘。
// 规则和设置页里手动操作是同一套（上限、重名、至少一个快捷操作……），AI 和人走的是同一道门。

import * as path from "node:path"
import { parseHubRepoUrl } from "./flow-hub-gitlab.js"
import { PROJECT_NAME_MAX, PROJECT_TEXT_MAX } from "./project-app-types.js"
import { DEFAULT_GIT_PRINCIPLES, GIT_PRINCIPLES_MAX } from "./project-git-principles.js"
import { ACTION_GUIDES } from "./project-node-guides.js"
import { mergeProjectMetadata } from "./project-store.js"
import {
  ACTION_LABEL_MAX,
  applyTemplateEdit,
  buildNewTemplate,
  newOpaqueId,
  templateDraftProblem,
  type TemplateDraft,
} from "./project-template-edit.js"
import type { Project, ProjectFieldDef, ProjectNodeDef, ProjectNodeGroupDef } from "./project-types.js"
import { WORK_BRANCH_MODES, type WorkBranchMode } from "./work-branch-mode.js"

type Fail = { ok: false; error: string }
const fail = (error: string): Fail => ({ ok: false, error })

/** 宿主处理 manage_project 管理类请求的结果：message 是原样给 AI 看的文字 */
export type AdminOutcome = { ok: true; message: string } | Fail

// ── 密钥 ────────────────────────────────────────────────────────────────

/** 密钥给 AI / 日志看的样子：从不回显全文 */
export function maskSecret(secret: string | undefined | null): string {
  const t = (secret ?? "").trim()
  if (!t) return "（未设置）"
  return t.length <= 8 ? `${t.slice(0, 2)}***` : `${t.slice(0, 6)}***${t.slice(-3)}`
}

// ── 全局设置（设置 → 项目） ──────────────────────────────────────────────

export interface SettingsSetInput {
  /** 项目存放位置，绝对路径；空串 = 改回默认位置 */
  worktreeRoot?: string
  /** GitLab 地址（域名部分）；空串 = 清空 */
  gitlabHost?: string
  /** GitLab Token；空串 = 清除 */
  gitlabToken?: string
  /** Git 基本原则全文；空串 = 关闭 */
  gitPrinciples?: string
  /** 恢复默认的 Git 基本原则（和 gitPrinciples 二选一） */
  resetGitPrinciples?: boolean
  flowHubUrl?: string
  flowHubToken?: string
  flowHubAuthor?: string
}

export type SettingsSetPlan =
  | {
      ok: true
      /** 要写进配置的键值（交给 saveConfig；gitPrinciples 写成默认文案由 saveConfig 当作「没改过」） */
      patch: Record<string, string>
      /** 给 AI 看的「改了什么」，不含密钥 */
      summary: string[]
      /** 需要先建好的目录（项目存放位置） */
      mkdir?: string
    }
  | Fail

const SECRET_MAX = 300
const AUTHOR_MAX = 60

function stripTrailingSep(p: string): string {
  const root = path.parse(p).root
  let out = p
  while (out.length > root.length && /[\\/]$/.test(out)) out = out.slice(0, -1)
  return out
}

/** GitLab 地址只认「域名部分」：共享空间那边用它和 Hub 地址的域名比对，带了路径会对不上 */
function normalizeGitlabHost(raw: string): { ok: true; value: string } | Fail {
  const t = raw.trim().replace(/\/+$/, "")
  const bad = fail("GitLab 地址只填域名部分，例如 https://gitlab.example.com（不要带仓库路径）")
  try {
    const u = new URL(t.includes("://") ? t : `https://${t}`)
    if (u.protocol !== "https:" && u.protocol !== "http:") return bad
    if ((u.pathname !== "/" && u.pathname !== "") || u.search || u.hash) return bad
    return { ok: true, value: u.origin }
  } catch {
    return bad
  }
}

function checkSecret(raw: string, label: string): { ok: true; value: string } | Fail {
  const v = raw.trim()
  if (/\s/.test(v)) return fail(`${label} 里不该有空格或换行，检查一下是不是复制多了`)
  if (v.length > SECRET_MAX) return fail(`${label} 太长了（最多 ${SECRET_MAX} 个字符）`)
  return { ok: true, value: v }
}

export function planSettingsSet(input: SettingsSetInput): SettingsSetPlan {
  const patch: Record<string, string> = {}
  const summary: string[] = []
  let mkdir: string | undefined

  if (input.worktreeRoot !== undefined) {
    const v = input.worktreeRoot.trim()
    if (!v) {
      patch.worktreeRoot = ""
      summary.push("项目存放位置：改回默认位置")
    } else {
      if (!path.isAbsolute(v)) return fail("worktree_root 要填绝对路径，例如 D:\\claw-projects")
      const dir = stripTrailingSep(path.normalize(v))
      if (path.parse(dir).root === dir) return fail(`不能把整个盘（${dir}）当项目存放位置，请指定一个文件夹，例如 ${path.join(dir, "claw-projects")}`)
      patch.worktreeRoot = dir
      mkdir = dir
      summary.push(`项目存放位置：${dir}（只影响之后新建的项目，已有项目不会搬家）`)
    }
  }

  if (input.gitlabHost !== undefined) {
    if (!input.gitlabHost.trim()) {
      patch.gitlabHost = ""
      summary.push("GitLab 地址：已清空（默认从仓库的 origin 推断）")
    } else {
      const h = normalizeGitlabHost(input.gitlabHost)
      if (!h.ok) return h
      patch.gitlabHost = h.value
      summary.push(`GitLab 地址：${h.value}`)
    }
  }

  if (input.gitlabToken !== undefined) {
    const t = checkSecret(input.gitlabToken, "GitLab Token")
    if (!t.ok) return t
    patch.gitlabToken = t.value
    summary.push(t.value ? "GitLab Token：已更新" : "GitLab Token：已清除")
  }

  if (input.resetGitPrinciples && input.gitPrinciples !== undefined) {
    return fail("git_principles 和 reset_git_principles 只能给一个：要写新内容就给 git_principles，要恢复默认就只给 reset_git_principles=true")
  }
  if (input.resetGitPrinciples) {
    patch.gitPrinciples = DEFAULT_GIT_PRINCIPLES
    summary.push("Git 基本原则：已恢复默认")
  } else if (input.gitPrinciples !== undefined) {
    const text = input.gitPrinciples.replace(/\r\n/g, "\n").trim()
    if (text.length > GIT_PRINCIPLES_MAX) return fail(`Git 基本原则最多 ${GIT_PRINCIPLES_MAX} 个字（它会带进每个项目会话），现在 ${text.length} 个字，精简一下`)
    patch.gitPrinciples = text
    summary.push(
      !text ? "Git 基本原则：已关闭（项目会话里不再带这段话）"
        : text === DEFAULT_GIT_PRINCIPLES ? "Git 基本原则：已恢复默认"
        : `Git 基本原则：已更新（${text.length} 字）`,
    )
  }

  if (input.flowHubUrl !== undefined) {
    const v = input.flowHubUrl.trim()
    if (v && !parseHubRepoUrl(v)) return fail("共享空间地址无效：应该是存放共享模板的那个 GitLab 仓库的网址，例如 https://gitlab.example.com/group/flow-hub")
    patch.flowHubUrl = v
    summary.push(v ? `共享空间地址：${v}` : "共享空间地址：已清空")
  }
  if (input.flowHubToken !== undefined) {
    const t = checkSecret(input.flowHubToken, "共享空间 Token")
    if (!t.ok) return t
    patch.flowHubToken = t.value
    summary.push(t.value ? "共享空间 Token：已更新" : "共享空间 Token：已清除（改用 GitLab Token）")
  }
  if (input.flowHubAuthor !== undefined) {
    const v = input.flowHubAuthor.trim()
    if (v.length > AUTHOR_MAX) return fail(`共享空间署名最多 ${AUTHOR_MAX} 个字`)
    patch.flowHubAuthor = v
    summary.push(v ? `共享空间署名：${v}` : "共享空间署名：已清空")
  }

  if (!Object.keys(patch).length) return fail("没有要改的设置：settings 里至少给一项（worktree_root / git_principles / gitlab_host / gitlab_token / flow_hub_*）")
  return { ok: true, patch, summary, ...(mkdir ? { mkdir } : {}) }
}

/** AI 看到的设置现状：密钥只带打码后的样子，全文不出宿主 */
export interface ProjectSettingsView {
  /** 设置里填的项目存放位置；空 = 用默认位置 */
  worktreeRoot: string
  /** 实际生效的项目存放位置 */
  effectiveRoot: string
  gitlabHost: string
  gitlabTokenMasked: string
  /** 实际生效的 Git 基本原则全文；关闭时是空串 */
  gitPrinciples: string
  gitPrinciplesMode: "default" | "custom" | "off"
  flowHubUrl: string
  flowHubTokenMasked: string
  flowHubAuthor: string
  repoCount: number
  templateCount: number
  projectCount: number
}

/** 读 / 改设置的结果：多带一份现状（help 的「当前状态」要用） */
export type SettingsOutcome = { ok: true; message: string; view: ProjectSettingsView } | Fail

export function buildSettingsView(
  cfg: {
    worktreeRoot?: string
    gitlabHost?: string
    gitlabToken?: string
    gitPrinciples?: string
    flowHubUrl?: string
    flowHubToken?: string
    flowHubAuthor?: string
  },
  extra: { effectiveRoot: string; repoCount: number; templateCount: number; projectCount: number },
): ProjectSettingsView {
  const configured = cfg.gitPrinciples
  const text = configured === undefined || configured === null ? DEFAULT_GIT_PRINCIPLES : configured.replace(/\r\n/g, "\n").trim()
  return {
    worktreeRoot: (cfg.worktreeRoot ?? "").trim(),
    effectiveRoot: extra.effectiveRoot,
    gitlabHost: (cfg.gitlabHost ?? "").trim(),
    gitlabTokenMasked: maskSecret(cfg.gitlabToken),
    gitPrinciples: text,
    gitPrinciplesMode: !text ? "off" : text === DEFAULT_GIT_PRINCIPLES ? "default" : "custom",
    flowHubUrl: (cfg.flowHubUrl ?? "").trim(),
    flowHubTokenMasked: maskSecret(cfg.flowHubToken),
    flowHubAuthor: (cfg.flowHubAuthor ?? "").trim(),
    repoCount: extra.repoCount,
    templateCount: extra.templateCount,
    projectCount: extra.projectCount,
  }
}

// ── 常用代码仓库 ─────────────────────────────────────────────────────────

export interface RepoProfileLike {
  path: string
  baseBranch: string
  testBranch?: string
  developBranch?: string
  /** 只在「不克隆」时存 false；缺省 = 克隆 */
  clone?: boolean
}

export interface RepoSaveInput {
  repoPath: string
  baseBranch?: string
  testBranch?: string
  developBranch?: string
  clone?: boolean
}

export type RepoSavePlan =
  | {
      ok: true
      profile: RepoProfileLike
      /** 之前没登记过（新增）；否则是修改 */
      created: boolean
      /** 修改时变了哪几项（新增时为空） */
      changed: string[]
    }
  | Fail

/**
 * 登记 / 修改一个常用仓库：已经登记过的只改给了的项（测试 / 开发分支传空串 = 清掉）。
 * 本地仓库没给基线分支时用宿主探测到的默认分支；远程仓库没法探测，必须明确给。
 */
export function planRepoSave(
  input: RepoSaveInput,
  ctx: { isRemote: boolean; existing?: RepoProfileLike; detectedBaseBranch?: string },
): RepoSavePlan {
  const { existing } = ctx
  const given = input.baseBranch?.trim()
  const baseBranch = given || existing?.baseBranch?.trim() || ctx.detectedBaseBranch?.trim() || ""
  if (!baseBranch) {
    return fail(ctx.isRemote
      ? "远程仓库没法自动识别默认分支，请问用户基线分支（新分支从哪个分支切出，一般是 main / master）后再登记"
      : "没能识别这个仓库的默认分支，请问用户基线分支后再登记")
  }
  const pick = (v: string | undefined, old: string | undefined): string | undefined =>
    v === undefined ? old?.trim() || undefined : v.trim() || undefined
  const testBranch = pick(input.testBranch, existing?.testBranch)
  const developBranch = pick(input.developBranch, existing?.developBranch)

  if (ctx.isRemote && input.clone === false) {
    return fail("远程仓库本机没有副本，一定会克隆，不能设成不克隆")
  }
  const clone = ctx.isRemote ? true : (input.clone ?? existing?.clone) !== false

  const profile: RepoProfileLike = {
    path: input.repoPath,
    baseBranch,
    ...(testBranch ? { testBranch } : {}),
    ...(developBranch ? { developBranch } : {}),
    ...(clone ? {} : { clone: false }),
  }
  if (!existing) return { ok: true, profile, created: true, changed: [] }

  const changed: string[] = []
  if (existing.baseBranch.trim() !== baseBranch) changed.push(`基线分支 ${existing.baseBranch.trim() || "（空）"} → ${baseBranch}`)
  if ((existing.testBranch?.trim() || undefined) !== testBranch) changed.push(`测试分支 → ${testBranch ?? "（清空）"}`)
  if ((existing.developBranch?.trim() || undefined) !== developBranch) changed.push(`开发分支 → ${developBranch ?? "（清空）"}`)
  if ((existing.clone !== false) !== clone) changed.push(clone ? "改为建项时克隆副本" : "改为不克隆（AI 直接用本机这份）")
  return { ok: true, profile, created: false, changed }
}

// ── 项目模板（流程组） ───────────────────────────────────────────────────

/** 一个快捷操作的提示词最长多少字（它点一下就整段投进会话，别无限长） */
export const ACTION_PROMPT_MAX = 6000
/** 一个模板最多放几个快捷操作 */
export const TEMPLATE_ACTIONS_MAX = 30

export interface TemplateActionInput {
  /** 已有操作带它（保留原提示词、可改名 / 调顺序）；新增的不用给，自动生成 */
  id?: string
  label: string
  /** 点这个操作时交给 AI 的工作要求。已有操作不给 = 保持不变，给空串 = 恢复内置默认；新增的必须给 */
  prompt?: string
}

export interface TemplateSaveInput {
  name?: string
  description?: string
  /** 接不接代码仓库 */
  needsRepo?: boolean
  /** 接代码仓库时克隆副本停在哪个分支的默认值 */
  workBranch?: WorkBranchMode
  /** 建项时要用户填的信息；给了就是完整新列表 */
  fields?: ProjectFieldDef[]
  /** 快捷操作；给了就是完整新列表（顺序即展示顺序，没列出的已有操作会被删掉） */
  actions?: TemplateActionInput[]
}

export type TemplateSavePlan =
  | {
      ok: true
      /** 保存后的全部模板（整张表写回） */
      groups: ProjectNodeGroupDef[]
      group: ProjectNodeGroupDef
      created: boolean
      /** 这次被删掉的快捷操作名 */
      removedActions: string[]
      /** 这次新增的快捷操作名 */
      addedActions: string[]
    }
  | Fail

const BRANCH_MODE_VALUES: readonly string[] = WORK_BRANCH_MODES.map((m) => m.value)

function planActions(
  inputs: readonly TemplateActionInput[],
  current: readonly ProjectNodeDef[],
  idsInOtherTemplates: ReadonlySet<string>,
): { ok: true; nodes: ProjectNodeDef[]; removed: string[]; added: string[] } | Fail {
  if (!inputs.length) return fail("模板里至少要有一个快捷操作，否则用它建不了项目")
  if (inputs.length > TEMPLATE_ACTIONS_MAX) return fail(`一个模板最多 ${TEMPLATE_ACTIONS_MAX} 个快捷操作`)

  const used = new Set<string>()
  const labels = new Set<string>()
  const matched = new Set<string>()
  const nodes: ProjectNodeDef[] = []
  const added: string[] = []
  const taken = (): string[] => [...idsInOtherTemplates, ...used, ...current.map((n) => n.id)]

  for (let i = 0; i < inputs.length; i++) {
    const a = inputs[i]
    const label = (a.label ?? "").trim()
    const no = `第 ${i + 1} 个快捷操作`
    if (!label) return fail(`${no}缺少名称`)
    if (label.length > ACTION_LABEL_MAX) return fail(`「${label}」太长了：快捷操作名称不要超过 ${ACTION_LABEL_MAX} 个字`)
    if (labels.has(label)) return fail(`快捷操作「${label}」重复了，每个操作要有不同的名字`)
    labels.add(label)

    const id = (a.id ?? "").trim()
    let existing: ProjectNodeDef | undefined
    if (id) existing = current.find((n) => n.id === id)
    else existing = current.find((n) => n.label === label && !matched.has(n.id))
    if (existing && matched.has(existing.id)) return fail(`快捷操作 id「${existing.id}」用了两次`)
    if (id && !existing) return fail(`${no}「${label}」：这个模板里没有 id 为「${id}」的快捷操作（新增的操作不用给 id）`)

    const nodeId = existing ? existing.id : newOpaqueId(taken())
    used.add(nodeId)

    const prompt = a.prompt === undefined ? undefined : a.prompt.replace(/\r\n/g, "\n").trim()
    if (prompt !== undefined && prompt.length > ACTION_PROMPT_MAX) {
      return fail(`「${label}」的提示词太长了（${prompt.length} 字，最多 ${ACTION_PROMPT_MAX} 字），精简一下`)
    }

    if (existing) {
      matched.add(existing.id)
      const { prompt: oldPrompt, ...rest } = existing
      const next = prompt === undefined ? oldPrompt : prompt
      nodes.push({ ...rest, label, ...(next?.trim() ? { prompt: next } : {}) })
    } else {
      if (!prompt) {
        return fail(`新增的快捷操作「${label}」要写 prompt：点它的时候交给 AI 的工作要求（做什么、产出什么、成果放哪、缺信息怎么办）`)
      }
      nodes.push({ id: nodeId, label, ...(prompt ? { prompt } : {}) })
      added.push(label)
    }
  }
  const removed = current.filter((n) => !matched.has(n.id)).map((n) => n.label)
  return { ok: true, nodes, removed, added }
}

/**
 * 新建（不给 templateId）或修改（给了）一个项目模板。
 * 修改时只动给了的项；快捷操作和「要填的信息」一旦给了就是完整新列表。
 * 返回写回用的整张模板表：别的模板原样不动（包括共享空间的跟踪信息）。
 */
export function planTemplateSave(
  templateId: string | undefined,
  input: TemplateSaveInput,
  groups: readonly ProjectNodeGroupDef[],
): TemplateSavePlan {
  const id = (templateId ?? "").trim()
  const existing = id ? groups.find((g) => g.id === id) : undefined
  if (id && !existing) return fail(`没有 id 为「${id}」的模板（先用 templates 查看）`)
  if (!existing && !(input.name ?? "").trim()) return fail("新建模板要给 name（模板名称）")

  const others = groups.filter((g) => g.id !== existing?.id)
  const workspace: "plain" | "worktree" = input.needsRepo !== undefined
    ? (input.needsRepo ? "worktree" : "plain")
    : (existing ? existing.workspace ?? "worktree" : "plain")
  if (input.workBranch !== undefined) {
    if (!BRANCH_MODE_VALUES.includes(input.workBranch)) return fail(`work_branch 只能是 ${BRANCH_MODE_VALUES.join(" / ")}`)
    if (workspace !== "worktree") return fail("不接代码仓库的模板没有工作分支：要设 work_branch 请同时 needs_repo=true")
  }
  const draft: TemplateDraft = {
    name: input.name ?? existing?.name ?? "",
    description: input.description ?? existing?.description ?? "",
    workspace,
    branchMode: input.workBranch ?? existing?.branchMode,
    fields: input.fields ?? existing?.fields ?? [],
  }
  const problem = templateDraftProblem(draft, others.map((g) => g.name))
  if (problem) return fail(problem)

  const idsInOthers = new Set(others.flatMap((g) => g.nodes.map((n) => n.id)))
  let nodes: ProjectNodeDef[] | undefined
  let removedActions: string[] = []
  let addedActions: string[] = []
  if (input.actions !== undefined) {
    const planned = planActions(input.actions, existing?.nodes ?? [], idsInOthers)
    if (!planned.ok) return planned
    nodes = planned.nodes
    removedActions = planned.removed
    addedActions = planned.added
  }

  if (!existing) {
    const fresh = buildNewTemplate(draft, groups.map((g) => g.id), [...idsInOthers])
    const group: ProjectNodeGroupDef = { ...fresh, nodes: nodes ?? fresh.nodes }
    if (!nodes) addedActions = fresh.nodes.map((n) => n.label)
    return { ok: true, groups: [...groups, group], group, created: true, removedActions, addedActions }
  }
  const edited = applyTemplateEdit(existing, draft)
  const group: ProjectNodeGroupDef = { ...edited, nodes: nodes ?? existing.nodes }
  return { ok: true, groups: groups.map((g) => (g.id === existing.id ? group : g)), group, created: false, removedActions, addedActions }
}

export type TemplateDeletePlan =
  | { ok: true; groups: ProjectNodeGroupDef[]; removed: ProjectNodeGroupDef }
  | Fail

/** 删模板的规则和设置页一致：至少留一个；还有老项目（没有自己的快捷操作副本）在用的不能删 */
export function planTemplateDelete(
  templateId: string,
  groups: readonly ProjectNodeGroupDef[],
  usage: Record<string, number>,
): TemplateDeletePlan {
  const id = (templateId ?? "").trim()
  const target = groups.find((g) => g.id === id)
  if (!target) return fail(`没有 id 为「${id}」的模板（先用 templates 查看）`)
  if (groups.length <= 1) return fail("至少要保留 1 个项目模板")
  const count = usage[id] ?? 0
  if (count > 0) return fail(`还有 ${count} 个老项目在用「${target.name}」，先处理那些项目（归档、删除，或让它们改用别的模板）再删`)
  return { ok: true, groups: groups.filter((g) => g.id !== id), removed: target }
}

/** 模板详情（给 AI 看）：每个快捷操作的自定义提示词 / 内置默认提示词 */
export interface TemplateDetail {
  id: string
  name: string
  description: string
  needsRepo: boolean
  workBranch: WorkBranchMode
  fields: ProjectFieldDef[]
  actions: { id: string; label: string; customPrompt?: string; defaultPrompt?: string }[]
  /** 还有几个老项目（没有自己的快捷操作副本）直接跟着这个模板走 */
  usedByOldProjects: number
}

export function buildTemplateDetail(g: ProjectNodeGroupDef, usage: Record<string, number>): TemplateDetail {
  return {
    id: g.id,
    name: g.name,
    description: g.description ?? "",
    needsRepo: (g.workspace ?? "worktree") === "worktree",
    workBranch: g.branchMode ?? "new",
    fields: (g.fields ?? []).map((f) => ({ ...f })),
    actions: g.nodes.map((n) => {
      const custom = n.prompt?.trim()
      const def = (ACTION_GUIDES[n.id] ?? []).join("\n")
      return {
        id: n.id,
        label: n.label,
        ...(custom ? { customPrompt: n.prompt } : {}),
        ...(def ? { defaultPrompt: def } : {}),
      }
    }),
    usedByOldProjects: usage[g.id] ?? 0,
  }
}

// ── 已有项目 ─────────────────────────────────────────────────────────────

export interface ProjectUpdateInput {
  name?: string
  goal?: string
  storyUrl?: string
  relatedDocs?: string
  productDocUrl?: string
  techDocUrl?: string
  /** 项目信息（metadata）：合并写入，值为空串 = 删掉这一项 */
  info?: Record<string, string>
}

const INFO_KEY_MAX = 60

export type ProjectUpdatePlan = { ok: true; project: Project; changed: string[] } | Fail

/** 改项目资料：和设置页「项目」里的编辑一样，只改给了的项；不改目录、模板和会话 */
export function planProjectUpdate(p: Project, input: ProjectUpdateInput): ProjectUpdatePlan {
  const next: Project = { ...p }
  const changed: string[] = []

  if (input.name !== undefined) {
    const name = input.name.trim()
    if (!name) return fail("项目名称不能为空")
    if (name.length > PROJECT_NAME_MAX) return fail(`项目名称不要超过 ${PROJECT_NAME_MAX} 个字`)
    if (name !== p.name) { next.name = name; changed.push(`名称 → ${name}（项目目录名不会跟着改）`) }
  }
  // 给的和现在一样就不算改动（不写盘、也不告诉 AI「已更新」）
  const text = (label: string, value: string | undefined, current: string | undefined, apply: (v: string) => void): Fail | undefined => {
    if (value === undefined) return undefined
    const v = value.trim()
    if (v.length > PROJECT_TEXT_MAX) return fail(`${label}不要超过 ${PROJECT_TEXT_MAX} 个字`)
    if (v === (current ?? "")) return undefined
    apply(v)
    changed.push(v ? `${label}已更新` : `${label}已清空`)
    return undefined
  }
  const err =
    text("项目目标", input.goal, p.goal, (v) => { next.goal = v })
    ?? text("项目链接", input.storyUrl, p.storyUrl, (v) => { next.storyUrl = v || undefined })
    ?? text("相关文档", input.relatedDocs, p.relatedDocs, (v) => { next.relatedDocs = v || undefined })
    ?? text("产品文档", input.productDocUrl, p.productDocUrl, (v) => { next.productDocUrl = v || undefined })
    ?? text("技术文档", input.techDocUrl, p.techDocUrl, (v) => { next.techDocUrl = v || undefined })
  if (err) return err

  if (input.info && Object.keys(input.info).length) {
    const patch: Record<string, string> = {}
    for (const [rawKey, rawValue] of Object.entries(input.info)) {
      const key = rawKey.trim()
      if (!key) return fail("项目信息的名字不能为空")
      if (key.length > INFO_KEY_MAX) return fail(`项目信息的名字「${key.slice(0, 20)}…」太长了（最多 ${INFO_KEY_MAX} 个字）`)
      const value = String(rawValue ?? "").trim()
      if (value.length > PROJECT_TEXT_MAX) return fail(`「${key}」的内容不要超过 ${PROJECT_TEXT_MAX} 个字`)
      // 和现在一样、或者要删一个本来就没有的，都不算改动
      if (value === (p.metadata?.[key] ?? "")) continue
      patch[key] = value
    }
    if (Object.keys(patch).length) {
      next.metadata = p.metadata ? { ...p.metadata } : undefined
      mergeProjectMetadata(next, patch)
      for (const [k, v] of Object.entries(patch)) changed.push(v ? `信息「${k}」已更新` : `信息「${k}」已删除`)
    }
  }

  const given = Object.entries(input).some(([k, v]) => v !== undefined && !(k === "info" && !Object.keys(v as object).length))
  if (!given) return fail("没有要改的内容：给 name / goal / story_url / related_docs / fields 里的至少一项")
  return { ok: true, project: next, changed }
}
