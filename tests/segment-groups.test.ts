import { describe, expect, it } from "vitest"
import type { AppChatSegment } from "../src/shared/app-chat-types"
import { groupSegments, summarizeGroup, type ProcessSegment } from "../src/renderer/components/chat/segment-groups"

const thinking = (ms?: number): AppChatSegment => ({ type: "thinking", text: "...", ms })
const tools = (...names: string[]): AppChatSegment => ({
  type: "tools",
  tools: names.map((name) => ({ name, status: "done", summary: `${name} 的参数` })),
})
const reply = (text = "好的"): AppChatSegment => ({ type: "reply", text })
const todos = (): AppChatSegment => ({ type: "todos", items: [{ content: "a", status: "pending" }] })

describe("groupSegments", () => {
  it("没有分段时没有块", () => {
    expect(groupSegments([])).toEqual([])
  })

  it("连续的思考和工具折成一组，下标对得上原数组", () => {
    const segs = [thinking(1000), tools("read"), thinking(2000), tools("grep"), reply()]
    const blocks = groupSegments(segs)
    expect(blocks).toHaveLength(2)
    expect(blocks[0]).toEqual({ kind: "group", start: 0, segs: segs.slice(0, 4) })
    expect(blocks[1]).toEqual({ kind: "single", index: 4, seg: segs[4] })
  })

  it("单个思考或单个工具块不折叠", () => {
    const segs = [thinking(), reply(), tools("read"), reply()]
    expect(groupSegments(segs).map((b) => b.kind)).toEqual(["single", "single", "single", "single"])
  })

  it("回复和任务清单把前后的过程隔成不同的组", () => {
    const segs = [thinking(), tools("read"), reply("中间说明"), tools("grep"), thinking(), todos(), tools("shell")]
    const blocks = groupSegments(segs)
    expect(blocks.map((b) => b.kind)).toEqual(["group", "single", "group", "single", "single"])
    const second = blocks[2]
    expect(second.kind === "group" && second.start).toBe(3)
    expect(blocks[3]).toMatchObject({ kind: "single", index: 5 })
    expect(blocks[4]).toMatchObject({ kind: "single", index: 6 })
  })

  it("回合进行中追加分段，已有的组起点不变（组件靠它保持展开状态）", () => {
    const base = [thinking(), tools("read")]
    const before = groupSegments(base)[0]
    const after = groupSegments([...base, thinking(), tools("grep")])[0]
    expect(before.kind === "group" && before.start).toBe(0)
    expect(after.kind === "group" && after.start).toBe(0)
    expect(after.kind === "group" && after.segs).toHaveLength(4)
  })

  it("单个分段在追加后升级为组时，原来的分段并入组里", () => {
    expect(groupSegments([thinking()]).map((b) => b.kind)).toEqual(["single"])
    expect(groupSegments([thinking(), tools("read")]).map((b) => b.kind)).toEqual(["group"])
  })
})

describe("summarizeGroup", () => {
  const run = (...segs: AppChatSegment[]) => segs as ProcessSegment[]

  it("统计思考次数、工具调用次数和失败数", () => {
    const s = summarizeGroup(run(
      thinking(),
      { type: "tools", tools: [{ name: "read", status: "done" }, { name: "grep", status: "error" }] },
      thinking(),
      tools("shell"),
    ))
    expect(s).toMatchObject({ thinkings: 2, toolCalls: 3, failed: 1 })
  })

  it("最后一条操作取最后一次工具调用，哪怕后面还跟着思考", () => {
    const s = summarizeGroup(run(tools("read", "grep"), thinking(500), tools("glob"), thinking(800)))
    expect(s.lastTool?.name).toBe("glob")
    expect(s.endsWithThinking).toBe(true)
  })

  it("同一个工具块里有多项调用时取最后一项", () => {
    const s = summarizeGroup(run(thinking(), tools("read", "grep")))
    expect(s.lastTool?.name).toBe("grep")
    expect(s.endsWithThinking).toBe(false)
  })

  it("只有思考时没有工具，记下最后一段思考的耗时", () => {
    const s = summarizeGroup(run(thinking(1200), thinking(3400)))
    expect(s.lastTool).toBeUndefined()
    expect(s.lastThinkingMs).toBe(3400)
    expect(s.toolCalls).toBe(0)
  })

  it("空的工具块不会产生最后一条操作", () => {
    const s = summarizeGroup(run(thinking(), { type: "tools", tools: [] }))
    expect(s.lastTool).toBeUndefined()
    expect(s.toolCalls).toBe(0)
  })
})
