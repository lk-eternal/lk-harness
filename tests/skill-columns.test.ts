import { createElement, type ReactElement, type ReactNode } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it, vi } from "vitest"
import { SkillFilesColumn, SkillListColumn, SkillRootColumn, type RootInfo } from "../src/renderer/components/skill/SkillColumns"
import { dirExpandKey } from "../src/renderer/components/skill-entry"

/** Skills 页「目录 → Skill → 文件」三列的渲染和回调（不需要 DOM：服务端渲染看 HTML，直接调函数组件取回调） */

type El = ReactElement<Record<string, unknown> & { children?: ReactNode }>

function findAll(node: ReactNode, pred: (el: El) => boolean, out: El[] = []): El[] {
  if (Array.isArray(node)) node.forEach((n) => findAll(n, pred, out))
  else if (node && typeof node === "object" && "props" in node) {
    const el = node as El
    if (pred(el)) out.push(el)
    findAll(el.props.children, pred, out)
  }
  return out
}
const byProp = (key: string, value?: unknown) => (el: El) => key in el.props && (value === undefined || el.props[key] === value)
const count = (html: string, needle: string) => html.split(needle).length - 1

const file = (name: string): SkillTreeNode => ({ name, type: "file" })
const dir = (name: string, children: SkillTreeNode[] = []): SkillTreeNode => ({ name, type: "directory", children })

const roots: RootInfo[] = [
  { id: "cursor", label: "~/.cursor/skills", path: "C:/Users/u/.cursor/skills", skillCount: 3 },
  { id: "claude", label: "~/.claude/skills", path: "C:/Users/u/.claude/skills", skillCount: 0 },
]

describe("SkillRootColumn（第一级：目录）", () => {
  it("每个目录一行：工具名、路径、Skill 数；当前目录带 aria-current，其他没有", () => {
    const html = renderToStaticMarkup(createElement(SkillRootColumn, { roots, rootId: "cursor", onSelect: vi.fn() }))
    expect(html).toContain("Cursor")
    expect(html).toContain("Claude Code")
    expect(html).toContain("~/.cursor/skills")
    expect(html).toContain(">3<")
    expect(html).toContain(">0<")
    expect(count(html, 'aria-current="true"')).toBe(1)
    expect(html).toMatch(/aria-current="true"[^>]*title="C:\/Users\/u\/\.cursor\/skills"|title="C:\/Users\/u\/\.cursor\/skills"[^>]*aria-current="true"/)
  })

  it("点一行带出它的 id；鼠标悬停能看到完整路径", () => {
    const onSelect = vi.fn()
    const rows = findAll(SkillRootColumn({ roots, rootId: "cursor", onSelect }), byProp("data-rail", "root"))
    expect(rows).toHaveLength(2)
    rows.forEach((r) => (r.props.onClick as () => void)())
    expect(onSelect.mock.calls).toEqual([["cursor"], ["claude"]])
    expect(rows[1].props.title).toBe("C:/Users/u/.claude/skills")
  })

  it("没有目录（读失败）时不报错", () => {
    expect(() => renderToStaticMarkup(createElement(SkillRootColumn, { roots: [], rootId: null, onSelect: vi.fn() }))).not.toThrow()
  })
})

