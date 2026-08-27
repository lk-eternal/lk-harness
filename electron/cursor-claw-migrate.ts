import Store from "electron-store"
import { safeStorage } from "electron"
import * as fs from "node:fs"
import * as path from "node:path"
import { app } from "electron"
import {
  getConfig,
  saveConfig,
  type AppConfig,
} from "./config-store"
import {
  mergeImportAgentResources,
  mergeImportChannels,
  mergeImportNodeGroups,
  mergeImportRepoProfiles,
  mergeImportTasks,
} from "./config-backup"
import { mergeImportHarnessRulesBundle } from "./harness-rule-store"
import {
  mergeHarnessMcpStoreRaw,
  CLAW_MCP_KEY,
  ADMIN_MCP_KEY,
} from "../src/shared/harness-mcp-store.js"
import { invalidateMcpEnabledCache } from "./mcp-manager"
import { readTasksFromFile, writeTasksToFile } from "./cron-scheduler"
import { initProjectStore } from "../src/shared/project-store.js"
import type { AgentResource, MessageChannel } from "../src/shared/channel-types.js"
import type { ScheduledTask } from "../src/shared/scheduled-task.js"
import type { ProjectNodeGroupDef } from "../src/shared/project-types.js"
import type { ConfigSection } from "./config-backup"
import { CONFIG_SECTION_LABELS, type ConfigSectionStat } from "./config-backup"

export interface CursorClawInstall {
  label: string
  userDataPath: string
}

const SECRET_PREFIX = "enc:v1:"

function canUseSafeStorage(): boolean {
  try { return safeStorage.isEncryptionAvailable() } catch { return false }
}

function openSecret(value: string | undefined): string | undefined {
  if (!value || !value.startsWith(SECRET_PREFIX)) return value
  try {
    return safeStorage.decryptString(Buffer.from(value.slice(SECRET_PREFIX.length), "base64"))
  } catch {
    return ""
  }
}

type SecretMapper = (value: string | undefined) => string | undefined

function mapChannelSecrets(channels: MessageChannel[] | undefined, fn: SecretMapper): MessageChannel[] | undefined {
  return channels?.map((c) => ({ ...c, larkAppSecret: fn(c.larkAppSecret), wechatToken: fn(c.wechatToken) }))
}

function mapResourceSecrets(resources: AgentResource[] | undefined, fn: SecretMapper): AgentResource[] | undefined {
  return resources?.map((r) => ({ ...r, apiKey: fn(r.apiKey) }))
}

function openConfigSecrets(cfg: AppConfig): AppConfig {
  return {
    ...cfg,
    channels: mapChannelSecrets(cfg.channels, openSecret) ?? [],
    agentResources: mapResourceSecrets(cfg.agentResources, openSecret) ?? [],
    gitlabToken: openSecret(cfg.gitlabToken) ?? "",
    flowHubToken: openSecret(cfg.flowHubToken) ?? "",
    larkAppSecret: openSecret(cfg.larkAppSecret) ?? "",
    wechatToken: openSecret(cfg.wechatToken) ?? "",
    cursorApiKey: openSecret(cfg.cursorApiKey) ?? "",
  }
}

function readCursorClawConfig(userDataPath: string): AppConfig | null {
  const configFile = path.join(userDataPath, "cursor-claw-config.json")
  if (!fs.existsSync(configFile)) return null
  try {
    const store = new Store<AppConfig>({
      name: "cursor-claw-config",
      encryptionKey: "cursor-claw-desktop-v1",
      cwd: userDataPath,
    })
    return openConfigSecrets(store.store as AppConfig)
  } catch {
    return null
  }
}

function readClawRulesBundle(userDataPath: string): { order: string[]; files: Record<string, { content: string; enabled?: boolean }> } | null {
  const rulesDir = path.join(userDataPath, "claw-rules")
  const manifestPath = path.join(rulesDir, "manifest.json")
  if (!fs.existsSync(manifestPath)) return null
  try {
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf-8")) as { order?: string[] }
    const order = Array.isArray(manifest.order) ? manifest.order : []
    const files: Record<string, { content: string; enabled?: boolean }> = {}
    for (const id of order) {
      const fp = path.join(rulesDir, `${id}.mdc`)
      if (!fs.existsSync(fp)) continue
      let raw = fs.readFileSync(fp, "utf-8")
      const disabled = raw.startsWith("<!-- disabled -->\n")
      if (disabled) raw = raw.slice("<!-- disabled -->\n".length)
      files[id] = { content: raw, enabled: !disabled }
    }
    if (!order.length && !Object.keys(files).length) return null
    return { order, files }
  } catch {
    return null
  }
}

