import { spawnSync } from "node:child_process"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import AdmZip from "adm-zip"
import { app } from "electron"
import {
  getConfig,
  saveConfig,
  type AppConfig,
} from "./config-store"
import { exportHarnessRulesBundle, mergeImportHarnessRulesBundle } from "./harness-rule-store"
import { listHarnessRules } from "./harness-rule-store"
import { listSkillRoots } from "./skill-store"
import { readHarnessMcpStoreRaw, mergeHarnessMcpStoreRaw } from "../src/shared/harness-mcp-store.js"
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

export const CONFIG_SECTION_NAV: { id: ConfigSection; label: string }[] = [
  { id: "general", label: "通用" },
  { id: "proxy", label: "网络" },
  { id: "agent", label: "Agent" },
  { id: "channels", label: "消息通道" },
  { id: "rules", label: "规则" },
  { id: "skills", label: "Skills" },
  { id: "mcp", label: "MCP" },
  { id: "projects", label: "项目" },
  { id: "tasks", label: "定时任务" },
]

export const ALL_CONFIG_SECTIONS: ConfigSection[] = CONFIG_SECTION_NAV.map((s) => s.id)

export const CONFIG_SECTION_LABELS: Record<ConfigSection, string> = Object.fromEntries(
  CONFIG_SECTION_NAV.map((s) => [s.id, s.label]),
) as Record<ConfigSection, string>

export interface ConfigSectionStat {
  id: ConfigSection
  label: string
  count: number
}

function agentResourceCount(resources: AgentResource[] | undefined): number {
  return (resources ?? []).length
}

function statsFromManifest(manifest: ConfigExportManifest, staging: string): ConfigSectionStat[] {
  const counts: Partial<Record<ConfigSection, number>> = {}
  if (manifest.general) {
    counts.general = (manifest.general.favoriteWorkspaces?.length ?? 0) + (manifest.general.favoriteModels?.length ?? 0)
  }
  if (manifest.proxy) {
    counts.proxy = [manifest.proxy.httpProxy, manifest.proxy.httpsProxy, manifest.proxy.noProxy].filter((s) => s?.trim()).length
  }
  if (manifest.agent) counts.agent = agentResourceCount(manifest.agent.agentResources)
  if (manifest.channels) counts.channels = manifest.channels.length
  if (manifest.rules) counts.rules = manifest.rules.order?.length ?? Object.keys(manifest.rules.files ?? {}).length
  if (manifest.tasks) counts.tasks = manifest.tasks.length
  if (manifest.mcp?.harness) counts.mcp = manifest.mcp.harness.order?.length ?? Object.keys(manifest.mcp.harness.servers ?? {}).length
  if (manifest.projects) {
    counts.projects = (manifest.projects.repoProfiles?.length ?? 0) + (manifest.projects.nodeGroups?.length ?? 0)
  }
  if (fs.existsSync(path.join(staging, "skills"))) {
    let n = 0
    for (const ent of fs.readdirSync(path.join(staging, "skills"), { withFileTypes: true })) {
      if (ent.isDirectory()) n += 1
    }
    counts.skills = n
  }
  return sectionsFromManifest(manifest, staging).map((id) => ({
    id,
    label: CONFIG_SECTION_LABELS[id],
    count: counts[id] ?? 0,
  }))
}

