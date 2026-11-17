import { afterEach, describe, expect, it, vi } from "vitest"
import * as fs from "node:fs"
import * as path from "node:path"
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import {
  HOST_RPC_ACK_TIMEOUT_MS,
  HOST_RPC_PREFIX,
  createHostRpc,
  parseHostRpcLine,
  type HostRpc,
  type HostRpcOutcome,
  type HostRpcReply,
} from "../src/shared/host-rpc"
import { createHostRpcDispatcher } from "../electron/host-rpc"
import { registerAdminTools } from "../src/server-admin"
import { runWithMcpInvokerSessionKey } from "../src/shared/mcp-invoker-context"

/**
 * daemon → 宿主的「发请求、等结果」通道，以及用它的 manage_project（templates / repos / create）。
 * 守住几件事：宿主不在时几秒内就报错（不白等）、超时后提醒 AI 先查再重试、
 * 回执顺序是 ack 在前结果在后、建项请求带上调用者所在的聊天和翻成驼峰的参数。
 */

describe("请求跟踪器（daemon 侧）", () => {
  afterEach(() => { vi.useRealTimers() })

  function make() {
    const sent: string[] = []
    const rpc = createHostRpc({ send: (l) => sent.push(l), newId: (() => { let n = 0; return () => `id${++n}` })() })
    return { rpc, sent }
  }
  const reqOf = (line: string) => JSON.parse(line.slice(HOST_RPC_PREFIX.length)) as { id: string; kind: string; payload: unknown }

  it("写出一行 __HOST_RPC__: 加 JSON（id、类型、参数）", () => {
    const { rpc, sent } = make()
    void rpc.request("project.create", { a: 1 }, 1000)
    expect(sent).toHaveLength(1)
    expect(sent[0].startsWith(HOST_RPC_PREFIX)).toBe(true)
    expect(sent[0]).not.toContain("\n")
    expect(reqOf(sent[0])).toEqual({ id: "id1", kind: "project.create", payload: { a: 1 } })
  })

  it("先回 ack 再回结果：请求拿到结果", async () => {
    const { rpc } = make()
    const p = rpc.request("k", {}, 1000)
    expect(rpc.settle({ id: "id1", phase: "ack" })).toBe(true)
    expect(rpc.pendingCount()).toBe(1)
    expect(rpc.settle({ id: "id1", phase: "done", ok: true, result: { projectId: "p1" } })).toBe(true)
    expect(await p).toEqual({ ok: true, result: { projectId: "p1" } })
    expect(rpc.pendingCount()).toBe(0)
  })

  it("宿主报错：带回它的原因；没写原因就给个兜底", async () => {
    const { rpc } = make()
    const a = rpc.request("k", {}, 1000)
    rpc.settle({ id: "id1", phase: "done", ok: false, error: "磁盘满了" })
    expect(await a).toEqual({ ok: false, error: "磁盘满了" })
    const b = rpc.request("k", {}, 1000)
    rpc.settle({ id: "id2", phase: "done", ok: false })
    expect(await b).toEqual({ ok: false, error: "操作失败" })
  })

  it("宿主漏了 ack、直接回结果：照样收下", async () => {
    const { rpc } = make()
    const p = rpc.request("k", {}, 1000)
    rpc.settle({ id: "id1", phase: "done", ok: true, result: 1 })
    expect(await p).toEqual({ ok: true, result: 1 })
  })

  it("宿主没在运行：ack 超时就报错，不等整体超时；迟到的回执被忽略", async () => {
    vi.useFakeTimers()
    const { rpc } = make()
    const p = rpc.request("k", {}, 10 * 60_000)
    await vi.advanceTimersByTimeAsync(HOST_RPC_ACK_TIMEOUT_MS + 1)
    const r = await p
    expect(r.ok).toBe(false)
    expect(!r.ok && r.error).toContain("没有响应")
    expect(!r.ok && r.error).toContain("没有执行")
    expect(rpc.pendingCount()).toBe(0)
    expect(rpc.settle({ id: "id1", phase: "done", ok: true })).toBe(false)
  })

  it("收到 ack 就不再按 ack 超时算；久久没结果：提醒先确认有没有成功，别直接重试", async () => {
    vi.useFakeTimers()
    const { rpc } = make()
    const p = rpc.request("k", {}, 60_000)
    rpc.settle({ id: "id1", phase: "ack" })
    await vi.advanceTimersByTimeAsync(HOST_RPC_ACK_TIMEOUT_MS + 1000)
    expect(rpc.pendingCount()).toBe(1)
    await vi.advanceTimersByTimeAsync(60_000)
    const r = await p
    expect(r.ok).toBe(false)
    expect(!r.ok && r.error).toContain("60 秒")
    expect(!r.ok && r.error).toContain("不要直接重试")
    expect(!r.ok && r.error).toContain("list")
  })

  it("写标准输出本身出错：直接报错，不挂着", async () => {
    const rpc = createHostRpc({ send: () => { throw new Error("EPIPE") } })
    const r = await rpc.request("k", {}, 1000)
    expect(r).toMatchObject({ ok: false })
    expect(!r.ok && r.error).toContain("EPIPE")
    expect(rpc.pendingCount()).toBe(0)
  })

  it("几个请求互不相干；不认识的 id、乱七八糟的回执一律返回 false", async () => {
    const { rpc } = make()
    const a = rpc.request("k", {}, 1000)
    const b = rpc.request("k", {}, 1000)
    rpc.settle({ id: "id2", phase: "done", ok: true, result: "B" })
    expect(await b).toEqual({ ok: true, result: "B" })
    expect(rpc.pendingCount()).toBe(1)
    for (const junk of [null, undefined, 1, "x", {}, { id: "nope", phase: "done", ok: true }, { id: "id1" }, { id: "id1", phase: "weird" }]) {
      expect(rpc.settle(junk)).toBe(false)
    }
    expect(rpc.pendingCount()).toBe(1)
    rpc.settle({ id: "id1", phase: "done", ok: true, result: "A" })
    expect(await a).toEqual({ ok: true, result: "A" })
  })

  it("parseHostRpcLine：只认前缀 + 合法 JSON + 有 id 和 kind", () => {
    expect(parseHostRpcLine(`${HOST_RPC_PREFIX}{"id":"a","kind":"k","payload":{"x":1}}`)).toEqual({ id: "a", kind: "k", payload: { x: 1 } })
    expect(parseHostRpcLine(`__PROJECT_DELETE__:{"id":"a","kind":"k"}`)).toBeNull()
    expect(parseHostRpcLine(`${HOST_RPC_PREFIX}{坏的`)).toBeNull()
    expect(parseHostRpcLine(`${HOST_RPC_PREFIX}{"kind":"k"}`)).toBeNull()
    expect(parseHostRpcLine(`${HOST_RPC_PREFIX}{"id":"a"}`)).toBeNull()
    expect(parseHostRpcLine(`${HOST_RPC_PREFIX}{"id":"","kind":"k"}`)).toBeNull()
  })
})

