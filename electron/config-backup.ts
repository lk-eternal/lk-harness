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
import { exportHarnessRulesBundle, importHarnessRulesBundle } from "./harness-rule-store"
import { readHarnessMcpStoreRaw, writeHarnessMcpStoreRaw } from "../src/shared/harness-mcp-store.js"
import { invalidateMcpEnabledCache } from "./mcp-manager"
import { readTasksFromFile, writeTasksToFile } from "./cron-scheduler"
import { initProjectStore, getNodeGroups, saveNodeGroups } from "../src/shared/project-store.js"
import { SKILL_ROOT_DEFS } from "./skill-store"
import type { AgentResource, MessageChannel } from "../src/shared/channel-types.js"
import type { ScheduledTask } from "../src/shared/scheduled-task.js"
import type { ProjectNodeGroupDef } from "../src/shared/project-types.js"

export const CONFIG_EXPORT_KIND = "lk-harness-config-export"
export const CONFIG_EXPORT_VERSION = 1

export type ConfigSection =
  | "general"
  | "proxy"
  | "agent"
  | "channels"
  | "projects"
  | "mcp"
  | "rules"
  | "tasks"
  | "skills"

export const ALL_CONFIG_SECTIONS: ConfigSection[] = [
  "general",
  "proxy",
  "agent",
  "channels",
  "projects",
  "mcp",
  "rules",
  "tasks",
  "skills",
]

export const CONFIG_SECTION_LABELS: Record<ConfigSection, string> = {
  general: "通用设置",
  proxy: "网络代理",
  agent: "Agent 资源",
  channels: "消息通道",
  projects: "项目设置",
  mcp: "MCP 服务器",
  rules: "Harness 规则",
  tasks: "定时任务",
  skills: "Skills 脚本",
}

export interface ConfigExportGeneral {
  favoriteWorkspaces: string[]
  favoriteModels: AppConfig["favoriteModels"]
  autoStart: boolean
  closeWindowAction: AppConfig["closeWindowAction"]
  autoUpgradePrompt: boolean
  daemonPort: number
  setupComplete: boolean
}

