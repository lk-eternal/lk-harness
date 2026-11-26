/**
 * 端到端（真实 daemon 进程 + 真实 HTTP 接口）：交给 Agent、但聊天里没有对应记录的消息。
 *
 * 线上的问题：定时任务结果、项目步骤这类消息不是用户在界面发的，直接进了会话队列，
 * Agent 照常处理，聊天流里却没有任何触发它的记录，看起来像 Agent 突然开口。
 * 正确的行为是：交给 Agent 的那一刻，聊天里还没有这条记录的，补一条带折叠全文的提示。
 *
 * 用 `npm run test:e2e` 运行；不在默认的 `npm test` 里。
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { startIsolatedDaemon, type ChatItem, type IsolatedDaemon } from "../helpers/isolated-daemon"

let d: IsolatedDaemon

beforeEach(async () => { d = await startIsolatedDaemon() })
afterEach(async () => { await d?.stop() })

const STEP_PROMPT = "[PROJECT_ACTION] 开发步骤\n来源：应用内步骤条。\n\n本步骤要求:\n- 先读代码再动手\n- 磁盘占用要检查"

/** 和应用「点步骤条」一样的直投：往会话队列投一条没有聊天记录的消息 */
const enqueueSystem = (messageId: string, content: string) =>
  d.post("/enqueue", { content, sessionKey: d.sessionKey, chatType: "project", messageId })

const notices = async (): Promise<ChatItem[]> => (await d.history()).filter((i) => i.kind === "notice")

describe("投递时补记录", () => {
  it("领取之前聊天里什么都没有；领取之后多一条提示：标题是第一行，全文折叠着", async () => {
    expect((await enqueueSystem("internal_enqueue_step_1", STEP_PROMPT)).ok).toBe(true)
    expect(await notices()).toEqual([])

    expect(((await d.poll()).messages ?? []).map((m) => m.text)).toEqual([STEP_PROMPT])

    const [notice, ...rest] = await notices()
    expect(rest).toEqual([])
    expect(notice).toMatchObject({ id: "internal_enqueue_step_1", kind: "notice", text: "[PROJECT_ACTION] 开发步骤", detail: "来源：应用内步骤条。\n\n本步骤要求:\n- 先读代码再动手\n- 磁盘占用要检查" })
  })

  it("同一条再领取一次（重投）：仍然只有一条提示", async () => {
    await enqueueSystem("internal_enqueue_step_1", STEP_PROMPT)
    await d.poll()
    await d.poll()
    expect(await notices()).toHaveLength(1)
  })

  it("用户在界面发的消息本来就有记录：领取后聊天里还是只有那一条，没有多出提示", async () => {
    expect((await d.post("/api/app-chat/send", { sessionKey: d.sessionKey, text: "你好" })).ok).toBe(true)
    expect(((await d.poll()).messages ?? []).map((m) => m.text)).toEqual(["你好"])

    const items = await d.history()
    expect(items.map((i) => i.kind)).toEqual(["user"])
    expect(items[0].text).toBe("你好")
  })

  it("一批里同时有用户的消息和系统消息：只给系统消息补", async () => {
    await d.post("/api/app-chat/send", { sessionKey: d.sessionKey, text: "用户的话" })
    await enqueueSystem("internal_enqueue_step_2", "定时任务触发\n\n去检查一下")
    const texts = ((await d.poll()).messages ?? []).map((m) => m.text)
    expect(texts).toHaveLength(2)

    const items = await d.history()
    expect(items.map((i) => i.kind).sort()).toEqual(["notice", "user"])
    expect(items.find((i) => i.kind === "notice")).toMatchObject({ id: "internal_enqueue_step_2", text: "定时任务触发" })
  })
})

describe("点选答案的投递不补记录：答案已经在问题卡上", () => {
  it("选完交给 Agent 之后，聊天里只有问题卡，没有提示条", async () => {
    // 真实流程：用户先发消息、Agent 领取并开始输出，之后才会提问
    await d.post("/api/app-chat/send", { sessionKey: d.sessionKey, text: "开始" })
    await d.poll()
    await d.card("ensure")
    await d.post("/api/confirm-claimed", { session_key: d.sessionKey })

    const asked = await d.post("/api/send-question", { text: "用哪个库？", options: ["A", "B"], session_key: d.sessionKey })
    expect(asked.ok, JSON.stringify(asked)).toBe(true)
    expect((await d.post("/api/app-chat/send", { sessionKey: d.sessionKey, questionId: asked.message_id, option: "B" })).ok).toBe(true)

    const delivered = ((await d.waitPoll()).messages ?? []).map((m) => m.text)
    expect(delivered).toEqual(["问题 1：用哪个库？\n回答：B"])
    expect(await notices()).toEqual([])
  })
})

describe("搜索", () => {
  it("提示条折叠着的全文也能搜到，命中类型是 notice", async () => {
    await enqueueSystem("internal_enqueue_step_1", STEP_PROMPT)
    await d.poll()

    const r = await d.post("/api/app-chat/search", { sessionKey: d.sessionKey, query: "磁盘占用" }) as { ok: boolean; hits?: Array<{ id: string; kind: string }> }
    expect(r.ok).toBe(true)
    expect(r.hits).toMatchObject([{ id: "internal_enqueue_step_1", kind: "notice" }])
  })
})
