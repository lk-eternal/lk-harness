import * as fs from "node:fs"
import * as path from "node:path"
import { app, shell } from "electron"
import { getConfig, getChannel, saveConfig, getRepoProfiles, upsertRepoProfiles, removeRepoProfile } from "./config-store"
import { reportCommandResult, type CommandButton } from "./command-handler"
import { buildSessionCardTitle } from "../src/shared/session-label.js"
import {
  createProject,
  deleteProject,
  getCurrentProject,
  getCurrentProjectId,
  getProject,
  getProjectStoreDir,
  initProjectStore,
  listProjectsForChat,
  listProjects,
  resolveProjectRef,
  saveProject,
  setCurrentProjectId,
  registerArtifact,
  getProjectNewDraft,
  saveProjectNewDraft,
  clearProjectNewDraft,
  getNodeGroups,
  projectGroupIds,
  projectGroups,
  projectNodes,
  projectNodeLabelOf,
  findProjectByGroupChat,
  type ProjectNewDraft,
} from "../src/shared/project-store.js"
import {
  projectRootDir,
  canEnterProjectFromChat,
  projectBindingForChat,
  projectGroupBindings,
  projectGroupChatMatches,
  projectMainBindings,
  projectSessionKeyFor,
  parseExistingGroupChatBinding,
  normalizeProjectChatMode,
  normalizeWorkBranchMode,
  PROJECT_RESERVED_SUBCOMMANDS,
  type Project,
  type ProjectActionType,
  type ProjectChatMode,
} from "../src/shared/project-types.js"
import type { ProjectBindingOutcome } from "../src/shared/project-app-types.js"
import type { PlannedBinding } from "../src/shared/project-bindings.js"
import { isUsableRepoRef, isRemoteRepoRef } from "./project-worktree"
import { ensureProjectDir, prepareProjectWorkspace, projectsRootDir } from "./project-workspace"
import { buildActionPrompt } from "./project-prompts"
import { syncArtifactToFeishu } from "./project-feishu-sync"
import { httpPost, syncActiveSession, enqueueToSession, getCurrentActiveSession, purgeSessionRouting, readLockFile } from "./daemon-client"
import { clearAppChatRecords } from "./app-chat"
import { removeNoFollow } from "../src/shared/safe-remove.js"
import { buildEmptyProjectMenu } from "../src/shared/quick-start.js"
import { pushUiLog } from "./ui-logger"
import { leaveProjectSession, formatCurrentSessionBlock, listTasksBoundToDelete, stopSessionAgent } from "./session-dispatcher"
import { parseChatKey, channelIdFromSessionKey } from "../src/shared/channel-types.js"
import {
  bindExistingGroup,
  bindingChannelFacts,
  connectMainBinding,
  createGroupBinding,
  mainChatKeyOfChannel,
  projectCleanupSessionKeys,
  projectGroupName,
  projectScheduleContexts,
  type GroupBindResult,
} from "./project-bind"
import { appendTasksNote, type BoundTaskBrief } from "../src/shared/session-schedule.js"
import { removeBoundTasks } from "./session-tasks"

/** 当前 chat 是哪个项目的专属群（有则返回该项目） */
function resolveBoundGroupProject(chatId?: string): Project | undefined {
  return findProjectByGroupChat(chatId)
}

/** 当前 chat 在操作哪个项目：专属群里就是群的项目；主聊天里是它所在通道的「当前项目」 */
function resolveProjectForChat(chatId?: string): Project | undefined {
  return resolveBoundGroupProject(chatId) ?? getCurrentProject(chatId)
}

/**
 * 当前 chat 能否进入/切换到该项目：
 * - 已在某专属群内：只能操作本群的项目（禁止切其它项目）
 * - 主聊天：项目要接入了这个通道的主聊天；只接了专属群的项目在这里进不去（防串台）
 */
function canOperateProjectInChat(project: Pick<Project, "id" | "bindings">, chatId?: string): boolean {
  const bound = resolveBoundGroupProject(chatId)
  if (bound) return bound.id === project.id
  return canEnterProjectFromChat(project, chatId)
}

