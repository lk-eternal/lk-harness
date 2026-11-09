import { describe, expect, it } from "vitest"
import {
  AI_SCHEDULE_LIMITS,
  aiTasksOwnedBy,
  buildAiScheduleTask,
  describeAiTask,
  everyMinutesToCron,
  evaluateAiTaskFire,
  isAiTaskLive,
  mergeSavedTasksKeepingAi,
  minGapMinutes,
  type AiScheduleInput,
  type AiScheduleOwner,
} from "../src/shared/ai-schedule.js"
import type { ScheduledTask } from "../src/shared/scheduled-task.js"

const NOW = new Date("2026-11-06T10:00:00+08:00").getTime()
const HOUR = 3_600_000

const mainOwner: AiScheduleOwner = { sessionKey: "ch_a|ou_main::D:/ws", kind: "main", channelId: "ch_a" }
const projectOwner: AiScheduleOwner = { sessionKey: "ch_a|oc_grp::project_p1", kind: "project", channelId: "ch_a", projectId: "p1" }

function input(over: Partial<AiScheduleInput> = {}): AiScheduleInput {
  return { name: "盯缺陷", prompt: "查一下项目有没有新缺陷", everyMinutes: 30, maxRuns: 10, ...over }
}

function build(over: Partial<AiScheduleInput> = {}, owner = mainOwner, activeCount = 0) {
  return buildAiScheduleTask(input(over), owner, { now: NOW, activeCount, id: "ai-test" })
}

describe("everyMinutesToCron：只收能均匀切开一小时/一天的间隔", () => {
  it.each([
    [5, "*/5 * * * *"],
    [10, "*/10 * * * *"],
    [30, "*/30 * * * *"],
    [60, "0 * * * *"],
    [120, "0 */2 * * *"],
    [360, "0 */6 * * *"],
    [1440, "0 0 * * *"],
  ])("%i 分钟 → %s", (n, cron) => {
    expect(everyMinutesToCron(n)).toEqual({ ok: true, cron })
  })

  it.each([7, 45, 90, 420, 0, -5, 2.5, Number.NaN])("%s 被拒绝", (n) => {
    expect(everyMinutesToCron(n).ok).toBe(false)
  })

  it("拒绝的原因是整点附近会出现更短间隔：每 7 分钟 :56 → :00 只隔 4 分钟", () => {
    expect(minGapMinutes("*/7 * * * *", new Date(NOW))).toBe(4)
  })
})

describe("minGapMinutes", () => {
  it("每天一次 = 1440 分钟", () => {
    expect(minGapMinutes("0 9 * * *", new Date(NOW))).toBe(1440)
  })
  it("无效 cron 返回 null", () => {
    expect(minGapMinutes("not a cron", new Date(NOW))).toBeNull()
  })
  it("带秒的 6 段 cron 也能识别出过密", () => {
    expect(minGapMinutes("*/10 * * * * *", new Date(NOW))).toBeLessThan(1)
  })
  it("不规则间隔取最小的那个", () => {
    expect(minGapMinutes("0,2 9 * * *", new Date(NOW))).toBe(2)
  })
})

