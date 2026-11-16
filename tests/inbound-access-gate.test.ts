/**
 * 入口准入：驱动 daemon 里真实的飞书 / 微信收消息回调，看哪些消息进队列、哪些被拦。
 *
 * 真实的 startFeishuChannel / initWeChatChannel + 真实文件队列（临时目录），只把「连飞书」和「微信 SDK」换成假的：
 * LarkSender.startConnection 只记下回调，WeChatManager 换成只记下回调的壳。
 *
 * 准入规则：其他人私聊、群聊默认全关；主用户私聊、主用户在未开通的群里发 /group 例外；
 * 被拒的消息不入队、不起 Agent，私聊回一句固定的话（24 小时一次），群聊和微信静默。
 */
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"

const h = vi.hoisted(() => {
  // daemon 在导入时就读 APP_DATA_DIR（队列、指令文件都落在里面），必须先于 import 设好
  const dir = (require("node:fs") as typeof import("node:fs")).mkdtempSync(
    (require("node:path") as typeof import("node:path")).join((require("node:os") as typeof import("node:os")).tmpdir(), "claw-access-gate-"),
  )
  process.env.APP_DATA_DIR = dir
  return { dir, wechatOpts: null as null | { onMessage: (m: any) => void } }
})

vi.mock("../src/wechat-manager.js", () => ({
  WeChatManager: class {
    constructor(opts: { onMessage: (m: any) => void }) { h.wechatOpts = opts }
    async start() {}
    async stop() {}
    async sendText() {}
  },
}))

import { channels, initWeChatChannel, startFeishuChannel, updateChannelFlags } from "../src/daemon.js"
import { LarkSender } from "../src/shared/lark-core.js"
import { clearAllQueueMessages, getQueueMessages, initFileQueue } from "../src/file-queue.js"
import { ensureGlobalCommandsDir } from "../src/shared/session-entry-paths.js"

const CH = "ch_gate"
const WS = "D:\\ws\\gate-main"

let onMsg: (ev: any) => void
const sendMessage = vi.fn(async (..._a: unknown[]) => "om_sent")
const replyMessage = vi.fn(async (..._a: unknown[]) => "om_sent")
let seq = 0

function makeRt(extra: Record<string, unknown> = {}, type: "feishu" | "wechat" = "feishu"): any {
  return {
    cfg: {
      id: CH, name: "gate-test", type, appId: "cli_x", appSecret: "secret", wechatToken: "t",
      mainUserEnabled: true, mainUserChatId: "oc_main", mainUserOpenId: "ou_main", workspaceDir: WS,
      ...extra,
    },
    lastP2pChatId: "oc_main",
    bindArmed: false,
    botOpenId: "ou_bot",
  }
}

async function startFeishu(extra: Record<string, unknown> = {}) {
  const rt = makeRt(extra)
  channels.set(CH, rt)
  await startFeishuChannel(rt)
  return rt
}

const dm = (chatId: string, over: Record<string, unknown> = {}) => ({
  text: "你好", messageId: `om_${++seq}`, chatId, chatType: "p2p", messageType: "text", rawContent: "",
  senderOpenId: "ou_other", senderType: "user", mentions: [], ...over,
})
const group = (chatId: string, over: Record<string, unknown> = {}) => ({
  text: "@_user_1 帮我看看", messageId: `om_${++seq}`, chatId, chatType: "group", messageType: "text", rawContent: "",
  senderOpenId: "ou_other", senderType: "user", mentions: [{ key: "@_user_1", id: "ou_bot", name: "bot" }], ...over,
})
const mainDm = (text = "我自己的消息") => dm("oc_main", { text, senderOpenId: "ou_main" })

const queued = () => getQueueMessages()
const flush = () => new Promise((r) => setTimeout(r, 30))
const commandFiles = () => {
  const dir = ensureGlobalCommandsDir(h.dir)
  return fs.readdirSync(dir).filter((f) => f.endsWith(".fcmd")).map((f) => JSON.parse(fs.readFileSync(path.join(dir, f), "utf-8")))
}

beforeAll(() => {
  initFileQueue()
  vi.spyOn(LarkSender.prototype, "startConnection").mockImplementation(async (...args: any[]) => { onMsg = args[3] })
  vi.spyOn(LarkSender.prototype, "sendMessage").mockImplementation(sendMessage as any)
  vi.spyOn(LarkSender.prototype, "replyMessage").mockImplementation(replyMessage as any)
})
afterAll(() => {
  vi.restoreAllMocks()
  fs.rmSync(h.dir, { recursive: true, force: true })
})
beforeEach(() => {
  clearAllQueueMessages()
  sendMessage.mockClear()
  replyMessage.mockClear()
  h.wechatOpts = null
  const cmdDir = ensureGlobalCommandsDir(h.dir)
  for (const f of fs.readdirSync(cmdDir)) fs.rmSync(path.join(cmdDir, f), { force: true })
})
afterEach(() => {
  channels.delete(CH)
  vi.useRealTimers()
})

