/**
 * 端到端（真实 daemon 进程 + 真实 HTTP 接口）：暂存区的排队、编辑、撤回、投递，聊天流顺序，删除会话后的路由落盘。
 *
 * 这些行为横跨 daemon、文件队列和聊天记录三处，单测只能分别覆盖；这里把几次线上问题的时间线原样复现：
 * - 「可以吗?」没进暂存区：Agent 已领取、回合卡还没出现的空窗里发消息
 * - 排队的 1–10 被上一回合的回复夹在中间：回合卡晚于排队消息才创建
 * - 删除会话后又变成「新会话」：purge 返回时路由还没落盘
 *
 * 用 `npm run test:e2e` 运行；不在默认的 `npm test` 里，避免起进程的测试拖慢单测、也不拦发版。
 */
import * as fs from "node:fs"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { startIsolatedDaemon, waitFor, sleep, type ChatItem, type IsolatedDaemon } from "../helpers/isolated-daemon"

let d: IsolatedDaemon

beforeEach(async () => { d = await startIsolatedDaemon() })
afterEach(async () => { await d?.stop() })

/** 一行描述聊天记录顺序：用户消息写正文，回合卡写 [卡:首段回复]，排队中的加 ? */
const shape = (items: ChatItem[]) => items.map((i) =>
  i.kind === "user" ? `${i.text}${i.queued ? "?" : ""}`
    : i.kind === "assistant" ? `[卡:${i.segments?.find((s) => s.type === "reply")?.text ?? ""}${i.interrupted ? "/断" : ""}]`
      : i.kind,
).join(" | ")

describe("暂存区：排队 / 编辑 / 撤回 / 投递", () => {
  it("空闲时不排队；回合进行中排队；指令不排队", async () => {
    expect((await d.post("/api/app-chat/send", { sessionKey: d.sessionKey, text: "第一条" })).ok).toBe(true)
    expect(await d.queuedOf()).toEqual([])

    const got = (await d.poll()).messages
    expect(got?.map((m) => m.text)).toEqual(["第一条"])
    const card = await d.card("ensure")
    expect(card.ok).toBe(true)
    expect(card.cardId).toBeTruthy()

    await d.post("/api/app-chat/send", { sessionKey: d.sessionKey, text: "插话A" })
    await d.post("/api/app-chat/send", { sessionKey: d.sessionKey, text: "插话B" })
    expect(await d.queuedOf()).toEqual(["插话A", "插话B"])

    await d.post("/api/app-chat/send", { sessionKey: d.sessionKey, text: "/s" })
    expect(await d.queuedOf()).not.toContain("/s")
  })

  it("编辑、撤回；投递的是改过的文本；已投递的撤不回、改不了", async () => {
    await d.post("/api/app-chat/send", { sessionKey: d.sessionKey, text: "第一条" })
    await d.poll()
    await d.card("ensure")
    await d.post("/api/app-chat/send", { sessionKey: d.sessionKey, text: "插话A" })
    await d.post("/api/app-chat/send", { sessionKey: d.sessionKey, text: "插话B" })
    const [a, b] = (await d.users()).filter((i) => i.queued)

    expect((await d.post("/api/app-chat/queue-edit", { sessionKey: d.sessionKey, messageId: a.id, text: "插话A（改过）" })).ok).toBe(true)
    expect((await d.queuedOf())[0]).toBe("插话A（改过）")
    expect((await d.post("/api/app-chat/queue-edit", { sessionKey: d.sessionKey, messageId: a.id, text: "   " })).ok).toBe(false)

    expect((await d.post("/api/app-chat/queue-remove", { sessionKey: d.sessionKey, messageId: b.id })).ok).toBe(true)
    expect(await d.queuedOf()).toEqual(["插话A（改过）"])
    expect((await d.users()).some((i) => i.id === b.id)).toBe(false)
    expect((await d.post("/api/app-chat/queue-remove", { sessionKey: d.sessionKey, messageId: b.id })).ok).toBe(false)

    const texts = ((await d.poll()).messages ?? []).map((m) => m.text)
    expect(texts).toContain("插话A（改过）")
    expect(texts).not.toContain("插话B")
    expect(await d.queuedOf()).toEqual([])
    const delivered = (await d.users()).find((u) => u.text === "插话A（改过）")
    expect(delivered).toBeTruthy()

    expect((await d.post("/api/app-chat/queue-remove", { sessionKey: d.sessionKey, messageId: delivered!.id })).ok).toBe(false)
    expect((await d.post("/api/app-chat/queue-edit", { sessionKey: d.sessionKey, messageId: delivered!.id, text: "想改" })).ok).toBe(false)
  })

  it("清空队列时暂存区同步清掉；队列文件被外部删掉后读历史不再标记为排队", async () => {
    await d.post("/api/app-chat/send", { sessionKey: d.sessionKey, text: "第一条" })
    await d.poll()
    await d.card("ensure")

    await d.post("/api/app-chat/send", { sessionKey: d.sessionKey, text: "插话C" })
    await d.post("/api/app-chat/send", { sessionKey: d.sessionKey, text: "插话D" })
    expect(await d.queuedOf()).toHaveLength(2)
    const q = await d.get("/queue")
    for (const m of q.messages.filter((m: { status: string }) => m.status === "pending")) await d.post("/queue-delete", { fileId: m.fileId })
    expect(await d.queuedOf()).toEqual([])
    expect((await d.users()).some((u) => u.text === "插话C" || u.text === "插话D")).toBe(false)

    // 对账：标着排队但队列里没有了（模拟异常）→ 当作已投递
    await d.post("/api/app-chat/send", { sessionKey: d.sessionKey, text: "插话E" })
    const e = (await d.users()).find((u) => u.text === "插话E")!
    const fid = (await d.get("/queue")).messages.find((m: { messageId: string }) => m.messageId === e.id)?.fileId as string
    expect(fid).toBeTruthy()
    const file = d.findFile(new RegExp(`^${fid.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`))
    expect(file).not.toBe("")
    fs.unlinkSync(file)
    expect(await d.queuedOf()).toEqual([])
  })

  it("Agent 已领取、回合卡还没出现的空窗里发的消息也进暂存区，数量和全局队列一致", async () => {
    await d.post("/api/app-chat/send", { sessionKey: d.sessionKey, text: "第一条" })
    expect(await d.queuedOf()).toEqual([])
    expect((await d.poll()).messages).toHaveLength(1)

    // 回合卡还没出现
    await d.post("/api/app-chat/send", { sessionKey: d.sessionKey, text: "第二条" })
    expect(await d.queuedOf()).toEqual(["第二条"])

    expect((await d.card("ensure")).ok).toBe(true)
    await d.post("/api/app-chat/send", { sessionKey: d.sessionKey, text: "第三条" })
    expect(await d.queuedOf()).toEqual(["第二条", "第三条"])
    const pending = (await d.get("/queue")).messages.filter((m: { status: string }) => m.status === "pending")
    expect(pending).toHaveLength(2)

    const next = ((await d.poll()).messages ?? []).map((m) => m.text)
    expect(next).toEqual(expect.arrayContaining(["第二条", "第三条"]))
    expect(await d.queuedOf()).toEqual([])
    expect(await d.users()).toHaveLength(3)

    // Agent 收口并确认处理完 → 空闲，新消息不再排队
    await d.post("/api/agent-stream-card", { session_key: d.sessionKey, action: "finish", segments: [{ type: "reply", text: "完" }] })
    await d.post("/api/confirm-claimed", { session_key: d.sessionKey })
    await d.post("/api/app-chat/send", { sessionKey: d.sessionKey, text: "第四条" })
    expect(await d.queuedOf()).toEqual([])
  })
})

