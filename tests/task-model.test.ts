import { describe, expect, it } from "vitest"
import { applyTaskChannel, applyTaskModel, resolveTaskResourceId, taskResourceMissing } from "../src/renderer/components/task-model"

const resources = [{ id: "r_sdk" }, { id: "r_llm" }]
const channels = [
  { id: "ch_a", agentResourceId: "r_sdk" },
  { id: "ch_b", agentResourceId: "r_llm" },
  { id: "ch_c", agentResourceId: "r_sdk" },
  { id: "ch_none" },
  { id: "ch_gone", agentResourceId: "r_deleted" },
]

describe("resolveTaskResourceId", () => {
  it("取所选通道的主用户供应商", () => {
    expect(resolveTaskResourceId(channels, resources, "ch_b")).toBe("r_llm")
    expect(resolveTaskResourceId(channels, resources, "ch_a")).toBe("r_sdk")
  })

  it("没选通道或通道已删时取第一个通道", () => {
    expect(resolveTaskResourceId(channels, resources, undefined)).toBe("r_sdk")
    expect(resolveTaskResourceId(channels, resources, "ch_deleted")).toBe("r_sdk")
    expect(resolveTaskResourceId([{ id: "x", agentResourceId: "r_llm" }, ...channels], resources, undefined)).toBe("r_llm")
  })

  it("通道没配供应商、或配的那一家不存在时不猜", () => {
    expect(resolveTaskResourceId(channels, resources, "ch_none")).toBeUndefined()
    expect(resolveTaskResourceId(channels, resources, "ch_gone")).toBeUndefined()
  })

  it("一个通道都没有", () => {
    expect(resolveTaskResourceId([], resources, undefined)).toBeUndefined()
    expect(resolveTaskResourceId(channels, [], "ch_a")).toBeUndefined()
  })
})

describe("applyTaskModel", () => {
  const task = { id: "t1", name: "日报", channelId: "ch_a", model: "old", modelParams: "p=1" }
  /** 选择器里「跟随通道」那一项给出的供应商是空串 */
  const FOLLOW = ""

  it("选「跟随通道」下的具体模型：写入模型和参数，供应商仍跟随通道，其它字段不动", () => {
    expect(applyTaskModel(task, { resourceId: FOLLOW, model: "gpt-5", modelParams: "effort=high" })).toEqual({
      ...task, model: "gpt-5", modelParams: "effort=high",
    })
    expect(applyTaskModel(task, { resourceId: FOLLOW, model: "gpt-5" }).resourceId).toBeUndefined()
  })

  it("选某一家供应商的模型：连供应商一起记下（这就是「级联供应商」）", () => {
    expect(applyTaskModel(task, { resourceId: "r_llm", model: "gpt-5", modelParams: "effort=high" })).toEqual({
      ...task, resourceId: "r_llm", model: "gpt-5", modelParams: "effort=high",
    })
  })

  it("选的恰好是通道现在的那一家，也照实记下（通道以后换了供应商，任务不能跟着换到不认识这个模型的那一家）", () => {
    expect(applyTaskModel(task, { resourceId: "r_sdk", model: "composer-2" }).resourceId).toBe("r_sdk")
  })

  it("从某一家换回「跟随通道」下的模型：任务自己的供应商清掉", () => {
    const own = { ...task, resourceId: "r_llm" }
    expect(applyTaskModel(own, { resourceId: FOLLOW, model: "composer-2" }).resourceId).toBeUndefined()
  })

  it("换供应商时不带走上一个模型的参数", () => {
    const own = { ...task, resourceId: "r_llm", modelParams: "effort=high" }
    expect(applyTaskModel(own, { resourceId: "r_sdk", model: "composer-2" }).modelParams).toBeUndefined()
  })

  it("没有参数时把旧参数清掉，不能把上一个模型的参数带过来", () => {
    expect(applyTaskModel(task, { resourceId: FOLLOW, model: "gpt-5" }).modelParams).toBeUndefined()
    expect(applyTaskModel(task, { resourceId: FOLLOW, model: "gpt-5", modelParams: "" }).modelParams).toBeUndefined()
  })

  it("「跟随通道主模型」（空模型）把供应商、模型、参数一起清掉，整个跟随通道", () => {
    const own = { ...task, resourceId: "r_llm" }
    const r = applyTaskModel(own, { resourceId: "r_llm", model: "", modelParams: "" })
    expect(r.resourceId).toBeUndefined()
    expect(r.model).toBeUndefined()
    expect(r.modelParams).toBeUndefined()
    expect(r.channelId).toBe("ch_a")
  })

  it("空白模型名也算跟随", () => {
    expect(applyTaskModel(task, { resourceId: FOLLOW, model: "   " }).model).toBeUndefined()
  })

  it("供应商只有空白：当作跟随通道", () => {
    expect(applyTaskModel(task, { resourceId: "  ", model: "gpt-5" }).resourceId).toBeUndefined()
  })

  it("不修改传入的对象", () => {
    const copy = { ...task }
    applyTaskModel(task, { resourceId: "r_llm", model: "gpt-5" })
    expect(task).toEqual(copy)
  })
})

