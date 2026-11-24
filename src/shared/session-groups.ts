// ── 会话列表的分类：项目 / 会话 / 已归档（对话页侧栏、手机端会话抽屉共用，纯逻辑） ─────────
// 每一类可以整体折叠；展开时先显示 5 个，底部「展开更多」再看 5 个，之后「展开全部」，全部展开后「收起」。
// 折叠和展开档位存在电脑端（主进程，见 electron/app-chat-session-groups.ts），桌面端和手机端读同一份，
// 所以两端看到的列表样子一致。这里放两端共用的规则：怎么分类、怎么算当前该显示哪些行、读到的东西怎么整理。

import { ARCHIVED_GROUP_TITLE } from "./session-archive.js"

/** 会话列表的三类（注意：和工作台 dashboard-tree 里按人群分的 SessionGroupId 是两回事） */
export type SessionListGroupId = "project" | "chat" | "archived"

export const SESSION_GROUP_IDS: readonly SessionListGroupId[] = ["project", "chat", "archived"]

export const SESSION_GROUP_TITLES: Record<SessionListGroupId, string> = {
  project: "项目",
  chat: "会话",
  archived: ARCHIVED_GROUP_TITLE,
}

/** 展开档位：0 = 前 5 个，1 = 前 10 个，2 = 全部 */
export type GroupLevel = 0 | 1 | 2

export const GROUP_PAGE_SIZE = 5

const LEVELS: readonly GroupLevel[] = [0, 1, 2]

/** 各档位最多显示几个（不含置顶的） */
const LEVEL_LIMITS: Record<GroupLevel, number> = { 0: GROUP_PAGE_SIZE, 1: GROUP_PAGE_SIZE * 2, 2: Infinity }

export interface GroupViewState {
  collapsed: boolean
  level: GroupLevel
}

export type SessionGroupStates = Record<SessionListGroupId, GroupViewState>

export type GroupStatePatch = Partial<GroupViewState>

/** 没存过时的样子：项目、会话展开，已归档收起（和以前的已归档分组一致） */
export const DEFAULT_GROUP_STATES: SessionGroupStates = {
  project: { collapsed: false, level: 0 },
  chat: { collapsed: false, level: 0 },
  archived: { collapsed: true, level: 0 },
}

interface Groupable {
  kind: string
  archived?: boolean
}

/** 会话属于哪一类：已归档的先算（归档只有项目有），其次项目，其余都是会话 */
export function groupOf(tab: Groupable): SessionListGroupId {
  if (tab.archived) return "archived"
  return tab.kind === "project" ? "project" : "chat"
}

/** 按类分开，各类内部保持原来的顺序 */
export function splitGroups<T extends Groupable>(tabs: readonly T[]): Record<SessionListGroupId, T[]> {
  const groups: Record<SessionListGroupId, T[]> = { project: [], chat: [], archived: [] }
  for (const t of tabs) groups[groupOf(t)].push(t)
  return groups
}

export function parseGroupId(raw: unknown): SessionListGroupId | undefined {
  return SESSION_GROUP_IDS.find((id) => id === raw)
}

function parseLevel(raw: unknown): GroupLevel | undefined {
  return raw === 0 || raw === 1 || raw === 2 ? raw : undefined
}

/** 从不可信的输入里取出合法字段；一个合法字段都没有就返回 undefined */
export function parseGroupPatch(raw: unknown): GroupStatePatch | undefined {
  if (!raw || typeof raw !== "object") return undefined
  const { collapsed, level } = raw as Record<string, unknown>
  const patch: GroupStatePatch = {}
  if (typeof collapsed === "boolean") patch.collapsed = collapsed
  const parsedLevel = parseLevel(level)
  if (parsedLevel !== undefined) patch.level = parsedLevel
  return Object.keys(patch).length > 0 ? patch : undefined
}

/** 把读到的东西整理成各类的状态：没存过、格式不对、某个字段不对，都退回默认值 */
export function parseGroupStates(raw: unknown): SessionGroupStates {
  const source = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {}
  const states = { ...DEFAULT_GROUP_STATES }
  for (const id of SESSION_GROUP_IDS) {
    states[id] = { ...DEFAULT_GROUP_STATES[id], ...parseGroupPatch(source[id]) }
  }
  return states
}

/** 改某一类的状态：返回新状态；已经是目标状态时原样返回同一个对象（调用方据此省掉写盘和刷新） */
export function applyGroupPatch(states: SessionGroupStates, id: SessionListGroupId, patch: GroupStatePatch): SessionGroupStates {
  const current = states[id]
  const next: GroupViewState = { ...current, ...patch }
  if (next.collapsed === current.collapsed && next.level === current.level) return states
  return { ...states, [id]: next }
}

export type GroupRowStatus = "working" | "unread" | "idle"

/** 一批会话里最需要让用户知道的状态：有在回复的，其次有新回复没看的 */
export function summarizeStatus<T>(rows: readonly T[], statusOf: (row: T) => GroupRowStatus): GroupRowStatus {
  let unread = false
  for (const row of rows) {
    const status = statusOf(row)
    if (status === "working") return "working"
    if (status === "unread") unread = true
  }
  return unread ? "unread" : "idle"
}

export interface GroupFooter {
  /** more：再多看 5 个；all：看全部；less：收回前 5 个 */
  kind: "more" | "all" | "less"
  /** 点了之后要记下的档位 */
  to: GroupLevel
}

export interface GroupView<T> {
  /** 此刻是不是整类折着 */
  collapsed: boolean
  /** 此刻要画的行 */
  shown: T[]
  /** 此刻被收起的行（整类折着时是全部） */
  hidden: T[]
  footer: GroupFooter | null
}

/**
 * 一类会话此刻该显示哪些行。rows 已经排好序（置顶的在前）。
 * - 置顶的行始终显示，不占那 5 个名额。
 * - keep 命中的行（刚被选中的会话）一定要看得见：它所在的类即使折着也先展开，被档位收起的话把档位提到够看见它。
 *   这只影响此刻的显示，不改记下的状态；谁来决定 keep 见 useSessionGroupControl。
 */
export function viewGroup<T>(
  rows: readonly T[],
  state: GroupViewState,
  opts: { isPinned: (row: T) => boolean; keep?: (row: T) => boolean },
): GroupView<T> {
  const keep = opts.keep ?? (() => false)
  if (state.collapsed && !rows.some(keep)) return { collapsed: true, shown: [], hidden: [...rows], footer: null }

  const pinned = rows.filter(opts.isPinned)
  const rest = rows.filter((row) => !opts.isPinned(row))
  const level = LEVELS.slice(state.level).find((lv) => !rest.slice(LEVEL_LIMITS[lv]).some(keep)) ?? 2
  const shownRest = rest.slice(0, LEVEL_LIMITS[level])
  const hidden = rest.slice(LEVEL_LIMITS[level])

  return { collapsed: false, shown: [...pinned, ...shownRest], hidden, footer: footerOf(level, hidden.length, rest.length) }
}

function footerOf(level: GroupLevel, hiddenCount: number, restCount: number): GroupFooter | null {
  if (hiddenCount > 0) return level === 0 ? { kind: "more", to: 1 } : { kind: "all", to: 2 }
  return restCount > GROUP_PAGE_SIZE ? { kind: "less", to: 0 } : null
}
