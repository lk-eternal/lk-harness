import * as fs from "node:fs"
import * as path from "node:path"
import {
  channelIdFromSessionKey,
  chatIdFromSessionKey,
  normalizeSessionKey,
  parseChatKey,
  resolveChannelAudience,
  workspaceDirFromSessionKey,
  type ChannelAudience,
  type MessageChannel,
} from "./channel-types.js"
import {
  resolveChannelDefaultModel,
  resolveLaunchModel,
  type ChannelAudienceFields,
  type ChannelModelFields,
} from "./launch-model.js"
import { projectIdFromSessionKey } from "./project-types.js"
import {
  MIRROR_FILE,
  STATE_FILE,
  globalRoutingPath,
  listSessionEntryDirPaths,
  readSessionKeyFromEntryDir,
} from "./session-entry-paths.js"
import {
  getSessionRecord,
  patchSessionRecord,
  readOverridesSnapshot,
  withOverridesSnapshot,
  type SessionOverrideRecord,
} from "./session-overrides-store.js"

/**
 * 会话管理页的后端：把磁盘上存着的会话（含飞书 / 微信里别人的会话）整理成一张可管理的清单，
 * 并给出「恢复默认」「批量清理」这两个需要规则的操作的判定。
 *
 * 只依赖文件和会话存储，不依赖 Electron：运行态（谁在跑、排队几条、会话叫什么、配置里有哪些通道）
 * 都由调用方传进来，所以能用真实文件系统 + 临时目录直接测。
 */

export type ManagedSessionKind =
  /** 聊天键 + 工作目录：最常见的会话 */
  | "workspace"
  /** 只有聊天键、没有工作目录 */
  | "chat"
  | "project"
  | "task"
  | "temp"

export type ManagedChatType = "p2p" | "group" | "unknown"

export interface ManagedSession {
  sessionKey: string
  channelId: string
  channelName: string
  chatKey: string
  chatType: ManagedChatType
  audience: ChannelAudience
  kind: ManagedSessionKind
  /** 展示名：能查到的聊天名 / 用户名，否则是「群 / 私聊 + 尾号」 */
  name: string
  workspaceDir?: string
  /**
   * 别人的会话才有（私聊和群一视同仁）：最后一条用户消息。
   * 私聊只有一串 id、群名也未必查得到，靠它认出这个会话在聊什么；主用户自己的会话不需要。
   */
  preview?: string
  running: boolean
  queued: number
  /** 最近一次真实对话的时间（逐回合镜像的修改时间；没有镜像时退回会话状态文件）；完全没有落盘的会话为空 */
  lastActiveAt?: number
  /** 下次拉起时实际用的模型（和真实拉起走同一个 resolveLaunchModel） */
  model: string
  modelParams: string
  /** 下次拉起时实际用的供应商（配置里找不到时已回落成默认资源） */
  resourceId: string
  resourceName: string
  modelSource: "session" | "channel"
  resourceSource: "session" | "channel"
  /** 这个会话所属人群的通道默认模型（空 = 通道没配，由引擎选默认） */
  defaultModel: string
  /** 模型 / 供应商 / 推理档任一项是会话自己改过的 */
  customized: boolean
  /** 能不能在这里重置 / 恢复默认 / 删除 / 参与批量清理：只有其他人的普通会话可以 */
  manageable: boolean
  blockedReason?: string
  /** 能不能「恢复默认」：只有「只改了模型」的会话（供应商是跟着通道的） */
  canRestoreDefault: boolean
}

/** 清单需要知道的通道字段 */
export type ManagerChannel = ChannelModelFields &
  ChannelAudienceFields &
  Pick<MessageChannel, "id" | "name" | "type"> & { enabled?: boolean }

