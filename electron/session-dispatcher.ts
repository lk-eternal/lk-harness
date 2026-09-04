import * as path from "node:path"
import * as fs from "node:fs"
import { app } from "electron"
import {
  getConfig, getChannel, getChannels, getAgentResource, resolveChannelForSession,
  resolveChannelModel, effectiveWorkspaceDir, saveConfig,
  getChannelFavoriteWorkspaces, setChannelFavoriteWorkspaces,
  type MessageChannel, type ModelScenario,
} from "./config-store"
import { parseChatKey, workspaceDirFromSessionKey, normalizeSessionKey, makeChatKey } from "../src/shared/channel-types"
import { broadcastLog } from "./ui-logger"
import { readLockFile, httpGet, httpPost, syncActiveSession, getCurrentActiveSession, resolveMainChatId, enqueueToSession } from "./daemon-client"
import { reportCommandResult } from "./command-handler"
import type { ChatType, LaunchMeta } from "./agent-session-types"
import { setChatNameResolver, setChatNameFallback, resolveSessionChatName } from "./session-chat-name"
import {
  getAgentEngine,
  getAllAgentEngines,
  isSupportedAgentResource,
  listAllAgentSessions,
  hasResumableAgentSession,
  agentFailCooldownRemaining,
  resetAllSessionContext,
  clearAllAgentFailStreaks,
  clearAgentFailStreaks,
  setAllAgentIdleHandlers,
  warmupAgentModels,
} from "./agent-engine"
import { cleanupWorkspaceDir } from "./workspace-injector"
import { shouldIncludeAdminMcp } from "../src/shared/harness-mcp-store.js"
import { buildSessionCardTitle, readGitBranch, dirBaseName } from "../src/shared/session-label.js"
import { disambiguatePathLabel } from "../src/shared/path-label.js"
import { getProject, findProjectByGroupChat, listProjects, getCurrentProjectId, setCurrentProjectId, saveProject } from "../src/shared/project-store.js"
import { projectIdFromSessionKey, projectSessionKey, projectRepoRefs, isPlainProject, canEnterProjectFromChat, projectGroupChatMatches } from "../src/shared/project-types.js"
import { ensureCheckouts } from "./project-worktree"
import { buildProjectSessionPrompt } from "./project-prompts"
import { getSessionOverride } from "../src/shared/session-model-store.js"
import { resolveModelLabel } from "../src/shared/model-utils.js"
import { readTasksFromFile } from "./cron-scheduler"
import { findScheduledTaskBySessionKey, formatScheduledTaskLabel, buildNotifySessionKey } from "../src/shared/scheduled-task"
import { isFeishuStreamEnabled } from "./stream-card"
import {
  clearLaunchFailStreak,
  clearAllLaunchFailStreaks,
  launchFailCooldownRemaining,
  markNotifiedIfDue,
  recordLaunchFailure,
} from "./launch-fail-tracker"

const STARTUP_NOTIFY_TEXT = "正在启动Agent，请稍等..."

function shouldSendStartupNotify(sessionKey: string, resumable: boolean): boolean {
  return !resumable && !isFeishuStreamEnabled(sessionKey)
}

// ── readLockFile 短 TTL 缓存 ─────────────────────────────
let _lockCache: { value: ReturnType<typeof readLockFile>; ts: number } | null = null
function cachedLock() {
  const now = Date.now()
  if (_lockCache && now - _lockCache.ts < 2000) return _lockCache.value
  const v = readLockFile()
  _lockCache = { value: v, ts: now }
  return v
}

// ── 生命周期通知 ──────────────────────────────────────────

async function notifyChat(sessionKey: string, text: string): Promise<void> {
  const lock = cachedLock()
  if (!lock?.port) return
  const chatId = extractChatId(sessionKey)
  try {
    await httpPost(`http://127.0.0.1:${lock.port}/api/send-text`, { text, session_key: sessionKey }, 5000)
  } catch (e: unknown) {
    broadcastLog(`[Notify] 发送通知失败 (${chatId}): ${e instanceof Error ? e.message : String(e)}`, "WARN")
  }
}

// ── 内部工具 ─────────────────────────────────────────────

const launchReserved = new Set<string>()

function tryReserveLaunch(sessionKey: string): boolean {
  if (isSessionAgentRunningInner(sessionKey)) return false
  launchReserved.add(sessionKey)
  return true
}

function releaseLaunch(sessionKey: string): void {
  launchReserved.delete(sessionKey)
}

function wrapLaunch(sessionKey: string, fn: () => Promise<void>): Promise<void> {
  return fn().finally(() => releaseLaunch(sessionKey))
}

function isSessionAgentRunningInner(key: string): boolean {
  return launchReserved.has(key)
    || getAllAgentEngines().some((e) => e.isRunning(key))
}

export function isSessionAgentRunning(key: string): boolean {
  return isSessionAgentRunningInner(key)
}

export async function stopSessionAgent(key: string): Promise<void> {
  releaseLaunch(key)
  await Promise.all(getAllAgentEngines().map((e) => e.stop(key)))
}

export async function stopAllSessionAgents(): Promise<void> {
  await Promise.all(getAllAgentEngines().map((e) => e.stopAll()))
  launchReserved.clear()
}

// ── Session 状态 ──────────────────────────────────────────

export const chatNameCache = new Map<string, string>()
export const previousActiveSessionMap = new Map<string, string>()

/** feature 被占用提醒节流：sessionKey → 上次提醒时间（调度器每轮都会撞到占用，避免刷屏） */
const featureOccupiedNotifyAt = new Map<string, number>()

async function reportLaunchOutcome(
  sessionKey: string,
  result: { ok: boolean; error?: string },
): Promise<void> {
  if (result.ok) {
    clearLaunchFailStreak(sessionKey)
    return
  }
  const err = result.error ?? "未知错误"
  recordLaunchFailure(sessionKey, err)
  broadcastLog(`[Agent] ${sessionKey} 启动跳过: ${err}`, "WARN")
  if (markNotifiedIfDue(sessionKey)) {
    await notifyChat(sessionKey, `⚠️ Agent 启动失败，消息仍在队列，修复后自动重试。\n原因: ${err}`)
  }
}

// ── Session 工具 ──────────────────────────────────────────

/** chatId 为 chatKey（`channelId|rawChatId`）；按所属通道的主用户绑定判断 */
export function isMainUser(chatId?: string, chatType?: string): boolean {
  if (chatType !== "p2p" || !chatId) return false
  const { channelId, chatId: raw } = parseChatKey(chatId)
  const channel = getChannel(channelId)
  if (!channel?.mainUserEnabled || !channel.mainUserChatId?.trim()) return false
  return raw === channel.mainUserChatId.trim()
}

export function extractChatId(sessionKey: string): string {
  const idx = sessionKey.indexOf("::")
  return idx > 0 ? sessionKey.slice(0, idx) : sessionKey
}

function formatDuration(ms: number): string {
  const s = Math.floor(ms / 1000)
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m${s % 60}s`
  return `${Math.floor(m / 60)}h${m % 60}m`
}

// ── 名称解析 ──────────────────────────────────────────────

export async function fetchChatNames(chatIds: string[]): Promise<void> {
  const missing = chatIds.filter((id) => id && !chatNameCache.has(id))
  if (missing.length === 0) return
  const lock = cachedLock()
  if (!lock?.port) return
  try {
    const res = (await httpPost(`http://127.0.0.1:${lock.port}/api/chat-names`, { chatIds: missing }, 15_000)) as { names?: Record<string, string> }
    if (res?.names) {
      for (const [id, name] of Object.entries(res.names)) chatNameCache.set(id, name)
    }
  } catch { /* ignore */ }
}

/** 解析失败冷却：避免对无权限/无法解析的 openId 每轮轮询都打 API */
const nameFetchFailedAt = new Map<string, number>()
const NAME_FETCH_RETRY_MS = 10 * 60_000

