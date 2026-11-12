import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
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
})
