import JSZip from "jszip"
import { DOMParser } from "@xmldom/xmldom"
import { describe, expect, it } from "vitest"
import { XLSX_MAX_COLS, XLSX_MAX_ROWS, XlsxFormatError, columnLabel, openXlsx, type ParseXml, type XlsxCell } from "../src/shared/preview-xlsx"

const parseXml: ParseXml = (text) =>
  new DOMParser({ errorHandler: { warning() {}, error() {}, fatalError(m) { throw new Error(m) } } })
    .parseFromString(text, "text/xml") as unknown as Document

const NS = 'xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"'

async function zipOf(parts: Record<string, string>, compression: "STORE" | "DEFLATE" = "STORE"): Promise<Uint8Array> {
  const zip = new JSZip()
  for (const [name, text] of Object.entries(parts)) zip.file(name, text)
  return zip.generateAsync({ type: "uint8array", compression })
}

function workbookXml(sheets: { name: string; rid: string; state?: string }[], props = ""): string {
  const list = sheets.map((s, i) => `<sheet name="${s.name}" sheetId="${i + 1}"${s.state ? ` state="${s.state}"` : ""} r:id="${s.rid}"/>`).join("")
  return `<?xml version="1.0" encoding="UTF-8"?><workbook ${NS}>${props}<sheets>${list}</sheets></workbook>`
}

function relsXml(rels: { id: string; target: string }[]): string {
  return `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${
    rels.map((r) => `<Relationship Id="${r.id}" Type="worksheet" Target="${r.target}"/>`).join("")}</Relationships>`
}

const sheetXml = (rowsXml: string, extra = "", before = "") => `<?xml version="1.0"?><worksheet ${NS}>${before}<sheetData>${rowsXml}</sheetData>${extra}</worksheet>`

/** 只有一个工作表的最小工作簿 */
function simple(sheet: string, extraParts: Record<string, string> = {}, props = ""): Promise<Uint8Array> {
  return zipOf({
    "xl/workbook.xml": workbookXml([{ name: "Sheet1", rid: "rId1" }], props),
    "xl/_rels/workbook.xml.rels": relsXml([{ id: "rId1", target: "worksheets/sheet1.xml" }]),
    "xl/worksheets/sheet1.xml": sheet,
    ...extraParts,
  })
}

async function firstSheet(bytes: Uint8Array) {
  return (await openXlsx(bytes, parseXml)).readSheet(0)
}

const texts = (row: (XlsxCell | undefined)[] | undefined) => (row ?? []).map((c) => c?.text)

describe("columnLabel", () => {
  it("A–Z、AA、ZZ、AAA 的边界", () => {
    expect([0, 1, 25, 26, 27, 51, 52, 701, 702].map(columnLabel)).toEqual(["A", "B", "Z", "AA", "AB", "AZ", "BA", "ZZ", "AAA"])
  })
})

describe("工作簿目录", () => {
  it("工作表名、隐藏状态，按 rId 对应到各自的文件（不是按顺序）", async () => {
    const bytes = await zipOf({
      "xl/workbook.xml": workbookXml([
        { name: "汇总", rid: "rId7" },
        { name: "明细", rid: "rId3", state: "hidden" },
        { name: "草稿", rid: "rId9", state: "veryHidden" },
      ]),
      "xl/_rels/workbook.xml.rels": relsXml([
        { id: "rId3", target: "worksheets/detail.xml" },
        { id: "rId7", target: "/xl/worksheets/summary.xml" },
        { id: "rId9", target: "../xl/worksheets/draft.xml" },
      ]),
      "xl/worksheets/summary.xml": sheetXml('<row r="1"><c r="A1" t="inlineStr"><is><t>汇总页</t></is></c></row>'),
      "xl/worksheets/detail.xml": sheetXml('<row r="1"><c r="A1" t="inlineStr"><is><t>明细页</t></is></c></row>'),
      "xl/worksheets/draft.xml": sheetXml('<row r="1"><c r="A1" t="inlineStr"><is><t>草稿页</t></is></c></row>'),
    })
    const wb = await openXlsx(bytes, parseXml)
    expect(wb.sheets).toEqual([
      { name: "汇总", hidden: false },
      { name: "明细", hidden: true },
      { name: "草稿", hidden: true },
    ])
    expect(texts((await wb.readSheet(0)).rows[0])).toEqual(["汇总页"])
    expect(texts((await wb.readSheet(1)).rows[0])).toEqual(["明细页"])
    expect(texts((await wb.readSheet(2)).rows[0])).toEqual(["草稿页"])
  })

  it("没有 rels 文件时按 sheetN.xml 顺序猜", async () => {
    const bytes = await zipOf({
      "xl/workbook.xml": workbookXml([{ name: "A", rid: "rId1" }, { name: "B", rid: "rId2" }]),
      "xl/worksheets/sheet1.xml": sheetXml('<row r="1"><c r="A1" t="inlineStr"><is><t>one</t></is></c></row>'),
      "xl/worksheets/sheet2.xml": sheetXml('<row r="1"><c r="A1" t="inlineStr"><is><t>two</t></is></c></row>'),
    })
    const wb = await openXlsx(bytes, parseXml)
    expect(texts((await wb.readSheet(1)).rows[0])).toEqual(["two"])
  })
})

