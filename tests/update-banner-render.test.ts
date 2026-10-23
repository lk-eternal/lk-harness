import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it, vi } from "vitest"
import UpdateBanner from "../src/mobile/UpdateBanner"

const update = { version: "1.1.3", apkUrl: "https://example.com/a.apk", releaseUrl: "https://example.com/r" }

describe("UpdateBanner", () => {
  it("显示新旧版本号和两个操作，且只占一行", () => {
    const html = renderToStaticMarkup(
      createElement(UpdateBanner, { update, currentVersion: "1.1.2", onUpdate: vi.fn(), onDismiss: vi.fn() }),
    )
    expect(html).toContain("发现新版本")
    expect(html).toContain("v1.1.3")
    expect(html).toContain("当前 v1.1.2")
    expect(html).toContain("下载更新")
    expect(html).toContain("忽略")
    // 单行：文案截断而不是换行，容器不允许 flex-wrap
    expect(html).toContain("truncate")
    expect(html).not.toContain("flex-wrap")
    expect((html.match(/<button/g) ?? []).length).toBe(2)
  })
})
