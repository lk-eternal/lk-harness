import { spawnSync } from "node:child_process"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { app } from "electron"
import {
  getConfig,
  saveConfig,
  CLI_RESOURCE_ID,
  type AppConfig,
} from "./config-store"
import { exportClawRulesBundle, importClawRulesBundle } from "./claw-rule-store"
import { readClawMcpStoreRaw, writeClawMcpStoreRaw } from "../src/shared/claw-mcp-store.js"
import { invalidateMcpEnabledCache } from "./mcp-manager"
import { readTasksFromFile, writeTasksToFile } from "./cron-scheduler"
import { initProjectStore, getNodeGroups, saveNodeGroups } from "../src/shared/project-store.js"
import { SKILL_ROOT_DEFS } from "./skill-store"
import type { AgentResource, MessageChannel } from "../src/shared/channel-types.js"
import type { ScheduledTask } from "../src/shared/scheduled-task.js"
import type { ProjectNodeGroupDef } from "../src/shared/project-types.js"

export const CONFIG_EXPORT_KIND = "lk-harness-config-export"
export const CONFIG_EXPORT_VERSION = 1

export interface ConfigExportManifest {
  kind: typeof CONFIG_EXPORT_KIND
  version: typeof CONFIG_EXPORT_VERSION
  exportedAt: string
  appVersion: string
  general: {
    favoriteWorkspaces: string[]
    favoriteModels: AppConfig["favoriteModels"]
    autoStart: boolean
    closeWindowAction: AppConfig["closeWindowAction"]
    autoUpgradePrompt: boolean
    daemonPort: number
    setupComplete: boolean
  }
  proxy: {
    httpProxy: string
    httpsProxy: string
    noProxy: string
  }
  agent: {
    agentResources: AgentResource[]
  }
  channels: MessageChannel[]
  projects: {
    gitlabToken: string
    gitlabHost: string
    repoProfiles: AppConfig["repoProfiles"]
    worktreeRoot: string
    flowHubUrl: string
    flowHubToken: string
    flowHubAuthor: string
    nodeGroups: ProjectNodeGroupDef[]
  }
  mcp: {
    claw: ReturnType<typeof readClawMcpStoreRaw>
  }
  rules: ReturnType<typeof exportClawRulesBundle>
  tasks: ScheduledTask[]
}

function appVersion(): string {
  try {
    const p = JSON.parse(fs.readFileSync(path.join(app.getAppPath(), "package.json"), "utf-8")) as { version?: string }
    return p.version ?? "0"
  } catch {
    return "0"
  }
}

function realPathSafe(p: string): string {
  try {
    return fs.realpathSync.native(p)
  } catch {
    return path.resolve(p)
  }
}

function isDirLike(entry: fs.Dirent): boolean {
  return entry.isDirectory() || entry.isSymbolicLink()
}

/** 按 realpath 去重；junction/软链用 cpSync；单条失败不中断整包导出 */
function copySkillRoot(src: string, dest: string, seen: Set<string>): string[] {
  const warnings: string[] = []
  if (!fs.existsSync(src)) return warnings
  fs.mkdirSync(dest, { recursive: true })
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name)
    const d = path.join(dest, entry.name)
    try {
      if (isDirLike(entry)) {
        const real = realPathSafe(s)
        if (seen.has(real)) continue
        seen.add(real)
        fs.cpSync(s, d, { recursive: true, force: true, errorOnExist: false })
      } else {
        fs.copyFileSync(s, d)
      }
    } catch (e) {
      warnings.push(`${entry.name}: ${e instanceof Error ? e.message : String(e)}`)
    }
  }
  return warnings
}

function copyDirSync(src: string, dest: string): void {
  fs.mkdirSync(dest, { recursive: true })
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name)
    const d = path.join(dest, entry.name)
    if (isDirLike(entry)) {
      fs.cpSync(s, d, { recursive: true, force: true, errorOnExist: false })
    } else {
      fs.copyFileSync(s, d)
    }
  }
}

function tarCreateZip(zipPath: string, cwd: string): boolean {
  const r = spawnSync("tar", ["-caf", zipPath, "-C", cwd, "."], { stdio: "pipe", windowsHide: true })
  return r.status === 0
}

function tarExtractZip(zipPath: string, dest: string): boolean {
  fs.mkdirSync(dest, { recursive: true })
  const r = spawnSync("tar", ["-xaf", zipPath, "-C", dest], { stdio: "pipe", windowsHide: true })
  return r.status === 0
}

function buildManifest(): ConfigExportManifest {
  initProjectStore(app.getPath("userData"))
  const cfg = getConfig()
  const sdkResources = (cfg.agentResources ?? []).filter((r) => r.type === "sdk")
  return {
    kind: CONFIG_EXPORT_KIND,
    version: CONFIG_EXPORT_VERSION,
    exportedAt: new Date().toISOString(),
    appVersion: appVersion(),
    general: {
      favoriteWorkspaces: cfg.favoriteWorkspaces ?? [],
      favoriteModels: cfg.favoriteModels ?? [],
      autoStart: cfg.autoStart ?? false,
      closeWindowAction: cfg.closeWindowAction ?? "ask",
      autoUpgradePrompt: cfg.autoUpgradePrompt ?? true,
      daemonPort: cfg.daemonPort ?? 19528,
      setupComplete: cfg.setupComplete ?? false,
    },
    proxy: {
      httpProxy: cfg.httpProxy ?? "",
      httpsProxy: cfg.httpsProxy ?? "",
      noProxy: cfg.noProxy ?? "",
    },
    agent: { agentResources: sdkResources },
    channels: cfg.channels ?? [],
    projects: {
      gitlabToken: cfg.gitlabToken ?? "",
      gitlabHost: cfg.gitlabHost ?? "",
      repoProfiles: cfg.repoProfiles ?? [],
      worktreeRoot: cfg.worktreeRoot ?? "",
      flowHubUrl: cfg.flowHubUrl ?? "",
      flowHubToken: cfg.flowHubToken ?? "",
      flowHubAuthor: cfg.flowHubAuthor ?? "",
      nodeGroups: getNodeGroups(),
    },
    mcp: {
      claw: readClawMcpStoreRaw(),
    },
    rules: exportClawRulesBundle(),
    tasks: readTasksFromFile(),
  }
}

