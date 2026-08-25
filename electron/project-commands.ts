import * as fs from "node:fs"
import * as path from "node:path"
import { app, shell } from "electron"
import { getConfig, saveConfig, getRepoProfiles, upsertRepoProfiles, removeRepoProfile } from "./config-store"
import { reportCommandResult, type CommandButton } from "./command-handler"
import { buildSessionCardTitle } from "../src/shared/session-label.js"
import {
  createProject,
  deleteProject,
  getCurrentProject,
  getProject,
  getProjectStoreDir,
  initProjectStore,
  listProjects,
  resolveProjectRef,
  setCurrentProjectId,
  registerArtifact,
  getProjectNewDraft,
  saveProjectNewDraft,
  clearProjectNewDraft,
  getNodeGroups,
  resolveNodeGroup,
  projectNodeLabel,
  projectGroupIds,
  findProjectByGroupChat,
  type ProjectNewDraft,
} from "../src/shared/project-store.js"
import { repoShortName,
  projectSessionKey,
  projectWorktrees,
  projectRepoRefs,
  projectRootDir,
  isPlainProject,
  canEnterProjectFromChat,
  projectGroupChatMatches,
  parseExistingGroupChatBinding,
  normalizeProjectChatMode,
  PROJECT_RESERVED_SUBCOMMANDS,
  type Project,
  type ProjectActionType,
  type ProjectChatMode,
  type ProjectWorkspaceType,
} from "../src/shared/project-types.js"
import {
  addProjectClone, ensureArtifactDir, isUsableRepoRef, isRemoteRepoRef, removeProjectWorktree,
  ensureCheckouts, syncCheckout, worktreeDirtyCount, unpushedCount,
} from "./project-worktree"
import { buildProjectSessionPrompt, buildActionPrompt } from "./project-prompts"
import { findMergeRequest } from "./project-gitlab"
import { syncArtifactToFeishu } from "./project-feishu-sync"
import { httpPost, syncActiveSession, enqueueToSession, getCurrentActiveSession } from "./daemon-client"
import { pushUiLog } from "./ui-logger"
import { leaveProjectSession, formatCurrentSessionBlock } from "./session-dispatcher"
import { parseChatKey, chatIdFromSessionKey, channelIdFromSessionKey } from "../src/shared/channel-types.js"

/** 当前 chat 是哪个独立群项目的专属群（有则返回该项目） */
function resolveBoundGroupProject(chatId?: string): Project | undefined {
  if (!chatId) return undefined
  return listProjects().find((p) => p.status !== "done" && projectGroupChatMatches(p, chatId))
}

/** 独立群内优先按 groupChatId 解析项目；否则用全局 current 指针 */
function resolveProjectForChat(chatId?: string): Project | undefined {
  return resolveBoundGroupProject(chatId) ?? getCurrentProject()
}

/**
 * 当前 chat 能否进入/切换到该项目：
 * - 已在某独立群内：只能操作本群绑定项目（禁止切其它项目）
 * - 私聊/普通群：独立群项目不可进
 */
function canOperateProjectInChat(project: Pick<Project, "id" | "groupChatId">, chatId?: string): boolean {
  const bound = resolveBoundGroupProject(chatId)
  if (bound) return bound.id === project.id
  return canEnterProjectFromChat(project, chatId)
}

const GROUP_ONLY_HINT = "该项目为独立群协作，请到专属群内进入与推进（私聊禁止，避免串台）"
const GROUP_LOCK_HINT = "当前为项目专属群，仅可协作本群项目，不能切换其它项目"

function mergedProjectNodeIds(p?: Project): string[] {
  const cur = p ?? getCurrentProject()
  const ids: string[] = []
  const seen = new Set<string>()
  for (const gid of projectGroupIds(cur ?? {})) {
    for (const n of resolveNodeGroup(gid).nodes) {
      if (!seen.has(n.id)) { seen.add(n.id); ids.push(n.id) }
    }
  }
  return ids
}

function projectHasNode(p: Project | undefined, nodeId: string): boolean {
  if (!p) return false
  for (const gid of projectGroupIds(p)) {
    if (resolveNodeGroup(gid).nodes.some((n) => n.id === nodeId)) return true
  }
  return false
}

function projectHelpText(): string {
  const nodeIds = mergedProjectNodeIds().join("|")
  return [
    "💡 /p 项目指令",
    "🔹 /p — 打开项目菜单",
    "🔹 /p info — 查看项目详细信息",
    "🔹 /p new — 新建项目",
    "🔹 /p ls — 列出全部项目",
    "🔹 /p use <序号|id> — 进入指定项目",
    "🔹 /p leave — 退出当前项目，回到主会话",
    "🔹 /c main — 快速切回主会话（不清项目选中态）",
    `🔹 /p ${nodeIds} — 推进项目节点`,
    "🔹 /p setup — 配置项目工作区与主仓",
    "🔹 /p del <序号|id> — 删除项目（连带移除 AI 工作目录）",
  ].join("\n")
}

function ensureStore(): void {
  initProjectStore(app.getPath("userData"))
}

function defaultFeatureBranch(name: string): string {
  const d = new Date()
  const yy = String(d.getFullYear()).slice(-2)
  const mm = String(d.getMonth() + 1).padStart(2, "0")
  const dd = String(d.getDate()).padStart(2, "0")
  return `feature/${yy}${mm}${dd}-${slugify(name)}`
}

function slugify(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fa5_-]+/gi, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40) || `p${Date.now().toString(36)}`
}

/** 同名项目 worktree 目录去重：被现有项目占用则追加 -2/-3… */
function uniqueProjectSlug(name: string): string {
  const base = slugify(name)
  const used = new Set<string>()
  for (const p of listProjects()) {
    const wts = p.repos?.length ? p.repos.map((r) => r.worktreePath) : [p.worktreePath]
    for (const wt of wts) {
      if (!wt) continue
      // 新规则 root/<slug>/<repo> 取父层；旧规则 root/<slug> 取本层
      used.add(path.basename(path.dirname(wt)).toLowerCase())
      used.add(path.basename(wt).toLowerCase())
    }
  }
  if (!used.has(base.toLowerCase())) return base
  for (let i = 2; i < 100; i++) {
    const cand = `${base}-${i}`
    if (!used.has(cand.toLowerCase())) return cand
  }
  return `${base}-${Date.now().toString(36)}`
}

function formatProjectCard(p: Project, index?: number): string {
  const root = projectRootDir(p)
  const gitLines = isPlainProject(p)
    ? [`🗂 纯会话型`, `📁 项目目录: ${root || p.worktreePath}`]
    : [
      `🌿 feature: ${p.featureBranch}`,
      root ? `📁 项目目录: ${root}` : "",
      ...(p.repos && p.repos.length
        ? p.repos.map((r, i) => {
            const tags = [`base=${r.baseBranch}`, r.testBranch ? `test=${r.testBranch}` : "", r.developBranch ? `dev=${r.developBranch}` : ""].filter(Boolean).join(" ")
            const sub = p.repos!.length > 1 ? `\n   📂 ${repoShortName(r.repoPath)}` : ""
            return `📦#${i + 1} ${r.repoPath}\n   ${tags}${sub}`
          })
        : [`base=${p.baseBranch}`]),
    ]
  const groupLine = projectGroupIds(p)
    .map((id) => resolveNodeGroup(id).name)
    .filter(Boolean)
    .join("、")
  const lines = [
    index != null ? `📦 项目 #${index} · ${p.name}` : `📦 项目 · ${p.name}`,
    `🆔 ${p.id}`,
    groupLine ? `🏷 流程组: ${groupLine}` : "",
    `📝 ${p.goal}`,
    p.storyUrl ? `🔗 项目链接 · ${p.storyUrl}` : "",
    p.relatedDocs ? `📄 相关文档 · ${p.relatedDocs}` : "",
    !p.relatedDocs && p.productDocUrl ? `📘 产品文档 · ${p.productDocUrl}` : "",
    !p.relatedDocs && p.techDocUrl ? `📗 技术文档 · ${p.techDocUrl}` : "",
    ...(p.metadata && Object.keys(p.metadata).length
      ? ["📋 metadata", ...Object.entries(p.metadata).map(([k, v]) => `   ${k}: ${v}`)]
      : []),
    ...gitLines,
    `💠 ${p.status}`,
    p.lastArtifactPath ? `📄 artifact · ${p.lastArtifactPath}` : "📄 尚无产物",
    p.lastFeishuDocUrl ? `📘 飞书 · ${p.lastFeishuDocUrl}` : "",
    p.lastMrUrl ? `🔀 MR · ${p.lastMrUrl}` : "",
  ]
  return lines.filter(Boolean).join("\n")
}

/** 节点推进按钮（建项卡 / 项目会话共用） */
function projectNodeButtons(p?: Project): CommandButton[] {
  const proj = p ?? getCurrentProject()
  const btns: CommandButton[] = []
  for (const gid of projectGroupIds(proj ?? {})) {
    const group = resolveNodeGroup(gid)
    for (const n of group.nodes) {
      btns.push({ label: n.label, cmd: `/p ${n.id}`, section: group.name })
    }
  }
  return btns
}

/** 建项完成卡：不含回主会话/退出（尚未进入或群模式不适用） */
function projectButtonsCreate(p?: Project): CommandButton[] {
  return [
    ...projectNodeButtons(p),
    { label: "项目详细信息", cmd: "/p info", section: "其他" },
  ]
}

