import { afterEach, beforeEach, describe, expect, it } from "vitest"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { channelIdFromSessionKey } from "../src/shared/channel-types"
import { resolveTaskLaunchModel, type ChannelModelFields } from "../src/shared/launch-model"
import { resolveTaskChannelId, taskCardFooter, taskSessionOverride, tasksWithChangedModelSetting, type ScheduledTask } from "../src/shared/scheduled-task"
import { initSessionOverridesStore, resetSessionOverridesStoreForTests } from "../src/shared/session-overrides-store"
import { setSessionOverride } from "../src/shared/session-model-store"
import { taskTabModel } from "../src/shared/task-tab-model"

/**
 * 独立定时任务的模型：界面上那一行显示什么、飞书卡片页脚写什么。
 * 以前这两处都是空的：任务的会话键是裸任务 id，凭键认不出所属通道，没给任务单独配模型时就什么都取不到；
 * 任务又不建流式卡，卡片上没有收口页脚。这里锁住「按任务绑定的通道、按任务自己的模型」解析的规则。
 */

const TASK_ID = "0b5f2c3e-1111-4222-8333-444455556666"

const task = (over: Partial<ScheduledTask> = {}): ScheduledTask => ({
  id: TASK_ID,
  name: "测试定时任务",
  cron: "* * * * *",
  content: "x",
  enabled: true,
  independent: true,
  channelId: "ch_b",
  ...over,
})

describe("resolveTaskChannelId", () => {
  const channels = [
    { id: "ch_a", enabled: false },
    { id: "ch_b", enabled: true },
    { id: "ch_c", enabled: true },
  ]

  it("任务绑定了通道就用它，哪怕它排在后面、或者已被停用", () => {
    expect(resolveTaskChannelId({ channelId: "ch_c" }, channels)).toBe("ch_c")
    expect(resolveTaskChannelId({ channelId: "ch_a" }, channels)).toBe("ch_a")
  })

  it("没绑通道（缺省或空串）取第一个启用的通道，跳过停用的", () => {
    expect(resolveTaskChannelId({}, channels)).toBe("ch_b")
    expect(resolveTaskChannelId({ channelId: "" }, channels)).toBe("ch_b")
  })

  it("没有任务（任务已被删）也按第一个启用的通道", () => {
    expect(resolveTaskChannelId(undefined, channels)).toBe("ch_b")
  })

  it("没有启用的通道就是没有", () => {
    expect(resolveTaskChannelId({}, [{ id: "ch_a", enabled: false }])).toBeUndefined()
    expect(resolveTaskChannelId({}, [])).toBeUndefined()
  })
})

const KNOWN = new Set(["sdk_main", "llm_others"])
/** 和 getAgentResource 一样：找不到就回落到默认资源，而不是报错 */
const resolveResource = (id: string | undefined) => ({ id: id && KNOWN.has(id) ? id : "sdk_default" })

const channel: ChannelModelFields = {
  agentResourceId: "sdk_main",
  othersAgentResourceId: "llm_others",
  model: "claude-sonnet",
  modelParams: '[{"id":"thinking","value":"on"}]',
  othersModel: "gemini-flash",
  othersModelParams: "[]",
}

