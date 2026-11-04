import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import * as fs from "node:fs"
import * as http from "node:http"
import * as os from "node:os"
import * as path from "node:path"
import { LOCK_FILE_NAME } from "../src/shared/constants"
import { ensureSessionEntry, globalChatNamesPath, globalRoutingPath } from "../src/shared/session-entry-paths"

/**
 * 会话清单里别人的会话「叫什么」的接线：真实的 session-manager / session-dispatcher / session-chat-name，
 * 真实文件（临时数据目录），向 daemon 要群名走真实 HTTP（假 daemon 记下被问了什么）。
 * 只有 electron 和通道配置用桩顶掉。「重启」用 vi.resetModules() 换一套全新的模块实例，内存缓存清空、磁盘上的留着。
 */

let userData = ""
let channels: Array<Record<string, unknown>> = []
vi.mock("electron", () => ({
  app: { getPath: () => userData, getVersion: () => "0", isPackaged: false },
  BrowserWindow: { getAllWindows: () => [] },
  ipcMain: { handle: () => {}, on: () => {} },
  shell: {},
  dialog: {},
  safeStorage: { isEncryptionAvailable: () => false },
}))
vi.mock("../electron/config-store", async (orig) => {
  const actual = await orig<typeof import("../electron/config-store")>()
  return {
    ...actual,
    getConfig: () => ({ channels, agentResources: [] }),
    getChannels: () => channels,
    getChannel: (id?: string) => channels.find((c) => c.id === id),
    // 真的 resolveChannelForSession 绕过上面的桩去读 electron-store，测试里没有 projectName 会抛；
    // 排队消息的标签（getQueueMessages）要用它
    resolveChannelForSession: (key: string) => channels.find((c) => c.id === key.split("|")[0]),
    getAgentResource: () => ({ id: "sdk_main", type: "sdk", name: "主供应商", apiKey: "" }),
  }
})

// 运行中的会话：只顶掉「有哪些引擎、各自在跑什么」，引擎列表的合并和会话名的解析（队列、工作台树看到的名字）用真的
let runningSessions: Array<Record<string, unknown>> = []
vi.mock("../electron/agent-engine/factory", async (orig) => {
  const actual = await orig<typeof import("../electron/agent-engine/factory")>()
  const engine = { listSessions: () => runningSessions, setIdleHandler: () => {} }
  return { ...actual, getAllAgentEngines: () => [engine] as never }
})

const FEISHU = {
  id: "ch_f", name: "AI Support", type: "feishu", enabled: true,
  mainUserEnabled: true, mainUserChatId: "ou_main", model: "composer-2", othersModel: "gemini-flash",
}
const WECHAT = { ...FEISHU, id: "ch_w", name: "微信", type: "wechat" }
const FEISHU_OFF = { ...FEISHU, id: "ch_off", name: "已停用", enabled: false }

const G1 = "ch_f|oc_group_aaa111"
const G2 = "ch_f|oc_group_bbb222"
const P_GUEST = "ch_f|oc_p2p_ccc333"
const P_OPENID = "ou_guest_open_id"

let server: http.Server
let asked: string[][]
let known: Record<string, string>
let queued: Array<Record<string, unknown>>

beforeEach(async () => {
  userData = fs.mkdtempSync(path.join(os.tmpdir(), "session-names-"))
  channels = [FEISHU]
  asked = []
  known = {}
  queued = []
  runningSessions = []
  server = http.createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on("data", (c: Buffer) => chunks.push(c))
    req.on("end", () => {
      res.setHeader("content-type", "application/json")
      if (req.url === "/queue") return void res.end(JSON.stringify({ messages: queued }))
      if (req.url === "/api/chat-names") {
        const ids = (JSON.parse(Buffer.concat(chunks).toString("utf8")).chatIds ?? []) as string[]
        asked.push(ids)
        const names: Record<string, string> = {}
        for (const id of ids) if (known[id]) names[id] = known[id]
        return void res.end(JSON.stringify({ ok: true, names }))
      }
      res.end(JSON.stringify({ ok: true }))
    })
  })
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r))
  const { port } = server.address() as { port: number }
  fs.writeFileSync(path.join(userData, LOCK_FILE_NAME), JSON.stringify({ pid: 1, port, version: "test" }))
})

afterEach(async () => {
  await new Promise<void>((r) => server.close(() => r()))
  fs.rmSync(userData, { recursive: true, force: true })
})

function addSession(chatKey: string, dir = "D:\\ws\\a", userText?: string): void {
  const key = `${chatKey}::${dir}`
  const entry = ensureSessionEntry(userData, key)
  if (userText) {
    fs.writeFileSync(
      path.join(entry, "mirror.jsonl"),
      [JSON.stringify({ role: "user", text: userText, at: 1 }), JSON.stringify({ role: "assistant", text: "好", at: 2 })].join("\n") + "\n",
    )
  }
}

