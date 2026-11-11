import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { afterEach, describe, expect, it, vi } from "vitest"
import {
  createMobileProject, deleteMobileProject, fetchMobileProjectRepos, fetchMobileProjectTemplates, fetchMobileProjectView,
  runMobileProjectStep, syncMobileProjectSteps,
  type MobileChatTab, type RouteStatus,
} from "../src/mobile/api"
import { SessionDrawer } from "../src/mobile/MobileModals"
import { NewProjectSheet } from "../src/mobile/MobileProject"
import { projectArtifactDownloadUrl } from "../src/mobile/project-download"

const BASE = "http://192.168.1.5:19529/"
const TOKEN = "bearer-token"
const FILE_TOKEN = "0123456789abcdef01234567"

interface Call { url: string; init?: RequestInit }

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

describe("手机端项目接口：请求长什么样", () => {
  it("新建项目：POST project-create，带通道和输入；不带文件夹（手机选不了电脑里的文件夹）", async () => {
    const calls = stubFetch(json({ ok: true, projectId: "p1", sessionKey: "k" }))
    const r = await createMobileProject(BASE, TOKEN, "ch_app", { name: "调研", goal: "g", templateId: "research", fields: { 交付形式: "PPT" } })
    expect(r).toEqual({ ok: true, projectId: "p1", sessionKey: "k" })
    expect(calls[0].url).toBe("http://192.168.1.5:19529/api/mobile/project-create")
    expect(headersOf(calls[0]).Authorization).toBe("Bearer bearer-token")
    expect(sent(calls[0])).toEqual({ channelId: "ch_app", input: { name: "调研", goal: "g", templateId: "research", fields: { 交付形式: "PPT" } } })
    expect(JSON.stringify(sent(calls[0]))).not.toContain("folder")
  })

  it("研发类项目：常用仓库走 project-repos；建项带上选的仓库、feature 分支、项目链接、相关文档", async () => {
    const repos = [{ path: "D:\\code\\shop", name: "shop", baseBranch: "develop" }]
    const calls = stubFetch(json({ ok: true, repos }), json({ ok: true, projectId: "p2", sessionKey: "k2" }))
    expect(await fetchMobileProjectRepos(BASE, TOKEN)).toEqual({ ok: true, repos })
    const input = {
      name: "改版", templateId: "develop",
      repos: [{ repoPath: "D:\\code\\shop", baseBranch: "develop" }],
      featureBranch: "feature/x", storyUrl: "https://s/1", relatedDocs: "文档",
    }
    await createMobileProject(BASE, TOKEN, "ch_app", input)
    expect(calls[0].url).toBe("http://192.168.1.5:19529/api/mobile/project-repos")
    expect(sent(calls[1])).toEqual({ channelId: "ch_app", input })
  })

  it("读模板、读项目信息、点步骤、同步、删除：各走各的接口，该带通道的都带通道", async () => {
    const calls = stubFetch(json({ ok: true, templates: [] }), json({ ok: true }), json({ ok: true }), json({ ok: true }), json({ ok: true }))
    await fetchMobileProjectTemplates(BASE, TOKEN)
    await fetchMobileProjectView(BASE, TOKEN, "ch_app", "p1")
    await runMobileProjectStep(BASE, TOKEN, "ch_app", "p1", "n2")
    await syncMobileProjectSteps(BASE, TOKEN, "p1")
    await deleteMobileProject(BASE, TOKEN, "ch_app", "p1")
    expect(calls.map((c) => c.url.replace("http://192.168.1.5:19529", ""))).toEqual([
      "/api/mobile/project-templates", "/api/mobile/project-view", "/api/mobile/project-run-step",
      "/api/mobile/project-sync-steps", "/api/mobile/project-delete",
    ])
    expect(sent(calls[1])).toEqual({ channelId: "ch_app", projectId: "p1" })
    expect(sent(calls[2])).toEqual({ channelId: "ch_app", projectId: "p1", nodeId: "n2" })
    expect(sent(calls[3])).toEqual({ projectId: "p1" })
    // 删除要带通道：电脑端据此判断项目归不归这个通道，不归的（飞书里建的）拒绝
    expect(sent(calls[4])).toEqual({ channelId: "ch_app", projectId: "p1" })
  })

  it("旧版电脑端没有项目接口（未知接口）：换成能看懂的升级提示，每个接口都一样", async () => {
    stubFetch(...Array.from({ length: 6 }, () => json({ ok: false, error: "未知接口" }, 404)))
    const rs = [
      await fetchMobileProjectTemplates(BASE, TOKEN),
      await fetchMobileProjectRepos(BASE, TOKEN),
      await createMobileProject(BASE, TOKEN, "c", { name: "n", templateId: "general" }),
      await fetchMobileProjectView(BASE, TOKEN, "c", "p"),
      await runMobileProjectStep(BASE, TOKEN, "c", "p", "n"),
      await deleteMobileProject(BASE, TOKEN, "c", "p"),
    ]
    for (const r of rs) {
      expect(r.ok).toBe(false)
      expect(r.error).toContain("升级")
    }
  })

  it("电脑端的拒绝原因原样带回（比如项目归飞书管）", async () => {
    stubFetch(json({ ok: false, error: "这个项目归其它通道管" }))
    expect(await runMobileProjectStep(BASE, TOKEN, "c", "p", "n")).toEqual({ ok: false, error: "这个项目归其它通道管" })
  })
})

