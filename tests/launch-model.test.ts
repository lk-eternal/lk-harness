import { afterEach, beforeEach, describe, expect, it } from "vitest"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import {
  resolveChannelDefaultModel,
  resolveLaunchModel,
  resolveSessionResourceId,
  type ChannelModelFields,
} from "../src/shared/launch-model"
import { initSessionOverridesStore, resetSessionOverridesStoreForTests } from "../src/shared/session-overrides-store"
import { setSessionOverride } from "../src/shared/session-model-store"
import { setSessionResourceOverride } from "../src/shared/session-resource-store"

/**
 * 拉起 Agent 时「用哪个供应商、哪个模型」的规则。这些用例锁住的是原来 launchAgent 里内联的行为（逐条照搬），
 * 重构成共用函数后行为不能变；会话管理页显示的有效模型也走这同一个函数。
 * 会话存储用真实实现 + 临时目录，不是 mock。
 */

const SESSION = "ch_a|oc_group1::D:\\ws\\a"
const CHAT = "ch_a|oc_group1"

const KNOWN = new Set(["sdk_main", "llm_others", "llm_other2"])
/** 和 getAgentResource 一样：找不到就回落到默认资源，而不是报错 */
const resolveResource = (id: string | undefined) => ({ id: id && KNOWN.has(id) ? id : "sdk_default" })

const channel: ChannelModelFields = {
  agentResourceId: "sdk_main",
  othersAgentResourceId: "llm_others",
  model: "composer-2",
  modelParams: "[]",
  othersModel: "gemini-flash",
  othersModelParams: '[{"id":"thinking","value":"high"}]',
}

let dataDir: string
beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "launch-model-"))
  initSessionOverridesStore(dataDir)
})
afterEach(() => {
  resetSessionOverridesStoreForTests()
  fs.rmSync(dataDir, { recursive: true, force: true })
})

describe("resolveChannelDefaultModel", () => {
  it("primary 取主模型；others 取其他人模型", () => {
    expect(resolveChannelDefaultModel(channel, "primary")).toEqual({ model: "composer-2", modelParams: "[]" })
    expect(resolveChannelDefaultModel(channel, "others")).toEqual({ model: "gemini-flash", modelParams: '[{"id":"thinking","value":"high"}]' })
  })

  it("其他人模型留空（含只有空白）时跟随主模型，参数也跟主", () => {
    const c = { ...channel, othersModel: "  ", othersModelParams: '[{"x":1}]' }
    expect(resolveChannelDefaultModel(c, "others")).toEqual({ model: "composer-2", modelParams: "[]" })
  })

  it("没有通道返回空", () => {
    expect(resolveChannelDefaultModel(undefined, "primary")).toEqual({ model: "", modelParams: "" })
  })
})

describe("resolveLaunchModel：没有任何会话级设置时跟随通道", () => {
  it("主用户：主供应商 + 主模型", () => {
    const r = resolveLaunchModel({ sessionKey: SESSION, channel, audience: "main", resolveResource })
    expect(r).toMatchObject({
      resourceId: "sdk_main",
      resolvedResourceId: "sdk_main",
      resourceSource: "channel",
      model: "composer-2",
      modelParams: "[]",
      modelSource: "channel",
    })
  })

  it("其他人：其他人供应商 + 其他人模型", () => {
    const r = resolveLaunchModel({ sessionKey: SESSION, channel, audience: "others", resolveResource })
    expect(r).toMatchObject({
      channelResourceId: "llm_others",
      resourceId: "llm_others",
      model: "gemini-flash",
      modelParams: '[{"id":"thinking","value":"high"}]',
      modelSource: "channel",
      resourceSource: "channel",
    })
  })

  it("其他人供应商留空：跟随主用户的供应商", () => {
    const r = resolveLaunchModel({
      sessionKey: SESSION,
      channel: { ...channel, othersAgentResourceId: "", othersModel: "" },
      audience: "others",
      resolveResource,
    })
    expect(r).toMatchObject({ resourceId: "sdk_main", model: "composer-2" })
  })

  it("通道默认模型是 auto 时原样带出，由引擎自己落到默认", () => {
    const r = resolveLaunchModel({ sessionKey: SESSION, channel: { ...channel, model: "auto" }, audience: "main", resolveResource })
    expect(r.model).toBe("auto")
  })
})

