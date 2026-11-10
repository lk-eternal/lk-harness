import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it, vi } from "vitest"
import { DirSheet, ModelRow, ModelSheet, PairSheet, QuickModelCard, SessionDrawer } from "../src/mobile/MobileModals"
import type { MobileChatTab, RouteStatus } from "../src/mobile/api"

const route: RouteStatus = { connected: true, activeUrl: "http://x", routeType: "lan" }
const noop = vi.fn()

const tab = (over: Partial<MobileChatTab> = {}): MobileChatTab => ({
  sessionKey: "chan::C:\\work\\demo",
  label: "demo",
  kind: "dir",
  running: false,
  current: false,
  removable: true,
  ...over,
})

const dirProps = (over: Partial<Parameters<typeof DirSheet>[0]> = {}): Parameters<typeof DirSheet>[0] => ({
  open: true, onClose: noop, options: [], currentDir: undefined, canRebind: true, onSelect: noop, ...over,
})

describe("底部弹层都带可拖动的抓手", () => {
  it("模型弹层", () => {
    const html = renderToStaticMarkup(
      createElement(ModelSheet, {
        open: true, onClose: noop, baseUrl: "", token: "", resources: [], quickModels: [],
        switching: false, onSelect: noop,
      }),
    )
    expect((html.match(/data-sheet-grip/g) ?? []).length).toBe(1)
  })

  it("目录弹层", () => {
    const html = renderToStaticMarkup(createElement(DirSheet, dirProps()))
    expect((html.match(/data-sheet-grip/g) ?? []).length).toBe(1)
  })

  it("配对弹层", () => {
    const html = renderToStaticMarkup(
      createElement(PairSheet, {
        open: true, onClose: noop, config: { pubUrl: "", lanUrl: "", token: "" }, route,
        reconnecting: false, onSaveAndConnect: noop,
      }),
    )
    expect((html.match(/data-sheet-grip/g) ?? []).length).toBe(1)
  })

  it("关着的时候什么都不渲染", () => {
    const html = renderToStaticMarkup(createElement(DirSheet, dirProps({ open: false })))
    expect(html).toBe("")
  })

  it("抓手是触摸专用的拖动区：不触发浏览器滚动，高度足够手指按住", () => {
    const html = renderToStaticMarkup(createElement(DirSheet, dirProps()))
    const grip = /<div data-sheet-grip[^>]*>/.exec(html)?.[0] ?? ""
    expect(grip).toContain("touch-none")
    expect(grip).toContain("py-2.5")
  })
})

describe("目录弹层：选工作目录（目录不是会话的身份，多个会话可以共用）", () => {
  const options = [
    { name: "lk", dir: "D:\\ws\\lk" },
    { name: "proj-a", dir: "D:\\work\\proj-a" },
  ]
  const buttons = (html: string) => html.match(/<button[^>]*>(?:(?!<\/button>).)*<\/button>/gs)?.filter((b) => b.includes("font-mono")) ?? []

  it("每个目录一项，显示目录名和完整路径；只有当前目录打勾（路径写法不同也算同一个）", () => {
    const items = buttons(renderToStaticMarkup(createElement(DirSheet, dirProps({ options, currentDir: "d:/work/proj-a/" }))))
    expect(items).toHaveLength(2)
    expect(items[0]).toContain(">lk<")
    expect(items[0]).toContain("D:\\ws\\lk")
    expect(items[0]).not.toContain("aria-current")
    expect(items[1]).toContain(">proj-a<")
    expect(items[1]).toContain('aria-current="true"')
  })

  it("还没选目录的会话：没有哪一项打勾", () => {
    expect(renderToStaticMarkup(createElement(DirSheet, dirProps({ options })))).not.toContain("aria-current")
  })

  it("会话还没开始：提示是给这个会话选目录；已经开始：提示选目录会新开一个会话", () => {
    expect(renderToStaticMarkup(createElement(DirSheet, dirProps({ options, canRebind: true })))).toContain("为这个会话选择工作目录")
    const started = renderToStaticMarkup(createElement(DirSheet, dirProps({ options, canRebind: false })))
    expect(started).toContain("新开一个会话")
    expect(started).not.toContain("为这个会话选择工作目录")
  })

  it("电脑上还没有用过的目录：说明要先在电脑端选一个（手机浏览不了电脑的文件）", () => {
    const html = renderToStaticMarkup(createElement(DirSheet, dirProps()))
    expect(html).toContain("请先在电脑端选一个")
    expect(buttons(html)).toHaveLength(0)
  })
})

