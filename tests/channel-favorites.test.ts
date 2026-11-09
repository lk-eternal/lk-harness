import { beforeEach, describe, expect, it, vi } from "vitest"
import * as os from "node:os"
import * as path from "node:path"

/**
 * 通道的常用目录：新建的应用内通道不能凭空带出一批目录会话。
 * 真实的 config-store，只把落盘的 electron-store 换成内存版（electron 只留 safeStorage 一个桩）。
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

import {
  getChannel, getChannelFavoriteWorkspaces, migrateFavoriteWorkspacesToChannels,
  removeWorkspaceFromChannelFavorites, saveConfig, setChannelFavoriteWorkspaces,
  type MessageChannel,
} from "../electron/config-store"

// 真实的绝对路径：config-store 会 path.resolve 它们，写死盘符在 Linux/macOS 上会被当成相对路径拼上 cwd
const ROOT = path.join(os.tmpdir(), "lkh-fav-test")
const ALPHA = path.join(ROOT, "alpha")
const BETA = path.join(ROOT, "beta")
const MINE = path.join(ROOT, "mine")
const GLOBAL_DIRS = [ALPHA, BETA]

function channel(id: string, type: MessageChannel["type"], extra: Partial<MessageChannel> = {}): MessageChannel {
  return {
    id, name: id, enabled: true, type, agentResourceId: "", model: "auto", modelParams: "",
    othersModel: "", othersModelParams: "", mainUserEnabled: type === "app",
    mainUserChatId: type === "app" ? "app_main" : "", allowOthers: false, digitalIdentity: "", workspaceDir: "",
    ...extra,
  }
}

/** 全局有常用目录，且已经过了「全局 → 各通道」的一次性迁移（也就是说这些通道都是迁移之后才建的） */
function seed(channels: MessageChannel[], migrated = true) {
  saveConfig({ channels, favoriteWorkspaces: GLOBAL_DIRS, favWorkspacesMigrated: migrated })
}

beforeEach(() => {
  // 经 saveConfig 重置，getConfig 的缓存才会跟着失效
  saveConfig({ channels: [], favoriteWorkspaces: [], favWorkspacesMigrated: false })
})

describe("新建的应用内通道没有任何常用目录", () => {
  it("全局有常用目录时，没存过自己列表的应用内通道读到的是空", () => {
    seed([channel("ch_app", "app")])
    expect(getChannelFavoriteWorkspaces(getChannel("ch_app"))).toEqual([])
  })

  it("用户自己加的目录才算：在新通道里加一个，列表只有这一个，不会把全局那批一起带进来", () => {
    seed([channel("ch_app", "app")])
    const ch = getChannel("ch_app")
    // 和 channel:add-favorite-workspace 一样：读现有的、追加、整体存回
    const saved = setChannelFavoriteWorkspaces("ch_app", [...getChannelFavoriteWorkspaces(ch), MINE])
    expect(saved).toEqual([MINE])
    expect(getChannelFavoriteWorkspaces(getChannel("ch_app"))).toEqual([MINE])
  })

  it("通道自己的列表原样用（同路径不同写法去重）", () => {
    // 第二条：大小写不同 + 末尾多一个分隔符
    seed([channel("ch_app", "app", { favoriteWorkspaces: [MINE, MINE.toUpperCase() + path.sep] })])
    expect(getChannelFavoriteWorkspaces(getChannel("ch_app"))).toEqual([MINE])
  })

  it("用户清空过的列表保持为空，不会又回退到全局", () => {
    seed([channel("ch_app", "app", { favoriteWorkspaces: [] })])
    expect(getChannelFavoriteWorkspaces(getChannel("ch_app"))).toEqual([])
  })

  it("在新通道里删目录会话不会把全局目录写进通道列表", () => {
    seed([channel("ch_app", "app")])
    removeWorkspaceFromChannelFavorites("ch_app", ALPHA)
    expect(getChannel("ch_app")?.favoriteWorkspaces).toBeUndefined()
  })
})

describe("其它通道不受影响", () => {
  it("飞书通道没存过列表时仍然回退到全局常用目录（/c w 的快捷按钮靠它）", () => {
    seed([channel("ch_fs", "feishu")])
    expect(getChannelFavoriteWorkspaces(getChannel("ch_fs"))).toEqual(GLOBAL_DIRS)
  })

  it("没有通道时（兜底）读全局", () => {
    seed([])
    expect(getChannelFavoriteWorkspaces(undefined)).toEqual(GLOBAL_DIRS)
  })
})

describe("全局 → 各通道的一次性迁移", () => {
  it("飞书通道得到一份全局的拷贝，应用内通道没有", () => {
    seed([channel("ch_fs", "feishu"), channel("ch_app", "app")], false)
    migrateFavoriteWorkspacesToChannels()
    expect(getChannel("ch_fs")?.favoriteWorkspaces).toEqual(GLOBAL_DIRS)
    expect(getChannel("ch_app")?.favoriteWorkspaces).toEqual([])
    expect(getChannelFavoriteWorkspaces(getChannel("ch_app"))).toEqual([])
  })

  it("已经有自己列表的通道不被覆盖", () => {
    seed([channel("ch_app", "app", { favoriteWorkspaces: [MINE] })], false)
    migrateFavoriteWorkspacesToChannels()
    expect(getChannel("ch_app")?.favoriteWorkspaces).toEqual([MINE])
  })
})
