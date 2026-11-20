import * as fs from "node:fs"
import * as path from "node:path"
import { randomBytes, randomUUID } from "node:crypto"
import {
  DEFAULT_NODE_GROUPS,
  DEFAULT_NODE_GROUP_ID,
  bindingsFromLegacy,
  legacyMirrorOf,
  normalizeWorkBranchMode,
  projectBoundToChannel,
  projectGroupChatMatches,
  projectMainBindings,
  type LegacyProjectBindingFields,
  type Project,
  type ProjectBinding,
  type ProjectNodeDef,
  type ProjectNodeGroupDef,
} from "./project-types.js"
import { parseChatKey } from "./channel-types.js"
import { migrateLegacyRepoFields } from "./project-repo-info.js"
import type { FlowHubHubTrack } from "./flow-hub-types.js"
import { cloneGroupPlain, normalizeFieldDefs } from "./project-templates.js"
import { writeJsonAtomic, readJsonFile } from "./atomic-json.js"
import type { FeishuProjectPickItem } from "./meegle-project-picker.js"

let baseDir = ""

export function initProjectStore(userDataDir: string): void {
  baseDir = path.join(userDataDir, "projects")
  ensureDir(baseDir)
  migrateLegacyProjectFilesOnce()
}

const LEGACY_MIGRATION_MARKER = ".repo-info-migrated"
/** 旧文件迁移的备份目录：迁之前把要改的项目文件原样拷一份进来，出问题可以手工还原 */
export const LEGACY_BACKUP_DIR = "backup-before-repo-info"
const LEGACY_FIELDS = ["repoPath", "baseBranch", "featureBranch", "repos", "workspaceType"]
const migratedDirs = new Set<string>()

/**
 * 一次性迁移：把还带着旧版仓库、分支字段（repoPath / baseBranch / featureBranch / repos / workspaceType）的项目文件
 * 改写成新版（折进项目信息）。迁之前先备份；做完写一个标记文件，以后不再扫描。
 * 即使没跑成也不影响使用：读项目时每次都会做同样的转换（见 normalizeProject），这里只是让旧字段尽早从文件里消失。
 */
