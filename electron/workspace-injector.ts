import * as fs from "node:fs"
import * as path from "node:path"
import { app } from "electron"
import { getConfig } from "./config-store"
import { broadcastLog } from "./ui-logger"

let daemonPort: number | null = null

export function setDaemonPort(port: number | null): void {
  if (daemonPort === port) return
  daemonPort = port
}

export function getDaemonPort(): number | null {
  return daemonPort
}

export function clearInjectionCache(): void {
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

function configuredWorkspaceDirs(): string[] {
  return [...new Set(
    (getConfig().channels ?? [])
      .map((c) => c.workspaceDir?.trim())
      .filter((w): w is string => !!w && fs.existsSync(w)),
  )]
}

/** 清理项目遗留的自管理 skill 目录（已改 prompt inline，不再注入） */
function cleanupStaleAdminSkill(wsDir: string): void {
  const stale = path.join(wsDir, ".cursor", "skills", ADMIN_SKILL_DIR)
  if (!fs.existsSync(stale)) return
  try {
    fs.rmSync(stale, { recursive: true, force: true })
    broadcastLog(`已清理遗留自管理 Skill: ${stale}`)
  } catch { /* ignore */ }
}

export function cleanupWorkspaceDir(dir: string): boolean {
  if (!dir.trim() || !fs.existsSync(dir)) return false
  cleanupStaleAdminSkill(dir)
  return true
}

/** 清理所有已配置通道工作目录中的遗留注入产物 */
export function cleanupChannelWorkspaces(): void {
  for (const dir of configuredWorkspaceDirs()) cleanupStaleAdminSkill(dir)
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
