import { describe, it, expect } from "vitest"
import { LarkSender } from "../src/shared/lark-core.js"

type Segment =
  | { type: "thinking"; text: string; title?: string; expanded?: boolean }
  | { type: "tools"; title?: string; expanded?: boolean; steps: Array<{ title: string; status: string; detail?: string; icon?: string }> }
  | { type: "reply"; text: string }
  | { type: "todos"; items: Array<{ content: string; status: string }> }

const mkTools = (n: number, tag: string): Segment => ({
  type: "tools",
  steps: Array.from({ length: n }, (_, i) => ({ title: `${tag}-step${i}`, status: "success", detail: `detail-${tag}-${i}` })),
})
const mkThink = (tag: string): Segment => ({ type: "thinking", text: `思考内容${tag} `.repeat(20) })
const mkReply = (tag: string): Segment => ({ type: "reply", text: `send_text 正文 ${tag}` })
const mkTodos = (tag: string): Segment => ({
  type: "todos",
  items: [{ content: `任务 ${tag}`, status: "todo" }],
})

function buildCard(segments: Segment[], showThinking = true): { json: string; count: number } {
  const card = LarkSender.buildStreamingCardJson({ status: "streaming", showThinking, segments }) as {
    body: { elements: unknown[] }
  }
  return { json: JSON.stringify(card), count: LarkSender.countCardElements(card.body.elements) }
}

describe("流式卡压缩（各类型留最近 N，无省略占位）", () => {
  it("不超限且未超 N 时原样保留：detail 不剥、无省略占位", () => {
    const { json, count } = buildCard([mkThink("s"), mkTools(5, "S"), mkReply("s")])
    expect(count).toBeLessThanOrEqual(LarkSender.STREAM_ELEMENT_BUDGET)
    expect(json).toContain("detail-S-4")
    expect(json).not.toContain("已省略")
  })

  it("思考/工具各只留最近 5；reply 与 todos 全保留；无省略文案", () => {
    const segments: Segment[] = []
    for (let i = 0; i < 12; i++) {
      segments.push(mkThink(`t${i}`))
      segments.push(mkTools(3, `g${i}`))
      if (i % 3 === 0) segments.push(mkReply(`r${i}`))
      if (i === 2) segments.push(mkTodos("mid"))
    }
    segments.push(mkThink("latest"))
    segments.push(mkTools(8, "LATEST"))
    segments.push(mkReply("final"))
    segments.push(mkTodos("end"))

    const { json, count } = buildCard(segments)
    expect(count).toBeLessThanOrEqual(LarkSender.STREAM_ELEMENT_BUDGET)
    expect(json).not.toContain("已省略")

    for (const r of ["r0", "r3", "r6", "r9", "final"]) {
      expect(json).toContain(`send_text 正文 ${r}`)
    }
    expect(json).toContain("任务 mid")
    expect(json).toContain("任务 end")

    expect(json).not.toContain("思考内容t0 ")
    expect(json).not.toContain("g0-step0")
    expect(json).toContain("思考内容latest ")
    expect(json).toContain("LATEST-step0")
  })

  it("keepPerKind 可配置（非默认 5）", () => {
    const segments: Segment[] = []
    for (let i = 0; i < 10; i++) {
      segments.push(mkThink(`t${i}`))
      segments.push(mkTools(1, `g${i}`))
    }
    const kept = LarkSender.keepRecentStreamSegments(segments, 3, true)
    expect(kept.filter((s) => s.type === "thinking")).toHaveLength(3)
    expect(kept.filter((s) => s.type === "tools")).toHaveLength(3)
    expect(LarkSender.normalizeStreamKeepPerKind(undefined)).toBe(5)
    expect(LarkSender.normalizeStreamKeepPerKind(99)).toBe(20)
  })

  it("keepRecentStreamSegments 精确保留各类型最近 N 块", () => {
    const segments: Segment[] = []
    for (let i = 0; i < 8; i++) {
      segments.push(mkThink(`t${i}`))
      segments.push(mkTools(1, `g${i}`))
    }
    segments.push(mkReply("keep"))
    segments.push(mkTodos("keep"))
    const kept = LarkSender.keepRecentStreamSegments(segments, 5, true)
    expect(kept.filter((s) => s.type === "thinking")).toHaveLength(5)
    expect(kept.filter((s) => s.type === "tools")).toHaveLength(5)
    expect(kept.filter((s) => s.type === "reply")).toHaveLength(1)
    expect(kept.filter((s) => s.type === "todos")).toHaveLength(1)
    expect(kept.some((s) => s.type === "thinking" && (s as Extract<Segment, { type: "thinking" }>).text.includes("t3"))).toBe(true)
    expect(kept.some((s) => s.type === "thinking" && (s as Extract<Segment, { type: "thinking" }>).text.includes("t2"))).toBe(false)
  })

  it("单个超大工具块兜底：从头截步、尾部保留", () => {
    const { json, count } = buildCard([mkReply("head"), mkTools(300, "BIG"), mkReply("tail")])
    expect(count).toBeLessThanOrEqual(LarkSender.STREAM_ELEMENT_BUDGET)
    expect(json).toContain("BIG-step299")
    expect(json).not.toContain("\"BIG-step0\"")
    expect(json).toContain("send_text 正文 head")
    expect(json).toContain("send_text 正文 tail")
    expect(json).not.toContain("已省略")
  })

  it("showThinking=false 时 thinking 不渲染", () => {
    const segments: Segment[] = []
    for (let i = 0; i < 30; i++) {
      segments.push(mkThink(`t${i}`))
      segments.push(mkTools(8, `g${i}`))
    }
    segments.push(mkReply("final"))
    const { json, count } = buildCard(segments, false)
    expect(count).toBeLessThanOrEqual(LarkSender.STREAM_ELEMENT_BUDGET)
    expect(json).not.toContain("思考内容")
    expect(json).toContain("send_text 正文 final")
    expect(json).not.toContain("已省略")
  })
})