export async function fetchUserNames(openIds: string[], channelId?: string): Promise<void> {
  const now = Date.now()
  // 无 channelId 时不查、不进冷却（否则权限已开也要干等 10 分钟）
  if (!channelId) return
  const missing = openIds.filter((id) =>
    id && !chatNameCache.has(id) && now - (nameFetchFailedAt.get(id) ?? 0) > NAME_FETCH_RETRY_MS)
  if (missing.length === 0) return
  const lock = cachedLock()
  if (!lock?.port) return
  try {
    const res = (await httpPost(`http://127.0.0.1:${lock.port}/api/user-names`, { openIds: missing, channelId }, 15_000)) as { names?: Record<string, string> }
    for (const id of missing) {
      const name = res?.names?.[id]
      if (name) {
        chatNameCache.set(id, name)
        nameFetchFailedAt.delete(id)
      } else {
        nameFetchFailedAt.set(id, now)
      }
    }
  } catch { /* ignore */ }
}

// ── 消息队列 ──────────────────────────────────────────────

interface DequeuedMessage { text: string; messageId: string; sessionKey?: string; meta?: { chatType?: string; senderOpenId?: string } }
interface MergedMessages { text: string; count: number; chatType?: string; messageIds: string[]; chatId?: string; senderOpenId?: string }

export async function pullMergedMessagesFromQueue(chatId?: string): Promise<MergedMessages | null> {
  const lock = cachedLock()
  if (!lock?.port) return null
  try {
    const body = chatId ? { chatId } : {}
    const res = (await httpPost(`http://127.0.0.1:${lock.port}/dequeue-all`, body, 10_000)) as {
      messages?: (DequeuedMessage | string)[]
    } | null
    const msgs = res?.messages ?? []
    if (msgs.length === 0) return null

    const parsed: DequeuedMessage[] = msgs
      .map((m) => (typeof m === "string" ? { text: m, messageId: "" } : m))
      .filter((m) => m.text?.trim())

    if (parsed.length === 0) return null

    const chatType = parsed[0].meta?.chatType || undefined
    const messageIds = parsed.map((m) => m.messageId).filter(Boolean)

    const text = parsed.length === 1
      ? parsed[0].text.trim()
      : parsed.map((m, i) => `【消息 ${i + 1}】\n${m.text.trim()}`).join("\n\n")

    return { text, count: parsed.length, chatType, messageIds, chatId, senderOpenId: parsed[0].meta?.senderOpenId || undefined }
  } catch {
    return null
  }
}

interface QueueSession { sessionKey: string; chatType: string; senderOpenId?: string; hasPending?: boolean }

async function getQueueSessions(): Promise<QueueSession[]> {
  const lock = cachedLock()
  if (!lock?.port) return []
  try {
    const res = (await httpGet(`http://127.0.0.1:${lock.port}/queue-chat-ids`)) as { chats?: QueueSession[] } | null
    return res?.chats ?? []
  } catch {
    return []
  }
}

export async function clearMessageQueue(): Promise<number> {
  const lock = cachedLock()
  if (!lock?.port) return 0
  try {
    const res = await httpPost(`http://127.0.0.1:${lock.port}/clear-queue`, {}) as { cleared?: number }
    clearAllAgentFailStreaks()
    clearAllLaunchFailStreaks()
    return res?.cleared ?? 0
  } catch { return 0 }
}

export interface QueueMessageItem {
  index: number
  fileId: string
  preview: string
  /** pending = 排队待投递；processing = 已投递给 Agent 待回复确认 */
  status?: "pending" | "processing"
  sessionKey?: string
  messageId?: string
  chatType?: string
  timestamp?: number
  senderOpenId?: string
  /** UI 展示用：私聊/群聊 + 项目名或目录名（避免裸 project_xxx） */
  sessionLabel?: string
}

function queueSessionLabel(sessionKey: string, chatType?: string): string {
  const chatLabel = chatType === "group" ? "群聊" : chatType === "task" ? "定时" : "私聊"
  const name = tabLabelForSession(sessionKey)
  const kind = sessionTabKind(sessionKey)
  const icon = kind === "project" ? "📦" : kind === "temp" ? "⏱" : "📁"
  return `${chatLabel} ${icon}${name}`
}

export async function getQueueMessages(): Promise<QueueMessageItem[]> {
  const lock = cachedLock()
  if (!lock?.port) return []
  try {
    const res = await httpGet(`http://127.0.0.1:${lock.port}/queue`) as { messages?: QueueMessageItem[] }
    return (res.messages ?? []).map((m) => ({
      ...m,
      sessionLabel: m.sessionKey ? queueSessionLabel(m.sessionKey, m.chatType) : undefined,
    }))
  } catch {
    return []
  }
}

/** /s 与 /c 共用的单会话状态块 */
export function formatSessionStatusBlock(
  s: {
    sessionKey: string
    chatType?: string
    workspaceDir?: string
    chatName?: string
    pid?: number
    model?: string
    modelParams?: string
    startedAt?: number
  },
  opts?: {
    index?: number
    current?: boolean
    queueMessages?: QueueMessageItem[]
    now?: number
    showType?: boolean
    /** 缺省 true；Agent 未匹配到运行实例时传 false */
    agentRunning?: boolean
    /** 群聊/非主用户：不暴露目录名、分支、路径 */
    hideWorkspace?: boolean
  },
): string {
  const now = opts?.now ?? Date.now()
  const hideWs = !!opts?.hideWorkspace
  const projId = projectIdFromSessionKey(s.sessionKey)
  const project = !hideWs && projId ? getProject(projId) : undefined
  const ws = hideWs ? undefined : (project?.worktreePath || s.workspaceDir)
  const card = hideWs ? undefined : buildSessionCardTitle({
    sessionKey: s.sessionKey,
    project,
    workspaceDir: ws,
  })
  const name = hideWs ? undefined : (card?.title || (ws ? `📂 ${dirBaseName(ws)}` : s.chatName || undefined))
  const branch = hideWs ? undefined : (
    card?.subtitle
    || (project?.featureBranch ? `🌿 ${project.featureBranch}` : undefined)
    || (ws ? (() => { const b = readGitBranch(ws); return b ? `🌿 ${b}` : undefined })() : undefined)
  )
  const agentRunning = opts?.agentRunning !== false
  const agentLine = agentRunning
    ? "🤖 对话: ✅ 进行中"
    : "🤖 对话: ❌ 空闲"
  const ov = getSessionOverride(s.sessionKey)
  const modelId = (s.model || ov?.model || "").trim() || "auto"
  const modelParams = (s.modelParams ?? ov?.modelParams ?? "").trim()
  const favLabel = (getConfig().favoriteModels ?? []).find(
    (f) => f.model === modelId && (f.modelParams ?? "") === modelParams,
  )?.label
  const model = resolveModelLabel(modelId, modelParams, favLabel) || modelId
  const qList = (opts?.queueMessages ?? []).filter((m) => m.sessionKey === s.sessionKey)
  const qProcessing = qList.filter((m) => m.status === "processing").length
  const qPending = qList.length - qProcessing
  const started = s.startedAt ? new Date(s.startedAt).toLocaleTimeString("zh-CN", { hour12: false }) : undefined
  const dur = s.startedAt ? formatDuration(now - s.startedAt) : undefined
  const timeLine = started && dur ? `⏱ 启动 ${started} · 时长 ${dur}` : undefined
  const type = s.chatType === "p2p" ? "私聊" : s.chatType === "group" ? "群聊" : s.chatType === "task" ? "定时" : s.chatType === "temp" ? "临时" : s.chatType === "project" ? "项目" : (s.chatType || "")
  let head: string
  if (opts?.index != null) {
    head = `#${opts.index}${opts.current ? " · 当前" : ""}${opts.showType !== false && type ? ` [${type}]` : ""}`
  } else {
    head = opts?.current === false ? "📍 对话" : "📍 当前对话"
  }
  return [
    head,
    name,
    branch,
    ws ? `📁 \`${ws}\`` : undefined,
    agentLine,
    `🧠 模型: ${model}`,
    `📭 消息: 等待 ${qPending} · 处理中 ${qProcessing}`,
    timeLine,
  ].filter(Boolean).join("\n")
}

export async function deleteQueueMessage(fileId: string): Promise<boolean> {
  const lock = cachedLock()
  if (!lock?.port) return false
  try {
    const res = await httpPost(`http://127.0.0.1:${lock.port}/queue-delete`, { fileId }, 5000) as { ok?: boolean }
    return res?.ok ?? false
  } catch {
    return false
  }
}

