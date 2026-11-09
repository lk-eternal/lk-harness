import { describe, expect, it } from "vitest"
import {
  buildNotifySessionKey,
  resolveTaskNotify,
  resolveTaskOutboundChatKey,
  taskImChannelId,
  taskOutboundChannelId,
  type ScheduledTask,
} from "../src/shared/scheduled-task.js"
import {
  TaskRunTracker,
  buildTaskProtocolSection,
  chooseNewTaskChannel,
  describeAiTaskProgress,
  describeManagedTaskOutcome,
  describeTaskDelivery,
  formatAiSelfReminder,
  formatTaskImResult,
  formatTaskResultForAgent,
  normalizeTaskDelivery,
  taskMissingResultText,
  validateTaskDelivery,
  type TaskDeliveryCheckEnv,
  type TaskDeliveryLabels,
} from "../src/shared/task-delivery.js"
import { resolveProjectAgentTarget } from "../src/shared/task-agent-target.js"

function task(over: Partial<ScheduledTask> = {}): ScheduledTask {
  return { id: "t1", name: "周报编写", cron: "0 9 * * 5", content: "写周报", enabled: true, channelId: "ch_a", ...over }
}

const labels: TaskDeliveryLabels = {
  channelName: (id) => ({ ch_a: "安若流年", ch_b: "测试通道" } as Record<string, string>)[id ?? ""],
  projectName: (id) => (id === "p1" ? "数英满班率" : undefined),
}

describe("resolveTaskNotify：通知方式", () => {
  it("显式配了就按配的", () => {
    expect(resolveTaskNotify({ notify: "agent" })).toBe("agent")
    expect(resolveTaskNotify({ notify: "im", notifyChatId: "" })).toBe("im")
    expect(resolveTaskNotify({ notify: "none", notifyChatId: "oc_x" })).toBe("none")
  })

  it("旧任务：填过聊天 ID 就是发 IM，没填就是不通知", () => {
    expect(resolveTaskNotify({ notifyChatId: "oc_x" })).toBe("im")
    expect(resolveTaskNotify({ notifyChatId: "  " })).toBe("none")
    expect(resolveTaskNotify({})).toBe("none")
  })

  it("非独立运行恒为不通知，不管配了什么", () => {
    expect(resolveTaskNotify({ independent: false, notify: "im", notifyChatId: "oc_x" })).toBe("none")
  })

  it("notify 是脏值时回落到旧规则", () => {
    expect(resolveTaskNotify({ notify: "bogus" as never, notifyChatId: "oc_x" })).toBe("im")
    expect(resolveTaskNotify({ notify: "bogus" as never })).toBe("none")
  })
})

