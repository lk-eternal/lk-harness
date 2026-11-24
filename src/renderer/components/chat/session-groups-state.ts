import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import {
  applyGroupPatch,
  DEFAULT_GROUP_STATES,
  parseGroupStates,
  SESSION_GROUP_IDS,
  type GroupStatePatch,
  type SessionGroupStates,
  type SessionListGroupId,
} from "../../../shared/session-groups"
import { sameChatSession } from "./useAppChatItems"

/** 各分类的折叠 / 展开状态在电脑端（主进程）存着，桌面端和手机端共用；这里只是它的窗口 */
export interface GroupStatesApi {
  getStates(): Promise<unknown>
  setGroup(group: SessionListGroupId, patch: GroupStatePatch): Promise<{ ok: boolean; error?: string; sessionGroups?: unknown }>
  /** 任何一端改了都会推过来；返回取消订阅 */
  onStates(cb: (states: unknown) => void): () => void
}

export interface GroupStatesController {
  states(): SessionGroupStates
  update(group: SessionListGroupId, patch: GroupStatePatch): void
  dispose(): void
}

function sameStates(a: SessionGroupStates, b: SessionGroupStates): boolean {
  return a === b || SESSION_GROUP_IDS.every((id) => a[id].collapsed === b[id].collapsed && a[id].level === b[id].level)
}

/**
 * 读 + 订阅电脑端的分类状态，改的时候先在界面上生效（点了就变，不等一来一回），
 * 电脑端没改成就报错并按电脑端的真实状态回滚。做法和置顶（pinned-sessions.ts）一样：
 * 先订阅再拉取，拉取期间已经收到推送的话，以推送为准（拉取结果可能是更早的）。
 */
export function createGroupStatesController(
  api: GroupStatesApi,
  onChange: (states: SessionGroupStates) => void,
  onError: (message: string) => void,
): GroupStatesController {
  let current = parseGroupStates(undefined)
  let pushed = false
  let disposed = false

  const apply = (next: SessionGroupStates) => {
    if (sameStates(next, current)) return
    current = next
    onChange(next)
  }
  const resync = async () => {
    try {
      const states = await api.getStates()
      if (!disposed) apply(parseGroupStates(states))
    } catch { /* 取不到就先保持现状，下一次推送会校正 */ }
  }

  const unsubscribe = api.onStates((states) => { pushed = true; apply(parseGroupStates(states)) })
  void api.getStates().then((states) => { if (!pushed && !disposed) apply(parseGroupStates(states)) }).catch(() => { /* 同上 */ })

  return {
    states: () => current,
    update(group, patch) {
      const next = applyGroupPatch(current, group, patch)
      if (next === current) return
      apply(next)
      const failed = (message: string) => {
        if (disposed) return
        onError(message)
        void resync()
      }
      void api.setGroup(group, patch).then(
        (r) => {
          if (disposed) return
          if (!r.ok) return failed(r.error ?? "保存列表的折叠状态失败")
          if (r.sessionGroups) apply(parseGroupStates(r.sessionGroups))
        },
        (e: unknown) => failed(e instanceof Error ? e.message : String(e)),
      )
    },
    dispose() {
      disposed = true
      unsubscribe()
    },
  }
}

/** 桌面端对话页会话栏各分类的折叠 / 展开状态：和手机端同一份，哪边改了两边一起变 */
export function useSessionGroupStates(onError: (message: string) => void): [SessionGroupStates, (group: SessionListGroupId, patch: GroupStatePatch) => void] {
  const [states, setStates] = useState<SessionGroupStates>(DEFAULT_GROUP_STATES)
  const controller = useRef<GroupStatesController | null>(null)
  const onErrorRef = useRef(onError)
  onErrorRef.current = onError

  useEffect(() => {
    const api = window.electronAPI
    const c = createGroupStatesController(
      { getStates: api.appChatSessionGroups, setGroup: api.appChatSetSessionGroup, onStates: api.onAppChatSessionGroups },
      setStates,
      (message) => onErrorRef.current(message),
    )
    controller.current = c
    return () => { c.dispose(); controller.current = null }
  }, [])

  const update = useCallback((group: SessionListGroupId, patch: GroupStatePatch) => controller.current?.update(group, patch), [])
  return [states, update]
}