/** 当前本机各模块数量（与设置页一级导航对齐） */
export function getLocalConfigSectionStats(): ConfigSectionStat[] {
  initProjectStore(app.getPath("userData"))
  const cfg = getConfig()
  const mcp = readHarnessMcpStoreRaw()
  const rules = listHarnessRules()
  const skills = listSkillRoots().reduce((sum, r) => sum + r.skillCount, 0)
  const tasks = readTasksFromFile()
  return CONFIG_SECTION_NAV.map(({ id, label }) => {
    let count = 0
    switch (id) {
      case "general":
        count = (cfg.favoriteWorkspaces?.length ?? 0) + (cfg.favoriteModels?.length ?? 0)
        break
      case "proxy":
        count = [cfg.httpProxy, cfg.httpsProxy, cfg.noProxy].filter((s) => s?.trim()).length
        break
      case "agent":
        count = agentResourceCount(cfg.agentResources)
        break
      case "channels":
        count = cfg.channels?.length ?? 0
        break
      case "rules":
        count = rules.length
        break
      case "skills":
        count = skills
        break
      case "mcp":
        count = mcp?.order?.length ?? Object.keys(mcp?.servers ?? {}).length
        break
      case "projects":
        count = (cfg.repoProfiles?.length ?? 0) + (getNodeGroups()?.length ?? 0)
        break
      case "tasks":
        count = tasks.length
        break
    }
    return { id, label, count }
  })
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

/** 导入 skill 根：跳过本地已存在的条目，仅新增 */
function importSkillRoot(src: string, dest: string, seen: Set<string>): string[] {
  const notes: string[] = []
  if (!fs.existsSync(src)) return notes
  fs.mkdirSync(dest, { recursive: true })
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name)
    const d = path.join(dest, entry.name)
    try {
      if (fs.existsSync(d)) {
        notes.push(`${entry.name}：已跳过（本地已存在）`)
        continue
      }
      if (isDirLike(entry)) {
        const real = realPathSafe(s)
        if (seen.has(real)) continue
        seen.add(real)
        fs.cpSync(s, d, { recursive: true, force: true, errorOnExist: false })
      } else {
        fs.copyFileSync(s, d)
      }
    } catch (e) {
      notes.push(`${entry.name}: ${e instanceof Error ? e.message : String(e)}`)
    }
  }
  return notes
}

function skipNote(label: string): string {
  return `${label}：已跳过（本地已存在）`
}

export function mergeImportAgentResources(incoming: AgentResource[], warnings: string[]): void {
  const cfg = getConfig()
  const existing = cfg.agentResources ?? []
  const rest = [...existing]
  const byId = new Set(rest.map((r) => r.id))
  for (const r of incoming) {
    if (byId.has(r.id)) warnings.push(skipNote(`agent/${r.name || r.id}`))
    else {
      rest.push(r)
      byId.add(r.id)
    }
  }
  saveConfig({ agentResources: rest })
}

export function mergeImportChannels(incoming: MessageChannel[], warnings: string[]): void {
  const cfg = getConfig()
  const current = [...(cfg.channels ?? [])]
  const byId = new Set(current.map((c) => c.id))
  for (const c of incoming) {
    if (byId.has(c.id)) warnings.push(skipNote(`通道/${c.name || c.id}`))
    else {
      current.push(c)
      byId.add(c.id)
    }
  }
  saveConfig({ channels: current })
}

export function mergeImportTasks(incoming: ScheduledTask[], warnings: string[]): void {
  const current = readTasksFromFile()
  const byId = new Set(current.map((t) => t.id))
  for (const t of incoming) {
    if (byId.has(t.id)) warnings.push(skipNote(`任务/${t.name || t.id}`))
    else {
      current.push(t)
      byId.add(t.id)
    }
  }
  writeTasksToFile(current)
}

export function mergeImportNodeGroups(incoming: ProjectNodeGroupDef[], warnings: string[]): void {
  const current = getNodeGroups()
  const byId = new Set(current.map((g) => g.id))
  const merged = [...current]
  for (const g of incoming) {
    if (byId.has(g.id)) warnings.push(skipNote(`流程组/${g.name || g.id}`))
    else {
      merged.push(g)
      byId.add(g.id)
    }
  }
  saveNodeGroups(merged)
}