describe("发送通道与出站目标", () => {
  it("发送通道：专门选的 > 所属通道", () => {
    expect(taskImChannelId({ channelId: "ch_a" })).toBe("ch_a")
    expect(taskImChannelId({ channelId: "ch_a", notifyChannelId: "ch_b" })).toBe("ch_b")
    expect(taskImChannelId({ channelId: "ch_a", notifyChannelId: "  " })).toBe("ch_a")
  })

  it("通知到 IM 时出站通道是发送通道；其余是所属通道", () => {
    expect(taskOutboundChannelId({ channelId: "ch_a", notify: "im", notifyChannelId: "ch_b" })).toBe("ch_b")
    expect(taskOutboundChannelId({ channelId: "ch_a", notify: "agent", notifyChannelId: "ch_b" })).toBe("ch_a")
    expect(taskOutboundChannelId({ channelId: "ch_a", notify: "none", notifyChannelId: "ch_b" })).toBe("ch_a")
  })

  it("通知到 IM + 填了聊天 ID：发到那个聊天，通道用发送通道", () => {
    expect(resolveTaskOutboundChatKey({ channelId: "ch_a", notify: "im", notifyChannelId: "ch_b", notifyChatId: "oc_g" }, "ou_main"))
      .toBe("ch_b|oc_g")
  })

  it("通知到 IM + 没填聊天 ID：发到发送通道的主用户私聊", () => {
    expect(resolveTaskOutboundChatKey({ channelId: "ch_a", notify: "im", notifyChannelId: "ch_b" }, "ou_main_b"))
      .toBe("ch_b|ou_main_b")
  })

  it("不通知 / 通知到 Agent：旧任务残留的聊天 ID 不再生效，媒体发到所属通道主用户私聊", () => {
    expect(resolveTaskOutboundChatKey({ channelId: "ch_a", notify: "none", notifyChatId: "oc_old" }, "ou_main"))
      .toBe("ch_a|ou_main")
    expect(resolveTaskOutboundChatKey({ channelId: "ch_a", notify: "agent", notifyChatId: "oc_old" }, "ou_main"))
      .toBe("ch_a|ou_main")
    expect(buildNotifySessionKey({ channelId: "ch_a", notify: "none", notifyChatId: "oc_old" })).toBeUndefined()
  })

  it("旧任务（没有 notify 字段）行为不变：有聊天 ID 发那里，没有发主用户私聊", () => {
    expect(resolveTaskOutboundChatKey({ channelId: "ch_a", notifyChatId: "oc_g" }, "ou_main")).toBe("ch_a|oc_g")
    expect(resolveTaskOutboundChatKey({ channelId: "ch_a" }, "ou_main")).toBe("ch_a|ou_main")
  })
})

describe("normalizeTaskDelivery：保存前清理", () => {
  it("不通知：清掉聊天 ID / 发送通道 / 项目绑定，并把方式写实", () => {
    const out = normalizeTaskDelivery(task({ notifyChatId: "oc_x", notifyChannelId: "ch_b", targetProjectId: "p1", notify: "none" }))
    expect(out.notify).toBe("none")
    expect(out.notifyChatId).toBeUndefined()
    expect(out.notifyChannelId).toBeUndefined()
    expect(out.targetProjectId).toBeUndefined()
  })

  it("旧任务（只有聊天 ID）保存后明确成通知到 IM，聊天 ID 保留", () => {
    const out = normalizeTaskDelivery(task({ notifyChatId: "oc_x" }))
    expect(out.notify).toBe("im")
    expect(out.notifyChatId).toBe("oc_x")
  })

  it("通知到 IM：发送通道和所属通道相同就不单独存", () => {
    expect(normalizeTaskDelivery(task({ notify: "im", notifyChannelId: "ch_a" })).notifyChannelId).toBeUndefined()
    expect(normalizeTaskDelivery(task({ notify: "im", notifyChannelId: "ch_b" })).notifyChannelId).toBe("ch_b")
  })

  it("通知到 IM：不留项目绑定；空白聊天 ID 清掉", () => {
    const out = normalizeTaskDelivery(task({ notify: "im", notifyChatId: "  ", targetProjectId: "p1" }))
    expect(out.notifyChatId).toBeUndefined()
    expect(out.targetProjectId).toBeUndefined()
  })

  it("通知到 Agent：保留项目绑定，清掉 IM 字段；没选项目 = 主会话（字段不存在）", () => {
    const withProject = normalizeTaskDelivery(task({ notify: "agent", targetProjectId: "p1", notifyChatId: "oc_x" }))
    expect(withProject.targetProjectId).toBe("p1")
    expect(withProject.notifyChatId).toBeUndefined()
    expect("targetProjectId" in normalizeTaskDelivery(task({ notify: "agent", targetProjectId: " " }))).toBe(false)
  })

  it("非独立运行：只保留项目绑定，通知相关字段全清", () => {
    const out = normalizeTaskDelivery(task({ independent: false, notify: "im", notifyChatId: "oc_x", notifyChannelId: "ch_b", targetProjectId: "p1" }))
    expect(out).not.toHaveProperty("notify")
    expect(out).not.toHaveProperty("notifyChatId")
    expect(out).not.toHaveProperty("notifyChannelId")
    expect(out.targetProjectId).toBe("p1")
  })

  it("不改原对象", () => {
    const src = task({ notifyChatId: "oc_x" })
    normalizeTaskDelivery(src)
    expect(src.notify).toBeUndefined()
  })
})