describe("buildAiScheduleTask：校验", () => {
  it("正常请求：fresh 模式 = 独立运行 + 结果投回本会话（notify=agent）", () => {
    const r = build()
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.task).toMatchObject({
      id: "ai-test",
      name: "盯缺陷",
      cron: "*/30 * * * *",
      content: "查一下项目有没有新缺陷",
      enabled: true,
      independent: true,
      notify: "agent",
      channelId: "ch_a",
      createdBy: "ai",
      createdAt: NOW,
      ownerSessionKey: mainOwner.sessionKey,
      maxRuns: 10,
    })
    expect(r.task.targetProjectId).toBeUndefined()
    expect(r.task.expiresAt).toBeUndefined()
    expect(r.nextRuns).toHaveLength(3)
  })

  it("session 模式 = 非独立运行，不带 notify", () => {
    const r = build({ mode: "session" })
    expect(r.ok && r.task.independent).toBe(false)
    expect(r.ok && r.task.notify).toBeUndefined()
  })

  it("项目会话：任务绑定到该项目", () => {
    const r = build({}, projectOwner)
    expect(r.ok && r.task.targetProjectId).toBe("p1")
    expect(r.ok && r.task.ownerSessionKey).toBe(projectOwner.sessionKey)
  })

  it("每 N 分钟换算成 cron；也可以直接给 cron", () => {
    const a = build({ everyMinutes: 60 })
    expect(a.ok && a.task.cron).toBe("0 * * * *")
    const b = build({ everyMinutes: undefined, cron: "0 9 * * 1-5" })
    expect(b.ok && b.task.cron).toBe("0 9 * * 1-5")
  })

  it("只给过期时间不给次数也行，过期时间换算成毫秒时间戳", () => {
    const r = build({ maxRuns: undefined, expiresInHours: 8 })
    expect(r.ok && r.task.expiresAt).toBe(NOW + 8 * HOUR)
    expect(r.ok && r.task.maxRuns).toBeUndefined()
  })

  it("次数和过期时间都没有 → 拒绝（不许无限期运行）", () => {
    const r = build({ maxRuns: undefined })
    expect(r).toEqual({ ok: false, error: expect.stringContaining("不允许无限期") })
  })

  it.each([
    ["缺名字", { name: " " }, "name"],
    ["名字太长", { name: "x".repeat(AI_SCHEDULE_LIMITS.maxNameLength + 1) }, "name 太长"],
    ["缺内容", { prompt: "" }, "prompt"],
    ["内容太长", { prompt: "x".repeat(AI_SCHEDULE_LIMITS.maxPromptLength + 1) }, "prompt 太长"],
    ["mode 非法", { mode: "forever" }, "mode"],
    ["cron 和间隔都给了", { cron: "0 9 * * *" }, "二选一"],
    ["cron 和间隔都没给", { everyMinutes: undefined }, "二选一"],
    ["cron 无效", { everyMinutes: undefined, cron: "nope" }, "cron 表达式无效"],
    ["间隔太密(cron)", { everyMinutes: undefined, cron: "*/2 * * * *" }, "触发太密"],
    ["间隔太密(分钟)", { everyMinutes: 1 }, "触发太密"],
    ["次数为 0", { maxRuns: 0 }, "max_runs"],
    ["次数超上限", { maxRuns: AI_SCHEDULE_LIMITS.maxRunsCap + 1 }, "max_runs"],
    ["次数不是整数", { maxRuns: 2.5 }, "max_runs"],
    ["过期时间为负", { maxRuns: undefined, expiresInHours: -1 }, "expires_in_hours"],
    ["过期时间超上限", { maxRuns: undefined, expiresInHours: AI_SCHEDULE_LIMITS.maxExpiryHours + 1 }, "expires_in_hours"],
  ] as const)("%s → 拒绝", (_label, over, msg) => {
    const r = build(over as Partial<AiScheduleInput>)
    expect(r.ok).toBe(false)
    expect(!r.ok && r.error).toContain(msg)
  })

  it("恰好等于最小间隔可以；上限边界的次数 / 过期时间可以", () => {
    expect(build({ everyMinutes: AI_SCHEDULE_LIMITS.minIntervalMinutes }).ok).toBe(true)
    expect(build({ maxRuns: AI_SCHEDULE_LIMITS.maxRunsCap }).ok).toBe(true)
    expect(build({ maxRuns: undefined, expiresInHours: AI_SCHEDULE_LIMITS.maxExpiryHours }).ok).toBe(true)
  })

  it("同一会话活跃排程达到上限 → 拒绝；差一个可以", () => {
    const cap = AI_SCHEDULE_LIMITS.maxActivePerSession
    expect(build({}, mainOwner, cap - 1).ok).toBe(true)
    const r = build({}, mainOwner, cap)
    expect(!r.ok && r.error).toContain("上限")
  })

  it("校验失败时不返回任务（不会留下半成品）", () => {
    const r = build({ name: "" })
    expect(r).not.toHaveProperty("task")
  })
})

describe("evaluateAiTaskFire", () => {
  it("未到限制：第 n 次触发，次数用完前一次标记 last", () => {
    expect(evaluateAiTaskFire({ maxRuns: 3 }, 0, NOW)).toEqual({ fire: true, run: 1, last: false })
    expect(evaluateAiTaskFire({ maxRuns: 3 }, 1, NOW)).toEqual({ fire: true, run: 2, last: false })
    expect(evaluateAiTaskFire({ maxRuns: 3 }, 2, NOW)).toEqual({ fire: true, run: 3, last: true })
  })
  it("次数用完 → 作废", () => {
    const d = evaluateAiTaskFire({ maxRuns: 3 }, 3, NOW)
    expect(d).toEqual({ fire: false, retire: expect.stringContaining("3 次") })
  })
  it("过期 → 作废（恰好到点也算过期）", () => {
    expect(evaluateAiTaskFire({ expiresAt: NOW + 1 }, 0, NOW)).toMatchObject({ fire: true })
    expect(evaluateAiTaskFire({ expiresAt: NOW }, 0, NOW)).toEqual({ fire: false, retire: "已过期" })
    expect(evaluateAiTaskFire({ expiresAt: NOW - 1 }, 0, NOW)).toEqual({ fire: false, retire: "已过期" })
  })
  it("只有过期时间：没有 last 概念", () => {
    expect(evaluateAiTaskFire({ expiresAt: NOW + HOUR }, 99, NOW)).toEqual({ fire: true, run: 100, last: false })
  })
  it("过期优先于次数的判断（两个都超了，原因是过期）", () => {
    expect(evaluateAiTaskFire({ maxRuns: 1, expiresAt: NOW - 1 }, 5, NOW)).toEqual({ fire: false, retire: "已过期" })
  })
})

