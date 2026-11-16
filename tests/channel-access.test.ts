import { describe, expect, it } from "vitest"
import {
  DENY_NOTICE_WINDOW_MS,
  admitChat,
  allowGroupPatch,
  anyOthersEnabled,
  channelScenes,
  denyGroupPatch,
  hasOthersScenes,
  resolveChannelAccess,
  sameChannelAccess,
  shouldSendDenyNotice,
} from "../src/shared/channel-access"
import { resolveChannelScene } from "../src/shared/channel-types"
import { admitInboundMessage, isGroupAdminCommand } from "../src/daemon.js"

const feishu = (extra: Record<string, unknown> = {}) => ({ type: "feishu" as const, ...extra })

describe("场景由通道类型决定", () => {
  it("飞书：我 / 其他人私聊 / 群聊；微信（ClawBot）和应用内：只有我", () => {
    expect(channelScenes("feishu")).toEqual(["main", "dm", "group"])
    expect(channelScenes("wechat")).toEqual(["main"])
    expect(channelScenes("app")).toEqual(["main"])
    expect(hasOthersScenes("feishu")).toBe(true)
    expect(hasOthersScenes("wechat")).toBe(false)
    expect(hasOthersScenes("app")).toBe(false)
  })
})

describe("resolveChannelAccess：新字段优先，缺省按旧 allowOthers 推", () => {
  it("全新通道：全关", () => {
    expect(resolveChannelAccess(feishu())).toEqual({ dm: false, groupPolicy: "off", groups: [] })
  })

  it("旧配置 allowOthers=true：私聊开 + 所有群（升级后行为不变）", () => {
    expect(resolveChannelAccess(feishu({ allowOthers: true }))).toEqual({ dm: true, groupPolicy: "all", groups: [] })
  })

  it("旧配置 allowOthers=false：全关", () => {
    expect(resolveChannelAccess(feishu({ allowOthers: false }))).toMatchObject({ dm: false, groupPolicy: "off" })
  })

  it("新字段一旦写了就以新字段为准，旧开关不再起作用", () => {
    const r = resolveChannelAccess(feishu({ allowOthers: true, othersDm: true, groupPolicy: "off" }))
    expect(r).toMatchObject({ dm: true, groupPolicy: "off" })
    expect(resolveChannelAccess(feishu({ allowOthers: true, othersDm: false, groupPolicy: "allowlist" })))
      .toMatchObject({ dm: false, groupPolicy: "allowlist" })
  })

  it("群名单去重、去空白，接受对象和字符串两种写法", () => {
    const r = resolveChannelAccess(feishu({ groupPolicy: "allowlist", allowedGroups: [" oc_a ", { chatId: "oc_a" }, { chatId: "oc_b" }, "", "  "] }))
    expect(r.groups).toEqual(["oc_a", "oc_b"])
  })

  it("非法的策略值当作没写", () => {
    expect(resolveChannelAccess(feishu({ groupPolicy: "bogus" as never })).groupPolicy).toBe("off")
  })

  it("微信、应用内：配置里写了什么都是全关", () => {
    for (const type of ["wechat", "app"] as const) {
      expect(resolveChannelAccess({ type, allowOthers: true, othersDm: true, groupPolicy: "all", allowedGroups: ["oc_a"] }))
        .toEqual({ dm: false, groupPolicy: "off", groups: [] })
    }
  })

  it("anyOthersEnabled：私聊或群聊任一开着", () => {
    expect(anyOthersEnabled(feishu())).toBe(false)
    expect(anyOthersEnabled(feishu({ othersDm: true }))).toBe(true)
    expect(anyOthersEnabled(feishu({ groupPolicy: "allowlist" }))).toBe(true)
    expect(anyOthersEnabled({ type: "wechat", allowOthers: true })).toBe(false)
  })
})

describe("admitChat：谁能进", () => {
  it("「我」永远放行，哪怕什么都没开", () => {
    expect(admitChat(feishu(), "main")).toEqual({ ok: true })
    expect(admitChat(undefined, "main")).toEqual({ ok: true })
  })

  it("其他人私聊：只看私聊开关，和群聊策略无关", () => {
    expect(admitChat(feishu(), "dm")).toEqual({ ok: false, reason: "dm-off" })
    expect(admitChat(feishu({ othersDm: true }), "dm")).toEqual({ ok: true })
    expect(admitChat(feishu({ groupPolicy: "all" }), "dm")).toEqual({ ok: false, reason: "dm-off" })
  })

  it("群聊：不允许 / 所有群 / 仅名单里的群；和私聊开关无关", () => {
    expect(admitChat(feishu(), "group", "oc_a")).toEqual({ ok: false, reason: "group-off" })
    expect(admitChat(feishu({ othersDm: true }), "group", "oc_a")).toEqual({ ok: false, reason: "group-off" })
    expect(admitChat(feishu({ groupPolicy: "all" }), "group", "oc_a")).toEqual({ ok: true })
    const al = feishu({ groupPolicy: "allowlist", allowedGroups: [{ chatId: "oc_a" }] })
    expect(admitChat(al, "group", "oc_a")).toEqual({ ok: true })
    expect(admitChat(al, "group", "oc_b")).toEqual({ ok: false, reason: "group-not-allowed" })
    expect(admitChat(al, "group", undefined)).toEqual({ ok: false, reason: "group-not-allowed" })
  })

  it("项目专属群算「我」的：群聊策略关着也放行", () => {
    expect(admitChat(feishu(), "group", "oc_a", { ownedGroup: true })).toEqual({ ok: true })
    // 但它不能让陌生私聊溜进来
    expect(admitChat(feishu(), "dm", "oc_a", { ownedGroup: true })).toEqual({ ok: false, reason: "dm-off" })
  })

  it("微信、应用内没有「其他人」场景：一律拒绝", () => {
    expect(admitChat({ type: "wechat", allowOthers: true }, "dm")).toEqual({ ok: false, reason: "unsupported" })
    expect(admitChat({ type: "app", groupPolicy: "all" }, "group", "oc_a")).toEqual({ ok: false, reason: "unsupported" })
    expect(admitChat(undefined, "dm")).toEqual({ ok: false, reason: "unsupported" })
  })
})

