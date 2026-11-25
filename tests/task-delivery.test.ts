import { describe, expect, it } from "vitest"
import {
  buildNotifySessionKey,
  isDirectNotifyTask,
  resolveTaskNotify,
  resolveTaskOutboundChatKey,
  sendsStandaloneMessages,
  taskAgentSessionKey,
  taskNotifyChannelId,
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
  formatTaskImMessage,
  formatTaskImResult,
  formatTaskResultForAgent,
  isLegacyDelivery,
  keepTaskAppSessions,
  normalizeTaskDelivery,
  toUserNotifyTask,
  validateTaskDelivery,
  type TaskDeliveryCheckEnv,
  type TaskDeliveryLabels,
} from "../src/shared/task-delivery.js"
import { resolveProjectAgentTarget } from "../src/shared/task-agent-target.js"

function task(over: Partial<ScheduledTask> = {}): ScheduledTask {
  return { id: "t1", name: "周报编写", cron: "0 9 * * 5", content: "写周报", enabled: true, channelId: "ch_a", ...over }
}

/** 应用内通道的会话键：ch_app 通道下的一个目录会话 */
const APP_SESSION = "ch_app|app_main::D:\\work\\docs"

const labels: TaskDeliveryLabels = {
  channelName: (id) => ({ ch_a: "安若流年", ch_b: "测试通道", ch_app: "应用内" } as Record<string, string>)[id ?? ""],
  projectName: (id) => (id === "p1" ? "数英满班率" : undefined),
  isAppChannel: (id) => id === "ch_app",
  sessionName: (key) => (key === APP_SESSION ? "docs" : undefined),
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

  it("非独立运行只有通知 AI / 通知我两种：没配过（旧任务）和配成不通知的都按通知 AI", () => {
    expect(resolveTaskNotify({ independent: false })).toBe("agent")
    expect(resolveTaskNotify({ independent: false, notify: "agent" })).toBe("agent")
    expect(resolveTaskNotify({ independent: false, notify: "none" })).toBe("agent")
    expect(resolveTaskNotify({ independent: false, notifyChatId: "oc_x" })).toBe("agent")
    expect(resolveTaskNotify({ independent: false, notify: "im", notifyChatId: "oc_x" })).toBe("im")
  })

  it("直接通知用户的任务（非独立 + 通知我）：不启动 Agent，消息是独立发出的", () => {
    expect(isDirectNotifyTask({ independent: false, notify: "im" })).toBe(true)
    expect(isDirectNotifyTask({ independent: false, notify: "agent" })).toBe(false)
    expect(isDirectNotifyTask({ independent: true, notify: "im" })).toBe(false)
    expect(sendsStandaloneMessages({ independent: true })).toBe(true)
    expect(sendsStandaloneMessages({ independent: false, notify: "im" })).toBe(true)
    expect(sendsStandaloneMessages({ independent: false, notify: "agent" })).toBe(false)
  })

  it("notify 是脏值时回落到旧规则", () => {
    expect(resolveTaskNotify({ notify: "bogus" as never, notifyChatId: "oc_x" })).toBe("im")
    expect(resolveTaskNotify({ notify: "bogus" as never })).toBe("none")
  })
})

