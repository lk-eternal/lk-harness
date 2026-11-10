import { afterEach, describe, expect, it, vi } from "vitest"
import { checkMobilePreviewPaths, createMobilePreviewHost, openMobilePreview } from "../src/mobile/api"
import { PREVIEW_MAX_DOCUMENT_BYTES, documentTooLargeMessage } from "../src/shared/preview-types"

const BASE = "http://192.168.1.5:19529/"
const TOKEN = "bearer-token"
const FILE_TOKEN = "0123456789abcdef01234567"

interface Call { url: string; init?: RequestInit }

/** 把 fetch 换成按顺序回放的假实现，并记录每次调用 */
function stubFetch(...responses: (Response | Error)[]) {
  const calls: Call[] = []
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, init })
    const next = responses.shift()
    if (!next) throw new Error("没有预设的响应了")
    if (next instanceof Error) throw next
    return next
  }))
  return calls
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })
const sent = (c: Call) => JSON.parse(String(c.init?.body)) as Record<string, unknown>
const headersOf = (c: Call) => c.init?.headers as Record<string, string>

afterEach(() => { vi.unstubAllGlobals() })

const OPENED = { ok: true, token: FILE_TOKEN, url: `/api/mobile/pv/${FILE_TOKEN}/a.docx`, name: "a.docx", size: 10, mtimeMs: 1, kind: "docx" }

describe("openMobilePreview", () => {
  it("POST 到 preview-open，带 Bearer 令牌、会话和路径；url 补全成完整地址（地址末尾的斜杠不重复）", async () => {
    const calls = stubFetch(json(OPENED))
    const r = await openMobilePreview(BASE, TOKEN, "app::s1", "D:\\work\\a.docx")
    expect(calls).toHaveLength(1)
    expect(calls[0].url).toBe("http://192.168.1.5:19529/api/mobile/preview-open")
    expect(calls[0].init?.method).toBe("POST")
    expect(headersOf(calls[0]).Authorization).toBe("Bearer bearer-token")
    expect(sent(calls[0])).toEqual({ sessionKey: "app::s1", path: "D:\\work\\a.docx" })
    expect(r).toEqual({ ...OPENED, url: `http://192.168.1.5:19529/api/mobile/pv/${FILE_TOKEN}/a.docx` })
  })

  it("电脑端拒绝（没权限、文件不存在）：原样返回原因", async () => {
    stubFetch(json({ ok: false, error: "文件不存在，可能已被移动或删除" }))
    expect(await openMobilePreview(BASE, TOKEN, "s", "x")).toEqual({ ok: false, error: "文件不存在，可能已被移动或删除" })
  })

  it("旧版电脑端没有这个接口（未知接口）：换成能看懂的升级提示", async () => {
    stubFetch(json({ ok: false, error: "未知接口" }, 404))
    const r = await openMobilePreview(BASE, TOKEN, "s", "x")
    expect(r.ok).toBe(false)
    expect(!r.ok && r.error).toContain("升级")
  })

  it("断网：返回失败而不是抛出", async () => {
    stubFetch(new TypeError("Failed to fetch"))
    const r = await openMobilePreview(BASE, TOKEN, "s", "x")
    expect(r).toEqual({ ok: false, error: "无法连接到电脑端，请检查网络" })
  })
})

describe("checkMobilePreviewPaths", () => {
  it("原样返回电脑端的结果，一一对应", async () => {
    const calls = stubFetch(json({ ok: true, paths: ["D:\\w\\a.ts", null, "D:\\w\\b.md"] }))
    const r = await checkMobilePreviewPaths(BASE, TOKEN, "app::s1", ["a.ts", "nope.ts", "b.md"])
    expect(r).toEqual(["D:\\w\\a.ts", null, "D:\\w\\b.md"])
    expect(calls[0].url).toBe("http://192.168.1.5:19529/api/mobile/preview-check")
    expect(sent(calls[0])).toEqual({ sessionKey: "app::s1", paths: ["a.ts", "nope.ts", "b.md"] })
  })

  it("失败（旧版电脑端、断网、返回异常）一律当都不能预览，长度对得上", async () => {
    stubFetch(json({ ok: false, error: "未知接口" }, 404))
    expect(await checkMobilePreviewPaths(BASE, TOKEN, "s", ["a", "b"])).toEqual([null, null])
    stubFetch(new TypeError("offline"))
    expect(await checkMobilePreviewPaths(BASE, TOKEN, "s", ["a", "b", "c"])).toEqual([null, null, null])
    stubFetch(json({ ok: true }))
    expect(await checkMobilePreviewPaths(BASE, TOKEN, "s", ["a"])).toEqual([null])
  })
})

