import { describe, expect, it, vi } from "vitest"
import { createSessionBranchService, dirInsideRepo, workingBlockedReason, type SessionBranchDeps } from "../electron/session-branch-core"
import type { BranchState } from "../electron/git-branch"

const A = "app_main::D:\\work\\repo"
const B = "app_main::D:\\work\\repo\\sub"

const baseState = (over: Partial<BranchState> = {}): BranchState => ({
  toplevel: "D:/work/repo",
  current: "main",
  detached: false,
  branches: [{ name: "main", kind: "local", current: true }, { name: "dev", kind: "local" }],
  dirty: 0,
  truncated: false,
  ...over,
})

function setup(over: Partial<SessionBranchDeps> = {}) {
  const deps: SessionBranchDeps = {
    resolveDir: vi.fn(() => ({ ok: true as const, dir: "D:\\work\\repo" })),
    workingSessions: vi.fn(async () => []),
    readState: vi.fn(async () => ({ ok: true as const, ...baseState() })),
    switchBranch: vi.fn(async () => ({ ok: true as const, current: "dev" })),
    switched: vi.fn(),
    ...over,
  }
  return { deps, svc: createSessionBranchService(deps) }
}

describe("分支列表：现在能不能切", () => {
  it("没人在这个目录里工作：列表原样带出，没有 blocked", async () => {
    const { svc } = setup({ readState: vi.fn(async () => ({ ok: true as const, ...baseState({ dirty: 2, truncated: true }) })) })
    const r = await svc.list(A)
    expect(r).toMatchObject({ ok: true, current: "main", detached: false, dirty: 2, truncated: true })
    expect(r.ok && r.blocked).toBeUndefined()
    expect(r.ok && r.branches.map((b) => b.name)).toEqual(["main", "dev"])
  })

  it("自己的会话正在回复：说是这个会话", async () => {
    const { svc } = setup({ workingSessions: vi.fn(async () => [A.toLowerCase()]) })
    const r = await svc.list(A)
    expect(r.ok && r.blocked).toBe("这个会话正在回复，等它结束再切换分支")
  })

  it("别的会话在这个目录里工作：说有几个", async () => {
    const { svc } = setup({ workingSessions: vi.fn(async () => [B, "x::D:\\work\\repo"]) })
    const r = await svc.list(A)
    expect(r.ok && r.blocked).toBe("有 2 个会话正在这个目录里工作，等它们结束再切换分支")
  })

  it("rebase、合并做到一半：原因优先于会话在工作", async () => {
    const { svc } = setup({
      readState: vi.fn(async () => ({ ok: true as const, ...baseState({ inProgress: "目录里有一次 rebase 做到一半，请先完成或中止它再切换分支" }) })),
      workingSessions: vi.fn(async () => [B]),
    })
    const r = await svc.list(A)
    expect(r.ok && r.blocked).toContain("rebase")
  })

  it("会话没有可用的目录（项目会话、没选目录）：原因原样交回，不去读 git", async () => {
    const { svc, deps } = setup({ resolveDir: vi.fn(() => ({ ok: false as const, error: "项目会话的分支由项目管理，不能在这里切换" })) })
    expect(await svc.list(A)).toEqual({ ok: false, error: "项目会话的分支由项目管理，不能在这里切换" })
    expect(deps.readState).not.toHaveBeenCalled()
  })

  it("读 git 失败：原因交回", async () => {
    const { svc } = setup({ readState: vi.fn(async () => ({ ok: false as const, error: "这个目录不是 git 仓库" })) })
    expect(await svc.list(A)).toEqual({ ok: false, error: "这个目录不是 git 仓库" })
  })

  it("把仓库根目录交给「哪些会话在工作」去比对", async () => {
    const { svc, deps } = setup()
    await svc.list(A)
    expect(deps.workingSessions).toHaveBeenCalledWith("D:\\work\\repo", "D:/work/repo")
  })
})

