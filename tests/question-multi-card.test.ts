import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it, vi } from "vitest"
import { LarkSender } from "../src/shared/lark-core.js"
import { checkerFieldName } from "../src/shared/question-multi.js"
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { buildCardSegmentsFromPayload, registerAgentOutboundTools } from "../src/daemon.js"
import { QuestionCard } from "../src/renderer/components/chat/ItemViews"
import type { AppChatQuestionItem } from "../src/shared/app-chat-types"

const OPTIONS = ["SUB_CHILD", "SUB_TEEN", "SUB_ADULT"]
type El = Record<string, any>
type QuestionSeg = Extract<Parameters<typeof buildCardSegmentsFromPayload>[0]["segments"][number], { type: "question" }>

/** 递归收集卡片里某个 tag 的所有节点 */
function nodesIn(node: unknown, tag: string, out: El[] = []): El[] {
  if (Array.isArray(node)) { node.forEach((n) => nodesIn(n, tag, out)); return out }
  if (node && typeof node === "object") {
    const el = node as El
    if (el.tag === tag) out.push(el)
    for (const v of Object.values(el)) nodesIn(v, tag, out)
  }
  return out
}
const buttonsIn = (node: unknown) => nodesIn(node, "button")

/** 一张卡里出现过的所有 name（表单、勾选框、按钮）：飞书要求整张卡内唯一 */
const namesIn = (card: unknown) => ["form", "checker", "button"].flatMap((t) => nodesIn(card, t).map((e) => e.name as string | undefined)).filter(Boolean)

function renderSegments(segments: QuestionSeg[]) {
  const segs = buildCardSegmentsFromPayload({ segments }, { finish: false, showThinking: true }, undefined, "sk1")
  const card = LarkSender.buildStreamingCardJson({ status: "streaming", segments: segs }) as { config: El; body: { elements: El[] } }
  return { segs, card }
}

/** 一道问题在卡片里的渲染结果：正文 markdown、按钮（label / type / 回调值）、footer */
function renderQuestion(seg: Partial<QuestionSeg>) {
  const { segs, card } = renderSegments([{ type: "question", blockId: "q1", text: "给哪些人开？", options: OPTIONS, ...seg }])
  const q = segs.find((s) => s.type === "question")
  if (!q || q.type !== "question") throw new Error("没有问题块")
  const buttons = buttonsIn(card.body.elements).map((b) => ({
    label: b.text.content as string,
    type: b.type as string,
    value: b.behaviors[0].value as El,
  }))
  return { q, buttons, card }
}

