import { describe, expect, it } from "vitest"
import {
  NOTICE_BODY_MAX_CHARS,
  NOTICE_FALLBACK_BODY,
  NOTICE_TITLE_MAX_CHARS,
  createReplyNotifier,
  isFinishedReply,
  isViewingSession,
  markdownToPlainLine,
  replyPreview,
  type ReplyNotice,
} from "../src/shared/app-chat-notify"
import type { AppChatAssistantItem, AppChatEvent, AppChatItem, AppChatSegment } from "../src/shared/app-chat-types"

const reply = (text: string): AppChatSegment => ({ type: "reply", text })
const tools = (): AppChatSegment => ({ type: "tools", tools: [{ name: "Read", status: "done" }] })
const thinking = (text: string): AppChatSegment => ({ type: "thinking", text })

function card(over: Partial<AppChatAssistantItem> = {}): AppChatAssistantItem {
  return { kind: "assistant", id: "card-1", ts: 1, segments: [reply("好了")], finished: true, ...over }
}
const itemEvent = (item: AppChatItem, sessionKey = "ch|app_main::D:\\work\\a"): AppChatEvent => ({ type: "item", sessionKey, item })

describe("Markdown 整理成一行", () => {
  it("普通文字原样，折成一行", () => {
    expect(markdownToPlainLine("第一行\n\n第二行")).toBe("第一行 第二行")
  })

  it("去掉标题、引用、列表、强调、行内代码的记号", () => {
    const md = "## 结果\n> 注意\n- **已修复** 登录\n- 缓存用 `redis`\n1. 再 *试试*"
    expect(markdownToPlainLine(md)).toBe("结果 注意 已修复 登录 缓存用 redis 再 试试")
  })

  it("链接和图片只留文字", () => {
    expect(markdownToPlainLine("见 [文档](https://a.b/c) 和 ![架构图](x.png)")).toBe("见 文档 和 架构图")
  })

  it("代码围栏只去掉标记行，里面的内容留着", () => {
    expect(markdownToPlainLine("改成这样：\n```ts\nconst a = 1\n```\n完成")).toBe("改成这样： const a = 1 完成")
  })

  it("分隔线、表格表头分隔行去掉，表格竖线变空格", () => {
    expect(markdownToPlainLine("| 名称 | 值 |\n| --- | :-: |\n| a | 1 |\n\n---\n结束")).toBe("名称 值 a 1 结束")
  })

  it("单个下划线 / 星号只在词边界处算强调：snake_case、乘号不动", () => {
    expect(markdownToPlainLine("变量 user_id_list 和 2*3*4 都不变")).toBe("变量 user_id_list 和 2*3*4 都不变")
    expect(markdownToPlainLine("这个 _很重要_ 啊")).toBe("这个 很重要 啊")
  })

  it("尖括号不当 HTML 标签吃掉（a<b、泛型），只处理换行标签", () => {
    expect(markdownToPlainLine("当 a<b 且 c>d 时返回 List<String>")).toBe("当 a<b 且 c>d 时返回 List<String>")
    expect(markdownToPlainLine("第一行<br>第二行<br/>第三行")).toBe("第一行 第二行 第三行")
  })

  it("只有记号、没有文字：得到空串", () => {
    expect(markdownToPlainLine("---\n```\n```")).toBe("")
    expect(markdownToPlainLine("   \n ")).toBe("")
  })

  it("Windows 换行也能处理", () => {
    expect(markdownToPlainLine("# 标题\r\n正文")).toBe("标题 正文")
  })
})