export interface ConfigExportManifest {
  kind: typeof CONFIG_EXPORT_KIND
  version: typeof CONFIG_EXPORT_VERSION
  exportedAt: string
  appVersion: string
  sections?: ConfigSection[]
  general?: ConfigExportGeneral
  proxy?: {
    httpProxy: string
    httpsProxy: string
    noProxy: string
  }
  agent?: {
    agentResources: AgentResource[]
  }
  channels?: MessageChannel[]
  projects?: {
    gitlabToken: string
    gitlabHost: string
    repoProfiles: AppConfig["repoProfiles"]
    worktreeRoot: string
    flowHubUrl: string
    flowHubToken: string
    flowHubAuthor: string
    nodeGroups: ProjectNodeGroupDef[]
  }
  mcp?: {
    harness: ReturnType<typeof readHarnessMcpStoreRaw>
  }
  rules?: ReturnType<typeof exportHarnessRulesBundle>
  tasks?: ScheduledTask[]
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

function normalizeSections(sections?: ConfigSection[]): Set<ConfigSection> {
  if (!sections?.length) return new Set(ALL_CONFIG_SECTIONS)
  return new Set(sections)
}

function buildManifest(sections?: ConfigSection[]): Partial<ConfigExportManifest> & Pick<ConfigExportManifest, "kind" | "version" | "exportedAt" | "appVersion"> {
  initProjectStore(app.getPath("userData"))
  const cfg = getConfig()
  const selected = normalizeSections(sections)
  const sdkResources = (cfg.agentResources ?? []).filter((r) => r.type === "sdk" || r.type === "llm-builtin" || r.type === "llm-custom")
  const base = {
    kind: CONFIG_EXPORT_KIND as typeof CONFIG_EXPORT_KIND,
    version: CONFIG_EXPORT_VERSION as typeof CONFIG_EXPORT_VERSION,
    exportedAt: new Date().toISOString(),
    appVersion: appVersion(),
    sections: [...selected],
  }
  return {
    ...base,
    ...(selected.has("general") ? {
      general: {
        favoriteWorkspaces: cfg.favoriteWorkspaces ?? [],
        favoriteModels: cfg.favoriteModels ?? [],
        autoStart: cfg.autoStart ?? false,
        closeWindowAction: cfg.closeWindowAction ?? "ask",
        autoUpgradePrompt: cfg.autoUpgradePrompt ?? true,
        daemonPort: cfg.daemonPort ?? 19528,
        setupComplete: cfg.setupComplete ?? false,
      },
    } : {}),
    ...(selected.has("proxy") ? {
      proxy: {
        httpProxy: cfg.httpProxy ?? "",
        httpsProxy: cfg.httpsProxy ?? "",
        noProxy: cfg.noProxy ?? "",
      },
    } : {}),
    ...(selected.has("agent") ? { agent: { agentResources: sdkResources } } : {}),
    ...(selected.has("channels") ? { channels: cfg.channels ?? [] } : {}),
    ...(selected.has("projects") ? {
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
    } : {}),
    ...(selected.has("mcp") ? { mcp: { harness: readHarnessMcpStoreRaw() } } : {}),
    ...(selected.has("rules") ? { rules: exportHarnessRulesBundle() } : {}),
    ...(selected.has("tasks") ? { tasks: readTasksFromFile() } : {}),
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

export function exportConfigBundle(zipPath: string, sections?: ConfigSection[]): { ok: boolean; error?: string; warnings?: string[] } {
  const staging = fs.mkdtempSync(path.join(os.tmpdir(), "lk-harness-export-"))
  const warnings: string[] = []
  const selected = normalizeSections(sections)
  try {
    fs.writeFileSync(path.join(staging, "manifest.json"), JSON.stringify(buildManifest(sections), null, 2), "utf-8")
    if (selected.has("skills")) {
      const skillsBase = path.join(staging, "skills")
      const seenSkills = new Set<string>()
      for (const def of SKILL_ROOT_DEFS) {
        const src = path.join(os.homedir(), ...def.rel)
        warnings.push(...copySkillRoot(src, path.join(skillsBase, def.id), seenSkills))
      }
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

export function importConfigBundle(zipPath: string, sections?: ConfigSection[]): { ok: boolean; error?: string; warnings?: string[] } {
  const staging = fs.mkdtempSync(path.join(os.tmpdir(), "lk-harness-import-"))
  const warnings: string[] = []
  const selected = normalizeSections(sections)
  try {
    if (!tarExtractZip(zipPath, staging)) return { ok: false, error: "解压失败（需要系统 tar 支持）" }
    const manifest = readManifest(staging)
    if (!manifest) return { ok: false, error: "不是有效的 LK Harness 配置包" }

    initProjectStore(app.getPath("userData"))

    if (selected.has("general") && manifest.general) {
      saveConfig({ ...manifest.general })
    }

    if (selected.has("proxy") && manifest.proxy) {
      saveConfig({
        httpProxy: manifest.proxy.httpProxy,
        httpsProxy: manifest.proxy.httpsProxy,
        noProxy: manifest.proxy.noProxy,
      })
    }

    if (selected.has("projects") && manifest.projects) {
      saveConfig({
        gitlabToken: manifest.projects.gitlabToken,
        gitlabHost: manifest.projects.gitlabHost,
        repoProfiles: manifest.projects.repoProfiles ?? [],
        repoRoots: (manifest.projects.repoProfiles ?? []).map((p) => p.path),
        worktreeRoot: manifest.projects.worktreeRoot,
        flowHubUrl: manifest.projects.flowHubUrl,
        flowHubToken: manifest.projects.flowHubToken,
        flowHubAuthor: manifest.projects.flowHubAuthor,
      })
      saveNodeGroups(manifest.projects.nodeGroups ?? [])
    }

    if (selected.has("channels") && manifest.channels) {
      saveConfig({ channels: manifest.channels })
    }

    if (selected.has("agent") && manifest.agent) {
      const cfg = getConfig()
      const cli = (cfg.agentResources ?? []).filter((r) => r.id === CLI_RESOURCE_ID || r.type === "cli")
      saveConfig({ agentResources: [...cli, ...manifest.agent.agentResources] })
    }

    if (selected.has("mcp") && manifest.mcp) {
      const legacyMcp = manifest.mcp as {
        harness?: { order: string[]; servers: Record<string, Record<string, unknown>> } | null
        claw?: { order: string[]; servers: Record<string, Record<string, unknown>> } | null
        global?: { mcpServers?: Record<string, Record<string, unknown>>; order?: string[] }
      }
      if (legacyMcp.harness) writeHarnessMcpStoreRaw(legacyMcp.harness)
      else if (legacyMcp.claw) writeHarnessMcpStoreRaw(legacyMcp.claw)
      else if (legacyMcp.global?.mcpServers) {
        writeHarnessMcpStoreRaw({
          order: legacyMcp.global.order ?? Object.keys(legacyMcp.global.mcpServers),
          servers: legacyMcp.global.mcpServers,
        })
      }
      invalidateMcpEnabledCache()
    }

    if (selected.has("rules") && manifest.rules) importHarnessRulesBundle(manifest.rules)

    if (selected.has("tasks") && manifest.tasks) writeTasksToFile(manifest.tasks ?? [])

    if (selected.has("skills")) {
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
    }

    return { ok: true, warnings: warnings.length ? warnings : undefined }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  } finally {
    fs.rmSync(staging, { recursive: true, force: true })
  }
}
