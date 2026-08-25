import { describe, it, expect } from "vitest"
import {
  makeChatKey,
  parseChatKey,
  chatIdFromSessionKey,
  channelIdFromSessionKey,
  workspaceDirFromSessionKey,
} from "../src/shared/channel-types.js"

describe("makeChatKey", () => {
  it("拼接 channelId 与 chatId", () => {
    expect(makeChatKey("ch_abc", "oc_123")).toBe("ch_abc|oc_123")
  })

  it("channelId 为空时返回裸 chatId", () => {
    expect(makeChatKey("", "oc_123")).toBe("oc_123")
  })
})

describe("parseChatKey", () => {
  it("解析带通道前缀的 chatKey", () => {
    expect(parseChatKey("ch_abc|oc_123")).toEqual({ channelId: "ch_abc", chatId: "oc_123" })
  })

  it("无通道前缀时只返回 chatId", () => {
    expect(parseChatKey("oc_123")).toEqual({ chatId: "oc_123" })
  })

  it("非 ch_ 前缀即使含分隔符也不拆分", () => {
    expect(parseChatKey("foo|bar")).toEqual({ chatId: "foo|bar" })
  })

  it("chatId 内含分隔符时只按第一个分隔符拆", () => {
    expect(parseChatKey("ch_a|oc_1|extra")).toEqual({ channelId: "ch_a", chatId: "oc_1|extra" })
  })

  it("分隔符在首位（idx=0）不拆分", () => {
    expect(parseChatKey("|oc_123")).toEqual({ chatId: "|oc_123" })
  })
})

describe("chatIdFromSessionKey", () => {
  it("剥离工作区后缀", () => {
    expect(chatIdFromSessionKey("ch_a|oc_1::D:\\ws\\dir")).toBe("ch_a|oc_1")
  })

  it("无后缀时原样返回", () => {
    expect(chatIdFromSessionKey("ch_a|oc_1")).toBe("ch_a|oc_1")
  })

  it("只在第一个 :: 处截断", () => {
    expect(chatIdFromSessionKey("oc_1::C:\\a::b")).toBe("oc_1")
  })

  it(":: 开头（idx=0）不截断", () => {
    expect(chatIdFromSessionKey("::oc_1")).toBe("::oc_1")
  })
})

describe("channelIdFromSessionKey", () => {
  it("从完整 sessionKey 提取 channelId", () => {
    expect(channelIdFromSessionKey("ch_a|oc_1::D:\\ws")).toBe("ch_a")
  })

  it("无通道前缀时返回 undefined", () => {
    expect(channelIdFromSessionKey("oc_1::D:\\ws")).toBeUndefined()
  })

  it("裸 chatId 返回 undefined", () => {
    expect(channelIdFromSessionKey("oc_1")).toBeUndefined()
  })
})

describe("workspaceDirFromSessionKey", () => {
  it("提取 Windows 路径后缀", () => {
    expect(workspaceDirFromSessionKey("ch_a|oc_1::D:\\workspace\\lk-harness")).toBe("D:\\workspace\\lk-harness")
  })

  it("提取 Unix 路径后缀", () => {
    expect(workspaceDirFromSessionKey("ch_a|oc_1::/home/me/proj")).toBe("/home/me/proj")
  })

  it("无 :: 后缀返回 undefined", () => {
    expect(workspaceDirFromSessionKey("ch_a|oc_1")).toBeUndefined()
  })

  it("非路径形态后缀（工作流节点）返回 undefined", () => {
    expect(workspaceDirFromSessionKey("ch_a|oc_1::wf_inst1_node2")).toBeUndefined()
  })

  it("空后缀返回 undefined", () => {
    expect(workspaceDirFromSessionKey("ch_a|oc_1::")).toBeUndefined()
  })
})