describe("切换", () => {
  const target = { name: "dev", kind: "local" as const }

  it("成功：交给 git 切，返回新分支，并通知「已切换」（带上从哪切到哪）", async () => {
    const { svc, deps } = setup()
    expect(await svc.switchTo(A, target)).toEqual({ ok: true, current: "dev" })
    expect(deps.switchBranch).toHaveBeenCalledWith("D:\\work\\repo", target)
    expect(deps.switched).toHaveBeenCalledWith({ sessionKey: A, dir: "D:\\work\\repo", from: "main", to: "dev" })
  })

  it("有会话正在回复：拒绝，git 一次都没碰", async () => {
    const { svc, deps } = setup({ workingSessions: vi.fn(async () => [B]) })
    const r = await svc.switchTo(A, target)
    expect(r).toEqual({ ok: false, error: "有 1 个会话正在这个目录里工作，等它们结束再切换分支" })
    expect(deps.switchBranch).not.toHaveBeenCalled()
    expect(deps.switched).not.toHaveBeenCalled()
  })

  it("git 拒绝（有冲突等）：原因交回，不通知已切换", async () => {
    const { svc, deps } = setup({ switchBranch: vi.fn(async () => ({ ok: false as const, error: "有未提交的改动会被目标分支覆盖（a.txt），请先提交或暂存" })) })
    expect(await svc.switchTo(A, target)).toEqual({ ok: false, error: "有未提交的改动会被目标分支覆盖（a.txt），请先提交或暂存" })
    expect(deps.switched).not.toHaveBeenCalled()
  })

  it("已经在目标分支上：成功，但不算切换，不通知", async () => {
    const { svc, deps } = setup({ switchBranch: vi.fn(async () => ({ ok: true as const, current: "main" })) })
    expect(await svc.switchTo(A, { name: "main", kind: "local" })).toEqual({ ok: true, current: "main" })
    expect(deps.switched).not.toHaveBeenCalled()
  })

  it("没有可用的目录：原因交回，不动 git", async () => {
    const { svc, deps } = setup({ resolveDir: vi.fn(() => ({ ok: false as const, error: "这个会话还没有选工作目录" })) })
    expect(await svc.switchTo(A, target)).toEqual({ ok: false, error: "这个会话还没有选工作目录" })
    expect(deps.switchBranch).not.toHaveBeenCalled()
  })

  it("同一个目录同时只切一次：第二个请求被拒，列表里也提示；不同目录互不影响；切完之后又能切", async () => {
    let finish: (v: { ok: true; current: string }) => void = () => undefined
    const gate = new Promise<{ ok: true; current: string }>((resolve) => { finish = resolve })
    const dirs: Record<string, string> = { s1: "D:\\work\\repo", s2: "d:/work/repo/", s3: "D:\\other" }
    const { svc, deps } = setup({
      resolveDir: (key) => ({ ok: true as const, dir: dirs[key] }),
      switchBranch: vi.fn().mockImplementationOnce(() => gate).mockResolvedValue({ ok: true, current: "dev" }),
    })

    const first = svc.switchTo("s1", target)
    await vi.waitFor(() => expect(deps.switchBranch).toHaveBeenCalledTimes(1))
    // 两端同时点（或连点）：同一个目录，路径写法不同也一样
    expect(await svc.switchTo("s2", target)).toEqual({ ok: false, error: "正在切换分支，请稍候" })
    const listed = await svc.list("s2")
    expect(listed.ok && listed.blocked).toBe("正在切换分支，请稍候")
    // 别的目录不受影响
    expect(await svc.switchTo("s3", target)).toEqual({ ok: true, current: "dev" })

    finish({ ok: true, current: "dev" })
    expect(await first).toEqual({ ok: true, current: "dev" })
    expect(await svc.switchTo("s2", target)).toEqual({ ok: true, current: "dev" })
  })

  it("切的过程中出了意外：占着的目录也会放开，不会永远切不了", async () => {
    const { svc } = setup({ switchBranch: vi.fn().mockRejectedValueOnce(new Error("boom")).mockResolvedValue({ ok: true, current: "dev" }) })
    await expect(svc.switchTo(A, target)).rejects.toThrow("boom")
    expect(await svc.switchTo(A, target)).toEqual({ ok: true, current: "dev" })
  })
})

describe("workingBlockedReason", () => {
  it("没人在工作：没有原因", () => {
    expect(workingBlockedReason(A, [])).toBeUndefined()
  })
  it("会话键大小写、斜杠写法不同也认得出是自己", () => {
    expect(workingBlockedReason("app_main::D:\\work\\repo", ["APP_MAIN::d:/work/repo"])).toBe("这个会话正在回复，等它结束再切换分支")
  })
})

describe("dirInsideRepo：会话的目录在不在这个仓库里", () => {
  it("仓库根、子目录算；同名前缀的兄弟目录、上级目录不算；写法不同也认", () => {
    expect(dirInsideRepo("D:\\work\\repo", "D:/work/repo")).toBe(true)
    expect(dirInsideRepo("d:/WORK/repo/packages/a", "D:/work/repo")).toBe(true)
    expect(dirInsideRepo("D:\\work\\repo-2", "D:/work/repo")).toBe(false)
    expect(dirInsideRepo("D:\\work", "D:/work/repo")).toBe(false)
  })
})
