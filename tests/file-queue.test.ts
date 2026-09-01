import { describe, it, expect, beforeEach, afterEach } from "vitest"
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
  getEarliestMessageTime,
  getQueueMessages,
  getDistinctSessions,
  deleteQueueMessage,
  deleteQueueMessagesByMessageId,
} from "../src/file-queue.js"

const SESSION_A = "ch_a|oc_111::D:\\ws\\a"
const SESSION_B = "ch_b|oc_222::D:\\ws\\b"

let dataDir: string

beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "claw-queue-"))
  process.env.APP_DATA_DIR = dataDir
  initFileQueue()
})

afterEach(() => {
  fs.rmSync(dataDir, { recursive: true, force: true })
})

describe("pushToFileQueue", () => {
  it("入队成功并计入队列长度", () => {
    expect(pushToFileQueue("你好", "m1", "test", SESSION_A)).toBe(true)
    expect(getQueueLength(SESSION_A)).toBe(1)
  })

  it("空白文本拒绝入队", () => {
    expect(pushToFileQueue("   ", "m1", "test", SESSION_A)).toBe(false)
    expect(getQueueLength(SESSION_A)).toBe(0)
  })

  it("同 messageId 去重", () => {
    expect(pushToFileQueue("第一次", "dup", "test", SESSION_A)).toBe(true)
    expect(pushToFileQueue("重复", "dup", "test", SESSION_A)).toBe(false)
    expect(getQueueLength(SESSION_A)).toBe(1)
  })

  it("skipDedup=true 允许同 messageId 再入队", () => {
    expect(pushToFileQueue("第一次", "dup", "test", SESSION_A)).toBe(true)
    expect(pushToFileQueue("再来", "dup", "test", SESSION_A, true)).toBe(true)
    expect(getQueueLength(SESSION_A)).toBe(2)
  })

  it("messageId 相似但不同的不误判去重（精确匹配 safeId）", () => {
    expect(pushToFileQueue("a", "om_1", "test", SESSION_A)).toBe(true)
    expect(pushToFileQueue("b", "om_12", "test", SESSION_A)).toBe(true)
    expect(getQueueLength(SESSION_A)).toBe(2)
  })

  it("不同会话相互隔离", () => {
    pushToFileQueue("给A", "ma", "test", SESSION_A)
    pushToFileQueue("给B", "mb", "test", SESSION_B)
    expect(getQueueLength(SESSION_A)).toBe(1)
    expect(getQueueLength(SESSION_B)).toBe(1)
    expect(getQueueLength()).toBe(2)
  })
})

describe("claimSessionMessages", () => {
  it("领取会话全部消息并按时间升序", () => {
    pushToFileQueue("早", "m1", "test", SESSION_A, false, { chatType: "p2p" })
    pushToFileQueue("晚", "m2", "test", SESSION_A)
    const msgs = claimSessionMessages(SESSION_A)
    expect(msgs.map((m) => m.text)).toEqual(["早", "晚"])
    expect(msgs[0].meta?.chatType).toBe("p2p")
    expect(msgs[0].timestamp).toBeLessThanOrEqual(msgs[1].timestamp)
  })

  it("领取不删除，未确认时重复领取返回同一批（至少一次投递）", () => {
    pushToFileQueue("消息", "m1", "test", SESSION_A)
    expect(claimSessionMessages(SESSION_A)).toHaveLength(1)
    expect(claimSessionMessages(SESSION_A)).toHaveLength(1)
  })

  it("领取后消息仍计入未处理数（claimed 未确认，掉线自愈依赖此可见性）", () => {
    pushToFileQueue("消息", "m1", "test", SESSION_A)
    claimSessionMessages(SESSION_A)
    expect(getQueueLength(SESSION_A)).toBe(1)
    confirmClaimedMessages("m1", SESSION_A)
    expect(getQueueLength(SESSION_A)).toBe(0)
  })

  it("getDistinctSessions 含 claimed-only 会话（Agent 掉线后调度器仍能看到）", () => {
    pushToFileQueue("消息", "m1", "test", SESSION_A, false, { chatType: "p2p" })
    claimSessionMessages(SESSION_A)
    expect(getDistinctSessions().map((s) => s.sessionKey)).toContain(SESSION_A)
    confirmClaimedMessages("m1", SESSION_A)
    expect(getDistinctSessions()).toHaveLength(0)
  })
})

