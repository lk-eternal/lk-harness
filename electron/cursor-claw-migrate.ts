import Store from "electron-store"
import * as fs from "node:fs"
import * as path from "node:path"
import { app } from "electron"
import { execFileSync } from "node:child_process"
import { createDecipheriv } from "node:crypto"
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
import { initProjectStore, getProjectStoreDir } from "../src/shared/project-store.js"
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

/** claw 侧 os_crypt AES 钥匙（每安装目录缓存；取不到记 null 不再试） */
const clawKeyCache = new Map<string, Buffer | null>()

/** Windows：用同用户 DPAPI 解开 claw Local State 里的 os_crypt 钥匙；非 Windows 直接 null */
function readClawOsCryptKey(userDataPath: string): Buffer | null {
  if (clawKeyCache.has(userDataPath)) return clawKeyCache.get(userDataPath) ?? null
  let key: Buffer | null = null
  try {
    if (process.platform === "win32") {
      const localState = JSON.parse(fs.readFileSync(path.join(userDataPath, "Local State"), "utf-8"))
      const b64: string | undefined = localState?.os_crypt?.encrypted_key
      if (b64) {
        const raw = Buffer.from(b64, "base64")
        const dpapiBlob = raw.subarray(0, 5).toString() === "DPAPI" ? raw.subarray(5) : raw
        const out = execFileSync("powershell.exe", [
          "-NoProfile", "-NonInteractive", "-Command",
          `[Convert]::ToBase64String([Security.Cryptography.ProtectedData]::Unprotect([Convert]::FromBase64String('${dpapiBlob.toString("base64")}'), $null, 'CurrentUser'))`,
        ], { timeout: 10_000, windowsHide: true, stdio: ["ignore", "pipe", "ignore"] })
        const bytes = Buffer.from(String(out).trim(), "base64")
        if (bytes.length === 32) key = bytes
      }
    }
  } catch { key = null }
  clawKeyCache.set(userDataPath, key)
  return key
}

/** Chromium os_crypt 格式解密（v10/v11 + nonce12 + ct+tag16）；解不开返回 null */
export function clawDecryptSecret(value: string, key: Buffer): string | null {
  try {
    const raw = Buffer.from(value, "base64")
    const version = raw.subarray(0, 3).toString()
    if (version !== "v10" && version !== "v11") return null
    const nonce = raw.subarray(3, 15)
    const ctAndTag = raw.subarray(15)
    if (ctAndTag.length < 17) return null
    const decipher = createDecipheriv("aes-256-gcm", key, nonce)
    decipher.setAuthTag(ctAndTag.subarray(ctAndTag.length - 16))
    const plain = Buffer.concat([decipher.update(ctAndTag.subarray(0, ctAndTag.length - 16)), decipher.final()])
    return plain.toString("utf-8")
  } catch { return null }
}

type SecretMapper = (value: string | undefined) => string | undefined

/** claw 侧密钥打开：明文直通；enc:v1 用 claw钥匙解；解不开记 failures 并置空待手填 */
function openClawSecret(value: string | undefined, key: Buffer | null, label: string, failures: string[]): string | undefined {
  if (!value || !value.startsWith(SECRET_PREFIX)) return value
  if (key) {
    const text = clawDecryptSecret(value.slice(SECRET_PREFIX.length), key)
    if (text !== null) return text
  }
  if (!failures.includes(label)) failures.push(label)
  return ""
}

function mapChannelSecrets(
  channels: MessageChannel[] | undefined,
  fn: (value: string | undefined, label: string) => string | undefined,
  labelOf: (c: MessageChannel) => string,
): MessageChannel[] | undefined {
  return channels?.map((c) => ({ ...c, larkAppSecret: fn(c.larkAppSecret, `${labelOf(c)} AppSecret`), wechatToken: fn(c.wechatToken, `${labelOf(c)} Token`) }))
}

