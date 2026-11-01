import { describe, expect, it } from "vitest"
import type {
  ChannelImpactClearResult,
  ChannelImpactPreviewResult,
  ChannelImpactStopResult,
  ChannelModelImpact,
} from "../src/shared/channel-model-impact"
import { saveChannelWithImpact, type ChannelSaveFlowDeps, type ImpactChoice } from "../src/shared/channel-save-flow"

const dflt = (resourceId: string, model: string) => ({ resourceId, resourceName: resourceId, model, modelParams: "" })
const bucket = (total = 0, running = 0) => ({ total, running })

/** 其他人的默认变了，并且有 1 个单独改过模型的会话、2 个运行中的跟随会话 */
const IMPACT: ChannelModelImpact = {
  changed: true,
  oldDefault: dflt("sdk_a", "m1"),
  newDefault: dflt("sdk_a", "m2"),
  providerChanged: false,
  total: 4,
  following: bucket(3, 2),
  modelPinned: bucket(1, 0),
  providerPinned: bucket(0, 0),
}
/** 默认变了，但没有任何值得问的会话 */
const QUIET: ChannelModelImpact = { ...IMPACT, total: 1, following: bucket(1, 0), modelPinned: bucket(0, 0) }

interface Harness {
  deps: ChannelSaveFlowDeps
  calls: string[]
  askedWith: ChannelModelImpact[]
}

function harness(opts: {
  preview?: ChannelImpactPreviewResult | (() => Promise<ChannelImpactPreviewResult>)
  choice?: ImpactChoice | null
  clear?: ChannelImpactClearResult | (() => Promise<ChannelImpactClearResult>)
  stop?: ChannelImpactStopResult | (() => Promise<ChannelImpactStopResult>)
}): Harness {
  const calls: string[] = []
  const askedWith: ChannelModelImpact[] = []
  const resolve = <T>(v: T | (() => Promise<T>)): Promise<T> => (typeof v === "function" ? (v as () => Promise<T>)() : Promise.resolve(v))
  return {
    calls,
    askedWith,
    deps: {
      preview: async (id, draft) => {
        calls.push(`preview:${id}:${JSON.stringify(draft)}`)
        return resolve(opts.preview ?? { ok: true, impact: IMPACT })
      },
      ask: async (impact) => {
        calls.push("ask")
        askedWith.push(impact)
        return opts.choice === undefined ? { clear: false, stop: false } : opts.choice
      },
      clear: async (id) => {
        calls.push(`clear:${id}`)
        return resolve(opts.clear ?? { ok: true, cleared: 1, failed: [] })
      },
      stop: async (id) => {
        calls.push(`stop:${id}`)
        return resolve(opts.stop ?? { ok: true, stopped: 2, failed: [] })
      },
    },
  }
}

const run = (h: Harness, extra?: { onCancel?: boolean; persistThrows?: boolean }) =>
  saveChannelWithImpact(
    "ch1",
    { id: "ch1" },
    h.deps,
    async () => {
      h.calls.push("persist")
      if (extra?.persistThrows) throw new Error("磁盘满了")
    },
    extra?.onCancel ? async () => { h.calls.push("onCancel") } : undefined,
  )

