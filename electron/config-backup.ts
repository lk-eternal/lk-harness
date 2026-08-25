import { spawnSync } from "node:child_process"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { app } from "electron"
import {
  getConfig,
  saveConfig,
  CLI_RESOURCE_ID,
  getRepoProfiles,
  type AppConfig,
} from "./config-store"
import { collectAllRulesForExport, rulesExportDir } from "./rule-store"
import { readMcpJson, writeMcpJson, invalidateMcpEnabledCache } from "./mcp-manager"
import { readTasksFromFile, writeTasksToFile } from "./cron-scheduler"
import { initProjectStore, getNodeGroups, saveNodeGroups } from "../src/shared/project-store.js"
import type { AgentResource, MessageChannel } from "../src/shared/channel-types.js"
import type { ScheduledTask } from "../src/shared/scheduled-task.js"
import type { ProjectNodeGroupDef } from "../src/shared/project-types.js"

export const CONFIG_EXPORT_KIND = "cursor-claw-config-export"
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
    repoProfiles: ReturnType<typeof getRepoProfiles>
    worktreeRoot: string
    flowHubUrl: string
    flowHubToken: string
    flowHubAuthor: string
    nodeGroups: ProjectNodeGroupDef[]
  }
  mcp: {
    global: Record<string, unknown> | null
  }
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

function skillsDir(): string {
  return path.join(os.homedir(), ".cursor", "skills")
}

function rulesDir(): string {
  return rulesExportDir()
}

function copyDirSync(src: string, dest: string): void {
  fs.mkdirSync(dest, { recursive: true })
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name)
    const d = path.join(dest, entry.name)
    if (entry.isDirectory()) copyDirSync(s, d)
    else fs.copyFileSync(s, d)
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
      repoProfiles: getRepoProfiles(cfg),
      worktreeRoot: cfg.worktreeRoot ?? "",
      flowHubUrl: cfg.flowHubUrl ?? "",
      flowHubToken: cfg.flowHubToken ?? "",
      flowHubAuthor: cfg.flowHubAuthor ?? "",
      nodeGroups: getNodeGroups(),
    },
    mcp: {
      global: readMcpJson("global"),
    },
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

export function exportConfigBundle(zipPath: string): { ok: boolean; error?: string } {
  const staging = fs.mkdtempSync(path.join(os.tmpdir(), "cursor-claw-export-"))
  try {
    fs.writeFileSync(path.join(staging, "manifest.json"), JSON.stringify(buildManifest(), null, 2), "utf-8")
    const sd = skillsDir()
    if (fs.existsSync(sd)) copyDirSync(sd, path.join(staging, "skills"))
    const rd = rulesDir()
    if (rd && fs.existsSync(rd)) copyDirSync(rd, path.join(staging, "rules"))
    if (fs.existsSync(zipPath)) fs.unlinkSync(zipPath)
    if (!tarCreateZip(zipPath, staging)) return { ok: false, error: "打包失败（需要系统 tar 支持）" }
    return { ok: true }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  } finally {
    fs.rmSync(staging, { recursive: true, force: true })
  }
}

export function importConfigBundle(zipPath: string): { ok: boolean; error?: string; warnings?: string[] } {
  const staging = fs.mkdtempSync(path.join(os.tmpdir(), "cursor-claw-import-"))
  const warnings: string[] = []
  try {
    if (!tarExtractZip(zipPath, staging)) return { ok: false, error: "解压失败（需要系统 tar 支持）" }
    const manifest = readManifest(staging)
    if (!manifest) return { ok: false, error: "不是有效的 Cursor Claw 配置包" }

    initProjectStore(app.getPath("userData"))

    const localCfg = getConfig()
    const { ...generalRest } = manifest.general

    saveConfig({
      ...generalRest,
      httpProxy: manifest.proxy.httpProxy,
      httpsProxy: manifest.proxy.httpsProxy,
      noProxy: manifest.proxy.noProxy,
      gitlabToken: manifest.projects.gitlabToken,
      gitlabHost: manifest.projects.gitlabHost,
      repoProfiles: manifest.projects.repoProfiles,
      repoRoots: manifest.projects.repoProfiles.map((p) => p.path),
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

    if (manifest.mcp.global) writeMcpJson("global", manifest.mcp.global)
    invalidateMcpEnabledCache()

    writeTasksToFile(manifest.tasks ?? [])

    const sd = skillsDir()
    const stagingSkills = path.join(staging, "skills")
    if (fs.existsSync(stagingSkills)) {
      try {
        if (fs.existsSync(sd)) fs.rmSync(sd, { recursive: true, force: true })
        copyDirSync(stagingSkills, sd)
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        warnings.push(`skills 导入失败：${msg}`)
      }
    }

    const rd = rulesDir()
    const stagingRules = path.join(staging, "rules")
    if (fs.existsSync(stagingRules)) {
      try {
        if (fs.existsSync(rd)) fs.rmSync(rd, { recursive: true, force: true })
        fs.mkdirSync(rd, { recursive: true })
        copyDirSync(stagingRules, rd)
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        warnings.push(`rules 导入失败：${msg}`)
      }
    }

    return { ok: true, warnings: warnings.length ? warnings : undefined }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  } finally {
    fs.rmSync(staging, { recursive: true, force: true })
  }
}
