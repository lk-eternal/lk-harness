import { createElement, type ReactElement, type ReactNode } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it, vi } from "vitest"
import SkillTreeList from "../src/renderer/components/SkillTreeList"
import { ancestorExpandKeys, dirExpandKey } from "../src/renderer/components/skill-entry"

/**
 * 回归：Skill 管理页在 2026-08 的重构里换成了 SkillPanel，旧页面的「新建文件 / 新建文件夹」
 * 入口没带过去，之后没人发现——所以这里盯住「每一行有哪些按钮」。
 * 2026-11 改成「目录 → Skill → 文件」一级一级点：这个组件只管一个 Skill 里的文件树，
 * Skill 根目录下的新建按钮在文件列表的标题行（见 skill-columns.test.ts）。
 */

const file = (name: string): SkillTreeNode => ({ name, type: "file" })
const dir = (name: string, children: SkillTreeNode[] = []): SkillTreeNode => ({ name, type: "directory", children })

const ROOT = "cursor"
const SKILL = "my-skill"
/** my-skill 里除 SKILL.md 之外的内容 */
const nodes: SkillTreeNode[] = [dir("scripts", [file("run.sh"), dir("lib", [file("deep.txt")])]), file("notes.md")]

function makeProps(expanded: string[], activeFile: string | null = null) {
  return {
    rootId: ROOT,
    skillPath: SKILL,
    nodes,
    expanded: new Set(expanded),
    activeFile,
    onToggle: vi.fn(),
    onOpenFile: vi.fn(),
    onCreate: vi.fn(),
    onDeleteFolder: vi.fn(),
  }
}

const OPEN_SCRIPTS = [dirExpandKey(ROOT, SKILL, "scripts")]

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
  it("每个文件夹行都有「新建文件」「新建文件夹」「删除文件夹」，文件行没有", () => {
    const html = renderToStaticMarkup(createElement(SkillTreeList, makeProps([...OPEN_SCRIPTS, dirExpandKey(ROOT, SKILL, "scripts/lib")])))
    // 可见的行：scripts、run.sh、lib、deep.txt、notes.md；带按钮的是 scripts 和 lib
    expect(html).toContain("run.sh")
    expect(html).toContain("deep.txt")
    expect(html).toContain("notes.md")
    expect(count(html, 'title="新建文件"')).toBe(2)
    expect(count(html, 'title="新建文件夹"')).toBe(2)
    expect(count(html, 'title="删除文件夹"')).toBe(2)
  })

  it("文件夹没展开时，里面的东西不渲染", () => {
    const html = renderToStaticMarkup(createElement(SkillTreeList, makeProps([])))
    expect(html).toContain("scripts")
    expect(html).toContain("notes.md")
    expect(html).not.toContain("run.sh")
    expect(count(html, 'title="新建文件"')).toBe(1)
  })

  it("只展开 scripts：lib 在，lib 里的 deep.txt 不渲染", () => {
    const html = renderToStaticMarkup(createElement(SkillTreeList, makeProps(OPEN_SCRIPTS)))
    expect(html).toContain("lib")
    expect(html).not.toContain("deep.txt")
  })

  it("按钮默认藏着，悬停或键盘聚焦到该行才显示，且浮在行尾不占名字的宽度", () => {
    const html = renderToStaticMarkup(createElement(SkillTreeList, makeProps(OPEN_SCRIPTS)))
    expect(html).toContain("group-hover:flex")
    expect(html).toContain("group-focus-within:flex")
    expect(html).toContain("absolute")
    expect(html).toContain("hidden")
  })

  it("每个按钮都有 aria-label，读屏和测试都能按名字找到", () => {
    const html = renderToStaticMarkup(createElement(SkillTreeList, makeProps(OPEN_SCRIPTS)))
    expect(count(html, 'aria-label="新建文件"')).toBe(2)
  })

  it("没有内容时什么都不渲染（提示文字由文件列表那一列给）", () => {
    const html = renderToStaticMarkup(createElement(SkillTreeList, { ...makeProps([]), nodes: [] }))
    expect(html).toBe("")
  })
})

