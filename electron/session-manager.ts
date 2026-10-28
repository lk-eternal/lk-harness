import { app } from "electron"
import { normalizeSessionKey, type MessageChannel } from "../src/shared/channel-types"
import {
  listManagedSessions,
  planCleanup,
  readRoutingSnapshot,
  restoreModelDefault,
  type CleanupPreviewResult,
  type CleanupRunResult,
  type ManagedSession,
  type ManagerListResult,
  type ManagerOpResult,
} from "../src/shared/managed-sessions"
import { purgeSessionEntry } from "../src/shared/session-entry-paths"
import { initSessionOverridesStore } from "../src/shared/session-overrides-store"
import { clearAgentFailStreaks, resetAllSessionContext } from "./agent-engine/control"
import { getAgentResource, getChannels } from "./config-store"
import { readTasksFromFile } from "./cron-scheduler"
import { purgeSessionRouting, readLockFile } from "./daemon-client"
import { resolveSessionChatName } from "./session-chat-name"
import {
  getQueueMessages,
  getSessionAgentList,
  isSessionAgentRunning,
  previousActiveSessionMap,
  stopSessionAgent,
} from "./session-dispatcher"

/**
 * 会话管理页的主进程部分：把配置、运行态、磁盘上的会话收集起来交给 src/shared/managed-sessions 整理，
 * 并执行重置 / 恢复默认 / 删除 / 批量清理。规则（谁能管、清单怎么排、清理选谁）都在 shared 里，这里只做 IO。
 *
 * 换模型、停止沿用已有的 session:set-model、agent:stop-session，不在这里重复。
 */

const userData = (): string => app.getPath("userData")
const keyOf = (sessionKey: string): string => normalizeSessionKey(sessionKey) || sessionKey

async function collect(): Promise<{ sessions: ManagedSession[]; skipped: number }> {
  initSessionOverridesStore(userData())
  const queuedByKey = new Map<string, number>()
  for (const m of await getQueueMessages()) {
    if (!m.sessionKey) continue
    const k = keyOf(m.sessionKey)
    queuedByKey.set(k, (queuedByKey.get(k) ?? 0) + 1)
  }
  const taskNames = new Map(readTasksFromFile().map((t) => [t.id, t.name]))
  return listManagedSessions({
    userDataDir: userData(),
    now: Date.now(),
    channels: getChannels(),
    resolveResource: (id) => {
      const r = getAgentResource(id)
      return { id: r.id, name: r.name }
    },
    runningKeys: getSessionAgentList().map((s) => s.sessionKey),
    queuedByKey,
    routing: readRoutingSnapshot(userData()),
    taskIds: new Set(taskNames.keys()),
    chatName: (k) => taskNames.get(k) ?? resolveSessionChatName(k),
  })
}

const daemonPort = (): number | undefined => readLockFile()?.port || undefined

export async function listSessionsForManager(): Promise<ManagerListResult> {
  try {
    const { sessions, skipped } = await collect()
    return { ok: true, daemonRunning: !!daemonPort(), sessions, skipped }
  } catch (e) {
    return { ok: false, daemonRunning: !!daemonPort(), sessions: [], skipped: 0, error: errorText(e) }
  }
}

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

/**
 * 界面发来的只有会话键：一律回到清单里按当前状态查一遍再动手，不信界面传来的任何「这个会话能管」的结论。
 */
async function findManageable(
  sessionKey: string,
): Promise<{ ok: true; session: ManagedSession; channel: MessageChannel } | { ok: false; error: string }> {
  const key = keyOf(typeof sessionKey === "string" ? sessionKey.trim() : "")
  if (!key) return { ok: false, error: "sessionKey 不能为空" }
  const { sessions } = await collect()
  const session = sessions.find((s) => s.sessionKey === key)
  if (!session) return { ok: false, error: "会话不存在（可能已被删除）" }
  if (!session.manageable) return { ok: false, error: session.blockedReason ?? "该会话不能在这里管理" }
  const channel = getChannels().find((c) => c.id === session.channelId)
  if (!channel) return { ok: false, error: "会话所属的通道不存在" }
  return { ok: true, session, channel }
}

/** 恢复默认：清掉会话自己存的模型，跟随通道里其他人的默认；正在运行的要停掉，下条消息才会按新的拉起 */
export async function restoreSessionDefault(sessionKey: string): Promise<ManagerOpResult> {
  try {
    const found = await findManageable(sessionKey)
    if (!found.ok) return found
    const { session, channel } = found
    if (!session.canRestoreDefault) {
      return { ok: false, error: session.resourceSource === "session" ? "该会话单独指定了供应商，不能一键恢复默认" : "该会话没有单独设置过模型" }
    }
    initSessionOverridesStore(userData())
    const r = restoreModelDefault({
      sessionKey: session.sessionKey,
      channel,
      audience: session.audience,
      resolveResource: (id) => {
        const res = getAgentResource(id)
        return { id: res.id, name: res.name }
      },
    })
    if (!r.ok) return { ok: false, error: r.error }
    const stopped = isSessionAgentRunning(session.sessionKey)
    if (stopped) await stopSessionAgent(session.sessionKey)
    return { ok: true, stopped }
  } catch (e) {
    return { ok: false, error: errorText(e) }
  }
}

