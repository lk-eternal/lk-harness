import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { deleteHarnessSkill, listHarnessSkills, readHarnessSkill, saveHarnessSkill } from "../src/shared/skill-admin"
import { resolveSkillDirUnder } from "../src/shared/skill-dir-path"

/** base/skills 是 Skill 根目录；base 下的 outside/ 和 sentinel.txt 是「根目录以外」的东西，任何操作都不该碰 */
let base: string
let root: string

function write(file: string, content: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, content, "utf-8")
}

const skillMd = (desc: string, name = "x") => `---\nname: ${name}\ndescription: ${desc}\n---\n# 正文\n`

beforeEach(() => {
  base = fs.mkdtempSync(path.join(os.tmpdir(), "skill-admin-"))
  root = path.join(base, "skills")
  fs.mkdirSync(root, { recursive: true })
  write(path.join(base, "sentinel.txt"), "keep")
  write(path.join(base, "outside", "SKILL.md"), "outside skill")
})

afterEach(() => {
  vi.restoreAllMocks()
  fs.rmSync(base, { recursive: true, force: true })
})

/** 根目录外面的东西都还在 */
function expectOutsideUntouched(): void {
  expect(fs.readFileSync(path.join(base, "sentinel.txt"), "utf-8")).toBe("keep")
  expect(fs.readFileSync(path.join(base, "outside", "SKILL.md"), "utf-8")).toBe("outside skill")
  expect(fs.existsSync(root)).toBe(true)
}

/** 目录链接：Windows 用 junction（不需要管理员权限），其他系统是符号链接 */
function link(target: string, at: string): boolean {
  try {
    fs.mkdirSync(path.dirname(at), { recursive: true })
    fs.symlinkSync(target, at, "junction")
    return true
  } catch {
    return false
  }
}

describe("resolveSkillDirUnder", () => {
  it("合法名字解析到 root 下，支持 / 和 \\ 分层，首尾空白忽略", () => {
    expect(resolveSkillDirUnder(root, "foo")).toBe(path.join(root, "foo"))
    expect(resolveSkillDirUnder(root, "group/foo")).toBe(path.join(root, "group", "foo"))
    expect(resolveSkillDirUnder(root, "group\\foo")).toBe(path.join(root, "group", "foo"))
    expect(resolveSkillDirUnder(root, "  foo  ")).toBe(path.join(root, "foo"))
    expect(resolveSkillDirUnder(root, "中文 名字")).toBe(path.join(root, "中文 名字"))
  })

  it.each([
    "",
    "   ",
    ".",
    "..",
    "../outside",
    "a/../../outside",
    "a/..",
    "./foo",
    "foo/",
    "/foo",
    "//foo",
    "a//b",
    "..\\outside",
    "C:",
    "C:\\Windows",
    "C:foo",
    "/etc/passwd",
    "foo:bar",
    "foo\u0000bar",
    "foo\nbar",
  ])("拒绝 %j", (name) => {
    expect(resolveSkillDirUnder(root, name)).toBeNull()
  })

  it.each([undefined, null, 42, {}, ["a"]])("name 不是字符串（%j）也不抛错，直接拒绝", (name) => {
    expect(resolveSkillDirUnder(root, name as never)).toBeNull()
  })
})