function readClawMcpStore(userDataPath: string): { order: string[]; servers: Record<string, Record<string, unknown>> } | null {
  const storePath = path.join(userDataPath, "claw-mcp", "servers.json")
  if (!fs.existsSync(storePath)) return null
  try {
    const raw = JSON.parse(fs.readFileSync(storePath, "utf-8")) as {
      order?: string[]
      servers?: Record<string, Record<string, unknown>>
    }
    const order = (raw.order ?? []).filter((n) => n !== "cursor-claw" && n !== "cursor-claw-admin" && n !== CLAW_MCP_KEY && n !== ADMIN_MCP_KEY)
    const servers: Record<string, Record<string, unknown>> = {}
    for (const [name, cfg] of Object.entries(raw.servers ?? {})) {
      if (name === "cursor-claw" || name === "cursor-claw-admin" || name === CLAW_MCP_KEY || name === ADMIN_MCP_KEY) continue
      servers[name] = cfg
    }
    if (!order.length && !Object.keys(servers).length) return null
    return { order, servers }
  } catch {
    return null
  }
}

function readClawTasks(userDataPath: string): ScheduledTask[] | null {
  const tasksPath = path.join(userDataPath, "scheduled-tasks.json")
  if (!fs.existsSync(tasksPath)) return null
  try {
    const raw = JSON.parse(fs.readFileSync(tasksPath, "utf-8"))
    return Array.isArray(raw) ? raw as ScheduledTask[] : null
  } catch {
    return null
  }
}

function readClawNodeGroups(userDataPath: string): ProjectNodeGroupDef[] | null {
  const groupsPath = path.join(userDataPath, "project-node-groups.json")
  if (!fs.existsSync(groupsPath)) return null
  try {
    const raw = JSON.parse(fs.readFileSync(groupsPath, "utf-8"))
    return Array.isArray(raw) ? raw as ProjectNodeGroupDef[] : null
  } catch {
    return null
  }
}

export function discoverCursorClawInstalls(): CursorClawInstall[] {
  const base = path.dirname(app.getPath("userData"))
  const results: CursorClawInstall[] = []
  const seen = new Set<string>()

  const addIfValid = (label: string, dir: string) => {
    const resolved = path.resolve(dir)
    if (seen.has(resolved)) return
    if (!fs.existsSync(path.join(resolved, "cursor-claw-config.json"))) return
    seen.add(resolved)
    results.push({ label, userDataPath: resolved })
  }

  addIfValid("Cursor Claw（默认）", path.join(base, "cursor-claw"))
  try {
    if (fs.existsSync(base)) {
      for (const ent of fs.readdirSync(base, { withFileTypes: true })) {
        if (!ent.isDirectory()) continue
        if (!ent.name.startsWith("cursor-claw-")) continue
        const profile = ent.name.slice("cursor-claw-".length)
        addIfValid(`Cursor Claw（${profile}）`, path.join(base, ent.name))
      }
    }
  } catch { /* ignore */ }

  return results
}

/** 检测 Cursor Claw 安装中可迁移的模块 */
export function inspectCursorClawSections(userDataPath: string): { ok: boolean; sections?: ConfigSection[]; items?: ConfigSectionStat[]; error?: string } {
  const cfg = readCursorClawConfig(userDataPath)
  if (!cfg) return { ok: false, error: "无法读取 Cursor Claw 配置（路径无效或文件损坏）" }

  const items: ConfigSectionStat[] = []
  items.push({
    id: "general",
    label: CONFIG_SECTION_LABELS.general,
    count: (cfg.favoriteWorkspaces?.length ?? 0) + (cfg.favoriteModels?.length ?? 0),
  })
  const proxyN = [cfg.httpProxy, cfg.httpsProxy, cfg.noProxy].filter((s) => s?.trim()).length
  if (proxyN) items.push({ id: "proxy", label: CONFIG_SECTION_LABELS.proxy, count: proxyN })
  const agents = (cfg.agentResources ?? []).filter((r) => r.type === "sdk" || r.type === "llm-builtin" || r.type === "llm-custom")
  if (agents.length) items.push({ id: "agent", label: CONFIG_SECTION_LABELS.agent, count: agents.length })
  if (cfg.channels?.length) items.push({ id: "channels", label: CONFIG_SECTION_LABELS.channels, count: cfg.channels.length })
  const groups = readClawNodeGroups(userDataPath)
  const projectN = (cfg.repoProfiles?.length ?? 0) + (groups?.length ?? 0)
    + ((cfg.gitlabToken ?? "").trim() || (cfg.worktreeRoot ?? "").trim() || (cfg.flowHubUrl ?? "").trim() ? 1 : 0)
  if (projectN) items.push({ id: "projects", label: CONFIG_SECTION_LABELS.projects, count: projectN })
  const mcp = readClawMcpStore(userDataPath)
  if (mcp) items.push({ id: "mcp", label: CONFIG_SECTION_LABELS.mcp, count: mcp.order.length || Object.keys(mcp.servers).length })
  const rules = readClawRulesBundle(userDataPath)
  if (rules) items.push({ id: "rules", label: CONFIG_SECTION_LABELS.rules, count: rules.order.length || Object.keys(rules.files).length })
  const tasks = readClawTasks(userDataPath)
  if (tasks?.length) items.push({ id: "tasks", label: CONFIG_SECTION_LABELS.tasks, count: tasks.length })

  if (!items.length) return { ok: false, error: "未识别到可迁移模块" }
  return { ok: true, sections: items.map((i) => i.id), items }
}