describe("SkillListColumn（第二级：这个目录里的 Skill）", () => {
  const base = { root: roots[0], activeSkill: null, creating: false, onSelect: vi.fn(), onNew: vi.fn() }
  const skills = [
    { skillPath: "pdf", content: "---\nname: pdf\ndescription: 读写 PDF\n---\n" },
    { skillPath: "group/report", content: "# 周报\n每周五写" },
    { skillPath: "empty", content: "" },
  ]

  it("每个 Skill 一行：路径加一句话说明；没有说明的只有路径", () => {
    const html = renderToStaticMarkup(createElement(SkillListColumn, { ...base, skills }))
    expect(html).toContain("pdf")
    expect(html).toContain("读写 PDF")
    expect(html).toContain("group/report")
    expect(html).toContain("周报")
    expect(count(html, "data-skill=")).toBe(3)
    expect(count(html, "line-clamp-2")).toBe(2) // 只有两个有说明
  })

  it("标题是目录的工具名和路径", () => {
    const html = renderToStaticMarkup(createElement(SkillListColumn, { ...base, skills }))
    expect(html).toContain("Cursor")
    expect(html).toContain("~/.cursor/skills")
  })

  it("当前选中的带 aria-current；点一行带出它的路径", () => {
    const onSelect = vi.fn()
    const html = renderToStaticMarkup(createElement(SkillListColumn, { ...base, skills, activeSkill: "group/report" }))
    expect(count(html, 'aria-current="true"')).toBe(1)
    expect(html).toMatch(/data-skill="group\/report"[^>]*aria-current="true"|aria-current="true"[^>]*data-skill="group\/report"/)
    const rows = findAll(SkillListColumn({ ...base, skills, onSelect }), byProp("data-skill"))
    rows.forEach((r) => (r.props.onClick as () => void)())
    expect(onSelect.mock.calls).toEqual([["pdf"], ["group/report"], ["empty"]])
  })

  it("还在读时显示加载中，不显示「没有 Skill」", () => {
    const html = renderToStaticMarkup(createElement(SkillListColumn, { ...base, skills: null }))
    expect(html).toContain("加载中")
    expect(html).not.toContain("还没有 Skill")
  })

  it("目录是空的：给提示；正在新建时不提示，改成占位的一行", () => {
    const empty = renderToStaticMarkup(createElement(SkillListColumn, { ...base, skills: [] }))
    expect(empty).toContain("这个目录里还没有 Skill")
    const creating = renderToStaticMarkup(createElement(SkillListColumn, { ...base, skills: [], creating: true }))
    expect(creating).not.toContain("这个目录里还没有 Skill")
    expect(creating).toContain("新 Skill")
    expect(creating).toContain("正在创建")
    expect(count(creating, 'aria-current="true"')).toBe(1)
  })

  it("「新建 Skill」按钮一直在，点了调 onNew", () => {
    const onNew = vi.fn()
    for (const s of [null, [], skills]) expect(renderToStaticMarkup(createElement(SkillListColumn, { ...base, skills: s }))).toContain("新建 Skill")
    const btn = findAll(SkillListColumn({ ...base, skills, onNew }), (el) => el.type === "button" && JSON.stringify(el.props.children).includes("新建 Skill"))
    expect(btn).toHaveLength(1)
    ;(btn[0].props.onClick as () => void)()
    expect(onNew).toHaveBeenCalledTimes(1)
  })

  it("「返回」只在给了 onBack（目录列被收起）时出现，点了调它", () => {
    expect(renderToStaticMarkup(createElement(SkillListColumn, { ...base, skills }))).not.toContain("全部目录")
    const onBack = vi.fn()
    const html = renderToStaticMarkup(createElement(SkillListColumn, { ...base, skills, onBack }))
    expect(html).toContain("全部目录")
    const back = findAll(SkillListColumn({ ...base, skills, onBack }), byProp("label", "全部目录"))
    ;(back[0].props.onClick as () => void)()
    expect(onBack).toHaveBeenCalledTimes(1)
  })
})

