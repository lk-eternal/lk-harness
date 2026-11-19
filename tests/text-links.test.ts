import { describe, expect, it } from "vitest"
import { splitTextLinks, type TextPart } from "../src/shared/text-links"

const text = (t: string): TextPart => ({ kind: "text", text: t })
const link = (url: string): TextPart => ({ kind: "link", url })

describe("splitTextLinks", () => {
  it("没有网址：整段都是普通文字，空串没有片段", () => {
    expect(splitTextLinks("")).toEqual([])
    expect(splitTextLinks("D:\\lk-harness-projects\\排课2-0")).toEqual([text("D:\\lk-harness-projects\\排课2-0")])
  })

  it("整段就是一个网址（项目链接、项目信息里的文档地址）", () => {
    expect(splitTextLinks("https://wukongedu.feishu.cn/wiki/JJv3wbNEOitJQQkIZ6AcwndGnie"))
      .toEqual([link("https://wukongedu.feishu.cn/wiki/JJv3wbNEOitJQQkIZ6AcwndGnie")])
    expect(splitTextLinks("HTTPS://A.COM/X")).toEqual([link("HTTPS://A.COM/X")])
  })

  it("多个网址：换行、逗号、空格隔开都能分开，顺序不变", () => {
    expect(splitTextLinks("https://a.com/1, https://b.com/2\nhttps://c.com/3 备注")).toEqual([
      link("https://a.com/1"), text(", "), link("https://b.com/2"), text("\n"), link("https://c.com/3"), text(" 备注"),
    ])
  })

  it("网址后面紧贴中文和全角标点：不把后面的字吞进去", () => {
    expect(splitTextLinks("见https://a.com/x，再看")).toEqual([text("见"), link("https://a.com/x"), text("，再看")])
    expect(splitTextLinks("文档：https://a.com/x。")).toEqual([text("文档："), link("https://a.com/x"), text("。")])
    expect(splitTextLinks("（https://a.com/x）")).toEqual([text("（"), link("https://a.com/x"), text("）")])
    expect(splitTextLinks("https://a.com/x文档")).toEqual([link("https://a.com/x"), text("文档")])
  })

  it("句末标点和右括号不算网址的一部分，网址中间的标点保留", () => {
    expect(splitTextLinks("看 https://a.com/x.")).toEqual([text("看 "), link("https://a.com/x"), text(".")])
    expect(splitTextLinks("https://a.com/x?y=1&z=2#h,")).toEqual([link("https://a.com/x?y=1&z=2#h"), text(",")])
    expect(splitTextLinks("(see https://a.com/x)")).toEqual([text("(see "), link("https://a.com/x"), text(")")])
    expect(splitTextLinks("https://a.com/a.b/c;d=1")).toEqual([link("https://a.com/a.b/c;d=1")])
  })

  it("只认带主机的 http(s)：别的协议和只有协议头的都当普通文字", () => {
    for (const v of [
      "ftp://a.com/x", "file:///etc/passwd", "javascript:alert(1)", "https://", "https:// x", "www.a.com", "a.com/x",
      "https:///x", "https://?a=1", "https://.",
    ]) {
      expect(splitTextLinks(v), v).toEqual([text(v)])
    }
  })

  it("夹在文字里的无效网址头不影响后面的有效网址", () => {
    expect(splitTextLinks("https:// 然后 https://a.com")).toEqual([text("https:// 然后 "), link("https://a.com")])
  })

  it("所有片段按顺序拼回去，和原文逐字一致", () => {
    const samples = [
      "【上线前必配·网关】生产环境 wk-gateway.yaml 中 id=cp-scheduling 路由的 Path 白名单，需新增 /cp-scheduling/api/student/course-schedule-link/**（家长确认链接的学员端 4 个接口）。状态：dev 已加；",
      "a https://a.com/x, b https://b.com/y。\n  末行 http://c.com:8080/z?q=1&r=%E4%B8%AD.",
      "https://https://a.com",
      "   https://a.com   ",
    ]
    for (const s of samples) {
      const joined = splitTextLinks(s).map((p) => (p.kind === "link" ? p.url : p.text)).join("")
      expect(joined).toBe(s)
    }
  })
})
