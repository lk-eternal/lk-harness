import { afterEach, beforeEach, describe, expect, it } from "vitest"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { makeChatKey } from "../src/shared/channel-types"
import {
  addProjectBinding,
  bindingsFromLegacy,
  canEnterProjectFromChat,
  legacyMirrorOf,
  parseExistingGroupChatBinding,
  projectBindingForChat,
  projectBoundToChannel,
  projectChannelIds,
  projectSessionKey,
  projectSessionKeyFor,
  projectSessionKeyOfChannel,
  projectSessionKeys,
  removeProjectBinding,
  sameChatKey,
  type ProjectBinding,
} from "../src/shared/project-types"
import {
  channelBindingModes,
  parseBindingChoices,
  planBindingChoices,
  projectChannelOptions,
  reachableChannels,
  type BindingChannelFacts,
} from "../src/shared/project-bindings"
import { getProject, initProjectStore, listProjectsForChannel, saveProject } from "../src/shared/project-store"

/**
 * 项目接入点（bindings）：项目按消息通道隔离的核心规则。
 * 守住几件事：旧项目文件迁移时只绑它原来所在的通道；谁看得到（接入了通道）、谁能进（只有接入的聊天）；
 * 建项 / 补接入时调用者能选什么、选得对不对（应用内对话的调用者能接任何通道，飞书 / 微信的只能接自己所在的）；
 * 写盘时带着旧版字段（回退版本还认得），读盘时只认 bindings。
 */

const FS = "ch_fs"
const FS2 = "ch_fs2"
const WX = "ch_wx"
const APP = "ch_app"
const fsChat = (id = "ou_main") => makeChatKey(FS, id)
const GROUP = "oc_aa2192cfececee92d57dccd0b59980fd"

describe("旧项目文件 → bindings：存量只绑它现在所在的通道", () => {
  it("有会话键：绑那个通道的主聊天，会话键原样带着", () => {
    const sk = `${fsChat()}::project_p1`
    expect(bindingsFromLegacy("p1", { sessionKey: sk, notifyChatId: fsChat() })).toEqual([{ kind: "main", channelId: FS, sessionKey: sk }])
  })

  it("只有 notifyChatId（还没进过会话）：绑那个通道的主聊天，没有会话键", () => {
    expect(bindingsFromLegacy("p1", { notifyChatId: makeChatKey(APP, "app_main") })).toEqual([{ kind: "main", channelId: APP }])
  })

  it("老版本飞书会话键没有通道前缀、认不出通道：一个入口都不给（只在设置页看得到，要用再去绑定）", () => {
    expect(bindingsFromLegacy("p1", { sessionKey: "ou_main::project_p1", notifyChatId: "ou_main" })).toEqual([])
    expect(bindingsFromLegacy("p1", {})).toEqual([])
  })

  it("独立群项目：只有这个群（旧语义里私聊进不去），会话键沿用群自己的", () => {
    const groupKey = makeChatKey(FS, GROUP)
    const own = `${groupKey}::project_p1`
    expect(bindingsFromLegacy("p1", { groupChatId: groupKey, notifyChatId: groupKey, sessionKey: own }))
      .toEqual([{ kind: "group", channelId: FS, chatKey: groupKey, sessionKey: own }])
    // 会话键属于别的聊天（比如迁移前停在私聊里）：不拿来当群的，由群号推出来
    expect(bindingsFromLegacy("p1", { groupChatId: groupKey, sessionKey: `${fsChat()}::project_p1` }))
      .toEqual([{ kind: "group", channelId: FS, chatKey: groupKey, sessionKey: own }])
  })

  it("旧的裸群号：靠会话键 / 通知聊天认出通道；认不出就保留群入口（通道记空），群里的消息路由靠它认群", () => {
    expect(bindingsFromLegacy("p1", { groupChatId: GROUP, sessionKey: `${fsChat()}::project_p1` }))
      .toEqual([{ kind: "group", channelId: FS, chatKey: makeChatKey(FS, GROUP), sessionKey: `${makeChatKey(FS, GROUP)}::project_p1` }])
    expect(bindingsFromLegacy("p1", { groupChatId: GROUP, notifyChatId: fsChat() })[0]).toMatchObject({ channelId: FS, chatKey: makeChatKey(FS, GROUP) })
    expect(bindingsFromLegacy("p1", { groupChatId: GROUP }))
      .toEqual([{ kind: "group", channelId: "", chatKey: GROUP, sessionKey: `${GROUP}::project_p1` }])
  })
})

