import { describe, expect, it } from "vitest"
import { REFINISH_WINDOW_MS, findRefinishedCards, repairJsonlText } from "../src/shared/app-chat-duration-repair"

const user = (ts: number, extra: Record<string, unknown> = {}) => ({ id: `u${ts}`, ts, kind: "user", text: "hi", ...extra })
const card = (ts: number, finishedAt: number | undefined, extra: Record<string, unknown> = {}) => ({
  id: `a${ts}`,
  ts,
  kind: "assistant",
  segments: [{ type: "reply", text: "ok" }],
  finished: true,
  ...(finishedAt === undefined ? {} : { finishedAt }),
  ...extra,
})
const SEC = 1000
const HOUR = 3600 * SEC

describe("findRefinishedCards：被 Resume 改写收口时间的回复卡", () => {
  it("收口紧跟在下一条用户消息之后几秒：判为被改写", () => {
    // 回复在 0:00:10 真实收口，用户 3 小时后发下一条，Resume 在它之后 3 秒重新盖了 finishedAt
    const items = [user(0), card(1_000, 3 * HOUR + 3 * SEC), user(3 * HOUR)]
    expect(findRefinishedCards(items)).toEqual([1])
  })

  it("真实收口在下一条消息之前：不动", () => {
    const items = [user(0), card(1_000, 11_000), user(3 * HOUR)]
    expect(findRefinishedCards(items)).toEqual([])
  })

  it("窗口边界：恰好 10 秒算，多 1 毫秒不算", () => {
    const t = 5 * HOUR
    expect(findRefinishedCards([user(0), card(1_000, t + REFINISH_WINDOW_MS), user(t)])).toEqual([1])
    expect(findRefinishedCards([user(0), card(1_000, t + REFINISH_WINDOW_MS + 1), user(t)])).toEqual([])
  })

  it("默认窗口就是 10 秒：下一条消息后 30 秒才收口的不算（真实收口可能就是那样）", () => {
    const t = 5 * HOUR
    expect(REFINISH_WINDOW_MS).toBe(10_000)
    expect(findRefinishedCards([user(0), card(1_000, t + 30 * SEC), user(t)])).toEqual([])
    expect(findRefinishedCards([user(0), card(1_000, t + 5 * SEC), user(t)])).toEqual([1])
  })

  it("只认回复卡：别的条目哪怕有 finishedAt 也不碰", () => {
    const t = 5 * HOUR
    const items = [user(0), { id: "x", ts: 1_000, kind: "text", text: "x", finishedAt: t + 2 * SEC }, user(t)]
    expect(findRefinishedCards(items)).toEqual([])
    expect(repairJsonlText(items.map((i) => JSON.stringify(i)).join("\n")).repaired).toBe(0)
  })

  it("收口时间恰好等于下一条消息的时间：算", () => {
    expect(findRefinishedCards([card(1_000, 5 * HOUR), user(5 * HOUR)])).toEqual([0])
  })

  it("运行中排进来的消息、很久之后才收口：不动", () => {
    // 回合跑了 2 小时，期间 30 分钟时用户排进一条消息；收口远在那条消息之后
    const items = [user(0), card(1_000, 2 * HOUR), user(30 * 60 * SEC)]
    expect(findRefinishedCards(items)).toEqual([])
  })

  it("后面没有用户消息（最后一张卡）：不动", () => {
    expect(findRefinishedCards([user(0), card(1_000, 11_000)])).toEqual([])
  })

  it("没有收口时间的卡（运行中、被判定结束的旧记录）：不动", () => {
    expect(findRefinishedCards([card(1_000, undefined), user(HOUR)])).toEqual([])
  })

  it("只看这张卡后面的第一条用户消息，中间的别的条目不影响", () => {
    const items = [
      user(0),
      card(1_000, 2 * HOUR + 2 * SEC),
      { id: "n", ts: HOUR, kind: "notice", text: "x" },
      { id: "i", ts: HOUR + 1, kind: "image", path: "p" },
      user(2 * HOUR),
    ]
    expect(findRefinishedCards(items)).toEqual([1])
  })

  it("更后面的用户消息不算：必须是紧邻的下一条", () => {
    // 下一条用户消息在 1 小时，收口在 3 小时 + 2 秒（紧跟第三条用户消息，但中间隔着第二条）
    const items = [user(0), card(1_000, 3 * HOUR + 2 * SEC), user(HOUR), user(3 * HOUR)]
    expect(findRefinishedCards(items)).toEqual([])
  })

  it("用户消息时间比卡还早（排序异常）：不碰", () => {
    const items = [card(10 * SEC, 10 * SEC + 3 * SEC), user(5 * SEC)]
    expect(findRefinishedCards(items)).toEqual([])
  })

  it("一份记录里有多张被改坏的卡，逐张判断", () => {
    const items = [
      user(0), card(1_000, 11_000), // 好的
      user(HOUR), card(HOUR + 1_000, 3 * HOUR + 3 * SEC), // 改坏的
      user(3 * HOUR), card(3 * HOUR + 1_000, 3 * HOUR + 9_000), // 好的
      user(8 * HOUR),
    ]
    expect(findRefinishedCards(items)).toEqual([3])
  })

  it("跳过空值和解析失败的行", () => {
    expect(findRefinishedCards([null, undefined, user(0), card(1_000, 2 * HOUR + SEC), null, user(2 * HOUR)])).toEqual([3])
  })
})