describe("飞书：默认（其他人私聊、群聊都关）", () => {
  beforeEach(async () => { await startFeishu({ othersDm: false, groupPolicy: "off", allowedGroups: [] }) })

  it("主用户私聊照常入队", async () => {
    onMsg(mainDm())
    await flush()
    expect(queued()).toHaveLength(1)
    expect(sendMessage).not.toHaveBeenCalled()
  })

  it("别人私聊：不入队，回一句固定的话", async () => {
    onMsg(dm("oc_stranger_1"))
    await flush()
    expect(queued()).toHaveLength(0)
    expect(sendMessage).toHaveBeenCalledTimes(1)
    expect(String(sendMessage.mock.calls[0][0])).toContain("没有向你开放")
    // 直接发到对方私聊（第 3 个参数是 chat_id），不是引用回复
    expect(sendMessage.mock.calls[0][1]).toBeUndefined()
    expect(sendMessage.mock.calls[0][2]).toBe("oc_stranger_1")
    expect(replyMessage).not.toHaveBeenCalled()
  })

  it("同一个人 24 小时内只回一次；换个人、过了 24 小时再回", async () => {
    vi.useFakeTimers({ toFake: ["Date"] })
    vi.setSystemTime(new Date("2030-01-01T00:00:00Z"))
    onMsg(dm("oc_stranger_2"))
    await flush()
    onMsg(dm("oc_stranger_2"))
    onMsg(dm("oc_stranger_2"))
    await flush()
    expect(sendMessage).toHaveBeenCalledTimes(1)

    onMsg(dm("oc_stranger_3"))
    await flush()
    expect(sendMessage).toHaveBeenCalledTimes(2)

    vi.setSystemTime(new Date("2030-01-02T01:00:00Z"))
    onMsg(dm("oc_stranger_2"))
    await flush()
    expect(sendMessage).toHaveBeenCalledTimes(3)
    expect(queued()).toHaveLength(0)
  })

  it("机器人发来的私聊：不入队也不回（防两个机器人对话循环）", async () => {
    onMsg(dm("oc_bot_dm", { senderType: "app", senderOpenId: "ou_botfriend" }))
    await flush()
    expect(queued()).toHaveLength(0)
    expect(sendMessage).not.toHaveBeenCalled()
  })

  it("群里 @ 机器人：不入队、静默（不回复）", async () => {
    onMsg(group("oc_group_a"))
    await flush()
    expect(queued()).toHaveLength(0)
    expect(sendMessage).not.toHaveBeenCalled()
    expect(replyMessage).not.toHaveBeenCalled()
  })

  it("群里没 @ 机器人的闲聊：照旧直接忽略", async () => {
    onMsg(group("oc_group_a", { mentions: [], text: "大家好" }))
    await flush()
    expect(queued()).toHaveLength(0)
    expect(sendMessage).not.toHaveBeenCalled()
  })

  it("主用户在未开通的群里发 /group allow：放行到指令队列（不当普通消息入队）", async () => {
    onMsg(group("oc_group_b", { text: "@_user_1 /group allow", senderOpenId: "ou_main" }))
    await flush()
    expect(queued()).toHaveLength(0)
    const cmds = commandFiles()
    expect(cmds).toHaveLength(1)
    expect(cmds[0]).toMatchObject({ command: "/group allow", chatType: "group", senderIsMainUser: true })
    expect(cmds[0].chatId).toBe(`${CH}|oc_group_b`)
  })

  it("别人在未开通的群里发 /group allow：被拦，指令队列里没有", async () => {
    onMsg(group("oc_group_c", { text: "@_user_1 /group allow", senderOpenId: "ou_other" }))
    await flush()
    expect(commandFiles()).toHaveLength(0)
    expect(queued()).toHaveLength(0)
  })

  it("主用户在未开通的群里发别的指令或普通消息：被拦（只放过 /group）", async () => {
    onMsg(group("oc_group_d", { text: "@_user_1 /status", senderOpenId: "ou_main" }))
    onMsg(group("oc_group_d", { text: "@_user_1 帮我写个函数", senderOpenId: "ou_main" }))
    await flush()
    expect(commandFiles()).toHaveLength(0)
    expect(queued()).toHaveLength(0)
  })

  it("私聊里别人发 /group allow：不是群，被拦", async () => {
    onMsg(dm("oc_stranger_4", { text: "/group allow" }))
    await flush()
    expect(commandFiles()).toHaveLength(0)
    expect(queued()).toHaveLength(0)
  })
})