describe("resolveTaskLaunchModel", () => {
  let dataDir: string
  beforeEach(() => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "task-model-"))
    initSessionOverridesStore(dataDir)
  })
  afterEach(() => {
    resetSessionOverridesStoreForTests()
    fs.rmSync(dataDir, { recursive: true, force: true })
  })

  it("任务没配模型：跟随通道主模型（不是「其他人」那一套），供应商也是主供应商", () => {
    const r = resolveTaskLaunchModel({ sessionKey: TASK_ID, task: task(), channel, resolveResource })
    expect(r.model).toBe("claude-sonnet")
    expect(r.modelParams).toBe('[{"id":"thinking","value":"on"}]')
    expect(r.resolvedResourceId).toBe("sdk_main")
    expect(r.modelSource).toBe("channel")
  })

  it("任务自己配了模型：用任务的，供应商仍是通道主供应商", () => {
    const r = resolveTaskLaunchModel({
      sessionKey: TASK_ID,
      task: task({ model: "composer-2.5", modelParams: '[{"id":"fast","value":"true"}]' }),
      channel,
      resolveResource,
    })
    expect(r.model).toBe("composer-2.5")
    expect(r.modelParams).toBe('[{"id":"fast","value":"true"}]')
    expect(r.resolvedResourceId).toBe("sdk_main")
    expect(r.modelSource).toBe("explicit")
  })

  it("任务的模型只有空白等于没配，跟随通道", () => {
    const r = resolveTaskLaunchModel({ sessionKey: TASK_ID, task: task({ model: "   ", modelParams: "[1]" }), channel, resolveResource })
    expect(r.model).toBe("claude-sonnet")
    expect(r.modelSource).toBe("channel")
  })

  it("任务的模型优先于会话里存的；任务没配时，会话里存的优先于通道默认", () => {
    setSessionOverride(TASK_ID, { model: "stored-model", modelParams: "", resourceId: "sdk_main" })
    const withTaskModel = resolveTaskLaunchModel({ sessionKey: TASK_ID, task: task({ model: "composer-2.5" }), channel, resolveResource })
    expect(withTaskModel.model).toBe("composer-2.5")
    const without = resolveTaskLaunchModel({ sessionKey: TASK_ID, task: task(), channel, resolveResource })
    expect(without.model).toBe("stored-model")
    expect(without.modelSource).toBe("session")
  })

  it("找不到通道（比如通道已被删）又没给任务配模型：什么都没有，界面上就是空的", () => {
    const r = resolveTaskLaunchModel({ sessionKey: TASK_ID, task: task(), channel: undefined, resolveResource })
    expect(r.model).toBe("")
  })

  describe("任务自己选了供应商", () => {
    const own = { model: "gemini-flash", modelParams: "[]", resourceId: "llm_others" }

    it("用任务选的供应商和模型，不是通道的", () => {
      const r = resolveTaskLaunchModel({ sessionKey: TASK_ID, task: task(own), channel, resolveResource })
      expect(r).toMatchObject({ model: "gemini-flash", resolvedResourceId: "llm_others", modelSource: "explicit", resourceSource: "session" })
    })

    it("盖过会话里旧登记的供应商（改了供应商后，旧登记不能让它继续用老的）", () => {
      setSessionOverride(TASK_ID, { model: "stale", modelParams: "", resourceId: "sdk_main" })
      const r = resolveTaskLaunchModel({ sessionKey: TASK_ID, task: task(own), channel, resolveResource })
      expect(r).toMatchObject({ model: "gemini-flash", resolvedResourceId: "llm_others" })
    })

    it("没配模型时供应商不生效，整个跟随通道（模型名是跟着供应商走的）", () => {
      const r = resolveTaskLaunchModel({ sessionKey: TASK_ID, task: task({ ...own, model: undefined }), channel, resolveResource })
      expect(r).toMatchObject({ model: "claude-sonnet", resolvedResourceId: "sdk_main", modelSource: "channel" })
    })

    it("选的供应商已不在配置里：resolvedResourceId 回落默认资源，拉起时据此报错，不会悄悄换一家跑", () => {
      const r = resolveTaskLaunchModel({ sessionKey: TASK_ID, task: task({ ...own, resourceId: "llm_gone" }), channel, resolveResource })
      expect(r.resourceId).toBe("llm_gone")
      expect(r.resolvedResourceId).toBe("sdk_default")
    })
  })
})

describe("taskSessionOverride：入队时登记在任务会话里的模型覆盖", () => {
  it("没配模型就不登记（空串、空白、缺省都算）", () => {
    expect(taskSessionOverride({}, "sdk_main")).toBeUndefined()
    expect(taskSessionOverride({ model: "" }, "sdk_main")).toBeUndefined()
    expect(taskSessionOverride({ model: "   ", resourceId: "llm_others" }, "sdk_main")).toBeUndefined()
  })

  it("没选供应商：登记通道的供应商（和原来一致）", () => {
    expect(taskSessionOverride({ model: " m ", modelParams: "[1]" }, " sdk_main ")).toEqual({ model: "m", modelParams: "[1]", resourceId: "sdk_main" })
  })

  it("选了供应商：登记任务自己的，不是通道的", () => {
    expect(taskSessionOverride({ model: "m", resourceId: " llm_others " }, "sdk_main")).toEqual({ model: "m", modelParams: "", resourceId: "llm_others" })
  })

  it("通道也没配供应商：不带 resourceId", () => {
    expect(taskSessionOverride({ model: "m" }, undefined)).toEqual({ model: "m", modelParams: "" })
    expect(taskSessionOverride({ model: "m", resourceId: "  " }, "  ")).toEqual({ model: "m", modelParams: "" })
  })
})