describe("发送通道与出站目标", () => {
  it("通知通道：旧任务专门存的 notifyChannelId > channelId（设置页只写 channelId）", () => {
    expect(taskNotifyChannelId({ channelId: "ch_a" })).toBe("ch_a")
    expect(taskNotifyChannelId({ channelId: "ch_a", notifyChannelId: "ch_b" })).toBe("ch_b")
    expect(taskNotifyChannelId({ channelId: "ch_a", notifyChannelId: "  " })).toBe("ch_a")
    expect(taskNotifyChannelId({})).toBeUndefined()
  })

  it("通知 AI 所选的具体会话：只有通知 AI 且没绑项目时才算", () => {
    expect(taskAgentSessionKey({ notify: "agent", notifyChatId: APP_SESSION })).toBe(APP_SESSION)
    expect(taskAgentSessionKey({ independent: false, notifyChatId: APP_SESSION })).toBe(APP_SESSION)
    expect(taskAgentSessionKey({ notify: "agent", notifyChatId: APP_SESSION, targetProjectId: "p1" })).toBeUndefined()
    expect(taskAgentSessionKey({ notify: "agent" })).toBeUndefined()
    expect(taskAgentSessionKey({ notify: "im", notifyChatId: APP_SESSION })).toBeUndefined()
    expect(taskAgentSessionKey({ notify: "none", notifyChatId: APP_SESSION })).toBeUndefined()
  })

  it("通知我 + 应用内通道：聊天 ID 就是接收结果的会话键，原样当出站目标", () => {
    expect(resolveTaskOutboundChatKey({ channelId: "ch_app", notify: "im", notifyChatId: APP_SESSION }, "ignored")).toBe(APP_SESSION)
    expect(buildNotifySessionKey({ channelId: "ch_app", notify: "im", notifyChatId: APP_SESSION })).toBe(APP_SESSION)
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

  it("通知 AI：选了具体会话就保留会话键；绑了项目则项目优先、会话键作废", () => {
    const picked = normalizeTaskDelivery(task({ notify: "agent", notifyChatId: APP_SESSION }))
    expect(picked.notifyChatId).toBe(APP_SESSION)
    expect(picked).not.toHaveProperty("targetProjectId")
    const both = normalizeTaskDelivery(task({ notify: "agent", notifyChatId: APP_SESSION, targetProjectId: "p1" }))
    expect(both.targetProjectId).toBe("p1")
    expect(both).not.toHaveProperty("notifyChatId")
  })

  it("非独立运行：清掉模型相关字段，通知方式只剩通知 AI / 通知我，没配过的写成通知 AI", () => {
    const withModel = task({ independent: false, model: "m1", modelParams: "{}", resourceId: "r1" })
    const out = normalizeTaskDelivery(withModel)
    expect(out.notify).toBe("agent")
    expect(out).not.toHaveProperty("model")
    expect(out).not.toHaveProperty("modelParams")
    expect(out).not.toHaveProperty("resourceId")
    // 不通知对非独立运行没意义：写成通知 AI，并保留它选的会话
    const none = normalizeTaskDelivery(task({ independent: false, notify: "none", notifyChatId: APP_SESSION }))
    expect(none.notify).toBe("agent")
    expect(none.notifyChatId).toBe(APP_SESSION)
    // 通知我照常保留
    const im = normalizeTaskDelivery(task({ independent: false, notify: "im", notifyChatId: "oc_x", targetProjectId: "p1" }))
    expect(im.notify).toBe("im")
    expect(im.notifyChatId).toBe("oc_x")
    expect(im).not.toHaveProperty("targetProjectId")
  })

  it("独立运行不动模型", () => {
    const out = normalizeTaskDelivery(task({ notify: "none", model: "m1", resourceId: "r1" }))
    expect(out.model).toBe("m1")
    expect(out.resourceId).toBe("r1")
  })

  it("不改原对象", () => {
    const src = task({ notifyChatId: "oc_x" })
    normalizeTaskDelivery(src)
    expect(src.notify).toBeUndefined()
  })
})

describe("isLegacyDelivery：旧版交付方式", () => {
  it("独立运行 + 通知我（含没配 notify 但填过聊天 ID 的旧任务）不算旧版", () => {
    expect(isLegacyDelivery(task({ independent: true, notify: "im" }))).toBe(false)
    expect(isLegacyDelivery(task({ notify: "im", notifyChatId: "oc_g" }))).toBe(false)
    expect(isLegacyDelivery(task({ notifyChatId: "oc_g" }))).toBe(false)
  })

  it("非独立 / 不通知 / 通知 AI / 绑了项目都算旧版", () => {
    expect(isLegacyDelivery(task({ independent: false, notify: "im" }))).toBe(true)
    expect(isLegacyDelivery(task({ notify: "none" }))).toBe(true)
    expect(isLegacyDelivery(task())).toBe(true)
    expect(isLegacyDelivery(task({ notify: "agent" }))).toBe(true)
    expect(isLegacyDelivery(task({ notify: "im", targetProjectId: "p1" }))).toBe(true)
  })
})

describe("toUserNotifyTask：统一成独立运行 + 通知我", () => {
  it("旧版的通知 AI：会话键 / 项目绑定作废，不带到通知我里", () => {
    const next = toUserNotifyTask(task({ notify: "agent", notifyChatId: APP_SESSION, targetProjectId: "p1" }))
    expect(next).toMatchObject({ independent: true, notify: "im" })
    expect(next.notifyChatId).toBeUndefined()
    expect(next.targetProjectId).toBeUndefined()
  })

  it("旧版的非独立 + 通知我：转成独立运行，聊天 ID 保留（它本来就是通知我的目标）", () => {
    const next = toUserNotifyTask(task({ independent: false, notify: "im", notifyChatId: "oc_g" }))
    expect(next).toMatchObject({ independent: true, notify: "im", notifyChatId: "oc_g" })
  })

  it("旧版的不通知：残留的聊天 ID 不生效，也不带过来", () => {
    expect(toUserNotifyTask(task({ notify: "none", notifyChatId: "oc_old" })).notifyChatId).toBeUndefined()
  })

  it("已经是通知我：飞书群 ID、模型、专属会话键原样保留", () => {
    const base = task({ notify: "im", notifyChatId: "oc_g", resourceId: "r1", model: "m1", modelParams: "p" })
    expect(toUserNotifyTask(base)).toEqual({ ...base, independent: true, notify: "im" })
    const app = task({ channelId: "ch_app", notify: "im", notifyChatId: APP_SESSION })
    expect(toUserNotifyTask(app).notifyChatId).toBe(APP_SESSION)
  })

  it("不改原对象；AI 排程专有字段不碰", () => {
    const src = task({ notify: "agent", createdBy: "ai", maxRuns: 3 })
    toUserNotifyTask(src)
    expect(src.notify).toBe("agent")
    expect(toUserNotifyTask(src)).toMatchObject({ createdBy: "ai", maxRuns: 3 })
  })
})

describe("keepTaskAppSessions：保存快照不抹掉 daemon 新建的专属会话", () => {
  it("快照里没有、文件里有应用内会话键：带回来", () => {
    const before = [task({ channelId: "ch_app", notify: "im", notifyChatId: APP_SESSION })]
    const saved = [task({ channelId: "ch_app", notify: "im", name: "改过名" })]
    expect(keepTaskAppSessions(saved, before)[0]).toMatchObject({ name: "改过名", notifyChatId: APP_SESSION })
  })

  it("快照里自己有：以快照为准", () => {
    const before = [task({ channelId: "ch_app", notify: "im", notifyChatId: APP_SESSION })]
    const saved = [task({ channelId: "ch_app", notify: "im", notifyChatId: "ch_app|app_main::D:\\other" })]
    expect(keepTaskAppSessions(saved, before)[0].notifyChatId).toBe("ch_app|app_main::D:\\other")
  })

  it("飞书群 ID 被用户清空（不含 ::）：不带回来，清空是用户的意思", () => {
    const before = [task({ notify: "im", notifyChatId: "oc_g" })]
    const saved = [task({ notify: "im" })]
    expect(keepTaskAppSessions(saved, before)[0].notifyChatId).toBeUndefined()
  })

  it("换了通知通道：旧通道的会话键对新通道没用，不带回来", () => {
    const before = [task({ channelId: "ch_app", notify: "im", notifyChatId: APP_SESSION })]
    const saved = [task({ channelId: "ch_a", notify: "im" })]
    expect(keepTaskAppSessions(saved, before)[0].notifyChatId).toBeUndefined()
  })

  it("新建的任务 / AI 排程 / 不是通知我的：原样", () => {
    const before = [task({ id: "ai1", createdBy: "ai", notify: "agent", notifyChatId: APP_SESSION })]
    const saved = [task({ id: "ai1", createdBy: "ai", notify: "agent" }), task({ id: "new", channelId: "ch_app", notify: "im" })]
    const out = keepTaskAppSessions(saved, before)
    expect(out[0].notifyChatId).toBeUndefined()
    expect(out[1].notifyChatId).toBeUndefined()
  })
})

describe("validateTaskDelivery：能不能送达", () => {
  const env = (over: Partial<TaskDeliveryCheckEnv> = {}): TaskDeliveryCheckEnv => ({
    projectExists: (id) => id === "p1",
    channelExists: (id) => id === "ch_a" || id === "ch_b" || id === "ch_app",
    channelMainUserBound: (id) => (id === "ch_a" ? true : id === "ch_b" ? false : undefined),
    channelName: (id) => labels.channelName(id),
    channelIsApp: (id) => id === "ch_app",
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

  it("应用内通道没有主用户私聊，但每个任务有自己的专属会话（投递时没有就建）：通知我不用选会话", () => {
    expect(validateTaskDelivery(task({ channelId: "ch_app", notify: "im" }), env())).toBeUndefined()
    expect(validateTaskDelivery(task({ channelId: "ch_app", notify: "im", notifyChatId: APP_SESSION }), env())).toBeUndefined()
    expect(validateTaskDelivery(task({ channelId: "ch_app", independent: false, notify: "im" }), env())).toBeUndefined()
  })

  it("应用内通知我的会话键属于别的通道（换过通道留下的）：不拦保存，投递时会重建", () => {
    expect(validateTaskDelivery(task({ channelId: "ch_a", notify: "im", notifyChatId: APP_SESSION }), env({ channelIsApp: () => true }))).toBeUndefined()
  })

  it("通知 AI 所选会话必须属于这个通道（换了通道，旧会话键会指到别的通道里去）", () => {
    expect(validateTaskDelivery(task({ channelId: "ch_a", notify: "agent", notifyChatId: APP_SESSION }), env())).toContain("不属于这个通道")
    expect(validateTaskDelivery(task({ channelId: "ch_app", notify: "agent", notifyChatId: APP_SESSION }), env())).toBeUndefined()
  })

  it("通知 AI：不选会话 = 通道主会话，不要求主用户私聊（主会话解析失败是投递时的事）", () => {
    expect(validateTaskDelivery(task({ channelId: "ch_b", notify: "agent" }), env())).toBeUndefined()
  })

  it("通知 AI 选了项目：会话键不参与检查", () => {
    expect(validateTaskDelivery(task({ channelId: "ch_a", notify: "agent", targetProjectId: "p1", notifyChatId: APP_SESSION }), env())).toBeUndefined()
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

  it("独立 + 通知我：说清走哪个通道、发到哪、不唤醒 Agent、没提交结果就不通知", () => {
    const priv = describeTaskDelivery(task({ notify: "im" }), labels)
    expect(priv).toContain("通过「安若流年」发到主用户私聊")
    expect(priv).toContain("不唤醒任何 Agent")
    expect(priv).toContain("没提交结果就不通知")
    const grp = describeTaskDelivery(task({ notify: "im", notifyChannelId: "ch_b", notifyChatId: "oc_32cb78537b97c685e29f8a77e8a510cc" }), labels)
    expect(grp).toContain("通过「测试通道」发到聊天 oc_32cb785…10cc")
  })

  it("通知我 + 应用内通道：发到这个任务专属的会话，建没建好都这么写（不写会话名、不要求选）", () => {
    expect(describeTaskDelivery(task({ channelId: "ch_app", notify: "im" }), labels))
      .toContain("通过「应用内」发到这个任务专属的会话（没有就自动创建）")
    expect(describeTaskDelivery(task({ channelId: "ch_app", notify: "im", notifyChatId: APP_SESSION }), labels))
      .toContain("发到这个任务专属的会话")
    expect(describeTaskDelivery(task({ channelId: "ch_app", notify: "im" }), labels)).not.toContain("未选")
  })

  it("通知 AI 选了具体会话：写会话名，不再写主会话", () => {
    const run = describeTaskDelivery(task({ channelId: "ch_app", notify: "agent", notifyChatId: APP_SESSION }), labels)
    expect(run).toContain("会话「docs」")
    expect(run).not.toContain("主会话")
    expect(run).toContain("没提交结果就不通知")
    const direct = describeTaskDelivery(task({ channelId: "ch_app", independent: false, notifyChatId: APP_SESSION }), labels)
    expect(direct).toContain("发给「会话「docs」」")
    expect(direct).toContain("占用该会话的上下文")
  })

  it("非独立 + 通知我：不启动 Agent，任务内容以 AI 口吻直接发给用户", () => {
    const s = describeTaskDelivery(task({ independent: false, notify: "im" }), labels)
    expect(s).toContain("不启动 Agent")
    expect(s).toContain("以 AI 口吻")
    expect(s).toContain("通过「安若流年」发到主用户私聊")
    expect(s).not.toContain("占用")
    expect(describeTaskDelivery(task({ channelId: "ch_app", independent: false, notify: "im", notifyChatId: APP_SESSION }), labels))
      .toContain("发到这个任务专属的会话")
  })

  it("引用的项目 / 通道已不存在时明说", () => {
    expect(describeTaskDelivery(task({ notify: "agent", targetProjectId: "p_gone" }), labels)).toContain("已不存在")
    expect(describeTaskDelivery(task({ notify: "im", notifyChannelId: "ch_gone" }), labels)).toContain("通道已不存在")
  })

  it("旧任务按推断的方式描述", () => {
    expect(describeTaskDelivery(task({ notifyChatId: "oc_x" }), labels)).toContain("发到聊天")
  })

  it("AI 自己排的程：去向是创建它的会话（可能是应用内的其他会话），不写死「主会话」", () => {
    const reminder = describeTaskDelivery(task({ independent: false, createdBy: "ai" }), labels)
    expect(reminder).toContain("「创建它的会话」")
    expect(reminder).not.toContain("主会话")
    const fresh = describeTaskDelivery(task({ notify: "agent", createdBy: "ai" }), labels)
    expect(fresh).toContain("「创建它的会话」的队列")
    // 项目会话建的排程仍说清是哪个项目
    expect(describeTaskDelivery(task({ notify: "agent", createdBy: "ai", targetProjectId: "p1" }), labels)).toContain("项目「数英满班率」的会话")
    // 用户自己建的任务不变
    expect(describeTaskDelivery(task({ independent: false, createdBy: "user" }), labels)).toContain("「主会话」")
  })
})

describe("resolveProjectAgentTarget：项目会话能不能当投递目标", () => {
  const main = { kind: "main" as const, channelId: "ch_a", sessionKey: "ch_a|ou_alice::project_p1" }
  const group = { kind: "group" as const, channelId: "ch_a", chatKey: "ch_a|oc_grp" }
  const base = { name: "组班", archivedAt: undefined as number | undefined, bindings: [main, group] }

  it("按任务所属通道取项目在这个通道上记录的会话，聊天键从中取（主聊天优先）", () => {
    const r = resolveProjectAgentTarget("p1", base, "ch_a")
    expect(r).toEqual({ ok: true, sessionKey: "ch_a|ou_alice::project_p1", chatKey: "ch_a|ou_alice", label: "项目「组班」的会话" })
  })

  it("没记录主聊天的会话 key 但有独立群：按群拼", () => {
    const r = resolveProjectAgentTarget("p1", { ...base, bindings: [group] }, "ch_a")
    expect(r.ok && r.sessionKey).toBe("ch_a|oc_grp::project_p1")
  })

  it("没指定通道：退回项目的第一条会话", () => {
    const r = resolveProjectAgentTarget("p1", base)
    expect(r.ok && r.sessionKey).toBe("ch_a|ou_alice::project_p1")
  })

  it("项目没接入任务所在的通道：不投（不越过隔离去别的通道的会话），不作废（绑定后能恢复）", () => {
    const r = resolveProjectAgentTarget("p1", base, "ch_other")
    expect(r).toMatchObject({ ok: false, retire: false })
    expect(!r.ok && r.error).toContain("没有接入")
  })

  it("接入了但还没有会话键（主聊天没进入过）：不可用但不作废（进过项目就会有）", () => {
    const r = resolveProjectAgentTarget("p1", { ...base, bindings: [{ kind: "main", channelId: "ch_a" }] }, "ch_a")
    expect(r).toMatchObject({ ok: false, retire: false })
  })

  it("已归档 / 不存在：作废（以后也投不了了）", () => {
    expect(resolveProjectAgentTarget("p1", { ...base, archivedAt: 1700000000000 })).toEqual({
      ok: false, retire: true, error: "项目「组班」已归档",
    })
    expect(resolveProjectAgentTarget("p1", undefined)).toMatchObject({ ok: false, retire: true })
  })

  it("没归档：照常可用（取消归档后恢复投递）", () => {
    expect(resolveProjectAgentTarget("p1", { ...base, archivedAt: undefined }, "ch_a")).toMatchObject({ ok: true })
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

  it("IM 任务消息有两份写法：带任务名的 text（没有任务横幅的通道用）、不带的 titledText（飞书横幅已是任务名时用）", () => {
    expect(formatTaskImMessage({ name: "周报编写" }, " 周报已更新 ")).toEqual({
      text: "⏰ **周报编写**\n\n周报已更新",
      titledText: "周报已更新",
    })
  })

  it("不带任务名的那份确实没有任务名：横幅已经写了，正文再来一遍就是重复（回归：飞书私聊里「⏰ 周报编写」出现两次）", () => {
    const msg = formatTaskImMessage({ name: "周报编写" }, "周报已更新")
    expect(msg.titledText).not.toContain("周报编写")
    expect(msg.text).toContain("周报编写")
  })

  it("旧入口输出不变：formatTaskImResult 就是新函数的 text（两处文案不会各改各的）", () => {
    expect(formatTaskImResult({ name: "x" }, " 内容 ")).toBe(formatTaskImMessage({ name: "x" }, "内容").text)
  })
})

describe("buildTaskProtocolSection：独立任务的提示词", () => {
  it("非独立任务没有这一段", () => {
    expect(buildTaskProtocolSection(task({ independent: false }), labels)).toBe("")
  })

  it("所有模式都先说清：回复不直接送达，用 send_result 提交结果", () => {
    for (const notify of ["none", "agent", "im"] as const) {
      const s = buildTaskProtocolSection(task({ notify }), labels)
      expect(s).toContain("你的回复不会直接发给任何人")
      expect(s).toContain("`send_result`")
      expect(s).toContain("周报编写")
    }
  })

  it("不通知：做完要提交（没事可报用 quiet）", () => {
    const s = buildTaskProtocolSection(task({ notify: "none" }), labels)
    expect(s).toContain("quiet=true")
    expect(s).not.toContain("没有就直接结束")
  })

  it("通知我 / 通知 AI：没有要汇报的就直接结束，不用提交任何东西（没提交就静默）", () => {
    for (const notify of ["agent", "im"] as const) {
      const s = buildTaskProtocolSection(task({ notify }), labels)
      expect(s).toContain("没有就直接结束")
      expect(s).not.toContain("quiet")
    }
  })

  it("通知我：说清发到哪", () => {
    const s = buildTaskProtocolSection(task({ notify: "im", notifyChannelId: "ch_b", notifyChatId: "oc_grp" }), labels)
    expect(s).toContain("通过「测试通道」发到聊天 oc_grp")
    expect(s).toContain("send_image")
    expect(buildTaskProtocolSection(task({ channelId: "ch_app", notify: "im", notifyChatId: APP_SESSION }), labels))
      .toContain("通过「应用内」发到这个任务专属的会话")
  })

  it("通知 AI 选了具体会话：结果投进那个会话", () => {
    expect(buildTaskProtocolSection(task({ channelId: "ch_app", notify: "agent", notifyChatId: APP_SESSION }), labels))
      .toContain("结果会投进「会话「docs」」")
  })

  it("通知到 Agent：说清投进哪个会话，文件写路径", () => {
    const s = buildTaskProtocolSection(task({ notify: "agent", targetProjectId: "p1" }), labels)
    expect(s).toContain("项目「数英满班率」的会话")
    expect(s).toContain("路径写在 `text` 里")
  })

  it("通知到 Agent + AI 自己排的程：结果投回创建它的会话，不说成主会话", () => {
    const s = buildTaskProtocolSection(task({ notify: "agent", createdBy: "ai" }), labels)
    expect(s).toContain("结果会投进「创建它的会话」")
    expect(s).not.toContain("主会话")
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
    t.queued("a", true, 100)
    t.submitted("a", false, 200)
    expect(t.finished("a", false, 300)).toBe("submitted")
  })

  it("声明没事可报：quiet", () => {
    const t = new TaskRunTracker()
    t.queued("a", true, 100)
    t.submitted("a", true, 200)
    expect(t.finished("a", false, 300)).toBe("quiet")
  })

  it("入队后什么都没提交：missing", () => {
    const t = new TaskRunTracker()
    t.queued("a", true, 100)
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
    t.queued("a", false, 100)
    expect(t.finished("a", false, 300)).toBe("missing")
  })

  it("完成后清零：下一轮重新对账，上一轮的结果不会串过来", () => {
    const t = new TaskRunTracker()
    t.queued("a", true, 100)
    t.submitted("a", false, 200)
    expect(t.finished("a", false, 300)).toBe("submitted")
    t.queued("a", true, 400)
    expect(t.finished("a", false, 500)).toBe("missing")
  })

  it("上一轮被清空队列这类外力打断、没走到完成：新一轮入队时记账清零，上一轮的提交不会串过来", () => {
    const t = new TaskRunTracker()
    t.queued("a", true, 100)
    t.submitted("a", false, 200)
    // 队列被清空，finished 永远不会来；下一次入队时队列是空的
    t.queued("a", true, 400)
    expect(t.alreadySubmitted("a")).toBe(false)
    expect(t.finished("a", false, 500)).toBe("missing")
  })

  it("入队时队列里还有消息：并入正在进行的这一批，已提交的结果仍然有效", () => {
    const t = new TaskRunTracker()
    t.queued("a", true, 100)
    t.submitted("a", false, 200)
    t.queued("a", false, 300)
    expect(t.alreadySubmitted("a")).toBe(true)
    expect(t.finished("a", false, 400)).toBe("submitted")
  })

  it("完成时队列里还有任务消息：窗口让给下一轮，从完成时刻算起", () => {
    const t = new TaskRunTracker()
    t.queued("a", true, 100)
    t.submitted("a", false, 200)
    expect(t.finished("a", true, 300)).toBe("submitted")
    // 下一轮没提交就完成 → missing（而不是 undefined）
    expect(t.finished("a", false, 400)).toBe("missing")
  })

  it("同一轮多条触发合并：以最早入队时间为准", () => {
    const t = new TaskRunTracker()
    t.queued("a", true, 100)
    t.queued("a", false, 150)
    t.submitted("a", false, 120)
    expect(t.finished("a", false, 300)).toBe("submitted")
  })

  it("alreadySubmitted：同一轮提交过就拒绝重复；完成后恢复", () => {
    const t = new TaskRunTracker()
    t.queued("a", true, 100)
    expect(t.alreadySubmitted("a")).toBe(false)
    t.submitted("a", false, 200)
    expect(t.alreadySubmitted("a")).toBe(true)
    t.finished("a", false, 300)
    expect(t.alreadySubmitted("a")).toBe(false)
  })

  it("不同任务互不影响", () => {
    const t = new TaskRunTracker()
    t.queued("a", true, 100)
    t.queued("b", true, 100)
    t.submitted("a", false, 200)
    expect(t.finished("b", false, 300)).toBe("missing")
    expect(t.finished("a", false, 300)).toBe("submitted")
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
    expect(s).toContain("通道：「安若流年」（飞书）")
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
    expect(s).toContain("通道：「安若流年」")
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
    expect(s).toContain("通道：（通道已不存在）")
  })

  it("通知 AI 选了具体会话（含 AI 默认选的自己所在的会话）：措辞写「所选会话」，不写「主会话」", () => {
    const picked = task({ channelId: "ch_app", independent: false, notifyChatId: APP_SESSION })
    const self = describeManagedTaskOutcome(picked, labels, { ...app, mainSessionKey: APP_SESSION, mainSessionIsInvoker: true })
    expect(self).toContain("所选会话就是你当前所在的会话")
    expect(self).not.toContain("主会话")
    expect(self).not.toContain("⚠")
    const other = describeManagedTaskOutcome(picked, labels, { ...app, mainSessionKey: APP_SESSION, mainSessionIsInvoker: false })
    expect(other).toContain("⚠ 所选会话不是你当前所在的会话")
    expect(other).toContain("schedule_create")
    const gone = describeManagedTaskOutcome(picked, labels, { ...app, mainSessionKey: null })
    expect(gone).toContain("没能找到所选会话")
    expect(gone).toContain("到点会投递失败")
  })

  it("通知我（非独立：内容直接发给用户；独立：结果发给用户）：不涉及 Agent 会话，不出现「当前会话」的说明", () => {
    const direct = describeManagedTaskOutcome(
      task({ channelId: "ch_app", independent: false, notify: "im", notifyChatId: APP_SESSION }), labels, { ...app },
    )
    expect(direct).toContain("不启动 Agent")
    expect(direct).toContain("发到这个任务专属的会话")
    expect(direct).not.toContain("当前所在的会话")
  })
})