export function mergeImportRepoProfiles(incoming: AppConfig["repoProfiles"], warnings: string[]): AppConfig["repoProfiles"] {
  const cfg = getConfig()
  const current = [...(cfg.repoProfiles ?? [])]
  const byPath = new Set(current.map((p) => p.path))
  for (const p of incoming ?? []) {
    if (byPath.has(p.path)) warnings.push(skipNote(`仓库/${p.path}`))
    else {
      current.push(p)
      byPath.add(p.path)
    }
  }
  return current
}

export function mergeImportMcpFromManifest(
  legacyMcp: {
    harness?: { order: string[]; servers: Record<string, Record<string, unknown>> } | null
    claw?: { order: string[]; servers: Record<string, Record<string, unknown>> } | null
    global?: { mcpServers?: Record<string, Record<string, unknown>>; order?: string[] }
  },
  warnings: string[],
): void {
  let incoming: { order: string[]; servers: Record<string, Record<string, unknown>> } | null = null
  if (legacyMcp.harness) incoming = legacyMcp.harness
  else if (legacyMcp.claw) incoming = legacyMcp.claw
  else if (legacyMcp.global?.mcpServers) {
    incoming = {
      order: legacyMcp.global.order ?? Object.keys(legacyMcp.global.mcpServers),
      servers: legacyMcp.global.mcpServers,
    }
  }
  if (incoming) warnings.push(...mergeHarnessMcpStoreRaw(incoming))
}

function addDirToZip(zip: AdmZip, dir: string, zipRoot: string): void {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, ent.name)
    const entry = zipRoot ? `${zipRoot}/${ent.name}` : ent.name
    if (isDirLike(ent)) addDirToZip(zip, abs, entry)
    else zip.addLocalFile(abs, zipRoot)
  }
}

function zipCreateFromDir(zipPath: string, cwd: string): boolean {
  try {
    const zip = new AdmZip()
    addDirToZip(zip, cwd, "")
    if (fs.existsSync(zipPath)) fs.unlinkSync(zipPath)
    zip.writeZip(zipPath)
    return fs.existsSync(zipPath)
  } catch {
    return false
  }
}

function zipExtractToDir(zipPath: string, dest: string): boolean {
  try {
    fs.mkdirSync(dest, { recursive: true })
    const zip = new AdmZip(zipPath)
    zip.extractAllTo(dest, true)
    return true
  } catch {
    return false
  }
}

function tarCreateZip(zipPath: string, cwd: string): boolean {
  if (zipCreateFromDir(zipPath, cwd)) return true
  const r = spawnSync("tar", ["-caf", zipPath, "-C", cwd, "."], { stdio: "pipe", windowsHide: true })
  return r.status === 0
}

