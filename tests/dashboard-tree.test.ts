import { describe, it, expect } from "vitest"
import { buildDashboardTree, classifySessionGroup } from "../src/shared/dashboard-tree.js"

describe("classifySessionGroup", () => {
  it("maps project_ key to project", () => {
    expect(classifySessionGroup("ch_x|ou_y::project_abc", "project")).toBe("project")
  })
  it("maps temp/task to task", () => {
    expect(classifySessionGroup("temp_123", "temp")).toBe("task")
    expect(classifySessionGroup("task-id", "task")).toBe("task")
  })
  it("maps group to group", () => {
    expect(classifySessionGroup("ch_x|oc_g::D:\\ws", "group")).toBe("group")
  })
  it("maps non-main p2p to other_p2p", () => {
    expect(classifySessionGroup("ch_x|ou_other::D:\\ws", "p2p", { mainChatId: "ch_x|ou_main" })).toBe("other_p2p")
  })
  it("maps main p2p to main", () => {
    expect(classifySessionGroup("ch_x|ou_main::D:\\ws", "p2p", { mainChatId: "ch_x|ou_main" })).toBe("main")
  })
})

describe("buildDashboardTree", () => {
  it("main group keeps idle switchable sessions; other groups only running", () => {
    const tree = buildDashboardTree({
      channels: [{ id: "c1", name: "飞书", connected: true, mainUserChatId: "ch|ou_main" }],
      running: [
        { sessionKey: "ch|ou_main::D:\\a", chatType: "p2p", model: "grok-4.5", label: "a" },
        { sessionKey: "ch|ou_other::D:\\b", chatType: "p2p", model: "composer-2.5", label: "b" },
      ],
      mainSwitchable: [
        { channelId: "c1", sessionKey: "ch|ou_main::D:\\idle", label: "idle-dir", kind: "dir" },
      ],
      activeKeyByChat: { "ch|ou_main": "ch|ou_main::D:\\a" },
      queue: [],
    })
    const ch = tree.channels[0]
    expect(ch.groups.main.sessions.map((s) => s.sessionKey)).toEqual([
      "ch|ou_main::D:\\a",
      "ch|ou_main::D:\\idle",
    ])
    expect(ch.groups.main.sessions[0].current).toBe(true)
    expect(ch.groups.other_p2p.sessions).toHaveLength(1)
    expect(ch.groups.group.sessions).toHaveLength(0)
  })

  it("attaches queue items to matching session", () => {
    const tree = buildDashboardTree({
      channels: [{ id: "c1", name: "飞书", connected: true, mainUserChatId: "ch|ou_main" }],
      running: [{ sessionKey: "ch|ou_main::D:\\a", chatType: "p2p", label: "a" }],
      mainSwitchable: [],
      activeKeyByChat: {},
      queue: [
        { sessionKey: "ch|ou_main::D:\\a", fileId: "f1", preview: "hi", status: "pending" },
        { sessionKey: "other", fileId: "f2", preview: "x", status: "pending" },
      ],
    })
    expect(tree.channels[0].groups.main.sessions[0].queue).toEqual([
      { fileId: "f1", preview: "hi", status: "pending" },
    ])
  })
})

describe("buildDashboardTree 会话的供应商", () => {
  const channel = {
    id: "c1", name: "飞书", connected: true, mainUserChatId: "ch|ou_main",
    agentResourceId: "r_main", othersAgentResourceId: "r_others",
  }
  const build = (over: Partial<Parameters<typeof buildDashboardTree>[0]> = {}) =>
    buildDashboardTree({
      channels: [channel],
      running: [],
      mainSwitchable: [],
      activeKeyByChat: {},
      queue: [],
      ...over,
    }).channels[0]

  it("运行中的会话带着自己的供应商时，不被通道默认盖掉", () => {
    const ch = build({
      running: [{ sessionKey: "ch|ou_main::D:\\a", chatType: "p2p", model: "m", resourceId: "r_session" }],
    })
    expect(ch.groups.main.sessions[0].resourceId).toBe("r_session")
  })

  it("主用户的空闲会话没存供应商：补通道的主用户供应商", () => {
    const ch = build({
      mainSwitchable: [{ channelId: "c1", sessionKey: "ch|ou_main::D:\\idle", label: "idle", kind: "dir" }],
    })
    expect(ch.groups.main.sessions[0].resourceId).toBe("r_main")
  })

  it("主用户的空闲会话自己存了供应商：保留", () => {
    const ch = build({
      mainSwitchable: [{ channelId: "c1", sessionKey: "ch|ou_main::D:\\idle", label: "idle", kind: "dir", resourceId: "r_saved" }],
    })
    expect(ch.groups.main.sessions[0].resourceId).toBe("r_saved")
  })

  it("私聊他人、群：补「其他人」的供应商", () => {
    const ch = build({
      running: [
        { sessionKey: "ch|ou_other::D:\\b", chatType: "p2p" },
        { sessionKey: "ch|oc_group::D:\\c", chatType: "group" },
      ],
    })
    expect(ch.groups.other_p2p.sessions[0].resourceId).toBe("r_others")
    expect(ch.groups.group.sessions[0].resourceId).toBe("r_others")
  })

  it("「其他人」没单独配供应商：跟随主用户的", () => {
    const ch = buildDashboardTree({
      channels: [{ ...channel, othersAgentResourceId: undefined }],
      running: [{ sessionKey: "ch|ou_other::D:\\b", chatType: "p2p" }],
      mainSwitchable: [],
      activeKeyByChat: {},
      queue: [],
    }).channels[0]
    expect(ch.groups.other_p2p.sessions[0].resourceId).toBe("r_main")
  })

  it("项目、任务会话按主用户的供应商，不看「其他人」", () => {
    const ch = build({
      running: [
        { sessionKey: "ch|ou_main::project_abc123", chatType: "project" },
        { sessionKey: "temp_1", chatType: "task", channelId: "c1" },
      ],
    })
    expect(ch.groups.project.sessions[0].resourceId).toBe("r_main")
    expect(ch.groups.task.sessions[0].resourceId).toBe("r_main")
  })

  it("通道没配供应商：不编一个", () => {
    const ch = buildDashboardTree({
      channels: [{ id: "c1", name: "飞书", connected: true, mainUserChatId: "ch|ou_main" }],
      running: [{ sessionKey: "ch|ou_main::D:\\a", chatType: "p2p" }],
      mainSwitchable: [],
      activeKeyByChat: {},
      queue: [],
    }).channels[0]
    expect(ch.groups.main.sessions[0].resourceId).toBeUndefined()
  })
})