describe("/group allow：开通一个群", () => {
  it("策略是「不允许」：改成「仅我开通的群」并记下这个群（含名字和时间）", () => {
    const { patch, alreadyAdmitted, policyChanged } = allowGroupPatch(feishu(), "oc_a", "产品群", 1000)
    expect(patch.groupPolicy).toBe("allowlist")
    expect(patch.allowedGroups).toEqual([{ chatId: "oc_a", name: "产品群", addedAt: 1000 }])
    expect(alreadyAdmitted).toBe(false)
    expect(policyChanged).toBe(true)
  })

  it("已经在名单里：不重复添加，只更新群名", () => {
    const c = feishu({ groupPolicy: "allowlist", allowedGroups: [{ chatId: "oc_a", name: "旧名", addedAt: 1 }] })
    const { patch, alreadyAdmitted, policyChanged } = allowGroupPatch(c, "oc_a", "新名", 2000)
    expect(patch.allowedGroups).toEqual([{ chatId: "oc_a", name: "新名", addedAt: 1 }])
    expect(alreadyAdmitted).toBe(true)
    expect(policyChanged).toBe(false)
  })

  it("策略是「所有群」：本来就能用，策略不变，仍记进名单", () => {
    const { patch, alreadyAdmitted, policyChanged } = allowGroupPatch(feishu({ groupPolicy: "all" }), "oc_a", undefined, 5)
    expect(patch.groupPolicy).toBe("all")
    expect(patch.allowedGroups).toEqual([{ chatId: "oc_a", addedAt: 5 }])
    expect(alreadyAdmitted).toBe(true)
    expect(policyChanged).toBe(false)
  })

  it("开通后确实放行；其他群仍然不行", () => {
    const { patch } = allowGroupPatch(feishu(), "oc_a")
    const next = { ...feishu(), ...patch }
    expect(admitChat(next, "group", "oc_a")).toEqual({ ok: true })
    expect(admitChat(next, "group", "oc_b")).toMatchObject({ ok: false })
  })
})

describe("/group deny：关闭一个群", () => {
  const listed = feishu({ groupPolicy: "allowlist", allowedGroups: [{ chatId: "oc_a" }, { chatId: "oc_b" }] })

  it("从名单里去掉，其余不动", () => {
    const r = denyGroupPatch(listed, "oc_a")
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.patch.allowedGroups).toEqual([{ chatId: "oc_b" }])
      expect(r.patch.groupPolicy).toBe("allowlist")
    }
  })

  it("策略是「所有群」：没法单独关一个", () => {
    expect(denyGroupPatch(feishu({ groupPolicy: "all" }), "oc_a")).toEqual({ ok: false, reason: "policy-all" })
  })

  it("不在名单里：没什么可关", () => {
    expect(denyGroupPatch(listed, "oc_zzz")).toEqual({ ok: false, reason: "not-listed" })
  })
})

describe("sameChannelAccess：设置保存时判断准入有没有变", () => {
  it("名单顺序不算变；多一个群 / 改策略 / 改私聊开关都算变", () => {
    const a = feishu({ othersDm: true, groupPolicy: "allowlist", allowedGroups: ["oc_a", "oc_b"] })
    expect(sameChannelAccess(a, feishu({ othersDm: true, groupPolicy: "allowlist", allowedGroups: ["oc_b", "oc_a"] }))).toBe(true)
    expect(sameChannelAccess(a, feishu({ othersDm: true, groupPolicy: "allowlist", allowedGroups: ["oc_a"] }))).toBe(false)
    expect(sameChannelAccess(a, feishu({ othersDm: true, groupPolicy: "all" }))).toBe(false)
    expect(sameChannelAccess(a, feishu({ othersDm: false, groupPolicy: "allowlist", allowedGroups: ["oc_a", "oc_b"] }))).toBe(false)
  })

  it("旧开关和对应的新字段等价", () => {
    expect(sameChannelAccess(feishu({ allowOthers: true }), feishu({ othersDm: true, groupPolicy: "all" }))).toBe(true)
    expect(sameChannelAccess(feishu({ allowOthers: false }), feishu())).toBe(true)
  })
})

