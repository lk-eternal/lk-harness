import * as fs from "node:fs"
import * as path from "node:path"
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