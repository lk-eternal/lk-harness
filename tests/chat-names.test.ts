import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import {
  CHAT_NAME_CHUNK,
  CHAT_NAME_RETRY_MS,
  createChatNameBook,
  createChatNameFetcher,
} from "../src/shared/chat-names"
import { globalChatNamesPath } from "../src/shared/session-entry-paths"
import { lookupChatName, resolveSessionChatName, setChatNameFallback, setChatNameResolver, setChatNameStored } from "../electron/session-chat-name"

/**
 * 会话清单里别人的会话「叫什么」的三块：落盘的名字本、后台批量问群名、查名字的优先级。
 * 真实文件 + 临时目录；向 daemon 要名字的那一步用假的，记录它被问了什么。
 */

let dir: string
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "chat-names-"))
})
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true })
})

describe("ChatNameBook：名字落盘", () => {
  it("存进去的名字，换一个实例（等于重启）还读得到", () => {
    const file = globalChatNamesPath(dir)
    const a = createChatNameBook(file)
    expect(a.setMany({ "ch_a|oc_1": "客服一群", "ch_a|oc_2": "张三" })).toBe(true)
    const b = createChatNameBook(file)
    expect(b.get("ch_a|oc_1")).toBe("客服一群")
    expect(b.get("ch_a|oc_2")).toBe("张三")
    expect(b.get("ch_a|oc_none")).toBeUndefined()
  })

  it("路径在会话库的 _global 下，目录不存在会自己建", () => {
    const file = globalChatNamesPath(dir)
    expect(file.includes("_global")).toBe(true)
    createChatNameBook(file).setMany({ k: "名" })
    expect(fs.existsSync(file)).toBe(true)
  })

  it("没变化不写盘：同样的名字再存一遍返回 false、文件不动（状态轮询每 5 秒都会存）", () => {
    const file = globalChatNamesPath(dir)
    const book = createChatNameBook(file)
    book.setMany({ k: "名" })
    const mtime = fs.statSync(file).mtimeMs
    fs.utimesSync(file, new Date(mtime - 60_000), new Date(mtime - 60_000))
    const before = fs.statSync(file).mtimeMs
    expect(book.setMany({ k: "名" })).toBe(false)
    expect(fs.statSync(file).mtimeMs).toBe(before)
  })

  it("名字变了要更新（群改了名 / 用户改了名）", () => {
    const file = globalChatNamesPath(dir)
    const book = createChatNameBook(file)
    book.setMany({ k: "旧名" })
    expect(book.setMany({ k: "新名" })).toBe(true)
    expect(createChatNameBook(file).get("k")).toBe("新名")
  })

  it("空名字 / 非字符串 / 空键忽略，不会把已有的名字清掉", () => {
    const file = globalChatNamesPath(dir)
    const book = createChatNameBook(file)
    book.setMany({ k: "名" })
    expect(book.setMany({ k: "  ", "": "x", j: undefined })).toBe(false)
    expect(createChatNameBook(file).get("k")).toBe("名")
    expect(createChatNameBook(file).get("j")).toBeUndefined()
  })

  it("名字压成一行并截断到 100 字", () => {
    const book = createChatNameBook(globalChatNamesPath(dir))
    book.setMany({ a: "  张  三\n丰 ", b: "长".repeat(300) })
    expect(book.get("a")).toBe("张 三 丰")
    expect(book.get("b")!.length).toBe(100)
  })

  it("文件损坏当成空的，不抛错；之后有新名字照常写", () => {
    const file = globalChatNamesPath(dir)
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, "{坏的")
    const book = createChatNameBook(file)
    expect(book.get("k")).toBeUndefined()
    expect(book.setMany({ k: "名" })).toBe(true)
    expect(createChatNameBook(file).get("k")).toBe("名")
  })

  it("写不进去（目录被同名文件占着）不抛错，内存里的名字照常能读", () => {
    const blocker = path.join(dir, "blocker")
    fs.writeFileSync(blocker, "x")
    const book = createChatNameBook(path.join(blocker, "chat-names.json"))
    expect(() => book.setMany({ k: "名" })).not.toThrow()
    expect(book.get("k")).toBe("名")
  })
})