function writeRouting(chatType: Record<string, string>): void {
  const p = globalRoutingPath(userData)
  fs.mkdirSync(path.dirname(p), { recursive: true })
  fs.writeFileSync(p, JSON.stringify({ chatType }))
}

/** 「启动应用」：换一套全新的模块实例（内存缓存清空），按真实启动那样把查名字的几个钩子接上 */
async function boot() {
  vi.resetModules()
  const manager = await import("../electron/session-manager")
  const dispatcher = await import("../electron/session-dispatcher")
  dispatcher.initSessionDispatcher()
  const names = async (): Promise<Record<string, string>> => {
    const r = await manager.listSessionsForManager()
    expect(r.ok).toBe(true)
    return Object.fromEntries(r.sessions.map((s) => [s.chatKey, s.name]))
  }
  return { manager, dispatcher, names }
}

const settle = () => new Promise((r) => setTimeout(r, 60))

describe("清单里别人的群：后台去问群名", () => {
  it("第一次刷新先显示「群 + 尾号」，问到之后下一次刷新就是群名；名字也落了盘", async () => {
    addSession(G1)
    addSession(G2)
    writeRouting({ [G1]: "group", [G2]: "group" })
    known = { [G1]: "客服一群", [G2]: "客服二群" }
    const { names, dispatcher } = await boot()

    const first = await names()
    expect(first[G1]).toBe("群 aaa111")
    expect(first[G2]).toBe("群 bbb222")

    await vi.waitFor(async () => {
      const later = await names()
      expect(later[G1]).toBe("客服一群")
      expect(later[G2]).toBe("客服二群")
    })
    // 派发和状态轮询读的是同一份内存缓存：清单问到的群名它们也要能用，不能各问各的
    expect(dispatcher.chatNameCache.get(G1)).toBe("客服一群")
    const disk = JSON.parse(fs.readFileSync(globalChatNamesPath(userData), "utf8")) as { names: Record<string, string> }
    expect(disk.names).toMatchObject({ [G1]: "客服一群", [G2]: "客服二群" })
  })

  it("问到了的群不会每次刷新都再问（清单 8 秒刷新一次）", async () => {
    addSession(G1)
    writeRouting({ [G1]: "group" })
    known = { [G1]: "客服一群" }
    const { names } = await boot()
    await names()
    await vi.waitFor(async () => expect((await names())[G1]).toBe("客服一群"))
    const askedBefore = asked.length
    for (let i = 0; i < 5; i++) await names()
    await settle()
    expect(asked.length).toBe(askedBefore)
  })

  it("问不到名字的群（机器人被移出了）冷却：多次刷新只问一次，名字一直是「群 + 尾号」", async () => {
    addSession(G1)
    writeRouting({ [G1]: "group" })
    known = {} // 飞书那边什么都查不到
    const { names } = await boot()
    for (let i = 0; i < 6; i++) {
      expect((await names())[G1]).toBe("群 aaa111")
      await settle()
    }
    expect(asked.flat().filter((k) => k === G1).length).toBe(1)
  })

  it("非飞书通道、已停用通道的群不去问飞书", async () => {
    channels = [FEISHU, WECHAT, FEISHU_OFF]
    const wechatGroup = "ch_w|oc_wxgroup_ddd444"
    const offGroup = "ch_off|oc_offgroup_eee555"
    addSession(G1)
    addSession(wechatGroup)
    addSession(offGroup)
    writeRouting({ [G1]: "group", [wechatGroup]: "group", [offGroup]: "group" })
    known = { [G1]: "客服一群" }
    const { names } = await boot()
    await names()
    await vi.waitFor(() => expect(asked.length).toBeGreaterThan(0))
    await settle()
    expect(asked.flat()).toEqual([G1])
  })

  it("重启之后（内存缓存空了），重新问到之前先用落盘的名字；问到新名字（群改了名）就换上", async () => {
    addSession(G1)
    writeRouting({ [G1]: "group" })
    known = { [G1]: "旧群名" }
    const first = await boot()
    await first.names()
    await vi.waitFor(async () => expect((await first.names())[G1]).toBe("旧群名"))

    // 重启；这回飞书暂时问不到——清单仍然是旧群名，不会退回「群 aaa111」
    known = {}
    const second = await boot()
    expect((await second.names())[G1]).toBe("旧群名")
    await settle()
    expect((await second.names())[G1]).toBe("旧群名")

    // 再重启一次，这回问得到新名字
    known = { [G1]: "新群名" }
    const third = await boot()
    expect((await third.names())[G1]).toBe("旧群名")
    await vi.waitFor(async () => expect((await third.names())[G1]).toBe("新群名"))
  })

  it("daemon 没起：清单照常返回，名字用兜底；daemon 起来后补上", async () => {
    addSession(G1)
    writeRouting({ [G1]: "group" })
    known = { [G1]: "客服一群" }
    const lock = path.join(userData, LOCK_FILE_NAME)
    const saved = fs.readFileSync(lock)
    fs.rmSync(lock)
    const { names } = await boot()
    expect((await names())[G1]).toBe("群 aaa111")
    await settle()
    expect(asked).toEqual([])

    fs.writeFileSync(lock, saved)
    // 锁文件有 2 秒的读取缓存，等它过期；问不了不算失败，没有进冷却，起来后下一次刷新就会问
    await vi.waitFor(async () => expect((await names())[G1]).toBe("客服一群"), { timeout: 8000, interval: 500 })
  })
})

