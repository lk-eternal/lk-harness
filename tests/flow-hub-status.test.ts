import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"
import {
  flowHubMissingMessage,
  flowHubStatusOf,
  NO_FLOW_HUB,
  sameFlowHubStatus,
} from "../src/shared/flow-hub-status"
import { loadFlowHubContext } from "../electron/flow-hub-service"
import type { AppConfig } from "../electron/config-store"

const URL_OK = "https://gitlab.example.com/internal-shared/flow-hub"

describe("flowHubStatusOf：共享空间配没配好", () => {
  it("什么都没填：地址和可用都是否", () => {
    expect(flowHubStatusOf({})).toEqual({ urlReady: false, configured: false })
    expect(flowHubStatusOf(null)).toEqual(NO_FLOW_HUB)
    expect(flowHubStatusOf(undefined)).toEqual(NO_FLOW_HUB)
  })

  it("只填了地址：有入口，但还不能用", () => {
    expect(flowHubStatusOf({ flowHubUrl: URL_OK })).toEqual({ urlReady: true, configured: false })
  })

  it("地址 + 共享空间 Token：可用", () => {
    expect(flowHubStatusOf({ flowHubUrl: URL_OK, flowHubToken: "glpat-hub" })).toEqual({ urlReady: true, configured: true })
  })

  it("地址 + 「研发」里的 GitLab Token：也可用（共享空间 Token 没填时兜底）", () => {
    expect(flowHubStatusOf({ flowHubUrl: URL_OK, gitlabToken: "glpat-dev" })).toEqual({ urlReady: true, configured: true })
  })

  it("只有 Token 没有地址：不可用", () => {
    expect(flowHubStatusOf({ flowHubToken: "glpat-hub", gitlabToken: "glpat-dev" })).toEqual({ urlReady: false, configured: false })
  })

  it("只有空白也算没填（粘贴时带上的空格、换行不算）", () => {
    expect(flowHubStatusOf({ flowHubUrl: "  \n", flowHubToken: " " })).toEqual(NO_FLOW_HUB)
    expect(flowHubStatusOf({ flowHubUrl: URL_OK, flowHubToken: "  ", gitlabToken: "\t" })).toEqual({ urlReady: true, configured: false })
  })

  it("null 和 undefined 一样当没填", () => {
    expect(flowHubStatusOf({ flowHubUrl: URL_OK, flowHubToken: null, gitlabToken: null }).configured).toBe(false)
  })

  it("和主进程取凭据的规则一致：界面上说配好了，主进程就拿得到凭据（反过来也是）", () => {
    const base = { flowHubUrl: "", flowHubToken: "", gitlabToken: "", gitlabHost: "", flowHubAuthor: "" }
    const cases: Partial<typeof base>[] = [
      {},
      { flowHubUrl: URL_OK },
      { flowHubUrl: URL_OK, flowHubToken: "t" },
      { flowHubUrl: URL_OK, gitlabToken: "t" },
      { flowHubToken: "t", gitlabToken: "t" },
      { flowHubUrl: URL_OK, flowHubToken: "  " },
    ]
    for (const c of cases) {
      const cfg = { ...base, ...c }
      const ui = flowHubStatusOf(cfg).configured
      const main = !("error" in loadFlowHubContext(cfg as unknown as AppConfig))
      expect(ui, JSON.stringify(c)).toBe(main)
    }
  })
})

describe("sameFlowHubStatus", () => {
  it("两项都相同才算相同", () => {
    expect(sameFlowHubStatus({ urlReady: true, configured: false }, { urlReady: true, configured: false })).toBe(true)
    expect(sameFlowHubStatus({ urlReady: true, configured: false }, { urlReady: true, configured: true })).toBe(false)
    expect(sameFlowHubStatus({ urlReady: false, configured: false }, { urlReady: true, configured: false })).toBe(false)
  })
})

describe("flowHubMissingMessage：缺什么说什么", () => {
  it("地址没填：让人去填地址", () => {
    const msg = flowHubMissingMessage({ urlReady: false, configured: false })
    expect(msg).toContain("还没填共享空间地址")
    expect(msg).not.toContain("已经填好")
  })

  it("地址填了、缺 Token：明确说地址已经好了，只差 Token，并给出两种补法", () => {
    const msg = flowHubMissingMessage({ urlReady: true, configured: false })
    expect(msg).toContain("共享空间地址已经填好了")
    expect(msg).toContain("共享空间 Token")
    expect(msg).toContain("GitLab Token")
    expect(msg).not.toContain("还没填共享空间地址")
  })
})

/**
 * 「填了还不行」的原因：项目页自己存着一份「共享空间配没配好」，只在打开页面时读一次，设置页保存后没人通知它。
 * 界面行为要真 DOM 才测得出（仓库里没有 DOM 测试环境），这里守住几处接线，别被改回去。
 */
describe("项目页的接线（守住不被改回去）", () => {
  // Windows 上 git 检出是 CRLF，下面的正则按 \n 写，统一成 \n 再匹配
  const readSource = (file: string) => readFileSync(file, "utf8").replace(/\r\n/g, "\n")
  const tab = readSource("src/renderer/components/project/ProjectsTab.tsx")
  const panel = readSource("src/renderer/components/project/ProjectSettingsPanel.tsx")

  it("点「共享空间」时现读配置，不只看页面里存的那份", () => {
    const body = /const openHub = async[\s\S]*?\n {2}\}\n/.exec(tab)?.[0] ?? ""
    expect(body).toMatch(/await readHub\(\)/)
    expect(body).toMatch(/flowHubMissingMessage\(/)
  })

  it("设置页保存后通知项目页重读", () => {
    expect(tab).toMatch(/<ProjectSettingsPanel onSaved=\{[^}]*readHub\(\)/)
  })

  it("设置页：保存后先通知、再判断页面是否还在（页面切走时的保存也要通知）", () => {
    const flush = /const flush = useCallback\(async \(\) => \{[\s\S]*?\n {2}\}, \[\]\)/.exec(panel)?.[0] ?? ""
    const notify = flush.indexOf("onSavedRef.current?.()")
    const mountedCheck = flush.indexOf("if (!mounted.current) return")
    expect(notify).toBeGreaterThan(flush.indexOf("saveConfig("))
    expect(mountedCheck).toBeGreaterThan(notify)
  })

  it("设置页：输入框一失焦就保存，不用等防抖", () => {
    expect(panel).toMatch(/onBlur=\{\(\) => void flush\(\)\}/)
  })

  it("项目页用共享的判断函数，没有自己再写一份规则", () => {
    expect(tab).toMatch(/flowHubStatusOf\(/)
    expect(tab).not.toMatch(/flowHubToken \?\? ""\)\.trim\(\)/)
  })
})
