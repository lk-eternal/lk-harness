import { describe, expect, it } from "vitest"
import {
  SKILLS_MID_PX,
  SKILLS_WIDE_PX,
  pickInitialRoot,
  rootDisplayName,
  skillSummary,
  skillsColumns,
  withoutSkillMd,
} from "../src/renderer/components/skill/skills-nav"
import { validateSkillPath } from "../src/renderer/components/skill-entry"

const file = (name: string): SkillTreeNode => ({ name, type: "file" })
const dir = (name: string, children: SkillTreeNode[] = []): SkillTreeNode => ({ name, type: "directory", children })

describe("skillsColumns：现在该显示哪几列", () => {
  it("没选 Skill：目录和 Skill 两列都在，不管多宽多窄（右边的编辑区是空的）", () => {
    for (const w of [0, 300, SKILLS_MID_PX - 1, SKILLS_MID_PX, SKILLS_WIDE_PX, 2000]) {
      expect(skillsColumns(w, false)).toEqual({ roots: true, skills: true, files: false, back: null })
    }
  })

  it("选了 Skill、够宽：目录、Skill、文件三列都在，不需要返回", () => {
    expect(skillsColumns(SKILLS_WIDE_PX, true)).toEqual({ roots: true, skills: true, files: true, back: null })
    expect(skillsColumns(1400, true)).toEqual({ roots: true, skills: true, files: true, back: null })
  })

  it("选了 Skill、中等宽度（应用默认窗口）：最左的目录列收起，Skill 列顶上能回到目录", () => {
    expect(skillsColumns(SKILLS_WIDE_PX - 1, true)).toEqual({ roots: false, skills: true, files: true, back: "roots" })
    expect(skillsColumns(750, true)).toEqual({ roots: false, skills: true, files: true, back: "roots" })
    expect(skillsColumns(SKILLS_MID_PX, true)).toEqual({ roots: false, skills: true, files: true, back: "roots" })
  })

  it("选了 Skill、很窄：只剩文件一列，文件列顶上能回到 Skill 列表", () => {
    expect(skillsColumns(SKILLS_MID_PX - 1, true)).toEqual({ roots: false, skills: false, files: true, back: "skills" })
    expect(skillsColumns(636, true)).toEqual({ roots: false, skills: false, files: true, back: "skills" })
  })

  it("宽度 0（页面被藏起来，量不到）不当成「很窄」，按默认窗口那一档", () => {
    expect(skillsColumns(0, true)).toEqual({ roots: false, skills: true, files: true, back: "roots" })
  })

  it("有「返回」时，被收起的那一级一定是返回的目的地；没有返回时三列齐全", () => {
    for (let w = 1; w <= 1600; w += 7) {
      const c = skillsColumns(w, true)
      expect(c.files).toBe(true) // 选了 Skill，文件列任何时候都在
      if (c.back === "roots") expect(c.roots).toBe(false)
      if (c.back === "skills") expect(c.skills).toBe(false)
      if (c.back === null) expect(c.roots && c.skills).toBe(true)
    }
  })

  it("阈值是递增的：窄 < 中 < 宽，收起的列只会随变窄而增加", () => {
    const hidden = (w: number) => { const c = skillsColumns(w, true); return [c.roots, c.skills].filter((x) => !x).length }
    expect(SKILLS_MID_PX).toBeLessThan(SKILLS_WIDE_PX)
    let prev = -1
    for (let w = 1600; w >= 1; w -= 5) {
      const n = hidden(w)
      expect(n).toBeGreaterThanOrEqual(prev)
      prev = n
    }
  })
})

describe("rootDisplayName / pickInitialRoot", () => {
  it("已知目录用工具名，不认识的用路径", () => {
    expect(rootDisplayName({ id: "cursor", label: "~/.cursor/skills" })).toBe("Cursor")
    expect(rootDisplayName({ id: "claude", label: "~/.claude/skills" })).toBe("Claude Code")
    expect(rootDisplayName({ id: "pi", label: "~/.pi/agent/skills" })).toBe("Pi")
    expect(rootDisplayName({ id: "future", label: "~/.future/skills" })).toBe("~/.future/skills")
  })

  it("第一次进来停在第一个有 Skill 的目录；都没有就第一个；没有目录就 null", () => {
    const r = (id: string, skillCount: number) => ({ id, label: id, skillCount })
    expect(pickInitialRoot([r("cursor", 0), r("agents", 2), r("pi", 5)])).toBe("agents")
    expect(pickInitialRoot([r("cursor", 0), r("agents", 0)])).toBe("cursor")
    expect(pickInitialRoot([r("cursor", 3), r("agents", 2)])).toBe("cursor")
    expect(pickInitialRoot([])).toBeNull()
  })
})

