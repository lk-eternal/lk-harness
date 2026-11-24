import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { isSessionPinned, movePinned, parsePinnedIds, pinFirst, setSessionPinned, type PinPlacement } from "../../../shared/app-chat-pins"

type PinsResult = { ok: boolean; error?: string; pins?: string[] }

/** 置顶状态在电脑端（主进程）存着，桌面端和手机端共用；这里只是它的窗口 */
export interface PinsApi {
  getPins(): Promise<string[]>
  setPinned(sessionKey: string, pinned: boolean): Promise<PinsResult>
  /** 拖动调整置顶的顺序：把 sessionKey 挪到 targetKey 的前面 / 后面 */
  movePin(sessionKey: string, targetKey: string, placement: PinPlacement): Promise<PinsResult>
  /** 任何一端改了置顶都会推过来；返回取消订阅 */
  onPins(cb: (pins: string[]) => void): () => void
}

export interface PinsController {
  ids(): readonly string[]
  toggle(sessionKey: string): void
  move(sessionKey: string, targetKey: string, placement: PinPlacement): void
  dispose(): void
}

/**
 * 拖动排好了新顺序 order，换算成「把 movedKey 挪到谁的前面 / 后面」，也就是 movePin 要的参数。
 * 挪到最后一位就放在前一项的后面，其余放在后一项的前面。
 */
export function pinMoveOf(order: readonly string[], movedKey: string): { targetKey: string; placement: PinPlacement } | undefined {
  const at = order.indexOf(movedKey)
  if (at < 0 || order.length < 2) return undefined
  return at < order.length - 1
    ? { targetKey: order[at + 1], placement: "before" }
    : { targetKey: order[at - 1], placement: "after" }
}

function sameList(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((x, i) => x === b[i])
}

/**
 * 读 + 订阅电脑端的置顶列表，改的时候先在界面上生效（点了就变，不等一来一回），
 * 电脑端没改成就报错并按电脑端的真实状态回滚。
 * 先订阅再拉取，拉取期间已经收到推送的话，以推送为准（拉取结果可能是更早的）。
 */
export function createPinsController(
  api: PinsApi,
  onChange: (ids: readonly string[]) => void,
  onError: (message: string) => void,
): PinsController {
  let ids: readonly string[] = []
  let pushed = false
  let disposed = false

  const apply = (next: readonly string[]) => {
    if (sameList(next, ids)) return
    ids = next
    onChange(next)
  }
  const resync = async () => {
    try {
      const pins = await api.getPins()
      if (!disposed) apply(parsePinnedIds(pins))
    } catch { /* 取不到就先保持现状，下一次推送会校正 */ }
  }

  const unsubscribe = api.onPins((pins) => { pushed = true; apply(parsePinnedIds(pins)) })
  void api.getPins().then((pins) => { if (!pushed && !disposed) apply(parsePinnedIds(pins)) }).catch(() => { /* 同上 */ })

  /** 先在界面上生效，再让电脑端去改；电脑端没改成就报错，并按电脑端的真实状态回滚 */
  const commit = (next: readonly string[], request: () => Promise<PinsResult>, fallbackError: string) => {
    apply(next)
    const failed = (message: string) => {
      if (disposed) return
      onError(message)
      void resync()
    }
    void request().then(
      (r) => {
        if (disposed) return
        if (!r.ok) return failed(r.error ?? fallbackError)
        if (r.pins) apply(parsePinnedIds(r.pins))
      },
      (e: unknown) => failed(e instanceof Error ? e.message : String(e)),
    )
  }

  return {
    ids: () => ids,
    toggle(sessionKey) {
      const pinned = !isSessionPinned(ids, sessionKey)
      commit(setSessionPinned(ids, sessionKey, pinned), () => api.setPinned(sessionKey, pinned), pinned ? "置顶失败" : "取消置顶失败")
    },
    move(sessionKey, targetKey, placement) {
      const next = movePinned(ids, sessionKey, targetKey, placement)
      if (next === ids) return
      commit(next, () => api.movePin(sessionKey, targetKey, placement), "调整置顶顺序失败")
    },
    dispose() {
      disposed = true
      unsubscribe()
    },
  }
}

export interface PinnedSessions {
  isPinned: (sessionKey: string) => boolean
  toggle: (sessionKey: string) => void
  /** 拖动调整置顶的顺序：把 sessionKey 挪到 targetKey 的前面 / 后面 */
  move: (sessionKey: string, targetKey: string, placement: PinPlacement) => void
  /** 把会话排成「置顶的在前」，置顶的按用户排的顺序 */
  order: <T extends { sessionKey: string }>(tabs: readonly T[]) => T[]
}

/** 对话页会话栏的置顶会话：和手机端同一份，哪边改了两边一起变 */
export function usePinnedSessions(onError: (message: string) => void): PinnedSessions {
  const [ids, setIds] = useState<readonly string[]>([])
  const controller = useRef<PinsController | null>(null)
  const onErrorRef = useRef(onError)
  onErrorRef.current = onError

  useEffect(() => {
    const api = window.electronAPI
    const c = createPinsController(
      { getPins: api.appChatPins, setPinned: api.appChatSetPinned, movePin: api.appChatMovePin, onPins: api.onAppChatPins },
      setIds,
      (message) => onErrorRef.current(message),
    )
    controller.current = c
    return () => { c.dispose(); controller.current = null }
  }, [])

  const isPinned = useCallback((sessionKey: string) => isSessionPinned(ids, sessionKey), [ids])
  const toggle = useCallback((sessionKey: string) => controller.current?.toggle(sessionKey), [])
  const move = useCallback((sessionKey: string, targetKey: string, placement: PinPlacement) => controller.current?.move(sessionKey, targetKey, placement), [])
  const order = useCallback(<T extends { sessionKey: string }>(tabs: readonly T[]) => pinFirst(tabs, ids), [ids])
  return useMemo(() => ({ isPinned, toggle, move, order }), [isPinned, toggle, move, order])
}
