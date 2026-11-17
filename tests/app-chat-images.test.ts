import { afterEach, beforeEach, describe, expect, it } from "vitest"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { AppChat } from "../src/app-channel"

/**
 * 对话里的图片只存路径。以前原样放在系统临时目录（24 小时后被后台清理）、或 AI 随手生成的位置，
 * 过几天打开聊天就是「图片不可用」。现在发出去的那一刻收进会话自己的目录，和会话记录同生命周期。
 */
const CHANNEL = "ch_test"
const SESSION = `${CHANNEL}|app_main::D:\\ws\\a`
const OTHER = `${CHANNEL}|app_main::D:\\ws\\b`
const MAX_ITEMS = 1000

let dir: string
let store: string
let src: string
let chat: AppChat
const chats: AppChat[] = []

function open(): AppChat {
  const c = new AppChat(store, () => {})
  chats.push(c)
  return c
}

/** 一张「源图」：放在会话目录之外（相当于临时目录里的粘贴图 / AI 生成的图） */
function makeImage(name: string, content = "image-bytes"): string {
  const p = path.join(src, name)
  fs.writeFileSync(p, content)
  return p
}

/** 指定大小的稀疏文件，不真占盘 */
function makeSparse(name: string, bytes: number): string {
  const p = path.join(src, name)
  const fd = fs.openSync(p, "w")
  fs.ftruncateSync(fd, bytes)
  fs.closeSync(fd)
  return p
}

/** 通道目录里所有会话图片目录 */
function imageDirs(): string[] {
  const channelDir = path.join(store, CHANNEL)
  if (!fs.existsSync(channelDir)) return []
  return fs.readdirSync(channelDir).filter((n) => n.endsWith(".images")).map((n) => path.join(channelDir, n))
}

const filesIn = (d: string): string[] => (fs.existsSync(d) ? fs.readdirSync(d) : [])

function jsonlFile(): string {
  const channelDir = path.join(store, CHANNEL)
  return path.join(channelDir, fs.readdirSync(channelDir).find((n) => n.endsWith(".jsonl"))!)
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "app-chat-images-"))
  store = path.join(dir, "store")
  src = path.join(dir, "src")
  fs.mkdirSync(src, { recursive: true })
  chat = open()
})

afterEach(() => {
  for (const c of chats.splice(0)) c.flush()
  fs.rmSync(dir, { recursive: true, force: true })
})

