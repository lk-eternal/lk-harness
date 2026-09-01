import * as fs from "node:fs"
import * as path from "node:path"
import { randomBytes, randomUUID } from "node:crypto"
import { DEFAULT_NODE_GROUPS, DEFAULT_NODE_GROUP_ID, projectGroupChatMatches, type Project, type ProjectNodeDef, type ProjectNodeGroupDef } from "./project-types.js"
import type { FlowHubHubTrack } from "./flow-hub-types.js"
import { writeJsonAtomic, readJsonFile } from "./atomic-json.js"

let baseDir = ""

export function initProjectStore(userDataDir: string): void {
  baseDir = path.join(userDataDir, "projects")
  ensureDir(baseDir)
}

export function getProjectStoreDir(): string {
  return baseDir
}

// ── 流程组表（electron 设置页写，daemon MCP 读，共用一份文件） ──

function groupsPath(): string {
  return path.join(baseDir, "project-node-groups.json")
}

/** 旧版扁平节点表：仅迁移用 */
function legacyNodesPath(): string {
  return path.join(baseDir, "project-nodes.json")
}

const NODE_GROUP_ID_RE = /^[a-z][a-z0-9-]*$/

function pickHubTrack(item: FlowHubHubTrack): FlowHubHubTrack {
  const out: FlowHubHubTrack = {}
  if (item.hubId?.trim()) out.hubId = item.hubId.trim()
  if (typeof item.hubRevision === "number") out.hubRevision = item.hubRevision
  if (item.hubContentHash?.trim()) out.hubContentHash = item.hubContentHash.trim()
  if (typeof item.localRevision === "number") out.localRevision = item.localRevision
  return out
}

function sanitizeGroups(groups: ProjectNodeGroupDef[] | null | undefined): ProjectNodeGroupDef[] {
  return (groups ?? [])
    .filter((g) => g?.id?.trim() && g?.name?.trim())
    .map((g) => ({
      id: g.id.trim(),
      name: g.name.trim(),
      ...(g.workspace === "plain" || g.workspace === "worktree" ? { workspace: g.workspace } : {}),
      ...pickHubTrack(g),
      nodes: (g.nodes ?? []).filter((n) => n?.id?.trim() && n?.label?.trim())
        .map((n) => ({
          id: n.id.trim(),
          label: n.label.trim(),
          ...(n.prompt?.trim() ? { prompt: n.prompt } : {}),
          ...pickHubTrack(n),
        })),
    }))
}

function slugFromGroupName(name: string): string {
  let slug = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "")
  if (!slug || !/^[a-z]/.test(slug)) {
    slug = slug ? `g-${slug.replace(/^[^a-z0-9]*/i, "")}` : ""
  }
  slug = slug.replace(/[^a-z0-9-]/g, "").replace(/^-+|-+$/g, "")
  return NODE_GROUP_ID_RE.test(slug) ? slug.slice(0, 40) : ""
}

/** 解析单组导出 JSON；兼容 envelope 与裸 group 对象 */
export function parseNodeGroupExport(raw: unknown): ProjectNodeGroupDef | null {
  if (!raw || typeof raw !== "object") return null
  const obj = raw as Record<string, unknown>
  let candidate: unknown
  if (obj.kind === "lk-harness-node-group" && obj.group && typeof obj.group === "object") {
    candidate = obj.group
  } else if (typeof obj.id === "string" && typeof obj.name === "string" && Array.isArray(obj.nodes)) {
    candidate = obj
  } else {
    return null
  }
  const c = candidate as ProjectNodeGroupDef
  if (!c.name?.trim() || !Array.isArray(c.nodes)) return null
  const [group] = sanitizeGroups([{
    id: (c.id ?? "").trim() || "import",
    name: c.name,
    workspace: c.workspace === "plain" || c.workspace === "worktree" ? c.workspace : "worktree",
    nodes: c.nodes,
  }])
  if (!group) return null
  return {
    ...group,
    workspace: group.workspace === "plain" ? "plain" : "worktree",
  }
}

