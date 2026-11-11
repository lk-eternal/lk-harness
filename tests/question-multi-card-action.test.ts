/**
 * 飞书多选题的卡片回调：直接驱动 daemon 里真实的 handleCardAction，
 * 通道里挂一个假的飞书发送器（记录每次整卡刷新），验证「表单提交 → 读勾选 → 作答」这套状态机。
 *
 * 勾选在飞书客户端本地完成、不回调；服务端只会收到「提交」这一次回调，
 * 勾选内容在 formValue 里（LarkSender 收到回调时已把布尔值转成字符串 "true" / "false"）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { agentStreamCards, cardQuestionMap, channels, buildCardSegmentsFromPayload, handleCardAction } from "../src/daemon.js"
import { checkerFieldName } from "../src/shared/question-multi.js"

type El = Record<string, any>
const OPTIONS = ["SUB_CHILD", "SUB_TEEN", "SUB_ADULT", "SUB_ALL"]
const CHANNEL = "ch_multi_test"
const CHAT = `${CHANNEL}|oc_multi_test`
const SESSION = `${CHAT}::D:\\ws\\multi-test`

const updates: El[] = []
const sender = {
  updateStreamingCard: vi.fn(async (_cardId: string, card: El) => { updates.push(card); return true }),
  closeStreamingCard: vi.fn(async () => true),
}
const rt: any = {
  cfg: { id: CHANNEL, name: "multi-test", type: "feishu", mainUserEnabled: false, mainUserChatId: "", workspaceDir: "" },
  sender,
  lastP2pChatId: null,
  bindArmed: false,
}

let seq = 0
let messageId: string

/** 往流式卡里放未决的多选题（和 /api/send-question 发题时放进去的一样） */
function seedCard(block: El = {}, ...more: El[]) {
  messageId = `om_multi_${++seq}`
  const mk = (b: El) => ({ blockId: "q1", insertAt: 0, text: "给哪些人开？", options: OPTIONS, multi: true, ...b })
  agentStreamCards.set(SESSION, {
    cardId: `card_${seq}`, messageId, sequence: 0, channelId: CHANNEL, showThinking: false,
    lastHash: "", lastSegments: [], mcpReplies: [], createdAt: Date.now(), inflight: Promise.resolve(),
    panelSeq: 0, knownPanelIds: new Set(), expandedPanelIds: new Set(),
    questionBlocks: [mk(block), ...more.map(mk)],
  } as any)
}

const blockOf = (id = "q1") => agentStreamCards.get(SESSION)!.questionBlocks.find((b) => b.blockId === id)!

/** 卡片上这道题的勾选框 name 前缀：取自真实渲染出的表单，和客户端实际回传的字段名同源 */
function prefixOf(blockId = "q1"): string {
  const [seg] = buildCardSegmentsFromPayload(
    { segments: [{ type: "question", blockId, text: "x", options: OPTIONS, multi: true }] },
    { finish: false, showThinking: false },
    undefined,
    SESSION,
  )
  if (seg.type !== "question" || !seg.form) throw new Error("没渲染出表单")
  return seg.form.namePrefix
}

/** 提交时飞书回传的表单值：每个勾选框一个 "true" / "false" */
const formOf = (checked: string[], prefix = prefixOf()) =>
  Object.fromEntries(OPTIONS.map((o, i) => [checkerFieldName(prefix, i), String(checked.includes(o))]))

const act = (value: El, formValue?: El) =>
  handleCardAction(rt, { messageId, chatId: "oc_multi_test", value, formValue } as any) as Promise<El>
const submit = (formValue?: El, blockId = "q1") => act({ kind: "question_submit", sk: SESSION, blockId }, formValue)

/** 回调返回的整张卡里某个 tag 的节点数 */
function countTag(card: unknown, tag: string): number {
  let n = 0
  const walk = (x: unknown) => {
    if (Array.isArray(x)) return x.forEach(walk)
    if (x && typeof x === "object") {
      const el = x as El
      if (el.tag === tag) n++
      Object.values(el).forEach(walk)
    }
  }
  walk(card)
  return n
}

