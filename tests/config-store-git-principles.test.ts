import { beforeEach, describe, expect, it, vi } from "vitest"
import { DEFAULT_GIT_PRINCIPLES, GIT_PRINCIPLES_MAX, resolveGitPrinciples } from "../src/shared/project-git-principles"

/**
 * 设置里的「Git 基本原则」怎么存：
 * - 没设过（键不存在）= 用默认文案；以后默认文案升级了，没改过的人自动用上新的；
 * - 存成和默认文案一样的 = 当没改过，把键删掉（点「恢复默认」就是这样回到「跟着默认走」）；
 * - 存成空 = 用户主动关掉，不带；
 * - 其余的原样存（换行统一、去两端空白、超长截断）。
 * 真实的 config-store，只把落盘的 electron-store 换成内存版（要支持 delete）。
 */

let disk: Record<string, unknown> = {}
vi.mock("electron-store", () => ({
  default: class {
    constructor(opts: { defaults?: Record<string, unknown> }) {
      disk = structuredClone(opts.defaults ?? {})
    }
    get store() { return disk }
    set(patch: Record<string, unknown>) { Object.assign(disk, structuredClone(patch)) }
    delete(key: string) { delete disk[key] }
  },
}))
vi.mock("electron", () => ({ safeStorage: { isEncryptionAvailable: () => false } }))

import { getConfig, saveConfig } from "../electron/config-store"

beforeEach(() => {
  // 清掉上一条用例留下的值，并让 getConfig 的缓存失效
  delete disk.gitPrinciples
  saveConfig({ favoriteWorkspaces: [] })
})

describe("Git 基本原则的保存", () => {
  it("没设过：配置里没有这个键，实际生效的是默认文案", () => {
    expect(getConfig().gitPrinciples).toBeUndefined()
    expect("gitPrinciples" in disk).toBe(false)
    expect(resolveGitPrinciples(getConfig().gitPrinciples)).toBe(DEFAULT_GIT_PRINCIPLES)
  })

  it("改成自己的文字：存下来（换行统一成 \\n、去两端空白），读出来就是它", () => {
    saveConfig({ gitPrinciples: "  只在 feature 分支提交。\r\n不要 force push。\r\n " })
    expect(getConfig().gitPrinciples).toBe("只在 feature 分支提交。\n不要 force push。")
    expect(resolveGitPrinciples(getConfig().gitPrinciples)).toBe("只在 feature 分支提交。\n不要 force push。")
  })

  it("存成和默认文案一样的（点了「恢复默认」）：键被删掉，回到「跟着默认走」；Windows 换行的默认文案也一样", () => {
    saveConfig({ gitPrinciples: "自己写的" })
    expect(getConfig().gitPrinciples).toBe("自己写的")
    saveConfig({ gitPrinciples: DEFAULT_GIT_PRINCIPLES })
    expect("gitPrinciples" in disk).toBe(false)
    expect(getConfig().gitPrinciples).toBeUndefined()

    saveConfig({ gitPrinciples: "又改了" })
    saveConfig({ gitPrinciples: DEFAULT_GIT_PRINCIPLES.replace(/\n/g, "\r\n") })
    expect("gitPrinciples" in disk).toBe(false)
    expect(getConfig().gitPrinciples).toBeUndefined()
  })

  it("清空：存成空串，实际生效的是「不带」（和没设过不一样）", () => {
    saveConfig({ gitPrinciples: "" })
    expect(getConfig().gitPrinciples).toBe("")
    expect(resolveGitPrinciples(getConfig().gitPrinciples)).toBe("")
    saveConfig({ gitPrinciples: "   \n  " })
    expect(getConfig().gitPrinciples).toBe("")
  })

  it("太长的截断到上限；同一次保存里的别的设置不受影响", () => {
    saveConfig({ gitPrinciples: "x".repeat(GIT_PRINCIPLES_MAX + 500), worktreeRoot: "D:\\projects" })
    expect(getConfig().gitPrinciples).toHaveLength(GIT_PRINCIPLES_MAX)
    expect(getConfig().worktreeRoot).toBe("D:\\projects")
  })

  it("保存别的设置不会动它：自己写的原样，没设过的仍然没设过", () => {
    saveConfig({ gitPrinciples: "自己写的" })
    saveConfig({ worktreeRoot: "D:\\a" })
    expect(getConfig().gitPrinciples).toBe("自己写的")
    saveConfig({ gitPrinciples: DEFAULT_GIT_PRINCIPLES })
    saveConfig({ worktreeRoot: "D:\\b" })
    expect(getConfig().gitPrinciples).toBeUndefined()
  })
})

describe("常用仓库的「克隆副本」设置", () => {
  it("只存「不克隆」：缺省就是克隆；勾回去就不再存这个键", () => {
    saveConfig({ repoProfiles: [{ path: "D:\\a", baseBranch: "main", clone: false }, { path: "D:\\b", baseBranch: "main" }] })
    const got = getConfig().repoProfiles
    expect(got.find((p) => p.path.endsWith("a"))).toMatchObject({ clone: false })
    expect("clone" in got.find((p) => p.path.endsWith("b"))!).toBe(false)
  })
})