export interface ManagedSessionsEnv {
  userDataDir: string
  now: number
  channels: readonly ManagerChannel[]
  /** 和 getAgentResource 一样：找不到就回落到默认资源，而不是报错 */
  resolveResource: (id: string | undefined) => { id: string; name?: string }
  runningKeys: Iterable<string>
  /** 排队消息数，key 是规范化后的会话键 */
  queuedByKey: ReadonlyMap<string, number>
  routing: RoutingSnapshot
  /** 定时任务的 id（任务的会话键就是裸 id，凭键认不出） */
  taskIds: ReadonlySet<string>
  /**
   * 会话叫什么（聊天名 / 用户名 / 任务名）；查不到返回 undefined。
   * 只给真查到的名字：兜底名由清单按「群 / 私聊 + 尾号」统一生成，调用方不要自己编（编成同一个名字就分不清谁是谁了）
   */
  chatName: (sessionKey: string) => string | undefined
}

/** daemon 落盘的路由表里，这里用得到的部分 */
export interface RoutingSnapshot {
  chatType?: Record<string, string>
  sessionToChat?: Record<string, string>
}

// ── 主进程 ↔ 界面之间的返回形状 ───────────────────────────

export interface ManagerListResult {
  ok: boolean
  /** daemon 没在跑时删除 / 批量清理都做不了（路由表要由它清），界面据此置灰 */
  daemonRunning: boolean
  sessions: ManagedSession[]
  /** 磁盘上有、但解析不出所属通道的会话个数（通道已删 / 老格式） */
  skipped: number
  error?: string
}

export interface ManagerOpResult {
  ok: boolean
  error?: string
  /** 操作做完了，但有一点没能完全处理好 */
  warning?: string
  /** 为了让设置生效，顺带停掉了正在运行的会话 */
  stopped?: boolean
}

export interface CleanupPreviewResult {
  ok: boolean
  daemonRunning: boolean
  plan?: CleanupPlan
  error?: string
}

export interface CleanupRunResult {
  ok: boolean
  error?: string
  deleted: string[]
  /** 预览之后状态变了、不再符合条件而没删的 */
  skipped: { sessionKey: string; reason: string }[]
  failed: { sessionKey: string; error: string }[]
}

export const DEFAULT_CLEANUP_DAYS = 14
const DAY_MS = 24 * 60 * 60 * 1000
const PREVIEW_MAX_CHARS = 60

export function readRoutingSnapshot(userDataDir: string): RoutingSnapshot {
  try {
    const raw = JSON.parse(fs.readFileSync(globalRoutingPath(userDataDir), "utf8")) as RoutingSnapshot
    return { chatType: raw.chatType ?? {}, sessionToChat: raw.sessionToChat ?? {} }
  } catch {
    return {}
  }
}

function norm(sessionKey: string): string {
  return normalizeSessionKey(sessionKey) || sessionKey
}

export function classifySessionKind(sessionKey: string, isTask: boolean): ManagedSessionKind {
  if (isTask) return "task"
  if (projectIdFromSessionKey(sessionKey)) return "project"
  if (sessionKey.startsWith("temp_")) return "temp"
  if (workspaceDirFromSessionKey(sessionKey)) return "workspace"
  return "chat"
}

/** 不能在会话管理页里重置 / 删除的原因；能管返回 undefined */
export function manageBlockedReason(kind: ManagedSessionKind, audience: ChannelAudience): string | undefined {
  if (audience === "main") return "主用户的会话请在工作台的会话列表里管理"
  if (kind === "project") return "项目会话由项目管理"
  if (kind === "task") return "定时任务的会话由定时任务管理"
  if (kind === "temp") return "临时会话不在这里管理"
  return undefined
}

/** 查不到名字时的会话名：「群 / 私聊 + 尾号」。会话清单和工作台的消息队列共用，两处同名 */
export function fallbackName(chatKey: string, chatType: ManagedChatType): string {
  const raw = parseChatKey(chatKey).chatId
  const tail = raw.length > 8 ? raw.slice(-6) : raw
  if (chatType === "group") return `群 ${tail}`
  if (chatType === "p2p") return `私聊 ${tail}`
  return tail || "未知会话"
}

