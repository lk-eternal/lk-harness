import * as fs from "node:fs"
import * as path from "node:path"
import { app } from "electron"
import { getConfig } from "./config-store"
import { broadcastLog } from "./ui-logger"
import { buildBuiltinMcpServers } from "../src/shared/claw-mcp-store.js"

export interface InjectResult {
  file: string
  action: "created" | "updated" | "skipped"
  message: string
}

let daemonPort: number | null = null

function norm(p: string): string { return path.resolve(p) }

export function setDaemonPort(port: number | null): void {
  if (daemonPort === port) return
  daemonPort = port
}

export function getDaemonPort(): number | null {
  return daemonPort
}

export function clearInjectionCache(_dir?: string): void {
  /* no-op：已退役 workspace 注入缓存 */
}

export function getTemplateRoot(): string {
  if (app.isPackaged) return path.join(process.resourcesPath, "template")
  return path.join(app.getAppPath(), "resources", "template")
}

export function getRuleTemplatePath(): string {
  return path.join(getTemplateRoot(), "rule", "lk-harness.mdc")
}

const ADMIN_SKILL_DIR = "lk-harness-admin"

/** 清理项目里残留的自管理 skill 目录（已改 prompt inline，不再注入） */
function cleanupStaleAdminSkill(wsDir: string): void {
  const stale = path.join(wsDir, ".cursor", "skills", ADMIN_SKILL_DIR)
  if (!fs.existsSync(stale)) return
  try {
    fs.rmSync(stale, { recursive: true, force: true })
    broadcastLog(`已清理残留自管理 Skill: ${stale}`)
  } catch { /* ignore */ }
}

function mergeProjectMcpFile(filePath: string, servers: Record<string, unknown>): void {
  let mcpConfig: Record<string, unknown> = {}
  if (fs.existsSync(filePath)) {
    try { mcpConfig = JSON.parse(fs.readFileSync(filePath, "utf-8")) } catch { mcpConfig = {} }
  }
  const existing = (mcpConfig.mcpServers ?? {}) as Record<string, unknown>
  Object.assign(existing, servers)
  mcpConfig.mcpServers = existing
  const dir = path.dirname(filePath)
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(filePath, JSON.stringify(mcpConfig, null, 2), "utf-8")
}

/** CLI 专用：仅向项目 `.cursor/mcp.json` merge 内置 MCP，不碰全局、不删用户条目 */
export function injectCliMcpToProjectDir(wsDir: string, includeAdmin: boolean): boolean {
  if (!daemonPort || !wsDir.trim()) return false
  try {
    const servers = buildBuiltinMcpServers(daemonPort, includeAdmin)
    if (!Object.keys(servers).length) return false
    mergeProjectMcpFile(path.join(wsDir, ".cursor", "mcp.json"), servers)
    broadcastLog(`CLI MCP 已注入项目目录: ${wsDir}`)
    return true
  } catch (e: unknown) {
    broadcastLog(`CLI MCP 项目注入失败: ${e instanceof Error ? e.message : e}`, "ERROR")
    return false
  }
}

export async function injectWorkspaceToDir(
  dir: string,
  _skipIdentity = false,
  _identityOverride?: string,
  _skipAdmin = false,
): Promise<boolean> {
  if (!dir.trim() || !fs.existsSync(dir)) return false
  cleanupStaleAdminSkill(dir)
  return true
}

export async function injectWorkspaceMcpAndRules(): Promise<{ mcpOk: boolean; ruleOk: boolean; skillOk: boolean }> {
  const dirs = [...new Set(
    (getConfig().channels ?? [])
      .map((c) => c.workspaceDir?.trim())
      .filter((w): w is string => !!w && fs.existsSync(w)),
  )]
  for (const dir of dirs) cleanupStaleAdminSkill(dir)
  return { mcpOk: true, ruleOk: true, skillOk: false }
}

export const ADMIN_SKILL_CONTENT = `# LK Harness — 自管理 Skill

你可以通过以下 MCP 工具管理 LK Harness 应用自身的运行状态、配置和环境。

## 可用 MCP 工具

### manage_agent
管理 Agent 生命周期。
| action | 说明 |
|--------|------|
| status | 查询运行状态 |
| stop | 停止 Agent |
| restart | 重启应用 |
| reset | 重置会话 |
| clean | 清空消息队列 |

### manage_mcp
管理 MCP 服务器配置（list / add / delete）。

### manage_rules
管理 Cursor Rules 文件（list / read / save / delete）。

### manage_skills
管理 Agent Skills（list / read / save / delete）。

### manage_tasks
管理定时任务（list / add / update / delete / toggle）。

### manage_workspace
管理工作目录（get / set）。
`

export async function injectWorkspace(): Promise<{ results: InjectResult[] }> {
  const dirs = [...new Set(
    (getConfig().channels ?? [])
      .map((c) => c.workspaceDir?.trim())
      .filter((w): w is string => !!w && fs.existsSync(w)),
  )]
  if (dirs.length === 0) {
    return { results: [{ file: "", action: "skipped", message: "无通道工作目录" }] }
  }
  for (const dir of dirs) cleanupStaleAdminSkill(dir)
  return { results: [{ file: ADMIN_SKILL_DIR, action: "skipped", message: "已退役 workspace 注入，仅清理残留" }] }
}