describe("confirmClaimedMessages", () => {
  it("确认目标及更早的 claimed 消息", async () => {
    pushToFileQueue("一", "m1", "test", SESSION_A)
    await new Promise((r) => setTimeout(r, 5))
    pushToFileQueue("二", "m2", "test", SESSION_A)
    claimSessionMessages(SESSION_A)

    const acked = confirmClaimedMessages("m2", SESSION_A)
    expect(acked.sort()).toEqual(["m1", "m2"])
    expect(claimSessionMessages(SESSION_A)).toHaveLength(0)
  })

  it("只确认到 cutoff，更晚的 claimed 保留", async () => {
    pushToFileQueue("一", "m1", "test", SESSION_A)
    await new Promise((r) => setTimeout(r, 5))
    pushToFileQueue("二", "m2", "test", SESSION_A)
    claimSessionMessages(SESSION_A)

    expect(confirmClaimedMessages("m1", SESSION_A)).toEqual(["m1"])
    const remain = claimSessionMessages(SESSION_A)
    expect(remain).toHaveLength(1)
    expect(remain[0].messageId).toBe("m2")
  })

  it("未投递的 qmsg 不受 ack 影响", async () => {
    pushToFileQueue("早", "m1", "test", SESSION_A)
    claimSessionMessages(SESSION_A)
    await new Promise((r) => setTimeout(r, 5))
    pushToFileQueue("新（未领取）", "m3", "test", SESSION_A)

    confirmClaimedMessages("m1", SESSION_A)
    expect(getQueueLength(SESSION_A)).toBe(1)
  })

  it("目标不存在返回空数组", () => {
    pushToFileQueue("消息", "m1", "test", SESSION_A)
    claimSessionMessages(SESSION_A)
    expect(confirmClaimedMessages("nope", SESSION_A)).toEqual([])
  })

  it("省略 sessionKey 时遍历所有会话兜底", () => {
    pushToFileQueue("消息", "m1", "test", SESSION_A)
    claimSessionMessages(SESSION_A)
    expect(confirmClaimedMessages("m1")).toEqual(["m1"])
  })

  it("省略 messageId 时确认会话全部 claimed（阻塞 poll 隐式确认），未投递的 qmsg 保留", () => {
    pushToFileQueue("一", "m1", "test", SESSION_A)
    pushToFileQueue("二", "m2", "test", SESSION_A)
    claimSessionMessages(SESSION_A)
    pushToFileQueue("新（未领取）", "m3", "test", SESSION_A)

    expect(confirmClaimedMessages(undefined, SESSION_A).sort()).toEqual(["m1", "m2"])
    expect(getQueueLength(SESSION_A)).toBe(1)
    const remain = claimSessionMessages(SESSION_A)
    expect(remain).toHaveLength(1)
    expect(remain[0].messageId).toBe("m3")
  })

  it("省略 messageId 只清指定会话，不误删其他会话的 claimed", () => {
    pushToFileQueue("给A", "ma", "test", SESSION_A)
    pushToFileQueue("给B", "mb", "test", SESSION_B)
    claimSessionMessages(SESSION_A)
    claimSessionMessages(SESSION_B)

    expect(confirmClaimedMessages(undefined, SESSION_A)).toEqual(["ma"])
    expect(getQueueLength(SESSION_B)).toBe(1)
  })
})

describe("至少一次投递（简单模型）", () => {
  it("幽灵连接领走后（claimed），下一次领取仍然可见——实质复不丢", () => {
    pushToFileQueue("被幽灵领走", "m1", "test", SESSION_A)
    claimSessionMessages(SESSION_A)
    const again = claimSessionMessages(SESSION_A)
    expect(again.map((m) => m.messageId)).toEqual(["m1"])
  })

  it("claimed 与新 qmsg 混合时一并返回，按时间升序", async () => {
    pushToFileQueue("旧的处理中", "m1", "test", SESSION_A)
    claimSessionMessages(SESSION_A)
    await new Promise((r) => setTimeout(r, 5))
    pushToFileQueue("新消息", "m2", "test", SESSION_A)

    const msgs = claimSessionMessages(SESSION_A)
    expect(msgs.map((m) => m.messageId)).toEqual(["m1", "m2"])
  })

  it("阻塞 poll 全量确认后队列干净，只剩确认后新到的消息", () => {
    pushToFileQueue("一", "m1", "test", SESSION_A)
    pushToFileQueue("二", "m2", "test", SESSION_A)
    claimSessionMessages(SESSION_A)
    expect(confirmClaimedMessages(undefined, SESSION_A).sort()).toEqual(["m1", "m2"])
    pushToFileQueue("确认后新到", "m3", "test", SESSION_A)
    expect(claimSessionMessages(SESSION_A).map((m) => m.messageId)).toEqual(["m3"])
  })
})