describe("SkillTreeList 的当前文件高亮", () => {
  it("只有编辑区里开着的那个文件带 aria-current", () => {
    const html = renderToStaticMarkup(createElement(SkillTreeList, makeProps(OPEN_SCRIPTS, "scripts/run.sh")))
    expect(count(html, 'aria-current="true"')).toBe(1)
    expect(html).toMatch(/data-file="scripts\/run\.sh"[^>]*aria-current="true"|aria-current="true"[^>]*data-file="scripts\/run\.sh"/)
  })

  it("没开文件、或开的是 SKILL.md（不在树里）时，没有高亮", () => {
    expect(renderToStaticMarkup(createElement(SkillTreeList, makeProps(OPEN_SCRIPTS, null)))).not.toContain("aria-current")
  })

  it("同名文件在不同文件夹里不会一起高亮（按完整相对路径比）", () => {
    const twin: SkillTreeNode[] = [dir("a", [file("x.md")]), dir("b", [file("x.md")])]
    const props = { ...makeProps([dirExpandKey(ROOT, SKILL, "a"), dirExpandKey(ROOT, SKILL, "b")], "b/x.md"), nodes: twin }
    const html = renderToStaticMarkup(createElement(SkillTreeList, props))
    expect(count(html, 'aria-current="true"')).toBe(1)
    expect(html).toMatch(/data-file="b\/x\.md"[^>]*aria-current|aria-current[^>]*data-file="b\/x\.md"/)
  })
})

describe("SkillTreeList 的回调参数", () => {
  it("每个按钮带的是自己所在行的父路径", () => {
    const props = makeProps([...OPEN_SCRIPTS, dirExpandKey(ROOT, SKILL, "scripts/lib")])
    const actions = collectActions(SkillTreeList(props))
    expect(actions.map((a) => a.title)).toEqual([
      "新建文件", "新建文件夹", "删除文件夹", // scripts
      "新建文件", "新建文件夹", "删除文件夹", // scripts/lib
    ])
    actions.forEach((a) => a.onClick())
    expect(props.onCreate.mock.calls).toEqual([
      ["file", "scripts"],
      ["folder", "scripts"],
      ["file", "scripts/lib"],
      ["folder", "scripts/lib"],
    ])
    expect(props.onDeleteFolder.mock.calls).toEqual([["scripts"], ["scripts/lib"]])
  })

  it("点文件：带完整的相对路径；点文件夹行：切换展开", () => {
    const props = makeProps([...OPEN_SCRIPTS, dirExpandKey(ROOT, SKILL, "scripts/lib")])
    const out = SkillTreeList(props)
    findButtonClick(out, "run.sh")?.()
    findButtonClick(out, "deep.txt")?.()
    findButtonClick(out, "notes.md")?.()
    expect(props.onOpenFile.mock.calls).toEqual([["scripts/run.sh"], ["scripts/lib/deep.txt"], ["notes.md"]])
    findButtonClick(out, "lib")?.()
    expect(props.onToggle).toHaveBeenLastCalledWith(dirExpandKey(ROOT, SKILL, "scripts/lib"))
  })

  it("新建后要展开的 key，和列表实际使用的 key 一致（建在深层，路径上的每一层都展开，新东西立刻可见）", () => {
    // 模拟：在 my-skill/scripts/lib 下新建 x/y.txt，面板会展开这些祖先
    const keys = ancestorExpandKeys(ROOT, SKILL, "scripts/lib/x/y.txt")
    const deep: SkillTreeNode[] = [dir("scripts", [dir("lib", [dir("x", [file("y.txt")])])])]
    const html = renderToStaticMarkup(createElement(SkillTreeList, { ...makeProps(keys), nodes: deep }))
    expect(html).toContain("y.txt")
  })
})
