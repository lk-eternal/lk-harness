import { describe, expect, it } from "vitest"
import {
  BRANCH_ROW_LIMIT,
  branchGroups,
  branchNotices,
  canSwitchBranch,
  describeSwitchFailure,
  inProgressReason,
  isDetachedLabel,
  makeBranchOverride,
  matchesBranchQuery,
  parseBranchRefs,
  parseBranchTarget,
  parseDirtyCount,
  sharedSessionCount,
  shownBranch,
  type BranchOption,
} from "../src/shared/git-branch"

const TOP = "C:/work/repo"
const lines = (...l: string[]) => l.join("\n")

describe("parseBranchRefs：解析 for-each-ref 的输出", () => {
  it("本地分支带提交时间；当前分支排在最前，其余保持最近提交在前的顺序", () => {
    const out = parseBranchRefs(lines(
      `refs/heads/feature/b\t300\t`,
      `refs/heads/main\t200\t${TOP}`,
      `refs/heads/old\t100\t`,
    ), { current: "main", ownTop: TOP })
    expect(out.map((b) => b.name)).toEqual(["main", "feature/b", "old"])
    expect(out[0]).toMatchObject({ name: "main", kind: "local", current: true, committedAt: 200 })
    expect(out[1].current).toBeUndefined()
  })

  it("在别的工作目录检出的分支标出位置；当前目录自己检出的不算（路径写法不同也认）", () => {
    const out = parseBranchRefs(lines(
      `refs/heads/main\t2\tc:\\work\\repo`,
      `refs/heads/feature/x\t1\tC:/work/wt`,
    ), { current: "main", ownTop: TOP })
    expect(out.find((b) => b.name === "main")?.checkedOutAt).toBeUndefined()
    expect(out.find((b) => b.name === "feature/x")?.checkedOutAt).toBe("C:/work/wt")
  })

  it("远程分支只列本地还没有的；origin/HEAD 不列；同名分支在几个远程都有只列一次", () => {
    const out = parseBranchRefs(lines(
      `refs/heads/main\t5\t`,
      `refs/remotes/origin/main\t5\t`,
      `refs/remotes/origin/HEAD\t5\t`,
      `refs/remotes/origin/release/1.0\t4\t`,
      `refs/remotes/upstream/release/1.0\t3\t`,
      `refs/remotes/upstream/hotfix\t2\t`,
    ), { current: "main", ownTop: TOP })
    expect(out.map((b) => `${b.kind}:${b.remote ?? ""}:${b.name}`)).toEqual([
      "local::main",
      "remote:origin:release/1.0",
      "remote:upstream:hotfix",
    ])
  })

  it("游离 HEAD：没有当前分支", () => {
    const out = parseBranchRefs(`refs/heads/main\t1\t${TOP}`, { ownTop: TOP })
    expect(out.some((b) => b.current)).toBe(false)
  })

  it("空行、没有时间的引用、不认识的引用都不会出错", () => {
    const out = parseBranchRefs(lines("", "refs/heads/a", "refs/tags/v1\t1\t", "refs/remotes/origin\t1\t"), {})
    expect(out).toEqual([{ name: "a", kind: "local" }])
  })
})

describe("parseDirtyCount", () => {
  it("按行数算，空行不算", () => {
    expect(parseDirtyCount("")).toBe(0)
    expect(parseDirtyCount(" M a.txt\r\nM  b.txt\n\n")).toBe(2)
  })
})