const GROUP_ONLY_HINT = "这个项目没有接入当前聊天：请到它接入的聊天（比如专属群）里进入与推进，或先在设置的项目管理里把它绑定到这个通道（避免串台）"
const GROUP_LOCK_HINT = "当前为项目专属群，仅可协作本群项目，不能切换其它项目"

function projectHasNode(p: Project | undefined, nodeId: string): boolean {
  if (!p) return false
  return projectNodes(p).some((n) => n.id === nodeId)
}

function projectHelpText(): string {
  return [
    "💡 /p 项目指令",
    "🔹 /p — 打开项目菜单，点节点按钮推进项目",
    "🔹 /p info — 查看项目详细信息",
    "🔹 /p new — 新建项目",
    "🔹 /p ls — 列出全部项目",
    "🔹 /p use <序号|id> — 进入指定项目",
    "🔹 /p leave — 退出当前项目，回到主会话",
    "🔹 /c main — 快速切回主会话（不清项目选中态）",
    "🔹 /p setup — 配置项目目录与常用代码仓库",
    "🔹 /p del <序号|id> — 删除项目（连带移除项目目录）",
  ].join("\n")
}

function ensureStore(): void {
  initProjectStore(app.getPath("userData"))
}

function formatProjectCard(p: Project, index?: number): string {
  const root = projectRootDir(p)
  const gitLines = [`📁 项目目录: ${root || p.worktreePath}`]
  const groupLine = projectGroups(p)
    .map((g) => g.name)
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
      ? ["📋 项目信息", ...Object.entries(p.metadata).map(([k, v]) => `   ${k}: ${v}`)]
      : []),
    ...gitLines,
    p.archivedAt ? "🗄 已归档" : "",
    p.lastArtifactPath ? `📄 artifact · ${p.lastArtifactPath}` : "📄 尚无产物",
    p.lastFeishuDocUrl ? `📘 飞书 · ${p.lastFeishuDocUrl}` : "",
    p.lastMrUrl ? `🔀 MR · ${p.lastMrUrl}` : "",
  ]
  return lines.filter(Boolean).join("\n")
}