describe("validateTaskDelivery：能不能送达", () => {
  const env = (over: Partial<TaskDeliveryCheckEnv> = {}): TaskDeliveryCheckEnv => ({
    projectExists: (id) => id === "p1",
    channelExists: (id) => id === "ch_a" || id === "ch_b",
    channelMainUserBound: (id) => (id === "ch_a" ? true : id === "ch_b" ? false : undefined),
    channelName: (id) => labels.channelName(id),
    ...over,
  })

  it("不通知永远没问题", () => {
    expect(validateTaskDelivery(task({ notify: "none" }), env())).toBeUndefined()
  })

  it("通知到 IM：通道有主用户私聊就行", () => {
    expect(validateTaskDelivery(task({ notify: "im" }), env())).toBeUndefined()
  })

  it("通知到 IM：通道没绑主用户又没填聊天 ID → 报错并点名通道", () => {
    const err = validateTaskDelivery(task({ notify: "im", notifyChannelId: "ch_b" }), env())
    expect(err).toContain("测试通道")
    expect(err).toContain("绑定主用户")
  })

  it("通知到 IM：填了聊天 ID 就不要求主用户绑定", () => {
    expect(validateTaskDelivery(task({ notify: "im", notifyChannelId: "ch_b", notifyChatId: "oc_g" }), env())).toBeUndefined()
  })

  it("通知到 IM：发送通道不存在 / 没选", () => {
    expect(validateTaskDelivery(task({ notify: "im", notifyChannelId: "ch_gone" }), env())).toContain("已不存在")
    expect(validateTaskDelivery(task({ notify: "im", channelId: undefined }), env())).toContain("选择")
  })

  it("通知到 Agent / 非独立：绑定的项目必须存在；不绑 = 主会话 OK", () => {
    expect(validateTaskDelivery(task({ notify: "agent", targetProjectId: "p_gone" }), env())).toContain("项目已不存在")
    expect(validateTaskDelivery(task({ independent: false, targetProjectId: "p_gone" }), env())).toContain("项目已不存在")
    expect(validateTaskDelivery(task({ notify: "agent", targetProjectId: "p1" }), env())).toBeUndefined()
    expect(validateTaskDelivery(task({ notify: "agent" }), env())).toBeUndefined()
  })

  it("不通知时残留的项目绑定不拦保存（保存时会被清掉）", () => {
    expect(validateTaskDelivery(task({ notify: "none", targetProjectId: "p_gone" }), env())).toBeUndefined()
  })
})

describe("describeTaskDelivery：设置页文案", () => {
  it("非独立：说清内容进哪个会话、会占上下文", () => {
    const s = describeTaskDelivery(task({ independent: false }), labels)
    expect(s).toContain("主会话")
    expect(s).toContain("占用该会话的上下文")
    expect(describeTaskDelivery(task({ independent: false, targetProjectId: "p1" }), labels)).toContain("项目「数英满班率」")
  })

  it("独立 + 不通知", () => {
    const s = describeTaskDelivery(task({ notify: "none" }), labels)
    expect(s).toContain("全新 Agent")
    expect(s).toContain("不通知")
  })

  it("独立 + 通知到 Agent：说清投进哪个会话的队列", () => {
    const s = describeTaskDelivery(task({ notify: "agent", targetProjectId: "p1" }), labels)
    expect(s).toContain("项目「数英满班率」的会话")
    expect(s).toContain("队列")
  })

  it("独立 + 通知到 IM：说清走哪个通道、发到哪、和 Agent 会话无关", () => {
    const priv = describeTaskDelivery(task({ notify: "im" }), labels)
    expect(priv).toContain("通过「安若流年」发到主用户私聊")
    expect(priv).toContain("和 Agent 会话无关")
    const grp = describeTaskDelivery(task({ notify: "im", notifyChannelId: "ch_b", notifyChatId: "oc_32cb78537b97c685e29f8a77e8a510cc" }), labels)
    expect(grp).toContain("通过「测试通道」发到聊天 oc_32cb785…10cc")
  })

  it("引用的项目 / 通道已不存在时明说", () => {
    expect(describeTaskDelivery(task({ notify: "agent", targetProjectId: "p_gone" }), labels)).toContain("已不存在")
    expect(describeTaskDelivery(task({ notify: "im", notifyChannelId: "ch_gone" }), labels)).toContain("通道已不存在")
  })

  it("旧任务按推断的方式描述", () => {
    expect(describeTaskDelivery(task({ notifyChatId: "oc_x" }), labels)).toContain("发到聊天")
  })
})