beforeEach(() => {
  updates.length = 0
  sender.updateStreamingCard.mockClear()
  channels.set(CHANNEL, rt)
})
afterEach(() => {
  agentStreamCards.delete(SESSION)
  cardQuestionMap.clear()
  channels.delete(CHANNEL)
})

describe("飞书多选题：提交", () => {
  it("一项没勾就提交：提示先勾选，问题仍然开着，不刷卡", async () => {
    seedCard()
    const r = await submit(formOf([]))
    expect(r.toast).toMatchObject({ type: "warning", content: "请先勾选至少一项" })
    expect(r.card).toBeUndefined()
    expect(blockOf().answered).toBeUndefined()
    expect(sender.updateStreamingCard).not.toHaveBeenCalled()
  })

  it("勾了之后提交：答案是勾选项按题目顺序用「、」连起来；卡片变成已选择（没有表单和勾选框）", async () => {
    seedCard()
    const r = await submit(formOf(["SUB_ADULT", "SUB_CHILD"]))
    expect(blockOf().answered).toBe("SUB_CHILD、SUB_ADULT")
    expect(r.toast).toMatchObject({ type: "success" })
    expect(r.card.type).toBe("raw")
    expect(countTag(r.card.data, "form")).toBe(0)
    expect(countTag(r.card.data, "checker")).toBe(0)
    expect(JSON.stringify(r.card.data)).toContain("已选择: **SUB_CHILD、SUB_ADULT**")
    // 同时把整张卡推给飞书（流式卡全量更新）
    expect(sender.updateStreamingCard).toHaveBeenCalledTimes(1)
    expect(JSON.stringify(updates[0])).toContain("已选择: **SUB_CHILD、SUB_ADULT**")
  })

  it("只勾一项：答案就是这个选项本身", async () => {
    seedCard()
    await submit(formOf(["SUB_TEEN"]))
    expect(blockOf().answered).toBe("SUB_TEEN")
  })

  it("全勾上也行", async () => {
    seedCard()
    await submit(formOf(OPTIONS))
    expect(blockOf().answered).toBe(OPTIONS.join("、"))
  })

  it("提交没带勾选内容（没有表单值 / 空表单 / 只有别的字段）：提示改用文字回复，不当成「一项没勾」，问题仍开着", async () => {
    seedCard()
    for (const fv of [undefined, {}, { custom_input: "A" }]) {
      const r = await submit(fv)
      expect(r.toast).toMatchObject({ type: "warning" })
      expect(r.toast.content).toContain("没读到勾选内容")
      expect(r.toast.content).not.toBe("请先勾选至少一项")
    }
    expect(blockOf().answered).toBeUndefined()
    expect(sender.updateStreamingCard).not.toHaveBeenCalled()
  })

  it("重复点提交只作答一次", async () => {
    seedCard()
    const first = await submit(formOf(["SUB_TEEN"]))
    expect(first.toast).toMatchObject({ type: "success" })
    const again = await submit(formOf(["SUB_ALL"]))
    expect(again.toast).toMatchObject({ type: "warning" })
    expect(blockOf().answered).toBe("SUB_TEEN")
  })

  it("已作答 / 已关闭 / 不是多选题 / 题目不在卡里：都提示已过期，不动卡", async () => {
    seedCard({ answered: "SUB_CHILD" })
    expect((await submit(formOf(["SUB_TEEN"]))).toast).toMatchObject({ type: "warning" })
    expect(blockOf().answered).toBe("SUB_CHILD")

    seedCard({ closedNote: "问题已关闭" })
    expect((await submit(formOf(["SUB_TEEN"]))).toast).toMatchObject({ type: "warning" })

    seedCard({ multi: false })
    expect((await submit(formOf(["SUB_TEEN"]))).toast).toMatchObject({ type: "warning" })

    seedCard()
    const r = await submit(formOf(["SUB_TEEN"]), "不存在")
    expect(r.toast).toMatchObject({ type: "warning" })
    expect(sender.updateStreamingCard).not.toHaveBeenCalled()
  })
})