// ── Agent 启动 ─────────────────────────────────────────────

interface LaunchAgentParams {
  sessionKey: string
  chatType: ChatType
  meta?: LaunchMeta
  useMainWorkspace?: boolean
  senderOpenId?: string
  chatName?: string
  taskMessage?: string
  /** 显式指定通道（定时任务/工作流）；缺省从 sessionKey 的 chatKey 前缀解析 */
  channelId?: string
  /** 显式模型覆盖（任务模型 / 工作流节点模型） */
  modelOverride?: string
  modelParamsOverride?: string
  workingDirectory?: string
  /** 调度时已知的队列 messageId（SDK bootstrap poll 预登记，防误换卡） */
  pendingMessageIds?: string[]
  /** 定时任务 outbound 投递目标 */
  notifySessionKey?: string
}

/** 解析项目绑定：sessionKey 带 project_，或 chatId 命中独立群 groupChatId */
function findBoundProject(sessionKey: string, chatId?: string) {
  const projId = projectIdFromSessionKey(sessionKey)
  if (projId) {
    const p = getProject(projId)
    if (p && p.status !== "done") return p
  }
  const key = chatId || extractChatId(sessionKey)
  return key ? findProjectByGroupChat(key) : undefined
}

async function launchAgent(p: LaunchAgentParams): Promise<{ ok: boolean; error?: string }> {
  const { sessionKey, chatType, meta, senderOpenId, taskMessage } = p
  const scheduledTask = chatType === "task" ? scheduledTaskForSessionKey(sessionKey) : undefined
  const chatName = p.chatName || scheduledTask?.name
  const notifySessionKey = p.notifySessionKey?.trim()
    || (scheduledTask ? buildNotifySessionKey(scheduledTask) : undefined)
  const useMain = p.useMainWorkspace ?? (chatType === "p2p")
  const chatRef = meta?.chatId || extractChatId(sessionKey)
  const boundProject = findBoundProject(sessionKey, chatRef)
  // 项目会话 / 独立群：不算「其他人使用」，不注入数字身份，用主模型
  const projectOwned = chatType === "project" || !!boundProject || (chatType === "group" && !!findProjectByGroupChat(chatRef))

  // 通道与 Agent 资源解析（temp/task 的 sessionKey 无 ch_ 前缀时，从 meta.chatId 兜底）
  const channel: MessageChannel | undefined = getChannel(p.channelId)
    ?? resolveChannelForSession(sessionKey)
    ?? (meta?.chatId ? getChannel(parseChatKey(meta.chatId).channelId) : undefined)
  // 会话级供应商覆盖（/m p set）优先于通道默认，只影响当前会话
  let resourceId = channel?.agentResourceId
  try {
    const { resolveResourceForSession, initSessionResourceStore } = await import("../src/shared/session-resource-store.js")
    initSessionResourceStore(app.getPath("userData"))
    resourceId = resolveResourceForSession(sessionKey, channel?.agentResourceId)
  } catch { /* store 未就绪时沿用通道资源 */ }
  const resource = getAgentResource(resourceId)
  if (resourceId && resource.id !== resourceId) {
    return { ok: false, error: `Agent 资源「${resourceId}」未找到，请在设置 → Agent 中确认并已保存通道配置` }
  }

  const isOwnTask = chatType === "task" || chatType === "temp" || chatType === "project" || projectOwned
  if (!useMain && !isOwnTask && !channel?.allowOthers) {
    return { ok: false, error: `通道「${channel?.name ?? "未知"}」未启用其他人使用` }
  }

  const skipIdentity = useMain || projectOwned || chatType === "task" || chatType === "temp"

  let workDir: string
  if (p.workingDirectory) {
    workDir = p.workingDirectory
    if (!fs.existsSync(workDir)) fs.mkdirSync(workDir, { recursive: true })
  } else if (boundProject?.worktreePath) {
    workDir = boundProject.worktreePath
    if (!fs.existsSync(workDir)) fs.mkdirSync(workDir, { recursive: true })
  } else if (useMain || isOwnTask) {
    // sessionKey 自带工作目录后缀时优先（如切换 workspace 后旧会话被重新拉起，
    // 必须回到原目录，否则 UI 目录显示错误且 Resume 目录匹配失败丢上下文）
    const skDir = workspaceDirFromSessionKey(sessionKey)
    workDir = skDir && fs.existsSync(skDir) ? skDir : effectiveWorkspaceDir(channel)
  } else {
    // 临时目录名含 chatKey 的通道前缀（ch_xxx_...），不同通道天然隔离
    const safeChatId = sessionKey.replace(/[^a-zA-Z0-9_-]/g, "_")
    workDir = path.join(app.getPath("userData"), "workspaces", safeChatId)
    if (!fs.existsSync(workDir)) fs.mkdirSync(workDir, { recursive: true })
  }
  if (!workDir) return { ok: false, error: "工作目录未配置" }

  // 清理残留 workspace 注入
  cleanupWorkspaceDir(workDir)

  // 模型解析：显式覆盖 > 会话 override/pending > 通道场景模型
  let model: string
  let modelParams: string
  if (p.modelOverride?.trim()) {
    model = p.modelOverride.trim()
    modelParams = p.modelParamsOverride ?? ""
  } else {
    const scenario: ModelScenario = useMain || isOwnTask ? "primary" : "others"
    const resolved = resolveChannelModel(channel, scenario)
    model = resolved.model
    modelParams = resolved.modelParams
    try {
      const { resolveModelForSession, initSessionModelStore } = await import("../src/shared/session-model-store.js")
      initSessionModelStore(app.getPath("userData"))
      const eff = resolveModelForSession(sessionKey, { model, modelParams })
      model = eff.model
      modelParams = eff.modelParams ?? ""
    } catch { /* store 未就绪时沿用通道模型 */ }
  }

  // 会话模式：保留会话（run 结束持久化 agentId，新消息 Resume 续上下文）+ 长连接（无限 poll）
  const keepSession = channel?.keepSession ?? true
  let persistentPoll = keepSession && (channel?.persistentPoll ?? true)
  if (chatType === "task" && scheduledTask && scheduledTask.independent !== false) {
    persistentPoll = false
  }
  // 独立群即使入站 chatType=group，出站/提示词也按 project 语义（禁数字身份）
  const launchChatType: ChatType = projectOwned ? "project" : chatType
  const launchMeta = { ...meta, chatType: launchChatType }
  const includeAdmin = shouldIncludeAdminMcp(launchMeta, sessionKey, useMain)

  if (!isSupportedAgentResource(resource)) {
    return { ok: false, error: "请在设置 → Agent 中配置 Cursor SDK 或大模型资源，并绑定到通道" }
  }
  if (resource.type === "sdk" && !resource.apiKey?.trim()) {
    return { ok: false, error: "Cursor SDK API Key 未配置" }
  }

  // 切供应商搬运：先 peek 拼首回合，launch 成功后才 consume，失败保留
  let launchTaskMessage = taskMessage
  let newSession: boolean | undefined
  try {
    const { peekCarryover, initCarryoverStore } = await import("./carryover.js")
    initCarryoverStore(app.getPath("userData"))
    const pending = peekCarryover(sessionKey)
    if (pending) {
      newSession = true
      launchTaskMessage = pending.block + (taskMessage?.trim() ? `\n---\n${taskMessage.trim()}` : "")
    }
  } catch { /* 无搬运则正常拉起 */ }

  const launched = await getAgentEngine(resource).launch({
    sessionKey,
    chatType: launchChatType,
    meta: launchMeta,
    workspaceDir: workDir,
    useMainWorkspace: skipIdentity,
    digitalIdentityOverride: channel?.digitalIdentity,
    senderOpenId,
    chatName,
    taskMessage: launchTaskMessage,
    notifySessionKey,
    model,
    modelParams,
    keepSession,
    persistentPoll,
    newSession,
    pendingMessageIds: p.pendingMessageIds,
    resource,
    channelId: channel?.id,
    includeAdmin,
  })
  if (launched.ok && newSession) {
    try {
      const { consumeCarryover, initCarryoverStore } = await import("./carryover.js")
      initCarryoverStore(app.getPath("userData"))
      consumeCarryover(sessionKey)
    } catch { /* 幂等清理失败不影响 */ }
  }
  return launched
}

