/**
 * 访客限制在 pi 引擎这一侧：真实的 createHarnessPiSession + 真实的 pi 会话（不联网，不发请求），
 * 只桩掉 Electron、配置、daemon、MCP 扩展加载。
 * 验证：访客会话里 pi 的本机工具（读写文件 / 命令 / 搜索）一个都不在启用清单里，宿主 MCP 扩展注册的工具不受影响；
 * 不受限的会话和以前一样；访客的 MCP 配置走 /mcp-visitor 且不带用户 MCP；提示词里有访客说明。
 */
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"

const h = vi.hoisted(() => ({
  dir: "",
  mcpConfigs: [] as Array<{ mcpServers: Record<string, { url?: string }> }>,
}))

vi.mock("electron", async () => {
  const f = await import("node:fs")
  const o = await import("node:os")
  const p = await import("node:path")
  h.dir = f.mkdtempSync(p.join(o.tmpdir(), "pi-visitor-"))
  process.env.APP_DATA_DIR = h.dir
  process.env.PI_CODING_AGENT_DIR = p.join(h.dir, "agent")
  return { app: { isPackaged: false, getAppPath: () => p.resolve(process.cwd()), getPath: () => h.dir } }
})
vi.mock("../electron/config-store", () => ({
  getConfig: () => ({ digitalIdentity: "", daemonPort: 19528, channels: [] }),
  getChannel: () => undefined,
}))
vi.mock("../electron/daemon-client", () => ({ readLockFile: () => ({ port: 4321 }) }))
vi.mock("../electron/cron-scheduler", () => ({ readTasksFromFile: () => [] }))
vi.mock("../electron/ui-logger", () => ({ broadcastLog: () => {}, pushUiLog: () => {} }))
vi.mock("../electron/llm-proxy", () => ({ llmProxyConfigured: () => false, withLlmProxyOptions: (o: unknown) => o }))
vi.mock("../electron/skill-catalog", () => ({
  getSkillCatalog: (_now: number, allow?: string[]) => ({
    text: allow ? `NAMELIST:${allow.join(",") || "(none)"}` : "NAMELIST:all",
    hash: "",
    count: 0,
  }),
}))
// MCP 扩展：记下传进来的配置；返回一个会注册一个「宿主 MCP 工具」的扩展，用来证明 excludeTools 不误伤它
vi.mock("../electron/pi-mcp-loader.js", async () => {
  const { Type } = await import("typebox")
  return {
    loadMcpExtension: async (cfg: { mcpServers: Record<string, { url?: string }> }) => {
      h.mcpConfigs.push(cfg)
      return (pi: { registerTool: (t: unknown) => void }) => {
        pi.registerTool({
          name: "send_question",
          label: "send_question",
          description: "fake host mcp tool",
          parameters: Type.Object({}),
          execute: async () => ({ content: [{ type: "text", text: "ok" }], details: {} }),
        })
      }
    },
  }
})

import { buildAppendSystemPrompt, createHarnessPiSession } from "../electron/pi-embedded"
import { computePromptHash } from "../electron/prompt-assembler"
import { initHarnessMcpStore, saveHarnessMcpServer, CLAW_MCP_KEY } from "../src/shared/harness-mcp-store"
import { PI_LOCAL_TOOLS, resolveVisitorLimits } from "../src/shared/visitor-limits"

const MODEL = {
  id: "m", name: "m", api: "openai-completions", provider: "res1", baseUrl: "http://127.0.0.1:9/v1",
  reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 8000, maxTokens: 1000,
} as never

let seq = 0
function launchOpts(extra: Record<string, unknown> = {}) {
  seq += 1
  return {
    sessionKey: `ch_pi${seq}|oc_chat${seq}::${h.dir}`,
    chatType: "p2p",
    meta: { chatType: "p2p" },
    workspaceDir: h.dir,
    resource: { id: "res1", name: "res1", type: "llm-custom" },
    includeAdmin: false,
    ...extra,
  } as never
}

beforeAll(() => {
  fs.mkdirSync(path.join(h.dir, "agent"), { recursive: true })
})
afterAll(() => {
  fs.rmSync(h.dir, { recursive: true, force: true })
})
beforeEach(() => {
  h.mcpConfigs.length = 0
  initHarnessMcpStore(h.dir)
  saveHarnessMcpServer("notion", { url: "http://notion.example/mcp" })
})

