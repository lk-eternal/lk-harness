/** 会话记忆的提示词：lk-harness-memory 挂在哪些会话，提示词「能力」里的会话记忆组和首轮带入的 memory 就出现在哪些会话。
 * 走真实的提示词组装，只桩掉 Electron / 配置 / daemon 这些与注入无关的依赖。 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"

const h = vi.hoisted(() => ({ userData: "" }))

vi.mock("electron", async () => {
  const p = await import("node:path")
  return { app: { isPackaged: false, getAppPath: () => p.resolve(process.cwd()), getPath: () => h.userData } }
})
vi.mock("../electron/config-store", () => ({
  getConfig: () => ({ digitalIdentity: "", daemonPort: 19528, channels: [] }),
  getChannel: () => undefined,
}))
vi.mock("../electron/daemon-client", () => ({ readLockFile: () => null }))
vi.mock("../electron/cron-scheduler", () => ({ readTasksFromFile: () => [] }))
vi.mock("../electron/ui-logger", () => ({ broadcastLog: () => {} }))

import {
  assembleProtocolBlocks,
  assembleSdkWorkerTurnPrompt,
  assembleTurnPrompt,
  type PromptAssemblyContext,
} from "../electron/prompt-assembler.js"
import { buildBuiltinMcpServers, MEMORY_MCP_KEY, shouldMountMemoryMcp } from "../src/shared/harness-mcp-store.js"
import { resolveVisitorLimits } from "../src/shared/visitor-limits.js"
import { saveSessionMemory } from "../src/shared/session-memory.js"
import { joinPromptBlocks } from "../src/shared/prompt-markup.js"

beforeEach(() => {
  h.userData = fs.mkdtempSync(path.join(os.tmpdir(), "lk-memprompt-"))
})
afterEach(() => { fs.rmSync(h.userData, { recursive: true, force: true }) })

const MEMORY_GROUP = "## 会话记忆（lk-harness-memory）"
const protocol = (ctx: PromptAssemblyContext) => joinPromptBlocks(assembleProtocolBlocks(ctx))
const count = (s: string, sub: string) => s.split(sub).length - 1
const MSGS = [{ text: "用户这一句", messageId: "m1" }]

const MAIN: PromptAssemblyContext = { meta: { chatType: "p2p" }, sessionKey: "ch_a|oc_main", includeAdmin: true }
const PROJECT: PromptAssemblyContext = { meta: { chatType: "project" }, sessionKey: "ch_a|oc_group::project_p1", includeAdmin: false }
const FULL_OTHER: PromptAssemblyContext = { meta: { chatType: "p2p" }, sessionKey: "ch_a|oc_x", includeAdmin: false }
const TASK: PromptAssemblyContext = { meta: { chatType: "task" }, sessionKey: "task_1", includeAdmin: false }
const VISITOR: PromptAssemblyContext = {
  meta: { chatType: "p2p" },
  sessionKey: "ch_a|oc_v",
  includeAdmin: false,
  visitor: resolveVisitorLimits({ visitorTier: "visitor" }, "others"),
}

/** 本轮信封里的 memory 标签内容；没有返回 undefined。宿主提示词的说明文字里也提到 `<memory>`，所以从 turn 标签起找 */
function memoryOf(prompt: string): string | undefined {
  const turn = prompt.slice(prompt.lastIndexOf("<turn "))
  return /<memory>\n([\s\S]*?)\n<\/memory>/.exec(turn)?.[1]
}

describe("提示词里的「会话记忆」组跟着工具挂载走", () => {
  it.each([["主用户会话", MAIN], ["项目会话", PROJECT], ["完整档的其他人", FULL_OTHER]] as [string, PromptAssemblyContext][])(
    "%s：有会话记忆组，且只出现一次",
    (_n, ctx) => {
      expect(count(protocol(ctx), MEMORY_GROUP)).toBe(1)
    },
  )

  it.each([["独立定时任务", TASK], ["访客档的其他人", VISITOR]] as [string, PromptAssemblyContext][])(
    "%s：没挂载，提示词里也没有",
    (_n, ctx) => {
      const t = protocol(ctx)
      expect(t).not.toContain("memory_save")
      expect(t).not.toContain("lk-harness-memory")
    },
  )

  it("没有会话 key（没有调用者身份）：不挂载，也不提", () => {
    expect(protocol({ meta: { chatType: "p2p" }, includeAdmin: true })).not.toContain("memory_save")
  })

  it("提示词判定与挂载判定一致：同一组条件，挂了就提、没挂就不提", () => {
    for (const ctx of [MAIN, PROJECT, FULL_OTHER, TASK, VISITOR]) {
      const endpoint = ctx.meta?.chatType === "task" ? "task" : ctx.visitor ? "visitor" : "interactive"
      const mounted = MEMORY_MCP_KEY in buildBuiltinMcpServers(
        19528,
        ctx.includeAdmin === true,
        endpoint,
        ctx.meta?.chatType === "project" || !!ctx.sessionKey?.includes("::project_"),
        ctx.sessionKey,
      )
      expect(protocol(ctx).includes(MEMORY_GROUP), JSON.stringify(ctx)).toBe(mounted)
    }
  })

  it("会话记忆组把关键规则交代清楚：只保留约 15 轮、记忆随首轮带入、用户最新说法优先", () => {
    const t = protocol(MAIN)
    const part = t.slice(t.indexOf(MEMORY_GROUP))
    expect(part).toContain("最近约 15 轮")
    expect(part).toContain("首轮")
    expect(part).toContain("以用户为准")
  })
})

