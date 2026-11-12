import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
  createBugWatcher,
  createMeegleBugSource,
  runBugWatchCycle,
  type BugWatchDeps,
  type WatchProject,
} from "../src/daemon-bug-watch"
import type { BugRecord, BugWatchState } from "../src/shared/project-bug-watch"

const URL_OF = (id: string) => `https://project.feishu.cn/wk-dm/story/detail/${id}`
/** 项目 id → 纯数字的需求 id（链接里的需求 id 必须是数字） */
const storyIdOf = (projectId: string) => [...projectId].map((c) => c.charCodeAt(0)).join("")
/** 替身 fetchStoryName 给出的需求名称 */
const nameOf = (projectId: string) => `需求${storyIdOf(projectId)}`
const bug = (id: number, extra: Partial<BugRecord> = {}): BugRecord =>
  ({ id: String(id), name: `缺陷${id}`, status: "OPEN", assignee: "张三", priority: "P2", ...extra })

const proj = (id: string, extra: Partial<WatchProject> = {}): WatchProject =>
  ({ id, name: `项目${id}`, storyUrl: URL_OF(storyIdOf(id)), watchBugs: true, ...extra })

/** 可编排的替身：records 记下所有外部动作，便于断言「没调用 / 调了几次」 */
function harness(initial: { projects: WatchProject[]; bugs?: Record<string, BugRecord[] | Error>; names?: Record<string, string | undefined> }) {
  const h = {
    projects: initial.projects,
    bugsByName: { ...(initial.bugs ?? {}) } as Record<string, BugRecord[] | Error>,
    names: { ...(initial.names ?? {}) } as Record<string, string | undefined>,
    authed: true,
    deliver: (() => ({ ok: true })) as BugWatchDeps["deliverToSession"],
    notifyError: undefined as Error | undefined,
    state: {} as BugWatchState,
    now: 1_000_000,
    calls: { auth: 0, storyName: 0, bugs: 0, saves: 0 },
    session: [] as Array<{ project: string; text: string }>,
    group: [] as Array<{ project: string; text: string }>,
    logs: [] as string[],
  }
  const deps: BugWatchDeps = {
    now: () => h.now,
    listProjects: () => h.projects,
    authenticated: async () => { h.calls.auth++; return h.authed },
    fetchStoryName: async (storyId) => {
      h.calls.storyName++
      return storyId in h.names ? h.names[storyId] : `需求${storyId}`
    },
    fetchBugs: async (name) => {
      h.calls.bugs++
      const r = h.bugsByName[name]
      if (r instanceof Error) throw r
      return r ?? []
    },
    loadState: () => JSON.parse(JSON.stringify(h.state)) as BugWatchState,
    saveState: (s) => { h.calls.saves++; h.state = JSON.parse(JSON.stringify(s)) as BugWatchState },
    deliverToSession: (p, text) => {
      const r = h.deliver(p, text)
      if (r.ok) h.session.push({ project: p.id, text })
      return r
    },
    notifyGroup: async (p, text) => {
      if (h.notifyError) throw h.notifyError
      h.group.push({ project: p.id, text })
    },
    log: (_l, m) => { h.logs.push(m) },
  }
  return { h, deps }
}

describe("runBugWatchCycle：什么时候查、查谁", () => {
  it("没有任何项目开着监控：不碰飞书项目 CLI（零成本）", async () => {
    const { h, deps } = harness({ projects: [proj("p1", { watchBugs: false }), proj("p2", { watchBugs: undefined })] })
    const r = await runBugWatchCycle(deps)
    expect(r.ran).toBe(false)
    expect(h.calls).toEqual({ auth: 0, storyName: 0, bugs: 0, saves: 0 })
  })

  it("开了监控但项目已归档 / 需求链接不支持：跳过并说明原因，不查", async () => {
    const { h, deps } = harness({
      projects: [
        proj("archived", { archivedAt: 1_700_000_000_000 }),
        proj("nourl", { storyUrl: undefined }),
        proj("tech", { storyUrl: "https://project.feishu.cn/wk-dm/t1024/detail/1" }),
      ],
    })
    const r = await runBugWatchCycle(deps)
    expect(r.ran).toBe(false)
    const by = Object.fromEntries(r.projects.map((p) => [p.projectId, p]))
    expect(by.archived).toMatchObject({ result: "skipped", detail: "项目已归档" })
    expect(by.nourl.detail).toContain("没有填")
    expect(by.tech.detail).toContain("wk-dm")
    expect(h.calls.bugs).toBe(0)
    expect(h.calls.auth).toBe(0)
  })

  it("飞书项目 CLI 没登录：整轮跳过，记录不动", async () => {
    const { h, deps } = harness({ projects: [proj("p1")] })
    h.authed = false
    const r = await runBugWatchCycle(deps)
    expect(r.ran).toBe(false)
    expect(r.reason).toContain("未登录")
    expect(h.calls.bugs).toBe(0)
    expect(h.state).toEqual({})
  })

  it("指定 projectId：只查这一个", async () => {
    const { h, deps } = harness({ projects: [proj("p1"), proj("p2")] })
    const r = await runBugWatchCycle(deps, { projectId: "p2" })
    expect(r.projects.map((p) => p.projectId)).toEqual(["p2"])
    expect(h.calls.bugs).toBe(1)
  })
})