describe("清单里别人的私聊：名字按聊天键记下来", () => {
  it("运行时按 open_id 查到的名字，记到聊天键下：重启后会话空闲也认得出", async () => {
    addSession(P_GUEST, "D:\\ws\\a", "你好，我想问个问题")
    writeRouting({ [P_GUEST]: "p2p" })
    const a = await boot()
    expect((await a.names())[P_GUEST]).toBe("私聊 ccc333")

    a.dispatcher.chatNameCache.set(P_OPENID, "张三")
    a.dispatcher.rememberP2pNames([{ sessionKey: `${P_GUEST}::D:\\ws\\a`, chatType: "p2p", senderOpenId: P_OPENID }])
    expect((await a.names())[P_GUEST]).toBe("张三")

    const b = await boot() // 重启：内存里的 open_id → 名字没了，磁盘上记着聊天键 → 名字
    expect(b.dispatcher.chatNameCache.size).toBe(0)
    expect((await b.names())[P_GUEST]).toBe("张三")
  })

  it("只记私聊、只记真查到名字的：群的发言人、还没查到名字的 open_id 都不记", async () => {
    addSession(P_GUEST)
    addSession(G1)
    writeRouting({ [P_GUEST]: "p2p", [G1]: "group" })
    const a = await boot()
    a.dispatcher.chatNameCache.set("ou_speaker_in_group", "群里的某人")
    a.dispatcher.rememberP2pNames([
      { sessionKey: `${G1}::D:\\ws\\a`, chatType: "group", senderOpenId: "ou_speaker_in_group" },
      { sessionKey: `${P_GUEST}::D:\\ws\\a`, chatType: "p2p", senderOpenId: "ou_not_resolved_yet" },
      { sessionKey: `${P_GUEST}::D:\\ws\\a`, chatType: "p2p" },
    ])
    expect(a.dispatcher.chatNameBook.get(G1)).toBeUndefined()
    expect(a.dispatcher.chatNameBook.get(P_GUEST)).toBeUndefined()
    expect(fs.existsSync(globalChatNamesPath(userData))).toBe(false)
    expect((await a.names())[P_GUEST]).toBe("私聊 ccc333")
  })

  it("一个都没查到名字：每个会话各按自己的尾号区分，没有一个叫「访客」", async () => {
    const others = ["ch_f|oc_p2p_fff666", "ch_f|oc_p2p_ggg777"]
    addSession(P_GUEST)
    others.forEach((k) => addSession(k))
    addSession(G1)
    writeRouting({ [P_GUEST]: "p2p", [others[0]]: "p2p", [others[1]]: "p2p", [G1]: "group" })
    const { names } = await boot()
    const all = Object.values(await names())
    expect(all.sort()).toEqual(["私聊 ccc333", "私聊 fff666", "私聊 ggg777", "群 aaa111"].sort())
    expect(all.some((n) => n.includes("访客"))).toBe(false)
    // 清单只为群去问飞书要名字；私聊要的是用户名，靠 open_id，群名接口问不出来
    await vi.waitFor(() => expect(asked.length).toBeGreaterThan(0))
    await settle()
    expect(asked.flat()).toEqual([G1])
  })
})

/** 引擎里「正在跑」的一个会话（字段和真实的 listSessions 一样；chatName 不带，由 listAllAgentSessions 按缓存解析） */
function running(chatKey: string, chatType: string, senderOpenId?: string, dir = "D:\\ws\\a"): Record<string, unknown> {
  return {
    sessionKey: `${chatKey}::${dir}`, runtimeId: "sdk", startedAt: 1, lastActivityAt: 2,
    chatType, workspaceDir: dir, senderOpenId,
  }
}

