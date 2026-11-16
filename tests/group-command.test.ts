import { describe, expect, it, vi } from "vitest"
import { describeGroupAccess, runGroupCommand, type GroupCommandDeps } from "../electron/group-command"
import { admitChat } from "../src/shared/channel-access"
import type { MessageChannel } from "../src/shared/channel-types"

function channel(extra: Partial<MessageChannel> = {}): MessageChannel {
  return {
    id: "ch_a", name: "飞书", enabled: true, type: "feishu", agentResourceId: "", model: "auto", modelParams: "",
    othersModel: "", othersModelParams: "", mainUserEnabled: true, mainUserChatId: "oc_main",
    allowOthers: false, digitalIdentity: "", workspaceDir: "",
    ...extra,
  }
}

/** 假的依赖：通道存内存里，updateChannel 真的合并，onChanged 记调用 */
function setup(initial: Partial<MessageChannel> = {}, opts: { projectGroups?: string[]; names?: Record<string, string> } = {}) {
  const store = { ch: channel(initial) }
  const onChanged = vi.fn(async (_id: string) => {})
  const deps: GroupCommandDeps = {
    getChannel: (id) => (id === store.ch.id ? structuredClone(store.ch) : undefined),
    updateChannel: (_id, patch) => { store.ch = { ...store.ch, ...patch } },
    lookupChatName: (key) => opts.names?.[key],
    isProjectGroup: (key) => (opts.projectGroups ?? []).includes(key),
    onChanged,
  }
  const run = (text: string, over: { chatId?: string; chatType?: string; allowed?: boolean } = {}) =>
    runGroupCommand({
      tokens: text.split(/\s+/),
      chatId: over.chatId ?? "ch_a|oc_group1",
      chatType: over.chatType ?? "group",
      allowed: over.allowed ?? true,
    }, deps)
  return { store, onChanged, run }
}

describe("/group allow", () => {
  it("在群里开通：策略从「不允许」变成「仅我开通的群」，这个群立刻能用，其他群不行", async () => {
    const { store, run, onChanged } = setup({}, { names: { "ch_a|oc_group1": "产品讨论" } })
    const r = await run("/group allow")
    expect(r.ok).toBe(true)
    expect(r.text).toContain("已开通本群")
    expect(store.ch.groupPolicy).toBe("allowlist")
    expect(store.ch.allowedGroups).toMatchObject([{ chatId: "oc_group1", name: "产品讨论" }])
    expect(admitChat(store.ch, "group", "oc_group1")).toEqual({ ok: true })
    expect(admitChat(store.ch, "group", "oc_other")).toMatchObject({ ok: false })
    expect(onChanged).toHaveBeenCalledWith("ch_a")
  })

  it("allowOthers 这个派生值跟着变（降级回旧版本时大致可用）", async () => {
    const { store, run } = setup()
    expect(store.ch.allowOthers).toBe(false)
    await run("/group allow")
    expect(store.ch.allowOthers).toBe(true)
  })

  it("重复开通：提示已经可以用，名单里不会有两条", async () => {
    const { store, run } = setup()
    await run("/group allow")
    const r = await run("/group allow")
    expect(r.ok).toBe(true)
    expect(r.text).toContain("已经可以使用")
    expect(store.ch.allowedGroups).toHaveLength(1)
  })

  it("不动私聊开关", async () => {
    const { store, run } = setup({ othersDm: true })
    await run("/group allow")
    expect(store.ch.othersDm).toBe(true)
    const s2 = setup({ othersDm: false })
    await s2.run("/group allow")
    expect(s2.store.ch.othersDm).toBe(false)
  })

  it("在私聊里发：要求去群里发，不改任何配置", async () => {
    const { store, run, onChanged } = setup()
    const r = await run("/group allow", { chatId: "ch_a|oc_main", chatType: "p2p" })
    expect(r.ok).toBe(false)
    expect(r.text).toContain("请在要开通的群里发送")
    expect(store.ch.allowedGroups).toBeUndefined()
    expect(onChanged).not.toHaveBeenCalled()
  })

  it("项目专属群：本来就能用，不进名单", async () => {
    const { store, run } = setup({}, { projectGroups: ["ch_a|oc_group1"] })
    const r = await run("/group allow")
    expect(r.ok).toBe(true)
    expect(r.text).toContain("项目专属群")
    expect(store.ch.allowedGroups).toBeUndefined()
  })
})

