import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import {
  collectSkillCatalogRoots,
  computeSkillCatalog,
  getSkillCatalog,
  resetSkillCatalogCache,
} from "../electron/skill-catalog"
import { SKILL_DESC_MAX } from "../src/shared/skill-catalog"

/** 临时 HOME：Skill 目录是 HOME 下固定的五个位置 */
let home: string
const SAVED_ENV = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE }

const dirOf = {
  cursor: () => path.join(home, ".cursor", "skills"),
  agents: () => path.join(home, ".agents", "skills"),
  pi: () => path.join(home, ".pi", "agent", "skills"),
  claude: () => path.join(home, ".claude", "skills"),
  codex: () => path.join(home, ".codex", "skills"),
}

function put(root: string, folder: string, md: string): void {
  const file = path.join(root, folder, "SKILL.md")
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, md, "utf-8")
}

const md = (fm: Record<string, string>, body = "# 正文\n") =>
  `---\n${Object.entries(fm).map(([k, v]) => `${k}: ${v}`).join("\n")}\n---\n${body}`

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "skill-scan-"))
  resetSkillCatalogCache()
})

afterEach(() => {
  process.env.HOME = SAVED_ENV.HOME
  process.env.USERPROFILE = SAVED_ENV.USERPROFILE
  if (SAVED_ENV.HOME === undefined) delete process.env.HOME
  if (SAVED_ENV.USERPROFILE === undefined) delete process.env.USERPROFILE
  resetSkillCatalogCache()
  fs.rmSync(home, { recursive: true, force: true })
})

describe("collectSkillCatalogRoots", () => {
  it("按设置页的顺序给出五个目录：cursor、agents、pi、claude、codex；没有 Skill 的目录也在，只是空的", () => {
    put(dirOf.pi(), "p", md({ name: "p", description: "pi 的" }))
    const roots = collectSkillCatalogRoots(home)
    expect(roots.map((r) => r.dir)).toEqual([dirOf.cursor(), dirOf.agents(), dirOf.pi(), dirOf.claude(), dirOf.codex()].map((d) => path.resolve(d)))
    expect(roots.map((r) => r.skills.length)).toEqual([0, 0, 1, 0, 0])
  })

  it("名字取 frontmatter 的 name，没写就是文件夹名；分层的 Skill 保留相对路径", () => {
    put(dirOf.cursor(), "folder-a", md({ name: "显示名", description: "甲" }))
    put(dirOf.cursor(), "folder-b", md({ description: "乙" }))
    put(dirOf.cursor(), "group/inner", md({ description: "丙" }))
    const skills = collectSkillCatalogRoots(home)[0].skills
    expect(skills).toEqual([
      { name: "显示名", folder: "folder-a", description: "甲" },
      { name: "folder-b", folder: "folder-b", description: "乙" },
      { name: "group/inner", folder: "group/inner", description: "丙" },
    ])
  })

  it("声明了 disable-model-invocation: true 的 Skill 不列（它们只想被人手动调用）；写 false 的照常列", () => {
    put(dirOf.agents(), "manual-only", md({ name: "manual-only", description: "手动", "disable-model-invocation": "true" }))
    put(dirOf.agents(), "auto", md({ name: "auto", description: "自动", "disable-model-invocation": "false" }))
    expect(collectSkillCatalogRoots(home)[1].skills.map((s) => s.name)).toEqual(["auto"])
  })

  it("SKILL.md 读不了、或目录里没有 SKILL.md 的不列", () => {
    fs.mkdirSync(path.join(dirOf.cursor(), "no-md"), { recursive: true })
    put(dirOf.cursor(), "ok", md({ description: "好" }))
    expect(collectSkillCatalogRoots(home)[0].skills.map((s) => s.name)).toEqual(["ok"])
  })

  it("文件很大也只读开头：frontmatter 在前面就够，正文再长也不影响", () => {
    put(dirOf.cursor(), "big", md({ name: "big", description: "开头就有说明" }, `${"很长的正文\n".repeat(200_000)}`))
    expect(collectSkillCatalogRoots(home)[0].skills).toEqual([{ name: "big", folder: "big", description: "开头就有说明" }])
  })

  it("某个目录读不了（比如它其实是个文件）：当作没有，其他目录照常", () => {
    fs.mkdirSync(path.dirname(dirOf.cursor()), { recursive: true })
    fs.writeFileSync(dirOf.cursor(), "我是个文件，不是目录")
    put(dirOf.agents(), "fine", md({ description: "好的" }))
    const roots = collectSkillCatalogRoots(home)
    expect(roots[0].skills).toEqual([])
    expect(roots[1].skills.map((s) => s.name)).toEqual(["fine"])
  })

  it("一个 Skill 目录都没有：不报错，各目录都是空", () => {
    expect(collectSkillCatalogRoots(home).every((r) => r.skills.length === 0)).toBe(true)
  })
})