describe("SkillFilesColumn（第三级：一个 Skill 里的文件）", () => {
  const tree: SkillTreeNode[] = [
    dir("my-skill", [file("SKILL.md"), dir("scripts", [file("run.sh")]), file("notes.md")]),
    dir("other", [file("SKILL.md"), file("other-only.txt")]),
  ]
  const base = {
    rootId: "cursor", skillPath: "my-skill", tree, expanded: new Set<string>(),
    skillMdActive: false, activeFile: null as string | null,
    onToggle: vi.fn(), onOpenSkillMd: vi.fn(), onOpenFile: vi.fn(), onCreate: vi.fn(), onDeleteFolder: vi.fn(),
  }

  it("标题是 Skill 路径；SKILL.md 单独占第一行，不在树里重复；只显示这个 Skill 的文件", () => {
    const html = renderToStaticMarkup(createElement(SkillFilesColumn, base))
    expect(html).toContain("my-skill")
    expect(html).toContain("notes.md")
    expect(html).toContain("scripts")
    expect(count(html, "SKILL.md")).toBe(1)
    expect(html).not.toContain("other-only.txt")
  })

  it("点 SKILL.md 那一行调 onOpenSkillMd；它在编辑区开着时带 aria-current", () => {
    const onOpenSkillMd = vi.fn()
    const [row] = findAll(SkillFilesColumn({ ...base, onOpenSkillMd }), byProp("data-leaf", "skill"))
    ;(row.props.onClick as () => void)()
    expect(onOpenSkillMd).toHaveBeenCalledTimes(1)
    expect(renderToStaticMarkup(createElement(SkillFilesColumn, base))).not.toContain("aria-current")
    expect(renderToStaticMarkup(createElement(SkillFilesColumn, { ...base, skillMdActive: true }))).toContain('aria-current="true"')
  })

  it("Skill 根目录下的「新建文件 / 新建文件夹」在标题行，建在根目录（父路径为空串）", () => {
    const onCreate = vi.fn()
    const btns = findAll(SkillFilesColumn({ ...base, onCreate }), (el) => typeof el.props.title === "string" && typeof el.props.onClick === "function")
    // 文件夹行里的按钮属于 SkillTreeList（它有自己的测试），这里只有标题行的两个
    expect(btns.map((b) => b.props.title)).toEqual(["新建文件", "新建文件夹"])
    btns.forEach((b) => (b.props.onClick as () => void)())
    expect(onCreate.mock.calls).toEqual([["file", ""], ["folder", ""]])
  })

  it("文件夹展开后里面的文件才出现；开着的文件高亮", () => {
    const closed = renderToStaticMarkup(createElement(SkillFilesColumn, base))
    expect(closed).not.toContain("run.sh")
    const open = renderToStaticMarkup(createElement(SkillFilesColumn, { ...base, expanded: new Set([dirExpandKey("cursor", "my-skill", "scripts")]), activeFile: "scripts/run.sh" }))
    expect(open).toContain("run.sh")
    expect(count(open, 'aria-current="true"')).toBe(1)
    expect(open).toMatch(/data-file="scripts\/run\.sh"[^>]*aria-current="true"|aria-current="true"[^>]*data-file="scripts\/run\.sh"/)
  })

  it("除了 SKILL.md 没有别的文件时给提示", () => {
    const html = renderToStaticMarkup(createElement(SkillFilesColumn, { ...base, skillPath: "lonely", tree: [dir("lonely", [file("SKILL.md")])] }))
    expect(html).toContain("没有别的文件")
    expect(renderToStaticMarkup(createElement(SkillFilesColumn, base))).not.toContain("没有别的文件")
  })

  it("树里还没有这个 Skill（刚建好、列表没读回来）也不报错", () => {
    expect(() => renderToStaticMarkup(createElement(SkillFilesColumn, { ...base, skillPath: "ghost" }))).not.toThrow()
  })

  it("「返回」只在给了 back 时出现，点了调它，文字是给的 label", () => {
    expect(renderToStaticMarkup(createElement(SkillFilesColumn, base))).not.toContain("全部 Skill")
    const onClick = vi.fn()
    const props = { ...base, back: { label: "全部 Skill", onClick } }
    expect(renderToStaticMarkup(createElement(SkillFilesColumn, props))).toContain("全部 Skill")
    const back = findAll(SkillFilesColumn(props), byProp("label", "全部 Skill"))
    ;(back[0].props.onClick as () => void)()
    expect(onClick).toHaveBeenCalledTimes(1)
  })
})
