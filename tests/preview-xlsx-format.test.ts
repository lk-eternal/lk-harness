import { describe, expect, it } from "vitest"
import { formatGeneral, formatNumber, numFmtCode, splitSections } from "../src/shared/preview-xlsx-format"

// Excel 序列号：2024-01-01 = 45292
const D = 45292

describe("formatGeneral（常规）", () => {
  it.each([
    [0, "0"],
    [100, "100"],
    [-5, "-5"],
    [1234.5, "1234.5"],
    [0.1 + 0.2, "0.3"], // 浮点噪声不外露
    [1 / 3, "0.333333333333333"],
    [123456789012, "123456789012"],
    [1e20, "1E+20"],
    [-1.5e20, "-1.5E+20"],
    [0.0000001234, "1.234E-07"],
    [0.000001234, "0.000001234"],
    [0.0001234, "0.0001234"],
  ])("%s → %s", (n, text) => {
    expect(formatGeneral(n)).toBe(text)
  })
  it("NaN / Infinity 原样", () => {
    expect(formatGeneral(Infinity)).toBe("Infinity")
  })
})

describe("数字格式", () => {
  it.each([
    ["0", 3.6, "4"],
    ["0.00", 3.14159, "3.14"],
    ["0.00", 2, "2.00"],
    ["0.00", 1.005, "1.01"], // 十进制四舍五入，不是 toFixed 的 1.00
    ["0.00", -1.5, "-1.50"],
    ["#,##0", 1234567.89, "1,234,568"],
    ["#,##0", 999.5, "1,000"],
    ["#,##0", 0, "0"],
    ["#,##0", 12, "12"],
    ["#,##0.00", 1234.5, "1,234.50"],
    ["#,##0.00", -1234.5, "-1,234.50"],
    ["0%", 0.256, "26%"],
    ["0.00%", 0.5, "50.00%"],
    ["0.0%", 0.12345, "12.3%"],
    ["00000", 42, "00042"],
    ["#.00", 0.5, ".50"],
    ["#.##", 3, "3"],
    ["0.##", 2.5, "2.5"],
    ["0.##", 2, "2"],
    ["0.0#", 1.5, "1.5"],
    ["0.0#", 1.256, "1.26"],
  ])("%s ← %s → %s", (code, n, text) => {
    expect(formatNumber(n, code)).toBe(text)
  })

  it.each([
    ['"¥"#,##0.00', 1234.5, "¥1,234.50"],
    ["[$¥-804]#,##0.00", 1234.5, "¥1,234.50"],
    ["$#,##0.00", 1234.5, "$1,234.50"],
    ['#,##0.00" 元"', 8, "8.00 元"],
    ['0.0" MB"', 3.14, "3.1 MB"],
    ["[$-409]#,##0", 1500, "1,500"], // 只有区域信息，没有符号
  ])("货币和单位：%s ← %s → %s", (code, n, text) => {
    expect(formatNumber(n, code)).toBe(text)
  })

  it.each([
    ["#,##0,", 1234567, "1,235"], // 末尾逗号：除以 1000
    ["0.0,,", 5_500_000, "5.5"],
    ['0.0,"K"', 1500, "1.5K"],
  ])("缩放：%s ← %s → %s", (code, n, text) => {
    expect(formatNumber(n, code)).toBe(text)
  })

  it.each([
    ["000-0000", 5551234, "555-1234"],
    ["(###) ###-####", 5551234567, "(555) 123-4567"],
    ["00-00", 5, "00-05"],
  ])("占位符之间夹着文字：%s ← %s → %s", (code, n, text) => {
    expect(formatNumber(n, code)).toBe(text)
  })

  it.each([
    ["0.00E+00", 12345.678, "1.23E+04"],
    ["0.00E+00", 0.00012, "1.20E-04"],
    ["0.0E+0", 99999, "1.0E+5"], // 进位后尾数是 10，要进到下一个指数
    ["0.00E+00", 0, "0.00E+00"],
  ])("科学计数：%s ← %s → %s", (code, n, text) => {
    expect(formatNumber(n, code)).toBe(text)
  })

  it("分节：负数用第二节、零用第三节；第二节自己带符号时不再补减号", () => {
    expect(formatNumber(1234.5, "#,##0.00;[Red]-#,##0.00")).toBe("1,234.50")
    expect(formatNumber(-1234.5, "#,##0.00;[Red]-#,##0.00")).toBe("-1,234.50")
    expect(formatNumber(-1234.5, "#,##0.00;(#,##0.00)")).toBe("(1,234.50)")
    expect(formatNumber(0, '0.00;-0.00;"零"')).toBe("零")
    expect(formatNumber(0, "0;;")).toBe("") // 常见的「零不显示」写法
    expect(formatNumber(5, "0;;")).toBe("5")
  })

  it("会计格式里的 _) 补一个空格宽度", () => {
    expect(formatNumber(12, "#,##0_);(#,##0)")).toBe("12 ")
    expect(formatNumber(-12, "#,##0_);(#,##0)")).toBe("(12)")
  })

  it("General / 空 / @ 走常规", () => {
    expect(formatNumber(0.1 + 0.2, "General")).toBe("0.3")
    expect(formatNumber(1.5, "general")).toBe("1.5")
    expect(formatNumber(1.5, "")).toBe("1.5")
    expect(formatNumber(1.5, "@")).toBe("1.5")
  })

  it("分数格式不硬算，显示原数值而不是错值", () => {
    expect(formatNumber(0.5, "# ?/?")).toBe("0.5")
    expect(formatNumber(1.25, "# ??/??")).toBe("1.25")
  })

  it("只有文字的格式照原样显示那段文字", () => {
    expect(formatNumber(1, '"已完成"')).toBe("已完成")
  })
})