describe("单元格内容", () => {
  it("共享字符串、内联字符串、公式结果文本、布尔、错误值", async () => {
    const sst = `<?xml version="1.0"?><sst ${NS}><si><t>姓名</t></si><si><t xml:space="preserve"> 张三 </t></si></sst>`
    const bytes = await simple(sheetXml(
      '<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c><c r="C1" t="inlineStr"><is><t>内联</t></is></c></row>' +
      '<row r="2"><c r="A2" t="str"><f>A1&amp;"!"</f><v>姓名!</v></c><c r="B2" t="b"><v>1</v></c><c r="C2" t="b"><v>0</v></c><c r="D2" t="e"><v>#DIV/0!</v></c></row>',
    ), { "xl/sharedStrings.xml": sst })
    const sheet = await firstSheet(bytes)
    expect(texts(sheet.rows[0])).toEqual(["姓名", " 张三 ", "内联"])
    expect(texts(sheet.rows[1])).toEqual(["姓名!", "TRUE", "FALSE", "#DIV/0!"])
    expect(sheet.columns).toBe(4)
    expect(sheet.rowCount).toBe(2)
  })

  it("富文本分段的字符串接起来，拼音注释不算", async () => {
    const sst = `<?xml version="1.0"?><sst ${NS}><si><r><t>红</t></r><r><rPr><b/></rPr><t>色</t></r><rPh sb="0" eb="1"><t>ホン</t></rPh><phoneticPr fontId="1"/></si></sst>`
    const sheet = await firstSheet(await simple(sheetXml('<row r="1"><c r="A1" t="s"><v>0</v></c></row>'), { "xl/sharedStrings.xml": sst }))
    expect(texts(sheet.rows[0])).toEqual(["红色"])
  })

  it("数字按单元格样式的格式显示：内置、自定义、日期、百分比", async () => {
    const styles = `<?xml version="1.0"?><styleSheet ${NS}>
      <numFmts count="1"><numFmt numFmtId="164" formatCode="0.0&quot; kg&quot;"/></numFmts>
      <cellStyleXfs count="1"><xf numFmtId="9"/></cellStyleXfs>
      <cellXfs count="5"><xf numFmtId="0"/><xf numFmtId="2"/><xf numFmtId="14"/><xf numFmtId="9"/><xf numFmtId="164"/></cellXfs></styleSheet>`
    const sheet = await firstSheet(await simple(sheetXml(
      '<row r="1"><c r="A1"><v>1234.5</v></c><c r="B1" s="1"><v>1234.5</v></c><c r="C1" s="2"><v>45292</v></c><c r="D1" s="3"><v>0.256</v></c><c r="E1" s="4"><v>72.46</v></c></row>',
    ), { "xl/styles.xml": styles }))
    // A1 没有 s：用 cellXfs 第 0 项（常规），不能被 cellStyleXfs 里的 9（百分比）带偏
    expect(texts(sheet.rows[0])).toEqual(["1234.5", "1234.50", "2024-01-01", "26%", "72.5 kg"])
  })

  it("数字靠右，文字不靠右", async () => {
    const sheet = await firstSheet(await simple(sheetXml('<row r="1"><c r="A1"><v>1</v></c><c r="B1" t="inlineStr"><is><t>x</t></is></c></row>')))
    expect(sheet.rows[0][0]?.right).toBe(true)
    expect(sheet.rows[0][1]?.right).toBeUndefined()
  })

  it("工作簿用 1904 日期系统时，日期换算跟着变", async () => {
    const styles = `<?xml version="1.0"?><styleSheet ${NS}><cellXfs count="2"><xf numFmtId="0"/><xf numFmtId="14"/></cellXfs></styleSheet>`
    const sheet = await firstSheet(await simple(
      sheetXml('<row r="1"><c r="A1" s="1"><v>1461</v></c></row>'),
      { "xl/styles.xml": styles },
      '<workbookPr date1904="1"/>',
    ))
    expect(texts(sheet.rows[0])).toEqual(["1908-01-01"])
  })

  it("部件开头带 UTF-8 BOM：交给解析器的文本里不留 BOM（有的解析器会因此报错）", async () => {
    const noBom: ParseXml = (text) => {
      if (text.charCodeAt(0) === 0xfeff) throw new Error("parser choked on BOM")
      return parseXml(text)
    }
    const bytes = await simple("\uFEFF" + sheetXml('<row r="1"><c r="A1"><v>3</v></c></row>'))
    expect(texts((await (await openXlsx(bytes, noBom)).readSheet(0)).rows[0])).toEqual(["3"])
  })

  it("公式有缓存结果就显示结果；没有（脚本生成的文件）就显示公式本身并标记", async () => {
    const sheet = await firstSheet(await simple(sheetXml(
      '<row r="1"><c r="A1"><f>SUM(B1:B3)</f><v>6</v></c><c r="B1"><f>SUM(C1:C3)</f></c><c r="C1" t="str"><f>A1&amp;"x"</f></c></row>',
    )))
    expect(sheet.rows[0][0]).toEqual({ text: "6", right: true })
    expect(sheet.rows[0][1]).toEqual({ text: "=SUM(C1:C3)", formula: true })
    expect(sheet.rows[0][2]).toEqual({ text: '=A1&"x"', formula: true })
  })

  it("空单元格、共享公式里没写公式的后续格、指向不存在的共享字符串：不占位", async () => {
    const sheet = await firstSheet(await simple(sheetXml(
      '<row r="1"><c r="A1"/><c r="B1"><f t="shared" si="0"/></c><c r="C1" t="s"><v>99</v></c><c r="D1"><v>7</v></c></row>',
    )))
    expect(texts(sheet.rows[0])).toEqual([undefined, undefined, undefined, "7"])
  })

  it("样式表缺失、样式下标越界都按常规显示", async () => {
    const sheet = await firstSheet(await simple(sheetXml('<row r="1"><c r="A1" s="42"><v>0.5</v></c></row>')))
    expect(texts(sheet.rows[0])).toEqual(["0.5"])
  })

  it("数字单元格里不是数字的内容原样显示", async () => {
    const sheet = await firstSheet(await simple(sheetXml('<row r="1"><c r="A1"><v>abc</v></c></row>')))
    expect(texts(sheet.rows[0])).toEqual(["abc"])
  })
})

