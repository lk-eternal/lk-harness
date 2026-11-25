/** 每轮信封里的环境信息：会话类型、通道名、现在、每条消息的发送时间；消息格式说明跟着宿主提示词走。
 * 走真实的提示词组装，只桩掉 Electron / 配置 / daemon 这些与注入无关的依赖。 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const h = vi.hoisted(() => ({
  channels: {
    ch_fs: { id: "ch_fs", type: "feishu" },
    ch_wx: { id: "ch_wx", type: "wechat" },
    ch_app: { id: "ch_app", type: "app" },
  } as Record<string, { id: string; type: string }>,
}))

vi.mock("electron", async () => {
  const p = await import("node:path")
  return { app: { isPackaged: false, getAppPath: () => p.resolve(process.cwd()), getPath: () => p.resolve(process.cwd(), "temp") } }
})
vi.mock("../electron/config-store", () => ({
  getConfig: () => ({ digitalIdentity: "", daemonPort: 19528, channels: [] }),
  getChannel: (id?: string) => (id ? h.channels[id] : undefined),
}))
vi.mock("../electron/daemon-client", () => ({ readLockFile: () => null }))
vi.mock("../electron/cron-scheduler", () => ({ readTasksFromFile: () => [] }))
vi.mock("../electron/ui-logger", () => ({ broadcastLog: () => {} }))

import { assembleProtocolBlocks, assembleTurnPrompt } from "../electron/prompt-assembler.js"
import { MESSAGE_FORMAT_BLOCK } from "../src/shared/turn-envelope.js"
import { joinPromptBlocks } from "../src/shared/prompt-markup.js"

beforeEach(() => {
  vi.spyOn(Date.prototype, "getTimezoneOffset").mockReturnValue(-480)
  vi.useFakeTimers({ toFake: ["Date"] })
  vi.setSystemTime(new Date(2026, 10, 25, 10, 19))
})
afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

const MSGS = [{ text: "你好", messageId: "m1" }]

describe("turn 标签的环境信息", () => {
  it("会话类型、现在（日期、星期、时间、时区）都在 turn 标签上", () => {
    const p = assembleTurnPrompt(MSGS, { meta: { chatType: "p2p" } })
    expect(p.split("\n")[0]).toBe('<turn chat="p2p" now="2026-11-25 周三 10:19 (UTC+8)">')
  })

  it.each([
    ["ch_fs", "飞书"],
    ["ch_wx", "微信"],
    ["ch_app", "应用内对话"],
  ])("会话键里的通道 %s 写成通道名 %s", (channelId, label) => {
    const p = assembleTurnPrompt(MSGS, { meta: { chatType: "p2p" }, sessionKey: `${channelId}|oc_main` })
    expect(p.split("\n")[0]).toContain(`channel="${label}"`)
  })

  it("认不出通道（没有会话键、通道已删）：不写 channel", () => {
    expect(assembleTurnPrompt(MSGS, {})).not.toContain("channel=")
    expect(assembleTurnPrompt(MSGS, { sessionKey: "ch_gone|oc_main" })).not.toContain("channel=")
  })

  it("消息的入队时间作为发送时间；没有入队时间的不写 at", () => {
    const sent = new Date(2026, 10, 25, 9, 5).getTime()
    const p = assembleTurnPrompt([{ text: "早", messageId: "m1", timestamp: sent }, { text: "晚", messageId: "m2" }], {})
    expect(p).toContain('<message id="m1" at="2026-11-25 09:05">\n早\n</message>')
    expect(p).toContain('<message id="m2">\n晚\n</message>')
  })
})

describe("宿主提示词里的消息格式", () => {
  it("每种会话都有，排在能力之后、用户规则和访客段之前", () => {
    const blocks = assembleProtocolBlocks({ meta: { chatType: "p2p" }, sessionKey: "ch_fs|oc_main", includeAdmin: true })
    const at = blocks.indexOf(MESSAGE_FORMAT_BLOCK)
    expect(at).toBe(2)
    expect(blocks[1]!.startsWith("# 能力")).toBe(true)
    expect(joinPromptBlocks(blocks)).toContain("# 消息格式")
  })
})
