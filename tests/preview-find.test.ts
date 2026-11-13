import { createElement, createRef } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it, vi } from "vitest"
import { FindBar } from "../src/renderer/components/preview/FindScope"
import { findSupported } from "../src/renderer/components/preview/find-dom"
import {
  FIND_MAX_MATCHES, findAll, formatFindCount, joinPieces, locateMatch, normalizeFindText, seedFromSelection, stepMatch,
  type FindPiece,
} from "../src/shared/preview-find"

const piece = (text: string, breakBefore = false, pre = false): FindPiece => ({ text, breakBefore, pre })

describe("findAll", () => {
  it("忽略大小写，从左到右，返回每处的起止偏移", () => {
    expect(findAll("Foo foo FOO", "foo").matches).toEqual([
      { start: 0, end: 3 },
      { start: 4, end: 7 },
      { start: 8, end: 11 },
    ])
  })

  it("互不重叠：aaa 里找 aa 只有一处", () => {
    expect(findAll("aaa", "aa").matches).toEqual([{ start: 0, end: 2 }])
  })

  it("关键词是普通文字，不是正则：括号、点、星号、斜杠原样匹配", () => {
    expect(findAll("a.b a*b (x) [y] a/b", ".").matches).toHaveLength(1)
    expect(findAll("a.b a*b (x) [y] a/b", "a*b").matches).toEqual([{ start: 4, end: 7 }])
    expect(findAll("call(x) call[y]", "(x)").matches).toEqual([{ start: 4, end: 7 }])
    expect(findAll("call(x) call[y]", "[y]").matches).toEqual([{ start: 12, end: 15 }])
    expect(findAll("a/b", "a/b").matches).toEqual([{ start: 0, end: 3 }])
    expect(() => findAll("x", "\\")).not.toThrow()
    expect(findAll("a\\b", "\\").matches).toEqual([{ start: 1, end: 2 }])
  })

  it("中文、emoji 照常找，偏移按 UTF-16 算（和字符串下标一致）", () => {
    const text = "你好，世界 😀 世界"
    const { matches } = findAll(text, "世界")
    expect(matches.map((m) => text.slice(m.start, m.end))).toEqual(["世界", "世界"])
    const emoji = findAll(text, "😀").matches
    expect(emoji).toHaveLength(1)
    expect(text.slice(emoji[0].start, emoji[0].end)).toBe("😀")
  })

  it("转小写会变长的字符（İ）不会让后面的偏移错位", () => {
    const text = "İ-needle"
    const { matches } = findAll(text, "needle")
    expect(matches).toHaveLength(1)
    expect(text.slice(matches[0].start, matches[0].end)).toBe("needle")
  })

  it("空关键词没有命中", () => {
    expect(findAll("abc", "")).toEqual({ matches: [], capped: false })
  })

  it("关键词里的换行当空格：和 Markdown 段落里源文件的硬换行对得上", () => {
    expect(findAll("foo bar", "foo\nbar").matches).toEqual([{ start: 0, end: 7 }])
  })

  it("命中太多就停在上限，并标记 capped", () => {
    const text = "a".repeat(50)
    const r = findAll(text, "a", 10)
    expect(r.matches).toHaveLength(10)
    expect(r.capped).toBe(true)
    // 刚好等于上限不算被截断
    expect(findAll("aaa", "a", 3)).toMatchObject({ capped: false })
    expect(FIND_MAX_MATCHES).toBeGreaterThanOrEqual(1000)
  })
})

