import { describe, expect, it } from "vitest"
import {
  deliveryLabel,
  describeCronShort,
  describeScheduleDetail,
  describeScheduleItem,
  formatFireTime,
  runNowHint,
  summarizeSchedules,
  taskBoundToSession,
  type SessionScheduleContext,
  type SessionScheduleItem,
} from "../src/shared/session-schedule.js"
import { buildSessionSchedules, nextCronFireAt, removeUserTask } from "../src/shared/session-schedule-build.js"
import type { ScheduledTask } from "../src/shared/scheduled-task.js"

const NOW = new Date("2026-11-06T10:00:00+08:00").getTime()
const MIN = 60_000
const HOUR = 3_600_000

/** 本地时间（测试不依赖运行机器的时区） */
const local = (y: number, mo: number, d: number, h: number, mi: number) => new Date(y, mo - 1, d, h, mi).getTime()

const MAIN_KEY = "ch_app|app_main::D:\\chat"
const mainCtx: SessionScheduleContext = { sessionKey: MAIN_KEY, mainOfChannelId: "ch_app" }
const dirCtx: SessionScheduleContext = { sessionKey: "ch_app|app_main::D:\\other" }
const projectCtx: SessionScheduleContext = { sessionKey: "ch_app|oc_grp::project_p1", projectId: "p1" }

function task(over: Partial<ScheduledTask> = {}): ScheduledTask {
  return { id: "t1", name: "任务", cron: "*/10 * * * *", content: "做点事", enabled: true, ...over }
}
const aiTask = (over: Partial<ScheduledTask> = {}) =>
  task({ id: "ai-1", name: "AI 排程", createdBy: "ai", ownerSessionKey: MAIN_KEY, maxRuns: 5, ...over })

describe("describeCronShort：常见写法说人话，认不出的原样给出", () => {
  it.each([
    ["* * * * *", "每 1 分钟"],
    ["*/1 * * * *", "每 1 分钟"],
    ["*/5 * * * *", "每 5 分钟"],
    ["0 * * * *", "每小时整点"],
    ["30 * * * *", "每小时第 30 分"],
    ["0 */1 * * *", "每小时"],
    ["0 */2 * * *", "每 2 小时"],
    ["15 */6 * * *", "每 6 小时（第 15 分）"],
    ["0 9 * * *", "每天 09:00"],
    ["5 8 * * *", "每天 08:05"],
    ["0 0 * * *", "每天 00:00"],
    ["30 9 * * 1-5", "工作日 09:30"],
    ["0 10 * * 1", "每周一 10:00"],
    ["0 10 * * 0", "每周日 10:00"],
    ["0 10 * * 7", "每周日 10:00"],
    ["0 18 * * 1,3,5", "每周一、三、五 18:00"],
    ["0 9 * * 2-4", "每周二至周四 09:00"],
    ["0 9 15 * *", "每月 15 日 09:00"],
    ["* * * * * *", "每秒"],
    ["*/10 * * * * *", "每 10 秒"],
    ["0 */5 * * * *", "每 5 分钟"],
    ["0 0 9 * * *", "每天 09:00"],
  ])("%s → %s", (cron, text) => {
    expect(describeCronShort(cron)).toBe(text)
  })

  it.each([
    "0 9 1-15 * *",   // 日期范围
    "*/5 9 * * *",    // 只在 9 点这一小时里每 5 分钟
    "0 9,18 * * *",   // 小时列表
    "0 9-17 * * *",   // 小时范围
    "0 9 * 6 *",      // 限定月份
    "0 9 1 * 1",      // 日期和星期同时限定
    "0 25 * * *",     // 小时越界
    "61 * * * *",     // 分钟越界
    "0 9 * * 8",      // 星期越界
    "*/0 * * * *",    // 步长 0
    "30 * * * * *",   // 每分钟的第 30 秒，不在认得的范围
    "30 0 9 * * *",   // 每天 09:00:30：带着非 0 的秒，不能说成「每天 09:00」
    "bad",
    "",
  ])("认不出的写法不乱解释：%j", (cron) => {
    expect(describeCronShort(cron)).toBe(`cron ${cron.trim()}`)
  })
})

