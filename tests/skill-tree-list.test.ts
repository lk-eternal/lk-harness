import { createElement, type ReactElement, type ReactNode } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it, vi } from "vitest"
import SkillTreeList from "../src/renderer/components/SkillTreeList"
import { ancestorExpandKeys, dirExpandKey, skillExpandKey } from "../src/renderer/components/skill-entry"

/**
 * 回归：Skill 管理页在 2026-08 的重构里换成了 SkillPanel，旧页面的「新建文件 / 新建文件夹」
 * 入口没带过去，之后没人发现——所以这里盯住「每一行有哪些按钮」。
 */

const file = (name: string): SkillTreeNode => ({ name, type: "file" })
const dir = (name: string, children: SkillTreeNode[] = []): SkillTreeNode => ({ name, type: "directory", children })

const ROOT = "cursor"
const skills = [{ skillPath: "my-skill", name: "my-skill" }]
const tree: SkillTreeNode[] = [
  dir("my-skill", [file("SKILL.md"), dir("scripts", [file("run.sh"), dir("lib", [file("deep.txt")])])]),
]

function makeProps(expanded: string[]) {
  return {
    rootId: ROOT,
    skills,
    tree,
    expanded: new Set(expanded),
    activeSkillPath: null,
    onToggle: vi.fn(),
    onSelectSkill: vi.fn(),
    onOpenFile: vi.fn(),
    onCreate: vi.fn(),
    onDeleteFolder: vi.fn(),
  }
}

const OPEN_SKILL_AND_SCRIPTS = [skillExpandKey(ROOT, "my-skill"), dirExpandKey(ROOT, "my-skill", "scripts")]

const count = (html: string, needle: string) => html.split(needle).length - 1

/** 按渲染顺序收集所有带 title 的操作按钮元素（不需要 DOM：SkillTreeList 是纯函数组件） */
function collectActions(node: ReactNode, out: { title: string; onClick: () => void }[] = []) {
  if (Array.isArray(node)) node.forEach((n) => collectActions(n, out))
  else if (node && typeof node === "object" && "props" in node) {
    const el = node as ReactElement<{ title?: string; onClick?: () => void; children?: ReactNode }>
    if (typeof el.props.title === "string" && typeof el.props.onClick === "function") out.push({ title: el.props.title, onClick: el.props.onClick })
    collectActions(el.props.children, out)
  }
  return out
}

function textOf(node: ReactNode): string {
  if (typeof node === "string" || typeof node === "number") return String(node)
  if (Array.isArray(node)) return node.map(textOf).join("")
  if (node && typeof node === "object" && "props" in node) return textOf((node as ReactElement<{ children?: ReactNode }>).props.children)
  return ""
}

/** 找到文字里包含 text 的 <button> 的 onClick */
function findButtonClick(node: ReactNode, text: string): (() => void) | undefined {
  if (Array.isArray(node)) {
    for (const n of node) { const f = findButtonClick(n, text); if (f) return f }
    return undefined
  }
  if (node && typeof node === "object" && "props" in node) {
    const el = node as ReactElement<{ onClick?: () => void; children?: ReactNode }>
    if (el.type === "button" && el.props.onClick && textOf(el.props.children).includes(text)) return el.props.onClick
    return findButtonClick(el.props.children, text)
  }
  return undefined
}