describe("joinPieces / locateMatch", () => {
  it("同一块里相邻的文字直接接在一起：能找到横跨好几个文字节点的词（foo**bar** 渲染成 foo、bar 两个节点）", () => {
    const joined = joinPieces([piece("say foo"), piece("bar baz")])
    expect(joined.text).toBe("say foobar baz")
    const [m] = findAll(joined.text, "foobar").matches
    expect(locateMatch(joined.segments, m)).toEqual({
      start: { piece: 0, offset: 4 },
      end: { piece: 1, offset: 3 },
    })
  })

  it("块与块之间隔着换行：命中不会横跨两个段落 / 两行 / 两个单元格", () => {
    const joined = joinPieces([piece("first end"), piece("start second", true)])
    expect(joined.text).toBe("first end\nstart second")
    expect(findAll(joined.text, "endstart").matches).toHaveLength(0)
    expect(findAll(joined.text, "end start").matches).toHaveLength(0)
    expect(findAll(joined.text, "end").matches).toHaveLength(1)
  })

  it("命中的起点正好在上一段末尾、终点正好在下一段开头时，归到真正含有文字的那一段", () => {
    const joined = joinPieces([piece("ab"), piece("cd"), piece("ef")])
    // "bc"：起点在第 0 段的最后一个字符，终点在第 1 段的第一个字符之后
    expect(locateMatch(joined.segments, { start: 1, end: 3 })).toEqual({
      start: { piece: 0, offset: 1 },
      end: { piece: 1, offset: 1 },
    })
    // "cd" 整段：起点是第 1 段段首（不是第 0 段末尾），终点是第 1 段段尾（不是第 2 段开头）
    expect(locateMatch(joined.segments, { start: 2, end: 4 })).toEqual({
      start: { piece: 1, offset: 0 },
      end: { piece: 1, offset: 2 },
    })
    // 横跨三段
    expect(locateMatch(joined.segments, { start: 1, end: 5 })).toEqual({
      start: { piece: 0, offset: 1 },
      end: { piece: 2, offset: 1 },
    })
  })

  it("空段不占位，但下标仍和传入的数组一一对应", () => {
    const joined = joinPieces([piece("ab"), piece(""), piece("cd")])
    expect(joined.text).toBe("abcd")
    expect(joined.segments.map((s) => s.piece)).toEqual([0, 2])
    expect(locateMatch(joined.segments, { start: 2, end: 4 })).toEqual({
      start: { piece: 2, offset: 0 },
      end: { piece: 2, offset: 2 },
    })
  })

  it("第一段带 breakBefore 不会在最前面多出一个换行", () => {
    expect(joinPieces([piece("ab", true), piece("cd", true)]).text).toBe("ab\ncd")
  })

  it("落在块之间的换行上的命中换算不出来，返回 undefined", () => {
    const joined = joinPieces([piece("ab"), piece("cd", true)])
    expect(locateMatch(joined.segments, { start: 2, end: 3 })).toBeUndefined()
    expect(locateMatch([], { start: 0, end: 1 })).toBeUndefined()
  })

  it("正文里的换行 / 制表符是个空格；<pre> 里的换行是真换行", () => {
    const prose = joinPieces([piece("foo\nbar\tbaz")])
    expect(prose.text).toBe("foo bar baz")
    expect(findAll(prose.text, "foo bar").matches).toHaveLength(1)
    // 长度不变，偏移和原文字节点一一对应
    expect(prose.text).toHaveLength("foo\nbar\tbaz".length)

    const code = joinPieces([piece("line1\nline2", false, true)])
    expect(code.text).toBe("line1\nline2")
    expect(findAll(code.text, "line1 line2").matches).toHaveLength(0)
    expect(findAll(code.text, "line2").matches).toHaveLength(1)
  })

  it("不换行空格也当空格（Markdown 渲染里常见）", () => {
    expect(normalizeFindText("a\u00a0b")).toBe("a b")
    expect(findAll(joinPieces([piece("a\u00a0b")]).text, "a b").matches).toHaveLength(1)
    expect(findAll(joinPieces([piece("a\u00a0b", false, true)]).text, "a b").matches).toHaveLength(1)
  })

  it("大文本也能一次换算完（二分，不是逐段扫）", () => {
    const pieces = Array.from({ length: 20_000 }, (_, i) => piece(`line ${i} needle`, true))
    const joined = joinPieces(pieces)
    const { matches } = findAll(joined.text, "needle", Infinity)
    expect(matches).toHaveLength(20_000)
    const at = locateMatch(joined.segments, matches[12_345])
    expect(at?.start.piece).toBe(12_345)
    expect(at?.end.piece).toBe(12_345)
    expect(pieces[12_345].text.slice(at!.start.offset, at!.end.offset)).toBe("needle")
  })
})