describe("飞书多选题：同一张卡里有两道题", () => {
  it("提交第一题只读第一题的勾选；第二题还开着，表单和勾选框原样留在卡上", async () => {
    seedCard({ blockId: "q1" }, { blockId: "q2", text: "第二题？" })
    const r = await submit(formOf(["SUB_TEEN"], prefixOf("q1")), "q1")
    expect(blockOf("q1").answered).toBe("SUB_TEEN")
    expect(blockOf("q2").answered).toBeUndefined()
    expect(r.toast.content).toContain("已选择")
    expect(countTag(r.card.data, "form")).toBe(1)
    expect(countTag(r.card.data, "checker")).toBe(OPTIONS.length)
  })

  it("别的题的勾选框字段不会算到这道题头上", async () => {
    seedCard({ blockId: "q1" }, { blockId: "q2" })
    const r = await submit(formOf(OPTIONS, prefixOf("q2")), "q1")
    expect(r.toast.content).toContain("没读到勾选内容")
    expect(blockOf("q1").answered).toBeUndefined()
  })
})

describe("独立的多选题卡（不在流式卡里）：提交", () => {
  const seedAlone = () => {
    messageId = `om_alone_${++seq}`
    cardQuestionMap.set(messageId, {
      text: "给哪些人开？", displayBody: "给哪些人开？\n\n**A.** SUB_CHILD", options: OPTIONS, createdAt: Date.now(), multi: true,
    } as any)
  }
  const aloneForm = (checked: string[]) => formOf(checked, "qm")

  it("按固定前缀读勾选，答完整卡换成已选择，并撤掉待答记录", async () => {
    seedAlone()
    const r = await act({ kind: "question_submit" }, aloneForm(["SUB_ALL", "SUB_TEEN"]))
    expect(r.toast).toMatchObject({ type: "success" })
    expect(JSON.stringify(r.card.data)).toContain("已选择: **SUB_TEEN、SUB_ALL**")
    expect(countTag(r.card.data, "form")).toBe(0)
    expect(cardQuestionMap.has(messageId)).toBe(false)
  })

  it("一项没勾：提示先勾选，待答记录还在", async () => {
    seedAlone()
    const r = await act({ kind: "question_submit" }, aloneForm([]))
    expect(r.toast).toMatchObject({ type: "warning", content: "请先勾选至少一项" })
    expect(cardQuestionMap.has(messageId)).toBe(true)
  })

  it("没带勾选内容：提示改用文字回复", async () => {
    seedAlone()
    const r = await act({ kind: "question_submit" }, undefined)
    expect(r.toast.content).toContain("没读到勾选内容")
    expect(cardQuestionMap.has(messageId)).toBe(true)
  })
})

describe("旧版多选卡（每个选项一个开关按钮）", () => {
  it("点开关：明确提示这张卡已失效，不改任何状态、不刷卡", async () => {
    seedCard()
    const r = await act({ kind: "question_toggle", opt: "SUB_TEEN", sk: SESSION, blockId: "q1" })
    expect(r.toast).toMatchObject({ type: "warning" })
    expect(r.toast.content).toContain("旧版样式")
    expect(r.card).toBeUndefined()
    expect(blockOf().answered).toBeUndefined()
    expect(sender.updateStreamingCard).not.toHaveBeenCalled()
  })

  it("旧卡的「提交」没有表单值：同样提示，不会误作答", async () => {
    seedCard()
    const r = await submit(undefined)
    expect(r.toast.content).toContain("没读到勾选内容")
    expect(blockOf().answered).toBeUndefined()
  })
})

describe("单选题不受影响", () => {
  it("点选项还是一点就作答（kind=question）", async () => {
    seedCard({ multi: undefined })
    const r = await act({ kind: "question", opt: "SUB_TEEN", sk: SESSION, blockId: "q1" })
    expect(blockOf().answered).toBe("SUB_TEEN")
    expect(r.toast).toMatchObject({ type: "success" })
  })
})