describe("日期时间", () => {
  it.each([
    ["yyyy-mm-dd", D, "2024-01-01"],
    ["yyyy-mm-dd hh:mm:ss", D + 0.5, "2024-01-01 12:00:00"],
    ["m/d/yyyy", D, "1/1/2024"],
    ["mm/dd/yy", D, "01/01/24"],
    ["d-mmm-yy", D, "1-Jan-24"],
    ["mmm d, yyyy", D, "Jan 1, 2024"],
    ["mmmm", D, "January"],
    ["dddd", D, "Monday"],
    ["ddd", D, "Mon"],
    ['yyyy"年"m"月"d"日"', D, "2024年1月1日"],
    ["[$-409]d-mmm", D, "1-Jan"],
    ["yyyy-mm", D, "2024-01"],
  ])("%s ← %s → %s", (code, serial, text) => {
    expect(formatNumber(serial, code)).toBe(text)
  })

  it.each([
    ["h:mm", 0.5208333333333334, "12:30"],
    ["h:mm:ss", 0.75, "18:00:00"],
    ["hh:mm", 0.0625, "01:30"],
    ["h:mm AM/PM", 0.75, "6:00 PM"],
    ["h:mm AM/PM", 0.0208333333333333, "12:30 AM"],
    ["h:mm A/P", 0.75, "6:00 P"],
    ["mm:ss", 0.0007, "01:00"], // 前面没有 h、后面有 s：m 是「分」
    ["mm:ss.0", 0.00001, "00:00.9"], // 0.864 秒：显示一位小数是四舍五入的 0.9，不是截断的 0.8
    ["h:mm:ss.00", 0.5 + 0.0000123, "12:00:01.06"],
    ["yyyy-mm-dd hh:mm", D + 0.0625, "2024-01-01 01:30"],
  ])("时间 %s ← %s → %s", (code, serial, text) => {
    expect(formatNumber(serial, code)).toBe(text)
  })

  it("经过时长 [h]:mm:ss 不按 24 小时回绕", () => {
    expect(formatNumber(1.5, "[h]:mm:ss")).toBe("36:00:00")
    expect(formatNumber(2.25, "[h]:mm")).toBe("54:00")
    expect(formatNumber(0.5, "[mm]:ss")).toBe("720:00")
    expect(formatNumber(0.001, "[ss]")).toBe("86")
  })

  it("m 在 h 后面是分，单独出现是月", () => {
    expect(formatNumber(D + 0.0625, "h:mm")).toBe("1:30")
    expect(formatNumber(D, "m")).toBe("1")
    expect(formatNumber(D + 0.5, "yyyy-m-d h:m")).toBe("2024-1-1 12:0")
  })

  it("时间舍入到秒时进位到第二天（不会出现 24:00:00）", () => {
    expect(formatNumber(D + 0.99999999, "yyyy-mm-dd hh:mm:ss")).toBe("2024-01-02 00:00:00")
  })

  it("1900 系统：序列号 60 是 Excel 保留的 1900-02-29，61 才是 3 月 1 日", () => {
    expect(formatNumber(1, "yyyy-mm-dd")).toBe("1900-01-01")
    expect(formatNumber(59, "yyyy-mm-dd")).toBe("1900-02-28")
    expect(formatNumber(60, "yyyy-mm-dd")).toBe("1900-02-29")
    expect(formatNumber(61, "yyyy-mm-dd")).toBe("1900-03-01")
  })

  it("1904 系统：0 号是 1904-01-01", () => {
    expect(formatNumber(0, "yyyy-mm-dd", { date1904: true })).toBe("1904-01-01")
    expect(formatNumber(1461, "yyyy-mm-dd", { date1904: true })).toBe("1908-01-01") // 1904 是闰年：366 + 365 × 3 天
  })

  it("负数、超出 9999 年：不是合法日期，按常规显示数值", () => {
    expect(formatNumber(-1, "yyyy-mm-dd")).toBe("-1")
    expect(formatNumber(3_000_000, "yyyy-mm-dd")).toBe("3000000")
  })

  it("引号和转义里的 y/m/d/h/s 不当日期记号", () => {
    expect(formatNumber(5, '0" days"')).toBe("5 days")
    expect(formatNumber(5, '0\\d')).toBe("5d")
  })

  it("格式分节里带日期时只看被选中的那一节", () => {
    expect(formatNumber(D, "yyyy-mm-dd;@")).toBe("2024-01-01")
  })
})

describe("numFmtCode / splitSections", () => {
  it("自定义的优先，其次内置，都没有按常规", () => {
    const custom = new Map([[164, "0.0%"], [14, "dd/mm/yyyy"]])
    expect(numFmtCode(164, custom)).toBe("0.0%")
    expect(numFmtCode(14, custom)).toBe("dd/mm/yyyy")
    expect(numFmtCode(14, new Map())).toBe("yyyy-mm-dd")
    expect(numFmtCode(9, new Map())).toBe("0%")
    expect(numFmtCode(999, new Map())).toBe("General")
  })
  it("引号、方括号、转义里的分号不切分", () => {
    expect(splitSections('0.00;"a;b"')).toEqual(["0.00", '"a;b"'])
    expect(splitSections("[>1;x]0;0")).toEqual(["[>1;x]0", "0"])
    expect(splitSections("0\\;0;1")).toEqual(["0\\;0", "1"])
    expect(splitSections("0.00")).toEqual(["0.00"])
  })
})