describe("tasksWithChangedModelSetting：保存后哪些任务的旧模型覆盖要作废", () => {
  const base = task({ model: "m", modelParams: "[1]", resourceId: "llm_others" })
  const other = task({ id: "other-task", model: "x" })

  it("什么都没改：没有", () => {
    expect(tasksWithChangedModelSetting([base, other], [{ ...base }, { ...other }])).toEqual([])
  })

  it("改了模型 / 参数 / 供应商 / 通道任一项：有这个任务，没改的不在里面", () => {
    for (const patch of [{ model: "m2" }, { modelParams: "[2]" }, { resourceId: "sdk_main" }, { channelId: "ch_c" }]) {
      expect(tasksWithChangedModelSetting([base, other], [{ ...base, ...patch }, other])).toEqual([base.id])
    }
  })

  it("改回「跟随」（模型和供应商都清掉）也算改了：正是旧覆盖会盖过新设置的情形", () => {
    const cleared = { ...base, model: undefined, modelParams: undefined, resourceId: undefined }
    expect(tasksWithChangedModelSetting([base], [cleared])).toEqual([base.id])
  })

  it("只有空白的差别不算改", () => {
    expect(tasksWithChangedModelSetting([base], [{ ...base, model: " m ", resourceId: "llm_others " }])).toEqual([])
    expect(tasksWithChangedModelSetting([task()], [task({ model: "  ", resourceId: "" })])).toEqual([])
  })

  it("名称、内容、cron 等无关字段变了不算", () => {
    expect(tasksWithChangedModelSetting([base], [{ ...base, name: "改名", cron: "0 9 * * *", content: "y", enabled: false }])).toEqual([])
  })

  it("新建和删除的任务不算", () => {
    expect(tasksWithChangedModelSetting([base], [base, other])).toEqual([])
    expect(tasksWithChangedModelSetting([base, other], [base])).toEqual([])
  })
})

describe("taskTabModel：工作台上定时任务那一行显示的模型", () => {
  let dataDir: string
  beforeEach(() => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "task-tab-model-"))
    initSessionOverridesStore(dataDir)
  })
  afterEach(() => {
    resetSessionOverridesStoreForTests()
    fs.rmSync(dataDir, { recursive: true, force: true })
  })

  const chA = { id: "ch_a", enabled: true, ...channel, model: "first-channel-model", agentResourceId: "llm_others" }
  const chB = { id: "ch_b", enabled: true, ...channel }
  const channels = [chA, chB]

  it("这就是出问题的那一行：裸任务 id 凭键认不出通道（所以原来什么都取不到）", () => {
    expect(channelIdFromSessionKey(TASK_ID)).toBeUndefined()
  })

  it("任务没配模型：显示它绑定的通道的主模型、参数和供应商，不是第一个通道的", () => {
    const r = taskTabModel({ sessionKey: TASK_ID, task: task({ channelId: "ch_b" }), channels, resolveResource })
    expect(r).toEqual({ model: "claude-sonnet", modelParams: '[{"id":"thinking","value":"on"}]', resourceId: "sdk_main" })
  })

  it("任务自己配了模型：显示任务的，供应商是通道的", () => {
    const r = taskTabModel({
      sessionKey: TASK_ID,
      task: task({ channelId: "ch_b", model: "composer-2.5", modelParams: '[{"id":"fast","value":"true"}]' }),
      channels,
      resolveResource,
    })
    expect(r).toEqual({ model: "composer-2.5", modelParams: '[{"id":"fast","value":"true"}]', resourceId: "sdk_main" })
  })

  it("任务自己选了供应商：显示任务的供应商（工作台那一行才不会把别家的模型名挂在通道的供应商下）", () => {
    const r = taskTabModel({
      sessionKey: TASK_ID,
      task: task({ channelId: "ch_b", model: "gemini-flash", modelParams: "[]", resourceId: "llm_others" }),
      channels,
      resolveResource,
    })
    expect(r).toEqual({ model: "gemini-flash", modelParams: "[]", resourceId: "llm_others" })
  })

  it("任务选了供应商但没配模型：供应商不生效，显示通道的", () => {
    const r = taskTabModel({ sessionKey: TASK_ID, task: task({ channelId: "ch_b", resourceId: "llm_others" }), channels, resolveResource })
    expect(r.resourceId).toBe("sdk_main")
    expect(r.model).toBe("claude-sonnet")
  })

  it("任务没绑通道：按第一个启用的通道（和拉起任务时一致），跳过停用的", () => {
    const withDisabledFirst = [{ ...chA, enabled: false }, chB]
    expect(taskTabModel({ sessionKey: TASK_ID, task: task({ channelId: undefined }), channels: withDisabledFirst, resolveResource }).model).toBe("claude-sonnet")
    expect(taskTabModel({ sessionKey: TASK_ID, task: task({ channelId: undefined }), channels, resolveResource }).model).toBe("first-channel-model")
  })

  it("会话里存过模型、任务没配时：显示存的（拉起时它优先于通道默认）", () => {
    setSessionOverride(TASK_ID, { model: "stored-model", modelParams: "", resourceId: "sdk_main" })
    expect(taskTabModel({ sessionKey: TASK_ID, task: task({ channelId: "ch_b" }), channels, resolveResource }).model).toBe("stored-model")
  })

  it("什么都取不到时是空对象（界面显示「选择模型」）：通道已被删又没配模型、或没有任何启用的通道", () => {
    expect(taskTabModel({ sessionKey: TASK_ID, task: task({ channelId: "ch_deleted" }), channels, resolveResource })).toEqual({})
    expect(taskTabModel({ sessionKey: TASK_ID, task: task({ channelId: undefined }), channels: [{ ...chA, enabled: false }], resolveResource })).toEqual({})
  })

  it("通道已被删但任务自己配了模型：仍显示任务的模型，供应商回落到默认资源", () => {
    const r = taskTabModel({ sessionKey: TASK_ID, task: task({ channelId: "ch_deleted", model: "composer-2.5" }), channels, resolveResource })
    expect(r.model).toBe("composer-2.5")
    expect(r.resourceId).toBe("sdk_default")
  })

  it("供应商在配置里找不到：回落到默认资源的 id，不留一个不存在的 id", () => {
    const r = taskTabModel({
      sessionKey: TASK_ID,
      task: task({ channelId: "ch_b" }),
      channels: [{ ...chB, agentResourceId: "sdk_gone" }],
      resolveResource,
    })
    expect(r.resourceId).toBe("sdk_default")
  })
})

