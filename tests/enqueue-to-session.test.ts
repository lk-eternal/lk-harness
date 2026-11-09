import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import * as http from "node:http"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { LOCK_FILE_NAME } from "../src/shared/constants"

// daemon-client 顶部会导入 electron 和通道配置；这里只测它发给 daemon 的那条请求，两个依赖用桩顶掉
let userData = ""
vi.mock("electron", () => ({ app: { getPath: () => userData } }))
vi.mock("../electron/config-store", () => ({
  getChannel: vi.fn(),
  getEnabledChannels: vi.fn(() => []),
  effectiveWorkspaceDir: vi.fn(),
}))

import { enqueueToSession, triggerScheduledTaskViaDaemon } from "../electron/daemon-client"

/**
 * /enqueue 是 Electron 往 daemon 会话队列投消息的通用接口：
 * body 里的 model / modelParams / resourceId 是双方的约定，daemon 据此在会话里登记「用哪家供应商的哪个模型」。
 * （手动触发定时任务不再走这里，见下面的 triggerScheduledTaskViaDaemon。）
 */
describe("enqueueToSession：发给 daemon 的 /enqueue 请求", () => {
  let server: http.Server
  let bodies: Array<Record<string, unknown>>

  beforeEach(async () => {
    bodies = []
    userData = fs.mkdtempSync(path.join(os.tmpdir(), "enqueue-session-"))
    server = http.createServer((req, res) => {
      const chunks: Buffer[] = []
      req.on("data", (c: Buffer) => chunks.push(c))
      req.on("end", () => {
        if (req.method === "POST" && req.url === "/enqueue") bodies.push(JSON.parse(Buffer.concat(chunks).toString("utf8")))
        res.setHeader("content-type", "application/json")
        res.end(JSON.stringify({ ok: true }))
      })
    })
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r))
  })

  afterEach(async () => {
    await new Promise<void>((r) => server.close(() => r()))
    fs.rmSync(userData, { recursive: true, force: true })
  })

  const port = () => (server.address() as { port: number }).port

  it("带上任务选的供应商、模型和参数；字段叫 resourceId", async () => {
    const r = await enqueueToSession(port(), "task-1", "内容", "task", {
      channelId: "ch_a", model: "gpt-5", modelParams: "[1]", resourceId: "llm_b",
    })
    expect(r.ok).toBe(true)
    expect(bodies).toHaveLength(1)
    expect(bodies[0]).toMatchObject({
      sessionKey: "task-1", chatType: "task", channelId: "ch_a", model: "gpt-5", modelParams: "[1]", resourceId: "llm_b",
    })
  })

  it("没选供应商时请求里没有这个字段（daemon 据此取通道的）", async () => {
    await enqueueToSession(port(), "task-2", "内容", "task", { channelId: "ch_a", model: "composer-2" })
    expect(bodies).toHaveLength(1)
    expect("resourceId" in bodies[0]).toBe(false)
  })
})

/**
 * 手动触发定时任务（设置页「立即执行」、IM 的 /t run）：Electron 只告诉 daemon「触发哪个任务」，
 * 投到哪（独立会话 / 主会话 / 项目会话）、结果发到哪，全部由 daemon 按任务配置决定。
 * daemon 对「任务不存在 / 投不出去」回的是 200 + ok:false，客户端要把原因原样交给界面。
 */
describe("triggerScheduledTaskViaDaemon：手动触发请求", () => {
  let server: http.Server
  let seen: Array<{ method?: string; url?: string; body: Record<string, unknown> }>
  let reply: { status: number; body: unknown }

  beforeEach(async () => {
    seen = []
    reply = { status: 200, body: { ok: true } }
    server = http.createServer((req, res) => {
      const chunks: Buffer[] = []
      req.on("data", (c: Buffer) => chunks.push(c))
      req.on("end", () => {
        seen.push({ method: req.method, url: req.url, body: JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}") })
        res.statusCode = reply.status
        res.setHeader("content-type", "application/json")
        res.end(JSON.stringify(reply.body))
      })
    })
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r))
  })

  afterEach(async () => {
    await new Promise<void>((r) => server.close(() => r()))
  })

  const port = () => (server.address() as { port: number }).port

  it("POST /api/task-trigger，body 只带任务 id", async () => {
    const r = await triggerScheduledTaskViaDaemon(port(), "t-1")
    expect(r).toEqual({ ok: true })
    expect(seen).toEqual([{ method: "POST", url: "/api/task-trigger", body: { taskId: "t-1" } }])
  })

  it("daemon 说投不出去：把原因原样带回，不吞", async () => {
    reply = { status: 200, body: { ok: false, error: "项目「A」已暂停" } }
    expect(await triggerScheduledTaskViaDaemon(port(), "t-1")).toEqual({ ok: false, error: "项目「A」已暂停" })
  })

  it("daemon 回的失败没带原因：给个兜底说法，不是 undefined", async () => {
    reply = { status: 200, body: { ok: false } }
    const r = await triggerScheduledTaskViaDaemon(port(), "t-1")
    expect(r.ok).toBe(false)
    expect(r.error).toBeTruthy()
  })

  it("daemon 连不上：返回 ok:false 和错误信息，而不是抛出", async () => {
    const dead = port()
    await new Promise<void>((r) => server.close(() => r()))
    const r = await triggerScheduledTaskViaDaemon(dead, "t-1")
    expect(r.ok).toBe(false)
    expect(r.error).toBeTruthy()
    // afterEach 还会 close 一次：重新起一个占位，避免重复 close 报错
    server = http.createServer()
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  })
})
