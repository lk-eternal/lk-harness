/**
 * 端到端（真实 daemon 进程 + 真实 HTTP 接口）：在会话历史里搜索，并把命中取回来。
 *
 * 界面只加载最近一页，更早的记录在 daemon 里：搜索在 daemon 端对完整历史做，
 * 命中的 id 再交给历史接口的 reachId，一次取到那条旧记录。
 *
 * 用 `npm run test:e2e` 运行；不在默认的 `npm test` 里。
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { startIsolatedDaemon, sleep, type ChatItem, type IsolatedDaemon } from "../helpers/isolated-daemon"

let d: IsolatedDaemon

beforeEach(async () => { d = await startIsolatedDaemon() })
afterEach(async () => { await d?.stop() })

const TOTAL = 45

async function seed(): Promise<void> {
  for (let i = 1; i <= TOTAL; i++) {
    expect((await d.post("/api/app-chat/send", { sessionKey: d.sessionKey, text: i === 3 ? "最早提到的 苹果 在这里" : `消息 ${i}` })).ok).toBe(true)
    await sleep(3) // 记录按时间戳排序，错开毫秒
  }
}

interface Hit { id: string; ts: number; kind: string; snippet: string }
const search = (query: unknown, sessionKey = d.sessionKey) => d.post("/api/app-chat/search", { sessionKey, query }) as Promise<{
  ok: boolean; hits?: Hit[]; capped?: boolean
}>
const page = (query: Record<string, unknown>) => d.post("/api/app-chat/history", { sessionKey: d.sessionKey, ...query }) as Promise<{
  ok: boolean; items: ChatItem[]; hasMore?: boolean
}>

describe("/api/app-chat/search：在完整历史里搜", () => {
  it("命中最新的在前，带 id、时间、类型和片段；空格隔开的词都要命中", async () => {
    await seed()
    const r = await search("消息 4") // 「消息」和「4」两个词：含数字 4 的消息都算
    expect(r.ok).toBe(true)
    expect(r.capped).toBe(false)
    expect(r.hits?.map((h) => h.snippet)).toEqual([
      "消息 45", "消息 44", "消息 43", "消息 42", "消息 41", "消息 40", "消息 34", "消息 24", "消息 14", "消息 4",
    ])
    expect(r.hits?.every((h) => h.kind === "user" && h.id && h.ts > 0)).toBe(true)
  })

  it("能搜到界面没加载的旧记录：最近一页之外的也在结果里", async () => {
    await seed()
    const loaded = (await page({ limit: 30 })).items
    expect(loaded.some((i) => i.text?.includes("苹果"))).toBe(false)
    const r = await search("苹果")
    expect(r.hits).toHaveLength(1)
    expect(r.hits?.[0].snippet).toBe("最早提到的 苹果 在这里")
  })

  it("命中的 id 交给历史接口的 reachId：一次取到那条旧记录，接在已加载的一段前面", async () => {
    await seed()
    const first = await page({ limit: 10 })
    const cursor = first.items[0]
    const hit = (await search("苹果")).hits![0]

    const reached = await page({ limit: 10, beforeId: cursor.id, beforeTs: cursor.ts, reachId: hit.id })
    expect(reached.items[0].id).toBe(hit.id)
    expect(reached.items.at(-1)?.text).toBe("消息 35") // 游标是消息 36，不含游标本身
    expect(reached.hasMore).toBe(true) // 苹果前面还有消息 1、2
    expect([...reached.items, ...first.items].map((i) => i.id)).toEqual((await page({})).items.slice(2).map((i) => i.id))
  })

  it("空查询、不是字符串的查询：没有命中，不报错", async () => {
    await seed()
    for (const bad of ["", "   ", 5, null, undefined, { x: 1 }]) {
      const r = await search(bad)
      expect(r.ok, JSON.stringify(bad)).toBe(true)
      expect(r.hits, JSON.stringify(bad)).toEqual([])
    }
  })

  it("会话不属于应用内对话通道：拒绝，不回落到别的会话去搜", async () => {
    await seed()
    const r = await search("苹果", "不属于应用内对话的会话键")
    expect(r.ok).toBe(false)
    expect(r.hits).toBeUndefined()
  })
})