describe("listHarnessSkills", () => {
  it("说明取 SKILL.md 的 description，不是 frontmatter 的 ---", () => {
    write(path.join(root, "weekly", "SKILL.md"), skillMd("写周报用的", "weekly"))
    expect(listHarnessSkills(root)).toEqual([{ name: "weekly", preview: "写周报用的" }])
  })

  it("没有 frontmatter：退回正文第一行；完全空文件：空说明", () => {
    write(path.join(root, "plain", "SKILL.md"), "# 直接写正文\n细节")
    write(path.join(root, "empty", "SKILL.md"), "")
    expect(listHarnessSkills(root)).toEqual([
      { name: "empty", preview: "" },
      { name: "plain", preview: "直接写正文" },
    ])
  })

  it("说明超过 100 字截断", () => {
    write(path.join(root, "long", "SKILL.md"), skillMd("长".repeat(300)))
    const [s] = listHarnessSkills(root)
    expect(s.preview).toBe(`${"长".repeat(100)}…`)
  })

  it("分层目录：列出的是带 SKILL.md 的那一层，名字带相对路径；分类目录本身不算", () => {
    write(path.join(root, "group", "a", "SKILL.md"), skillMd("甲"))
    write(path.join(root, "group", "b", "SKILL.md"), skillMd("乙"))
    expect(listHarnessSkills(root).map((s) => s.name)).toEqual(["group/a", "group/b"])
  })

  it("没有 SKILL.md 的目录不算 Skill", () => {
    write(path.join(root, "notes", "readme.txt"), "随手记的")
    write(path.join(root, "real", "SKILL.md"), skillMd("真的"))
    expect(listHarnessSkills(root).map((s) => s.name)).toEqual(["real"])
  })

  it("Skill 自己的子目录（scripts、references）里即使有 SKILL.md 也不是另一个 Skill", () => {
    write(path.join(root, "outer", "SKILL.md"), skillMd("外层"))
    write(path.join(root, "outer", "references", "inner", "SKILL.md"), skillMd("示例里的"))
    expect(listHarnessSkills(root).map((s) => s.name)).toEqual(["outer"])
  })

  it("根目录自己有 SKILL.md 不算 Skill（没有名字可言）", () => {
    write(path.join(root, "SKILL.md"), skillMd("根"))
    expect(listHarnessSkills(root)).toEqual([])
  })

  it("跳过 . 开头的目录和 node_modules", () => {
    write(path.join(root, ".hidden", "SKILL.md"), skillMd("藏起来"))
    write(path.join(root, "node_modules", "pkg", "SKILL.md"), skillMd("依赖"))
    write(path.join(root, "ok", "SKILL.md"), skillMd("好"))
    expect(listHarnessSkills(root).map((s) => s.name)).toEqual(["ok"])
  })

  it("按名字排序，与创建顺序无关", () => {
    for (const n of ["c", "a", "b"]) write(path.join(root, n, "SKILL.md"), skillMd(n))
    expect(listHarnessSkills(root).map((s) => s.name)).toEqual(["a", "b", "c"])
  })

  it("根目录不存在：空列表，不抛错", () => {
    expect(listHarnessSkills(path.join(base, "nope"))).toEqual([])
  })

  it("符号链接 / junction 指过去的 Skill 也列出来", (ctx) => {
    write(path.join(base, "elsewhere", "linked", "SKILL.md"), skillMd("链接过来的"))
    if (!link(path.join(base, "elsewhere", "linked"), path.join(root, "linked"))) return ctx.skip() // 当前环境建不了链接：明确标成跳过
    expect(listHarnessSkills(root)).toEqual([{ name: "linked", preview: "链接过来的" }])
  })

  it("链接指回上层造成循环：不会死循环，也不重复列", (ctx) => {
    write(path.join(root, "real", "SKILL.md"), skillMd("真"))
    if (!link(root, path.join(root, "group", "loop"))) return ctx.skip()
    expect(listHarnessSkills(root).map((s) => s.name)).toEqual(["real"])
  })
})

describe("readHarnessSkill", () => {
  it("读出内容；分层名字和反斜杠写法都行", () => {
    write(path.join(root, "group", "foo", "SKILL.md"), "内容 A")
    expect(readHarnessSkill(root, "group/foo")).toEqual({ ok: true, content: "内容 A" })
    expect(readHarnessSkill(root, "group\\foo")).toEqual({ ok: true, content: "内容 A" })
  })

  it("不存在、或目录里没有 SKILL.md：404", () => {
    fs.mkdirSync(path.join(root, "bare"))
    expect(readHarnessSkill(root, "missing")).toMatchObject({ ok: false, status: 404 })
    expect(readHarnessSkill(root, "bare")).toMatchObject({ ok: false, status: 404 })
  })

  it.each(["..", ".", "../outside", "a/../../outside", "/outside", path.join("..", "outside"), "C:\\x"])(
    "名字 %j 想读 root 外面或 root 自己：400，且不会把外面的内容读出来",
    (name) => {
      const r = readHarnessSkill(root, name)
      expect(r).toMatchObject({ ok: false, status: 400 })
      expect(JSON.stringify(r)).not.toContain("outside skill")
    },
  )

  it("绝对路径（指向 root 外的真实 Skill）被拒绝", () => {
    expect(readHarnessSkill(root, path.join(base, "outside"))).toMatchObject({ ok: false, status: 400 })
  })

  it("非法名字的报错里告诉 AI 怎么写", () => {
    const r = readHarnessSkill(root, "..")
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toContain("invalid name")
  })
})

describe("saveHarnessSkill", () => {
  it("新建：自动建目录，写 SKILL.md；再存是覆盖", () => {
    expect(saveHarnessSkill(root, "foo", "v1")).toEqual({ ok: true, message: "foo saved" })
    expect(fs.readFileSync(path.join(root, "foo", "SKILL.md"), "utf-8")).toBe("v1")
    expect(saveHarnessSkill(root, "foo", "v2").ok).toBe(true)
    expect(fs.readFileSync(path.join(root, "foo", "SKILL.md"), "utf-8")).toBe("v2")
  })

  it("分层名字建多级目录；提示里的名字去掉首尾空白", () => {
    expect(saveHarnessSkill(root, " group/foo ", "c")).toEqual({ ok: true, message: "group/foo saved" })
    expect(fs.readFileSync(path.join(root, "group", "foo", "SKILL.md"), "utf-8")).toBe("c")
  })

  it("保存后能被列出、被读出（三个操作对同一个名字口径一致）", () => {
    saveHarnessSkill(root, "group\\foo", skillMd("端到端"))
    expect(listHarnessSkills(root)).toEqual([{ name: "group/foo", preview: "端到端" }])
    expect(readHarnessSkill(root, "group/foo")).toMatchObject({ ok: true })
  })

  it.each(["..", ".", "../escaped", "a/../../escaped", "/escaped", "C:\\escaped", ""])(
    "名字 %j：400，什么都没写出去",
    (name) => {
      expect(saveHarnessSkill(root, name, "evil")).toMatchObject({ ok: false, status: 400 })
      expect(fs.existsSync(path.join(base, "escaped"))).toBe(false)
      expect(fs.existsSync(path.join(root, "SKILL.md"))).toBe(false)
      expect(fs.readdirSync(root)).toEqual([])
      expect(fs.readdirSync(base).sort()).toEqual(["outside", "sentinel.txt", "skills"])
    },
  )
})