describe("宿主分发器", () => {
  const URL = "http://127.0.0.1:4321/api/host-rpc"
  const line = (kind: string, payload: unknown = {}, id = "r1") => `${HOST_RPC_PREFIX}${JSON.stringify({ id, kind, payload })}`

  function make(handlers: Record<string, (p: unknown) => unknown>, post?: (url: string, body: HostRpcReply) => Promise<unknown>) {
    const posts: { url: string; body: HostRpcReply }[] = []
    const warns: string[] = []
    const handle = createHostRpcDispatcher({
      post: async (url, body) => { posts.push({ url, body }); return post ? post(url, body) : { ok: true } },
      handlers,
      warn: (m) => warns.push(m),
    })
    return { handle, posts, warns }
  }

  it("不是宿主请求的行：返回 false，什么都不发", async () => {
    const { handle, posts } = make({})
    expect(await handle("__PROJECT_DELETE__:{}", 4321)).toBe(false)
    expect(await handle("普通日志", 4321)).toBe(false)
    expect(posts).toEqual([])
  })

  it("先 ack、再把处理函数的结果作为 done 发回 daemon 的 /api/host-rpc", async () => {
    const seen: unknown[] = []
    const { handle, posts } = make({ "project.templates": (p) => { seen.push(p); return [{ id: "general" }] } })
    expect(await handle(line("project.templates", { q: 1 }), 4321)).toBe(true)
    expect(seen).toEqual([{ q: 1 }])
    expect(posts).toEqual([
      { url: URL, body: { id: "r1", phase: "ack" } },
      { url: URL, body: { id: "r1", phase: "done", ok: true, result: [{ id: "general" }] } },
    ])
  })

  it("异步处理函数会等它做完再回结果；ack 不用等它", async () => {
    let release!: () => void
    const gate = new Promise<void>((r) => { release = r })
    const { handle, posts } = make({ slow: async () => { await gate; return "ok" } })
    const done = handle(line("slow"), 4321)
    await new Promise((r) => setTimeout(r, 10))
    expect(posts.map((p) => p.body.phase)).toEqual(["ack"])
    release()
    await done
    expect(posts.map((p) => p.body.phase)).toEqual(["ack", "done"])
  })

  it("处理函数抛错：done 报错带原因", async () => {
    const { handle, posts } = make({ boom: () => { throw new Error("克隆失败") } })
    await handle(line("boom"), 4321)
    expect(posts[1].body).toEqual({ id: "r1", phase: "done", ok: false, error: "克隆失败" })
  })

  it("不认识的请求类型（含 toString 这类原型上的名字）：ack 之后回错误，不会去执行", async () => {
    const { handle, posts } = make({})
    for (const kind of ["nope", "toString", "__proto__", "constructor"]) {
      posts.length = 0
      await handle(line(kind), 4321)
      expect(posts.map((p) => p.body.phase)).toEqual(["ack", "done"])
      const done = posts[1].body
      expect(done).toMatchObject({ id: "r1", phase: "done", ok: false })
      expect(done).not.toHaveProperty("result")
      expect(JSON.stringify(done)).toContain("不认识")
    }
  })

  it("格式不对的行、daemon 端口未知：已消费（返回 true），不发回执，只记警告", async () => {
    const { handle, posts, warns } = make({ k: () => 1 })
    expect(await handle(`${HOST_RPC_PREFIX}{坏的`, 4321)).toBe(true)
    expect(await handle(line("k"), undefined)).toBe(true)
    expect(await handle(line("k"), null)).toBe(true)
    expect(posts).toEqual([])
    expect(warns).toHaveLength(3)
  })

  it("回执送不到 daemon：不抛错、记警告；ack 失败不耽误处理函数照常执行", async () => {
    let ran = false
    const { handle, posts, warns } = make({ k: () => { ran = true; return 1 } }, async () => { throw new Error("ECONNREFUSED") })
    await expect(handle(line("k"), 4321)).resolves.toBe(true)
    expect(ran).toBe(true)
    expect(posts).toHaveLength(2)
    expect(warns.filter((w) => w.includes("ECONNREFUSED"))).toHaveLength(2)
  })

  it("和跟踪器连起来：daemon 发请求 → 宿主处理 → 结果回到 request 的返回值", async () => {
    let rpc!: HostRpc
    const handle = createHostRpcDispatcher({
      post: async (_url, body) => { rpc.settle(body); return { ok: true } },
      handlers: { echo: (p) => ({ got: p }) },
    })
    rpc = createHostRpc({ send: (l) => { void handle(l.trimEnd(), 4321) } })
    expect(await rpc.request("echo", { n: 7 }, 1000)).toEqual({ ok: true, result: { got: { n: 7 } } })
    const unknown = await rpc.request("missing", {}, 1000)
    expect(unknown.ok).toBe(false)
    expect(rpc.pendingCount()).toBe(0)
  })
})