describe("飞书多选题卡片", () => {
  it("单选题保持原样：选项按钮点一下就作答，没有表单", () => {
    const { q, buttons, card } = renderQuestion({})
    expect(buttons.map((b) => b.label)).toEqual(["A", "B", "C"])
    expect(buttons.every((b) => b.value.kind === "question")).toBe(true)
    expect(q.questionText).toBe("给哪些人开？\n\n**A.** SUB_CHILD\n**B.** SUB_TEEN\n**C.** SUB_ADULT")
    expect(nodesIn(card.body.elements, "form")).toEqual([])
  })

  it("未决多选题：题干 + 一张表单（每个选项一个勾选框，最后一个「提交」），题干里不再重复列选项", () => {
    const { q, buttons, card } = renderQuestion({ multi: true })
    expect(q.questionText).toBe("给哪些人开？")
    expect(q.footer).toContain("可多选")

    const form = card.body.elements.find((e) => e.tag === "form")!
    expect(form).toBeDefined()
    // 勾选框在表单里的灰框面板中（面板见下一条用例），不一定是表单的直接子节点
    const checkers = nodesIn(form.elements, "checker")
    expect(checkers.map((c: El) => c.text.content)).toEqual(["A. SUB_CHILD", "B. SUB_TEEN", "C. SUB_ADULT"])
    expect(checkers.every((c: El) => c.checked === false)).toBe(true)
    // 飞书客户端要求交互组件带 value，缺了点勾选时报 200340
    expect(checkers.every((c: El) => c.value && typeof c.value === "object")).toBe(true)

    // 勾选框 name = 本题前缀 + 序号，服务端读勾选用同一个规则
    const prefix = String(form.name).replace(/_form$/, "")
    expect(checkers.map((c: El) => c.name)).toEqual(OPTIONS.map((_, i) => checkerFieldName(prefix, i)))
    expect(String(form.element_id).length).toBeLessThanOrEqual(20)

    // 表单里只有一个提交按钮：form_action_type=submit，回调值带上会话和题块，服务端据此找到这道题
    const submits = nodesIn(form.elements, "button")
    expect(submits).toHaveLength(1)
    const submit = submits[0]
    expect(submit.form_action_type).toBe("submit")
    expect(submit.name).toBeTruthy()
    expect(submit.behaviors).toEqual([{ type: "callback", value: { kind: "question_submit", sk: "sk1", blockId: "q1" } }])
    // 整张卡里只有这一个按钮：勾选不再靠按钮，也就没有逐项点击的回调
    expect(buttons.map((b) => b.label)).toEqual(["提交"])
    expect(nodesIn(card.body.elements, "checker")).toHaveLength(3)
  })

  it("表单在卡片根节点，不被任何折叠面板包着（飞书规定表单容器只能放根节点）", () => {
    const { card } = renderQuestion({ multi: true })
    expect(card.body.elements.filter((e) => e.tag === "form")).toHaveLength(1)
    for (const panel of nodesIn(card.body.elements, "collapsible_panel")) {
      expect(nodesIn(panel.elements, "form")).toEqual([])
    }
  })

  it("未决多选题和别的问题一样有灰色边框：灰框面板放在表单里面（表单可以包面板，反过来不行）", () => {
    const { card } = renderQuestion({ multi: true })
    const form = card.body.elements.find((e) => e.tag === "form")!
    // 表单里就这一个面板，题干、勾选框、提交按钮、灰字提示都在面板里
    expect(form.elements.map((e: El) => e.tag)).toEqual(["collapsible_panel"])
    const panel = form.elements[0]
    expect(panel.expanded).toBe(true)
    expect(panel.elements[0]).toMatchObject({ tag: "markdown", content: "给哪些人开？" })
    expect(nodesIn(panel.elements, "checker")).toHaveLength(OPTIONS.length)
    expect(nodesIn(panel.elements, "button")).toHaveLength(1)
    expect(panel.elements.at(-1)).toMatchObject({ tag: "markdown", text_size: "notation" })
    expect(panel.elements.at(-1).content).toContain("可多选")
    // 卡片根节点上只剩这个表单：没有游离在外面的题干或提示
    expect(card.body.elements.filter((e) => e.tag === "markdown")).toEqual([])

    // 边框、标题、图标和单选题的待选面板完全一致，以后谁改了样式另一边不会掉队
    const single = renderQuestion({}).card.body.elements.find((e) => e.tag === "collapsible_panel")!
    expect(panel.border).toEqual(single.border)
    expect(panel.header).toEqual(single.header)
    expect(panel.header.title.content).toBe("❓ 待选择")
  })

  it("element_id 整张卡内不重名、不超过 20 个字符（表单、面板、题干各一个）", () => {
    const { card } = renderSegments([
      { type: "question", blockId: "q1", text: "第一题？", options: OPTIONS, multi: true },
      { type: "question", blockId: "q2", text: "第二题？", options: OPTIONS, multi: true },
      { type: "question", blockId: "q3", text: "第三题？", options: OPTIONS },
    ])
    const ids: string[] = []
    const walk = (x: unknown) => {
      if (Array.isArray(x)) return x.forEach(walk)
      if (x && typeof x === "object") {
        const el = x as El
        if (typeof el.element_id === "string") ids.push(el.element_id)
        Object.values(el).forEach(walk)
      }
    }
    walk(card.body.elements)
    expect(ids.length).toBeGreaterThanOrEqual(3 * 2)
    expect(new Set(ids).size).toBe(ids.length)
    expect(ids.every((id) => id.length <= 20 && /^[A-Za-z][A-Za-z0-9_]*$/.test(id))).toBe(true)
  })

  it("有未决多选题时卡片不再是流式输出状态（和单选题一样，否则点不了）", () => {
    expect(renderQuestion({ multi: true }).card.config.streaming_mode).toBe(false)
    expect(renderQuestion({}).card.config.streaming_mode).toBe(false)
  })

  it("同一张卡里有两道多选题：表单名、勾选框名、按钮名都不重名，各自的提交带各自的题块", () => {
    const { card } = renderSegments([
      { type: "question", blockId: "q1", text: "第一题？", options: OPTIONS, multi: true },
      { type: "question", blockId: "q2", text: "第二题？", options: OPTIONS, multi: true },
    ])
    const names = namesIn(card.body.elements)
    expect(names).toHaveLength(2 + 2 * OPTIONS.length + 2)
    expect(new Set(names).size).toBe(names.length)
    expect(nodesIn(card.body.elements, "form")).toHaveLength(2)
    expect(buttonsIn(card.body.elements).map((b) => b.behaviors[0].value.blockId)).toEqual(["q1", "q2"])
  })

  it("答完：回到普通问题块（折叠面板里没有表单和勾选框），答案写在 footer", () => {
    const { q, buttons, card } = renderQuestion({ multi: true, answered: "SUB_CHILD、SUB_ADULT" })
    expect(buttons).toEqual([])
    expect(nodesIn(card.body.elements, "form")).toEqual([])
    expect(nodesIn(card.body.elements, "checker")).toEqual([])
    expect(q.questionText).toBe("给哪些人开？\n\n**A.** SUB_CHILD\n**B.** SUB_TEEN\n**C.** SUB_ADULT")
    expect(q.footer).toBe("✅ 已选择: **SUB_CHILD、SUB_ADULT**")
    expect(card.body.elements.some((e) => e.tag === "collapsible_panel")).toBe(true)
  })

  it("被关闭：没有表单，footer 是关闭原因", () => {
    const { q, buttons, card } = renderQuestion({ multi: true, closedNote: "问题已关闭" })
    expect(buttons).toEqual([])
    expect(nodesIn(card.body.elements, "form")).toEqual([])
    expect(q.footer).toBe("⌛ _问题已关闭_")
  })
})