describe("taskResourceMissing", () => {
  it("任务选的供应商不在配置里：要提醒", () => {
    expect(taskResourceMissing({ resourceId: "r_deleted" }, resources)).toBe(true)
  })

  it("还在、没选（跟随通道）、只有空白：不用提醒", () => {
    expect(taskResourceMissing({ resourceId: "r_llm" }, resources)).toBe(false)
    expect(taskResourceMissing({}, resources)).toBe(false)
    expect(taskResourceMissing({ resourceId: "  " }, resources)).toBe(false)
  })

  it("一家供应商都没有：选了就算缺失", () => {
    expect(taskResourceMissing({ resourceId: "r_llm" }, [])).toBe(true)
  })
})

describe("applyTaskChannel", () => {
  const task = { id: "t1", channelId: "ch_a", model: "composer-2", modelParams: "fast=true" }

  it("换到同一家供应商的通道：模型保留", () => {
    expect(applyTaskChannel(task, "ch_c", channels, resources)).toEqual({ ...task, channelId: "ch_c" })
  })

  it("换到另一家供应商的通道：模型改回跟随", () => {
    const r = applyTaskChannel(task, "ch_b", channels, resources)
    expect(r.channelId).toBe("ch_b")
    expect(r.model).toBeUndefined()
    expect(r.modelParams).toBeUndefined()
  })

  it("从「默认」(未选通道) 换到第一个通道所在供应商之外的通道：改回跟随", () => {
    const r = applyTaskChannel({ ...task, channelId: undefined }, "ch_b", channels, resources)
    expect(r.model).toBeUndefined()
  })

  it("换成「默认」：按第一个通道判断是否同供应商", () => {
    expect(applyTaskChannel({ ...task, channelId: "ch_c" }, undefined, channels, resources).model).toBe("composer-2")
    expect(applyTaskChannel({ ...task, channelId: "ch_b" }, undefined, channels, resources).model).toBeUndefined()
  })

  it("前后都解析不出供应商：不动模型（没有依据说它错了）", () => {
    const t = { ...task, channelId: "ch_none" }
    expect(applyTaskChannel(t, "ch_gone", channels, resources).model).toBe("composer-2")
  })

  it("原来解析不出、换到有供应商的通道：改回跟随", () => {
    expect(applyTaskChannel({ ...task, channelId: "ch_none" }, "ch_a", channels, resources).model).toBeUndefined()
  })

  describe("任务自己选了供应商", () => {
    const own = { ...task, resourceId: "r_llm", model: "gpt-5", modelParams: "effort=high" }

    it("换到任何通道：供应商、模型、参数都保留（模型是它家的，和通道无关）", () => {
      for (const ch of ["ch_a", "ch_b", "ch_c", "ch_none", "ch_gone", undefined]) {
        expect(applyTaskChannel(own, ch, channels, resources)).toEqual({ ...own, channelId: ch })
      }
    })

    it("供应商已被删了也不动它，由界面提醒用户重新选", () => {
      const gone = { ...own, resourceId: "r_deleted" }
      expect(applyTaskChannel(gone, "ch_b", channels, resources)).toEqual({ ...gone, channelId: "ch_b" })
    })

    it("供应商只有空白：当作没选，按跟随通道处理", () => {
      const blank = { ...task, resourceId: "  " }
      expect(applyTaskChannel(blank, "ch_b", channels, resources).model).toBeUndefined()
    })
  })
})
