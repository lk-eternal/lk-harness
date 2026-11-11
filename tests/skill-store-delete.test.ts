import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { deleteSkill, deleteSkillEntry, removeSkillEntryUnder, removeSkillUnder } from "../electron/skill-store"

/**
 * 设置页删除 Skill / Skill 里的文件的处理端（skills:delete、skills:delete-file 背后）。
 * 根目录由调用方传入，所以在临时目录里测，不碰真实的 ~/.cursor/skills。
 * 这个文件跑在普通 Node 里；删链接在 Electron 的 Node 里是否越界，见 safe-remove-electron.test.ts。
 */

/** base/skills 是 Skill 根目录；sentinel.txt 在根目录外面，任何操作都不该碰 */
let base: string
let root: string

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

const exists = (p: string) => {
  try { fs.lstatSync(p); return true } catch { return false }
}

beforeEach(() => {
  base = fs.mkdtempSync(path.join(os.tmpdir(), "skill-store-delete-"))
  root = path.join(base, "skills")
  fs.mkdirSync(root, { recursive: true })
  write(path.join(base, "sentinel.txt"), "keep")
})
afterEach(async () => {
  vi.restoreAllMocks()
  await fs.promises.rm(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
})

function expectRootIntact(): void {
  expect(fs.readFileSync(path.join(base, "sentinel.txt"), "utf-8")).toBe("keep")
  expect(exists(root)).toBe(true)
}

describe("removeSkillUnder：删除整个 Skill", () => {
  it("删掉整个文件夹（含 scripts 等），同级的 Skill 不动", async () => {
    write(path.join(root, "foo", "SKILL.md"))
    write(path.join(root, "foo", "scripts", "run.sh"))
    write(path.join(root, "keep", "SKILL.md"))
    expect(await removeSkillUnder(root, "foo")).toEqual({ ok: true })
    expect(exists(path.join(root, "foo"))).toBe(false)
    expect(exists(path.join(root, "keep", "SKILL.md"))).toBe(true)
  })

  it("分层 Skill（group/foo）删的是最里面那层", async () => {
    write(path.join(root, "group", "foo", "SKILL.md"))
    write(path.join(root, "group", "bar", "SKILL.md"))
    expect(await removeSkillUnder(root, "group/foo")).toEqual({ ok: true })
    expect(exists(path.join(root, "group", "foo"))).toBe(false)
    expect(exists(path.join(root, "group", "bar", "SKILL.md"))).toBe(true)
  })

  it("已经不在了：算成功（重复点删除不报错）", async () => {
    expect(await removeSkillUnder(root, "nope")).toEqual({ ok: true })
  })

  // 以前处理端永远回 ok:true，界面也不看结果，删失败了谁都不知道
  it("删不掉：返回失败和原因，界面才能提示", async () => {
    write(path.join(root, "busy", "SKILL.md"))
    vi.spyOn(fs.promises, "rm").mockRejectedValue(Object.assign(new Error("operation not permitted"), { code: "EPERM" }))
    const r = await removeSkillUnder(root, "busy")
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toContain("删不掉（EPERM）")
  })

  it("链接过来的 Skill：只删链接，原目录的文件原样保留", async (ctx) => {
    write(path.join(base, "elsewhere", "linked", "SKILL.md"), "原件")
    write(path.join(base, "elsewhere", "linked", "scripts", "run.sh"), "原件脚本")
    if (!link(path.join(base, "elsewhere", "linked"), path.join(root, "linked"))) return ctx.skip()
    expect(await removeSkillUnder(root, "linked")).toEqual({ ok: true })
    expect(exists(path.join(root, "linked"))).toBe(false)
    expect(fs.readFileSync(path.join(base, "elsewhere", "linked", "SKILL.md"), "utf-8")).toBe("原件")
    expect(fs.readFileSync(path.join(base, "elsewhere", "linked", "scripts", "run.sh"), "utf-8")).toBe("原件脚本")
  })

  // 空路径和 "." 会指到 Skill 根目录自己：isPathInside 把自身也算「在里面」，处理端必须自己拦住
  it.each(["", ".", "./", "a/.."])("路径 %j 指到根目录自己：拒绝，根目录和里面的 Skill 一个不少", async (p) => {
    write(path.join(root, "a", "SKILL.md"))
    write(path.join(root, "b", "SKILL.md"))
    expect(await removeSkillUnder(root, p)).toEqual({ ok: false, error: "路径无效" })
    expect(exists(path.join(root, "a", "SKILL.md"))).toBe(true)
    expect(exists(path.join(root, "b", "SKILL.md"))).toBe(true)
    expectRootIntact()
  })

  it.each(["..", "../skills-evil", "a/../../sentinel.txt", "../outside"])("路径 %j 越出根目录：拒绝，外面的东西不动", async (p) => {
    write(path.join(base, "skills-evil", "SKILL.md"))
    write(path.join(base, "outside", "SKILL.md"))
    expect(await removeSkillUnder(root, p)).toEqual({ ok: false, error: "路径无效" })
    expect(exists(path.join(base, "skills-evil", "SKILL.md"))).toBe(true)
    expect(exists(path.join(base, "outside", "SKILL.md"))).toBe(true)
    expectRootIntact()
  })

  it("绝对路径指到根目录外：拒绝", async () => {
    write(path.join(base, "outside", "SKILL.md"))
    expect(await removeSkillUnder(root, path.join(base, "outside"))).toEqual({ ok: false, error: "路径无效" })
    expect(exists(path.join(base, "outside", "SKILL.md"))).toBe(true)
  })
})

describe("removeSkillEntryUnder：删除 Skill 里的文件或文件夹", () => {
  it("删一个文件", async () => {
    write(path.join(root, "foo", "SKILL.md"))
    write(path.join(root, "foo", "notes.md"))
    expect(await removeSkillEntryUnder(root, "foo", "notes.md")).toEqual({ ok: true })
    expect(exists(path.join(root, "foo", "notes.md"))).toBe(false)
    expect(exists(path.join(root, "foo", "SKILL.md"))).toBe(true)
  })

  it("删一个文件夹（连里面的内容）", async () => {
    write(path.join(root, "foo", "SKILL.md"))
    write(path.join(root, "foo", "scripts", "deep", "run.sh"))
    expect(await removeSkillEntryUnder(root, "foo", "scripts")).toEqual({ ok: true })
    expect(exists(path.join(root, "foo", "scripts"))).toBe(false)
    expect(exists(path.join(root, "foo", "SKILL.md"))).toBe(true)
  })

  it("文件不存在：如实说，不算成功", async () => {
    write(path.join(root, "foo", "SKILL.md"))
    expect(await removeSkillEntryUnder(root, "foo", "nope.md")).toEqual({ ok: false, error: "文件不存在" })
  })

  it("删不掉：返回失败和原因", async () => {
    write(path.join(root, "foo", "SKILL.md"))
    write(path.join(root, "foo", "scripts", "run.sh"))
    vi.spyOn(fs.promises, "rm").mockRejectedValue(Object.assign(new Error("busy"), { code: "EBUSY" }))
    const r = await removeSkillEntryUnder(root, "foo", "scripts")
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toContain("删不掉（EBUSY）")
  })

  it("Skill 里的文件夹是指向别处的链接：只删链接，指向的地方不动", async (ctx) => {
    write(path.join(base, "shared-refs", "a.md"), "共享资料")
    write(path.join(root, "foo", "SKILL.md"))
    if (!link(path.join(base, "shared-refs"), path.join(root, "foo", "references"))) return ctx.skip()
    expect(await removeSkillEntryUnder(root, "foo", "references")).toEqual({ ok: true })
    expect(exists(path.join(root, "foo", "references"))).toBe(false)
    expect(fs.readFileSync(path.join(base, "shared-refs", "a.md"), "utf-8")).toBe("共享资料")
  })

  // relativePath 为空或 "." 会指到 Skill 文件夹自己：整个 Skill 会被从「删文件」这个入口删掉
  it.each(["", ".", "./", "scripts/.."])("相对路径 %j 指到 Skill 文件夹自己：拒绝，Skill 完整保留", async (rel) => {
    write(path.join(root, "foo", "SKILL.md"))
    write(path.join(root, "foo", "scripts", "run.sh"))
    expect(await removeSkillEntryUnder(root, "foo", rel)).toEqual({ ok: false, error: "路径无效" })
    expect(exists(path.join(root, "foo", "SKILL.md"))).toBe(true)
    expect(exists(path.join(root, "foo", "scripts", "run.sh"))).toBe(true)
  })

  it.each(["../bar/SKILL.md", "../../sentinel.txt", "../foobar"])("越出 Skill 文件夹 %j：拒绝，别的 Skill 不动", async (rel) => {
    write(path.join(root, "foo", "SKILL.md"))
    write(path.join(root, "bar", "SKILL.md"))
    write(path.join(root, "foobar", "SKILL.md"))
    expect(await removeSkillEntryUnder(root, "foo", rel)).toEqual({ ok: false, error: "路径无效" })
    expect(exists(path.join(root, "bar", "SKILL.md"))).toBe(true)
    expect(exists(path.join(root, "foobar", "SKILL.md"))).toBe(true)
    expectRootIntact()
  })

  it("skillPath 本身指到根目录自己（空或 \".\"）：拒绝", async () => {
    write(path.join(root, "foo", "SKILL.md"))
    expect(await removeSkillEntryUnder(root, "", "foo")).toEqual({ ok: false, error: "路径无效" })
    expect(await removeSkillEntryUnder(root, ".", "foo")).toEqual({ ok: false, error: "路径无效" })
    expect(exists(path.join(root, "foo", "SKILL.md"))).toBe(true)
  })
})

describe("按根目录 id 的包装", () => {
  it("未知的根目录 id：拒绝，不会去删任何东西", async () => {
    expect(await deleteSkill("no-such-root", "foo")).toEqual({ ok: false, error: "路径无效" })
    expect(await deleteSkillEntry("no-such-root", "foo", "SKILL.md")).toEqual({ ok: false, error: "路径无效" })
  })
})
