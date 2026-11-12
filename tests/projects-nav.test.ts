import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it, vi } from "vitest"
import NewProjectDialog from "../src/renderer/components/project/NewProjectDialog"
import ProjectRail from "../src/renderer/components/project/ProjectRail"
import ProjectsTab from "../src/renderer/components/project/ProjectsTab"
import TemplateWorkspace from "../src/renderer/components/project/TemplateWorkspace"
import {
  NARROW_LAYOUT_PX, PROJECTS_SUB_TABS, PROJECT_TEMPLATES_TARGET, isNarrowLayout, isProjectsSubTab, landingSel, projectsJumpFor,
  resolveSel, sameSel, sectionOfSel, selForJump, splitSettingsTarget, type ProjectsSel, type SelContext,
} from "../src/renderer/components/project/projects-nav"
import type { ProjectListItem } from "../src/shared/project-app-types"

describe("设置页跳转目标", () => {
  it("只有一级标签：和以前一样，没有子页", () => {
    expect(splitSettingsTarget("channel")).toEqual({ tab: "channel" })
    expect(splitSettingsTarget("projects")).toEqual({ tab: "projects" })
  })

  it("带子页：冒号前是一级标签，冒号后是子页", () => {
    expect(splitSettingsTarget("projects:templates")).toEqual({ tab: "projects", sub: "templates" })
  })

  it("没有传、空串、只有冒号：不抛错，也不凭空造出子页", () => {
    expect(splitSettingsTarget(undefined)).toEqual({ tab: "" })
    expect(splitSettingsTarget("")).toEqual({ tab: "" })
    expect(splitSettingsTarget("projects:")).toEqual({ tab: "projects" })
    expect(splitSettingsTarget("  projects : templates ")).toEqual({ tab: "projects", sub: "templates" })
  })

  it("子页里再有冒号：整段留给子页，不再拆", () => {
    expect(splitSettingsTarget("projects:a:b")).toEqual({ tab: "projects", sub: "a:b" })
  })

  it("「去项目模板」的目标：落在项目标签的模板子页", () => {
    expect(splitSettingsTarget(PROJECT_TEMPLATES_TARGET)).toEqual({ tab: "projects", sub: "templates" })
    expect(projectsJumpFor(splitSettingsTarget(PROJECT_TEMPLATES_TARGET))).toEqual({ sub: "templates" })
  })
})

describe("项目标签的子页请求", () => {
  it("每个已有子页都认得，别的不认", () => {
    for (const t of PROJECTS_SUB_TABS) expect(isProjectsSubTab(t)).toBe(true)
    expect([...PROJECTS_SUB_TABS]).toEqual(["list", "templates", "settings"])
    expect(isProjectsSubTab("nope")).toBe(false)
    expect(isProjectsSubTab(undefined)).toBe(false)
  })

  it("目标不是项目标签、没有子页、子页不认识：不发请求（保持项目标签原来停在哪就在哪）", () => {
    expect(projectsJumpFor({ tab: "channel", sub: "templates" })).toBeUndefined()
    expect(projectsJumpFor({ tab: "projects" })).toBeUndefined()
    expect(projectsJumpFor({ tab: "projects", sub: "nope" })).toBeUndefined()
  })

  it("每次都是新对象：同一个子页连续请求两次，标签靠引用变化也能各响应一次", () => {
    const a = projectsJumpFor({ tab: "projects", sub: "templates" })
    const b = projectsJumpFor({ tab: "projects", sub: "templates" })
    expect(a).toEqual(b)
    expect(a).not.toBe(b)
  })
})