describe("SkillTreeList 的行内按钮", () => {
  it("Skill 行、每个文件夹行都有「新建文件」和「新建文件夹」，文件行没有", () => {
    const html = renderToStaticMarkup(createElement(SkillTreeList, makeProps(OPEN_SKILL_AND_SCRIPTS)))
    // 可见的行：my-skill、SKILL.md、scripts、run.sh、lib（lib 没展开，deep.txt 不渲染）
    expect(html).toContain("my-skill")
    expect(html).toContain("run.sh")
    expect(html).not.toContain("deep.txt")
    // 带按钮的行 = Skill 行 + scripts + lib = 3
    expect(count(html, 'title="新建文件"')).toBe(3)
    expect(count(html, 'title="新建文件夹"')).toBe(3)
  })

  it("「删除文件夹」只在文件夹行上，Skill 行没有（整个 Skill 的删除在编辑器里）", () => {
    const html = renderToStaticMarkup(createElement(SkillTreeList, makeProps(OPEN_SKILL_AND_SCRIPTS)))
    expect(count(html, 'title="删除文件夹"')).toBe(2)
  })

  it("Skill 没展开时只有它自己那一行的两个按钮", () => {
    const html = renderToStaticMarkup(createElement(SkillTreeList, makeProps([])))
    expect(count(html, 'title="新建文件"')).toBe(1)
    expect(count(html, 'title="新建文件夹"')).toBe(1)
    expect(html).not.toContain("删除文件夹")
    expect(html).not.toContain("SKILL.md")
  })

  it("按钮默认藏着，悬停或键盘聚焦到该行才显示，且浮在行尾不占名字的宽度", () => {
    const html = renderToStaticMarkup(createElement(SkillTreeList, makeProps(OPEN_SKILL_AND_SCRIPTS)))
    expect(html).toContain("group-hover:flex")
    expect(html).toContain("group-focus-within:flex")
    expect(html).toContain("absolute")
    expect(html).toContain("hidden")
  })

  it("每个按钮都有 aria-label，读屏和测试都能按名字找到", () => {
    const html = renderToStaticMarkup(createElement(SkillTreeList, makeProps(OPEN_SKILL_AND_SCRIPTS)))
    expect(count(html, 'aria-label="新建文件"')).toBe(3)
  })
})

describe("SkillTreeList 的回调参数", () => {
  it("每个按钮带的是自己所在行的 skillPath 和父路径", () => {
    const props = makeProps([...OPEN_SKILL_AND_SCRIPTS, dirExpandKey(ROOT, "my-skill", "scripts/lib")])
    const actions = collectActions(SkillTreeList(props))
    expect(actions.map((a) => a.title)).toEqual([
      "新建文件", "新建文件夹", // my-skill
      "新建文件", "新建文件夹", "删除文件夹", // scripts
      "新建文件", "新建文件夹", "删除文件夹", // scripts/lib
    ])
    actions.forEach((a) => a.onClick())
    expect(props.onCreate.mock.calls).toEqual([
      ["file", "my-skill", ""],
      ["folder", "my-skill", ""],
      ["file", "my-skill", "scripts"],
      ["folder", "my-skill", "scripts"],
      ["file", "my-skill", "scripts/lib"],
      ["folder", "my-skill", "scripts/lib"],
    ])
    expect(props.onDeleteFolder.mock.calls).toEqual([
      ["my-skill", "scripts"],
      ["my-skill", "scripts/lib"],
    ])
  })

  it("点文件：带完整的相对路径；点文件夹行：切换展开；点 Skill 名：选中它", () => {
    const props = makeProps([...OPEN_SKILL_AND_SCRIPTS, dirExpandKey(ROOT, "my-skill", "scripts/lib")])
    const out = SkillTreeList(props)
    findButtonClick(out, "run.sh")?.()
    findButtonClick(out, "deep.txt")?.()
    expect(props.onOpenFile.mock.calls).toEqual([
      ["my-skill", "scripts/run.sh"],
      ["my-skill", "scripts/lib/deep.txt"],
    ])
    findButtonClick(out, "lib")?.()
    expect(props.onToggle).toHaveBeenLastCalledWith(dirExpandKey(ROOT, "my-skill", "scripts/lib"))
  })

  it("新建后要展开的 key，和列表实际使用的 key 一致（建在深层，路径上的每一层都展开，新东西立刻可见）", () => {
    // 模拟：在 my-skill/scripts/lib 下新建 x/y.txt，面板会展开这些祖先
    const keys = ancestorExpandKeys(ROOT, "my-skill", "scripts/lib/x/y.txt")
    const tree2: SkillTreeNode[] = [dir("my-skill", [dir("scripts", [dir("lib", [dir("x", [file("y.txt")])])])])]
    const html = renderToStaticMarkup(createElement(SkillTreeList, { ...makeProps(keys), tree: tree2 }))
    expect(html).toContain("y.txt")
  })
})
