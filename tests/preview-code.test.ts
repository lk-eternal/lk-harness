import { describe, expect, it } from "vitest"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { HIGHLIGHT_MAX_CHARS, MAX_RENDER_LINES, escapeHtml, toCodeLines } from "../src/renderer/components/preview/code-highlight"
import { resolveMarkdownImage } from "../src/renderer/components/preview/TextViewers"
import { PreviewContext, type PreviewApi } from "../src/renderer/components/preview/PreviewContext"
import { SafeLink } from "../src/renderer/components/chat/Markdown"
import { previewLanguages } from "../src/shared/preview-kinds"

describe("escapeHtml", () => {
  it("转义 & < > 引号", () => {
    expect(escapeHtml(`<a href="x" onclick='y'>&</a>`)).toBe("&lt;a href=&quot;x&quot; onclick=&#39;y&#39;&gt;&amp;&lt;/a&gt;")
  })
})

describe("toCodeLines", () => {
  it("认识的语言：高亮，每行一段", () => {
    const r = toCodeLines("const a = 1\nlet b = 'x'", "typescript")
    expect(r.highlighted).toBe(true)
    expect(r.lines).toHaveLength(2)
    expect(r.lines[0]).toContain('class="hljs-keyword"')
    expect(r.lines[1]).toContain("hljs-string")
  })

  it("跨行的块注释：每一行单独都是配平的 span", () => {
    const r = toCodeLines("/* a\nb\nc */\nx", "javascript")
    expect(r.lines).toHaveLength(4)
    for (const line of r.lines) {
      expect((line.match(/<span/g) ?? []).length).toBe((line.match(/<\/span>/g) ?? []).length)
    }
    expect(r.lines[1]).toContain("hljs-comment")
  })

  it("没有语言 / 不认识的语言：纯文本，且必须转义（文件内容不可信）", () => {
    for (const lang of [undefined, "no-such-lang"]) {
      const r = toCodeLines('<script>alert("x")</script>', lang)
      expect(r.highlighted).toBe(false)
      expect(r.lines).toEqual(["&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;"])
    }
  })

  it("高亮结果里恶意标签同样被转义（没有任何未转义的 <script>）", () => {
    const r = toCodeLines('x = "</span><img src=x onerror=alert(1)>"', "python")
    const html = r.lines.join("\n")
    expect(html).not.toContain("<img")
    expect(html).not.toContain("<script")
  })

  it("文件以换行结尾：不多出一个空行；中间的空行保留；CRLF 当一个换行", () => {
    expect(toCodeLines("a\nb\n", undefined).lines).toEqual(["a", "b"])
    expect(toCodeLines("a\r\n\r\nb", undefined).lines).toEqual(["a", "", "b"])
    expect(toCodeLines("", undefined).lines).toEqual([""])
  })

  it("太大的文本不做高亮（高亮会卡住界面），但仍然转义", () => {
    const big = "<" + "x".repeat(HIGHLIGHT_MAX_CHARS)
    const r = toCodeLines(big, "javascript")
    expect(r.highlighted).toBe(false)
    expect(r.lines[0].startsWith("&lt;xxx")).toBe(true)
  })

  it("行数太多：只给前面一部分并标出被截断", () => {
    const text = Array.from({ length: MAX_RENDER_LINES + 5 }, (_, i) => String(i)).join("\n")
    const r = toCodeLines(text, undefined)
    expect(r.cutOff).toBe(true)
    expect(r.lines).toHaveLength(MAX_RENDER_LINES)
    expect(toCodeLines("a\nb", undefined).cutOff).toBe(false)
  })

  it("扩展名表里用到的每一种语言，界面里都注册过（否则那种文件不会高亮）", () => {
    for (const lang of previewLanguages()) {
      expect(toCodeLines("x", lang).highlighted, lang).toBe(true)
    }
  })
})

describe("resolveMarkdownImage", () => {
  const base = "lkfile://tok123/readme.md"

  it("相对路径解到令牌覆盖的目录里", () => {
    expect(resolveMarkdownImage("img/a.png", base)).toBe("lkfile://tok123/img/a.png")
    expect(resolveMarkdownImage("./a b.png", base)).toBe("lkfile://tok123/a%20b.png")
  })

  it("用 .. 也走不出令牌这一级（仍落在同一个令牌下，越权由服务端 403）", () => {
    expect(resolveMarkdownImage("../../x.png", base)).toBe("lkfile://tok123/x.png")
  })

  it("网络图片、data:、file:、其它协议、绝对路径、锚点：不加载", () => {
    for (const src of [
      "https://tracker.example/p.gif", "http://a.com/a.png", "//a.com/a.png", "data:image/png;base64,AAAA",
      "file:///C:/secret.png", "lkfile://other/x.png", "javascript:alert(1)", "/etc/passwd", "\\\\host\\share\\a.png", "C:\\secret.png", "#frag", "", undefined,
    ]) {
      expect(resolveMarkdownImage(src, base), String(src)).toBeUndefined()
    }
  })
})

describe("SafeLink（对话里的链接）", () => {
  const api = (over: Partial<PreviewApi>): PreviewApi => ({ available: true, linkMode: "internal", openFile: () => {}, openUrl: () => {}, ...over })
  const html = (href: string | undefined, ctx?: PreviewApi) => {
    const el = createElement(SafeLink, { href }, "文字")
    return renderToStaticMarkup(ctx ? createElement(PreviewContext.Provider, { value: ctx }, el) : el)
  }

  it("http(s) 链接仍然是 target=_blank + noopener（点击行为由 onClick 决定）", () => {
    for (const ctx of [undefined, api({}), api({ linkMode: "external" })]) {
      const out = html("https://a.com/x", ctx)
      expect(out).toContain('href="https://a.com/x"')
      expect(out).toContain('target="_blank"')
      expect(out).toContain('rel="noreferrer noopener"')
    }
  })

  it("其它协议的链接不渲染成可点的 <a>（Agent 输出不可信）", () => {
    for (const href of ["javascript:alert(1)", "file:///C:/Windows/win.ini", "lkfile://t/x", "data:text/html,x", undefined]) {
      const out = html(href, api({}))
      expect(out, String(href)).not.toContain("<a")
      expect(out).toContain("文字")
    }
  })
})