describe("resolveProjectAgentTarget：项目会话能不能当投递目标", () => {
  const base = { name: "组班", status: "active" as const, sessionKey: "ch_a|oc_grp::project_p1", groupChatId: "ch_a|oc_grp" }

  it("用项目记录的会话 key，聊天键从中取", () => {
    const r = resolveProjectAgentTarget("p1", base)
    expect(r).toEqual({ ok: true, sessionKey: "ch_a|oc_grp::project_p1", chatKey: "ch_a|oc_grp", label: "项目「组班」的会话" })
  })

  it("没记录会话 key 但有独立群：按群拼", () => {
    const r = resolveProjectAgentTarget("p1", { ...base, sessionKey: undefined })
    expect(r.ok && r.sessionKey).toBe("ch_a|oc_grp::project_p1")
  })

  it("没会话也没群：不可用但不作废（进过项目就会有）", () => {
    const r = resolveProjectAgentTarget("p1", { ...base, sessionKey: undefined, groupChatId: undefined })
    expect(r).toMatchObject({ ok: false, retire: false })
  })

  it("暂停：不可用但不作废；完成 / 不存在：作废", () => {
    expect(resolveProjectAgentTarget("p1", { ...base, status: "paused" })).toMatchObject({ ok: false, retire: false })
    expect(resolveProjectAgentTarget("p1", { ...base, status: "done" })).toMatchObject({ ok: false, retire: true })
    expect(resolveProjectAgentTarget("p1", undefined)).toMatchObject({ ok: false, retire: true })
  })
})

describe("消息文案", () => {
  const now = new Date("2026-11-06T09:00:00")

  it("投给 Agent 的结果：一行标题标明来源，正文原样在后", () => {
    const m = formatTaskResultForAgent({ name: "查缺陷" }, "  发现 2 条新缺陷  ", now)
    expect(m).toContain("⏰ 定时任务「查缺陷」汇报")
    expect(m.endsWith("\n\n发现 2 条新缺陷")).toBe(true)
    expect(m).not.toContain("不要照做")
    expect(formatTaskResultForAgent({ name: "x", createdBy: "ai" }, "t", now)).toContain("⏰ 定时任务「x」汇报")
  })

  it("AI 自排程提醒：带第几次，有上限时带分母", () => {
    expect(formatAiSelfReminder({ name: "盯构建" }, "看看构建", { run: 2, maxRuns: 5 }, now)).toContain("第 2/5 次")
    expect(formatAiSelfReminder({ name: "盯构建" }, "看看构建", { run: 2 }, now)).toContain("第 2 次")
    expect(formatAiSelfReminder({ name: "盯构建" }, "看看构建", { run: 1 }, now)).toContain("看看构建")
  })

  it("发到 IM 的结果带任务名", () => {
    expect(formatTaskImResult({ name: "周报编写" }, " 周报已更新 ")).toBe("⏰ **周报编写**\n\n周报已更新")
  })

  it("AI 没提交结果的提示：一句话点名任务", () => {
    const t = taskMissingResultText({ name: "周报编写" })
    expect(t).toBe("⏰ **周报编写** 已运行结束，但没有提交结果。")
  })
})

