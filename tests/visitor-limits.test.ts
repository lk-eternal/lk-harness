import { describe, expect, it, beforeAll, afterAll } from "vitest"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import {
  PI_LOCAL_TOOLS,
  VISITOR_SDK_BASE_TOOLS,
  VISITOR_SDK_SKILL_TOOLS,
  buildVisitorPromptSection,
  filterUserMcp,
  resolveVisitorLimits,
  sameVisitorLimits,
  visitorLimitsKey,
} from "../src/shared/visitor-limits"
import {
  ADMIN_MCP_KEY,
  CLAW_MCP_KEY,
  SCHEDULE_MCP_KEY,
  buildSdkMcpServers,
  initHarnessMcpStore,
  saveHarnessMcpServer,
} from "../src/shared/harness-mcp-store"

const ROOT = path.resolve(__dirname, "..")

describe("resolveVisitorLimits：谁受限", () => {
  it("主人自己的会话不受限，不管通道档位写什么", () => {
    expect(resolveVisitorLimits({ visitorTier: "visitor" }, "main")).toBeUndefined()
    expect(resolveVisitorLimits(undefined, "main")).toBeUndefined()
  })

  it("其他人 + 同我：不受限", () => {
    expect(resolveVisitorLimits({ visitorTier: "full" }, "others")).toBeUndefined()
  })

  it("其他人 + 访客：默认只有联网 / 任务清单 / MCP 族，没有任何本机工具", () => {
    const l = resolveVisitorLimits({ visitorTier: "visitor" }, "others")!
    expect(l.sdkTools).toEqual([...VISITOR_SDK_BASE_TOOLS])
    for (const local of ["shell", "read", "edit", "delete", "grep", "glob", "ls", "task", "generateImage"]) {
      expect(l.sdkTools, local).not.toContain(local)
    }
    expect(l.mcpAllow).toEqual([])
    expect(l.skillAllow).toEqual([])
    expect(l.canRead).toBe(false)
    expect(l.piExcludeTools).toEqual([...PI_LOCAL_TOOLS])
  })

  it("档位字段缺失按访客算（残缺对象不能意外变成全部权限）", () => {
    expect(resolveVisitorLimits({}, "others")).toBeDefined()
    expect(resolveVisitorLimits(undefined, "others")).toBeDefined()
  })

  it("额外开放 MCP：只进 mcpAllow，不动工具白名单", () => {
    const l = resolveVisitorLimits({ visitorTier: "visitor", visitorMcp: [" a ", "b", "a", ""] }, "others")!
    expect(l.mcpAllow).toEqual(["a", "b"])
    expect(l.sdkTools).toEqual([...VISITOR_SDK_BASE_TOOLS])
  })

  it("额外开放任何 Skill：同时开放 read（读 SKILL.md），pi 也不再关 read", () => {
    const l = resolveVisitorLimits({ visitorTier: "visitor", visitorSkills: ["s1"] }, "others")!
    expect(l.skillAllow).toEqual(["s1"])
    expect(l.canRead).toBe(true)
    expect(l.sdkTools).toEqual([...VISITOR_SDK_BASE_TOOLS, ...VISITOR_SDK_SKILL_TOOLS])
    expect(l.piExcludeTools).not.toContain("read")
    expect(l.piExcludeTools).toContain("bash")
    expect(l.piExcludeTools).toContain("write")
  })
})

