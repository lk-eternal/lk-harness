import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { app } from "electron"
import { getConfig } from "./config-store"
import { broadcastLog } from "./ui-logger"

// ── Types ──────────────────────────────────────────────────────

export interface InjectResult {
  file: string
  action: "created" | "updated" | "skipped"
  message: string
}

// ── State ──────────────────────────────────────────────────────

let daemonPort: number | null = null
let lastMcpHash = ""
/** 仅控制 Skills 注入日志频率（每目录首次打一条），不做注入短路 */
const skillsLoggedDirs = new Set<string>()

const HOME_DIR = os.homedir()
const GLOBAL_MCP_PATH = path.join(HOME_DIR, ".cursor", "mcp.json")

function norm(p: string): string { return path.resolve(p) }

export function setDaemonPort(port: number | null): void {
  if (daemonPort === port) return
  daemonPort = port
  clearInjectionCache()
}

export function clearInjectionCache(dir?: string): void {
  if (dir) {
    skillsLoggedDirs.delete(norm(dir))
  } else {
    lastMcpHash = ""
    skillsLoggedDirs.clear()
  }
}

// ── Path helpers ───────────────────────────────────────────────

export function getTemplateRoot(): string {
  if (app.isPackaged) return path.join(process.resourcesPath, "template")
  return path.join(app.getAppPath(), "resources", "template")
}

export function getRuleTemplatePath(): string {
  return path.join(getTemplateRoot(), "rule", "cursor-claw.mdc")
}

export function getSkillsTemplateDir(): string {
  return path.join(getTemplateRoot(), "skills")
}

// ── MCP injection ──────────────────────────────────────────────

const ADMIN_MCP_KEY = "cursor-claw-admin"

export function buildMcpServers(opts?: { admin?: boolean }): Record<string, unknown> {
  if (!daemonPort) return {}
  const base = `http://127.0.0.1:${daemonPort}`
  const servers: Record<string, unknown> = {
    "cursor-claw": { url: `${base}/mcp` },
  }
  if (opts?.admin) servers[ADMIN_MCP_KEY] = { url: `${base}/mcp-admin` }
  return servers
}

