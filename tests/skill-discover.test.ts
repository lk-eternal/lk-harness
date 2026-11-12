import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { discoverSkillPaths } from "../electron/skill-store"

/** 发现 Skill（目录里有 SKILL.md 的文件夹，含分类目录下的）。根目录由调用方传入，在临时目录里测。 */

let root: string

function write(file: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, "x", "utf-8")
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "skill-discover-"))
})
afterEach(async () => {
  await fs.promises.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
})

describe("discoverSkillPaths", () => {
  it("平铺的和分类目录下的都找得到，排好序；没有 SKILL.md 的目录不算", () => {
    write(path.join(root, "b-skill", "SKILL.md"))
    write(path.join(root, "a-skill", "SKILL.md"))
    write(path.join(root, "group", "inner", "SKILL.md"))
    write(path.join(root, "notes", "readme.txt"))
    expect(discoverSkillPaths(root)).toEqual(["a-skill", "b-skill", "group/inner"])
  })

  it("根目录不存在：返回空", () => {
    expect(discoverSkillPaths(path.join(root, "nope"))).toEqual([])
  })

  it("链接绕回自己的祖先目录：不会无限递归，其余 Skill 照常找到", () => {
    write(path.join(root, "foo", "SKILL.md"))
    try {
      fs.symlinkSync(root, path.join(root, "foo", "loop"), "junction")
    } catch {
      return // 这台机器建不了目录链接
    }
    expect(discoverSkillPaths(root)).toEqual(["foo"])
  })

  /** 建目录链接（Windows 用 junction，不需要管理员权限）；这台机器建不了就返回 false，调用方跳过 */
  function link(target: string, at: string): boolean {
    try {
      fs.mkdirSync(path.dirname(at), { recursive: true })
      fs.symlinkSync(target, at, "junction")
      return true
    } catch {
      return false
    }
  }

  it("链接指向兄弟目录、或根目录外的文件夹（不构成循环）：照常跟进去，按链接名找到", () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "skill-discover-out-"))
    try {
      write(path.join(root, "real", "SKILL.md"))
      write(path.join(outside, "SKILL.md"))
      if (!link(path.join(root, "real"), path.join(root, "alias"))) return
      if (!link(outside, path.join(root, "ext"))) return
      expect(discoverSkillPaths(root)).toEqual(["alias", "ext", "real"])
    } finally {
      fs.rmSync(outside, { recursive: true, force: true })
    }
  })

  it("失效的链接（指向的文件夹已经删了）：跳过，不报错，其余照常找到", () => {
    write(path.join(root, "skill", "SKILL.md"))
    const gone = path.join(root, "..", `gone-${path.basename(root)}`)
    fs.mkdirSync(gone)
    const ok = link(gone, path.join(root, "dead"))
    fs.rmdirSync(gone)
    if (!ok) return
    expect(discoverSkillPaths(root)).toEqual(["skill"])
  })

  it("链接绕回的是中间某一层祖先（不是根）：不无限递归，这一层和下一层都照常找到", () => {
    write(path.join(root, "a", "SKILL.md"))
    write(path.join(root, "a", "b", "SKILL.md"))
    if (!link(path.join(root, "a"), path.join(root, "a", "b", "up"))) return
    expect(discoverSkillPaths(root)).toEqual(["a", "a/b"])
  })

  it("两个文件夹互相链接：不无限递归，两边自己的 Skill 都找得到", () => {
    write(path.join(root, "x", "SKILL.md"))
    write(path.join(root, "y", "SKILL.md"))
    if (!link(path.join(root, "y"), path.join(root, "x", "to-y"))) return
    if (!link(path.join(root, "x"), path.join(root, "y", "to-x"))) return
    const found = discoverSkillPaths(root)
    expect(found).toContain("x")
    expect(found).toContain("y")
    expect(found.length).toBeLessThanOrEqual(4) // 最多每边再多一条经过链接的路径
  })

  it("普通文件夹不用问系统要真实路径：只有根目录和链接才要（每个文件夹都问一遍，目录一多就明显变慢）", () => {
    for (const d of ["a", "b", "c"]) for (const s of ["x", "y", "z"]) write(path.join(root, d, s, "SKILL.md"))
    const realpath = vi.spyOn(fs.realpathSync, "native")
    try {
      expect(discoverSkillPaths(root)).toHaveLength(9)
      expect(realpath).toHaveBeenCalledTimes(1) // 只有根目录

      realpath.mockClear()
      if (!link(path.join(root, "a"), path.join(root, "c", "to-a"))) return
      expect(discoverSkillPaths(root)).toHaveLength(12) // 链接指向的 a 下面三个，按链接名再出现一次
      expect(realpath).toHaveBeenCalledTimes(2) // 根目录 + 这一个链接
    } finally {
      realpath.mockRestore()
    }
  })
})
