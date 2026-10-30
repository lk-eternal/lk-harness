import { appChatSessionName } from "./app-chat-types.js"
import { channelIdFromSessionKey, resolveChannelResourceId } from "./channel-types.js"

export type SessionGroupId = "main" | "other_p2p" | "group" | "project" | "task"

export interface DashboardQueueItem {
  fileId: string
  preview: string
  status?: "pending" | "processing"
}

export interface DashboardSessionNode {
  sessionKey: string
  label: string
  group: SessionGroupId
  running: boolean
  current?: boolean
  removable?: boolean
  kind?: string
  chatType?: string
  model?: string
  modelParams?: string
  /** 会话实际用的供应商：会话自己的（运行中 / 已存的）优先，没有就是所属通道按人群取的默认 */
  resourceId?: string
  workspaceDir?: string
  queue: DashboardQueueItem[]
}

export interface DashboardChannelNode {
  channelId: string
  name: string
  connected: boolean
  mainUserChatId?: string
  groups: Record<SessionGroupId, { sessions: DashboardSessionNode[] }>
}

export interface BuildDashboardTreeInput {
  channels: {
    id: string
    name: string
    connected: boolean
    mainUserChatId?: string
    /** 通道默认供应商：会话自己没存供应商时，行上的供应商按它补 */
    agentResourceId?: string
    othersAgentResourceId?: string
  }[]
  running: {
    sessionKey: string
    chatType?: string
    label?: string
    model?: string
    modelParams?: string
    resourceId?: string
    workspaceDir?: string
    chatName?: string
    /** 独立定时任务等无 chatKey 前缀时的所属通道 */
    channelId?: string
  }[]
  mainSwitchable: {
    channelId: string
    sessionKey: string
    label: string
    kind?: string
    removable?: boolean
    model?: string
    modelParams?: string
    resourceId?: string
  }[]
  activeKeyByChat: Record<string, string | undefined>
  queue: {
    sessionKey?: string
    fileId: string
    preview: string
    status?: "pending" | "processing"
  }[]
}

const GROUP_IDS: SessionGroupId[] = ["main", "other_p2p", "group", "project", "task"]

function emptyGroups(): Record<SessionGroupId, { sessions: DashboardSessionNode[] }> {
  return {
    main: { sessions: [] },
    other_p2p: { sessions: [] },
    group: { sessions: [] },
    project: { sessions: [] },
    task: { sessions: [] },
  }
}

function chatIdFromSessionKey(sessionKey: string): string {
  const idx = sessionKey.indexOf("::")
  return idx >= 0 ? sessionKey.slice(0, idx) : sessionKey
}

function sessionBelongsToChat(sessionKey: string, chatId: string): boolean {
  if (!chatId) return false
  if (sessionKey === chatId) return true
  return sessionKey.startsWith(`${chatId}::`)
}

/**
 * 比较两个会话键是不是同一个会话时用的口径（渲染进程无 process）：
 * sessionKey 含 Windows 路径，大小写与 \ / 混用都要能对上，
 * 否则队列消息挂不到会话上，行内的排队计数会一直是 0
 */
export function sessionKeyToken(sessionKey: string): string {
  return sessionKey.replace(/[\\/]+/g, "/").toLowerCase()
}

function sameSessionKey(a: string, b: string): boolean {
  if (a === b) return true
  return sessionKeyToken(a) === sessionKeyToken(b)
}

export function classifySessionGroup(
  sessionKey: string,
  chatType: string | undefined,
  opts?: { mainChatId?: string },
): SessionGroupId {
  if (/::project_[a-f0-9]+/i.test(sessionKey) || chatType === "project") return "project"
  if (sessionKey.startsWith("temp_") || chatType === "temp" || chatType === "task") return "task"
  if (chatType === "group") return "group"
  const main = opts?.mainChatId?.trim()
  if (main && sessionBelongsToChat(sessionKey, main)) return "main"
  if (chatType === "p2p" || !chatType) {
    if (main && sessionBelongsToChat(sessionKey, main)) return "main"
    if (main) return "other_p2p"
    return "main"
  }
  return "other_p2p"
}

function queueFor(sessionKey: string, queue: BuildDashboardTreeInput["queue"]): DashboardQueueItem[] {
  return queue
    .filter((q) => q.sessionKey && sameSessionKey(q.sessionKey, sessionKey))
    .map((q) => ({ fileId: q.fileId, preview: q.preview, status: q.status }))
}

function resolveChannelId(
  sessionKey: string,
  channels: BuildDashboardTreeInput["channels"],
): string | undefined {
  // sessionKey 前缀即 chatKey，channelId 就在里面，不需要按主用户猜
  const direct = channelIdFromSessionKey(sessionKey)
  if (direct && channels.some((c) => c.id === direct)) return direct
  const hit = channels.find((c) => c.mainUserChatId && sessionBelongsToChat(sessionKey, c.mainUserChatId))
  return hit?.id ?? channels[0]?.id
}

/** 会话自己没存供应商时，行上显示的供应商：所属通道按人群取的默认（私聊他人和群是「其他人」，其余是主用户） */
function channelDefaultResourceId(
  channel: BuildDashboardTreeInput["channels"][number] | undefined,
  group: SessionGroupId,
): string | undefined {
  const audience = group === "other_p2p" || group === "group" ? "others" : "main"
  if (!channel) return undefined
  const fields = { agentResourceId: channel.agentResourceId ?? "", othersAgentResourceId: channel.othersAgentResourceId }
  return resolveChannelResourceId(fields, audience) || undefined
}

