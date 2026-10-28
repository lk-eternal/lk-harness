import { describe, expect, it } from "vitest"
import { resolveManageChatId, type OwnerChannel } from "../src/shared/session-owner"

// 三个通道，都绑了主用户。第 1 个排在最前，正是旧逻辑（取第一个绑了主用户的通道）会误用的那个
const CH_A: OwnerChannel = { id: "ch_a", mainUserEnabled: true, mainUserChatId: "ou_main_a" }
const CH_B: OwnerChannel = { id: "ch_b", mainUserEnabled: true, mainUserChatId: "ou_main_b" }
const CH_C: OwnerChannel = { id: "ch_c", mainUserEnabled: true, mainUserChatId: "  ou_main_c  " }
const ALL = [CH_A, CH_B, CH_C]

describe("resolveManageChatId：按会话自己所属的通道解析主用户聊天", () => {
  it("第 2 个及以后通道里的会话，解析到它自己的通道，不是第一个通道", () => {
    // 回归：以前界面发来会话键后取第一个通道，「激活」会把通道 A 的当前会话指针指到通道 B 的会话上
    expect(resolveManageChatId("ch_b|ou_main_b::D:\\work\\x", ALL)).toEqual({
      ok: true,
      chatId: "ch_b|ou_main_b",
      channelId: "ch_b",
    })
    expect(resolveManageChatId("ch_c|ou_main_c::D:\\work\\y", ALL)).toMatchObject({ ok: true, chatId: "ch_c|ou_main_c", channelId: "ch_c" })
  })

  it("第一个通道的会话仍然解析到第一个通道", () => {
    expect(resolveManageChatId("ch_a|ou_main_a::D:\\work\\x", ALL)).toMatchObject({ ok: true, chatId: "ch_a|ou_main_a" })
  })

  it("会话键带通道前缀但通道已不存在或已停用：报错，不回退到别的通道", () => {
    const r = resolveManageChatId("ch_gone|ou_x::D:\\work\\x", ALL)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toContain("不存在或已停用")
  })

  it("所属通道没有绑定主用户：报错，不回退到别的通道", () => {
    const noMain: OwnerChannel = { id: "ch_n", mainUserEnabled: false, mainUserChatId: "ou_x" }
    const r = resolveManageChatId("ch_n|ou_x::D:\\work\\x", [CH_A, noMain])
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toContain("没有绑定主用户")
    // 只填了 chatId、但开关没开，也算没绑
    const blank: OwnerChannel = { id: "ch_b2", mainUserEnabled: true, mainUserChatId: "   " }
    expect(resolveManageChatId("ch_b2|ou::D:\\w", [CH_A, blank]).ok).toBe(false)
  })

  it("主用户 chatId 两端的空白会去掉", () => {
    expect(resolveManageChatId("ch_c|ou_main_c::D:\\work\\y", ALL)).toMatchObject({ chatId: "ch_c|ou_main_c" })
  })

  it("旧格式（没有通道前缀）：看会话记录里存的聊天键", () => {
    expect(resolveManageChatId("ou_old::D:\\work\\x", ALL, "ch_b|ou_old")).toEqual({
      ok: true,
      chatId: "ch_b|ou_main_b",
      channelId: "ch_b",
    })
  })

  it("旧格式、会话记录里也没有：只有一个通道绑了主用户才能确定", () => {
    expect(resolveManageChatId("ou_old::D:\\work\\x", [CH_B])).toMatchObject({ ok: true, chatId: "ch_b|ou_main_b" })
    // 另一个通道没绑主用户，不影响「只有一个」的判断
    const noMain: OwnerChannel = { id: "ch_n", mainUserEnabled: false }
    expect(resolveManageChatId("ou_old::D:\\work\\x", [noMain, CH_B])).toMatchObject({ ok: true, chatId: "ch_b|ou_main_b" })
  })

  it("旧格式、看不出所属通道、有多个通道绑了主用户：报错，不再猜第一个", () => {
    const r = resolveManageChatId("ou_old::D:\\work\\x", ALL)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toContain("无法确定")
  })

  it("一个绑了主用户的通道都没有", () => {
    const r = resolveManageChatId("ou_old::D:\\work\\x", [{ id: "ch_n", mainUserEnabled: false }])
    expect(r).toEqual({ ok: false, error: "未绑定主用户" })
    expect(resolveManageChatId("ou_old::D:\\work\\x", [])).toEqual({ ok: false, error: "未绑定主用户" })
  })

  it("会话键里的前缀优先于会话记录里存的聊天键", () => {
    expect(resolveManageChatId("ch_a|ou_main_a::D:\\work\\x", ALL, "ch_b|ou_main_b")).toMatchObject({ channelId: "ch_a" })
  })

  it("项目会话键同样按前缀所属通道解析", () => {
    expect(resolveManageChatId("ch_b|ou_main_b::project_abc123", ALL)).toMatchObject({ ok: true, chatId: "ch_b|ou_main_b" })
  })
})
