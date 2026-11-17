// daemon → 宿主（Electron 主进程）的「发请求、等结果」通道。
//
// 为什么需要它：daemon 是宿主起的子进程，碰不到 Electron 的 app / 配置库；而有些事（比如建项目）只能宿主做，
// AI 还得知道做成了没有。现有的 `__XXX__:` 标准输出标记都是单向通知，没有结果可回。
//
// 协议（三步，都是一行 JSON）：
//   1. daemon 往标准输出写 `__HOST_RPC__:{"id","kind","payload"}`；
//   2. 宿主收到后立刻 POST /api/host-rpc `{id, phase:"ack"}`（证明宿主在、认得这一行）；
//   3. 宿主做完 POST /api/host-rpc `{id, phase:"done", ok, result | error}`。
// ack 单独拎出来，是为了宿主没在运行（单独起 daemon、版本不匹配）时几秒内就报错，而不是白等到整体超时。

export const HOST_RPC_PREFIX = "__HOST_RPC__:"

/** 宿主多久没回 ack 就当它不在 */
export const HOST_RPC_ACK_TIMEOUT_MS = 5_000

export type HostRpcOutcome<T = unknown> = { ok: true; result: T } | { ok: false; error: string }

/** 宿主回给 daemon 的消息（POST /api/host-rpc 的请求体） */
export type HostRpcReply =
  | { id: string; phase: "ack" }
  | { id: string; phase: "done"; ok: true; result?: unknown }
  | { id: string; phase: "done"; ok: false; error?: string }

export interface HostRpc {
  /** 发一个请求并等结果。不会抛错：宿主没响应、超时、宿主报错都当 { ok: false } 返回 */
  request<T = unknown>(kind: string, payload: unknown, timeoutMs: number): Promise<HostRpcOutcome<T>>
  /** 收到宿主的回执。返回这个 id 是不是还在等（已超时或根本不认识的返回 false，调用方忽略即可） */
  settle(reply: unknown): boolean
  /** 还在等的请求数（测试和诊断用） */
  pendingCount(): number
}

export interface HostRpcOptions {
  /** 把一行交给宿主；生产环境就是写标准输出 */
  send: (line: string) => void
  ackTimeoutMs?: number
  newId?: () => string
}

interface Pending {
  acked: boolean
  finish: (o: HostRpcOutcome) => void
  ackTimer: ReturnType<typeof setTimeout>
  doneTimer: ReturnType<typeof setTimeout>
}

let seq = 0
function defaultId(): string {
  seq += 1
  return `rpc_${Date.now().toString(36)}_${seq}_${Math.random().toString(36).slice(2, 8)}`
}

export function createHostRpc(opts: HostRpcOptions): HostRpc {
  const pending = new Map<string, Pending>()
  const ackTimeoutMs = opts.ackTimeoutMs ?? HOST_RPC_ACK_TIMEOUT_MS
  const newId = opts.newId ?? defaultId

  return {
    request<T>(kind: string, payload: unknown, timeoutMs: number): Promise<HostRpcOutcome<T>> {
      const id = newId()
      return new Promise<HostRpcOutcome<T>>((resolve) => {
        const finish = (o: HostRpcOutcome) => {
          const p = pending.get(id)
          if (!p) return
          pending.delete(id)
          clearTimeout(p.ackTimer)
          clearTimeout(p.doneTimer)
          resolve(o as HostRpcOutcome<T>)
        }
        const ackTimer = setTimeout(
          () => finish({ ok: false, error: "应用主进程没有响应（应用没在运行，或版本不匹配），这件事没有执行" }),
          ackTimeoutMs,
        )
        // 超时后事情可能还在宿主那边做（比如克隆大仓库），所以话要说清楚：结果未知，先查再决定要不要重试
        const doneTimer = setTimeout(
          () => finish({ ok: false, error: `等了 ${Math.round(timeoutMs / 1000)} 秒还没有结果，操作可能仍在进行；请先用 list 确认有没有成功，不要直接重试` }),
          timeoutMs,
        )
        pending.set(id, { acked: false, finish, ackTimer, doneTimer })
        try {
          opts.send(`${HOST_RPC_PREFIX}${JSON.stringify({ id, kind, payload })}`)
        } catch (e) {
          finish({ ok: false, error: `无法把请求交给应用主进程：${e instanceof Error ? e.message : String(e)}` })
        }
      })
    },

    settle(reply: unknown): boolean {
      const r = (reply && typeof reply === "object" ? reply : {}) as Record<string, unknown>
      const id = typeof r.id === "string" ? r.id : ""
      const p = id ? pending.get(id) : undefined
      if (!p) return false
      if (r.phase === "ack") {
        if (!p.acked) {
          p.acked = true
          clearTimeout(p.ackTimer)
        }
        return true
      }
      if (r.phase === "done") {
        if (r.ok === true) p.finish({ ok: true, result: r.result })
        else p.finish({ ok: false, error: typeof r.error === "string" && r.error ? r.error : "操作失败" })
        return true
      }
      return false
    },

    pendingCount: () => pending.size,
  }
}

let shared: HostRpc | undefined

/** daemon 进程里共用的那一个：请求写标准输出，由宿主的子进程输出解析器接走 */
export function getHostRpc(): HostRpc {
  shared ??= createHostRpc({ send: (line) => { process.stdout.write(line + "\n") } })
  return shared
}

/** 宿主侧解析标准输出里的一行；不是请求（或格式不对）返回 null */
export function parseHostRpcLine(line: string): { id: string; kind: string; payload: unknown } | null {
  if (!line.startsWith(HOST_RPC_PREFIX)) return null
  try {
    const o = JSON.parse(line.slice(HOST_RPC_PREFIX.length)) as Record<string, unknown>
    if (typeof o.id !== "string" || !o.id || typeof o.kind !== "string" || !o.kind) return null
    return { id: o.id, kind: o.kind, payload: o.payload }
  } catch {
    return null
  }
}
