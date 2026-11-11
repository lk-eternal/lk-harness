// ── 应用内建项 / 项目信息面板：纯逻辑（桌面端、手机端、主进程共用，便于单测） ───────

import * as path from "node:path"
import {
  PROJECT_NAME_MAX,
  PROJECT_TEXT_MAX,
  isRemoteRepoUrl,
  repoPicksProblem,
  type ProjectCreateInput,
  type ProjectListItem,
  type ProjectRepoInput,
  type ProjectTemplateInfo,
  type ProjectView,
} from "./project-app-types.js"
import { channelIdFromSessionKey } from "./channel-types.js"
import {
  cloneGroupPlain,
  fieldValuesToMetadata,
  mergeGroupFields,
  missingRequiredFields,
  snapshotGroups,
} from "./project-templates.js"
import {
  DEFAULT_NODE_GROUP_ID,
  isPlainProject,
  projectRootDir,
  type Project,
  type ProjectNodeGroupDef,
} from "./project-types.js"

/** 全部流程组 → 建项模板列表 */
export function templateInfos(groups: ProjectNodeGroupDef[]): ProjectTemplateInfo[] {
  return groups.map((g) => ({
    id: g.id,
    name: g.name,
    description: g.description?.trim() ?? "",
    fields: (g.fields ?? []).map((f) => ({ ...f })),
    steps: g.nodes.map((n) => ({ id: n.id, label: n.label })),
    needsRepo: g.workspace !== "plain",
  }))
}

/**
 * 把手机网关收到的建项请求体整理成建项入参：只认字符串，其余一律丢掉；不接受 folder（手机选不了电脑里的文件夹）。
 * 内容对不对（仓库路径、分支名等）交给 planProjectCreate 校验，这里只管形状。
 */
export function parseGatewayCreateInput(raw: unknown): ProjectCreateInput {
  const o = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>
  const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined)
  const fields: Record<string, string> = {}
  if (o.fields && typeof o.fields === "object") {
    for (const [k, v] of Object.entries(o.fields as Record<string, unknown>)) {
      if (typeof v === "string") fields[k] = v
    }
  }
  const repos = Array.isArray(o.repos)
    ? (o.repos as unknown[]).map((r) => {
        const x = (r && typeof r === "object" ? r : {}) as Record<string, unknown>
        return { repoPath: str(x.repoPath) ?? "", baseBranch: str(x.baseBranch) ?? "" }
      })
    : undefined
  return {
    name: str(o.name) ?? "",
    goal: str(o.goal),
    templateId: str(o.templateId) ?? "",
    fields,
    repos,
    featureBranch: str(o.featureBranch),
    storyUrl: str(o.storyUrl),
    relatedDocs: str(o.relatedDocs),
  }
}

export type ProjectCreatePlan =
  | {
    ok: true
    name: string
    goal: string
    group: ProjectNodeGroupDef
    metadata: Record<string, string>
    /** 要接的代码仓库（已去掉两端空白）；不接代码仓库的模板为空 */
    repos: ProjectRepoInput[]
    /** 用户指定的 feature 分支；空串表示按默认规则生成 */
    featureBranch: string
    storyUrl?: string
    relatedDocs?: string
  }
  | { ok: false; error: string }

