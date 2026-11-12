import * as fs from "node:fs"
import * as path from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const h = vi.hoisted(() => ({
  gate: Promise.resolve() as Promise<void>,
  calls: [] as { file: string; pathAtCall: string | undefined }[],
  fail: false,
}))

vi.mock("electron", () => ({ ipcMain: { handle: () => {} }, shell: { openExternal: async () => {} } }))
vi.mock("../electron/config-store", () => ({ getConfig: () => ({ channels: [] }) }))
vi.mock("../electron/shell-path", () => ({ shellPathReady: () => h.gate }))
vi.mock("node:child_process", async () => {
  const { promisify } = await import("node:util")
  const execFile: any = () => { throw new Error("toolbox 只应该走 promisify 版本") }
  execFile[promisify.custom] = async (file: string) => {
    h.calls.push({ file, pathAtCall: process.env.PATH })
    if (h.fail) throw Object.assign(new Error("spawn ENOENT"), { stdout: "", stderr: "ENOENT" })
    return { stdout: "v22.23.2\n", stderr: "" }
  }
  return { execFile, spawn: () => { throw new Error("不应该 spawn") } }
})

import { getToolboxStatus, installTool } from "../electron/toolbox"

const root = path.resolve(__dirname, "..")
const read = (rel: string) => fs.readFileSync(path.join(root, rel), "utf8")

describe("工具箱：等终端里的 PATH 补进来再检测", () => {
  let savedPath: string | undefined
  beforeEach(() => { savedPath = process.env.PATH; h.calls.length = 0; h.fail = false; h.gate = Promise.resolve() })
  afterEach(() => { if (savedPath === undefined) delete process.env.PATH; else process.env.PATH = savedPath })

  it("PATH 还没补好时不开始检测；补好之后检测用的是补好的 PATH", async () => {
    let release!: () => void
    h.gate = new Promise<void>((resolve) => { release = resolve })

    const pending = getToolboxStatus()
    await new Promise((r) => setTimeout(r, 30))
    expect(h.calls, "login shell 的 PATH 还没读完，不应该已经去跑 node -v").toHaveLength(0)

    process.env.PATH = "/fixed/by/login/shell"
    release()
    const status = await pending
    expect(h.calls.length).toBeGreaterThan(0)
    expect(h.calls.every((c) => c.pathAtCall === "/fixed/by/login/shell")).toBe(true)
    expect(status.nodeOk).toBe(true)
    expect(status.nodeVersion).toBe("22.23.2")
  })

  it("补好了就不再等：已经 resolve 的情况下检测照常跑", async () => {
    const status = await getToolboxStatus()
    expect(status.nodeOk).toBe(true)
  })

  it("真的没有 Node：提示按平台给——Windows 要勾选 Add to PATH，macOS / Linux 让用户把 which node 反馈回来", async () => {
    h.fail = true
    const r = await installTool("larkCli")
    expect(r.ok).toBe(false)
    expect(r.error).toContain("未检测到 Node.js")
    if (process.platform === "win32") {
      expect(r.error).toContain("Add to PATH")
    } else {
      expect(r.error).toContain("which node")
      expect(r.error).not.toContain("Add to PATH")
    }
  })
})

describe("接线：谁在什么时候补 PATH", () => {
  it("main 在 app ready 后第一件事就补 PATH，早于 initDaemonManager", () => {
    const main = read("electron/main.ts")
    const ready = main.indexOf("app.whenReady()")
    const init = main.indexOf("initShellPath(", ready)
    const daemon = main.indexOf("initDaemonManager()", ready)
    expect(ready).toBeGreaterThan(-1)
    expect(init, "main.ts 没有调用 initShellPath").toBeGreaterThan(ready)
    expect(init).toBeLessThan(daemon)
    // 它是 whenReady 回调里的第一条语句：中间没有别的初始化
    expect(main.slice(ready, init)).not.toMatch(/migrateSecretsToSafeStorage|createWindow|initDaemonManager/)
  })

  it("daemon 拷贝环境变量之前先等 PATH 就绪", () => {
    const dm = read("electron/daemon-manager.ts")
    const fn = dm.indexOf("export async function startDaemon")
    const wait = dm.indexOf("await shellPathReady()", fn)
    const env = dm.indexOf("const env: Record<string, string> = {", fn)
    expect(fn).toBeGreaterThan(-1)
    expect(wait, "startDaemon 没有 await shellPathReady()").toBeGreaterThan(fn)
    expect(wait).toBeLessThan(env)
  })
})
