/**
 * 飞书消息里 @ 机器人自己：给 Agent 的正文保留，指令识别的正文照旧剥掉。
 *
 * 起因：另一个机器人在群里发「大家好～ @A @小福 @B …」，小福被点名了，
 * 但 @ 自己那一段在入队前被整个删掉，Agent 看到的是「@A @B …」，判断成「没提到我」。
 * 修法的约束：指令识别（「@机器人 /p use xxx」）、建项草稿、「仅 @ 了你」的空正文兜底都依赖剥掉 @ 之后的正文，不能被带坏。
 */
import fs from "node:fs"
import path from "node:path"
import { describe, expect, it } from "vitest"
import { COMMANDS } from "../src/shared/command-catalog.js"
import type { LarkMention } from "../src/shared/lark-core.js"
import { SELF_MENTION_NOTE, resolveInboundTexts, resolveMentionTags } from "../src/shared/lark-mentions.js"

const SELF = "ou_self_bot"
const self = (key = "@_user_1", name = "小福"): LarkMention => ({ key, id: SELF, name })
const other = (key: string, id: string, name: string): LarkMention => ({ key, id, name })
const all = (): LarkMention => ({ key: "@_all", id: "", name: "所有人" })

/** 和 daemon.ts 的 isCommand 同一个判断（那个函数是模块私有的，这里照抄） */
const isCommand = (text: string): boolean => {
  const trimmed = text.trim().toLowerCase()
  return Object.keys(COMMANDS).some((cmd) => trimmed === cmd || trimmed.startsWith(cmd + " "))
}

describe("resolveMentionTags：默认口径（和改动前逐字一致）", () => {
  it("@自己 整个删掉，指令前面的 @ 不挡路", () => {
    expect(resolveMentionTags("@_user_1 /p use abc", [self()], SELF)).toBe("/p use abc")
  })

  it("@其他人 写成「@名字(open_id=…)」，Agent 能直接拿 open_id 回 @", () => {
    expect(resolveMentionTags("@_user_1 你好", [other("@_user_1", "ou_a", "安若流年")], SELF)).toBe("@安若流年(open_id=ou_a) 你好")
  })

  it("别人的 @ 没有 open_id 时只写名字", () => {
    expect(resolveMentionTags("@_user_1 你好", [other("@_user_1", "", "某人")], SELF)).toBe("@某人 你好")
  })

  it("@所有人 删掉", () => {
    expect(resolveMentionTags("@_all 今晚发布", [all()], SELF)).toBe("今晚发布")
  })

  it("没登记在 mentions 里的残留占位符也清掉", () => {
    expect(resolveMentionTags("@_user_9 你好", [self()], SELF)).toBe("你好")
  })

  it("删掉 @ 留下的连续空格折叠成一个；没有 mentions 时只 trim，不动正文里的空格", () => {
    expect(resolveMentionTags("大家好   @_user_1   收到", [self()], SELF)).toBe("大家好 收到")
    expect(resolveMentionTags("  a  b  ", [], SELF)).toBe("a  b")
  })

  it("还不知道自己的 open_id 时，谁都不当作自己", () => {
    expect(resolveMentionTags("@_user_1 你好", [self()], undefined)).toBe(`@小福(open_id=${SELF}) 你好`)
  })
})