describe("createChatNameFetcher：后台批量问群名", () => {
  function setup(opts: { reply?: (keys: string[]) => Record<string, string> | null; chunkSize?: number } = {}) {
    const asked: string[][] = []
    const cache = new Map<string, string>()
    const book = createChatNameBook(globalChatNamesPath(dir))
    let t = 1_000_000
    const fetcher = createChatNameFetcher({
      cache,
      book,
      now: () => t,
      chunkSize: opts.chunkSize,
      request: async (keys) => {
        asked.push(keys)
        return opts.reply ? opts.reply(keys) : Object.fromEntries(keys.map((k) => [k, `名-${k}`]))
      },
    })
    return { fetcher, asked, cache, book, advance: (ms: number) => { t += ms } }
  }

  it("问到的名字进内存缓存，也记到盘上", async () => {
    const { fetcher, cache, book } = setup()
    await fetcher.fetch(["g1", "g2"])
    expect(cache.get("g1")).toBe("名-g1")
    expect(book.get("g2")).toBe("名-g2")
  })

  it("已经有名字的不再问；重复的键只问一次", async () => {
    const { fetcher, asked, cache } = setup()
    cache.set("g1", "已有")
    await fetcher.fetch(["g1", "g2", "g2", "g2"])
    expect(asked).toEqual([["g2"]])
  })

  it("全都有名字时一次请求都不发", async () => {
    const { fetcher, asked, cache } = setup()
    cache.set("g1", "a")
    await fetcher.fetch(["g1"])
    await fetcher.fetch([])
    expect(asked).toEqual([])
  })

  it("分批：几十个群不会塞进一次请求（一批太大会超时，问到的也跟着丢）", async () => {
    const keys = Array.from({ length: CHAT_NAME_CHUNK * 2 + 3 }, (_, i) => `g${i}`)
    const { fetcher, asked, cache } = setup()
    await fetcher.fetch(keys)
    expect(asked.map((a) => a.length)).toEqual([CHAT_NAME_CHUNK, CHAT_NAME_CHUNK, 3])
    expect(asked.flat()).toEqual(keys)
    expect(cache.size).toBe(keys.length)
  })

  it("其中一批失败，别的批照常问、照常记", async () => {
    const keys = Array.from({ length: 6 }, (_, i) => `g${i}`)
    let n = 0
    const asked: string[][] = []
    const cache = new Map<string, string>()
    const fetcher = createChatNameFetcher({
      cache,
      chunkSize: 2,
      request: async (ks) => {
        asked.push(ks)
        if (++n === 2) throw new Error("超时")
        return Object.fromEntries(ks.map((k) => [k, `名-${k}`]))
      },
    })
    await fetcher.fetch(keys)
    expect(asked.length).toBe(3)
    expect([...cache.keys()].sort()).toEqual(["g0", "g1", "g4", "g5"])
  })

  it("查不到的（机器人被移出了群 / 群解散了）冷却一阵：期间每次刷新都不再去问", async () => {
    const { fetcher, asked, advance } = setup({ reply: () => ({}) })
    await fetcher.fetch(["gone"])
    await fetcher.fetch(["gone"])
    advance(CHAT_NAME_RETRY_MS - 1)
    await fetcher.fetch(["gone"])
    expect(asked).toEqual([["gone"]])
    advance(2)
    await fetcher.fetch(["gone"])
    expect(asked).toEqual([["gone"], ["gone"]])
  })

  it("请求整个失败（超时 / 接口报错）也冷却，不会每轮都重打", async () => {
    let calls = 0
    const cache = new Map<string, string>()
    let t = 0
    const fetcher = createChatNameFetcher({
      cache,
      now: () => t,
      request: async () => {
        calls++
        throw new Error("ECONNRESET")
      },
    })
    await fetcher.fetch(["g1"])
    await fetcher.fetch(["g1"])
    expect(calls).toBe(1)
    t += CHAT_NAME_RETRY_MS + 1
    await fetcher.fetch(["g1"])
    expect(calls).toBe(2)
  })

  it("daemon 没起（现在问不了）不算失败：不冷却，起来后下一次就能问到", async () => {
    let up = false
    const asked: string[][] = []
    const cache = new Map<string, string>()
    const fetcher = createChatNameFetcher({
      cache,
      chunkSize: 1,
      request: async (ks) => {
        asked.push(ks)
        return up ? Object.fromEntries(ks.map((k) => [k, "名"])) : null
      },
    })
    await fetcher.fetch(["g1", "g2", "g3"])
    expect(asked).toEqual([["g1"]]) // 问不了就停，不把后面的批也一个个试一遍
    expect(cache.size).toBe(0)
    up = true
    await fetcher.fetch(["g1", "g2", "g3"])
    expect(cache.size).toBe(3)
  })

  it("先查不到、冷却过后查到了：名字补上，冷却记录清掉", async () => {
    let known = false
    const cache = new Map<string, string>()
    let t = 0
    const fetcher = createChatNameFetcher({
      cache,
      now: () => t,
      request: async (ks) => (known ? Object.fromEntries(ks.map((k) => [k, "后来才有的名"])) : {}),
    })
    await fetcher.fetch(["g1"])
    expect(cache.has("g1")).toBe(false)
    known = true
    t += CHAT_NAME_RETRY_MS + 1
    await fetcher.fetch(["g1"])
    expect(cache.get("g1")).toBe("后来才有的名")
  })

  it("同一个群正在问的时候，别的调用方（状态轮询 / 派发 / 清单）不会重复去问", async () => {
    const asked: string[][] = []
    let release: () => void = () => {}
    const gate = new Promise<void>((r) => { release = r })
    const cache = new Map<string, string>()
    const fetcher = createChatNameFetcher({
      cache,
      request: async (ks) => {
        asked.push(ks)
        await gate
        return Object.fromEntries(ks.map((k) => [k, "名"]))
      },
    })
    const first = fetcher.fetch(["g1", "g2"])
    const second = fetcher.fetch(["g1", "g2", "g3"]) // g1 g2 在途，第二个调用方只会去问 g3
    release()
    await Promise.all([first, second])
    expect(asked).toEqual([["g1", "g2"], ["g3"]])
  })

  it("请求出错后在途标记要释放：之后（冷却过了）还能再问", async () => {
    let t = 0
    let fail = true
    const asked: string[][] = []
    const cache = new Map<string, string>()
    const fetcher = createChatNameFetcher({
      cache,
      now: () => t,
      request: async (ks) => {
        asked.push(ks)
        if (fail) throw new Error("x")
        return { g1: "名" }
      },
    })
    await fetcher.fetch(["g1"])
    fail = false
    t += CHAT_NAME_RETRY_MS + 1
    await fetcher.fetch(["g1"])
    expect(cache.get("g1")).toBe("名")
    expect(asked.length).toBe(2)
  })
})

