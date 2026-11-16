import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"
import { flowHubMissingMessage } from "../src/shared/flow-hub-status"

/**
 * 「项目设置」页的版式要真浏览器才测得出（仓库里没有 DOM 测试环境），这里只守住几条约定，别被改回去：
 * 全部展开不折叠、仓库一行一个且表头和行共用列宽、宽窄两种排法用同一个断点、每个标签都对得上输入框、
 * 提示文案里提到的设置项名字在页面上真的存在。
 */
const panel = readFileSync("src/renderer/components/project/ProjectSettingsPanel.tsx", "utf8")

describe("项目设置页：全部展开，不折叠", () => {
  it("没有折叠开关：不再有 Fold、aria-expanded 和展开收起的箭头", () => {
    expect(panel).not.toMatch(/\bFold\b/)
    expect(panel).not.toContain("aria-expanded")
    expect(panel).not.toMatch(/Chevron(Down|Right)/)
    expect(panel).not.toMatch(/setDevOpen|setHubOpen|devOpen|hubOpen/)
  })

  it("没有「更多分支设置」：测试、开发分支直接是列，不用点开", () => {
    expect(panel).not.toContain("更多分支设置")
    expect(panel).not.toMatch(/moreRows|setMoreRows/)
    for (const label of ["基线分支", "测试分支", "开发分支"]) {
      expect(panel.match(new RegExp(`aria-label="${label}"`, "g"))).toHaveLength(1)
    }
  })

  it("五块设置都在", () => {
    for (const title of ["项目存放位置", "常用代码仓库", "Git 基本原则", "GitLab", "团队共享"]) {
      expect(panel).toContain(`title="${title}"`)
    }
  })
})

describe("项目设置页：仓库表格", () => {
  const wideCols = /const REPO_WIDE_COLS = "@\[(\d+(?:\.\d+)?rem)\]:grid-cols-\[([^\]]+)\]"/.exec(panel)

  it("宽排法是 6 列：地址 | 基线 | 测试 | 开发 | 克隆副本 | 移除", () => {
    expect(wideCols).not.toBeNull()
    expect(wideCols![2].split("_")).toHaveLength(6)
  })

  it("表头和每一行用的是同一套列宽，上下才对得齐", () => {
    // 表头直接引用，行通过 REPO_ROW（里面带着同一个常量）
    expect(panel).toMatch(/const REPO_ROW = `[^`]*\$\{REPO_WIDE_COLS\}`/)
    expect(panel).toMatch(/@\[42rem\]:grid \$\{REPO_WIDE_COLS\}/)
    expect(panel.match(/\$\{REPO_WIDE_COLS\}/g)!.length).toBeGreaterThanOrEqual(2)
  })

  it("宽窄只有一个断点：表头、行、分支小标签用同一个值，不会出现表头已经显示而行还是窄排法", () => {
    const points = new Set([...panel.matchAll(/@\[(\d+(?:\.\d+)?rem)\]:/g)].map((m) => m[1]))
    expect([...points]).toEqual(["42rem"])
  })

  it("窄排法下不靠横向滚动：右边的列不会被藏起来", () => {
    expect(panel).not.toContain("overflow-x-auto")
    expect(panel).not.toMatch(/min-w-\[\d+rem\]/)
  })

  it("表头只在宽排法显示，分支小标签只在窄排法显示（两处不会同时出现）", () => {
    expect(panel).toMatch(/className=\{`hidden [^`]*@\[42rem\]:grid /)
    expect(panel).toMatch(/text-fg-muted @\[42rem\]:hidden">\{label\}/)
  })
})

describe("项目设置页：克隆副本 + Git 基本原则", () => {
  it("每个仓库一个「克隆副本」勾选：默认勾上，取消勾选存成 clone:false，勾回去就不存（缺省=克隆）", () => {
    expect(panel).toContain('aria-label="克隆副本"')
    expect(panel).toMatch(/checked=\{isRemoteRepoUrl\(p\.path\) \|\| p\.clone !== false\}/)
    expect(panel).toMatch(/clone: e\.target\.checked \? undefined : false/)
  })

  it("远程地址的勾选是灰的（本机没有副本可用，一定克隆）", () => {
    expect(panel).toMatch(/disabled=\{isRemoteRepoUrl\(p\.path\)\}/)
  })

  it("说明文案讲清两种情况：克隆=AI 在副本里改、不动你的仓库；不克隆=只记信息、AI 直接用本机这份", () => {
    expect(panel).toContain("勾上，建项目时会克隆一份到项目目录，AI 在副本里改，不动你自己的仓库")
    expect(panel).toContain("不勾就不克隆，只把仓库信息记进项目，AI 直接用你本机这份")
  })

  it("Git 基本原则：一个文本框，显示的是实际生效的文本，能一键恢复默认，清空=不带", () => {
    expect(panel).toContain('aria-label="Git 基本原则"')
    expect(panel).toContain("gitPrinciples: resolveGitPrinciples(config.gitPrinciples)")
    expect(panel).toContain("恢复默认")
    expect(panel).toContain("项目会话里不会带这段话")
    expect(panel).toContain("maxLength={GIT_PRINCIPLES_MAX}")
  })

  it("GitLab 卡片不再说「让 AI 查 MR」", () => {
    expect(panel).not.toContain("让 AI 查找、查看 MR")
  })
})

describe("项目设置页：标签和输入框对得上", () => {
  it("每个表单行的 htmlFor 都有同名 id 的输入框（点名字能聚焦，读屏也念得出）", () => {
    const labels = [...panel.matchAll(/htmlFor="([^"]+)"/g)].map((m) => m[1])
    expect(labels.length).toBeGreaterThanOrEqual(6)
    for (const id of labels) {
      expect(panel, id).toContain(`id="${id}"`)
    }
    expect(new Set(labels).size).toBe(labels.length)
  })
})

describe("提示文案提到的设置项，页面上真的有", () => {
  it("共享空间没配好的提示里写的「项目设置 → X」，X 都是设置页里的块标题", () => {
    for (const status of [{ urlReady: false, configured: false }, { urlReady: true, configured: false }]) {
      const names = [...flowHubMissingMessage(status).matchAll(/项目设置 → ([^」]+)」/g)].map((m) => m[1])
      expect(names.length).toBeGreaterThan(0)
      for (const name of names) expect(panel, name).toContain(`title="${name}"`)
    }
  })

  it("提示里不再出现已经不存在的旧名字", () => {
    for (const status of [{ urlReady: false, configured: false }, { urlReady: true, configured: false }]) {
      const msg = flowHubMissingMessage(status)
      expect(msg).not.toContain("高级")
      expect(msg).not.toContain("「研发」")
    }
  })
})