/** 校验建项输入并整理成要落盘的内容（不碰文件系统） */
export function planProjectCreate(input: ProjectCreateInput, groups: ProjectNodeGroupDef[]): ProjectCreatePlan {
  const name = (input.name ?? "").trim()
  if (!name) return { ok: false, error: "请填写项目名称" }
  if (name.length > PROJECT_NAME_MAX) return { ok: false, error: `项目名称不要超过 ${PROJECT_NAME_MAX} 个字` }
  const goal = (input.goal ?? "").trim()
  if (goal.length > PROJECT_TEXT_MAX) return { ok: false, error: `目标不要超过 ${PROJECT_TEXT_MAX} 个字` }

  const group = groups.find((g) => g.id === input.templateId)
  if (!group) return { ok: false, error: "模板不存在，请重新选择" }
  if (!group.nodes.length) return { ok: false, error: `模板「${group.name}」里还没有快捷操作` }

  const fields = mergeGroupFields([group])
  const missing = missingRequiredFields(fields, input.fields)
  if (missing.length) return { ok: false, error: `请填写：${missing.join("、")}` }
  const metadata = fieldValuesToMetadata(fields, input.fields)
  for (const [k, v] of Object.entries(metadata)) {
    if (v.length > PROJECT_TEXT_MAX) return { ok: false, error: `「${k}」不要超过 ${PROJECT_TEXT_MAX} 个字` }
  }

  const storyUrl = (input.storyUrl ?? "").trim()
  const relatedDocs = (input.relatedDocs ?? "").trim()
  if (storyUrl.length > PROJECT_TEXT_MAX) return { ok: false, error: `项目链接不要超过 ${PROJECT_TEXT_MAX} 个字` }
  if (relatedDocs.length > PROJECT_TEXT_MAX) return { ok: false, error: `相关文档不要超过 ${PROJECT_TEXT_MAX} 个字` }
  const links = { ...(storyUrl ? { storyUrl } : {}), ...(relatedDocs ? { relatedDocs } : {}) }

  // 不接代码仓库的模板：仓库和分支的输入一概不理，免得手滑多传的东西悄悄生效
  if (group.workspace === "plain") {
    return { ok: true, name, goal, group, metadata, repos: [], featureBranch: "", ...links }
  }

  const repos: ProjectRepoInput[] = []
  for (const r of input.repos ?? []) {
    const raw = String(r?.repoPath ?? "").trim()
    if (!raw) continue
    // 远程地址原样保留；本地路径必须是完整路径（相对路径会按应用的启动目录算，不是用户想的那个）
    if (!isRemoteRepoUrl(raw) && !path.isAbsolute(raw)) {
      return { ok: false, error: `本地仓库要写完整路径，或者填远程地址：${raw}` }
    }
    repos.push({
      repoPath: isRemoteRepoUrl(raw) ? raw : path.resolve(raw),
      baseBranch: String(r?.baseBranch ?? "").trim(),
    })
  }
  const problem = repoPicksProblem(repos)
  if (problem) return { ok: false, error: problem }
  const featureBranch = (input.featureBranch ?? "").trim()
  if (featureBranch.length > PROJECT_NAME_MAX * 2) return { ok: false, error: "feature 分支名太长了" }
  return { ok: true, name, goal, group, metadata, repos, featureBranch, ...links }
}

function pathKey(p: string): string {
  return path.resolve(p).replace(/[\\/]+$/, "").toLowerCase()
}

/** child 是 parent 本身或在它里面 */
export function isSameOrInside(child: string, parent: string): boolean {
  const c = pathKey(child)
  const p = pathKey(parent)
  return c === p || c.startsWith(p + path.sep)
}

export interface FolderCheckContext {
  /** 应用数据目录：既不能是它，也不能是它的上级（否则项目目录会把应用数据圈进去） */
  userDataDir: string
  /** 已有项目：名字 + 它占用的目录 */
  projects: { name: string; dir: string; external: boolean }[]
}

/** 校验用户选的已有文件夹能不能当项目目录；是否存在、是否目录由调用方查盘 */
export function checkExternalFolder(
  folder: string,
  ctx: FolderCheckContext,
): { ok: true; dir: string } | { ok: false; error: string } {
  const raw = (folder ?? "").trim()
  if (!raw || !path.isAbsolute(raw)) return { ok: false, error: "请选择一个有效的文件夹" }
  const dir = path.resolve(raw)
  if (path.parse(dir).root.toLowerCase() === dir.toLowerCase()) {
    return { ok: false, error: "不能把磁盘根目录当项目文件夹，请选一个具体的文件夹" }
  }
  if (isSameOrInside(ctx.userDataDir, dir)) {
    return { ok: false, error: "这个文件夹包含了应用自己的数据目录，请换一个" }
  }
  if (isSameOrInside(dir, ctx.userDataDir)) {
    return { ok: false, error: "不能使用应用自己的数据目录，请换一个" }
  }
  for (const p of ctx.projects) {
    if (!p.dir) continue
    if (isSameOrInside(dir, p.dir)) {
      return { ok: false, error: `这个文件夹已经属于项目「${p.name}」，请换一个` }
    }
    // 它包住了别人的目录：删项目时会连带波及
    if (isSameOrInside(p.dir, dir)) {
      return { ok: false, error: `这个文件夹里有项目「${p.name}」的目录，请换一个` }
    }
  }
  return { ok: true, dir }
}

function normalizedGroups(groups: ProjectNodeGroupDef[]): ProjectNodeGroupDef[] {
  return groups.map(cloneGroupPlain)
}

/**
 * 按全局模板刷新项目副本：副本里每个组，全局还有同 id 的就换成最新的，全局已删掉的保留原样。
 * 步骤和字段随模板走，项目里的 metadata 值不动。
 */