describe("回复预览", () => {
  it("取最后一段有文字的回复（结论），不取前面的", () => {
    expect(replyPreview([reply("先看看"), tools(), reply("**结论**：改好了")])).toBe("结论：改好了")
  })

  it("最后一段回复只有记号时，往前找有文字的那段", () => {
    expect(replyPreview([reply("正文"), tools(), reply("---")])).toBe("正文")
  })

  it("只有思考和工具、没有回复文字：空串", () => {
    expect(replyPreview([thinking("想一想"), tools()])).toBe("")
    expect(replyPreview([])).toBe("")
  })

  it("超过上限截断并加省略号，按字符数算（emoji 不被劈开）", () => {
    const long = "字".repeat(NOTICE_BODY_MAX_CHARS + 20)
    const out = replyPreview([reply(long)])
    expect(Array.from(out)).toHaveLength(NOTICE_BODY_MAX_CHARS + 1)
    expect(out.endsWith("…")).toBe(true)

    const emoji = replyPreview([reply("😀".repeat(NOTICE_BODY_MAX_CHARS + 5))])
    expect(Array.from(emoji).slice(0, -1).every((c) => c === "😀")).toBe(true)
  })

  it("正好等于上限：不加省略号", () => {
    const exact = "字".repeat(NOTICE_BODY_MAX_CHARS)
    expect(replyPreview([reply(exact)])).toBe(exact)
  })

  it("很长的回复也只处理开头，结果仍是预览长度", () => {
    const out = replyPreview([reply(`# 总结\n${"内容 ".repeat(50_000)}`)])
    expect(out.startsWith("总结 内容")).toBe(true)
    expect(Array.from(out)).toHaveLength(NOTICE_BODY_MAX_CHARS + 1)
  })
})

describe("什么算「回复完成」", () => {
  it("回合卡收口了就是", () => {
    expect(isFinishedReply(card())).toBe(true)
  })

  it("还在流式输出的不是", () => {
    expect(isFinishedReply(card({ finished: false }))).toBe(false)
  })

  it("被打断的（用户停止、切模型、重置）不是", () => {
    expect(isFinishedReply(card({ interrupted: true }))).toBe(false)
  })

  it("用户消息、普通文字、提示这些不是回合卡", () => {
    expect(isFinishedReply({ kind: "user", id: "u", ts: 1, text: "你好" })).toBe(false)
    expect(isFinishedReply({ kind: "text", id: "t", ts: 1, text: "你好" })).toBe(false)
    expect(isFinishedReply({ kind: "notice", id: "n", ts: 1, text: "已重置" })).toBe(false)
  })
})

describe("是不是正看着这个会话", () => {
  const A = "ch|app_main::D:\\work\\a"
  const B = "ch|app_main::D:\\work\\b"

  it("窗口在前台、停在这个会话上：是", () => {
    expect(isViewingSession(A, A, true)).toBe(true)
  })

  it("窗口不在前台（最小化、藏在托盘、被别的程序盖住）：不是，哪怕对话页还停在这个会话", () => {
    expect(isViewingSession(A, A, false)).toBe(false)
  })

  it("看着的是别的会话，或不在对话页（null）：不是", () => {
    expect(isViewingSession(B, A, true)).toBe(false)
    expect(isViewingSession(null, A, true)).toBe(false)
  })

  it("路径分隔符、大小写写法不同也认得出是同一个会话", () => {
    expect(isViewingSession("ch|app_main::D:\\Work\\A", "ch|app_main::d:/work/a", true)).toBe(true)
  })
})

