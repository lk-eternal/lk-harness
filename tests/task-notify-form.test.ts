import { describe, expect, it } from "vitest"
import type { ScheduledTask } from "../src/shared/scheduled-task-rules"
import {
  agentPickValue,
  applyAgentPick,
  applyIndependent,
  applyNotifyChannel,
  applyNotifyMode,
  sessionLabelOf,
  sessionOptionsForChannel,
  type SessionTabLike,
} from "../src/renderer/components/task-notify-form"

const task = (over: Partial<ScheduledTask> = {}): ScheduledTask => ({
  id: "t1", name: "周报", cron: "0 9 * * 5", content: "写周报", enabled: true, independent: true, channelId: "ch_a", ...over,
})

const SESSION = "ch_app|app_main::D:\\work\\docs"

describe("applyIndependent：切换独立运行", () => {
  it("切成非独立：不通知没有意义，改成通知 AI，并清掉不通知时残留的接收方", () => {
    const out = applyIndependent(task({ notify: "none", notifyChatId: "oc_x", targetProjectId: "p1" }), false)
    expect(out.independent).toBe(false)
    expect(out.notify).toBe("agent")
    expect(out).not.toHaveProperty("notifyChatId")
    expect(out).not.toHaveProperty("targetProjectId")
  })

  it("切成非独立：本来就是通知 AI / 通知我的，接收方原样保留", () => {
    const agent = applyIndependent(task({ notify: "agent", notifyChatId: SESSION }), false)
    expect(agent.notify).toBe("agent")
    expect(agent.notifyChatId).toBe(SESSION)
    const me = applyIndependent(task({ notify: "im", notifyChatId: "oc_x" }), false)
    expect(me.notify).toBe("im")
    expect(me.notifyChatId).toBe("oc_x")
  })

  it("切回独立：什么都不动", () => {
    const out = applyIndependent(task({ independent: false, notify: "agent", notifyChatId: SESSION }), true)
    expect(out.independent).toBe(true)
    expect(out.notify).toBe("agent")
    expect(out.notifyChatId).toBe(SESSION)
  })

  it("不改原对象", () => {
    const src = task({ notify: "none" })
    applyIndependent(src, false)
    expect(src.independent).toBe(true)
    expect(src.notify).toBe("none")
  })
})

describe("applyNotifyMode：切换通知谁", () => {
  it("换了方式，会话 / 群 / 项目都作废（它们是按通知方式填的）", () => {
    const out = applyNotifyMode(task({ notify: "agent", notifyChatId: SESSION, targetProjectId: "p1" }), "im")
    expect(out.notify).toBe("im")
    expect(out).not.toHaveProperty("notifyChatId")
    expect(out).not.toHaveProperty("targetProjectId")
  })

  it("不改通道", () => {
    expect(applyNotifyMode(task({ channelId: "ch_a" }), "agent").channelId).toBe("ch_a")
  })
})

describe("applyNotifyChannel：换通道", () => {
  const channels = [{ id: "ch_a", agentResourceId: "r1" }, { id: "ch_b", agentResourceId: "r1" }, { id: "ch_c", agentResourceId: "r2" }]
  const resources = [{ id: "r1" }, { id: "r2" }]

  it("写入通道；会话键 / 群 ID / 项目绑定 / 旧任务单独存的发送通道都作废", () => {
    const out = applyNotifyChannel(
      task({ notify: "agent", notifyChatId: SESSION, targetProjectId: "p1", notifyChannelId: "ch_c" }),
      "ch_b", channels, resources,
    )
    expect(out.channelId).toBe("ch_b")
    expect(out).not.toHaveProperty("notifyChatId")
    expect(out).not.toHaveProperty("targetProjectId")
    expect(out).not.toHaveProperty("notifyChannelId")
  })

  it("模型跟随通道的规则不变：换到另一家供应商的通道，跟随通道的模型清掉；同一家保留", () => {
    const withModel = task({ model: "m1", modelParams: "p" })
    expect(applyNotifyChannel(withModel, "ch_b", channels, resources).model).toBe("m1")
    const other = applyNotifyChannel(withModel, "ch_c", channels, resources)
    expect(other.model).toBeUndefined()
    expect(other.modelParams).toBeUndefined()
  })

  it("任务自己选了供应商：模型原样保留", () => {
    expect(applyNotifyChannel(task({ model: "m1", resourceId: "r1" }), "ch_c", channels, resources).model).toBe("m1")
  })
})