describe("位置", () => {
  it("行、单元格没有 r 属性时按顺序排；有 r 就按 r 放，中间留空", async () => {
    const sheet = await firstSheet(await simple(sheetXml(
      '<row><c t="inlineStr"><is><t>a</t></is></c><c t="inlineStr"><is><t>b</t></is></c></row>' +
      '<row r="4"><c r="C4" t="inlineStr"><is><t>c</t></is></c><c t="inlineStr"><is><t>d</t></is></c></row>' +
      '<row><c r="AA6" t="inlineStr"><is><t>e</t></is></c></row>',
    )))
    expect(texts(sheet.rows[0])).toEqual(["a", "b"])
    expect(texts(sheet.rows[1])).toEqual([])
    expect(texts(sheet.rows[3])).toEqual([undefined, undefined, "c", "d"])
    // 没写 r 的行排在上一行（第 4 行）后面，就是第 5 行；AA 列是第 27 列
    expect(sheet.rows[4][26]?.text).toBe("e")
    expect(sheet.rowCount).toBe(5)
    expect(sheet.columns).toBe(27)
    expect(sheet.rows).toHaveLength(5)
  })

  it("列宽按字符数换成像素，没设的列是 undefined", async () => {
    const sheet = await firstSheet(await simple(sheetXml(
      '<row r="1"><c r="A1"><v>1</v></c><c r="B1"><v>2</v></c><c r="C1"><v>3</v></c><c r="D1"><v>4</v></c></row>',
      '', '<cols><col min="1" max="2" width="10" customWidth="1"/><col min="4" max="4" width="500"/></cols>',
    )))
    expect(sheet.colWidths[0]).toBe(75)
    expect(sheet.colWidths[1]).toBe(75)
    expect(sheet.colWidths[2]).toBeUndefined()
    expect(sheet.colWidths[3]).toBe(480)
  })
})

describe("合并区域", () => {
  it("读出左上角和跨度，合并出来的空白也计入行列数", async () => {
    const sheet = await firstSheet(await simple(sheetXml(
      '<row r="1"><c r="A1" t="inlineStr"><is><t>标题</t></is></c></row>',
      '<mergeCells count="4"><mergeCell ref="A1:D2"/><mergeCell ref="B4:B6"/><mergeCell ref="F1"/><mergeCell ref="F3:F3"/></mergeCells>',
    )))
    expect(sheet.merges).toEqual([
      { row: 0, col: 0, rows: 2, cols: 4 },
      { row: 3, col: 1, rows: 3, cols: 1 },
    ])
    expect(sheet.rowCount).toBe(6)
    expect(sheet.columns).toBe(4)
  })

  it("超出显示范围的合并区域被截断或丢掉", async () => {
    const sheet = await firstSheet(await simple(sheetXml(
      '<row r="1"><c r="A1"><v>1</v></c></row>',
      `<mergeCells><mergeCell ref="A1:ZZ9999"/><mergeCell ref="A6000:B6001"/><mergeCell ref="DA1:DB2"/></mergeCells>`,
    )))
    expect(sheet.merges).toEqual([{ row: 0, col: 0, rows: XLSX_MAX_ROWS, cols: XLSX_MAX_COLS }])
    expect(sheet.rowCount).toBe(XLSX_MAX_ROWS)
    expect(sheet.columns).toBe(XLSX_MAX_COLS)
  })
})