export function syncedSnapshot(
  snapshot: ProjectNodeGroupDef[],
  globals: ProjectNodeGroupDef[],
): ProjectNodeGroupDef[] {
  return snapshot.map((s) => {
    const g = globals.find((x) => x.id === s.id)
    return cloneGroupPlain(g ?? s)
  })
}

/** 项目副本和全局模板不一致（有可同步的内容） */
export function snapshotDiffers(snapshot: ProjectNodeGroupDef[], globals: ProjectNodeGroupDef[]): boolean {
  return JSON.stringify(normalizedGroups(snapshot)) !== JSON.stringify(syncedSnapshot(snapshot, globals))
}

export interface ProjectListItemDeps {
  /** 项目实际使用的流程组（副本优先） */
  groups: ProjectNodeGroupDef[]
  /** 全局流程组，判断能否同步 */
  globals: ProjectNodeGroupDef[]
}

/** 项目绑定的模板 id（去重，只留全局还存在的；一个都没有就回落默认模板）。和 project-store 的 projectGroupIds 同一条规则，只是模板表由调用方给 */
function resolveGroupIds(ids: readonly string[], globals: readonly ProjectNodeGroupDef[]): string[] {
  const uniq = [...new Set(ids.map((id) => String(id ?? "").trim()).filter(Boolean))]
  const valid = uniq.filter((id) => globals.some((g) => g.id === id))
  return valid.length ? valid : [DEFAULT_NODE_GROUP_ID]
}

export type ProjectGroupChange =
  | { ok: true; groupIds: string[]; groupId: string; changed: boolean; groupSnapshot?: ProjectNodeGroupDef[] }
  | { ok: false; error: string }

/**
 * 改项目的模板。模板真的换了、并且项目有自己的快捷操作副本时，才按所选模板重新复制一份；
 * 模板没变（比如只是改了项目名称，界面把当前模板原样传回来）不能动副本，否则每次保存都会把项目里改过的快捷操作冲掉。
 */
export function changeProjectGroups(
  p: Pick<Project, "groupIds" | "groupId" | "groupSnapshot">,
  ids: readonly string[],
  globals: readonly ProjectNodeGroupDef[],
): ProjectGroupChange {
  for (const raw of ids) {
    const id = String(raw ?? "").trim()
    if (id && !globals.some((g) => g.id === id)) return { ok: false, error: `项目模板不存在：${id}` }
  }
  const resolved = resolveGroupIds(ids, globals)
  const current = p.groupSnapshot?.length
    ? p.groupSnapshot.map((g) => g.id)
    : resolveGroupIds(p.groupIds?.length ? p.groupIds : (p.groupId ? [p.groupId] : []), globals)
  const changed = JSON.stringify(resolved) !== JSON.stringify(current)
  return {
    ok: true,
    groupIds: resolved,
    groupId: resolved[0],
    changed,
    ...(changed && p.groupSnapshot?.length
      ? { groupSnapshot: snapshotGroups(resolved.map((id) => globals.find((g) => g.id === id)!)) }
      : {}),
  }
}

/**
 * 每个全局模板有多少个项目还依赖它（删模板前要看这个）。
 * 有自己快捷操作副本的项目不依赖全局模板，删模板、改模板都不影响它，不算在用；
 * 一个项目绑了好几个模板，每个都算一次；没记模板的老项目算在默认模板头上。
 */
export function templateUsage(projects: readonly Pick<Project, "groupId" | "groupIds" | "groupSnapshot">[]): Record<string, number> {
  const usage: Record<string, number> = {}
  for (const p of projects) {
    if (p.groupSnapshot?.length) continue
    const ids = new Set((p.groupIds?.length ? p.groupIds : [p.groupId || DEFAULT_NODE_GROUP_ID]).filter(Boolean))
    for (const id of ids) usage[id] = (usage[id] ?? 0) + 1
  }
  return usage
}

