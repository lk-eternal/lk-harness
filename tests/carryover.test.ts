import { describe, it, expect, beforeEach, afterEach } from "vitest"
import * as fs from "node:fs"
import * as path from "node:path"
import * as os from "node:os"
import {
  turnsFromPiMessages,
  takeLastTurns,
  buildCarryoverBlock,
  initCarryoverStore,
  resetCarryoverStoreForTests,
  stashCarryover,
  consumeCarryover,
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
  it("跳过工具块与报错空回合，拆出[宿主交付]真用户正文", () => {
    const turns = turnsFromPiMessages([
      { role: "user", content: "[冷启动] 请先非阻塞 poll-message" },
      {
        role: "user",
        content: '[宿主交付]\n```json\n{"session":{},"messages":[{"text":"回调重试会重复入账"}]}\n```',
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

describe("buildCarryoverBlock", () => {
  it("头轮次尾三件套", () => {
    const block = buildCarryoverBlock(
      [{ role: "user", text: "看看怎么防" }, { role: "assistant", text: "加幂等键" }],
      "A网关", "B网关",
    )
    expect(block).toContain("[历史搬运 · 从 A网关 → B网关 · 共 2 轮]")
    expect(block).toContain("[用户] 看看怎么防")
    expect(block).toContain("[助手] 加幂等键")
    expect(block).toContain("[搬运结束]")
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
  it("单次消费", () => {
    stashCarryover("sk", { block: "b", turns: 2, fromLabel: "A", toLabel: "B" })
    expect(consumeCarryover("sk")?.block).toBe("b")
    expect(consumeCarryover("sk")).toBeUndefined()
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
})