/** 已进入项目会话后的操作卡；独立群模式不展示回主会话/退出（群内无主会话可回） */
function projectButtons(p?: Project, chatId?: string): CommandButton[] {
  const base = projectButtonsCreate(p)
  const proj = p ?? getCurrentProject()
  if (proj?.groupChatId) {
    return [...base, { label: "帮助", cmd: "/p help", section: "其他" }]
  }
  return [
    ...base,
    { label: "全部项目", cmd: "/p ls", section: "其他" },
    { label: "回主会话", cmd: "/c main", section: "其他" },
    { label: "退出项目", cmd: "/p leave", section: "其他" },
  ]
}

/** 项目卡色条用项目名/分支，避免仍显示普通会话目录 */
function projectCardTitle(p: Project) {
  return buildSessionCardTitle({ project: p })
}

function withChatFooter(text: string, footer = "也可直接发消息，在项目会话里继续聊"): string {
  return `${text}\n\n---\n${footer}`
}

/** 进入项目会话（懒加载）：确保 AI 工作目录就绪（缺失重建、检出 feature、同步远程新提交），再落元数据与消息路由 */
async function enterProjectSession(
  port: number,
  chatId: string,
  project: Project,
): Promise<{ ok: boolean; error?: string; notes?: string[] }> {
  if (!canOperateProjectInChat(project, chatId)) {
    return { ok: false, error: resolveBoundGroupProject(chatId) ? GROUP_LOCK_HINT : GROUP_ONLY_HINT }
  }
  const notes: string[] = []
  if (!isPlainProject(project)) {
    const refs = projectRepoRefs(project)
    if (refs.length) {
      for (const r of refs) {
        if (!fs.existsSync(r.worktreePath)) notes.push(`🔧 ${path.basename(r.worktreePath)}: 目录缺失，正在重建`)
      }
      const co = await ensureCheckouts(refs, project.featureBranch)
      if (!co.ok) return { ok: false, error: co.error }
      for (const r of refs) {
        const s = await syncCheckout(r.worktreePath, project.featureBranch)
        if (s.note) notes.push(s.note)
      }
      for (const wt of projectWorktrees(project)) {
        if (fs.existsSync(wt)) await ensureArtifactDir(wt)
      }
    } else if (project.worktreePath) {
      if (!fs.existsSync(project.worktreePath)) {
        try { fs.mkdirSync(project.worktreePath, { recursive: true }) } catch (e: any) {
          return { ok: false, error: e?.message || "无法创建工作目录" }
        }
      }
      await ensureArtifactDir(project.worktreePath)
    }
  }
  // 独立群：会话绑在群 chat；沿用会话：必须与当前进入的 chat/通道一致（防恢复数据绑错通道导致 active 被拒）
  let sessionKey: string
  if (project.groupChatId) {
    sessionKey = project.sessionKey || projectSessionKey(project.groupChatId, project.id)
  } else {
    const expected = projectSessionKey(chatId, project.id)
    const prev = project.sessionKey
    const prevChat = prev ? chatIdFromSessionKey(prev) : ""
    const prevCh = prev ? channelIdFromSessionKey(prev) : undefined
    const enterCh = parseChatKey(chatId).channelId
    const stale = !prev || prevChat !== chatId || (prevCh && enterCh && prevCh !== enterCh)
    sessionKey = stale ? expected : prev
    if (stale && prev && prev !== expected) {
      notes.push(`🔧 已纠正会话绑定（原通道与当前不一致）`)
    }
  }
  project.sessionKey = sessionKey
  // 独立群通知/路由固定绑群，禁止被私聊进入改写
  project.notifyChatId = project.groupChatId || chatId
  // leave 挂起的项目重新激活（调度器恢复自动拉起）
  if (project.status === "paused") project.status = "active"
  const { saveProject } = await import("../src/shared/project-store.js")
  saveProject(project)
  const bound = await syncActiveSession(port, chatId, sessionKey)
  if (!bound) {
    return { ok: false, error: `无法将当前会话切到项目（跨通道或路由拒绝）：${sessionKey}` }
  }
  return { ok: true, notes }
}

/** AI 工作目录不可用（克隆失败/存量 worktree 分支被占用等）时的用户提示 */
function featureOccupiedText(p: Project, detail: string): string {
  return [
    `❌ 无法进入项目「${p.name}」：AI 工作目录不可用`,
    detail,
    "",
    "排除故障（网络/权限/分支占用）后重试即可，缺失的目录会自动重建",
  ].join("\n")
}

interface NewProjectInput {
  chatKey?: string
  name?: string
  goal?: string
  repoPath?: string
  baseBranch?: string
  featureBranch?: string
  storyUrl?: string
  relatedDocs?: string
  productDocUrl?: string
  techDocUrl?: string
  worktreeRootOverride?: string
  groupId?: string
  groupIds?: string[]
  workspaceType?: ProjectWorkspaceType
  /** 会话模式：group=独立群（默认）；inline=沿用当前会话；bind=绑定已有群 */
  chatMode?: ProjectChatMode
  /** bind 模式：已有群 chat_id（oc_… 或 ch_|oc_） */
  existingGroupChatId?: string
  /** 表单提交人 open_id：独立群模式建群时设为群主并拉入群 */
  operatorOpenId?: string
  repos?: { repoPath: string; baseBranch: string; testBranch?: string; developBranch?: string }[]
}

/** 飞书群描述上限 100 字：优先写 feature + 分支映射 */
function projectGroupDescription(project: Project): string {
  const bits: string[] = []
  if (project.featureBranch?.trim()) bits.push(project.featureBranch.trim())
  const r0 = project.repos?.[0]
  const base = (r0?.baseBranch || project.baseBranch || "").trim()
  const test = (r0?.testBranch || "").trim()
  const dev = (r0?.developBranch || "").trim()
  const map = [
    base ? `base=${base}` : "",
    test ? `test=${test}` : "",
    dev ? `dev=${dev}` : "",
  ].filter(Boolean)
  if (map.length) bits.push(map.join(" "))
  if ((project.repos?.length ?? 0) > 1) bits.push(`+${(project.repos!.length) - 1}仓`)
  const text = bits.join(" · ") || (project.goal || "").trim()
  return text.slice(0, 100)
}