export async function launchSessionAgent(
  sessionKey: string, chatType: ChatType,
  meta?: LaunchMeta,
  useMainWorkspace?: boolean, senderOpenId?: string,
  pendingMessageIds?: string[],
): Promise<{ ok: boolean; error?: string }> {
  return launchAgent({ sessionKey, chatType, meta, useMainWorkspace, senderOpenId, pendingMessageIds })
}

export async function launchIndependentAgent(
  taskId: string, _taskName: string, message: string, type: ChatType = "task",
  _chatId?: string, channelId?: string, model?: string, modelParams?: string,
): Promise<{ ok: boolean; error?: string }> {
  const lock = cachedLock()
  if (!lock?.port) return { ok: false, error: "daemon 未就绪" }
  const r = await enqueueToSession(lock.port, taskId, message, type, { channelId, model, modelParams })
  if (!r.ok) return r
  await dispatchSessionAgents()
  return { ok: true }
}

export async function notifyChatFallback(chatId: string, text: string): Promise<void> {
  const lock = cachedLock()
  if (!lock?.port) return
  try {
    await httpPost(`http://127.0.0.1:${lock.port}/api/send-text`, { text, session_key: chatId }, 5000)
  } catch (e: unknown) {
    broadcastLog(`[WF Notify] 发送通知失败: ${e instanceof Error ? e.message : String(e)}`, "WARN")
  }
}

// ── Session 列表 ──────────────────────────────────────────

export function getSessionAgentList() {
  return listAllAgentSessions()
}

/** 未运行但可一键切换的会话：主会话 + 项目 + 常用目录（切换=只改路由，消息到达时自动拉起） */
function buildSwitchableSessions(
  chatId: string | undefined,
  running: { sessionKey: string }[],
  activeKey?: string,
): { sessionKey: string; label: string }[] {
  if (!chatId) return []
  const skip = new Set(running.map((r) => r.sessionKey))
  if (activeKey) skip.add(activeKey)
  const seen = new Set<string>()
  const out: { sessionKey: string; label: string }[] = []
  const push = (key: string, label: string) => {
    if (!key || skip.has(key) || seen.has(key)) return
    seen.add(key)
    out.push({ sessionKey: key, label })
  }
  const channel = resolveChannelForSession(chatId)
  const mainDir = effectiveWorkspaceDir(channel)
  // 目录会话：重名目录带父目录区分 + 显示当前分支
  const dirs: { dir: string; main?: boolean }[] = []
  if (mainDir) dirs.push({ dir: mainDir, main: true })
  for (const d of getChannelFavoriteWorkspaces(channel)) dirs.push({ dir: d })
  const nameCount = new Map<string, number>()
  for (const { dir } of dirs) {
    const n = dirBaseName(dir).toLowerCase()
    nameCount.set(n, (nameCount.get(n) ?? 0) + 1)
  }
  const dirLabel = (dir: string): string => {
    const base = dirBaseName(dir)
    const dup = (nameCount.get(base.toLowerCase()) ?? 0) > 1
    const parent = path.basename(path.dirname(dir))
    const name = dup && parent ? `${parent}/${base}` : base
    const branch = readGitBranch(dir)
    return `📂 ${name}${branch ? ` · 🌿 ${branch}` : ""}`
  }
  const bound = listProjects().find((p) => p.status !== "done" && projectGroupChatMatches(p, chatId))
  // 专属群：只协作本群项目，目录会话/其它项目一律不列（切了也会被强制路由拉回）
  if (bound) {
    const key = bound.sessionKey || projectSessionKey(bound.groupChatId || chatId, bound.id)
    push(key, `📦 ${bound.name} · 🌿 ${bound.featureBranch || "—"}`)
    return out.slice(0, 8)
  }
  if (mainDir) {
    const key = normalizeSessionKey(`${chatId}::${mainDir}`) || `${chatId}::${mainDir}`
    push(key, `${dirLabel(mainDir)}（主会话）`)
  }
  for (const p of listProjects()) {
    // 私聊/普通群：独立群项目不可切，不列
    if (!canEnterProjectFromChat(p, chatId)) continue
    const key = p.groupChatId
      ? (p.sessionKey || projectSessionKey(p.groupChatId, p.id))
      : projectSessionKey(chatId, p.id)
    push(key, `📦 ${p.name} · 🌿 ${p.featureBranch || "—"}`)
  }
  for (const { dir, main } of dirs) {
    if (main) continue
    const key = normalizeSessionKey(`${chatId}::${dir}`) || `${chatId}::${dir}`
    push(key, dirLabel(dir))
  }
  return out.slice(0, 8)
}

type SessionListEntry = {
  sessionKey: string
  running?: ReturnType<typeof getSessionAgentList>[number]
  current: boolean
}

/** /c ls 与首页 Tab 共用的扁平会话列表：当前 + 运行中 + 可切换，去重 */
function buildSessionListForChat(
  chatId: string | undefined,
  activeKey?: string,
): SessionListEntry[] {
  const runningAll = getSessionAgentList()
  const running = chatId
    ? runningAll.filter((s) => sessionBelongsToChat(s.sessionKey, chatId) || (!!activeKey && s.sessionKey === activeKey))
    : runningAll
  const runningByKey = new Map(running.map((s) => [s.sessionKey, s]))
  const switchable = buildSwitchableSessions(chatId, running, activeKey)
  const seen = new Set<string>()
  const out: SessionListEntry[] = []
  const push = (sessionKey: string) => {
    if (!sessionKey || seen.has(sessionKey)) return
    seen.add(sessionKey)
    out.push({
      sessionKey,
      running: runningByKey.get(sessionKey),
      current: !!activeKey && sessionKey === activeKey,
    })
  }
  if (activeKey) push(activeKey)
  for (const s of running.sort((a, b) => a.sessionKey.localeCompare(b.sessionKey))) push(s.sessionKey)
  for (const sw of switchable) push(sw.sessionKey)
  return out
}

function sessionListEntryToStatus(
  entry: SessionListEntry,
  index: number,
  qAll: QueueMessageItem[],
  now: number,
) {
  const channel = resolveChannelForSession(entry.sessionKey)
  const channelModel = resolveChannelModel(channel, "primary")
  const override = getSessionOverride(entry.sessionKey)
  const modelFields = tabModelFor(entry.sessionKey, entry.running)
  const s = entry.running ?? {
    sessionKey: entry.sessionKey,
    workspaceDir: workspaceDirFromSessionKey(entry.sessionKey),
    model: modelFields.model || override?.model || channelModel.model,
    modelParams: modelFields.modelParams ?? override?.modelParams ?? channelModel.modelParams,
  }
  return formatSessionStatusBlock(s, {
    index,
    current: entry.current,
    queueMessages: qAll,
    now,
    agentRunning: isSessionAgentRunning(entry.sessionKey),
    showType: false,
  })
}

function sameDirPath(a: string, b: string): boolean {
  return a.replace(/[\\/]+$/g, "").toLowerCase() === b.replace(/[\\/]+$/g, "").toLowerCase()
}

function sessionBelongsToChat(sessionKey: string, chatId: string): boolean {
  const sk = normalizeSessionKey(sessionKey) || sessionKey
  const ck = normalizeSessionKey(chatId) || chatId
  if (sk === ck) return true
  return sk.startsWith(`${ck}::`)
}

function scheduledTaskForSessionKey(sessionKey: string) {
  return findScheduledTaskBySessionKey(sessionKey, readTasksFromFile())
}