describe("/group deny", () => {
  it("关掉已开通的群，通知调用方清理会话", async () => {
    const { store, run, onChanged } = setup({ groupPolicy: "allowlist", allowedGroups: [{ chatId: "oc_group1" }, { chatId: "oc_group2" }] })
    const r = await run("/group deny")
    expect(r.ok).toBe(true)
    expect(store.ch.allowedGroups).toEqual([{ chatId: "oc_group2" }])
    expect(admitChat(store.ch, "group", "oc_group1")).toMatchObject({ ok: false })
    expect(admitChat(store.ch, "group", "oc_group2")).toEqual({ ok: true })
    expect(onChanged).toHaveBeenCalledTimes(1)
  })

  it("策略是「所有群」：说明没法单独关，并指路到设置", async () => {
    const { store, run, onChanged } = setup({ groupPolicy: "all" })
    const r = await run("/group deny")
    expect(r.ok).toBe(false)
    expect(r.text).toContain("所有群")
    expect(r.text).toContain("设置")
    expect(store.ch.groupPolicy).toBe("all")
    expect(onChanged).not.toHaveBeenCalled()
  })

  it("本来就没开通：提示，不改配置", async () => {
    const { run, onChanged } = setup({ groupPolicy: "allowlist", allowedGroups: [{ chatId: "oc_other" }] })
    const r = await run("/group deny")
    expect(r.ok).toBe(false)
    expect(r.text).toContain("本来就没有开通")
    expect(onChanged).not.toHaveBeenCalled()
  })
})

describe("/group ls 与 /group", () => {
  it("ls：列出策略、私聊开关和已开通的群（优先用名单里记的名字，其次查到的名字，最后缩写 ID）", async () => {
    const { run } = setup({
      groupPolicy: "allowlist", othersDm: true,
      allowedGroups: [{ chatId: "oc_g1", name: "产品群" }, { chatId: "oc_g2" }, { chatId: "oc_abcdefghijklmnop" }],
    }, { names: { "ch_a|oc_g2": "研发群" } })
    const r = await run("/group ls", { chatId: "ch_a|oc_main", chatType: "p2p" })
    expect(r.ok).toBe(true)
    expect(r.text).toContain("仅我开通的群")
    expect(r.text).toContain("其他人私聊：开放")
    expect(r.text).toContain("1. 产品群")
    expect(r.text).toContain("2. 研发群")
    expect(r.text).toMatch(/3\. oc_abcdefg…mnop/)
  })

  it("什么都没开时给出怎么开", async () => {
    const { run } = setup()
    const r = await run("/group ls", { chatId: "ch_a|oc_main", chatType: "p2p" })
    expect(r.text).toContain("不允许")
    expect(r.text).toContain("/group allow")
  })

  it("在群里单发 /group：先说本群状态，再附配置概况和用法", async () => {
    const closed = await setup().run("/group")
    expect(closed.text).toContain("本群未开通")
    expect(closed.text).toContain("用法")
    const opened = await setup({ groupPolicy: "allowlist", allowedGroups: [{ chatId: "oc_group1" }] }).run("/group")
    expect(opened.text).toContain("本群已开通")
    const all = await setup({ groupPolicy: "all" }).run("/group")
    expect(all.text).toContain("本群可以使用")
    const proj = await setup({}, { projectGroups: ["ch_a|oc_group1"] }).run("/group")
    expect(proj.text).toContain("项目专属群")
  })

  it("策略是「所有群」时，名单里残留的群不当作已开通列出，只提示", () => {
    const text = describeGroupAccess(channel({ groupPolicy: "all", allowedGroups: [{ chatId: "oc_x" }] }), () => undefined)
    expect(text).toContain("所有群")
    expect(text).toContain("名单里还留着 1 个群")
    expect(text).not.toContain("1. ")
  })
})

describe("权限与边界", () => {
  it("不是主用户（allowed=false）：拒绝，且什么都不改", async () => {
    const { store, run, onChanged } = setup()
    for (const cmd of ["/group allow", "/group deny", "/group ls", "/group"]) {
      const r = await run(cmd, { allowed: false })
      expect(r.ok).toBe(false)
      expect(r.text).toContain("仅管理员可用")
    }
    expect(store.ch.allowedGroups).toBeUndefined()
    expect(onChanged).not.toHaveBeenCalled()
  })

  it("微信 / 应用内通道：说明没有群聊", async () => {
    for (const type of ["wechat", "app"] as const) {
      const { run } = setup({ type })
      const r = await run("/group allow")
      expect(r.ok).toBe(false)
      expect(r.text).toContain("只能自己使用")
    }
  })

  it("找不到通道 / 不认识的子命令", async () => {
    const { run } = setup()
    expect((await run("/group allow", { chatId: "ch_zzz|oc_g" })).ok).toBe(false)
    const r = await run("/group wat")
    expect(r.ok).toBe(false)
    expect(r.text).toContain("不认识的子命令")
  })
})
