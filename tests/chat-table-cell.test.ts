import { readFileSync } from "node:fs"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"
import Markdown from "../src/renderer/components/chat/Markdown"
import { displayWidth, isShortCell, SHORT_CELL_MAX_WIDTH } from "../src/renderer/components/chat/table-cell"

describe("displayWidth", () => {
  it("英文数字算 1，中日韩字符和全角标点算 2", () => {
    expect(displayWidth("09:24")).toBe(5)
    expect(displayWidth("已改")).toBe(4)
    expect(displayWidth("done 完成")).toBe(9)
    expect(displayWidth("，")).toBe(2)
    expect(displayWidth("ひらがな")).toBe(8)
    expect(displayWidth("한글")).toBe(4)
  })

  it("代理对（emoji）按一个字符算，不会算成两个", () => {
    expect(displayWidth("😀")).toBe(1)
  })
})

describe("isShortCell", () => {
  it("时间、短状态、序号、是否、提交短哈希都算短", () => {
    for (const s of ["09:24", "已改", "未通过", "是", "10", "2004204cc9", "1.2s", "-"]) expect(isShortCell(s), s).toBe(true)
  })

  it("刚好在边界上算短，多一点就不算", () => {
    expect(isShortCell("a".repeat(SHORT_CELL_MAX_WIDTH))).toBe(true)
    expect(isShortCell("a".repeat(SHORT_CELL_MAX_WIDTH + 1))).toBe(false)
    expect(isShortCell("字".repeat(SHORT_CELL_MAX_WIDTH / 2))).toBe(true)
    expect(isShortCell("字".repeat(SHORT_CELL_MAX_WIDTH / 2 + 1))).toBe(false)
  })

  it("句子、路径、链接都不算短，该折行就折行", () => {
    expect(isShortCell("表格单元格的换行规则不再继承")).toBe(false)
    expect(isShortCell("src/renderer/components/chat/chat-markdown.css")).toBe(false)
    expect(isShortCell("https://example.com/a/b")).toBe(false)
  })

  it("前后的空白不算宽度；空单元格没东西可保护，不算短", () => {
    expect(isShortCell("  09:24  ")).toBe(true)
    expect(isShortCell("")).toBe(false)
    expect(isShortCell("   ")).toBe(false)
  })
})

describe("对话 Markdown 的表格单元格", () => {
  const html = (md: string) => renderToStaticMarkup(createElement(Markdown, { text: md }))
  const table = [
    "| 时间 | 事件 |",
    "|---|---|",
    "| 09:24 | 你提交 `2004204cc9` 到 feature，这条说明足够长，不该被当成短单元格 |",
  ].join("\n")

  it("短的单元格（表头也算）带上 lk-nowrap，长的不带", () => {
    const out = html(table)
    expect(out).toContain('<th class="lk-nowrap">时间</th>')
    expect(out).toContain('<th class="lk-nowrap">事件</th>')
    expect(out).toContain('<td class="lk-nowrap">09:24</td>')
    expect(out).toMatch(/<td>你提交 <code>2004204cc9<\/code> 到 feature/)
  })

  it("单元格里有行内代码、加粗这类嵌套时，按里面的文字算", () => {
    const out = html("| a | b |\n|---|---|\n| **ok** | `x` |")
    expect(out).toContain('<td class="lk-nowrap"><strong>ok</strong></td>')
    expect(out).toContain('<td class="lk-nowrap"><code>x</code></td>')
  })

  it("列的对齐方式照常保留", () => {
    const out = html("| 名称 | 数量 |\n|:--|--:|\n| a | 1 |")
    expect(out).toMatch(/<th[^>]*style="text-align:right"[^>]*>数量<\/th>/)
    expect(out).toMatch(/<td[^>]*style="text-align:right"[^>]*>1<\/td>/)
  })

  it("react-markdown 传进来的 node 不会落到 DOM 上", () => {
    expect(html(table)).not.toMatch(/\bnode=/)
  })
})

describe("表格样式（布局要真浏览器才测得出，这里只守住关键规则不被改回去）", () => {
  const css = readFileSync("src/renderer/components/chat/chat-markdown.css", "utf8")
  const rule = (selector: RegExp): string => selector.exec(css)?.[1] ?? ""

  it("单元格用 break-word 而不是继承外层的 anywhere，并且给超长的词封顶", () => {
    const cells = rule(/\.chat-md th, \.chat-md td \{([^}]*)\}/)
    expect(cells).toMatch(/overflow-wrap:\s*break-word/)
    expect(cells).toMatch(/max-width:\s*\d+(\.\d+)?em/)
    expect(cells).not.toMatch(/anywhere/)
  })

  it("lk-nowrap 在表头和表体单元格上都生效", () => {
    const nowrap = rule(/\.chat-md th\.lk-nowrap, \.chat-md td\.lk-nowrap \{([^}]*)\}/)
    expect(nowrap).toMatch(/white-space:\s*nowrap/)
  })
})