function tabLabelForSession(
  sessionKey: string,
  running?: { workspaceDir?: string; chatName?: string },
): string {
  const task = scheduledTaskForSessionKey(sessionKey)
  if (task) return formatScheduledTaskLabel(task.name)
  const pid = projectIdFromSessionKey(sessionKey)
  if (pid) {
    const p = getProject(pid)
    if (p) return `${p.name}${p.featureBranch ? ` · ${p.featureBranch}` : ""}`
    return pid
  }
  if (sessionKey.startsWith("temp_")) {
    return `临时 ${sessionKey.slice(5, 13)}`
  }
  const ws = workspaceDirFromSessionKey(sessionKey) || running?.workspaceDir
  if (ws) {
    const channel = resolveChannelForSession(sessionKey)
    const mainDir = effectiveWorkspaceDir(channel)
    const base = dirBaseName(ws)
    const branch = readGitBranch(ws)
    const mainTag = mainDir && sameDirPath(mainDir, ws) ? "（主）" : ""
    return `${base}${mainTag}${branch ? ` · ${branch}` : ""}`
  }
  return running?.chatName || sessionKey.slice(0, 28)
}

function sessionTabKind(sessionKey: string): SessionTabItem["kind"] {
  if (scheduledTaskForSessionKey(sessionKey)) return "task"
  if (projectIdFromSessionKey(sessionKey)) return "project"
  if (sessionKey.startsWith("temp_")) return "temp"
  const ws = workspaceDirFromSessionKey(sessionKey)
  if (!ws) return "other"
  const channel = resolveChannelForSession(sessionKey)
  const mainDir = effectiveWorkspaceDir(channel)
  if (mainDir && sameDirPath(mainDir, ws)) return "main"
  return "dir"
}

function isMainSessionKey(sessionKey: string, chatId: string): boolean {
  const ws = workspaceDirFromSessionKey(sessionKey)
  if (!ws) return false
  const channel = resolveChannelForSession(chatId)
  const mainDir = effectiveWorkspaceDir(channel)
  return !!mainDir && sameDirPath(mainDir, ws)
}

export function isDeletableSession(sessionKey: string, chatId: string): boolean {
  if (!sessionKey?.trim() || !chatId) return false
  if (projectIdFromSessionKey(sessionKey)) return false
  if (isMainSessionKey(sessionKey, chatId)) return false
  return true
}

function resolveMainSessionKey(chatId: string): string | undefined {
  const channel = resolveChannelForSession(chatId)
  const mainDir = effectiveWorkspaceDir(channel)
  if (!mainDir) return chatId
  return normalizeSessionKey(`${chatId}::${mainDir}`) || `${chatId}::${mainDir}`
}

/** 退出项目会话：清当前项目指针，活跃路由回主工作目录会话；返回回到的会话信息供回复展示 */
export async function leaveProjectSession(
  port: number,
  chatId: string,
): Promise<{ sessionKey?: string; workspaceDir?: string; branch?: string }> {
  setCurrentProjectId(null)
  const mainKey = resolveMainSessionKey(chatId)
  if (mainKey) await syncActiveSession(port, chatId, mainKey)
  const ws = mainKey ? workspaceDirFromSessionKey(mainKey) : undefined
  return {
    sessionKey: mainKey,
    workspaceDir: ws,
    branch: ws ? readGitBranch(ws) : undefined,
  }
}

/** 生成某会话的完整状态块（同 /s 当前对话段），供 /p leave 等场景复用 */
export async function formatCurrentSessionBlock(sessionKey: string, workspaceDir?: string): Promise<string> {
  const matched = getSessionAgentList().find((s) => s.sessionKey === sessionKey)
  const qMsgs = await getQueueMessages()
  const channel = resolveChannelForSession(sessionKey)
  const channelModel = resolveChannelModel(channel, "primary")
  const override = getSessionOverride(sessionKey)
  return formatSessionStatusBlock({
    sessionKey,
    chatType: matched?.chatType,
    workspaceDir: matched?.workspaceDir || workspaceDir,
    chatName: matched?.chatName,
    pid: matched?.pid,
    model: matched?.model || override?.model || channelModel.model,
    modelParams: matched?.modelParams ?? override?.modelParams ?? channelModel.modelParams,
    startedAt: matched?.startedAt,
  }, {
    current: true,
    queueMessages: qMsgs.filter((m) => m.sessionKey === sessionKey),
    agentRunning: !!matched,
    showType: false,
  })
}

/** 删除会话：停止 Agent、清 Resume、移出常用目录；若当前活跃则回主会话。项目会话请用 /p del。 */
export async function deleteUserSession(
  sessionKey: string,
  chatId?: string,
): Promise<{ ok: boolean; error?: string; label?: string }> {
  const key = sessionKey?.trim()
  if (!key) return { ok: false, error: "sessionKey 不能为空" }

  const lock = cachedLock()
  if (!lock?.port) return { ok: false, error: "服务未运行" }

  const resolvedChatId = chatId || await resolveMainChatId(lock.port)
  if (!resolvedChatId) return { ok: false, error: "未绑定主用户" }

  // 项目会话由项目表派生，只清上下文的话列表项不会消失，反而像是没生效
  if (projectIdFromSessionKey(key)) {
    return { ok: false, error: "项目会话请用 /p del 删除" }
  }
  if (isMainSessionKey(key, resolvedChatId)) {
    return { ok: false, error: "主会话不可删除" }
  }

  const label = tabLabelForSession(key)

  if (isSessionAgentRunning(key)) await stopSessionAgent(key)
  resetAllSessionContext(key)
  clearAgentFailStreaks(key)
  previousActiveSessionMap.delete(key)

  const ws = workspaceDirFromSessionKey(key)
  const owner = resolveChannelForSession(key)
  if (ws && owner) {
    // 只从该会话所属通道摘掉目录，别的通道的同名目录不受影响
    const favs = getChannelFavoriteWorkspaces(owner)
    const next = favs.filter((d) => !sameDirPath(d, ws))
    if (next.length !== favs.length) setChannelFavoriteWorkspaces(owner.id, next)
  }

  const activeKey = await getCurrentActiveSession(lock.port, resolvedChatId)
  if (activeKey === key) {
    const mainKey = resolveMainSessionKey(resolvedChatId)
    if (mainKey) {
      await syncActiveSession(lock.port, resolvedChatId, mainKey)
      setCurrentProjectId(null)
    }
  }

  return { ok: true, label }
}

export type SessionTabItem = {
  sessionKey: string
  label: string
  kind: "main" | "project" | "dir" | "temp" | "task" | "other"
  running: boolean
  current: boolean
  removable?: boolean
  model?: string
  modelParams?: string
}

/** 未运行会话也要能显示模型：跑着的用实时值，否则回落到 override，最后是通道默认 */
function tabModelFor(
  sessionKey: string,
  running?: { model?: string; modelParams?: string },
): { model?: string; modelParams?: string } {
  if (running?.model) return { model: running.model, modelParams: running.modelParams }
  const ov = getSessionOverride(sessionKey)
  if (ov) return { model: ov.model, modelParams: ov.modelParams }
  const fallback = resolveChannelModel(resolveChannelForSession(sessionKey), "primary")
  return fallback.model ? { model: fallback.model, modelParams: fallback.modelParams } : {}
}

async function buildTabsForChat(chatId: string, port: number): Promise<{ activeKey?: string; tabs: SessionTabItem[] }> {
  const activeKey = (await getCurrentActiveSession(port, chatId)) ?? undefined
  const list = buildSessionListForChat(chatId, activeKey)
  const tabs: SessionTabItem[] = list.map((entry) => ({
    sessionKey: entry.sessionKey,
    label: tabLabelForSession(entry.sessionKey, entry.running),
    kind: sessionTabKind(entry.sessionKey),
    running: isSessionAgentRunning(entry.sessionKey),
    current: entry.current,
    removable: isDeletableSession(entry.sessionKey, chatId) || sessionTabKind(entry.sessionKey) === "project",
    ...tabModelFor(entry.sessionKey, entry.running),
  }))
  return { activeKey, tabs: disambiguateTabLabels(tabs) }
}

/**
 * 目录 tab 的 label 只取末段目录名，D:\workspace\cp-scheduling 与 D:\bugfix\cp-scheduling
 * 会渲染成两行一模一样的文字。同名的补上父目录再区分。
 */