describe("写盘带旧版字段（回退版本还认得）、读盘只认 bindings", () => {
  const groupKey = makeChatKey(FS, GROUP)
  const base = { id: "p1" }

  it("有专属群取专属群；否则取第一个记过会话键的主聊天；都没有就什么也不写", () => {
    expect(legacyMirrorOf({ ...base, bindings: [
      { kind: "main", channelId: APP, sessionKey: `${makeChatKey(APP, "app_main")}::project_p1` },
      { kind: "group", channelId: FS, chatKey: groupKey },
    ] })).toEqual({ groupChatId: groupKey, notifyChatId: groupKey, sessionKey: `${groupKey}::project_p1` })

    expect(legacyMirrorOf({ ...base, bindings: [
      { kind: "main", channelId: WX },
      { kind: "main", channelId: FS, sessionKey: `${fsChat()}::project_p1` },
    ] })).toEqual({ sessionKey: `${fsChat()}::project_p1`, notifyChatId: fsChat() })

    expect(legacyMirrorOf({ ...base, bindings: [{ kind: "main", channelId: FS }] })).toEqual({})
    expect(legacyMirrorOf(base)).toEqual({})
  })

  describe("项目库读写", () => {
    let dir = ""
    const fileOf = (id: string) => path.join(dir, "projects", `${id}.json`)
    const rawOf = (id: string) => JSON.parse(fs.readFileSync(fileOf(id), "utf-8")) as Record<string, unknown>
    beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), "claw-bind-")); initProjectStore(dir) })
    afterEach(() => { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 } as fs.RmOptions) })

    const legacyFile = (over: Record<string, unknown>) => {
      fs.mkdirSync(path.join(dir, "projects"), { recursive: true })
      const obj = {
        id: "aaaabbbbcccc", name: "老项目", goal: "", worktreePath: path.join(dir, "w"), groupId: "general", groupIds: ["general"],
        createdAt: 1, updatedAt: 1, ...over,
      }
      fs.writeFileSync(fileOf(obj.id), JSON.stringify(obj), "utf-8")
      return obj.id
    }

    it("读旧文件：单入口字段迁成 bindings，读出来的项目不再带旧字段", () => {
      const sk = `${fsChat()}::project_aaaabbbbcccc`
      const id = legacyFile({ sessionKey: sk, notifyChatId: fsChat() })
      const p = getProject(id)!
      expect(p.bindings).toEqual([{ kind: "main", channelId: FS, sessionKey: sk }])
      for (const k of ["sessionKey", "notifyChatId", "groupChatId"]) expect(p).not.toHaveProperty(k)
      expect(listProjectsForChannel(FS).map((x) => x.id)).toEqual([id])
      expect(listProjectsForChannel(WX)).toEqual([])
    })

    it("文件里已经有 bindings 就只认 bindings，旧字段被丢掉（不会又迁移一遍）", () => {
      const id = legacyFile({
        bindings: [{ kind: "main", channelId: WX }],
        sessionKey: `${fsChat()}::project_aaaabbbbcccc`, notifyChatId: fsChat(),
      })
      expect(getProject(id)!.bindings).toEqual([{ kind: "main", channelId: WX }])
    })

    it("保存：bindings 照写，同时带上旧版字段；接入点变了，旧版字段跟着变", () => {
      const sk = `${fsChat()}::project_aaaabbbbcccc`
      const id = legacyFile({ sessionKey: sk, notifyChatId: fsChat() })
      const p = getProject(id)!
      saveProject(p)
      expect(rawOf(id)).toMatchObject({ bindings: [{ kind: "main", channelId: FS, sessionKey: sk }], sessionKey: sk, notifyChatId: fsChat() })

      addProjectBinding(p, { kind: "group", channelId: FS, chatKey: makeChatKey(FS, GROUP) })
      saveProject(p)
      expect(rawOf(id)).toMatchObject({ groupChatId: makeChatKey(FS, GROUP), notifyChatId: makeChatKey(FS, GROUP) })
      expect(getProject(id)!.bindings).toHaveLength(2)

      p.bindings = []
      saveProject(p)
      const raw = rawOf(id)
      expect(raw.bindings).toEqual([])
      for (const k of ["sessionKey", "notifyChatId", "groupChatId"]) expect(raw).not.toHaveProperty(k)
      expect(listProjectsForChannel(FS)).toEqual([])
    })

    it("没有任何入口的项目：谁的清单里都没有", () => {
      const id = legacyFile({ sessionKey: "ou_main::project_aaaabbbbcccc" })
      expect(getProject(id)!.bindings).toEqual([])
      for (const c of [FS, WX, APP]) expect(listProjectsForChannel(c)).toEqual([])
      expect(listProjectsForChannel(undefined)).toEqual([])
    })
  })
})

