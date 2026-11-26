/**
 * 端到端（真实 daemon 进程 + 真实 HTTP 接口）：对话里的图片跟着会话走。
 *
 * 线上反馈：经常看到「图片不可用」。图片只存路径，原来放在系统临时目录，后台每 6 小时清掉 24 小时前的文件；
 * AI 发图存的还是原路径，源文件一删也就没了。现在发出去的那一刻收进会话自己的目录，
 * 和会话记录同生命周期（清空 / 删除会话时一起删），不再受临时目录清理影响。
 *
 * 用 `npm run test:e2e` 运行；不在默认的 `npm test` 里。
 */
import * as fs from "node:fs"
import * as path from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { startIsolatedDaemon, type ChatItem, type IsolatedDaemon } from "../helpers/isolated-daemon"

let d: IsolatedDaemon

beforeEach(async () => { d = await startIsolatedDaemon() })
afterEach(async () => { await d?.stop() })

/** 模拟系统临时目录里的图（粘贴时的暂存位置）或 AI 生成的图 */
function makeImage(name: string, content = "pixels"): string {
  const p = path.join(d.dataDir, name)
  fs.writeFileSync(p, content)
  return p
}

/** 通道目录里的所有会话图片目录；路径是 daemon 内部决定的，这里只认「app-chat 下、.images 结尾」 */
function imageDirs(): string[] {
  const out: string[] = []
  const walk = (dir: string): void => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name)
      if (!e.isDirectory()) continue
      if (e.name.endsWith(".images")) out.push(full)
      else walk(full)
    }
  }
  const root = path.join(d.dataDir, "app-chat")
  if (fs.existsSync(root)) walk(root)
  return out
}

const imagesOf = async (messageId: string): Promise<string[]> =>
  (await d.users()).find((u) => u.id === messageId)?.images ?? []

const imageItems = async (): Promise<ChatItem[]> => (await d.history()).filter((i) => i.kind === "image")
const pathOf = (i: ChatItem): string => (i as unknown as { path: string }).path

describe("用户发的图：发送时收进会话目录", () => {
  it("记录里是收进去的那份，内容一致；原文件不动", async () => {
    const img = makeImage("shot.png", "my-pixels")
    const sent = await d.post("/api/app-chat/send", { sessionKey: d.sessionKey, text: "看图", images: [img] })
    expect(sent.ok).toBe(true)

    const [kept, ...rest] = await imagesOf(sent.messageId)
    expect(rest).toEqual([])
    expect(kept).not.toBe(img)
    expect(imageDirs()).toHaveLength(1)
    expect(path.dirname(kept)).toBe(imageDirs()[0])
    expect(fs.readFileSync(kept, "utf-8")).toBe("my-pixels")
    expect(fs.readFileSync(img, "utf-8")).toBe("my-pixels")
  })

  it("交给 Agent 的也是收进去的那份：之后翻聊天、让 Agent 重新看这张图，路径都还在", async () => {
    const img = makeImage("shot.png")
    const sent = await d.post("/api/app-chat/send", { sessionKey: d.sessionKey, text: "看图", images: [img] })
    const [kept] = await imagesOf(sent.messageId)

    const delivered = ((await d.poll()).messages ?? []).map((m) => m.text)
    expect(delivered).toEqual([`[图片已保存: ${kept}]\n看图`])
  })

  it("临时目录里的原图被清掉之后，聊天里的图还在", async () => {
    const img = makeImage("pasted.png", "keep-me")
    const sent = await d.post("/api/app-chat/send", { sessionKey: d.sessionKey, text: "看图", images: [img] })
    const [kept] = await imagesOf(sent.messageId)

    fs.rmSync(img) // 后台 24 小时清理做的事

    expect(fs.readFileSync(kept, "utf-8")).toBe("keep-me")
  })

  it("多张图片：顺序不变，各自一份", async () => {
    const sent = await d.post("/api/app-chat/send", {
      sessionKey: d.sessionKey, text: "两张", images: [makeImage("a.png", "A"), makeImage("b.jpg", "B")],
    })
    const kept = await imagesOf(sent.messageId)
    expect(kept.map((p) => fs.readFileSync(p, "utf-8"))).toEqual(["A", "B"])
    expect(kept.map((p) => path.extname(p))).toEqual([".png", ".jpg"])
  })

  it("原图不存在：和以前一样被丢掉，不进记录，也不会建出图片目录", async () => {
    const sent = await d.post("/api/app-chat/send", { sessionKey: d.sessionKey, text: "文字", images: [path.join(d.dataDir, "gone.png")] })
    expect(sent.ok).toBe(true)
    expect(await imagesOf(sent.messageId)).toEqual([])
    expect(imageDirs()).toEqual([])
  })

  it("纯文字消息不产生图片目录", async () => {
    await d.post("/api/app-chat/send", { sessionKey: d.sessionKey, text: "你好" })
    expect(imageDirs()).toEqual([])
  })

  it("排队中的带图消息：撤回之后图片一并删掉", async () => {
    await d.post("/api/app-chat/send", { sessionKey: d.sessionKey, text: "第一条" })
    await d.poll()
    await d.card("ensure", { segments: [{ type: "reply", text: "收到" }] }) // Agent 在干活，后面的消息要排队

    const sent = await d.post("/api/app-chat/send", { sessionKey: d.sessionKey, text: "插话", images: [makeImage("q.png")] })
    expect(await d.queuedOf()).toEqual(["插话"])
    const [kept] = await imagesOf(sent.messageId)
    expect(fs.existsSync(kept)).toBe(true)

    const removed = await d.post("/api/app-chat/queue-remove", { sessionKey: d.sessionKey, messageId: sent.messageId })
    expect(removed.ok).toBe(true)

    expect(fs.existsSync(kept)).toBe(false)
    expect(imageDirs()).toEqual([])
  })
})