describe("项目成果的下载链接", () => {
  const OPENED = { ok: true, token: FILE_TOKEN, url: `/api/mobile/pv/${FILE_TOKEN}/a.md`, name: "a.md", size: 10, mtimeMs: 1, kind: "markdown" }

  it("先打开预览（电脑端按项目目录校验），再凭预览令牌换下载票据——不按路径换（成果没在聊天里出现过，按路径会被拒）", async () => {
    const calls = stubFetch(json(OPENED), json({ ok: true, ticket: "tk1" }))
    const url = await projectArtifactDownloadUrl(BASE, TOKEN, "ch|app_main::project_p1", "D:\\proj\\.lk-harness\\artifacts\\a.md")
    expect(url).toBe("http://192.168.1.5:19529/api/mobile/file?ticket=tk1")
    expect(calls).toHaveLength(2)
    expect(calls[0].url).toBe("http://192.168.1.5:19529/api/mobile/preview-open")
    expect(sent(calls[0])).toEqual({ sessionKey: "ch|app_main::project_p1", path: "D:\\proj\\.lk-harness\\artifacts\\a.md" })
    expect(calls[1].url).toBe("http://192.168.1.5:19529/api/mobile/file-ticket")
    expect(sent(calls[1])).toEqual({ previewToken: FILE_TOKEN })
  })

  it("预览打不开（文件没了、没权限）：抛出电脑端给的原因，不再去换票据", async () => {
    const calls = stubFetch(json({ ok: false, error: "文件不存在，可能已被移动或删除" }))
    await expect(projectArtifactDownloadUrl(BASE, TOKEN, "s", "x")).rejects.toThrow("文件不存在，可能已被移动或删除")
    expect(calls).toHaveLength(1)
  })

  it("换票据失败：抛出原因", async () => {
    stubFetch(json(OPENED), json({ ok: false, error: "预览已失效，请重新打开" }, 404))
    await expect(projectArtifactDownloadUrl(BASE, TOKEN, "s", "x")).rejects.toThrow("预览已失效")
  })
})

describe("新建项目面板", () => {
  const props = (over: Record<string, unknown> = {}) => ({
    open: true, onClose: vi.fn(), baseUrl: BASE, token: TOKEN, channelId: "ch_app", onCreated: vi.fn(), ...over,
  })

  it("关着的时候什么都不渲染", () => {
    expect(renderToStaticMarkup(createElement(NewProjectSheet, props({ open: false })))).toBe("")
  })

  it("打开：有抓手、标题、加载提示；没有模板可选时「创建」不可点", () => {
    const html = renderToStaticMarkup(createElement(NewProjectSheet, props()))
    expect((html.match(/data-sheet-grip/g) ?? []).length).toBe(1)
    expect(html).toContain("新建项目")
    expect(html).toContain("加载中")
    const create = /<button[^>]*>(?:(?!<\/button>).)*创建<\/button>/s.exec(html)?.[0] ?? ""
    expect(create).toContain('disabled=""') // 样式类里也有 disabled:opacity-40，要认属性本身
  })

  it("说明项目文件夹由电脑自动建、手机选不了已有文件夹", () => {
    const html = renderToStaticMarkup(createElement(NewProjectSheet, props()))
    expect(html).toContain("电脑上会自动给项目建一个文件夹")
    expect(html).toContain("请在电脑端建项目")
  })
})

describe("会话抽屉：项目", () => {
  const route: RouteStatus = { connected: true, activeUrl: "http://x", routeType: "lan" }
  const tab = (over: Partial<MobileChatTab> = {}): MobileChatTab => ({
    sessionKey: "ch|app_main::project_abc123def456", label: "Q4 调研", kind: "project", running: false, current: false, removable: true, ...over,
  })
  const render = (tabs: MobileChatTab[], over: Record<string, unknown> = {}) =>
    renderToStaticMarkup(
      createElement(SessionDrawer, {
        open: true, onClose: vi.fn(), hostname: "pc", route,
        views: [{ channelId: "c1", name: "通道", tabs }],
        selected: null, sessionName: (t: MobileChatTab) => t.label, sessionStatus: () => "idle",
        activeAt: () => undefined, usageBytes: null, onSelect: vi.fn(), onNewTemp: vi.fn(), onNewProject: vi.fn(),
        onDelete: vi.fn(), onClearAll: vi.fn(), onOpenPair: vi.fn(), ...over,
      }),
    )

  it("项目会话的副标题是「项目」，不是「临时对话」", () => {
    const html = render([tab()])
    expect(html).toContain(">项目<")
    expect(html).not.toContain("临时对话")
  })

  it("有「新项目」按钮；没有通道（还没连上）时不出现", () => {
    expect(render([tab()])).toContain("新项目")
    const none = renderToStaticMarkup(createElement(SessionDrawer, {
      open: true, onClose: vi.fn(), hostname: "", route, views: [], selected: null, sessionName: () => "", sessionStatus: () => "idle",
      activeAt: () => undefined, usageBytes: null, onSelect: vi.fn(), onNewTemp: vi.fn(), onNewProject: vi.fn(),
      onDelete: vi.fn(), onClearAll: vi.fn(), onOpenPair: vi.fn(),
    }))
    expect(none).not.toContain("新项目")
  })

  it("项目会话在抽屉里不给直接删除（删除在项目信息里，能看到归属才给删）", () => {
    expect(render([tab()])).not.toContain("删除会话")
  })
})
