import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import * as fs from "node:fs"
import * as path from "node:path"
import * as os from "node:os"
import {
  initFileQueue,
  pushToFileQueue,
  claimNextMessage,
  claimSessionMessages,
  waitForSessionMessages,
  confirmClaimedMessages,
  getQueueLength,
  getQueueMessages,
  getDistinctSessions,
  deleteQueueMessage,
  deleteQueueMessagesByMessageId,
  clearAllQueueMessages,
  removePendingMessage,
  isMessageHandled,
  setDuplicateDropLogger,
} from "../src/file-queue.js"

/**
 * 「机器人自己说话」的一条根因：飞书会把 3 秒内没应答的事件重推（15 秒 / 5 分钟 / 1 小时 / 6 小时），
 * 同一应用有多个进程在线时事件还会被随机分给别的进程。队列文件一确认就删了，
 * 光靠「目录里有没有同 id 的文件」去重，认不出几小时前答过的消息，Agent 就会把它当新消息再答一遍。
 * 这里锁住：确认 / 撤回 / 删除过的消息，同一个 id 再来一律不进队，且重启后依然认得。
 */

const SESSION_A = "ch_a|oc_111::D:\\ws\\a"
const SESSION_B = "ch_b|oc_222::D:\\ws\\b"
const HOUR = 60 * 60 * 1000

let dataDir: string

beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "claw-queue-handled-"))
  process.env.APP_DATA_DIR = dataDir
  initFileQueue()
})

afterEach(() => {
  setDuplicateDropLogger(undefined)
  vi.useRealTimers()
  fs.rmSync(dataDir, { recursive: true, force: true })
})

/** 一条消息走完整个生命周期：入队 → Agent 领取 → 回复完确认 */
function deliverAndConfirm(messageId: string, session = SESSION_A): void {
  expect(pushToFileQueue("你好", messageId, "test", session)).toBe(true)
  expect(claimSessionMessages(session).map((m) => m.messageId)).toEqual([messageId])
  expect(confirmClaimedMessages(messageId, session)).toEqual([messageId])
  expect(getQueueLength(session)).toBe(0)
}

describe("已确认的消息，同 id 再来不重复入队", () => {
  it("确认后飞书重推同一个 message_id：拒绝入队，队列保持为空", () => {
    deliverAndConfirm("om_retry")
    expect(pushToFileQueue("你好", "om_retry", "feishu", SESSION_A)).toBe(false)
    expect(getQueueLength(SESSION_A)).toBe(0)
    expect(claimSessionMessages(SESSION_A)).toEqual([])
  })

  it("飞书全部重推节点（15 秒 / 5 分钟 / 1 小时 / 6 小时）都认得出", () => {
    vi.useFakeTimers({ toFake: ["Date"] })
    vi.setSystemTime(new Date("2026-11-17T10:25:42Z"))
    deliverAndConfirm("om_first")
    for (const delay of [15_000, 5 * 60_000 + 15_000, HOUR + 5 * 60_000, 7 * HOUR + 5 * 60_000]) {
      vi.setSystemTime(new Date(Date.parse("2026-11-17T10:25:42Z") + delay))
      expect(pushToFileQueue("你好", "om_first", "feishu", SESSION_A)).toBe(false)
    }
    expect(getQueueLength(SESSION_A)).toBe(0)
  })

  it("只拦同一个 id：别的消息照常入队，id 相似的不误伤", () => {
    deliverAndConfirm("om_1")
    expect(pushToFileQueue("另一条", "om_2", "feishu", SESSION_A)).toBe(true)
    expect(pushToFileQueue("前缀相似", "om_12", "feishu", SESSION_A)).toBe(true)
    expect(getQueueLength(SESSION_A)).toBe(2)
  })

  it("不跟会话绑定：同 id 换个会话再来也是重复", () => {
    deliverAndConfirm("om_x", SESSION_A)
    expect(pushToFileQueue("你好", "om_x", "feishu", SESSION_B)).toBe(false)
    expect(getQueueLength(SESSION_B)).toBe(0)
  })

  it("还没确认（processing）时的原有去重不受影响", () => {
    expect(pushToFileQueue("你好", "om_p", "feishu", SESSION_A)).toBe(true)
    claimSessionMessages(SESSION_A)
    expect(isMessageHandled("om_p")).toBe(false)
    expect(pushToFileQueue("你好", "om_p", "feishu", SESSION_A)).toBe(false)
    expect(getQueueMessages(SESSION_A).map((m) => m.status)).toEqual(["processing"])
  })

  it("claimNextMessage 领走（文件随即删除）的消息也记入", () => {
    pushToFileQueue("你好", "om_next", "feishu", SESSION_A)
    expect(claimNextMessage(SESSION_A)?.messageId).toBe("om_next")
    expect(pushToFileQueue("你好", "om_next", "feishu", SESSION_A)).toBe(false)
  })

  it("skipDedup=true 仍可显式绕过", () => {
    deliverAndConfirm("om_force")
    expect(pushToFileQueue("强制重投", "om_force", "feishu", SESSION_A, true)).toBe(true)
    expect(getQueueLength(SESSION_A)).toBe(1)
  })

  it("没有 messageId 的消息不受影响", () => {
    expect(pushToFileQueue("a", undefined, "test", SESSION_A)).toBe(true)
    expect(pushToFileQueue("a", undefined, "test", SESSION_A)).toBe(true)
    expect(isMessageHandled(undefined)).toBe(false)
  })
})