describe("截断", () => {
  it("行数超过上限：只留前 XLSX_MAX_ROWS 行并标记", async () => {
    const rows = Array.from({ length: XLSX_MAX_ROWS + 3 }, (_, i) => `<row r="${i + 1}"><c r="A${i + 1}"><v>${i + 1}</v></c></row>`).join("")
    const sheet = await firstSheet(await simple(sheetXml(rows)))
    expect(sheet.truncatedRows).toBe(true)
    expect(sheet.truncatedCols).toBe(false)
    expect(sheet.rowCount).toBe(XLSX_MAX_ROWS)
    expect(sheet.rows[XLSX_MAX_ROWS - 1][0]?.text).toBe(String(XLSX_MAX_ROWS))
  })

  it("刚好是上限不算截断", async () => {
    const rows = Array.from({ length: XLSX_MAX_ROWS }, (_, i) => `<row r="${i + 1}"><c r="A${i + 1}"><v>1</v></c></row>`).join("")
    const sheet = await firstSheet(await simple(sheetXml(rows)))
    expect(sheet.truncatedRows).toBe(false)
    expect(sheet.rowCount).toBe(XLSX_MAX_ROWS)
  })

  it("列数超过上限：丢掉多出来的列并标记", async () => {
    const cells = Array.from({ length: XLSX_MAX_COLS + 2 }, (_, i) => {
      let n = i + 1
      let letters = ""
      while (n > 0) { letters = String.fromCharCode(65 + ((n - 1) % 26)) + letters; n = Math.floor((n - 1) / 26) }
      return `<c r="${letters}1"><v>${i}</v></c>`
    }).join("")
    const sheet = await firstSheet(await simple(sheetXml(`<row r="1">${cells}</row>`)))
    expect(sheet.truncatedCols).toBe(true)
    expect(sheet.columns).toBe(XLSX_MAX_COLS)
    expect(sheet.rows[0][XLSX_MAX_COLS - 1]?.text).toBe(String(XLSX_MAX_COLS - 1))
    expect(sheet.rows[0]).toHaveLength(XLSX_MAX_COLS)
  })
})

describe("打不开的文件", () => {
  it("OLE 容器（设了密码的 xlsx、旧版 xls）：说明原因", async () => {
    const ole = new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0, 0, 0, 0])
    await expect(openXlsx(ole, parseXml)).rejects.toThrow(/密码|旧版/)
  })

  it("不是 zip", async () => {
    await expect(openXlsx(new TextEncoder().encode("hello, this is not a zip file at all"), parseXml)).rejects.toBeInstanceOf(XlsxFormatError)
  })

  it("是 zip 但缺工作簿", async () => {
    await expect(openXlsx(await zipOf({ "readme.txt": "x" }), parseXml)).rejects.toThrow("缺少工作簿")
  })

  it("工作簿里没有工作表", async () => {
    const bytes = await zipOf({ "xl/workbook.xml": workbookXml([]) })
    await expect(openXlsx(bytes, parseXml)).rejects.toThrow("没有工作表")
  })

  it("读不存在的工作表序号、对应文件缺失", async () => {
    const wb = await openXlsx(await zipOf({ "xl/workbook.xml": workbookXml([{ name: "A", rid: "rId1" }]) }), parseXml)
    await expect(wb.readSheet(5)).rejects.toThrow("没有这个工作表")
    await expect(wb.readSheet(0)).rejects.toThrow("找不到工作表")
  })

  it("单个部件解压后太大：不去解析，直接说明", async () => {
    const huge = sheetXml("") + " ".repeat(61 * 1024 * 1024)
    const big = await zipOf({
      "xl/workbook.xml": workbookXml([{ name: "Sheet1", rid: "rId1" }]),
      "xl/_rels/workbook.xml.rels": relsXml([{ id: "rId1", target: "worksheets/sheet1.xml" }]),
      "xl/worksheets/sheet1.xml": huge,
    }, "DEFLATE")
    expect(big.length).toBeLessThan(1024 * 1024) // 压缩后很小：大小必须看中央目录里记的原始大小，不能看文件本身多大
    const wb = await openXlsx(big, parseXml)
    await expect(wb.readSheet(0)).rejects.toThrow("数据量太大")
  })
})
