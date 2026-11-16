import { beforeEach, describe, expect, it, vi } from "vitest"

// 这个仓库的测试没有 DOM：这里把 useRef / useEffect 换成可控的，直接调组件函数，
// 再手动执行它登记的副作用，检查「选中的行不在视野里就带回来」这件事做对了没有
const hooks = vi.hoisted(() => ({
  effects: [] as { run: () => unknown; deps: unknown[] | undefined }[],
  aside: { current: null as unknown },
}))
vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>()
  return {
    ...actual,
    useRef: () => hooks.aside,
    useEffect: (run: () => unknown, deps?: unknown[]) => { hooks.effects.push({ run, deps }) },
  }
})

import ProjectRail from "../src/renderer/components/project/ProjectRail"
import type { ProjectsSel } from "../src/renderer/components/project/projects-nav"

const props = (sel: ProjectsSel, projects = 3, groups = 2) => ({
  sel, go: vi.fn(), hubUrlReady: false, onImport: vi.fn(), onOpenHub: vi.fn(),
  projects: Array.from({ length: projects }, (_, i) => ({ id: `p${i}`, name: `项目${i}`, archived: false, groupNames: [] })) as never,
  groups: Array.from({ length: groups }, (_, i) => ({ id: `g${i}`, name: `模板${i}`, workspace: "plain", nodes: [], fields: [] })) as never,
})

/** 渲染一次，返回「选中行」的 scrollIntoView 和 aside 的 querySelector 两个替身 */
function mount(p: ReturnType<typeof props>, hasRow = true) {
  hooks.effects.length = 0
  const scrollIntoView = vi.fn()
  const querySelector = vi.fn(() => (hasRow ? { scrollIntoView } : null))
  hooks.aside.current = { querySelector }
  ProjectRail(p)
  return { scrollIntoView, querySelector, effects: [...hooks.effects] }
}

describe("项目左栏：选中的行被滚到视野外时带回来", () => {
  beforeEach(() => { hooks.effects.length = 0 })

  it("选中某个项目、某个模板、正在新建的模板：执行时把那一行滚进视野，只在需要时挪（block: nearest）", () => {
    for (const sel of [
      { kind: "project", id: "p1" },
      { kind: "template", id: "g1", leaf: { kind: "info" } },
      { kind: "new-template" },
    ] satisfies ProjectsSel[]) {
      const m = mount(props(sel))
      expect(m.effects).toHaveLength(1)
      m.effects[0].run()
      expect(m.scrollIntoView, JSON.stringify(sel)).toHaveBeenCalledTimes(1)
      expect(m.scrollIntoView).toHaveBeenCalledWith({ block: "nearest" })
    }
  })

  it("找的是「选中的项目行 / 选中的模板行 / 新建占位行」，不会去找标题条或「项目设置」", () => {
    const m = mount(props({ kind: "project", id: "p1" }))
    m.effects[0].run()
    const selector = (m.querySelector.mock.calls[0] as unknown as [string])[0]
    expect(selector).toContain('[data-rail="project"][aria-current="true"]')
    expect(selector).toContain('[data-rail="template"][aria-current="true"]')
    expect(selector).toContain('[data-rail="new-template"]')
    expect(selector).not.toContain("settings")
    expect(selector).not.toContain("data-rail-head")
  })

  it("停在项目首页、模板首页、项目设置时：没有要带回来的行，不去查也不滚", () => {
    for (const sel of [{ kind: "projects-home" }, { kind: "templates-home" }, { kind: "settings" }] satisfies ProjectsSel[]) {
      const m = mount(props(sel))
      m.effects[0].run()
      expect(m.querySelector, JSON.stringify(sel)).not.toHaveBeenCalled()
      expect(m.scrollIntoView).not.toHaveBeenCalled()
    }
  })

  it("找不到那一行（列表还没加载出来）或还没有挂上：什么都不做，不报错", () => {
    const none = mount(props({ kind: "project", id: "p1" }), false)
    expect(() => none.effects[0].run()).not.toThrow()
    expect(none.scrollIntoView).not.toHaveBeenCalled()

    hooks.effects.length = 0
    hooks.aside.current = null
    ProjectRail(props({ kind: "project", id: "p1" }))
    expect(() => hooks.effects[0].run()).not.toThrow()
  })

  it("环境没有 scrollIntoView 时（老内核、测试环境）不报错", () => {
    hooks.effects.length = 0
    hooks.aside.current = { querySelector: () => ({}) }
    ProjectRail(props({ kind: "project", id: "p1" }))
    expect(() => hooks.effects[0].run()).not.toThrow()
  })

  it("什么时候重新执行：选中的行换了、项目数或模板数变了（列表后加载出来）；平时重绘不触发", () => {
    const a = mount(props({ kind: "project", id: "p1" }, 3, 2)).effects[0].deps
    const same = mount(props({ kind: "project", id: "p1" }, 3, 2)).effects[0].deps
    expect(same).toEqual(a)
    expect(mount(props({ kind: "project", id: "p2" }, 3, 2)).effects[0].deps).not.toEqual(a)
    expect(mount(props({ kind: "template", id: "p1", leaf: { kind: "info" } }, 3, 2)).effects[0].deps).not.toEqual(a) // 同 id 的模板和项目不混
    expect(mount(props({ kind: "project", id: "p1" }, 4, 2)).effects[0].deps).not.toEqual(a)
    expect(mount(props({ kind: "project", id: "p1" }, 3, 3)).effects[0].deps).not.toEqual(a)
    // 模板里换了快捷操作，左栏选中的还是那个模板，不重新滚
    const t1 = mount(props({ kind: "template", id: "g1", leaf: { kind: "info" } })).effects[0].deps
    const t2 = mount(props({ kind: "template", id: "g1", leaf: { kind: "action", id: "x" } })).effects[0].deps
    expect(t2).toEqual(t1)
  })
})
