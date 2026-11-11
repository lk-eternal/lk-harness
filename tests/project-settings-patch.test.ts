import { describe, expect, it } from "vitest"
import { buildSettingsPatch, cleanRepoProfiles, type ProjectSettingsValues } from "../src/shared/project-settings-patch"

const values = (over: Partial<ProjectSettingsValues> = {}): ProjectSettingsValues => ({
  worktreeRoot: "  D:\\projects  ",
  gitlabToken: " glpat-x ",
  gitlabHost: "",
  repoProfiles: [],
  flowHubUrl: " https://hub ",
  flowHubToken: "t",
  flowHubAuthor: " 我 ",
  ...over,
})

describe("buildSettingsPatch", () => {
  it("只带用户改过的字段，其它配置不碰（避免用页面里的旧值冲掉别处刚改的）", () => {
    expect(buildSettingsPatch(["worktreeRoot"], values())).toEqual({ worktreeRoot: "D:\\projects" })
    expect(buildSettingsPatch(["gitlabToken", "flowHubAuthor"], values())).toEqual({ gitlabToken: "glpat-x", flowHubAuthor: "我" })
    expect(buildSettingsPatch([], values())).toEqual({})
  })

  it("文本字段去首尾空白；清空是合法的修改（写成空串）", () => {
    expect(buildSettingsPatch(["gitlabHost", "worktreeRoot"], values({ gitlabHost: "   ", worktreeRoot: "" })))
      .toEqual({ gitlabHost: "", worktreeRoot: "" })
  })

  it("改了仓库列表才带 repoProfiles，并同步 repoRoots；没改仓库时绝不带，哪怕别的字段改了", () => {
    const v = values({ repoProfiles: [{ path: " D:\\a ", baseBranch: " main ", testBranch: " ", developBranch: "dev" }, { path: "  ", baseBranch: "x" }] })
    expect(buildSettingsPatch(["repoProfiles"], v)).toEqual({
      repoProfiles: [{ path: "D:\\a", baseBranch: "main", testBranch: undefined, developBranch: "dev" }],
      repoRoots: ["D:\\a"],
    })
    const other = buildSettingsPatch(["gitlabToken"], v)
    expect("repoProfiles" in other).toBe(false)
    expect("repoRoots" in other).toBe(false)
  })

  it("把仓库全删光也是合法修改：写成空列表", () => {
    expect(buildSettingsPatch(["repoProfiles"], values({ repoProfiles: [] }))).toEqual({ repoProfiles: [], repoRoots: [] })
  })
})

describe("cleanRepoProfiles", () => {
  it("丢掉没路径的行，保持顺序；不修改入参", () => {
    const rows = [{ path: "b", baseBranch: "m" }, { path: "", baseBranch: "m" }, { path: "a", baseBranch: " " }]
    const snapshot = JSON.stringify(rows)
    expect(cleanRepoProfiles(rows).map((r) => [r.path, r.baseBranch])).toEqual([["b", "m"], ["a", ""]])
    expect(JSON.stringify(rows)).toBe(snapshot)
  })
})