function mapResourceSecrets(
  resources: AgentResource[] | undefined,
  fn: (value: string | undefined, label: string) => string | undefined,
): AgentResource[] | undefined {
  return resources?.map((r) => ({ ...r, apiKey: fn(r.apiKey, `Agent「${r.name || r.id}」密钥`) }))
}

function openConfigSecrets(cfg: AppConfig, key: Buffer | null, failures: string[]): AppConfig {
  const fn = (value: string | undefined, label: string) => openClawSecret(value, key, label, failures)
  const labelOf = (c: MessageChannel) => `通道「${c.name || c.id}」`
  return {
    ...cfg,
    channels: mapChannelSecrets(cfg.channels, fn, labelOf) ?? [],
    agentResources: mapResourceSecrets(cfg.agentResources, fn) ?? [],
    gitlabToken: fn(cfg.gitlabToken, "GitLab Token") ?? "",
    flowHubToken: fn(cfg.flowHubToken, "FlowHub Token") ?? "",
    larkAppSecret: fn(cfg.larkAppSecret, "旧版飞书 AppSecret") ?? "",
    wechatToken: fn(cfg.wechatToken, "旧版微信 Token") ?? "",
    cursorApiKey: fn(cfg.cursorApiKey, "旧版 Cursor API Key") ?? "",
  }
}

function readCursorClawConfig(userDataPath: string, failures: string[] = []): AppConfig | null {
  const configFile = path.join(userDataPath, "cursor-claw-config.json")
  if (!fs.existsSync(configFile)) return null
  try {
    const store = new Store<AppConfig>({
      name: "cursor-claw-config",
      encryptionKey: "cursor-claw-desktop-v1",
      cwd: userDataPath,
    })
    return openConfigSecrets(store.store as AppConfig, readClawOsCryptKey(userDataPath), failures)
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
  // 新版在 projects/ 子目录，旧版在根目录
  for (const groupsPath of [path.join(userDataPath, "projects", "project-node-groups.json"), path.join(userDataPath, "project-node-groups.json")]) {
    if (!fs.existsSync(groupsPath)) continue
    try {
      const raw = JSON.parse(fs.readFileSync(groupsPath, "utf-8"))
      if (Array.isArray(raw)) return raw as ProjectNodeGroupDef[]
    } catch { /* 换下一个位置 */ }
  }
  return null
}

/** 拷贝 claw projects/ 下单项目文件（缺啥补啥，不覆盖本地）；返回 [新增, 跳过] */
function copyClawProjectFiles(userDataPath: string, destDir: string, warnings: string[]): [number, number] {
  let added = 0
  let skipped = 0
  try {
    const srcDir = path.join(userDataPath, "projects")
    if (!fs.existsSync(srcDir)) return [added, skipped]
    fs.mkdirSync(destDir, { recursive: true })
    for (const f of fs.readdirSync(srcDir)) {
      if (!/^[A-Za-z0-9-]+\.json$/.test(f) || f === "current.json" || f === "project-node-groups.json" || f === "pending-new.json") continue
      try {
        const dest = path.join(destDir, f)
        if (fs.existsSync(dest)) { skipped++; continue }
        const raw = JSON.parse(fs.readFileSync(path.join(srcDir, f), "utf-8"))
        if (!raw || typeof raw.id !== "string") { skipped++; continue }
        fs.copyFileSync(path.join(srcDir, f), dest)
        added++
      } catch {
        skipped++
      }
    }
  } catch { /* 目录不可读则跳过 */ }
  return [added, skipped]
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

  const secretFailures: string[] = []
  const cfg = readCursorClawConfig(userDataPath, secretFailures)
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
    else warnings.push("未找到 Cursor Claw 流程组文件，已跳过")
    const [added, skipped] = copyClawProjectFiles(userDataPath, getProjectStoreDir(), warnings)
    if (added || skipped) warnings.push(`项目文件：新增 ${added} 个，跳过 ${skipped} 个（本地已存在或格式不符）`)
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

  for (const f of secretFailures) warnings.push(`${f}：系统加密隔离，需手动重填`)
  return { ok: true, warnings: warnings.length ? warnings : undefined }
}