/** 节点推进按钮（建项卡 / 项目会话共用） */
function projectNodeButtons(p?: Project): CommandButton[] {
  const btns: CommandButton[] = []
  for (const group of projectGroups(p ?? {})) {
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
  // 在项目专属群里：群内没有主会话可回，也不能退出项目
  if (p && projectGroupChatMatches(p, chatId)) {
    return [...base, { label: "帮助", cmd: "/p help", section: "其他" }]
  }
  return [
    ...base,
    { label: "全部项目", cmd: "/p ls", section: "其他" },
    { label: "回主会话", cmd: "/c main", section: "其他" },
    { label: "退出项目", cmd: "/p leave", section: "其他" },
  ]
}

/** 项目卡横幅用项目名/分支，避免仍显示普通会话目录；项目专属群本身就是这个项目，不再重复 */
function projectCardTitle(p: Project, chatId?: string) {
  if (projectGroupChatMatches(p, chatId)) return undefined
  return buildSessionCardTitle({ project: p })
}

function withChatFooter(text: string, footer = "也可直接发消息，在项目会话里继续聊"): string {
  return `${text}\n\n---\n${footer}`
}

/** 进入项目会话（懒加载）：确认项目目录还在，再落元数据与消息路由 */
export async function enterProjectSession(
  port: number,
  chatId: string,
  project: Project,
): Promise<{ ok: boolean; error?: string; notes?: string[] }> {
  if (!canOperateProjectInChat(project, chatId)) {
    return { ok: false, error: resolveBoundGroupProject(chatId) ? GROUP_LOCK_HINT : GROUP_ONLY_HINT }
  }
  const notes: string[] = []
  const dir = await ensureProjectDir(project)
  if (!dir.ok) return { ok: false, error: dir.error }
  // 项目在每个入口上各有一条自己的会话：专属群用群的，主聊天用「当前聊天::project_id」。
  // 会话键只由进入的这个聊天推出来，不会去动别的入口上的会话（也就没有抢会话、绑错通道的事）
  const binding = projectBindingForChat(project, chatId)
  const sessionKey = projectSessionKeyFor(project, chatId)
  if (!binding || !sessionKey) return { ok: false, error: GROUP_ONLY_HINT }
  // 记下这个入口的会话键：没进入过的主聊天入口第一次进入时补上，定时任务投递、删项目清会话都靠它
  if (binding.sessionKey !== sessionKey) {
    binding.sessionKey = sessionKey
    saveProject(project)
  }
  const bound = await syncActiveSession(port, chatId, sessionKey)
  if (!bound) {
    return { ok: false, error: `无法将当前会话切到项目（跨通道或路由拒绝）：${sessionKey}` }
  }
  return { ok: true, notes }
}

/** 项目目录不可用（被移动或删除了）时的用户提示 */
function projectDirUnavailableText(p: Project, detail: string): string {
  return [
    `❌ 无法进入项目「${p.name}」：项目目录不可用`,
    detail,
  ].join("\n")
}

interface NewProjectInput {
  chatKey?: string
  name?: string
  goal?: string
  /** 新建分支的名字；不填按默认规则生成（只在模板的工作分支是「新建分支」时用） */
  featureBranch?: string
  storyUrl?: string
  relatedDocs?: string
  productDocUrl?: string
  techDocUrl?: string
  worktreeRootOverride?: string
  groupId?: string
  groupIds?: string[]
  /** plain=所选模板不接代码仓库，仓库一概不理 */
  workspaceType?: "plain"
  /** 会话模式：group=独立群（默认）；inline=沿用当前会话；bind=绑定已有群 */
  chatMode?: ProjectChatMode
  /** bind 模式：已有群 chat_id（oc_… 或 ch_|oc_） */
  existingGroupChatId?: string
  /** 表单提交人 open_id：独立群模式建群时设为群主并拉入群 */
  operatorOpenId?: string
  repos?: { repoPath: string; baseBranch: string; testBranch?: string; developBranch?: string }[]
}

/** 项目信息卡发进新接入的群里（尽力而为：reportCommandResult 自己吞掉发送错误，机器人不在群里时发不进去也不算失败）：正文是项目信息，按钮只留流程节点（信息已经在卡上，不再放「项目详细信息」） */
async function announceProjectInGroup(port: number, project: Project, groupChatKey: string): Promise<void> {
  await reportCommandResult(port, "", true, formatProjectCard(project), groupChatKey, projectNodeButtons(project), {
    cardTitle: projectCardTitle(project, groupChatKey),
    sessionKey: projectSessionKeyFor(project, groupChatKey),
  })
}

/**
 * 把选好的接入点落到刚建好的项目上（主聊天 / 新建独立群 / 绑定已有群），新接入的群里发一张项目卡。
 * 逐个做、互不影响：哪个失败就在它的结果里写原因，其余照常接上；项目要不要退回主聊天由调用方定。
 * 不进入项目会话、不动「当前项目」。
 */
export async function attachPlannedBindings(
  port: number | undefined,
  project: Project,
  items: PlannedBinding[],
  opts?: { ownerOpenId?: string },
): Promise<ProjectBindingOutcome[]> {
  const out: ProjectBindingOutcome[] = []
  for (const it of items) {
    const base = { channelId: it.channel.id, channelName: it.channel.name, channelType: it.channel.type, mode: it.mode }
    if (it.mode === "inline") {
      connectMainBinding(project, it.channel.id)
      out.push({ ...base, ok: true })
      continue
    }
    let r: GroupBindResult
    if (it.mode === "group") {
      r = port
        ? await createGroupBinding(port, project, it.channel.id, opts?.ownerOpenId || it.channel.mainUserOpenId || "")
        : { ok: false, error: "后台服务没有在运行" }
    } else {
      r = bindExistingGroup(project, it.channel.id, it.groupChatKey ?? "")
    }
    if (!r.ok) {
      const what = it.mode === "group" ? "建独立群" : "绑定群"
      pushUiLog("Project", "WARN", `[Bind] 项目 ${project.id} 在「${it.channel.name}」${what}失败: ${r.error}`)
      out.push({ ...base, ok: false, warning: `${what}没成功：${r.error}` })
      continue
    }
    if (port) await announceProjectInGroup(port, project, r.chatKey)
    out.push({ ...base, ok: true, groupChatId: r.rawChatId, ...(r.groupName ? { groupName: r.groupName } : {}) })
  }
  return out
}

/** 飞书建项选了独立群 / 绑群并且接成了：私聊里回一句收尾，并回到主会话（项目只在群里协作） */
async function replyGroupModeCreated(
  port: number,
  messageId: string,
  chatId: string,
  project: Project,
  outcome: ProjectBindingOutcome,
): Promise<void> {
  await leaveProjectSession(port, chatId)
  const lines = outcome.mode === "bind"
    ? [
      `✅ 项目「${project.name}」已创建`,
      `🔗 已绑定群 \`${outcome.groupChatId ?? ""}\``,
      "📣 请确认已将机器人拉入该群，否则群内无法收发消息",
    ]
    : [
      `✅ 项目「${project.name}」已创建`,
      `📣 独立群「${outcome.groupName ?? projectGroupName(project)}」已建好并拉你入群，后续协作请到群里进行`,
    ]
  await reportCommandResult(port, messageId, true, lines.join("\n"), chatId, [{ label: "项目菜单", cmd: "/p" }])
}

/**
 * 飞书建项：准备项目目录（按设置里的「克隆副本」克隆仓库）→ 落盘 → 按会话模式建群 / 绑群 / 沿用当前会话。
 * 和应用内建项共用 prepareProjectWorkspace；代码仓库都是可选的，一个都不选就只建项目目录。
 */
async function finalizeNewProject(
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
  const root = (draft.worktreeRootOverride || cfg.worktreeRoot || "").trim() || projectsRootDir()
  if (draft.worktreeRootOverride && root !== cfg.worktreeRoot) saveConfig({ worktreeRoot: root })

  // 所选模板不接代码仓库：多传的仓库一概不理
  const repos = draft.workspaceType === "plain"
    ? []
    : (draft.repos ?? []).filter((r) => r?.repoPath?.trim()).map((r) => ({ ...r, repoPath: r.repoPath.trim(), baseBranch: (r.baseBranch || "").trim() }))
  if (repos.length) {
    upsertRepoProfiles(repos.map((r) => ({
      path: r.repoPath,
      baseBranch: r.baseBranch,
      testBranch: r.testBranch,
      developBranch: r.developBranch,
    })))
  }

  // 克隆的副本停在哪个分支，由模板定（飞书表单里没有这个选项）
  const groupId = projectGroupIds({ groupIds: draft.groupIds, groupId: draft.groupId })[0]
  const group = getNodeGroups().find((g) => g.id === groupId)
  const ws = await prepareProjectWorkspace({
    name: draft.name,
    repos,
    workBranch: normalizeWorkBranchMode(group?.branchMode),
    featureBranch: draft.featureBranch,
    root,
  })
  if (!ws.ok) {
    await reportCommandResult(port, messageId, false, `❌ 创建失败：${ws.error}`, chatId)
    return
  }

  let persisted = false
  try {
    const project = createProject({
      name: draft.name,
      goal: draft.goal || "",
      storyUrl: draft.storyUrl,
      relatedDocs: draft.relatedDocs,
      productDocUrl: draft.productDocUrl,
      techDocUrl: draft.techDocUrl,
      worktreePath: ws.cwd,
      groupIds: draft.groupIds,
      groupId: draft.groupId,
      ...(Object.keys(ws.metadata).length ? { metadata: ws.metadata } : {}),
    })
    persisted = true
    if (draft.chatKey) clearProjectNewDraft(draft.chatKey)
    const channel = chatId ? bindingChannelFacts().find((c) => c.id === parseChatKey(chatId).channelId) : undefined
    let fallbackNote = ""
    // 独立群 / 绑定已有群：项目只接这个群（私聊里进不去，防串台）；没接成就退回当前聊天的主聊天
    const mode = draft.chatMode ?? "group"
    if (chatId && channel && mode !== "inline") {
      let item: PlannedBinding = { channel, mode }
      if (mode === "bind") {
        const parsed = parseExistingGroupChatBinding(draft.existingGroupChatId ?? "", channel.id)
        item = "error" in parsed
          ? { channel, mode }
          : { channel, mode, groupChatKey: parsed.chatKey, groupRawChatId: parsed.rawChatId }
      }
      const [outcome] = await attachPlannedBindings(port, project, [item], { ownerOpenId: draft.operatorOpenId })
      if (outcome.ok) {
        await replyGroupModeCreated(port, messageId, chatId, project, outcome)
        return
      }
      fallbackNote = `⚠️ ${mode === "bind" ? "绑定已有群" : "独立群创建"}失败，已回退当前会话模式\n原因：${outcome.warning ?? ""}`
    }
    if (chatId && channel) connectMainBinding(project, channel.id, chatId)
    if (chatId && canEnterProjectFromChat(project, chatId)) {
      const r = await enterProjectSession(port, chatId, project)
      if (!r.ok) {
        await reportCommandResult(port, messageId, false, projectDirUnavailableText(project, r.error || ""), chatId)
        return
      }
      setCurrentProjectId(project.id, chatId)
    }
    await replyProjectWorkspace(port, messageId, project, chatId, undefined, fallbackNote || undefined)
  } catch (e: any) {
    if (!persisted) {
      // 项目没落盘：整个新建的项目目录（含克隆）一并收掉，不留孤儿
      await ws.undo()
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
        `⚠️ 确认删除常用代码仓库 #${n}？\n${target.path}\n\n仅移除记录，不影响磁盘上的仓库。`,
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
  await reportCommandResult(port, messageId, false, "用法：/p setup（总览）· /p setup worktree（目录）· /p setup add（加代码仓库）· /p setup gitlab · /p setup del <序号>", chatId)
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
      const branches = [p.baseBranch, p.testBranch, p.developBranch, p.clone === false ? "不克隆" : ""].filter(Boolean).join(" · ")
      return `#${i + 1} ${name} · ${branches}\n   ${p.path}`
    }).join("\n")
    : "（暂无）"
  const btns: CommandButton[] = [
    { label: "设置工作区目录", cmd: "/p setup worktree" },
    { label: "添加代码仓库", cmd: "/p setup add" },
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
      "常用代码仓库：",
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
      "➕ 添加代码仓库 · 请回复仓库绝对路径（git 根目录）",
      [{ label: "返回 setup", cmd: "/p setup" }, { label: "取消", cmd: "/p new --cancel" }],
    )
    return
  }
  if (draft.step === "setup_add_base") {
    await send(
      `➕ 代码仓库 ${draft.repoPath}\n请回复 **基线分支**（必填）`,
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
      `✅ 已添加代码仓库 ${path.basename(draft.repoPath!)} · ${draft.baseBranch}`,
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
      repos: [{ repoPath: roots[repoIdx - 1], baseBranch }],
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
    }, 15_000) as { ok?: boolean; error?: string }
    if (!r?.ok) {
      await reportCommandResult(port, messageId, false, `❌ 创建表单发送失败（飞书卡片被拒）。可先 /p setup 检查配置，或用一行命令：\n/p new <名> <代码仓库序号> <基线> <新建分支名> <目标…>`, chatId)
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
    worktreeRoot: string
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
        "开发分支、测试分支写在项目信息的「代码仓库」里，需要改就直接改项目信息",
      ].join("\n"),
      chatId,
      [
        { label: "部署", cmd: "/p deploy" },
        { label: "提测", cmd: "/p submit-test" },
      ],
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

  await reportCommandResult(port, messageId, false, "用法：/p deploy | /p submit-test", chatId)
}