describe("查名字的优先级", () => {
  function install(mem: Record<string, string>, stored: Record<string, string>, fallback = true) {
    setChatNameResolver((id) => mem[id])
    setChatNameStored((id) => stored[id])
    setChatNameFallback(fallback ? (id) => (id.startsWith("ch_a|") ? "飞书服务台·访客" : undefined) : () => undefined)
  }

  it("本次运行查到的聊天名 > 按发送人 open_id 查到的 > 落盘的", () => {
    install({ "ch_a|oc_1": "内存群名", ou_x: "内存用户" }, { "ch_a|oc_1": "落盘群名" })
    expect(lookupChatName("ch_a|oc_1::D:\\ws")).toBe("内存群名")
    install({ ou_x: "内存用户" }, { "ch_a|oc_1": "落盘群名" })
    expect(lookupChatName("ch_a|oc_1::D:\\ws", "ou_x")).toBe("内存用户")
    expect(lookupChatName("ch_a|oc_1::D:\\ws")).toBe("落盘群名")
  })

  it("什么都查不到返回 undefined——不编「访客」（清单靠它判断要不要用自己的兜底名）", () => {
    install({}, {})
    expect(lookupChatName("ch_a|oc_1::D:\\ws")).toBeUndefined()
    expect(lookupChatName("ch_a|oc_1")).toBeUndefined()
  })

  it("运行中会话的广播名（resolveSessionChatName）：自带名 > 查到的 > 落盘的 > 才是「通道名·访客」", () => {
    install({}, { "ch_a|oc_1": "落盘群名" })
    expect(resolveSessionChatName("ch_a|oc_1::D:\\ws", "自带名")).toBe("自带名")
    expect(resolveSessionChatName("ch_a|oc_1::D:\\ws")).toBe("落盘群名")
    expect(resolveSessionChatName("ch_a|oc_2::D:\\ws")).toBe("飞书服务台·访客")
    install({}, {}, false)
    expect(resolveSessionChatName("ch_a|oc_2::D:\\ws")).toBeUndefined()
  })
})
