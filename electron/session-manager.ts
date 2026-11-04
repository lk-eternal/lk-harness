import { app } from "electron"
import { normalizeSessionKey, type MessageChannel } from "../src/shared/channel-types"
import {
  CHANNEL_MODEL_FIELDS,
  bucketOthers,
  clearTargets,
  followingRunningKeys,
  type ChannelImpactClearResult,
  type ChannelImpactPreviewResult,
  type ChannelImpactStopResult,
  type ImpactDefault,
} from "../src/shared/channel-model-impact"
import { othersDefaultChanged, othersDefaultOf } from "../src/shared/launch-model"
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
import { lookupChatName } from "./session-chat-name"
import {
  fetchChatNames,
  getQueueMessages,
  getSessionAgentList,
  isSessionAgentRunning,
  previousActiveSessionMap,
  rememberP2pNames,
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
  const queueMessages = await getQueueMessages()
  for (const m of queueMessages) {
    if (!m.sessionKey) continue
    const k = keyOf(m.sessionKey)
    queuedByKey.set(k, (queuedByKey.get(k) ?? 0) + 1)
  }
  const running = getSessionAgentList()
  const taskNames = new Map(readTasksFromFile().map((t) => [t.id, t.name]))

  // 私聊对方叫什么：名字缓存按 open_id 存，而磁盘上的会话只有聊天键，要靠 open_id 才对得上。
  // 运行中的会话和队列里的消息都带着 open_id（队列、工作台树就是靠它显示出名字的），
  // 这里每次列清单前先按聊天键记下来（落盘），下面按聊天键查就和它们看到的是同一个名字；
  // 会话结束、应用重启之后清单里也还认得出是谁。群不记：群里的 open_id 是发言人，不是这个群。
  const people: { sessionKey: string; chatType?: string; senderOpenId?: string }[] = [...running]
  for (const m of queueMessages) {
    if (m.sessionKey) people.push({ sessionKey: m.sessionKey, chatType: m.chatType, senderOpenId: m.senderOpenId })
  }
  rememberP2pNames(people)

  return listManagedSessions({
    userDataDir: userData(),
    now: Date.now(),
    channels: getChannels(),
    resolveResource: (id) => {
      const r = getAgentResource(id)
      return { id: r.id, name: r.name }
    },
    runningKeys: running.map((s) => s.sessionKey),
    queuedByKey,
    routing: readRoutingSnapshot(userData()),
    taskIds: new Set(taskNames.keys()),
    // 只给查到过的名字：查不到由清单按「群 / 私聊 + 尾号」显示，不要在这里编「通道名·访客」——
    // 那样所有没查到名字的会话都叫同一个名字，群也叫「访客」，根本分不清谁是谁
    chatName: (k) => taskNames.get(k) ?? lookupChatName(k),
  })
}

/**
 * 清单里的群，后台去问飞书要群名（不等结果：清单马上返回，8 秒后下一次刷新就带上了）。
 * 磁盘上只有一串 id，群名只有问飞书才知道；原来只在群运行时才问，空闲的群永远没有名字。
 * 分批、冷却、不重复问都在 fetchChatNames 里，每次刷新都调用也不会多打接口。
 */
function fillGroupNamesInBackground(sessions: readonly ManagedSession[]): void {
  const feishu = new Set(getChannels().filter((c) => c.type === "feishu" && c.enabled !== false).map((c) => c.id))
  const keys = sessions.filter((s) => s.chatType === "group" && feishu.has(s.channelId)).map((s) => s.chatKey)
  if (keys.length > 0) void fetchChatNames(keys).catch(() => {})
}

const daemonPort = (): number | undefined => readLockFile()?.port || undefined

