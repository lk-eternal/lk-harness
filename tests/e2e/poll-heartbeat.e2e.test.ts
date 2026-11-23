/**
 * 端到端（真实 daemon 进程 + 真实 HTTP 接口）：阻塞 poll 到点空返回（reason=timeout）后宿主续挂的整条路径。
 *
 * 常驻会话的 worker 挂一个等消息的长请求；daemon 必须在宿主请求库的 300 秒上限之前以 timeout 空返回，
 * worker 再续挂。这条路径此前没有真实跑过（旧的挂起时长 25 分钟，请求库 5 分钟就先掐断了）。
 * 这里把挂起时长缩到 500 毫秒，用真实 daemon 把「到点空返回 → 续挂 → 来消息照常投递、不丢不重」跑一遍。
 *
 * 用 `npm run test:e2e` 运行；不在默认的 `npm test` 里。
 */
import * as fs from "node:fs"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { sleep, startIsolatedDaemon, type IsolatedDaemon } from "../helpers/isolated-daemon"

let d: IsolatedDaemon

beforeEach(async () => {
  d = await startIsolatedDaemon({ env: { LARK_POLL_BLOCK_TIMEOUT_MS: "500" } })
})
afterEach(async () => { await d?.stop() })

type PollResult = { messages?: Array<{ text: string }>; reason?: string }

/** 模拟宿主 worker 的阻塞 poll */
const blockingPoll = async (): Promise<PollResult> =>
  (await fetch(`${d.base}/api/poll-message?sessionKey=${encodeURIComponent(d.sessionKey)}`)).json() as Promise<PollResult>

/** 模拟 worker 处理完一批消息后的确认（宿主在回合结束时调） */
const confirmDone = () => d.post("/api/confirm-claimed", { session_key: d.sessionKey })

describe("blocking poll 挂起到点", () => {
  it("没有消息：挂满设定时长后空返回 reason=timeout（不是 end，worker 据此续挂）", async () => {
    const t0 = Date.now()

    const r = await blockingPoll()

    expect(r).toEqual({ messages: [], reason: "timeout" })
    expect(Date.now() - t0).toBeGreaterThanOrEqual(450)
  })

  it("续挂：到点空返回后一直续挂，之后来的消息只投递一次，投递后再续挂只有空返回（不重投）", async () => {
    const beats: PollResult[] = []
    const worker = (async (): Promise<PollResult> => {
      for (;;) {
        const r = await blockingPoll()
        if (r.messages?.length) return r
        beats.push(r)
      }
    })()

    await sleep(1500) // 够挂过至少一次到点
    expect(beats.length).toBeGreaterThanOrEqual(1)
    expect(beats.every((b) => b.reason === "timeout")).toBe(true)

    expect((await d.post("/api/app-chat/send", { sessionKey: d.sessionKey, text: "后来的" })).ok).toBe(true)
    const got = await worker
    expect(got.messages?.map((m) => m.text)).toEqual(["后来的"])
    expect(got).not.toHaveProperty("reason")

    await confirmDone()
    expect(await blockingPoll()).toEqual({ messages: [], reason: "timeout" })
    expect(await blockingPoll()).toEqual({ messages: [], reason: "timeout" })
    expect((await d.users()).filter((u) => u.text === "后来的")).toHaveLength(1)
  })

  it("不丢：到点空返回和下一次续挂之间的空档里来的消息，下一次 poll 立刻拿到", async () => {
    expect(await blockingPoll()).toEqual({ messages: [], reason: "timeout" })
    expect((await d.post("/api/app-chat/send", { sessionKey: d.sessionKey, text: "空档里来的" })).ok).toBe(true)

    const r = await blockingPoll()

    expect(r.messages?.map((m) => m.text)).toEqual(["空档里来的"])
    expect(r).not.toHaveProperty("reason")
  })

  it("到点空返回是心跳，不逐次写 daemon 日志；有消息的投递照常写", async () => {
    await blockingPoll()
    await blockingPoll()
    expect((await d.post("/api/app-chat/send", { sessionKey: d.sessionKey, text: "有日志的" })).ok).toBe(true)
    await blockingPoll()

    const logFile = d.findFile(/^daemon\.log$/)
    const text = fs.readFileSync(logFile, "utf8")
    expect(text).toContain("[Poll→Worker] reason=messages")
    expect(text).not.toContain("[Poll→Worker] reason=timeout")
  })
})