describe("buildTaskProtocolSection：独立任务的提示词", () => {
  it("非独立任务没有这一段", () => {
    expect(buildTaskProtocolSection(task({ independent: false }), labels)).toBe("")
  })

  it("所有模式都先说清：回复不直接送达，做完用 send_result，没事用 quiet", () => {
    for (const notify of ["none", "agent", "im"] as const) {
      const s = buildTaskProtocolSection(task({ notify }), labels)
      expect(s).toContain("你的回复不会直接发给任何人")
      expect(s).toContain("`send_result`")
      expect(s).toContain("quiet=true")
      expect(s).toContain("周报编写")
    }
  })

  it("通知到 IM：说清发到哪", () => {
    const s = buildTaskProtocolSection(task({ notify: "im", notifyChannelId: "ch_b", notifyChatId: "oc_grp" }), labels)
    expect(s).toContain("通过「测试通道」发到聊天 oc_grp")
    expect(s).toContain("send_image")
  })

  it("通知到 Agent：说清投进哪个会话，文件写路径", () => {
    const s = buildTaskProtocolSection(task({ notify: "agent", targetProjectId: "p1" }), labels)
    expect(s).toContain("项目「数英满班率」的会话")
    expect(s).toContain("路径写在 `text` 里")
  })

  it("不通知：说清结果只记录，图片文件用 send_image / send_file", () => {
    const s = buildTaskProtocolSection(task({ notify: "none" }), labels)
    expect(s).toContain("只做记录、不发送")
    expect(s).toContain("send_image")
  })

  it("旧任务按推断的方式写", () => {
    expect(buildTaskProtocolSection(task({ notifyChatId: "oc_x" }), labels)).toContain("发到聊天 oc_x")
    expect(buildTaskProtocolSection(task(), labels)).toContain("只做记录、不发送")
  })
})

describe("TaskRunTracker：这次运行有没有提交结果", () => {
  it("入队 → 提交 → 完成：submitted", () => {
    const t = new TaskRunTracker()
    t.queued("a", 100)
    t.submitted("a", false, 200)
    expect(t.finished("a", false, 300)).toBe("submitted")
  })

  it("声明没事可报：quiet", () => {
    const t = new TaskRunTracker()
    t.queued("a", 100)
    t.submitted("a", true, 200)
    expect(t.finished("a", false, 300)).toBe("quiet")
  })

  it("入队后什么都没提交：missing", () => {
    const t = new TaskRunTracker()
    t.queued("a", 100)
    expect(t.finished("a", false, 300)).toBe("missing")
  })

  it("没有入队记录（daemon 重启过）：不判，不误报", () => {
    const t = new TaskRunTracker()
    t.submitted("a", false, 200)
    expect(t.finished("a", false, 300)).toBeUndefined()
    expect(new TaskRunTracker().finished("never", false, 1)).toBeUndefined()
  })

  it("结果早于入队时间的不算这一轮", () => {
    const t = new TaskRunTracker()
    t.submitted("a", false, 50)
    t.queued("a", 100)
    expect(t.finished("a", false, 300)).toBe("missing")
  })

  it("完成后清零：下一轮重新对账，上一轮的结果不会串过来", () => {
    const t = new TaskRunTracker()
    t.queued("a", 100)
    t.submitted("a", false, 200)
    expect(t.finished("a", false, 300)).toBe("submitted")
    t.queued("a", 400)
    expect(t.finished("a", false, 500)).toBe("missing")
  })

  it("完成时队列里还有任务消息：窗口让给下一轮，从完成时刻算起", () => {
    const t = new TaskRunTracker()
    t.queued("a", 100)
    t.submitted("a", false, 200)
    expect(t.finished("a", true, 300)).toBe("submitted")
    // 下一轮没提交就完成 → missing（而不是 undefined）
    expect(t.finished("a", false, 400)).toBe("missing")
  })

  it("同一轮多条触发合并：以最早入队时间为准", () => {
    const t = new TaskRunTracker()
    t.queued("a", 100)
    t.queued("a", 150)
    t.submitted("a", false, 120)
    expect(t.finished("a", false, 300)).toBe("submitted")
  })

  it("alreadySubmitted：同一轮提交过就拒绝重复；完成后恢复", () => {
    const t = new TaskRunTracker()
    t.queued("a", 100)
    expect(t.alreadySubmitted("a")).toBe(false)
    t.submitted("a", false, 200)
    expect(t.alreadySubmitted("a")).toBe(true)
    t.finished("a", false, 300)
    expect(t.alreadySubmitted("a")).toBe(false)
  })

  it("不同任务互不影响", () => {
    const t = new TaskRunTracker()
    t.queued("a", 100)
    t.queued("b", 100)
    t.submitted("a", false, 200)
    expect(t.finished("b", false, 300)).toBe("missing")
    expect(t.finished("a", false, 300)).toBe("submitted")
  })

  it("isActive：入队后到确认前在跑；确认后不在；队列里还有下一批则继续算在跑；重启后迟到的提交不算", () => {
    const t = new TaskRunTracker()
    expect(t.isActive("a")).toBe(false)
    t.queued("a", 100)
    expect(t.isActive("a")).toBe(true)
    t.finished("a", false, 200)
    expect(t.isActive("a")).toBe(false)
    t.queued("a", 300)
    t.finished("a", true, 400)
    expect(t.isActive("a")).toBe(true)
    t.submitted("ghost", false, 500)
    expect(t.isActive("ghost")).toBe(false)
  })
})