describe("describeSwitchFailure：git 的报错翻成人话", () => {
  it("改动会被覆盖：列出文件，让用户先提交或暂存", () => {
    const msg = describeSwitchFailure([
      "error: Your local changes to the following files would be overwritten by checkout:",
      "\ta.txt",
      "\tsrc/b.ts",
      "Please commit your changes or stash them before you switch branches.",
      "Aborting",
    ].join("\n"))
    expect(msg).toBe("有未提交的改动会被目标分支覆盖（a.txt、src/b.ts），请先提交或暂存")
  })

  it("改动的文件太多：只列前三个，说明总数", () => {
    const msg = describeSwitchFailure([
      "error: Your local changes to the following files would be overwritten by checkout:",
      "\t1", "\t2", "\t3", "\t4", "\t5",
      "Please commit your changes or stash them before you switch branches.",
    ].join("\n"))
    expect(msg).toContain("（1、2、3 等 5 个文件）")
  })

  it("未跟踪的文件会被覆盖", () => {
    const msg = describeSwitchFailure([
      "error: The following untracked working tree files would be overwritten by checkout:",
      "\tnew.txt",
      "Please move or remove them before you switch branches.",
      "Aborting",
    ].join("\n"))
    expect(msg).toBe("有未跟踪的文件会被目标分支覆盖（new.txt），请先移走或提交")
  })

  it("分支在别的工作目录检出（新旧两种 git 的措辞都认）", () => {
    expect(describeSwitchFailure("fatal: 'feature/x' is already used by worktree at 'C:/work/wt'")).toBe("这个分支已在另一个工作目录检出：C:/work/wt")
    expect(describeSwitchFailure("fatal: 'feature/x' is already checked out at '/tmp/wt'")).toBe("这个分支已在另一个工作目录检出：/tmp/wt")
  })

  it("index.lock 被占用、合并冲突没解决、不是仓库、分支被删了、超时", () => {
    expect(describeSwitchFailure("fatal: Unable to create 'D:/r/.git/index.lock': File exists.")).toContain("另一个 git 操作正在进行")
    expect(describeSwitchFailure("error: you need to resolve your current index first")).toContain("没解决的合并冲突")
    expect(describeSwitchFailure("fatal: not a git repository (or any of the parent directories): .git")).toBe("这个目录不是 git 仓库")
    expect(describeSwitchFailure("error: pathspec 'x' did not match any file(s) known to git")).toContain("分支不存在")
    expect(describeSwitchFailure("timed out")).toContain("超时")
  })

  it("认不出的：去掉 error:/fatal: 前缀，最多两行，不超过 300 字；什么都没有给个兜底", () => {
    expect(describeSwitchFailure("fatal: something odd\nsecond line\nthird line")).toBe("something odd；second line")
    expect(describeSwitchFailure("x".repeat(500)).length).toBe(300)
    expect(describeSwitchFailure("  ")).toBe("切换失败")
  })

  it("做到一半的操作说明：点名是哪一种", () => {
    expect(inProgressReason("rebase-merge")).toContain("rebase")
    expect(inProgressReason("MERGE_HEAD")).toContain("合并")
  })
})

const local = (name: string, over: Partial<BranchOption> = {}): BranchOption => ({ name, kind: "local", ...over })
const remote = (name: string, over: Partial<BranchOption> = {}): BranchOption => ({ name, kind: "remote", remote: "origin", ...over })

describe("branchGroups：菜单里的分组、搜索和可点状态", () => {
  const branches = [local("main", { current: true }), local("feature/login"), local("feature/pay", { checkedOutAt: "D:\\wt\\pay-wt" }), remote("release/2.0"), remote("hotfix")]

  it("本地在前、远程在后；远程分组的标题说明会创建同名本地分支", () => {
    const groups = branchGroups({ branches }, "")
    expect(groups.map((g) => g.kind)).toEqual(["local", "remote"])
    expect(groups[0].label).toBe("本地分支")
    expect(groups[1].label).toBe("远程 origin · 选中后创建同名本地分支")
    expect(groups[1].rows.map((r) => r.option.name)).toEqual(["release/2.0", "hotfix"])
  })

  it("搜索不分大小写；远程分支也能按「origin/xxx」搜；没有匹配的组不出现", () => {
    expect(branchGroups({ branches }, "LOGIN").flatMap((g) => g.rows.map((r) => r.option.name))).toEqual(["feature/login"])
    expect(branchGroups({ branches }, "origin/rel").map((g) => g.kind)).toEqual(["remote"])
    expect(branchGroups({ branches }, "不存在")).toEqual([])
    expect(matchesBranchQuery(local("a"), "  ")).toBe(true)
  })

  it("在别处检出的分支点不了，行里写明在哪；当前分支始终可点（点了只是关菜单）", () => {
    const rows = branchGroups({ branches }, "")[0].rows
    const pay = rows.find((r) => r.option.name === "feature/pay")!
    expect(pay.disabled).toBe(true)
    expect(pay.note).toBe("已在「pay-wt」检出")
    expect(rows.find((r) => r.option.name === "main")!.disabled).toBe(false)
    expect(rows.find((r) => r.option.name === "feature/login")!.disabled).toBe(false)
  })

  it("现在整体不能切（有会话在回复）：除当前分支外全部点不了", () => {
    const rows = branchGroups({ branches, blocked: "有 1 个会话正在这个目录里工作" }, "").flatMap((g) => g.rows)
    expect(rows.filter((r) => !r.disabled).map((r) => r.option.name)).toEqual(["main"])
  })

  it("太多只显示前面一部分，并告知还有多少没显示", () => {
    const many = Array.from({ length: BRANCH_ROW_LIMIT + 7 }, (_, i) => local(`b${i}`))
    const [g] = branchGroups({ branches: many }, "")
    expect(g.rows).toHaveLength(BRANCH_ROW_LIMIT)
    expect(g.hidden).toBe(7)
    // 搜索缩小范围之后就都能看到
    const [one] = branchGroups({ branches: many }, `b${BRANCH_ROW_LIMIT + 3}`)
    expect(one.rows.map((r) => r.option.name)).toEqual([`b${BRANCH_ROW_LIMIT + 3}`])
    expect(one.hidden).toBe(0)
  })

  it("远程来自多个远程时，标题不写具体远程名", () => {
    const [, g] = branchGroups({ branches: [local("m"), remote("a"), remote("b", { remote: "upstream" })] }, "")
    expect(g.label).toBe("远程 · 选中后创建同名本地分支")
  })
})