describe("repairJsonlText：只清掉被判定的卡的 finishedAt，其余原样", () => {
  const jsonl = (items: unknown[]) => items.map((i) => JSON.stringify(i)).join("\n") + "\n"
  const parse = (text: string) => text.split("\n").filter(Boolean).map((l) => JSON.parse(l))

  it("清掉被改坏的卡的 finishedAt，卡的其余字段原样保留", () => {
    const bad = card(1_000, 3 * HOUR + 3 * SEC, { modelLabel: "Opus", interrupted: false })
    const text = jsonl([user(0), bad, user(3 * HOUR)])
    const r = repairJsonlText(text)
    expect(r.repaired).toBe(1)
    expect(r.cards).toBe(1)
    const out = parse(r.text)
    expect(out[1]).not.toHaveProperty("finishedAt")
    const { finishedAt: _gone, ...expected } = bad
    void _gone
    expect(out[1]).toEqual(expected)
    expect(out[0]).toEqual(user(0))
    expect(out[2]).toEqual(user(3 * HOUR))
  })

  it("没有要修的：文本逐字节不变", () => {
    const text = jsonl([user(0), card(1_000, 11_000), user(HOUR)])
    const r = repairJsonlText(text)
    expect(r.repaired).toBe(0)
    expect(r.text).toBe(text)
  })

  it("没修的行逐字节保留：包括解析不了的行、空行、CRLF 和奇怪的空格", () => {
    const weird = '{"id":"u0","ts":0,"kind":"user","text":"hi"}   '
    const crlf = JSON.stringify(card(HOUR + 1_000, 3 * HOUR + 3 * SEC)) + "\r"
    const text = [weird, "这行不是 JSON", "", JSON.stringify(card(1_000, 11_000)), crlf, JSON.stringify(user(3 * HOUR)), ""].join("\n")
    // 第一张卡后面的第一条用户消息是 3h 那条（weird 在它前面），收口 11 秒，不动；CRLF 那张被改坏
    const r = repairJsonlText(text)
    expect(r.repaired).toBe(1)
    const lines = r.text.split("\n")
    expect(lines[0]).toBe(weird)
    expect(lines[1]).toBe("这行不是 JSON")
    expect(lines[2]).toBe("")
    expect(lines[3]).toBe(JSON.stringify(card(1_000, 11_000)))
    expect(lines[4]!.endsWith("\r")).toBe(true)
    expect(JSON.parse(lines[4]!)).not.toHaveProperty("finishedAt")
    expect(lines[5]).toBe(JSON.stringify(user(3 * HOUR)))
    expect(lines[6]).toBe("")
  })

  it("修完再修一次什么也不改（幂等）", () => {
    const text = jsonl([user(0), card(1_000, 3 * HOUR + 3 * SEC), user(3 * HOUR), card(3 * HOUR + 500, 3 * HOUR + 4_000)])
    const once = repairJsonlText(text)
    const twice = repairJsonlText(once.text)
    expect(once.repaired).toBe(1)
    expect(twice.repaired).toBe(0)
    expect(twice.text).toBe(once.text)
  })

  it("统计回复卡个数不含别的条目", () => {
    const r = repairJsonlText(jsonl([user(0), card(1, 2), { id: "t", ts: 3, kind: "text", text: "x" }, card(4, 5)]))
    expect(r.cards).toBe(2)
  })
})
