import { describe, it, expect, beforeEach, afterEach } from "vitest"
import * as fs from "node:fs"
import * as path from "node:path"
import * as os from "node:os"
import {
  turnsFromPiMessages,
  takeLastTurns,
  replyTexts,
  mergeLegacyTurns,
  appendMirrorTurns,
  readMirrorTurns,
  clearMirror,
  initCarryoverStore,
  resetCarryoverStoreForTests,
  stashCarryover,
  peekCarryover,
  consumeCarryover,
  pendingHistoryTurns,
} from "../electron/carryover.js"
import {
  initSessionResourceStore,
  resetSessionResourceStoreForTests,
  setSessionResourceOverride,
  getSessionResourceOverride,
  clearSessionResourceOverride,
  resolveResourceForSession,
} from "../src/shared/session-resource-store.js"

describe("turnsFromPiMessages", () => {
  it("跳过工具块与报错空回合，拆出[本轮投递]真用户正文", () => {
    const turns = turnsFromPiMessages([
      { role: "user", content: "[冷启动] 请先非阻塞 poll-message" },
      {
        role: "user",
        content: '[本轮投递]\n```json\n{"session":{},"messages":[{"text":"回调重试会重复入账"}]}\n```',
      },
      { role: "assistant", content: [] },
      {
        role: "assistant",
        content: [{ type: "text", text: "加了幂等键" }, { type: "tool_call", text: "x" }],
      },
    ])
    expect(turns).toEqual([
      { role: "user", text: "回调重试会重复入账" },
      { role: "assistant", text: "加了幂等键" },
    ])
  })
})

describe("takeLastTurns", () => {
  it("轮数与字符双封顶，超了砍最旧", () => {
    const turns = Array.from({ length: 20 }, (_, i) => ({
      role: i % 2 === 0 ? ("user" as const) : ("assistant" as const),
      text: `t${i}-xxxxxxxxxx`,
    }))
    const out = takeLastTurns(turns, 10, 8000)
    expect(out.length).toBe(10)
    expect(out[0].text.startsWith("t10")).toBe(true)
    const big = [{ role: "user" as const, text: "a".repeat(7000) }, { role: "assistant" as const, text: "b".repeat(2000) }]
    expect(takeLastTurns(big, 10, 8000).length).toBe(1)
  })
})

describe("replyTexts", () => {
  it("只取 reply 段正文", () => {
    expect(replyTexts([
      { type: "reply", text: "好了" },
      { type: "thinking", text: "想想" },
      { type: "reply", text: "  " },
    ])).toEqual(["好了"])
  })
})

describe("mergeLegacyTurns", () => {
  it("老账本去重后拼前面", () => {
    const legacy = [
      { role: "user" as const, text: "旧问题" },
      { role: "assistant" as const, text: "旧回答" },
    ]
    const mirror = [{ role: "assistant" as const, text: "旧回答" }]
    expect(mergeLegacyTurns(legacy, mirror)).toEqual([
      { role: "user", text: "旧问题" },
      { role: "assistant", text: "旧回答" },
    ])
    expect(mergeLegacyTurns(legacy, [])).toEqual(legacy)
  })
})

describe("mirror", () => {
  let dataDir: string
  beforeEach(() => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "claw-mirror-"))
    initCarryoverStore(dataDir)
  })
  afterEach(() => {
    resetCarryoverStoreForTests()
    fs.rmSync(dataDir, { recursive: true, force: true })
  })
  it("记一笔、读回、清空", () => {
    appendMirrorTurns("sk", [
      { role: "user", text: "你好" },
      { role: "assistant", text: "在" },
      { role: "user", text: "  " },
    ])
    expect(readMirrorTurns("sk")).toEqual([
      { role: "user", text: "你好" },
      { role: "assistant", text: "在" },
    ])
    clearMirror("sk")
    expect(readMirrorTurns("sk")).toEqual([])
  })
})

describe("carryover store", () => {
  let dataDir: string
  beforeEach(() => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "claw-carry-"))
    initCarryoverStore(dataDir)
  })
  afterEach(() => {
    resetCarryoverStoreForTests()
    fs.rmSync(dataDir, { recursive: true, force: true })
  })
  it("单次消费，peek 不删除", () => {
    stashCarryover("sk", { turns: 2, fromLabel: "A", toLabel: "B", history: [{ role: "user", text: "hi" }] })
    expect(peekCarryover("sk")?.turns).toBe(2)
    expect(peekCarryover("sk")?.turns).toBe(2)
    expect(consumeCarryover("sk")?.turns).toBe(2)
    expect(consumeCarryover("sk")).toBeUndefined()
  })
  it("无 history 即无单", () => {
    stashCarryover("sk2", { turns: 0, fromLabel: "A", toLabel: "B", history: [] })
    expect(pendingHistoryTurns(peekCarryover("sk2")!)).toEqual([])
  })
  it("毒 resume 逃生：镜像 30 轮搬运后消费端可续上", () => {
    const sk = "poisoned-session"
    appendMirrorTurns(sk, Array.from({ length: 40 }, (_, i) => ({
      role: i % 2 === 0 ? ("user" as const) : ("assistant" as const),
      text: `第${i + 1}轮`,
    })))
    // 生产端（force 失败 catch 内同款逻辑）
    const history = takeLastTurns(readMirrorTurns(sk))
    expect(history).toHaveLength(30)
    expect(history[0]).toEqual({ role: "user", text: "第11轮" })
    stashCarryover(sk, {
      turns: history.length,
      fromLabel: "poisoned-resume",
      toLabel: "fresh",
      history,
    })
    // 消费端（launchAgent 同款逻辑）
    const pending = peekCarryover(sk)
    expect(pendingHistoryTurns(pending!)).toHaveLength(30)
    expect(consumeCarryover(sk)?.turns).toBe(30)
    expect(consumeCarryover(sk)).toBeUndefined()
  })
  it("mirror 字节封顶砍最旧行", () => {
    appendMirrorTurns("sk", [{ role: "user", text: "a".repeat(80_000) }])
    appendMirrorTurns("sk", [{ role: "assistant", text: "b".repeat(80_000) }])
    expect(readMirrorTurns("sk")).toHaveLength(1)
  })
})

describe("session-resource-store", () => {
  let dataDir: string
  beforeEach(() => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "claw-res-"))
    initSessionResourceStore(dataDir)
  })
  afterEach(() => {
    resetSessionResourceStoreForTests()
    fs.rmSync(dataDir, { recursive: true, force: true })
  })
  it("override 优先于通道默认，可清", () => {
    expect(resolveResourceForSession("sk", "ch-default")).toBe("ch-default")
    setSessionResourceOverride("sk", "res-b")
    expect(getSessionResourceOverride("sk")).toBe("res-b")
    expect(resolveResourceForSession("sk", "ch-default")).toBe("res-b")
    clearSessionResourceOverride("sk")
    expect(resolveResourceForSession("sk", "ch-default")).toBe("ch-default")
  })

  it("新会话供应商回退父chat（q3带供应商不断）", () => {
    const chat = "ch_a|oc_111"
    const project = `${chat}::project_p1`
    setSessionResourceOverride(chat, "res-q3")
    expect(getSessionResourceOverride(project)).toBe("res-q3")
    expect(resolveResourceForSession(project, "ch-default")).toBe("res-q3")
  })
})
