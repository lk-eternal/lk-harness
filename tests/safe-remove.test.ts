import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { linkTargetOf, removeNoFollow } from "../src/shared/safe-remove"

/**
 * 注意：这个文件跑在普通 Node 里，而应用里跑的是 Electron 的 Node。
 * 普通 Node 的 fs.rmSync 删链接是安全的，所以这里测的是行为本身（含失败要报出来）；
 * 「在 Electron 里是不是真的不越界」由 safe-remove-electron.test.ts 在 Electron 的 Node 里验证。
 */

let base: string

beforeEach(() => {
  base = fs.mkdtempSync(path.join(os.tmpdir(), "safe-remove-"))
})
afterEach(async () => {
  vi.restoreAllMocks()
  await fs.promises.rm(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
})

function write(file: string, content = "x"): void {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, content, "utf-8")
}

/** 目录链接：Windows 用 junction（不需要管理员权限），其他系统是符号链接 */
function link(target: string, at: string): boolean {
  try {
    fs.symlinkSync(target, at, "junction")
    return true
  } catch {
    return false
  }
}

const exists = (p: string) => {
  try { fs.lstatSync(p); return true } catch { return false }
}

describe("removeNoFollow", () => {
  it("不存在：算成功（kind=missing），不报错", async () => {
    expect(await removeNoFollow(path.join(base, "nope"))).toEqual({ ok: true, kind: "missing" })
  })

  it("文件：删掉", async () => {
    const f = path.join(base, "a.txt")
    write(f)
    expect(await removeNoFollow(f)).toEqual({ ok: true, kind: "file" })
    expect(exists(f)).toBe(false)
  })

  it("文件夹：连里面几层的内容一起删，同级的不动", async () => {
    write(path.join(base, "skill", "SKILL.md"))
    write(path.join(base, "skill", "scripts", "deep", "run.sh"))
    write(path.join(base, "keep", "SKILL.md"))
    expect(await removeNoFollow(path.join(base, "skill"))).toEqual({ ok: true, kind: "dir" })
    expect(exists(path.join(base, "skill"))).toBe(false)
    expect(exists(path.join(base, "keep", "SKILL.md"))).toBe(true)
  })

  it("只读文件也能删（git 的对象文件就是只读的）", async () => {
    const f = path.join(base, "skill", "scripts", "ro.txt")
    write(f)
    fs.chmodSync(f, 0o444)
    expect(await removeNoFollow(path.join(base, "skill"))).toMatchObject({ ok: true })
    expect(exists(path.join(base, "skill"))).toBe(false)
  })

  it("链接：只删链接，原目录和里面的文件原样保留", async (ctx) => {
    write(path.join(base, "real", "SKILL.md"), "原件")
    write(path.join(base, "real", "scripts", "run.sh"), "原件脚本")
    if (!link(path.join(base, "real"), path.join(base, "link"))) return ctx.skip()
    expect(await removeNoFollow(path.join(base, "link"))).toEqual({ ok: true, kind: "link" })
    expect(exists(path.join(base, "link"))).toBe(false)
    expect(fs.readFileSync(path.join(base, "real", "SKILL.md"), "utf-8")).toBe("原件")
    expect(fs.readFileSync(path.join(base, "real", "scripts", "run.sh"), "utf-8")).toBe("原件脚本")
  })

  it("文件夹里面嵌套了链接：文件夹删掉，链接指向的地方不动", async (ctx) => {
    write(path.join(base, "outside", "precious.txt"), "别删我")
    write(path.join(base, "skill", "SKILL.md"))
    if (!link(path.join(base, "outside"), path.join(base, "skill", "references"))) return ctx.skip()
    expect(await removeNoFollow(path.join(base, "skill"))).toEqual({ ok: true, kind: "dir" })
    expect(exists(path.join(base, "skill"))).toBe(false)
    expect(fs.readFileSync(path.join(base, "outside", "precious.txt"), "utf-8")).toBe("别删我")
  })

  it("悬空链接（指向的地方已经没了）：照样能删掉", async (ctx) => {
    write(path.join(base, "gone", "SKILL.md"))
    if (!link(path.join(base, "gone"), path.join(base, "dangling"))) return ctx.skip()
    await fs.promises.rm(path.join(base, "gone"), { recursive: true, force: true })
    expect(await removeNoFollow(path.join(base, "dangling"))).toEqual({ ok: true, kind: "link" })
    expect(exists(path.join(base, "dangling"))).toBe(false)
  })

  // 失败要报出来：被占用（EPERM/EBUSY）和「rm 什么都没删却不报错」都不能被当成成功。
  // 真实的占用在各运行时表现不一样（普通 Node 里照样删得掉），所以这里模拟 rm 的行为。
  it("rm 抛 EPERM（被占用或没权限）：返回失败，说明原因和路径", async () => {
    write(path.join(base, "busy", "SKILL.md"))
    vi.spyOn(fs.promises, "rm").mockRejectedValue(Object.assign(new Error("operation not permitted"), { code: "EPERM" }))
    const r = await removeNoFollow(path.join(base, "busy"))
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.error).toContain("删不掉（EPERM）")
      expect(r.error).toContain(path.join(base, "busy"))
    }
  })

  it("rm 抛别的错误：返回失败，带上原始信息", async () => {
    write(path.join(base, "x", "SKILL.md"))
    vi.spyOn(fs.promises, "rm").mockRejectedValue(Object.assign(new Error("disk exploded"), { code: "EIO" }))
    const r = await removeNoFollow(path.join(base, "x"))
    expect(r).toEqual({ ok: false, error: "删除失败（EIO）：disk exploded" })
  })

  it("rm 悄悄什么都没删就返回（个别 Node 版本对含中文的路径会这样）：不能算成功", async () => {
    write(path.join(base, "中文目录", "SKILL.md"))
    vi.spyOn(fs.promises, "rm").mockResolvedValue(undefined)
    const r = await removeNoFollow(path.join(base, "中文目录"))
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toContain("没有删干净")
    expect(exists(path.join(base, "中文目录", "SKILL.md"))).toBe(true)
  })

  // 模拟的是 Windows 的目录链接（junction）：unlink 不认，退一步用 rmdir。
  // POSIX 上 unlink 链接从不报 EISDIR，而对链接 rmdir 会报 ENOTDIR，在那里模拟出来的场景不存在
  it.runIf(process.platform === "win32")("删链接时 unlink 不认（EISDIR / EPERM）：退一步用 rmdir，仍然只删链接", async (ctx) => {
    write(path.join(base, "real", "SKILL.md"), "原件")
    if (!link(path.join(base, "real"), path.join(base, "link"))) return ctx.skip()
    vi.spyOn(fs.promises, "unlink").mockRejectedValue(Object.assign(new Error("is a directory"), { code: "EISDIR" }))
    expect(await removeNoFollow(path.join(base, "link"))).toEqual({ ok: true, kind: "link" })
    expect(exists(path.join(base, "link"))).toBe(false)
    expect(fs.readFileSync(path.join(base, "real", "SKILL.md"), "utf-8")).toBe("原件")
  })
})

describe("linkTargetOf", () => {
  it("普通文件夹、文件、不存在：null", () => {
    write(path.join(base, "dir", "a.txt"))
    expect(linkTargetOf(path.join(base, "dir"))).toBeNull()
    expect(linkTargetOf(path.join(base, "dir", "a.txt"))).toBeNull()
    expect(linkTargetOf(path.join(base, "nope"))).toBeNull()
  })

  it("链接：返回指向的真实路径", (ctx) => {
    write(path.join(base, "real", "SKILL.md"))
    if (!link(path.join(base, "real"), path.join(base, "link"))) return ctx.skip()
    expect(linkTargetOf(path.join(base, "link"))).toBe(fs.realpathSync(path.join(base, "real")))
  })

  it("悬空链接：空串（和普通文件夹的 null 区分开）", async (ctx) => {
    write(path.join(base, "gone", "SKILL.md"))
    if (!link(path.join(base, "gone"), path.join(base, "dangling"))) return ctx.skip()
    await fs.promises.rm(path.join(base, "gone"), { recursive: true, force: true })
    expect(linkTargetOf(path.join(base, "dangling"))).toBe("")
  })
})
