// ── AI 管理项目相关配置（管理 MCP manage_project 的 settings / repo / template / get / update 等）──────
// 管理 MCP 跑在 daemon 进程里，配置（electron-store，密钥加密）和项目目录只有宿主能安全地写，所以这些请求经宿主通道
// （src/shared/host-rpc.ts）发过来，在这里落地。校验、合并、生成要保存的内容都在 src/shared/project-admin-plan.ts，
// 这里只做「读现状 → 交给 plan → 落盘」，规则和设置页里手动操作是同一套。
// 密钥只在宿主里出现：回给 AI 的永远是打码后的样子，日志里也只记改了哪几项，不记值。

import { app } from "electron"
import * as fs from "node:fs"
import * as path from "node:path"
import {
  findRepoProfile,
  getChannel,
  getConfig,
  getRepoProfiles,
  removeRepoProfile,
  saveConfig,
  upsertRepoProfiles,
  type AppConfig,
} from "./config-store"
import { inspectLocalRepo, isRemoteRepoRef, isValidBranchName } from "./project-worktree"
import { projectsRootDir } from "./project-workspace"
import { pushUiLog } from "./ui-logger"
import {
  buildProjectListItem,
  templateUsage,
} from "../src/shared/project-create-plan.js"
import {
  buildSettingsView,
  buildTemplateDetail,
  planProjectUpdate,
  planRepoSave,
  planSettingsSet,
  planTemplateDelete,
  planTemplateSave,
  type AdminOutcome,
  type ProjectSettingsView,
  type SettingsOutcome,
  type TemplateActionInput,
  type TemplateSaveInput,
} from "../src/shared/project-admin-plan.js"
import {
  formatProjectDetail,
  formatRepoRemoved,
  formatRepoSaved,
  formatSettings,
  formatTemplateDetail,
  formatTemplateSaved,
} from "../src/shared/project-admin-format.js"
import {
  getNodeGroups,
  getProject,
  initProjectStore,
  listProjects,
  projectGroups,
  saveNodeGroups,
  saveProject,
} from "../src/shared/project-store.js"
import type { Project, ProjectFieldDef, WorkBranchMode } from "../src/shared/project-types.js"

type Obj = Record<string, unknown>
const obj = (v: unknown): Obj => (v && typeof v === "object" && !Array.isArray(v) ? (v as Obj) : {})
const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined)
const bool = (v: unknown): boolean | undefined => (typeof v === "boolean" ? v : undefined)
const fail = (error: string): { ok: false; error: string } => ({ ok: false, error })

function ensureStore(): void {
  initProjectStore(app.getPath("userData"))
}

// ── 全局设置 ─────────────────────────────────────────────────────────────

export function readSettingsView(): ProjectSettingsView {
  ensureStore()
  const cfg = getConfig()
  return buildSettingsView(cfg, {
    effectiveRoot: projectsRootDir(),
    repoCount: getRepoProfiles(cfg).length,
    templateCount: getNodeGroups().length,
    projectCount: listProjects().length,
  })
}

export function getProjectSettings(): SettingsOutcome {
  const view = readSettingsView()
  return { ok: true, message: formatSettings(view), view }
}

export function setProjectSettings(payload: unknown): SettingsOutcome {
  const raw = obj(obj(payload).settings)
  const plan = planSettingsSet({
    worktreeRoot: str(raw.worktreeRoot),
    gitlabHost: str(raw.gitlabHost),
    gitlabToken: str(raw.gitlabToken),
    gitPrinciples: str(raw.gitPrinciples),
    resetGitPrinciples: bool(raw.resetGitPrinciples),
    flowHubUrl: str(raw.flowHubUrl),
    flowHubToken: str(raw.flowHubToken),
    flowHubAuthor: str(raw.flowHubAuthor),
  })
  if (!plan.ok) return plan
  if (plan.mkdir) {
    try {
      fs.mkdirSync(plan.mkdir, { recursive: true })
    } catch (e: unknown) {
      return fail(`无法创建目录 ${plan.mkdir}：${e instanceof Error ? e.message : String(e)}`)
    }
  }
  saveConfig(plan.patch as Partial<AppConfig>)
  // 日志只记改了哪几项，不记值（里面可能有密钥）
  pushUiLog("Project", "INFO", `[AiAdmin] AI 修改了项目设置：${Object.keys(plan.patch).join("、")}`)
  const view = readSettingsView()
  return {
    ok: true,
    message: ["✅ 已更新设置：", ...plan.summary.map((s) => `- ${s}`), "", formatSettings(view)].join("\n"),
    view,
  }
}

// ── 常用代码仓库 ─────────────────────────────────────────────────────────

const BRANCH_FIELDS: { key: "baseBranch" | "testBranch" | "developBranch"; label: string }[] = [
  { key: "baseBranch", label: "基线分支" },
  { key: "testBranch", label: "测试分支" },
  { key: "developBranch", label: "开发分支" },
]