/** 生成不与已有组冲突的新 id（优先文件 id，冲突加 -2/-3…） */
export function resolveUniqueNodeGroupId(
  preferredId: string | undefined,
  name: string,
  existingIds: Iterable<string>,
): string {
  const used = new Set(existingIds)
  const pick = (base: string): string | null => {
    if (!NODE_GROUP_ID_RE.test(base)) return null
    if (!used.has(base)) return base
    for (let i = 2; i < 1000; i++) {
      const cand = `${base}-${i}`
      if (NODE_GROUP_ID_RE.test(cand) && !used.has(cand)) return cand
    }
    return null
  }
  const pref = preferredId?.trim()
  if (pref) {
    const hit = pick(pref)
    if (hit) return hit
  }
  const fromName = slugFromGroupName(name)
  if (fromName) {
    const hit = pick(fromName)
    if (hit) return hit
  }
  for (let i = 0; i < 100; i++) {
    const cand = `import-${randomBytes(4).toString("hex")}`
    if (!used.has(cand)) return cand
  }
  return `import-${randomUUID().replace(/-/g, "").slice(0, 8)}`
}

/** 旧扁平表 → 默认组结构：plan/build/review 的自定义覆盖到开发组，ship 丢弃，其余节点并入开发组 */
function migrateLegacyNodes(legacy: ProjectNodeDef[]): ProjectNodeGroupDef[] {
  const groups = DEFAULT_NODE_GROUPS.map((g) => ({ ...g, nodes: g.nodes.map((n) => ({ ...n })) }))
  const develop = groups.find((g) => g.id === DEFAULT_NODE_GROUP_ID) ?? groups[0]
  for (const n of legacy) {
    if (n.id === "ship") continue
    const exist = develop.nodes.find((d) => d.id === n.id)
    if (exist) {
      exist.label = n.label || exist.label
      if (n.prompt?.trim()) exist.prompt = n.prompt
    } else {
      develop.nodes.push({ id: n.id, label: n.label, ...(n.prompt?.trim() ? { prompt: n.prompt } : {}) })
    }
  }
  return groups
}

interface NodeGroupsFile {
  version: 2
  groups: ProjectNodeGroupDef[]
  /** 已播种过的默认节点/组 id（`group:<id>` 表示组）：新版本新增默认节点只补种一次，用户删除后不复活 */
  seeded: string[]
}

function cloneDefaultGroups(): ProjectNodeGroupDef[] {
  return DEFAULT_NODE_GROUPS.map((g) => ({ ...g, nodes: g.nodes.map((n) => ({ ...n })) }))
}

/** 兼容 v1 裸数组格式：视文件中已有的组/节点为「已播种」 */
function normalizeGroupsFile(raw: unknown): NodeGroupsFile | null {
  if (Array.isArray(raw)) {
    const groups = sanitizeGroups(raw as ProjectNodeGroupDef[])
    if (!groups.length) return null
    const seeded = groups.flatMap((g) => [`group:${g.id}`, ...g.nodes.map((n) => n.id)])
    return { version: 2, groups, seeded }
  }
  if (raw && typeof raw === "object" && Array.isArray((raw as NodeGroupsFile).groups)) {
    const f = raw as NodeGroupsFile
    const groups = sanitizeGroups(f.groups)
    if (!groups.length) return null
    return { version: 2, groups, seeded: Array.isArray(f.seeded) ? f.seeded : [] }
  }
  return null
}

/** 把默认表中「从未播种过」的组/节点补进存量配置（默认节点随版本演进，老用户升级可见） */
function seedMissingDefaults(file: NodeGroupsFile): boolean {
  let changed = false
  const seeded = new Set(file.seeded)
  const mark = (id: string) => { if (!seeded.has(id)) { seeded.add(id); changed = true } }
  for (const dg of DEFAULT_NODE_GROUPS) {
    let group = file.groups.find((g) => g.id === dg.id)
    if (!group && !seeded.has(`group:${dg.id}`)) {
      group = { ...dg, nodes: dg.nodes.map((n) => ({ ...n })) }
      file.groups.push(group)
      changed = true
    }
    mark(`group:${dg.id}`)
    if (!group) { for (const n of dg.nodes) mark(n.id); continue }
    // 旧版本无 workspace 字段：按默认组补上（用户在新版设置页保存后字段固化，不再覆盖）
    if (group.workspace === undefined && dg.workspace) {
      group.workspace = dg.workspace
      changed = true
    }
    for (const n of dg.nodes) {
      if (!group.nodes.some((x) => x.id === n.id) && !seeded.has(n.id)) {
        group.nodes.push({ ...n })
        changed = true
      }
      mark(n.id)
    }
  }
  if (changed) file.seeded = [...seeded]
  return changed
}

