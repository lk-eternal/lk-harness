import { describe, expect, it } from "vitest"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { CodeText, CodeViewReady } from "../src/renderer/components/preview/TextViewers"
import { previewTypeOf } from "../src/shared/preview-kinds"
import type { PreviewFileInfo } from "../src/shared/preview-types"

function render(name: string, text: string, opts: { line?: number; truncated?: boolean } = {}): string {
  const type = previewTypeOf(name)
  const info: PreviewFileInfo = { ok: true, token: "t", url: "lkfile://t/" + name, name, size: text.length, mtimeMs: 0, kind: type.kind, lang: type.lang }
  const state = { status: "ready" as const, ok: true as const, text, encoding: "utf-8" as const, size: text.length, truncated: !!opts.truncated }
  return renderToStaticMarkup(createElement(CodeViewReady, { info, state, line: opts.line }))
}

/** 渲染出来的所有行号（data-ln） */
const lineNumbers = (html: string): number[] => [...html.matchAll(/data-ln="(\d+)"/g)].map((m) => Number(m[1]))

const MINIFIED = JSON.stringify({ items: Array.from({ length: 30 }, (_, i) => ({ id: i, name: `n${i}`, tags: ["a", "b"] })) })
const PRETTY = JSON.stringify(JSON.parse(MINIFIED), null, 2)

describe("JSON：默认显示什么", () => {
  it("压成一行的：默认显示格式化后的，工具栏标出已格式化，行号连续、有折叠箭头", () => {
    const html = render("data.json", MINIFIED)
    const nums = lineNumbers(html)
    expect(nums.length).toBeGreaterThan(100)
    expect(nums).toEqual(nums.map((_, i) => i + 1))
    expect(html).toContain("已格式化")
    expect(html).toContain("foldable")
    expect(html).toContain("折叠全部")
    expect(html).toContain("展开全部")
    expect(html).toContain('aria-expanded="true"')
    // 不允许有折叠起来的东西：默认全部展开
    expect(html).not.toContain("fold-pill")
  })

  it("已经排好版的：原样显示（行数和原文一致），不显示已格式化，但可以折叠、可以手动切到格式化", () => {
    const html = render("data.json", PRETTY)
    expect(lineNumbers(html)).toHaveLength(PRETTY.split("\n").length)
    expect(html).not.toContain("已格式化")
    expect(html).toContain("折叠全部")
    expect(html).toContain(">格式化<")
    expect(html).toContain(">原文<")
  })

  it("要定位到某一行（从对话里点进来）：原样显示并高亮那一行", () => {
    const html = render("data.json", MINIFIED, { line: 1 })
    expect(lineNumbers(html)).toEqual([1])
    expect(html).toContain('class="pl hit"')
    expect(html).not.toContain("已格式化")
  })

  it("jsonl：默认原样（一行一条记录），也提供格式化", () => {
    const text = Array.from({ length: 5 }, (_, i) => JSON.stringify({ id: i, msg: "x".repeat(200) })).join("\n")
    const html = render("log.jsonl", text)
    expect(lineNumbers(html)).toEqual([1, 2, 3, 4, 5])
    expect(html).toContain(">格式化<")
  })

  it("被截断的文件内容不完整：不提供格式化", () => {
    const html = render("big.json", MINIFIED.slice(0, 500), { truncated: true })
    expect(html).not.toContain(">格式化<")
    expect(html).not.toContain("已格式化")
  })

  it("jsonc / json5 / 配置文件：不提供格式化，但能折叠", () => {
    const text = PRETTY
    for (const name of ["tsconfig.jsonc", "a.json5", ".eslintrc"]) {
      const html = render(name, text)
      expect(html, name).not.toContain(">格式化<")
      expect(html, name).toContain("折叠全部")
    }
  })

  it("压成一行但不是合法 JSON（带注释）：显示原文，并说明为什么没格式化、错在哪", () => {
    const text = "/* 生成的 */ " + MINIFIED
    const html = render("x.json", text)
    expect(html).toContain("无法格式化，显示的是原文")
    expect(html).toContain("第 1 行第 1 列")
    expect(html).toContain("注释")
    expect(lineNumbers(html)).toEqual([1])
  })

  it("内容里的 HTML 必须转义（文件内容不可信），格式化后也一样", () => {
    const text = JSON.stringify({ pad: "x".repeat(300), html: '<img src=x onerror="alert(1)"><script>alert(2)</script>' })
    const html = render("evil.json", text)
    expect(html).toContain("已格式化")
    expect(html).not.toContain("<img")
    expect(html).not.toContain("<script")
    expect(html).toContain("&lt;script&gt;")
  })
})