describe("runBugWatchCycle：基线 / 新缺陷 / 去重", () => {
  it("第一轮只建基线（不通知）；之后新增的才投给项目会话并通知项目群；再下一轮不重复", async () => {
    const { h, deps } = harness({ projects: [proj("p1")], bugs: { [nameOf("p1")]: [bug(1), bug(2)] } })

    const r1 = await runBugWatchCycle(deps)
    expect(r1.projects[0]).toMatchObject({ result: "baseline" })
    expect(h.session).toEqual([])
    expect(h.group).toEqual([])
    expect(Object.keys(h.state.p1.seen).sort()).toEqual(["1", "2"])

    h.bugsByName[nameOf("p1")] = [bug(1), bug(2), bug(3, { name: "新出的缺陷" })]
    const r2 = await runBugWatchCycle(deps)
    expect(r2.projects[0]).toMatchObject({ result: "new", fresh: 1 })
    expect(h.session).toHaveLength(1)
    expect(h.session[0].text).toContain("新出的缺陷")
    expect(h.session[0].text).toContain("缺陷监控")
    expect(h.session[0].text).not.toContain("缺陷1")
    expect(h.group).toHaveLength(1)
    expect(h.group[0].text).toContain("新出的缺陷")

    const r3 = await runBugWatchCycle(deps)
    expect(r3.projects[0]).toMatchObject({ result: "unchanged" })
    expect(h.session).toHaveLength(1)
    expect(h.group).toHaveLength(1)
  })

  it("一轮发现多个新缺陷：合成一条消息，不是一个缺陷一条", async () => {
    const { h, deps } = harness({ projects: [proj("p1")], bugs: { [nameOf("p1")]: [bug(1)] } })
    await runBugWatchCycle(deps)
    h.bugsByName[nameOf("p1")] = [bug(1), bug(2), bug(3), bug(4)]
    const r = await runBugWatchCycle(deps)
    expect(r.projects[0].fresh).toBe(3)
    expect(h.session).toHaveLength(1)
    expect(h.group).toHaveLength(1)
  })

  it("投给项目会话失败（比如项目还没有会话）：不记账，下一轮重试；成功后不再重复", async () => {
    const { h, deps } = harness({ projects: [proj("p1")], bugs: { [nameOf("p1")]: [bug(1)] } })
    await runBugWatchCycle(deps)
    h.bugsByName[nameOf("p1")] = [bug(1), bug(2)]

    h.deliver = () => ({ ok: false, error: "项目还没有会话" })
    const failed = await runBugWatchCycle(deps)
    expect(failed.projects[0]).toMatchObject({ result: "error", fresh: 1 })
    expect(failed.projects[0].detail).toContain("项目还没有会话")
    expect(h.state.p1.seen["2"]).toBeUndefined() // 没记账
    expect(h.group).toEqual([]) // 会话没收到，也就不通知群里说「已转给项目会话」

    h.deliver = () => ({ ok: true })
    const retried = await runBugWatchCycle(deps)
    expect(retried.projects[0]).toMatchObject({ result: "new", fresh: 1 })
    expect(h.state.p1.seen["2"]).toBe("OPEN")
    expect((await runBugWatchCycle(deps)).projects[0].result).toBe("unchanged")
  })

  it("群通知失败：已经投给会话，照常记账，不会下一轮重复投递", async () => {
    const { h, deps } = harness({ projects: [proj("p1")], bugs: { [nameOf("p1")]: [bug(1)] } })
    await runBugWatchCycle(deps)
    h.bugsByName[nameOf("p1")] = [bug(1), bug(2)]
    h.notifyError = new Error("群被解散了")
    const r = await runBugWatchCycle(deps)
    expect(r.projects[0].result).toBe("new")
    expect(h.session).toHaveLength(1)
    expect(h.logs.some((l) => l.includes("群通知失败"))).toBe(true)
    expect((await runBugWatchCycle(deps)).projects[0].result).toBe("unchanged")
    expect(h.session).toHaveLength(1)
  })
})

