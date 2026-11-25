/**
 * 端到端（真实 daemon 进程）：内置 MCP 认「调用者是哪个会话」的请求头。
 *
 * 会话键里的目录可以是中文（如 `::D:\workspace\排查`），HTTP 头只能放 Latin-1，原样放进去客户端会直接拒发，
 * 那个会话的 lk-harness 内置 MCP 就全部连不上。所以头里放的是编码后的会话键，daemon 读到后还原。
 *
 * 这里不手写请求头，而是用挂载配置（buildBuiltinMcpServers）生成的地址和请求头去打真实 daemon，和真实 Agent 发出的请求一致；
 * 再用 Electron 一侧的读法把记忆读回来，确认 daemon 还原出的就是原来的会话键。
 * 用 `npm run test:e2e` 运行；不在默认的 `npm test` 里。
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { buildBuiltinMcpServers, MEMORY_MCP_KEY } from "../../src/shared/harness-mcp-store"
import { readSessionMemory } from "../../src/shared/session-memory"
import { startIsolatedDaemon, type IsolatedDaemon } from "../helpers/isolated-daemon"

let d: IsolatedDaemon

beforeEach(async () => { d = await startIsolatedDaemon() })
afterEach(async () => { await d?.stop() })

async function memorySaveAsAgent(sessionKey: string, key: string, content: string): Promise<string> {
  const port = Number(new URL(d.base).port)
  const entry = buildBuiltinMcpServers(port, false, "interactive", false, sessionKey)[MEMORY_MCP_KEY] as {
    url: string
    headers: Record<string, string>
  }
  const res = await fetch(entry.url, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", ...entry.headers },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "memory_save", arguments: { key, content } } }),
  })
  const raw = await res.text()
  const line = raw.split("\n").find((l) => l.startsWith("data:"))
  const payload = JSON.parse(line ? line.slice(5).trim() : raw)
  if (payload.error) throw new Error(`MCP 错误: ${JSON.stringify(payload.error)}`)
  return (payload.result.content as Array<{ text: string }>).map((c) => c.text).join("\n")
}

describe("内置 MCP 的调用者会话头", () => {
  it("会话键里有中文目录：请求能发出去，记忆落在原来的会话键下", async () => {
    const sessionKey = "ch_test|oc_p2p::D:\\workspace\\排查"
    expect(await memorySaveAsAgent(sessionKey, "巡检", "每天 8:40 和 17:40")).toContain("已记下「巡检」")
    expect(readSessionMemory(d.dataDir, sessionKey)).toMatchObject([{ key: "巡检", content: "每天 8:40 和 17:40" }])
  })

  it("会话键里有 % 和空格：编码后原样还原，不会被当成转义", async () => {
    const sessionKey = "ch_test|oc_p2p::D:\\workspace\\100% 完成 %E6%8E%92"
    expect(await memorySaveAsAgent(sessionKey, "k", "v")).toContain("已记下「k」")
    expect(readSessionMemory(d.dataDir, sessionKey)).toMatchObject([{ key: "k", content: "v" }])
  })
})