describe("describeAiTaskProgress：设置页里 AI 排程的进度", () => {
  const NOW = new Date("2026-11-06T10:00:00+08:00").getTime()

  it("限次数：已触发 n/m 次", () => {
    expect(describeAiTaskProgress({ maxRuns: 10, runCount: 3 }, NOW)).toBe("已触发 3/10 次")
  })
  it("没有计数记录按 0 次", () => {
    expect(describeAiTaskProgress({ maxRuns: 5 }, NOW)).toBe("已触发 0/5 次")
  })
  it("只限过期时间：不写总次数，带过期时刻", () => {
    const s = describeAiTaskProgress({ expiresAt: NOW + 3_600_000, runCount: 2 }, NOW)
    expect(s).toContain("已触发 2 次")
    expect(s).toContain("过期")
    expect(s).not.toContain("已过期")
  })
  it("已过期明说", () => {
    expect(describeAiTaskProgress({ expiresAt: NOW - 1, runCount: 4 }, NOW)).toBe("已触发 4 次，已过期")
  })
})

describe("chooseNewTaskChannel：AI 用 manage_tasks 建任务时所属通道怎么选", () => {
  const ids = ["ch_feishu", "ch_app"]

  it("事故复现：多通道时不能取第一个——调用者在应用内通道，就挂应用内通道（不是排第一的飞书）", () => {
    expect(chooseNewTaskChannel({ invokerChannelId: "ch_app", channelIds: ids })).toBe("ch_app")
  })

  it("显式指定优先于调用者所在的通道", () => {
    expect(chooseNewTaskChannel({ explicit: "ch_feishu", invokerChannelId: "ch_app", channelIds: ids })).toBe("ch_feishu")
  })

  it("显式指定是空白按没指定", () => {
    expect(chooseNewTaskChannel({ explicit: "  ", invokerChannelId: "ch_app", channelIds: ids })).toBe("ch_app")
  })

  it("不知道调用者是谁（旧调用方没带身份）：退回第一个通道", () => {
    expect(chooseNewTaskChannel({ channelIds: ids })).toBe("ch_feishu")
  })

  it("调用者所在的通道已经不存在：退回第一个通道，不写一个不存在的通道 id", () => {
    expect(chooseNewTaskChannel({ invokerChannelId: "ch_gone", channelIds: ids })).toBe("ch_feishu")
  })

  it("一个通道都没有：没有默认值", () => {
    expect(chooseNewTaskChannel({ invokerChannelId: "ch_app", channelIds: [] })).toBeUndefined()
  })
})