describe("shouldSendDenyNotice：被拒的人 24 小时只回一次", () => {
  it("窗口内同一个 key 不再回；换 key 照回；过了窗口再回", () => {
    const sent = new Map<string, number>()
    expect(shouldSendDenyNotice(sent, "ch|oc_a", 1000)).toBe(true)
    expect(shouldSendDenyNotice(sent, "ch|oc_a", 1000 + DENY_NOTICE_WINDOW_MS - 1)).toBe(false)
    expect(shouldSendDenyNotice(sent, "ch|oc_b", 1000)).toBe(true)
    expect(shouldSendDenyNotice(sent, "ch|oc_a", 1000 + DENY_NOTICE_WINDOW_MS)).toBe(true)
  })

  it("被拒绝的那一刻不会重置窗口（一直发消息也不会让「24 小时」越拖越长）", () => {
    const sent = new Map<string, number>()
    shouldSendDenyNotice(sent, "k", 0)
    for (let t = 1000; t < DENY_NOTICE_WINDOW_MS; t += 3_600_000) shouldSendDenyNotice(sent, "k", t)
    expect(shouldSendDenyNotice(sent, "k", DENY_NOTICE_WINDOW_MS)).toBe(true)
  })

  it("表很大时顺带清掉过期项，不会一直涨", () => {
    const sent = new Map<string, number>()
    for (let i = 0; i < 600; i++) sent.set(`old_${i}`, 0)
    shouldSendDenyNotice(sent, "fresh", DENY_NOTICE_WINDOW_MS + 1)
    expect(sent.size).toBe(1)
  })
})

describe("resolveChannelScene", () => {
  const main = { mainUserEnabled: true, mainUserChatId: "oc_main" }
  it("主用户私聊 = main；别人私聊 = dm；群 = group；类型未知 = undefined", () => {
    expect(resolveChannelScene({ ...main, sessionKey: "ch_a|oc_main::D:\\ws", chatType: "p2p" })).toBe("main")
    expect(resolveChannelScene({ ...main, sessionKey: "ch_a|oc_x::D:\\ws", chatType: "p2p" })).toBe("dm")
    expect(resolveChannelScene({ ...main, sessionKey: "ch_a|oc_g", chatType: "group" })).toBe("group")
    expect(resolveChannelScene({ ...main, sessionKey: "ch_a|oc_x", chatType: undefined })).toBeUndefined()
  })
})

describe("daemon：admitInboundMessage（入站场景判断）", () => {
  const cfg = (extra: Record<string, unknown> = {}) => ({
    id: "ch_a", name: "A", type: "feishu", mainUserEnabled: true, mainUserChatId: "oc_main", ...extra,
  }) as never

  it("绑定的主用户私聊永远放行；其余私聊看开关", () => {
    expect(admitInboundMessage(cfg(), "p2p", "oc_main", false)).toEqual({ ok: true })
    expect(admitInboundMessage(cfg(), "p2p", "oc_x", false)).toEqual({ ok: false, reason: "dm-off" })
    expect(admitInboundMessage(cfg({ othersDm: true }), "p2p", "oc_x", false)).toEqual({ ok: true })
  })

  it("主用户没启用 / 没绑定时，谁的私聊都算「其他人」", () => {
    expect(admitInboundMessage(cfg({ mainUserEnabled: false }), "p2p", "oc_main", false)).toMatchObject({ ok: false })
    expect(admitInboundMessage(cfg({ mainUserChatId: "" }), "p2p", "", false)).toMatchObject({ ok: false })
  })

  it("非私聊一律按群聊处理（含话题群 topic_group）；项目专属群放行", () => {
    expect(admitInboundMessage(cfg(), "group", "oc_g", false)).toEqual({ ok: false, reason: "group-off" })
    expect(admitInboundMessage(cfg(), "topic_group", "oc_g", false)).toEqual({ ok: false, reason: "group-off" })
    expect(admitInboundMessage(cfg(), undefined, "oc_g", false)).toEqual({ ok: false, reason: "group-off" })
    expect(admitInboundMessage(cfg(), "group", "oc_g", true)).toEqual({ ok: true })
  })

  it("微信：主用户放行，别人（含旧配置里的「允许其他人」）拒绝", () => {
    const wx = (extra: Record<string, unknown> = {}) => cfg({ type: "wechat", mainUserChatId: "wx_main", ...extra })
    expect(admitInboundMessage(wx(), "p2p", "wx_main", false)).toEqual({ ok: true })
    expect(admitInboundMessage(wx({ allowOthers: true, othersDm: true }), "p2p", "wx_x", false)).toEqual({ ok: false, reason: "unsupported" })
  })
})

describe("isGroupAdminCommand", () => {
  it.each([
    ["/group", true],
    ["/group allow", true],
    ["  /GROUP deny ", true],
    ["/group\tls", true],
    ["/groups", false],
    ["/groupie allow", false],
    ["请 /group allow", false],
    ["", false],
  ])("%j → %s", (text, expected) => {
    expect(isGroupAdminCommand(text)).toBe(expected)
  })
})