describe("「项目」页的选中位置", () => {
  const ctx: SelContext = {
    projectIds: ["p1", "p2"],
    templates: [{ id: "g1", actionIds: ["a1", "a2"] }, { id: "g2", actionIds: ["b1"] }],
  }

  it("跳转请求对应到落点：模板→模板首页，设置→项目设置，其余→项目首页", () => {
    expect(selForJump("templates")).toEqual({ kind: "templates-home" })
    expect(selForJump("settings")).toEqual({ kind: "settings" })
    expect(selForJump("list")).toEqual({ kind: "projects-home" })
  })

  it("左栏高亮哪一块：项目与项目首页算「项目」，模板的各层与新建都算「项目模板」", () => {
    expect(sectionOfSel({ kind: "projects-home" })).toBe("projects")
    expect(sectionOfSel({ kind: "project", id: "p1" })).toBe("projects")
    expect(sectionOfSel({ kind: "templates-home" })).toBe("templates")
    expect(sectionOfSel({ kind: "new-template" })).toBe("templates")
    expect(sectionOfSel({ kind: "template", id: "g1", leaf: { kind: "action", id: "a1" } })).toBe("templates")
    expect(sectionOfSel({ kind: "settings" })).toBe("settings")
  })

  it("sameSel：同一个位置才算相同，模板里换了快捷操作就是不同", () => {
    const info: ProjectsSel = { kind: "template", id: "g1", leaf: { kind: "info" } }
    expect(sameSel(info, { kind: "template", id: "g1", leaf: { kind: "info" } })).toBe(true)
    expect(sameSel(info, { kind: "template", id: "g2", leaf: { kind: "info" } })).toBe(false)
    expect(sameSel(info, { kind: "template", id: "g1", leaf: { kind: "action", id: "a1" } })).toBe(false)
    expect(sameSel({ kind: "template", id: "g1", leaf: { kind: "action", id: "a1" } }, { kind: "template", id: "g1", leaf: { kind: "action", id: "a2" } })).toBe(false)
    expect(sameSel({ kind: "template", id: "g1", leaf: { kind: "action", id: "a1" } }, { kind: "template", id: "g1", leaf: { kind: "action", id: "a1" } })).toBe(true)
    expect(sameSel({ kind: "project", id: "p1" }, { kind: "project", id: "p2" })).toBe(false)
    expect(sameSel({ kind: "project", id: "p1" }, { kind: "project", id: "p1" })).toBe(true)
    expect(sameSel({ kind: "settings" }, { kind: "settings" })).toBe(true)
    expect(sameSel({ kind: "settings" }, { kind: "templates-home" })).toBe(false)
  })

  it("resolveSel：数据都还在时原样不动", () => {
    const sels: ProjectsSel[] = [
      { kind: "project", id: "p2" },
      { kind: "template", id: "g1", leaf: { kind: "action", id: "a2" } },
      { kind: "template", id: "g1", leaf: { kind: "new-action" } },
      { kind: "new-template" }, { kind: "settings" }, { kind: "templates-home" }, { kind: "projects-home" },
    ]
    for (const s of sels) expect(resolveSel(s, ctx)).toBe(s)
  })

  it("resolveSel：被删掉的项目回项目首页，被删掉的模板回模板首页，被删掉的快捷操作落到模板信息", () => {
    expect(resolveSel({ kind: "project", id: "gone" }, ctx)).toEqual({ kind: "projects-home" })
    expect(resolveSel({ kind: "template", id: "gone", leaf: { kind: "info" } }, ctx)).toEqual({ kind: "templates-home" })
    expect(resolveSel({ kind: "template", id: "gone", leaf: { kind: "action", id: "a1" } }, ctx)).toEqual({ kind: "templates-home" })
    expect(resolveSel({ kind: "template", id: "g1", leaf: { kind: "action", id: "b1" } }, ctx)).toEqual({ kind: "template", id: "g1", leaf: { kind: "info" } })
  })

  it("landingSel：只有停在项目首页又有项目时才自动选第一个，其余都不动", () => {
    expect(landingSel({ kind: "projects-home" }, ["p1", "p2"])).toEqual({ kind: "project", id: "p1" })
    expect(landingSel({ kind: "projects-home" }, [])).toEqual({ kind: "projects-home" })
    const t: ProjectsSel = { kind: "templates-home" }
    expect(landingSel(t, ["p1"])).toBe(t)
    const s: ProjectsSel = { kind: "settings" }
    expect(landingSel(s, ["p1"])).toBe(s)
  })
})

