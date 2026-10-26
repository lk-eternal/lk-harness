import { describe, it, expect } from "vitest"
import { LarkSender } from "../src/shared/lark-core.js"
import { buildCardSegmentsFromPayload } from "../src/daemon.js"

type Step = { title: string; status: string; detail?: string; icon?: string }
type Seg =
  | { type: "thinking"; text: string; panelId?: string; expanded?: boolean }
  | { type: "tools"; panelId?: string; expanded?: boolean; steps: Step[]; stats?: { calls: number; failed: number } }
  | { type: "reply"; text: string }
  | { type: "todos"; items: Array<{ content: string; status: string }> }

type El = Record<string, any>

const think = (tag: string, panelId?: string): Seg => ({ type: "thinking", text: `思考内容${tag}`, panelId })
const tools = (steps: Array<[string, string?, string?]>, panelId?: string): Seg => ({
  type: "tools",
  panelId,
  steps: steps.map(([title, detail, status]) => ({ title, detail, status: status ?? "success" })),
})
const reply = (text: string): Seg => ({ type: "reply", text })

function build(segments: Seg[], extra: { status?: "streaming" | "completed"; showThinking?: boolean; keepPerKind?: number } = {}): El[] {
  const card = LarkSender.buildStreamingCardJson({ status: "streaming", segments, ...extra }) as { body: { elements: El[] } }
  return card.body.elements
}

const panelsOf = (els: El[]) => els.filter((e) => e.tag === "collapsible_panel")
const groupsOf = (els: El[]) => panelsOf(els).filter((p) => String(p.element_id).startsWith("grp_"))
const titleOf = (p: El): string => p.header.title.content

function collectIds(node: unknown, out: string[] = []): string[] {
  if (Array.isArray(node)) node.forEach((x) => collectIds(x, out))
  else if (node && typeof node === "object") {
    const rec = node as El
    if (typeof rec.element_id === "string") out.push(rec.element_id)
    Object.values(rec).forEach((v) => collectIds(v, out))
  }
  return out
}

