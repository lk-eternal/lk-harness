import { beforeEach, describe, expect, it, vi } from "vitest"

/**
 * getChannel 命中配置缓存时只克隆这一个通道，不再每次克隆整份配置（会话列表每个 tab 要查好几次）。
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

import { getChannel, getChannels, getConfig, saveConfig, type MessageChannel } from "../electron/config-store"

function channel(id: string, extra: Partial<MessageChannel> = {}): MessageChannel {
  return {
    id, name: id, enabled: true, type: "feishu", agentResourceId: "", model: "auto", modelParams: "",
    othersModel: "", othersModelParams: "", mainUserEnabled: false, mainUserChatId: "",
    allowOthers: false, digitalIdentity: "", workspaceDir: "",
    ...extra,
  }
}

beforeEach(() => {
  // 经 saveConfig 重置，getConfig 的缓存才会跟着失效
  saveConfig({ channels: [channel("ch_a"), channel("ch_b", { name: "B" }), channel("ch_app", { type: "app" })] })
})

describe("getChannel", () => {
  it("与 getChannels().find 完全一致（含缺省字段补齐、应用内通道的固定绑定）", () => {
    for (const id of ["ch_a", "ch_b", "ch_app"]) {
      expect(getChannel(id)).toEqual(getChannels().find((c) => c.id === id))
    }
    expect(getChannel("ch_app")).toMatchObject({ mainUserEnabled: true })
    // 缺省字段补齐
    expect(getChannel("ch_a")).toMatchObject({ keepSessionMain: true, persistentPollOthers: false, streamKeepPerKindOthers: 5 })
  })

  it("没有 id / 没有这个通道：undefined", () => {
    expect(getChannel(undefined)).toBeUndefined()
    expect(getChannel("")).toBeUndefined()
    expect(getChannel("ch_nope")).toBeUndefined()
  })

  it("返回的是副本：调用方改它不影响后续读到的配置", () => {
    const first = getChannel("ch_b")!
    first.name = "被改了"
    first.favoriteWorkspaces = ["X"]
    expect(getChannel("ch_b")!.name).toBe("B")
    expect(getChannel("ch_b")!.favoriteWorkspaces).toBeUndefined()
    expect(getConfig().channels.find((c) => c.id === "ch_b")!.name).toBe("B")
  })

  it("配置保存后立刻读到新值（缓存随写入失效）", () => {
    expect(getChannel("ch_b")!.name).toBe("B")
    saveConfig({ channels: [channel("ch_b", { name: "B2" })] })
    expect(getChannel("ch_b")!.name).toBe("B2")
    expect(getChannel("ch_a")).toBeUndefined()
  })

  it("缓存命中后只克隆这一个通道，不克隆整份配置", () => {
    getChannel("ch_a") // 先把缓存填上
    const spy = vi.spyOn(globalThis, "structuredClone")
    try {
      getChannel("ch_a")
      getChannel("ch_b")
      const cloned = spy.mock.calls.map((c) => c[0] as Record<string, unknown>)
      expect(cloned).toHaveLength(2)
      // 克隆的是通道本身（有 id），不是整份配置（有 channels 数组）
      for (const v of cloned) {
        expect("channels" in v).toBe(false)
        expect(typeof v.id).toBe("string")
      }
    } finally {
      spy.mockRestore()
    }
  })
})