describe("formatFireTime", () => {
  const now = local(2026, 11, 6, 14, 0)

  it("今天只写时分", () => {
    expect(formatFireTime(local(2026, 11, 6, 14, 56), now)).toBe("14:56")
    expect(formatFireTime(local(2026, 11, 6, 0, 5), now)).toBe("00:05")
  })
  it("明天写「明天」", () => {
    expect(formatFireTime(local(2026, 11, 7, 9, 0), now)).toBe("明天 09:00")
  })
  it("跨午夜：23:30 时 00:10 已经是明天", () => {
    expect(formatFireTime(local(2026, 11, 7, 0, 10), local(2026, 11, 6, 23, 30))).toBe("明天 00:10")
  })
  it("再往后写月/日", () => {
    expect(formatFireTime(local(2026, 11, 9, 9, 0), now)).toBe("11/9 09:00")
    expect(formatFireTime(local(2026, 12, 1, 18, 30), now)).toBe("12/1 18:30")
  })
})

describe("taskBoundToSession：哪些任务算绑定到这个会话", () => {
  describe("AI 排程：只看创建它的会话", () => {
    it("owner 就是当前会话", () => {
      expect(taskBoundToSession(aiTask(), mainCtx, "ch_app")).toBe(true)
    })
    it("盘符大小写、斜杠方向不同也是同一个会话（和对话页比较会话的口径一致）", () => {
      expect(taskBoundToSession(aiTask({ ownerSessionKey: "ch_app|app_main::d:/chat" }), mainCtx, "ch_app")).toBe(true)
    })
    it("别的会话建的不算（包括同通道的其它目录会话）", () => {
      expect(taskBoundToSession(aiTask(), dirCtx, "ch_app")).toBe(false)
      expect(taskBoundToSession(aiTask(), projectCtx, "ch_app")).toBe(false)
    })
    it("项目会话建的，在项目会话里看得到", () => {
      expect(taskBoundToSession(aiTask({ ownerSessionKey: projectCtx.sessionKey, targetProjectId: "p1" }), projectCtx, "ch_app")).toBe(true)
    })
    it("没有 owner 的 AI 任务不算", () => {
      expect(taskBoundToSession(aiTask({ ownerSessionKey: undefined }), mainCtx, "ch_app")).toBe(false)
    })
    it("当前会话键为空时不匹配任何东西", () => {
      expect(taskBoundToSession(aiTask({ ownerSessionKey: "" }), { sessionKey: "" }, "ch_app")).toBe(false)
    })
  })

  describe("用户建的任务：看投递目标", () => {
    it("非独立运行 + 所属通道 = 当前会话所在通道的主会话 → 算", () => {
      expect(taskBoundToSession(task({ independent: false, channelId: "ch_app" }), mainCtx, "ch_app")).toBe(true)
    })
    it("独立运行 + 通知到 Agent 会话（不指定项目）→ 结果投主会话，算", () => {
      expect(taskBoundToSession(task({ independent: true, notify: "agent", channelId: "ch_app" }), mainCtx, "ch_app")).toBe(true)
    })
    it("主会话只认主会话：同通道的其它目录会话、别的通道的主会话都不算", () => {
      const t = task({ independent: false, channelId: "ch_app" })
      expect(taskBoundToSession(t, dirCtx, "ch_app")).toBe(false)
      expect(taskBoundToSession(t, { ...mainCtx, mainOfChannelId: "ch_other" }, "ch_app")).toBe(false)
    })
    it("所属通道是飞书：投进飞书私聊，不会出现在应用内会话里", () => {
      expect(taskBoundToSession(task({ independent: false, channelId: "ch_feishu" }), mainCtx, "ch_feishu")).toBe(false)
    })
    it("解析不出所属通道时不猜", () => {
      expect(taskBoundToSession(task({ independent: false }), mainCtx, undefined)).toBe(false)
    })
    it("绑了项目：只在那个项目的会话里出现，主会话里不出现", () => {
      const t = task({ independent: false, channelId: "ch_app", targetProjectId: "p1" })
      expect(taskBoundToSession(t, projectCtx, "ch_app")).toBe(true)
      expect(taskBoundToSession(t, { ...projectCtx, projectId: "p2" }, "ch_app")).toBe(false)
      expect(taskBoundToSession(t, mainCtx, "ch_app")).toBe(false)
    })
    it("独立运行且不通知 / 通知到 IM：结果不投任何 Agent 会话，不算", () => {
      expect(taskBoundToSession(task({ independent: true, notify: "none", channelId: "ch_app" }), mainCtx, "ch_app")).toBe(false)
      expect(taskBoundToSession(task({ independent: true, notify: "im", channelId: "ch_app" }), mainCtx, "ch_app")).toBe(false)
    })
    it("旧任务没有 notify 字段：填过聊天 ID 就是通知到 IM，不算；没填就是不通知，也不算", () => {
      expect(taskBoundToSession(task({ notifyChatId: "oc_x", channelId: "ch_app" }), mainCtx, "ch_app")).toBe(false)
      expect(taskBoundToSession(task({ channelId: "ch_app" }), mainCtx, "ch_app")).toBe(false)
    })
  })
})