/** 重置：丢掉 resume / 账本，下条消息全新会话。静默，不给对方发消息（和 /reset 不同，/reset 是在对话里发的会回复） */
export async function resetManagedSession(sessionKey: string): Promise<ManagerOpResult> {
  try {
    const found = await findManageable(sessionKey)
    if (!found.ok) return found
    const key = found.session.sessionKey
    const stopped = isSessionAgentRunning(key)
    if (stopped) await stopSessionAgent(key)
    resetAllSessionContext(key)
    return { ok: true, stopped }
  } catch (e) {
    return { ok: false, error: errorText(e) }
  }
}

/**
 * 删掉一个别人的会话的全部落盘数据。和工作台里删主用户会话的 deleteUserSession 刻意分开：
 * 那个按「主用户的聊天」来判断主会话、回落活跃会话、并且会清掉通道的主目录配置和常用目录，
 * 用在别人的会话上会误伤主用户的配置。这里只动这个会话自己的东西：停进程、丢上下文、删目录、清路由。
 */
async function deleteSessionData(session: ManagedSession, port: number): Promise<ManagerOpResult> {
  const key = session.sessionKey
  const stopped = isSessionAgentRunning(key)
  if (stopped) await stopSessionAgent(key)
  resetAllSessionContext(key)
  purgeSessionEntry(userData(), key)
  clearAgentFailStreaks(key)
  previousActiveSessionMap.delete(key)
  await purgeSessionRouting(port, key)
  // purgeSessionRouting 吞掉了错误；路由表由 daemon 同步落盘，读回来看一眼是否清掉了
  const left = readRoutingSnapshot(userData()).sessionToChat ?? {}
  const stillRouted = Object.keys(left).some((k) => keyOf(k) === key)
  return stillRouted
    ? { ok: true, stopped, warning: "会话数据已删除，但服务的路由表里还登记着它（服务可能没有响应），列表里可能还会看到" }
    : { ok: true, stopped }
}

export async function deleteManagedSession(sessionKey: string): Promise<ManagerOpResult> {
  try {
    const port = daemonPort()
    if (!port) return { ok: false, error: "服务未运行，无法清理路由，请先启动服务" }
    const found = await findManageable(sessionKey)
    if (!found.ok) return found
    return await deleteSessionData(found.session, port)
  } catch (e) {
    return { ok: false, error: errorText(e) }
  }
}

export async function previewSessionCleanup(opts: { olderThanDays?: number; channelId?: string }): Promise<CleanupPreviewResult> {
  try {
    const { sessions } = await collect()
    return {
      ok: true,
      daemonRunning: !!daemonPort(),
      plan: planCleanup(sessions, { now: Date.now(), olderThanDays: opts?.olderThanDays, channelId: opts?.channelId || undefined }),
    }
  } catch (e) {
    return { ok: false, daemonRunning: !!daemonPort(), error: errorText(e) }
  }
}

/**
 * 执行批量清理。界面传来的 sessionKeys 只是「用户在预览里看到并确认的那批」，
 * 这里重新按当前状态算一遍该清的集合，只删两边都有的：预览之后变成运行中 / 来了排队消息 / 被人改了设置的，不删。
 */
export async function runSessionCleanup(opts: {
  olderThanDays?: number
  channelId?: string
  sessionKeys: string[]
}): Promise<CleanupRunResult> {
  const result: CleanupRunResult = { ok: true, deleted: [], skipped: [], failed: [] }
  try {
    const port = daemonPort()
    if (!port) return { ...result, ok: false, error: "服务未运行，无法清理路由，请先启动服务" }
    const requested = [...new Set((Array.isArray(opts?.sessionKeys) ? opts.sessionKeys : []).filter((k) => typeof k === "string").map((k) => keyOf(k.trim())).filter(Boolean))]
    const { sessions } = await collect()
    const plan = planCleanup(sessions, { now: Date.now(), olderThanDays: opts?.olderThanDays, channelId: opts?.channelId || undefined })
    const allowed = new Map(plan.candidates.map((s) => [s.sessionKey, s]))
    const existing = new Set(sessions.map((s) => s.sessionKey))
    for (const key of requested) {
      const session = allowed.get(key)
      if (!session) {
        result.skipped.push({ sessionKey: key, reason: existing.has(key) ? "状态已变化，不再符合清理条件" : "会话已不存在" })
        continue
      }
      // 计划是刚算的，但逐个删的过程中某个会话可能刚好开始运行
      if (isSessionAgentRunning(key)) {
        result.skipped.push({ sessionKey: key, reason: "刚刚开始运行" })
        continue
      }
      try {
        const r = await deleteSessionData(session, port)
        if (r.ok) result.deleted.push(key)
        else result.failed.push({ sessionKey: key, error: r.error ?? "删除失败" })
      } catch (e) {
        result.failed.push({ sessionKey: key, error: errorText(e) })
      }
    }
    return result
  } catch (e) {
    return { ...result, ok: false, error: errorText(e) }
  }
}