function tarExtractZip(zipPath: string, dest: string): boolean {
  if (zipExtractToDir(zipPath, dest)) return true
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

function sectionsFromManifest(manifest: ConfigExportManifest, staging: string): ConfigSection[] {
  const found = new Set<ConfigSection>()
  for (const id of manifest.sections ?? []) {
    if (ALL_CONFIG_SECTIONS.includes(id)) found.add(id)
  }
  if (manifest.general) found.add("general")
  if (manifest.proxy) found.add("proxy")
  if (manifest.agent) found.add("agent")
  if (manifest.channels?.length) found.add("channels")
  if (manifest.projects) found.add("projects")
  if (manifest.mcp) found.add("mcp")
  if (manifest.rules) found.add("rules")
  if (manifest.tasks?.length) found.add("tasks")
  if (fs.existsSync(path.join(staging, "skills"))) found.add("skills")
  return ALL_CONFIG_SECTIONS.filter((s) => found.has(s))
}

/** 读取配置包内含模块（不解包写入） */
export function inspectConfigBundle(zipPath: string): { ok: boolean; sections?: ConfigSection[]; items?: ConfigSectionStat[]; error?: string } {
  const staging = fs.mkdtempSync(path.join(os.tmpdir(), "lk-harness-inspect-"))
  try {
    if (!tarExtractZip(zipPath, staging)) return { ok: false, error: "解压失败" }
    const manifest = readManifest(staging)
    if (!manifest) return { ok: false, error: "不是有效的 LK Harness 配置包" }
    const items = statsFromManifest(manifest, staging)
    if (!items.length) return { ok: false, error: "配置包内未识别到可导入模块" }
    return { ok: true, sections: items.map((i) => i.id), items }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  } finally {
    fs.rmSync(staging, { recursive: true, force: true })
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
    if (!tarCreateZip(zipPath, staging)) return { ok: false, error: "打包失败" }
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
    if (!tarExtractZip(zipPath, staging)) return { ok: false, error: "解压失败" }
    const manifest = readManifest(staging)
    if (!manifest) return { ok: false, error: "不是有效的 LK Harness 配置包" }

    initProjectStore(app.getPath("userData"))

    if (selected.has("general") && manifest.general) {
      const cfg = getConfig()
      saveConfig({
        favoriteWorkspaces: [...new Set([...(cfg.favoriteWorkspaces ?? []), ...(manifest.general.favoriteWorkspaces ?? [])])],
        favoriteModels: manifest.general.favoriteModels?.length ? manifest.general.favoriteModels : cfg.favoriteModels,
        autoStart: manifest.general.autoStart,
        closeWindowAction: manifest.general.closeWindowAction,
        autoUpgradePrompt: manifest.general.autoUpgradePrompt,
        daemonPort: manifest.general.daemonPort,
        setupComplete: cfg.setupComplete || manifest.general.setupComplete,
      })
    }

    if (selected.has("proxy") && manifest.proxy) {
      saveConfig({
        httpProxy: manifest.proxy.httpProxy,
        httpsProxy: manifest.proxy.httpsProxy,
        noProxy: manifest.proxy.noProxy,
      })
    }

    if (selected.has("projects") && manifest.projects) {
      const repoProfiles = mergeImportRepoProfiles(manifest.projects.repoProfiles, warnings)
      saveConfig({
        gitlabToken: manifest.projects.gitlabToken || getConfig().gitlabToken,
        gitlabHost: manifest.projects.gitlabHost || getConfig().gitlabHost,
        repoProfiles,
        repoRoots: repoProfiles.map((p) => p.path),
        worktreeRoot: manifest.projects.worktreeRoot || getConfig().worktreeRoot,
        flowHubUrl: manifest.projects.flowHubUrl || getConfig().flowHubUrl,
        flowHubToken: manifest.projects.flowHubToken || getConfig().flowHubToken,
        flowHubAuthor: manifest.projects.flowHubAuthor || getConfig().flowHubAuthor,
      })
      if (manifest.projects.nodeGroups?.length) mergeImportNodeGroups(manifest.projects.nodeGroups, warnings)
    }

    if (selected.has("channels") && manifest.channels) {
      mergeImportChannels(manifest.channels, warnings)
    }

    if (selected.has("agent") && manifest.agent) {
      mergeImportAgentResources(manifest.agent.agentResources, warnings)
    }

    if (selected.has("mcp") && manifest.mcp) {
      mergeImportMcpFromManifest(manifest.mcp as Parameters<typeof mergeImportMcpFromManifest>[0], warnings)
      invalidateMcpEnabledCache()
    }

    if (selected.has("rules") && manifest.rules) {
      warnings.push(...mergeImportHarnessRulesBundle(manifest.rules))
    }

    if (selected.has("tasks") && manifest.tasks?.length) {
      mergeImportTasks(manifest.tasks, warnings)
    }

    if (selected.has("skills")) {
      const stagingSkills = path.join(staging, "skills")
      if (fs.existsSync(stagingSkills)) {
        for (const def of SKILL_ROOT_DEFS) {
          const src = path.join(stagingSkills, def.id)
          if (!fs.existsSync(src)) continue
          const dest = path.join(os.homedir(), ...def.rel)
          try {
            const seen = new Set<string>()
            warnings.push(...importSkillRoot(src, dest, seen))
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