function mergeMcpFile(filePath: string, servers: Record<string, unknown>): void {
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

/** 全局仅注入 cursor-claw（项目会话共用）；admin 只进主工作目录 */
export async function injectMcpGlobal(): Promise<boolean> {
  try {
    const newServers = buildMcpServers()
    const hash = JSON.stringify(newServers)
    if (lastMcpHash === hash) return true
    let mcpConfig: Record<string, unknown> = {}
    if (fs.existsSync(GLOBAL_MCP_PATH)) {
      try { mcpConfig = JSON.parse(fs.readFileSync(GLOBAL_MCP_PATH, "utf-8")) } catch { mcpConfig = {} }
    }
    const existing = (mcpConfig.mcpServers ?? {}) as Record<string, unknown>
    delete existing[ADMIN_MCP_KEY]
    Object.assign(existing, newServers)
    mcpConfig.mcpServers = existing
    const dir = path.dirname(GLOBAL_MCP_PATH)
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(GLOBAL_MCP_PATH, JSON.stringify(mcpConfig, null, 2), "utf-8")
    lastMcpHash = hash
    broadcastLog(`MCP 已注入全局配置: ${GLOBAL_MCP_PATH}`)
    return true
  } catch (e: unknown) {
    broadcastLog(`MCP 全局注入失败: ${e instanceof Error ? e.message : e}`, "ERROR")
    return false
  }
}

function injectMcpAdminToDir(wsDir: string): boolean {
  if (!daemonPort || !wsDir.trim()) return false
  try {
    mergeMcpFile(path.join(wsDir, ".cursor", "mcp.json"), buildMcpServers({ admin: true }))
    broadcastLog(`MCP admin 已注入主工作目录: ${wsDir}`)
    return true
  } catch (e: unknown) {
    broadcastLog(`MCP admin 注入失败: ${e instanceof Error ? e.message : e}`, "ERROR")
    return false
  }
}

// ── Rules injection ────────────────────────────────────────────

/** 内容一致时跳过写盘不打日志；变化才写并记录（规则更新可追溯，重复拉起不刷屏） */
function writeFileIfChanged(filePath: string, content: string, logLabel: string): void {
  const prev = fs.existsSync(filePath) ? fs.readFileSync(filePath, "utf-8") : null
  if (prev === content) return
  fs.writeFileSync(filePath, content, "utf-8")
  broadcastLog(`${logLabel}: ${filePath}`)
}

export function injectRulesToDir(wsDir: string, skipIdentity = false, identityOverride?: string): boolean {
  try {
    const rulesDir = path.join(wsDir, ".cursor", "rules")
    if (!fs.existsSync(rulesDir)) fs.mkdirSync(rulesDir, { recursive: true })
    const rulePath = path.join(rulesDir, "cursor-claw.mdc")
    const tplPath = getRuleTemplatePath()
    let ruleContent = fs.existsSync(tplPath) ? fs.readFileSync(tplPath, "utf-8") : ""
    if (!ruleContent) {
      broadcastLog(`规则模板文件不存在: ${tplPath}`, "WARN")
      return false
    }
    if (daemonPort) ruleContent = ruleContent.replace(/\{\{DAEMON_PORT\}\}/g, String(daemonPort))
    writeFileIfChanged(rulePath, ruleContent, "规则已注入")

    const identityPath = path.join(rulesDir, "digital-identity.mdc")
    if (skipIdentity) {
      if (fs.existsSync(identityPath)) fs.unlinkSync(identityPath)
    } else {
      // 优先使用通道级身份规则，未传入时回退全局旧字段
      const identity = (identityOverride ?? getConfig().digitalIdentity)?.trim()
      if (identity) {
        const identityMdc = [
          "---",
          "description: 对外身份规则 - 定义 Agent 面向其他用户时的角色与行为边界",
          "alwaysApply: true",
          "---",
          "",
          identity,
        ].join("\r\n")
        writeFileIfChanged(identityPath, identityMdc, "身份规则已注入")
      } else if (fs.existsSync(identityPath)) {
        fs.unlinkSync(identityPath)
      }
    }

    return true
  } catch (e: unknown) {
    broadcastLog(`规则注入失败: ${e instanceof Error ? e.message : e}`, "ERROR")
    return false
  }
}

// ── Skills injection ───────────────────────────────────────────

const ADMIN_SKILL_DIR = "cursor-claw-admin"

export function injectSkillsToDir(wsDir: string, skipAdmin = false): boolean {
  try {
    const srcDir = getSkillsTemplateDir()
    if (!fs.existsSync(srcDir)) return false
    const destBase = path.join(wsDir, ".cursor", "skills")
    if (skipAdmin) {
      const stale = path.join(destBase, ADMIN_SKILL_DIR)
      if (fs.existsSync(stale)) {
        fs.rmSync(stale, { recursive: true, force: true })
        broadcastLog(`已移除项目目录自管理 Skill: ${stale}`)
      }
    }
    const entries = fs.readdirSync(srcDir, { withFileTypes: true })
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      if (skipAdmin && entry.name === ADMIN_SKILL_DIR) continue
      const skillSrc = path.join(srcDir, entry.name)
      const skillDest = path.join(destBase, entry.name)
      if (!fs.existsSync(skillDest)) fs.mkdirSync(skillDest, { recursive: true })
      for (const file of fs.readdirSync(skillSrc)) {
        const s = path.join(skillSrc, file)
        const d = path.join(skillDest, file)
        if (fs.statSync(s).isFile()) fs.copyFileSync(s, d)
      }
    }
    if (!skillsLoggedDirs.has(norm(wsDir))) {
      skillsLoggedDirs.add(norm(wsDir))
      broadcastLog(`Skills 已注入: ${destBase}`)
    }
    return true
  } catch (e: unknown) {
    broadcastLog(`Skills 注入失败: ${e instanceof Error ? e.message : e}`, "ERROR")
    return false
  }
}

// ── Project-level MCP cleanup ──────────────────────────────────

const CLAW_MCP_KEYS = ["cursor-claw", ADMIN_MCP_KEY]