describe("resolveMentionTags：keepSelf（给 Agent 看的）", () => {
  const A = other("@_user_1", "ou_a", "安若流年")
  const B = other("@_user_3", "ou_b", "江耳的Flowship")
  const me = self("@_user_2")
  const raw = "大家好～ @_user_1 @_user_2 @_user_3 我是陈玉灵的测试助手，向你们打个招呼 👋"

  it("截图里那条：改动前 Agent 看不到自己被点名，改动后看得到，而且位置不变", () => {
    expect(resolveMentionTags(raw, [A, me, B], SELF)).toBe(
      "大家好～ @安若流年(open_id=ou_a) @江耳的Flowship(open_id=ou_b) 我是陈玉灵的测试助手，向你们打个招呼 👋",
    )
    expect(resolveMentionTags(raw, [A, me, B], SELF, { keepSelf: true })).toBe(
      `大家好～ @安若流年(open_id=ou_a) @小福(${SELF_MENTION_NOTE}) @江耳的Flowship(open_id=ou_b) 我是陈玉灵的测试助手，向你们打个招呼 👋`,
    )
  })

  it("自己的标注里不带 open_id：Agent 不会拿它去当 @ 别人的格式回出去", () => {
    const out = resolveMentionTags("@_user_1 你好", [self()], SELF, { keepSelf: true })
    expect(out).toBe(`@小福(${SELF_MENTION_NOTE}) 你好`)
    expect(out).not.toContain(SELF)
    expect(out).not.toContain("open_id")
  })

  it("拿不到名字时写「@你自己」，不留一个光秃秃的 @", () => {
    expect(resolveMentionTags("@_user_1 你好", [self("@_user_1", "")], SELF, { keepSelf: true })).toBe(`@${SELF_MENTION_NOTE} 你好`)
  })

  it("@所有人 不受影响，还是删掉", () => {
    expect(resolveMentionTags("@_all @_user_1 开会", [all(), self()], SELF, { keepSelf: true })).toBe(`@小福(${SELF_MENTION_NOTE}) 开会`)
  })

  it("keepSelf 不影响别人的 @", () => {
    expect(resolveMentionTags("@_user_1 你好", [A], SELF, { keepSelf: true })).toBe(resolveMentionTags("@_user_1 你好", [A], SELF))
  })
})

describe("resolveInboundTexts：一条消息的两份文本", () => {
  it("群聊：command 剥掉 @ 自己，agent 保留", () => {
    const r = resolveInboundTexts("@_user_1 帮我看下这个报错", [self()], SELF, "group")
    expect(r.command).toBe("帮我看下这个报错")
    expect(r.agent).toBe(`@小福(${SELF_MENTION_NOTE}) 帮我看下这个报错`)
  })

  it("群聊里 @ 了多个人：agent 保留所有人的 @，自己的带标注", () => {
    const r = resolveInboundTexts("@_user_1 @_user_2 一起看下", [other("@_user_1", "ou_a", "安若"), self("@_user_2")], SELF, "group")
    expect(r.command).toBe("@安若(open_id=ou_a) 一起看下")
    expect(r.agent).toBe(`@安若(open_id=ou_a) @小福(${SELF_MENTION_NOTE}) 一起看下`)
  })

  it("私聊：两份一样，@ 自己照旧剥掉（对面只有一个人，没有信息量）", () => {
    const r = resolveInboundTexts("@_user_1 /p", [self()], SELF, "p2p")
    expect(r).toEqual({ command: "/p", agent: "/p" })
  })

  it("话题群也算群聊", () => {
    expect(resolveInboundTexts("@_user_1 你好", [self()], SELF, "topic_group").agent).toBe(`@小福(${SELF_MENTION_NOTE}) 你好`)
  })

  it("群里只 @ 了机器人、正文为空：两份都是空串，不拿「@小福(你自己)」顶替——pushMessage 对空正文的兜底要照常触发", () => {
    expect(resolveInboundTexts("@_user_1", [self()], SELF, "group")).toEqual({ command: "", agent: "" })
    expect(resolveInboundTexts("@_user_1 ", [self()], SELF, "group")).toEqual({ command: "", agent: "" })
    // 只 @ 了机器人和所有人，同理
    expect(resolveInboundTexts("@_all @_user_1", [all(), self()], SELF, "group")).toEqual({ command: "", agent: "" })
  })

  it("群聊里这条没 @ 自己（比如只有 @所有人）：两份一样", () => {
    const r = resolveInboundTexts("@_all 今晚发布", [all()], SELF, "group")
    expect(r).toEqual({ command: "今晚发布", agent: "今晚发布" })
  })

  it("没有任何 @ 的消息原样不动", () => {
    expect(resolveInboundTexts("你好", [], SELF, "group")).toEqual({ command: "你好", agent: "你好" })
  })
})