export function getNodeGroups(): ProjectNodeGroupDef[] {
  if (!baseDir) return cloneDefaultGroups()
  const file = normalizeGroupsFile(readJsonSafe<unknown>(groupsPath(), null))
  if (file) {
    if (seedMissingDefaults(file)) writeJson(groupsPath(), file)
    return file.groups
  }
  const legacy = readJsonSafe<ProjectNodeDef[] | null>(legacyNodesPath(), null)
  const migrated = legacy?.length
    ? migrateLegacyNodes(legacy.filter((n) => n?.id?.trim() && n?.label?.trim()))
    : cloneDefaultGroups()
  const fresh: NodeGroupsFile = {
    version: 2,
    groups: migrated,
    seeded: migrated.flatMap((g) => [`group:${g.id}`, ...g.nodes.map((n) => n.id)]),
  }
  seedMissingDefaults(fresh)
  writeJson(groupsPath(), fresh)
  return fresh.groups
}

export function saveNodeGroups(groups: ProjectNodeGroupDef[]): void {
  if (!baseDir) throw new Error("project store not initialized")
  const prev = normalizeGroupsFile(readJsonSafe<unknown>(groupsPath(), null))
  // 显式保存 = 用户对完整默认表做过取舍：默认组/节点全部视为已播种，删掉的不再复活
  const defaultsSeeded = DEFAULT_NODE_GROUPS.flatMap((g) => [`group:${g.id}`, ...g.nodes.map((n) => n.id)])
  writeJson(groupsPath(), {
    version: 2,
    groups: sanitizeGroups(groups),
    seeded: [...new Set([...(prev?.seeded ?? []), ...defaultsSeeded])],
  } satisfies NodeGroupsFile)
}

/** 按组 id 解析流程组；缺省/失配回落默认组（再回落第一组） */
export function resolveNodeGroup(groupId?: string): ProjectNodeGroupDef {
  const groups = getNodeGroups()
  return groups.find((g) => g.id === groupId)
    ?? groups.find((g) => g.id === DEFAULT_NODE_GROUP_ID)
    ?? groups[0]
}

export function getProjectNodes(groupId?: string): ProjectNodeDef[] {
  return resolveNodeGroup(groupId).nodes
}

/** 组内优先，其次全组检索（历史 action 的节点可能已换组/删除） */
export function getProjectNode(id: string, groupId?: string): ProjectNodeDef | undefined {
  const inGroup = resolveNodeGroup(groupId).nodes.find((n) => n.id === id)
  if (inGroup) return inGroup
  for (const g of getNodeGroups()) {
    const hit = g.nodes.find((n) => n.id === id)
    if (hit) return hit
  }
  return undefined
}

export function projectNodeLabel(id: string, groupId?: string): string {
  return getProjectNode(id, groupId)?.label || id
}

/** 项目绑定的流程组 id（去重、过滤无效 id，至少回落默认组） */
export function projectGroupIds(p: Pick<Project, "groupIds" | "groupId">): string[] {
  const raw = p.groupIds?.length
    ? [...new Set(p.groupIds.map((id) => id?.trim()).filter(Boolean) as string[])]
    : (p.groupId?.trim() ? [p.groupId.trim()] : [])
  const valid = raw.filter((id) => getNodeGroups().some((g) => g.id === id))
  return valid.length ? valid : [DEFAULT_NODE_GROUP_ID]
}

function ensureDir(dir: string): void {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
}

function projectPath(id: string): string {
  return path.join(baseDir, `${id}.json`)
}

function currentPath(): string {
  return path.join(baseDir, "current.json")
}

function readJsonSafe<T>(filePath: string, fallback: T): T {
  try {
    return readJsonFile(filePath, fallback);
  } catch {
    return fallback;
  }
}

function writeJson(filePath: string, data: unknown): void {
  writeJsonAtomic(filePath, data)
}