describe("谁看得到、谁能进：只有接入的通道 / 聊天", () => {
  const groupKey = makeChatKey(FS, GROUP)
  const project = {
    id: "p1",
    bindings: [
      { kind: "main", channelId: APP },
      { kind: "main", channelId: FS, sessionKey: `${fsChat()}::project_p1` },
      { kind: "group", channelId: FS, chatKey: groupKey },
    ] as ProjectBinding[],
  }
  const onlyGroup = { id: "p2", bindings: [{ kind: "group", channelId: FS, chatKey: groupKey }] as ProjectBinding[] }

  it("可见：接入了这个通道的任何入口（主聊天或专属群）", () => {
    expect(projectBoundToChannel(project, APP)).toBe(true)
    expect(projectBoundToChannel(project, FS)).toBe(true)
    expect(projectBoundToChannel(project, WX)).toBe(false)
    expect(projectBoundToChannel(project, undefined)).toBe(false)
    expect(projectBoundToChannel(onlyGroup, FS)).toBe(true)
    expect(projectBoundToChannel({ id: "x" }, FS)).toBe(false)
    expect(projectChannelIds(project)).toEqual([APP, FS])
  })

  it("可进：主聊天按通道认（换了主用户也不丢）；专属群按群；没接入的通道、别的群都不行", () => {
    expect(canEnterProjectFromChat(project, fsChat())).toBe(true)
    expect(canEnterProjectFromChat(project, fsChat("ou_new_main"))).toBe(true)
    expect(canEnterProjectFromChat(project, makeChatKey(APP, "app_main"))).toBe(true)
    expect(canEnterProjectFromChat(project, groupKey)).toBe(true)
    expect(canEnterProjectFromChat(project, makeChatKey(WX, "wx_main"))).toBe(false)
    expect(canEnterProjectFromChat(project, undefined)).toBe(false)
    expect(canEnterProjectFromChat(project, "ou_bare_without_channel")).toBe(false)
  })

  it("只接了专属群的项目：看得到，但从主聊天进不去（群项目只能在群里进入）", () => {
    expect(canEnterProjectFromChat(onlyGroup, fsChat())).toBe(false)
    expect(canEnterProjectFromChat(onlyGroup, groupKey)).toBe(true)
    expect(projectBindingForChat(onlyGroup, groupKey)?.kind).toBe("group")
  })

  it("群号在同一租户内通用：两个通道的机器人进了同一个群，不能当成同一个入口；裸群号才退回只比群号", () => {
    expect(sameChatKey(makeChatKey(FS, GROUP), makeChatKey(FS2, GROUP))).toBe(false)
    expect(sameChatKey(makeChatKey(FS, GROUP), makeChatKey(FS, GROUP))).toBe(true)
    expect(sameChatKey(makeChatKey(FS, GROUP), GROUP)).toBe(true)
    expect(canEnterProjectFromChat(onlyGroup, makeChatKey(FS2, GROUP))).toBe(false)
  })

  it("会话键：专属群用群自己的，主聊天一律是「当前聊天键::project_id」；每个入口各一条，互不相同", () => {
    expect(projectSessionKeyFor(project, fsChat())).toBe(`${fsChat()}::project_p1`)
    expect(projectSessionKeyFor(project, fsChat("ou_new_main"))).toBe(`${fsChat("ou_new_main")}::project_p1`)
    expect(projectSessionKeyFor(project, groupKey)).toBe(`${groupKey}::project_p1`)
    expect(projectSessionKeyFor(project, makeChatKey(WX, "wx_main"))).toBeUndefined()
    // 通道上已知的会话键（定时任务投递、清会话用）：记过的主聊天优先，群能推出来；没进过的主聊天没有
    expect(projectSessionKeyOfChannel(project, FS)).toBe(`${fsChat()}::project_p1`)
    expect(projectSessionKeyOfChannel(onlyGroup, FS)).toBe(`${groupKey}::project_p2`)
    expect(projectSessionKeyOfChannel(project, APP)).toBeUndefined()
    expect(projectSessionKeyOfChannel(project, undefined)).toBeUndefined()
    expect(projectSessionKeys(project)).toEqual([`${fsChat()}::project_p1`, `${groupKey}::project_p1`])
    expect(projectSessionKey(groupKey, "p1")).toBe(`${groupKey}::project_p1`)
  })

  it("加入口：同一个入口不重复加（补上会话键）；去掉入口：返回被去掉的那个，没有就 undefined", () => {
    const p: { bindings?: ProjectBinding[] } = {}
    addProjectBinding(p, { kind: "main", channelId: FS })
    addProjectBinding(p, { kind: "main", channelId: FS, sessionKey: "k1" })
    expect(p.bindings).toEqual([{ kind: "main", channelId: FS, sessionKey: "k1" }])
    addProjectBinding(p, { kind: "group", channelId: FS, chatKey: groupKey })
    addProjectBinding(p, { kind: "group", channelId: FS, chatKey: GROUP })
    expect(p.bindings).toHaveLength(2)
    addProjectBinding(p, { kind: "group", channelId: FS2, chatKey: makeChatKey(FS2, GROUP) })
    expect(p.bindings).toHaveLength(3)

    expect(removeProjectBinding(p, { kind: "group", channelId: FS, chatKey: groupKey })?.chatKey).toBe(groupKey)
    expect(removeProjectBinding(p, { kind: "group", channelId: FS, chatKey: groupKey })).toBeUndefined()
    expect(removeProjectBinding(p, { kind: "main", channelId: FS })?.sessionKey).toBe("k1")
    expect(p.bindings?.map((b) => b.channelId)).toEqual([FS2])
  })
})