export function migrateFromCursorClaw(
  userDataPath: string,
  sections: ConfigSection[],
): { ok: boolean; error?: string; warnings?: string[] } {
  const warnings: string[] = []
  const selected = new Set(sections)
  if (!selected.size) return { ok: false, error: "请至少选择一个迁移模块" }

  const cfg = readCursorClawConfig(userDataPath)
  if (!cfg) return { ok: false, error: "无法读取 Cursor Claw 配置（路径无效或文件损坏）" }

  initProjectStore(app.getPath("userData"))

  if (selected.has("general")) {
    saveConfig({
      favoriteWorkspaces: cfg.favoriteWorkspaces ?? [],
      favoriteModels: cfg.favoriteModels ?? [],
      autoStart: cfg.autoStart ?? false,
      closeWindowAction: cfg.closeWindowAction ?? "ask",
      autoUpgradePrompt: cfg.autoUpgradePrompt ?? true,
      daemonPort: cfg.daemonPort ?? 19528,
    })
  }

  if (selected.has("proxy")) {
    saveConfig({
      httpProxy: cfg.httpProxy ?? "",
      httpsProxy: cfg.httpsProxy ?? "",
      noProxy: cfg.noProxy ?? "",
    })
  }

  if (selected.has("agent")) {
    const sdkResources = (cfg.agentResources ?? []).filter((r) => r.type === "sdk" || r.type === "llm-builtin" || r.type === "llm-custom")
    mergeImportAgentResources(sdkResources, warnings)
  }

  if (selected.has("channels") && cfg.channels?.length) {
    mergeImportChannels(cfg.channels, warnings)
  }

  if (selected.has("projects")) {
    const repoProfiles = mergeImportRepoProfiles(cfg.repoProfiles, warnings)
    saveConfig({
      gitlabToken: cfg.gitlabToken || getConfig().gitlabToken,
      gitlabHost: cfg.gitlabHost || getConfig().gitlabHost,
      repoProfiles,
      repoRoots: repoProfiles.map((p) => p.path),
      worktreeRoot: cfg.worktreeRoot || getConfig().worktreeRoot,
      flowHubUrl: cfg.flowHubUrl || getConfig().flowHubUrl,
      flowHubToken: cfg.flowHubToken || getConfig().flowHubToken,
      flowHubAuthor: cfg.flowHubAuthor || getConfig().flowHubAuthor,
    })
    const groups = readClawNodeGroups(userDataPath)
    if (groups?.length) mergeImportNodeGroups(groups, warnings)
    else if (selected.has("projects")) warnings.push("未找到 Cursor Claw 流程组文件，已跳过")
  }

  if (selected.has("mcp")) {
    const mcp = readClawMcpStore(userDataPath)
    if (mcp) {
      warnings.push(...mergeHarnessMcpStoreRaw(mcp))
      invalidateMcpEnabledCache()
    } else {
      warnings.push("未找到 Cursor Claw MCP 配置，已跳过")
    }
  }

  if (selected.has("rules")) {
    const rules = readClawRulesBundle(userDataPath)
    if (rules) warnings.push(...mergeImportHarnessRulesBundle(rules))
    else warnings.push("未找到 Cursor Claw 规则，已跳过")
  }

  if (selected.has("tasks")) {
    const tasks = readClawTasks(userDataPath)
    if (tasks?.length) mergeImportTasks(tasks, warnings)
    else {
      const existing = readTasksFromFile()
      if (!existing.length) warnings.push("未找到 Cursor Claw 定时任务，已跳过")
    }
  }

  if (selected.has("general") && cfg.setupComplete) {
    saveConfig({ setupComplete: true })
  }

  return { ok: true, warnings: warnings.length ? warnings : undefined }
}