describe("buildSessionSchedules", () => {
  const channels = [{ id: "ch_app", enabled: true }]
  const base = {
    ctx: mainCtx,
    aiRuns: {} as Record<string, number>,
    now: NOW,
    channels,
    runningTaskIds: new Set<string>(),
    nextFireAt: (_cron: string, from: number) => from + 10 * MIN,
  }

  it("只列绑定到当前会话的任务，带出来源、怎么跑、已触发次数", () => {
    const items = buildSessionSchedules({
      ...base,
      tasks: [
        aiTask({ id: "mine", name: "我的", independent: false }),
        aiTask({ id: "report", name: "独立的", independent: true, notify: "agent" }),
        aiTask({ id: "other", ownerSessionKey: dirCtx.sessionKey }),
        task({ id: "feishu", independent: false, channelId: "ch_feishu" }),
        task({ id: "silent", independent: true, notify: "none", channelId: "ch_app" }),
      ],
      aiRuns: { mine: 2 },
    })
    expect(items.map((i) => i.id).sort()).toEqual(["mine", "report"])
    const mine = items.find((i) => i.id === "mine")!
    expect(mine).toMatchObject({ origin: "ai", delivery: "inject", runCount: 2, maxRuns: 5, enabled: true, running: false })
    expect(items.find((i) => i.id === "report")).toMatchObject({ origin: "ai", delivery: "report", runCount: 0 })
  })

  it("已经作废的 AI 排程不列：被取消（停用等清理）、次数用完、已过期", () => {
    const items = buildSessionSchedules({
      ...base,
      tasks: [
        aiTask({ id: "live" }),
        aiTask({ id: "cancelled", enabled: false }),
        aiTask({ id: "used-up", maxRuns: 3 }),
        aiTask({ id: "expired", maxRuns: undefined, expiresAt: NOW - 1 }),
        aiTask({ id: "expires-soon", maxRuns: undefined, expiresAt: NOW + HOUR }),
      ],
      aiRuns: { "used-up": 3, live: 1 },
    })
    expect(items.map((i) => i.id).sort()).toEqual(["expires-soon", "live"])
  })

  it("下次触发时已经过期的 AI 排程：不显示一个不会发生的时间", () => {
    const [item] = buildSessionSchedules({
      ...base,
      tasks: [aiTask({ maxRuns: undefined, expiresAt: NOW + 5 * MIN })],
    })
    expect(item.nextAt).toBeUndefined()
    expect(item.expiresAt).toBe(NOW + 5 * MIN)
  })

  it("过期边界：下次触发恰好落在到期那一刻也不会发生（调度器 now >= expiresAt 就作废），晚 1 毫秒到期则还会发生", () => {
    const nextAt = NOW + 10 * MIN
    const at = (expiresAt: number) => buildSessionSchedules({
      ...base,
      tasks: [aiTask({ maxRuns: undefined, expiresAt })],
    })[0].nextAt
    expect(at(nextAt)).toBeUndefined()
    expect(at(nextAt + 1)).toBe(nextAt)
  })

  it("用户在设置页停用的任务照常列出（置灰），没有下次触发时间", () => {
    const [item] = buildSessionSchedules({
      ...base,
      tasks: [task({ independent: false, channelId: "ch_app", enabled: false })],
    })
    expect(item).toMatchObject({ origin: "user", enabled: false })
    expect(item.nextAt).toBeUndefined()
    expect(item.runCount).toBeUndefined()
  })

  it("独立任务正在运行时标出 running", () => {
    const items = buildSessionSchedules({
      ...base,
      tasks: [aiTask({ id: "a", independent: true, notify: "agent" }), aiTask({ id: "b", independent: true, notify: "agent" })],
      runningTaskIds: new Set(["a"]),
    })
    expect(items.find((i) => i.id === "a")?.running).toBe(true)
    expect(items.find((i) => i.id === "b")?.running).toBe(false)
  })

  it("没设所属通道的任务按「第一个启用的通道」归属，和设置页、daemon 同一口径", () => {
    const t = task({ id: "no-channel", independent: false })
    const first = (id: string) => buildSessionSchedules({
      ...base,
      tasks: [t],
      channels: [{ id: "ch_off", enabled: false }, { id, enabled: true }],
    })
    expect(first("ch_app").map((i) => i.id)).toEqual(["no-channel"])
    expect(first("ch_other")).toEqual([])
  })

  it("排序：已启用在前，下次触发早的在前，同时间按名字，算不出下次的排在启用组末尾，停用的最后", () => {
    // 用 cron 字符串当键，给每个任务指定下次触发时间
    const next: Record<string, number | undefined> = { late: NOW + 30 * MIN, soon: NOW + 5 * MIN, "tie-b": NOW + 15 * MIN, "tie-a": NOW + 15 * MIN }
    const items = buildSessionSchedules({
      ...base,
      tasks: [
        aiTask({ id: "late", name: "late", cron: "late" }),
        task({ id: "off", name: "off", cron: "off", independent: false, channelId: "ch_app", enabled: false }),
        aiTask({ id: "tie-b", name: "b", cron: "tie-b" }),
        aiTask({ id: "soon", name: "soon", cron: "soon" }),
        aiTask({ id: "tie-a", name: "a", cron: "tie-a" }),
        aiTask({ id: "no-next", name: "no-next", cron: "no-next" }),
      ],
      nextFireAt: (cron) => next[cron],
    })
    expect(items.map((i) => i.id)).toEqual(["soon", "tie-a", "tie-b", "late", "no-next", "off"])
  })
})