describe("模型弹层：同一个模型的几档推理参数", () => {
  const MODEL = "claude-sonnet-5-5-300k"
  const HIGH = JSON.stringify([{ id: "effort", value: "high" }])
  const XHIGH = JSON.stringify([{ id: "effort", value: "xhigh" }])
  // 两张卡片只差名字末尾的档位——原来被省略号截断，看起来一模一样，而且两张都打勾
  const quick = [
    { model: MODEL, modelParams: HIGH, label: `${MODEL}-high`, resourceId: "r1" },
    { model: MODEL, modelParams: XHIGH, label: `${MODEL}-xhigh`, resourceId: "r1" },
  ]
  const resources = [{ id: "r1", name: "LK", type: "sdk" }] as never
  const render = (over: Record<string, unknown> = {}) =>
    renderToStaticMarkup(
      createElement(ModelSheet, {
        open: true, onClose: noop, baseUrl: "", token: "", resources, quickModels: quick,
        currentResourceId: "r1", currentModel: MODEL, currentParams: XHIGH,
        switching: false, onSelect: noop, ...over,
      }),
    )
  const cards = (html: string) => html.match(/<button[^>]*>(?:(?!<\/button>).)*<\/button>/gs)?.filter((b) => b.includes("data-model-name")) ?? []

  it("只有当前这一档的卡片打勾", () => {
    const html = render()
    const c = cards(html)
    expect(c.length).toBe(2)
    expect(c.filter((b) => b.includes('aria-current="true"')).length).toBe(1)
    expect(c.find((b) => b.includes('aria-current="true"'))).toContain(`${MODEL}-xhigh`)
    expect(c.find((b) => !b.includes('aria-current="true"'))).toContain(`${MODEL}-high<`)
  })

  it("换一档当前值，打勾的跟着换", () => {
    const c = cards(render({ currentParams: HIGH }))
    expect(c.find((b) => b.includes('aria-current="true"'))).toContain(`${MODEL}-high<`)
  })

  it("当前是不带参数的同名模型：两档都不打勾", () => {
    expect(cards(render({ currentParams: undefined })).some((b) => b.includes('aria-current="true"'))).toBe(false)
  })

  it("名字完整显示：两张卡片的名字都在，且不用省略号截断（可以换行）", () => {
    const html = render()
    expect(html).toContain(`${MODEL}-high<`)
    expect(html).toContain(`${MODEL}-xhigh<`)
    for (const b of cards(html)) {
      const name = /<span data-model-name[^>]*>/.exec(b)?.[0] ?? ""
      expect(name).not.toContain("truncate")
      expect(name).toContain("break-words")
    }
  })

  it("卡片没有名字时按「模型 + 参数」显示，带上档位", () => {
    const html = render({ quickModels: [{ model: MODEL, modelParams: HIGH, resourceId: "r1" }] })
    expect(html).toContain(`${MODEL}-high<`)
  })

  it("点卡片：模型、参数、供应商一并交给选择回调", () => {
    const onPick = vi.fn()
    const el = QuickModelCard({ qm: quick[1], current: false, resourceName: "LK", onPick }) as { props: { onClick: () => void } }
    el.props.onClick()
    expect(onPick).toHaveBeenCalledWith({ model: MODEL, modelParams: XHIGH, resourceId: "r1" })
  })

  it("列表里的一行：当前档位打勾，名字可换行；id 和名字不同时再显示一行 id", () => {
    const row = { id: MODEL, label: `${MODEL}-xhigh`, params: XHIGH }
    const on = renderToStaticMarkup(createElement(ModelRow, { row, resourceId: "r1", current: true, onPick: noop }))
    const off = renderToStaticMarkup(createElement(ModelRow, { row, resourceId: "r1", current: false, onPick: noop }))
    expect(on).toContain('aria-current="true"')
    expect(off).not.toContain("aria-current")
    expect(on).toContain(`${MODEL}-xhigh`)
    expect(on).toContain("break-words")
    expect(on).not.toContain("truncate")
    expect((on.match(new RegExp(`>${MODEL}<`, "g")) ?? []).length).toBe(1)
  })

  it("点列表里的一行：带上这一行的推理参数和这一列的供应商（原来参数丢了，选中的是不带参数的默认档）", () => {
    const onPick = vi.fn()
    const el = ModelRow({ row: { id: MODEL, label: `${MODEL}-xhigh`, params: XHIGH }, resourceId: "r1", current: false, onPick }) as { props: { onClick: () => void } }
    el.props.onClick()
    expect(onPick).toHaveBeenCalledTimes(1)
    expect(onPick).toHaveBeenCalledWith({ model: MODEL, modelParams: XHIGH, resourceId: "r1" })
  })

  it("没有参数的行不带 modelParams", () => {
    const onPick = vi.fn()
    const el = ModelRow({ row: { id: "gpt-x" }, resourceId: "r2", current: false, onPick }) as { props: { onClick: () => void } }
    el.props.onClick()
    expect(onPick).toHaveBeenCalledWith({ model: "gpt-x", resourceId: "r2" })
  })
})