/** 存量 actions[] → lastArtifact*；去掉运行态数组 */
function normalizeProject(raw: Project): Project {
  const p = { ...raw }
  if (!p.lastArtifactPath && Array.isArray(p.actions) && p.actions.length) {
    const accepted = [...p.actions].reverse().find((a) => a.status === "accepted" && a.artifactPath)
    const any = accepted || [...p.actions].reverse().find((a) => a.artifactPath)
    if (any?.artifactPath) {
      p.lastArtifactPath = any.artifactPath
      p.lastArtifactSummary = any.summary
      p.lastMrUrl = any.mrUrl
      p.lastFeishuDocUrl = any.feishuDocUrl
      p.lastArtifactAt = any.completedAt || any.startedAt
    }
  }
  delete p.actions
  return p
}

export function listProjects(): Project[] {
  if (!baseDir || !fs.existsSync(baseDir)) return []
  return fs.readdirSync(baseDir)
    .filter((f) => f.endsWith(".json") && f !== "current.json")
    .map((f) => readJsonSafe<Project | null>(path.join(baseDir, f), null))
    .filter((p): p is Project => !!p && typeof p.id === "string")
    .map(normalizeProject)
    .sort((a, b) => b.updatedAt - a.updatedAt)
}

/** 当前 chat 是否为某活跃项目的专属群（chatKey / 裸 chatId 皆可） */
export function findProjectByGroupChat(chatKey?: string): Project | undefined {
  if (!chatKey) return undefined
  return listProjects().find((p) => p.status !== "done" && projectGroupChatMatches(p, chatKey))
}

export function getProject(id: string): Project | undefined {
  if (!baseDir || !id) return undefined
  const raw = readJsonSafe<Project | undefined>(projectPath(id), undefined)
  return raw ? normalizeProject(raw) : undefined
}

export function saveProject(project: Project): void {
  if (!baseDir) throw new Error("project store not initialized")
  const toSave = normalizeProject({ ...project, updatedAt: Date.now() })
  writeJson(projectPath(toSave.id), toSave)
}

export function deleteProject(id: string): boolean {
  const fp = projectPath(id)
  if (!fs.existsSync(fp)) return false
  // 软删除：移入 trash，避免误删后无法恢复元数据
  const trashDir = path.join(baseDir, "trash")
  ensureDir(trashDir)
  const trashFp = path.join(trashDir, `${id}.${Date.now()}.json`)
  try {
    fs.renameSync(fp, trashFp)
  } catch {
    fs.copyFileSync(fp, trashFp)
    fs.unlinkSync(fp)
  }
  const cur = getCurrentProjectId()
  if (cur === id) setCurrentProjectId(null)
  return true
}

export function getCurrentProjectId(): string | null {
  const data = readJsonSafe<{ id?: string }>(currentPath(), {})
  return data.id ?? null
}

export function setCurrentProjectId(id: string | null): void {
  if (!baseDir) throw new Error("project store not initialized")
  if (!id) {
    if (fs.existsSync(currentPath())) fs.unlinkSync(currentPath())
    return
  }
  writeJson(currentPath(), { id })
}

export function getCurrentProject(): Project | undefined {
  const id = getCurrentProjectId()
  return id ? getProject(id) : undefined
}

export function createProject(input: Omit<Project, "id" | "status" | "createdAt" | "updatedAt" | "actions"> & {
  id?: string
  status?: Project["status"]
}): Project {
  const now = Date.now()
  const groupIds = projectGroupIds(input)
  const project: Project = {
    id: input.id ?? randomUUID().replace(/-/g, "").slice(0, 12),
    name: input.name,
    goal: input.goal,
    storyUrl: input.storyUrl,
    relatedDocs: input.relatedDocs,
    productDocUrl: input.productDocUrl,
    techDocUrl: input.techDocUrl,
    repoPath: input.repoPath,
    baseBranch: input.baseBranch,
    featureBranch: input.featureBranch,
    worktreePath: input.worktreePath,
    repos: input.repos,
    groupIds,
    groupId: groupIds[0],
    workspaceType: input.workspaceType,
    status: input.status ?? "active",
    lastArtifactPath: input.lastArtifactPath,
    lastArtifactSummary: input.lastArtifactSummary,
    lastMrUrl: input.lastMrUrl,
    lastFeishuDocUrl: input.lastFeishuDocUrl,
    lastArtifactAt: input.lastArtifactAt,
    sessionKey: input.sessionKey,
    notifyChatId: input.notifyChatId,
    groupChatId: input.groupChatId,
    createdAt: now,
    updatedAt: now,
  }
  saveProject(project)
  setCurrentProjectId(project.id)
  return project
}