describe("YAML", () => {
  const yaml = ["a:", "  b: 1", "  c:", "    - x", "    - y", "d: 2"].join("\n")

  it("可以折叠，没有格式化切换", () => {
    const html = render("c.yaml", yaml)
    expect(html).toContain("折叠全部")
    expect(html).not.toContain(">格式化<")
    expect(html).not.toContain(">原文<")
    expect(lineNumbers(html)).toEqual([1, 2, 3, 4, 5, 6])
  })

  it("没有层级的：没有折叠按钮，版面和以前一样", () => {
    const html = render("flat.yml", "a: 1\nb: 2")
    expect(html).not.toContain("折叠全部")
    expect(html).not.toContain("foldable")
    expect(html).not.toContain("fold-btn")
  })
})

describe("其他代码文件和文本：没有折叠和格式化的界面，但行号照常", () => {
  it("ts / txt", () => {
    for (const [name, text] of [["a.ts", "const a = {\n  b: 1\n}\n"], ["a.txt", "x\ny"]] as const) {
      const html = render(name, text)
      expect(html, name).not.toContain("折叠全部")
      expect(html, name).not.toContain("fold-btn")
      expect(html, name).not.toContain(">格式化<")
    }
    expect(lineNumbers(render("a.ts", "const a = {\n  b: 1\n}\n"))).toEqual([1, 2, 3])
  })
})

describe("CodeText 的折叠渲染", () => {
  const text = ["{", '  "a": {', '    "b": 1,', '    "c": 2', "  },", '  "d": 3', "}"].join("\n")
  const regions = [{ start: 0, end: 5 }, { start: 1, end: 3 }]
  const html = (collapsed: number[]) =>
    renderToStaticMarkup(createElement(CodeText, { text, lang: "json", wrap: false, fold: { regions, collapsed: new Set(collapsed), onToggle: () => {} } }))

  it("没折叠：每行都在；有区间的行才有箭头，展开状态", () => {
    const out = html([])
    expect(lineNumbers(out)).toEqual([1, 2, 3, 4, 5, 6, 7])
    expect((out.match(/class="fold-btn"/g) ?? []).length).toBe(2)
    expect((out.match(/aria-expanded="true"/g) ?? []).length).toBe(2)
    expect(out).not.toContain("fold-pill")
  })

  it("折叠内层：藏起 3、4 行，保留的行号不变（不是重新编号），后面跟「⋯ 2 行」", () => {
    const out = html([1])
    expect(lineNumbers(out)).toEqual([1, 2, 5, 6, 7])
    expect(out).toContain("⋯ 2 行")
    expect(out).toContain('aria-expanded="false"')
    expect(out).not.toContain("&quot;b&quot;")
  })

  it("折叠外层：只剩第 1 行和收尾括号那一行；里面折叠与否都不会冒出来", () => {
    for (const collapsed of [[0], [0, 1]]) {
      const out = html(collapsed)
      expect(lineNumbers(out), String(collapsed)).toEqual([1, 7])
      expect(out).toContain("⋯ 5 行")
      expect(out).not.toContain("⋯ 2 行")
    }
  })

  it("折叠之后下面还有可折叠的行：它的行号仍是原来的行号", () => {
    const two = ["{", '  "a": {', '    "b": 1,', '    "c": 2', "  },", '  "d": {', '    "e": 1,', '    "f": 2', "  }", "}"].join("\n")
    const twoRegions = [{ start: 0, end: 8 }, { start: 1, end: 3 }, { start: 5, end: 7 }]
    const out = renderToStaticMarkup(createElement(CodeText, {
      text: two, lang: "json", wrap: false, fold: { regions: twoRegions, collapsed: new Set([1]), onToggle: () => {} },
    }))
    expect(lineNumbers(out)).toEqual([1, 2, 5, 6, 7, 8, 9, 10])
    // 第 6 行（"d": {）是折叠起点，行号不能因为前面藏了两行而变成 4
    expect(out).toMatch(/data-ln="6"[^>]*><button/)
  })

  it("折叠箭头是空按钮（复制代码时不会带上字符），行内容仍是高亮后的 HTML", () => {
    const out = html([])
    expect(out).toMatch(/<button type="button" class="fold-btn"[^>]*><\/button>/)
    expect(out).toContain("hljs-attr")
  })

  it("不传 fold：和以前一样，没有按钮，也没有 foldable", () => {
    const out = renderToStaticMarkup(createElement(CodeText, { text, lang: "json", wrap: false }))
    expect(out).not.toContain("fold-btn")
    expect(out).not.toContain("foldable")
    expect(lineNumbers(out)).toEqual([1, 2, 3, 4, 5, 6, 7])
  })
})