describe("回复完成通知", () => {
  function setup(opts: { viewing?: boolean; name?: string } = {}) {
    const shown: ReplyNotice[] = []
    const asked: string[] = []
    const notify = createReplyNotifier({
      isViewing: (key) => { asked.push(key); return opts.viewing === true },
      sessionName: () => opts.name ?? "修登录",
      show: (n) => { shown.push(n) },
    })
    return { notify, shown, asked }
  }

  it("回合卡收口、没在看这个会话：弹，标题是会话名，正文是回复开头，带会话键供点击跳转", () => {
    const { notify, shown } = setup()
    notify(itemEvent(card({ segments: [reply("## 完成\n登录问题已修复")] })))
    expect(shown).toEqual([{ sessionKey: "ch|app_main::D:\\work\\a", title: "修登录", body: "完成 登录问题已修复" }])
  })

  it("正看着这个会话：不弹", () => {
    const { notify, shown } = setup({ viewing: true })
    notify(itemEvent(card()))
    expect(shown).toEqual([])
  })

  it("回复里没有文字：正文用兜底文案", () => {
    const { notify, shown } = setup()
    notify(itemEvent(card({ segments: [tools()] })))
    expect(shown[0].body).toBe(NOTICE_FALLBACK_BODY)
  })

  it("还在输出的卡（流式快照）不弹；等它收口那一次才弹，只弹一次", () => {
    const { notify, shown } = setup()
    notify(itemEvent(card({ finished: false, segments: [reply("写到一半")] })))
    notify(itemEvent(card({ finished: false, segments: [reply("写到一半又多了")] })))
    expect(shown).toEqual([])
    notify(itemEvent(card()))
    expect(shown).toHaveLength(1)
  })

  it("被打断的卡不弹", () => {
    const { notify, shown } = setup()
    notify(itemEvent(card({ interrupted: true })))
    expect(shown).toEqual([])
  })

  it("同一张卡的重复事件只弹一次", () => {
    const { notify, shown } = setup()
    notify(itemEvent(card()))
    notify(itemEvent(card()))
    expect(shown).toHaveLength(1)
  })

  it("看着的时候收口的卡，之后离开了再收到它的重复事件，也不补弹", () => {
    let viewing = true
    const shown: ReplyNotice[] = []
    const notify = createReplyNotifier({ isViewing: () => viewing, sessionName: () => "x", show: (n) => { shown.push(n) } })
    notify(itemEvent(card()))
    viewing = false
    notify(itemEvent(card()))
    expect(shown).toEqual([])
  })

  it("不同的卡各弹各的，会话不同也各弹各的", () => {
    const { notify, shown } = setup()
    notify(itemEvent(card({ id: "c1" }), "ch|app_main::D:\\work\\a"))
    notify(itemEvent(card({ id: "c2" }), "ch|app_main::D:\\work\\a"))
    notify(itemEvent(card({ id: "c3" }), "ch|app_main::D:\\work\\b"))
    expect(shown.map((n) => n.sessionKey)).toEqual([
      "ch|app_main::D:\\work\\a",
      "ch|app_main::D:\\work\\a",
      "ch|app_main::D:\\work\\b",
    ])
  })

  it("用户消息、移除、清空这些事件不弹，也不去问是否在看", () => {
    const { notify, shown, asked } = setup()
    notify(itemEvent({ kind: "user", id: "u", ts: 1, text: "你好" }))
    notify({ type: "remove", sessionKey: "k", itemId: "u" })
    notify({ type: "clear", sessionKey: "k" })
    expect(shown).toEqual([])
    expect(asked).toEqual([])
  })

  it("会话名为空时用兜底名；太长的会话名截断", () => {
    const empty = setup({ name: "   " })
    empty.notify(itemEvent(card()))
    expect(empty.shown[0].title).toBe("应用内会话")

    const long = setup({ name: "名".repeat(NOTICE_TITLE_MAX_CHARS + 10) })
    long.notify(itemEvent(card()))
    expect(Array.from(long.shown[0].title)).toHaveLength(NOTICE_TITLE_MAX_CHARS + 1)
    expect(long.shown[0].title.endsWith("…")).toBe(true)
  })

  it("记忆有上限：很久以前的卡被挤出去之后，不会因为记忆无限增长；最近的卡仍然去重", () => {
    const { notify, shown } = setup()
    for (let i = 0; i < 500; i++) notify(itemEvent(card({ id: `c${i}` })))
    expect(shown).toHaveLength(500)
    notify(itemEvent(card({ id: "c499" })))
    expect(shown).toHaveLength(500)
  })
})
