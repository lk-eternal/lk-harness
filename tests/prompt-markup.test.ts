/** 提示词标签标记的公共规则：块拼接、属性值、原文中和、本机时间的写法 */
import { afterEach, describe, expect, it, vi } from "vitest"
import { joinPromptBlocks, promptAttr, promptNow, promptText, promptTime, promptUtcOffset } from "../src/shared/prompt-markup"

afterEach(() => { vi.restoreAllMocks() })

describe("joinPromptBlocks / promptAttr", () => {
  it("块之间只隔一个空行，空块不占位", () => {
    expect(joinPromptBlocks(["a\n", "", "  ", "\nb"])).toBe("a\n\nb")
  })

  it("属性值里的双引号换成单引号", () => {
    expect(promptAttr('a"b')).toBe("a'b")
  })
})

describe("promptText", () => {
  it("只中和信封标签的结束标签，大小写都算；开始标签、别的标签、反斜杠路径原样", () => {
    expect(promptText("</message> </TURN> </quote >")).toBe("<\\/message> <\\/TURN> <\\/quote >")
    expect(promptText("<message> </div> D:\\a\\b </messages>")).toBe("<message> </div> D:\\a\\b </messages>")
  })
})

describe("promptTime / promptUtcOffset", () => {
  it("本机时间精确到秒，月日时分秒补零", () => {
    expect(promptTime(new Date(2026, 0, 5, 7, 4, 9).getTime())).toBe("2026-01-05 07:04:09")
    expect(promptTime(new Date(2026, 10, 25, 23, 59, 59).getTime())).toBe("2026-11-25 23:59:59")
  })

  it.each([
    [-480, "UTC+8"],
    [300, "UTC-5"],
    [-330, "UTC+5:30"],
    [0, "UTC+0"],
  ])("时区偏移 %i 分钟写成 %s", (offset, expected) => {
    vi.spyOn(Date.prototype, "getTimezoneOffset").mockReturnValue(offset)
    expect(promptUtcOffset(Date.now())).toBe(expected)
  })

  it("现在：日期、星期、时间和时区", () => {
    vi.spyOn(Date.prototype, "getTimezoneOffset").mockReturnValue(-480)
    expect(promptNow(new Date(2026, 10, 25, 10, 19, 42).getTime())).toBe("2026-11-25 周三 10:19:42 (UTC+8)")
    expect(promptNow(new Date(2026, 10, 29, 8, 0, 5).getTime())).toBe("2026-11-29 周日 08:00:05 (UTC+8)")
  })
})