export async function listSessionsForManager(): Promise<ManagerListResult> {
  try {
    const { sessions, skipped } = await collect()
    fillGroupNamesInBackground(sessions)
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

// ── 保存通道里「其他人」的默认模型之后，对已有的别人的会话的影响 ─────────────────────
//
// 其他人的会话每次拉起都按通道当前的默认解析（没单独设置过的）：改了默认，下一条消息起自动生效，
// 但正在运行的会话是按旧默认拉起的，要等它结束；单独改过模型的会话则一直不跟着变。
// 保存时先让用户看到这些，再由用户决定要不要停掉运行中的、要不要把单独改过的清掉。
// 只动其他人的会话；主用户自己的会话、项目 / 任务 / 临时会话不在 collect 出的「可管理的其他人会话」里，碰不到。

/** 界面传来的未保存的草稿里，只认会影响其他人默认模型的字段和 allowOthers，其余一律忽略 */
function applyModelDraft(saved: MessageChannel, draft: unknown): MessageChannel {
  const d = (draft && typeof draft === "object" ? draft : {}) as Record<string, unknown>
  const next: MessageChannel = { ...saved }
  for (const f of CHANNEL_MODEL_FIELDS) {
    if (f in d) next[f] = typeof d[f] === "string" ? (d[f] as string) : ""
  }
  if (typeof d.allowOthers === "boolean") next.allowOthers = d.allowOthers
  return next
}

function describeDefault(channel: MessageChannel): ImpactDefault {
  const d = othersDefaultOf(channel)
  return { ...d, resourceName: d.resourceId ? (getAgentResource(d.resourceId).name ?? "") : "" }
}

const NO_BUCKET = { total: 0, running: 0 }

/** 保存前预览：按已保存的通道配置 + 界面上还没保存的模型字段，算出其他人的默认会不会变、影响到几个会话 */
export async function previewChannelModelImpact(channelId: string, draft: unknown): Promise<ChannelImpactPreviewResult> {
  try {
    const saved = getChannels().find((c) => c.id === channelId)
    if (!saved) return { ok: true }
    const after = applyModelDraft(saved, draft)
    const oldDefault = describeDefault(saved)
    const newDefault = describeDefault(after)
    const base = { oldDefault, newDefault, providerChanged: oldDefault.resourceId !== newDefault.resourceId }
    // 保存后不允许其他人使用：别人的会话拉不起来，默认怎么变都不影响谁，不用问
    if (!after.allowOthers || !othersDefaultChanged(saved, after)) {
      return { ok: true, impact: { ...base, changed: false, total: 0, following: NO_BUCKET, modelPinned: NO_BUCKET, providerPinned: NO_BUCKET } }
    }
    const { sessions } = await collect()
    return { ok: true, impact: { ...base, changed: true, ...bucketOthers(sessions, channelId) } }
  } catch (e) {
    return { ok: false, error: errorText(e) }
  }
}

/**
 * 清除其他人会话「单独改过的模型」，让它们重新跟随通道默认。必须在保存通道之前调用：
 * 要按当时的通道配置判断「这个会话存的供应商和通道默认一致」才能清得干净；保存之后默认变了，
 * 那份遗留的供应商就会被当成会话单独指定的而清不掉。
 * 单独指定了供应商的会话不动。不停止会话（停止在保存之后由 stopOthersFollowingDefault 做）。
 */
export async function clearOthersModelOverrides(channelId: string): Promise<ChannelImpactClearResult> {
  const out: ChannelImpactClearResult = { ok: true, cleared: 0, failed: [] }
  try {
    const channel = getChannels().find((c) => c.id === channelId)
    if (!channel) return { ...out, ok: false, error: "通道不存在" }
    const { sessions } = await collect()
    for (const s of clearTargets(sessions, channelId)) {
      try {
        const r = restoreModelDefault({
          sessionKey: s.sessionKey,
          channel,
          audience: s.audience,
          resolveResource: (id) => {
            const res = getAgentResource(id)
            return { id: res.id, name: res.name }
          },
        })
        if (r.ok) out.cleared++
        else out.failed.push({ sessionKey: s.sessionKey, error: r.error })
      } catch (e) {
        out.failed.push({ sessionKey: s.sessionKey, error: errorText(e) })
      }
    }
    return { ...out, ok: out.failed.length === 0 }
  } catch (e) {
    return { ...out, ok: false, error: errorText(e) }
  }
}

/** 保存之后调用：停掉其他人的、正在运行的、跟随默认的会话，它们的下一条消息会按新默认重新拉起 */
export async function stopOthersFollowingDefault(channelId: string): Promise<ChannelImpactStopResult> {
  const out: ChannelImpactStopResult = { ok: true, stopped: 0, failed: [] }
  try {
    if (!getChannels().some((c) => c.id === channelId)) return { ...out, ok: false, error: "通道不存在" }
    const { sessions } = await collect()
    for (const key of followingRunningKeys(sessions, channelId)) {
      try {
        // 收集之后、逐个停之前，这个会话可能刚好自己结束了
        if (!isSessionAgentRunning(key)) continue
        await stopSessionAgent(key)
        out.stopped++
      } catch (e) {
        out.failed.push({ sessionKey: key, error: errorText(e) })
      }
    }
    return { ...out, ok: out.failed.length === 0 }
  } catch (e) {
    return { ...out, ok: false, error: errorText(e) }
  }
}