describe("飞书流式卡：连续的思考/工具块折成一组", () => {
  it("连续的思考和工具折成一个面板：折叠、标题一行汇总，展开后是原来的每个块", () => {
    const els = build([
      think("a"),
      tools([["shell", "npm test"]]),
      think("b"),
      tools([["Read", "src/a.ts"]]),
    ])
    expect(els).toHaveLength(1)
    const group = els[0]
    expect(group.tag).toBe("collapsible_panel")
    expect(String(group.element_id)).toMatch(/^grp_/)
    expect(group.expanded).toBe(false)
    expect(titleOf(group)).toBe("⚙️ 思考 2 · 工具 2 · ✓ Read  src/a.ts")
    // 组内仍是原来的 4 个面板，各自带着自己的内容
    expect(group.elements).toHaveLength(4)
    expect(group.elements.map((e: El) => String(e.element_id).split("_")[0])).toEqual(["think", "tool", "think", "tool"])
    expect(JSON.stringify(group.elements)).toContain("npm test")
    expect(JSON.stringify(group.elements)).toContain("思考内容b")
  })

  it("单个思考/工具块保持原样，不套组面板", () => {
    expect(groupsOf(build([think("a")]))).toHaveLength(0)
    expect(groupsOf(build([reply("x"), tools([["shell"]]), reply("y")]))).toHaveLength(0)
    // 被回复隔开的两个块各自是单块
    const els = build([think("a"), reply("中间"), tools([["shell"]])])
    expect(groupsOf(els)).toHaveLength(0)
    expect(panelsOf(els)).toHaveLength(2)
  })

  it("回复把前后的过程隔成不同的组，回复照常显示", () => {
    const els = build([
      think("a"), tools([["shell", "first"]]),
      reply("中间的回复"),
      think("b"), tools([["Grep", "second"]]),
    ])
    expect(els.map((e) => e.tag)).toEqual(["collapsible_panel", "markdown", "collapsible_panel"])
    expect(titleOf(els[0])).toContain("first")
    expect(titleOf(els[2])).toContain("second")
    expect(els[1].content).toBe("中间的回复")
    expect(new Set(groupsOf(els).map((g) => g.element_id)).size).toBe(2)
  })

  it("任务清单也会隔断：清单前后的过程各成一组", () => {
    const els = build([
      think("a"), tools([["shell"]]),
      { type: "todos", items: [{ content: "做事", status: "pending" }] },
      think("b"), tools([["shell"]]),
    ])
    expect(groupsOf(els)).toHaveLength(2)
    expect(els.some((e) => String(e.element_id).startsWith("todos_"))).toBe(true)
  })

  it("有失败的工具：标题带失败数，最后一步失败时标 ✗", () => {
    const els = build([
      think("a"),
      tools([["shell", "ok", "success"], ["shell", "boom", "error"]]),
      think("b"),
      tools([["Read", "x.ts", "error"]]),
    ])
    const title = titleOf(els[0])
    expect(title).toContain("⚠️ 2 失败")
    expect(title).toContain("✗ Read  x.ts")
  })

  it("正在运行的工具标 ⏳", () => {
    const title = titleOf(build([think("a"), tools([["shell", "npm run build", "running"]])])[0])
    expect(title).toContain("⏳ shell  npm run build")
  })

  it("流式且这一组在末尾、最后一步是思考：尾部写「思考中…」；有回复跟在后面或已收口则不写", () => {
    const process: Seg[] = [think("a"), tools([["shell", "ls"]]), think("b")]
    expect(titleOf(build(process)[0])).toBe("⚙️ 思考 2 · 工具 1 · 思考中…")
    expect(titleOf(build([...process, reply("好了")])[0])).toBe("⚙️ 思考 2 · 工具 1 · ✓ shell  ls")
    expect(titleOf(build(process, { status: "completed" })[0])).toBe("⚙️ 思考 2 · 工具 1 · ✓ shell  ls")
  })

  it("汇总按裁剪前整段统计：旧块被丢后数字也不回退，组内只展示最近的块", () => {
    const segments: Seg[] = []
    for (let i = 0; i < 12; i++) {
      segments.push(think(`t${i}`, `t${i + 1}`))
      segments.push(tools([[`step${i}-a`], [`step${i}-b`]], `o${i + 1}`))
    }
    const els = build(segments)
    expect(els).toHaveLength(1)
    expect(titleOf(els[0])).toContain("思考 12 · 工具 24")
    // 默认每类只留最近 5 块：5 个思考 + 5 个工具
    expect(els[0].elements).toHaveLength(10)
    const json = JSON.stringify(els)
    expect(json).toContain("思考内容t11")
    expect(json).not.toContain("思考内容t0")
    // 组 id 取整段首个成员的 panelId，旧块被丢也不变
    expect(els[0].element_id).toBe("grp_t1")
  })

  it("工具步骤被截断时用真实调用数（stats），而不是剩下的步数", () => {
    const truncated: Seg = {
      type: "tools",
      steps: Array.from({ length: 10 }, (_, i) => ({ title: "shell", status: "success", detail: `c${i}` })),
      stats: { calls: 73, failed: 3 },
    }
    const title = titleOf(build([think("a"), truncated])[0])
    expect(title).toContain("工具 73")
    expect(title).toContain("⚠️ 3 失败")
  })

  it("裁剪后组内只剩一个块时不再折组，原样输出", () => {
    const els = build([think("a"), think("b")], { keepPerKind: 1 })
    expect(groupsOf(els)).toHaveLength(0)
    expect(els).toHaveLength(1)
    expect(JSON.stringify(els)).toContain("思考内容b")
    expect(JSON.stringify(els)).not.toContain("思考内容a")
  })

  it("标题永远一行：多行、超长的工具参数被压成一行并截断", () => {
    const detail = "第一行\n第二行 " + "x".repeat(300)
    const title = titleOf(build([think("a"), tools([["shell", detail]])])[0])
    expect(title).not.toContain("\n")
    expect(title.endsWith("…")).toBe(true)
    expect(Array.from(title).length).toBeLessThanOrEqual(70)
    expect(title).toContain("第一行 第二行")
  })

  it("工具名带服务器前缀时和工具块里的写法一致", () => {
    const title = titleOf(build([think("a"), tools([["lk-harness_send_image"]])])[0])
    expect(title).toContain("✓ lk-harness · send_image")
  })

  it("隐藏思考时，被隐藏思考隔开的相邻工具块也并成一组", () => {
    const els = build([tools([["shell", "a"]]), think("hidden"), tools([["Read", "b"]])], { showThinking: false })
    expect(els).toHaveLength(1)
    expect(titleOf(els[0])).toBe("⚙️ 工具 2 · ✓ Read  b")
    expect(JSON.stringify(els)).not.toContain("思考内容hidden")
  })

  it("整张卡的 element_id 唯一且合法（≤20 字符，字母开头）", () => {
    const segments: Seg[] = []
    for (let i = 0; i < 4; i++) {
      segments.push(think(`t${i}`, `t${i + 1}`), tools([["shell", `d${i}`]], `o${i + 1}`))
      segments.push(reply(`回复${i}`))
    }
    const ids = collectIds(build(segments))
    expect(new Set(ids).size).toBe(ids.length)
    for (const id of ids) expect(id).toMatch(/^[A-Za-z][A-Za-z0-9_]{0,19}$/)
    expect(ids.some((id) => id.startsWith("grp_"))).toBe(true)
  })

  it("没有 panelId 时用位置下标生成组 id，仍然合法", () => {
    const g = groupsOf(build([reply("先来一句"), think("a"), tools([["shell"]])]))[0]
    expect(g.element_id).toBe("grp_r1")
  })

  it("元素总数仍在预算内（组外壳只多出几个元素）", () => {
    const segments: Seg[] = []
    for (let i = 0; i < 30; i++) {
      segments.push(think(`t${i}`), tools(Array.from({ length: 8 }, (_, k) => [`s${i}-${k}`, `detail ${k}`] as [string, string])))
    }
    segments.push(reply("final"))
    const els = build(segments)
    expect(LarkSender.countCardElements(els)).toBeLessThanOrEqual(LarkSender.STREAM_ELEMENT_BUDGET)
    expect(groupsOf(els)).toHaveLength(1)
  })

  it("annotateProcessRuns 不改入参", () => {
    const input: Seg[] = [think("a"), tools([["shell"]]), reply("x")]
    const out = LarkSender.annotateProcessRuns(input)
    expect(out[0]).not.toBe(input[0])
    expect("run" in input[0]).toBe(false)
    expect((out[0] as { run?: unknown }).run).toBeDefined()
    expect(out[2]).toBe(input[2])
  })
})

