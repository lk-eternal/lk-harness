import { describe, it, expect } from "vitest"
import { resolveRememberedChatKey } from "../src/daemon.js"

describe("remember 路由写入决策（定时任务 sessionKey 不被冲掉）", () => {
  it("裸 task.id：已有真实映射则保留（返回 undefined 不写）", () => {
    expect(resolveRememberedChatKey("grafana-daily-screenshot", "ch_x|oc_y")).toBeUndefined()
  })

  it("裸 task.id：无映射也不写自映射", () => {
    expect(resolveRememberedChatKey("grafana-daily-screenshot", undefined)).toBeUndefined()
  })

  it("裸 chatKey：保持原行为（写自映射）", () => {
    expect(resolveRememberedChatKey("ch_x|oc_y", undefined)).toBe("ch_x|oc_y")
    expect(resolveRememberedChatKey("ch_x|oc_y", "ch_x|oc_y")).toBeUndefined()
  })

  it("全 key：写 chat 部分（原行为）", () => {
    expect(resolveRememberedChatKey("ch_x|oc_y::/ws/a", undefined)).toBe("ch_x|oc_y")
    expect(resolveRememberedChatKey("ch_x|oc_y::/ws/a", "ch_x|oc_y")).toBeUndefined()
  })

  it("旧格式无通道 chat 也不写自映射", () => {
    expect(resolveRememberedChatKey("oc_abc123", undefined)).toBeUndefined()
  })
})
