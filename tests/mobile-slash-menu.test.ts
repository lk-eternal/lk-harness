import { createElement, isValidElement, type ReactElement, type ReactNode } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it, vi } from "vitest"
import SlashMenu from "../src/mobile/SlashMenu"
import { slashMenuItems } from "../src/shared/command-catalog"

/** 把元素树里所有 <button> 摊平（SlashMenu 是无状态函数组件，直接调用即可拿到它渲染的树） */
function buttonsOf(node: ReactNode): Array<ReactElement<{ onClick?: () => void; onMouseDown?: (e: { preventDefault: () => void }) => void; children?: ReactNode }>> {
  if (Array.isArray(node)) return node.flatMap(buttonsOf)
  if (!isValidElement(node)) return []
  const el = node as ReactElement<{ children?: ReactNode }>
  return [...(el.type === "button" ? [el as never] : []), ...buttonsOf(el.props.children)]
}

describe("手机端 / 指令菜单", () => {
  it("没有候选时什么都不渲染（不挡住聊天内容）", () => {
    expect(renderToStaticMarkup(createElement(SlashMenu, { items: [], onPick: vi.fn() }))).toBe("")
    expect(renderToStaticMarkup(createElement(SlashMenu, { items: slashMenuItems("你好"), onPick: vi.fn() }))).toBe("")
  })

  it("输入 / 后列出全部主指令，每项显示指令和说明", () => {
    const items = slashMenuItems("/")
    const html = renderToStaticMarkup(createElement(SlashMenu, { items, onPick: vi.fn() }))
    for (const i of items) {
      expect(html).toContain(`>${i.cmd}<`)
      expect(html).toContain(i.desc.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"))
    }
    expect((html.match(/<button/g) ?? []).length).toBe(items.length)
  })

  it("向上展开贴着输入栏（absolute bottom-full），列表可滚动，层级盖在聊天内容上", () => {
    const html = renderToStaticMarkup(createElement(SlashMenu, { items: slashMenuItems("/"), onPick: vi.fn() }))
    const root = /<div[^>]*>/.exec(html)?.[0] ?? ""
    expect(root).toContain("absolute")
    expect(root).toContain("bottom-full")
    expect(root).toContain("overflow-y-auto")
    expect(root).toContain("z-30")
  })

  it("点一项 = 选中这条指令；按下时阻止默认行为，输入框不失焦（软键盘不收起）", () => {
    const onPick = vi.fn()
    const items = slashMenuItems("/st")
    const tree = SlashMenu({ items, onPick })
    const buttons = buttonsOf(tree)
    expect(buttons).toHaveLength(items.length)

    const preventDefault = vi.fn()
    buttons[1].props.onMouseDown?.({ preventDefault })
    expect(preventDefault).toHaveBeenCalledTimes(1)

    buttons[1].props.onClick?.()
    expect(onPick).toHaveBeenCalledTimes(1)
    expect(onPick).toHaveBeenCalledWith(items[1].cmd)
  })
})