describe("窄窗口", () => {
  it("宽度小于阈值才算窄；0（页面被藏起来）是「不知道」，不算窄", () => {
    expect(isNarrowLayout(0)).toBe(false)
    expect(isNarrowLayout(NARROW_LAYOUT_PX - 1)).toBe(true)
    expect(isNarrowLayout(NARROW_LAYOUT_PX)).toBe(false)
    expect(isNarrowLayout(1400)).toBe(false)
  })

  it("应用默认窗口 900 宽时设置页内容区不到阈值（所以默认就是窄布局）", () => {
    // 设置页左边的导航约 143 宽
    expect(isNarrowLayout(900 - 143)).toBe(true)
  })

  const group = { id: "g1", name: "调研分析", workspace: "plain" as const, nodes: [{ id: "a1", label: "界定问题" }, { id: "a2", label: "收集资料" }] }
  const workspace = (onBack?: () => void) => renderToStaticMarkup(createElement(TemplateWorkspace, {
    group: group as never, leaf: { kind: "info" }, groups: [group] as never, go: vi.fn(), hubUrlReady: false, hubConfigured: false,
    ui: { showAlert: vi.fn() }, registerGuard: vi.fn(), onBack,
    ops: {} as never,
  }))

  it("最左栏收起时，快捷操作列表顶上有「全部模板」；没收起就没有", () => {
    expect(workspace(vi.fn())).toContain("全部模板")
    expect(workspace()).not.toContain("全部模板")
  })

  it("左栏收起只是不显示（还在页面里），没收起是显示的", () => {
    const rail = (folded: boolean) => renderToStaticMarkup(createElement(ProjectRail, {
      sel: { kind: "templates-home" }, go: vi.fn(), hubUrlReady: false, onImport: vi.fn(), onOpenHub: vi.fn(), projects: [], groups: [], folded,
    }))
    expect(rail(true)).toMatch(/<aside class="hidden /)
    expect(rail(false)).toMatch(/<aside class="flex /)
  })
})

describe("新建项目对话框里的「去项目模板」入口", () => {
  const render = () => renderToStaticMarkup(createElement(NewProjectDialog, {
    channelId: "ch_1",
    onClose: vi.fn(),
    onCreated: vi.fn(),
    onOpenTemplateSettings: vi.fn(),
  }))

  it("模板还在加载时就能看到入口：没有想要的类型，不用等列表", () => {
    const html = render()
    expect(html).toContain("加载中")
    expect(html).toContain("没有想要的类型？")
    expect(html).toContain("去「项目模板」新建一个")
  })

  it("入口是一个按钮，不是 submit，也不是灰的", () => {
    const html = render()
    const m = html.match(/<button([^>]*)>去「项目模板」新建一个<\/button>/)
    expect(m).not.toBeNull()
    expect(m![1]).toContain('type="button"')
    // 只看 HTML 属性：样式类里的 disabled:opacity-50 不算
    expect(m![1]).not.toMatch(/\sdisabled(=|\s|$)/)
  })
})

describe("设置页「项目」标签：一栏式，没有顶上的子标签", () => {
  /** 左栏里被标成「当前」的按钮文字：分区标题（带数量）和「项目设置」 */
  const current = (html: string): string[] => {
    const out = [...html.matchAll(/aria-current="true" class="[^"]*"><span>([^<]*)<\/span>/g)].map((m) => m[1])
    if (/aria-current="true" class="[^"]*"><svg[^>]*>.*?<\/svg>项目设置</.test(html)) out.push("项目设置")
    return out
  }

  it("没有请求：落在「项目」，不再有「项目列表 / 项目模板 / 设置」三个标签", () => {
    const html = renderToStaticMarkup(createElement(ProjectsTab))
    expect(current(html)).toEqual(["项目"])
    expect(html).not.toContain("项目列表")
    expect(html).toContain('aria-label="项目导航"')
  })

  it("带着「项目模板」请求挂载：直接落在「项目模板」", () => {
    const html = renderToStaticMarkup(createElement(ProjectsTab, { jump: { sub: "templates" }, onJumpConsumed: vi.fn() }))
    expect(current(html)).toEqual(["项目模板"])
    // 模板首页的引导文案在右边
    expect(html).toContain("新建模板")
  })

  it("带着「设置」请求挂载：落在左栏底部的「项目设置」", () => {
    const html = renderToStaticMarkup(createElement(ProjectsTab, { jump: { sub: "settings" }, onJumpConsumed: vi.fn() }))
    expect(current(html)).toEqual(["项目设置"])
  })
})

describe("项目左栏", () => {
  const project = (id: string, name: string, groupNames: string[], archived = false): ProjectListItem => ({
    id, name, archived, groupNames,
  } as ProjectListItem)
  const group = (id: string, name: string, n: number, repo = false) => ({
    id, name, nodes: Array.from({ length: n }, (_, i) => ({ id: `${id}-${i}`, label: `操作${i}` })),
    fields: repo ? [{ label: "代码仓库", type: "repo" as const }] : [],
  })
  const render = (sel: ProjectsSel, hubUrlReady = false) => renderToStaticMarkup(createElement(ProjectRail, {
    sel, go: vi.fn(), hubUrlReady, onImport: vi.fn(), onOpenHub: vi.fn(),
    projects: [project("p1", "官网改版", ["通用任务"]), project("p2", "老项目", [], true)],
    groups: [group("g1", "通用任务", 2), group("g2", "研发需求", 3, true)] as never,
  }))

  it("项目和模板各一栏，名字、所用模板、快捷操作数量都在", () => {
    const html = render({ kind: "projects-home" })
    expect(html).toContain("官网改版")
    expect(html).toContain("通用任务")
    expect(html).toContain("老项目")
    expect(html).toContain("普通项目") // 没挂模板的老项目
    expect(html).toContain("3 个快捷操作")
    // 归档的项目才有标记；没归档的不带任何「进行中」之类的状态字
    expect(html).toContain("已归档 · 普通项目")
    expect(html.match(/已归档/g)).toHaveLength(1)
    expect(html).not.toMatch(/进行中|已暂停|已完成/)
  })

  it("选中谁谁亮：项目只亮一个，模板只亮一个", () => {
    const projectOn = (html: string) => (html.match(/<button[^>]*data-rail="project"[^>]*aria-current="true"/g) ?? []).length
    const templateOn = (html: string) => (html.match(/<button[^>]*data-rail="template"[^>]*aria-current="true"/g) ?? []).length
    const a = render({ kind: "project", id: "p2" })
    expect(projectOn(a)).toBe(1)
    expect(templateOn(a)).toBe(0)
    const b = render({ kind: "template", id: "g2", leaf: { kind: "info" } })
    expect(projectOn(b)).toBe(0)
    expect(templateOn(b)).toBe(1)
  })

  it("共享空间入口只在配了地址时出现，导入文件始终有", () => {
    expect(render({ kind: "projects-home" })).not.toContain("共享空间")
    expect(render({ kind: "projects-home" })).toContain("导入文件")
    expect(render({ kind: "projects-home" }, true)).toContain("共享空间")
  })

  it("正在新建模板时，列表里先有一行占位", () => {
    expect(render({ kind: "new-template" })).toContain("正在创建")
    expect(render({ kind: "projects-home" })).not.toContain("正在创建")
  })
})