function readManifest(staging: string): ConfigExportManifest | null {
  const p = path.join(staging, "manifest.json")
  if (!fs.existsSync(p)) return null
  try {
    const raw = JSON.parse(fs.readFileSync(p, "utf-8")) as ConfigExportManifest
    if (raw.kind !== CONFIG_EXPORT_KIND || raw.version !== CONFIG_EXPORT_VERSION) return null
    return raw
  } catch {
    return null
  }
}

export function exportConfigBundle(zipPath: string): { ok: boolean; error?: string; warnings?: string[] } {
  const staging = fs.mkdtempSync(path.join(os.tmpdir(), "lk-harness-export-"))
  const warnings: string[] = []
  try {
    fs.writeFileSync(path.join(staging, "manifest.json"), JSON.stringify(buildManifest(), null, 2), "utf-8")
    const skillsBase = path.join(staging, "skills")
    const seenSkills = new Set<string>()
    for (const def of SKILL_ROOT_DEFS) {
      const src = path.join(os.homedir(), ...def.rel)
      warnings.push(...copySkillRoot(src, path.join(skillsBase, def.id), seenSkills))
    }
    if (fs.existsSync(zipPath)) fs.unlinkSync(zipPath)
    if (!tarCreateZip(zipPath, staging)) return { ok: false, error: "打包失败（需要系统 tar 支持）" }
    return { ok: true, warnings: warnings.length ? warnings : undefined }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  } finally {
    fs.rmSync(staging, { recursive: true, force: true })
  }
}

export function importConfigBundle(zipPath: string): { ok: boolean; error?: string; warnings?: string[] } {
  const staging = fs.mkdtempSync(path.join(os.tmpdir(), "lk-harness-import-"))
  const warnings: string[] = []
  try {
    if (!tarExtractZip(zipPath, staging)) return { ok: false, error: "解压失败（需要系统 tar 支持）" }
    const manifest = readManifest(staging)
    if (!manifest) return { ok: false, error: "不是有效的 LK Harness 配置包" }

    initProjectStore(app.getPath("userData"))

    const { ...generalRest } = manifest.general

    saveConfig({
      ...generalRest,
      httpProxy: manifest.proxy.httpProxy,
      httpsProxy: manifest.proxy.httpsProxy,
      noProxy: manifest.proxy.noProxy,
      gitlabToken: manifest.projects.gitlabToken,
      gitlabHost: manifest.projects.gitlabHost,
      repoProfiles: manifest.projects.repoProfiles ?? [],
      repoRoots: (manifest.projects.repoProfiles ?? []).map((p) => p.path),
      worktreeRoot: manifest.projects.worktreeRoot,
      flowHubUrl: manifest.projects.flowHubUrl,
      flowHubToken: manifest.projects.flowHubToken,
      flowHubAuthor: manifest.projects.flowHubAuthor,
      channels: manifest.channels,
    })

    const cfg = getConfig()
    const cli = (cfg.agentResources ?? []).filter((r) => r.id === CLI_RESOURCE_ID || r.type === "cli")
    saveConfig({ agentResources: [...cli, ...manifest.agent.agentResources] })

    saveNodeGroups(manifest.projects.nodeGroups ?? [])

    const legacyMcp = manifest.mcp as {
      claw?: { order: string[]; servers: Record<string, Record<string, unknown>> } | null
      global?: { mcpServers?: Record<string, Record<string, unknown>>; order?: string[] }
    }
    if (legacyMcp.claw) writeClawMcpStoreRaw(legacyMcp.claw)
    else if (legacyMcp.global?.mcpServers) {
      writeClawMcpStoreRaw({
        order: legacyMcp.global.order ?? Object.keys(legacyMcp.global.mcpServers),
        servers: legacyMcp.global.mcpServers,
      })
    }
    invalidateMcpEnabledCache()

    if (manifest.rules) importClawRulesBundle(manifest.rules)

    writeTasksToFile(manifest.tasks ?? [])

    const stagingSkills = path.join(staging, "skills")
    if (fs.existsSync(stagingSkills)) {
      for (const def of SKILL_ROOT_DEFS) {
        const src = path.join(stagingSkills, def.id)
        if (!fs.existsSync(src)) continue
        const dest = path.join(os.homedir(), ...def.rel)
        try {
          if (fs.existsSync(dest)) fs.rmSync(dest, { recursive: true, force: true })
          copyDirSync(src, dest)
        } catch (e) {
          warnings.push(`skills/${def.id} 导入失败：${e instanceof Error ? e.message : String(e)}`)
        }
      }
    }

    return { ok: true, warnings: warnings.length ? warnings : undefined }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  } finally {
    fs.rmSync(staging, { recursive: true, force: true })
  }
}