describe("removeUserTask：对话页删除用户建的任务", () => {
  const tasks = [task({ id: "u1" }), task({ id: "u2" }), aiTask({ id: "ai-1" })]

  it("只删指定的那个，其余原样保留、顺序不变", () => {
    const r = removeUserTask(tasks, "u1")
    expect(r.ok && r.tasks.map((t) => t.id)).toEqual(["u2", "ai-1"])
  })
  it("不改传入的数组", () => {
    removeUserTask(tasks, "u1")
    expect(tasks.map((t) => t.id)).toEqual(["u1", "u2", "ai-1"])
  })
  it("AI 排程拒绝直接删（要走 daemon 的取消），任务列表原样不动", () => {
    const r = removeUserTask(tasks, "ai-1")
    expect(r).toEqual({ ok: false, error: "AI 排程请用取消，不能直接删除" })
  })
  it("不存在的 id 报错，不会误删别的", () => {
    const r = removeUserTask(tasks, "nope")
    expect(r.ok).toBe(false)
    expect(!r.ok && r.error).toContain("不存在")
  })
})

describe("nextCronFireAt", () => {
  it("返回严格晚于 from 的下一个触发点", () => {
    const from = new Date(2026, 10, 6, 14, 2, 30).getTime()
    const at = nextCronFireAt("*/5 * * * *", from)!
    expect(at).toBeGreaterThan(from)
    expect(at - from).toBeLessThanOrEqual(5 * MIN)
    expect(new Date(at).getMinutes() % 5).toBe(0)
  })
  it("恰好在触发点上时给下一个，不是当前这个", () => {
    const from = new Date(2026, 10, 6, 14, 5, 0).getTime()
    expect(nextCronFireAt("*/5 * * * *", from)).toBe(from + 5 * MIN)
  })
  it("带秒的 cron 也能算", () => {
    const from = new Date(2026, 10, 6, 14, 0, 0).getTime()
    expect(nextCronFireAt("*/10 * * * * *", from)).toBe(from + 10_000)
  })
  it("无效 / 空表达式返回 undefined，不抛错", () => {
    expect(nextCronFireAt("not a cron", NOW)).toBeUndefined()
    expect(nextCronFireAt("   ", NOW)).toBeUndefined()
  })
})

