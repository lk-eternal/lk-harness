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

import { enqueueToSession } from "../electron/daemon-client"

/**
 * 手动触发定时任务（界面「立即执行」、飞书 /task 指令）经 /enqueue 入队：
 * body 里的 model / modelParams / resourceId 是 Electron 和 daemon 之间的约定，
 * daemon 据此在任务会话里登记「用哪家供应商的哪个模型」。任务自己选了供应商却没带过去，登记的就还是通道的那一家。
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
