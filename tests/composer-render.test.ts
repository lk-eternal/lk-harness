import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { afterEach, describe, expect, it, vi } from "vitest"
import Composer from "../src/renderer/components/chat/Composer"
import { composerDraftKey, composerDrafts, discardComposerDraft } from "../src/renderer/components/chat/composer-drafts"

const A = "app:main::D:\\proj\\a"
const B = "app:main::D:\\proj\\b"

function render(draftKey: string | null): string {
  return renderToStaticMarkup(
    createElement(Composer, {
      draftKey,
      disabled: draftKey === null,
      busy: false,
      onSend: vi.fn(),
      onStop: vi.fn(),
      onError: vi.fn(),
    }),
  )
}

afterEach(() => {
  discardComposerDraft(A)
  discardComposerDraft(B)
})

describe("Composer 的草稿按会话分开", () => {
  it("A 会话里没发送的文字，在 B 会话（含新建的会话）的输入框里是空的，切回 A 还在", () => {
    const keyA = composerDraftKey(A)
    const keyB = composerDraftKey(B)
    composerDrafts.update(keyA, (d) => ({ ...d, text: "A 里写了一半的话" }))

    expect(render(keyA)).toContain("A 里写了一半的话")
    expect(render(keyB)).not.toContain("A 里写了一半的话")
    expect(render(keyA)).toContain("A 里写了一半的话")
  })

  it("B 自己的草稿只在 B 显示", () => {
    composerDrafts.update(composerDraftKey(A), (d) => ({ ...d, text: "草稿-A" }))
    composerDrafts.update(composerDraftKey(B), (d) => ({ ...d, text: "草稿-B" }))

    const htmlB = render(composerDraftKey(B))
    expect(htmlB).toContain("草稿-B")
    expect(htmlB).not.toContain("草稿-A")
    // B 写了东西，A 的草稿不能被覆盖
    const htmlA = render(composerDraftKey(A))
    expect(htmlA).toContain("草稿-A")
    expect(htmlA).not.toContain("草稿-B")
  })

  it("待发送的图片也跟着会话走", () => {
    composerDrafts.update(composerDraftKey(A), (d) => ({ ...d, images: [{ path: "/tmp/a.png", preview: "blob:preview-of-a" }] }))

    expect(render(composerDraftKey(A))).toContain("blob:preview-of-a")
    expect(render(composerDraftKey(B))).not.toContain("blob:preview-of-a")
  })

  it("同一个会话的不同写法（大小写、斜杠方向）共用一份草稿", () => {
    composerDrafts.update(composerDraftKey("app:main::D:\\proj\\a"), (d) => ({ ...d, text: "共用的草稿" }))
    expect(render(composerDraftKey("app:main::d:/proj/a"))).toContain("共用的草稿")
  })

  it("会话被删除后草稿一并丢弃；没选中会话时输入框为空", () => {
    composerDrafts.update(composerDraftKey(A), (d) => ({ ...d, text: "要被丢掉的草稿" }))
    discardComposerDraft(A)

    expect(render(composerDraftKey(A))).not.toContain("要被丢掉的草稿")
    expect(render(null)).not.toContain("要被丢掉的草稿")
  })
})