describe("通知 AI 的会话下拉：值和任务字段互相转换", () => {
  it("项目 / 具体会话 / 主会话", () => {
    expect(agentPickValue({ targetProjectId: "p1" })).toBe("project:p1")
    expect(agentPickValue({ notifyChatId: SESSION })).toBe(SESSION)
    expect(agentPickValue({})).toBe("")
    expect(agentPickValue({ targetProjectId: " ", notifyChatId: " " })).toBe("")
    // 项目优先：同时有时按项目（保存时会话键会被清掉）
    expect(agentPickValue({ targetProjectId: "p1", notifyChatId: SESSION })).toBe("project:p1")
  })

  it("选项目：写 targetProjectId，会话键清掉", () => {
    const out = applyAgentPick(task({ notifyChatId: SESSION }), "project:p1")
    expect(out.targetProjectId).toBe("p1")
    expect(out).not.toHaveProperty("notifyChatId")
  })

  it("选会话：写会话键，项目绑定清掉", () => {
    const out = applyAgentPick(task({ targetProjectId: "p1" }), SESSION)
    expect(out.notifyChatId).toBe(SESSION)
    expect(out).not.toHaveProperty("targetProjectId")
  })

  it("选主会话（空）：两个字段都清掉", () => {
    const out = applyAgentPick(task({ targetProjectId: "p1", notifyChatId: SESSION }), "")
    expect(out).not.toHaveProperty("targetProjectId")
    expect(out).not.toHaveProperty("notifyChatId")
  })

  it("读出再写回不变", () => {
    for (const t of [task({ targetProjectId: "p1" }), task({ notifyChatId: SESSION }), task()]) {
      const back = applyAgentPick(t, agentPickValue(t))
      expect(agentPickValue(back)).toBe(agentPickValue(t))
    }
  })
})

describe("sessionOptionsForChannel：设置页里会话下拉的选项", () => {
  const tabs: SessionTabLike[] = [
    { sessionKey: "ch_app|app_main::D:\\work\\main", label: "main（主）", kind: "main" },
    { sessionKey: "ch_app|app_main::D:\\work\\docs", label: "docs", kind: "dir" },
    { sessionKey: "ch_app|app_main::C:\\data\\workspaces\\temp_1700000000000", label: "temp", kind: "temp" },
    { sessionKey: "ch_app|app_main::project_abc123", label: "满班率", kind: "project" },
    { sessionKey: "ch_app|app_main::D:\\old", label: "old", kind: "dir", archived: true },
  ]

  it("项目会话和已归档的不列，主会话在内", () => {
    const out = sessionOptionsForChannel(tabs, { isApp: true, titles: {} })
    expect(out.map((o) => o.value)).toEqual([
      "ch_app|app_main::D:\\work\\main",
      "ch_app|app_main::D:\\work\\docs",
      "ch_app|app_main::C:\\data\\workspaces\\temp_1700000000000",
    ])
  })

  it("应用内通道：和对话页叫同一个名字（摘要标题优先，没选目录的临时会话叫「新会话」），主会话带「（主）」", () => {
    const titles = { "ch_app|app_main::d:/work/docs": "整理文档" }
    const out = sessionOptionsForChannel(tabs, { isApp: true, titles })
    expect(out.map((o) => o.label)).toEqual(["main（主）", "整理文档", "新会话"])
  })

  it("其他通道：用树里的名字（已经带「（主）」的不重复加）", () => {
    const out = sessionOptionsForChannel(tabs, { isApp: false, titles: {} })
    expect(out.map((o) => o.label)).toEqual(["main（主）", "docs", "temp"])
  })

  it("同名的加序号，下拉里不会有两行一模一样", () => {
    const dup: SessionTabLike[] = [
      { sessionKey: "ch_app|app_main::C:\\data\\workspaces\\temp_1", label: "temp", kind: "temp" },
      { sessionKey: "ch_app|app_main::C:\\data\\workspaces\\temp_2", label: "temp", kind: "temp" },
      { sessionKey: "ch_app|app_main::D:\\work\\docs", label: "docs", kind: "dir" },
    ]
    const out = sessionOptionsForChannel(dup, { isApp: true, titles: {} })
    expect(out.map((o) => o.label)).toEqual(["新会话 #1", "新会话 #2", "docs"])
  })

  it("没有会话：空列表", () => {
    expect(sessionOptionsForChannel([], { isApp: true, titles: {} })).toEqual([])
  })

  it("sessionLabelOf：列表里有就返回名字，没有（已删 / 换过通道）返回 undefined", () => {
    const out = sessionOptionsForChannel(tabs, { isApp: false, titles: {} })
    expect(sessionLabelOf(out, "ch_app|app_main::D:\\work\\docs")).toBe("docs")
    expect(sessionLabelOf(out, "ch_app|app_main::D:\\gone")).toBeUndefined()
  })
})