describe("taskCardFooter", () => {
  const tasks = [task()]
  const labels = new Map([[TASK_ID, "composer-2.5-fast"]])
  const labelOf = (k: string) => labels.get(k)

  it("独立任务：页脚是这次运行用的模型", () => {
    expect(taskCardFooter({ invokerSessionKey: TASK_ID, sessionKey: "ch_b|oc_main", tasks, modelLabelOf: labelOf })).toBe("composer-2.5-fast")
  })

  it("按调用方（任务 id）查模型名，不是按发送目标（聊天键）查", () => {
    const asked: string[] = []
    taskCardFooter({
      invokerSessionKey: TASK_ID,
      sessionKey: "ch_b|oc_main",
      tasks,
      modelLabelOf: (k) => { asked.push(k); return "m" },
    })
    expect(asked).toEqual([TASK_ID])
  })

  it("没有调用方时退回用发送的会话键（它本身就是任务 id 的情形）", () => {
    expect(taskCardFooter({ sessionKey: TASK_ID, tasks, modelLabelOf: labelOf })).toBe("composer-2.5-fast")
  })

  it("不是独立任务的会话一律没有页脚，哪怕登记过模型名（主会话有自己的流式卡页脚）", () => {
    const l = new Map([["ch_b|oc_main::D:\\ws", "composer-2"], [TASK_ID, "composer-2.5-fast"]])
    expect(taskCardFooter({ invokerSessionKey: "ch_b|oc_main::D:\\ws", sessionKey: "ch_b|oc_main", tasks, modelLabelOf: (k) => l.get(k) })).toBeUndefined()
    expect(taskCardFooter({ invokerSessionKey: "other-id", sessionKey: "ch_b|oc_main", tasks, modelLabelOf: (k) => l.get(k) })).toBeUndefined()
  })

  it("非独立任务（走主会话队列，有流式卡）没有页脚", () => {
    expect(taskCardFooter({ invokerSessionKey: TASK_ID, tasks: [task({ independent: false })], modelLabelOf: labelOf })).toBeUndefined()
  })

  it("没登记模型名、或登记的是空白：没有页脚；有空白的话去掉首尾空白", () => {
    expect(taskCardFooter({ invokerSessionKey: TASK_ID, tasks, modelLabelOf: () => undefined })).toBeUndefined()
    expect(taskCardFooter({ invokerSessionKey: TASK_ID, tasks, modelLabelOf: () => "   " })).toBeUndefined()
    expect(taskCardFooter({ invokerSessionKey: TASK_ID, tasks, modelLabelOf: () => "  composer-2.5-fast " })).toBe("composer-2.5-fast")
  })

  it("什么键都没有：没有页脚", () => {
    expect(taskCardFooter({ tasks, modelLabelOf: labelOf })).toBeUndefined()
    expect(taskCardFooter({ invokerSessionKey: "  ", sessionKey: "", tasks, modelLabelOf: labelOf })).toBeUndefined()
  })
})