describe("resolveLaunchModel：会话自己存的模型", () => {
  it("和最终供应商匹配时生效，并标成「会话」来源", () => {
    setSessionOverride(SESSION, { model: "gpt-x", modelParams: "[1]", resourceId: "llm_others" })
    const r = resolveLaunchModel({ sessionKey: SESSION, channel, audience: "others", resolveResource })
    expect(r).toMatchObject({ model: "gpt-x", modelParams: "[1]", modelSource: "session", resourceSource: "channel", resourceId: "llm_others" })
  })

  it("老数据没有 resourceId：不生效（防大模型供应商的模型名交给别的供应商）", () => {
    setSessionOverride(SESSION, { model: "gpt-x", modelParams: "" })
    const r = resolveLaunchModel({ sessionKey: SESSION, channel, audience: "others", resolveResource })
    expect(r).toMatchObject({ model: "gemini-flash", modelSource: "channel" })
  })

  it("属于别的供应商：不生效", () => {
    // 所属聊天上存的模型属于 llm_other2，而这个会话自己把供应商改成了 sdk_main
    setSessionOverride(CHAT, { model: "gpt-x", modelParams: "", resourceId: "llm_other2" })
    setSessionResourceOverride(SESSION, "sdk_main")
    const r = resolveLaunchModel({ sessionKey: SESSION, channel, audience: "others", resolveResource })
    expect(r).toMatchObject({ resourceId: "sdk_main", model: "gemini-flash", modelSource: "channel" })
  })

  it("会话所属聊天（裸聊天键）上存的模型，对该聊天下的会话同样生效", () => {
    setSessionOverride(CHAT, { model: "chat-level", modelParams: "", resourceId: "llm_others" })
    const r = resolveLaunchModel({ sessionKey: SESSION, channel, audience: "others", resolveResource })
    expect(r).toMatchObject({ model: "chat-level", modelSource: "session" })
  })

  it("会话自己存的优先于所属聊天存的", () => {
    setSessionOverride(CHAT, { model: "chat-level", resourceId: "llm_others" })
    setSessionOverride(SESSION, { model: "session-level", resourceId: "llm_others" })
    const r = resolveLaunchModel({ sessionKey: SESSION, channel, audience: "others", resolveResource })
    expect(r.model).toBe("session-level")
  })

  it("别的会话存的不影响这个会话", () => {
    setSessionOverride("ch_a|oc_other::D:\\ws\\a", { model: "gpt-x", resourceId: "llm_others" })
    const r = resolveLaunchModel({ sessionKey: SESSION, channel, audience: "others", resolveResource })
    expect(r).toMatchObject({ model: "gemini-flash", modelSource: "channel" })
  })
})