describe("saveChannelWithImpact：设置页和向导共用的保存流程", () => {
  it("不勾任何一项：只保存，不清除也不停止", async () => {
    const h = harness({ choice: { clear: false, stop: false } })
    const r = await run(h)
    expect(r).toEqual({ saved: true, cancelled: false, lines: [] })
    expect(h.calls).toEqual(['preview:ch1:{"id":"ch1"}', "ask", "persist"])
  })

  it("两项都勾：先清除、再保存、最后停止（顺序不能变）", async () => {
    const h = harness({ choice: { clear: true, stop: true } })
    const r = await run(h)
    expect(h.calls.slice(2)).toEqual(["clear:ch1", "persist", "stop:ch1"])
    expect(r.saved).toBe(true)
    expect(r.lines).toEqual([
      "单独改过的模型：已清除 1 个",
      "正在运行的会话：已停止 2 个",
    ])
  })

  it("只勾停止：不清除，保存之后才停止", async () => {
    const h = harness({ choice: { clear: false, stop: true } })
    await run(h)
    expect(h.calls.slice(2)).toEqual(["persist", "stop:ch1"])
  })

  it("只勾清除：清除在保存之前，不停止", async () => {
    const h = harness({ choice: { clear: true, stop: false } })
    await run(h)
    expect(h.calls.slice(2)).toEqual(["clear:ch1", "persist"])
  })

  it("预览里的影响原样交给提示框", async () => {
    const h = harness({})
    await run(h)
    expect(h.askedWith).toEqual([IMPACT])
  })

  it("取消：什么都不保存、不清除、不停止，返回 saved:false", async () => {
    const h = harness({ choice: null })
    const r = await run(h)
    expect(r).toEqual({ saved: false, cancelled: true, lines: [] })
    expect(h.calls).toEqual(['preview:ch1:{"id":"ch1"}', "ask"])
  })

  it("取消时有兜底就调用它（向导里要把其余设置照存），仍然不清除不停止", async () => {
    const h = harness({ choice: null })
    const r = await run(h, { onCancel: true })
    expect(r.saved).toBe(false)
    expect(h.calls).toEqual(['preview:ch1:{"id":"ch1"}', "ask", "onCancel"])
  })

  it("没有值得问的会话：不弹提示，直接保存", async () => {
    const h = harness({ preview: { ok: true, impact: QUIET } })
    const r = await run(h)
    expect(r).toEqual({ saved: true, cancelled: false, lines: [] })
    expect(h.calls).toEqual(['preview:ch1:{"id":"ch1"}', "persist"])
  })

  it("其他人的默认没变：不弹提示", async () => {
    const h = harness({ preview: { ok: true, impact: { ...IMPACT, changed: false } } })
    await run(h)
    expect(h.calls).not.toContain("ask")
  })

  it("新通道（预览没有 impact）：直接保存", async () => {
    const h = harness({ preview: { ok: true } })
    const r = await run(h)
    expect(r.saved).toBe(true)
    expect(r.lines).toEqual([]) // 没有 impact 不是「没能检查」，保存后不能弹任何话
    expect(h.calls).toEqual(['preview:ch1:{"id":"ch1"}', "persist"])
  })

  it("预览返回失败：不拦保存，保存后说明没能检查", async () => {
    const h = harness({ preview: { ok: false, error: "daemon 没响应" } })
    const r = await run(h)
    expect(h.calls).toEqual(['preview:ch1:{"id":"ch1"}', "persist"])
    expect(r.saved).toBe(true)
    expect(r.lines).toHaveLength(1)
    expect(r.lines[0]).toContain("没能检查")
    expect(r.lines[0]).toContain("daemon 没响应")
  })

  it("预览抛异常：同样不拦保存", async () => {
    const h = harness({ preview: () => Promise.reject(new Error("通道断了")) })
    const r = await run(h)
    expect(h.calls).toEqual(['preview:ch1:{"id":"ch1"}', "persist"])
    expect(r.lines[0]).toContain("通道断了")
  })

  it("清除抛异常：不拦保存，之后的停止照做，结果里写明失败", async () => {
    const h = harness({ choice: { clear: true, stop: true }, clear: () => Promise.reject(new Error("读不了会话")) })
    const r = await run(h)
    expect(h.calls.slice(2)).toEqual(["clear:ch1", "persist", "stop:ch1"])
    expect(r.saved).toBe(true)
    expect(r.lines.join("\n")).toContain("读不了会话")
    expect(r.lines.join("\n")).toContain("已停止 2 个")
  })

  it("清除部分失败：保存照常，结果里带失败个数", async () => {
    const h = harness({
      choice: { clear: true, stop: false },
      clear: { ok: false, cleared: 1, failed: [{ sessionKey: "k", error: "被占用" }] },
    })
    const r = await run(h)
    expect(h.calls).toContain("persist")
    expect(r.lines.join("\n")).toContain("1 个失败")
  })

  it("停止抛异常：设置已经保存了，结果里写明", async () => {
    const h = harness({ choice: { clear: false, stop: true }, stop: () => Promise.reject(new Error("停不掉")) })
    const r = await run(h)
    expect(r.saved).toBe(true)
    expect(r.lines.join("\n")).toContain("停不掉")
  })

  it("保存本身失败：异常抛给调用方，而且不再去停止会话", async () => {
    const h = harness({ choice: { clear: false, stop: true } })
    await expect(run(h, { persistThrows: true })).rejects.toThrow("磁盘满了")
    expect(h.calls).not.toContain("stop:ch1")
  })
})