/** 独立群模式：建项目专属群并把项目会话/通知绑定到群；失败由调用方回退当前会话模式 */
async function setupProjectGroup(
  port: number,
  project: Project,
  chatId: string,
  operatorOpenId?: string,
): Promise<{ ok: boolean; chatKey?: string; error?: string }> {
  if (!operatorOpenId) return { ok: false, error: "缺少操作者 open_id（文本建项暂不支持独立群）" }
  try {
    const r = await httpPost(`http://127.0.0.1:${port}/create-project-group`, {
      name: `📦 ${project.name}`,
      description: projectGroupDescription(project),
      channelId: parseChatKey(chatId).channelId,
      ownerOpenId: operatorOpenId,
    }, 15000) as { ok?: boolean; chatKey?: string; error?: string } | null
    if (!r?.ok || !r.chatKey) return { ok: false, error: r?.error || "建群失败" }
    project.groupChatId = r.chatKey
    project.notifyChatId = r.chatKey
    project.sessionKey = projectSessionKey(r.chatKey, project.id)
    const { saveProject } = await import("../src/shared/project-store.js")
    saveProject(project)
    // 群模式项目不抢占主会话的当前项目指针
    setCurrentProjectId(null)
    return { ok: true, chatKey: r.chatKey }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

/** 绑定已有飞书群为项目专属群（用户需自行将机器人拉入群） */
function bindProjectGroup(
  project: Project,
  operatorChatId: string,
  existingInput: string,
): { ok: boolean; chatKey?: string; rawChatId?: string; error?: string } {
  const channelId = parseChatKey(operatorChatId).channelId
  const parsed = parseExistingGroupChatBinding(existingInput, channelId || "")
  if ("error" in parsed) return { ok: false, error: parsed.error }
  const taken = findProjectByGroupChat(parsed.chatKey)
  if (taken && taken.id !== project.id) {
    return { ok: false, error: `该群已绑定项目「${taken.name}」(${taken.id})` }
  }
  project.groupChatId = parsed.chatKey
  project.notifyChatId = parsed.chatKey
  project.sessionKey = projectSessionKey(parsed.chatKey, project.id)
  return { ok: true, chatKey: parsed.chatKey, rawChatId: parsed.rawChatId }
}

async function persistBoundProjectGroup(project: Project): Promise<void> {
  const { saveProject } = await import("../src/shared/project-store.js")
  saveProject(project)
  setCurrentProjectId(null)
}

/** 绑定已有群模式：写入 groupChatId 并通知群/私聊 */
async function finishBindGroupModeCreate(
  port: number,
  messageId: string,
  chatId: string,
  project: Project,
  existingGroupChatId: string,
  extraNote?: string,
): Promise<{ ok: true; rawChatId: string } | { ok: false; error: string }> {
  const bound = bindProjectGroup(project, chatId, existingGroupChatId)
  if (!bound.ok || !bound.chatKey || !bound.rawChatId) {
    const error = bound.error || "绑定群失败"
    pushUiLog("Electron", "WARN", `[Project] 绑定已有群失败: ${error}`)
    return { ok: false, error }
  }
  await persistBoundProjectGroup(project)
  const groupHint = "请确认已将机器人拉入该群，否则群内无法收发消息"
  try {
    await reportCommandResult(
      port,
      "",
      true,
      "",
      bound.chatKey,
      projectButtonsCreate(project),
      { cardTitle: projectCardTitle(project), sessionKey: project.sessionKey },
    )
  } catch (e) {
    pushUiLog("Electron", "WARN", `[Project] 绑定群通知发送失败（可能机器人未入群）: ${e}`)
  }
  await leaveProjectSession(port, chatId)
  await reportCommandResult(
    port,
    messageId,
    true,
    [
      `✅ 项目「${project.name}」已创建`,
      `🔗 已绑定群 \`${bound.rawChatId}\``,
      `📣 ${groupHint}`,
    ].join("\n"),
    chatId,
    [{ label: "项目菜单", cmd: "/p" }],
  )
  return { ok: true, rawChatId: bound.rawChatId }
}

/** 群模式建项收尾：项目卡发进群 + 主会话回执；失败时带回错误原因供回退提示 */
async function finishGroupModeCreate(
  port: number,
  messageId: string,
  chatId: string,
  project: Project,
  operatorOpenId?: string,
  extraNote?: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const g = await setupProjectGroup(port, project, chatId, operatorOpenId)
  if (!g.ok || !g.chatKey) {
    const error = g.error || "建群失败"
    pushUiLog("Electron", "WARN", `[Project] 独立群创建失败，回退当前会话: ${error}`)
    return { ok: false, error }
  }
  await reportCommandResult(
    port,
    "",
    true,
    "",
    g.chatKey,
    projectButtonsCreate(project),
    { cardTitle: projectCardTitle(project), sessionKey: project.sessionKey },
  )
  await leaveProjectSession(port, chatId)
  await reportCommandResult(
    port,
    messageId,
    true,
    [
      `✅ 项目「${project.name}」已创建`,
      `📣 独立群「📦 ${project.name}」已建好并拉你入群，后续协作请到群里进行`,
    ].join("\n"),
    chatId,
    [{ label: "项目菜单", cmd: "/p" }],
  )
  return { ok: true }
}

/** 纯会话型项目：不建 worktree，自动创建独立会话目录 */
async function finalizePlainProject(
  port: number,
  messageId: string,
  chatId: string | undefined,
  draft: NewProjectInput,
): Promise<void> {
  if (!draft.name) {
    await reportCommandResult(port, messageId, false, "❌ 创建信息不完整（名称必填）", chatId)
    return
  }
  const cfg = getConfig()
  const root = (draft.worktreeRootOverride || cfg.worktreeRoot || "").trim()
    || path.join(app.getPath("userData"), "claw-projects")
  const projectSlug = uniqueProjectSlug(draft.name)
  const workDir = path.join(root, projectSlug, "workspace")
  try {
    if (!fs.existsSync(workDir)) fs.mkdirSync(workDir, { recursive: true })
    const project = createProject({
      name: draft.name,
      goal: draft.goal || "",
      storyUrl: draft.storyUrl,
      relatedDocs: draft.relatedDocs,
      productDocUrl: draft.productDocUrl,
      techDocUrl: draft.techDocUrl,
      repoPath: "",
      baseBranch: "",
      featureBranch: "",
      worktreePath: workDir,
      groupIds: draft.groupIds,
      groupId: draft.groupId,
      workspaceType: "plain",
      notifyChatId: chatId,
    })
    if (chatId) {
      project.sessionKey = projectSessionKey(chatId, project.id)
      const { saveProject } = await import("../src/shared/project-store.js")
      saveProject(project)
    }
    await ensureArtifactDir(workDir)
    if (draft.chatKey) clearProjectNewDraft(draft.chatKey)
    let fallbackNote = ""
    if (draft.chatMode === "bind" && chatId) {
      if (!draft.existingGroupChatId?.trim()) {
        await reportCommandResult(port, messageId, false, "❌ 绑定已有群时请填写群 chat_id（oc_…）", chatId)
        return
      }
      const bindResult = await finishBindGroupModeCreate(port, messageId, chatId, project, draft.existingGroupChatId)
      if (bindResult.ok) return
      fallbackNote = `\n⚠️ 绑定已有群失败，已回退当前会话模式\n原因：${bindResult.error}`
    } else if (draft.chatMode !== "inline" && chatId) {
      const groupResult = await finishGroupModeCreate(port, messageId, chatId, project, draft.operatorOpenId)
      if (groupResult.ok) return
      fallbackNote = `\n⚠️ 独立群创建失败，已回退当前会话模式\n原因：${groupResult.error}`
    }
    if (chatId && canEnterProjectFromChat(project, chatId)) {
      await enterProjectSession(port, chatId, project)
      if (!project.groupChatId) setCurrentProjectId(project.id)
    }
    const note = fallbackNote ? fallbackNote.replace(/^\n/, "") : undefined
    await replyProjectWorkspace(port, messageId, project, chatId, undefined, note)
  } catch (e: any) {
    await reportCommandResult(port, messageId, false, `❌ 创建失败: ${e?.message || e}`, chatId)
  }
}

async function finalizeNewProject(
  port: number,
  messageId: string,
  chatId: string | undefined,
  draft: NewProjectInput,
): Promise<void> {
  if (draft.workspaceType === "plain") {
    await finalizePlainProject(port, messageId, chatId, draft)
    return
  }
  const cfg = getConfig()
  const worktreeRoot = (draft.worktreeRootOverride || cfg.worktreeRoot || "").trim()
    || path.join(app.getPath("userData"), "claw-projects")
  const repos = (draft.repos && draft.repos.length)
    ? draft.repos
    : (draft.repoPath && draft.baseBranch
      ? [{ repoPath: draft.repoPath, baseBranch: draft.baseBranch }]
      : [])
  if (!draft.name) {
    await reportCommandResult(port, messageId, false, "❌ 创建信息不完整（名称必填）", chatId)
    return
  }
  if (!draft.goal) draft.goal = ""
  for (const r of repos) {
    if (!(await isUsableRepoRef(r.repoPath))) {
      await reportCommandResult(port, messageId, false, `❌ 主仓无效（须是本地 git 根目录或远程仓库地址）: ${r.repoPath}`, chatId)
      return
    }
  }
  if (worktreeRoot !== cfg.worktreeRoot && draft.worktreeRootOverride) {
    saveConfig({ worktreeRoot })
  }
  if (repos.length) {
    upsertRepoProfiles(repos.map((r) => ({
      path: r.repoPath,
      baseBranch: r.baseBranch,
      testBranch: r.testBranch,
      developBranch: r.developBranch,
    })))
  }

  const featureBranch = repos.length
    ? (draft.featureBranch || defaultFeatureBranch(draft.name)).trim()
    : ""
  const projectSlug = uniqueProjectSlug(draft.name)
  const projectRepos: { repoPath: string; baseBranch: string; testBranch?: string; developBranch?: string; worktreePath: string }[] = []
  const wtErrors: string[] = []

  if (repos.length) {
    for (const r of repos) {
      const short = repoShortName(r.repoPath)
      const worktreePath = path.join(worktreeRoot, projectSlug, short)
      const wt = await addProjectClone({
        repoPath: r.repoPath,
        worktreePath,
        featureBranch,
        baseBranch: r.baseBranch,
      })
      if (!wt.ok) wtErrors.push(`${short}: ${wt.error}`)
      projectRepos.push({
        repoPath: r.repoPath,
        baseBranch: r.baseBranch,
        testBranch: r.testBranch,
        developBranch: r.developBranch,
        worktreePath,
      })
    }
  } else {
    const worktreePath = path.join(worktreeRoot, projectSlug, "workspace")
    try {
      if (!fs.existsSync(worktreePath)) fs.mkdirSync(worktreePath, { recursive: true })
    } catch (e: any) {
      await reportCommandResult(port, messageId, false, `❌ 无法创建工作目录: ${e?.message || e}`, chatId)
      return
    }
    projectRepos.push({
      repoPath: "",
      baseBranch: "",
      worktreePath,
    })
  }

  const primary = projectRepos[0]
  let persisted = false
  try {
    const project = createProject({
      name: draft.name,
      goal: draft.goal,
      storyUrl: draft.storyUrl,
      relatedDocs: draft.relatedDocs,
      productDocUrl: draft.productDocUrl,
      techDocUrl: draft.techDocUrl,
      repoPath: primary.repoPath,
      baseBranch: primary.baseBranch,
      featureBranch,
      worktreePath: primary.worktreePath,
      repos: repos.length ? projectRepos : undefined,
      groupIds: draft.groupIds,
      groupId: draft.groupId,
      workspaceType: "worktree",
      notifyChatId: chatId,
    })
    persisted = true
    if (chatId) {
      project.sessionKey = projectSessionKey(chatId, project.id)
      const { saveProject } = await import("../src/shared/project-store.js")
      saveProject(project)
    }
    // 仅对已建成的目录建产物目录：提前 mkdir 会让懒重建误判 AI 工作目录已存在
    for (const r of projectRepos) {
      if (fs.existsSync(r.worktreePath)) await ensureArtifactDir(r.worktreePath)
    }
    if (draft.chatKey) clearProjectNewDraft(draft.chatKey)
    const wtWarn = wtErrors.length
      ? ["⚠️ AI 工作目录初始化未完成：", ...wtErrors.map((e) => `· ${e}`), "排除故障后推进节点即自动重建。"].join("\n")
      : undefined
    let fallbackNote = ""
    if (draft.chatMode === "bind" && chatId) {
      if (!draft.existingGroupChatId?.trim()) {
        await reportCommandResult(port, messageId, false, "❌ 绑定已有群时请填写群 chat_id（oc_…）", chatId)
        return
      }
      const bindResult = await finishBindGroupModeCreate(port, messageId, chatId, project, draft.existingGroupChatId, wtWarn)
      if (bindResult.ok) return
      fallbackNote = `\n⚠️ 绑定已有群失败，已回退当前会话模式\n原因：${bindResult.error}`
    } else if (draft.chatMode !== "inline" && chatId) {
      const groupResult = await finishGroupModeCreate(port, messageId, chatId, project, draft.operatorOpenId, wtWarn)
      if (groupResult.ok) return
      fallbackNote = `\n⚠️ 独立群创建失败，已回退当前会话模式\n原因：${groupResult.error}`
    }
    if (wtErrors.length) {
      const note = [
        fallbackNote ? fallbackNote.replace(/^\n/, "") : "",
        "⚠️ AI 工作目录初始化未完成",
        ...wtErrors.map((e) => `· ${e}`),
      ].filter(Boolean).join("\n")
      if (chatId && canEnterProjectFromChat(project, chatId)) {
        await enterProjectSession(port, chatId, project)
        if (!project.groupChatId) setCurrentProjectId(project.id)
      }
      await replyProjectWorkspace(port, messageId, project, chatId, undefined, note)
      return
    }
    if (chatId && canEnterProjectFromChat(project, chatId)) {
      const r = await enterProjectSession(port, chatId, project)
      if (!r.ok) {
        await reportCommandResult(port, messageId, false, featureOccupiedText(project, r.error || ""), chatId)
        return
      }
      if (!project.groupChatId) setCurrentProjectId(project.id)
    }
    const note = fallbackNote ? fallbackNote.replace(/^\n/, "") : undefined
    await replyProjectWorkspace(port, messageId, project, chatId, undefined, note)
  } catch (e: any) {
    if (!persisted) {
      // 项目未落盘才回滚 worktree（防孤儿）；已落盘后的异常不动现场，缺啥走懒修复
      for (const c of projectRepos) await removeProjectWorktree(c.repoPath, c.worktreePath)
      await reportCommandResult(port, messageId, false, `❌ 创建失败已回滚: ${e?.message || e}`, chatId)
      return
    }
    await reportCommandResult(port, messageId, false, `⚠️ 项目已创建，但后续处理出错: ${e?.message || e}\n可 /p use 进入项目重试`, chatId)
  }
}

async function handleSetupCommand(
  port: number,
  messageId: string,
  chatId: string | undefined,
  args: string[],
  patchMessageId?: string,
): Promise<void> {
  ensureStore()
  if (!chatId) {
    await reportCommandResult(port, messageId, false, "❌ 无法解析会话", chatId)
    return
  }
  const mode = (args[0] || "").toLowerCase()
  if (!mode) {
    clearProjectNewDraft(chatId)
    await replySetupHub(port, messageId, chatId, patchMessageId)
    return
  }
  if (mode === "worktree") {
    // 优先卡内表单（原卡切视图）；被拒/微信降级走分步问答
    try {
      const r = await httpPost(`http://127.0.0.1:${port}/api/project-setup-form`, {
        message_id: messageId,
        session_key: chatId,
        form: "worktree",
        patch_message_id: patchMessageId,
        worktree_root: getConfig().worktreeRoot?.trim() || undefined,
      }) as { ok?: boolean }
      if (r?.ok) return
    } catch { /* fall through to Q&A */ }
    const draft: ProjectNewDraft = {
      chatKey: chatId,
      step: "setup_worktree",
      setupOnly: true,
      returnToSetup: true,
      updatedAt: Date.now(),
    }
    await promptNewStep(port, messageId, chatId, draft, patchMessageId)
    return
  }
  if (mode === "add") {
    const flag = (args[1] || "").toLowerCase()
    const cur = getProjectNewDraft(chatId)
    if (flag === "--skip-test" && cur?.step === "setup_add_test") {
      cur.testBranch = undefined
      cur.step = "setup_add_dev"
      await promptNewStep(port, messageId, chatId, cur, patchMessageId)
      return
    }
    if (flag === "--skip-dev" && cur?.step === "setup_add_dev") {
      cur.developBranch = undefined
      upsertRepoProfiles([{
        path: cur.repoPath!,
        baseBranch: cur.baseBranch || "main",
        testBranch: cur.testBranch,
        developBranch: undefined,
      }])
      clearProjectNewDraft(chatId)
      // 向导收尾：原卡直接更新为 setup 总览（省一条“已添加”插播消息）
      await replySetupHub(port, messageId, chatId, patchMessageId)
      return
    }
    // 优先发飞书表单（四项一次填完，按钮来源原卡切视图）；被拒/微信降级走分步问答
    try {
      const r = await httpPost(`http://127.0.0.1:${port}/api/project-setup-form`, {
        message_id: messageId,
        session_key: chatId,
        patch_message_id: patchMessageId,
      }) as { ok?: boolean }
      if (r?.ok) return
    } catch { /* fall through to Q&A */ }
    const draft: ProjectNewDraft = {
      chatKey: chatId,
      step: "setup_add_path",
      setupOnly: true,
      returnToSetup: true,
      updatedAt: Date.now(),
    }
    await promptNewStep(port, messageId, chatId, draft, patchMessageId)
    return
  }
  if (mode === "del" || mode === "delete" || mode === "rm") {
    const n = Number.parseInt(args[1] || "", 10)
    if (!Number.isInteger(n) || n < 1) {
      await reportCommandResult(port, messageId, false, "用法：/p setup del <序号>", chatId)
      return
    }
    const profiles = getRepoProfiles(getConfig())
    const target = profiles[n - 1]
    if (!target) {
      await reportCommandResult(port, messageId, false, `❌ 序号无效：${n}`, chatId)
      return
    }
    if (!args.includes("--yes")) {
      // 确认视图（原卡切换）：误触可取消返回总览
      await reportCommandResult(
        port, messageId, true,
        `⚠️ 确认删除主仓配置 #${n}？\n${target.path}\n\n仅移除记录，不影响磁盘上的仓库。`,
        chatId,
        [
          { label: `确认删除 #${n}`, cmd: `/p setup del ${n} --yes` },
          { label: "取消", cmd: "/p setup" },
        ],
        patchMessageId ? { patchMessageId } : undefined,
      )
      return
    }
    const removed = removeRepoProfile(n)
    if (!removed) {
      await reportCommandResult(port, messageId, false, `❌ 序号无效：${n}`, chatId)
      return
    }
    // 原卡更新为最新总览，删除结果并入首行提示
    await replySetupHub(port, messageId, chatId, patchMessageId, `✅ 已删除 #${n} ${path.basename(removed.path)}`)
    return
  }
  if (mode === "gitlab") {
    try {
      const cfg = getConfig()
      const r = await httpPost(`http://127.0.0.1:${port}/api/project-setup-form`, {
        message_id: messageId,
        session_key: chatId,
        form: "gitlab",
        patch_message_id: patchMessageId,
        gitlab_host: cfg.gitlabHost?.trim() || undefined,
        token_masked: maskToken(cfg.gitlabToken || ""),
      }) as { ok?: boolean }
      if (r?.ok) return
    } catch { /* fall through to Q&A */ }
    const draft: ProjectNewDraft = {
      chatKey: chatId,
      step: "setup_gitlab_token",
      setupOnly: true,
      returnToSetup: true,
      updatedAt: Date.now(),
    }
    await promptNewStep(port, messageId, chatId, draft, patchMessageId)
    return
  }
  await reportCommandResult(port, messageId, false, "用法：/p setup（总览）· /p setup worktree（目录）· /p setup add（加主仓）· /p setup gitlab · /p setup del <序号>", chatId)
}

function maskToken(token: string): string {
  const t = token.trim()
  if (!t) return "（未设置）"
  return t.length <= 8 ? `${t.slice(0, 2)}***` : `${t.slice(0, 6)}***${t.slice(-3)}`
}

export async function replySetupHub(port: number, messageId: string, chatId: string, patchMessageId?: string, notice?: string): Promise<void> {
  const cfg = getConfig()
  const profiles = getRepoProfiles(cfg)
  const wt = cfg.worktreeRoot?.trim() ? path.normalize(cfg.worktreeRoot.trim()) : ""
  const list = profiles.length
    ? profiles.map((p, i) => {
      const name = path.basename(p.path)
      const branches = [p.baseBranch, p.testBranch, p.developBranch].filter(Boolean).join(" · ")
      return `#${i + 1} ${name} · ${branches}\n   ${p.path}`
    }).join("\n")
    : "（暂无）"
  const btns: CommandButton[] = [
    { label: "设置工作区目录", cmd: "/p setup worktree" },
    { label: "添加主仓", cmd: "/p setup add" },
    { label: "设置 GitLab", cmd: "/p setup gitlab" },
  ]
  for (let i = 0; i < Math.min(profiles.length, 8); i++) {
    btns.push({
      label: `删除 #${i + 1} ${path.basename(profiles[i].path)}`,
      cmd: `/p setup del ${i + 1}`,
    })
  }
  btns.push({ label: "← 项目菜单", cmd: "/p menu --back" })
  await reportCommandResult(
    port,
    messageId,
    true,
    [
      ...(notice ? [notice, ""] : []),
      "⚙️ 项目工作区",
      "",
      `工作区目录：${wt || "（未设置）"}`,
      "",
      "主仓：",
      list,
      "",
      `GitLab Token：${maskToken(cfg.gitlabToken || "")}`,
      `GitLab Host：${cfg.gitlabHost?.trim() || "（默认从 origin 推断）"}`,
    ].join("\n"),
    chatId,
    btns,
    patchMessageId ? { patchMessageId } : undefined,
  )
}

async function promptNewStep(
  port: number,
  messageId: string,
  chatId: string | undefined,
  draft: ProjectNewDraft,
  patchMessageId?: string,
): Promise<void> {
  const cfg = getConfig()
  saveProjectNewDraft(draft)
  // 向导步骤卡：按钮点击来源时原卡推进，避免每步刷一条新消息
  const send = (text: string, buttons: CommandButton[]) => reportCommandResult(
    port, messageId, true, text, chatId, buttons, patchMessageId ? { patchMessageId } : undefined,
  )

  if (draft.step === "setup_worktree") {
    await send(
      ["⚙️ 设置工作区目录", "", "请直接回复绝对路径", "例：`D:\\claw-projects`"].join("\n"),
      [{ label: "返回 setup", cmd: "/p setup" }, { label: "取消", cmd: "/p new --cancel" }],
    )
    return
  }

  if (draft.step === "setup_add_path") {
    await send(
      "➕ 添加主仓 · 请回复主仓绝对路径（git 根目录）",
      [{ label: "返回 setup", cmd: "/p setup" }, { label: "取消", cmd: "/p new --cancel" }],
    )
    return
  }
  if (draft.step === "setup_add_base") {
    await send(
      `➕ 主仓 ${draft.repoPath}\n请回复 **生产基线分支**（必填）`,
      [{ label: "返回 setup", cmd: "/p setup" }, { label: "取消", cmd: "/p new --cancel" }],
    )
    return
  }
  if (draft.step === "setup_add_test") {
    await send(
      "➕ 请回复 **测试分支**（可空，回 `-` 跳过）",
      [{ label: "跳过", cmd: "/p setup add --skip-test" }, { label: "返回 setup", cmd: "/p setup" }],
    )
    return
  }
  if (draft.step === "setup_add_dev") {
    await send(
      "➕ 请回复 **开发分支**（可空，回 `-` 跳过）",
      [{ label: "跳过并完成", cmd: "/p setup add --skip-dev" }, { label: "返回 setup", cmd: "/p setup" }],
    )
    return
  }
  if (draft.step === "setup_gitlab_token") {
    await send(
      `🔑 请回复 **GitLab Token**（当前 ${maskToken(cfg.gitlabToken || "")}；回 \`-\` 保持不变）`,
      [{ label: "返回 setup", cmd: "/p setup" }],
    )
    return
  }
  if (draft.step === "setup_gitlab_host") {
    await send(
      `🌐 请回复 **GitLab Host**（当前 ${cfg.gitlabHost?.trim() || "默认从 origin 推断"}；回 \`-\` 保持不变，回 \`clear\` 清空）`,
      [{ label: "返回 setup", cmd: "/p setup" }],
    )
    return
  }

}

/** 向导进行中时，把用户下一条非指令文本填入当前步骤 */
export async function fillProjectNewFromText(
  port: number,
  messageId: string,
  chatId: string,
  text: string,
): Promise<boolean> {
  ensureStore()
  const draft = getProjectNewDraft(chatId)
  if (!draft) return false
  if (draft.step === "form") return false
  const value = text.trim().replace(/^["']|["']$/g, "")
  if (!value) return true

  if (draft.step === "setup_worktree") {
    if (!path.isAbsolute(value)) {
      await reportCommandResult(port, messageId, false, "❌ 请回复绝对路径，例如 D:\\claw-projects", chatId)
      return true
    }
    // 压平 D:\\foo 这类双反斜杠输入，避免脏路径进 config
    const dir = path.normalize(value)
    try {
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
    } catch (e: any) {
      await reportCommandResult(port, messageId, false, `❌ 无法创建目录: ${e?.message || e}`, chatId)
      return true
    }
    saveConfig({ worktreeRoot: dir })
    clearProjectNewDraft(chatId)
    await reportCommandResult(port, messageId, true, `✅ 工作区目录已设为：${dir}`, chatId)
    await replySetupHub(port, messageId, chatId)
    return true
  }

  if (draft.step === "setup_add_path") {
    const remote = isRemoteRepoRef(value)
    if (!remote && !path.isAbsolute(value)) {
      await reportCommandResult(port, messageId, false, "❌ 请回复本地绝对路径或远程仓库地址（https:// 或 git@）", chatId)
      return true
    }
    if (!(await isUsableRepoRef(value))) {
      await reportCommandResult(port, messageId, false, `❌ 不是有效 git 根目录: ${value}`, chatId)
      return true
    }
    draft.repoPath = remote ? value.trim() : path.resolve(value)
    draft.step = "setup_add_base"
    await promptNewStep(port, messageId, chatId, draft)
    return true
  }
  if (draft.step === "setup_add_base") {
    draft.baseBranch = value
    draft.step = "setup_add_test"
    await promptNewStep(port, messageId, chatId, draft)
    return true
  }
  if (draft.step === "setup_add_test") {
    draft.testBranch = value === "-" ? undefined : value
    draft.step = "setup_add_dev"
    await promptNewStep(port, messageId, chatId, draft)
    return true
  }
  if (draft.step === "setup_gitlab_token") {
    if (value !== "-") saveConfig({ gitlabToken: value })
    draft.step = "setup_gitlab_host"
    await promptNewStep(port, messageId, chatId, draft)
    return true
  }
  if (draft.step === "setup_gitlab_host") {
    if (value === "clear") saveConfig({ gitlabHost: "" })
    else if (value !== "-") saveConfig({ gitlabHost: value })
    clearProjectNewDraft(chatId)
    await reportCommandResult(port, messageId, true, "✅ GitLab 配置已更新", chatId)
    await replySetupHub(port, messageId, chatId)
    return true
  }
  if (draft.step === "setup_add_dev") {
    draft.developBranch = value === "-" ? undefined : value
    upsertRepoProfiles([{
      path: draft.repoPath!,
      baseBranch: draft.baseBranch || "main",
      testBranch: draft.testBranch,
      developBranch: draft.developBranch,
    }])
    clearProjectNewDraft(chatId)
    await reportCommandResult(
      port,
      messageId,
      true,
      `✅ 已添加主仓 ${path.basename(draft.repoPath!)} · ${draft.baseBranch}`,
      chatId,
    )
    await replySetupHub(port, messageId, chatId)
    return true
  }

  return true
}

async function handleNewCommand(
  port: number,
  messageId: string,
  chatId: string | undefined,
  parts: string[],
): Promise<void> {
  ensureStore()
  const cfg = getConfig()
  const chatKey = chatId || ""

  // 兼容一行写完：/p new name repoIdx base feature goal...
  if (parts.length >= 6 && !parts[2]?.startsWith("--")) {
    const name = parts[2]
    const repoIdx = Number.parseInt(parts[3], 10)
    const baseBranch = parts[4]
    const featureBranch = parts[5]
    const goal = parts.slice(6).join(" ").trim()
    const roots = cfg.repoRoots || []
    if (!goal || !Number.isInteger(repoIdx) || repoIdx < 1 || repoIdx > roots.length) {
      await reportCommandResult(port, messageId, false, "❌ 一行创建参数无效；也可用 /p new 走交互", chatId)
      return
    }
    await finalizeNewProject(port, messageId, chatId, {
      chatKey,
      name,
      repoPath: roots[repoIdx - 1],
      baseBranch,
      featureBranch,
      goal,
      // 文本建项拿不到 operatorOpenId，独立群必失败；直接沿用当前会话
      chatMode: "inline",
    })
    return
  }

  const flag = parts[2]?.startsWith("--") ? parts[2].toLowerCase() : ""

  if (flag === "--cancel") {
    if (chatKey) clearProjectNewDraft(chatKey)
    await reportCommandResult(port, messageId, true, "已取消向导", chatId)
    return
  }

  if (!chatKey) {
    await reportCommandResult(port, messageId, false, "❌ 无法解析会话", chatId)
    return
  }

  try {
    const r = await httpPost(`http://127.0.0.1:${port}/api/project-new-form`, {
      message_id: messageId,
      session_key: chatId,
      repo_profiles: getRepoProfiles(cfg),
      repo_roots: cfg.repoRoots || [],
      worktree_root: cfg.worktreeRoot || "",
    }) as { ok?: boolean; error?: string }
    if (!r?.ok) {
      await reportCommandResult(port, messageId, false, `❌ 创建表单发送失败（飞书卡片被拒）。可先 /p setup 检查配置，或用一行命令：\n/p new <名> <主仓路径> <基线> <feature> <目标…>`, chatId)
    }
  } catch (e: any) {
    await reportCommandResult(port, messageId, false, `❌ 打不开创建表单: ${e?.message || e}`, chatId)
  }
}

/** 表单提交（daemon 卡片回调 → electron） */
export async function handleProjectNewSubmit(
  port: number,
  messageId: string,
  chatId: string,
  fields: {
    name: string
    goal: string
    repoPath: string
    worktreeRoot: string
    baseBranch: string
    featureBranch?: string
    storyUrl?: string
    relatedDocs?: string
    productDocUrl?: string
    techDocUrl?: string
    groupId?: string
    groupIds?: string[]
    workspaceType?: string
    chatMode?: string
    existingGroupChatId?: string
    operatorOpenId?: string
    repos?: { repoPath: string; baseBranch: string; testBranch?: string; developBranch?: string }[]
  },
): Promise<void> {
  ensureStore()
  await finalizeNewProject(port, messageId, chatId, {
    chatKey: chatId,
    name: fields.name,
    goal: fields.goal,
    repoPath: fields.repoPath,
    baseBranch: fields.baseBranch || "main",
    featureBranch: fields.featureBranch,
    storyUrl: fields.storyUrl || undefined,
    relatedDocs: fields.relatedDocs || undefined,
    productDocUrl: fields.productDocUrl || undefined,
    techDocUrl: fields.techDocUrl || undefined,
    worktreeRootOverride: fields.worktreeRoot,
    groupId: fields.groupId,
    groupIds: fields.groupIds,
    workspaceType: fields.workspaceType === "plain" ? "plain" : undefined,
    chatMode: normalizeProjectChatMode(fields.chatMode),
    existingGroupChatId: fields.existingGroupChatId || undefined,
    operatorOpenId: fields.operatorOpenId || undefined,
    repos: fields.repos,
  })
}


async function handleShipCommand(
  port: number,
  messageId: string,
  chatId: string | undefined,
  args: string[],
): Promise<void> {
  ensureStore()
  const p = resolveProjectForChat(chatId)
  if (!p) {
    await reportCommandResult(port, messageId, false, "❌ 没有当前项目，先 /p new 或 /p use", chatId)
    return
  }
  if (!canOperateProjectInChat(p, chatId)) {
    await reportCommandResult(port, messageId, false, `❌ ${GROUP_ONLY_HINT}`, chatId)
    return
  }
  const primary = p.repos?.[0]
  const developBranch = primary?.developBranch?.trim()
  const testBranch = primary?.testBranch?.trim()
  const mode = (args[0] || "").toLowerCase()

  if (!mode) {
    await reportCommandResult(
      port,
      messageId,
      true,
      [
        "🚢 交付已拆分为两个节点：",
        "· 部署 /p deploy — 推送到开发分支",
        "· 提测 /p submit-test — 开 MR 到测试分支并通知测试",
        "",
        "分支配置仍可用 /p ship --set develop|test <名>",
      ].join("\n"),
      chatId,
      [
        { label: "部署", cmd: "/p deploy" },
        { label: "提测", cmd: "/p submit-test" },
      ],
    )
    return
  }

  if (mode === "--set" || mode === "set") {
    const kind = (args[1] || "").toLowerCase()
    const name = (args[2] || "").trim()
    if (!name || (kind !== "develop" && kind !== "dev" && kind !== "test")) {
      await reportCommandResult(port, messageId, false, "用法：/p ship --set develop <分支> 或 /p ship --set test <分支>", chatId)
      return
    }
    const repos = [...(p.repos || [{
      repoPath: p.repoPath,
      baseBranch: p.baseBranch,
      worktreePath: p.worktreePath,
    }])]
    if (kind === "test") repos[0].testBranch = name
    else repos[0].developBranch = name
    p.repos = repos
    const { saveProject } = await import("../src/shared/project-store.js")
    saveProject(p)
    upsertRepoProfiles([{
      path: repos[0].repoPath,
      baseBranch: repos[0].baseBranch,
      testBranch: repos[0].testBranch,
      developBranch: repos[0].developBranch,
    }])
    await reportCommandResult(
      port,
      messageId,
      true,
      `✅ 已写入 ${kind === "test" ? "testBranch" : "developBranch"}=${name}\n可再 /p ship`,
      chatId,
      [{ label: "继续 ship", cmd: "/p ship" }],
    )
    return
  }

  // 兼容旧卡片按钮：转发到拆分后的节点流程（统一入队，AI 执行）
  if ((mode === "--to" || mode === "to") && (args[1] || "").toLowerCase() === "develop") {
    await runAction(port, messageId, chatId, "deploy")
    return
  }

  if ((mode === "--mr" || mode === "mr") && (args[1] || "").toLowerCase() === "test") {
    await runAction(port, messageId, chatId, "submit-test")
    return
  }

  await reportCommandResult(port, messageId, false, "用法：/p deploy | /p submit-test | /p ship --set develop|test <名>", chatId)
}

/** 部署节点：校验配置后推送开发分支（宿主动作 + Agent 摘要） */
/** 上线文档节点：宿主只读查询 feature→基线 的现存 MR，附给 Agent（Agent 无 GitLab token，且严禁自行创建/合并） */
async function releaseMrHint(p: Project): Promise<string> {
  const cfg = getConfig()
  const mr = await findMergeRequest({
    cwd: p.worktreePath,
    token: cfg.gitlabToken || "",
    host: cfg.gitlabHost || undefined,
    sourceBranch: p.featureBranch,
    targetBranch: p.baseBranch,
  }).catch((e) => ({ ok: false as const, mrUrl: undefined, state: undefined, error: String(e) }))
  if (mr.mrUrl) {
    return `宿主已查到 ${p.featureBranch} → ${p.baseBranch} 的 MR（${mr.state === "merged" ? "已合并" : "开启中"}）: ${mr.mrUrl}`
  }
  return [
    `宿主未查到 ${p.featureBranch} → ${p.baseBranch} 的现存 MR${mr.error ? `（查询失败: ${mr.error}）` : ""}。`,
    "按节点要求从需求工作项评论或用户处获取；确实尚未创建时指导用户在 GitLab 手动创建（严禁你自行创建）。",
  ].join("")
}

async function runAction(
  port: number,
  messageId: string,
  chatId: string | undefined,
  type: ProjectActionType,
  patchMessageId?: string,
): Promise<void> {
  ensureStore()
  if (!chatId) {
    await reportCommandResult(port, messageId, false, "❌ 无法解析 chatId", chatId)
    return
  }
  const p = resolveProjectForChat(chatId)
  if (!p) {
    await reportCommandResult(port, messageId, false, "❌ 没有当前项目，先 /p new 或 /p use", chatId)
    return
  }
  if (!canOperateProjectInChat(p, chatId)) {
    const hint = resolveBoundGroupProject(chatId) ? GROUP_LOCK_HINT : GROUP_ONLY_HINT
    await reportCommandResult(port, messageId, false, `❌ ${hint}`, chatId, undefined, { patchMessageId })
    return
  }
  if (!isPlainProject(p)) {
    const refs = projectRepoRefs(p)
    if (refs.length) {
      const co = await ensureCheckouts(refs, p.featureBranch)
      if (!co.ok) {
        await reportCommandResult(port, messageId, false, featureOccupiedText(p, co.error || ""), chatId, undefined, { patchMessageId })
        return
      }
    }
  }
  const project = getProject(p.id) ?? p
  await ensureArtifactDir(project.worktreePath)
  const sessionKey = project.groupChatId
    ? (project.sessionKey || projectSessionKey(project.groupChatId, project.id))
    : projectSessionKey(chatId, project.id)
  project.sessionKey = sessionKey
  project.notifyChatId = project.groupChatId || chatId
  // 点节点按钮 = 明确要干活：leave 挂起的项目自动恢复
  if (project.status === "paused") project.status = "active"
  const { saveProject } = await import("../src/shared/project-store.js")
  saveProject(project)
  if (!project.groupChatId) setCurrentProjectId(project.id)

  let prompt = buildActionPrompt(project, type)
  if (type === "fill-release-doc" && !isPlainProject(project)) {
    prompt += `\n\n${await releaseMrHint(project)}`
  }

  // 任务入队而非直塞启动提示词：Agent 崩溃时消息自动重投，节点不丢
  pushUiLog("Project", "INFO", `[${sessionKey}] ${projectNodeLabel(type, project.groupId)}节点任务入队:\n${prompt}`)
  const enq = await enqueueToSession(port, sessionKey, prompt)
  if (!enq.ok) {
    await reportCommandResult(port, messageId, false, `❌ 节点任务入队失败: ${enq.error}`, chatId)
    return
  }
  await syncActiveSession(port, chatId, sessionKey)
  await reportCommandResult(
    port,
    messageId,
    true,
    `🚀 已启动${projectNodeLabel(type, p.groupId)}\n项目：${project.name}`,
    chatId,
    undefined,
    { patchMessageId, cardTitle: projectCardTitle(p), sessionKey: project.sessionKey },
  )
}

async function handleDeleteProjectCommand(
  port: number,
  messageId: string,
  chatId: string | undefined,
  args: string[],
  patchMessageId?: string,
): Promise<void> {
  ensureStore()
  const token = args.filter((a) => a !== "--yes")[0]
  const confirmed = args.includes("--yes")
  // 选择/确认是瞬态卡：按钮点击来源时原卡推进；最终删除结果新发留痕
  const patchExtra = patchMessageId ? { patchMessageId } : undefined

  if (!token) {
    const list = listProjects()
    if (!list.length) {
      await reportCommandResult(port, messageId, true, "📭 暂无项目", chatId, undefined, patchExtra)
      return
    }
    const lines = list.map((p, i) => `#${i + 1} ${p.name} · ${p.featureBranch}\n     id=${p.id}`)
    // 选项直接带 id，避免序号在列表变化时指错项目
    const btns: CommandButton[] = list.slice(0, 10).map((p, i) => ({
      label: `删除 #${i + 1} ${p.name}`,
      cmd: `/p del ${p.id}`,
    }))
    btns.push({ label: "返回菜单", cmd: "/p" })
    await reportCommandResult(port, messageId, true, `选择要删除的项目：\n${lines.join("\n")}`, chatId, btns, patchExtra)
    return
  }

  // --yes 只接受 12 位 hex 项目 id，禁止再走序号/同名解析（防误删）
  if (confirmed && !/^[a-f0-9]{12}$/i.test(token)) {
    await reportCommandResult(port, messageId, false, `❌ 确认删除必须使用项目 id（收到：${token}）`, chatId, undefined, patchExtra)
    return
  }
  const target = confirmed ? getProject(token) : resolveProjectRef(token)
  if (!target) {
    await reportCommandResult(
      port,
      messageId,
      false,
      confirmed ? `❌ 确认删除失败：项目 id 无效或已不存在（${token}）` : `❌ 未找到项目：${token}`,
      chatId,
      undefined,
      patchExtra,
    )
    return
  }
  const repos = target.repos?.length
    ? target.repos
    : [{ repoPath: target.repoPath, baseBranch: target.baseBranch, worktreePath: target.worktreePath }]

  if (!confirmed) {
    await reportCommandResult(
      port,
      messageId,
      true,
      [
        `⚠️ 确认删除项目「${target.name}」？`,
        `id：${target.id}`,
        `feature：${target.featureBranch}`,
        ...repos.map((r) => `📁 ${r.worktreePath}`),
        "",
        "将移除以上 AI 工作目录（含未提交改动）；主仓与远程分支不受影响。",
      ].join("\n"),
      chatId,
      [
        { label: `确认删除 ${target.name}`, cmd: `/p del ${target.id} --yes` },
        { label: "取消", cmd: "/p" },
      ],
      patchExtra,
    )
    return
  }

  const wasCurrent = getCurrentProject()?.id === target.id
  const deletedName = target.name
  const deletedId = target.id
  await executeProjectDelete(deletedId)
  void archiveProjectGroup(port, target)
  if (wasCurrent && chatId) await leaveProjectSession(port, chatId)
  await reportCommandResult(
    port,
    messageId,
    true,
    `🗑 已删除项目「${deletedName}」（id=${deletedId}）并移除 AI 工作目录`,
    chatId,
    [{ label: "项目菜单", cmd: "/p" }],
    patchExtra,
  )
}

/** 独立群模式项目删除后：群改名归档（不解散，聊天记录留档） */
export async function archiveProjectGroup(port: number, project: Project): Promise<void> {
  if (!project.groupChatId) return
  try {
    await httpPost(`http://127.0.0.1:${port}/archive-project-group`, {
      chatKey: project.groupChatId,
      name: `【已归档】${project.name}`.slice(0, 60),
    }, 10000)
  } catch { /* 尽力归档 */ }
}

/** 删除项目：元数据软删进 trash；AI 工作目录整包移入系统回收站。 slug 目录被其他项目引用时只删记录。 */
export async function executeProjectDelete(projectId: string): Promise<{ ok: boolean; name?: string }> {
  ensureStore()
  if (!/^[a-f0-9]{12}$/i.test(projectId)) {
    pushUiLog("Project", "WARN", `[Delete] 拒绝非法 projectId: ${projectId}`)
    return { ok: false }
  }
  const target = getProject(projectId)
  if (!target) return { ok: false }
  pushUiLog(
    "Project",
    "WARN",
    `[Delete] 即将删除项目「${target.name}」id=${target.id} feature=${target.featureBranch} wt=${target.worktreePath}`,
  )
  const rootDir = projectRootDir(target).trim()
  const otherRoots = new Set<string>()
  for (const p of listProjects()) {
    if (p.id === target.id) continue
    const rd = projectRootDir(p).trim()
    if (rd) otherRoots.add(path.resolve(rd).toLowerCase())
  }

  if (rootDir && fs.existsSync(rootDir)) {
    const rootKey = path.resolve(rootDir).toLowerCase()
    if (otherRoots.has(rootKey)) {
      pushUiLog("Project", "WARN", `[Delete] 目录被其他项目引用，跳过清理: ${rootDir}`)
    } else {
      let trashed = false
      try {
        await shell.trashItem(rootDir)
        trashed = true
        pushUiLog("Project", "INFO", `[Delete] 已移入系统回收站: ${rootDir}`)
      } catch (e) {
        pushUiLog("Project", "WARN", `[Delete] 回收站失败 ${rootDir}: ${e instanceof Error ? e.message : String(e)}`)
      }
      if (!trashed) {
        const repos = target.repos?.length
          ? target.repos
          : [{ repoPath: target.repoPath, baseBranch: target.baseBranch, worktreePath: target.worktreePath }]
        for (const r of repos) {
          if (!r.worktreePath || !fs.existsSync(r.worktreePath)) continue
          try { await removeProjectWorktree(r.repoPath, r.worktreePath) } catch { /* 尽力清理 */ }
        }
        try {
          if (fs.existsSync(rootDir)) fs.rmSync(rootDir, { recursive: true, force: true })
          pushUiLog("Project", "INFO", `[Delete] 已强制删除: ${rootDir}`)
        } catch { /* 尽力清理 */ }
      }
    }
  }
  deleteProject(target.id)
  return { ok: true, name: target.name }
}

/** 项目协作主卡：仅 header + 流程组按钮（详情走 /p info） */
async function replyProjectWorkspace(
  port: number,
  messageId: string,
  p: Project,
  chatId?: string,
  patchMessageId?: string,
  headerNote?: string,
): Promise<void> {
  const sk = p.sessionKey || (chatId ? projectSessionKey(chatId, p.id) : undefined)
  const base = projectCardTitle(p)
  const cardTitle = headerNote && base
    ? { title: base.title, subtitle: headerNote }
    : base
  await reportCommandResult(
    port,
    messageId,
    true,
    "",
    chatId,
    projectButtons(p, chatId),
    { cardTitle, patchMessageId, sessionKey: sk },
  )
}

/** 项目二级菜单：列表 + 快速进入，不自动进当前项目；patchMessageId 用于域内「返回菜单」原卡跳转 */
async function replyProjectMenu(port: number, messageId: string, chatId?: string, patchMessageId?: string): Promise<void> {
  const bound = resolveBoundGroupProject(chatId)
  if (bound) {
    const sk = bound.sessionKey || projectSessionKey(bound.groupChatId || chatId!, bound.id)
    if (chatId) await syncActiveSession(port, chatId, sk)
    await replyProjectWorkspace(port, messageId, bound, chatId, patchMessageId)
    return
  }

  const list = listProjects()
  const cur = resolveProjectForChat(chatId)
  if (list.length === 0) {
    await reportCommandResult(port, messageId, true, `${projectHelpText()}\n\n📭 暂无项目`, chatId, [
      { label: "新建项目", cmd: "/p new" },
      { label: "配置工作区", cmd: "/p setup" },
    ], { cardTitle: { title: "项目", subtitle: "菜单" }, patchMessageId })
    return
  }
  const statusLabel: Record<string, string> = { active: "进行中", paused: "已暂停", done: "已完成" }
  const lines = list.map((p, i) => {
    const mark = cur?.id === p.id ? "（当前）" : ""
    const st = statusLabel[p.status] || p.status
    const mode = p.groupChatId
      ? (canOperateProjectInChat(p, chatId) ? " · 独立群（本群）" : " · 独立群（仅群内）")
      : ""
    return `#${i + 1} 📦 ${p.name}${mark} · ${st}${mode}\n     🌿 ${p.featureBranch || "—"}`
  })
  const head = cur
    ? [
      "📦 项目菜单",
      `当前选中：「${cur.name}」——尚未进入协作，点下方「进入」开始`,
      "",
      lines.join("\n"),
    ].join("\n")
    : ["📦 项目菜单", "", lines.join("\n")].join("\n")
  const btns: CommandButton[] = list
    .filter((p) => canOperateProjectInChat(p, chatId))
    .slice(0, 10)
    .map((p) => ({
      label: `进入 ${p.name}`,
      cmd: `/p use ${p.id}`,
      section: "进入项目",
    }))
  if (cur && canOperateProjectInChat(cur, chatId)) {
    btns.push({ label: "项目详细信息", cmd: "/p info", section: "其他" })
    if (!cur.groupChatId) {
      btns.push({ label: "回主会话", cmd: "/c main", section: "其他" })
      btns.push({ label: "退出项目", cmd: "/p leave", section: "其他" })
    }
  }
  btns.push({ label: "新建项目", cmd: "/p new", section: "其他" })
  btns.push({ label: "删除项目", cmd: "/p del", section: "其他" })
  btns.push({ label: "配置工作区", cmd: "/p setup", section: "其他" })
  btns.push({ label: "帮助", cmd: "/p help", section: "其他" })
  await reportCommandResult(
    port,
    messageId,
    true,
    `${head}\n\n💡 点「进入」才会切换到该项目；直接发消息不会自动进入`,
    chatId,
    btns,
    { cardTitle: { title: "项目", subtitle: "菜单" }, patchMessageId },
  )
}

export async function handleFeishuProjectCommand(
  port: number,
  messageId: string,
  raw: string,
  chatId?: string,
  patchMessageId?: string,
): Promise<void> {
  ensureStore()
  const parts = raw.trim().split(/\s+/).filter(Boolean)
  const low = (s: string) => s.toLowerCase()

  if (parts.length <= 1) {
    const bound = resolveBoundGroupProject(chatId)
    if (bound) {
      await replyProjectWorkspace(port, messageId, bound, chatId, patchMessageId)
      return
    }
    const cur = getCurrentProject()
    if (cur && chatId && canOperateProjectInChat(cur, chatId)) {
      const active = await getCurrentActiveSession(port, chatId)
      const projSk = cur.sessionKey || projectSessionKey(chatId, cur.id)
      if (active === projSk) {
        await replyProjectWorkspace(port, messageId, cur, chatId, patchMessageId)
        return
      }
    }
    await replyProjectMenu(port, messageId, chatId, patchMessageId)
    return
  }

  const sub = low(parts[1])
  if (sub === "help" || sub === "-h" || sub === "--help") {
    await reportCommandResult(port, messageId, true, projectHelpText(), chatId, undefined, { patchMessageId })
    return
  }

  if (sub === "menu") {
    const back = parts.slice(2).some((t) => low(t) === "--back")
    const bound = resolveBoundGroupProject(chatId)
    const cur = resolveProjectForChat(chatId)
    if (back && (bound || cur)) {
      const p = bound ?? cur!
      await replyProjectWorkspace(
        port, messageId, p, chatId, patchMessageId,
      )
      return
    }
    await replyProjectMenu(port, messageId, chatId, back ? patchMessageId : undefined)
    return
  }

  if (sub === "ls" || sub === "list") {
    await replyProjectMenu(port, messageId, chatId, patchMessageId)
    return
  }

  if (sub === "use") {
    const target = resolveProjectRef(parts[2])
    if (!target) {
      await reportCommandResult(port, messageId, false, "💡 用法：/p use <序号|id>", chatId)
      return
    }
    if (!canOperateProjectInChat(target, chatId)) {
      const hint = resolveBoundGroupProject(chatId) ? GROUP_LOCK_HINT : GROUP_ONLY_HINT
      await reportCommandResult(port, messageId, false, `❌ ${hint}`, chatId, undefined, { patchMessageId })
      return
    }
    let enterNotes: string[] = []
    if (chatId) {
      const r = await enterProjectSession(port, chatId, target)
      if (!r.ok) {
        const isolation = (r.error || "").includes("独立群")
        await reportCommandResult(port, messageId, false, isolation ? `❌ ${r.error}` : featureOccupiedText(target, r.error || ""), chatId, isolation ? undefined : [
          { label: `重试进入 ${target.name}`, cmd: `/p use ${target.id}` },
        ], {
          cardTitle: projectCardTitle(target),
          sessionKey: target.sessionKey || (chatId ? projectSessionKey(chatId, target.id) : undefined),
        })
        return
      }
      enterNotes = r.notes || []
    }
    // 独立群不抢占全局 current 指针（防私聊/其它入口误用）
    if (!target.groupChatId) setCurrentProjectId(target.id)
    await replyProjectWorkspace(
      port, messageId, target, chatId, patchMessageId,
      enterNotes.length ? enterNotes.join("\n") : undefined,
    )
    return
  }

  if (sub === "leave") {
    if (!chatId) {
      await reportCommandResult(port, messageId, false, "❌ 无法解析会话", chatId)
      return
    }
    if (resolveBoundGroupProject(chatId)) {
      await reportCommandResult(port, messageId, false, "❌ 项目专属群固定协作本群项目，无主会话可回，无需退出", chatId, undefined, { patchMessageId })
      return
    }
    const cur = getCurrentProject()
    const notes: string[] = []
    if (cur && !isPlainProject(cur)) {
      // 独立 checkout：AI 工作目录与主仓互不干扰，退出只切路由；未同步内容仅提示不拦截
      for (const r of projectRepoRefs(cur)) {
        const dirty = await worktreeDirtyCount(r.worktreePath)
        const ahead = await unpushedCount(r.worktreePath, cur.featureBranch)
        const segs: string[] = []
        if (dirty > 0) segs.push(`${dirty} 处未提交改动`)
        if (ahead > 0) segs.push(`${ahead} 个未推送提交`)
        if (segs.length) notes.push(`💾 ${path.basename(r.worktreePath)}: ${segs.join("、")}（留在 AI 工作目录，下次进入继续）`)
      }
      if (notes.length) notes.push(`🌿 需要在主仓看到 AI 改动时，让项目会话提交并推送 ${cur.featureBranch} 后在主仓 pull`)
    }
    const back = await leaveProjectSession(port, chatId)
    const block = back.sessionKey
      ? await formatCurrentSessionBlock(back.sessionKey, back.workspaceDir)
      : ""
    await reportCommandResult(
      port,
      messageId,
      true,
      ["✅ 已退出项目，回到普通会话", ...notes, "", block].filter(Boolean).join("\n"),
      chatId,
      [{ label: "切换会话", cmd: "/c" }],
      {
        cardTitle: buildSessionCardTitle({ workspaceDir: back.workspaceDir }),
        sessionKey: back.sessionKey,
        patchMessageId,
      },
    )
    return
  }

  if (sub === "info") {
    const cur = resolveProjectForChat(chatId)
    if (!cur) {
      await reportCommandResult(port, messageId, false, "❌ 没有当前项目", chatId, undefined, { patchMessageId })
      return
    }
    if (!canOperateProjectInChat(cur, chatId)) {
      await reportCommandResult(port, messageId, false, `❌ ${GROUP_ONLY_HINT}`, chatId, undefined, { patchMessageId })
      return
    }
    await reportCommandResult(port, messageId, true, formatProjectCard(cur), chatId, [
      { label: "← 返回菜单", cmd: "/p menu --back", section: "导航" },
    ], {
      cardTitle: { title: projectCardTitle(cur)?.title ?? `📦 ${cur.name}`, subtitle: "详细信息" },
      patchMessageId,
    })
    return
  }

  if (sub === "new") {
    if (resolveBoundGroupProject(chatId)) {
      await reportCommandResult(port, messageId, false, `❌ ${GROUP_LOCK_HINT}`, chatId, undefined, { patchMessageId })
      return
    }
    await handleNewCommand(port, messageId, chatId, parts)
    return
  }

  if (sub === "del" || sub === "delete" || sub === "rm") {
    if (resolveBoundGroupProject(chatId)) {
      await reportCommandResult(port, messageId, false, `❌ ${GROUP_LOCK_HINT}`, chatId, undefined, { patchMessageId })
      return
    }
    await handleDeleteProjectCommand(port, messageId, chatId, parts.slice(2), patchMessageId)
    return
  }

  if (sub === "setup") {
    // setup 动全局配置（主仓表/工作区目录/GitLab），专属群成员不可触达
    if (resolveBoundGroupProject(chatId)) {
      await reportCommandResult(port, messageId, false, `❌ ${GROUP_LOCK_HINT}`, chatId, undefined, { patchMessageId })
      return
    }
    await handleSetupCommand(port, messageId, chatId, parts.slice(2), patchMessageId)
    return
  }

  if (sub === "ship") {
    await handleShipCommand(port, messageId, chatId, parts.slice(2))
    return
  }

  if (!PROJECT_RESERVED_SUBCOMMANDS.includes(sub) && projectHasNode(resolveProjectForChat(chatId), sub)) {
    await runAction(port, messageId, chatId, sub, patchMessageId)
    return
  }

  if (sub === "sync") {
    const cur = resolveProjectForChat(chatId)
    if (!cur) {
      await reportCommandResult(port, messageId, false, "❌ 没有当前项目", chatId)
      return
    }
    if (!canOperateProjectInChat(cur, chatId)) {
      const hint = resolveBoundGroupProject(chatId) ? GROUP_LOCK_HINT : GROUP_ONLY_HINT
      await reportCommandResult(port, messageId, false, `❌ ${hint}`, chatId, undefined, { patchMessageId })
      return
    }
    if (!cur.lastArtifactPath) {
      await reportCommandResult(port, messageId, false, "❌ 没有可同步的产物", chatId)
      return
    }
    const abs = path.isAbsolute(cur.lastArtifactPath)
      ? cur.lastArtifactPath
      : path.join(cur.worktreePath, cur.lastArtifactPath)
    const sync = syncArtifactToFeishu({ artifactPath: abs, title: cur.name })
    if (sync.docUrl) {
      registerArtifact(cur.id, { artifactPath: cur.lastArtifactPath, feishuDocUrl: sync.docUrl })
    }
    if (!sync.ok) {
      await reportCommandResult(port, messageId, false, `⚠️ ${sync.error}`, chatId)
      return
    }
    await reportCommandResult(
      port,
      messageId,
      true,
      `✅ 已同步飞书${sync.docUrl ? `\n${sync.docUrl}` : ""}`,
      chatId,
      undefined,
      { patchMessageId },
    )
    return
  }

  await reportCommandResult(port, messageId, false, `😅 未知指令: ${parts[1]}\n\n${projectHelpText()}`, chatId)
}

export async function handleProjectSyncSignal(payload: {
  projectId: string
  /** @deprecated 轻量化后忽略 */
  actionId?: string
  artifactPath?: string
}): Promise<void> {
  ensureStore()
  const p = getProject(payload.projectId)
  if (!p) return
  const artifactPath = payload.artifactPath || p.lastArtifactPath
  if (!artifactPath) return
  const abs = path.isAbsolute(artifactPath) ? artifactPath : path.join(p.worktreePath, artifactPath)
  if (!fs.existsSync(abs)) return
  const sync = syncArtifactToFeishu({ artifactPath: abs, title: p.name })
  if (sync.docUrl) registerArtifact(p.id, { artifactPath, feishuDocUrl: sync.docUrl })
}

