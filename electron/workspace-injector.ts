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
  /* no-opï¼?å·²é??å½?workspace æ³¨å?¥ç¼?å­? */
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

/** æ¸?ç?é¡¹ç?®é??æ®?ç??ç??è?ªç®¡ç?skill ç?®å½?ï¼?å·²æ??prompt inlineï¼?ä¸å?æ³¨å?¥ï¼? */
function cleanupStaleAdminSkill(wsDir: string): void {
  const stale = path.join(wsDir, ".cursor", "skills", ADMIN_SKILL_DIR)
  if (!fs.existsSync(stale)) return
  try {
    fs.rmSync(stale, { recursive: true, force: true })
    broadcastLog(`å·²æ¸?ç?æ®?ç??è?ªç®¡ç? Skill: ${stale}`)
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

/** CLI ä¸?ç?¨ï¼?ä»?å?é¡¹ç??`.cursor/mcp.json` merge å??ç½® MCPï¼?ä¸ç¢°å?¨å±?ã?ä¸å? ç?¨æ?·æ¡ç??*/
export function injectCliMcpToProjectDir(wsDir: string, includeAdmin: boolean): boolean {
  if (!daemonPort || !wsDir.trim()) return false
  try {
    const servers = buildBuiltinMcpServers(daemonPort, includeAdmin)
    if (!Object.keys(servers).length) return false
    mergeProjectMcpFile(path.join(wsDir, ".cursor", "mcp.json"), servers)
    broadcastLog(`CLI MCP å·²æ³¨å?¥é¡¹ç?®ç?®å½? ${wsDir}`)
    return true
  } catch (e: unknown) {
    broadcastLog(`CLI MCP é¡¹ç?®æ³¨å?¥å¤±è´¥: ${e instanceof Error ? e.message : e}`, "ERROR")
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

export const ADMIN_SKILL_CONTENT = `# LK Harness â??è?ªç®¡ç?Skill

ä½ å¯ä»¥é??è¿?ä»¥ä¸? MCP å·¥å?·ç®¡ç? LK Harness åº?ç?¨è?ªèº«ç??è¿è¡?ç?¶æ?ã?é?ç½®å??ç?¯å¢?ã??

## å¯ç?¨ MCP å·¥å?·

### manage_agent
ç®¡ç? Agent ç??å?½å?¨æ??ã??
| action | è¯´æ?? |
|--------|------|
| status | æ?¥è¯¢è¿è¡?ç?¶æ??|
| stop | å?æ­¢ Agent |
| restart | é?å¯åº?ç?¨ |
| reset | é?ç½®ä¼?è¯ |
| clean | æ¸?ç©ºæ¶?æ¯é??å?? |

### manage_mcp
ç®¡ç? MCP æ?å?¡å?¨é?ç½®ï¼?list / add / deleteï¼?ã??

### manage_rules
ç®¡ç? Cursor Rules æ??ä»¶ï¼?list / read / save / deleteï¼?ã??

### manage_skills
ç®¡ç? Agent Skillsï¼?list / read / save / deleteï¼?ã??

### manage_tasks
ç®¡ç?å®?æ?¶ä»»å?¡ï¼?list / add / update / delete / toggleï¼?ã??

### manage_workspace
ç®¡ç?å·¥ä½?ç?®å½?ï¼?get / setï¼?ã??
`

export async function injectWorkspace(): Promise<{ results: InjectResult[] }> {
  const dirs = [...new Set(
    (getConfig().channels ?? [])
      .map((c) => c.workspaceDir?.trim())
      .filter((w): w is string => !!w && fs.existsSync(w)),
  )]
  if (dirs.length === 0) {
    return { results: [{ file: "", action: "skipped", message: "æ? é??é?å·¥ä½?ç?®å½?" }] }
  }
  for (const dir of dirs) cleanupStaleAdminSkill(dir)
  return { results: [{ file: ADMIN_SKILL_DIR, action: "skipped", message: "å·²é??å½?workspace æ³¨å?¥ï¼?ä»?æ¸?ç?æ®?ç??" }] }
}
