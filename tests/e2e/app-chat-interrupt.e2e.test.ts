/**
 * 端到端（真实 daemon 进程 + 真实 HTTP 接口）：打断类操作要「立刻上屏」。
 *
 * 两次线上反馈：
 * - 发图片时带 `/f`：没有打断，消息进了暂存区排队（带图就不当指令处理了，图片也没有交给 Agent）
 * - 暂存区点「立即发送」：不像 `/f` 那样直接出现在聊天里，而是转圈圈，要等打断完成、Agent 领走才出现
 *
 * 主进程里 `/f` 的执行（入队 `[打断] …` + 停掉旧 Agent）在 Electron 主进程，这里验证 daemon 这一侧：
 * 消息不进暂存区、指令入了队列且带着图片、「立即发送」把排队的消息放进聊天流。
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

/** 一行描述聊天记录顺序：用户消息写正文，回合卡写 [卡:首段回复]，排队中的加 ? */
const shape = (items: ChatItem[]) => items.map((i) =>
  i.kind === "user" ? `${i.text}${i.queued ? "?" : ""}`
    : i.kind === "assistant" ? `[卡:${i.segments?.find((s) => s.type === "reply")?.text ?? ""}${i.interrupted ? "/断" : ""}]`
      : i.kind,
).join(" | ")

/** 让 Agent「在干活」：它领走了第一条，回合卡已经出现 */
async function makeBusy(): Promise<void> {
  await d.post("/api/app-chat/send", { sessionKey: d.sessionKey, text: "第一条" })
  expect((await d.poll()).messages).toHaveLength(1)
  expect((await d.card("ensure", { segments: [{ type: "reply", text: "收到" }] })).ok).toBe(true)
}

/** 建一张真实存在的图片文件（发送接口会丢掉不存在的路径） */
function makeImage(name: string): string {
  const p = path.join(d.dataDir, name)
  fs.writeFileSync(p, Buffer.from("89504e470d0a1a0a", "hex"))
  return p
}

const marker = (p: string) => `[图片已保存: ${p}]`

/**
 * 发出去之后，记录里（也是交给 Agent 的）图片路径。
 * 发送的那一刻图片被收进会话自己的目录，所以和原文件不是同一个路径（详见 app-chat-images.e2e.test.ts）。
 */
async function imagesOf(messageId: string): Promise<string[]> {
  return (await d.users()).find((u) => u.id === messageId)?.images ?? []
}

async function pendingCommands(): Promise<Array<{ command: string; messageId: string }>> {
  return (await d.get("/commands")).commands ?? []
}

