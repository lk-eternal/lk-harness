/**
 * 隔离 daemon：用独立的数据目录和随机端口起一个真实的 daemon 进程，供端到端测试走真实 HTTP 接口。
 *
 * 不碰用户自己正在运行的 daemon：APP_DATA_DIR 指向临时目录（锁文件也在里面），端口交给系统分配，
 * 通道只配一个「应用内」通道，没有任何外部凭据。
 */
import { spawn, type ChildProcess } from "node:child_process"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { fileURLToPath } from "node:url"

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..")

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

/** 聊天记录条目：只声明测试用到的字段 */
export interface ChatItem {
  id: string
  kind: string
  text?: string
  queued?: boolean
  interrupted?: boolean
  segments?: Array<{ type: string; text?: string }>
}

export interface IsolatedDaemon {
  base: string
  dataDir: string
  wsDir: string
  sessionKey: string
  post(p: string, body: unknown): Promise<any>
  get(p: string): Promise<any>
  /** 模拟 Agent 非阻塞领取这个会话的消息 */
  poll(): Promise<{ messages?: Array<{ text: string }> }>
  history(): Promise<ChatItem[]>
  users(): Promise<ChatItem[]>
  /** 暂存区里（标着排队）的用户消息文本 */
  queuedOf(): Promise<string[]>
  /** 流式卡动作（ensure / finish） */
  card(action: string, extra?: Record<string, unknown>): Promise<any>
  /** 在数据目录里递归找文件（路径是 daemon 内部决定的，测试不假设具体位置） */
  findFile(re: RegExp): string
  stop(): Promise<void>
}

export async function startIsolatedDaemon(): Promise<IsolatedDaemon> {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "lkh-e2e-"))
  const wsDir = path.join(dataDir, "ws-a")
  fs.mkdirSync(wsDir, { recursive: true })
  const sessionKey = `ch_test|app_main::${wsDir}`
  const channels = [{
    id: "ch_test", name: "测试", type: "app", enabled: true,
    mainUserEnabled: true, mainUserChatId: "app_main", workspaceDir: wsDir,
  }]

  const child: ChildProcess = spawn(
    process.execPath,
    [path.join(ROOT, "node_modules/tsx/dist/cli.mjs"), path.join(ROOT, "src/daemon-entry.ts")],
    {
      cwd: ROOT,
      env: {
        ...process.env,
        APP_DATA_DIR: dataDir,
        LARK_WORKSPACE_DIR: wsDir,
        CLAW_CHANNELS_JSON: JSON.stringify(channels),
        LARK_DAEMON_PORT: "0",
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  )
  let log = ""
  child.stdout?.on("data", (d) => { log += d })
  child.stderr?.on("data", (d) => { log += d })

  const stop = async () => {
    if (child.exitCode === null) {
      child.kill()
      await new Promise<void>((resolve) => {
        const t = setTimeout(resolve, 3000)
        child.once("exit", () => { clearTimeout(t); resolve() })
      })
    }
    // Windows 上进程刚退出时文件句柄可能还没释放
    fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
  }

  let port = 0
  const lock = path.join(dataDir, "daemon.lock.json")
  for (let i = 0; i < 160 && !port; i++) {
    if (child.exitCode !== null) break
    try { port = JSON.parse(fs.readFileSync(lock, "utf8")).port } catch { await sleep(250) }
  }
  if (!port) {
    await stop()
    throw new Error(`隔离 daemon 没有就绪（exit=${child.exitCode}）\n${log.slice(-2000)}`)
  }

  const base = `http://127.0.0.1:${port}`
  const post = async (p: string, body: unknown) =>
    (await fetch(base + p, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })).json()
  const get = async (p: string) => (await fetch(base + p)).json()
  const history = async (): Promise<ChatItem[]> => (await post("/api/app-chat/history", { sessionKey })).items
  const users = async () => (await history()).filter((i) => i.kind === "user")

  const findFile = (re: RegExp): string => {
    const walk = (dir: string): string => {
      for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, ent.name)
        if (ent.isDirectory()) { const hit = walk(full); if (hit) return hit } else if (re.test(ent.name)) return full
      }
      return ""
    }
    return walk(dataDir)
  }

  return {
    base, dataDir, wsDir, sessionKey, post, get, history, users, findFile, stop,
    poll: async () => (await fetch(`${base}/api/poll-message?sessionKey=${encodeURIComponent(sessionKey)}&wait=false`)).json(),
    queuedOf: async () => (await users()).filter((i) => i.queued).map((i) => i.text ?? ""),
    card: (action, extra = {}) =>
      post("/api/agent-stream-card", { session_key: sessionKey, action, segments: [{ type: "reply", text: "处理中" }], ...extra }),
  }
}

/** 轮询直到条件成立（落盘类断言用，不靠固定 sleep） */
export async function waitFor(cond: () => boolean | Promise<boolean>, timeoutMs = 8000, stepMs = 100): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await cond()) return true
    await sleep(stepMs)
  }
  return await cond()
}

export { sleep }