/**
 * 对指定项目启动一个步骤（节点）：把步骤提示词投进项目会话。
 * 飞书按钮（runAction）和应用内步骤条共用；项目由调用方明确给出，不读全局「当前项目」。
 * touchCurrent=false：应用内启动不去动飞书私聊用的全局当前项目指针。
 */
export async function startProjectNode(
  port: number,
  chatId: string,
  p: Project,
  type: ProjectActionType,
  opts: { touchCurrent: boolean },
): Promise<
  | { ok: true; project: Project; sessionKey: string; label: string }
  | { ok: false; error: string; kind: "denied" | "checkout" | "enqueue" }
> {
  if (!canOperateProjectInChat(p, chatId)) {
    const hint = resolveBoundGroupProject(chatId) ? GROUP_LOCK_HINT : GROUP_ONLY_HINT
    return { ok: false, error: hint, kind: "denied" }
  }
  const project = getProject(p.id) ?? p
  const dir = await ensureProjectDir(project)
  if (!dir.ok) return { ok: false, error: projectDirUnavailableText(project, dir.error), kind: "checkout" }
  // 从哪个聊天推进，就用项目在这个聊天上的那条会话（每个入口各有一条，互不干扰）
  const binding = projectBindingForChat(project, chatId)
  const sessionKey = projectSessionKeyFor(project, chatId)
  if (!binding || !sessionKey) return { ok: false, error: GROUP_ONLY_HINT, kind: "denied" }
  if (binding.sessionKey !== sessionKey) {
    binding.sessionKey = sessionKey
    saveProject(project)
  }
  if (opts.touchCurrent && binding.kind === "main") setCurrentProjectId(project.id, chatId)

  const prompt = buildActionPrompt(project, type, undefined, { gitPrinciples: getConfig().gitPrinciples })

  // 任务入队而非直塞启动提示词：Agent 崩溃时消息自动重投，节点不丢
  const label = projectNodeLabelOf(project, type)
  pushUiLog("Project", "INFO", `[${sessionKey}] ${label}节点任务入队:\n${prompt}`)
  const enq = await enqueueToSession(port, sessionKey, prompt)
  if (!enq.ok) return { ok: false, error: `节点任务入队失败: ${enq.error}`, kind: "enqueue" }
  await syncActiveSession(port, chatId, sessionKey)
  return { ok: true, project, sessionKey, label }
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
  const r = await startProjectNode(port, chatId, p, type, { touchCurrent: true })
  if (!r.ok) {
    if (r.kind === "enqueue") await reportCommandResult(port, messageId, false, `❌ ${r.error}`, chatId)
    else if (r.kind === "denied") await reportCommandResult(port, messageId, false, `❌ ${r.error}`, chatId, undefined, { patchMessageId })
    else await reportCommandResult(port, messageId, false, r.error, chatId, undefined, { patchMessageId })
    return
  }
  await reportCommandResult(
    port,
    messageId,
    true,
    `🚀 已启动${r.label}\n项目：${r.project.name}`,
    chatId,
    undefined,
    { patchMessageId, cardTitle: projectCardTitle(p, chatId), sessionKey: r.sessionKey },
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

  // 只能删这个聊天看得到的项目（接入了当前通道的），别的通道的项目碰不到
  const visible = listProjectsForChat(chatId)
  if (!token) {
    const list = visible
    if (!list.length) {
      await reportCommandResult(port, messageId, true, "📭 暂无项目", chatId, undefined, patchExtra)
      return
    }
    const lines = list.map((p, i) => `#${i + 1} ${p.name}\n     id=${p.id}`)
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
  const target = confirmed ? visible.find((p) => p.id === token) : resolveProjectRef(token, visible)
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
  if (!confirmed) {
    const root = projectRootDir(target).trim() || target.worktreePath
    await reportCommandResult(
      port,
      messageId,
      true,
      appendTasksNote([
        `⚠️ 确认删除项目「${target.name}」？`,
        `id：${target.id}`,
        `📁 ${root}`,
        "",
        target.externalWorkspace
          ? "只移除项目记录，这个文件夹原样保留。"
          : "将移除上面的项目目录（含克隆副本里没提交的改动）；你自己本机的代码仓库和远程分支不受影响。",
      ].join("\n"), listTasksBoundToDelete({ projectId: target.id })),
      chatId,
      [
        { label: `确认删除 ${target.name}`, cmd: `/p del ${target.id} --yes` },
        { label: "取消", cmd: "/p" },
      ],
      patchExtra,
    )
    return
  }

  const deletedName = target.name
  const deletedId = target.id
  // 停在这个项目上的聊天（含当前这个）挪回主会话、每个入口的会话清掉，都在 executeProjectDelete 里做
  const deleted = await executeProjectDelete(deletedId)
  void archiveProjectGroup(port, target)
  await reportCommandResult(
    port,
    messageId,
    true,
    appendTasksNote(`🗑 已删除项目「${deletedName}」（id=${deletedId}）`, deleted.removedTasks ?? []),
    chatId,
    [{ label: "项目菜单", cmd: "/p" }],
    patchExtra,
  )
}

/** 项目删除后：它接入的每个专属群都改名归档（不解散，聊天记录留档） */
export async function archiveProjectGroup(port: number, project: Pick<Project, "name" | "bindings">): Promise<void> {
  for (const g of projectGroupBindings(project)) {
    try {
      await httpPost(`http://127.0.0.1:${port}/archive-project-group`, {
        chatKey: g.chatKey,
        name: `【已归档】${project.name}`.slice(0, 60),
      }, 10000)
    } catch { /* 尽力归档 */ }
  }
}

/** 删除项目：元数据软删进 trash；项目目录整包移入系统回收站（只动项目目录，用户自己的代码仓库不碰）。目录被其他项目引用时只删记录。 */
export async function executeProjectDelete(projectId: string): Promise<{ ok: boolean; name?: string; removedTasks?: BoundTaskBrief[] }> {
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
    `[Delete] 即将删除项目「${target.name}」id=${target.id} wt=${target.worktreePath}`,
  )
  const rootDir = projectRootDir(target).trim()
  const otherRoots = new Set<string>()
  for (const p of listProjects()) {
    if (p.id === target.id) continue
    const rd = projectRootDir(p).trim()
    if (rd) otherRoots.add(path.resolve(rd).toLowerCase())
  }

  if (target.externalWorkspace) {
    // 用户自己选的文件夹：只解绑，绝不移入回收站、更不能走下面失败后的强制删除
    pushUiLog("Project", "INFO", `[Delete] 外部文件夹项目，只移除记录，保留目录: ${rootDir}`)
  } else if (rootDir && fs.existsSync(rootDir)) {
    const rootKey = path.resolve(rootDir).toLowerCase()
    const holdsOtherProject = [...otherRoots].some((r) => r.startsWith(rootKey + path.sep))
    if (otherRoots.has(rootKey)) {
      pushUiLog("Project", "WARN", `[Delete] 目录被其他项目引用，跳过清理: ${rootDir}`)
    } else if (holdsOtherProject) {
      pushUiLog("Project", "WARN", `[Delete] 目录里包含其他项目的目录，跳过清理: ${rootDir}`)
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
        // 不能直接 fs.rmSync：Electron 的 Node 里它会顺着目录里的链接把目标也删了（见 shared/safe-remove.ts）
        if (fs.existsSync(rootDir)) {
          const removed = await removeNoFollow(rootDir)
          if (removed.ok) pushUiLog("Project", "INFO", `[Delete] 已强制删除: ${rootDir}`)
          else pushUiLog("Project", "WARN", `[Delete] 强制删除失败 ${rootDir}: ${removed.error}`)
        }
      }
    }
  }
  // 项目在每个入口上都有一条会话，会话由项目派生：项目没了，每一条的 Agent、路由登记、应用内聊天记录都要一起清，
  // 否则会留下删不掉的幽灵会话（比如在飞书里删了项目，应用里还留着一个找不到项目的会话）
  const lock = readLockFile()
  // 停在这个项目上的主聊天（飞书私聊、应用内对话）：先把它们的活跃会话挪回主会话，不然下一条消息还往已删除的项目会话里投
  if (lock?.port) {
    const onProject = new Set<string>()
    for (const b of projectMainBindings(target)) {
      const chatKey = mainChatKeyOfChannel(b.channelId)
      if (chatKey && getCurrentProjectId(chatKey) === target.id) onProject.add(chatKey)
    }
    for (const chatKey of onProject) await leaveProjectSession(lock.port, chatKey)
  }
  for (const sk of projectCleanupSessionKeys(target)) {
    await stopSessionAgent(sk)
    if (lock?.port) await purgeSessionRouting(lock.port, sk)
    const ch = channelIdFromSessionKey(sk)
    if (ch && getChannel(ch)?.type === "app") await clearAppChatRecords({ sessionKey: sk })
  }
  deleteProject(target.id)
  // 挂在项目每个入口会话上的定时任务（AI 排程、设置页任务）也一起走，确认框里已经列过
  return { ok: true, name: target.name, removedTasks: await removeBoundTasks(projectScheduleContexts(target)) }
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
  const sk = projectSessionKeyFor(p, chatId)
  const base = projectCardTitle(p, chatId)
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
    const sk = projectSessionKeyFor(bound, chatId)
    if (chatId && sk) await syncActiveSession(port, chatId, sk)
    await replyProjectWorkspace(port, messageId, bound, chatId, patchMessageId)
    return
  }

  // 只列接入了当前通道的项目：别的通道的项目这里看不到
  const list = listProjectsForChat(chatId)
  const cur = resolveProjectForChat(chatId)
  if (list.length === 0) {
    // 第一次用的人最需要知道「项目是什么、怎么建」，而不是一串子指令（子指令在「指令说明」里）
    const empty = buildEmptyProjectMenu()
    await reportCommandResult(port, messageId, true, empty.text, chatId, empty.buttons, { cardTitle: empty.title, patchMessageId })
    return
  }
  const lines = list.map((p, i) => {
    const mark = cur?.id === p.id ? "（当前）" : ""
    const st = p.archivedAt ? " · 已归档" : ""
    const mode = canOperateProjectInChat(p, chatId) ? "" : " · 仅群内"
    return `#${i + 1} 📦 ${p.name}${mark}${st}${mode}`
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
    if (!projectGroupChatMatches(cur, chatId)) {
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
    const cur = getCurrentProject(chatId)
    if (cur && chatId && canOperateProjectInChat(cur, chatId)) {
      const active = await getCurrentActiveSession(port, chatId)
      const projSk = projectSessionKeyFor(cur, chatId)
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
    // 序号 / id / 名字只在这个聊天看得到的项目里找：别的通道的项目，知道 id 也进不去
    const target = resolveProjectRef(parts[2], listProjectsForChat(chatId), resolveProjectForChat(chatId))
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
        const isolation = r.error === GROUP_ONLY_HINT || r.error === GROUP_LOCK_HINT
        await reportCommandResult(port, messageId, false, isolation ? `❌ ${r.error}` : projectDirUnavailableText(target, r.error || ""), chatId, isolation ? undefined : [
          { label: `重试进入 ${target.name}`, cmd: `/p use ${target.id}` },
        ], {
          cardTitle: projectCardTitle(target, chatId),
          sessionKey: projectSessionKeyFor(target, chatId),
        })
        return
      }
      enterNotes = r.notes || []
    }
    // 当前项目只记在通道的主聊天上；在专属群里进入不碰它（store 里群聊键不会被记）
    setCurrentProjectId(target.id, chatId)
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
    const back = await leaveProjectSession(port, chatId)
    const block = back.sessionKey
      ? await formatCurrentSessionBlock(back.sessionKey, back.workspaceDir)
      : ""
    await reportCommandResult(
      port,
      messageId,
      true,
      ["✅ 已退出项目，回到普通会话", "", block].filter(Boolean).join("\n"),
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
      cardTitle: { title: projectCardTitle(cur, chatId)?.title ?? "项目", subtitle: "详细信息" },
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
    // setup 动全局配置（常用代码仓库/项目目录/GitLab），专属群成员不可触达
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

