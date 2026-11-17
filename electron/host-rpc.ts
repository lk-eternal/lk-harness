// 宿主侧：接 daemon 经标准输出发来的 `__HOST_RPC__:` 请求（协议见 src/shared/host-rpc.ts）。
// 先回 ack（证明宿主在、认得这一行），再分发给处理函数，最后回结果。依赖都从外面注入，不碰 Electron，方便测试。

import { HOST_RPC_PREFIX, parseHostRpcLine, type HostRpcReply } from "../src/shared/host-rpc.js"

export type HostRpcHandler = (payload: unknown) => unknown | Promise<unknown>

export interface HostRpcDispatcherDeps {
  /** 把回执发给 daemon（POST JSON） */
  post: (url: string, body: HostRpcReply) => Promise<unknown>
  /** 请求类型 → 处理函数 */
  handlers: Record<string, HostRpcHandler>
  warn?: (msg: string) => void
}

/**
 * 返回处理一行 daemon 输出的函数：不是宿主请求返回 false（调用方继续按别的标记处理）；
 * 是就返回 true（哪怕格式不对、没法回执，也已经消费掉了）。
 */
export function createHostRpcDispatcher(deps: HostRpcDispatcherDeps): (line: string, port: number | null | undefined) => Promise<boolean> {
  return async (line, port) => {
    if (!line.startsWith(HOST_RPC_PREFIX)) return false
    const req = parseHostRpcLine(line)
    if (!req) {
      deps.warn?.("宿主请求格式不对，已忽略")
      return true
    }
    if (!port) {
      // 没法回执：daemon 那边 ack 超时会自己报「主进程没有响应」，不会一直挂着
      deps.warn?.(`宿主请求 ${req.kind} 收到时 daemon 端口未知，没法回执`)
      return true
    }
    const url = `http://127.0.0.1:${port}/api/host-rpc`
    const reply = async (r: HostRpcReply) => {
      try {
        await deps.post(url, r)
      } catch (e) {
        deps.warn?.(`宿主请求 ${req.kind} 的回执没送到 daemon：${e instanceof Error ? e.message : String(e)}`)
      }
    }
    await reply({ id: req.id, phase: "ack" })
    const handler = Object.prototype.hasOwnProperty.call(deps.handlers, req.kind) ? deps.handlers[req.kind] : undefined
    if (!handler) {
      await reply({ id: req.id, phase: "done", ok: false, error: `应用主进程不认识这个请求：${req.kind}（应用版本可能比 daemon 旧）` })
      return true
    }
    try {
      const result = await handler(req.payload)
      await reply({ id: req.id, phase: "done", ok: true, result })
    } catch (e) {
      await reply({ id: req.id, phase: "done", ok: false, error: e instanceof Error ? e.message : String(e) })
    }
    return true
  }
}
