import { describe, expect, it, vi } from "vitest"
import {
  describeAppChannelIssue,
  ensureAppChannel,
  planAppChannel,
  type EnsureAppChannelIO,
} from "../src/shared/app-channel-ensure"
import { APP_CHANNEL_CHAT_ID, CHANNEL_TYPE_LABELS, type MessageChannel } from "../src/shared/channel-types"
import { emptyChannel } from "../src/renderer/channel-defaults"

const channel = (id: string, type: MessageChannel["type"], enabled = true): MessageChannel => ({ ...emptyChannel(type, id), id, enabled })

/** 内存里的通道存储：load 读最新的，save 整体覆盖，并记录写了几次 */
function fakeIO(initial: MessageChannel[], opts: { saveError?: Error; loadError?: Error } = {}) {
  let stored = initial
  const save = vi.fn(async (next: MessageChannel[]) => {
    if (opts.saveError) throw opts.saveError
    stored = next
  })
  const io: EnsureAppChannelIO = {
    loadChannels: async () => {
      if (opts.loadError) throw opts.loadError
      return stored
    },
    saveChannels: save,
    newChannel: () => channel("ch_new", "app"),
  }
  return { io, save, get stored() { return stored } }
}

describe("planAppChannel：对话页要不要建应用内通道", () => {
  it("一个通道都没有：建", () => {
    expect(planAppChannel(undefined)).toEqual({ action: "create" })
    expect(planAppChannel([])).toEqual({ action: "create" })
  })

  it("只有飞书 / 微信：照样建（它们进不了对话页）", () => {
    expect(planAppChannel([channel("a", "feishu"), channel("b", "wechat")])).toEqual({ action: "create" })
  })

  it("有启用的应用内通道：不建", () => {
    expect(planAppChannel([channel("a", "app")])).toEqual({ action: "ready" })
    expect(planAppChannel([channel("a", "feishu"), channel("b", "app")])).toEqual({ action: "ready" })
  })

  it("enabled 字段缺省按启用算，和对话页取通道的口径一致", () => {
    const legacy = { id: "a", type: "app" } as MessageChannel
    expect(planAppChannel([legacy])).toEqual({ action: "ready" })
  })

  it("应用内通道被用户停用：不建也不替他打开，只报停用", () => {
    expect(planAppChannel([channel("a", "app", false)])).toEqual({ action: "disabled", channelId: "a" })
  })

  it("一个停用、一个启用：能用，不算停用", () => {
    expect(planAppChannel([channel("a", "app", false), channel("b", "app")])).toEqual({ action: "ready" })
  })
})

describe("ensureAppChannel", () => {
  it("没有应用内通道：建好并写回，新通道追加在最后，已有通道原样保留", async () => {
    const feishu = { ...channel("ch_feishu", "feishu"), larkAppId: "cli_x", larkAppSecret: "secret" }
    const s = fakeIO([feishu])

    const r = await ensureAppChannel(s.io)

    expect(r).toEqual({ status: "created", channelId: "ch_new" })
    expect(s.save).toHaveBeenCalledTimes(1)
    expect(s.stored.map((c) => c.id)).toEqual(["ch_feishu", "ch_new"])
    expect(s.stored[0]).toBe(feishu)
  })

  it("一个通道都没有也能建", async () => {
    const s = fakeIO([])
    expect(await ensureAppChannel(s.io)).toEqual({ status: "created", channelId: "ch_new" })
    expect(s.stored).toHaveLength(1)
  })

  it("已经有应用内通道：什么都不写", async () => {
    const s = fakeIO([channel("a", "app")])
    expect(await ensureAppChannel(s.io)).toEqual({ status: "ready" })
    expect(s.save).not.toHaveBeenCalled()
  })

  it("应用内通道被停用：什么都不写，报停用", async () => {
    const s = fakeIO([channel("a", "app", false)])
    expect(await ensureAppChannel(s.io)).toEqual({ status: "disabled" })
    expect(s.save).not.toHaveBeenCalled()
    expect(s.stored[0].enabled).toBe(false)
  })

  it("连着调两次：第二次看到已经建好了，不会重复建", async () => {
    const s = fakeIO([])
    await ensureAppChannel(s.io)
    expect(await ensureAppChannel(s.io)).toEqual({ status: "ready" })
    expect(s.save).toHaveBeenCalledTimes(1)
    expect(s.stored).toHaveLength(1)
  })

  it("保存失败：不抛错，返回失败原因", async () => {
    const s = fakeIO([], { saveError: new Error("磁盘已满") })
    expect(await ensureAppChannel(s.io)).toEqual({ status: "failed", error: "磁盘已满" })
  })

  it("读配置失败：不抛错，也不写", async () => {
    const s = fakeIO([], { loadError: new Error("读不到配置") })
    expect(await ensureAppChannel(s.io)).toEqual({ status: "failed", error: "读不到配置" })
    expect(s.save).not.toHaveBeenCalled()
  })

  it("抛出的不是 Error 也能给出文字原因", async () => {
    const io: EnsureAppChannelIO = {
      loadChannels: async () => { throw "boom" },
      saveChannels: async () => undefined,
      newChannel: () => channel("x", "app"),
    }
    expect(await ensureAppChannel(io)).toEqual({ status: "failed", error: "boom" })
  })
})

describe("自动建出来的通道（对话页用的 emptyChannel('app')）", () => {
  const created = emptyChannel("app", CHANNEL_TYPE_LABELS.app)

  it("启用，名字叫「应用内对话」，id 是 ch_ 开头的新 id", () => {
    expect(created.enabled).toBe(true)
    expect(created.type).toBe("app")
    expect(created.name).toBe("应用内对话")
    expect(created.id).toMatch(/^ch_[0-9a-f]{8}$/)
    expect(emptyChannel("app", "x").id).not.toBe(created.id)
  })

  it("固定绑定本机主用户：建完就能聊，不用走绑定", () => {
    expect(created.mainUserEnabled).toBe(true)
    expect(created.mainUserChatId).toBe(APP_CHANNEL_CHAT_ID)
  })

  it("供应商留空，跟随默认供应商", () => {
    expect(created.agentResourceId).toBe("")
  })

  it("建出来之后 planAppChannel 认它是可用的", () => {
    expect(planAppChannel([created])).toEqual({ action: "ready" })
  })
})

describe("describeAppChannelIssue：对话页没有可用通道时的提示", () => {
  it("停用：说是停用，按钮写「去设置里启用」", () => {
    expect(describeAppChannelIssue({ kind: "disabled" })).toEqual({
      message: "「应用内对话」通道已停用",
      settingsLabel: "去设置里启用",
    })
  })

  it("创建失败：带上原因，并说明会自动重试", () => {
    const d = describeAppChannelIssue({ kind: "failed", error: "磁盘已满" })
    expect(d.message).toContain("磁盘已满")
    expect(d.message).toContain("自动重试")
    expect(d.settingsLabel).toBe("去设置里添加")
  })

  it("没有原因（读取还没完成等）：沿用「还没有通道」", () => {
    expect(describeAppChannelIssue(null)).toEqual({
      message: "还没有「应用内对话」通道",
      settingsLabel: "去设置里添加",
    })
  })
})