function disambiguateTabLabels(tabs: SessionTabItem[]): SessionTabItem[] {
  const dirOf = new Map<string, string>()
  for (const t of tabs) {
    const ws = workspaceDirFromSessionKey(t.sessionKey)
    if (ws) dirOf.set(t.sessionKey, ws)
  }
  const dupLabels = new Set(
    tabs.map((t) => t.label).filter((l, i, all) => all.indexOf(l) !== i),
  )
  if (dupLabels.size === 0) return tabs
  const peers = [...dirOf.values()]
  return tabs.map((t) => {
    const ws = dirOf.get(t.sessionKey)
    if (!ws || !dupLabels.has(t.label)) return t
    const suffix = t.label.slice(dirBaseName(ws).length)
    return { ...t, label: `${disambiguatePathLabel(ws, peers)}${suffix}` }
  })
}

/** 首页常用会话：对齐 /c（主用户 chat 下活跃 + 可切换） */
export async function listMainSessionTabs(): Promise<{
  ok: boolean
  chatId?: string
  activeKey?: string
  tabs: SessionTabItem[]
  error?: string
}> {
  const lock = cachedLock()
  if (!lock?.port) return { ok: false, error: "服务未运行", tabs: [] }
  const chatId = await resolveMainChatId(lock.port)
  if (!chatId) return { ok: false, error: "未绑定主用户", tabs: [] }
  const { activeKey, tabs } = await buildTabsForChat(chatId, lock.port)
  return { ok: true, chatId, activeKey, tabs }
}

/** 首页通道树：按配置通道聚合主用户 tabs + 全量运行会话 */
export async function listDashboardTree(): Promise<{
  ok: boolean
  channels: {
    channelId: string
    name: string
    mainUserChatId?: string
    mainTabs: SessionTabItem[]
    activeKey?: string
  }[]
  running: ReturnType<typeof getSessionAgentList>
  error?: string
}> {
  const lock = cachedLock()
  const channels = getChannels().filter((c) => c.enabled !== false)
  const out: {
    channelId: string
    name: string
    mainUserChatId?: string
    mainTabs: SessionTabItem[]
    activeKey?: string
  }[] = []
  for (const c of channels) {
    const rawMain = c.mainUserEnabled ? (c.mainUserChatId?.trim() || undefined) : undefined
    // 配置里是裸 chatId；会话/路由用 ch_xxx|chatId
    const mainUserChatId = rawMain ? makeChatKey(c.id, rawMain) : undefined
    if (!mainUserChatId || !lock?.port) {
      out.push({ channelId: c.id, name: c.name, mainUserChatId, mainTabs: [] })
      continue
    }
    try {
      const { activeKey, tabs } = await buildTabsForChat(mainUserChatId, lock.port)
      out.push({
        channelId: c.id,
        name: c.name,
        mainUserChatId,
        mainTabs: tabs,
        activeKey,
      })
    } catch {
      out.push({ channelId: c.id, name: c.name, mainUserChatId, mainTabs: [] })
    }
  }
  return {
    ok: true,
    channels: out,
    running: lock?.port
      ? getSessionAgentList().map((s) => {
          const task = scheduledTaskForSessionKey(s.sessionKey)
          if (!task) return s
          return {
            ...s,
            chatName: s.chatName || task.name,
            channelId: task.channelId,
          }
        })
      : [],
    error: lock?.port ? undefined : "服务未运行",
  }
}

/** 与 /c <序号> 相同：只改路由指针，不强制拉起 */
export async function switchMainSession(sessionKey: string): Promise<{ ok: boolean; error?: string }> {
  const key = sessionKey?.trim()
  if (!key) return { ok: false, error: "sessionKey 不能为空" }
  const lock = cachedLock()
  if (!lock?.port) return { ok: false, error: "服务未运行" }
  const chatId = await resolveMainChatId(lock.port)
  if (!chatId) return { ok: false, error: "未绑定主用户" }
  const pid = projectIdFromSessionKey(key)
  if (pid) {
    const proj = getProject(pid)
    const bound = listProjects().find((p) => p.status !== "done" && projectGroupChatMatches(p, chatId))
    if (bound && bound.id !== pid) {
      return { ok: false, error: "当前为项目专属群，不能切换其它项目" }
    }
    if (proj && !canEnterProjectFromChat(proj, chatId)) {
      return { ok: false, error: "该项目为独立群协作，请到专属群内操作（私聊不可进入）" }
    }
  }
  await syncActiveSession(lock.port, chatId, key)
  if (pid) {
    const proj = getProject(pid)
    if (proj?.groupChatId) {
      // 独立群不抢占主会话 current 指针
      setCurrentProjectId(null)
    } else {
      setCurrentProjectId(pid)
    }
    // 存量挂起（旧版 leave）的项目切回视作重新进入：恢复调度 + 确保 AI 工作目录就绪
    if (proj?.status === "paused") {
      proj.status = "active"
      saveProject(proj)
      if (!isPlainProject(proj)) await ensureCheckouts(projectRepoRefs(proj), proj.featureBranch)
    }
  }
  return { ok: true }
}

// ── /chat 命令处理 ────────────────────────────────────────