/** 非主工作目录：剥离宿主 MCP，避免项目 Agent 加载自管理工具 */
function cleanProjectMcpStale(wsDir: string, stripAdminOnly = false): void {
  const projectMcpPath = path.join(wsDir, ".cursor", "mcp.json")
  if (!fs.existsSync(projectMcpPath)) return
  try {
    const cfg = JSON.parse(fs.readFileSync(projectMcpPath, "utf-8"))
    const servers = cfg.mcpServers as Record<string, unknown> | undefined
    if (!servers) return
    let changed = false
    const keys = stripAdminOnly ? [ADMIN_MCP_KEY] : CLAW_MCP_KEYS
    for (const key of keys) {
      if (key in servers) { delete servers[key]; changed = true }
    }
    if (!changed) return
    if (Object.keys(servers).length === 0 && Object.keys(cfg).filter((k) => k !== "mcpServers").length === 0) {
      fs.unlinkSync(projectMcpPath)
      broadcastLog(`已删除空的项目级 MCP 配置: ${projectMcpPath}`)
    } else {
      cfg.mcpServers = servers
      fs.writeFileSync(projectMcpPath, JSON.stringify(cfg, null, 2), "utf-8")
      broadcastLog(`已清理项目级 MCP 残留: ${projectMcpPath}`)
    }
  } catch { /* ignore */ }
}

// ── Composite: inject all into a directory ─────────────────────

// 不做"已注入过就跳过"的短路：模板/身份规则随时可能更新（如 /reset、改身份），
// 每次拉起都重新对齐；writeFileIfChanged 保证内容一致时零写盘、零日志
export async function injectWorkspaceToDir(
  dir: string,
  skipIdentity = false,
  identityOverride?: string,
  skipAdmin = false,
): Promise<boolean> {
  injectSkillsToDir(dir, skipAdmin)
  if (skipAdmin) cleanProjectMcpStale(dir, true)
  return injectRulesToDir(dir, skipIdentity, identityOverride)
}

export async function injectWorkspaceMcpAndRules(): Promise<{ mcpOk: boolean; ruleOk: boolean; skillOk: boolean }> {
  const mcpOk = await injectMcpGlobal()
  const dirs = [...new Set(
    (getConfig().channels ?? [])
      .map((c) => c.workspaceDir?.trim())
      .filter((w): w is string => !!w && fs.existsSync(w)),
  )]
  if (dirs.length === 0) return { mcpOk, ruleOk: false, skillOk: false }
  let ruleOk = false
  let skillOk = false
  for (const dir of dirs) {
    injectMcpAdminToDir(dir)
    ruleOk = injectRulesToDir(dir, true) || ruleOk
    skillOk = injectSkillsToDir(dir) || skillOk
  }
  return { mcpOk, ruleOk, skillOk }
}

// ── UI-triggered: inject admin skill (IPC) ─────────────────────

const ADMIN_SKILL_CONTENT = `# Cursor Claw — 自管理 Skill

你可以通过以下 MCP 工具管理 Cursor Claw 应用自身的运行状态、配置和环境。

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

function ensureDir(dirPath: string): void {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true })
  }
}

function injectFile(filePath: string, content: string, forceUpdate = false): InjectResult {
  const relPath = path.basename(filePath)
  if (fs.existsSync(filePath) && !forceUpdate) {
    return { file: relPath, action: "skipped", message: "文件已存在" }
  }
  const action = fs.existsSync(filePath) ? "updated" as const : "created" as const
  ensureDir(path.dirname(filePath))
  fs.writeFileSync(filePath, content, "utf-8")
  return { file: relPath, action, message: action === "updated" ? "文件已更新" : "文件已创建" }
}

export async function injectWorkspace(): Promise<{ results: InjectResult[] }> {
  const dirs = [...new Set(
    (getConfig().channels ?? [])
      .map((c) => c.workspaceDir?.trim())
      .filter((w): w is string => !!w && fs.existsSync(w)),
  )]
  if (dirs.length === 0) {
    return { results: [{ file: "", action: "skipped", message: "无通道工作目录" }] }
  }
  const results: InjectResult[] = []
  for (const dir of dirs) {
    results.push(injectFile(
      path.join(dir, ".cursor", "skills", "cursor-claw-admin", "SKILL.md"),
      ADMIN_SKILL_CONTENT,
      true,
    ))
  }
  return { results }
}