describe("指令识别不受影响", () => {
  const cmds = Object.keys(COMMANDS)

  it("指令清单不是空的（下面的逐条验证有意义）", () => {
    expect(cmds.length).toBeGreaterThan(5)
  })

  it.each(cmds)("群聊里「@机器人 %s 参数」：command 文本照旧被识别成指令", (cmd) => {
    for (const raw of [`@_user_1 ${cmd}`, `@_user_1 ${cmd} 参数`, `@_user_1  ${cmd}  参数`]) {
      const r = resolveInboundTexts(raw, [self()], SELF, "group")
      expect(isCommand(r.command), `「${raw}」剥掉 @ 后应是指令，实际是「${r.command}」`).toBe(true)
    }
  })

  it("agent 文本里带着 @ 标注，不是指令——这就是为什么指令识别必须用 command 那份", () => {
    const r = resolveInboundTexts("@_user_1 /p use abc", [self()], SELF, "group")
    expect(isCommand(r.command)).toBe(true)
    expect(isCommand(r.agent)).toBe(false)
  })

  it("/group 开通指令（主用户在还没开通的群里发）的判断也照旧", () => {
    const isGroupAdminCommand = (t: string) => /^\/group(\s|$)/i.test(t.trim())
    const r = resolveInboundTexts("@_user_1 /group allow", [self()], SELF, "group")
    expect(isGroupAdminCommand(r.command)).toBe(true)
    expect(r.command).toBe("/group allow")
  })

  it("非指令的斜杠开头文本不会被误认成指令", () => {
    const r = resolveInboundTexts("@_user_1 /not-a-command 你好", [self()], SELF, "group")
    expect(isCommand(r.command)).toBe(false)
  })
})

/**
 * daemon 的状态是模块级的、没法在单测里直接跑，这里把接线钉住：
 * 指令识别、建项草稿、管理指令判断用剥掉 @ 的那份；入队给 Agent 的用保留 @ 的那份。
 */
describe("daemon 接线", () => {
  const src = fs.readFileSync(path.resolve(__dirname, "..", "src", "daemon.ts"), "utf8").replace(/\r\n/g, "\n")
  const bodyOf = (signature: string): string => {
    const start = src.indexOf(signature)
    expect(start, `daemon.ts 里找不到 ${signature}`).toBeGreaterThan(-1)
    const next = src.indexOf("\nfunction ", start + signature.length)
    const nextAsync = src.indexOf("\nasync function ", start + signature.length)
    const ends = [next, nextAsync].filter((i) => i > -1)
    return src.slice(start, ends.length ? Math.min(...ends) : undefined)
  }
  const feishu = bodyOf("export async function startFeishuChannel(")

  it("从共享模块拿两份文本，daemon 里不再留一份自己的 resolveMentionTags", () => {
    expect(src).toContain('from "./shared/lark-mentions.js"')
    expect(src).not.toMatch(/function resolveMentionTags\(/)
    expect(feishu).toMatch(/const \{ command: cleanText, agent: agentText \} = resolveInboundTexts\(text, ev\.mentions, rt\.botOpenId, chatType\)/)
  })

  it("文本消息：指令、建项草稿、管理指令判断都用 cleanText；入队给 Agent 的是 agentText", () => {
    expect(feishu).toMatch(/isGroupAdminCommand\(cleanText\)/)
    expect(feishu).toMatch(/messageType === "text" && isCommand\(cleanText\)/)
    expect(feishu).toMatch(/handleCommand\(cleanText, messageId, chatKey/)
    expect(feishu).toMatch(/__PROJECT_NEW_FILL__:\$\{JSON\.stringify\(\{ chatId: chatKey, messageId, text: cleanText \}\)\}/)
    expect(feishu).toMatch(/if \(messageType === "text"\) \{\s*enqueue\(agentText\);/)
  })

  it("非文本消息（富文本、卡片、带图指令）：同样 command 判指令、agent 入队，兜底也入 agentText", () => {
    expect(feishu).toMatch(/resolveInboundTexts\(result \|\| text, ev\.mentions, rt\.botOpenId, chatType\)/)
    expect(feishu).toMatch(/isCommand\(body\.command\)/)
    expect(feishu).toMatch(/handleCommand\(body\.command, messageId, chatKey/)
    expect(feishu).toMatch(/enqueue\(body\.agent\)/)
    expect(feishu).toMatch(/\.catch\(\(\) => enqueue\(agentText\)\)/)
  })

  it("没有任何一处把剥掉 @ 的 cleanText 直接入队", () => {
    expect(feishu).not.toMatch(/enqueue\(cleanText\)/)
    expect(feishu).not.toMatch(/enqueue\(body\)/)
  })

  it("pushMessage 对「正文为空」的兜底还在：群里只 @ 了机器人且带引用时提示去看引用原文", () => {
    const push = bodyOf("function pushMessage(")
    expect(push).toMatch(/if \(!content\?\.trim\(\)\)/)
    expect(push).toContain("用户仅 @ 了你")
    expect(push).toMatch(/meta\?\.quoted_message\?\.text\?\.trim\(\)/)
  })
})
