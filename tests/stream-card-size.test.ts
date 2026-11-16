import { describe, expect, it } from "vitest"
import { LarkSender } from "../src/shared/lark-core"

/**
 * 流式卡的体积预算（飞书 200860：整卡不能超过 30 KB）。
 * 过去只管元素个数（≤200），内容很长的卡元素不多却超 30 KB，整卡更新失败后卡片就停在旧内容上。
 */

const BUDGET = LarkSender.STREAM_CARD_BYTE_BUDGET
const cjk = (n: number) => "思".repeat(n)
const bytes = (card: unknown) => LarkSender.cardBytes(card)
const json = (card: unknown) => JSON.stringify(card)
const elementsOf = (card: any): any[] => card.body.elements

type Seg = Parameters<typeof LarkSender.buildStreamingCardJson>[0] extends infer O
  ? O extends { segments?: infer S } ? NonNullable<S>[number] : never
  : never

const thinking = (marker: string, len = 1500): Seg => ({ type: "thinking", text: marker + cjk(len), expanded: false })
const tools = (prefix: string, steps = 10, detail = 120): Seg => ({
  type: "tools",
  expanded: false,
  steps: Array.from({ length: steps }, (_, i) => ({ title: `${prefix}-s${i}`, status: "success", detail: cjk(detail) })),
  stats: { calls: steps, failed: 0 },
})
const reply = (text: string): Seg => ({ type: "reply", text })
const build = (segments: Seg[], extra: Record<string, unknown> = {}) =>
  LarkSender.buildStreamingCardJson({ status: "streaming", showThinking: true, segments, ...extra }) as any

/** 5 轮「2 个思考 + 10 步工具 + 一句回复」：元素数不到 180，但体积 31 KB，现实里很普通的长会话 */
const fiveRounds = (): Seg[] =>
  Array.from({ length: 5 }, (_, r) => [thinking(`THINK-r${r}-a `, 800), thinking(`THINK-r${r}-b `, 800), tools(`Tool-r${r}`), reply(`REPLY-r${r}`)]).flat()

describe("cardBytes", () => {
  it("按 UTF-8 字节数算：汉字 3 字节", () => {
    expect(bytes("a")).toBe(3) // JSON 里带引号："a"
    expect(bytes("思")).toBe(5) // 两个引号 + 3 字节
  })
})

describe("体积预算：没超就一个字不改", () => {
  it("小卡和不设预算时完全一样", () => {
    const segs = [thinking("T ", 300), tools("Tool", 3, 40), reply("你好，这是回复")]
    expect(build(segs)).toEqual(build(segs, { byteBudget: 10_000_000 }))
  })

  it("刚好在预算以内的大卡也不动：正文完整、没有省略提示", () => {
    const segs = [reply(cjk(6000))] // 约 18 KB
    const card = build(segs)
    expect(bytes(card)).toBeLessThanOrEqual(BUDGET)
    expect(json(card)).not.toContain("内容过长")
    expect(json(card)).toContain(cjk(6000))
  })
})

describe("体积预算：过程内容太多时，先丢旧的", () => {
  it("5 轮长会话：不加预算时超 30 KB，加了之后在预算内", () => {
    const before = build(fiveRounds(), { byteBudget: 10_000_000 })
    expect(bytes(before)).toBeGreaterThan(30 * 1024) // 复现：过去就是这张卡让飞书报 200860
    const card = build(fiveRounds())
    expect(bytes(card)).toBeLessThanOrEqual(BUDGET)
    expect(LarkSender.countCardElements(card)).toBeLessThanOrEqual(LarkSender.STREAM_ELEMENT_BUDGET)
  })

  it("丢的是最早的过程；每一轮的回复都在，最新一轮的思考和工具也在", () => {
    const s = json(build(fiveRounds()))
    for (let r = 0; r < 5; r++) expect(s).toContain(`REPLY-r${r}`)
    expect(s).toContain("THINK-r4-b ")
    expect(s).toContain("Tool-r4-s9")
    expect(s).not.toContain("THINK-r0-a ")
  })

  it("纯思考（没有工具块）也不会被丢光：至少留着最新的思考，卡片不为空", () => {
    const segs = Array.from({ length: 8 }, (_, i) => thinking(`T${i} `, 1500))
    const card = build(segs)
    expect(bytes(card)).toBeLessThanOrEqual(BUDGET)
    expect(elementsOf(card).length).toBeGreaterThan(0)
    expect(json(card)).toContain("T7 ")
    expect(json(card)).not.toContain("T0 ")
  })

  it("只有一个超大的思考：不丢它，截成尾部", () => {
    const segs = [thinking("HEAD ", 20000)]
    const card = build(segs)
    expect(bytes(card)).toBeLessThanOrEqual(BUDGET)
    expect(json(card)).not.toContain("HEAD ")
    expect(json(card)).toContain(cjk(200))
  })

  it("自定义预算也生效（飞书报 200860 后 daemon 会给这张卡收紧）", () => {
    const small = 12 * 1024
    const card = build(fiveRounds(), { byteBudget: small })
    expect(bytes(card)).toBeLessThanOrEqual(small)
    expect(json(card)).toContain("THINK-r4-b ")
  })

  it("收紧到下限：回复仍在，卡片不为空", () => {
    const card = build(fiveRounds(), { byteBudget: 8 * 1024 })
    expect(bytes(card)).toBeLessThanOrEqual(8 * 1024)
    for (let r = 0; r < 5; r++) expect(json(card)).toContain(`REPLY-r${r}`)
  })
})

