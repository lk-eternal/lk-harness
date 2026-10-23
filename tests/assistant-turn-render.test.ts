import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"
import type { AppChatAssistantItem, AppChatSegment } from "../src/shared/app-chat-types"
import AssistantTurn from "../src/renderer/components/chat/AssistantTurn"

const base: AppChatAssistantItem = { id: "a1", kind: "assistant", ts: 1_700_000_000_000, segments: [], finished: true }

const render = (segments: AppChatSegment[], finished = true) =>
  renderToStaticMarkup(createElement(AssistantTurn, { item: { ...base, segments, finished } }))

const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim()

/** 一长串思考/工具交替，和用户截图里的场景一致 */
const longRun = (): AppChatSegment[] => {
  const segs: AppChatSegment[] = []
  for (let i = 0; i < 6; i++) {
    segs.push({ type: "thinking", text: `想法 ${i}`, ms: 1000 + i })
    segs.push({ type: "tools", tools: [{ name: "read", status: "done", summary: `file-${i}.ts` }] })
  }
  return segs
}

describe("AssistantTurn 折叠", () => {
  it("连续的思考和工具折成一行，只显示最后一条操作", () => {
    const html = render(longRun())
    expect(html.match(/<button/g)).toHaveLength(1)
    const t = text(html)
    expect(t).toContain("思考 6 · 工具 6")
    expect(t).toContain("file-5.ts")
    expect(t).not.toContain("file-4.ts")
    expect(t).not.toContain("想法")
  })

  it("回合进行中同样折叠；最后是思考时显示思考中", () => {
    const segs = [...longRun(), { type: "thinking", text: "正在想", ms: undefined } as AppChatSegment]
    const t = text(render(segs, false))
    expect(t).toContain("思考 7 · 工具 6")
    expect(t).toContain("思考中…")
    expect(t).not.toContain("正在想")
  })

  it("回合进行中最后是工具时，显示这个工具", () => {
    const segs: AppChatSegment[] = [...longRun(), { type: "tools", tools: [{ name: "grep", status: "running", summary: "TODO" }] }]
    const t = text(render(segs, false))
    expect(t).toContain("grep")
    expect(t).toContain("TODO")
  })

  it("有失败的工具时折叠行上标出失败数", () => {
    const segs: AppChatSegment[] = [
      { type: "thinking", text: "x", ms: 10 },
      { type: "tools", tools: [{ name: "shell", status: "error", summary: "npm test" }] },
    ]
    expect(text(render(segs))).toContain("1 失败")
  })

  it("回复前后的过程分别折叠，回复原样显示", () => {
    const segs: AppChatSegment[] = [
      { type: "thinking", text: "a", ms: 10 },
      { type: "tools", tools: [{ name: "read", status: "done" }] },
      { type: "reply", text: "中间结论" },
      { type: "thinking", text: "b", ms: 10 },
      { type: "tools", tools: [{ name: "grep", status: "done" }] },
    ]
    const t = text(render(segs))
    expect(t.match(/思考 1 · 工具 1/g)).toHaveLength(2)
    expect(t).toContain("中间结论")
  })

  it("单个思考块保持原来的样子", () => {
    const html = render([{ type: "thinking", text: "只有一块", ms: 500 }])
    expect(text(html)).toContain("思考 500ms")
    expect(text(html)).not.toContain("思考 1")
  })

  it("已结束的回合里停在 running 的工具不再转圈", () => {
    const segs: AppChatSegment[] = [
      { type: "thinking", text: "a", ms: 10 },
      { type: "tools", tools: [{ name: "shell", status: "running", summary: "sleep 99" }] },
    ]
    expect(render(segs, true)).not.toContain("animate-spin")
  })
})