describe("聊天流顺序", () => {
  it("连发 1–10 后立即发送：被打断的回复在 1–10 之前，新回合的回复在它们之后", async () => {
    await d.post("/api/app-chat/send", { sessionKey: d.sessionKey, text: "P" })
    expect((await d.poll()).messages).toHaveLength(1)

    // 回合卡还不存在时连发 1–9；时间戳要有先后，所以隔一小会儿
    for (let i = 1; i <= 9; i++) { await d.post("/api/app-chat/send", { sessionKey: d.sessionKey, text: String(i) }); await sleep(15) }
    await d.card("ensure", { segments: [{ type: "reply", text: "收到" }] })
    await sleep(15)
    await d.post("/api/app-chat/send", { sessionKey: d.sessionKey, text: "10" })

    expect(shape(await d.history())).toBe("P | [卡:收到] | 1? | 2? | 3? | 4? | 5? | 6? | 7? | 8? | 9? | 10?")

    // 立即发送：回合被打断收口，排队消息被新 Agent 领走，新回合开始输出
    await d.card("finish", { segments: [{ type: "reply", text: "收到" }], interrupted: true })
    await d.post("/api/confirm-claimed", { session_key: d.sessionKey })
    expect(((await d.poll()).messages ?? [])).toHaveLength(10)
    await sleep(15)
    await d.card("ensure", { segments: [{ type: "reply", text: "新回合" }] })

    expect(shape(await d.history())).toBe("P | [卡:收到/断] | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | [卡:新回合]")

    // 聊天记录会落盘
    expect(await waitFor(() => d.findFile(/\.jsonl$/) !== "")).toBe(true)
  })
})

describe("删除会话", () => {
  it("purge 返回后 routing 文件立即不含该会话（不是防抖之后）", async () => {
    await d.post("/api/app-chat/send", { sessionKey: d.sessionKey, text: "hi" })
    // 路由文件由防抖落盘，等它出现并登记了该会话
    const has = () => {
      const rp = d.findFile(/^routing.*\.json$/)
      return !!rp && fs.readFileSync(rp, "utf8").includes("ws-a")
    }
    expect(await waitFor(has, 8000)).toBe(true)

    await d.post("/api/purge-session-routing", { sessionKey: d.sessionKey })
    expect(has()).toBe(false)
  })
})