describe("归属与列表", () => {
  const t = (over: Partial<ScheduledTask>): ScheduledTask => ({
    id: "x", name: "n", cron: "*/30 * * * *", content: "c", enabled: true, ...over,
  })

  it("aiTasksOwnedBy：只取 AI 创建且归属该会话的；用户建的和别的会话的都不算", () => {
    const tasks = [
      t({ id: "1", createdBy: "ai", ownerSessionKey: "S1" }),
      t({ id: "2", createdBy: "ai", ownerSessionKey: "S2" }),
      t({ id: "3", ownerSessionKey: "S1" }),
      t({ id: "4", createdBy: "user", ownerSessionKey: "S1" }),
    ]
    expect(aiTasksOwnedBy(tasks, "S1").map((x) => x.id)).toEqual(["1"])
  })

  describe("mergeSavedTasksKeepingAi：设置页保存不能碰 AI 排程", () => {
    const user = (id: string): ScheduledTask => t({ id, name: `用户-${id}` })
    const ai = (id: string, over: Partial<ScheduledTask> = {}): ScheduledTask => t({ id, name: `AI-${id}`, createdBy: "ai", ownerSessionKey: "S1", ...over })

    it("界面保存的用户任务照常落盘；AI 排程取文件里的", () => {
      const merged = mergeSavedTasksKeepingAi([user("u1"), user("u2")], [user("old"), ai("a1")])
      expect(merged.map((x) => x.id)).toEqual(["u1", "u2", "a1"])
    })

    it("界面旧快照里没有 AI 刚建的排程 → 不会把它盖掉", () => {
      const merged = mergeSavedTasksKeepingAi([user("u1")], [user("u1"), ai("fresh")])
      expect(merged.map((x) => x.id)).toContain("fresh")
    })

    it("界面快照里的 AI 排程（已被取消 / 被改过）一律不采纳：以文件为准", () => {
      const merged = mergeSavedTasksKeepingAi(
        [user("u1"), ai("gone"), ai("a1", { cron: "0 0 * * *", content: "被界面改过" })],
        [ai("a1", { cron: "*/30 * * * *", content: "原样" })],
      )
      expect(merged.map((x) => x.id)).toEqual(["u1", "a1"])
      expect(merged.find((x) => x.id === "a1")).toMatchObject({ cron: "*/30 * * * *", content: "原样" })
    })

    it("界面传来的 runCount 不落盘", () => {
      const merged = mergeSavedTasksKeepingAi([{ ...user("u1"), runCount: 3 }], [])
      expect(merged[0]).not.toHaveProperty("runCount")
    })

    it("用户把任务改成 createdBy=ai 也不行（不会被当作 AI 排程保留，也不会绕过）", () => {
      const merged = mergeSavedTasksKeepingAi([ai("forged")], [])
      expect(merged).toEqual([])
    })
  })

  it("isAiTaskLive 与 evaluateAiTaskFire 一致", () => {
    expect(isAiTaskLive(t({ maxRuns: 2 }), 1, NOW)).toBe(true)
    expect(isAiTaskLive(t({ maxRuns: 2 }), 2, NOW)).toBe(false)
    expect(isAiTaskLive(t({ expiresAt: NOW - 1 }), 0, NOW)).toBe(false)
  })

  it("describeAiTask：写清 id、做什么、进度、过期；作废的标出来", () => {
    const line = describeAiTask(t({ id: "ai-1", name: "盯缺陷", maxRuns: 10, independent: true }), 3, NOW)
    expect(line).toContain("id=ai-1")
    expect(line).toContain("盯缺陷")
    expect(line).toContain("已触发 3/10 次")
    expect(line).toContain("每次新 Agent")
    expect(line).not.toContain("作废")
    const sess = describeAiTask(t({ independent: false, expiresAt: NOW + HOUR }), 0, NOW)
    expect(sess).toContain("到点提醒本会话")
    expect(sess).toContain("过期")
    expect(describeAiTask(t({ maxRuns: 2 }), 2, NOW)).toContain("已作废")
  })
})