describe("branchNotices：菜单顶部的提示", () => {
  it("有会话在回复：只给原因，不再提改动（反正切不了）", () => {
    expect(branchNotices({ blocked: "有 2 个会话正在这个目录里工作", dirty: 3, shared: 2 })).toEqual([
      { tone: "warn", text: "有 2 个会话正在这个目录里工作" },
      { tone: "info", text: "这个目录有 2 个会话在用，切换对它们都生效" },
    ])
  })

  it("有改动：说明会带到新分支、冲突时 git 会拒绝；一个会话用这个目录就不提共用", () => {
    const n = branchNotices({ dirty: 3, shared: 1 })
    expect(n).toHaveLength(1)
    expect(n[0].text).toContain("有 3 个文件有改动")
    expect(n[0].text).toContain("不会丢改动")
  })

  it("干净、没共用：没有提示；分支被截断时提醒用搜索", () => {
    expect(branchNotices({ dirty: 0, shared: 1 })).toEqual([])
    expect(branchNotices({ dirty: 0, shared: 1, truncated: true })[0].text).toContain("搜索")
  })
})

describe("会话能不能切分支", () => {
  it("主目录、常用目录、选了目录的临时会话可以；项目会话和其它不行", () => {
    expect(["main", "dir", "temp"].every(canSwitchBranch)).toBe(true)
    expect(["project", "task", "other", ""].some(canSwitchBranch)).toBe(false)
  })

  it("游离 HEAD 的标签", () => {
    expect(isDetachedLabel("HEAD(abc1234)")).toBe(true)
    expect(isDetachedLabel("HEAD")).toBe(true)
    expect(isDetachedLabel("HEAD-fix")).toBe(false)
    expect(isDetachedLabel("main")).toBe(false)
  })

  it("共用这个目录的会话个数：路径写法不同也算同一个；没有目录是 0", () => {
    const tabs = [{ d: "D:\\w\\a" }, { d: "d:/w/a/" }, { d: "D:\\w\\b" }, { d: undefined }]
    expect(sharedSessionCount(tabs, (t) => t.d, "D:/w/A")).toBe(2)
    expect(sharedSessionCount(tabs, (t) => t.d, undefined)).toBe(0)
  })
})

describe("parseBranchTarget：界面和网关传来的目标只认三个字段", () => {
  it("本地、远程；多余字段丢掉", () => {
    expect(parseBranchTarget({ name: "a", kind: "local", evil: "--force" })).toEqual({ name: "a", kind: "local" })
    expect(parseBranchTarget({ name: "a" })).toEqual({ name: "a", kind: "local" })
    expect(parseBranchTarget({ name: "a", kind: "remote", remote: "origin" })).toEqual({ name: "a", kind: "remote", remote: "origin" })
  })

  it("缺名字、远程缺远程名、类型不对：当成没有", () => {
    for (const bad of [null, undefined, 1, "a", {}, { name: "" }, { name: 3 }, { name: "a", kind: "remote" }, { name: "a", kind: "remote", remote: 1 }]) {
      expect(parseBranchTarget(bad)).toBeUndefined()
    }
  })
})

describe("shownBranch：刚切完、列表还没刷新到时按钮显示新分支", () => {
  const ov = makeBranchOverride("main", "feature/x", 1000)

  it("列表读到的还是切换前的旧值：先显示新分支", () => {
    expect(shownBranch("main", ov, 2000)).toBe("feature/x")
  })

  it("列表已经刷新到新分支、或读到别的值（在终端里又切了）：以读到的为准", () => {
    expect(shownBranch("feature/x", ov, 2000)).toBe("feature/x")
    expect(shownBranch("develop", ov, 2000)).toBe("develop")
  })

  it("超过期限就不再顶替；没有覆盖或没有读到分支时原样返回", () => {
    expect(shownBranch("main", ov, ov.until)).toBe("main")
    expect(shownBranch("main", null, 2000)).toBe("main")
    expect(shownBranch(undefined, ov, 2000)).toBeUndefined()
  })
})