export async function saveRepo(payload: unknown): Promise<AdminOutcome> {
  const raw = obj(obj(payload).repo)
  const given = (str(raw.repoPath) ?? "").trim()
  if (!given) return fail("repo.repo_path 必填：本地 git 仓库的根目录（绝对路径）或远程仓库地址")
  const isRemote = isRemoteRepoRef(given)
  if (!isRemote && !path.isAbsolute(given)) return fail("repo_path 要填本地仓库的绝对路径，或远程地址（https:// / ssh:// / git@）")

  const warnings: string[] = []
  let detectedBase: string | undefined
  let repoPath = given
  let localBranches: string[] = []
  if (!isRemote) {
    const inspected = await inspectLocalRepo(given)
    if (!inspected.ok) return fail(inspected.error)
    detectedBase = inspected.info.defaultBranch
    localBranches = inspected.info.branches
    repoPath = path.resolve(given)
  }

  const branches = { baseBranch: str(raw.baseBranch), testBranch: str(raw.testBranch), developBranch: str(raw.developBranch) }
  for (const { key, label } of BRANCH_FIELDS) {
    const name = branches[key]?.trim()
    if (!name) continue
    if (!(await isValidBranchName(name))) return fail(`${label}「${name}」不是合法的分支名`)
    if (!isRemote && localBranches.length && !localBranches.includes(name)) {
      warnings.push(`${label}「${name}」在这个本地仓库里没找到（可能还没 fetch），请和用户确认分支名没写错`)
    }
  }

  const existing = findRepoProfile(repoPath)
  const plan = planRepoSave(
    { repoPath: existing?.path ?? repoPath, ...branches, clone: bool(raw.clone) },
    { isRemote, existing, detectedBaseBranch: detectedBase },
  )
  if (!plan.ok) return plan
  // upsert 对没写 clone 的会沿用旧值；这里 plan 已经合并好了，明确写出来，免得「改回克隆」被旧的 false 顶回去
  upsertRepoProfiles([{ ...plan.profile, clone: plan.profile.clone ?? true }])
  pushUiLog("Project", "INFO", `[AiAdmin] AI ${plan.created ? "登记" : "修改"}了常用仓库 ${plan.profile.path}`)
  return { ok: true, message: [formatRepoSaved(plan, detectedBase), ...warnings.map((w) => `⚠️ ${w}`)].join("\n") }
}

export function removeRepo(payload: unknown): AdminOutcome {
  const given = (str(obj(obj(payload).repo).repoPath) ?? "").trim()
  if (!given) return fail("repo.repo_path 必填：要移除的仓库路径或地址（用 repos 查看）")
  const existing = findRepoProfile(given) ?? (isRemoteRepoRef(given) ? undefined : findRepoProfile(path.resolve(given)))
  if (!existing) return fail(`常用代码仓库里没有「${given}」（用 repos 查看现有的）`)
  const idx = getRepoProfiles().findIndex((p) => p.path === existing.path)
  const removed = idx >= 0 ? removeRepoProfile(idx + 1) : null
  if (!removed) return fail("移除失败：没在列表里找到这一项")
  pushUiLog("Project", "INFO", `[AiAdmin] AI 移除了常用仓库 ${removed.path}`)
  return { ok: true, message: formatRepoRemoved(removed) }
}

// ── 项目模板 ─────────────────────────────────────────────────────────────

export function templateDetail(payload: unknown): AdminOutcome {
  ensureStore()
  const p = obj(payload)
  const id = (str(p.templateId) ?? "").trim()
  const g = getNodeGroups().find((x) => x.id === id)
  if (!g) return fail(`没有 id 为「${id}」的模板（先用 templates 查看）`)
  const actionId = (str(p.actionId) ?? "").trim() || undefined
  if (actionId && !g.nodes.some((n) => n.id === actionId)) {
    return fail(`模板「${g.name}」里没有 id 为「${actionId}」的快捷操作（有：${g.nodes.map((n) => n.id).join("、")}）`)
  }
  return { ok: true, message: formatTemplateDetail(buildTemplateDetail(g, templateUsage(listProjects())), actionId) }
}

function parseFields(v: unknown): ProjectFieldDef[] | undefined {
  if (!Array.isArray(v)) return undefined
  return v.map((x) => {
    const f = obj(x)
    return {
      label: str(f.label) ?? "",
      ...(str(f.placeholder) ? { placeholder: str(f.placeholder) } : {}),
      ...(bool(f.multiline) ? { multiline: true } : {}),
      ...(bool(f.required) ? { required: true } : {}),
    }
  })
}

function parseActions(v: unknown): TemplateActionInput[] | undefined {
  if (!Array.isArray(v)) return undefined
  return v.map((x) => {
    const a = obj(x)
    return { id: str(a.id), label: str(a.label) ?? "", prompt: str(a.prompt) }
  })
}

