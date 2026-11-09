import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"
import QueuePanel, { type QueueMessageView } from "../src/renderer/components/dashboard/QueuePanel"
import { queueRowView } from "../src/renderer/components/dashboard/queue-row"

/**
 * 工作台「消息队列」每一行的通道徽标和会话名。
 * 现场：别人的私聊在队列里被标成「私聊 📁AI Support（主）」，像主用户的会话；
 * 会话树里只有运行中的别人的会话，Agent 一起一停，同一行就在「AI Support  甘露」和「私聊 📁AI Support（主）」之间来回换。
 * 所以别人的会话的名字只认主进程算好的 sessionLabel，不看会话树。
 */

const KEY = "ch_f|oc_p2p_ccc333::D:\\ws\\a"

function msg(over: Partial<QueueMessageView> = {}): QueueMessageView {
  return {
    index: 0,
    fileId: "f1",
    preview: "开课时间 2026-10-29",
    status: "processing",
    sessionKey: KEY,
    chatType: "p2p",
    timestamp: Date.UTC(2026, 10, 6, 7, 8, 35),
    sessionLabel: "甘露",
    channelName: "AI Support",
    audience: "others",
    ...over,
  }
}

type Meta = { channelName: string; label: string }
const OLD_FALLBACK = "私聊 📁a（主）"

function render(m: QueueMessageView, tree?: Meta): string {
  const metaByKey = new Map<string, Meta>(tree && m.sessionKey ? [[m.sessionKey.toLowerCase(), tree]] : [])
  return renderToStaticMarkup(
    createElement(QueuePanel, { messages: [m], metaByKey, labelOf: () => OLD_FALLBACK, onDelete: () => {} }),
  )
}

describe("queueRowView：行上的通道徽标和会话名", () => {
  it("别人的会话：名字只认主进程算的，会话树里有没有它（运行 / 空闲）都一样", () => {
    const running = queueRowView(msg(), { channelName: "AI Support", label: "AI Support·访客" }, () => OLD_FALLBACK)
    const idle = queueRowView(msg(), undefined, () => OLD_FALLBACK)
    expect(running).toEqual({ channelName: "AI Support", label: "甘露" })
    expect(idle).toEqual(running)
  })

  it("主用户自己的会话：会话树里有就用树里的名字（应用内会话在树里叫摘要标题），没有才退回主进程的标签", () => {
    const mine = msg({ audience: "main", sessionLabel: "私聊 📁a（主）" })
    expect(queueRowView(mine, { channelName: "AI Support", label: "我的会话标题" }, () => "兜底").label).toBe("我的会话标题")
    expect(queueRowView(mine, undefined, () => "兜底").label).toBe("兜底")
  })

  it("通道徽标取消息自带的；没有就取会话树里的", () => {
    expect(queueRowView(msg({ channelName: "甲" }), { channelName: "乙", label: "x" }, () => "").channelName).toBe("甲")
    expect(queueRowView(msg({ channelName: undefined }), { channelName: "乙", label: "x" }, () => "").channelName).toBe("乙")
    expect(queueRowView(msg({ channelName: undefined }), undefined, () => "").channelName).toBeUndefined()
  })

  it("旧版主进程没带 audience / sessionLabel：照旧，树里有用树的，没有用兜底", () => {
    const legacy = msg({ audience: undefined, sessionLabel: undefined, channelName: undefined })
    expect(queueRowView(legacy, { channelName: "AI Support", label: "树里的名字" }, () => "兜底")).toEqual({ channelName: "AI Support", label: "树里的名字" })
    expect(queueRowView(legacy, undefined, () => "兜底")).toEqual({ channelName: undefined, label: "兜底" })
  })
})

describe("QueuePanel：别人的会话那一行不闪", () => {
  it("会话运行中（树里有）和空闲（树里没有）渲染出来的整行一模一样，都是「通道徽标 + 对方的名字」", () => {
    const whileRunning = render(msg(), { channelName: "AI Support", label: "AI Support·访客" })
    const whileIdle = render(msg())
    expect(whileIdle).toBe(whileRunning)
    expect(whileIdle).toContain("甘露")
    expect(whileIdle).toContain("AI Support")
    expect(whileIdle).not.toContain("（主）")
  })

  it("空闲时也有通道徽标（旧版树里没有这个会话就没有徽标）", () => {
    expect(render(msg())).toContain('title="所属通道"')
  })

  it("两个人的消息各叫各的名字", () => {
    const html = renderToStaticMarkup(
      createElement(QueuePanel, {
        messages: [
          msg({ fileId: "a", sessionKey: "ch_f|oc_a::D:\\ws\\a", sessionLabel: "甘露" }),
          msg({ fileId: "b", sessionKey: "ch_f|oc_b::D:\\ws\\a", sessionLabel: "李四" }),
        ],
        metaByKey: new Map(),
        labelOf: () => OLD_FALLBACK,
        onDelete: () => {},
      }),
    )
    expect(html).toContain("甘露")
    expect(html).toContain("李四")
    expect(html).not.toContain("（主）")
  })

  it("主用户自己的会话行不变：树里有用树里的名字", () => {
    const html = render(msg({ audience: "main", sessionLabel: "私聊 📁a（主）" }), { channelName: "AI Support", label: "a（主） · main" })
    expect(html).toContain("a（主） · main")
    expect(html).not.toContain("私聊 📁a（主）")
  })
})