function mtimeOf(file: string): number | undefined {
  try {
    return fs.statSync(file).mtimeMs
  } catch {
    return undefined
  }
}

function lastActiveOf(entryDir: string | undefined): number | undefined {
  if (!entryDir) return undefined
  return mtimeOf(path.join(entryDir, MIRROR_FILE)) ?? mtimeOf(path.join(entryDir, STATE_FILE)) ?? mtimeOf(entryDir)
}

/** 镜像文件里最后一条用户消息，压成一行并截断 */
export function previewFromMirror(raw: string, maxChars = PREVIEW_MAX_CHARS): string | undefined {
  const lines = raw.split("\n")
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim()
    if (!line) continue
    try {
      const turn = JSON.parse(line) as { role?: unknown; text?: unknown }
      if (turn.role !== "user" || typeof turn.text !== "string") continue
      const flat = turn.text.replace(/\s+/g, " ").trim()
      if (!flat) continue
      return flat.length > maxChars ? `${flat.slice(0, maxChars)}…` : flat
    } catch { /* 坏行跳过 */ }
  }
  return undefined
}

/**
 * 预览每次刷新清单（8 秒一次）都要给每个别人的会话读一遍，镜像文件会随对话越写越大，所以只读末尾：
 * 先读最后 128KB，里面没有用户消息（末尾全是一整段很长的助手回复）再扩到 4MB，再没有就当没有。
 */
const PREVIEW_TAIL_WINDOWS = [128 * 1024, 4 * 1024 * 1024]

function readTail(file: string, size: number, bytes: number): string {
  const fd = fs.openSync(file, "r")
  try {
    const buf = Buffer.alloc(bytes)
    fs.readSync(fd, buf, 0, bytes, size - bytes)
    // 窗口起点多半落在一行中间（甚至半个汉字里）：那半行解析不出来，previewFromMirror 本来就会跳过坏行
    return buf.toString("utf8")
  } finally {
    fs.closeSync(fd)
  }
}

function readPreview(entryDir: string | undefined): string | undefined {
  if (!entryDir) return undefined
  const file = path.join(entryDir, MIRROR_FILE)
  try {
    const size = fs.statSync(file).size
    for (const bytes of PREVIEW_TAIL_WINDOWS) {
      if (size <= bytes) return previewFromMirror(fs.readFileSync(file, "utf8"))
      const hit = previewFromMirror(readTail(file, size, bytes))
      if (hit) return hit
    }
    return undefined
  } catch {
    return undefined
  }
}

function asChatType(v: string | undefined): ManagedChatType {
  return v === "p2p" || v === "group" ? v : "unknown"
}

/**
 * 磁盘上存着的会话（每个会话一个目录）+ daemon 路由表里登记过的会话（/c 能看到的），合并去重后逐个整理。
 * 解析不出所属通道的（老格式、通道已删）、应用内对话通道的，不列；返回 skipped 是前者的个数。
 */