describe("adoptImage：发出去的图片收进会话自己的目录", () => {
  it("复制一份进会话目录：内容一致、保留原文件名和扩展名，原文件不动", () => {
    const original = makeImage("shot.PNG", "pixels")
    const kept = chat.adoptImage(SESSION, original)

    expect(kept).not.toBe(original)
    expect(imageDirs()).toHaveLength(1)
    expect(path.dirname(kept)).toBe(imageDirs()[0])
    expect(path.basename(kept)).toMatch(/^shot_[0-9a-f]{8}\.PNG$/)
    expect(fs.readFileSync(kept, "utf-8")).toBe("pixels")
    expect(fs.readFileSync(original, "utf-8")).toBe("pixels")
  })

  it("每次都是独立的一份：同一个路径重新生成后再发，旧消息里的图不能跟着变", () => {
    const original = makeImage("chart.png", "v1")
    const first = chat.adoptImage(SESSION, original)
    fs.writeFileSync(original, "v2")
    const second = chat.adoptImage(SESSION, original)

    expect(second).not.toBe(first)
    expect(fs.readFileSync(first, "utf-8")).toBe("v1")
    expect(fs.readFileSync(second, "utf-8")).toBe("v2")
  })

  it("已经在会话目录里的图不再复制（重发、改排队消息都不会越攒越多）", () => {
    const kept = chat.adoptImage(SESSION, makeImage("a.png"))
    expect(chat.adoptImage(SESSION, kept)).toBe(kept)
    expect(filesIn(imageDirs()[0])).toHaveLength(1)
  })

  it("别的会话里的图，在这个会话里算外面的图：照样复制一份", () => {
    const inOther = chat.adoptImage(OTHER, makeImage("a.png"))
    const inThis = chat.adoptImage(SESSION, inOther)
    expect(inThis).not.toBe(inOther)
    expect(imageDirs()).toHaveLength(2)
  })

  it("原文件之后被删，会话里的这份还在", () => {
    const original = makeImage("gone.png", "pixels")
    const kept = chat.adoptImage(SESSION, original)
    fs.rmSync(original)
    expect(fs.readFileSync(kept, "utf-8")).toBe("pixels")
  })

  it("文件名很长：只取前 60 个字符，不会超出系统的文件名长度", () => {
    const kept = chat.adoptImage(SESSION, makeImage(`${"a".repeat(200)}.png`))
    expect(path.basename(kept)).toMatch(/^a{60}_[0-9a-f]{8}\.png$/)
    expect(fs.existsSync(kept)).toBe(true)
  })

  it("中文文件名保留", () => {
    const kept = chat.adoptImage(SESSION, makeImage("截图.png"))
    expect(path.basename(kept)).toMatch(/^截图_[0-9a-f]{8}\.png$/)
  })

  describe("不收的情况：原路径原样返回，不挡发送，也不在磁盘上留下图片目录", () => {
    const untouched = (p: string) => {
      expect(chat.adoptImage(SESSION, p)).toBe(p)
      expect(imageDirs()).toEqual([])
    }

    it("不是图片格式", () => untouched(makeImage("notes.txt")))
    it("没有扩展名", () => untouched(makeImage("noext")))
    it("文件不存在", () => untouched(path.join(src, "missing.png")))
    it("空路径", () => untouched(""))

    it("路径是个目录", () => {
      const p = path.join(src, "folder.png")
      fs.mkdirSync(p)
      untouched(p)
    })

    it("超过 20MB", () => untouched(makeSparse("big.png", 20 * 1024 * 1024 + 1)))

    it("恰好 20MB 的收进来", () => {
      const p = makeSparse("edge.png", 20 * 1024 * 1024)
      const kept = chat.adoptImage(SESSION, p)
      expect(kept).not.toBe(p)
      expect(fs.statSync(kept).size).toBe(20 * 1024 * 1024)
    })
  })
})

describe("记录里的图片：addImage / addUser", () => {
  it("addImage（AI 发图）：记录里存的是收进去的路径，会话认它、不再认原路径", () => {
    const original = makeImage("chart.png")
    chat.addImage(SESSION, original)

    const item = chat.list(SESSION)[0]
    const kept = item.kind === "image" ? item.path : ""
    expect(kept).not.toBe("")
    expect(kept).not.toBe(original)
    expect(path.dirname(kept)).toBe(imageDirs()[0])
    expect(chat.referencesPath(SESSION, kept)).toBe(true)
    expect(chat.referencesPath(SESSION, original)).toBe(false)
  })

  it("addImage 的源文件不在：记录照旧存原路径（界面会显示「图片已被清理」，和以前一样）", () => {
    const missing = path.join(src, "missing.png")
    chat.addImage(SESSION, missing)
    const item = chat.list(SESSION)[0]
    expect(item.kind === "image" && item.path).toBe(missing)
  })

  it("用户发的图：adoptImages 之后交给 addUser，记录里是收进去的路径，顺序不变", () => {
    const kept = chat.adoptImages(SESSION, [makeImage("a.png"), makeImage("b.jpg")])
    chat.addUser(SESSION, "u1", "看图", kept)

    const user = chat.list(SESSION)[0]
    expect(user.kind === "user" && user.images).toEqual(kept)
    expect(kept.every((p) => path.dirname(p) === imageDirs()[0])).toBe(true)
    expect(kept.map((p) => path.extname(p))).toEqual([".png", ".jpg"])
  })

  it("adoptImages 里混着不能收的：能收的收，不能收的原样，位置对应", () => {
    const text = makeImage("notes.txt")
    const [a, t, m] = chat.adoptImages(SESSION, [makeImage("a.png"), text, path.join(src, "missing.png")])
    expect(path.dirname(a)).toBe(imageDirs()[0])
    expect(t).toBe(text)
    expect(m).toBe(path.join(src, "missing.png"))
  })
})