describe("runBugWatchCycle：查询失败的处理", () => {
  it("查询失败不更新记录，更不会拿失败当基线：之后第一次成功的结果仍然只是基线、不刷屏", async () => {
    const { h, deps } = harness({ projects: [proj("p1")], bugs: { [nameOf("p1")]: new Error("timeout") } })
    const r1 = await runBugWatchCycle(deps)
    expect(r1.projects[0]).toMatchObject({ result: "error", detail: "timeout" })
    expect(h.state).toEqual({})

    h.bugsByName[nameOf("p1")] = [bug(1), bug(2), bug(3), bug(4), bug(5)]
    const r2 = await runBugWatchCycle(deps)
    expect(r2.projects[0].result).toBe("baseline")
    expect(h.session).toEqual([])
  })

  it("一个项目查失败不影响其它项目", async () => {
    const { h, deps } = harness({
      projects: [proj("a"), proj("b")],
      bugs: { [nameOf("a")]: new Error("boom"), [nameOf("b")]: [bug(1)] },
    })
    const r = await runBugWatchCycle(deps)
    expect(r.ran).toBe(true)
    expect(r.projects.map((p) => [p.projectId, p.result])).toEqual([["a", "error"], ["b", "baseline"]])
    expect(h.state.b).toBeDefined()
    expect(h.state.a).toBeUndefined()
  })

  it("取不到需求名称：报错，不查缺陷", async () => {
    const { h, deps } = harness({ projects: [proj("p1")], names: { [storyIdOf("p1")]: undefined } })
    const r = await runBugWatchCycle(deps)
    expect(r.projects[0].result).toBe("error")
    expect(r.projects[0].detail).toContain("取不到需求")
    expect(h.calls.bugs).toBe(0)
  })

  it("需求名称含引号等没法安全拼进查询：跳过并说明，不查", async () => {
    const { h, deps } = harness({ projects: [proj("p1")], names: { [storyIdOf("p1")]: "含'引号" } })
    const r = await runBugWatchCycle(deps)
    expect(r.projects[0].result).toBe("skipped")
    expect(h.calls.bugs).toBe(0)
  })
})

describe("runBugWatchCycle：记录的维护", () => {
  it("需求名称缓存在记录里：之后每轮不再重复取；换了需求链接就重新取并重新建基线", async () => {
    const { h, deps } = harness({ projects: [proj("p1")], bugs: { [nameOf("p1")]: [bug(1)], "需求123456": [bug(9), bug(10)] } })
    await runBugWatchCycle(deps)
    await runBugWatchCycle(deps)
    expect(h.calls.storyName).toBe(1)

    h.projects = [proj("p1", { storyUrl: URL_OF("123456") })]
    const r = await runBugWatchCycle(deps)
    expect(h.calls.storyName).toBe(2)
    expect(r.projects[0].result).toBe("baseline") // 新需求下已有的缺陷不当新缺陷
    expect(h.session).toEqual([])
  })

  it("已删除项目的记录会被清掉；监控关掉的项目记录保留（再打开不重新刷屏）", async () => {
    const { h, deps } = harness({ projects: [proj("keep"), proj("gone")], bugs: { [nameOf("keep")]: [bug(1)], [nameOf("gone")]: [bug(1)] } })
    await runBugWatchCycle(deps)
    expect(Object.keys(h.state).sort()).toEqual(["gone", "keep"])

    h.projects = [proj("keep", { watchBugs: false })]
    await runBugWatchCycle(deps)
    expect(Object.keys(h.state)).toEqual(["keep"])
  })
})