describe("resolveLaunchModel：会话级供应商覆盖", () => {
  it("供应商以会话存的为准，来源标成「会话」", () => {
    setSessionResourceOverride(SESSION, "llm_other2")
    const r = resolveLaunchModel({ sessionKey: SESSION, channel, audience: "others", resolveResource })
    expect(r).toMatchObject({
      channelResourceId: "llm_others",
      resourceId: "llm_other2",
      resolvedResourceId: "llm_other2",
      resourceSource: "session",
    })
  })

  it("只改了供应商、没存模型：模型回落到通道默认（原有行为，不保证模型属于新供应商）", () => {
    setSessionResourceOverride(SESSION, "llm_other2")
    const r = resolveLaunchModel({ sessionKey: SESSION, channel, audience: "others", resolveResource })
    expect(r).toMatchObject({ model: "gemini-flash", modelSource: "channel" })
  })

  it("模型和供应商存在同一条会话记录里：只改供应商不清模型，存着的模型就跟着归到新供应商（原有行为）", () => {
    setSessionOverride(SESSION, { model: "old-provider-model", resourceId: "llm_others" })
    setSessionResourceOverride(SESSION, "llm_other2")
    const r = resolveLaunchModel({ sessionKey: SESSION, channel, audience: "others", resolveResource })
    expect(r).toMatchObject({ resourceId: "llm_other2", model: "old-provider-model", modelSource: "session" })
  })

  it("setSessionOverride 带 resourceId 时，同时就是会话级供应商覆盖", () => {
    // 存模型时顺带写入了 resourceId，读供应商覆盖时读到的就是它
    setSessionOverride(SESSION, { model: "gpt-x", resourceId: "llm_other2" })
    const r = resolveLaunchModel({ sessionKey: SESSION, channel, audience: "others", resolveResource })
    expect(r).toMatchObject({ resourceId: "llm_other2", resourceSource: "session", model: "gpt-x", modelSource: "session" })
  })

  it("供应商在配置里找不到：resourceId 保留原值，resolvedResourceId 是回落的默认资源，调用方据此报错", () => {
    const r = resolveLaunchModel({ sessionKey: SESSION, channel: { ...channel, agentResourceId: "sdk_gone" }, audience: "main", resolveResource })
    expect(r.resourceId).toBe("sdk_gone")
    expect(r.resolvedResourceId).toBe("sdk_default")
  })

  it("通道没配供应商：resourceId 为空，resolvedResourceId 是默认资源（会话存的模型据此匹配）", () => {
    const r = resolveLaunchModel({ sessionKey: SESSION, channel: { ...channel, agentResourceId: "" }, audience: "main", resolveResource })
    expect(r.resourceId).toBe("")
    expect(r.resolvedResourceId).toBe("sdk_default")
  })
})

describe("resolveLaunchModel：显式指定（定时任务 / 工作流节点）", () => {
  it("优先于会话存的和通道默认", () => {
    setSessionOverride(SESSION, { model: "gpt-x", resourceId: "llm_others" })
    const r = resolveLaunchModel({
      sessionKey: SESSION,
      channel,
      audience: "others",
      explicit: { model: "  task-model  ", modelParams: "[2]" },
      resolveResource,
    })
    expect(r).toMatchObject({ model: "task-model", modelParams: "[2]", modelSource: "explicit" })
  })

  it("没给参数时参数为空串", () => {
    const r = resolveLaunchModel({ sessionKey: SESSION, channel, audience: "main", explicit: { model: "m" }, resolveResource })
    expect(r).toMatchObject({ model: "m", modelParams: "" })
  })

  it("显式模型只有空白：视为没指定", () => {
    const r = resolveLaunchModel({ sessionKey: SESSION, channel, audience: "main", explicit: { model: "   " }, resolveResource })
    expect(r).toMatchObject({ model: "composer-2", modelSource: "channel" })
  })

  it("显式指定不改变供应商的解析", () => {
    setSessionResourceOverride(SESSION, "llm_other2")
    const r = resolveLaunchModel({ sessionKey: SESSION, channel, audience: "main", explicit: { model: "m" }, resolveResource })
    expect(r).toMatchObject({ resourceId: "llm_other2", resourceSource: "session" })
  })
})

describe("resolveLaunchModel：会话存储不可用", () => {
  it("存储没初始化（读会抛）时沿用通道的供应商和模型，不抛出", () => {
    resetSessionOverridesStoreForTests()
    const prev = process.env.APP_DATA_DIR
    delete process.env.APP_DATA_DIR
    try {
      const r = resolveLaunchModel({ sessionKey: SESSION, channel, audience: "others", resolveResource })
      expect(r).toMatchObject({
        resourceId: "llm_others",
        resourceSource: "channel",
        model: "gemini-flash",
        modelSource: "channel",
      })
    } finally {
      if (prev !== undefined) process.env.APP_DATA_DIR = prev
    }
  })
})