describe("完整回复后隐藏折叠块", () => {
  it("finish 且 hideOnFinish 默认开启时只留 reply", () => {
    const segments: Segment[] = [mkThink("a"), mkTools(2, "T"), mkTodos("x"), mkReply("done")]
    const stripped = LarkSender.stripFoldableSegmentsOnFinish(segments, { finish: true })
    expect(stripped).toEqual([mkReply("done")])
  })

  it("streaming 或未 finish 时不剥", () => {
    const segments: Segment[] = [mkThink("a"), mkReply("done")]
    expect(LarkSender.stripFoldableSegmentsOnFinish(segments, { finish: false })).toEqual(segments)
    expect(LarkSender.stripFoldableSegmentsOnFinish(segments, { finish: true, hideOnFinish: false })).toEqual(segments)
  })

  it("finish 后仅 thinking/tools 无正文时展示占位", () => {
    const segments: Segment[] = [mkThink("a"), mkTools(2, "T"), mkTodos("x")]
    const stripped = LarkSender.stripFoldableSegmentsOnFinish(segments, { finish: true })
    expect(stripped).toEqual([{ type: "reply", text: LarkSender.THINKING_ONLY_PLACEHOLDER }])
    const { json } = buildCard(stripped, true)
    expect(json).toContain("仅包含思考,无实质输出")
  })
})

describe("问题区样式", () => {
  it("questionText 时渲染灰框 panel，footer（含已选择）在 panel 内且保持展开", () => {
    const card = LarkSender.buildStreamingCardJson({
      status: "completed",
      questionText: "**请选择**\n\n**A.** 是\n**B.** 否",
      buttons: [{ label: "A", value: { kind: "q", opt: "是" } }, { label: "B", value: { kind: "q", opt: "否" } }],
      footer: "✅ 已选择: **是**",
    }) as { body: { elements: unknown[] } }
    const json = JSON.stringify(card)
    expect(json).not.toContain("cus-question")
    expect(json).not.toContain("background_style")
    expect(json).toContain("question_block")
    expect(json).toContain("collapsible_panel")
    expect(json).toContain('"color":"grey"')
    expect(json).toContain('"expanded":true')
    expect(json).toContain("✅ 已选择")
    const topLevelFoot = card.body.elements.filter((e) =>
      e && typeof e === "object" && (e as { tag?: string }).tag === "markdown"
        && JSON.stringify(e).includes("已选择"),
    )
    expect(topLevelFoot.length).toBe(0)
  })

  it("segments 内联 question 时问题块在正文之后、非卡片末尾 hr 区", () => {
    const card = LarkSender.buildStreamingCardJson({
      status: "completed",
      segments: [
        { type: "reply", text: "上文" },
        {
          type: "question",
          questionText: "**请选择**\n\n**A.** 是",
          buttons: [{ label: "A", value: { kind: "question", opt: "是" } }],
          footer: "✅ 已选择: **是**",
        },
        { type: "reply", text: "下文" },
      ],
    }) as { body: { elements: unknown[] } }
    const json = JSON.stringify(card)
    const replyIdx = json.indexOf("上文")
    const qIdx = json.indexOf("question_block")
    const afterIdx = json.indexOf("下文")
    expect(replyIdx).toBeGreaterThan(-1)
    expect(qIdx).toBeGreaterThan(replyIdx)
    expect(afterIdx).toBeGreaterThan(qIdx)
    expect(json).toContain("✅ 已选择")
  })
})