describe("deleteHarnessSkill", () => {
  it("删掉整个 Skill 目录（含 scripts 等附带文件）", async () => {
    write(path.join(root, "foo", "SKILL.md"), "x")
    write(path.join(root, "foo", "scripts", "run.sh"), "echo")
    write(path.join(root, "keep", "SKILL.md"), "y")
    expect(await deleteHarnessSkill(root, "foo")).toEqual({ ok: true, message: "foo deleted" })
    expect(fs.existsSync(path.join(root, "foo"))).toBe(false)
    expect(fs.existsSync(path.join(root, "keep", "SKILL.md"))).toBe(true)
  })

  it("不存在：404", async () => {
    expect(await deleteHarnessSkill(root, "missing")).toMatchObject({ ok: false, status: 404 })
  })

  it("删不掉（被占用 / 没权限）：回 500 和原因，不能报成功", async () => {
    write(path.join(root, "busy", "SKILL.md"), "x")
    vi.spyOn(fs.promises, "rm").mockRejectedValue(Object.assign(new Error("operation not permitted"), { code: "EPERM" }))
    const r = await deleteHarnessSkill(root, "busy")
    expect(r).toMatchObject({ ok: false, status: 500 })
    if (!r.ok) expect(r.error).toContain("删不掉（EPERM）")
    expect(fs.existsSync(path.join(root, "busy", "SKILL.md"))).toBe(true)
  })

  it("名字写成分类目录（里面有别的 Skill）：不删，里面的 Skill 都还在", async () => {
    write(path.join(root, "group", "a", "SKILL.md"), "a")
    write(path.join(root, "group", "b", "SKILL.md"), "b")
    const r = await deleteHarnessSkill(root, "group")
    expect(r).toMatchObject({ ok: false, status: 400 })
    if (!r.ok) expect(r.error).toContain("not a skill")
    expect(fs.existsSync(path.join(root, "group", "a", "SKILL.md"))).toBe(true)
    expect(fs.existsSync(path.join(root, "group", "b", "SKILL.md"))).toBe(true)
  })

  it("分层 Skill 删的是最里面那层，分类目录留着", async () => {
    write(path.join(root, "group", "a", "SKILL.md"), "a")
    write(path.join(root, "group", "b", "SKILL.md"), "b")
    expect((await deleteHarnessSkill(root, "group/a")).ok).toBe(true)
    expect(fs.existsSync(path.join(root, "group", "a"))).toBe(false)
    expect(fs.existsSync(path.join(root, "group", "b", "SKILL.md"))).toBe(true)
  })

  it.each(["..", ".", "", "   ", "../outside", "a/../../outside", "/outside", "C:\\outside"])(
    "名字 %j 指到 root 外面或 root 自己：400，root 里外的东西一个不少",
    async (name) => {
      write(path.join(root, "a", "SKILL.md"), "a")
      write(path.join(root, "SKILL.md"), "root skill md") // 即使 root 自己有 SKILL.md 也不能被当成可删的 Skill
      expect(await deleteHarnessSkill(root, name)).toMatchObject({ ok: false, status: 400 })
      expect(fs.existsSync(path.join(root, "a", "SKILL.md"))).toBe(true)
      expect(fs.existsSync(path.join(root, "SKILL.md"))).toBe(true)
      expectOutsideUntouched()
    },
  )

  it("绝对路径指向 root 外的真实 Skill：不删", async () => {
    expect(await deleteHarnessSkill(root, path.join(base, "outside"))).toMatchObject({ ok: false, status: 400 })
    expectOutsideUntouched()
  })

  // 这条跑在普通 Node 里；在应用实际用的 Electron Node 里是否真的不越界，见 safe-remove-electron.test.ts
  it("链接过来的 Skill：删的只是链接，原目录里的文件不能丢，回复里说明是链接", async (ctx) => {
    write(path.join(base, "elsewhere", "linked", "SKILL.md"), "原件")
    write(path.join(base, "elsewhere", "linked", "scripts", "run.sh"), "原件脚本")
    if (!link(path.join(base, "elsewhere", "linked"), path.join(root, "linked"))) return ctx.skip()
    const r = await deleteHarnessSkill(root, "linked")
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.message).toBe("linked deleted（这是链接，只删了链接，原目录没动）")
    expect(fs.existsSync(path.join(root, "linked"))).toBe(false)
    expect(fs.readFileSync(path.join(base, "elsewhere", "linked", "SKILL.md"), "utf-8")).toBe("原件")
    expect(fs.readFileSync(path.join(base, "elsewhere", "linked", "scripts", "run.sh"), "utf-8")).toBe("原件脚本")
  })
})
