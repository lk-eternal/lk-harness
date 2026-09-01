import { describe, it, expect } from "vitest"
import {
  makeChatKey,
  parseChatKey,
  chatIdFromSessionKey,
  channelIdFromSessionKey,
  workspaceDirFromSessionKey,
} from "../src/shared/channel-types.js"

describe("makeChatKey", () => {
  it("?? channelId ? chatId", () => {
    expect(makeChatKey("ch_abc", "oc_123")).toBe("ch_abc|oc_123")
  })

  it("channelId ?????? chatId", () => {
    expect(makeChatKey("", "oc_123")).toBe("oc_123")
  })
})

describe("parseChatKey", () => {
  it("???????? chatKey", () => {
    expect(parseChatKey("ch_abc|oc_123")).toEqual({ channelId: "ch_abc", chatId: "oc_123" })
  })

  it("????????? chatId", () => {
    expect(parseChatKey("oc_123")).toEqual({ chatId: "oc_123" })
  })

  it("? ch_ ????????????", () => {
    expect(parseChatKey("foo|bar")).toEqual({ chatId: "foo|bar" })
  })

  it("chatId ???????????????", () => {
    expect(parseChatKey("ch_a|oc_1|extra")).toEqual({ channelId: "ch_a", chatId: "oc_1|extra" })
  })

  it("???????idx=0????", () => {
    expect(parseChatKey("|oc_123")).toEqual({ chatId: "|oc_123" })
  })
})

describe("chatIdFromSessionKey", () => {
  it("???????", () => {
    expect(chatIdFromSessionKey("ch_a|oc_1::D:\\ws\\dir")).toBe("ch_a|oc_1")
  })

  it("????????", () => {
    expect(chatIdFromSessionKey("ch_a|oc_1")).toBe("ch_a|oc_1")
  })

  it("????? :: ???", () => {
    expect(chatIdFromSessionKey("oc_1::C:\\a::b")).toBe("oc_1")
  })

  it(":: ???idx=0????", () => {
    expect(chatIdFromSessionKey("::oc_1")).toBe("::oc_1")
  })
})

describe("channelIdFromSessionKey", () => {
  it("??? sessionKey ?? channelId", () => {
    expect(channelIdFromSessionKey("ch_a|oc_1::D:\\ws")).toBe("ch_a")
  })

  it("???????? undefined", () => {
    expect(channelIdFromSessionKey("oc_1::D:\\ws")).toBeUndefined()
  })

  it("? chatId ?? undefined", () => {
    expect(channelIdFromSessionKey("oc_1")).toBeUndefined()
  })
})

describe("workspaceDirFromSessionKey", () => {
  it("?? Windows ????", () => {
    expect(workspaceDirFromSessionKey("ch_a|oc_1::D:\\workspace\\lk-harness")).toBe("D:\\workspace\\lk-harness")
  })

  it("?? Unix ????", () => {
    expect(workspaceDirFromSessionKey("ch_a|oc_1::/home/me/proj")).toBe("/home/me/proj")
  })

  it("? :: ???? undefined", () => {
    expect(workspaceDirFromSessionKey("ch_a|oc_1")).toBeUndefined()
  })

  it("???????????????? undefined", () => {
    expect(workspaceDirFromSessionKey("ch_a|oc_1::wf_inst1_node2")).toBeUndefined()
  })

  it("????? undefined", () => {
    expect(workspaceDirFromSessionKey("ch_a|oc_1::")).toBeUndefined()
  })
})
