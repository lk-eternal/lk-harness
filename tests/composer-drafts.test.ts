import { describe, expect, it, vi } from "vitest"
import { createDraftStore, type DraftImage } from "../src/shared/composer-drafts"

interface Img extends DraftImage {
  preview: string
}
const img = (name: string): Img => ({ path: `/tmp/${name}.png`, preview: `blob:${name}` })

describe("createDraftStore：按会话分开的输入框草稿", () => {
  it("没有草稿的会话拿到的是同一个空草稿（引用稳定，可直接当 useSyncExternalStore 快照）", () => {
    const store = createDraftStore<Img>()
    const a = store.get("a")
    expect(a).toEqual({ text: "", images: [] })
    expect(store.get("b")).toBe(a)
    expect(store.get(null)).toBe(a)
  })

  it("A 会话没发送的内容不会出现在 B 会话；切回 A 原样还在", () => {
    const store = createDraftStore<Img>()
    store.update("A", (d) => ({ ...d, text: "写了一半的话" }))
    store.update("A", (d) => ({ ...d, images: [...d.images, img("1")] }))

    // 新建/切到会话 B：B 的输入框是空的
    expect(store.get("B")).toEqual({ text: "", images: [] })

    store.update("B", (d) => ({ ...d, text: "B 自己的草稿" }))
    expect(store.get("A").text).toBe("写了一半的话")
    expect(store.get("A").images.map((i) => i.path)).toEqual(["/tmp/1.png"])
    expect(store.get("B").text).toBe("B 自己的草稿")
    expect(store.get("B").images).toEqual([])
  })

  it("草稿被改成空（清空文字且没有图片）时，记录直接删掉，回到共享的空草稿", () => {
    const store = createDraftStore<Img>()
    store.update("A", (d) => ({ ...d, text: "x" }))
    expect(store.get("A")).not.toBe(store.get("zzz"))
    store.update("A", (d) => ({ ...d, text: "" }))
    expect(store.get("A")).toBe(store.get("zzz"))
  })

  it("key 为 null（还没选中会话）时读写都是空操作，不会通知", () => {
    const store = createDraftStore<Img>()
    const listener = vi.fn()
    store.subscribe(listener)
    store.update(null, (d) => ({ ...d, text: "x" }))
    store.discard(null)
    expect(store.get(null).text).toBe("")
    expect(listener).not.toHaveBeenCalled()
  })

  it("内容没变化的更新不通知（不会白白重渲染）", () => {
    const store = createDraftStore<Img>()
    store.update("A", (d) => ({ ...d, text: "hi" }))
    const listener = vi.fn()
    store.subscribe(listener)

    store.update("A", (d) => d) // 原样返回
    store.update("A", (d) => ({ ...d, text: "hi" })) // 新对象但内容一样
    store.discard("never-existed")
    expect(listener).not.toHaveBeenCalled()

    store.update("A", (d) => ({ ...d, text: "hi!" }))
    expect(listener).toHaveBeenCalledTimes(1)
  })

  it("订阅与取消订阅", () => {
    const store = createDraftStore<Img>()
    const listener = vi.fn()
    const off = store.subscribe(listener)
    store.update("A", (d) => ({ ...d, text: "1" }))
    off()
    store.update("A", (d) => ({ ...d, text: "2" }))
    expect(listener).toHaveBeenCalledTimes(1)
  })

  it("discard 丢掉整个草稿，并释放其中每张图片", () => {
    const removed: string[] = []
    const store = createDraftStore<Img>({ onRemoveImage: (i) => removed.push(i.preview) })
    store.update("A", () => ({ text: "t", images: [img("1"), img("2")] }))
    store.update("B", () => ({ text: "", images: [img("3")] }))

    store.discard("A")

    expect(store.get("A").text).toBe("")
    expect(removed.sort()).toEqual(["blob:1", "blob:2"])
    expect(store.get("B").images).toHaveLength(1) // 别的会话不受影响
  })

  it("只移除其中一张图片时，只释放被移除的那张", () => {
    const removed: string[] = []
    const store = createDraftStore<Img>({ onRemoveImage: (i) => removed.push(i.preview) })
    const [one, two] = [img("1"), img("2")]
    store.update("A", () => ({ text: "", images: [one, two] }))

    store.update("A", (d) => ({ ...d, images: d.images.filter((i) => i.path !== one.path) }))

    expect(removed).toEqual(["blob:1"])
    expect(store.get("A").images).toEqual([two])
  })

  it("新增图片、改文字不会释放已有图片", () => {
    const removed: string[] = []
    const store = createDraftStore<Img>({ onRemoveImage: (i) => removed.push(i.preview) })
    store.update("A", () => ({ text: "", images: [img("1")] }))
    store.update("A", (d) => ({ ...d, text: "x" }))
    store.update("A", (d) => ({ ...d, images: [...d.images, img("2")] }))
    expect(removed).toEqual([])
  })

  it("异步上传图片：切到别的会话之后才完成，图片仍落在发起它的会话里", async () => {
    const store = createDraftStore<Img>()
    store.update("A", (d) => ({ ...d, text: "看这张图" }))

    // 在 A 里选了图，上传期间用户切到了 B 并开始输入
    const startedIn = "A"
    const upload = new Promise<Img>((resolve) => setTimeout(() => resolve(img("late")), 5))
    store.update("B", (d) => ({ ...d, text: "B 的内容" }))
    const uploaded = await upload
    store.update(startedIn, (d) => ({ ...d, images: [...d.images, uploaded] }))

    expect(store.get("A").images.map((i) => i.path)).toEqual(["/tmp/late.png"])
    expect(store.get("B").images).toEqual([])
    expect(store.get("B").text).toBe("B 的内容")
  })

  it("发送失败后把内容放回发出消息的会话；期间在该会话重新输入的内容优先（与手机端 handleSend 的写法一致）", () => {
    const store = createDraftStore<Img>()
    const restore = (key: string, text: string, images: Img[]) =>
      store.update(key, (d) => ({ text: d.text || text, images: d.images.length > 0 ? d.images : images }))

    // 会话 A 发送：先清空输入框，用户随即切到 B，之后发送失败
    store.update("A", () => ({ text: "要发的话", images: [img("1")] }))
    const sent = store.get("A")
    store.discard("A")
    store.update("B", (d) => ({ ...d, text: "B 里正在写的" }))
    restore("A", sent.text, sent.images)

    expect(store.get("A").text).toBe("要发的话")
    expect(store.get("A").images).toHaveLength(1)
    expect(store.get("B").text).toBe("B 里正在写的") // 没有被串进 B

    // 失败时 A 里已经重新输入了内容：不覆盖
    store.update("C", () => ({ text: "旧", images: [] }))
    const sentC = store.get("C")
    store.discard("C")
    store.update("C", (d) => ({ ...d, text: "新" }))
    restore("C", sentC.text, sentC.images)
    expect(store.get("C").text).toBe("新")
  })
})
