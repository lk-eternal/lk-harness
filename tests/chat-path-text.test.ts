import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"
import { PathText, splitPathText } from "../src/renderer/components/chat/PathLink"

const joined = (text: string): string => splitPathText(text).map((p) => p.text).join("")
const linked = (text: string) => splitPathText(text).filter((p) => p.path !== undefined)

describe("splitPathText（工具行摘要里的路径）", () => {
  it("整条摘要就是一个路径（read 工具）：整条算一段", () => {
    const text = "D:\\workspace\\lk-harness\\temp\\shots\\composed\\_view_feishu-dark.png"
    expect(splitPathText(text)).toEqual([{ text, path: text }])
  })

  it("整条摘要是带空格的绝对路径也认", () => {
    const text = "D:\\My Docs\\a.docx"
    expect(splitPathText(text)).toEqual([{ text, path: text }])
  })

  it("带行号：路径不含行号，行号在 line 里，显示的文字仍是原文", () => {
    expect(splitPathText("src/app.ts:42")).toEqual([{ text: "src/app.ts:42", path: "src/app.ts", line: 42 }])
  })

  it("shell 命令里夹的绝对路径：前后的文字原样保留", () => {
    const text = "node D:\\work\\compose.mjs --out D:\\work\\out.png"
    expect(splitPathText(text)).toEqual([
      { text: "node " },
      { text: "D:\\work\\compose.mjs", path: "D:\\work\\compose.mjs" },
      { text: " --out " },
      { text: "D:\\work\\out.png", path: "D:\\work\\out.png" },
    ])
    expect(joined(text)).toBe(text)
  })

  it("不像路径的摘要保持一整段普通文字", () => {
    for (const text of ["npm test", "TODO", "**/*.tsx", "node compose.mjs 2>&1 | Select-Object -First 15", "https://example.com/a/b.png"]) {
      expect(linked(text)).toEqual([])
      expect(joined(text)).toBe(text)
    }
  })

  it("空摘要拆不出任何一段", () => {
    expect(splitPathText("")).toEqual([])
  })
})

describe("PathText", () => {
  it("没有预览面板（或路径还没确认）时原样显示文字，不出现链接", () => {
    const html = renderToStaticMarkup(createElement(PathText, { text: "node D:\\work\\compose.mjs --out out.png" }))
    expect(html).toBe("node D:\\work\\compose.mjs --out out.png")
    expect(html).not.toContain("role=\"link\"")
  })
})