describe("createMobilePreviewHost", () => {
  const host = createMobilePreviewHost(BASE, TOKEN)

  it("fileText：POST preview-text，body 里是文件令牌", async () => {
    const calls = stubFetch(json({ ok: true, text: "hi", encoding: "utf-8", size: 2, truncated: false }))
    expect(await host.fileText(FILE_TOKEN)).toEqual({ ok: true, text: "hi", encoding: "utf-8", size: 2, truncated: false })
    expect(calls[0].url).toBe("http://192.168.1.5:19529/api/mobile/preview-text")
    expect(sent(calls[0])).toEqual({ token: FILE_TOKEN })
    expect(headersOf(calls[0]).Authorization).toBe("Bearer bearer-token")
  })

  it("fileText：令牌失效的提示原样给到界面；旧版电脑端给升级提示", async () => {
    stubFetch(json({ ok: false, error: "预览已失效，请重新打开" }))
    expect(await host.fileText(FILE_TOKEN)).toEqual({ ok: false, error: "预览已失效，请重新打开" })
    stubFetch(json({ ok: false, error: "未知接口" }, 404))
    const r = await host.fileText(FILE_TOKEN)
    expect(!r.ok && r.error).toContain("升级")
  })

  it("fileZip：POST preview-zip", async () => {
    const listing = { ok: true, size: 99, entries: [], total: 0 }
    const calls = stubFetch(json(listing))
    expect(await host.fileZip(FILE_TOKEN)).toEqual(listing)
    expect(calls[0].url).toBe("http://192.168.1.5:19529/api/mobile/preview-zip")
    expect(sent(calls[0])).toEqual({ token: FILE_TOKEN })
  })

  describe("fileBytes", () => {
    it("GET 预览链接取整个文件；链接里是文件令牌，请求不带 Authorization", async () => {
      const calls = stubFetch(new Response(new Uint8Array([1, 2, 3]), { status: 200, headers: { "content-length": "3" } }))
      const r = await host.fileBytes(FILE_TOKEN)
      expect(r).toEqual({ ok: true, bytes: new Uint8Array([1, 2, 3]) })
      expect(calls[0].url).toBe(`http://192.168.1.5:19529/api/mobile/pv/${FILE_TOKEN}/file`)
      expect(calls[0].init?.headers).toBeUndefined()
    })

    it("403（令牌过期或不认识）：提示重新打开", async () => {
      stubFetch(new Response("", { status: 403 }))
      expect(await host.fileBytes(FILE_TOKEN)).toEqual({ ok: false, error: "预览已失效，请重新打开" })
    })

    it("其他状态码：带上状态码", async () => {
      stubFetch(new Response("", { status: 404 }))
      expect(await host.fileBytes(FILE_TOKEN)).toEqual({ ok: false, error: "读取文件失败（HTTP 404）" })
    })

    it("Content-Length 超过上限：不读内容，用和电脑端一样的说明", async () => {
      const size = PREVIEW_MAX_DOCUMENT_BYTES + 1
      const res = new Response(new Uint8Array([1]), { status: 200, headers: { "content-length": String(size) } })
      const arrayBuffer = vi.spyOn(res, "arrayBuffer")
      stubFetch(res)
      expect(await host.fileBytes(FILE_TOKEN)).toEqual({ ok: false, error: documentTooLargeMessage(size) })
      expect(arrayBuffer).not.toHaveBeenCalled()
    })

    it("刚好等于上限可以读", async () => {
      const res = new Response(new Uint8Array([9]), { status: 200, headers: { "content-length": String(PREVIEW_MAX_DOCUMENT_BYTES) } })
      stubFetch(res)
      expect((await host.fileBytes(FILE_TOKEN)).ok).toBe(true)
    })

    it("断网、读取中途断开：返回失败而不是抛出", async () => {
      stubFetch(new TypeError("Failed to fetch"))
      expect(await host.fileBytes(FILE_TOKEN)).toEqual({ ok: false, error: "无法连接到电脑端，请检查网络" })
      const broken = new Response(new Uint8Array([1]), { status: 200 })
      vi.spyOn(broken, "arrayBuffer").mockRejectedValue(new TypeError("terminated"))
      stubFetch(broken)
      expect(await host.fileBytes(FILE_TOKEN)).toEqual({ ok: false, error: "读取文件失败，连接中断" })
    })
  })
})
