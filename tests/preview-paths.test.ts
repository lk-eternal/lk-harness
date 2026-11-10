import { describe, expect, it } from "vitest"
import { MAX_PATH_MENTIONS, findPathMentions, parsePathRef } from "../src/shared/preview-paths"

const paths = (text: string) => findPathMentions(text).map((m) => m.path)

describe("findPathMentions：认得出的", () => {
  it("Windows 绝对路径：反斜杠、正斜杠、中文目录名", () => {
    expect(paths("已写入 D:\\work\\报告\\q1.xlsx 请查收")).toEqual(["D:\\work\\报告\\q1.xlsx"])
    expect(paths("见 C:/Users/a/b.txt")).toEqual(["C:/Users/a/b.txt"])
  })

  it("目录名里带点的路径不在点处截断；多段扩展名（.tar.gz）认全", () => {
    expect(paths("D:\\a.b\\c.txt")).toEqual(["D:\\a.b\\c.txt"])
    expect(paths("src/v1.2/main.ts")).toEqual(["src/v1.2/main.ts"])
    expect(paths("D:\\a\\b.tar.gz")).toEqual(["D:\\a\\b.tar.gz"])
    expect(paths("out/b.tar.gz")).toEqual(["out/b.tar.gz"])
  })

  it("句末的句号、中文标点、紧跟的中文都不算路径的一部分", () => {
    expect(paths("see D:\\a\\b.txt.")).toEqual(["D:\\a\\b.txt"])
    expect(paths("文件在 D:\\a\\b.txt。")).toEqual(["D:\\a\\b.txt"])
    expect(paths("D:\\a\\b.txt里有数据")).toEqual(["D:\\a\\b.txt"])
    expect(paths("(src/app.ts)，然后")).toEqual(["src/app.ts"])
    expect(paths("'src/app.ts'")).toEqual(["src/app.ts"])
  })

  it("相对路径（有目录）和 POSIX 绝对路径", () => {
    expect(paths("改了 src/app.ts 和 ./lib/x.js 以及 ../a/b.md")).toEqual(["src/app.ts", "./lib/x.js", "../a/b.md"])
    expect(paths("配置在 /etc/nginx/nginx.conf")).toEqual(["/etc/nginx/nginx.conf"])
    expect(paths("src\\main\\App.java")).toEqual(["src\\main\\App.java"])
  })

  it("行号后缀：:42、:42:7、#L42、#L42-L50", () => {
    const line = (t: string) => findPathMentions(t)[0]?.line
    expect(line("src/app.ts:42")).toBe(42)
    expect(line("src/app.ts:42:7")).toBe(42)
    expect(line("src/app.ts#L42")).toBe(42)
    expect(line("src/app.ts#L42-L50")).toBe(42)
    expect(line("D:\\a\\b.ts:12")).toBe(12)
    expect(line("src/app.ts")).toBeUndefined()
    expect(line("src/app.ts:0")).toBeUndefined()
  })

  it("位置：start/end 正好圈住路径加行号，后面的冒号和标点不带进来", () => {
    const text = "先看 src/app.ts:42: 这里"
    const [m] = findPathMentions(text)
    expect(text.slice(m.start, m.end)).toBe("src/app.ts:42")
    expect(m.path).toBe("src/app.ts")
  })

  it("一段里有多个：按出现顺序，互不重叠", () => {
    const text = "a/b.ts, D:\\x\\y.md; ./c/d.json"
    const ms = findPathMentions(text)
    expect(ms.map((m) => m.path)).toEqual(["a/b.ts", "D:\\x\\y.md", "./c/d.json"])
    for (let i = 1; i < ms.length; i++) expect(ms[i].start).toBeGreaterThanOrEqual(ms[i - 1].end)
  })
})

