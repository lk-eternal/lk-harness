import { describe, expect, it } from "vitest"
import {
  ancestorExpandKeys,
  dirExpandKey,
  findEntryConflict,
  isSameOrInside,
  joinEntryPath,
  locationLabel,
  skillExpandKey,
  validateEntryName,
} from "../src/renderer/components/skill-entry"

const file = (name: string): SkillTreeNode => ({ name, type: "file" })
const dir = (name: string, children: SkillTreeNode[] = []): SkillTreeNode => ({ name, type: "directory", children })

describe("validateEntryName", () => {
  it("正常名字原样通过，前后空格去掉", () => {
    expect(validateEntryName("utils.py")).toEqual({ ok: true, name: "utils.py" })
    expect(validateEntryName("  a.txt  ")).toEqual({ ok: true, name: "a.txt" })
    expect(validateEntryName(".gitignore")).toEqual({ ok: true, name: ".gitignore" })
    expect(validateEntryName("中文 说明.md")).toEqual({ ok: true, name: "中文 说明.md" })
  })

  it("用 / 一次建多层，反斜杠当成 /", () => {
    expect(validateEntryName("scripts/run.sh")).toEqual({ ok: true, name: "scripts/run.sh" })
    expect(validateEntryName("scripts\\lib\\x.py")).toEqual({ ok: true, name: "scripts/lib/x.py" })
  })

  it.each(["", "   "])("空名字被拒绝：%j", (raw) => {
    expect(validateEntryName(raw).ok).toBe(false)
  })

  it.each(["a//b", "/abs", "a/", "../x", "a/../b", "..", ".", "a/./b"])("空路径段、. 和 .. 被拒绝（防止逃出 Skill 目录）：%j", (raw) => {
    expect(validateEntryName(raw).ok).toBe(false)
  })

  it.each(["a:b", "C:/x", 'a"b', "a|b", "a?b", "a*b", "a<b", "a>b", "a\u0001b"])("跨平台非法字符被拒绝：%j", (raw) => {
    expect(validateEntryName(raw).ok).toBe(false)
  })

  it.each(["con", "NUL.txt", "com1", "lpt9.log", "x/CON/y", "Aux"])("Windows 保留名被拒绝（写了不会报错也不会落盘）：%j", (raw) => {
    expect(validateEntryName(raw).ok).toBe(false)
  })

  it("长得像保留名但不是的照常放行", () => {
    for (const ok of ["console.log", "company.md", "com10", "auxiliary", "nullable.ts"]) {
      expect(validateEntryName(ok).ok, ok).toBe(true)
    }
  })

  it.each(["a.", "x/b /y", "x/b./y"])("以点或空格结尾的路径段被拒绝（Windows 会悄悄去掉；整个输入前后的空格则只是被 trim）：%j", (raw) => {
    expect(validateEntryName(raw).ok).toBe(false)
  })

  it("错误文案能直接给用户看：.. 给的是「不能有 . 或 ..」，而不是笼统的「以点结尾」", () => {
    for (const raw of ["../x", "a/..", ".."]) {
      const r = validateEntryName(raw)
      expect(r.ok, raw).toBe(false)
      if (!r.ok) expect(r.error, raw).toContain("不能有 . 或 ..")
    }
    const r = validateEntryName("a:b")
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toContain("不能包含")
  })
})

describe("findEntryConflict", () => {
  const tree = [file("SKILL.md"), dir("scripts", [file("run.sh"), dir("lib")])]

  it("不存在的名字可以建", () => {
    expect(findEntryConflict(tree, "new.md")).toBeNull()
    expect(findEntryConflict(tree, "scripts/new.sh")).toBeNull()
    expect(findEntryConflict(tree, "scripts/lib/x")).toBeNull()
    // 中间的目录也不存在：整串都是新的
    expect(findEntryConflict(tree, "a/b/c")).toBeNull()
  })

  it("同名文件、同名文件夹都算冲突，并指出是哪一种", () => {
    expect(findEntryConflict(tree, "SKILL.md")).toContain("同名文件")
    expect(findEntryConflict(tree, "scripts")).toContain("同名文件夹")
    expect(findEntryConflict(tree, "scripts/run.sh")).toContain("同名文件")
    expect(findEntryConflict(tree, "scripts/lib")).toContain("同名文件夹")
  })

  it("大小写不同也算冲突（Windows / macOS 文件系统不分大小写，否则会被悄悄覆盖）", () => {
    expect(findEntryConflict(tree, "skill.md")).not.toBeNull()
    expect(findEntryConflict(tree, "Scripts/RUN.SH")).not.toBeNull()
  })

  it("要建在一个文件下面时拒绝", () => {
    expect(findEntryConflict(tree, "SKILL.md/x")).toContain("是文件")
    expect(findEntryConflict(tree, "scripts/run.sh/deep/x")).toContain("scripts/run.sh")
  })

  it("Skill 下还没有内容（children 为空或 undefined）时不冲突", () => {
    expect(findEntryConflict(undefined, "a.md")).toBeNull()
    expect(findEntryConflict([], "a/b.md")).toBeNull()
  })
})

describe("展开状态的 key", () => {
  it("Skill 和文件夹的 key 格式固定", () => {
    expect(skillExpandKey("cursor", "my-skill")).toBe("cursor:my-skill")
    expect(dirExpandKey("cursor", "my-skill", "scripts/lib")).toBe("cursor:my-skill/scripts/lib")
  })

  it("建完之后展开所有祖先，不含新建的这一项本身", () => {
    expect(ancestorExpandKeys("cursor", "s", "x.md")).toEqual(["cursor:s"])
    expect(ancestorExpandKeys("cursor", "s", "a/b/c.txt")).toEqual(["cursor:s", "cursor:s/a", "cursor:s/a/b"])
  })

  it("joinEntryPath：父路径为空时不带前导斜杠", () => {
    expect(joinEntryPath("", "a")).toBe("a")
    expect(joinEntryPath("x/y", "a")).toBe("x/y/a")
  })

  it("locationLabel：对话框里的位置恰好以一个 / 结尾（曾经建在根目录时显示成 my-skill//）", () => {
    expect(locationLabel("my-skill", "")).toBe("my-skill/")
    expect(locationLabel("my-skill", "scripts")).toBe("my-skill/scripts/")
    expect(locationLabel("group/my-skill", "a/b")).toBe("group/my-skill/a/b/")
  })

  it("isSameOrInside：自己或在它下面，不误伤前缀相同的同级", () => {
    expect(isSameOrInside("a/b", "a/b")).toBe(true)
    expect(isSameOrInside("a/b/c.txt", "a/b")).toBe(true)
    expect(isSameOrInside("a/bc", "a/b")).toBe(false)
    expect(isSameOrInside("a", "a/b")).toBe(false)
  })
})
