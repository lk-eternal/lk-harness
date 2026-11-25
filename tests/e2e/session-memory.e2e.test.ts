/**
 * 端到端（真实 daemon 进程）：会话记忆工具（/mcp-memory）。
 *
 * daemon 写、Electron 读，是两个进程各自按数据目录读写同一个 memory.json；
 * 这里用真实 daemon 和真实 MCP 请求（身份走和真实 Agent 一样的请求头），再由测试进程用 Electron 那边的读法把它读回来，
 * 确认两边认的是同一个会话文件。
 * 用 `npm run test:e2e` 运行；不在默认的 `npm test` 里。
 */
import * as fs from "node:fs"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { readSessionMemory, saveSessionMemory } from "../../src/shared/session-memory"
import { sessionMemoryPath } from "../../src/shared/session-entry-paths"
import { startIsolatedDaemon, type IsolatedDaemon } from "../helpers/isolated-daemon"

let d: IsolatedDaemon

beforeEach(async () => { d = await startIsolatedDaemon() })
afterEach(async () => { await d?.stop() })

async function rpc(invoker: string | undefined, method: string, params: Record<string, unknown> = {}): Promise<any> {
  const res = await fetch(`${d.base}/mcp-memory`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      ...(invoker ? { "X-Harness-Session-Key": invoker } : {}),
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  })
  const raw = await res.text()
  const line = raw.split("\n").find((l) => l.startsWith("data:"))
  const payload = JSON.parse(line ? line.slice(5).trim() : raw)
  if (payload.error) throw new Error(`MCP 错误: ${JSON.stringify(payload.error)}`)
  return payload.result
}

const call = async (invoker: string | undefined, tool: string, args: Record<string, unknown> = {}): Promise<string> => {
  const r = await rpc(invoker, "tools/call", { name: tool, arguments: args })
  return (r.content as Array<{ text: string }>).map((c) => c.text).join("\n")
}

describe("会话记忆工具（/mcp-memory）", () => {
  it("暴露 memory_save / memory_read / memory_delete 三个工具", async () => {
    const r = await rpc(d.sessionKey, "tools/list")
    expect((r.tools as Array<{ name: string }>).map((t) => t.name).sort()).toEqual(["memory_delete", "memory_read", "memory_save"])
  })

  it("记 → 读 → 覆盖 → 删：落在调用者会话的 memory.json，Electron 的读法能读到", async () => {
    expect(await call(d.sessionKey, "memory_read")).toBe("当前会话还没有记忆")

    expect(await call(d.sessionKey, "memory_save", { key: "部署约束", content: "只能周三发布" })).toContain("已记下「部署约束」（共 1/20 条）")
    expect(readSessionMemory(d.dataDir, d.sessionKey)).toMatchObject([{ key: "部署约束", content: "只能周三发布" }])
    expect(fs.existsSync(sessionMemoryPath(d.dataDir, d.sessionKey))).toBe(true)

    expect(await call(d.sessionKey, "memory_save", { key: "部署约束", content: "周三和周五" })).toContain("已更新「部署约束」")
    expect(await call(d.sessionKey, "memory_read")).toMatch(/<item key="部署约束" created="[\d-]+ [\d:]+" updated="[\d-]+ [\d:]+">周三和周五<\/item>/)

    expect(await call(d.sessionKey, "memory_delete", { key: "部署约束" })).toContain("还剩 0 条")
    expect(readSessionMemory(d.dataDir, d.sessionKey)).toEqual([])
  })

  it("Electron 一侧先写的记忆，daemon 的 memory_read 也读得到（两边认同一个文件）", async () => {
    saveSessionMemory(d.dataDir, d.sessionKey, "来自另一边", "内容")
    expect(await call(d.sessionKey, "memory_read")).toContain('<item key="来自另一边"')
  })

  it("记忆属于调用者的会话：别的会话看不到、也动不了", async () => {
    const other = `ch_test|app_main::${d.dataDir}\\elsewhere`
    await call(d.sessionKey, "memory_save", { key: "a", content: "1" })
    expect(await call(other, "memory_read")).toBe("当前会话还没有记忆")
    expect(await call(other, "memory_delete", { key: "a" })).toContain("[memory_failed]")
    expect(readSessionMemory(d.dataDir, d.sessionKey)).toMatchObject([{ key: "a", content: "1" }])
  })

  it("没有调用者会话头：拒绝读写，不会写到哪个会话里去", async () => {
    expect(await call(undefined, "memory_save", { key: "a", content: "1" })).toContain("[memory_failed] 没有识别到调用者所在的会话")
    expect(await call(undefined, "memory_read")).toContain("[memory_failed]")
    expect(fs.existsSync(sessionMemoryPath(d.dataDir, d.sessionKey))).toBe(false)
  })

  it("超长、满了：把原因交给 AI，不写入", async () => {
    expect(await call(d.sessionKey, "memory_save", { key: "k", content: "字".repeat(501) })).toContain("[memory_failed] 内容太长")
    for (let i = 0; i < 20; i++) await call(d.sessionKey, "memory_save", { key: `k${i}`, content: "v" })
    const full = await call(d.sessionKey, "memory_save", { key: "新的", content: "v" })
    expect(full).toContain("[memory_failed]")
    expect(full).toContain("memory_delete")
    expect(readSessionMemory(d.dataDir, d.sessionKey)).toHaveLength(20)
  })
})