describe("claimNextMessage", () => {
  it("领取即消费，不可再次领取", () => {
    pushToFileQueue("唯一", "m1", "test", SESSION_A)
    const msg = claimNextMessage(SESSION_A)
    expect(msg?.text).toBe("唯一")
    expect(msg?.sessionKey).toBe(SESSION_A)
    expect(claimNextMessage(SESSION_A)).toBeNull()
    expect(claimSessionMessages(SESSION_A)).toHaveLength(0)
  })
})

describe("waitForSessionMessages", () => {
  it("timeoutMs=0 且队列为空立即返回空数组", async () => {
    expect(await waitForSessionMessages(0, 50, SESSION_A)).toEqual([])
  })

  it("已有待处理消息立即返回", async () => {
    pushToFileQueue("在等你", "m1", "test", SESSION_A)
    const msgs = await waitForSessionMessages(0, 50, SESSION_A)
    expect(msgs).toHaveLength(1)
  })

  it("等待期间新消息到达被轮询捞起", async () => {
    const pending = waitForSessionMessages(2000, 20, SESSION_A)
    setTimeout(() => pushToFileQueue("迟到的", "m1", "test", SESSION_A), 40)
    const msgs = await pending
    expect(msgs.map((m) => m.text)).toEqual(["迟到的"])
  })

  it("isCancelled 返回 true 时提前结束", async () => {
    let cancelled = false
    setTimeout(() => { cancelled = true }, 30)
    const msgs = await waitForSessionMessages(5000, 10, SESSION_A, () => cancelled)
    expect(msgs).toEqual([])
  })
})

describe("查询与删除", () => {
  it("getEarliestMessageTime 返回最早入队时间", async () => {
    pushToFileQueue("早", "m1", "test", SESSION_A)
    const first = getEarliestMessageTime(SESSION_A)
    await new Promise((r) => setTimeout(r, 5))
    pushToFileQueue("晚", "m2", "test", SESSION_A)
    expect(getEarliestMessageTime(SESSION_A)).toBe(first)
    expect(getEarliestMessageTime(SESSION_B)).toBeNull()
  })

  it("getQueueMessages 返回预览视图（含排队状态）", () => {
    pushToFileQueue("预览内容".repeat(100), "m1", "test", SESSION_A, false, { chatType: "group", senderOpenId: "ou_x" })
    const views = getQueueMessages(SESSION_A)
    expect(views).toHaveLength(1)
    expect(views[0].preview.length).toBeLessThanOrEqual(200)
    expect(views[0].chatType).toBe("group")
    expect(views[0].senderOpenId).toBe("ou_x")
    expect(views[0].status).toBe("pending")
  })

  it("已投递未确认的消息显示 processing 状态且可删除", () => {
    pushToFileQueue("处理中的", "m1", "test", SESSION_A)
    claimSessionMessages(SESSION_A)
    const views = getQueueMessages(SESSION_A)
    expect(views).toHaveLength(1)
    expect(views[0].status).toBe("processing")
    expect(views[0].fileId.endsWith(".claimed")).toBe(true)
    expect(deleteQueueMessage(views[0].fileId, SESSION_A)).toBe(true)
    expect(getQueueLength(SESSION_A)).toBe(0)
  })

  it("getDistinctSessions 汇总各会话", () => {
    pushToFileQueue("a", "m1", "test", SESSION_A, false, { chatType: "p2p" })
    pushToFileQueue("b", "m2", "test", SESSION_B, false, { chatType: "group" })
    const sessions = getDistinctSessions()
    const keys = sessions.map((s) => s.sessionKey).sort()
    expect(keys).toEqual([SESSION_A, SESSION_B].sort())
  })

  it("deleteQueueMessage 删除指定文件且拒绝路径穿越", () => {
    pushToFileQueue("要删的", "m1", "test", SESSION_A)
    const [view] = getQueueMessages(SESSION_A)
    expect(deleteQueueMessage("../" + view.fileId, SESSION_A)).toBe(false)
    expect(deleteQueueMessage("not-qmsg.txt", SESSION_A)).toBe(false)
    expect(deleteQueueMessage(view.fileId, SESSION_A)).toBe(true)
    expect(getQueueLength(SESSION_A)).toBe(0)
  })

  it("deleteQueueMessagesByMessageId 按 messageId 删除 pending 与 claimed", () => {
    const msgId = "om_recall_test_001"
    pushToFileQueue("待撤回", msgId, "test", SESSION_A)
    claimSessionMessages(SESSION_A)
    expect(getQueueLength(SESSION_A)).toBe(1)
    const { removed, sessionKeys } = deleteQueueMessagesByMessageId(msgId)
    expect(removed).toBe(1)
    expect(sessionKeys).toEqual([SESSION_A])
    expect(getQueueLength(SESSION_A)).toBe(0)
  })
})