describe("shouldMountMemoryMcp / buildBuiltinMcpServers", () => {
  it("只有交互端点且有调用者会话才挂；task、访客端点、没有会话（或全空白）不挂", () => {
    expect(shouldMountMemoryMcp({ endpoint: "interactive", sessionKey: "s1" })).toBe(true)
    expect(shouldMountMemoryMcp({ endpoint: "task", sessionKey: "s1" })).toBe(false)
    expect(shouldMountMemoryMcp({ endpoint: "visitor", sessionKey: "s1" })).toBe(false)
    expect(shouldMountMemoryMcp({ endpoint: "interactive" })).toBe(false)
    expect(shouldMountMemoryMcp({ endpoint: "interactive", sessionKey: "   " })).toBe(false)
  })

  it("挂载时带上调用者会话头，且主用户、项目、普通交互会话都有", () => {
    const entry = { url: "http://127.0.0.1:19528/mcp-memory", headers: { "X-Harness-Session-Key": "ch_a%7Coc_main" } }
    expect(buildBuiltinMcpServers(19528, true, "interactive", false, "ch_a|oc_main")[MEMORY_MCP_KEY]).toEqual(entry)
    expect(MEMORY_MCP_KEY in buildBuiltinMcpServers(19528, false, "interactive", true, "ch_a|oc_g::project_p1")).toBe(true)
    expect(MEMORY_MCP_KEY in buildBuiltinMcpServers(19528, false, "interactive", false, "ch_a|oc_x")).toBe(true)
    expect(MEMORY_MCP_KEY in buildBuiltinMcpServers(19528, false, "visitor", false, "ch_a|oc_v")).toBe(false)
    expect(MEMORY_MCP_KEY in buildBuiltinMcpServers(19528, false, "task", false, "task_1")).toBe(false)
  })
})

describe("首轮带入记忆", () => {
  const remember = (sk: string) => {
    saveSessionMemory(h.userData, sk, "部署约束", "线上只能周三发布")
    saveSessionMemory(h.userData, sk, "待办", "等产品确认文案")
  }

  it("首轮：memory 标签里每条记忆一个 item，带创建和修改时间，放在消息之前；用户消息照常在 message 里", () => {
    remember(MAIN.sessionKey!)
    const prompt = assembleTurnPrompt(MSGS, MAIN, { firstTurn: true })
    const items = memoryOf(prompt)!.split("\n")
    expect(items).toHaveLength(2)
    expect(items[0]).toMatch(/^<item key="部署约束" created="[\d-]+ [\d:]+" updated="[\d-]+ [\d:]+">线上只能周三发布<\/item>$/)
    expect(items[1]).toContain('<item key="待办"')
    expect(prompt.indexOf("<memory>")).toBeLessThan(prompt.indexOf("<message "))
    expect(prompt).toContain('<message id="m1">\n用户这一句\n</message>')
  })

  it("不是首轮：不带（AI 手里的上下文里已经有了，每轮重复只是白占字数）", () => {
    remember(MAIN.sessionKey!)
    expect(memoryOf(assembleTurnPrompt(MSGS, MAIN, { firstTurn: false }))).toBeUndefined()
    expect(memoryOf(assembleTurnPrompt(MSGS, MAIN))).toBeUndefined()
  })

  it("首轮但没有记忆：不出现 memory 标签", () => {
    expect(assembleTurnPrompt(MSGS, MAIN, { firstTurn: true })).not.toContain("<memory>")
  })

  it("记忆只给自己的会话：别的会话的记忆不会串进来", () => {
    remember("ch_a|oc_other")
    expect(memoryOf(assembleTurnPrompt(MSGS, MAIN, { firstTurn: true }))).toBeUndefined()
  })

  it.each([["独立定时任务", TASK], ["访客档", VISITOR]] as [string, PromptAssemblyContext][])(
    "%s：没挂记忆工具，磁盘上即使有记忆也不带",
    (_n, ctx) => {
      remember(ctx.sessionKey!)
      expect(memoryOf(assembleTurnPrompt(MSGS, ctx, { firstTurn: true }))).toBeUndefined()
    },
  )

  it("没有会话 key（单测里的空上下文）：不读记忆，不抛错", () => {
    expect(memoryOf(assembleTurnPrompt(MSGS, {}, { firstTurn: true }))).toBeUndefined()
  })

  it("和切供应商搬来的历史一起首轮带入：memory 在前，接着是 history，最后是本轮消息", () => {
    remember(MAIN.sessionKey!)
    const prompt = assembleTurnPrompt(MSGS, MAIN, {
      firstTurn: true,
      historyTurns: [{ role: "user", text: "旧问题" }, { role: "assistant", text: "旧回答" }],
    })
    const at = (s: string) => prompt.indexOf(s)
    expect(at("<memory>")).toBeLessThan(at("<history>"))
    expect(at("<history>")).toBeLessThan(at("旧问题"))
    expect(at("旧回答")).toBeLessThan(at("</history>"))
    expect(at("</history>")).toBeLessThan(at("用户这一句"))
  })

  it("SDK 引擎的整轮提示词：协议段在前，memory 随首轮的 turn 标签在后，且只出现一次", () => {
    remember(MAIN.sessionKey!)
    const p = assembleSdkWorkerTurnPrompt(MSGS, MAIN, { firstTurn: true })
    expect(p.indexOf(MEMORY_GROUP)).toBeLessThan(p.lastIndexOf("<turn "))
    expect(count(p, "线上只能周三发布")).toBe(1)
    expect(assembleSdkWorkerTurnPrompt(MSGS, MAIN, { firstTurn: false })).not.toContain("线上只能周三发布")
  })
})