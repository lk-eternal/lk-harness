import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"

/**
 * readAppChatImage 用异步读盘：几 MB 的截图同步读 + base64 会把主进程占住。
 * 真实文件；electron / electron-store 顶掉。
 */

let userData = ""
vi.mock("electron-store", () => ({
  default: class {
    get store() { return {} }
    set() {}
  },
}))
vi.mock("electron", () => ({
  app: { getPath: () => userData, getVersion: () => "0", isPackaged: false },
  BrowserWindow: { getAllWindows: () => [] },
  ipcMain: { handle: () => {}, on: () => {} },
  shell: {},
  dialog: {},
  clipboard: {},
  nativeImage: {},
  safeStorage: { isEncryptionAvailable: () => false },
}))

import { readAppChatImage } from "../electron/app-chat"

let dir: string
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), "lk-app-image-")) })
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }) })

describe("readAppChatImage", () => {
  it("读出 data URL（按扩展名给 MIME）", async () => {
    const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3])
    const file = path.join(dir, "a.png")
    fs.writeFileSync(file, bytes)
    expect(await readAppChatImage(file)).toEqual({ ok: true, dataUrl: `data:image/png;base64,${bytes.toString("base64")}` })
    const jpg = path.join(dir, "b.JPG")
    fs.writeFileSync(jpg, bytes)
    expect(await readAppChatImage(jpg)).toMatchObject({ ok: true, dataUrl: expect.stringMatching(/^data:image\/jpeg;base64,/) })
  })

  it("返回 Promise（不阻塞调用方）", () => {
    const file = path.join(dir, "a.png")
    fs.writeFileSync(file, "x")
    expect(readAppChatImage(file)).toBeInstanceOf(Promise)
  })

  it("不是图片扩展名 → 报错，不读文件", async () => {
    const file = path.join(dir, "a.txt")
    fs.writeFileSync(file, "x")
    expect(await readAppChatImage(file)).toEqual({ ok: false, error: "不是图片文件" })
  })

  it("文件不存在 → 报错而不是抛异常", async () => {
    expect(await readAppChatImage(path.join(dir, "gone.png"))).toEqual({ ok: false, error: "文件不存在" })
  })

  it("超过 20MB → 报错（稀疏文件，不真占盘）", async () => {
    const file = path.join(dir, "big.png")
    const fd = fs.openSync(file, "w")
    fs.ftruncateSync(fd, 20 * 1024 * 1024 + 1)
    fs.closeSync(fd)
    expect(await readAppChatImage(file)).toEqual({ ok: false, error: "图片超过 20MB" })
  })

  it("读取失败（路径是目录）→ 报错而不是抛异常", async () => {
    const asDir = path.join(dir, "dir.png")
    fs.mkdirSync(asDir)
    const r = await readAppChatImage(asDir)
    expect(r.ok).toBe(false)
  })
})