describe("manage_project 的 templates / repos / create", () => {
  const FEISHU_SK = `ch_fs|ou_main::${path.resolve("/work")}`
  const APP_SK = `ch_app|app_main::${path.resolve("/work")}`

  function setup(reply: (kind: string, payload: unknown) => HostRpcOutcome) {
    const calls: { kind: string; payload: any; timeoutMs: number }[] = []
    const hostRpc: HostRpc = {
      request: async (kind, payload, timeoutMs) => { calls.push({ kind, payload: payload as any, timeoutMs }); return reply(kind, payload) as never },
      settle: () => false,
      pendingCount: () => 0,
    }
    const s = new McpServer({ name: "t", version: "0" })
    registerAdminTools(s, { hostRpc })
    const tool = (s as any)._registeredTools.manage_project as {
      description: string
      inputSchema: { safeParse: (v: unknown) => { success: boolean; data?: any } }
      handler: (args: any, extra: unknown) => Promise<{ content: { text: string }[] }>
    }
    /** 像真实调用那样：先过参数校验，再在带调用者会话键的上下文里执行 */
    const call = async (args: Record<string, unknown>, sessionKey?: string): Promise<string> => {
      const parsed = tool.inputSchema.safeParse(args)
      if (!parsed.success) throw new Error("参数没过校验")
      const res = await runWithMcpInvokerSessionKey(sessionKey, () => tool.handler(parsed.data, {}))
      return res.content[0].text
    }
    return { calls, tool, call }
  }

  const CREATED = { ok: true as const, projectId: "abc123def456", name: "Q4 调研", dir: "D:\\projects\\q4", templateName: "调研" }

  it("工具说明讲清三件事：先查模板、建前要用户确认、建完不进入会话", () => {
    const { tool } = setup(() => ({ ok: true, result: [] }))
    for (const word of ["templates", "repos", "create", "send_question", "不会进入项目会话", "独立群", "delete"]) expect(tool.description).toContain(word)
  })

  it("参数校验：认新的 action 和 snake_case 参数，拒掉不认识的", () => {
    const { tool } = setup(() => ({ ok: true, result: [] }))
    const ok = tool.inputSchema.safeParse({
      action: "create", name: "n", template_id: "develop", fields: { 交付形式: "PPT" },
      repos: [{ repo_path: "/r/a", base_branch: "main" }], work_branch: "test", feature_branch: "f", story_url: "u", related_docs: "d", folder: "/x",
    })
    expect(ok.success).toBe(true)
    for (const action of ["list", "delete", "templates", "repos", "create"]) expect(tool.inputSchema.safeParse({ action }).success).toBe(true)
    expect(tool.inputSchema.safeParse({ action: "update" }).success).toBe(false)
    expect(tool.inputSchema.safeParse({ action: "create", work_branch: "main" }).success).toBe(false)
    expect(tool.inputSchema.safeParse({ action: "create", repos: [{ repo_path: "/r/a" }] }).success).toBe(false)
  })

  it("create：带上调用者所在的聊天（去掉会话里的工作目录后缀）和翻成驼峰的参数，给足建项时间", async () => {
    const { call, calls } = setup(() => ({ ok: true, result: CREATED }))
    const text = await call({
      action: "create", name: "Q4 调研", goal: "看清竞品", template_id: "research", fields: { 交付形式: "PPT" },
      repos: [{ repo_path: "/r/shop", base_branch: "main" }], work_branch: "test", feature_branch: "feature/x",
      story_url: "https://t.example.com/1", related_docs: "见 wiki", folder: "/f",
    }, FEISHU_SK)
    expect(calls).toHaveLength(1)
    expect(calls[0].kind).toBe("project.create")
    expect(calls[0].timeoutMs).toBeGreaterThanOrEqual(5 * 60_000)
    expect(calls[0].payload).toEqual({
      chatKey: "ch_fs|ou_main",
      input: {
        name: "Q4 调研", goal: "看清竞品", templateId: "research", fields: { 交付形式: "PPT" },
        repos: [{ repoPath: "/r/shop", baseBranch: "main" }], workBranch: "test", featureBranch: "feature/x",
        storyUrl: "https://t.example.com/1", relatedDocs: "见 wiki", folder: "/f",
      },
    })
    expect(text).toContain("✅ 已创建项目「Q4 调研」")
    expect(text).toContain("abc123def456")
    expect(text).toContain("没有进入项目会话")
    expect(text).toContain("/p use")
  })

  it("应用内对话的会话键也能解出聊天", async () => {
    const { call, calls } = setup(() => ({ ok: true, result: CREATED }))
    await call({ action: "create", name: "n", template_id: "general" }, APP_SK)
    expect(calls[0].payload.chatKey).toBe("ch_app|app_main")
  })

  it("没有调用者会话 / 没给模板：直接报错，不去打扰宿主", async () => {
    const { call, calls } = setup(() => ({ ok: true, result: CREATED }))
    expect(await call({ action: "create", name: "n", template_id: "general" })).toContain("无法确定你所在的会话")
    expect(await call({ action: "create", name: "n" }, FEISHU_SK)).toContain("template_id")
    expect(await call({ action: "create", name: "n", template_id: "  " }, FEISHU_SK)).toContain("template_id")
    expect(calls).toEqual([])
  })

  it("宿主没响应 / 超时 / 建项校验没过：原因原样带给 AI，不当成功", async () => {
    const down = setup(() => ({ ok: false, error: "应用主进程没有响应" }))
    expect(await down.call({ action: "create", name: "n", template_id: "general" }, FEISHU_SK)).toBe("❌ 应用主进程没有响应")
    const invalid = setup(() => ({ ok: true, result: { ok: false, error: "请填写：交付形式" } }))
    expect(await invalid.call({ action: "create", name: "n", template_id: "research" }, FEISHU_SK)).toBe("❌ 请填写：交付形式")
    const empty = setup(() => ({ ok: true, result: undefined }))
    expect(await empty.call({ action: "create", name: "n", template_id: "general" }, FEISHU_SK)).toContain("❌")
  })

  it("templates / repos：走宿主，返回可读的清单；没有就说没有", async () => {
    const t = setup(() => ({
      ok: true,
      result: [{
        id: "research", name: "调研", description: "做竞品调研", needsRepo: false, workBranchMode: "new",
        fields: [{ label: "交付形式", required: true, placeholder: "PPT" }, { label: "截止时间" }],
        steps: [],
      }, {
        id: "test", name: "测试", description: "", needsRepo: true, workBranchMode: "test", fields: [], steps: [],
      }],
    }))
    const text = await t.call({ action: "templates" }, FEISHU_SK)
    expect(text).toContain("共 2 个项目模板")
    expect(text).toContain("可以接（可选，最多 6 个），默认工作分支：测试分支")
    expect(text).toContain("要填的信息：无")
    expect(t.calls[0]).toMatchObject({ kind: "project.templates", payload: {} })
    expect(text).toContain("id=research")
    expect(text).toContain("交付形式（必填，例：PPT）")
    expect(text).toContain("截止时间（可选）")
    expect(text).toContain("代码仓库：不接")

    const r = setup(() => ({
      ok: true,
      result: [
        { path: "/r/shop", name: "shop", baseBranch: "main", clone: true },
        { path: "/r/docs", name: "docs", baseBranch: "", clone: false },
      ],
    }))
    const rt = await r.call({ action: "repos" }, FEISHU_SK)
    expect(r.calls[0].kind).toBe("project.repos")
    expect(rt).toContain("/r/shop")
    expect(rt).toContain("基线分支 main｜建项时克隆一份副本")
    expect(rt).toContain("基线分支 （未配置，需要问用户）｜不克隆，只记录仓库信息")

    expect(await setup(() => ({ ok: true, result: [] })).call({ action: "templates" }, FEISHU_SK)).toContain("没有可用的项目模板")
    expect(await setup(() => ({ ok: true, result: [] })).call({ action: "repos" }, FEISHU_SK)).toContain("还没有常用代码仓库")
    expect(await setup(() => ({ ok: false, error: "没响应" })).call({ action: "templates" }, FEISHU_SK)).toBe("❌ 没响应")
  })
})

