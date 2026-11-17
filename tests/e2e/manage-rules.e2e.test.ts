/**
 * 端到端（真实 daemon 进程）：AI 通过 manage_rules 管理 Harness 规则。
 *
 * 修过的问题：save 新建的规则只写了文件、没有登记到规则清单——返回「saved」，
 * 但 list 看不到、read 报 not found、提示词里也不会带上，规则永远不生效。
 *
 * 走的是真实的 MCP 工具（/mcp-admin），和 AI 实际调用的路径一致。
 * 用 `npm run test:e2e` 运行；不在默认的 `npm test` 里。
 */
import * as fs from "node:fs"
import * as path from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { startIsolatedDaemon, type IsolatedDaemon } from "../helpers/isolated-daemon"

let d: IsolatedDaemon

beforeEach(async () => { d = await startIsolatedDaemon() })
afterEach(async () => { await d?.stop() })

const rulesDir = () => path.join(d.dataDir, "harness-rules")

/** 调 MCP 工具（无状态 streamable HTTP，直接发 JSON-RPC） */
async function mcp(tool: string, args: Record<string, unknown>): Promise<string> {
  const res = await fetch(`${d.base}/mcp-admin`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", "X-Harness-Session-Key": d.sessionKey },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: tool, arguments: args } }),
  })
  const raw = await res.text()
  const line = raw.split("\n").find((l) => l.startsWith("data:"))
  const payload = JSON.parse(line ? line.slice(5).trim() : raw)
  if (payload.error) throw new Error(`MCP 错误: ${JSON.stringify(payload.error)}`)
  return (payload.result.content as Array<{ text: string }>).map((c) => c.text).join("\n")
}
const manageRules = (args: Record<string, unknown>) => mcp("manage_rules", args)

describe("manage_rules：保存 → 列出 → 读取 → 删除", () => {
  it("新建的规则：list 能看到，read 读得回来", async () => {
    expect(await manageRules({ action: "save", name: "更新日志写法.mdc", content: "## 写法\n- 短\n" })).toContain("saved")

    expect(await manageRules({ action: "list" })).toContain("更新日志写法.mdc")
    expect(await manageRules({ action: "read", name: "更新日志写法.mdc" })).toContain("## 写法")
    expect(fs.existsSync(path.join(rulesDir(), "更新日志写法.mdc"))).toBe(true)
  })

  it("不带扩展名也行，和带扩展名是同一条", async () => {
    await manageRules({ action: "save", name: "无扩展名", content: "a" })
    expect(await manageRules({ action: "read", name: "无扩展名.mdc" })).toContain("a")
    expect(await manageRules({ action: "list" })).toContain("无扩展名.mdc")
  })

  it("同名再保存是更新：list 里只有一条，内容是新的", async () => {
    await manageRules({ action: "save", name: "r1.mdc", content: "v1" })
    await manageRules({ action: "save", name: "r1.mdc", content: "v2" })

    const lines = (await manageRules({ action: "list" })).split("\n").filter((l) => l.includes("r1.mdc"))
    expect(lines).toHaveLength(1)
    expect(await manageRules({ action: "read", name: "r1.mdc" })).toContain("v2")
  })

  it("磁盘上留着没登记的旧文件（孤儿）：保存同名规则后它生效", async () => {
    fs.mkdirSync(rulesDir(), { recursive: true })
    fs.writeFileSync(path.join(rulesDir(), "孤儿.mdc"), "旧内容\n")
    expect(await manageRules({ action: "list" })).not.toContain("孤儿.mdc")

    await manageRules({ action: "save", name: "孤儿.mdc", content: "新内容" })

    expect(await manageRules({ action: "list" })).toContain("孤儿.mdc")
    expect(await manageRules({ action: "read", name: "孤儿.mdc" })).toContain("新内容")
  })

  it("删除后 list 里没有，文件也删了", async () => {
    await manageRules({ action: "save", name: "tmp.mdc", content: "x" })
    expect(await manageRules({ action: "list" })).toContain("tmp.mdc") // 先确认真的登记过，否则下面的「没有」是白过
    expect(await manageRules({ action: "delete", name: "tmp.mdc" })).toContain("deleted")

    expect(await manageRules({ action: "list" })).not.toContain("tmp.mdc")
    expect(fs.existsSync(path.join(rulesDir(), "tmp.mdc"))).toBe(false)
  })
})
