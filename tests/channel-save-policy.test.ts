import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"

/**
 * 设置页保存通道 → saveAppConfigFromRenderer 必须把「保存前 / 保存后」的通道交给 applyChannelPolicyChanges，
 * 否则收紧准入、改访客限制都不会停掉正在跑的别人的会话（只剩设置文件变了）。
 * 真实的 daemon-manager + config-store，只桩掉落盘的 electron-store、electron、daemon 通信、会话调度。
 */
let userData = ""
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
vi.mock("electron", () => ({
  app: { getPath: () => userData, getVersion: () => "0", isPackaged: false, getAppPath: () => userData },
  BrowserWindow: { getAllWindows: () => [] },
  ipcMain: { handle: () => {}, on: () => {} },
  shell: {},
  dialog: {},
  safeStorage: { isEncryptionAvailable: () => false },
}))

const applyPolicy = vi.fn(async () => {})
vi.mock("../electron/session-dispatcher", async (orig) => {
  const actual = await orig<typeof import("../electron/session-dispatcher")>()
  return { ...actual, applyChannelPolicyChanges: applyPolicy }
})
vi.mock("../electron/daemon-client", async (orig) => {
  const actual = await orig<typeof import("../electron/daemon-client")>()
  return {
    ...actual,
    readLockFile: () => null,
    httpPost: vi.fn(async () => ({})),
    httpGet: vi.fn(async () => ({})),
  }
})

const CH = "ch_f"
function feishu(extra: Record<string, unknown> = {}) {
  return {
    id: CH, name: "飞书", enabled: true, type: "feishu", agentResourceId: "r1", model: "composer-2", modelParams: "",
    othersModel: "", othersModelParams: "", mainUserEnabled: true, mainUserChatId: "oc_main",
    allowOthers: false, digitalIdentity: "", workspaceDir: "",
    ...extra,
  }
}

beforeEach(() => {
  userData = fs.mkdtempSync(path.join(os.tmpdir(), "channel-save-policy-"))
  applyPolicy.mockClear()
})
afterEach(() => {
  fs.rmSync(userData, { recursive: true, force: true })
})

async function boot(initial: Record<string, unknown>) {
  vi.resetModules()
  const config = await import("../electron/config-store")
  config.saveConfig({
    agentResources: [{ id: "r1", name: "SDK", type: "sdk", apiKey: "k" }] as never,
    channels: [feishu(initial)] as never,
  })
  const manager = await import("../electron/daemon-manager")
  return { config, manager }
}

describe("saveAppConfigFromRenderer：保存通道后检查准入 / 访客限制有没有变", () => {
  it("改了通道：applyChannelPolicyChanges 收到保存前（已套默认值）和保存后的通道", async () => {
    const { config, manager } = await boot({ othersDm: true, groupPolicy: "all" })
    const next = { ...config.getChannels()[0]!, othersDm: false }
    const r = await manager.saveAppConfigFromRenderer({ channels: [next] as never })
    expect(r.ok).toBe(true)
    expect(applyPolicy).toHaveBeenCalledTimes(1)
    const [prev, after] = applyPolicy.mock.calls[0]! as unknown as [Array<{ id: string; othersDm: boolean }>, Array<{ id: string; othersDm: boolean }>]
    expect(prev.find((c) => c.id === CH)!.othersDm).toBe(true)
    expect(after.find((c) => c.id === CH)!.othersDm).toBe(false)
  })

  it("旧配置（只有 allowOthers=true）保存：「保存前」是迁移后的值，不是缺字段的原样", async () => {
    const { config, manager } = await boot({ allowOthers: true })
    const next = { ...config.getChannels()[0]!, name: "改名" }
    await manager.saveAppConfigFromRenderer({ channels: [next] as never })
    const [prev] = applyPolicy.mock.calls[0]! as unknown as [Array<{ id: string; othersDm: boolean; groupPolicy: string; visitorTier: string }>]
    const p = prev.find((c) => c.id === CH)!
    expect(p).toMatchObject({ othersDm: true, groupPolicy: "all", visitorTier: "full" })
  })

  it("没碰通道（只改别的设置）：不触发", async () => {
    const { manager } = await boot({ othersDm: true })
    await manager.saveAppConfigFromRenderer({ httpProxy: "" })
    expect(applyPolicy).not.toHaveBeenCalled()
  })
})
