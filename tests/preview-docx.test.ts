import JSZip from "jszip"
import mammoth from "mammoth"
import { describe, expect, it } from "vitest"
import { DocxFormatError, convertDocxToPreview, stripLinks, wrapDocxHtml, type DocxConvert } from "../src/shared/preview-docx"

const W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"
const R = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
const REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"

async function makeDocx(bodyXml: string): Promise<Uint8Array> {
  const zip = new JSZip()
  zip.file("[Content_Types].xml", `<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
    <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
    <Default Extension="xml" ContentType="application/xml"/>
    <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
    <Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/></Types>`)
  zip.file("_rels/.rels", `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${REL}/officeDocument" Target="word/document.xml"/></Relationships>`)
  zip.file("word/_rels/document.xml.rels", `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
    <Relationship Id="rId1" Type="${REL}/styles" Target="styles.xml"/>
    <Relationship Id="rId5" Type="${REL}/hyperlink" Target="https://example.com/x" TargetMode="External"/></Relationships>`)
  zip.file("word/styles.xml", `<?xml version="1.0"?><w:styles xmlns:w="${W}"><w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/></w:style></w:styles>`)
  zip.file("word/document.xml", `<?xml version="1.0"?><w:document xmlns:w="${W}" xmlns:r="${R}"><w:body>${bodyXml}</w:body></w:document>`)
  return zip.generateAsync({ type: "uint8array" })
}

const convert: DocxConvert = (bytes) => mammoth.convertToHtml({ buffer: Buffer.from(bytes) })

const para = (text: string) => `<w:p><w:r><w:t xml:space="preserve">${text}</w:t></w:r></w:p>`

describe("stripLinks", () => {
  it("<a> 换成不可点的 span，文字留着", () => {
    expect(stripLinks('<p><a href="https://x.com" id="a1">文字</a></p>')).toBe('<p><span class="lnk">文字</span></p>')
  })

  it("大写标签、没有属性的 <a>、多个链接", () => {
    expect(stripLinks('<A HREF="x">1</A><a>2</a><a href="y">3</a>')).toBe('<span class="lnk">1</span><span class="lnk">2</span><span class="lnk">3</span>')
  })

  it("名字以 a 开头的其他标签不动", () => {
    const html = "<abbr>x</abbr><address>y</address><article>z</article>"
    expect(stripLinks(html)).toBe(html)
  })

  it("没有任何 href 能留下来", () => {
    expect(stripLinks('<a href="javascript:alert(1)">x</a><a\nhref="https://a">y</a>')).not.toMatch(/href/i)
  })
})

describe("wrapDocxHtml", () => {
  it("带编码声明和 CSP：不允许脚本和网络，只放行 data: 图片", () => {
    const html = wrapDocxHtml("<p>正文</p>")
    expect(html).toContain('<meta charset="utf-8">')
    expect(html).toContain("default-src 'none'")
    expect(html).toContain("img-src data:")
    expect(html).not.toMatch(/script-src|connect-src/)
    expect(html).toContain("<body><p>正文</p></body>")
  })
})

describe("convertDocxToPreview（真实的 mammoth）", () => {
  it("标题、粗体、表格转成对应的 HTML", async () => {
    const bytes = await makeDocx(
      `<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>季度报告</w:t></w:r></w:p>` +
      `<w:p><w:r><w:rPr><w:b/></w:rPr><w:t>重点</w:t></w:r><w:r><w:t xml:space="preserve"> 普通文字</w:t></w:r></w:p>` +
      `<w:tbl><w:tr><w:tc><w:p><w:r><w:t>单元格甲</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>单元格乙</w:t></w:r></w:p></w:tc></w:tr></w:tbl>`,
    )
    const out = await convertDocxToPreview(bytes, convert)
    expect(out.empty).toBe(false)
    expect(out.srcdoc).toContain("<h1>季度报告</h1>")
    expect(out.srcdoc).toContain("<strong>重点</strong>")
    expect(out.srcdoc).toMatch(/<table>[\s\S]*单元格甲[\s\S]*单元格乙[\s\S]*<\/table>/)
  })

  it("超链接：文字留着，href 去掉", async () => {
    const bytes = await makeDocx(`<w:p><w:hyperlink r:id="rId5"><w:r><w:t>点这里</w:t></w:r></w:hyperlink></w:p>`)
    // 先确认 mammoth 确实会生成 <a href>，否则下面的断言什么也没证明
    expect((await convert(bytes)).value).toContain('<a href="https://example.com/x">')
    const out = await convertDocxToPreview(bytes, convert)
    expect(out.srcdoc).toContain('<span class="lnk">点这里</span>')
    expect(out.srcdoc).not.toContain("example.com")
    expect(out.srcdoc).not.toMatch(/<a[\s>]/i)
  })

  it("文字里的 <script> 是被转义的文本，不会变成标签", async () => {
    const bytes = await makeDocx(para("&lt;script&gt;alert(1)&lt;/script&gt;&lt;img src=x onerror=alert(2)&gt;"))
    const out = await convertDocxToPreview(bytes, convert)
    const body = out.srcdoc.slice(out.srcdoc.indexOf("<body>"))
    expect(body).not.toContain("<script")
    expect(body).not.toContain("<img")
    expect(body).toContain("&lt;script&gt;")
  })

  it("空文档、只有空段落：标记为空", async () => {
    expect((await convertDocxToPreview(await makeDocx(""), convert)).empty).toBe(true)
    expect((await convertDocxToPreview(await makeDocx(para("   ") + para("&#160;")), convert)).empty).toBe(true)
  })
})

describe("convertDocxToPreview（注入转换结果）", () => {
  const fake = (value: string): DocxConvert => async () => ({ value, messages: [] })

  it("有图片或表格就算有内容，即使没有文字", async () => {
    expect((await convertDocxToPreview(new Uint8Array(), fake('<p><img src="data:image/png;base64,AAAA" /></p>'))).empty).toBe(false)
    expect((await convertDocxToPreview(new Uint8Array(), fake("<table><tr><td></td></tr></table>"))).empty).toBe(false)
  })

  it("只有空白和 &nbsp;、空标签：算空", async () => {
    expect((await convertDocxToPreview(new Uint8Array(), fake("<p> </p><p>&nbsp;</p><h1></h1>"))).empty).toBe(true)
  })

  it("转换器抛错：包成能直接给用户看的说明，保留原始原因", async () => {
    const boom: DocxConvert = async () => { throw new Error("坏文件") }
    const err = await convertDocxToPreview(new Uint8Array([1, 2, 3]), boom).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(DocxFormatError)
    expect((err as Error).message).toMatch(/无法解析这个文档.*坏文件/)
  })

  it("OLE 容器（旧版 .doc、设了密码的 docx）：不交给转换器，直接说明", async () => {
    let called = false
    const spy: DocxConvert = async () => { called = true; return { value: "", messages: [] } }
    const ole = new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])
    await expect(convertDocxToPreview(ole, spy)).rejects.toThrow(/密码|旧版/)
    expect(called).toBe(false)
  })

  it("真实 mammoth 遇到不是 docx 的 zip：给出说明而不是原始英文报错", async () => {
    const zip = new JSZip()
    zip.file("hello.txt", "hi")
    const bytes = await zip.generateAsync({ type: "uint8array" })
    await expect(convertDocxToPreview(bytes, convert)).rejects.toThrow(/无法解析这个文档/)
  })
})