describe("daemon 生成卡片分段：工具调用数在截断前统计", () => {
  it("单个工具块超过体积上限时，stats 是真实数量，组头按它显示", () => {
    // 不带 summary：每步 3 个元素，40 步加思考面板才不会被元素预算挤掉
    const manyTools = Array.from({ length: 60 }, (_, i) => ({
      name: `tool${i}`,
      status: i % 20 === 0 ? "error" : "success",
    }))
    const segs = buildCardSegmentsFromPayload(
      { segments: [{ type: "thinking", text: "想一想", ms: 1200 }, { type: "tools", tools: manyTools }] },
      { finish: false, showThinking: true },
    )
    const toolSeg = segs.find((s) => s.type === "tools")
    expect(toolSeg && toolSeg.type === "tools" && toolSeg.steps.length).toBe(40)
    expect(toolSeg && toolSeg.type === "tools" && toolSeg.stats).toEqual({ calls: 60, failed: 3 })

    const card = LarkSender.buildStreamingCardJson({ status: "streaming", segments: segs }) as { body: { elements: El[] } }
    const group = card.body.elements[0]
    expect(titleOf(group)).toContain("思考 1 · 工具 60")
    expect(titleOf(group)).toContain("⚠️ 3 失败")
    expect(titleOf(group)).toContain("✓ tool59")
  })

  it("收口后仍保留过程块（不隐藏思考）时：残留的 running 按成功显示，组头跟着是 ✓", () => {
    const segs = buildCardSegmentsFromPayload(
      { segments: [{ type: "thinking", text: "想", ms: 500 }, { type: "tools", tools: [{ name: "shell", status: "running", summary: "sleep 100" }] }] },
      { finish: true, showThinking: true, hideThinkingOnFinish: false },
    )
    const card = LarkSender.buildStreamingCardJson({ status: "completed", segments: segs }) as { body: { elements: El[] } }
    expect(titleOf(card.body.elements[0])).toBe("⚙️ 思考 1 · 工具 1 · ✓ shell  sleep 100")
  })
})
