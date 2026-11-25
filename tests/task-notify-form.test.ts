import { describe, expect, it } from "vitest"
import type { ScheduledTask } from "../src/shared/scheduled-task-rules"
import { applyNotifyChannel } from "../src/renderer/components/task-notify-form"

const task = (over: Partial<ScheduledTask> = {}): ScheduledTask => ({
  id: "t1", name: "周报", cron: "0 9 * * 5", content: "写周报", enabled: true, independent: true, channelId: "ch_a", ...over,
})

const SESSION = "ch_app|app_main::D:\\work\\docs"

describe("applyNotifyChannel：换通道", () => {
  const channels = [{ id: "ch_a", agentResourceId: "r1" }, { id: "ch_b", agentResourceId: "r1" }, { id: "ch_c", agentResourceId: "r2" }]
  const resources = [{ id: "r1" }, { id: "r2" }]

  it("写入通道；会话键 / 飞书会话 ID / 项目绑定 / 旧任务单独存的发送通道都作废", () => {
    const out = applyNotifyChannel(
      task({ notify: "im", notifyChatId: SESSION, targetProjectId: "p1", notifyChannelId: "ch_c" }),
      "ch_b", channels, resources,
    )
    expect(out.channelId).toBe("ch_b")
    expect(out).not.toHaveProperty("notifyChatId")
    expect(out).not.toHaveProperty("targetProjectId")
    expect(out).not.toHaveProperty("notifyChannelId")
  })

  it("任务自己选了供应商（表单里模型都是显式的）：换通道模型原样保留", () => {
    expect(applyNotifyChannel(task({ model: "m1", resourceId: "r1" }), "ch_c", channels, resources).model).toBe("m1")
  })

  it("还没显式选供应商的旧数据：换到另一家供应商的通道，跟随通道的模型清掉；同一家保留", () => {
    const withModel = task({ model: "m1", modelParams: "p" })
    expect(applyNotifyChannel(withModel, "ch_b", channels, resources).model).toBe("m1")
    const other = applyNotifyChannel(withModel, "ch_c", channels, resources)
    expect(other.model).toBeUndefined()
    expect(other.modelParams).toBeUndefined()
  })

  it("不改原对象", () => {
    const src = task({ notify: "im", notifyChatId: "oc_x" })
    applyNotifyChannel(src, "ch_b", channels, resources)
    expect(src.channelId).toBe("ch_a")
    expect(src.notifyChatId).toBe("oc_x")
  })
})
