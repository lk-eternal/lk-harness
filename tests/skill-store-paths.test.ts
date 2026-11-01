import * as os from "node:os"
import * as path from "node:path"
import { describe, expect, it } from "vitest"
import { resolveRootAbs, resolveSkillDir, resolveSkillFile } from "../electron/skill-store"
import { isPathInside } from "../src/shared/path-inside"

// 这些函数只做路径计算，不读磁盘；根目录取自 ~/.cursor/skills，测试里不创建任何文件
const ROOT = path.join(os.homedir(), ".cursor", "skills")

describe("resolveSkillDir：Skill 目录必须落在根目录之内", () => {
  it("根目录之内的 Skill 正常解析", () => {
    expect(resolveSkillDir("cursor", "my-skill")).toBe(path.join(ROOT, "my-skill"))
    expect(resolveSkillDir("cursor", "group/my-skill")).toBe(path.join(ROOT, "group", "my-skill"))
  })

  it("同名前缀的兄弟目录不能放行（skills-evil 不在 skills 里）", () => {
    expect(resolveSkillDir("cursor", "../skills-evil")).toBeUndefined()
    expect(resolveSkillDir("cursor", "../skills-evil/x")).toBeUndefined()
  })

  it("向上越出根目录的路径被拒绝", () => {
    expect(resolveSkillDir("cursor", "..")).toBeUndefined()
    expect(resolveSkillDir("cursor", "../../secret")).toBeUndefined()
    expect(resolveSkillDir("cursor", "a/../../x")).toBeUndefined()
  })

  it("绝对路径被拒绝，不会因为 path.resolve 的特性逃出去", () => {
    expect(resolveSkillDir("cursor", path.join(os.homedir(), "elsewhere"))).toBeUndefined()
  })

  it("路径里先下去再回到根目录之内仍然放行", () => {
    expect(resolveSkillDir("cursor", "a/../b")).toBe(path.join(ROOT, "b"))
  })

  it("未知的根目录 id 返回 undefined", () => {
    expect(resolveSkillDir("no-such-root", "x")).toBeUndefined()
    expect(resolveRootAbs("no-such-root")).toBeUndefined()
  })
})

describe("resolveSkillFile：文件必须落在所属 Skill 目录之内", () => {
  it("Skill 目录之内的文件正常解析", () => {
    expect(resolveSkillFile("cursor", "foo", "SKILL.md")).toBe(path.join(ROOT, "foo", "SKILL.md"))
    expect(resolveSkillFile("cursor", "foo", "refs/a.md")).toBe(path.join(ROOT, "foo", "refs", "a.md"))
  })

  it("同名前缀的兄弟 Skill 不能放行（foobar 不在 foo 里）", () => {
    expect(resolveSkillFile("cursor", "foo", "../foobar/SKILL.md")).toBeUndefined()
  })

  it("越出自己的 Skill 目录去到别的 Skill 也被拒绝", () => {
    expect(resolveSkillFile("cursor", "foo", "../bar/SKILL.md")).toBeUndefined()
    expect(resolveSkillFile("cursor", "foo", "../../x")).toBeUndefined()
  })

  it("Skill 目录本身不合法时直接返回 undefined", () => {
    expect(resolveSkillFile("cursor", "../skills-evil", "x")).toBeUndefined()
    expect(resolveSkillFile("no-such-root", "foo", "x")).toBeUndefined()
  })
})

describe("isPathInside（从 path-inside 直接引用）", () => {
  it("含自身、按路径边界比较", () => {
    const root = path.resolve("tmp-root", "skills")
    expect(isPathInside(root, root)).toBe(true)
    expect(isPathInside(root, path.join(root, "a", "b"))).toBe(true)
    expect(isPathInside(root, root + "-evil")).toBe(false)
    expect(isPathInside(root, path.join(root, ".."))).toBe(false)
  })
})
