import { beforeEach, describe, expect, it, vi } from "vitest"

/**
 * 通道准入字段的存量迁移：旧配置只有一个总开关 allowOthers，升级后要
 * - true  → 其他人私聊开 + 所有群 + 能力档位「同我」（行为和升级前一模一样，不弹任何提示）；
 * - false → 全关，之后新开放的其他人默认是「访客」；
 * - 微信（ClawBot）和应用内对话没有「其他人」，不管旧配置写了什么都是全关。
 * 真实的 config-store，只把落盘的 electron-store 换成内存版。
 */

let disk: Record<string, unknown> = {}
vi.mock("electron-store", () => ({
  default: class {
    constructor(opts: { defaults?: Record<string, unknown> }) {
      disk = structuredClone(opts.defaults ?? {})
    }
    get store() { return disk }
    set(patch: Record<string, unknown>) { Object.assign(disk, structuredClone(patch)) }
  },
}))
vi.mock("electron", () => ({ safeStorage: { isEncryptionAvailable: () => false } }))

import { getChannel, getChannels, saveConfig, updateChannel, type MessageChannel } from "../electron/config-store"

function legacy(id: string, extra: Record<string, unknown> = {}): MessageChannel {
  return {
    id, name: id, enabled: true, type: "feishu", agentResourceId: "", model: "auto", modelParams: "",
    othersModel: "", othersModelParams: "", mainUserEnabled: false, mainUserChatId: "",
    allowOthers: false, digitalIdentity: "", workspaceDir: "",
    ...extra,
  } as MessageChannel
}

beforeEach(() => {
  saveConfig({ channels: [] })
})

describe("旧配置 allowOthers → 新的准入字段", () => {
  it("飞书 allowOthers=true：私聊开、所有群、同我（升级后行为不变）", () => {
    saveConfig({ channels: [legacy("ch_a", { allowOthers: true })] })
    expect(getChannel("ch_a")).toMatchObject({
      othersDm: true, groupPolicy: "all", allowedGroups: [], visitorTier: "full", visitorMcp: [], visitorSkills: [], allowOthers: true,
    })
  })

  it("飞书 allowOthers=false：全关；以后新开放的其他人默认是访客", () => {
    saveConfig({ channels: [legacy("ch_a", { allowOthers: false })] })
    expect(getChannel("ch_a")).toMatchObject({
      othersDm: false, groupPolicy: "off", visitorTier: "visitor", allowOthers: false,
    })
  })

  it("微信 / 应用内：就算旧配置里 allowOthers=true 也是全关、档位访客（它们没有「其他人」）", () => {
    saveConfig({ channels: [legacy("ch_w", { type: "wechat", allowOthers: true }), legacy("ch_p", { type: "app", allowOthers: true })] })
    for (const id of ["ch_w", "ch_p"]) {
      expect(getChannel(id)).toMatchObject({ othersDm: false, groupPolicy: "off", allowedGroups: [], visitorTier: "visitor", allowOthers: false })
    }
  })

  it("通道上没写 allowOthers 时，沿用全局旧开关", () => {
    const c = legacy("ch_a") as unknown as Record<string, unknown>
    delete c.allowOthers
    saveConfig({ allowOthers: true, channels: [c as unknown as MessageChannel] })
    expect(getChannel("ch_a")).toMatchObject({ othersDm: true, groupPolicy: "all", visitorTier: "full" })
    saveConfig({ allowOthers: false })
  })

  it("已经写了新字段的通道：以新字段为准，不被旧开关盖掉", () => {
    saveConfig({
      channels: [legacy("ch_a", {
        allowOthers: true, othersDm: false, groupPolicy: "allowlist", allowedGroups: [{ chatId: "oc_a", name: "产品群" }],
        visitorTier: "visitor", visitorMcp: ["m1"], visitorSkills: ["s1"],
      })],
    })
    expect(getChannel("ch_a")).toMatchObject({
      othersDm: false, groupPolicy: "allowlist", visitorTier: "visitor", visitorMcp: ["m1"], visitorSkills: ["s1"],
      allowedGroups: [{ chatId: "oc_a", name: "产品群" }],
      allowOthers: true, // 派生值：群聊还开着
    })
  })

  it("allowOthers 保存成派生值：私聊和群聊都关时为 false，任一开着为 true", () => {
    saveConfig({
      channels: [
        legacy("ch_off", { othersDm: false, groupPolicy: "off" }),
        legacy("ch_dm", { othersDm: true, groupPolicy: "off" }),
        legacy("ch_grp", { othersDm: false, groupPolicy: "allowlist" }),
      ],
    })
    expect(getChannel("ch_off")!.allowOthers).toBe(false)
    expect(getChannel("ch_dm")!.allowOthers).toBe(true)
    expect(getChannel("ch_grp")!.allowOthers).toBe(true)
  })

  it("迁移是幂等的：读出来再存回去，再读结果不变", () => {
    saveConfig({ channels: [legacy("ch_a", { allowOthers: true }), legacy("ch_b"), legacy("ch_w", { type: "wechat", allowOthers: true })] })
    const first = getChannels()
    saveConfig({ channels: first })
    expect(getChannels()).toEqual(first)
  })
})

describe("迁移结果在后续修改后不退化", () => {
  it("存量「同我」通道关掉所有其他人再重新打开：档位仍是「同我」（迁移结果已落盘，不会因 allowOthers 变 false 而被重推成访客）", () => {
    saveConfig({ channels: [legacy("ch_a", { allowOthers: true })] })
    // 任一次 updateChannel 都会把当前（已套默认值的）配置整体落盘
    updateChannel("ch_a", { othersDm: false, groupPolicy: "off", allowOthers: false })
    expect(getChannel("ch_a")).toMatchObject({ othersDm: false, groupPolicy: "off", visitorTier: "full" })
    updateChannel("ch_a", { othersDm: true, allowOthers: true })
    expect(getChannel("ch_a")).toMatchObject({ othersDm: true, visitorTier: "full" })
  })

  it("updateChannel 只改群名单：私聊开关、档位原样保留", () => {
    saveConfig({ channels: [legacy("ch_a", { allowOthers: true })] })
    updateChannel("ch_a", { groupPolicy: "allowlist", allowedGroups: [{ chatId: "oc_x" }] })
    expect(getChannel("ch_a")).toMatchObject({ othersDm: true, groupPolicy: "allowlist", visitorTier: "full", allowedGroups: [{ chatId: "oc_x" }] })
  })
})