export function listManagedSessions(env: ManagedSessionsEnv): { sessions: ManagedSession[]; skipped: number } {
  const channelsById = new Map(env.channels.map((c) => [c.id, c]))
  const running = new Set([...env.runningKeys].map(norm))
  const routing = env.routing

  // 全部会话共用一份会话存储快照：每个会话都要解析有效模型，不共用就是 N×N 次读文件
  return withOverridesSnapshot(() => {
    const records = readOverridesSnapshot().sessions
    const entries = new Map<string, { sessionKey: string; entryDir?: string }>()
    for (const dir of listSessionEntryDirPaths(env.userDataDir)) {
      const sk = readSessionKeyFromEntryDir(dir)
      if (sk) entries.set(norm(sk), { sessionKey: norm(sk), entryDir: dir })
    }
    for (const sk of Object.keys(routing.sessionToChat ?? {})) {
      const key = norm(sk)
      if (key && !entries.has(key)) entries.set(key, { sessionKey: key })
    }

    const sessions: ManagedSession[] = []
    let skipped = 0
    for (const { sessionKey, entryDir } of entries.values()) {
      const rec: SessionOverrideRecord | undefined = records[sessionKey]
      const routedChat = routing.sessionToChat?.[sessionKey]
      const channelId = channelIdFromSessionKey(sessionKey)
        ?? channelIdFromSessionKey(rec?.chatId ?? "")
        ?? channelIdFromSessionKey(routedChat ?? "")
      const channel = channelId ? channelsById.get(channelId) : undefined
      if (!channel) {
        skipped++
        continue
      }
      if (channel.type === "app") continue

      const kind = classifySessionKey(sessionKey, env.taskIds)
      const chatKey = channelIdFromSessionKey(sessionKey)
        ? chatIdFromSessionKey(sessionKey)
        : (rec?.chatId ?? routedChat ?? "")
      const chatType = asChatType(routing.chatType?.[chatKey])
      const audience = resolveChannelAudience({
        mainUserEnabled: channel.mainUserEnabled,
        mainUserChatId: channel.mainUserChatId,
        chatKey,
        sessionKey,
        chatType: kind === "task" || kind === "temp" || kind === "project"
          ? kind
          : chatType === "unknown" ? undefined : chatType,
      })

      const eff = resolveLaunchModel({ sessionKey, channel, audience, resolveResource: env.resolveResource })
      const resource = env.resolveResource(eff.resourceId)
      const blockedReason = manageBlockedReason(kind, audience)
      const modelSource: ManagedSession["modelSource"] = eff.modelSource === "session" ? "session" : "channel"
      const customized = modelSource === "session" || eff.resourceSource === "session" || !!rec?.thinkingLevel
      const manageable = !blockedReason

      sessions.push({
        sessionKey,
        channelId: channel.id,
        channelName: channel.name,
        chatKey,
        chatType,
        audience,
        kind,
        name: env.chatName(sessionKey) || fallbackName(chatKey, chatType),
        workspaceDir: workspaceDirFromSessionKey(sessionKey),
        preview: audience === "others" ? readPreview(entryDir) : undefined,
        running: running.has(sessionKey),
        queued: env.queuedByKey.get(sessionKey) ?? 0,
        lastActiveAt: lastActiveOf(entryDir),
        model: eff.model,
        modelParams: eff.modelParams,
        resourceId: eff.resolvedResourceId,
        resourceName: resource.name || resource.id,
        modelSource,
        resourceSource: eff.resourceSource,
        defaultModel: resolveChannelDefaultModel(channel, audience === "main" ? "primary" : "others").model,
        customized,
        manageable,
        blockedReason,
        canRestoreDefault: manageable && modelSource === "session" && eff.resourceSource === "channel",
      })
    }

    sessions.sort((a, b) => (b.lastActiveAt ?? -1) - (a.lastActiveAt ?? -1) || a.sessionKey.localeCompare(b.sessionKey))
    return { sessions, skipped }
  })
}

function classifySessionKey(sessionKey: string, taskIds: ReadonlySet<string>): ManagedSessionKind {
  return classifySessionKind(sessionKey, taskIds.has(sessionKey))
}

// ── 批量清理 ─────────────────────────────────────────────

export interface CleanupPlan {
  olderThanDays: number
  candidates: ManagedSession[]
  /** 没被选中的原因计数（一个会话只记第一条原因），预览里据此告诉用户「另有多少个因为 xx 被保留」 */
  excluded: {
    notManageable: number
    running: number
    queued: number
    customized: number
    noActivityTime: number
    recent: number
  }
}

/** 天数不合法（非数字、小于 1）时用默认值；上限 10 年，防止传个极大数溢出 */
export function normalizeCleanupDays(days: unknown): number {
  const n = typeof days === "number" ? days : Number(days)
  if (!Number.isFinite(n) || n < 1) return DEFAULT_CLEANUP_DAYS
  return Math.min(Math.floor(n), 3650)
}