describe("createBugWatcher：定时与重入", () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  it("启动后先等一小会儿做第一轮，之后按间隔重复；stop 之后不再跑", async () => {
    const { h, deps } = harness({ projects: [proj("p1")], bugs: { [nameOf("p1")]: [bug(1)] } })
    const w = createBugWatcher(deps, { intervalMs: 1000, firstDelayMs: 200 })
    w.start()
    expect(h.calls.auth).toBe(0)
    await vi.advanceTimersByTimeAsync(250)
    expect(h.calls.auth).toBe(1)
    await vi.advanceTimersByTimeAsync(1000)
    expect(h.calls.auth).toBe(2)
    w.stop()
    await vi.advanceTimersByTimeAsync(5000)
    expect(h.calls.auth).toBe(2)
  })

  it("重复 start 不会起两套定时器", async () => {
    const { h, deps } = harness({ projects: [proj("p1")], bugs: { [nameOf("p1")]: [bug(1)] } })
    const w = createBugWatcher(deps, { intervalMs: 1000, firstDelayMs: 100 })
    w.start(); w.start()
    await vi.advanceTimersByTimeAsync(150)
    expect(h.calls.auth).toBe(1)
    w.stop()
  })

  it("上一轮没结束时再触发不重入", async () => {
    const { h, deps } = harness({ projects: [proj("p1")], bugs: { [nameOf("p1")]: [bug(1)] } })
    let release: () => void = () => {}
    const gate = new Promise<void>((r) => { release = r })
    const slowAuth = deps.authenticated
    deps.authenticated = async () => { await gate; return slowAuth() }
    const w = createBugWatcher(deps)

    const first = w.runNow()
    const second = await w.runNow()
    expect(second).toMatchObject({ ran: false, reason: "上一轮还没结束" })
    release()
    expect((await first).ran).toBe(true)
    expect(h.calls.bugs).toBe(1)
    expect((await w.runNow()).ran).toBe(true) // 结束后可以再跑
  })

  it("一轮里抛出意外错误：不冒泡，下一轮照常", async () => {
    const { h, deps } = harness({ projects: [proj("p1")], bugs: { [nameOf("p1")]: [bug(1)] } })
    let boom = true
    const orig = deps.listProjects
    deps.listProjects = () => { if (boom) throw new Error("读项目失败"); return orig() }
    const w = createBugWatcher(deps)
    const r1 = await w.runNow()
    expect(r1).toMatchObject({ ran: false, reason: "读项目失败" })
    boom = false
    expect((await w.runNow()).ran).toBe(true)
    expect(h.logs.some((l) => l.includes("本轮异常"))).toBe(true)
  })
})

describe("createMeegleBugSource：给飞书项目 CLI 的参数和结果判断", () => {
  const okResult = { data: { "1": [{ moql_field_list: [
    { key: "work_item_id", value_type: "long_value", value: { long_value: 5 } },
    { key: "name", value_type: "string_value", value: { string_value: "某缺陷" } },
  ] }] } }

  it("取需求名称：workitem get，空间 wk-dm，读 work_item_attribute.work_item_name", async () => {
    const run = vi.fn(async () => ({ work_item_attribute: { work_item_name: "  【满班率】组班 " } }))
    const src = createMeegleBugSource(run)
    expect(await src.fetchStoryName("7141906911")).toBe("【满班率】组班")
    const args = run.mock.calls[0][0] as string[]
    expect(args.slice(0, 2)).toEqual(["workitem", "get"])
    expect(args).toContain("--work-item-id")
    expect(args[args.indexOf("--work-item-id") + 1]).toBe("7141906911")
    expect(args[args.indexOf("--project-key") + 1]).toBe("wk-dm")
  })

  it("需求不存在（没返回名称）→ undefined", async () => {
    expect(await createMeegleBugSource(async () => ({}) ).fetchStoryName("1")).toBeUndefined()
    expect(await createMeegleBugSource(async () => null).fetchStoryName("1")).toBeUndefined()
  })

  it("查缺陷：workitem query，-P 里是带需求名称的 mql；解析出缺陷", async () => {
    const run = vi.fn(async () => okResult)
    const bugs = await createMeegleBugSource(run).fetchBugs("【满班率】组班")
    expect(bugs).toEqual([{ id: "5", name: "某缺陷", status: "", assignee: "", priority: "" }])
    const args = run.mock.calls[0][0] as string[]
    expect(args.slice(0, 2)).toEqual(["workitem", "query"])
    const mql = (JSON.parse(args[args.indexOf("-P") + 1]) as { mql: string }).mql
    expect(mql).toContain("array_contains(`关联产品需求`, '【满班率】组班')")
  })

  it("返回看不懂的东西 → 抛错（不能当成「没有缺陷」）；确实没有缺陷（data 里空）→ 空数组", async () => {
    await expect(createMeegleBugSource(async () => ({ error: "x" })).fetchBugs("组班")).rejects.toThrow("无法识别")
    expect(await createMeegleBugSource(async () => ({ data: { "1": [] } })).fetchBugs("组班")).toEqual([])
  })

  it("CLI 本身抛错（超时 / 退出码非 0）→ 原样抛出", async () => {
    await expect(createMeegleBugSource(async () => { throw new Error("ETIMEDOUT") }).fetchBugs("组班")).rejects.toThrow("ETIMEDOUT")
  })

  it("名称不能安全拼进查询 → 抛错，不调用 CLI", async () => {
    const run = vi.fn(async () => okResult)
    await expect(createMeegleBugSource(run).fetchBugs("a'b")).rejects.toThrow()
    expect(run).not.toHaveBeenCalled()
  })
})