describe("撤回 / 删除过的消息，同 id 再来也不重新入队", () => {
  it("用户撤回（removePendingMessage）后飞书重推", () => {
    pushToFileQueue("你好", "om_recall", "feishu", SESSION_A)
    expect(removePendingMessage(SESSION_A, "om_recall")).toBe(true)
    expect(pushToFileQueue("你好", "om_recall", "feishu", SESSION_A)).toBe(false)
  })

  it("按 messageId 删除（deleteQueueMessagesByMessageId）后飞书重推", () => {
    pushToFileQueue("你好", "om_del", "feishu", SESSION_A)
    expect(deleteQueueMessagesByMessageId("om_del").removed).toBe(1)
    expect(pushToFileQueue("你好", "om_del", "feishu", SESSION_A)).toBe(false)
  })

  it("界面里手动删除队列文件（deleteQueueMessage）后飞书重推", () => {
    pushToFileQueue("你好", "om_ui", "feishu", SESSION_A)
    const [view] = getQueueMessages(SESSION_A)
    expect(deleteQueueMessage(view.fileId, SESSION_A)).toBe(true)
    expect(pushToFileQueue("你好", "om_ui", "feishu", SESSION_A)).toBe(false)
  })

  it("什么都没删到时不记：随后到达的同 id 消息正常入队", () => {
    expect(removePendingMessage(SESSION_A, "om_none")).toBe(false)
    expect(deleteQueueMessagesByMessageId("om_none").removed).toBe(0)
    expect(pushToFileQueue("你好", "om_none", "feishu", SESSION_A)).toBe(true)
  })
})

describe("别的进程写进来的重复文件，不投递也不拉起 Agent", () => {
  /** 模拟没退干净的旧 daemon：绕过我们的入队检查，直接把同 id 的文件写进目录 */
  function foreignWrite(messageId: string, session = SESSION_A): void {
    expect(pushToFileQueue("你好", messageId, "old-daemon", session, true)).toBe(true)
  }

  it("claimSessionMessages 不返回，并把重复文件删掉", () => {
    deliverAndConfirm("om_dup")
    foreignWrite("om_dup")
    expect(claimSessionMessages(SESSION_A)).toEqual([])
    expect(getQueueMessages(SESSION_A)).toEqual([])
  })

  it("waitForSessionMessages 不被重复文件唤醒", async () => {
    deliverAndConfirm("om_dup")
    foreignWrite("om_dup")
    expect(await waitForSessionMessages(0, 10, SESSION_A)).toEqual([])
  })

  it("claimNextMessage 不返回重复文件", () => {
    deliverAndConfirm("om_dup")
    foreignWrite("om_dup")
    expect(claimNextMessage(SESSION_A)).toBeNull()
    expect(getQueueMessages(SESSION_A)).toEqual([])
  })

  it("getDistinctSessions（调度器据此拉起 Agent）不把只含重复文件的会话算进去", () => {
    deliverAndConfirm("om_dup")
    foreignWrite("om_dup")
    expect(getDistinctSessions()).toEqual([])
    expect(getQueueMessages(SESSION_A)).toEqual([])
  })

  it("重复文件和新消息混在一起：只投新的", () => {
    deliverAndConfirm("om_dup")
    foreignWrite("om_dup")
    expect(pushToFileQueue("新消息", "om_new", "feishu", SESSION_A)).toBe(true)
    expect(claimSessionMessages(SESSION_A).map((m) => m.messageId)).toEqual(["om_new"])
  })

  it("丢弃时通知日志回调（带 safeId）", () => {
    const dropped: string[] = []
    setDuplicateDropLogger((id) => dropped.push(id))
    deliverAndConfirm("om_dup")
    foreignWrite("om_dup")
    claimSessionMessages(SESSION_A)
    expect(dropped).toEqual(["om_dup"])
  })

  it("未处理过的 id 即使重复写了两份，原有行为不变（都投递）", () => {
    foreignWrite("om_fresh")
    foreignWrite("om_fresh")
    expect(claimSessionMessages(SESSION_A).map((m) => m.messageId)).toEqual(["om_fresh", "om_fresh"])
  })
})

