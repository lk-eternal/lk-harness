import * as http from "node:http"

/** 测试用的本地 HTTP 服务：支持 Range，并能按计划掐断、挂住、回错误码，用来模拟被墙/被重置的下载 */

/** 这一次连接怎么处理：正常发完 / 发一部分后掐断 / 发一部分后挂住不动 / 直接回某个状态码 */
export type Plan =
  | { kind: "ok" }
  | { kind: "drop"; afterBytes: number }
  | { kind: "stall"; afterBytes: number }
  | { kind: "status"; code: number }

export interface TestServer {
  url: string
  /** 每次请求带的 Range 头，按到达顺序 */
  requests: { range: string | null }[]
  close(): Promise<void>
}

export async function startServer(
  payload: Buffer,
  plan: (n: number) => Plan,
  opts: { supportsRange?: boolean; fileName?: string } = {},
): Promise<TestServer> {
  const supportsRange = opts.supportsRange ?? true
  const requests: { range: string | null }[] = []
  const server = http.createServer((req, res) => {
    const n = requests.length
    const range = typeof req.headers.range === "string" ? req.headers.range : null
    requests.push({ range })
    const p = plan(n)
    if (p.kind === "status") {
      res.writeHead(p.code)
      res.end("x")
      return
    }
    const m = supportsRange && range ? /^bytes=(\d+)-$/.exec(range) : null
    const start = m ? Number(m[1]) : 0
    if (start >= payload.length) {
      res.writeHead(416, { "Content-Range": `bytes */${payload.length}` })
      res.end()
      return
    }
    const body = payload.subarray(start)
    if (m) {
      res.writeHead(206, {
        "Content-Length": body.length,
        "Content-Range": `bytes ${start}-${payload.length - 1}/${payload.length}`,
      })
    } else {
      res.writeHead(200, { "Content-Length": body.length })
    }
    res.flushHeaders()
    const limit = p.kind === "ok" ? body.length : Math.min(p.afterBytes, body.length)
    let sent = 0
    const pump = () => {
      while (sent < limit) {
        const end = Math.min(sent + 16 * 1024, limit)
        const ok = res.write(body.subarray(sent, end))
        sent = end
        if (!ok) {
          res.once("drain", pump)
          return
        }
      }
      if (p.kind === "ok") res.end()
      // drop：留一点时间让已写的数据发出去，再掐断连接；stall：什么也不做，连接一直挂着
      else if (p.kind === "drop") setTimeout(() => res.socket?.destroy(), 30)
    }
    pump()
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const { port } = server.address() as { port: number }
  return {
    url: `http://127.0.0.1:${port}/${opts.fileName ?? "lk-harness-setup-9.9.9.exe"}`,
    requests,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections()
        server.close(() => resolve())
      }),
  }
}
