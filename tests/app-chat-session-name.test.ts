import { describe, expect, it } from "vitest"
import { appChatSessionDir, appChatSessionId, appChatSessionName, sameChatDir } from "../src/shared/app-chat-types.js"
import { withAppChatNames, type DashboardChannelNode, type DashboardSessionNode, type SessionGroupId } from "../src/shared/dashboard-tree.js"

const APP = "ch_app"
const FEISHU = "ch_feishu"
const keyOf = (channelId: string, dir: string) => `${channelId}|chat::${dir}`
const TEMP_DIR = "C:\\Users\\me\\AppData\\Roaming\\lk-harness\\workspaces\\temp_1730000000000"

describe("appChatSessionName：应用内会话叫什么（对话页和工作台共用）", () => {
  it("摘要标题优先于目录名和传入的 label", () => {
    const key = keyOf(APP, "D:\\ws\\lk")
    expect(appChatSessionName(key, { [appChatSessionId(key)]: "你好与能力介绍" }, "lk（主） · main")).toBe("你好与能力介绍")
  })

  it("标题按归一化后的会话键查：路径分隔符、大小写写法不同也命中", () => {
    const titles = { "ch_app|chat::d:/ws/lk": "FBQ" }
    expect(appChatSessionName("ch_app|chat::D:\\WS\\Lk", titles, "x")).toBe("FBQ")
    expect(appChatSessionName("ch_app|chat::D:\\\\ws\\\\lk", titles, "x")).toBe("FBQ")
  })

  it("还没有标题：显示目录名，不带「（主）」和分支", () => {
    expect(appChatSessionName(keyOf(APP, "D:\\workspace\\lk-harness"), {}, "lk-harness（主） · main")).toBe("lk-harness")
    expect(appChatSessionName(keyOf(APP, "/home/me/proj/"), {}, "label")).toBe("proj")
  })

  it("还没有标题的临时会话叫「新会话」，有了标题就用标题", () => {
    const key = keyOf(APP, TEMP_DIR)
    expect(appChatSessionName(key, {}, `temp_1730000000000`)).toBe("新会话")
    expect(appChatSessionName(key, { [appChatSessionId(key)]: "查日志" }, "x")).toBe("查日志")
  })

  it("不是目录的会话（项目、定时任务）取不到名字，回落到传入的 label；没传就是 undefined", () => {
    expect(appChatSessionName("ch_app|chat::project_abc123", {}, "项目甲")).toBe("项目甲")
    expect(appChatSessionName("temp_12345678", {}, "临时 12345678")).toBe("临时 12345678")
    expect(appChatSessionName("ch_app|chat::project_abc123", {})).toBeUndefined()
  })

  it("项目会话永远叫项目名：已经存着摘要标题（或手动改的名字）也不用，没有项目名时不拿标题顶替", () => {
    const key = "ch_app|chat::project_abc123"
    expect(appChatSessionName(key, { [appChatSessionId(key)]: "修复订单页样式" }, "项目甲")).toBe("项目甲")
    expect(appChatSessionName(key, { [appChatSessionId(key)]: "修复订单页样式" })).toBeUndefined()
  })

  it("只有项目会话不看标题：同样的写法落在目录会话上，标题照样优先", () => {
    const key = keyOf(APP, "D:\\ws\\project_abc123")
    expect(appChatSessionName(key, { [appChatSessionId(key)]: "查日志" }, "x")).toBe("查日志")
  })

  it("空标题当作没有标题", () => {
    const key = keyOf(APP, "D:\\ws\\lk")
    expect(appChatSessionName(key, { [appChatSessionId(key)]: "" }, "x")).toBe("lk")
  })

  it("临时会话选了目录：没有标题时显示所选目录名，不再叫「新会话」；有标题仍用标题", () => {
    const key = keyOf(APP, TEMP_DIR)
    expect(appChatSessionName(key, {}, "temp_1730000000000", "D:\\work\\proj-a")).toBe("proj-a")
    expect(appChatSessionName(key, { [appChatSessionId(key)]: "查日志" }, "x", "D:\\work\\proj-a")).toBe("查日志")
  })
})

