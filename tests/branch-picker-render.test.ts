import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { beforeEach, describe, expect, it, vi } from "vitest"
import type { BranchListData } from "../src/shared/git-branch"

/**
 * 分支选择的界面：桌面端输入框下方的下拉菜单、手机端的底部抽屉、输入框的「下方一行」。
 * 菜单里的数据是打开后才去读的（effect），静态渲染时读不到，所以把读数据的 hook 顶掉，直接喂它一份数据看显示。
 */

type MenuState = { data: BranchListData | null; loading: boolean; error: string; switching: string | null; choose: () => Promise<undefined> }
let menu: MenuState

vi.mock("../src/renderer/components/chat/useBranchMenu", () => ({ useBranchMenu: () => menu }))

const { BranchMenuView, default: BranchPicker } = await import("../src/renderer/components/chat/BranchPicker")
const { BranchSheet } = await import("../src/mobile/MobileModals")
const { default: Composer } = await import("../src/renderer/components/chat/Composer")

const data = (over: Partial<BranchListData> = {}): BranchListData => ({
  current: "main",
  detached: false,
  dirty: 0,
  branches: [
    { name: "main", kind: "local", current: true },
    { name: "feature/login", kind: "local" },
    { name: "hotfix", kind: "local", checkedOutAt: "D:\\work\\repo-hotfix" },
    { name: "release/1.0", kind: "remote", remote: "origin" },
  ],
  ...over,
})

const menuView = (over: Partial<Parameters<typeof BranchMenuView>[0]> = {}) =>
  renderToStaticMarkup(createElement(BranchMenuView, {
    data: data(), loading: false, error: "", switching: null, query: "", onQuery: vi.fn(), shared: 1, onPick: vi.fn(), ...over,
  }))

/** 取出所有分支行（带名字的按钮） */
const rows = (html: string) => html.match(/<button[^>]*>(?:(?!<\/button>).)*<\/button>/gs) ?? []

beforeEach(() => {
  menu = { data: null, loading: false, error: "", switching: null, choose: vi.fn(async () => undefined) }
})

describe("桌面端分支菜单", () => {
  it("本地分支一组、远程分支另一组；当前分支打勾；远程那组说明选中会创建本地分支", () => {
    const html = menuView()
    expect(html).toContain("本地分支")
    expect(html).toContain("远程 origin · 选中后创建同名本地分支")
    const r = rows(html)
    expect(r).toHaveLength(4)
    expect(r[0]).toContain(">main<")
    expect(r[0]).toContain('aria-current="true"')
    expect(r.filter((b) => b.includes("aria-current"))).toHaveLength(1)
    expect(r[3]).toContain(">release/1.0<")
  })

  it("在别的工作目录检出的分支：点不了，行内小字说在哪", () => {
    const hot = rows(menuView()).find((b) => b.includes(">hotfix<")) ?? ""
    expect(hot).toContain('disabled=""')
    expect(hot).toContain("已在「repo-hotfix」检出")
    expect(rows(menuView()).find((b) => b.includes(">feature/login<"))).not.toContain('disabled=""')
  })

  it("现在不能切（有会话在回复等）：顶部是原因，除当前分支外都点不了", () => {
    const html = menuView({ data: data({ blocked: "这个会话正在回复，等它结束再切换分支" }) })
    expect(html).toContain("这个会话正在回复，等它结束再切换分支")
    const r = rows(html)
    expect(r.filter((b) => b.includes('disabled=""'))).toHaveLength(3)
    expect(r.find((b) => b.includes(">main<"))).not.toContain('disabled=""')
  })

  it("提示：几个会话共用、有改动会带到新分支；没有就不显示", () => {
    const plain = menuView()
    expect(plain).not.toContain("个会话在用")
    expect(plain).not.toContain("个文件有改动")
    const html = menuView({ data: data({ dirty: 3 }), shared: 2 })
    expect(html).toContain("这个目录有 2 个会话在用，切换对它们都生效")
    expect(html).toContain("有 3 个文件有改动，切换时会带到新分支")
  })

  it("搜索：只留匹配的；远程分支可以按 origin/ 搜；都不匹配时说没有", () => {
    expect(rows(menuView({ query: "LOGIN" })).map((b) => /(feature\/login)/.exec(b)?.[1])).toEqual(["feature/login"])
    expect(menuView({ query: "origin/rel" })).toContain(">release/1.0<")
    const none = menuView({ query: "zzz" })
    expect(none).toContain("没有匹配的分支")
    expect(rows(none)).toHaveLength(0)
  })

  it("读取中、读取失败：显示各自的提示；没读到数据也没报错时当作还在读", () => {
    expect(menuView({ data: null, loading: true })).toContain("读取分支…")
    expect(menuView({ data: null })).toContain("读取分支…")
    const failed = menuView({ data: null, error: "项目会话的分支由项目管理，不能在这里切换" })
    expect(failed).toContain("项目会话的分支由项目管理，不能在这里切换")
    expect(failed).not.toContain("读取分支…")
  })

  it("切换中：当前正在切的那行有转圈，其它行点不了", () => {
    const html = menuView({ switching: "local::feature/login" })
    const r = rows(html)
    expect(r.find((b) => b.includes(">feature/login<"))).toContain("animate-spin")
    expect(r.find((b) => b.includes(">feature/login<"))).not.toContain('disabled=""')
    expect(r.find((b) => b.includes(">main<"))).toContain('disabled=""')
  })

  it("向上展开（输入框在页面下方）", () => {
    expect(menuView()).toContain("bottom-full")
  })
})

