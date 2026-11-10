import { createElement } from "react"
import ReactMarkdown from "react-markdown"
import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"
import Markdown from "../src/renderer/components/chat/Markdown"
import { rehypePathMentions } from "../src/renderer/components/chat/path-mentions"

interface Node {
  type: string
  value?: string
  tagName?: string
  properties?: Record<string, unknown>
  children?: Node[]
}

const text = (value: string): Node => ({ type: "text", value })
const el = (tagName: string, children: Node[], properties: Record<string, unknown> = {}): Node => ({ type: "element", tagName, properties, children })
const run = (tree: Node): Node => {
  rehypePathMentions()(tree)
  return tree
}
/** 把树里所有文字按顺序拼起来：不管怎么拆，文字内容都不能变 */
const flat = (n: Node): string => (n.type === "text" ? (n.value ?? "") : (n.children ?? []).map(flat).join(""))
const spans = (n: Node): Node[] => [
  ...(n.type === "element" && n.tagName === "span" && n.properties?.dataLkPath !== undefined ? [n] : []),
  ...(n.children ?? []).flatMap(spans),
]

describe("rehypePathMentions", () => {
  it("把文字里的路径包成带标记的 span，前后的文字原样保留", () => {
    const original = "已写入 D:\\work\\report.xlsx，见 src/app.ts:42。"
    const tree = run(el("p", [text(original)]))
    expect(flat(tree)).toBe(original)
    const found = spans(tree)
    expect(found.map((s) => s.properties)).toEqual([
      { dataLkPath: "D:\\work\\report.xlsx" },
      { dataLkPath: "src/app.ts", dataLkLine: "42" },
    ])
    expect(found.map(flat)).toEqual(["D:\\work\\report.xlsx", "src/app.ts:42"])
  })

  it("路径在开头、结尾、整段文字时没有多余的空文本节点", () => {
    const whole = run(el("p", [text("src/a.ts")]))
    expect(whole.children).toHaveLength(1)
    expect(whole.children?.[0].tagName).toBe("span")
    const both = run(el("p", [text("src/a.ts 和 src/b.ts")]))
    expect(both.children?.map((c) => c.type)).toEqual(["element", "text", "element"])
  })

  it("没有路径的文字不动", () => {
    const tree = el("p", [text("2024/03/15 and/or v1.2.3，没有路径")])
    const before = JSON.stringify(tree)
    run(tree)
    expect(JSON.stringify(tree)).toBe(before)
  })

  it("加粗、列表项这类嵌套里的路径也认", () => {
    const tree = run(el("ul", [el("li", [el("strong", [text("改了 lib/util.ts")])])]))
    expect(spans(tree).map(flat)).toEqual(["lib/util.ts"])
  })

  it("链接、代码块、行内代码里的文字不碰", () => {
    const tree = el("div", [
      el("a", [text("src/in-link.ts")], { href: "https://example.com" }),
      el("pre", [el("code", [text("cat src/in-block.ts")])]),
      el("code", [text("src/in-inline.ts")]),
    ])
    expect(spans(run(tree))).toEqual([])
  })

  it("pre 里直接放的文字（不经过 code）也不碰", () => {
    expect(spans(run(el("pre", [text("src/in-pre.ts")])))).toEqual([])
  })

  it("链接后面的普通文字照常处理", () => {
    const tree = run(el("p", [el("a", [text("x")], { href: "https://e.com" }), text(" 然后看 src/after.ts")]))
    expect(spans(tree).map(flat)).toEqual(["src/after.ts"])
  })
})

describe("经 react-markdown 渲染", () => {
  const render = (md: string) => renderToStaticMarkup(createElement(ReactMarkdown, {
    rehypePlugins: [rehypePathMentions],
    components: {
      span: (props) => {
        const p = props as Record<string, unknown>
        return createElement("i", { "data-path": String(p["data-lk-path"]), "data-line": String(p["data-lk-line"]) }, props.children)
      },
    },
    children: md,
  }))

  it("标记作为 data-lk-path / data-lk-line 属性传到 span 组件", () => {
    expect(render("见 src/app.ts:42 的实现")).toBe('<p>见 <i data-path="src/app.ts" data-line="42">src/app.ts:42</i> 的实现</p>')
  })

  it("没带行号时没有 data-lk-line", () => {
    expect(render("见 src/app.ts")).toContain('data-line="undefined"')
  })

  it("Markdown 强调、链接里的路径不会被拆坏", () => {
    const html = render("**改了 src/a.ts**，详见 [文档](https://e.com/docs/a.md)")
    expect(html).toContain('<strong>改了 <i data-path="src/a.ts"')
    expect(html).toContain('<a href="https://e.com/docs/a.md">文档</a>')
  })
})

describe("对话 Markdown（没有预览面板时）", () => {
  const html = (md: string) => renderToStaticMarkup(createElement(Markdown, { text: md }))

  it("路径只是普通文字，不会变成可点的", () => {
    const out = html("已写入 D:\\work\\report.xlsx，见 `src/app.ts:42`")
    expect(out).not.toContain("lk-path")
    expect(out).toContain("D:\\work\\report.xlsx")
    expect(out).toContain("<code>src/app.ts:42</code>")
  })

  it("代码块的语言标注、高亮和复制按钮不受影响", () => {
    const out = html("```ts\nconst a = 1\n```")
    expect(out).toContain("<span>ts</span>")
    expect(out).toContain("hljs")
    expect(out).toContain("const")
  })
})