describe("飞书：开放其他人私聊", () => {
  it("别人私聊入队，不再回「未开放」", async () => {
    await startFeishu({ othersDm: true, groupPolicy: "off", allowedGroups: [] })
    onMsg(dm("oc_stranger_5"))
    await flush()
    expect(queued()).toHaveLength(1)
    expect(sendMessage).not.toHaveBeenCalled()
  })

  it("只开私聊不等于开群：群里 @ 仍被拦", async () => {
    await startFeishu({ othersDm: true, groupPolicy: "off", allowedGroups: [] })
    onMsg(group("oc_group_e"))
    await flush()
    expect(queued()).toHaveLength(0)
  })
})

describe("飞书：群聊策略", () => {
  it("所有群：任何群 @ 机器人都入队；其他人私聊仍然关着", async () => {
    await startFeishu({ othersDm: false, groupPolicy: "all", allowedGroups: [] })
    onMsg(group("oc_group_f"))
    onMsg(dm("oc_stranger_6"))
    await flush()
    const q = queued()
    expect(q).toHaveLength(1)
    expect(q[0].sessionKey).toContain("oc_group_f")
  })

  it("仅我开通的群：只有名单里的群能用", async () => {
    await startFeishu({ othersDm: false, groupPolicy: "allowlist", allowedGroups: ["oc_group_ok"] })
    onMsg(group("oc_group_ok"))
    onMsg(group("oc_group_no"))
    await flush()
    const q = queued()
    expect(q).toHaveLength(1)
    expect(q[0].sessionKey).toContain("oc_group_ok")
  })

  it("热更新：设置页改了名单，不用重启 Daemon 立刻生效；撤销同样立刻生效", async () => {
    await startFeishu({ othersDm: false, groupPolicy: "off", allowedGroups: [] })
    onMsg(group("oc_group_hot", { messageId: "om_hot_1" }))
    await flush()
    expect(queued()).toHaveLength(0)

    updateChannelFlags([{ id: CH, groupPolicy: "allowlist", allowedGroups: ["oc_group_hot"] }])
    onMsg(group("oc_group_hot", { messageId: "om_hot_2" }))
    await flush()
    expect(queued()).toHaveLength(1)

    updateChannelFlags([{ id: CH, allowedGroups: [] }])
    onMsg(group("oc_group_hot", { messageId: "om_hot_3" }))
    await flush()
    expect(queued()).toHaveLength(1)
  })

  it("热更新其他人私聊开关", async () => {
    await startFeishu({ othersDm: false, groupPolicy: "off", allowedGroups: [] })
    updateChannelFlags([{ id: CH, othersDm: true }])
    onMsg(dm("oc_stranger_7"))
    await flush()
    expect(queued()).toHaveLength(1)
    updateChannelFlags([{ id: CH, othersDm: false }])
    onMsg(dm("oc_stranger_7"))
    await flush()
    expect(queued()).toHaveLength(1)
  })

  it("主用户本人的群消息：群没开通就不放行（主用户在群里也是「群聊」场景）", async () => {
    await startFeishu({ othersDm: false, groupPolicy: "off", allowedGroups: [] })
    onMsg(group("oc_group_g", { senderOpenId: "ou_main" }))
    await flush()
    expect(queued()).toHaveLength(0)
  })
})

describe("微信（ClawBot）只能自己用", () => {
  async function startWechat(extra: Record<string, unknown> = {}) {
    const rt = makeRt({ mainUserChatId: "wx_main", ...extra }, "wechat")
    rt.lastP2pChatId = "wx_main"
    channels.set(CH, rt)
    initWeChatChannel(rt)
    return rt
  }
  const wx = (chatId: string, text = "hi") => ({ chatId, chatType: "p2p", text, messageId: `wx_${++seq}`, senderOpenId: chatId })

  it("主用户消息入队；别人的消息不入队", async () => {
    await startWechat()
    h.wechatOpts!.onMessage(wx("wx_main", "我的消息"))
    h.wechatOpts!.onMessage(wx("wx_stranger", "陌生人"))
    await flush()
    const q = queued()
    expect(q).toHaveLength(1)
    expect(q[0].sessionKey).toContain("wx_main")
  })

  it("就算配置里留着旧的「允许其他人」，微信也不放行别人", async () => {
    await startWechat({ allowOthers: true, othersDm: true, groupPolicy: "all" })
    h.wechatOpts!.onMessage(wx("wx_stranger2"))
    await flush()
    expect(queued()).toHaveLength(0)
  })
})