export async function handleChatCommand(tokens: string[], port: number, messageId: string, chatId?: string, patchMessageId?: string): Promise<void> {
  const reply = (ok: boolean, msg: string, buttons?: { label: string; cmd: string }[]) => reportCommandResult(port, messageId, ok, msg, chatId, buttons, patchMessageId ? { patchMessageId } : undefined)
  const sub = tokens[1]?.toLowerCase()

  const activeKey = chatId ? await getCurrentActiveSession(port, chatId) : undefined
  const list = buildSessionListForChat(chatId, activeKey)

  if (!sub || sub === "ls" || sub === "list") {
    if (list.length === 0) { await reply(true, "📭 当前没有会话"); return }
    const channel = chatId ? resolveChannelForSession(chatId) : undefined
      if (channel) {
        const resource = getAgentResource(channel.agentResourceId)
        if (resource) void warmupAgentModels(resource, channel, channel.model, channel.modelParams)
      }
    const qAll = await getQueueMessages()
    const now = Date.now()
    const blocks = list.map((entry, i) => sessionListEntryToStatus(entry, i + 1, qAll, now))
    const chatBtns: { label: string; cmd: string }[] = [{ label: "🔄 刷新", cmd: "/c ls" }]
    if (chatId) {
      const mainKey = resolveMainSessionKey(chatId)
      if (mainKey && mainKey !== chatId && mainKey !== activeKey) chatBtns.push({ label: "🏠 主会话", cmd: "/c main" })
    }
    list.slice(0, 10).forEach((_e, i) => {
      chatBtns.push({ label: `#${i + 1}`, cmd: `/c ${i + 1}` })
    })
    const usage = "💡 点序号切换 · /c main 回主会话 · /c stop <序号> 停止 · /c del <序号> 删除 · /c new <描述> 新临时会话"
    const parts = [`📋 会话列表 (${list.length})`, "", blocks.join("\n\n"), "", usage]
    await reply(true, parts.filter((x, i, a) => !(x === "" && a[i - 1] === "")).join("\n"), chatBtns)
    return
  }

  // 一键切回主会话：只改路由指针，项目/其他会话留在后台不动（区别于 /p leave 的清项目指针）
  if (sub === "main" || sub === "home" || sub === "0") {
    if (!chatId) { await reply(false, "❌ 无法定位会话来源"); return }
    const mainKey = resolveMainSessionKey(chatId)
    if (!mainKey || mainKey === chatId) { await reply(false, "❌ 未配置主工作目录，无法定位主会话"); return }
    if (activeKey === mainKey) {
      const ws = workspaceDirFromSessionKey(mainKey)
      const stalePid = getCurrentProjectId()
      if (stalePid) setCurrentProjectId(null)
      const lines = ["🏠 当前已在主会话"]
      if (stalePid) lines.push(`已清除残留的项目指针（${stalePid}）`)
      if (ws) lines.push(`主工作目录: ${ws}`)
      await reply(true, lines.join("\n"))
      return
    }
    setCurrentProjectId(null)
    const fromProject = activeKey ? projectIdFromSessionKey(activeKey) : null
    await syncActiveSession(port, chatId, mainKey)
    const ws = workspaceDirFromSessionKey(mainKey)
    const block = await formatCurrentSessionBlock(mainKey, ws)
    const head = fromProject
      ? "🏠 已切回主会话（项目留在后台，随时 /p use 或点项目按钮回去）"
      : "🏠 已切回主会话"
    const btns: { label: string; cmd: string }[] = [{ label: "切换会话 /c", cmd: "/c" }]
    if (fromProject) btns.push({ label: "退出项目 /p leave", cmd: "/p leave" })
    await reportCommandResult(port, messageId, true, [head, "", block].join("\n"), chatId, btns, {
      cardTitle: buildSessionCardTitle({ workspaceDir: ws }),
      sessionKey: mainKey,
      ...(patchMessageId ? { patchMessageId } : {}),
    })
    return
  }

  if (sub === "new") {
    const taskMsg = tokens.slice(2).join(" ").trim()
    if (!taskMsg) { await reply(false, "💡 用法：/c new <任务描述>\n例如：/c new 帮我检查一下服务器状态"); return }
    const taskId = `temp_${Date.now()}`
    const channelId = chatId ? parseChatKey(chatId).channelId : undefined
    const result = await launchIndependentAgent(taskId, "临时会话", taskMsg, "temp", chatId, channelId)
    if (result.ok && chatId) {
      const currentActive = await getCurrentActiveSession(port, chatId)
      if (currentActive && currentActive !== taskId) previousActiveSessionMap.set(taskId, currentActive)
      await syncActiveSession(port, chatId, taskId)
    }
    if (result.ok) {
      const newSession = getSessionAgentList().find((s) => s.sessionKey === taskId)
      const lines = [
        `🚀 新会话已创建:`,
        `  SessionKey: ${taskId}`,
        `  类型: 临时`,
        `  工作目录: ${newSession?.workspaceDir ? path.basename(newSession.workspaceDir) : "-"}`,
        `  PID: ${newSession?.pid || "-"}`,
        `  启动时间: ${new Date().toLocaleTimeString("zh-CN", { hour12: false })}`,
        `\n🔀 已切换到此会话，临时会话结束后将自动回退`,
      ]
      await reply(true, lines.join("\n"))
    } else {
      await reply(false, `❌ 启动失败: ${result.error ?? "未知错误"}`)
    }
    return
  }

  if (sub === "stop") {
    const idx = parseInt(tokens[2], 10)
    if (isNaN(idx) || idx < 1 || idx > list.length) {
      await reply(false, `❌ 无效序号，范围 1-${list.length}`)
      return
    }
    const entry = list[idx - 1]
    if (!isSessionAgentRunning(entry.sessionKey)) {
      await reply(false, `❌ #${idx} 未在运行`)
      return
    }
    await stopSessionAgent(entry.sessionKey)
    if (patchMessageId) {
      await handleChatCommand(["/c", "ls"], port, messageId, chatId, patchMessageId)
      return
    }
    await reply(true, `✅ 已停止会话 #${idx}: ${entry.running?.chatName || tabLabelForSession(entry.sessionKey, entry.running)}`)
    return
  }

  if (sub === "del" || sub === "delete" || sub === "rm") {
    const idx = parseInt(tokens[2], 10)
    if (isNaN(idx) || idx < 1 || idx > list.length) {
      await reply(false, `❌ 无效序号，范围 1-${list.length}`)
      return
    }
    const result = await deleteUserSession(list[idx - 1].sessionKey, chatId)
    if (!result.ok) {
      await reply(false, `❌ ${result.error ?? "删除失败"}`)
      return
    }
    if (patchMessageId) {
      await handleChatCommand(["/c", "ls"], port, messageId, chatId, patchMessageId)
      return
    }
    await reply(true, `🗑 已删除会话 #${idx}${result.label ? `: ${result.label}` : ""}`)
    return
  }

  const idx = parseInt(sub, 10)
  if (!isNaN(idx)) {
    if (idx < 1 || idx > list.length) {
      await reply(false, `❌ 无效序号，范围 1-${list.length}`)
      return
    }
    const entry = list[idx - 1]
    if (chatId) {
      await syncActiveSession(port, chatId, entry.sessionKey)
      const pid = projectIdFromSessionKey(entry.sessionKey)
      if (pid) setCurrentProjectId(pid)
    }
    if (patchMessageId) {
      await handleChatCommand(["/c", "ls"], port, messageId, chatId, patchMessageId)
      return
    }
    const qAll = await getQueueMessages()
    const block = sessionListEntryToStatus(entry, idx, qAll, Date.now())
    const hint = isSessionAgentRunning(entry.sessionKey)
      ? "💡 后续消息将路由到此会话"
      : "💡 该会话未运行，下一条消息会自动拉起（有历史则恢复上下文）"
    await reply(true, `🔀 已切换到会话 #${idx}\n\n${block}\n\n${hint}`)
    return
  }

  await reply(false, ["💡 /c 子命令（全称 /chat）","🔹 /c ls — 列出会话","🔹 /c <序号> — 切换到指定会话","🔹 /c main — 一键切回主会话","🔹 /c stop <序号> — 停止指定会话","🔹 /c del <序号> — 删除指定会话","🔹 /c new <描述> — 创建新临时会话"].join("\n"))
}

// ── 僵尸 Agent 检测 ──────────────────────────────────────

const ZOMBIE_REPLY_SILENCE_MS = 20 * 60 * 1000

async function isZombieAgent(sessionKey: string): Promise<boolean> {
  const lock = cachedLock()
  if (!lock?.port) return false
  try {
    const sk = encodeURIComponent(sessionKey)
    const [replyRes, msgRes] = await Promise.all([
      httpGet(`http://127.0.0.1:${lock.port}/api/session-last-reply?sessionKey=${sk}`) as Promise<{ lastReplyAt?: number | null }>,
      httpGet(`http://127.0.0.1:${lock.port}/api/session-earliest-msg?sessionKey=${sk}`) as Promise<{ earliestMsgTime?: number | null }>,
    ])
    const earliestMsgTime = msgRes?.earliestMsgTime ?? null
    if (earliestMsgTime === null) return false
    // Agent 有运行时活动（SDK/LLM 流事件）就不算僵尸——正在干长活未回消息是正常状态
    const agentActivityAt = getSessionAgentList().find((s) => s.sessionKey === sessionKey)?.lastActivityAt ?? 0
    const startedAt = getSessionAgentList().find((s) => s.sessionKey === sessionKey)?.startedAt ?? 0
    const lastActiveTime = Math.max(replyRes?.lastReplyAt ?? 0, startedAt, agentActivityAt)
    const startTime = Math.max(earliestMsgTime, lastActiveTime)
    return Date.now() - startTime > ZOMBIE_REPLY_SILENCE_MS
  } catch {
    return false
  }
}

// ── 会话调度主循环 ────────────────────────────────────────

let dispatching = false

function enqueueSessionLaunch(sessionKey: string, launches: Promise<void>[], fn: () => Promise<void>): boolean {
  if (!tryReserveLaunch(sessionKey)) return false
  launches.push(wrapLaunch(sessionKey, fn))
  return true
}

function sessionLaunchBusy(sessionKey: string): boolean {
  return isSessionAgentRunning(sessionKey)
}

/** 规划 + launch 全程互斥，避免 tick 重叠重复拉起 */
export async function dispatchSessionAgents(): Promise<void> {
  if (dispatching) return
  dispatching = true
  try {
    const launches = await _planSessionLaunches()
    if (launches.length > 0) await Promise.allSettled(launches)
  } finally {
    dispatching = false
  }
}

