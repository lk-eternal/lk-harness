import { describe, expect, it } from "vitest"
import { applyTaskChannel, applyTaskModel, resolveTaskResourceId } from "../src/renderer/components/task-model"

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

  it("选具体模型：写入模型和参数，其它字段不动", () => {
    expect(applyTaskModel(task, { model: "gpt-5", modelParams: "effort=high" })).toEqual({
      ...task, model: "gpt-5", modelParams: "effort=high",
    })
  })

  it("没有参数时把旧参数清掉，不能把上一个模型的参数带过来", () => {
    expect(applyTaskModel(task, { model: "gpt-5" }).modelParams).toBeUndefined()
    expect(applyTaskModel(task, { model: "gpt-5", modelParams: "" }).modelParams).toBeUndefined()
  })

  it("「跟随通道主模型」（空模型）同时清掉模型和参数", () => {
    const r = applyTaskModel(task, { model: "", modelParams: "" })
    expect(r.model).toBeUndefined()
    expect(r.modelParams).toBeUndefined()
    expect(r.channelId).toBe("ch_a")
  })

  it("空白模型名也算跟随", () => {
    expect(applyTaskModel(task, { model: "   " }).model).toBeUndefined()
  })

  it("不修改传入的对象", () => {
    const copy = { ...task }
    applyTaskModel(task, { model: "gpt-5" })
    expect(task).toEqual(copy)
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
})