describe("appChatSessionDir：会话的工作目录（给用户看的）", () => {
  it("选的目录优先于会话键里的目录", () => {
    expect(appChatSessionDir(keyOf(APP, TEMP_DIR), "D:\\work\\proj-a")).toBe("D:\\work\\proj-a")
    expect(appChatSessionDir(keyOf(APP, "D:\\ws\\lk"), "D:\\work\\proj-a")).toBe("D:\\work\\proj-a")
  })

  it("没选目录时：键里是真实目录就是它，临时会话的临时文件夹对用户不可见", () => {
    expect(appChatSessionDir(keyOf(APP, "D:\\ws\\lk"))).toBe("D:\\ws\\lk")
    expect(appChatSessionDir(keyOf(APP, TEMP_DIR))).toBeUndefined()
  })

  it("项目、定时任务这类不是目录的会话没有目录", () => {
    expect(appChatSessionDir("ch_app|chat::project_abc123")).toBeUndefined()
    expect(appChatSessionDir("temp_12345678")).toBeUndefined()
  })
})

describe("sameChatDir：目录是不是同一个", () => {
  it("分隔符、末尾斜杠、大小写不算区别", () => {
    expect(sameChatDir("D:\\Work\\Proj", "d:/work/proj/")).toBe(true)
    expect(sameChatDir("/home/me/proj", "/home/me/proj/")).toBe(true)
  })

  it("不同目录、空值都不算同一个（空对空也不算，没选目录不能「匹配」没选目录）", () => {
    expect(sameChatDir("D:\\work\\a", "D:\\work\\b")).toBe(false)
    expect(sameChatDir("D:\\work\\a", "D:\\work\\a-old")).toBe(false)
    expect(sameChatDir(undefined, undefined)).toBe(false)
    expect(sameChatDir("D:\\work\\a", undefined)).toBe(false)
  })
})

function node(over: Partial<DashboardSessionNode> = {}): DashboardSessionNode {
  return { sessionKey: "k", label: "k", group: "main", running: false, queue: [], ...over }
}

function channel(channelId: string, groups: Partial<Record<SessionGroupId, DashboardSessionNode[]>>): DashboardChannelNode {
  const all: SessionGroupId[] = ["main", "other_p2p", "group", "project", "task"]
  return {
    channelId,
    name: channelId,
    connected: true,
    groups: Object.fromEntries(all.map((g) => [g, { sessions: groups[g] ?? [] }])) as DashboardChannelNode["groups"],
  }
}