describe("工具名必须是真实存在的（名字错了 SDK 在 Agent.create 时直接抛错，整个访客会话起不来）", () => {
  /** SDK 的工具词表来自 protobuf 里 ToolCall 的 oneof 字段：公共名 = 驼峰字段名去掉 ToolCall 后缀 */
  function sdkToolVocabulary(): Set<string> {
    const bundle = fs.readFileSync(path.join(ROOT, "node_modules/@cursor/sdk/dist/cjs/index.js"), "utf8")
    const start = bundle.indexOf('["ToolCall|1 shell_tool_call')
    expect(start, "找不到 SDK 的 ToolCall 字段表：SDK 升级后内部结构变了，重新核对访客工具名").toBeGreaterThan(-1)
    const chunk = bundle.slice(start, bundle.indexOf("]", start))
    const fields = [...chunk.matchAll(/(?:ToolCall\|1|tool\|\d+) ([a-z_0-9]+_tool_call)/g)].map((m) => m[1]!)
    const camel = (n: string) => n.replace(/_([a-z0-9])/g, (_, c: string) => c.toUpperCase())
    const names = new Set(fields.map((f) => camel(f).replace(/ToolCall$/, "")))
    // SDK 里 shell 和 mcp 是工具族的公共名
    names.add("shell")
    names.add("mcp")
    expect(names.size, "解析出的工具名太少，解析逻辑可能已失效").toBeGreaterThan(30)
    return names
  }

  it("访客的 SDK 白名单里每个名字都在 SDK 词表里", () => {
    const vocab = sdkToolVocabulary()
    for (const name of [...VISITOR_SDK_BASE_TOOLS, ...VISITOR_SDK_SKILL_TOOLS]) {
      expect(vocab.has(name), `SDK 里没有叫 ${name} 的工具`).toBe(true)
    }
  })

  it("pi 要关的本机工具覆盖了 pi 自带的全部工具（pi 升级加了新工具，这里要同步）", () => {
    const src = fs.readFileSync(path.join(ROOT, "node_modules/@mariozechner/pi-coding-agent/dist/core/tools/index.js"), "utf8")
    const block = src.slice(src.indexOf("export const allToolNames = new Set(["))
    const names = [...block.slice(0, block.indexOf("]")).matchAll(/"([a-z]+)"/g)].map((m) => m[1]!)
    expect(names.length, "没解析出 pi 的自带工具名").toBeGreaterThan(5)
    for (const n of names) expect(PI_LOCAL_TOOLS, `pi 自带的 ${n} 没有在访客档关掉`).toContain(n)
  })
})

describe("visitorLimitsKey / sameVisitorLimits：设置保存时判断要不要重启访客会话", () => {
  it("不受限就是 full", () => {
    expect(visitorLimitsKey(undefined)).toBe("full")
  })

  it("MCP / Skill 顺序不影响指纹，内容变了才变", () => {
    const a = resolveVisitorLimits({ visitorTier: "visitor", visitorMcp: ["a", "b"], visitorSkills: ["x", "y"] }, "others")
    const b = resolveVisitorLimits({ visitorTier: "visitor", visitorMcp: ["b", "a"], visitorSkills: ["y", "x"] }, "others")
    const c = resolveVisitorLimits({ visitorTier: "visitor", visitorMcp: ["a"], visitorSkills: ["x", "y"] }, "others")
    expect(visitorLimitsKey(a)).toBe(visitorLimitsKey(b))
    expect(visitorLimitsKey(a)).not.toBe(visitorLimitsKey(c))
  })

  it("已经开放了一些，再增减一个：也算变了（旧会话手里的 MCP 挂载 / Skill 名单已经过期）", () => {
    const base = { visitorTier: "visitor" as const, visitorMcp: ["a"], visitorSkills: ["x"] }
    expect(sameVisitorLimits(base, { ...base, visitorMcp: ["a", "b"] })).toBe(false)
    expect(sameVisitorLimits(base, { ...base, visitorMcp: ["b"] })).toBe(false)
    expect(sameVisitorLimits(base, { ...base, visitorSkills: ["x", "y"] })).toBe(false)
    expect(sameVisitorLimits(base, { ...base, visitorSkills: ["y"] })).toBe(false)
    expect(sameVisitorLimits(base, { ...base, visitorMcp: ["a"], visitorSkills: ["x"] })).toBe(true)
  })

  it("档位切换、额外开放变化 = 限制变了；不相关字段变化 = 没变", () => {
    expect(sameVisitorLimits({ visitorTier: "visitor" }, { visitorTier: "full" })).toBe(false)
    expect(sameVisitorLimits({ visitorTier: "visitor" }, { visitorTier: "visitor", visitorMcp: ["m"] })).toBe(false)
    expect(sameVisitorLimits({ visitorTier: "visitor" }, { visitorTier: "visitor", visitorSkills: ["s"] })).toBe(false)
    expect(sameVisitorLimits({ visitorTier: "visitor" }, { visitorTier: "visitor", visitorMcp: [], visitorSkills: [] })).toBe(true)
    expect(sameVisitorLimits({ visitorTier: "full", visitorMcp: ["m"] }, { visitorTier: "full" })).toBe(true) // 同我档里点名的清单无意义
  })
})

