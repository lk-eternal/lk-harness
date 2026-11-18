import { describe, it, expect } from "vitest"
import * as fs from "node:fs"
import * as path from "node:path"

/**
 * 「重置」的几个入口有没有真的走统一的 resetSessionConversation（流程本身的行为由 reset-session.test.ts 锁住）：
 * 任何一个入口各自拼「停止 + 清上下文」，就会留下已投递给旧 Agent 的消息，被调度器当成掉线重投，重置本身也被重投。
 */

const read = (...p: string[]) => fs.readFileSync(path.resolve(__dirname, "..", ...p), "utf8").replace(/\r\n/g, "\n")
const dispatcherSrc = read("electron", "session-dispatcher.ts")
const managerSrc = read("electron", "daemon-manager.ts")
const sessionManagerSrc = read("electron", "session-manager.ts")

/** 从 startMarker 开始，到下一个同级 case / 函数结尾为止 */
function sliceFrom(src: string, startMarker: string, endMarker: string): string {
  const start = src.indexOf(startMarker)
  expect(start, `找不到 ${startMarker}`).toBeGreaterThan(-1)
  const end = src.indexOf(endMarker, start + startMarker.length)
  expect(end, `${startMarker} 之后找不到 ${endMarker}`).toBeGreaterThan(start)
  return src.slice(start, end)
}

describe("resetSessionConversation 的真实接线", () => {
  it("队列读写、停 Agent、清上下文用的都是调度器里真实的那几个", () => {
    const body = sliceFrom(dispatcherSrc, "export function resetSessionConversation(", "\n}\n")
    expect(body).toContain("resetSessionFlow(sessionKey, {")
    expect(body).toMatch(/getQueue:\s*getQueueMessages\b/)
    expect(body).toMatch(/deleteMessage:\s*deleteQueueMessage\b/)
    expect(body).toMatch(/normalizeKey:\s*normalizeSessionKey\b/)
    expect(body).toMatch(/isRunning:\s*isSessionAgentRunning\b/)
    expect(body).toMatch(/stopAgent:\s*stopSessionAgent\b/)
    expect(body).toMatch(/resetContext:\s*resetAllSessionContext\b/)
  })
})

describe("重置入口", () => {
  it("/reset 指令（飞书、应用内、AI 的 manage_agent reset 都走它）：走统一的重置，不再自己停 Agent、清上下文", () => {
    const body = sliceFrom(managerSrc, 'case "/reset": {', 'case "/w":')
    expect(body).toMatch(/await resetSessionConversation\(sessionKey\)/)
    expect(body).not.toContain("stopSessionAgent")
    expect(body).not.toContain("resetAllSessionContext")
  })

  it("会话管理页的「重置」：同一条路", () => {
    const body = sliceFrom(sessionManagerSrc, "export async function resetManagedSession(", "\n}\n")
    expect(body).toMatch(/await resetSessionConversation\(found\.session\.sessionKey\)/)
    expect(body).not.toContain("stopSessionAgent")
    expect(body).not.toContain("resetAllSessionContext")
  })
})