describe("findPathMentions：不能乱认", () => {
  it.each([
    ["and/or", "and/or"],
    ["日期", "2024/03/15"],
    ["版本号", "v1.2.3"],
    ["缩写", "TCP/IP"],
    ["邮箱", "user@host.com"],
    ["小数分数", "1/2"],
    ["没有目录的文件名（纯文字里太容易误认）", "package.json 和 README.md"],
    ["扩展名过长", "a/b.verylongextension"],
  ])("%s：%s", (_label, text) => {
    expect(paths(text)).toEqual([])
  })

  it("网址整个都不算（不从网址中间切出一段路径）", () => {
    expect(paths("https://github.com/a/b/blob/main/x.ts")).toEqual([])
    expect(paths("看 http://example.com/docs/guide.html 这个页面")).toEqual([])
    expect(paths("//cdn.example.com/lib/a.js")).toEqual([])
    expect(paths("x://host/a/b.txt")).toEqual([]) // 单字母的协议名看起来像盘符，但盘符后面不会跟两个斜杠
  })

  it("单词末尾的字母不当盘符（path:\\foo\\bar.txt 里的 h:\\ 不是 H 盘）；冒号隔开的真盘符照认", () => {
    expect(paths("path:\\foo\\bar.txt")).toEqual([])
    expect(paths("路径:D:\\x\\y.txt")).toEqual(["D:\\x\\y.txt"])
  })

  it("超过数量上限就停", () => {
    const text = Array.from({ length: MAX_PATH_MENTIONS + 20 }, (_, i) => `a/f${i}.ts`).join(" ")
    expect(findPathMentions(text)).toHaveLength(MAX_PATH_MENTIONS)
  })

  it("恶意构造的超长文本：很快返回（只扫描开头一段）", () => {
    const started = Date.now()
    findPathMentions("a:\\".repeat(200_000))
    findPathMentions("a/".repeat(200_000))
    findPathMentions("a:\\a.".repeat(50_000))
    expect(Date.now() - started).toBeLessThan(2000)
  })

  it("超出扫描范围之后的路径不认", () => {
    expect(paths(" ".repeat(20_000) + "src/late.ts")).toEqual([])
  })
})

describe("parsePathRef（行内代码整体是不是路径）", () => {
  it("相对路径、绝对路径、行号", () => {
    expect(parsePathRef("src/app.ts")).toEqual({ path: "src/app.ts" })
    expect(parsePathRef("src/app.ts:42")).toEqual({ path: "src/app.ts", line: 42 })
    expect(parsePathRef("src/app.ts:42:7")).toEqual({ path: "src/app.ts", line: 42 })
    expect(parsePathRef("src/app.ts#L12-L20")).toEqual({ path: "src/app.ts", line: 12 })
    expect(parsePathRef("D:\\a\\b.ts:12")).toEqual({ path: "D:\\a\\b.ts", line: 12 })
    expect(parsePathRef("/usr/local/bin/tool")).toEqual({ path: "/usr/local/bin/tool" })
  })

  it("没有目录的文件名要带扩展名；没扩展名的文件要有目录", () => {
    expect(parsePathRef("package.json")).toEqual({ path: "package.json" })
    expect(parsePathRef("build/Makefile")).toEqual({ path: "build/Makefile" })
    expect(parsePathRef("Makefile")).toBeUndefined()
    expect(parsePathRef("config")).toBeUndefined()
  })

  it("绝对路径里可以有空格，相对路径和裸文件名不行", () => {
    expect(parsePathRef("D:\\My Docs\\a.docx")).toEqual({ path: "D:\\My Docs\\a.docx" })
    expect(parsePathRef("/Users/me/My Files/a.txt")).toEqual({ path: "/Users/me/My Files/a.txt" })
    expect(parsePathRef("src/my file.ts")).toBeUndefined()
    expect(parsePathRef("my file.txt")).toBeUndefined()
  })

  it("前后的空白去掉", () => {
    expect(parsePathRef("  src/app.ts \n")).toEqual({ path: "src/app.ts" })
  })

  it("行号 0 或大得离谱：行号丢掉，路径保留", () => {
    expect(parsePathRef("a/b.ts:0")).toEqual({ path: "a/b.ts" })
    expect(parsePathRef("a/b.ts:99999999999")).toEqual({ path: "a/b.ts" })
  })

  it.each([
    "", "   ", "1.2.3", "v1.2.3", "e.g.", "C:12", "C:foo/bar.ts", "--out/x.js", "-rf/x.txt", "src/", "src\\", "D:\\a\\",
    "https://x.com/a.png", "file:///etc/hosts", "a|b/c.txt", "a?b/c.txt", "a*/c.txt", "a<b>/c.txt", 'a"b/c.txt', "line1\nline2/a.txt",
    "npm install", "foo bar/baz.ts",
  ])("不是路径：%j", (code) => {
    expect(parsePathRef(code)).toBeUndefined()
  })

  it("过长的不认", () => {
    expect(parsePathRef(`${"a".repeat(401)}/b.ts`)).toBeUndefined()
    expect(parsePathRef(`${"a".repeat(380)}/b.ts`)).toBeDefined()
  })
})
