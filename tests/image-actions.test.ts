import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"
import { ImageActions } from "../src/renderer/components/chat/ItemViews"
import { LIGHTBOX_ICON_SIZE, LIGHTBOX_TOOL_BUTTON } from "../src/renderer/components/chat/ImageLightbox"

/** 图片的「复制 / 另存为」：缩略图上悬浮的是小按钮；放进放大查看器时要和查看器自己的缩放、关闭按钮一样大 */

const render = (large?: boolean) => renderToStaticMarkup(createElement(ImageActions, { path: "C:/x/a.png", large }))
const buttons = (html: string) => [...html.matchAll(/<button\b[^>]*>.*?<\/button>/g)].map((m) => m[0])
const classOf = (button: string) => /class="([^"]*)"/.exec(button)?.[1]
const iconWidth = (button: string) => /<svg[^>]*\swidth="(\d+)"/.exec(button)?.[1]

describe("ImageActions", () => {
  it("放大查看器里（large）：两个按钮的样式和图标大小，与查看器自己的工具按钮是同一份", () => {
    const bs = buttons(render(true))
    expect(bs).toHaveLength(2)
    for (const b of bs) {
      expect(classOf(b)).toBe(LIGHTBOX_TOOL_BUTTON)
      expect(iconWidth(b)).toBe(String(LIGHTBOX_ICON_SIZE))
    }
  })

  it("查看器里按钮之间的间距和旁边的关闭按钮一致（gap-2）", () => {
    expect(render(true)).toContain('<div class="flex gap-2">')
  })

  it("缩略图上悬浮的（默认）：仍是小按钮，没被放大", () => {
    const bs = buttons(render())
    expect(bs).toHaveLength(2)
    for (const b of bs) {
      expect(classOf(b)).toContain("p-1 ")
      expect(classOf(b)).not.toContain("rounded-full")
      expect(iconWidth(b)).toBe("12")
    }
    expect(render()).toContain('<div class="flex gap-1">')
  })

  it("两种场景都是「复制图片」「另存为」，顺序不变", () => {
    for (const large of [true, false]) {
      const bs = buttons(render(large))
      expect(bs[0]).toContain('title="复制图片"')
      expect(bs[1]).toContain('title="另存为"')
    }
  })

  it("查看器的按钮形状：圆形、p-2.5、图标 18", () => {
    expect(LIGHTBOX_TOOL_BUTTON).toContain("rounded-full")
    expect(LIGHTBOX_TOOL_BUTTON).toContain("p-2.5")
    expect(LIGHTBOX_ICON_SIZE).toBe(18)
  })
})