describe("pi 访客会话", () => {
  it("对照组：不受限的会话有 pi 的本机工具（说明这个实验看得见它们）", async () => {
    const { session } = await createHarnessPiSession(launchOpts(), MODEL, "k")
    const active = session.getActiveToolNames()
    expect(active).toEqual(expect.arrayContaining(["read", "bash", "edit", "write"]))
    expect(active).toContain("send_question")
    expect(h.mcpConfigs[0]!.mcpServers[CLAW_MCP_KEY]!.url).toBe("http://127.0.0.1:4321/mcp-interactive")
    expect(Object.keys(h.mcpConfigs[0]!.mcpServers)).toContain("notion")
  })

  it("访客：pi 的本机工具一个都不启用，宿主 MCP 工具仍在", async () => {
    const visitor = resolveVisitorLimits({ visitorTier: "visitor" }, "others")!
    const { session } = await createHarnessPiSession(launchOpts({ visitor }), MODEL, "k")
    const active = session.getActiveToolNames()
    for (const t of PI_LOCAL_TOOLS) expect(active).not.toContain(t)
    expect(active).toContain("send_question")
  })

  it("访客：想用也用不了——全部工具里本机工具也被排除，不只是默认不启用", async () => {
    const visitor = resolveVisitorLimits({ visitorTier: "visitor" }, "others")!
    const { session } = await createHarnessPiSession(launchOpts({ visitor }), MODEL, "k")
    const all = session.getAllTools().map((t: { name: string }) => t.name)
    for (const t of PI_LOCAL_TOOLS) expect(all).not.toContain(t)
  })

  it("访客的 MCP 配置：内置端点是 /mcp-visitor，不带用户 MCP", async () => {
    const visitor = resolveVisitorLimits({ visitorTier: "visitor" }, "others")!
    await createHarnessPiSession(launchOpts({ visitor }), MODEL, "k")
    const servers = h.mcpConfigs[0]!.mcpServers
    expect(servers[CLAW_MCP_KEY]!.url).toBe("http://127.0.0.1:4321/mcp-visitor")
    expect(Object.keys(servers)).toEqual([CLAW_MCP_KEY])
  })

  it("额外开放的用户 MCP 才挂", async () => {
    const visitor = resolveVisitorLimits({ visitorTier: "visitor", visitorMcp: ["notion"] }, "others")!
    await createHarnessPiSession(launchOpts({ visitor }), MODEL, "k")
    expect(Object.keys(h.mcpConfigs[0]!.mcpServers).sort()).toEqual([CLAW_MCP_KEY, "notion"].sort())
  })
})

describe("提示词指纹（两个引擎共用）：访客限制变了指纹就变", () => {
  it("不受限 / 访客 / 访客+开放 MCP 三者指纹互不相同；相同限制指纹相同", () => {
    const ctx = { meta: { chatType: "p2p" }, sessionKey: "ch_a|oc_x", includeAdmin: false } as never
    const lim = (c: Record<string, unknown>) => resolveVisitorLimits({ visitorTier: "visitor", ...c }, "others")
    const none = computePromptHash(ctx)
    const v1 = computePromptHash({ ...(ctx as object), visitor: lim({}) } as never)
    const v2 = computePromptHash({ ...(ctx as object), visitor: lim({ visitorMcp: ["notion"] }) } as never)
    const v2again = computePromptHash({ ...(ctx as object), visitor: lim({ visitorMcp: ["notion"] }) } as never)
    expect(new Set([none, v1, v2]).size).toBe(3)
    expect(v2).toBe(v2again)
  })
})

describe("pi 访客提示词", () => {
  it("访客：有访客说明，Skill 名单按开放的取；不受限：没有访客说明，名单全量", () => {
    const visitor = resolveVisitorLimits({ visitorTier: "visitor", visitorSkills: ["s1"] }, "others")!
    const v = buildAppendSystemPrompt(launchOpts({ visitor }))[0]!
    const plain = buildAppendSystemPrompt(launchOpts())[0]!
    expect(v).toContain("访客")
    expect(v).toContain("NAMELIST:s1")
    expect(plain).not.toContain("访客")
    expect(plain).toContain("NAMELIST:all")
  })
})
