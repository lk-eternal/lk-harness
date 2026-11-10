/**
 * 端到端（真实 daemon 进程 + 真实 HTTP 接口）：历史分页与手机端取文件前的归属校验。
 *
 * 打开会话只拉最近一页、点「加载更早」再往前翻，是桌面端和手机端共用的接口约定；
 * 老版本手机 App 不带 limit，必须仍拿到整段历史；请求体来自界面和手机，不能信。
 *
 * 用 `npm run test:e2e` 运行；不在默认的 `npm test` 里。
 */
import * as fs from "node:fs"
import * as path from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { startIsolatedDaemon, sleep, type ChatItem, type IsolatedDaemon } from "../helpers/isolated-daemon"

let d: IsolatedDaemon

beforeEach(async () => { d = await startIsolatedDaemon() })
afterEach(async () => { await d?.stop() })

const TOTAL = 45

async function seed(): Promise<void> {
  for (let i = 1; i <= TOTAL; i++) {
    expect((await d.post("/api/app-chat/send", { sessionKey: d.sessionKey, text: `消息 ${i}` })).ok).toBe(true)
    await sleep(3) // 记录按时间戳排序，错开毫秒
  }
}
const page = (query: Record<string, unknown>) => d.post("/api/app-chat/history", { sessionKey: d.sessionKey, ...query }) as Promise<{
  ok: boolean; items: ChatItem[]; hasMore?: boolean
}>
const texts = (items: ChatItem[]) => items.map((i) => i.text)

describe("/api/app-chat/history：分页", () => {
  it("不带 limit：整段历史（老版本手机 App 的请求），没有更早的", async () => {
    await seed()
    const r = await page({})
    expect(r.items).toHaveLength(TOTAL)
    expect(r.hasMore).toBe(false)
  })

  it("带 limit：最近一页，并告知前面还有更早的；顺序不变", async () => {
    await seed()
    const r = await page({ limit: 30 })
    expect(r.ok).toBe(true)
    expect(r.items).toHaveLength(30)
    expect(r.items[0].text).toBe("消息 16")
    expect(r.items.at(-1)?.text).toBe(`消息 ${TOTAL}`)
    expect(r.hasMore).toBe(true)
  })

  it("用本页第一条当游标往前翻：接上前一页，翻完 hasMore 变 false，拼起来正好是整段历史", async () => {
    await seed()
    const first = await page({ limit: 30 })
    const cursor = first.items[0]
    const second = await page({ limit: 30, beforeId: cursor.id, beforeTs: cursor.ts })
    expect(second.items).toHaveLength(15)
    expect(second.items.at(-1)?.text).toBe("消息 15")
    expect(second.hasMore).toBe(false)
    expect(texts([...second.items, ...first.items])).toEqual(texts((await page({})).items))
  })

  it("游标那条被移除了（id 找不到）：按时间戳定位，不丢也不重", async () => {
    await seed()
    const first = await page({ limit: 30 })
    const cursor = first.items[0]
    const second = await page({ limit: 30, beforeId: "已经不存在的id", beforeTs: cursor.ts })
    expect(second.items.at(-1)?.text).toBe("消息 15")
    expect(second.items).toHaveLength(15)
  })

  it("请求体不可信：limit 不是正整数、类型不对都当没给（整段），过大的 limit 被截到上限", async () => {
    await seed()
    for (const bad of [{ limit: "30" }, { limit: 0 }, { limit: -5 }, { limit: null }, { beforeTs: "abc" }]) {
      const r = await page(bad)
      expect(r.items, JSON.stringify(bad)).toHaveLength(TOTAL)
    }
    expect((await page({ limit: 1e9 })).items).toHaveLength(TOTAL) // 上限 200，会话只有 45 条
  })
})

describe("/api/app-chat/references-path：手机端取图片/文件前的归属校验", () => {
  it("会话记录里出现过的路径算，没出现过的不算，别的会话不算", async () => {
    const img = path.join(d.wsDir, "shot.png")
    fs.writeFileSync(img, "png")
    const other = path.join(d.wsDir, "other.png")
    fs.writeFileSync(other, "png")
    await d.post("/api/app-chat/send", { sessionKey: d.sessionKey, text: "看图", images: [img] })

    const owns = async (p: string, sessionKey = d.sessionKey) =>
      ((await d.post("/api/app-chat/references-path", { sessionKey, path: p })) as { ok: boolean; owned?: boolean })
    expect(await owns(img)).toEqual({ ok: true, owned: true })
    expect(await owns(other)).toEqual({ ok: true, owned: false })
    expect((await owns(img, "不属于应用内对话的会话键")).ok).toBe(false)
    expect(await owns("")).toEqual({ ok: true, owned: false })
  })
})