describe("体积预算：正文太长放不下", () => {
  it("12000 字的回复：截到预算内，开头完整，末尾写明省略了多少字", () => {
    const full = "开头标记。" + cjk(12000)
    const before = build([reply(full)], { byteBudget: 10_000_000 })
    expect(bytes(before)).toBeGreaterThan(30 * 1024)

    const card = build([reply(full)])
    expect(bytes(card)).toBeLessThanOrEqual(BUDGET)
    const md = elementsOf(card).find((e) => e.tag === "markdown" && String(e.content).includes("开头标记。"))
    expect(md).toBeDefined()
    const content = String(md.content)
    expect(content.startsWith("开头标记。")).toBe(true)
    expect(content).toContain("内容过长")
    // 写明的省略字数 = 真实被截掉的字数
    const omitted = Number(/后面约 (\d+) 字/.exec(content)![1])
    const kept = content.split("\n\n<font")[0].length
    expect(kept + omitted).toBe(full.length)
  })

  it("飞书那边的上限也得满足：截完后连同整卡不到 30 KB", () => {
    const card = build([thinking("T ", 1500), tools("Tool"), reply(cjk(40000))])
    expect(bytes(card)).toBeLessThan(30 * 1024)
    expect(bytes(card)).toBeLessThanOrEqual(BUDGET)
  })

  it("正文放不下时先丢过程，不先动正文：回复里的内容比过程更重要", () => {
    const card = build([thinking("OLD ", 1500), tools("OldTool"), reply("REPLY-A"), thinking("NEW ", 1500), reply(cjk(7000))])
    expect(bytes(card)).toBeLessThanOrEqual(BUDGET)
    expect(json(card)).toContain("REPLY-A")
  })

  it("截在代码块中间：补上结束标记，后面的内容不会被当成代码", () => {
    const full = "说明\n```ts\n" + "const a = 1;\n".repeat(4000) + "```\n结尾"
    const card = build([reply(full)])
    const md = elementsOf(card).find((e) => e.tag === "markdown" && String(e.content).includes("说明"))
    const fences = (String(md.content).match(/^```/gm) ?? []).length
    expect(fences % 2).toBe(0)
    expect(bytes(card)).toBeLessThanOrEqual(BUDGET)
  })

  it("多条回复时只截最长的一条", () => {
    const card = build([reply("SHORT-ONE"), reply(cjk(12000))])
    // 相邻回复在卡片里是两个 markdown
    expect(json(card)).toContain("SHORT-ONE")
    expect(json(card)).toContain("内容过长")
    expect((json(card).match(/内容过长/g) ?? []).length).toBe(1)
  })

  it("不算这条正文卡片本身就超了（别的块太大）：截正文救不了，就不去动它", () => {
    const todos: Seg = { type: "todos", items: Array.from({ length: 60 }, (_, i) => ({ content: `任务${i}` + cjk(100), status: "pending" })) }
    const card = build([todos, reply(cjk(1000))], { byteBudget: 8 * 1024 })
    expect(json(card)).not.toContain("内容过长")
    expect(json(card)).toContain(cjk(1000))
  })

  it("收口帧（completed）同样走预算：回复很长的收口卡也能更新成功，而不是失败后卡在旧内容上", () => {
    const card = LarkSender.buildStreamingCardJson({ status: "completed", segments: [reply(cjk(20000))] }) as any
    expect(bytes(card)).toBeLessThanOrEqual(BUDGET)
    expect(card.config.streaming_mode).toBe(false)
  })
})

describe("clipReplyForCard", () => {
  it("没超就原样返回", () => {
    expect(LarkSender.clipReplyForCard("abc", 10)).toBe("abc")
  })

  it("尽量在行尾断开，不把一行切成两半", () => {
    const text = ["第一行", "第二行", "第三行很长很长很长很长很长"].join("\n")
    const out = LarkSender.clipReplyForCard(text, 12)
    expect(out.startsWith("第一行\n第二行")).toBe(true)
    expect(out).not.toContain("第三行")
  })

  it("省略字数 = 原文长度 − 保留的长度", () => {
    const text = "a".repeat(1000)
    const out = LarkSender.clipReplyForCard(text, 300)
    const kept = out.split("\n\n<font")[0].length
    expect(Number(/后面约 (\d+) 字/.exec(out)![1])).toBe(1000 - kept)
  })
})