describe("记忆的寿命", () => {
  it("进程重启（全新模块实例，内存清零）后依然认得", async () => {
    deliverAndConfirm("om_persist")
    vi.resetModules()
    const fresh = await import("../src/file-queue.js")
    // 重启前内存里没有，只能靠落盘的文件
    expect(fresh.isMessageHandled("om_persist")).toBe(false)
    fresh.initFileQueue()
    expect(fresh.isMessageHandled("om_persist")).toBe(true)
    expect(fresh.pushToFileQueue("你好", "om_persist", "feishu", SESSION_A)).toBe(false)
  })

  it("记忆文件损坏时从空开始，不影响正常入队", async () => {
    deliverAndConfirm("om_broken")
    fs.writeFileSync(path.join(dataDir, "file-queue", "handled-message-ids.json"), "{not json", "utf-8")
    vi.resetModules()
    const fresh = await import("../src/file-queue.js")
    fresh.initFileQueue()
    expect(fresh.pushToFileQueue("你好", "om_broken", "feishu", SESSION_A)).toBe(true)
  })

  it("保留 24 小时：到期前拦、到期后放行", () => {
    vi.useFakeTimers({ toFake: ["Date"] })
    const t0 = Date.parse("2026-11-17T10:00:00Z")
    vi.setSystemTime(t0)
    deliverAndConfirm("om_ttl")

    vi.setSystemTime(t0 + 24 * HOUR - 1000)
    expect(pushToFileQueue("你好", "om_ttl", "feishu", SESSION_A)).toBe(false)

    vi.setSystemTime(t0 + 24 * HOUR + 1000)
    expect(isMessageHandled("om_ttl")).toBe(false)
    expect(pushToFileQueue("你好", "om_ttl", "feishu", SESSION_A)).toBe(true)
  })

  it("重启时已过期的记录被丢弃，不会一直攒在文件里", () => {
    vi.useFakeTimers({ toFake: ["Date"] })
    const t0 = Date.parse("2026-11-17T10:00:00Z")
    vi.setSystemTime(t0)
    deliverAndConfirm("om_old")
    vi.setSystemTime(t0 + 25 * HOUR)
    initFileQueue()
    expect(isMessageHandled("om_old")).toBe(false)
    deliverAndConfirm("om_today")
    const saved = JSON.parse(fs.readFileSync(path.join(dataDir, "file-queue", "handled-message-ids.json"), "utf-8"))
    expect(Object.keys(saved)).toEqual(["om_today"])
  })

  it("clearAllQueueMessages 一并清空记忆（回到干净状态）", () => {
    deliverAndConfirm("om_clear")
    clearAllQueueMessages()
    expect(isMessageHandled("om_clear")).toBe(false)
    initFileQueue()
    expect(isMessageHandled("om_clear")).toBe(false)
    expect(pushToFileQueue("你好", "om_clear", "feishu", SESSION_A)).toBe(true)
  })
})