describe("describeManagedTaskOutcome：AI 建 / 改任务后，工具返回里写明实际去向", () => {
  const feishu = { channelName: "安若流年", channelKind: "飞书", channelIsExternalIm: true }
  const app = { channelName: "应用内", channelKind: "应用内对话", channelIsExternalIm: false }

  it("事故复现：非独立任务投给飞书通道的主会话，而调用者在别处——必须明说「不是当前会话」，并指向 schedule_create", () => {
    const s = describeManagedTaskOutcome(
      task({ independent: false }),
      labels,
      { ...feishu, mainSessionKey: "ch_a|oc_x::D:\\proj", mainSessionIsInvoker: false },
    )
    expect(s).toContain("所属通道：「安若流年」（飞书）")
    expect(s).toContain("不是你当前所在的会话")
    expect(s).toContain("回复会发到飞书里")
    expect(s).toContain("schedule_create")
    expect(s).not.toContain("就是你当前所在的会话")
  })

  it("主会话正好是调用者自己的会话：如实说「就是当前会话」，不吓唬", () => {
    const s = describeManagedTaskOutcome(
      task({ independent: false, channelId: "ch_b" }),
      labels,
      { ...app, channelName: "测试通道", mainSessionKey: "ch_b|app_main::D:\\chat", mainSessionIsInvoker: true },
    )
    expect(s).toContain("这个主会话就是你当前所在的会话")
    expect(s).not.toContain("⚠")
    expect(s).not.toContain("schedule_create")
  })

  it("应用内通道的主会话但不是调用者所在的会话：提示不是当前会话，但不说「回复会发到飞书」", () => {
    const s = describeManagedTaskOutcome(
      task({ independent: false, channelId: "ch_b" }),
      labels,
      { ...app, mainSessionKey: "ch_b|app_main::D:\\chat", mainSessionIsInvoker: false },
    )
    expect(s).toContain("不是你当前所在的会话")
    expect(s).not.toContain("回复会发到")
  })

  it("不知道调用者是谁：不下「是 / 不是当前会话」的结论", () => {
    const s = describeManagedTaskOutcome(
      task({ independent: false }),
      labels,
      { ...feishu, mainSessionKey: "ch_a|oc_x::D:\\proj" },
    )
    expect(s).not.toContain("当前所在的会话")
    expect(s).toContain("所属通道：「安若流年」")
  })

  it("通道没有主用户私聊 / 没配工作目录：直接说会投递失败", () => {
    const s = describeManagedTaskOutcome(task({ independent: false }), labels, { ...feishu, mainSessionKey: null })
    expect(s).toContain("到点会投递失败")
  })

  it("独立运行、通知到 IM：不涉及主会话，不出现「当前会话」的说明", () => {
    const s = describeManagedTaskOutcome(task({ independent: true, notify: "im" }), labels, { ...feishu })
    expect(s).toContain("通过「安若流年」发到主用户私聊")
    expect(s).not.toContain("当前所在的会话")
    expect(s).not.toContain("⚠")
  })

  it("独立运行、通知到 Agent 会话：结果投进主会话，同样说明是不是当前会话", () => {
    const s = describeManagedTaskOutcome(
      task({ independent: true, notify: "agent" }),
      labels,
      { ...app, mainSessionKey: "ch_a|app_main::D:\\chat", mainSessionIsInvoker: false },
    )
    expect(s).toContain("不是你当前所在的会话")
  })

  it("通道不存在：写明，不编一个通道名", () => {
    const s = describeManagedTaskOutcome(task({ independent: true, notify: "none", channelId: "ch_gone" }), labels, {})
    expect(s).toContain("所属通道：（通道已不存在）")
  })
})