describe("stepMatch", () => {
  it("下一个：到末尾绕回第一个", () => {
    expect(stepMatch(0, 3, 1)).toBe(1)
    expect(stepMatch(2, 3, 1)).toBe(0)
  })

  it("上一个：到开头绕回最后一个", () => {
    expect(stepMatch(2, 3, -1)).toBe(1)
    expect(stepMatch(0, 3, -1)).toBe(2)
  })

  it("只有一处时原地不动；没有命中是 -1；还没选中过时按方向取头或尾", () => {
    expect(stepMatch(0, 1, 1)).toBe(0)
    expect(stepMatch(0, 1, -1)).toBe(0)
    expect(stepMatch(0, 0, 1)).toBe(-1)
    expect(stepMatch(-1, 5, 1)).toBe(0)
    expect(stepMatch(-1, 5, -1)).toBe(4)
    expect(stepMatch(9, 5, 1)).toBe(0)
  })
})

describe("formatFindCount", () => {
  it("第几处 / 共几处（从 1 数）", () => {
    expect(formatFindCount(0, 12, false)).toBe("1 / 12")
    expect(formatFindCount(11, 12, false)).toBe("12 / 12")
  })

  it("没有命中：无结果；到了上限：总数后面加 +", () => {
    expect(formatFindCount(0, 0, false)).toBe("无结果")
    expect(formatFindCount(3, 10_000, true)).toBe("4 / 10000+")
  })
})

describe("seedFromSelection", () => {
  it("选中了一小段单行文字：拿来当关键词（去掉首尾空白）", () => {
    expect(seedFromSelection("  hello world \n".trim())).toBe("hello world")
    expect(seedFromSelection(" foo ")).toBe("foo")
  })

  it("空白、跨行、太长的选择不拿来当关键词", () => {
    expect(seedFromSelection("   ")).toBeUndefined()
    expect(seedFromSelection("")).toBeUndefined()
    expect(seedFromSelection("line1\nline2")).toBeUndefined()
    expect(seedFromSelection("x".repeat(101))).toBeUndefined()
    expect(seedFromSelection("x".repeat(100))).toBe("x".repeat(100))
  })
})

describe("FindBar", () => {
  function render(props: Partial<Parameters<typeof FindBar>[0]> = {}): string {
    return renderToStaticMarkup(
      createElement(FindBar, {
        inputRef: createRef<HTMLInputElement>(),
        query: "needle",
        onQuery: vi.fn(),
        active: 2,
        total: 12,
        capped: false,
        onStep: vi.fn(),
        onClose: vi.fn(),
        ...props,
      }),
    )
  }

  it("显示关键词和「第几处 / 共几处」，上一个 / 下一个 / 关闭三个按钮带快捷键提示", () => {
    const html = render()
    expect(html).toContain('value="needle"')
    expect(html).toContain("3 / 12")
    expect(html).toContain("上一个（Shift+Enter）")
    expect(html).toContain("下一个（Enter）")
    expect(html).toContain("关闭（Esc）")
    expect(html).toContain('role="search"')
  })

  it("关键词有、命中没有：显示「无结果」，上一个 / 下一个不可点", () => {
    const html = render({ total: 0, active: 0 })
    expect(html).toContain("无结果")
    expect(html.match(/disabled=""/g)).toHaveLength(2)
  })

  it("还没输入关键词：不显示计数，也不报「无结果」", () => {
    const html = render({ query: "", total: 0 })
    expect(html).not.toContain("无结果")
    expect(html).not.toContain(" / ")
  })

  it("命中太多：计数带 +", () => {
    expect(render({ total: 10_000, active: 0, capped: true })).toContain("1 / 10000+")
  })
})

describe("findSupported", () => {
  it("不是浏览器环境（没有 CSS.highlights）就返回 false，整个功能不启用", () => {
    expect(findSupported()).toBe(false)
  })
})