describe("AI 发的图（send_image）：同样收进会话目录", () => {
  // 发图接口只认已经注册过的会话：真实使用里总是用户先说了话，Agent 才会回图
  beforeEach(async () => {
    await d.post("/api/app-chat/send", { sessionKey: d.sessionKey, text: "来张图" })
    await d.poll()
  })

  it("记录里是收进去的那份；AI 把原文件删了，聊天里的图还在", async () => {
    const img = makeImage("chart.png", "v1")
    const r = await d.post("/api/send-image", { image_path: img, session_key: d.sessionKey })
    expect(r.ok).toBe(true)

    const [item] = await imageItems()
    const kept = pathOf(item)
    expect(kept).not.toBe(img)
    expect(path.dirname(kept)).toBe(imageDirs()[0])

    fs.rmSync(img)
    expect(fs.readFileSync(kept, "utf-8")).toBe("v1")
  })

  it("同一个路径重新生成后再发：前一条消息里的图不能跟着变", async () => {
    const img = makeImage("chart.png", "v1")
    await d.post("/api/send-image", { image_path: img, session_key: d.sessionKey })
    fs.writeFileSync(img, "v2")
    await d.post("/api/send-image", { image_path: img, session_key: d.sessionKey })

    const items = await imageItems()
    expect(items).toHaveLength(2)
    expect(items.map((i) => fs.readFileSync(pathOf(i), "utf-8"))).toEqual(["v1", "v2"])
  })

  it("源文件不存在：照旧报错，不进记录", async () => {
    const r = await d.post("/api/send-image", { image_path: path.join(d.dataDir, "nope.png"), session_key: d.sessionKey })
    expect(r).toEqual({ ok: false, error: "图片文件不存在" })
    expect(await imageItems()).toEqual([])
    expect(imageDirs()).toEqual([])
  })
})

