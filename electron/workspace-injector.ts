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

function norm(p: string): string { return path.resolve(p) }

export function setDaemonPort(port: number | null): void {
  if (daemonPort === port) return
  daemonPort = port
}

export function getDaemonPort(): number | null {
  return daemonPort
}

export function clearInjectionCache(_dir?: string): void {
  /* no-op???? workspace ???? */
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

/** ?????????? skill ????? prompt inline?????? */
function cleanupStaleAdminSkill(wsDir: string): void {
  const stale = path.join(wsDir, ".cursor", "skills", ADMIN_SKILL_DIR)
  if (!fs.existsSync(stale)) return
  try {
    fs.rmSync(stale, { recursive: true, force: true })
    broadcastLog(`???????? Skill: ${stale}`)
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

/** CLI ??????? `.cursor/mcp.json` merge ?? MCP????????????? */
export function injectCliMcpToProjectDir(wsDir: string, includeAdmin: boolean): boolean {
  if (!daemonPort || !wsDir.trim()) return false
  try {
    const servers = buildBuiltinMcpServers(daemonPort, includeAdmin)
    if (!Object.keys(servers).length) return false
    mergeProjectMcpFile(path.join(wsDir, ".cursor", "mcp.json"), servers)
    broadcastLog(`CLI MCP ??????? ${wsDir}`)
    return true
  } catch (e: unknown) {
    broadcastLog(`CLI MCP ??????: ${e instanceof Error ? e.message : e}`, "ERROR")
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

/** ??? Skill ???? resources/template/skills/lk-harness-admin/SKILL.md ?? */
export function getAdminSkillContent(): string {
  if (adminSkillContentCache) return adminSkillContentCache
  const p = path.join(getTemplateRoot(), "skills", "lk-harness-admin", "SKILL.md")
  adminSkillContentCache = fs.readFileSync(p, "utf8")
  return adminSkillContentCache
}

export function getAdminMcpProtocolSection(): string {
  let body = getAdminSkillContent().trim()
  body = body.replace(/^#[^\n]+\n+/, "")
  body = body.replace(/^## 可用 MCP 工具\n+/, "")
  return `\n\n### 应用自管理（lk-harness-admin）\n\n${body}\n`
}

export async function injectWorkspace(): Promise<{ results: InjectResult[] }> {
  const dirs = [...new Set(
    (getConfig().channels ?? [])
      .map((c) => c.workspaceDir?.trim())
      .filter((w): w is string => !!w && fs.existsSync(w)),
  )]
  if (dirs.length === 0) {
    return { results: [{ file: "", action: "skipped", message: "???????" }] }
  }
  for (const dir of dirs) cleanupStaleAdminSkill(dir)
  return { results: [{ file: ADMIN_SKILL_DIR, action: "skipped", message: "??? workspace ????????" }] }
}
