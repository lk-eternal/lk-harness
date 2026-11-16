import { describe, expect, it } from "vitest"
import { createDraftStore } from "../src/shared/composer-drafts"
import { createUploadGate, waitForUploadsBeforeSend, type UploadBatchResult } from "../src/shared/upload-gate"

/** 一个可以手动完成的上传批次 */
function deferredBatch() {
  let resolve!: (r: UploadBatchResult) => void
  let reject!: (e: unknown) => void
  const promise = new Promise<UploadBatchResult>((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

/** 让已排队的微任务都跑完 */
const flush = () => new Promise<void>((r) => setTimeout(r, 0))

describe("上传闸门：图片还在传时点发送要等", () => {
  it("没有上传在途：立刻放行，不等任何东西", async () => {
    const gate = createUploadGate()
    expect(gate.pending).toBe(false)
    expect(await gate.settle()).toBeNull()
    expect(await waitForUploadsBeforeSend(gate)).toEqual({ ok: true })
  })

  it("有上传在途：settle 一直等到它传完，传完后 pending 变回 false", async () => {
    const gate = createUploadGate()
    const b = deferredBatch()
    gate.track(b.promise)
    expect(gate.pending).toBe(true)

    let settled = false
    const waiting = gate.settle().then((r) => { settled = true; return r })
    await flush()
    expect(settled).toBe(false) // 还没传完，不能放行

    b.resolve({ failed: 0 })
    expect(await waiting).toEqual({ failed: 0 })
    await flush()
    expect(gate.pending).toBe(false)
  })

  it("等待的过程中又选了一批图：两批都传完才放行", async () => {
    const gate = createUploadGate()
    const first = deferredBatch()
    const second = deferredBatch()
    gate.track(first.promise)

    let settled = false
    const waiting = gate.settle().then((r) => { settled = true; return r })
    gate.track(second.promise)

    first.resolve({ failed: 0 })
    await flush()
    expect(settled).toBe(false) // 第二批还在传

    second.resolve({ failed: 0 })
    expect(await waiting).toEqual({ failed: 0 })
  })

  it("有图片没传成：汇总失败张数和第一条原因", async () => {
    const gate = createUploadGate()
    const a = deferredBatch()
    const b = deferredBatch()
    gate.track(a.promise)
    gate.track(b.promise)
    a.resolve({ failed: 1, error: "图片上传失败" })
    b.resolve({ failed: 2, error: "读取图片失败" })
    expect(await gate.settle()).toEqual({ failed: 3, error: "图片上传失败" })
  })

  it("某一批异常中断（promise 被 reject）：当作失败，闸门不会卡住", async () => {
    const gate = createUploadGate()
    const b = deferredBatch()
    gate.track(b.promise)
    const waiting = gate.settle()
    b.reject(new Error("网络断了"))
    expect(await waiting).toEqual({ failed: 1, error: "网络断了" })
    await flush()
    expect(gate.pending).toBe(false)
    expect(await gate.settle()).toBeNull()
  })

  it("发送前：图片没传成就不放行，并说明消息没发出、内容还在", async () => {
    const gate = createUploadGate()
    gate.track(Promise.resolve({ failed: 1, error: "不支持的图片格式（image/heic）" }))
    const r = await waitForUploadsBeforeSend(gate)
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.message).toContain("消息没有发出")
      expect(r.message).toContain("不支持的图片格式（image/heic）")
      expect(r.message).toContain("还在输入框里")
    }
  })

  it("发送前：失败没有给原因时，也有兜底说法", async () => {
    const gate = createUploadGate()
    gate.track(Promise.resolve({ failed: 1 }))
    const r = await waitForUploadsBeforeSend(gate)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.message).toContain("图片上传失败")
  })
})

describe("发送的顺序：上传途中点发送，发出去的消息要带上随后传完的图", () => {
  /** 和 MobileApp.handleSend 同一个顺序：先等上传，再从草稿里取最新的图片 */
  async function send(gate: ReturnType<typeof createUploadGate>, store: ReturnType<typeof createDraftStore<{ path: string }>>, key: string) {
    const waited = await waitForUploadsBeforeSend(gate)
    if (!waited.ok) return { sent: null, error: waited.message }
    const images = store.get(key).images.map((i) => i.path)
    return { sent: { text: store.get(key).text, images }, error: "" }
  }

  it("文字先写好、图片还在传时点发送：等图片进了草稿再发，一张不少", async () => {
    const gate = createUploadGate()
    const store = createDraftStore<{ path: string }>()
    store.update("s1", (d) => ({ ...d, text: "看这张图" }))

    const batch = deferredBatch()
    gate.track(batch.promise)
    const sending = send(gate, store, "s1")

    // 图片这时才传完、进草稿
    await flush()
    store.update("s1", (d) => ({ ...d, images: [...d.images, { path: "/tmp/a.png" }] }))
    batch.resolve({ failed: 0 })

    expect(await sending).toEqual({ sent: { text: "看这张图", images: ["/tmp/a.png"] }, error: "" })
  })

  it("对照：不等的话（旧行为）发出去的就是没有图的消息", () => {
    const store = createDraftStore<{ path: string }>()
    store.update("s1", (d) => ({ ...d, text: "看这张图" }))
    const snapshot = store.get("s1").images.map((i) => i.path) // 点发送那一刻取快照
    store.update("s1", (d) => ({ ...d, images: [...d.images, { path: "/tmp/a.png" }] })) // 图片随后才进草稿
    expect(snapshot).toEqual([]) // 旧行为：消息不带图，图片后来才冒出来
  })

  it("图片没传成：消息不发出，文字和已传好的图都还在草稿里", async () => {
    const gate = createUploadGate()
    const store = createDraftStore<{ path: string }>()
    store.update("s1", (d) => ({ ...d, text: "两张图", images: [{ path: "/tmp/ok.png" }] }))

    const batch = deferredBatch()
    gate.track(batch.promise)
    const sending = send(gate, store, "s1")
    batch.resolve({ failed: 1, error: "图片上传失败" })

    const r = await sending
    expect(r.sent).toBeNull()
    expect(r.error).toContain("消息没有发出")
    expect(store.get("s1").text).toBe("两张图")
    expect(store.get("s1").images.map((i) => i.path)).toEqual(["/tmp/ok.png"])
  })

  it("等待期间切到别的会话：图片仍然落在发起上传的那个会话，发的也是那个会话的草稿", async () => {
    const gate = createUploadGate()
    const store = createDraftStore<{ path: string }>()
    store.update("s1", (d) => ({ ...d, text: "A 会话的消息" }))
    store.update("s2", (d) => ({ ...d, text: "B 会话的草稿" }))

    const batch = deferredBatch()
    gate.track(batch.promise)
    const sending = send(gate, store, "s1") // 在 A 会话点的发送

    store.update("s1", (d) => ({ ...d, images: [...d.images, { path: "/tmp/a.png" }] })) // 上传时记下的 key 是 A
    batch.resolve({ failed: 0 })

    expect(await sending).toEqual({ sent: { text: "A 会话的消息", images: ["/tmp/a.png"] }, error: "" })
    expect(store.get("s2").images).toEqual([]) // B 会话没有被带上图片
    expect(store.get("s2").text).toBe("B 会话的草稿")
  })
})