describe("列表文案", () => {
  const now = local(2026, 11, 6, 14, 0)
  const item = (over: Partial<SessionScheduleItem> = {}): SessionScheduleItem => ({
    id: "x", name: "测试", cron: "*/1 * * * *", origin: "ai", delivery: "inject", enabled: true, running: false, ...over,
  })

  it("AI 提醒本会话：怎么跑 · 频率 · 已触发 · 下次", () => {
    const text = describeScheduleItem(item({ runCount: 2, maxRuns: 5, nextAt: local(2026, 11, 6, 14, 56) }), now)
    expect(text).toBe("提醒本会话 · 每 1 分钟 · 已触发 2/5 次 · 下次 14:56")
  })
  it("独立执行", () => {
    expect(describeScheduleItem(item({ delivery: "report", cron: "*/2 * * * *", runCount: 0, maxRuns: 5, nextAt: local(2026, 11, 6, 14, 57) }), now))
      .toBe("独立执行 · 每 2 分钟 · 已触发 0/5 次 · 下次 14:57")
  })
  it("只有到期时间没有次数上限", () => {
    expect(describeScheduleItem(item({ runCount: 3, expiresAt: local(2026, 11, 7, 9, 0), nextAt: local(2026, 11, 6, 14, 1) }), now))
      .toBe("提醒本会话 · 每 1 分钟 · 已触发 3 次 · 明天 09:00 到期 · 下次 14:01")
  })
  it("用户建的任务不写次数；停用写「已停用」；运行中写「运行中」", () => {
    expect(describeScheduleItem(item({ origin: "user", delivery: "report", cron: "0 9 * * *", enabled: false }), now))
      .toBe("独立执行 · 每天 09:00 · 已停用")
    expect(describeScheduleItem(item({ origin: "user", delivery: "report", running: true, nextAt: local(2026, 11, 6, 14, 1) }), now))
      .toBe("独立执行 · 每 1 分钟 · 运行中")
  })

  it("折叠条：几个、最近一次什么时候", () => {
    expect(summarizeSchedules([], now)).toBe("")
    expect(summarizeSchedules([
      item({ nextAt: local(2026, 11, 6, 14, 57) }),
      item({ id: "y", nextAt: local(2026, 11, 6, 14, 56) }),
    ], now)).toBe("2 个定时 · 下次 14:56")
  })
  it("折叠条：停用的不参与「下次」；全停用写已停用；有在跑的写运行中；算不出时间就只写个数", () => {
    expect(summarizeSchedules([
      item({ enabled: false, nextAt: local(2026, 11, 6, 14, 1) }),
      item({ id: "y", nextAt: local(2026, 11, 6, 15, 0) }),
    ], now)).toBe("2 个定时 · 下次 15:00")
    expect(summarizeSchedules([item({ enabled: false }), item({ id: "y", enabled: false })], now)).toBe("2 个定时 · 已停用")
    expect(summarizeSchedules([item({ running: true }), item({ id: "y" })], now)).toBe("2 个定时 · 运行中")
    expect(summarizeSchedules([item()], now)).toBe("1 个定时")
  })

  it("悬停说明讲清到点会发生什么、谁创建的", () => {
    expect(describeScheduleDetail(item({ delivery: "inject" }))).toContain("发进这个会话")
    expect(describeScheduleDetail(item({ delivery: "report" }))).toContain("全新 Agent")
    expect(describeScheduleDetail(item({ origin: "ai" }))).toContain("AI 给自己排的程")
    expect(describeScheduleDetail(item({ origin: "user" }))).toContain("设置页")
  })
  it("「立即运行」的提示说明不影响计划和次数", () => {
    for (const delivery of ["inject", "report"] as const) {
      expect(runNowHint(item({ delivery }))).toContain("不计入已触发次数")
    }
    expect(deliveryLabel("inject")).toBe("提醒本会话")
    expect(deliveryLabel("report")).toBe("独立执行")
  })
})
