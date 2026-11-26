/**
 * 端到端（真实 daemon 进程 + 真实 HTTP 接口）：回合中发给应用内的文字，并进回合卡它发出时的位置。
 *
 * 飞书里这类文字（带会话的 send-text）并进流式卡；应用内以前是排在会话末尾的独立文本记录，现在和飞书一致。
 * 只带 message_id、不带会话的（失败提示等）仍是独立记录。
 *
 * 用 `npm run test:e2e` 运行；不在默认的 `npm test` 里。
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { startIsolatedDaemon, type IsolatedDaemon } from "../helpers/isolated-daemon"

let d: IsolatedDaemon

beforeEach(async () => {
  d = await startIsolatedDaemon()
  // 发送接口只认已经注册过的会话：真实使用里总是用户先说了话
  await d.post("/api/app-chat/send", { sessionKey: d.sessionKey, text: "开始" })
  await d.poll()
})
afterEach(async () => { await d?.stop() })

const turnSegments = async () => (await d.history()).find((i) => i.kind === "assistant")?.segments
const textItems = async () => (await d.history()).filter((i) => i.kind === "text")

describe("回合中的 send-text", () => {
  it("有回合卡：并进卡里发出时的位置，成为一段回复；后续流式更新不会冲掉", async () => {
    await d.card("ensure")
    const r = await d.post("/api/send-text", { text: "先说一句", session_key: d.sessionKey })
    expect(r.ok).toBe(true)
    expect(await turnSegments()).toEqual([{ type: "reply", text: "处理中" }, { type: "reply", text: "先说一句" }])
    expect(await textItems()).toEqual([])

    await d.card("update", { segments: [{ type: "reply", text: "处理中" }, { type: "reply", text: "接着说" }] })
    expect(await turnSegments()).toEqual([
      { type: "reply", text: "处理中" },
      { type: "reply", text: "先说一句" },
      { type: "reply", text: "接着说" },
    ])
  })

  it("没有回合卡：仍是独立文本记录", async () => {
    const r = await d.post("/api/send-text", { text: "没人在干活", session_key: d.sessionKey })
    expect(r.ok).toBe(true)
    expect(await turnSegments()).toBeUndefined()
    expect((await textItems()).map((i) => i.text)).toEqual(["没人在干活"])
  })
})