describe("接线（只有真实应用跑得到的部分，读源码守住）", () => {
  const read = (...p: string[]) => fs.readFileSync(path.resolve(__dirname, "..", ...p), "utf8").replace(/\r\n/g, "\n")

  it("宿主：daemon 输出里的 __HOST_RPC__ 行交给分发器，处理函数就是项目那三个", () => {
    const src = read("electron", "daemon-manager.ts")
    expect(src).toMatch(/createHostRpcDispatcher\(\{[^}]*handlers: projectHostRpcHandlers/s)
    expect(src).toMatch(/line\.startsWith\(HOST_RPC_PREFIX\)\) \{\n\s*void handleHostRpcLine\(line, cachedPort \?\? readLockFile\(\)\?\.port\)\n\s*continue/)
    const proj = read("electron", "project-create.ts")
    for (const kind of ["project.templates", "project.repos", "project.create"]) expect(proj).toContain(`"${kind}"`)
  })

  it("daemon：/api/host-rpc 把回执交给同一个跟踪器；管理 MCP 默认用它", () => {
    const src = read("src", "daemon.ts")
    expect(src).toContain('"/api/host-rpc": handleHostRpcReply')
    expect(src).toMatch(/getHostRpc\(\)\.settle\(body\)/)
    const admin = read("src", "server-admin.ts")
    expect(admin).toContain("deps.hostRpc ?? getHostRpc()")
  })

  it("AI 建项不进入项目会话、不碰「当前项目」指针：建项核心里没有进入会话的调用，进入只在应用内「新建」里", () => {
    const src = read("electron", "project-create.ts")
    const core = src.slice(src.indexOf("async function createProjectCore"), src.indexOf("export async function createProjectFromApp"))
    expect(core).not.toContain("enterProjectSession")
    const ai = src.slice(src.indexOf("export async function createProjectForAi"), src.indexOf("function strOf"))
    expect(ai).not.toContain("enterProjectSession")
    expect(ai).toContain("createProjectCore(where.chatKey, input)")
    const app = src.slice(src.indexOf("export async function createProjectFromApp"), src.indexOf("export async function createProjectForAi"))
    expect(app).toContain("enterProjectSession")
  })
})