describe("独立的飞书多选题卡（不在流式卡里）", () => {
  const form = { namePrefix: "qm", labels: ["A. 甲", "B. 乙"], submitValue: { kind: "question_submit", sk: "sk1" } }
  const opts = { questionText: "选哪些？", form, title: "会话A", footer: "<font color='grey'>可多选</font>" }

  it("会话横幅（灰字 + 细线）+ 题干 + 表单 + 灰字提示，表单在根节点", () => {
    const card = LarkSender.buildQuestionMultiCard(opts)
    expect(card.schema).toBe("2.0")
    expect(card.body.elements.map((e: El) => e.tag)).toEqual(["markdown", "hr", "markdown", "form", "markdown"])
    const f = card.body.elements[3]
    expect(f.elements.filter((e: El) => e.tag === "checker").map((c: El) => c.name)).toEqual(["qm_0", "qm_1"])
    expect(buttonsIn(card).map((b) => b.behaviors[0].value)).toEqual([{ kind: "question_submit", sk: "sk1" }])
    // 整张卡内 name 不重名
    const names = namesIn(card)
    expect(new Set(names).size).toBe(names.length)
  })

  it("没有标题时不画标题条", () => {
    const card = LarkSender.buildQuestionMultiCard({ ...opts, title: undefined })
    expect(card.body.elements.map((e: El) => e.tag)).toEqual(["markdown", "form", "markdown"])
  })

  describe("发送", () => {
    const setup = () => {
      const sent: Array<{ via: string; card: El }> = []
      const client = {
        im: {
          message: {
            reply: vi.fn(async ({ data }: El) => { sent.push({ via: "reply", card: JSON.parse(data.content) }); return { code: 0, data: { message_id: "om_reply" } } }),
            create: vi.fn(async ({ data }: El) => { sent.push({ via: "create", card: JSON.parse(data.content) }); return { data: { message_id: "om_create" } } }),
          },
        },
      }
      const sender = new LarkSender({ client: client as any, chatId: "oc_main", messagePrefix: "【前缀】", log: () => {} })
      return { sent, sender }
    }

    it("群聊回复：走 reply，题干带上消息前缀，返回新卡的 message_id", async () => {
      const { sent, sender } = setup()
      expect(await sender.sendQuestionMultiCard(opts, "om_orig")).toBe("om_reply")
      expect(sent.map((s) => s.via)).toEqual(["reply"])
      expect(nodesIn(sent[0].card, "markdown")[1].content).toBe("【前缀】选哪些？")
    })

    it("p2p 直发：走 create", async () => {
      const { sent, sender } = setup()
      expect(await sender.sendQuestionMultiCard(opts, undefined, "oc_x")).toBe("om_create")
      expect(sent.map((s) => s.via)).toEqual(["create"])
    })
  })
})

