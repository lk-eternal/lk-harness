import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import * as http from "node:http"
import * as os from "node:os"
import { releaseQueuedAppChatMessages } from "../electron/app-chat"

/**
 * 暂存区「立即发送」第一步：主进程让 Daemon 把排队的消息放进聊天流（releaseQueuedAppChatMessages）。
 * 真实的 electron/app-chat.ts，向假 Daemon 发真实 HTTP（记下收到了什么）；只有 electron 和通道配置、锁文件用桩顶掉。
 * Daemon 一侧的行为（放出几条、顺序、幂等）在 tests/e2e/app-chat-interrupt.e2e.test.ts 里用真 Daemon 验证。
 */

let port = 0
let channels: Array<Record<string, unknown>> = []
vi.mock("electron", () => ({
  app: { getPath: () => os.tmpdir(), getVersion: () => "0", isPackaged: false },
  BrowserWindow: { getAllWindows: () => [] },
  ipcMain: { handle: () => {}, on: () => {} },
  clipboard: {},
  dialog: {},
  nativeImage: {},
  shell: {},
  safeStorage: { isEncryptionAvailable: () => false },
}))
vi.mock("../electron/config-store", async (orig) => {
  const actual = await orig<typeof import("../electron/config-store")>()
  return { ...actual, getChannel: (id?: string) => channels.find((c) => c.id === id) }
})
vi.mock("../electron/daemon-client", async (orig) => {
  const actual = await orig<typeof import("../electron/daemon-client")>()
  return { ...actual, readLockFile: () => (port ? { pid: 1, port, version: "test" } : null) }
})

const APP_SESSION = "ch_app|app_main::D:/ws"
const FEISHU_SESSION = "ch_f|ou_main::D:/ws"

let server: http.Server
let hits: Array<{ url?: string; body: unknown }>

beforeEach(async () => {
  channels = [
    { id: "ch_app", name: "应用内", type: "app", enabled: true },
    { id: "ch_f", name: "飞书", type: "feishu", enabled: true },
  ]
  hits = []
  server = http.createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on("data", (c: Buffer) => chunks.push(c))
    req.on("end", () => {
      hits.push({ url: req.url, body: JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}") })
      res.setHeader("content-type", "application/json")
      res.end(JSON.stringify({ ok: true, released: 2 }))
    })
  })
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r))
  port = (server.address() as { port: number }).port
})

afterEach(async () => {
  port = 0
  await new Promise<void>((r) => server.close(() => r()))
})

describe("releaseQueuedAppChatMessages", () => {
  it("应用内对话的会话：让 Daemon 放出排队的消息，带上会话 key，结果原样返回", async () => {
    const r = await releaseQueuedAppChatMessages(APP_SESSION)
    expect(hits).toEqual([{ url: "/api/app-chat/queue-release", body: { sessionKey: APP_SESSION } }])
    expect(r).toEqual(expect.objectContaining({ ok: true, released: 2 }))
  })

  it("飞书会话（没有暂存区）：不发请求，当没事发生", async () => {
    expect(await releaseQueuedAppChatMessages(FEISHU_SESSION)).toEqual({ ok: true })
    expect(hits).toEqual([])
  })

  it("通道已经不存在（被删了）：同样不发请求", async () => {
    channels = []
    expect(await releaseQueuedAppChatMessages(APP_SESSION)).toEqual({ ok: true })
    expect(hits).toEqual([])
  })

  it("Daemon 没起：返回失败，不抛错（调用方只记警告，照常打断）", async () => {
    port = 0
    const r = await releaseQueuedAppChatMessages(APP_SESSION)
    expect(r.ok).toBe(false)
    expect(hits).toEqual([])
  })
})