describe("会话抽屉里的删除按钮", () => {
  const render = (tabs: MobileChatTab[]) =>
    renderToStaticMarkup(
      createElement(SessionDrawer, {
        open: true, onClose: noop, hostname: "pc", route,
        views: [{ channelId: "c1", name: "通道", tabs }],
        selected: null, sessionName: (t: MobileChatTab) => t.label, sessionStatus: () => "idle",
        activeAt: () => undefined, usageBytes: null, onSelect: noop, onNewTemp: noop,
        onDelete: noop, onClearAll: noop, onOpenPair: noop,
      }),
    )

  it("触控区至少 44px 见方，并带读屏名称", () => {
    const html = render([tab()])
    const btn = /<button[^>]*aria-label="删除会话"[^>]*>/.exec(html)?.[0] ?? ""
    expect(btn).not.toBe("")
    expect(btn).toContain("h-11")
    expect(btn).toContain("w-11")
  })

  it("不可删除的会话不出现删除按钮", () => {
    expect(render([tab({ removable: false })])).not.toContain("删除会话")
    expect(render([tab({ kind: "project" })])).not.toContain("删除会话")
  })
})

describe("会话抽屉里的会话副标题：工作目录", () => {
  const TEMP = "chan::C:\\Users\\me\\AppData\\Roaming\\lk-harness\\workspaces\\temp_1730000000000"
  const render = (tabs: MobileChatTab[]) =>
    renderToStaticMarkup(
      createElement(SessionDrawer, {
        open: true, onClose: noop, hostname: "pc", route,
        views: [{ channelId: "c1", name: "通道", tabs }],
        selected: null, sessionName: () => "会话名", sessionStatus: () => "idle",
        activeAt: () => undefined, usageBytes: null, onSelect: noop, onNewTemp: noop,
        onDelete: noop, onClearAll: noop, onOpenPair: noop,
      }),
    )

  it("临时会话选了目录：副标题是那个目录名（原来一律写「临时对话」）", () => {
    const html = render([tab({ sessionKey: TEMP, boundDir: "D:\\work\\proj-a" })])
    expect(html).toContain(">proj-a<")
    expect(html).not.toContain("临时对话")
  })

  it("临时会话没选目录：仍是「临时对话」", () => {
    expect(render([tab({ sessionKey: TEMP })])).toContain("临时对话")
  })

  it("常用目录会话：副标题是键里的目录名", () => {
    expect(render([tab({ sessionKey: "chan::D:\\ws\\lk" })])).toContain(">lk<")
  })
})
