import Store from "electron-store"
import { safeStorage } from "electron"
import { randomBytes } from "node:crypto"
import * as path from "node:path"
import * as os from "node:os"
import type { AgentResource, MessageChannel } from "../src/shared/channel-types"
import { channelIdFromSessionKey } from "../src/shared/channel-types"
import type { ScheduledTask } from "../src/shared/scheduled-task"

export type { AgentResource, MessageChannel, ScheduledTask }

export interface AppConfig {
  // ── 新模型：Agent 资源池 + 消息通道 ──
  agentResources: AgentResource[]
  channels: MessageChannel[]
  /** 旧配置 → 通道模型 一次性迁移标记 */
  channelsMigrated: boolean
  /** 全局常用目录是否已复制到各通道 */
  favWorkspacesMigrated: boolean

  // ── 全局配置 ──
  workspaceDir: string
  /** 常用工作目录种子；实际读写以 channel.favoriteWorkspaces 为准（无通道时的兜底） */
  favoriteWorkspaces: string[]
  /** 常用模型（飞书/Dashboard 快捷切会话模型） */
  favoriteModels: { model: string; modelParams?: string; label?: string }[]
  autoStart: boolean
  setupComplete: boolean
  httpProxy: string
  httpsProxy: string
  noProxy: string
  /** 点关闭主窗口时：ask=弹窗选择；minimize=隐藏到托盘；quit=直接退出应用 */
  closeWindowAction: "ask" | "minimize" | "quit"
  /** 启动时自动弹出升级提示；false=静默，用户仍可在「关于」手动检查更新 */
  autoUpgradePrompt: boolean
  /** 主会话 chatId 映射（`channelId:workspaceDir` → chatId），用于 --resume 恢复上下文 */
  mainChatIds: Record<string, string>
  /** Daemon 固定端口（0 = 随机） */
  daemonPort: number

  /** 项目工作区：GitLab token（ship / 私有仓 fetch） */
  gitlabToken: string
  /** GitLab Host，如 https://gitlab.com 或自建 */
  gitlabHost: string
  /** 已 clone 的主仓本地路径列表 */
  repoRoots: string[]
  /** 主仓+固定基线（/p new 多选记忆） */
  repoProfiles: { path: string; baseBranch: string; testBranch?: string; developBranch?: string }[]
  /** 新建 worktree 的父目录 */
  worktreeRoot: string

  /** Flow Hub 共享仓库地址 */
  flowHubUrl: string
  /** Flow Hub 专用 GitLab Token（与项目 Token 分离） */
  flowHubToken: string
  /** Flow Hub 上传作者昵称 */
  flowHubAuthor: string

  // ── 旧字段（仅用于迁移，新代码不应再读取）──
  allowOthers: boolean
  digitalIdentity: string
  larkAppId: string
  larkAppSecret: string
  larkAppQuickCreated: boolean
  larkReceiveId: string
  model: string
  modelParams: string
  agentNewSession: boolean
  feishuEnabled: boolean
  wechatEnabled: boolean
  wechatToken: string
  wechatAccountId: string
  agentMode: "cli" | "sdk"
  cursorApiKey: string
  othersModel: string
  othersModelParams: string
  taskModel: string
  taskModelParams: string
}

const defaults: AppConfig = {
  agentResources: [],
  channels: [],
  channelsMigrated: false,
  favWorkspacesMigrated: false,

  workspaceDir: "",
  favoriteWorkspaces: [],
  favoriteModels: [],
  autoStart: false,
  setupComplete: false,
  httpProxy: "",
  httpsProxy: "",
  noProxy: "localhost,127.0.0.1,feishu.cn",
  closeWindowAction: "ask",
  autoUpgradePrompt: true,
  mainChatIds: {},
  daemonPort: 19528,

  gitlabToken: "",
  gitlabHost: "",
  repoRoots: [],
  repoProfiles: [],
  worktreeRoot: "",

  flowHubUrl: "",
  flowHubToken: "",
  flowHubAuthor: "",

  allowOthers: false,
  digitalIdentity: "",
  larkAppId: "",
  larkAppSecret: "",
  larkAppQuickCreated: false,
  larkReceiveId: "",
  model: "auto",
  modelParams: "",
  agentNewSession: false,
  feishuEnabled: false,
  wechatEnabled: false,
  wechatToken: "",
  wechatAccountId: "",
  agentMode: "cli",
  cursorApiKey: "",
  othersModel: "",
  othersModelParams: "",
  taskModel: "",
  taskModelParams: "",
}