describe("带图片发 /f：照样是指令，不进暂存区排队", () => {
  it("Agent 在干活时：直接上屏、不排队，指令入队并带着图片", async () => {
    await makeBusy()
    const img = makeImage("shot.png")

    const sent = await d.post("/api/app-chat/send", { sessionKey: d.sessionKey, text: "/f ci先让他跑着吧", images: [img] })
    expect(sent.ok).toBe(true)

    expect(await d.queuedOf()).toEqual([])
    const item = (await d.users()).find((u) => u.id === sent.messageId)
    expect(item).toBeTruthy()
    expect(item!.queued).toBeFalsy()
    expect(item!.text).toBe("/f ci先让他跑着吧")
    const [kept, ...rest] = item!.images ?? []
    expect(rest).toEqual([])
    expect(fs.readFileSync(kept)).toEqual(fs.readFileSync(img))

    const cmds = await pendingCommands()
    expect(cmds).toHaveLength(1)
    expect(cmds[0].messageId).toBe(sent.messageId)
    // 主进程的 /f 把指令里除 /f 外的内容原样交给 Agent：图片标记要在里面（收进会话目录之后的那份）
    expect(cmds[0].command).toBe(`/f ci先让他跑着吧 ${marker(kept)}`)
  })

  it("没有任何排队消息；也没有把它当普通消息交给 Agent", async () => {
    await makeBusy()
    const img = makeImage("shot.png")
    await d.post("/api/app-chat/send", { sessionKey: d.sessionKey, text: "/f 重来", images: [img] })
    expect(((await d.get("/queue")).messages ?? []).filter((m: { status: string }) => m.status === "pending")).toHaveLength(0)
  })

  it("只有 /f 和图片、没有文字：也是指令", async () => {
    await makeBusy()
    const img = makeImage("only.png")
    const sent = await d.post("/api/app-chat/send", { sessionKey: d.sessionKey, text: "/f", images: [img] })
    expect(sent.ok).toBe(true)
    expect(await d.queuedOf()).toEqual([])
    expect((await pendingCommands()).map((c) => c.command)).toEqual([`/f ${marker((await imagesOf(sent.messageId))[0])}`])
  })

  it("多张图片：按发送顺序全部带上", async () => {
    await makeBusy()
    const a = makeImage("a.png")
    const b = makeImage("b.png")
    const sent = await d.post("/api/app-chat/send", { sessionKey: d.sessionKey, text: "/f 看这两张", images: [a, b] })
    const [ka, kb] = await imagesOf(sent.messageId)
    expect(path.extname(ka)).toBe(".png")
    expect(path.basename(ka)).toMatch(/^a_/)
    expect(path.basename(kb)).toMatch(/^b_/)
    expect((await pendingCommands()).map((c) => c.command)).toEqual([`/f 看这两张 ${marker(ka)} ${marker(kb)}`])
  })

  it("大小写不敏感，和不带图时的 /f 一致", async () => {
    await makeBusy()
    const img = makeImage("up.png")
    await d.post("/api/app-chat/send", { sessionKey: d.sessionKey, text: "/F 大写", images: [img] })
    expect(await d.queuedOf()).toEqual([])
    expect(await pendingCommands()).toHaveLength(1)
  })

  it("Agent 空闲时同样是指令，不会当普通消息交给 Agent", async () => {
    const img = makeImage("idle.png")
    await d.post("/api/app-chat/send", { sessionKey: d.sessionKey, text: "/f 开始吧", images: [img] })
    expect(await d.queuedOf()).toEqual([])
    expect(await pendingCommands()).toHaveLength(1)
    expect((await d.poll()).messages ?? []).toHaveLength(0)
  })

  it("图片文件已经不存在：图片被丢掉，剩下的照样是指令", async () => {
    await makeBusy()
    await d.post("/api/app-chat/send", { sessionKey: d.sessionKey, text: "/f 文字", images: [path.join(d.dataDir, "gone.png")] })
    expect((await pendingCommands()).map((c) => c.command)).toEqual(["/f 文字"])
  })

  it("不带图时的 /f 和以前完全一样（回归）", async () => {
    await makeBusy()
    await d.post("/api/app-chat/send", { sessionKey: d.sessionKey, text: "/f 只有文字" })
    expect(await d.queuedOf()).toEqual([])
    expect((await pendingCommands()).map((c) => c.command)).toEqual(["/f 只有文字"])
  })

  it("别的指令带图：保持原来的行为——当普通消息，图片交给 Agent（指令本身不用图片）", async () => {
    await makeBusy()
    const img = makeImage("s.png")
    const sent = await d.post("/api/app-chat/send", { sessionKey: d.sessionKey, text: "/s", images: [img] })
    expect(await d.queuedOf()).toEqual(["/s"])
    expect(await pendingCommands()).toHaveLength(0)
    // 已领取未确认的第一条会一起再投递，所以只断言带图的这条在里面、而且图片标记排在正文前（和平时一样）
    const delivered = ((await d.poll()).messages ?? []).map((m) => m.text)
    expect(delivered).toContain(`${marker((await imagesOf(sent.messageId))[0])}\n/s`)
  })

  it("普通带图消息仍然排队、图片照常交给 Agent（回归）", async () => {
    await makeBusy()
    const img = makeImage("plain.png")
    await d.post("/api/app-chat/send", { sessionKey: d.sessionKey, text: "看图", images: [img] })
    expect(await d.queuedOf()).toEqual(["看图"])
    expect(await pendingCommands()).toHaveLength(0)
  })
})

