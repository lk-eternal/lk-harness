/**
 * 端到端（真实 daemon 进程 + 真实 HTTP 接口）：poll-message 的空返回协议。
 *
 * Agent 本身不 poll（协议里没有 poll，由宿主 Session Worker 代管），所以响应里只有机器可读的 reason：
 * 按需唤醒（keepAlive=false）且队列已空 → reason=end，worker 据此退出；有消息时没有 reason。
 * 没有写给模型看的 directive 文案。
 *
 * 用 `npm run test:e2e` 运行；不在默认的 `npm test` 里。
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { startIsolatedDaemon, waitFor, type IsolatedDaemon } from "../helpers/isolated-daemon"

let d: IsolatedDaemon

beforeEach(async () => { d = await startIsolatedDaemon() })
afterEach(async () => { await d?.stop() })

/** 模拟宿主 worker 的阻塞 poll */
const blockingPoll = async (): Promise<Record<string, unknown>> =>
  (await fetch(`${d.base}/api/poll-message?sessionKey=${encodeURIComponent(d.sessionKey)}`)).json() as Promise<Record<string, unknown>>

/** 切到按需唤醒（主用户会话的 keepAlive 默认为开） */
const useOnDemandWake = () => d.post("/api/channel-flags", { channels: [{ id: "ch_test", keepAliveMain: false }] })

/** 订阅 SSE，收集 poll-phase 事件（daemon-manager 就是靠它同步流式卡状态） */
async function collectPollPhaseEvents(): Promise<{ events: Array<Record<string, any>>; close: () => void }> {
  const ctrl = new AbortController()
  const res = await fetch(`${d.base}/api/queue-events`, { signal: ctrl.signal })
  const events: Array<Record<string, any>> = []
  const reader = res.body!.getReader()
  const dec = new TextDecoder()
  let buf = ""
  void (async () => {
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) return
        buf += dec.decode(value, { stream: true })
        const frames = buf.split("\n\n")
        buf = frames.pop() ?? ""
        for (const f of frames) {
          const line = f.split("\n").find((l) => l.startsWith("data:"))
          if (!line) continue
          try {
            const ev = JSON.parse(line.slice(5).trim())
            if (ev.type === "poll-phase") events.push(ev)
          } catch { /* 非 JSON 帧 */ }
        }
      }
    } catch { /* 连接被主动关闭 */ }
  })()
  return { events, close: () => ctrl.abort() }
}

describe("blocking poll 空返回", () => {
  it("按需唤醒且队列为空：立即返回 reason=end，响应里没有 directive 文案", async () => {
    expect((await d.post("/api/app-chat/send", { sessionKey: d.sessionKey, text: "开始" })).ok).toBe(true)
    expect(((await d.poll()).messages ?? []).map((m) => m.text)).toEqual(["开始"])
    await d.post("/api/confirm-claimed", { session_key: d.sessionKey })
    await useOnDemandWake()

    const r = await blockingPoll()

    expect(r).toEqual({ messages: [], reason: "end" })
    expect(r).not.toHaveProperty("directive")
  })

  it("按需唤醒但挂 poll 时队列里还有消息：照常返回消息，不带 reason", async () => {
    expect((await d.post("/api/app-chat/send", { sessionKey: d.sessionKey, text: "还有一条" })).ok).toBe(true)
    await useOnDemandWake()

    const r = await blockingPoll() as { messages?: Array<{ text: string }>; reason?: string }

    expect((r.messages ?? []).map((m) => m.text)).toEqual(["还有一条"])
    expect(r).not.toHaveProperty("reason")
    expect(r).not.toHaveProperty("directive")
  })

  it("SSE 的 poll-phase end 事件带同一个 reason，不再带 directive", async () => {
    expect((await d.post("/api/app-chat/send", { sessionKey: d.sessionKey, text: "开始" })).ok).toBe(true)
    await d.poll()
    await d.post("/api/confirm-claimed", { session_key: d.sessionKey })
    await useOnDemandWake()
    const sse = await collectPollPhaseEvents()
    try {
      await blockingPoll()
      expect(await waitFor(() => sse.events.some((e) => e.phase === "end" && e.blocking === true))).toBe(true)
      const end = sse.events.find((e) => e.phase === "end" && e.blocking === true)!
      expect(end).toMatchObject({ sessionKey: d.sessionKey, reason: "end", messageIds: [] })
      expect(end).not.toHaveProperty("directive")
    } finally {
      sse.close()
    }
  })
})
