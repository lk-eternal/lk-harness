import { describe, expect, it } from "vitest"
import {
  decodePreviewText, detectDelimiter, formatBytes, parseCsv, splitHighlightedLines, splitTextLines,
} from "../src/shared/preview-text"

const utf8 = (s: string) => new Uint8Array(Buffer.from(s, "utf8"))

describe("decodePreviewText", () => {
  it("UTF-8 原样解出", () => {
    expect(decodePreviewText(utf8("你好 hello"))).toEqual({ text: "你好 hello", encoding: "utf-8", binary: false })
  })

  it("带 BOM 的 UTF-8 去掉 BOM", () => {
    const bytes = new Uint8Array([0xef, 0xbb, 0xbf, ...utf8("abc")])
    expect(decodePreviewText(bytes).text).toBe("abc")
  })

  it("UTF-16 LE / BE（按 BOM）", () => {
    const le = new Uint8Array([0xff, 0xfe, 0x60, 0x4f, 0x7d, 0x59]) // 你好
    const be = new Uint8Array([0xfe, 0xff, 0x4f, 0x60, 0x59, 0x7d])
    expect(decodePreviewText(le)).toMatchObject({ text: "你好", encoding: "utf-16le" })
    expect(decodePreviewText(be)).toMatchObject({ text: "你好", encoding: "utf-16be" })
  })

  it("不是合法 UTF-8 时按 GB18030 解（国内 Windows 的 txt/csv）", () => {
    const gbk = new Uint8Array([0xc4, 0xe3, 0xba, 0xc3]) // 你好
    expect(decodePreviewText(gbk)).toEqual({ text: "你好", encoding: "gb18030", binary: false })
  })

  it("开头有 NUL 的判为二进制，不给文本", () => {
    const r = decodePreviewText(new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x00, 0x00, 0x01]))
    expect(r).toEqual({ text: "", encoding: "utf-8", binary: true })
  })

  it("只读了文件开头一段（truncated）时，末尾切在多字节字符中间不算非 UTF-8", () => {
    const full = utf8("你好世界")
    const cut = full.subarray(0, full.length - 1) // 最后一个字符只剩两个字节
    const r = decodePreviewText(cut, true)
    expect(r.encoding).toBe("utf-8")
    expect(r.text.startsWith("你好世")).toBe(true)
    // 不是被截断的同样内容才要走 GB18030
    expect(decodePreviewText(cut, false).encoding).toBe("gb18030")
  })
})

describe("detectDelimiter", () => {
  it("tsv 一定是 tab", () => {
    expect(detectDelimiter("a,b,c", "tsv")).toBe("\t")
  })
  it("首行里哪个分隔符多用哪个", () => {
    expect(detectDelimiter("a,b,c\n1;2;3;4", "csv")).toBe(",")
    expect(detectDelimiter("a;b;c\n1,2", "csv")).toBe(";")
    expect(detectDelimiter("a\tb\tc,d", "csv")).toBe("\t")
  })
  it("一个分隔符都没有就是逗号", () => {
    expect(detectDelimiter("single", "csv")).toBe(",")
    expect(detectDelimiter("", "csv")).toBe(",")
  })
  it("只看首行：后面几行的分隔符不影响", () => {
    expect(detectDelimiter("a,b\n1;2;3;4;5;6", "csv")).toBe(",")
  })
})

describe("parseCsv", () => {
  it("基本表格，CRLF 和 LF 都认", () => {
    expect(parseCsv("a,b\r\n1,2\n3,4").rows).toEqual([["a", "b"], ["1", "2"], ["3", "4"]])
  })

  it("引号里可以有分隔符、换行和成对的引号", () => {
    const { rows } = parseCsv('name,note\n"Smith, J","line1\nline2"\n"say ""hi""",x')
    expect(rows).toEqual([["name", "note"], ["Smith, J", "line1\nline2"], ['say "hi"', "x"]])
  })

  it("空字段保留，引号包的空串也是空字段", () => {
    expect(parseCsv('a,,c\n"",x,').rows).toEqual([["a", "", "c"], ["", "x", ""]])
  })

  it("文件末尾的换行不产生多余的行；空行跳过", () => {
    expect(parseCsv("a,b\n1,2\n").rows).toEqual([["a", "b"], ["1", "2"]])
    expect(parseCsv("a\n\nb\n").rows).toEqual([["a"], ["b"]])
  })

  it("其它分隔符", () => {
    expect(parseCsv("a;b\n1;2", ";").rows).toEqual([["a", "b"], ["1", "2"]])
    expect(parseCsv("a\tb\n1\t2", "\t").rows).toEqual([["a", "b"], ["1", "2"]])
  })

  it("maxRows 到了就停，并告诉调用方被截断了", () => {
    const r = parseCsv("1\n2\n3\n4\n5", ",", 3)
    expect(r.rows).toEqual([["1"], ["2"], ["3"]])
    expect(r.truncated).toBe(true)
  })

  it("刚好 maxRows 行且后面没有内容：不算截断", () => {
    expect(parseCsv("1\n2\n3\n", ",", 3)).toEqual({ rows: [["1"], ["2"], ["3"]], truncated: false })
    expect(parseCsv("1\n2\n3", ",", 3).truncated).toBe(false)
  })

  it("引号没闭合的残缺文件也不会死循环或抛错", () => {
    expect(parseCsv('a,"unterminated\nstill in quote').rows).toEqual([["a", "unterminated\nstill in quote"]])
  })

  it("空文本没有行", () => {
    expect(parseCsv("")).toEqual({ rows: [], truncated: false })
  })
})

describe("splitTextLines / formatBytes", () => {
  it("CRLF、CR、LF 统一按行切", () => {
    expect(splitTextLines("a\r\nb\rc\nd")).toEqual(["a", "b", "c", "d"])
  })
  it("formatBytes", () => {
    expect(formatBytes(0)).toBe("0 B")
    expect(formatBytes(1023)).toBe("1023 B")
    expect(formatBytes(1536)).toBe("1.5 KB")
    expect(formatBytes(5 * 1024 * 1024)).toBe("5.0 MB")
    expect(formatBytes(3 * 1024 ** 3)).toBe("3.0 GB")
  })
})

describe("splitHighlightedLines", () => {
  it("没有换行：一行", () => {
    expect(splitHighlightedLines('<span class="a">x</span>')).toEqual(['<span class="a">x</span>'])
  })

  it("跨行的 span 在行尾闭合、下一行重新打开，每行单独都是合法片段", () => {
    const html = 'a <span class="hljs-comment">/* one\ntwo\nthree */</span> b'
    expect(splitHighlightedLines(html)).toEqual([
      'a <span class="hljs-comment">/* one</span>',
      '<span class="hljs-comment">two</span>',
      '<span class="hljs-comment">three */</span> b',
    ])
  })

  it("嵌套 span 跨行：按嵌套顺序闭合和重开", () => {
    const html = '<span class="o"><span class="i">x\ny</span> z</span>'
    expect(splitHighlightedLines(html)).toEqual([
      '<span class="o"><span class="i">x</span></span>',
      '<span class="o"><span class="i">y</span> z</span>',
    ])
  })

  it("空行保留", () => {
    expect(splitHighlightedLines("a\n\nb")).toEqual(["a", "", "b"])
  })

  it("切完再拼回去，去掉标签后的文本和原文一致", () => {
    const html = '<span class="k">if</span> (x) {\n  <span class="s">"a\nb"</span>\n}'
    const strip = (s: string) => s.replace(/<[^>]+>/g, "")
    expect(splitHighlightedLines(html).map(strip).join("\n")).toBe(strip(html))
  })
})
