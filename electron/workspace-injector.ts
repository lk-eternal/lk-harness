import * as fs from "node:fs"
import * as path from "node:path"
import { app } from "electron"
import { getConfig } from "./config-store"
import { broadcastLog } from "./ui-logger"
import { buildBuiltinMcpServers } from "../src/shared/harness-mcp-store.js"

export interface InjectResult {
  file: string
  action: "created" | "updated" | "skipped"
  message: string
}

let daemonPort: number | null = null

export function setDaemonPort(port: number | null): void {
  if (daemonPort === port) return
  daemonPort = port
}

export function getDaemonPort(): number | null {
  return daemonPort
}

export function clearInjectionCache(_dir?: string): void {
  adminSkillContentCache = null
  void import("./prompt-assembler.js").then(({ clearProtocolTemplateCache }) => clearProtocolTemplateCache())
}

export function getTemplateRoot(): string {
  if (app.isPackaged) return path.join(process.resourcesPath, "template")
  return path.join(app.getAppPath(), "resources", "template")
}

export function getRuleTemplatePath(): string {
  return path.join(getTemplateRoot(), "rule", "lk-harness.mdc")
}

export function getLlmHostRuleTemplatePath(): string {
  return path.join(getTemplateRoot(), "rule", "lk-harness-llm-host.mdc")
}

const ADMIN_SKILL_DIR = "lk-harness-admin"

/** 清理项目遗留的自管理 skill 目录（已改 prompt inline，不再注入） */
function cleanupStaleAdminSkill(wsDir: string): void {
  const stale = path.join(wsDir, ".cursor", "skills", ADMIN_SKILL_DIR)
  if (!fs.existsSync(stale)) return
  try {
    fs.rmSync(stale, { recursive: true, force: true })
    broadcastLog(`已清理遗留自管理 Skill: ${stale}`)
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

/** CLI 专用：仅向项目 `.cursor/mcp.json` merge 内置 MCP，不碰规则、不占用用户条目 */
export function injectCliMcpToProjectDir(wsDir: string, includeAdmin: boolean): boolean {
  if (!daemonPort || !wsDir.trim()) return false
  try {
    const servers = buildBuiltinMcpServers(daemonPort, includeAdmin)
    if (!Object.keys(servers).length) return false
    mergeProjectMcpFile(path.join(wsDir, ".cursor", "mcp.json"), servers)
    broadcastLog(`CLI MCP 已注入项目目录 ${wsDir}`)
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

let adminSkillContentCache: string | null = null

export function getAdminSkillContent(): string {
  if (adminSkillContentCache) return adminSkillContentCache
  const p = path.join(getTemplateRoot(), "skills", "lk-harness-admin", "SKILL.md")
  adminSkillContentCache = fs.readFileSync(p, "utf8")
  return adminSkillContentCache
}

/** 嵌入宿主协议模板的 admin MCP 段（不含 Skill 标题与重复小节） */
export function getAdminMcpProtocolSection(): string {
  let body = getAdminSkillContent().trim()
  body = body.replace(/^#[^\n]+\r?\n+/, "")
  body = body.replace(/^[^\n#]+\r?\n+/, "") // 介绍段
  body = body.replace(/\r?\n## 可用 MCP 工具\r?\n+/, "\n")
  return `\n\n### 应用自管理（lk-harness-admin）\n\n${body.trim()}\n`
}

export async function injectWorkspace(): Promise<{ results: InjectResult[] }> {
  const dirs = [...new Set(
    (getConfig().channels ?? [])
      .map((c) => c.workspaceDir?.trim())
      .filter((w): w is string => !!w && fs.existsSync(w)),
  )]
  if (dirs.length === 0) {
    return { results: [{ file: "", action: "skipped", message: "无有效工作目录" }] }
  }
  for (const dir of dirs) cleanupStaleAdminSkill(dir)
  return { results: [{ file: ADMIN_SKILL_DIR, action: "skipped", message: "已停用 workspace 注入，仅清理残留" }] }
}