describe("filterUserMcp", () => {
  const servers = { a: { url: "u1" }, b: { url: "u2" }, c: { url: "u3" } }
  it("limits 缺省：不过滤", () => {
    expect(filterUserMcp(servers, undefined)).toBe(servers)
  })
  it("只留点名的；点名了不存在的不报错", () => {
    expect(Object.keys(filterUserMcp(servers, { mcpAllow: ["b", "zzz"] }))).toEqual(["b"])
    expect(filterUserMcp(servers, { mcpAllow: [] })).toEqual({})
  })
})

describe("访客的提示词", () => {
  it("默认：说清能做和不能做的，并要求不透露本机信息", () => {
    const text = buildVisitorPromptSection(resolveVisitorLimits({ visitorTier: "visitor" }, "others")!)
    expect(text).toContain("访客会话")
    expect(text).toContain("你可以：")
    expect(text).toContain("你不能：")
    expect(text).toContain("读写本机文件")
    expect(text).toContain("发送本机的图片或文件")
    expect(text).toContain("不要透露本机")
  })
  it("开放了 MCP / Skill：把它们写进「能做」，「不能读本机文件」改成「不能读与 Skill 无关的文件」", () => {
    const text = buildVisitorPromptSection(resolveVisitorLimits({ visitorTier: "visitor", visitorMcp: ["notion"], visitorSkills: ["s"] }, "others")!)
    expect(text).toContain("notion")
    expect(text).toContain("Skill 的说明文件")
    expect(text).toContain("读取与 Skill 无关的本机文件")
    expect(text).not.toContain("读写本机文件")
  })
})

describe("buildSdkMcpServers：访客用专用端点，用户 MCP 按点名挂载", () => {
  let dir = ""
  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "visitor-mcp-"))
    initHarnessMcpStore(dir)
    saveHarnessMcpServer("notion", { url: "http://notion.example/mcp" })
    saveHarnessMcpServer("db", { command: "db-mcp" })
  })
  afterAll(() => {
    initHarnessMcpStore("")
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it("不传白名单：用户装的全挂（主人 / 同我档，行为和以前一样）", () => {
    const s = buildSdkMcpServers(1234, false, "interactive", false, "sk")
    expect(Object.keys(s).sort()).toEqual([CLAW_MCP_KEY, "db", "notion"].sort())
    expect((s[CLAW_MCP_KEY] as { url: string }).url).toBe("http://127.0.0.1:1234/mcp-interactive")
  })

  it("访客端点：内置 MCP 指向 /mcp-visitor，且带调用者会话头", () => {
    const s = buildSdkMcpServers(1234, false, "visitor", false, "sk", [])
    expect(s[CLAW_MCP_KEY]).toEqual({ url: "http://127.0.0.1:1234/mcp-visitor", headers: { "X-Harness-Session-Key": "sk" } })
  })

  it("白名单为空：一个用户 MCP 都不挂；管理 / 自排程 MCP 也不会出现", () => {
    const s = buildSdkMcpServers(1234, false, "visitor", false, "sk", [])
    expect(Object.keys(s)).toEqual([CLAW_MCP_KEY])
    expect(s[ADMIN_MCP_KEY]).toBeUndefined()
    expect(s[SCHEDULE_MCP_KEY]).toBeUndefined()
  })

  it("点名什么挂什么，不存在的名字忽略", () => {
    const s = buildSdkMcpServers(1234, false, "visitor", false, "sk", ["notion", "nope"])
    expect(Object.keys(s).sort()).toEqual([CLAW_MCP_KEY, "notion"].sort())
  })
})