describe("withAppChatNames：工作台里应用内通道的会话换成会话名", () => {
  const lk = keyOf(APP, "D:\\ws\\lk")
  const harness = keyOf(APP, "D:\\workspace\\lk-harness")
  const temp = keyOf(APP, TEMP_DIR)
  const titles = { [appChatSessionId(lk)]: "你好与能力介绍" }
  const appIds = new Set([APP])

  const appChannel = () => channel(APP, {
    main: [
      node({ sessionKey: lk, label: "lk", kind: "dir", running: true, current: true, model: "m1", queue: [{ fileId: "f1", preview: "hi" }] }),
      node({ sessionKey: harness, label: "lk-harness（主） · main", kind: "main" }),
      node({ sessionKey: temp, label: "temp_1730000000000", kind: "dir" }),
    ],
    project: [node({ sessionKey: "ch_app|chat::project_abc123", label: "📦 项目甲", group: "project" })],
  })

  it("有标题的用标题，没标题的用目录名，临时会话叫「新会话」", () => {
    const [ch] = withAppChatNames([appChannel()], appIds, titles)
    expect(ch.groups.main.sessions.map((s) => s.label)).toEqual(["你好与能力介绍", "lk-harness", "新会话"])
  })

  it("只换名字：运行状态、当前标记、模型、排队消息和会话键都原样保留", () => {
    const [ch] = withAppChatNames([appChannel()], appIds, titles)
    const renamed = ch.groups.main.sessions[0]
    expect(renamed).toMatchObject({
      sessionKey: lk,
      kind: "dir",
      running: true,
      current: true,
      model: "m1",
      queue: [{ fileId: "f1", preview: "hi" }],
    })
  })

  it("各个分组一视同仁：不在「主用户」组里的应用内目录会话（比如正在运行的）也换名字", () => {
    const ch = channel(APP, {
      main: [node({ sessionKey: lk, label: "lk" })],
      task: [node({ sessionKey: harness, label: "lk-harness（主） · main", group: "task", running: true })],
      other_p2p: [node({ sessionKey: temp, label: "temp_1730000000000", group: "other_p2p" })],
    })
    const [out] = withAppChatNames([ch], appIds, titles)
    expect(out.groups.main.sessions[0].label).toBe("你好与能力介绍")
    expect(out.groups.task.sessions[0].label).toBe("lk-harness")
    expect(out.groups.other_p2p.sessions[0].label).toBe("新会话")
    expect(out.groups.task.sessions[0].running).toBe(true)
  })

  it("项目、任务这类不是目录的会话保持原来的 label", () => {
    const [ch] = withAppChatNames([appChannel()], appIds, titles)
    expect(ch.groups.project.sessions[0].label).toBe("📦 项目甲")
  })

  it("项目会话即使存着摘要标题也保持原 label（旧版本生成过的标题不再显示）", () => {
    const projectKey = "ch_app|chat::project_abc123"
    const [ch] = withAppChatNames([appChannel()], appIds, { ...titles, [appChatSessionId(projectKey)]: "修复订单页样式" })
    expect(ch.groups.project.sessions[0].label).toBe("📦 项目甲")
  })

  it("不是应用内的通道一概不动：同一个会话键有标题也一样，返回的还是原来那个对象", () => {
    const feishuKey = keyOf(FEISHU, "D:\\ws\\lk")
    const feishu = channel(FEISHU, { main: [node({ sessionKey: feishuKey, label: "lk（主） · main" })] })
    const out = withAppChatNames([feishu, appChannel()], appIds, { ...titles, [appChatSessionId(feishuKey)]: "不该出现" })
    expect(out[0]).toBe(feishu)
    expect(out[0].groups.main.sessions[0].label).toBe("lk（主） · main")
    expect(out[1].groups.main.sessions[0].label).toBe("你好与能力介绍")
  })

  it("不改传进来的对象", () => {
    const input = appChannel()
    const before = JSON.stringify(input)
    withAppChatNames([input], appIds, titles)
    expect(JSON.stringify(input)).toBe(before)
  })

  it("没有应用内通道、或没有任何名字需要换时，返回的就是传进来的数组（不白白触发重渲染）", () => {
    const list = [appChannel()]
    expect(withAppChatNames(list, new Set(), titles)).toBe(list)
    const onlyProject = [channel(APP, { project: [node({ sessionKey: "ch_app|chat::project_abc123", label: "📦 项目甲" })] })]
    expect(withAppChatNames(onlyProject, appIds, {})).toBe(onlyProject)
  })

  it("标题后到：标题变化后重新算，名字跟着变；标题被清掉又回到目录名", () => {
    const list = [appChannel()]
    expect(withAppChatNames(list, appIds, {})[0].groups.main.sessions[0].label).toBe("lk")
    expect(withAppChatNames(list, appIds, titles)[0].groups.main.sessions[0].label).toBe("你好与能力介绍")
    expect(withAppChatNames(list, appIds, { [appChatSessionId(lk)]: "改过的名字" })[0].groups.main.sessions[0].label).toBe("改过的名字")
  })
})