describe("绑定已有群：群号必须是这个通道的群", () => {
  it("裸群号补上通道前缀；带本通道前缀的原样；带别的通道前缀的拒绝（别的通道的群里的人不能驱动这个项目）", () => {
    expect(parseExistingGroupChatBinding(GROUP, FS)).toEqual({ chatKey: makeChatKey(FS, GROUP), rawChatId: GROUP })
    expect(parseExistingGroupChatBinding(` ${makeChatKey(FS, GROUP)} `, FS)).toEqual({ chatKey: makeChatKey(FS, GROUP), rawChatId: GROUP })
    const other = parseExistingGroupChatBinding(makeChatKey(FS2, GROUP), FS)
    expect("error" in other && other.error).toContain("别的消息通道")
  })

  it("空 / 格式不对 / 没有通道：给原因", () => {
    for (const bad of ["", "  ", "not-a-group", "ou_user", `${FS}|ou_user`]) expect("error" in parseExistingGroupChatBinding(bad, FS), bad).toBe(true)
    expect("error" in parseExistingGroupChatBinding(GROUP, "")).toBe(true)
  })
})

describe("建项 / 补接入时能选什么、选得对不对", () => {
  const ch = (id: string, type: BindingChannelFacts["type"], over: Partial<BindingChannelFacts> = {}): BindingChannelFacts => ({
    id, name: `${id}名`, type, enabled: true, mainUserEnabled: true, mainUserChatId: type === "app" ? "app_main" : "u1", ...over,
  })
  const channels = [
    ch(APP, "app"),
    ch(FS, "feishu", { mainUserOpenId: "ou_open" }),
    ch(FS2, "feishu"),
    ch(WX, "wechat"),
  ]
  const plan = (choices: unknown, invoker?: string, list = channels) => planBindingChoices(choices as never, list, invoker)

  it("各通道能用的方式：应用内只有 inline；微信只有 inline；飞书看有没有主用户、有没有 open_id；bind 飞书永远可以", () => {
    expect(channelBindingModes(channels[0])).toEqual({ modes: ["inline"] })
    expect(channelBindingModes(channels[3])).toMatchObject({ modes: ["inline"], note: expect.stringContaining("微信不能建群") })
    expect(channelBindingModes(channels[1])).toEqual({ modes: ["inline", "group", "bind"] })
    expect(channelBindingModes(channels[2])).toMatchObject({ modes: ["inline", "bind"], note: expect.stringContaining("open_id") })
    expect(channelBindingModes(ch(FS, "feishu", { mainUserChatId: "", mainUserOpenId: "ou" })))
      .toMatchObject({ modes: ["bind"], note: expect.stringContaining("还没绑定主用户") })
    expect(channelBindingModes(ch(FS, "feishu", { mainUserEnabled: false }))).toMatchObject({ modes: ["bind"] })
    expect(channelBindingModes(ch(WX, "wechat", { mainUserChatId: "" }))).toMatchObject({ modes: [], note: expect.stringContaining("还没绑定主用户") })
    expect(channelBindingModes(ch(FS, "feishu", { enabled: false }))).toEqual({ modes: [], note: "这个通道已停用" })
  })

  it("能接到哪些通道：应用内通道的调用者是全部，飞书 / 微信的只有自己所在的；认不出调用者就一个都没有", () => {
    expect(reachableChannels(channels, APP).map((c) => c.id)).toEqual([APP, FS, FS2, WX])
    expect(reachableChannels(channels, FS).map((c) => c.id)).toEqual([FS])
    expect(reachableChannels(channels, WX).map((c) => c.id)).toEqual([WX])
    expect(reachableChannels(channels, "ch_nope")).toEqual([])
    expect(reachableChannels(channels, undefined)).toEqual([])

    const opts = projectChannelOptions(channels, APP)
    expect(opts.map((o) => [o.id, o.current])).toEqual([[APP, true], [FS, false], [FS2, false], [WX, false]])
    expect(opts[1]).toEqual({ id: FS, name: `${FS}名`, type: "feishu", current: false, modes: ["inline", "group", "bind"] })
    expect(projectChannelOptions(channels, FS).map((o) => o.id)).toEqual([FS])
    expect(projectChannelOptions(channels, FS)[0].current).toBe(true)
  })

  it("没有默认值：不给 / 空数组都要报错，让 AI 先看 channels 再去问用户", () => {
    for (const v of [undefined, []]) {
      const r = plan(v, APP)
      expect(r.ok).toBe(false)
      expect(!r.ok && r.error).toContain("channels")
      expect(!r.ok && r.error).toContain("问用户")
    }
  })

  it("应用内对话里的调用者：可以同时接多个通道、各用各的方式", () => {
    const r = plan([
      { channelId: APP, mode: "inline" },
      { channelId: FS, mode: "group" },
      { channelId: FS, mode: "bind", groupChatId: GROUP },
      { channelId: WX, mode: "inline" },
    ], APP)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.items.map((i) => [i.channel.id, i.mode])).toEqual([[APP, "inline"], [FS, "group"], [FS, "bind"], [WX, "inline"]])
    expect(r.items[2]).toMatchObject({ groupChatKey: makeChatKey(FS, GROUP), groupRawChatId: GROUP })
  })

  it("飞书 / 微信里的调用者：只能接自己所在的通道，哪怕混着选一个别的也整体拒绝（集中部署时通道之间不互通）", () => {
    expect(plan([{ channelId: FS, mode: "inline" }], FS).ok).toBe(true)
    for (const [invoker, other] of [[FS, APP], [FS, FS2], [FS, WX], [WX, FS], [WX, APP]]) {
      const r = plan([{ channelId: other, mode: "inline" }], invoker)
      expect(r.ok, `${invoker} → ${other}`).toBe(false)
      expect(!r.ok && r.error).toContain("只能接入自己所在的通道")
    }
    expect(plan([{ channelId: FS, mode: "inline" }, { channelId: APP, mode: "inline" }], FS).ok).toBe(false)
    const unknown = plan([{ channelId: "ch_nope", mode: "inline" }], APP)
    expect(!unknown.ok && unknown.error).toContain("找不到通道")
    expect(plan([{ channelId: FS, mode: "inline" }], undefined).ok).toBe(false)
  })

  it("通道不支持的方式：给出原因（微信不能建群、没有 open_id 不能建群、没绑主用户不能接主聊天、停用的通道什么都不行）", () => {
    const deny = (choices: unknown, invoker: string, hint: string, list = channels) => {
      const r = plan(choices, invoker, list)
      expect(r.ok, hint).toBe(false)
      expect(!r.ok && r.error, hint).toContain(hint)
    }
    deny([{ channelId: APP, mode: "group" }], APP, "不能用 group")
    deny([{ channelId: WX, mode: "bind", groupChatId: GROUP }], WX, "微信不能建群")
    deny([{ channelId: FS2, mode: "group" }], FS2, "open_id")
    deny([{ channelId: FS, mode: "inline" }], APP, "还没绑定主用户", [channels[0], ch(FS, "feishu", { mainUserChatId: "" })])
    deny([{ channelId: FS, mode: "inline" }], APP, "已停用", [channels[0], ch(FS, "feishu", { enabled: false })])
  })

  it("写错的参数：mode 不认识 / 缺 channel_id / 缺群号 / 群号不对 / 同一项选重了", () => {
    const deny = (choices: unknown, hint: string) => {
      const r = plan(choices, APP)
      expect(r.ok, hint).toBe(false)
      expect(!r.ok && r.error, hint).toContain(hint)
    }
    deny([{ channelId: FS, mode: "dedicated" }], "inline / group / bind")
    deny([{ channelId: FS, mode: "" }], "inline / group / bind")
    deny([{ channelId: "", mode: "inline" }], "channel_id")
    deny([{ channelId: FS, mode: "bind" }], "chat_id")
    deny([{ channelId: FS, mode: "bind", groupChatId: "not-a-group" }], "chat_id")
    deny([{ channelId: FS, mode: "bind", groupChatId: makeChatKey(FS2, GROUP) }], "别的消息通道")
    deny([{ channelId: FS, mode: "inline" }, { channelId: FS, mode: "inline" }], "选重了")
    deny([{ channelId: FS, mode: "bind", groupChatId: GROUP }, { channelId: FS, mode: "bind", groupChatId: GROUP }], "选重了")
    // 同一通道绑两个不同的群不算重
    expect(plan([{ channelId: FS, mode: "bind", groupChatId: GROUP }, { channelId: FS, mode: "bind", groupChatId: "oc_bbbb" }], APP).ok).toBe(true)
  })

  it("parseBindingChoices：宿主请求里的接入点只认字符串字段，不判断对错（错的交给 planBindingChoices 带原因报）", () => {
    expect(parseBindingChoices([
      { channelId: " ch_fs ", mode: "bind", groupChatId: ` ${GROUP} ` },
      { channelId: 5, mode: 7, groupChatId: {} },
      null,
      "x",
    ])).toEqual([
      { channelId: "ch_fs", mode: "bind", groupChatId: GROUP },
      { channelId: "", mode: "" },
    ])
    expect(parseBindingChoices(undefined)).toEqual([])
    expect(parseBindingChoices("inline")).toEqual([])
  })
})