describe("AI 回合中发的图 / 文件：并进回合卡它发的那个位置", () => {
  beforeEach(async () => {
    await d.post("/api/app-chat/send", { sessionKey: d.sessionKey, text: "来张图" })
    await d.poll()
  })

  const turnSegments = async () => (await d.history()).find((i) => i.kind === "assistant")?.segments

  it("有回合卡：图、文件各在卡里发的位置，记录本身仍在", async () => {
    await d.card("ensure")
    await d.post("/api/send-image", { image_path: makeImage("chart.png"), session_key: d.sessionKey })
    const report = path.join(d.dataDir, "report.txt")
    fs.writeFileSync(report, "x")
    await d.post("/api/send-file", { file_path: report, session_key: d.sessionKey })

    const [image] = await imageItems()
    const file = (await d.history()).find((i) => i.kind === "file")
    expect(file).toBeDefined()
    expect(await turnSegments()).toEqual([
      { type: "reply", text: "处理中" },
      { type: "item", itemId: image.id },
      { type: "item", itemId: file!.id },
    ])
  })

  it("卡后续的流式更新不会把它们冲掉", async () => {
    await d.card("ensure")
    await d.post("/api/send-image", { image_path: makeImage("chart.png"), session_key: d.sessionKey })
    await d.card("update", { segments: [{ type: "reply", text: "处理中" }, { type: "reply", text: "接着说" }] })

    const [image] = await imageItems()
    expect(await turnSegments()).toEqual([
      { type: "reply", text: "处理中" },
      { type: "item", itemId: image.id },
      { type: "reply", text: "接着说" },
    ])
  })

  it("没有回合卡：仍是独立记录", async () => {
    await d.post("/api/send-image", { image_path: makeImage("chart.png"), session_key: d.sessionKey })
    expect(await turnSegments()).toBeUndefined()
    expect(await imageItems()).toHaveLength(1)
  })
})

describe("清空 / 删除会话：图片一起删", () => {
  it("清空会话记录：用户发的图和 AI 发的图都删，目录也删", async () => {
    const sent = await d.post("/api/app-chat/send", { sessionKey: d.sessionKey, text: "看图", images: [makeImage("u.png")] })
    await d.post("/api/send-image", { image_path: makeImage("ai.png"), session_key: d.sessionKey })
    const [mine] = await imagesOf(sent.messageId)
    const theirs = pathOf((await imageItems())[0])
    expect(fs.existsSync(mine) && fs.existsSync(theirs)).toBe(true)

    const cleared = await d.post("/api/app-chat/clear", { sessionKey: d.sessionKey })
    expect(cleared.ok).toBe(true)

    expect(fs.existsSync(mine)).toBe(false)
    expect(fs.existsSync(theirs)).toBe(false)
    expect(imageDirs()).toEqual([])
  })

  it("清空整个通道：所有会话的图片都删", async () => {
    const sent = await d.post("/api/app-chat/send", { sessionKey: d.sessionKey, text: "看图", images: [makeImage("u.png")] })
    const [mine] = await imagesOf(sent.messageId)

    const cleared = await d.post("/api/app-chat/clear", { channelId: "ch_test" })
    expect(cleared.ok).toBe(true)

    expect(fs.existsSync(mine)).toBe(false)
    expect(imageDirs()).toEqual([])
  })

  it("只清空这个会话，别的会话的图片不动", async () => {
    // 同一个通道里另一个工作目录的会话
    const otherKey = `ch_test|app_main::${path.join(d.dataDir, "ws-other")}`

    const a = await d.post("/api/app-chat/send", { sessionKey: d.sessionKey, text: "A", images: [makeImage("a.png")] })
    const b = await d.post("/api/app-chat/send", { sessionKey: otherKey, text: "B", images: [makeImage("b.png")] })
    expect(b.ok).toBe(true)
    const [aImg] = await imagesOf(a.messageId)
    const bHistory = (await d.post("/api/app-chat/history", { sessionKey: otherKey })).items as ChatItem[]
    const bImg = bHistory.find((i) => i.id === b.messageId)?.images?.[0] ?? ""
    expect(imageDirs()).toHaveLength(2)

    await d.post("/api/app-chat/clear", { sessionKey: d.sessionKey })

    expect(fs.existsSync(aImg)).toBe(false)
    expect(fs.existsSync(bImg)).toBe(true)
    expect(imageDirs()).toHaveLength(1)
  })
})