function migrateLegacyProjectFilesOnce(): void {
  if (migratedDirs.has(baseDir)) return
  migratedDirs.add(baseDir)
  const marker = path.join(baseDir, LEGACY_MIGRATION_MARKER)
  if (fs.existsSync(marker)) return
  let allOk = true
  try {
    for (const f of fs.readdirSync(baseDir)) {
      if (!f.endsWith(".json") || f === "current.json") continue
      const fp = path.join(baseDir, f)
      try {
        const raw = readJsonSafe<(Project & Record<string, unknown>) | null>(fp, null)
        if (!raw || typeof raw.id !== "string") continue
        if (!LEGACY_FIELDS.some((k) => raw[k] !== undefined)) continue
        const backupDir = path.join(baseDir, LEGACY_BACKUP_DIR)
        ensureDir(backupDir)
        const backup = path.join(backupDir, f)
        if (!fs.existsSync(backup)) fs.copyFileSync(fp, backup)
        writeJson(fp, projectToDisk(normalizeProject(raw)))
      } catch {
        allOk = false
      }
    }
    if (allOk) fs.writeFileSync(marker, new Date().toISOString(), "utf-8")
  } catch { /* 读目录失败：下次启动再试 */ }
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
      // 只存非默认值：缺省就是「新建分支」，存量模板的文件内容和中心库哈希都不变
      ...(normalizeWorkBranchMode(g.branchMode) !== "new" ? { branchMode: normalizeWorkBranchMode(g.branchMode) } : {}),
      ...(typeof g.description === "string" && g.description.trim() ? { description: g.description.trim() } : {}),
      ...(normalizeFieldDefs(g.fields) ? { fields: normalizeFieldDefs(g.fields) } : {}),
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
    branchMode: c.branchMode,
    description: c.description,
    fields: c.fields,
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
  const groups = DEFAULT_NODE_GROUPS.map(cloneGroupPlain)
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
  return DEFAULT_NODE_GROUPS.map(cloneGroupPlain)
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
      group = cloneGroupPlain(dg)
      file.groups.push(group)
      changed = true
    }
    mark(`group:${dg.id}`)
    if (!group) { for (const n of dg.nodes) mark(n.id); continue }
    // 旧版本无 workspace 字段：按默认组补上（用户在新版设置页保存后字段固化，不再覆盖）。
    // 「测试」组以前是不接代码仓库的，老文件里缺这个字段的按老行为补，别悄悄变成接仓库；
    // branchMode 不补：只有全新安装的默认「测试」模板才自带，存量模板由用户自己在模板里打开
    if (group.workspace === undefined && dg.workspace) {
      group.workspace = dg.id === "test" ? "plain" : dg.workspace
      changed = true
    }
    // 旧版本没有模板说明：补上默认组的说明（只补空的，不覆盖用户写的）
    if (group.description === undefined && dg.description) {
      group.description = dg.description
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

type ProjectGroupRef = Pick<Project, "groupIds" | "groupId">

/** 项目实际使用的流程组：按绑定的模板 id 实时读全局模板，改模板立即对所有项目生效 */
export function projectGroups(p: ProjectGroupRef): ProjectNodeGroupDef[] {
  return projectGroupIds(p).map((id) => resolveNodeGroup(id))
}

/** 项目全部步骤（多组按顺序合并，同 id 只留第一个） */
export function projectNodes(p: ProjectGroupRef): ProjectNodeDef[] {
  const seen = new Set<string>()
  const out: ProjectNodeDef[] = []
  for (const g of projectGroups(p)) {
    for (const n of g.nodes) {
      if (seen.has(n.id)) continue
      seen.add(n.id)
      out.push(n)
    }
  }
  return out
}

/** 按项目找步骤：先找项目自己的流程组，再回落全局（历史产物的步骤可能已被改名/删除） */
export function projectNodeOf(p: ProjectGroupRef, nodeId: string): ProjectNodeDef | undefined {
  const own = projectNodes(p).find((n) => n.id === nodeId)
  if (own) return own
  return getProjectNode(nodeId, p.groupId)
}

export function projectNodeLabelOf(p: ProjectGroupRef, nodeId: string): string {
  return projectNodeOf(p, nodeId)?.label || nodeId
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

/**
 * 存量 actions[] → lastArtifact*；去掉运行态数组。
 * 旧版有 status（进行中 / 已暂停 / 已完成）：「已完成」按已归档读，其余当普通项目；读出来之后不再带这个字段，下次保存时从文件里消失。
 */
function normalizeProject(raw: Project & LegacyProjectBindingFields & { status?: unknown; watchBugs?: unknown }): Project {
  // status 是旧版的三态；watchBugs 是旧版「自动盯缺陷」的开关（功能已去掉）；groupSnapshot 是旧版建项时复制的模板副本（现在一律实时读模板）：老项目文件里留着的都不要了，下次保存时一并清掉
  const { status, watchBugs, groupSnapshot, sessionKey: legacySessionKey, notifyChatId: legacyNotify, groupChatId: legacyGroup, ...legacyRest } = raw
  // 旧版的仓库、分支字段折进项目信息（见 project-repo-info.ts）：读出来就是新形状，下次保存时旧字段从文件里消失
  const rest = migrateLegacyRepoFields(legacyRest)
  const p: Project = { ...rest }
  // 旧版只有一个入口（sessionKey / notifyChatId / groupChatId）：没有 bindings 才迁移，有了就只认 bindings
  if (!Array.isArray(p.bindings)) {
    p.bindings = bindingsFromLegacy(p.id, { sessionKey: legacySessionKey, notifyChatId: legacyNotify, groupChatId: legacyGroup })
  }
  if (status === "done" && !p.archivedAt) p.archivedAt = p.updatedAt || p.createdAt || Date.now()
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

/** 当前 chat 是否为某未归档项目的专属群（chatKey / 裸 chatId 皆可） */
export function findProjectByGroupChat(chatKey?: string): Project | undefined {
  if (!chatKey) return undefined
  return listProjects().find((p) => !p.archivedAt && projectGroupChatMatches(p, chatKey))
}

export function getProject(id: string): Project | undefined {
  if (!baseDir || !id) return undefined
  const raw = readJsonSafe<Project | undefined>(projectPath(id), undefined)
  return raw ? normalizeProject(raw) : undefined
}

/** 写盘的形状：Project 加上旧版的单入口字段（只为回退到旧版本时项目还认得会话和专属群，读文件时会被丢掉） */
function projectToDisk(p: Project): Project & LegacyProjectBindingFields {
  return { ...p, ...legacyMirrorOf(p) }
}

export function saveProject(project: Project): void {
  if (!baseDir) throw new Error("project store not initialized")
  const toSave = normalizeProject({ ...project, updatedAt: Date.now() })
  writeJson(projectPath(toSave.id), projectToDisk(toSave))
}

/**
 * 这个通道能管的项目：项目接入了它的主聊天或某个专属群（管理员在这个通道里用 AI 管项目看的是这份）。
 * 没有任何入口的项目谁的清单里都没有，只在设置页里看得到。
 */
export function listProjectsForChannel(channelId?: string): Project[] {
  if (!channelId) return []
  return listProjects().filter((p) => projectBoundToChannel(p, channelId))
}

/**
 * 这个聊天里看得到的项目（/p 菜单、/p ls、按序号或名字选项目、/p del 都只在这份里找）：
 * - 在某个项目的专属群里：只有这一个项目（群里看不到、也切不到别的项目，群成员未必是管理员）；
 * - 其余（主聊天）：接入了这个通道的项目。只接了专属群的项目也在里面（管理员要能删、能看），但主聊天里进不去它（见 canEnterProjectFromChat）。
 */
export function listProjectsForChat(chatKey?: string): Project[] {
  if (!chatKey) return []
  const grp = findProjectByGroupChat(chatKey)
  if (grp) return [grp]
  return listProjectsForChannel(parseChatKey(chatKey).channelId)
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
  clearCurrentProjectOf(id)
  return true
}

/** 归档 / 取消归档；已经是想要的状态时原样返回（不改归档时间）。项目不存在返回 undefined */
export function setProjectArchived(id: string, archived: boolean): Project | undefined {
  const p = getProject(id)
  if (!p) return undefined
  if (archived === !!p.archivedAt) return p
  if (archived) p.archivedAt = Date.now()
  else delete p.archivedAt
  saveProject(p)
  return getProject(id)
}

/**
 * 改项目名。项目名只有这一个字段：设置页的项目详情、对话页里项目会话的名字（会话名就是项目名）改的都是它。
 * 名字的规则（非空、长度）由调用方用 normalizeProjectName 校验，这里原样存。
 */
export function renameProject(id: string, name: string): Project | undefined {
  const p = getProject(id)
  if (!p) return undefined
  if (p.name === name) return p
  p.name = name
  saveProject(p)
  return getProject(id)
}

/** 文件刚改过的这段时间内不缓存：mtime 粒度粗（部分文件系统 1~2 秒）时，同大小的改写会被误认为没变 */
const ARCHIVED_CACHE_RACY_MS = 1500
const archivedCache = new Map<string, { mtimeNs: bigint; size: bigint; archived: boolean }>()

/**
 * 项目是否已归档。会话列表每隔几秒刷新一次，每个项目会话都要问一次，
 * 不能每次都把整个项目文件读出来解析（项目多了在主进程里同步读盘，随项目数线性变慢）。
 * 按文件的 mtime + 大小缓存：文件没动只 stat 一次；归档 / 取消归档会改文件，下一次就读到新值。
 * 项目不存在、文件读不出来都按「没归档」算，不缓存，下次再读。
 */
export function isProjectArchived(id: string): boolean {
  if (!baseDir || !id) return false
  const file = projectPath(id)
  let st: fs.BigIntStats
  try {
    st = fs.statSync(file, { bigint: true })
  } catch {
    archivedCache.delete(file)
    return false
  }
  const hit = archivedCache.get(file)
  if (hit && hit.mtimeNs === st.mtimeNs && hit.size === st.size) return hit.archived
  const p = getProject(id)
  if (!p) {
    archivedCache.delete(file)
    return false
  }
  const archived = !!p.archivedAt
  const ageMs = Date.now() - Number(st.mtimeNs / 1_000_000n)
  if (ageMs > ARCHIVED_CACHE_RACY_MS) archivedCache.set(file, { mtimeNs: st.mtimeNs, size: st.size, archived })
  else archivedCache.delete(file)
  return archived
}

/** 测试用：清掉归档缓存（测试会手写项目文件） */
export function resetProjectArchivedCacheForTests(): void {
  archivedCache.clear()
}

/**
 * 「当前项目」指针：按通道记，每个通道（它的主聊天）各有一个，互不影响。
 * 旧版全局只有一个 { id }：读的时候，那个项目接入了哪个通道的主聊天，就算哪个通道的当前项目；
 * 第一次写的时候落成按通道的形状，旧的 id 就没了。
 */
interface CurrentFile {
  id?: string
  byChannel?: Record<string, string>
}

/**
 * 「当前项目」属于通道的主聊天。聊天键认不出通道、或者是某个项目的专属群（含已归档项目的群）时返回 undefined：
 * 群里的项目由群自己认（findProjectByGroupChat），不碰通道的当前项目，否则群里的操作会把主聊天正在用的项目挤掉。
 */
function channelOfChat(chatKey?: string): string | undefined {
  if (!chatKey) return undefined
  if (listProjects().some((p) => projectGroupChatMatches(p, chatKey))) return undefined
  return parseChatKey(chatKey).channelId
}

function readCurrentByChannel(): Record<string, string> {
  const data = readJsonSafe<CurrentFile>(currentPath(), {})
  const byChannel: Record<string, string> = { ...(data.byChannel ?? {}) }
  if (data.id) {
    const legacy = getProject(data.id)
    if (legacy) for (const b of projectMainBindings(legacy)) if (b.channelId && !byChannel[b.channelId]) byChannel[b.channelId] = data.id
  }
  return byChannel
}

function writeCurrentByChannel(byChannel: Record<string, string>): void {
  if (!baseDir) throw new Error("project store not initialized")
  if (!Object.keys(byChannel).length) {
    if (fs.existsSync(currentPath())) fs.unlinkSync(currentPath())
    return
  }
  writeJson(currentPath(), { byChannel })
}

export function getCurrentProjectId(chatKey: string | undefined): string | null {
  const ch = channelOfChat(chatKey)
  if (!ch) return null
  return readCurrentByChannel()[ch] ?? null
}

/** 设置（id 为 null 就是清掉）这个聊天所在通道的当前项目；聊天键认不出通道就什么也不做 */
export function setCurrentProjectId(id: string | null, chatKey: string | undefined): void {
  if (!baseDir) throw new Error("project store not initialized")
  const ch = channelOfChat(chatKey)
  if (!ch) return
  const byChannel = readCurrentByChannel()
  if (id) byChannel[ch] = id
  else delete byChannel[ch]
  writeCurrentByChannel(byChannel)
}

/** 项目没了或归档了：所有通道里指向它的当前项目指针一并清掉 */
export function clearCurrentProjectOf(id: string): void {
  if (!baseDir) return
  const byChannel = readCurrentByChannel()
  let changed = false
  for (const [ch, pid] of Object.entries(byChannel)) {
    if (pid === id) { delete byChannel[ch]; changed = true }
  }
  const raw = readJsonSafe<CurrentFile>(currentPath(), {})
  if (changed || raw.id === id) writeCurrentByChannel(byChannel)
}

/** 这个聊天所在通道的当前项目；指针指着的项目已经没接入这个通道（解绑了）就当没有，不会越过隔离 */
export function getCurrentProject(chatKey: string | undefined): Project | undefined {
  const id = getCurrentProjectId(chatKey)
  const p = id ? getProject(id) : undefined
  return p && projectBoundToChannel(p, channelOfChat(chatKey)) ? p : undefined
}

export function createProject(input: Omit<Project, "id" | "archivedAt" | "createdAt" | "updatedAt" | "actions"> & {
  id?: string
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
    worktreePath: input.worktreePath,
    groupIds,
    groupId: groupIds[0],
    ...(input.externalWorkspace ? { externalWorkspace: true } : {}),
    ...(input.metadata && Object.keys(input.metadata).length ? { metadata: input.metadata } : {}),
    lastArtifactPath: input.lastArtifactPath,
    lastArtifactSummary: input.lastArtifactSummary,
    lastMrUrl: input.lastMrUrl,
    lastFeishuDocUrl: input.lastFeishuDocUrl,
    lastArtifactAt: input.lastArtifactAt,
    ...(input.bindings?.length ? { bindings: input.bindings } : {}),
    createdAt: now,
    updatedAt: now,
  }
  saveProject(project)
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
/**
 * 在给定的项目清单里按序号 / id / 名字找项目；不带 token 就取 current。
 * 清单要由调用方定：聊天里用 listProjectsForChat（只含接入了这个通道的），设置页管理才用全量 listProjects。
 */
export function resolveProjectRef(token: string | undefined, projects: Project[], current?: Project): Project | undefined {
  const list = projects
  if (!token) return current && list.some((p) => p.id === current.id) ? current : undefined
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
  | "feishu_pick"
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
  formFeishuPickItems?: FeishuProjectPickItem[]
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

