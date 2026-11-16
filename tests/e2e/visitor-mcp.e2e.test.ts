/**
 * 端到端（真实 daemon 进程）：访客专用的内置 MCP 端点 /mcp-visitor 只暴露 send_question。
 *
 * 单测只能验证「注册函数在 visitor 模式下少注册了什么」；这里用真实 HTTP 请求确认
 * daemon 的路由确实把 /mcp-visitor 接到了访客那一份，而不是别的端点——
 * send_image / send_file 能发本机任意路径的文件，访客端点上绝不能有。
 * 用 `npm run test:e2e` 运行；不在默认的 `npm test` 里。
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { startIsolatedDaemon, type IsolatedDaemon } from "../helpers/isolated-daemon"

let d: IsolatedDaemon
beforeEach(async () => { d = await startIsolatedDaemon() })
afterEach(async () => { await d?.stop() })

async function rpc(endpoint: string, method: string, params: Record<string, unknown> = {}): Promise<any> {
  const res = await fetch(d.base + endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      "X-Harness-Session-Key": d.sessionKey,
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  })
  const raw = await res.text()
  const line = raw.split("\n").find((l) => l.startsWith("data:"))
  return JSON.parse(line ? line.slice(5).trim() : raw)
}

const toolNames = async (endpoint: string): Promise<string[]> => {
  const r = await rpc(endpoint, "tools/list")
  return (r.result.tools as Array<{ name: string }>).map((t) => t.name).sort()
}

describe("/mcp-visitor（其他人的受限会话）", () => {
  it("只有 send_question；没有发图 / 发文件 / 分支 diff", async () => {
    expect(await toolNames("/mcp-visitor")).toEqual(["send_question"])
  })

  it("对照：交互端点（主人会话）有发图 / 发文件，说明上面的「没有」是访客端点专有的限制", async () => {
    const names = await toolNames("/mcp-interactive")
    expect(names).toEqual(expect.arrayContaining(["send_question", "send_image", "send_file"]))
  })

  it("直接调访客端点上的 send_file：工具不存在，不会去读任何本机路径", async () => {
    const r = await rpc("/mcp-visitor", "tools/call", { name: "send_file", arguments: { path: "C:\\Windows\\win.ini" } })
    expect(r.result.isError).toBe(true)
    expect(r.result.content[0].text).toContain("Tool send_file not found")
  })
})
