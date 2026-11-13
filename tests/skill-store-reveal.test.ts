import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { resolveSkillOpenTargetUnder, revealSkillPath, revealSkillPathUnder, type ShellOpener } from "../electron/skill-store"

/**
 * 设置页「打开目录 / 显示文件位置」的处理端（skills:reveal 背后）。
 * 根目录由调用方传入，所以在临时目录里测，不碰真实的 ~/.cursor/skills；
 * 真正弹出文件管理器的 Electron shell 换成假的，只看它被怎么调用。
 */

/** base/skills 是 Skill 根目录；outside 在根目录外面，任何路径都不该指到它 */
let base: string
let root: string
let outside: string

function write(file: string, content = "x"): void {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, content, "utf-8")
}

function link(target: string, at: string): boolean {
  try {
    fs.symlinkSync(target, at, "junction")
    return true
  } catch {
    return false
  }
}

function fakeShell(openResult = "") {
  const openPath = vi.fn(async (_target: string) => openResult)
  const showItemInFolder = vi.fn((_target: string): void => {})
  return { openPath, showItemInFolder } satisfies ShellOpener
}

beforeEach(() => {
  base = fs.mkdtempSync(path.join(os.tmpdir(), "skill-store-reveal-"))
  root = path.join(base, "skills")
  outside = path.join(base, "outside")
  write(path.join(root, "foo", "SKILL.md"))
  write(path.join(root, "foo", "scripts", "run.sh"))
  write(path.join(root, "foo", "notes.md"))
  write(path.join(root, "group", "bar", "SKILL.md"))
  write(path.join(root, "other", "SKILL.md"))
  write(path.join(outside, "secret.txt"), "s")
})
afterEach(async () => {
  vi.restoreAllMocks()
  await fs.promises.rm(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
})

describe("resolveSkillOpenTargetUnder：要打开的是哪里", () => {
  it("两个参数都为空：Skill 根目录自己，是文件夹", () => {
    expect(resolveSkillOpenTargetUnder(root, "", "")).toEqual({ ok: true, kind: "directory", path: root })
  })

  it("只给 Skill 路径：那个 Skill 的文件夹；分层的 Skill（group/bar）是最里面那层", () => {
    expect(resolveSkillOpenTargetUnder(root, "foo", "")).toEqual({ ok: true, kind: "directory", path: path.join(root, "foo") })
    expect(resolveSkillOpenTargetUnder(root, "group/bar", "")).toEqual({ ok: true, kind: "directory", path: path.join(root, "group", "bar") })
  })

  it("Skill 里的文件夹是文件夹，文件（含 SKILL.md）是文件", () => {
    expect(resolveSkillOpenTargetUnder(root, "foo", "scripts")).toEqual({ ok: true, kind: "directory", path: path.join(root, "foo", "scripts") })
    expect(resolveSkillOpenTargetUnder(root, "foo", "scripts/run.sh")).toEqual({ ok: true, kind: "file", path: path.join(root, "foo", "scripts", "run.sh") })
    expect(resolveSkillOpenTargetUnder(root, "foo", "SKILL.md")).toEqual({ ok: true, kind: "file", path: path.join(root, "foo", "SKILL.md") })
    expect(resolveSkillOpenTargetUnder(root, "foo", "notes.md")).toMatchObject({ ok: true, kind: "file" })
  })

  it("返回的是规范化的绝对路径（界面传来的 / 在 Windows 上变成 \\），交给系统不会出错", () => {
    const r = resolveSkillOpenTargetUnder(root, "foo", "scripts/run.sh")
    expect(r.ok && path.isAbsolute(r.path)).toBe(true)
    expect(r.ok && r.path).toBe(path.join(root, "foo", "scripts", "run.sh"))
  })

  it("路径里有空格和中文也行", () => {
    write(path.join(root, "我的 skill", "SKILL.md"))
    write(path.join(root, "我的 skill", "参考 资料", "说明.md"))
    expect(resolveSkillOpenTargetUnder(root, "我的 skill", "")).toEqual({ ok: true, kind: "directory", path: path.join(root, "我的 skill") })
    expect(resolveSkillOpenTargetUnder(root, "我的 skill", "参考 资料/说明.md")).toEqual({ ok: true, kind: "file", path: path.join(root, "我的 skill", "参考 资料", "说明.md") })
  })

  it("指向文件夹的链接（含 Windows 的 junction）按文件夹算", () => {
    if (!link(path.join(outside), path.join(root, "linked"))) return // 这台机器建不了链接：跳过
    expect(resolveSkillOpenTargetUnder(root, "linked", "")).toEqual({ ok: true, kind: "directory", path: path.join(root, "linked") })
    expect(resolveSkillOpenTargetUnder(root, "linked", "secret.txt")).toMatchObject({ ok: true, kind: "file" })
  })

  it("链接指向的东西已经没了：说不存在，不抛错", () => {
    const gone = path.join(base, "gone")
    fs.mkdirSync(gone)
    if (!link(gone, path.join(root, "dangling"))) return
    fs.rmdirSync(gone)
    expect(resolveSkillOpenTargetUnder(root, "dangling", "")).toEqual({ ok: false, error: "文件或文件夹不存在，可能已被删除" })
  })
})

describe("resolveSkillOpenTargetUnder：不存在", () => {
  it("Skill 根目录还没建（比如还没装过这个工具）：提示新建第一个 Skill 时会自动创建，并且不替用户把它建出来", () => {
    const fresh = path.join(base, "never", "skills")
    expect(resolveSkillOpenTargetUnder(fresh, "", "")).toEqual({ ok: false, error: "这个目录还不存在，新建第一个 Skill 时会自动创建" })
    expect(fs.existsSync(path.join(base, "never"))).toBe(false)
  })

  it("Skill 或里面的文件被别处删了：说不存在，不是「路径无效」", () => {
    const missing = { ok: false, error: "文件或文件夹不存在，可能已被删除" }
    expect(resolveSkillOpenTargetUnder(root, "ghost", "")).toEqual(missing)
    expect(resolveSkillOpenTargetUnder(root, "foo", "nope.txt")).toEqual(missing)
    expect(resolveSkillOpenTargetUnder(root, "foo", "nope/deeper/x.txt")).toEqual(missing)
  })

  it("把文件当文件夹往下走（notes.md/x）也是不存在，不抛错", () => {
    expect(resolveSkillOpenTargetUnder(root, "foo", "notes.md/x")).toEqual({ ok: false, error: "文件或文件夹不存在，可能已被删除" })
  })
})

describe("resolveSkillOpenTargetUnder：不能指到不该指的地方", () => {
  const invalid = { ok: false, error: "路径无效" }

  it("Skill 路径用 .. 或绝对路径跳出根目录", () => {
    expect(resolveSkillOpenTargetUnder(root, "..", "")).toEqual(invalid)
    expect(resolveSkillOpenTargetUnder(root, "../outside", "")).toEqual(invalid)
    expect(resolveSkillOpenTargetUnder(root, "foo/../../outside", "")).toEqual(invalid)
    expect(resolveSkillOpenTargetUnder(root, outside, "")).toEqual(invalid)
  })

  it("根目录的同名前缀兄弟目录（skills-evil）不会被当成根目录里面", () => {
    write(path.join(base, "skills-evil", "SKILL.md"))
    expect(resolveSkillOpenTargetUnder(root, "../skills-evil", "")).toEqual(invalid)
  })

  it("文件路径用 .. 或绝对路径跳出这个 Skill（哪怕还在根目录里：别的 Skill 也不行）", () => {
    expect(resolveSkillOpenTargetUnder(root, "foo", "..")).toEqual(invalid)
    expect(resolveSkillOpenTargetUnder(root, "foo", "../other")).toEqual(invalid)
    expect(resolveSkillOpenTargetUnder(root, "foo", "../other/SKILL.md")).toEqual(invalid)
    expect(resolveSkillOpenTargetUnder(root, "foo", "../../outside/secret.txt")).toEqual(invalid)
    expect(resolveSkillOpenTargetUnder(root, "foo", path.join(outside, "secret.txt"))).toEqual(invalid)
  })

  it("没有 Skill 路径却给了文件路径：不知道相对谁，拒绝，不当成根目录下的文件", () => {
    expect(resolveSkillOpenTargetUnder(root, "", "foo")).toEqual(invalid)
    expect(resolveSkillOpenTargetUnder(root, "", "foo/SKILL.md")).toEqual(invalid)
  })

  it("参数不是字符串（界面传来的值不保证类型）：路径无效，不抛错，也不悄悄当成根目录", () => {
    const bad = [undefined, null, 5, {}, ["foo"]] as unknown as string[]
    for (const v of bad) {
      expect(resolveSkillOpenTargetUnder(root, v, "")).toEqual(invalid)
      expect(resolveSkillOpenTargetUnder(root, "foo", v)).toEqual(invalid)
    }
  })

  it("含空字符的路径不抛错", () => {
    const r = resolveSkillOpenTargetUnder(root, "foo\u0000x", "")
    expect(r.ok).toBe(false)
  })
})

describe("revealSkillPathUnder：交给系统怎么打开", () => {
  it("文件夹：直接打开它，不调「显示文件位置」", async () => {
    const shell = fakeShell()
    expect(await revealSkillPathUnder(root, "foo", "scripts", shell)).toEqual({ ok: true })
    expect(shell.openPath.mock.calls).toEqual([[path.join(root, "foo", "scripts")]])
    expect(shell.showItemInFolder).not.toHaveBeenCalled()
  })

  it("Skill 根目录和 Skill 文件夹自己也是直接打开", async () => {
    const shell = fakeShell()
    await revealSkillPathUnder(root, "", "", shell)
    await revealSkillPathUnder(root, "group/bar", "", shell)
    expect(shell.openPath.mock.calls).toEqual([[root], [path.join(root, "group", "bar")]])
  })

  it("文件：在所在文件夹里选中它，不调「打开文件夹」（不会用默认程序把脚本跑起来）", async () => {
    const shell = fakeShell()
    expect(await revealSkillPathUnder(root, "foo", "scripts/run.sh", shell)).toEqual({ ok: true })
    expect(shell.showItemInFolder.mock.calls).toEqual([[path.join(root, "foo", "scripts", "run.sh")]])
    expect(shell.openPath).not.toHaveBeenCalled()
  })

  it("系统打不开文件夹：把系统给的原因带回去", async () => {
    const shell = fakeShell("没有权限")
    expect(await revealSkillPathUnder(root, "foo", "", shell)).toEqual({ ok: false, error: "没有权限" })
  })

  it("系统接口抛错（两种调用都算）：变成失败结果，不让错误冒到界面外", async () => {
    const throwing: ShellOpener = {
      openPath: async () => { throw new Error("shell 坏了") },
      showItemInFolder: () => { throw new Error("shell 坏了") },
    }
    expect(await revealSkillPathUnder(root, "foo", "", throwing)).toEqual({ ok: false, error: "shell 坏了" })
    expect(await revealSkillPathUnder(root, "foo", "notes.md", throwing)).toEqual({ ok: false, error: "shell 坏了" })
  })

  it("路径无效或不存在时一次系统调用都不发", async () => {
    const shell = fakeShell()
    expect(await revealSkillPathUnder(root, "..", "", shell)).toEqual({ ok: false, error: "路径无效" })
    expect(await revealSkillPathUnder(root, "foo", "../other", shell)).toEqual({ ok: false, error: "路径无效" })
    expect(await revealSkillPathUnder(root, "ghost", "", shell)).toMatchObject({ ok: false })
    expect(shell.openPath).not.toHaveBeenCalled()
    expect(shell.showItemInFolder).not.toHaveBeenCalled()
  })

  it("只是看位置：不改磁盘上的任何东西", async () => {
    const snapshot = (dir: string): string[] => fs.readdirSync(dir, { recursive: true, withFileTypes: true }).map((e) => path.join(e.parentPath, e.name)).sort()
    const before = snapshot(base)
    await revealSkillPathUnder(root, "foo", "scripts", fakeShell())
    await revealSkillPathUnder(root, "foo", "SKILL.md", fakeShell())
    await revealSkillPathUnder(path.join(base, "never"), "", "", fakeShell())
    expect(snapshot(base)).toEqual(before)
  })
})

describe("revealSkillPath：按目录 id 找根", () => {
  it("不认识的目录 id：路径无效，一次系统调用都不发（不能拿一个怪 id 去打开别处）", async () => {
    const shell = fakeShell()
    for (const id of ["nope", "", "../../etc", "cursor/../x", "CURSOR"]) {
      expect(await revealSkillPath(id, "", "", shell)).toEqual({ ok: false, error: "路径无效" })
    }
    expect(shell.openPath).not.toHaveBeenCalled()
    expect(shell.showItemInFolder).not.toHaveBeenCalled()
  })
})