export function saveTemplate(payload: unknown): AdminOutcome {
  ensureStore()
  const p = obj(payload)
  const t = obj(p.template)
  const input: TemplateSaveInput = {
    name: str(t.name),
    description: str(t.description),
    needsRepo: bool(t.needsRepo),
    // 不在这里洗成合法值：给错了让 planTemplateSave 明确报错，别悄悄变成「新建分支」
    workBranch: str(t.workBranch) as WorkBranchMode | undefined,
    fields: parseFields(t.fields),
    actions: parseActions(t.actions),
  }
  const plan = planTemplateSave(str(p.templateId), input, getNodeGroups())
  if (!plan.ok) return plan
  saveNodeGroups(plan.groups)
  pushUiLog("Project", "INFO", `[AiAdmin] AI ${plan.created ? "新建" : "修改"}了项目模板「${plan.group.name}」(${plan.group.id})`)
  return { ok: true, message: formatTemplateSaved(plan) }
}

export function deleteTemplate(payload: unknown): AdminOutcome {
  ensureStore()
  const id = (str(obj(payload).templateId) ?? "").trim()
  const plan = planTemplateDelete(id, getNodeGroups(), templateUsage(listProjects()))
  if (!plan.ok) return plan
  saveNodeGroups(plan.groups)
  pushUiLog("Project", "INFO", `[AiAdmin] AI 删除了项目模板「${plan.removed.name}」(${plan.removed.id})`)
  return {
    ok: true,
    message: `✅ 已删除项目模板「${plan.removed.name}」（${plan.removed.nodes.length} 个快捷操作一起删了）。已经建好的项目不受影响。现在还有 ${plan.groups.length} 个模板。`,
  }
}

// ── 已有项目 ─────────────────────────────────────────────────────────────

function projectOf(payload: unknown): { ok: true; project: Project } | { ok: false; error: string } {
  ensureStore()
  const id = (str(obj(payload).projectId) ?? "").trim()
  if (!id) return fail("需要 project_id（用 list 查看）")
  const p = getProject(id)
  if (!p) return fail(`没有 id 为「${id}」的项目（用 list 查看）`)
  return { ok: true, project: p }
}

export function getProjectDetail(payload: unknown): AdminOutcome {
  const r = projectOf(payload)
  if (!r.ok) return r
  const item = buildProjectListItem(r.project, { groups: projectGroups(r.project) })
  return { ok: true, message: formatProjectDetail(item, (id) => getChannel(id)?.name ?? id) }
}

export function updateProjectInfo(payload: unknown): AdminOutcome {
  const r = projectOf(payload)
  if (!r.ok) return r
  const u = obj(obj(payload).update)
  const info = obj(u.info)
  const plan = planProjectUpdate(r.project, {
    name: str(u.name),
    goal: str(u.goal),
    storyUrl: str(u.storyUrl),
    relatedDocs: str(u.relatedDocs),
    info: Object.keys(info).length ? Object.fromEntries(Object.entries(info).map(([k, v]) => [k, typeof v === "string" ? v : String(v ?? "")])) : undefined,
  })
  if (!plan.ok) return plan
  if (!plan.changed.length) return { ok: true, message: `ℹ️ 项目「${r.project.name}」没有变化（给的内容和现在一样）` }
  saveProject(plan.project)
  pushUiLog("Project", "INFO", `[AiAdmin] AI 修改了项目「${plan.project.name}」(${plan.project.id})：${plan.changed.length} 项`)
  return { ok: true, message: [`✅ 已更新项目「${plan.project.name}」(${plan.project.id})：`, ...plan.changed.map((c) => `- ${c}`)].join("\n") }
}

/** 归档要走 project-create 里的实现（和界面同一份）；那边反过来引用这个文件，所以靠注入避免循环引用 */
export interface ProjectAdminDeps {
  setArchived: (projectId: string, archived: boolean) => { ok: boolean; name?: string; error?: string }
}

export function createProjectAdminHandlers(deps: ProjectAdminDeps): Record<string, (payload: unknown) => unknown | Promise<unknown>> {
  return {
    "project.settings.get": () => getProjectSettings(),
    "project.settings.set": (payload) => setProjectSettings(payload),
    "project.repo.save": (payload) => saveRepo(payload),
    "project.repo.remove": (payload) => removeRepo(payload),
    "project.template.detail": (payload) => templateDetail(payload),
    "project.template.save": (payload) => saveTemplate(payload),
    "project.template.delete": (payload) => deleteTemplate(payload),
    "project.get": (payload) => getProjectDetail(payload),
    "project.update": (payload) => updateProjectInfo(payload),
    "project.archive": (payload): AdminOutcome => {
      const r = projectOf(payload)
      if (!r.ok) return r
      const archived = bool(obj(payload).archived)
      if (archived === undefined) return fail("archive 需要 archived=true（归档）或 false（取消归档）")
      const out = deps.setArchived(r.project.id, archived)
      if (!out.ok) return fail(out.error ?? "操作失败")
      pushUiLog("Project", "INFO", `[AiAdmin] AI ${archived ? "归档" : "取消归档"}了项目「${r.project.name}」(${r.project.id})`)
      return {
        ok: true,
        message: archived
          ? `✅ 已归档项目「${r.project.name}」：会话、聊天记录和成果都还在，只是收进「已归档」，不再认领飞书专属群。想恢复用 archived=false。`
          : `✅ 已取消归档项目「${r.project.name}」。`,
      }
    },
  }
}