describe("resolveSessionResourceId：切换模型时判断「当前供应商」", () => {
  // 通道绑了主用户 ou_main；别人（oc_group1 群、ou_guest 私聊）用单独配的 llm_others
  const bound = { ...channel, mainUserEnabled: true, mainUserChatId: "ou_main" }
  const MAIN_SESSION = "ch_a|ou_main::D:\\ws\\a"
  const GUEST_P2P = "ch_a|ou_guest::D:\\ws\\a"

  it("主用户的会话：通道主供应商", () => {
    expect(resolveSessionResourceId({ sessionKey: MAIN_SESSION, channel: bound })).toBe("sdk_main")
  })

  it("别人的群 / 私聊会话：其他人供应商，而不是通道主供应商（修复前这里算成 sdk_main）", () => {
    expect(resolveSessionResourceId({ sessionKey: SESSION, channel: bound })).toBe("llm_others")
    expect(resolveSessionResourceId({ sessionKey: GUEST_P2P, channel: bound })).toBe("llm_others")
  })

  it("其他人供应商留空：跟随主供应商", () => {
    const c = { ...bound, othersAgentResourceId: "" }
    expect(resolveSessionResourceId({ sessionKey: SESSION, channel: c })).toBe("sdk_main")
  })

  it("会话自己存的供应商优先于通道默认", () => {
    setSessionResourceOverride(SESSION, "llm_other2")
    expect(resolveSessionResourceId({ sessionKey: SESSION, channel: bound })).toBe("llm_other2")
    // 别的会话不受影响
    expect(resolveSessionResourceId({ sessionKey: GUEST_P2P, channel: bound })).toBe("llm_others")
  })

  it("所属聊天上存的供应商，对该聊天下的会话同样生效", () => {
    setSessionResourceOverride(CHAT, "llm_other2")
    expect(resolveSessionResourceId({ sessionKey: SESSION, channel: bound })).toBe("llm_other2")
  })

  it("系统会话（项目 / 临时）归主用户，哪怕聊天不是主用户的", () => {
    expect(resolveSessionResourceId({ sessionKey: "ch_a|oc_group1::project_p1", channel: bound })).toBe("sdk_main")
    expect(resolveSessionResourceId({ sessionKey: "temp_abcd1234", channel: bound })).toBe("sdk_main")
  })

  it("定时任务的会话键是裸 id，调用方传 chatType=task 才归主用户", () => {
    expect(resolveSessionResourceId({ sessionKey: "task-1", channel: bound })).toBe("llm_others")
    expect(resolveSessionResourceId({ sessionKey: "task-1", channel: bound, chatType: "task" })).toBe("sdk_main")
  })

  it("通道没绑主用户：所有会话都按其他人算", () => {
    const c = { ...channel, mainUserEnabled: false, mainUserChatId: "ou_main" }
    expect(resolveSessionResourceId({ sessionKey: MAIN_SESSION, channel: c })).toBe("llm_others")
  })

  it("找不到通道：只能用会话自己存的，没有就是空", () => {
    expect(resolveSessionResourceId({ sessionKey: SESSION, channel: undefined })).toBe("")
    setSessionResourceOverride(SESSION, "llm_other2")
    expect(resolveSessionResourceId({ sessionKey: SESSION, channel: undefined })).toBe("llm_other2")
  })

  it("会话存储没初始化：退回通道默认，不抛", () => {
    resetSessionOverridesStoreForTests()
    const prev = process.env.APP_DATA_DIR
    delete process.env.APP_DATA_DIR
    try {
      expect(resolveSessionResourceId({ sessionKey: SESSION, channel: bound })).toBe("llm_others")
    } finally {
      if (prev !== undefined) process.env.APP_DATA_DIR = prev
    }
  })
})