describe("立即发送：排队的消息马上进聊天流，不等 Agent 领走", () => {
  async function queueTwo(): Promise<void> {
    await makeBusy()
    await d.post("/api/app-chat/send", { sessionKey: d.sessionKey, text: "插话A" })
    await sleep(15)
    await d.post("/api/app-chat/send", { sessionKey: d.sessionKey, text: "插话B" })
  }

  it("放出之前在暂存区；放出之后立刻进聊天流，顺序不变", async () => {
    await queueTwo()
    expect(await d.queuedOf()).toEqual(["插话A", "插话B"])
    expect(shape(await d.history())).toBe("第一条 | [卡:收到] | 插话A? | 插话B?")

    const r = await d.post("/api/app-chat/queue-release", { sessionKey: d.sessionKey })
    expect(r.ok).toBe(true)
    expect(r.released).toBe(2)

    expect(await d.queuedOf()).toEqual([])
    expect(shape(await d.history())).toBe("第一条 | [卡:收到] | 插话A | 插话B")
  })

  it("放出来只是让界面先显示：消息仍在真实队列里，Agent 之后照常领走，聊天流不再变", async () => {
    await queueTwo()
    await d.post("/api/app-chat/queue-release", { sessionKey: d.sessionKey })

    const pending = ((await d.get("/queue")).messages ?? []).filter((m: { status: string }) => m.status === "pending")
    expect(pending).toHaveLength(2)

    // 打断收口，新 Agent 领走
    await d.card("finish", { segments: [{ type: "reply", text: "收到" }], interrupted: true })
    await d.post("/api/confirm-claimed", { session_key: d.sessionKey })
    expect(((await d.poll()).messages ?? []).map((m) => m.text)).toEqual(["插话A", "插话B"])
    await sleep(15)
    await d.card("ensure", { segments: [{ type: "reply", text: "新回合" }] })

    expect(shape(await d.history())).toBe("第一条 | [卡:收到/断] | 插话A | 插话B | [卡:新回合]")
  })

  it("没有排队的消息：什么也不做，返回 0", async () => {
    await makeBusy()
    const r = await d.post("/api/app-chat/queue-release", { sessionKey: d.sessionKey })
    expect(r).toMatchObject({ ok: true, released: 0 })
    expect(shape(await d.history())).toBe("第一条 | [卡:收到]")
  })

  it("重复放出是幂等的", async () => {
    await queueTwo()
    expect((await d.post("/api/app-chat/queue-release", { sessionKey: d.sessionKey })).released).toBe(2)
    expect((await d.post("/api/app-chat/queue-release", { sessionKey: d.sessionKey })).released).toBe(0)
    expect(shape(await d.history())).toBe("第一条 | [卡:收到] | 插话A | 插话B")
  })

  it("放出之后再发的消息（打断还没完成时）照常排队", async () => {
    await queueTwo()
    await d.post("/api/app-chat/queue-release", { sessionKey: d.sessionKey })
    await sleep(15)
    await d.post("/api/app-chat/send", { sessionKey: d.sessionKey, text: "插话C" })
    expect(await d.queuedOf()).toEqual(["插话C"])
    expect(shape(await d.history())).toBe("第一条 | [卡:收到] | 插话A | 插话B | 插话C?")
  })

  it("已经放出的消息不能再编辑、撤回（它们已经不在暂存区里了）", async () => {
    await queueTwo()
    const [a] = (await d.users()).filter((u) => u.queued)
    await d.post("/api/app-chat/queue-release", { sessionKey: d.sessionKey })
    expect((await d.post("/api/app-chat/queue-edit", { sessionKey: d.sessionKey, messageId: a.id, text: "改" })).ok).toBe(false)
    expect((await d.post("/api/app-chat/queue-remove", { sessionKey: d.sessionKey, messageId: a.id })).ok).toBe(false)
    expect((await d.users()).some((u) => u.id === a.id)).toBe(true)
  })

  it("带图片的排队消息放出后图片还在", async () => {
    await makeBusy()
    const img = makeImage("q.png")
    const sent = await d.post("/api/app-chat/send", { sessionKey: d.sessionKey, text: "看图", images: [img] })
    const before = await imagesOf(sent.messageId)
    expect(before).toHaveLength(1)
    await d.post("/api/app-chat/queue-release", { sessionKey: d.sessionKey })
    const item = (await d.users()).find((u) => u.text === "看图")
    expect(item?.queued).toBeFalsy()
    expect(item?.images).toEqual(before)
    expect(fs.existsSync(before[0])).toBe(true)
  })

  it("不是应用内对话的会话：拒绝", async () => {
    const r = await d.post("/api/app-chat/queue-release", { sessionKey: "ch_nope|app_main::D:/nowhere" })
    expect(r.ok).toBe(false)
  })
})
