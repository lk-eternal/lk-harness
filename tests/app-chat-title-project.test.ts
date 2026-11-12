import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"

/**
 * 会话摘要标题的生成入口：普通会话照常生成，项目会话不生成（它的名字就是项目名）。
 * 真实的 app-chat-title + 真实的标题文件（临时数据目录）；只把 electron、通道配置、引擎、日志顶掉。
 * 引擎的 complete 记着被调了几次——项目会话一次都不该调，那是白花的一次模型调用。
 */

let userData = ""
const complete = vi.fn(async () => ({ ok: true as const, text: "查日志" }))

vi.mock("electron", () => ({
  app: { getPath: () => userData },
  BrowserWindow: { getAllWindows: () => [] },
}))
vi.mock("../electron/config-store", () => ({
  getChannel: (id: string) => (id ? { id, type: "app", agentResourceId: "r1", model: "m1" } : undefined),
  getAgentResource: () => ({ id: "r1", type: "llm-custom", name: "r1" }),
}))
vi.mock("../electron/agent-engine", () => ({
  getAgentEngine: () => ({ kind: "llm", complete }),
}))
vi.mock("../electron/ui-logger", () => ({ broadcastLog: () => {} }))

type Title = typeof import("../electron/app-chat-title")
async function load(): Promise<Title> {
  vi.resetModules()
  return await import("../electron/app-chat-title")
}

const DIR = "ch_app|chat::D:\\work\\a"
const PROJECT = "ch_app|chat::project_abc123"

beforeEach(() => {
  userData = fs.mkdtempSync(path.join(os.tmpdir(), "app-chat-title-"))
  complete.mockClear()
})
afterEach(() => {
  fs.rmSync(userData, { recursive: true, force: true })
})

describe("ensureAppChatTitle：谁会生成摘要标题", () => {
  it("普通会话：取第一条消息生成标题并存下来", async () => {
    const title = await load()
    const load1 = vi.fn(async () => "帮我查一下昨天的日志")
    await title.ensureAppChatTitle(DIR, load1)
    expect(load1).toHaveBeenCalledTimes(1)
    expect(complete).toHaveBeenCalledTimes(1)
    expect(Object.values(title.getAppChatTitles())).toEqual(["查日志"])
  })

  it("项目会话：不取第一条消息、不调模型、不存标题", async () => {
    const title = await load()
    const load1 = vi.fn(async () => "帮我整理一下需求")
    await title.ensureAppChatTitle(PROJECT, load1)
    expect(load1).not.toHaveBeenCalled()
    expect(complete).not.toHaveBeenCalled()
    expect(title.getAppChatTitles()).toEqual({})
    expect(fs.existsSync(path.join(userData, "app-chat-titles.json"))).toBe(false)
  })

  it("项目会话不生成不影响同一时间的普通会话", async () => {
    const title = await load()
    await Promise.all([
      title.ensureAppChatTitle(PROJECT, async () => "项目里的第一句"),
      title.ensureAppChatTitle(DIR, async () => "普通会话的第一句"),
    ])
    expect(complete).toHaveBeenCalledTimes(1)
    expect(Object.keys(title.getAppChatTitles())).toHaveLength(1)
  })
})