/** 设置页项目列表里一个项目的资料：字段、快捷操作取自项目实际在用的模板 */
export function buildProjectListItem(p: Project, deps: ProjectListItemDeps): ProjectListItem {
  const seen = new Set<string>()
  const actions = deps.groups.flatMap((g) =>
    g.nodes
      .filter((n) => (seen.has(n.id) ? false : (seen.add(n.id), true)))
      .map((n) => ({ id: n.id, label: n.label })),
  )
  const refs = p.repos?.length ? p.repos.map((r) => r.repoPath) : [p.repoPath]
  return {
    id: p.id,
    name: p.name,
    goal: p.goal || "",
    ...(p.storyUrl ? { storyUrl: p.storyUrl } : {}),
    ...(p.relatedDocs ? { relatedDocs: p.relatedDocs } : {}),
    ...(p.productDocUrl ? { productDocUrl: p.productDocUrl } : {}),
    ...(p.techDocUrl ? { techDocUrl: p.techDocUrl } : {}),
    featureBranch: p.featureBranch || "",
    status: p.status,
    // 实际在用的模板（没记模板的老项目已经回落到默认模板），详情页据此勾选，不用再猜
    groupId: deps.groups[0]?.id,
    groupIds: deps.groups.map((g) => g.id),
    groupNames: deps.groups.map((g) => g.name),
    fields: mergeGroupFields(deps.groups).map((f) => ({ ...f })),
    actions,
    hasGroupSnapshot: !!p.groupSnapshot?.length,
    canSyncSteps: !!p.groupSnapshot?.length && snapshotDiffers(p.groupSnapshot, deps.globals),
    externalWorkspace: p.externalWorkspace === true,
    isCode: !isPlainProject(p),
    dir: projectRootDir(p) || p.worktreePath || "",
    ...(p.worktreePath ? { worktreePath: p.worktreePath } : {}),
    ...(p.repoPath ? { repoPath: p.repoPath } : {}),
    repoPaths: refs.filter(Boolean),
    ...(p.workspaceType ? { workspaceType: p.workspaceType } : {}),
    metadata: { ...(p.metadata ?? {}) },
    ...(p.groupChatId ? { groupChatId: p.groupChatId } : {}),
    watchBugs: p.watchBugs === true,
  }
}

/**
 * 项目归不归这个通道：按项目现在绑的会话（没有就看独立群、通知会话）所在的通道判断；
 * 从来没绑过任何会话的项目谁都可以认领。老版本飞书会话键没有通道前缀，认不出通道，一律算别人的。
 */
export function isProjectOwnedBy(
  p: Pick<Project, "sessionKey" | "groupChatId" | "notifyChatId">,
  channelId: string,
): boolean {
  const ref = p.sessionKey || p.groupChatId || p.notifyChatId
  if (!ref) return true
  return channelIdFromSessionKey(ref) === channelId
}

export interface ProjectViewDeps {
  /** 当前查看的通道，用来判断项目归不归它 */
  channelId: string
  /** 项目实际使用的流程组（副本优先） */
  groups: ProjectNodeGroupDef[]
  /** 全局流程组，判断能否同步 */
  globals: ProjectNodeGroupDef[]
  fileExists: (p: string) => boolean
}

/** 项目信息面板的数据 */
export function buildProjectView(p: Project, deps: ProjectViewDeps): ProjectView {
  const seen = new Set<string>()
  const steps = deps.groups.flatMap((g) =>
    g.nodes
      .filter((n) => (seen.has(n.id) ? false : (seen.add(n.id), true)))
      .map((n) => ({ id: n.id, label: n.label, group: g.name })),
  )
  const isCode = !isPlainProject(p)
  const dir = projectRootDir(p) || p.worktreePath || ""
  let artifact: ProjectView["artifact"]
  if (p.lastArtifactPath) {
    const abs = path.isAbsolute(p.lastArtifactPath)
      ? p.lastArtifactPath
      : path.join(p.worktreePath || dir, p.lastArtifactPath)
    artifact = {
      path: abs,
      name: path.basename(abs),
      ...(p.lastArtifactSummary ? { summary: p.lastArtifactSummary } : {}),
      ...(p.lastArtifactAt ? { at: p.lastArtifactAt } : {}),
      exists: deps.fileExists(abs),
    }
  }
  return {
    id: p.id,
    name: p.name,
    goal: p.goal || "",
    status: p.status,
    isCode,
    templateNames: deps.groups.map((g) => g.name),
    steps,
    info: Object.entries(p.metadata ?? {}).map(([key, value]) => ({ key, value })),
    ...(p.storyUrl ? { storyUrl: p.storyUrl } : {}),
    ...(p.relatedDocs ? { relatedDocs: p.relatedDocs } : {}),
    dir,
    externalDir: p.externalWorkspace === true,
    ...(artifact ? { artifact } : {}),
    ownedHere: isProjectOwnedBy(p, deps.channelId),
    canSyncSteps: !!p.groupSnapshot?.length && snapshotDiffers(p.groupSnapshot, deps.globals),
    ...(isCode && p.featureBranch ? { featureBranch: p.featureBranch } : {}),
  }
}