describe("图片跟着会话记录一起走", () => {
  it("清空会话：这个会话的图片目录一并删掉，别的会话不受影响", () => {
    const mine = chat.adoptImage(SESSION, makeImage("a.png"))
    chat.addUser(SESSION, "u1", "x", [mine])
    const theirs = chat.adoptImage(OTHER, makeImage("b.png"))
    chat.addUser(OTHER, "u2", "y", [theirs])
    expect(imageDirs()).toHaveLength(2)

    chat.clearSession(SESSION)

    expect(fs.existsSync(mine)).toBe(false)
    expect(fs.existsSync(path.dirname(mine))).toBe(false)
    expect(fs.existsSync(theirs)).toBe(true)
  })

  it("清空整个通道：所有会话的图片都删", () => {
    const a = chat.adoptImage(SESSION, makeImage("a.png"))
    const b = chat.adoptImage(OTHER, makeImage("b.png"))
    chat.addUser(SESSION, "u1", "x", [a])
    chat.addUser(OTHER, "u2", "y", [b])

    chat.clearChannel(CHANNEL)

    expect(fs.existsSync(a)).toBe(false)
    expect(fs.existsSync(b)).toBe(false)
    expect(imageDirs()).toEqual([])
  })

  it("删掉一条记录（撤回排队消息）：它的图片删掉，目录空了也删", () => {
    const kept = chat.adoptImage(SESSION, makeImage("a.png"))
    chat.addUser(SESSION, "u1", "x", [kept], true)

    expect(chat.removeItem(SESSION, "u1")).toBe(true)

    expect(fs.existsSync(kept)).toBe(false)
    expect(imageDirs()).toEqual([])
  })

  it("丢弃排队消息（dropQueued）也一样", () => {
    const kept = chat.adoptImage(SESSION, makeImage("a.png"))
    chat.addUser(SESSION, "u1", "x", [kept], true)
    expect(chat.dropQueued(SESSION)).toBe(1)
    expect(fs.existsSync(kept)).toBe(false)
  })

  it("删掉一条记录时，别的记录还引用着的图不能删", () => {
    const shared = chat.adoptImage(SESSION, makeImage("a.png"))
    const own = chat.adoptImage(SESSION, makeImage("b.png"))
    chat.addUser(SESSION, "u1", "x", [shared, own])
    chat.addUser(SESSION, "u2", "y", [shared])

    chat.removeItem(SESSION, "u1")
    expect(fs.existsSync(shared)).toBe(true)
    expect(fs.existsSync(own)).toBe(false)

    chat.removeItem(SESSION, "u2")
    expect(fs.existsSync(shared)).toBe(false)
  })

  it("删记录不会去删会话目录以外的文件（记录里存的是没能收进来的原路径）", () => {
    const outside = makeImage("mine.png")
    chat.addUser(SESSION, "u1", "x", [outside])
    chat.removeItem(SESSION, "u1")
    expect(fs.existsSync(outside)).toBe(true)
  })

  it("记录超过上限被挤出去时，最老那条的图片一并删，新的不动", () => {
    const old = chat.adoptImage(SESSION, makeImage("old.png"))
    chat.addUser(SESSION, "u-old", "最早", [old])
    const fresh = chat.adoptImage(SESSION, makeImage("fresh.png"))
    chat.addUser(SESSION, "u-fresh", "最近", [fresh])
    for (let i = 0; i < MAX_ITEMS - 1; i++) chat.addText(SESSION, `t${i}`)

    expect(chat.list(SESSION)).toHaveLength(MAX_ITEMS)
    expect(chat.list(SESSION).some((i) => i.id === "u-old")).toBe(false)
    expect(fs.existsSync(old)).toBe(false)
    expect(fs.existsSync(fresh)).toBe(true)
  })

  it("一直聊下去：旧记录被挤出后，会话图片目录里只剩还在记录里的图", () => {
    for (let i = 0; i < 5; i++) {
      const kept = chat.adoptImage(SESSION, makeImage(`p${i}.png`))
      chat.addUser(SESSION, `u${i}`, `第${i}张`, [kept])
    }
    for (let i = 0; i < MAX_ITEMS - 2; i++) chat.addText(SESSION, `t${i}`) // 共 1003 条，最早 3 条被挤出

    const referenced = chat.list(SESSION).flatMap((it) => (it.kind === "user" ? it.images ?? [] : []))
    expect(referenced).toHaveLength(2)
    expect(filesIn(imageDirs()[0]).sort()).toEqual(referenced.map((p) => path.basename(p)).sort())
  })
})