/**
 * 批量清理该删哪些：其他人的普通会话里，久未活动、且没有任何「还在用 / 有人为设置」迹象的。
 * 排除顺序即计数顺序：不可管理 → 正在运行 → 有排队消息 → 自己改过模型 / 供应商 / 推理档 → 没有活动时间 → 还不够久。
 * 没有活动时间的（只在路由表里登记过、磁盘上什么都没有）无从判断多久没用，不动。
 */
export function planCleanup(
  sessions: readonly ManagedSession[],
  opts: { now: number; olderThanDays?: unknown; channelId?: string },
): CleanupPlan {
  const olderThanDays = normalizeCleanupDays(opts.olderThanDays)
  const cutoff = opts.now - olderThanDays * DAY_MS
  const excluded: CleanupPlan["excluded"] = { notManageable: 0, running: 0, queued: 0, customized: 0, noActivityTime: 0, recent: 0 }
  const candidates: ManagedSession[] = []
  for (const s of sessions) {
    if (opts.channelId && s.channelId !== opts.channelId) continue
    if (!s.manageable) excluded.notManageable++
    else if (s.running) excluded.running++
    else if (s.queued > 0) excluded.queued++
    else if (s.customized) excluded.customized++
    else if (s.lastActiveAt === undefined) excluded.noActivityTime++
    else if (s.lastActiveAt > cutoff) excluded.recent++
    else candidates.push(s)
  }
  return { olderThanDays, candidates, excluded }
}

// ── 恢复默认 ─────────────────────────────────────────────

export type RestoreDefaultResult = { ok: true; clearedKeys: string[] } | { ok: false; error: string }

/**
 * 「恢复默认」：清掉会话自己存的模型，让它重新跟随通道里按人群配的默认（以后改了通道默认也跟着变）。
 * 只管「只改了模型」的会话；单独指定了供应商的不动（那是另一种设置，换回去要重新选）。
 *
 * 会话存的模型可能记在会话自己名下，也可能记在它所属聊天（裸聊天键）名下被同一聊天下的会话共用：
 * 先清会话自己的，清完仍然生效的话再清聊天上的，保证清完页面上看到的就是默认。
 * 同时清掉和通道默认供应商相同的 resourceId——换模型时顺带存下的，留着以后通道改了供应商，它就变成一个隐形的供应商覆盖。
 *
 * 会话存储要由调用方先初始化；不能在 withOverridesSnapshot 里调用。
 */
export function restoreModelDefault(input: {
  sessionKey: string
  channel: ManagerChannel
  audience: ChannelAudience
  resolveResource: ManagedSessionsEnv["resolveResource"]
}): RestoreDefaultResult {
  const { sessionKey, channel, audience, resolveResource } = input
  const resolve = () => resolveLaunchModel({ sessionKey, channel, audience, resolveResource })
  const before = resolve()
  if (before.resourceSource === "session") return { ok: false, error: "该会话单独指定了供应商，不是只改了模型，不能一键恢复默认" }
  if (before.modelSource !== "session") return { ok: false, error: "该会话没有单独设置过模型" }

  const cleared: string[] = []
  const clear = (key: string): void => {
    const rec = getSessionRecord(key)
    if (!rec) return
    const patch: Partial<SessionOverrideRecord> = { model: undefined, modelParams: undefined }
    if (rec.resourceId && rec.resourceId === before.channelResourceId) patch.resourceId = undefined
    patchSessionRecord(key, patch)
    cleared.push(key)
  }
  clear(sessionKey)
  if (resolve().modelSource === "session") {
    const chat = chatIdFromSessionKey(sessionKey)
    if (chat && chat !== sessionKey) clear(chat)
  }
  if (resolve().modelSource === "session") return { ok: false, error: "清除后模型设置仍然生效，请重试" }
  return { ok: true, clearedKeys: cleared }
}
