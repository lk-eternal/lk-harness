import { describe, expect, it } from "vitest"
import { readFileSync } from "node:fs"
import {
  APP_CHAT_IMAGE_MIME,
  APP_CHAT_IMAGE_MISSING,
  MAX_APP_CHAT_IMAGE_BYTES,
  appChatImageMime,
  imageFailureView,
} from "../src/shared/app-chat-image"

describe("appChatImageMime：按扩展名认图片（界面、主进程、daemon 共用）", () => {
  it("支持的格式，不分大小写", () => {
    expect(appChatImageMime("C:\\a\\b.png")).toBe("image/png")
    expect(appChatImageMime("/tmp/x.JPG")).toBe("image/jpeg")
    expect(appChatImageMime("x.jpeg")).toBe("image/jpeg")
    expect(appChatImageMime("x.GIF")).toBe("image/gif")
    expect(appChatImageMime("x.webp")).toBe("image/webp")
    expect(appChatImageMime("x.bmp")).toBe("image/bmp")
  })

  it("别的格式、没有扩展名、扩展名只在目录名里：都不是", () => {
    expect(appChatImageMime("x.txt")).toBeUndefined()
    expect(appChatImageMime("x.svg")).toBeUndefined()
    expect(appChatImageMime("noext")).toBeUndefined()
    expect(appChatImageMime("dir.png/file")).toBeUndefined()
    expect(appChatImageMime("dir.png\\file")).toBeUndefined()
    expect(appChatImageMime("")).toBeUndefined()
  })

  it("只有扩展名的隐藏文件不算（和 path.extname 一致）", () => {
    expect(appChatImageMime(".png")).toBeUndefined()
    expect(appChatImageMime("a/.png")).toBeUndefined()
  })

  it("表和上限就是主进程读图用的那份", () => {
    expect(Object.keys(APP_CHAT_IMAGE_MIME).sort()).toEqual([".bmp", ".gif", ".jpeg", ".jpg", ".png", ".webp"])
    expect(MAX_APP_CHAT_IMAGE_BYTES).toBe(20 * 1024 * 1024)
  })
})

describe("imageFailureView：读不出来时占位上怎么说", () => {
  const FILE = "C:\\Users\\x\\AppData\\Local\\Temp\\lk-harness-images\\a.png"

  it("文件已经不在磁盘上：说「已被清理」，悬停解释并给出原路径", () => {
    const v = imageFailureView(APP_CHAT_IMAGE_MISSING, FILE)
    expect(v.label).toBe("图片已被清理")
    expect(v.hint).toContain("已不在磁盘上")
    expect(v.hint).toContain(FILE)
  })

  it("别的原因：照实说，不冒充「被清理」", () => {
    const tooBig = imageFailureView("图片超过 20MB", FILE)
    expect(tooBig.label).toBe("图片不可用")
    expect(tooBig.hint).toBe(`图片超过 20MB：${FILE}`)
    expect(imageFailureView("不是图片文件", FILE).label).toBe("图片不可用")
    expect(imageFailureView("EACCES: permission denied", FILE).label).toBe("图片不可用")
  })

  it("没给原因：也有提示", () => {
    expect(imageFailureView(undefined, FILE)).toEqual({ label: "图片不可用", hint: `读取失败：${FILE}` })
    expect(imageFailureView("", FILE).hint).toBe(`读取失败：${FILE}`)
  })
})

// 仓库没有 DOM 测试环境，界面这处接线靠读源码守住（和 flow-hub-status.test.ts 一样先统一换行，CRLF 检出时也能过）
describe("缩略图占位的接线", () => {
  const source = readFileSync("src/renderer/components/chat/ItemViews.tsx", "utf8").replace(/\r\n/g, "\n")

  it("读图失败的原因要一路传到占位，不能只剩一个 failed", () => {
    expect(source).toContain("setState({ failed: true, error: r.error })")
    expect(source).toContain("const { url, failed, error } = useLocalImage(path)")
    expect(source).toContain("imageFailureView(error, path)")
  })

  it("占位上的字和悬停提示都来自 imageFailureView，不再写死「图片不可用」", () => {
    expect(source).toContain("title={view.hint}")
    expect(source).toContain("{view.label}")
    expect(source).not.toContain("图片不可用")
  })
})