/** merge metadata KV；空字符串 value 删 key */
export function mergeProjectMetadata(project: Project, patch: Record<string, string>): void {
  if (!patch || !Object.keys(patch).length) return
  const meta = { ...(project.metadata ?? {}) }
  for (const [k, v] of Object.entries(patch)) {
    if (!k.trim()) continue
    if (v === "") delete meta[k]
    else meta[k] = v
  }
  if (Object.keys(meta).length) project.metadata = meta
  else delete project.metadata
}

/** 登记最近产物（供后续节点注入上下文）；不发消息、不推进流程 */
export function registerArtifact(
  projectId: string,
  opts: { artifactPath: string; summary?: string; mrUrl?: string; feishuDocUrl?: string },
): { ok: true; project: Project } | { ok: false; error: string } {
  const project = getProject(projectId)
  if (!project) return { ok: false, error: "项目不存在" }
  project.lastArtifactPath = opts.artifactPath
  if (opts.summary !== undefined) project.lastArtifactSummary = opts.summary
  if (opts.mrUrl !== undefined) project.lastMrUrl = opts.mrUrl
  if (opts.feishuDocUrl !== undefined) project.lastFeishuDocUrl = opts.feishuDocUrl
  project.lastArtifactAt = Date.now()
  saveProject(project)
  return { ok: true, project }
}
export function resolveProjectRef(token: string | undefined, projects?: Project[]): Project | undefined {
  const list = projects ?? listProjects()
  if (!token) return getCurrentProject()
  // 仅纯数字才当序号；hex id（如 3d2abd629656）绝不能 parseInt——否则会变成 3 误删第 3 项
  if (/^\d+$/.test(token)) {
    const idx = Number.parseInt(token, 10)
    if (idx >= 1 && idx <= list.length) return list[idx - 1]
  }
  const byId = list.find((p) => p.id === token)
  if (byId) return byId
  const byName = list.filter((p) => p.name === token)
  return byName.length === 1 ? byName[0] : undefined
}

/** /p new 交互向导草稿（按 chatKey） */
export type ProjectNewStep =
  | "form"
  | "setup_worktree"
  | "setup_add_path"
  | "setup_add_base"
  | "setup_add_test"
  | "setup_add_dev"
  | "setup_gitlab_token"
  | "setup_gitlab_host"

export interface ProjectNewDraft {
  chatKey: string
  step: ProjectNewStep
  name?: string
  repoPath?: string
  baseBranch?: string
  testBranch?: string
  developBranch?: string
  featureBranch?: string
  goal?: string
  storyUrl?: string
  /** 创建项目卡片：settings 快照 + 会话内追加 */
  formMode?: "main" | "add_repo"
  formRepoProfiles?: { path: string; baseBranch: string; testBranch?: string; developBranch?: string }[]
  formExtraRepos?: { path: string; baseBranch: string; testBranch?: string; developBranch?: string }[]
  formCache?: Record<string, string>
  /** 仅 /p setup，完成后不进入创建 */
  setupOnly?: boolean
  /** setup 子流程结束后回到 setup 总览 */
  returnToSetup?: boolean
  updatedAt: number
}

function pendingNewPath(): string {
  return path.join(baseDir, "pending-new.json")
}

export function getProjectNewDraft(chatKey: string): ProjectNewDraft | undefined {
  if (!baseDir || !chatKey) return undefined
  const all = readJsonSafe<Record<string, ProjectNewDraft>>(pendingNewPath(), {})
  return all[chatKey]
}

export function saveProjectNewDraft(draft: ProjectNewDraft): void {
  if (!baseDir) throw new Error("project store not initialized")
  const all = readJsonSafe<Record<string, ProjectNewDraft>>(pendingNewPath(), {})
  draft.updatedAt = Date.now()
  all[draft.chatKey] = draft
  writeJson(pendingNewPath(), all)
}

export function clearProjectNewDraft(chatKey: string): void {
  if (!baseDir || !chatKey) return
  const all = readJsonSafe<Record<string, ProjectNewDraft>>(pendingNewPath(), {})
  if (!all[chatKey]) return
  delete all[chatKey]
  writeJson(pendingNewPath(), all)
}

export function hasProjectNewDraft(chatKey: string): boolean {
  const d = getProjectNewDraft(chatKey)
  return !!d && d.step !== "form"
}