let _store: Store<AppConfig> | null = null

function getStore(): Store<AppConfig> {
  if (!_store) {
    _store = new Store<AppConfig>({
      name: "cursor-claw-config",
      // 文件级混淆密钥（历史格式兼容，防手滑翻看）；真实凭据保护靠下方 safeStorage 字段级加密
      encryptionKey: "cursor-claw-desktop-v1",
      defaults,
    })
  }
  return _store
}

// ── 敏感凭据 OS 级加密 ────────────────────────────────────
// App Secret / iLink Token / API Key / GitLab Token 落盘为 enc:v1:<base64> 密文
// （Windows DPAPI / macOS Keychain）；getConfig 读出即明文，调用方无感。
// safeStorage 不可用（部分 Linux 无 keyring）时保持明文，行为同旧版。

const SECRET_PREFIX = "enc:v1:"

function canUseSafeStorage(): boolean {
  try { return safeStorage.isEncryptionAvailable() } catch { return false }
}

function sealSecret(value: string | undefined): string | undefined {
  if (!value || value.startsWith(SECRET_PREFIX) || !canUseSafeStorage()) return value
  try {
    return SECRET_PREFIX + safeStorage.encryptString(value).toString("base64")
  } catch { return value }
}

function openSecret(value: string | undefined): string | undefined {
  if (!value || !value.startsWith(SECRET_PREFIX)) return value
  try {
    return safeStorage.decryptString(Buffer.from(value.slice(SECRET_PREFIX.length), "base64"))
  } catch {
    // OS 密钥不可用（换机/换用户）：密文无法还原，视为未配置
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

/** 读侧解密（含旧顶层字段：迁移路径仍需可读） */
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

/** 写侧加密：仅处理本次要写的敏感键 */
function sealPartialSecrets(partial: Partial<AppConfig>): Partial<AppConfig> {
  const out = { ...partial }
  if (out.channels) out.channels = mapChannelSecrets(out.channels, sealSecret)!
  if (out.agentResources) out.agentResources = mapResourceSecrets(out.agentResources, sealSecret)!
  if (out.gitlabToken !== undefined) out.gitlabToken = sealSecret(out.gitlabToken) ?? ""
  if (out.flowHubToken !== undefined) out.flowHubToken = sealSecret(out.flowHubToken) ?? ""
  if (out.larkAppSecret !== undefined) out.larkAppSecret = sealSecret(out.larkAppSecret) ?? ""
  if (out.wechatToken !== undefined) out.wechatToken = sealSecret(out.wechatToken) ?? ""
  if (out.cursorApiKey !== undefined) out.cursorApiKey = sealSecret(out.cursorApiKey) ?? ""
  return out
}

/** 启动时一次性把存量明文凭据加密落盘（app ready 后调用；不可用则跳过） */
export function migrateSecretsToSafeStorage(): void {
  if (!canUseSafeStorage()) return
  const raw = getStore().store
  const plain = (v?: string) => !!v && !v.startsWith(SECRET_PREFIX)
  const dirty = (raw.channels ?? []).some((c) => plain(c.larkAppSecret) || plain(c.wechatToken))
    || (raw.agentResources ?? []).some((r) => plain(r.apiKey))
    || plain(raw.gitlabToken) || plain(raw.flowHubToken) || plain(raw.larkAppSecret) || plain(raw.wechatToken) || plain(raw.cursorApiKey)
  if (!dirty) return
  getStore().set(sealPartialSecrets({
    channels: raw.channels,
    agentResources: raw.agentResources,
    gitlabToken: raw.gitlabToken,
    flowHubToken: raw.flowHubToken,
    larkAppSecret: raw.larkAppSecret,
    wechatToken: raw.wechatToken,
    cursorApiKey: raw.cursorApiKey,
  }) as unknown as AppConfig)
}

export function getConfig(): AppConfig {
  const cfg = openConfigSecrets({ ...defaults, ...getStore().store })
  const fav = dedupeFavoriteWorkspaces(cfg.favoriteWorkspaces)
  if (fav.length !== (cfg.favoriteWorkspaces?.length ?? 0)) {
    getStore().set({ favoriteWorkspaces: fav } as unknown as AppConfig)
    cfg.favoriteWorkspaces = fav
  } else {
    cfg.favoriteWorkspaces = fav
  }
  // 读取时还原被 path.normalize 拧坏的远程 URL，避免设置页继续展示/回写脏路径
  if (cfg.repoProfiles?.length) {
    cfg.repoProfiles = cfg.repoProfiles.map((p) => ({ ...p, path: normalizeRepoPath(p.path) }))
  }
  if (cfg.repoRoots?.length) {
    cfg.repoRoots = cfg.repoRoots.map((r) => normalizeRepoPath(r))
  }
  return cfg
}

export function saveConfig(partial: Partial<AppConfig>): void {
  const cleaned = Object.fromEntries(
    Object.entries(partial).filter(([, v]) => v !== undefined),
  ) as Partial<AppConfig>
  if (cleaned.favoriteWorkspaces) {
    cleaned.favoriteWorkspaces = dedupeFavoriteWorkspaces(cleaned.favoriteWorkspaces)
  }
  // 压平 D:\\foo 双反斜杠脏输入；远程 URL 绝不能 path.normalize（Windows 会把 / 拧成 \\）
  if (cleaned.worktreeRoot?.trim()) cleaned.worktreeRoot = path.normalize(cleaned.worktreeRoot.trim())
  if (cleaned.repoRoots) cleaned.repoRoots = cleaned.repoRoots.map((r) => normalizeRepoPath(r)).filter(Boolean)
  if (cleaned.repoProfiles) {
    cleaned.repoProfiles = cleaned.repoProfiles
      .filter((p) => p?.path?.trim())
      .map((p) => ({ ...p, path: normalizeRepoPath(p.path) }))
  }
  if (Object.keys(cleaned).length > 0) {
    // electron-store 的 set(object) 重载要求完整 AppConfig，实际支持部分键合并
    getStore().set(sealPartialSecrets(cleaned) as unknown as AppConfig)
  }
}

/** 工作目录路径比较键：解析 + 去尾部分隔符 + 小写 */
export function workspacePathKey(p: string): string {
  try {
    return path.resolve(p.trim()).replace(/[\\/]+$/, "").toLowerCase()
  } catch {
    return p.trim().replace(/[\\/]+$/, "").toLowerCase()
  }
}

/** 常用目录去重（同路径不同写法只留一条） */
export function dedupeFavoriteWorkspaces(dirs: string[] | undefined): string[] {
  const map = new Map<string, string>()
  for (const raw of dirs ?? []) {
    const d = raw?.trim()
    if (!d) continue
    const key = workspacePathKey(d)
    if (!map.has(key)) {
      try { map.set(key, path.resolve(d)) } catch { map.set(key, d) }
    }
  }
  return [...map.values()]
}

export function isSameWorkspacePath(a: string, b: string): boolean {
  return workspacePathKey(a) === workspacePathKey(b)
}

// ── 通道 / 资源 工具 ──────────────────────────────────────

export const CLI_RESOURCE_ID = "cli"

export function newChannelId(): string {
  return `ch_${randomBytes(4).toString("hex")}`
}

export function newSdkResourceId(): string {
  return `sdk_${randomBytes(4).toString("hex")}`
}

export function getChannels(): MessageChannel[] {
  const cfg = getConfig()
  // 旧版本迁移出的通道可能缺少通道级字段，用旧全局值兜底
  return (cfg.channels ?? []).map((c) => ({
    ...c,
    allowOthers: c.allowOthers ?? cfg.allowOthers ?? false,
    digitalIdentity: c.digitalIdentity ?? cfg.digitalIdentity ?? "",
  }))
}

export function getEnabledChannels(): MessageChannel[] {
  return getChannels().filter((c) => c.enabled)
}

export function getChannel(id?: string): MessageChannel | undefined {
  if (!id) return undefined
  return getChannels().find((c) => c.id === id)
}

/** 解析会话所属通道；解析不到时返回 undefined（禁止静默回退到「第一个启用通道」，防微信会话读到飞书配置） */
export function resolveChannelForSession(sessionKey: string): MessageChannel | undefined {
  const id = channelIdFromSessionKey(sessionKey)
  return id ? getChannel(id) : undefined
}

export function getAgentResources(): AgentResource[] {
  const list = getConfig().agentResources ?? []
  if (!list.some((r) => r.id === CLI_RESOURCE_ID)) {
    return [{ id: CLI_RESOURCE_ID, type: "cli", name: "Cursor CLI" }, ...list]
  }
  return list
}

export function getAgentResource(id?: string): AgentResource {
  const cli: AgentResource = { id: CLI_RESOURCE_ID, type: "cli", name: "Cursor CLI" }
  if (!id) return cli
  return getAgentResources().find((r) => r.id === id) ?? cli
}

export function saveChannel(channel: MessageChannel): void {
  const channels = getChannels()
  const idx = channels.findIndex((c) => c.id === channel.id)
  if (idx >= 0) channels[idx] = channel
  else channels.push(channel)
  saveConfig({ channels })
}

export function updateChannel(id: string, partial: Partial<MessageChannel>): MessageChannel | undefined {
  const channels = getChannels()
  const idx = channels.findIndex((c) => c.id === id)
  if (idx < 0) return undefined
  channels[idx] = { ...channels[idx], ...partial }
  saveConfig({ channels })
  return channels[idx]
}

// ── 通道级常用目录 ────────────────────────────────────────
// 全局 favoriteWorkspaces 会让每个通道都列出同一批目录，看起来像会话串了。
// 通道自带列表后各自独立；undefined 表示尚未迁移，读时回退全局。

export function getChannelFavoriteWorkspaces(channel: MessageChannel | undefined): string[] {
  if (channel?.favoriteWorkspaces) return dedupeFavoriteWorkspaces(channel.favoriteWorkspaces)
  return dedupeFavoriteWorkspaces(getConfig().favoriteWorkspaces)
}

export function setChannelFavoriteWorkspaces(channelId: string, dirs: string[]): string[] {
  const next = dedupeFavoriteWorkspaces(dirs)
  updateChannel(channelId, { favoriteWorkspaces: next })
  return next
}

/** 全局常用目录一次性复制到各通道，此后两边独立演进 */
export function migrateFavoriteWorkspacesToChannels(): void {
  const cfg = getConfig()
  if (cfg.favWorkspacesMigrated) return
  const channels = getChannels()
  if (channels.length > 0) {
    const global = dedupeFavoriteWorkspaces(cfg.favoriteWorkspaces)
    const next = channels.map((c) => c.favoriteWorkspaces ? c : { ...c, favoriteWorkspaces: [...global] })
    saveConfig({ channels: next, favWorkspacesMigrated: true })
    return
  }
  saveConfig({ favWorkspacesMigrated: true })
}

export type ModelScenario = "primary" | "others"

/** 解析通道在某场景下的模型（others 留空则跟随主模型） */
export function resolveChannelModel(channel: MessageChannel | undefined, scenario: ModelScenario): { model: string; modelParams: string } {
  if (!channel) return { model: "", modelParams: "" }
  if (scenario === "others" && channel.othersModel?.trim()) {
    return { model: channel.othersModel, modelParams: channel.othersModelParams ?? "" }
  }
  return { model: channel.model ?? "", modelParams: channel.modelParams ?? "" }
}

/** 通道的有效主工作目录（仅通道级，不再回退全局） */
export function effectiveWorkspaceDir(channel?: MessageChannel): string {
  return channel?.workspaceDir?.trim() ?? ""
}

/** CLI/MCP 探测用的 cwd：首个已启用且配置了目录的通道，否则用户主目录 */
export function primaryWorkspaceForCli(): string {
  for (const c of getConfig().channels ?? []) {
    const w = c.workspaceDir?.trim()
    if (c.enabled && w) return w
  }
  return os.homedir()
}

/** 将遗留的全局 workspaceDir 迁移到通道后清空 */
export function retireGlobalWorkspaceDir(): void {
  const cfg = getConfig()
  const globalWs = cfg.workspaceDir?.trim()
  if (!globalWs) return
  const channels = cfg.channels ?? []
  const migrated = channels.map((c) =>
    c.mainUserEnabled && !c.workspaceDir?.trim() ? { ...c, workspaceDir: globalWs } : c,
  )
  const changed = migrated.some((c, i) => c.workspaceDir !== channels[i]?.workspaceDir)
  saveConfig({
    ...(changed ? { channels: migrated } : {}),
    workspaceDir: "",
  })
}

// ── 旧配置迁移 ────────────────────────────────────────────

export interface LegacyMigrationHooks {
  /** 读取微信旧 state.json 的 lastChatId（迁移主用户绑定） */
  readWechatLastChatId?: () => string
  /** 迁移旧 wechat-data 目录到 wechat-data/<channelId> */
  moveWechatDataDir?: (channelId: string) => void
  /** 给 scheduled-tasks.json 中的任务补 channelId / model */
  patchScheduledTasks?: (patch: (t: ScheduledTask) => ScheduledTask) => void
}

/**
 * 把旧的单通道配置（larkApp* / wechat* / agentMode / 模型配置）升级为
 * agentResources + channels 模型。upsert 语义、可重入：
 * - 每种类型只迁移/更新第一个对应通道
 * - Setup 向导完成后会再次调用以同步向导写入的旧字段
 */
export function migrateLegacyConfig(hooks?: LegacyMigrationHooks): void {
  const cfg = getConfig()
  const partial: Partial<AppConfig> = {}

  // Agent 资源
  let resources = [...(cfg.agentResources ?? [])]
  if (!resources.some((r) => r.id === CLI_RESOURCE_ID)) {
    resources = [{ id: CLI_RESOURCE_ID, type: "cli", name: "Cursor CLI" }, ...resources]
  }
  let legacySdkId = resources.find((r) => r.type === "sdk" && r.apiKey === cfg.cursorApiKey?.trim())?.id
  if (cfg.cursorApiKey?.trim() && !legacySdkId) {
    legacySdkId = newSdkResourceId()
    resources.push({ id: legacySdkId, type: "sdk", name: "SDK Key", apiKey: cfg.cursorApiKey.trim() })
  }
  partial.agentResources = resources

  const agentResourceId = cfg.agentMode === "sdk" && legacySdkId ? legacySdkId : CLI_RESOURCE_ID
  const channels = [...(cfg.channels ?? [])]

  const baseModel = {
    model: cfg.model ?? "auto",
    modelParams: cfg.modelParams ?? "",
    othersModel: cfg.othersModel ?? "",
    othersModelParams: cfg.othersModelParams ?? "",
    allowOthers: cfg.allowOthers ?? false,
    digitalIdentity: cfg.digitalIdentity ?? "",
  }

  if (cfg.feishuEnabled && cfg.larkAppId?.trim() && cfg.larkAppSecret?.trim()) {
    const existing = channels.find((c) => c.type === "feishu")
    if (existing) {
      existing.larkAppId = cfg.larkAppId.trim()
      existing.larkAppSecret = cfg.larkAppSecret.trim()
      existing.larkAppQuickCreated = cfg.larkAppQuickCreated
      existing.enabled = true
      if (cfg.larkReceiveId?.trim()) {
        existing.mainUserEnabled = true
        existing.mainUserChatId = cfg.larkReceiveId.trim()
      }
    } else {
      channels.push({
        id: newChannelId(),
        name: "飞书",
        enabled: true,
        type: "feishu",
        larkAppId: cfg.larkAppId.trim(),
        larkAppSecret: cfg.larkAppSecret.trim(),
        larkAppQuickCreated: cfg.larkAppQuickCreated,
        agentResourceId,
        ...baseModel,
        mainUserEnabled: !!cfg.larkReceiveId?.trim(),
        mainUserChatId: cfg.larkReceiveId?.trim() ?? "",
        workspaceDir: "",
      })
    }
  }

  if (cfg.wechatEnabled && cfg.wechatToken?.trim()) {
    const existing = channels.find((c) => c.type === "wechat")
    if (existing) {
      existing.wechatToken = cfg.wechatToken.trim()
      existing.wechatAccountId = cfg.wechatAccountId?.trim() ?? ""
      existing.enabled = true
      const lastChatId = hooks?.readWechatLastChatId?.() ?? ""
      if (lastChatId && !existing.mainUserChatId) {
        existing.mainUserEnabled = true
        existing.mainUserChatId = lastChatId
      }
    } else {
      const id = newChannelId()
      const lastChatId = hooks?.readWechatLastChatId?.() ?? ""
      channels.push({
        id,
        name: "微信",
        enabled: true,
        type: "wechat",
        wechatToken: cfg.wechatToken.trim(),
        wechatAccountId: cfg.wechatAccountId?.trim() ?? "",
        agentResourceId,
        ...baseModel,
        mainUserEnabled: !!lastChatId,
        mainUserChatId: lastChatId,
        workspaceDir: "",
      })
      hooks?.moveWechatDataDir?.(id)
    }
  }

  partial.channels = channels

  // 定时任务补默认通道与旧任务模型
  if (!cfg.channelsMigrated && channels.length > 0) {
    const defaultChannelId = channels[0].id
    hooks?.patchScheduledTasks?.((t) => ({
      ...t,
      channelId: t.channelId || defaultChannelId,
      model: t.model ?? (cfg.taskModel?.trim() || undefined),
      modelParams: t.modelParams ?? (cfg.taskModel?.trim() ? cfg.taskModelParams : undefined),
    }))
  }

  // 旧 mainChatIds（workspaceDir → chatId）迁移为 channelId:workspaceDir 键
  if (!cfg.channelsMigrated && channels.length > 0) {
    const oldIds = cfg.mainChatIds ?? {}
    const newIds: Record<string, string> = {}
    for (const [key, chatId] of Object.entries(oldIds)) {
      if (key.startsWith("ch_") && key.includes(":")) {
        newIds[key] = chatId
      } else {
        newIds[`${channels[0].id}:${key}`] = chatId
      }
    }
    partial.mainChatIds = newIds
  }

  partial.channelsMigrated = true

  // 全局工作目录迁移到已绑主用户但通道目录为空的通道
  const globalWs = (cfg.workspaceDir ?? "").trim()
  if (globalWs) {
    const migrated = channels.map((c) =>
      c.mainUserEnabled && !c.workspaceDir?.trim() ? { ...c, workspaceDir: globalWs } : c,
    )
    if (migrated.some((c, i) => c.workspaceDir !== channels[i].workspaceDir)) {
      partial.channels = migrated
    }
  }

  saveConfig(partial)
}

// ── 主会话 chatId（CLI resume）─────────────────────────────

export function mainChatScopeKey(channelId: string, workspaceDir: string): string {
  return `${channelId}:${workspaceDir}`
}

export function getMainChatIdForScope(scope: string): string {
  return (getConfig().mainChatIds ?? {})[scope]?.trim() || ""
}

export function setMainChatIdForScope(scope: string, chatId: string): void {
  const config = getConfig()
  const ids = { ...(config.mainChatIds ?? {}), [scope]: chatId }
  if (!chatId) delete ids[scope]
  saveConfig({ mainChatIds: ids })
}

export type RepoProfileCfg = {
  path: string
  baseBranch: string
  testBranch?: string
  developBranch?: string
}

function isRemoteRepoPath(p: string): boolean {
  return /^(https?:\/\/|ssh:\/\/|git@)/i.test((p || "").trim())
}

/** 历史 bug 修复：远程地址曾被 path.resolve 拼成本地形态（D:\ws\https:\gitlab...\repo.git），读取时还原 */
function restoreMangledRemote(p: string): string {
  const m = p.match(/(https?|ssh):[\\/]+(.+)$/i)
  if (m) return `${m[1].toLowerCase()}://${m[2].replace(/\\/g, "/")}`
  const gitAt = p.toLowerCase().indexOf("git@")
  if (gitAt >= 0 && /git@[^\\/]+[:\\/].+$/i.test(p.slice(gitAt))) {
    return p.slice(gitAt).replace(/\\/g, "/")
  }
  return p
}

/** 远程地址保持原文（不做本地 resolve）；本地路径 resolve 规范化 */
function normalizeRepoPath(raw: string): string {
  const t = (raw || "").trim()
  if (!t) return t
  const restored = restoreMangledRemote(t)
  if (isRemoteRepoPath(restored)) return restored
  return path.resolve(restored)
}

/** 去重 key：远程去尾 .git / 斜杠，本地统一小写路径 */
function repoProfileKey(p: string): string {
  const n = normalizeRepoPath(p).toLowerCase()
  if (isRemoteRepoPath(n)) return n.replace(/\.git$/i, "").replace(/[\\/]+$/, "")
  return n
}

export function getRepoProfiles(cfg: AppConfig = getConfig()): RepoProfileCfg[] {
  const profiles = cfg.repoProfiles || []
  if (profiles.length) {
    // 同仓的本地坏形态与还原后的远程地址会得到相同 key：后者优先保留
    const byKey = new Map<string, RepoProfileCfg>()
    for (const p of profiles) {
      if (!p?.path?.trim()) continue
      byKey.set(repoProfileKey(p.path), {
        path: normalizeRepoPath(p.path),
        baseBranch: (p.baseBranch || "main").trim() || "main",
        testBranch: p.testBranch?.trim() || undefined,
        developBranch: p.developBranch?.trim() || undefined,
      })
    }
    return [...byKey.values()]
  }
  return (cfg.repoRoots || []).map((r) => ({
    path: normalizeRepoPath(r),
    baseBranch: "main",
  }))
}

export function upsertRepoProfiles(pairs: RepoProfileCfg[]): void {
  const byKey = new Map<string, RepoProfileCfg>()
  for (const p of [...getRepoProfiles(), ...pairs]) {
    if (!p?.path?.trim()) continue
    byKey.set(repoProfileKey(p.path), {
      path: normalizeRepoPath(p.path),
      baseBranch: (p.baseBranch || "main").trim() || "main",
      testBranch: p.testBranch?.trim() || undefined,
      developBranch: p.developBranch?.trim() || undefined,
    })
  }
  const next = [...byKey.values()]
  saveConfig({ repoProfiles: next, repoRoots: next.map((p) => p.path) })
}

export function removeRepoProfile(index1Based: number): RepoProfileCfg | null {
  const list = getRepoProfiles()
  const idx = index1Based - 1
  if (idx < 0 || idx >= list.length) return null
  const [removed] = list.splice(idx, 1)
  saveConfig({
    repoProfiles: list,
    repoRoots: list.map((p) => p.path),
  })
  return removed
}