describe("computeSkillCatalog", () => {
  it("没有任何 Skill：空文本、空 hash、数量 0（不注入）", () => {
    expect(computeSkillCatalog(home)).toEqual({ text: "", hash: "", count: 0 })
  })

  it("同名 Skill 只列一次，先出现的目录赢（cursor > agents > pi > claude > codex）", () => {
    put(dirOf.claude(), "shared", md({ name: "shared", description: "来自 claude" }))
    put(dirOf.cursor(), "shared", md({ name: "shared", description: "来自 cursor" }))
    put(dirOf.codex(), "shared", md({ name: "shared", description: "来自 codex" }))
    const c = computeSkillCatalog(home)
    expect(c.count).toBe(1)
    expect(c.text).toContain("来自 cursor")
    expect(c.text).not.toContain("来自 claude")
    expect(c.text).not.toContain("来自 codex")
    expect(c.text).not.toContain(dirOf.claude()) // 去重后整个目录都没剩下就不写
  })

  it("说明读得很长，进名单时按 120 字截断", () => {
    put(dirOf.cursor(), "wordy", md({ name: "wordy", description: "话".repeat(900) }))
    const { text } = computeSkillCatalog(home)
    expect(text).toContain(`- wordy：${"话".repeat(SKILL_DESC_MAX)}…`)
    expect(text).not.toContain("话".repeat(SKILL_DESC_MAX + 1))
  })

  it("目录路径写进名单（AI 才知道去哪读完整 SKILL.md）", () => {
    put(dirOf.pi(), "x", md({ description: "x" }))
    expect(computeSkillCatalog(home).text).toContain(`### ${path.resolve(dirOf.pi())}`)
  })

  describe("hash：名单变了才变（拿它判断 AI 手里那份过期没有）", () => {
    it("同样的内容反复算，hash 一样；12 位十六进制", () => {
      put(dirOf.cursor(), "a", md({ description: "甲" }))
      const h1 = computeSkillCatalog(home).hash
      const h2 = computeSkillCatalog(home).hash
      expect(h1).toBe(h2)
      expect(h1).toMatch(/^[0-9a-f]{12}$/)
    })

    it("文件被 touch（只改修改时间）：hash 不变，不会因此重发名单", () => {
      put(dirOf.cursor(), "a", md({ description: "甲" }))
      const before = computeSkillCatalog(home).hash
      const file = path.join(dirOf.cursor(), "a", "SKILL.md")
      const future = new Date(Date.now() + 3600_000)
      fs.utimesSync(file, future, future)
      expect(computeSkillCatalog(home).hash).toBe(before)
    })

    it("只改了 SKILL.md 的正文（名单里没有正文）：hash 不变", () => {
      put(dirOf.cursor(), "a", md({ description: "甲" }, "# 正文一\n"))
      const before = computeSkillCatalog(home).hash
      put(dirOf.cursor(), "a", md({ description: "甲" }, "# 完全不同的正文\n更多\n"))
      expect(computeSkillCatalog(home).hash).toBe(before)
    })

    it("改说明、加 Skill、删 Skill、改名：hash 都变", () => {
      put(dirOf.cursor(), "a", md({ name: "a", description: "甲" }))
      const h0 = computeSkillCatalog(home).hash

      put(dirOf.cursor(), "a", md({ name: "a", description: "甲改了" }))
      const h1 = computeSkillCatalog(home).hash
      expect(h1).not.toBe(h0)

      put(dirOf.cursor(), "b", md({ name: "b", description: "乙" }))
      const h2 = computeSkillCatalog(home).hash
      expect(h2).not.toBe(h1)

      put(dirOf.cursor(), "a", md({ name: "a2", description: "甲改了" }))
      const h3 = computeSkillCatalog(home).hash
      expect(h3).not.toBe(h2)

      fs.rmSync(path.join(dirOf.cursor(), "b"), { recursive: true })
      expect(computeSkillCatalog(home).hash).not.toBe(h3)
    })

    it("新增一个被隐藏的 Skill（disable-model-invocation）：名单没变，hash 不变", () => {
      put(dirOf.cursor(), "a", md({ description: "甲" }))
      const before = computeSkillCatalog(home).hash
      put(dirOf.agents(), "manual", md({ description: "手动", "disable-model-invocation": "true" }))
      expect(computeSkillCatalog(home).hash).toBe(before)
    })

    it("被同名遮住的 Skill 改了说明：名单没变，hash 不变", () => {
      put(dirOf.cursor(), "dup", md({ name: "dup", description: "赢的" }))
      put(dirOf.claude(), "dup", md({ name: "dup", description: "输的" }))
      const before = computeSkillCatalog(home).hash
      put(dirOf.claude(), "dup", md({ name: "dup", description: "输的，改了" }))
      expect(computeSkillCatalog(home).hash).toBe(before)
    })
  })
})

describe("getSkillCatalog：拉起会话时用，短时间内复用上一次的扫描", () => {
  function pointHomeAt(dir: string): void {
    process.env.HOME = dir
    process.env.USERPROFILE = dir
    expect(os.homedir()).toBe(dir) // 这个测试依赖 os.homedir() 跟着环境变量走
  }

  it("10 秒内复用缓存（磁盘变了也先不看）；过了 10 秒重新扫", () => {
    pointHomeAt(home)
    put(dirOf.cursor(), "a", md({ name: "a", description: "甲" }))
    const first = getSkillCatalog(1_000)
    expect(first.count).toBe(1)

    put(dirOf.cursor(), "b", md({ name: "b", description: "乙" }))
    expect(getSkillCatalog(1_000 + 9_999).count).toBe(1) // 还在缓存期
    const later = getSkillCatalog(1_000 + 10_000)
    expect(later.count).toBe(2)
    expect(later.hash).not.toBe(first.hash)
  })

  it("resetSkillCatalogCache 之后立刻重新扫", () => {
    pointHomeAt(home)
    put(dirOf.cursor(), "a", md({ description: "甲" }))
    expect(getSkillCatalog(5).count).toBe(1)
    put(dirOf.cursor(), "b", md({ description: "乙" }))
    resetSkillCatalogCache()
    expect(getSkillCatalog(6).count).toBe(2)
  })

  it("没有任何 Skill：缓存的也是「空」，调用方据此不注入", () => {
    pointHomeAt(home)
    expect(getSkillCatalog(1)).toEqual({ text: "", hash: "", count: 0 })
  })
})
