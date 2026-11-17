import { describe, expect, it } from "vitest"
import {
  COMMANDS, FEISHU_ONLY_COMMANDS, IMAGE_CARRYING_COMMANDS, commandTextWithImages, isImageCarryingCommand,
  primaryCommands, slashMenuItems, slashQueryOf,
} from "../src/shared/command-catalog"

describe("slashQueryOf：只有输入的是「/指令」本身才有查询词", () => {
  it.each([
    ["/", "/"],
    ["/st", "/st"],
    ["/STATUS", "/status"], // 大小写不敏感
    ["/c", "/c"],
  ])("%j → %j", (text, query) => {
    expect(slashQueryOf(text)).toBe(query)
  })

  it.each([
    ["空输入", ""],
    ["普通文字", "你好"],
    ["斜杠不在开头", "看看 /status"],
    ["指令后已有参数", "/model ls"],
    ["指令后只有一个空格", "/model "],
    ["斜杠前有空格", " /status"],
    ["多行", "/status\n再来一行"],
  ])("%s → null", (_label, text) => {
    expect(slashQueryOf(text)).toBeNull()
  })
})

describe("slashMenuItems：输入框指令菜单的候选", () => {
  it("单个 / 给全部主指令，不含「同 /xxx」的别名，也不含只属于飞书的指令", () => {
    const items = slashMenuItems("/")
    expect(items).toEqual(primaryCommands().filter((c) => !FEISHU_ONLY_COMMANDS.has(c.cmd)))
    expect(items.map((i) => i.cmd)).not.toContain("/group")
    expect(Object.keys(COMMANDS)).toContain("/group") // Daemon 仍然认它
    expect(items.length).toBeGreaterThan(5)
    expect(items.every((i) => !i.desc.startsWith("同 "))).toBe(true)
    expect(items.map((i) => i.cmd)).toEqual(expect.arrayContaining(["/stop", "/status", "/chat", "/help"]))
  })

  it("继续输入按前缀过滤", () => {
    expect(slashMenuItems("/st").map((i) => i.cmd)).toEqual(["/stop", "/status"])
    expect(slashMenuItems("/ch").map((i) => i.cmd)).toEqual(["/chat"])
  })

  it("别名不进菜单：/c 只匹配以 /c 开头的主指令（/chat /clean），不会出现 /c 本身", () => {
    const cmds = slashMenuItems("/c").map((i) => i.cmd)
    expect(cmds).toEqual(["/chat", "/clean"])
    expect(Object.keys(COMMANDS)).toContain("/c")
  })

  it("没有匹配的指令 / 不是指令输入 → 空", () => {
    expect(slashMenuItems("/zzz")).toEqual([])
    expect(slashMenuItems("你好")).toEqual([])
    expect(slashMenuItems("/status ")).toEqual([])
    expect(slashMenuItems("")).toEqual([])
  })

  it("每一项都带说明，能直接显示", () => {
    for (const i of slashMenuItems("/")) {
      expect(i.cmd).toMatch(/^\/[a-z]+$/)
      expect(i.desc.trim().length).toBeGreaterThan(0)
    }
  })
})

describe("isImageCarryingCommand：带图发出时仍然算指令的只有 /f", () => {
  it.each([
    ["/f 先停一下"],
    ["/F 大写也认"],
    ["/f"],
    ["  /f 前面有空格"],
    ["/f\n换行也算分隔"],
  ])("%j → true", (text) => {
    expect(isImageCarryingCommand(text)).toBe(true)
  })

  it.each([
    ["/s 别的指令"],
    ["/stop"],
    ["/fx 前缀相同但不是 /f"],
    ["/ff"],
    ["先 /f 再说"],
    ["你好"],
    [""],
    ["   "],
  ])("%j → false", (text) => {
    expect(isImageCarryingCommand(text)).toBe(false)
  })

  it("集合里的每一项都是 Daemon 认得的指令（不会写错）", () => {
    for (const c of IMAGE_CARRYING_COMMANDS) expect(Object.keys(COMMANDS)).toContain(c)
  })
})

describe("commandTextWithImages：图片标记跟在指令文本后面，交给只有一行文本的指令队列", () => {
  it("没有图片：就是去掉首尾空白的指令文本（和以前一样）", () => {
    expect(commandTextWithImages("/f 先停一下", [])).toBe("/f 先停一下")
    expect(commandTextWithImages("  /f 先停一下  ", [])).toBe("/f 先停一下")
  })

  it("一张图：用一个空格接在正文后面", () => {
    expect(commandTextWithImages("/f ci 先跑着", ["C:\\tmp\\a.png"])).toBe("/f ci 先跑着 [图片已保存: C:\\tmp\\a.png]")
  })

  it("多张图：保持顺序，标记之间也只隔一个空格", () => {
    expect(commandTextWithImages("/f 看图", ["/t/1.png", "/t/2.png"])).toBe("/f 看图 [图片已保存: /t/1.png] [图片已保存: /t/2.png]")
  })

  it("只有 /f 加图：指令后面直接跟标记", () => {
    expect(commandTextWithImages("/f", ["/t/1.png"])).toBe("/f [图片已保存: /t/1.png]")
  })

  it("主进程按空白切词再用单个空格拼回去：这样处理一遍结果不变（不会丢图、不会改路径）", () => {
    const text = commandTextWithImages("/f 先停  一下", ["C:\\Users\\a b\\x.png", "/t/2.png"])
    const rejoined = text.split(/\s+/).join(" ")
    // 正文里本来的连续空格会被合并，图片标记（含带空格的路径）不受影响
    expect(rejoined).toContain("[图片已保存: C:\\Users\\a b\\x.png] [图片已保存: /t/2.png]")
  })
})
