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
import { formatBound, formatChannels, formatCreated, formatUnbound, parseAiBindings } from "../src/shared/project-ai-format"

/**
 * daemon → 宿主的「发请求、等结果」通道，以及用它的 manage_project（templates / repos / channels / create）。
 * 守住几件事：宿主不在时几秒内就报错（不白等）、超时后提醒 AI 先查再重试、
 * 回执顺序是 ack 在前结果在后、建项请求带上调用者所在的聊天、接入的通道（bindings）和翻成驼峰的参数。
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

  const INLINE_FS = [{ channel_id: "ch_fs", mode: "inline" }]
  const CREATED = {
    ok: true as const, projectId: "abc123def456", name: "Q4 调研", dir: "D:\\projects\\q4", templateName: "调研",
    bindings: [{ channelId: "ch_fs", channelName: "飞书", ok: true, mode: "inline" as const }],
  }

  it("工具说明讲清几件事：先查通道和模板、建前要用户确认、建完不进入会话、bindings 必须指定、通道之间隔离", () => {
    const { tool } = setup(() => ({ ok: true, result: [] }))
    for (const word of [
      "templates", "repos", "channels", "create", "bind", "unbind", "send_question", "不会进入项目会话", "独立群", "delete",
      "bindings", "没有默认值", "inline", "只能接自己所在的通道", "按消息通道隔离",
    ]) expect(tool.description, word).toContain(word)
    expect(tool.description).not.toContain("chat_mode")
  })

  it("参数校验：认新的 action 和 snake_case 参数，拒掉不认识的", () => {
    const { tool } = setup(() => ({ ok: true, result: [] }))
    const ok = tool.inputSchema.safeParse({
      action: "create", name: "n", template_id: "develop", fields: { 交付形式: "PPT" },
      repos: [{ repo_path: "/r/a", base_branch: "main" }], work_branch: "test", feature_branch: "f", story_url: "u", related_docs: "d", folder: "/x",
      bindings: [{ channel_id: "ch_fs", mode: "bind", group_chat_id: "oc_aa2192cfececee92d57dccd0b59980fd" }, { channel_id: "ch_app", mode: "inline" }],
    })
    expect(ok.success).toBe(true)
    for (const action of [
      "help", "list", "get", "create", "update", "archive", "delete", "sync_steps", "channels", "bind", "unbind",
      "templates", "template_save", "template_delete", "repos", "repo_save", "repo_remove", "settings", "settings_set",
    ]) expect(tool.inputSchema.safeParse({ action }).success).toBe(true)
    expect(tool.inputSchema.safeParse({ action: "rename" }).success).toBe(false)
    // 管理类的新参数：repo / template / settings 是对象，topic / work_branch 是枚举
    expect(tool.inputSchema.safeParse({
      action: "template_save", template_id: "t",
      template: { name: "n", needs_repo: true, work_branch: "test", fields: [{ label: "a", required: true }], actions: [{ id: "x", label: "y", prompt: "p" }] },
    }).success).toBe(true)
    expect(tool.inputSchema.safeParse({ action: "repo_save", repo: { repo_path: "/r/a", base_branch: "main", clone: false } }).success).toBe(true)
    expect(tool.inputSchema.safeParse({ action: "repo_save", repo: { base_branch: "main" } }).success).toBe(false)
    expect(tool.inputSchema.safeParse({ action: "settings_set", settings: { worktree_root: "/p", gitlab_token: "t", reset_git_principles: true } }).success).toBe(true)
    expect(tool.inputSchema.safeParse({ action: "settings_set", settings: { gitlab_token: 123 } }).success).toBe(false)
    expect(tool.inputSchema.safeParse({ action: "help", topic: "create" }).success).toBe(true)
    expect(tool.inputSchema.safeParse({ action: "help", topic: "billing" }).success).toBe(false)
    expect(tool.inputSchema.safeParse({ action: "archive", project_id: "p", archived: "yes" }).success).toBe(false)
    expect(tool.inputSchema.safeParse({ action: "template_save", template: { work_branch: "main" } }).success).toBe(false)
    expect(tool.inputSchema.safeParse({ action: "create", work_branch: "main" }).success).toBe(false)
    expect(tool.inputSchema.safeParse({ action: "create", repos: [{ repo_path: "/r/a" }] }).success).toBe(false)
    for (const mode of ["group", "bind", "inline"]) expect(tool.inputSchema.safeParse({ action: "create", bindings: [{ channel_id: "c", mode }] }).success).toBe(true)
    expect(tool.inputSchema.safeParse({ action: "create", bindings: [{ channel_id: "c", mode: "dedicated" }] }).success).toBe(false)
    // 每一项都要有 channel_id；bindings 是数组
    expect(tool.inputSchema.safeParse({ action: "create", bindings: [{ mode: "inline" }] }).success).toBe(false)
    expect(tool.inputSchema.safeParse({ action: "create", bindings: "inline" }).success).toBe(false)
    // 旧的 chat_mode 参数没有了：不认的参数被丢掉（不会再当成选了 inline）
    const legacy = tool.inputSchema.safeParse({ action: "create", chat_mode: "inline" })
    expect(legacy.success && "chat_mode" in (legacy.data ?? {})).toBe(false)
  })

  it("create：带上调用者所在的聊天（去掉会话里的工作目录后缀）和翻成驼峰的参数，给足建项时间", async () => {
    const { call, calls } = setup(() => ({ ok: true, result: CREATED }))
    const text = await call({
      action: "create", name: "Q4 调研", goal: "看清竞品", template_id: "research", fields: { 交付形式: "PPT" },
      repos: [{ repo_path: "/r/shop", base_branch: "main" }], work_branch: "test", feature_branch: "feature/x",
      story_url: "https://t.example.com/1", related_docs: "见 wiki", folder: "/f",
      bindings: [{ channel_id: "ch_fs", mode: "inline" }, { channel_id: "ch_fs", mode: "bind", group_chat_id: " oc_aa2192cfececee92d57dccd0b59980fd " }],
    }, FEISHU_SK)
    expect(calls).toHaveLength(1)
    expect(calls[0].kind).toBe("project.create")
    expect(calls[0].timeoutMs).toBeGreaterThanOrEqual(5 * 60_000)
    expect(calls[0].payload).toEqual({
      chatKey: "ch_fs|ou_main",
      // snake_case 翻成驼峰，群号去掉首尾空白
      bindings: [
        { channelId: "ch_fs", mode: "inline" },
        { channelId: "ch_fs", mode: "bind", groupChatId: "oc_aa2192cfececee92d57dccd0b59980fd" },
      ],
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
    await call({ action: "create", name: "n", template_id: "general", bindings: [{ channel_id: "ch_app", mode: "inline" }] }, APP_SK)
    expect(calls[0].payload.chatKey).toBe("ch_app|app_main")
  })

  it("没有调用者会话 / 没给模板：直接报错，不去打扰宿主", async () => {
    const { call, calls } = setup(() => ({ ok: true, result: CREATED }))
    expect(await call({ action: "create", name: "n", template_id: "general", bindings: INLINE_FS })).toContain("无法确定你所在的会话")
    expect(await call({ action: "create", name: "n", bindings: INLINE_FS }, FEISHU_SK)).toContain("template_id")
    expect(await call({ action: "create", name: "n", template_id: "  ", bindings: INLINE_FS }, FEISHU_SK)).toContain("template_id")
    expect(calls).toEqual([])
  })

  it("bindings 必须指定：不给就报错并让 AI 先看 channels、再去问用户，不去打扰宿主（各个通道都一样，没有默认值）", async () => {
    const { call, calls } = setup(() => ({ ok: true, result: CREATED }))
    for (const sk of [FEISHU_SK, APP_SK]) {
      for (const args of [{}, { bindings: [] }]) {
        const text = await call({ action: "create", name: "n", template_id: "general", ...args }, sk)
        expect(text.startsWith("❌ ")).toBe(true)
        expect(text).toContain("bindings")
        expect(text).toContain("channels")
        expect(text).toContain("send_question")
      }
    }
    expect(calls).toEqual([])
  })

  it("bindings 里的 group / bind / 多个通道：连同群号原样交给宿主，结果里每个通道各说一句", async () => {
    const { call, calls } = setup(() => ({
      ok: true,
      result: {
        ...CREATED,
        bindings: [
          { channelId: "ch_app", channelName: "应用内", ok: true, mode: "inline" },
          { channelId: "ch_fs", channelName: "飞书", ok: true, mode: "group", groupName: "📦 Q4 调研", groupChatId: "oc_new" },
        ],
      },
    }))
    const text = await call({
      action: "create", name: "Q4 调研", template_id: "general",
      bindings: [{ channel_id: "ch_app", mode: "inline" }, { channel_id: "ch_fs", mode: "group" }],
    }, APP_SK)
    expect(calls[0].payload).toMatchObject({
      chatKey: "ch_app|app_main",
      bindings: [{ channelId: "ch_app", mode: "inline" }, { channelId: "ch_fs", mode: "group" }],
    })
    expect(text).toContain("「应用内」接了主聊天")
    expect(text).toContain("「飞书」新建了飞书独立群「📦 Q4 调研」")
  })

  it("宿主没响应 / 超时 / 建项校验没过：原因原样带给 AI，不当成功", async () => {
    const down = setup(() => ({ ok: false, error: "应用主进程没有响应" }))
    expect(await down.call({ action: "create", name: "n", template_id: "general", bindings: INLINE_FS }, FEISHU_SK)).toBe("❌ 应用主进程没有响应")
    const invalid = setup(() => ({ ok: true, result: { ok: false, error: "请填写：交付形式" } }))
    expect(await invalid.call({ action: "create", name: "n", template_id: "research", bindings: INLINE_FS }, FEISHU_SK)).toBe("❌ 请填写：交付形式")
    const empty = setup(() => ({ ok: true, result: undefined }))
    expect(await empty.call({ action: "create", name: "n", template_id: "general", bindings: INLINE_FS }, FEISHU_SK)).toContain("❌")
  })

  it("channels：问宿主「我在哪个通道、能接哪些」，把清单讲给 AI；没有会话 / 宿主出错带原因", async () => {
    const options = [
      { id: "ch_app", name: "应用内", type: "app", current: true, modes: ["inline"] },
      { id: "ch_fs", name: "飞书", type: "feishu", current: false, modes: ["inline", "bind"], note: "没有记录到主用户的飞书身份（open_id），不能新建独立群" },
    ]
    const s = setup(() => ({ ok: true, result: { ok: true, current: "ch_app", channels: options } }))
    const text = await s.call({ action: "channels" }, APP_SK)
    expect(s.calls).toHaveLength(1)
    expect(s.calls[0]).toMatchObject({ kind: "project.channels", payload: { chatKey: "ch_app|app_main" } })
    expect(s.calls[0].timeoutMs).toBeLessThan(5 * 60_000)
    expect(text).toContain("你现在在「应用内」通道（channel_id=ch_app）")
    expect(text).toContain("channel_id=ch_fs")
    expect(text).toContain("当前所在")
    expect(text).toContain("不能新建独立群")

    expect(await s.call({ action: "channels" })).toContain("无法确定你所在的会话")
    expect(await setup(() => ({ ok: false, error: "应用主进程没有响应" })).call({ action: "channels" }, APP_SK)).toBe("❌ 应用主进程没有响应")
    expect(await setup(() => ({ ok: true, result: { ok: false, error: "只有主用户的私聊可以创建项目" } })).call({ action: "channels" }, FEISHU_SK)).toBe("❌ 只有主用户的私聊可以创建项目")
    expect(await setup(() => ({ ok: true, result: undefined })).call({ action: "channels" }, FEISHU_SK)).toContain("❌")
  })

  it("bind / unbind：没有调用者会话时直接报错，不去打扰宿主", async () => {
    const { call, calls } = setup(() => ({ ok: true, result: { ok: true } }))
    expect(await call({ action: "bind", project_id: "p1", bindings: INLINE_FS })).toContain("无法确定你所在的会话")
    expect(await call({ action: "unbind", project_id: "p1", bindings: INLINE_FS })).toContain("无法确定你所在的会话")
    expect(calls).toEqual([])
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

describe("parseAiBindings：MCP 参数（snake_case）→ 接入点", () => {
  it("channel_id / mode / group_chat_id 翻成驼峰，去掉首尾空白；没给群号就不带这个字段", () => {
    expect(parseAiBindings([
      { channel_id: " ch_fs ", mode: " inline " },
      { channel_id: "ch_fs", mode: "bind", group_chat_id: "  oc_x1  " },
      { channel_id: "ch_fs", mode: "group", group_chat_id: "   " },
    ])).toEqual([
      { channelId: "ch_fs", mode: "inline" },
      { channelId: "ch_fs", mode: "bind", groupChatId: "oc_x1" },
      { channelId: "ch_fs", mode: "group" },
    ])
  })

  it("没给 / 空数组：得到空列表（由调用方报「必须指定 bindings」）；缺的字段变成空串，由宿主的校验带原因报错", () => {
    expect(parseAiBindings(undefined)).toEqual([])
    expect(parseAiBindings([])).toEqual([])
    expect(parseAiBindings([{ mode: "inline" }])).toEqual([{ channelId: "", mode: "inline" }])
    expect(parseAiBindings([{ channel_id: "c" }])).toEqual([{ channelId: "c", mode: "" }])
  })
})

describe("formatChannels：告诉 AI 当前在哪、能接哪些通道、各自能用什么方式", () => {
  const app = { id: "ch_app", name: "应用内", type: "app" as const, current: true, modes: ["inline" as const] }
  const fs = { id: "ch_fs", name: "飞书", type: "feishu" as const, current: false, modes: ["inline" as const, "group" as const, "bind" as const] }

  it("在应用内对话里：能接任何通道，当前所在的通道有标记，说明三种方式和没有默认值", () => {
    const t = formatChannels("ch_app", [app, fs])
    expect(t).toContain("你现在在「应用内」通道（channel_id=ch_app）")
    expect(t).toContain("可以把项目接到下面任何通道")
    expect(t).toContain("共 2 个通道")
    expect(t).toContain("#1 应用内｜channel_id=ch_app｜应用内对话｜当前所在｜能用：inline")
    expect(t).toContain("#2 飞书｜channel_id=ch_fs｜飞书｜能用：inline / group / bind")
    expect(t).not.toContain("#2 飞书｜channel_id=ch_fs｜飞书｜当前所在")
    for (const word of ["inline", "group", "bind", "没有默认值", "send_question"]) expect(t).toContain(word)
  })

  it("只有自己所在的通道：说明别的通道要到应用内对话里操作；受限的原因（note）原样给出", () => {
    const t = formatChannels("ch_fs", [{ ...fs, current: true, modes: ["inline", "bind"], note: "没有记录到主用户的飞书身份（open_id），不能新建独立群" }])
    expect(t).toContain("项目只能接到你当前所在的这个通道")
    expect(t).toContain("⚠️ 没有记录到主用户的飞书身份（open_id），不能新建独立群")
    expect(t).toContain("能用：inline / bind")
  })

  it("一种方式都不能用 / 没有通道：照实说", () => {
    expect(formatChannels("ch_fs", [{ ...fs, current: true, modes: [], note: "这个通道已停用" }])).toContain("暂时都不能选")
    expect(formatChannels("x", [])).toContain("没有可以接入项目的消息通道")
  })
})

describe("formatCreated：按项目接入的每个通道，告诉 AI 接下来怎么跟用户说", () => {
  const base = { ok: true as const, projectId: "pid1", name: "改版", dir: "D:\\p\\改版", templateName: "开发" }
  const inline = { channelId: "ch_fs", channelName: "飞书", ok: true, mode: "inline" as const }

  it("inline：没建群，项目 ID 给用户，可以 /p use 进入；没有进入会话", () => {
    const t = formatCreated({ ...base, bindings: [inline] })
    expect(t).toContain("✅ 已创建项目「改版」")
    expect(t).toContain("项目 ID：pid1")
    expect(t).toContain("「飞书」接了主聊天（不建群）")
    expect(t).toContain("/p use <项目 ID>")
    expect(t).toContain("没有进入项目会话")
    expect(t).not.toContain("飞书独立群")
    expect(t).not.toContain("⚠️")
  })

  it("group：说明建了群、用户是群主、群里的项目只能在群里进入和推进", () => {
    const t = formatCreated({ ...base, bindings: [{ channelId: "ch_fs", channelName: "飞书", ok: true, mode: "group", groupName: "📦 改版", groupChatId: "oc_new" }] })
    expect(t).toContain("「飞书」新建了飞书独立群「📦 改版」")
    expect(t).toContain("群主")
    expect(t).toContain("群里的项目只能在群里进入和推进")
  })

  it("bind：说明绑了哪个群，提醒确认机器人在群里；不声称项目卡一定送达", () => {
    const t = formatCreated({ ...base, bindings: [{ channelId: "ch_fs", channelName: "飞书", ok: true, mode: "bind", groupChatId: "oc_exist" }] })
    expect(t).toContain("「飞书」绑定了飞书群 oc_exist")
    expect(t).toContain("机器人不在群里的话发不进去")
    expect(t).toContain("群里的项目只能在群里进入和推进")
  })

  it("多个通道：每个通道一行；没接成的带原因，warning 排在接入清单前面，让 AI 如实转述", () => {
    const t = formatCreated({
      ...base,
      bindings: [
        { channelId: "ch_app", channelName: "应用内", ok: true, mode: "inline" },
        { channelId: "ch_fs", channelName: "飞书", ok: false, mode: "group", warning: "建独立群没成功：无权限" },
      ],
      warning: "「飞书」建独立群没成功：无权限。项目已经建好，其余接入照常。",
    })
    const lines = t.split("\n")
    const warnAt = lines.findIndex((l) => l.startsWith("⚠️ 「飞书」建独立群没成功"))
    expect(warnAt).toBeGreaterThan(-1)
    expect(warnAt).toBeLessThan(lines.findIndex((l) => l.startsWith("- ✅「应用内」")))
    expect(t).toContain("- ⚠️「飞书」建独立群没成功：无权限")
  })
})

describe("formatBound / formatUnbound", () => {
  it("bind：列出每个接入点的结果，部分没接成带 warning", () => {
    const t = formatBound({
      ok: true, projectId: "p1", name: "改版",
      bindings: [
        { channelId: "ch_wx", channelName: "微信", ok: true, mode: "inline" },
        { channelId: "ch_fs", channelName: "飞书", ok: false, mode: "bind", warning: "绑定群没成功：该群已绑定项目「甲」(x)" },
      ],
      warning: "「飞书」绑定群没成功。其余接入已生效，请如实告诉用户",
    })
    expect(t).toContain("项目「改版」（p1）的接入已更新")
    expect(t).toContain("- ✅「微信」接了主聊天")
    expect(t).toContain("- ⚠️「飞书」绑定群没成功")
    expect(t).toContain("其余接入已生效")
  })

  it("unbind：说清取消了什么、会话已清理；专属群的备注（没解散）一并带上", () => {
    const main = formatUnbound({ ok: true, projectId: "p1", name: "改版", removed: "飞书 的主聊天" })
    expect(main).toContain("项目「改版」（p1）已取消接入：飞书 的主聊天")
    expect(main).toContain("那条会话已一并清理")
    const group = formatUnbound({ ok: true, projectId: "p1", name: "改版", removed: "飞书 的专属群", note: "群没有改名也没有解散，只是不再接入这个项目" })
    expect(group).toContain("群没有改名也没有解散")
  })
})

describe("接线（只有真实应用跑得到的部分，读源码守住）", () => {
  const read = (...p: string[]) => fs.readFileSync(path.resolve(__dirname, "..", ...p), "utf8").replace(/\r\n/g, "\n")

  it("宿主：daemon 输出里的 __HOST_RPC__ 行交给分发器，处理函数就是项目那几个", () => {
    const src = read("electron", "daemon-manager.ts")
    expect(src).toMatch(/createHostRpcDispatcher\(\{[^}]*handlers: projectHostRpcHandlers/s)
    expect(src).toMatch(/line\.startsWith\(HOST_RPC_PREFIX\)\) \{\n\s*void handleHostRpcLine\(line, cachedPort \?\? readLockFile\(\)\?\.port\)\n\s*continue/)
    const proj = read("electron", "project-create.ts")
    for (const kind of ["project.templates", "project.repos", "project.channels", "project.create", "project.bind", "project.unbind"]) expect(proj).toContain(`"${kind}"`)
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
    expect(ai).toContain("createProjectCore(input)")
    const app = src.slice(src.indexOf("export async function createProjectFromApp"), src.indexOf("export async function createProjectForAi"))
    expect(app).toContain("enterProjectSession")
  })

  it("AI 建群 / 绑群：先认人、再校验接入点，都在建项之前；接入只在项目整个建成之后，且不离开会话、不清「当前项目」指针、不往私聊发回执", () => {
    const create = read("electron", "project-create.ts")
    const ai = create.slice(create.indexOf("export async function createProjectForAi"), create.indexOf("function strOf"))
    const core = ai.indexOf("createProjectCore(input)")
    expect(core).toBeGreaterThan(-1)
    // 先认出调用者（只认主用户）、再校验 bindings（没有默认值），然后才建目录建项目
    expect(ai.indexOf("resolveAiCreateChat(chatKey)")).toBeGreaterThan(-1)
    expect(ai.indexOf("resolveAiCreateChat(chatKey)")).toBeLessThan(ai.indexOf("planBindingChoices("))
    expect(ai.indexOf("planBindingChoices(")).toBeLessThan(core)
    // 项目建好（校验、克隆、落盘都过了）才去接入通道
    expect(ai.indexOf("attachPlannedBindings(")).toBeGreaterThan(core)
    expect(ai).not.toContain("leaveProjectSession")
    expect(ai).not.toContain("setCurrentProjectId")

    const cmds = read("electron", "project-commands.ts")
    const attach = cmds.slice(cmds.indexOf("export async function attachPlannedBindings"), cmds.indexOf("async function replyGroupModeCreated"))
    expect(attach).toContain("createGroupBinding(")
    expect(attach).toContain("bindExistingGroup(")
    expect(attach).not.toContain("leaveProjectSession")
    expect(attach).not.toContain("setCurrentProjectId")
    // 回执只发到群里（chatKey 是群），不发回调用者的私聊
    const announce = cmds.slice(cmds.indexOf("async function announceProjectInGroup"), cmds.indexOf("export async function attachPlannedBindings"))
    expect(announce).toContain(`reportCommandResult(port, "", true, "", groupChatKey,`)

    // 飞书表单建项的老路径行为不变：选了群就回到主会话（项目只在群里协作），沿用当前会话的照样进入项目、记下当前项目
    expect(cmds).toMatch(/await leaveProjectSession\(port, chatId\)/)
    expect(cmds).toMatch(/await enterProjectSession\(port, chatId, project\)\n\s*if \(!r\.ok\)/)
    expect(cmds).toMatch(/setCurrentProjectId\(project\.id, chatId\)/)
  })

  it("server-admin：create 在打扰宿主之前先要求 bindings；带上调用者的聊天", () => {
    const admin = read("src", "server-admin.ts")
    const block = admin.slice(admin.indexOf('if (action === "create")'), admin.indexOf("// 只剩 delete"))
    expect(block.indexOf("parseAiBindings(bindings)")).toBeGreaterThan(-1)
    expect(block.indexOf("if (!choices.length)")).toBeLessThan(block.indexOf('request<AiProjectCreateResult>("project.create"'))
    expect(block).toContain("bindings: choices")
    expect(block).toContain("chatKey: chatIdFromSessionKey(invoker)")
    expect(block).not.toContain("chat_mode")
  })
})