describe("重启之后", () => {
  it("记录和图片都在，会话认这些图，原文件没了也不影响", () => {
    const original = makeImage("a.png", "pixels")
    const kept = chat.adoptImage(SESSION, original)
    chat.addUser(SESSION, "u1", "看图", [kept])
    chat.addImage(SESSION, makeImage("b.png", "more"))
    chat.flush()
    fs.rmSync(original)

    const reopened = open()
    const items = reopened.list(SESSION)
    const userImages = items.flatMap((i) => (i.kind === "user" ? i.images ?? [] : []))
    const aiImages = items.flatMap((i) => (i.kind === "image" ? [i.path] : []))
    expect(userImages).toEqual([kept])
    expect(aiImages).toHaveLength(1)
    for (const p of [...userImages, ...aiImages]) {
      expect(fs.existsSync(p)).toBe(true)
      expect(reopened.referencesPath(SESSION, p)).toBe(true)
    }
  })

  it("收进了图、但记录没来得及落盘就退出：重启后图片目录里没人要的图被清掉", () => {
    chat.adoptImage(SESSION, makeImage("lost.png"))
    expect(imageDirs()).toHaveLength(1)

    open().list(SESSION)

    expect(imageDirs()).toEqual([])
  })

  it("清理残留只清没被记录引用的，记录引用着的不动", () => {
    const used = chat.adoptImage(SESSION, makeImage("used.png"))
    const orphan = chat.adoptImage(SESSION, makeImage("orphan.png"))
    chat.addUser(SESSION, "u1", "x", [used])
    chat.flush()

    open().list(SESSION)

    expect(fs.existsSync(used)).toBe(true)
    expect(fs.existsSync(orphan)).toBe(false)
  })

  it("记录里路径写法不规整（带 ..）也认得是同一张图，不会被当成残留", () => {
    const used = chat.adoptImage(SESSION, makeImage("used.png"))
    const dirName = path.basename(path.dirname(used))
    // 不能用 path.join：它会把 .. 规整掉；这里要的是记录里原样带着 .. 的写法
    const roundabout = `${path.dirname(used)}${path.sep}..${path.sep}${dirName}${path.sep}${path.basename(used)}`
    expect(roundabout).not.toBe(used)
    chat.addUser(SESSION, "u1", "x", [roundabout])
    chat.flush()

    open().list(SESSION)

    expect(fs.existsSync(used)).toBe(true)
  })

  it("别的会话的图片目录不会被误清", () => {
    const mine = chat.adoptImage(SESSION, makeImage("a.png"))
    const theirs = chat.adoptImage(OTHER, makeImage("b.png"))
    chat.addUser(SESSION, "u1", "x", [mine])
    chat.addUser(OTHER, "u2", "y", [theirs])
    chat.flush()

    const reopened = open()
    reopened.list(SESSION)

    expect(fs.existsSync(theirs)).toBe(true)
    reopened.list(OTHER)
    expect(fs.existsSync(theirs)).toBe(true)
  })

  it("记录没有图片的会话：载入时不会凭空建出图片目录", () => {
    chat.addText(SESSION, "你好")
    chat.flush()
    open().list(SESSION)
    expect(imageDirs()).toEqual([])
  })
})

describe("记录占用", () => {
  it("usageBytes 把会话里的图片算进去", () => {
    const kept = chat.adoptImage(SESSION, makeImage("a.png", "x".repeat(5000)))
    chat.addUser(SESSION, "u1", "x", [kept])
    chat.flush()

    expect(chat.usageBytes(CHANNEL)).toBe(fs.statSync(jsonlFile()).size + 5000)
  })

  it("清空会话后占用回落，图片不再计入", () => {
    const kept = chat.adoptImage(SESSION, makeImage("a.png", "x".repeat(5000)))
    chat.addUser(SESSION, "u1", "x", [kept])
    chat.flush()
    chat.clearSession(SESSION)
    expect(chat.usageBytes(CHANNEL)).toBe(0)
  })

  it("没有记录的通道是 0", () => {
    expect(chat.usageBytes("app_none")).toBe(0)
  })
})