describe("清单里别人的私聊：和队列、工作台树取同一个名字", () => {
  it("运行中的私聊：队列里叫什么，清单里就叫什么，不用等任何轮询、不依赖谁事先记过", async () => {
    addSession(P_GUEST, "D:\\ws\\a", "OW00UQ 为何不能申请")
    writeRouting({ [P_GUEST]: "p2p" })
    runningSessions = [running(P_GUEST, "p2p", P_OPENID)]
    const { names, dispatcher, manager } = await boot()
    dispatcher.chatNameCache.set(P_OPENID, "甘露")

    // 队列行 / 工作台树用的就是这个：运行中会话自己解析出来的名字
    expect(dispatcher.getSessionAgentList()[0].chatName).toBe("甘露")
    expect((await names())[P_GUEST]).toBe("甘露")
    const row = (await manager.listSessionsForManager()).sessions.find((s) => s.chatKey === P_GUEST)
    expect(row?.running).toBe(true)
  })

  it("还没查到对方名字时是「私聊 + 尾号」，不是「访客」；查到的下一次刷新就换上", async () => {
    addSession(P_GUEST)
    writeRouting({ [P_GUEST]: "p2p" })
    runningSessions = [running(P_GUEST, "p2p", P_OPENID)]
    const { names, dispatcher } = await boot()
    expect((await names())[P_GUEST]).toBe("私聊 ccc333")

    dispatcher.chatNameCache.set(P_OPENID, "甘露")
    expect((await names())[P_GUEST]).toBe("甘露")
  })

  it("会话结束之后（不再运行）、应用重启之后，名字还在", async () => {
    addSession(P_GUEST)
    writeRouting({ [P_GUEST]: "p2p" })
    runningSessions = [running(P_GUEST, "p2p", P_OPENID)]
    const a = await boot()
    a.dispatcher.chatNameCache.set(P_OPENID, "甘露")
    expect((await a.names())[P_GUEST]).toBe("甘露")

    runningSessions = []
    expect((await a.names())[P_GUEST]).toBe("甘露")

    const b = await boot()
    expect(b.dispatcher.chatNameCache.size).toBe(0)
    expect((await b.names())[P_GUEST]).toBe("甘露")
  })

  it("只在队列里排队、还没拉起的私聊：消息带着 open_id，同样认得出", async () => {
    addSession(P_GUEST)
    writeRouting({ [P_GUEST]: "p2p" })
    queued = [{
      index: 0, fileId: "f1", preview: "你好", status: "pending", sessionKey: `${P_GUEST}::D:\\ws\\a`,
      chatType: "p2p", timestamp: 1, senderOpenId: P_OPENID,
    }]
    const { names, dispatcher } = await boot()
    dispatcher.chatNameCache.set(P_OPENID, "甘露")
    expect((await names())[P_GUEST]).toBe("甘露")
  })

  it("群：发言人的 open_id 不能当成群名（群里运行中会话的 senderOpenId 是最近一个发言的人）", async () => {
    addSession(G1)
    writeRouting({ [G1]: "group" })
    runningSessions = [running(G1, "group", "ou_speaker")]
    queued = [{ index: 0, fileId: "f2", preview: "x", status: "pending", sessionKey: `${G1}::D:\\ws\\a`, chatType: "group", senderOpenId: "ou_speaker" }]
    const { names, dispatcher } = await boot()
    dispatcher.chatNameCache.set("ou_speaker", "群里的某人")
    expect((await names())[G1]).toBe("群 aaa111")
    expect(dispatcher.chatNameBook.get(G1)).toBeUndefined()
  })

  it("两个人各自的私聊不会串：各用各的 open_id", async () => {
    const P2 = "ch_f|oc_p2p_hhh888"
    addSession(P_GUEST)
    addSession(P2)
    writeRouting({ [P_GUEST]: "p2p", [P2]: "p2p" })
    runningSessions = [running(P_GUEST, "p2p", P_OPENID), running(P2, "p2p", "ou_other")]
    const { names, dispatcher } = await boot()
    dispatcher.chatNameCache.set(P_OPENID, "甘露")
    dispatcher.chatNameCache.set("ou_other", "李四")
    const n = await names()
    expect(n[P_GUEST]).toBe("甘露")
    expect(n[P2]).toBe("李四")
  })
})

describe("清单里别人的会话：最后一句话", () => {
  it("私聊和群都带", async () => {
    addSession(P_GUEST, "D:\\ws\\a", "私聊里的最后一句")
    addSession(G1, "D:\\ws\\a", "群里的最后一句")
    writeRouting({ [P_GUEST]: "p2p", [G1]: "group" })
    const { manager } = await boot()
    const r = await manager.listSessionsForManager()
    const preview = Object.fromEntries(r.sessions.map((s) => [s.chatKey, s.preview]))
    expect(preview).toEqual({ [P_GUEST]: "私聊里的最后一句", [G1]: "群里的最后一句" })
  })
})
