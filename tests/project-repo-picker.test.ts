import { describe, expect, it } from "vitest"
import {
  DEFAULT_REMOTE_BASE_BRANCH, parseRemoteRepoInput, picksOf, repoItemsFromOptions, upsertPickedRepo,
} from "../src/shared/project-repo-picker"
import { repoIdentityKey, repoPicksProblem } from "../src/shared/project-app-types"

const opts = [
  { path: "D:\\code\\shop", name: "shop", baseBranch: "develop" },
  { path: "https://git.example.com/team/api.git", name: "api", baseBranch: "master" },
]

describe("repoItemsFromOptions", () => {
  it("记住的仓库变成候选：默认都不勾，保留各自基线分支，能分出远程", () => {
    const items = repoItemsFromOptions(opts)
    expect(items.map((i) => [i.name, i.baseBranch, i.checked, i.remote])).toEqual([
      ["shop", "develop", false, false],
      ["api", "master", false, true],
    ])
  })

  it("同一个仓库写了两遍（大小写、末尾斜杠、.git 不同）只留第一个；没有基线分支的补默认值", () => {
    const items = repoItemsFromOptions([
      { path: "D:\\code\\shop", name: "shop", baseBranch: "" },
      { path: "d:\\code\\SHOP\\", name: "shop", baseBranch: "x" },
      { path: "https://g.com/a/b.git", name: "b", baseBranch: "m" },
      { path: "https://g.com/a/b", name: "b", baseBranch: "n" },
    ])
    expect(items).toHaveLength(2)
    expect(items[0].baseBranch).toBe(DEFAULT_REMOTE_BASE_BRANCH)
  })
})

describe("upsertPickedRepo", () => {
  it("新仓库：追加并勾上，用传进来的默认分支和分支提示", () => {
    const next = upsertPickedRepo([], { path: " D:\\code\\mall ", baseBranch: "develop", branches: ["develop", "main"] })
    expect(next).toHaveLength(1)
    expect(next[0]).toMatchObject({ path: "D:\\code\\mall", name: "mall", baseBranch: "develop", checked: true, remote: false, inspected: true })
    expect(next[0].branches).toEqual(["develop", "main"])
  })

  it("已有的仓库：只勾上并补分支提示，不覆盖用户已经改过的基线分支；入参不被修改", () => {
    const base = repoItemsFromOptions(opts).map((i) => ({ ...i, baseBranch: i.name === "shop" ? "release" : i.baseBranch }))
    const snapshot = JSON.stringify(base)
    const next = upsertPickedRepo(base, { path: "d:\\code\\shop\\", baseBranch: "main", branches: ["a", "b"] })
    expect(next).toHaveLength(2)
    expect(next[0]).toMatchObject({ checked: true, baseBranch: "release", branches: ["a", "b"], inspected: true })
    expect(next[1].checked).toBe(false)
    expect(JSON.stringify(base)).toBe(snapshot)
  })

  it("远程地址：识别为远程，没给基线分支用默认值，没读过分支提示", () => {
    const next = upsertPickedRepo([], { path: "git@github.com:me/x.git" })
    expect(next[0]).toMatchObject({ remote: true, baseBranch: DEFAULT_REMOTE_BASE_BRANCH, inspected: false, branches: [] })
  })
})

describe("parseRemoteRepoInput", () => {
  it("合法的远程地址（去掉首尾空白）通过", () => {
    for (const ok of ["https://g.com/a/b.git", "http://g.com/a/b", "ssh://git@g.com/a/b.git", "git@g.com:a/b.git"]) {
      expect(parseRemoteRepoInput(`  ${ok}  `)).toEqual({ ok: true, url: ok })
    }
  })

  it("空、不是远程地址（本地路径、相对路径）、含空格：给人话报错", () => {
    for (const bad of ["", "   ", "D:\\code\\shop", "/home/me/shop", "github.com/a/b", "https://g.com/a b"]) {
      const r = parseRemoteRepoInput(bad)
      expect(r.ok, `「${bad}」`).toBe(false)
      if (!r.ok) expect(r.error.length).toBeGreaterThan(0)
    }
  })
})

describe("picksOf + 校验", () => {
  it("只取勾上的，保持候选顺序，基线分支去空白", () => {
    const items = repoItemsFromOptions(opts).map((i) => ({ ...i, checked: true, baseBranch: ` ${i.baseBranch} ` }))
    expect(picksOf(items)).toEqual([
      { repoPath: "D:\\code\\shop", baseBranch: "develop" },
      { repoPath: "https://git.example.com/team/api.git", baseBranch: "master" },
    ])
    expect(picksOf(items.map((i) => ({ ...i, checked: false })))).toEqual([])
  })

  it("没勾、基线分支被清空、选重了，都能被 repoPicksProblem 拦下", () => {
    const items = repoItemsFromOptions(opts)
    expect(repoPicksProblem(picksOf(items))).toContain("至少选一个")
    const one = upsertPickedRepo(items, { path: "D:\\code\\shop" }).map((i) => i.checked ? { ...i, baseBranch: "" } : i)
    expect(repoPicksProblem(picksOf(one))).toContain("基线分支")
    expect(repoPicksProblem([{ repoPath: "D:\\a\\x", baseBranch: "m" }, { repoPath: "d:\\a\\X\\", baseBranch: "m" }])).toContain("选重了")
    expect(repoPicksProblem([{ repoPath: "D:\\a\\x", baseBranch: "m" }])).toBe("")
  })

  it("repoIdentityKey 和 repoPicksProblem 的判重规则一致", () => {
    expect(repoIdentityKey(" https://g.com/a/B.git/ ")).toBe(repoIdentityKey("https://g.com/a/b"))
  })
})