describe("桌面端分支按钮", () => {
  const picker = (over: Partial<Parameters<typeof BranchPicker>[0]> = {}) =>
    renderToStaticMarkup(createElement(BranchPicker, {
      sessionKey: "ch_app|app_main::D:\\work\\repo", branch: "main", shared: 1, working: false, onSwitched: vi.fn(), onError: vi.fn(), ...over,
    }))

  it("没点开时只有一个显示当前分支的按钮，不读 git、不渲染菜单", () => {
    const html = picker()
    expect(html).toContain(">main<")
    expect(html).toContain('title="切换分支"')
    expect(html).not.toContain("搜索分支")
  })

  it("游离 HEAD：黄色并提示可以切回分支", () => {
    const html = picker({ branch: "HEAD(abc1234)" })
    expect(html).toContain(">HEAD(abc1234)<")
    expect(html).toContain("text-yellow-500")
    expect(html).toContain("游离 HEAD")
  })

  it("目录里有会话在回复：按钮变灰，说明原因", () => {
    const html = picker({ working: true })
    expect(html).toContain("text-fg-faint")
    expect(html).toContain("有会话正在这个目录里回复，暂时不能切换分支")
  })
})

describe("手机端分支抽屉", () => {
  const sheet = (over: Partial<Parameters<typeof BranchSheet>[0]> = {}) =>
    renderToStaticMarkup(createElement(BranchSheet, {
      open: true, onClose: vi.fn(), baseUrl: "http://x", token: "t", sessionKey: "ch_app|app_main::D:\\work\\repo",
      shared: 1, onSwitched: vi.fn(), onError: vi.fn(), ...over,
    }))

  it("关着的时候什么都不渲染", () => {
    expect(sheet({ open: false })).toBe("")
  })

  it("打开：有抓手、标题、搜索框；没读到数据前是读取中", () => {
    const html = sheet()
    expect((html.match(/data-sheet-grip/g) ?? []).length).toBe(1)
    expect(html).toContain("切换分支")
    expect(html).toContain("搜索分支")
    expect(html).toContain("读取分支…")
  })

  it("分组、当前打勾、别处检出的点不了并说明、顶部提示", () => {
    menu = { ...menu, data: data({ dirty: 2, blocked: undefined }) }
    const html = sheet({ shared: 3 })
    expect(html).toContain("本地分支")
    expect(html).toContain("远程 origin · 选中后创建同名本地分支")
    const r = rows(html).filter((b) => b.includes("font-medium"))
    expect(r).toHaveLength(4)
    expect(r.filter((b) => b.includes('aria-current="true"'))).toHaveLength(1)
    expect(r.find((b) => b.includes(">hotfix<"))).toContain('disabled=""')
    expect(r.find((b) => b.includes(">hotfix<"))).toContain("已在「repo-hotfix」检出")
    expect(html).toContain("这个目录有 3 个会话在用，切换对它们都生效")
    expect(html).toContain("有 2 个文件有改动")
  })

  it("不能切的时候：原因在顶部，其它分支点不了", () => {
    menu = { ...menu, data: data({ blocked: "有 1 个会话正在这个目录里工作，等它们结束再切换分支" }) }
    const html = sheet()
    expect(html).toContain("有 1 个会话正在这个目录里工作，等它们结束再切换分支")
    expect(rows(html).filter((b) => b.includes("font-medium") && b.includes('disabled=""'))).toHaveLength(3)
  })

  it("读取失败：显示原因，不显示读取中", () => {
    menu = { ...menu, error: "手机端连不上电脑" }
    // 失败时数据为空：列表区为空，原因由抽屉里的错误行显示
    const html = sheet()
    expect(html).not.toContain("读取分支…")
    expect(html).toContain("手机端连不上电脑")
  })
})

describe("输入框下方一行（目录、分支）", () => {
  const composer = (props: Record<string, unknown>) =>
    renderToStaticMarkup(createElement(Composer, {
      draftKey: null, disabled: false, busy: false, onSend: vi.fn(), onStop: vi.fn(), onError: vi.fn(), ...props,
    }))

  it("below 的内容在输入框下面，不在输入框底栏里（底栏只放模型等）", () => {
    const html = composer({
      footer: createElement("span", { id: "footer-mark" }),
      below: createElement("span", { id: "below-mark" }),
    })
    const textarea = html.indexOf("<textarea")
    const footer = html.indexOf('id="footer-mark"')
    const below = html.indexOf('id="below-mark"')
    expect(textarea).toBeGreaterThan(-1)
    expect(footer).toBeGreaterThan(textarea)
    expect(below).toBeGreaterThan(footer)
  })

  it("没有 below（项目会话）：不留空行", () => {
    const html = composer({ footer: createElement("span", { id: "footer-mark" }) })
    expect(html).toContain('id="footer-mark"')
    expect(html).not.toContain("mt-2 flex min-w-0 flex-wrap")
  })
})