/** 渲染分类时需要的一切：记下的状态、怎么改它，以及「刚选中的会话要让它看得见」 */
export interface SessionGroupControl {
  states: SessionGroupStates
  change: (group: SessionListGroupId, patch: GroupStatePatch) => void
  /** 这个会话此刻要让它看得见（用户选中过它，之后还没动过分类标题或底部的展开按钮） */
  isRevealed: (sessionKey: string) => boolean
  /** 用户动了分类标题或底部的按钮：为选中的会话临时撑开的都收回，按记下的状态显示 */
  clearReveal: () => void
}

const noop = () => {}

/** 没接分类状态（比如只想看列表怎么排的场合）：都是默认状态，改了也不记 */
export const NO_GROUP_CONTROL: SessionGroupControl = {
  states: DEFAULT_GROUP_STATES,
  change: noop,
  isRevealed: () => false,
  clearReveal: noop,
}

export interface SeenSelection {
  key: string
  group: SessionListGroupId | undefined
}

/**
 * 这次选中要不要为它撑开分类：换选了另一个会话，或者当前会话换了分类（刚把当前项目归档了）。
 * 第一次选中（seen 为空）不算；会话还没出现在列表里（分类未知）时换不换分类也无从比较，同样不算。
 */
export function shouldReveal(seen: SeenSelection | null, selected: string, selectedGroup: SessionListGroupId | undefined): boolean {
  if (seen === null) return false
  if (!sameChatSession(seen.key, selected)) return true
  return seen.group !== undefined && selectedGroup !== undefined && seen.group !== selectedGroup
}

/**
 * 在记下的状态之上加「选中的会话要看得见」：换选了另一个会话（点通知跳过来的、新建了会话、列表里点了别的），
 * 或者当前会话换了分类（刚把当前项目归档了），它所在的分类就临时展开到看得见它。
 * 这只影响此刻的显示，不改记下的状态，所以另一端不受影响。
 * - 撑开过的会话都保持撑开，直到用户动分类标题或底部按钮：不然点一行就把上一个撑开的收回去，列表在手下跳。
 * - 第一次选中不算（开 app 或载入完成后默认选中的那个）：否则每次重启，默认选中的会话所在的分类都会被撑开，记住的折叠状态就白记了。
 */
export function useSessionGroupControl(
  states: SessionGroupStates,
  change: (group: SessionListGroupId, patch: GroupStatePatch) => void,
  selected: string | null,
  /** 选中的会话现在在哪一类；列表里还没有它（还在加载）时是 undefined */
  selectedGroup: SessionListGroupId | undefined,
): SessionGroupControl {
  const [revealed, setRevealed] = useState<readonly string[]>([])
  const [seen, setSeen] = useState<SeenSelection | null>(null)

  // 选中的变化在渲染期间就处理，不等 effect：撑开要和这次选中在同一次渲染里生效，
  // 会话栏滚到选中行（useScrollActiveIntoView）时，它已经在 DOM 里了
  if (selected !== null && (seen === null || seen.key !== selected || seen.group !== selectedGroup)) {
    setSeen({ key: selected, group: selectedGroup })
    if (shouldReveal(seen, selected, selectedGroup)) setRevealed((keys) => (keys.some((k) => sameChatSession(k, selected)) ? keys : [...keys, selected]))
  }

  const isRevealed = useCallback((sessionKey: string) => revealed.some((k) => sameChatSession(k, sessionKey)), [revealed])
  const clearReveal = useCallback(() => setRevealed((keys) => (keys.length > 0 ? [] : keys)), [])
  return useMemo(() => ({ states, change, isRevealed, clearReveal }), [states, change, isRevealed, clearReveal])
}