async function _planSessionLaunches(): Promise<Promise<void>[]> {
  const config = getConfig()
  const sessions = await getQueueSessions()
  const queueMsgs = await getQueueMessages()
  const pendingIdsBySession = new Map<string, string[]>()
  for (const m of queueMsgs) {
    if (!m.sessionKey || !m.messageId) continue
    const ids = pendingIdsBySession.get(m.sessionKey) ?? []
    ids.push(m.messageId)
    pendingIdsBySession.set(m.sessionKey, ids)
  }
  const pendingFor = (sessionKey: string) => pendingIdsBySession.get(sessionKey)
  const launches: Promise<void>[] = []

  const feishuOn = (config.channels ?? []).some((c) => c.enabled && c.type === "feishu")
  const groupKeys = sessions.filter((s) => s.chatType === "group").map((s) => extractChatId(s.sessionKey))
  if (groupKeys.length > 0 && feishuOn) await fetchChatNames(groupKeys)

  for (const { sessionKey, chatType, senderOpenId, hasPending } of sessions) {
    // 有新 .qmsg 时无视各类失败冷却，立即重试；仅 .claimed 重投遵守退避
    if (!hasPending && agentFailCooldownRemaining(sessionKey) > 0) continue
    if (!hasPending && launchFailCooldownRemaining(sessionKey) > 0) continue
    if (sessionLaunchBusy(sessionKey)) {
      if (await isZombieAgent(sessionKey)) {
        broadcastLog(`[Agent] ${sessionKey} 疑似僵尸(队列有消息且 ${ZOMBIE_REPLY_SILENCE_MS / 60_000}min 无回复消息)，强制终止并重启`, "WARN")
        await stopSessionAgent(sessionKey)
        await new Promise((r) => setTimeout(r, 1000))
      } else {
        continue
      }
    }

    const chatId = extractChatId(sessionKey)
    const mainUser = isMainUser(chatId, chatType)

    // 工作流节点会话由工作流引擎调度，dispatch 不代拉（缺节点上下文，会杂交成 p2p）
    if (sessionKey.includes("::wf_")) {
      broadcastLog(`[Agent] 工作流会话 ${sessionKey} 有残留消息，等待引擎调度，跳过`, "WARN")
      continue
    }
    // 裸 id 会话（临时/定时任务）：按队列 chatType 拉起；续聊走主工作目录 + Resume
    if (!sessionKey.includes("|") && !sessionKey.includes("::")) {
      const launchType: ChatType = chatType === "task" ? "task" : "temp"
      const resumableT = hasResumableAgentSession(sessionKey)
      // 队列唤醒必须带回任务绑定的通道，否则 getAgentResource(undefined) 会回落默认 SDK
      const task = readTasksFromFile().find((t) => t.id === sessionKey)
      const channelId = task?.channelId
        || getChannels().find((c) => c.enabled)?.id
      if (enqueueSessionLaunch(sessionKey, launches, async () => {
        const r = await launchAgent({
          sessionKey,
          chatType: launchType,
          meta: { chatId: sessionKey, chatType: launchType },
          channelId,
          modelOverride: task?.model,
          modelParamsOverride: task?.modelParams,
          pendingMessageIds: pendingFor(sessionKey),
        })
        if (!r.ok) await reportLaunchOutcome(sessionKey, r)
      })) {
        broadcastLog(`[Agent] 任务会话 ${sessionKey} 有新消息，正在启动Agent（${resumableT ? "Resume 恢复上下文" : "全新会话"}/${launchType}${channelId ? `/${channelId}` : ""}）`)
      }
      continue
    }

    // 项目专属会话：必须按项目语义拉起（worktree 目录 + project 类型 + Resume），
    // 否则会被当成 p2p 在主工作目录新建会话——工作目录、提示词、上下文全错
    const projId = projectIdFromSessionKey(sessionKey)
    const proj = projId ? getProject(projId) : undefined
    if (proj) {
      // leave 挂起的项目不自动拉起（会把刚释放的 feature 又占回去）；残留消息等 /p use 恢复后处理
      if (proj.status === "paused") {
        const lastAt = featureOccupiedNotifyAt.get(sessionKey) ?? 0
        if (Date.now() - lastAt > 10 * 60_000) {
          featureOccupiedNotifyAt.set(sessionKey, Date.now())
          await notifyChat(sessionKey, `💤 项目「${proj.name}」已退出会话，有消息待处理：/p use 重新进入后会自动继续`)
        }
        continue
      }
      // 拉起前确保 AI 工作目录就绪（缺失自动重建、切回 feature）；失败拦下并节流提醒（纯会话型无 git 直接放行）
      const co = isPlainProject(proj) ? { ok: true as const, error: undefined } : await ensureCheckouts(projectRepoRefs(proj), proj.featureBranch)
      if (!co.ok) {
        broadcastLog(`[Agent] 项目「${proj.name}」AI 工作目录不可用，暂缓拉起: ${co.error}`, "WARN")
        const lastAt = featureOccupiedNotifyAt.get(sessionKey) ?? 0
        if (Date.now() - lastAt > 10 * 60_000) {
          featureOccupiedNotifyAt.set(sessionKey, Date.now())
          await notifyChat(sessionKey, [
            `⚠️ 项目「${proj.name}」的 AI 工作目录不可用，消息暂无法处理：`,
            co.error || "",
            "",
            "处理故障后重发消息即可（缺失的目录会自动重建）",
          ].join("\n"))
        }
        continue
      }
      const resumableP = hasResumableAgentSession(sessionKey)
      if (enqueueSessionLaunch(sessionKey, launches, async () => {
        const r = await launchAgent({
          sessionKey,
          chatType: "project",
          chatName: `📦 ${proj.name}`,
          workingDirectory: proj.worktreePath,
          meta: { chatId, chatType: "project" },
          channelId: parseChatKey(chatId).channelId,
          taskMessage: resumableP ? undefined : buildProjectSessionPrompt(proj),
          pendingMessageIds: pendingFor(sessionKey),
        })
        if (!r.ok) await reportLaunchOutcome(sessionKey, r)
      })) {
        broadcastLog(`[Agent] 项目「${proj.name}」有新消息，正在启动Agent（${resumableP ? "Resume 恢复上下文" : "全新会话"}）`)
        if (shouldSendStartupNotify(sessionKey, resumableP)) await notifyChat(sessionKey, STARTUP_NOTIFY_TEXT)
      }
      continue
    }

    if (feishuOn && chatType === "p2p" && senderOpenId?.startsWith("ou_") && !chatNameCache.has(senderOpenId)) {
      await fetchUserNames([senderOpenId], parseChatKey(chatId).channelId)
    }

    const userName = senderOpenId ? chatNameCache.get(senderOpenId) : undefined
    const chatName = chatNameCache.get(chatId) || userName
    const resumable = hasResumableAgentSession(sessionKey)
    const p2pName = userName || resolveSessionChatName(sessionKey, undefined, senderOpenId) || chatId
    const label = chatType === "group"
      ? `群聊 ${chatName ? `「${chatName}」` : chatId}`
      : (mainUser ? `主用户私聊${userName ? ` (${userName})` : ""}` : `私聊 ${p2pName}`)
    const meta: LaunchMeta = { chatId, chatType: chatType as "p2p" | "group" }
    if (enqueueSessionLaunch(sessionKey, launches, async () => {
      const result = await launchSessionAgent(sessionKey, chatType as "p2p" | "group", meta, mainUser, senderOpenId, pendingFor(sessionKey))
      if (result.ok && chatId !== sessionKey) {
        const lock = cachedLock()
        if (lock?.port) {
          const cur = await getCurrentActiveSession(lock.port, chatId)
          if (!cur || cur === chatId) await syncActiveSession(lock.port, chatId, sessionKey)
        }
      }
      if (!result.ok) await reportLaunchOutcome(sessionKey, result)
    })) {
      broadcastLog(`[Agent] ${label} 有新消息，正在启动Agent（${resumable ? "Resume 恢复上下文" : "全新会话"}）${mainUser ? "(主工作目录)" : ""}`)
      if (shouldSendStartupNotify(sessionKey, resumable)) await notifyChat(sessionKey, STARTUP_NOTIFY_TEXT)
    }
  }
  return launches
}

// ── 初始化 ────────────────────────────────────────────────

export function initSessionDispatcher(): void {
  setChatNameResolver((chatId) => chatNameCache.get(chatId))
  // 名字查不到（如 bot 缺通讯录权限）时，用「通道名·访客」代替裸 sessionKey
  setChatNameFallback((chatId) => {
    const channel = getChannel(parseChatKey(chatId).channelId)
    return channel?.name ? `${channel.name}·访客` : undefined
  })
  const redispatchOnIdle = () => { void dispatchSessionAgents().catch(() => {}) }
  setAllAgentIdleHandlers(redispatchOnIdle)
}

