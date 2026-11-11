import { describe, expect, it } from "vitest"
import {
  countUnreadElsewhere, emptySessionHint, loadSidebarCollapsed, saveSidebarCollapsed, sidebarToggleTitle, type StorageLike,
} from "../src/renderer/components/chat/sidebar-state"
import type { SessionStatus } from "../src/renderer/components/chat/useSessionActivity"

function memoryStorage(initial: Record<string, string> = {}): StorageLike & { data: Record<string, string> } {
  const data = { ...initial }
  return {
    data,
    getItem: (k) => (k in data ? data[k] : null),
    setItem: (k, v) => { data[k] = v },
  }
}

const brokenStorage: StorageLike = {
  getItem: () => { throw new Error("denied") },
  setItem: () => { throw new Error("denied") },
}

describe("会话栏收起状态的记忆", () => {
  it("没存过：展开", () => {
    expect(loadSidebarCollapsed(memoryStorage())).toBe(false)
  })

  it("存了收起：下次还是收起；存了展开：下次是展开", () => {
    const s = memoryStorage()
    saveSidebarCollapsed(true, s)
    expect(loadSidebarCollapsed(s)).toBe(true)
    saveSidebarCollapsed(false, s)
    expect(loadSidebarCollapsed(s)).toBe(false)
  })

  it("存的是不认识的值：当作展开，不当作收起", () => {
    expect(loadSidebarCollapsed(memoryStorage({ "lk.chat.sidebarCollapsed": "true" }))).toBe(false)
    expect(loadSidebarCollapsed(memoryStorage({ "lk.chat.sidebarCollapsed": "" }))).toBe(false)
  })

  it("存储读不了、写不了（被禁用）：不抛错，按展开处理", () => {
    expect(() => saveSidebarCollapsed(true, brokenStorage)).not.toThrow()
    expect(loadSidebarCollapsed(brokenStorage)).toBe(false)
  })

  it("没有存储可用（比如不在浏览器里）：不抛错", () => {
    expect(loadSidebarCollapsed()).toBe(false)
    expect(() => saveSidebarCollapsed(true)).not.toThrow()
  })
})

describe("收起后其他会话的新回复提示", () => {
  const statuses: Record<string, SessionStatus> = { a: "unread", b: "idle", c: "unread", d: "working", e: "unread" }
  const tab = (sessionKey: string, running = false) => ({ sessionKey, running })
  const statusOf = (key: string) => statuses[key] ?? "idle"

  it("数的是「没在看的会话里有新回复的」，运行中、空闲的不算", () => {
    expect(countUnreadElsewhere([tab("a"), tab("b"), tab("c"), tab("d")], () => false, statusOf)).toBe(2)
  })

  it("正在看的那个会话不算（它自己就在眼前）", () => {
    expect(countUnreadElsewhere([tab("a"), tab("c"), tab("e")], (k) => k === "a", statusOf)).toBe(2)
    expect(countUnreadElsewhere([tab("a")], (k) => k === "a", statusOf)).toBe(0)
  })

  it("没有会话：0", () => {
    expect(countUnreadElsewhere([], () => false, statusOf)).toBe(0)
  })

  it("把会话是否在运行传给状态判断", () => {
    const seen: [string, boolean][] = []
    countUnreadElsewhere([tab("a", true), tab("b", false)], () => false, (k, running) => { seen.push([k, running]); return "idle" })
    expect(seen).toEqual([["a", true], ["b", false]])
  })
})

describe("没选中会话时的提示", () => {
  it("还没加载完：加载中，不管会话栏收没收", () => {
    expect(emptySessionHint(false, false)).toBe("加载中…")
    expect(emptySessionHint(false, true)).toBe("加载中…")
  })

  it("会话栏展开着：指向左边", () => {
    expect(emptySessionHint(true, false)).toBe("← 选择会话，或新建一个")
  })

  it("会话栏收起着：不再指向左边（那里没有东西），让人去展开", () => {
    const hint = emptySessionHint(true, true)
    expect(hint).not.toContain("←")
    expect(hint).toContain("展开会话栏")
  })
})

describe("开关按钮的提示文字", () => {
  it("展开着：提示收起", () => {
    expect(sidebarToggleTitle(false, 0)).toBe("收起会话栏")
    expect(sidebarToggleTitle(false, 3)).toBe("收起会话栏")
  })

  it("收起着：提示展开；有新回复时带上数量", () => {
    expect(sidebarToggleTitle(true, 0)).toBe("展开会话栏")
    expect(sidebarToggleTitle(true, 2)).toBe("展开会话栏（2 个会话有新回复）")
  })
})
