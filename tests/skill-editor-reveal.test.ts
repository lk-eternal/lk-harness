import { createElement, type ReactElement, type ReactNode } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it, vi } from "vitest"
import SkillEditor, { type EditMode } from "../src/renderer/components/skill/SkillEditor"

/** Skills 页右边编辑区头部的「显示位置」（不需要 DOM：服务端渲染看 HTML，直接调函数组件取回调） */

type El = ReactElement<Record<string, unknown> & { children?: ReactNode; header?: ReactNode }>

/** 编辑区的标题放在 EditorFrame 的 header 属性里，不在 children 里：两处都要走一遍 */
function findAll(node: ReactNode, pred: (el: El) => boolean, out: El[] = []): El[] {
  if (Array.isArray(node)) node.forEach((n) => findAll(n, pred, out))
  else if (node && typeof node === "object" && "props" in node) {
    const el = node as El
    if (pred(el)) out.push(el)
    findAll(el.props.header, pred, out)
    findAll(el.props.children, pred, out)
  }
  return out
}

const count = (html: string, needle: string) => html.split(needle).length - 1

function props(edit: EditMode, onReveal = vi.fn()) {
  return { edit, rootLabel: "~/.cursor/skills", dirty: false, justSaved: false, error: null, onChange: vi.fn(), onSave: vi.fn(), onRevert: vi.fn(), onDelete: vi.fn(), onReveal }
}

const existingSkill: EditMode = { kind: "skill", skillPath: "pdf", name: "pdf", content: "# pdf", originalPath: "pdf", isNew: false }
const newSkill: EditMode = { kind: "skill", skillPath: "", name: "", content: "", originalPath: null, isNew: true }
const aFile: EditMode = { kind: "file", skillPath: "pdf", relativePath: "scripts/run.sh", content: "echo" }

describe("SkillEditor 头部的「显示位置」", () => {
  it("已有的 Skill 和 Skill 里的文件都有这个入口", () => {
    for (const edit of [existingSkill, aFile]) {
      const html = renderToStaticMarkup(createElement(SkillEditor, props(edit)))
      expect(html).toContain("显示位置")
      expect(count(html, 'title="在文件管理器中显示这个文件"')).toBe(1)
    }
  })

  it("新建还没保存的 Skill：磁盘上还没有，不显示这个入口", () => {
    const html = renderToStaticMarkup(createElement(SkillEditor, props(newSkill)))
    expect(html).not.toContain("显示位置")
    expect(html).not.toContain("在文件管理器中显示")
  })

  it("点了调 onReveal，且不会顺带保存、还原或删除", () => {
    const p = props(aFile)
    const [btn] = findAll(SkillEditor(p), (el) => el.props.title === "在文件管理器中显示这个文件")
    expect(btn).toBeDefined()
    ;(btn.props.onClick as () => void)()
    expect(p.onReveal).toHaveBeenCalledTimes(1)
    expect(p.onSave).not.toHaveBeenCalled()
    expect(p.onRevert).not.toHaveBeenCalled()
    expect(p.onDelete).not.toHaveBeenCalled()
  })

  it("有没保存的修改时照样能点（只是看位置，不碰编辑内容）", () => {
    const p = { ...props(existingSkill), dirty: true }
    const [btn] = findAll(SkillEditor(p), (el) => el.props.title === "在文件管理器中显示这个文件")
    expect(btn.props.disabled).toBeUndefined()
    ;(btn.props.onClick as () => void)()
    expect(p.onReveal).toHaveBeenCalledTimes(1)
    expect(p.onChange).not.toHaveBeenCalled()
  })

  it("路径很长时标题和路径仍可截断，按钮不被挤出去也不换行", () => {
    const longFile: EditMode = { kind: "file", skillPath: "s".repeat(80), relativePath: `${"d/".repeat(40)}file.txt`, content: "" }
    const html = renderToStaticMarkup(createElement(SkillEditor, props(longFile)))
    expect(html).toMatch(/<div class="min-w-0 flex-1"><p class="truncate/)
    expect(html).toMatch(/title="在文件管理器中显示这个文件"[^>]*class="[^"]*shrink-0[^"]*whitespace-nowrap/)
  })
})
