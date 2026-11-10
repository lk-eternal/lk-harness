import { describe, expect, it } from "vitest"
import { COMMANDS, primaryCommands, slashMenuItems, slashQueryOf } from "../src/shared/command-catalog"

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
  it("单个 / 给全部主指令，不含「同 /xxx」的别名", () => {
    const items = slashMenuItems("/")
    expect(items).toEqual(primaryCommands())
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