describe("MCP send_question 工具", () => {
  const tool = () => {
    const s = new McpServer({ name: "t", version: "0" })
    registerAgentOutboundTools(s, { taskResult: false })
    return (s as any)._registeredTools.send_question
  }

  it("multi_select 是可选的布尔参数；不传 = 单选", () => {
    const schema = tool().inputSchema
    const base = { text: "给哪些人开？", options: ["a", "b"] }
    expect(schema.safeParse(base).success).toBe(true)
    expect(schema.safeParse({ ...base, multi_select: true }).success).toBe(true)
    expect(schema.safeParse({ ...base, multi_select: false }).success).toBe(true)
    expect(schema.safeParse({ ...base, multi_select: "yes" }).success).toBe(false)
  })

  it("说明里告诉 Agent 怎么用多选、答案长什么样", () => {
    const t = tool()
    expect(t.description).toContain("multi_select")
    const desc = JSON.stringify(t.inputSchema.shape.multi_select.description ?? t.inputSchema.shape.multi_select._def?.description ?? "")
    expect(desc).toContain("、")
  })
})

describe("应用内多选题卡片", () => {
  const base: AppChatQuestionItem = {
    kind: "question", id: "q1", messageId: "q1", ts: 1, text: "给哪些人开？", options: OPTIONS, multi: true,
  }
  const render = (item: Partial<AppChatQuestionItem>) =>
    renderToStaticMarkup(createElement(QuestionCard, { item: { ...base, ...item }, onAnswer: vi.fn() }))
  const count = (html: string, re: RegExp) => (html.match(re) ?? []).length
  const checked = (html: string) => count(html, /aria-checked="true"/g)
  // 数 disabled 属性本身（提交按钮的 class 里也有 disabled: 前缀的样式，不能按子串数）
  const disabled = (html: string) => count(html, /\sdisabled=""/g)

  it("还没选：选项都是没勾的复选框，提交按钮灰着（没勾不能提交）", () => {
    const html = render({})
    expect(count(html, /role="checkbox"/g)).toBe(3)
    expect(checked(html)).toBe(0)
    // 3 个选项都能点，只有「提交」被禁用
    expect(disabled(html)).toBe(1)
    expect(html).toContain("提交")
    expect(html).toContain("可多选")
  })

  it("单选题不受影响：没有复选框、没有提交按钮", () => {
    const html = render({ multi: undefined })
    expect(count(html, /role="checkbox"/g)).toBe(0)
    expect(html).not.toContain("提交")
  })

  it("已提交、答案还在等（held：等 AI 说完 / 等其余问题）：已选的项打勾，仍可改勾，并提示还没交给 Agent", () => {
    const html = render({ answered: "SUB_CHILD、SUB_ADULT", held: true })
    expect(checked(html)).toBe(2)
    expect(html).toContain("等 AI 说完、问题都选完后一起提交")
    expect(html).toContain("更新选择")
    // 3 个选项仍可点；勾选没变，「更新选择」不可点
    expect(disabled(html)).toBe(1)
  })

  it("已交给 Agent：选项全部锁定、已选的项保持打勾，没有提交按钮", () => {
    const html = render({ answered: "SUB_TEEN、SUB_ADULT" })
    expect(checked(html)).toBe(2)
    expect(disabled(html)).toBe(3)
    expect(html).not.toContain("提交")
  })

  it("已关闭：锁定并显示关闭原因", () => {
    const html = render({ closedNote: "问题已关闭" })
    expect(checked(html)).toBe(0)
    expect(disabled(html)).toBe(3)
    expect(html).toContain("问题已关闭")
  })
})
