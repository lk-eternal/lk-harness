import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import * as fs from "node:fs"
import * as http from "node:http"
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

import { notifySessionLaunched } from "../electron/daemon-client"

/**
 * 拉起会话后通知 daemon：除了「是否续接 / 哪个运行时」，还要带上这次用的模型显示名（model_label）。
 * daemon 用它给独立定时任务的飞书卡片补页脚；字段名是 Electron 和 daemon 之间的约定，两边改一边就对不上。
 */
describe("notifySessionLaunched", () => {
  let server: http.Server
  let bodies: Array<Record<string, unknown>>

  beforeEach(async () => {
    bodies = []
    userData = fs.mkdtempSync(path.join(os.tmpdir(), "notify-launched-"))
    server = http.createServer((req, res) => {
      const chunks: Buffer[] = []
      req.on("data", (c: Buffer) => chunks.push(c))
      req.on("end", () => {
        if (req.method === "POST" && req.url === "/api/session-launched") bodies.push(JSON.parse(Buffer.concat(chunks).toString("utf8")))
        res.setHeader("content-type", "application/json")
        res.end(JSON.stringify({ ok: true }))
      })
    })
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r))
    const { port } = server.address() as { port: number }
    fs.writeFileSync(path.join(userData, LOCK_FILE_NAME), JSON.stringify({ pid: 1, port, version: "test" }))
  })

  afterEach(async () => {
    await new Promise<void>((r) => server.close(() => r()))
    fs.rmSync(userData, { recursive: true, force: true })
  })

  it("带上模型显示名：字段叫 model_label", async () => {
    await notifySessionLaunched("task-1", { resumed: false, runtime: "sdk", modelLabel: "composer-2.5-fast" })
    expect(bodies).toEqual([{ session_key: "task-1", resumed: false, runtime: "sdk", model_label: "composer-2.5-fast" }])
  })

  it("llm 运行时、续接的会话同样带上", async () => {
    await notifySessionLaunched("task-2", { resumed: true, runtime: "llm", modelLabel: "claude-sonnet-5-5 · high" })
    expect(bodies[0]).toMatchObject({ session_key: "task-2", resumed: true, runtime: "llm", model_label: "claude-sonnet-5-5 · high" })
  })

  it("没有模型显示名时请求里没有这个字段（daemon 据此清掉上一次登记的）", async () => {
    await notifySessionLaunched("task-3", { resumed: false, runtime: "sdk" })
    expect(bodies).toHaveLength(1)
    expect("model_label" in bodies[0]).toBe(false)
  })

  it("daemon 没在运行（没有锁文件）：静默返回，不发请求也不抛错", async () => {
    fs.rmSync(path.join(userData, LOCK_FILE_NAME))
    await expect(notifySessionLaunched("task-4", { runtime: "sdk", modelLabel: "m" })).resolves.toBeUndefined()
    expect(bodies).toEqual([])
  })
})