export function buildDashboardTree(input: BuildDashboardTreeInput): { channels: DashboardChannelNode[] } {
  const channelCfgById = new Map(input.channels.map((c) => [c.id, c]))
  const nodes = input.channels.map((c) => ({
    channelId: c.id,
    name: c.name,
    connected: c.connected,
    mainUserChatId: c.mainUserChatId,
    groups: emptyGroups(),
  }))
  const byId = new Map(nodes.map((n) => [n.channelId, n]))

  const push = (channelId: string | undefined, node: DashboardSessionNode, opts?: { keepIdle?: boolean }) => {
    const ch = channelId ? byId.get(channelId) : undefined
    if (!ch) return
    // 他组默认只列运行中；主用户的可切换项是显式清单，空闲也要保留
    if (node.group !== "main" && !node.running && !opts?.keepIdle) return
    const list = ch.groups[node.group].sessions
    if (list.some((s) => sameSessionKey(s.sessionKey, node.sessionKey))) return
    const resourceId = node.resourceId || channelDefaultResourceId(channelCfgById.get(ch.channelId), node.group)
    if (resourceId) node.resourceId = resourceId
    list.push(node)
  }

  for (const r of input.running) {
    const owner = input.channels.find((c) => c.mainUserChatId && sessionBelongsToChat(r.sessionKey, c.mainUserChatId))
    const channelId = r.channelId ?? owner?.id ?? resolveChannelId(r.sessionKey, input.channels)
    const chMeta = channelId ? byId.get(channelId) : undefined
    const mainChat = chMeta?.mainUserChatId || owner?.mainUserChatId
    const group = classifySessionGroup(r.sessionKey, r.chatType, { mainChatId: mainChat })
    const chat = chatIdFromSessionKey(r.sessionKey)
    const active = input.activeKeyByChat[chat] || (mainChat ? input.activeKeyByChat[mainChat] : undefined)
    push(channelId, {
      sessionKey: r.sessionKey,
      label: r.label || r.chatName || r.sessionKey,
      group,
      running: true,
      current: !!(active && sameSessionKey(active, r.sessionKey)),
      chatType: r.chatType,
      model: r.model,
      modelParams: r.modelParams,
      resourceId: r.resourceId,
      workspaceDir: r.workspaceDir,
      queue: queueFor(r.sessionKey, input.queue),
    })
  }

  for (const sw of input.mainSwitchable) {
    const ch = byId.get(sw.channelId)
    const active = ch?.mainUserChatId ? input.activeKeyByChat[ch.mainUserChatId] : undefined
    // 项目/临时会话即使挂在主用户名下也应归各自的组，别一股脑塞进「主用户」
    const group = classifySessionGroup(sw.sessionKey, sw.kind, { mainChatId: ch?.mainUserChatId })
    push(sw.channelId, {
      sessionKey: sw.sessionKey,
      label: sw.label,
      group,
      running: false,
      current: !!(active && sameSessionKey(active, sw.sessionKey)),
      removable: sw.removable,
      kind: sw.kind,
      model: sw.model,
      modelParams: sw.modelParams,
      resourceId: sw.resourceId,
      queue: queueFor(sw.sessionKey, input.queue),
    }, { keepIdle: true })
  }

  return { channels: nodes }
}

export function groupLabel(id: SessionGroupId): string {
  switch (id) {
    case "main": return "主用户"
    case "other_p2p": return "私聊他人"
    case "group": return "群"
    case "project": return "项目"
    case "task": return "任务/临时"
  }
}

/**
 * 应用内对话通道的会话，在工作台里和对话页叫同一个名字（摘要标题 / 手动改的名字，没有时按 appChatSessionName 的规则）。
 * 树里的 label 是给飞书 / 微信会话用的「目录 · 分支」写法，应用内的会话用不上。
 * 只动 appChannelIds 里的通道；其它通道、取不到名字的会话（项目、定时任务）原样返回，没有变化时返回的还是同一个对象。
 */
export function withAppChatNames(
  channels: DashboardChannelNode[],
  appChannelIds: ReadonlySet<string>,
  titles: Readonly<Record<string, string>>,
): DashboardChannelNode[] {
  if (appChannelIds.size === 0) return channels
  let anyChanged = false
  const out = channels.map((ch) => {
    if (!appChannelIds.has(ch.channelId)) return ch
    let chChanged = false
    const groups = { ...ch.groups }
    for (const gid of GROUP_IDS) {
      let groupChanged = false
      const sessions = groups[gid].sessions.map((s) => {
        const label = appChatSessionName(s.sessionKey, titles, s.label) ?? s.label
        if (label === s.label) return s
        groupChanged = true
        return { ...s, label }
      })
      if (!groupChanged) continue
      groups[gid] = { ...groups[gid], sessions }
      chChanged = true
    }
    if (!chChanged) return ch
    anyChanged = true
    return { ...ch, groups }
  })
  return anyChanged ? out : channels
}

export { GROUP_IDS }