describe("skillSummary：列表里每个 Skill 的一句话说明", () => {
  it("取开头 --- 之间的 description", () => {
    expect(skillSummary("---\nname: pdf\ndescription: 读写 PDF 文件\n---\n\n# PDF\n正文")).toBe("读写 PDF 文件")
  })

  it("支持引号、CRLF、BOM", () => {
    expect(skillSummary('---\r\nname: a\r\ndescription: "带 : 冒号的说明"\r\n---\r\nbody')).toBe("带 : 冒号的说明")
    expect(skillSummary("---\ndescription: 'single quoted'\n---\n")).toBe("single quoted")
    expect(skillSummary("\uFEFF---\ndescription: 有 BOM\n---\n")).toBe("有 BOM")
  })

  it("支持 > 和 | 的多行写法，遇到下一个键停止", () => {
    expect(skillSummary("---\ndescription: >\n  第一行\n  第二行\nname: x\n---\n")).toBe("第一行 第二行")
    expect(skillSummary("---\ndescription: |-\n  行一\n\n  行二\nlicense: MIT\n---\n")).toBe("行一 行二")
  })

  it("description 排在别的键后面也找得到；键名要完整匹配（不把 description2 当成它）", () => {
    expect(skillSummary("---\nname: a\nversion: 1\ndescription: 在后面\n---\n")).toBe("在后面")
    expect(skillSummary("---\ndescription2: 不是\n---\n# 标题\n")).toBe("标题")
  })

  it("没有 description 就取正文第一行有内容的文字，标题的 # 去掉", () => {
    expect(skillSummary("# 发周报\n\n步骤如下")).toBe("发周报")
    expect(skillSummary("\n\n  直接是正文  \n后面")).toBe("直接是正文")
    expect(skillSummary("---\nname: a\n---\n\n## 第二级标题\n")).toBe("第二级标题")
  })

  it("description 为空时退回正文", () => {
    expect(skillSummary("---\ndescription:\nname: a\n---\n正文第一行")).toBe("正文第一行")
  })

  it("空内容、只有 frontmatter 都返回空串，不抛错", () => {
    expect(skillSummary("")).toBe("")
    expect(skillSummary("---\nname: a\n---\n")).toBe("")
    expect(skillSummary("---\n")).toBe("")
  })

  it("没有闭合的 --- 不当 frontmatter：按正文取（第一行 --- 跳过），且不死循环", () => {
    expect(skillSummary("---\ndescription: 没闭合\n正文")).toBe("description: 没闭合")
  })

  it("太长的说明截断，空白合并成一个空格", () => {
    const long = skillSummary(`---\ndescription: ${"很长".repeat(200)}\n---\n`)
    expect(long.length).toBeLessThanOrEqual(161)
    expect(long.endsWith("…")).toBe(true)
    expect(skillSummary("---\ndescription:   a   \t b  \n---\n")).toBe("a b")
  })
})

describe("withoutSkillMd：文件列表里 SKILL.md 单独占第一行", () => {
  it("去掉最上层的 SKILL.md，其余原样（含顺序）", () => {
    const out = withoutSkillMd([dir("scripts", [file("SKILL.md")]), file("SKILL.md"), file("notes.md")])
    expect(out.map((n) => n.name)).toEqual(["scripts", "notes.md"])
    // 子文件夹里同名的文件不动
    expect(out[0].children?.map((c) => c.name)).toEqual(["SKILL.md"])
  })

  it("名字是 SKILL.md 的文件夹不是 SKILL.md；大小写不同的是另一个文件", () => {
    expect(withoutSkillMd([dir("SKILL.md"), file("skill.md")]).map((n) => n.name)).toEqual(["SKILL.md", "skill.md"])
  })

  it("undefined 当成空", () => {
    expect(withoutSkillMd(undefined)).toEqual([])
  })
})

describe("validateSkillPath：新建 / 改名前的检查（保存会直接写 SKILL.md，重名会盖掉别人的）", () => {
  const existing = ["pdf", "Group/Report", "weekly"]

  it("正常路径通过，支持分层，反斜杠变 /，空格去掉", () => {
    expect(validateSkillPath("my-skill", existing, null)).toEqual({ ok: true, path: "my-skill" })
    expect(validateSkillPath("  team\\notes  ", existing, null)).toEqual({ ok: true, path: "team/notes" })
  })

  it("新建时和已有的重名被拒，大小写不敏感，并说出是哪个", () => {
    const r = validateSkillPath("PDF", existing, null)
    expect(r.ok).toBe(false)
    expect(!r.ok && r.error).toContain("pdf")
    expect(validateSkillPath("group/report", existing, null).ok).toBe(false)
  })

  it("改名时，改成别的 Skill 的路径被拒", () => {
    expect(validateSkillPath("pdf", existing, "weekly").ok).toBe(false)
  })

  it("和自己同名不算冲突（没改路径只改了内容）；只改大小写也放行给后面处理", () => {
    expect(validateSkillPath("pdf", existing, "pdf")).toEqual({ ok: true, path: "pdf" })
    expect(validateSkillPath("PDF", existing, "pdf")).toEqual({ ok: true, path: "PDF" })
  })

  it.each(["", "   ", "../x", "a/../b", "a//b", "/abs", "C:/x", "a*b", "con", "a."])("非法路径被拒绝：%j", (raw) => {
    expect(validateSkillPath(raw, existing, null).ok).toBe(false)
  })
})
