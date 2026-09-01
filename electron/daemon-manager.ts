import { spawn, spawnSync, type ChildProcess } from "node:child_process"
import { randomUUID, randomBytes } from "node:crypto"
import * as http from "node:http"
import * as path from "node:path"
import * as fs from "node:fs"
import * as os from "node:os"
import { app, BrowserWindow, dialog, ipcMain, powerSaveBlocker, shell } from "electron"
import {
  getConfig, saveConfig, type AppConfig,
  getChannels, getEnabledChannels, getChannel,
  updateChannel, migrateLegacyConfig, effectiveWorkspaceDir,
  resolveChannelForSession, getAgentResource, resolveChannelModel,
  getChannelFavoriteWorkspaces, setChannelFavoriteWorkspaces, migrateFavoriteWorkspacesToChannels,
  mainChatScopeKey, setMainChatIdForScope, upsertRepoProfiles, type MessageChannel,
  retireGlobalWorkspaceDir, primaryWorkspaceForCli,
} from "./config-store"
import { parseChatKey, channelIdFromSessionKey, type DaemonChannelConfig, type ChannelStatusInfo } from "../src/shared/channel-types"
import { validateCron, readTasksFromFile, writeTasksToFile, previewCronNextRuns, getNextCronFireLabel } from "./cron-scheduler"
import { pushLog, pushUiLog, broadcastLog, getLogBuffer, clearLogBuffer, escapeLogContentSingleLine } from "./ui-logger"
import { applyProxyEnv, syncMainProcessProxyEnv } from "./agent-cli"
import { createUtf8Decoder, decodeUtf8Chunk, finishUtf8Decoder } from "../src/shared/utf8-stream.js"
import {
  stopAgent as _stopCliAgent,
  isAgentRunning as _isCliAgentRunning, getRunningSessionCount as _getCliRunningCount,
  getAgentChildPid, getSessionAgentCount as _getCliSessionCount, getIndependentTaskStatuses as _getCliTaskStatuses,
  type ChatType,
} from "./agent-launcher"
import { stopAllSdkSessions, resetSdkSessionContext, getSdkSessionCount, getSdkSessionList, checkSdkApiKey, listSdkModels, getSdkSessionDiagnostics, getResumableSummary, switchSdkSessionModel, handlePollPhaseEvent, clearSdkFailStreak } from "./agent-sdk"
import { resetLlmSessionContext, handleLlmPollPhaseEvent, switchLlmSessionModel, clearLlmFailStreak } from "./agent-llm"
import { stopAllLlmSessions, getLlmSessionCount } from "./agent-llm"
import { initSessionModelStore, listQuickModels, getSessionOverride, removeRecentModel } from "../src/shared/session-model-store.js"
import { initHarnessMcpStore } from "../src/shared/harness-mcp-store.js"
import { initHarnessRuleStore } from "../src/shared/harness-rule-store.js"
import { usesLlmRuntime } from "./agent-engine/factory"
import { registerFeishuApp } from "./feishu-register"
import {
  setDaemonPort,
  injectWorkspaceToDir, injectWorkspaceMcpAndRules, clearInjectionCache,
} from "./workspace-injector"
import {
  invalidateMcpEnabledCache,
  getMcpServerList,
  getMcpEnabledMap,
  deleteMcpServer,
  saveMcpServer,
  McpServerEntry,
} from "./mcp-manager"
import { FileCommand, reportCommandResult, handleFeishuModelCommand, handleFeishuMcpCommand, handleFeishuTaskCommand, parseListModelsStdout, type TaskRunFn } from "./command-handler"
import { handleFeishuProjectCommand, handleProjectSyncSignal, fillProjectNewFromText, handleProjectNewSubmit, replySetupHub, executeProjectDelete, archiveProjectGroup } from "./project-commands"
import { isGitRepoRoot } from "./project-worktree"
import { getDefaultNodeGuide } from "./project-prompts"
import {
  fetchCatalog,
  getSyncStatusForCatalogEntry,
  importGroupFromHub,
  importNodeFromHub,
  listHubNodes,
  previewHubItem,
  syncGroupFromHub,
  syncNodeFromHub,
  uploadGroup,
  uploadNode,
} from "./flow-hub-service"
import { exportConfigBundle, importConfigBundle, inspectConfigBundle, getLocalConfigSectionStats, type ConfigSection } from "./config-backup"
import { discoverCursorClawInstalls, migrateFromCursorClaw, inspectCursorClawSections } from "./cursor-claw-migrate"
import { initProjectStore, getProject, getCurrentProject, listProjects, findProjectByGroupChat, getNodeGroups, saveNodeGroups, saveProject, projectGroupIds, parseNodeGroupExport, resolveUniqueNodeGroupId } from "../src/shared/project-store.js"
import { projectIdFromSessionKey, projectSessionKey, DEFAULT_NODE_GROUP_ID, canEnterProjectFromChat } from "../src/shared/project-types.js"
import {
  readGitBranch,
  formatSessionLabel,
  resolveWorkspaceFromSessionKey,
  dirBaseName,
} from "../src/shared/session-label.js"
import { readLockFile, getLockFilePath, httpGet, httpPost, syncActiveSession, getCurrentActiveSession, enqueueToMainSession, enqueueToSession, resolveMainChatId, resolveMainSessionKey } from "./daemon-client"
import {
  isSessionAgentRunning, stopSessionAgent, stopAllSessionAgents,
  dispatchSessionAgents, launchSessionAgent, launchIndependentAgent,
  notifyChatFallback,
  getSessionAgentList, handleChatCommand, clearMessageQueue, getQueueMessages, formatSessionStatusBlock,
  listMainSessionTabs, listDashboardTree, switchMainSession, deleteUserSession, leaveProjectSession,
  pullMergedMessagesFromQueue, isMainUser, extractChatId, chatNameCache,
  fetchChatNames, fetchUserNames, initSessionDispatcher, previousActiveSessionMap,
} from "./session-dispatcher"

export { applyProxyEnv, syncMainProcessProxyEnv, bootstrapProxyEnv, checkCliInstalled, installCli, execAgentSync, execAgentAsync, type ExecAgentOptions as ExecAgentSyncOptions } from "./agent-cli"
export { checkAgentLoggedIn, loginCli } from "./agent-launcher"
export { getLogBuffer } from "./ui-logger"
export { checkSdkApiKey, listSdkModels, noteGlobalSdkError, clearSdkFailStreak } from "./agent-sdk"
export { injectWorkspaceMcpAndRules, injectWorkspaceToDir, clearInjectionCache } from "./workspace-injector"
export { getQueueMessages, clearMessageQueue, deleteQueueMessage } from "./session-dispatcher"


function isAgentRunning(): boolean {
  return _isCliAgentRunning() || getSdkSessionCount() > 0 || getLlmSessionCount() > 0
}

function getRunningSessionCount(): number {
  return _getCliRunningCount() + getSdkSessionCount() + getLlmSessionCount()
}

function getSessionAgentCount(): number {
  return _getCliSessionCount() + getSdkSessionCount() + getLlmSessionCount()
}

async function stopAgent(): Promise<void> {
  const timeout = new Promise<void>((r) => setTimeout(r, 12_000))
  await Promise.race([stopAllSessionAgents(), timeout])
}

function getIndependentTaskStatuses(): Record<string, { running: boolean; pid?: number; startedAt?: number }> {
  const out: Record<string, { running: boolean; pid?: number; startedAt?: number }> = _getCliTaskStatuses()
  for (const s of getSdkSessionList()) {
    if (s.chatType === "task" || s.chatType === "temp") out[s.sessionKey] = { running: true, startedAt: s.startedAt }
  }
  return out
}


const UNIFIED_DAEMON_PREFIX = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}\.\d{3} \[Daemon\] /

function pushDaemonStderrLine(rawLine: string): void {
  const t = rawLine.trim()
  if (!t) return
  if (UNIFIED_DAEMON_PREFIX.test(t)) {
    pushLog(t.replace(/^(\d{4}-\d{2}-\d{2})T(\d{2}:)/, "$1 $2"))
    return
  }
  pushUiLog("Daemon", "WARN", t)
}


export interface DaemonStatus {
  running: boolean
  /** 正在启动中（spawn 到就绪期间），UI 据此显示"启动中"并禁用启动按钮 */
  starting?: boolean
  version?: string
  uptime?: number
  queueLength?: number
  queueCounts?: { pending: number; processing: number }
  hasChatId?: boolean
  agentRunning?: boolean
  agentPid?: number | null
  sessionAgentCount?: number
  cliAvailable?: boolean
  error?: string
  workspaceMismatch?: boolean
  daemonWorkspaceDir?: string
  channels?: ChannelStatusInfo[]
  feishuEnabled?: boolean
  feishuConnected?: boolean
  wechatEnabled?: boolean
  wechatStatus?: string
  wechatReady?: boolean
}

let daemonProcess: ChildProcess | null = null
let statusInterval: NodeJS.Timeout | null = null
let cachedPort: number | null = null
/** 本次由本应用启动成功时 Daemon 所绑定的工作目录（用于目录切换后的状态判断） */
let activeDaemonWorkspaceDir: string | null = null

/** 期望 Daemon 处于运行态：true 时若进程意外退出则自动重启；主动停止/退出应用置 false */
let daemonShouldRun = false
/** 启动进行中（含自动启动/自愈重启），用于向 UI 暴露"启动中"状态 */
let daemonStarting = false
let daemonRestartTimer: NodeJS.Timeout | null = null
let daemonRestartCount = 0
let lastDaemonStartAt = 0
const DAEMON_AUTO_RESTART_DELAY_MS = 3_000
const DAEMON_RESTART_WINDOW_MS = 60_000
const DAEMON_RESTART_MAX = 5

/** 运行期意外退出的自愈重启：带 crash-loop 退避（窗口内超限即停手报警，等待人工介入） */
function scheduleDaemonAutoRestart(exitCode: number | null): void {
  if (!daemonShouldRun) return
  if (daemonRestartTimer) { clearTimeout(daemonRestartTimer); daemonRestartTimer = null }
  const now = Date.now()
  if (now - lastDaemonStartAt > DAEMON_RESTART_WINDOW_MS) daemonRestartCount = 0
  if (daemonRestartCount >= DAEMON_RESTART_MAX) {
    daemonShouldRun = false
    broadcastLog(`[Daemon] 短时间内异常退出 ${daemonRestartCount} 次，已停止自动重启，请检查后在主页手动启动`, "ERROR")
    return
  }
  daemonRestartCount++
  broadcastLog(`[Daemon] 异常退出 (code=${exitCode})，${DAEMON_AUTO_RESTART_DELAY_MS / 1000}s 后自动重启 (第 ${daemonRestartCount}/${DAEMON_RESTART_MAX} 次)`, "WARN")
  daemonRestartTimer = setTimeout(() => {
    daemonRestartTimer = null
    if (!daemonShouldRun) return
    void startDaemon().then((r) => {
      if (!r.ok) broadcastLog(`[Daemon] 自动重启失败: ${r.error}`, "ERROR")
    })
  }, DAEMON_AUTO_RESTART_DELAY_MS)
}

let tempWsClient: import("@larksuiteoapi/node-sdk").WSClient | null = null
let tempConnAbort: (() => void) | null = null

// ── 主用户绑定等待器（daemon armed-bind 模式）──────────────
let bindWaiter: { channelId: string; resolve: (chatId: string) => void } | null = null

function resolveBindWaiter(channelId: string, chatId: string): void {
  if (bindWaiter && bindWaiter.channelId === channelId) {
    const w = bindWaiter
    bindWaiter = null
    w.resolve(chatId)
  }
}

// ── 微信临时连接：等待首条消息（Daemon 未运行时的绑定兜底）──
let wechatTempMgr: { stop: () => Promise<void> } | null = null

async function wechatWaitFirstMessageImpl(token: string, accountId: string, channelId?: string): Promise<{ ok: boolean; chatId?: string; error?: string }> {
  if (wechatTempMgr) { try { await wechatTempMgr.stop() } catch { /* ignore */ } wechatTempMgr = null }
  const dataDir = channelId
    ? path.join(app.getPath("userData"), "wechat-data", channelId)
    : path.join(app.getPath("userData"), "wechat-data")
  const { WeChatManager } = await import("../src/wechat-manager.js")

  return new Promise<{ ok: boolean; chatId?: string; error?: string }>((resolve) => {
    let done = false
    const timer = setTimeout(() => {
      if (done) return; done = true
      wechatTempMgr?.stop().catch(() => {}); wechatTempMgr = null
      resolve({ ok: false, error: "等待超时(5分钟)，请重试" })
    }, 5 * 60_000)

    const mgr = new WeChatManager({
      dataDir,
      log: (level: string, ...args: unknown[]) => console.log(`[main-wechat-temp] [${level}]`, ...args),
      onMessage: (msg: { chatType: string; chatId: string }) => {
        if (done) return
        if (msg.chatType === "p2p" && msg.chatId) {
          done = true; clearTimeout(timer)
          const stateFile = path.join(dataDir, "state.json")
          try {
            let st: Record<string, unknown> = {}
            if (fs.existsSync(stateFile)) st = JSON.parse(fs.readFileSync(stateFile, "utf-8"))
            st.lastChatId = msg.chatId
            if (!fs.existsSync(path.dirname(stateFile))) fs.mkdirSync(path.dirname(stateFile), { recursive: true })
            fs.writeFileSync(stateFile, JSON.stringify(st))
          } catch { /* ignore */ }
          mgr.stop().then(() => { wechatTempMgr = null }).catch(() => { wechatTempMgr = null })
          resolve({ ok: true, chatId: msg.chatId })
        }
      },
    })
    wechatTempMgr = mgr
    mgr.start(token, accountId).catch((err: Error) => {
      if (done) return; done = true; clearTimeout(timer)
      wechatTempMgr = null
      resolve({ ok: false, error: err?.message ?? "连接失败" })
    })
  })
}

function getDaemonEntryPath(): string {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, "daemon", "daemon-entry.mjs")
  }
  const bundled = path.join(app.getAppPath(), "dist-bundle", "daemon-entry.mjs")
  if (fs.existsSync(bundled)) return bundled
  return path.join(app.getAppPath(), "dist", "daemon-entry.js")
}

async function startTempConnection(appId: string, appSecret: string): Promise<{ chatId: string }> {
  stopTempConnection()
  const Lark = await import("@larksuiteoapi/node-sdk")
  return new Promise((resolve, reject) => {
    let settled = false
    // 任何终态（成功/超时/取消/失败）都必须关闭临时连接：飞书按连接负载均衡推送事件，
    // 残留连接会截走 Daemon 正式连接的消息（且在主进程里，重启 Daemon 无法恢复）
    const settle = (fn: () => void) => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      tempConnAbort = null
      if (tempWsClient) {
        try { tempWsClient.close({ force: true }) } catch { /* ignore */ }
        tempWsClient = null
      }
      fn()
    }
    const timeout = setTimeout(() => {
      settle(() => reject(new Error("绑定超时（90秒内未收到飞书私聊消息）")))
    }, 90_000)
    tempConnAbort = () => settle(() => reject(new Error("cancelled")))

    const eventDispatcher = new Lark.EventDispatcher({}).register({
      "im.message.receive_v1": (data: any) => {
        const msg = data?.message
        if ((msg?.chat_type ?? "p2p") !== "p2p") return
        settle(() => resolve({ chatId: msg?.chat_id ?? "" }))
      },
    })

    const wsClient = new Lark.WSClient({ appId, appSecret, loggerLevel: Lark.LoggerLevel.error, autoReconnect: false })
    tempWsClient = wsClient
    wsClient.start({ eventDispatcher })
      .then(() => pushLog("[TEMP_CONN] 飞书临时 WebSocket 连接建立成功"))
      .catch((e: any) => settle(() => reject(new Error(`WebSocket 连接失败: ${e?.message ?? e}`))))
  })
}

function stopTempConnection(): void {
  if (tempConnAbort) { tempConnAbort(); tempConnAbort = null }
  if (tempWsClient) {
    try { tempWsClient.close({ force: true }) } catch { /* ignore */ }
    tempWsClient = null
  }
}



async function httpsPost(url: string, body: object, headers: Record<string, string> = {}, timeoutMs = 5000): Promise<any> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return res.json().catch(() => null)
}

async function httpsGet(url: string, headers: Record<string, string> = {}, timeoutMs = 8000): Promise<any> {
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(timeoutMs) })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return res.json().catch(() => null)
}

/** 用凭据获取飞书机器人应用信息（app_name / open_id），凭据无效时返回错误 */
async function fetchLarkBotInfo(appId: string, appSecret: string): Promise<{ ok: boolean; name?: string; openId?: string; error?: string }> {
  try {
    const tokenResp = await httpsPost("https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal", {
      app_id: appId, app_secret: appSecret,
    })
    const token = tokenResp?.tenant_access_token
    if (!token) return { ok: false, error: tokenResp?.msg || "凭据无效（获取 token 失败）" }
    const botResp = await httpsGet("https://open.feishu.cn/open-apis/bot/v3/info", { Authorization: `Bearer ${token}` })
    const bot = botResp?.bot
    if (!bot?.app_name) return { ok: false, error: botResp?.msg || "未获取到机器人信息（请确认已开启机器人能力）" }
    return { ok: true, name: bot.app_name, openId: bot.open_id }
  } catch (e: any) {
    return { ok: false, error: e?.message ?? "请求失败" }
  }
}

async function larkSendTestMessage(channel: MessageChannel, receiveId: string): Promise<void> {
  if (!channel.larkAppId || !channel.larkAppSecret) throw new Error("飞书凭据未配置")
  const tokenResp = await httpsPost("https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal", {
    app_id: channel.larkAppId,
    app_secret: channel.larkAppSecret,
  })
  const token = tokenResp?.tenant_access_token
  if (!token) throw new Error("获取 access_token 失败")
  const sendResp = await httpsPost(
    `https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=chat_id`,
    { receive_id: receiveId, msg_type: "interactive", content: JSON.stringify({ schema: "2.0", config: { wide_screen_mode: true }, body: { elements: [{ tag: "markdown", content: "🔗 绑定测试成功！连接正常。" }] } }) },
    { Authorization: `Bearer ${token}` },
  )
  if (sendResp?.code !== 0) throw new Error(sendResp?.msg || "发送失败")
}

async function wechatSendTestMessage(channel: MessageChannel): Promise<void> {
  if (!channel.wechatToken) throw new Error("微信 Token 未配置")
  const dataDir = path.join(app.getPath("userData"), "wechat-data", channel.id)
  return wechatSendTestMessageRaw(channel.wechatToken, dataDir, channel.mainUserEnabled ? channel.mainUserChatId : "")
}

async function wechatSendTestMessageRaw(token: string, dataDir: string, preferredChatId?: string): Promise<void> {
  if (!token?.trim()) throw new Error("微信 Token 未配置")
  const stateFile = path.join(dataDir, "state.json")
  if (!fs.existsSync(stateFile)) throw new Error("暂无微信交互记录，请先给机器人发一条消息")
  const state = JSON.parse(fs.readFileSync(stateFile, "utf-8"))
  const chatId = preferredChatId?.trim() || (state?.lastChatId as string | undefined)
  if (!chatId) throw new Error("暂无微信交互记录，请先给机器人发一条消息")
  const ctFile = path.join(dataDir, "wechat-ctx-tokens.json")
  if (!fs.existsSync(ctFile)) throw new Error("无会话上下文，请先给机器人发一条消息")
  const ctMap = JSON.parse(fs.readFileSync(ctFile, "utf-8")) as Record<string, string>
  const contextToken = ctMap[chatId]
  if (!contextToken) throw new Error("无会话上下文，请先给机器人发一条消息")
  const clientId = `claw:${Date.now()}-${randomBytes(4).toString("hex")}`
  const uin = Buffer.from(String(randomBytes(4).readUInt32BE(0)), "utf-8").toString("base64")
  const bodyStr = JSON.stringify({
    msg: {
      from_user_id: "", to_user_id: chatId, client_id: clientId,
      message_type: 2, message_state: 2,
      item_list: [{ type: 1, text_item: { text: "🔗 微信测试成功！连接正常。" } }],
      context_token: contextToken,
    },
    base_info: { channel_version: "standalone-0.1.0" },
  })
  const res = await fetch("https://ilinkai.weixin.qq.com/ilink/bot/sendmessage", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "AuthorizationType": "ilink_bot_token",
      "Authorization": `Bearer ${token.trim()}`,
      "Content-Length": String(Buffer.byteLength(bodyStr, "utf-8")),
      "X-WECHAT-UIN": uin,
    },
    body: bodyStr,
  })
  const raw = await res.text()
  if (!res.ok) throw new Error(`微信 API 错误 ${res.status}: ${raw}`)
  try {
    const json = JSON.parse(raw)
    if (json.ret && json.ret !== 0) throw new Error(`微信 API 返回错误: ${json.errmsg ?? raw}`)
  } catch (e) {
    if (e instanceof SyntaxError) return
    throw e
  }
}


export async function getDaemonStatus(): Promise<DaemonStatus> {
  const cfgWs = primaryWorkspaceForCli()

  const statusFromHealth = (port: number, health: Record<string, unknown>): DaemonStatus => {
    cachedPort = port
    setDaemonPort(port)
    const status: DaemonStatus = {
      running: true,
      version: health.version as string,
      uptime: health.uptime as number,
      queueLength: health.queueLength as number,
      queueCounts: health.queueCounts as { pending: number; processing: number } | undefined,
      hasChatId: health.hasChatId as boolean,
      agentRunning: isAgentRunning() || getSessionAgentCount() > 0,
      agentPid: getAgentChildPid(),
      sessionAgentCount: getRunningSessionCount(),
      channels: health.channels as ChannelStatusInfo[] | undefined,
      feishuEnabled: health.feishuEnabled as boolean | undefined,
      feishuConnected: health.feishuConnected as boolean | undefined,
      wechatEnabled: health.wechatEnabled as boolean | undefined,
      wechatStatus: health.wechatStatus as string | undefined,
      wechatReady: health.wechatReady as boolean | undefined,
    }
    return status
  }

  const tryHealth = async (port: number): Promise<DaemonStatus | null> => {
    try {
      const health = await httpGet(`http://127.0.0.1:${port}/health`) as Record<string, unknown>
      if (health.status !== "ok") {
        return null
      }
      return statusFromHealth(port, health)
    } catch {
      return null
    }
  }

  const lock = readLockFile()
  if (lock?.port) {
    const st = await tryHealth(lock.port)
    if (st) {
      const mismatch =
        activeDaemonWorkspaceDir !== null && activeDaemonWorkspaceDir !== cfgWs
      if (mismatch) {
        st.workspaceMismatch = true
        st.daemonWorkspaceDir = activeDaemonWorkspaceDir ?? undefined
      }
      return st
    }
  }

  if (cachedPort) {
    const st = await tryHealth(cachedPort)
    if (st) {
      const mismatch =
        !lock?.port ||
        lock.port !== cachedPort ||
        (activeDaemonWorkspaceDir !== null && activeDaemonWorkspaceDir !== cfgWs)
      if (mismatch) {
        st.workspaceMismatch = true
        st.daemonWorkspaceDir = activeDaemonWorkspaceDir ?? undefined
      }
      return st
    }
  }

  return { running: false, starting: daemonStarting, error: daemonStarting ? undefined : "Daemon 未运行" }
}

function ensureCliConfig(): void {
  try {
    const cliConfigPath = path.join(os.homedir(), ".cursor", "cli-config.json")
    let config: Record<string, unknown> = {}
    if (fs.existsSync(cliConfigPath)) {
      config = JSON.parse(fs.readFileSync(cliConfigPath, "utf-8"))
    }
    const network = (config.network ?? {}) as Record<string, unknown>
    if (network.useHttp1ForAgent !== true) {
      network.useHttp1ForAgent = true
      config.network = network
      if (!config.version) config.version = 1
      if (!config.editor) config.editor = { vimMode: false }
      if (!config.permissions) config.permissions = { allow: [], deny: [] }
      const dir = path.dirname(cliConfigPath)
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
      fs.writeFileSync(cliConfigPath, JSON.stringify(config, null, 2), "utf-8")
    }
  } catch { /* ignore */ }
}

/** 通道是否凭据齐全可下发给 Daemon */
function channelReady(c: MessageChannel): boolean {
  if (!c.enabled) return false
  if (c.type === "feishu") return !!(c.larkAppId?.trim() && c.larkAppSecret?.trim())
  return !!c.wechatToken?.trim()
}

function buildDaemonChannelConfig(c: MessageChannel): DaemonChannelConfig | null {
  if (!channelReady(c)) return null
  return {
    id: c.id,
    name: c.name || (c.type === "feishu" ? "飞书" : "微信"),
    type: c.type,
    appId: c.larkAppId?.trim(),
    appSecret: c.larkAppSecret?.trim(),
    wechatToken: c.wechatToken?.trim(),
    wechatAccountId: c.wechatAccountId?.trim(),
    mainUserEnabled: !!c.mainUserEnabled,
    mainUserChatId: c.mainUserEnabled ? (c.mainUserChatId?.trim() ?? "") : "",
    workspaceDir: c.workspaceDir?.trim() ?? "",
    keepAlive: (c.keepSession ?? true) && (c.persistentPoll ?? true),
    showThinking: c.showThinking ?? true,
    streamKeepPerKind: c.streamKeepPerKind,
    hideThinkingOnFinish: c.hideThinkingOnFinish ?? true,
  }
}

function buildDaemonChannelConfigs(): DaemonChannelConfig[] {
  return getChannels().map(buildDaemonChannelConfig).filter((c): c is DaemonChannelConfig => c !== null)
}

function diffChannelEnabledChanges(prev: MessageChannel[], next: MessageChannel[]): { start: MessageChannel[]; stop: string[] } {
  const prevById = new Map(prev.map((c) => [c.id, c]))
  const nextById = new Map(next.map((c) => [c.id, c]))
  const start: MessageChannel[] = []
  const stop: string[] = []

  for (const c of next) {
    const was = prevById.get(c.id)
    if (!was) {
      if (c.enabled && channelReady(c)) start.push(c)
      continue
    }
    if (was.enabled && !c.enabled) stop.push(c.id)
    else if (!was.enabled && c.enabled && channelReady(c)) start.push(c)
  }
  for (const c of prev) {
    if (!nextById.has(c.id) && c.enabled) stop.push(c.id)
  }
  return { start, stop }
}

async function applyChannelLifecycleChanges(prev: MessageChannel[], next: MessageChannel[]): Promise<void> {
  const { start, stop } = diffChannelEnabledChanges(prev, next)
  if (start.length === 0 && stop.length === 0) return
  const port = cachedPort ?? readLockFile()?.port
  if (!port) return
  for (const id of stop) {
    try {
      await httpPost(`http://127.0.0.1:${port}/api/channel-lifecycle`, { action: "stop", id }, 5000)
    } catch (e: unknown) {
      broadcastLog(`[Channels] 通道停用失败(${id}): ${e instanceof Error ? e.message : e}`, "WARN")
    }
  }
  for (const c of start) {
    const cfg = buildDaemonChannelConfig(c)
    if (!cfg) continue
    try {
      await httpPost(`http://127.0.0.1:${port}/api/channel-lifecycle`, { action: "start", channel: cfg }, 10000)
    } catch (e: unknown) {
      broadcastLog(`[Channels] 通道启用失败(${c.name || c.id}): ${e instanceof Error ? e.message : e}`, "WARN")
    }
  }
  broadcastLog(`[Channels] 通道启停已热更新（${stop.length} 停 / ${start.length} 启）`)
  broadcastStatus(await getDaemonStatus())
}

export async function startDaemon(): Promise<{ ok: boolean; error?: string }> {
  if (daemonRestartTimer) { clearTimeout(daemonRestartTimer); daemonRestartTimer = null }
  const config = getConfig()
  const channelConfigs = buildDaemonChannelConfigs()
  if (channelConfigs.length === 0) {
    return { ok: false, error: "至少需要配置一个可用的消息通道（设置 → 消息通道）" }
  }
  const wsFallback = primaryWorkspaceForCli()

  ensureCliConfig()

  const existingStatus = await getDaemonStatus()
  if (existingStatus.running) {
    if (daemonProcess) {
      startStatusPolling()
      return { ok: true }
    }
    try {
      const lock = readLockFile()
      const portToShutdown = lock?.port ?? cachedPort
      if (portToShutdown) {
        await httpPost(`http://127.0.0.1:${portToShutdown}/shutdown`, {})
        await new Promise((r) => setTimeout(r, 1500))
      }
    } catch { /* ignore orphan cleanup */ }
  }

  // 强制清理旧 lock，确保 waitForLockFile 不会读到残留数据
  try { fs.unlinkSync(getLockFilePath()) } catch { /* ok if absent */ }

  const entryPath = getDaemonEntryPath()
  if (!fs.existsSync(entryPath)) {
    return { ok: false, error: `Daemon 入口文件不存在: ${entryPath}` }
  }

  daemonStarting = true
  broadcastStatus({ running: false, starting: true })

  try {
    const templateDir = app.isPackaged
      ? path.join(process.resourcesPath, "template")
      : path.join(app.getAppPath(), "resources", "template")

    const env: Record<string, string> = {
      ...process.env as Record<string, string>,
      LARK_WORKSPACE_DIR: wsFallback,
      APP_DATA_DIR: app.getPath("userData"),
      LK_HARNESS_TEMPLATE_DIR: templateDir,
      NODE_USE_ENV_PROXY: "1",
      CLAW_CHANNELS_JSON: JSON.stringify(channelConfigs),
      ...(config.daemonPort ? { LARK_DAEMON_PORT: String(config.daemonPort) } : {}),
    }
    applyProxyEnv(env, config)

    let earlyOutput = ""
    let earlyExit: number | null = null
    let daemonStdoutBuf = ""
    let daemonStderrBuf = ""
    const daemonOutDec = createUtf8Decoder()
    const daemonErrDec = createUtf8Decoder()

    daemonProcess = spawn(process.execPath, [entryPath], {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      env: { ...env, ELECTRON_RUN_AS_NODE: "1" },
    })

    daemonProcess.stdout?.on("data", (d: Buffer) => {
      const chunk = decodeUtf8Chunk(daemonOutDec, d)
      earlyOutput += chunk
      daemonStdoutBuf += chunk
      const parts = daemonStdoutBuf.split(/\r?\n/)
      daemonStdoutBuf = parts.pop() ?? ""
      for (const raw of parts) {
        const line = raw.trim()
        if (!line || line.startsWith("[info]:")) continue
        if (line.startsWith("__PROJECT_NOTIFY__:")) {
          try {
            const { chatId, text, buttons, footer, filePath, sessionKey } = JSON.parse(line.slice("__PROJECT_NOTIFY__:".length)) as {
              chatId: string; text: string; buttons?: { label: string; cmd: string; section?: string }[]; footer?: string; filePath?: string; sessionKey?: string
            }
            if (chatId && text) {
              const port = cachedPort ?? readLockFile()?.port
              const body = footer ? `${text}\n\n---\n${footer}` : text
              if (port) {
                void (async () => {
                  // 先发产物文件再发结论卡；出站均登记项目会话——用户引用文件/卡片回复时路由回项目会话
                  if (filePath && fs.existsSync(filePath)) {
                    await httpPost(`http://127.0.0.1:${port}/api/send-file`, {
                      file_path: filePath, session_key: sessionKey || chatId,
                    }, 15000).catch(() => {})
                  }
                  await reportCommandResult(port, "", true, body, chatId, buttons, sessionKey ? { sessionKey } : undefined)
                })()
              } else {
                void notifyChatFallback(chatId, body)
              }
            }
          } catch { /* ignore */ }
          continue
        }
        if (line.startsWith("__PROJECT_SYNC__:")) {
          try {
            const payload = JSON.parse(line.slice("__PROJECT_SYNC__:".length))
            void handleProjectSyncSignal(payload)
          } catch { /* ignore */ }
          continue
        }
        if (line.startsWith("__PROJECT_NEW_FILL__:")) {
          try {
            const payload = JSON.parse(line.slice("__PROJECT_NEW_FILL__:".length)) as {
              chatId: string; messageId: string; text: string
            }
            const port = cachedPort ?? readLockFile()?.port
            if (port && payload.chatId && payload.messageId) {
              void fillProjectNewFromText(port, payload.messageId, payload.chatId, payload.text || "")
            }
          } catch { /* ignore */ }
          continue
        }
        if (line.startsWith("__PROJECT_DELETE__:")) {
          try {
            const { projectId } = JSON.parse(line.slice("__PROJECT_DELETE__:".length)) as { projectId: string }
            if (projectId) {
              const target = getProject(projectId)
              void (async () => {
                await executeProjectDelete(projectId)
                const port = cachedPort ?? readLockFile()?.port
                if (target && port) await archiveProjectGroup(port, target)
              })()
            }
          } catch { /* ignore */ }
          continue
        }
        if (line.startsWith("__PROJECT_PROFILE_UPSERT__:")) {
          void (async () => { try {
            const payload = JSON.parse(line.slice("__PROJECT_PROFILE_UPSERT__:".length)) as {
              path: string; baseBranch: string; testBranch?: string; developBranch?: string
              chatId?: string; messageId?: string
            }
            const port = cachedPort ?? readLockFile()?.port
            // setup 表单提交（带 chatId）：路径必须是 git 根目录，否则拒绝并回错误（原卡置为错误视图）
            if (payload.chatId && !(await isGitRepoRoot(payload.path))) {
              if (port) {
                void reportCommandResult(port, payload.messageId || "", false,
                  `❌ 不是有效 git 根目录，未保存：${payload.path}`, payload.chatId,
                  [{ label: "重新添加", cmd: "/p setup add" }, { label: "返回 setup", cmd: "/p setup" }],
                  payload.messageId ? { patchMessageId: payload.messageId } : undefined)
              }
              return
            }
            upsertRepoProfiles([payload])
            // 单卡多视图：保存后原表单卡直接回到 setup 总览
            if (port && payload.chatId) {
              void replySetupHub(port, payload.messageId || "", payload.chatId, payload.messageId, `✅ 已保存主仓 ${path.basename(payload.path)}`)
            }
          } catch { /* ignore */ } })()
          continue
        }
        if (line.startsWith("__PROJECT_SETUP_FIELD__:")) {
          try {
            const payload = JSON.parse(line.slice("__PROJECT_SETUP_FIELD__:".length)) as {
              kind: "worktree" | "gitlab"; worktreeRoot?: string; gitlabToken?: string; gitlabHost?: string
              chatId?: string; messageId?: string
            }
            const port = cachedPort ?? readLockFile()?.port
            let notice = ""
            if (payload.kind === "worktree" && payload.worktreeRoot) {
              try { if (!fs.existsSync(payload.worktreeRoot)) fs.mkdirSync(payload.worktreeRoot, { recursive: true }) } catch { /* replySetupHub 会显示未变更 */ }
              saveConfig({ worktreeRoot: payload.worktreeRoot })
              notice = `✅ 工作区目录已设为 ${payload.worktreeRoot}`
            } else if (payload.kind === "gitlab") {
              const patch: { gitlabToken?: string; gitlabHost?: string } = {}
              if (payload.gitlabToken && payload.gitlabToken !== "-") patch.gitlabToken = payload.gitlabToken
              if (payload.gitlabHost) patch.gitlabHost = payload.gitlabHost.toLowerCase() === "clear" ? "" : payload.gitlabHost
              if (Object.keys(patch).length) saveConfig(patch)
              notice = "✅ GitLab 配置已更新"
            }
            // 单卡多视图：保存后原表单卡回到 setup 总览
            if (port && payload.chatId) {
              void replySetupHub(port, payload.messageId || "", payload.chatId, payload.messageId, notice)
            }
          } catch { /* ignore */ }
          continue
        }
        if (line.startsWith("__PROJECT_NEW_SUBMIT__:")) {
          try {
            const payload = JSON.parse(line.slice("__PROJECT_NEW_SUBMIT__:".length)) as {
              chatId: string; messageId: string
              name: string; goal: string; repoPath: string; worktreeRoot: string
              baseBranch: string; featureBranch?: string
              storyUrl?: string; relatedDocs?: string; productDocUrl?: string; techDocUrl?: string
              groupId?: string
              groupIds?: string[]
              workspaceType?: string
              chatMode?: string
              existingGroupChatId?: string
              operatorOpenId?: string
              repos?: { repoPath: string; baseBranch: string; testBranch?: string; developBranch?: string }[]
            }
            const port = cachedPort ?? readLockFile()?.port
            if (port && payload.chatId && payload.messageId) {
              void handleProjectNewSubmit(port, payload.messageId, payload.chatId, payload)
            }
          } catch { /* ignore */ }
          continue
        }
        if (line.startsWith("__BIND_RESULT__:")) {
          try {
            const payload = JSON.parse(line.slice("__BIND_RESULT__:".length))
            const chatId = payload.chatId as string | undefined
            const channelId = payload.channelId as string | undefined
            if (chatId && channelId) {
              updateChannel(channelId, { mainUserEnabled: true, mainUserChatId: chatId })
              broadcastLog(`[Bind] 通道 ${channelId} 主用户绑定成功: chat_id=${chatId}`)
              resolveBindWaiter(channelId, chatId)
              BrowserWindow.getAllWindows().forEach((w) => w.webContents.send("bind:result", { ok: true, value: chatId, channelId }))
            }
          } catch { /* ignore */ }
          continue
        }
        if (line.startsWith("__WORKSPACE_SWITCH__:")) {
          try {
            const { dir } = JSON.parse(line.slice("__WORKSPACE_SWITCH__:".length))
            if (dir) void applyWorkspaceSwitch(dir, false, true)
          } catch { /* ignore */ }
          continue
        }
        if (line.startsWith("__WECHAT_QR__:")) {
          const rest = line.slice("__WECHAT_QR__:".length)
          const sep = rest.indexOf(":")
          const channelId = sep > 0 ? rest.slice(0, sep) : ""
          const dataUrl = sep > 0 ? rest.slice(sep + 1) : rest
          BrowserWindow.getAllWindows().forEach((w) => w.webContents.send("wechat:qrcode", dataUrl, channelId))
          continue
        }
        if (line.startsWith("__WECHAT_STATUS__:")) {
          const rest = line.slice("__WECHAT_STATUS__:".length)
          const sep = rest.indexOf(":")
          const channelId = sep > 0 ? rest.slice(0, sep) : ""
          const status = sep > 0 ? rest.slice(sep + 1) : rest
          BrowserWindow.getAllWindows().forEach((w) => w.webContents.send("wechat:status", status, channelId))
          continue
        }
        pushUiLog("Daemon", "INFO", line)
      }
    })

    daemonProcess.stderr?.on("data", (d: Buffer) => {
      const chunk = decodeUtf8Chunk(daemonErrDec, d)
      earlyOutput += chunk
      daemonStderrBuf += chunk
      const parts = daemonStderrBuf.split(/\r?\n/)
      daemonStderrBuf = parts.pop() ?? ""
      for (const raw of parts) {
        pushDaemonStderrLine(raw)
      }
    })

    daemonProcess.on("exit", (code) => {
      earlyExit = code
      daemonProcess = null
      cachedPort = null
      setDaemonPort(null)
      activeDaemonWorkspaceDir = null
      broadcastStatus({ running: false, error: `Daemon 退出 (code=${code})` })
      if (daemonShouldRun) scheduleDaemonAutoRestart(code)
    })

    const lock = await waitForLockFile(15_000, daemonProcess?.pid)
    if (!lock) {
      // 启动失败：清理可能僵死的进程，避免端口/资源泄漏（earlyExit 已退出则无需 kill）
      if (earlyExit === null && daemonProcess && !daemonProcess.killed) {
        try { daemonProcess.kill("SIGKILL") } catch { /* ignore */ }
        daemonProcess = null
      }
      if (earlyExit !== null) {
        return { ok: false, error: `Daemon 进程已退出 (code=${earlyExit})。输出:\n${earlyOutput.slice(-500)}` }
      }
      return { ok: false, error: "Daemon 启动超时（未生成 lock 文件）" }
    }

    cachedPort = lock.port
    setDaemonPort(lock.port)
    activeDaemonWorkspaceDir = wsFallback || null
    daemonShouldRun = true
    lastDaemonStartAt = Date.now()
    startStatusPolling()
    await injectWorkspaceMcpAndRules()
    return { ok: true }
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e)
    return { ok: false, error: `启动失败: ${msg}` }
  } finally {
    daemonStarting = false
  }
}

export async function stopDaemon(): Promise<void> {
  daemonShouldRun = false
  if (daemonRestartTimer) { clearTimeout(daemonRestartTimer); daemonRestartTimer = null }
  stopStatusPolling()
  await stopAgent()
  clearLogBuffer()

  if (cachedPort) {
    try {
      await httpPost(`http://127.0.0.1:${cachedPort}/shutdown`, {})
      await new Promise((r) => setTimeout(r, 500))
    } catch { /* ignore */ }
  }

  if (daemonProcess && !daemonProcess.killed) {
    try { daemonProcess.kill("SIGTERM") } catch { /* ignore */ }
    await new Promise((r) => setTimeout(r, 1000))
    if (daemonProcess && !daemonProcess.killed) {
      try { daemonProcess.kill("SIGKILL") } catch { /* ignore */ }
    }
  }
  daemonProcess = null
  cachedPort = null
  setDaemonPort(null)
  activeDaemonWorkspaceDir = null
  broadcastStatus({
    running: false,
    error: "Daemon 未运行",
    agentRunning: false,
    agentPid: null,
    queueLength: 0,
  })
}

function waitForLockFile(timeoutMs: number, expectedPid?: number): Promise<{ port: number } | null> {
  return new Promise((resolve) => {
    const start = Date.now()
    const check = () => {
      const lock = readLockFile()
      if (lock?.port && (!expectedPid || lock.pid === expectedPid)) {
        resolve(lock)
        return
      }
      if (Date.now() - start > timeoutMs) {
        resolve(null)
        return
      }
      setTimeout(check, 300)
    }
    check()
  })
}

function broadcastStatus(status: DaemonStatus): void {
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send("daemon:status-update", status)
  }
}


let powerSaveBlockerId: number | null = null
let sseReq: http.ClientRequest | null = null
let sseDispatchDebounce: NodeJS.Timeout | null = null

function startDaemonPowerSaveBlock(): void {
  stopDaemonPowerSaveBlock()
  try {
    powerSaveBlockerId = powerSaveBlocker.start("prevent-app-suspension")
  } catch { /* ignore */ }
}

function stopDaemonPowerSaveBlock(): void {
  if (powerSaveBlockerId !== null) {
    try {
      powerSaveBlocker.stop(powerSaveBlockerId)
    } catch { /* ignore */ }
    powerSaveBlockerId = null
  }
}

let sseBackoff = 1_000
const SSE_BACKOFF_MAX = 30_000

function scheduleSseReconnect(req: http.ClientRequest): void {
  if (sseReq !== req) return
  sseReq = null
  setTimeout(() => connectSseQueueEvents(), sseBackoff)
  sseBackoff = Math.min(sseBackoff * 2, SSE_BACKOFF_MAX)
}

function connectSseQueueEvents(): void {
  disconnectSseQueueEvents()
  const lock = readLockFile()
  if (!lock?.port) return
  const url = `http://127.0.0.1:${lock.port}/api/queue-events`
  let buf = ""
  const sseDec = createUtf8Decoder()
  const req = http.get(url, { timeout: 0 }, (res) => {
    sseBackoff = 1_000
    res.on("data", (chunk: Buffer) => {
      buf += decodeUtf8Chunk(sseDec, chunk)
      const lines = buf.split("\n")
      buf = lines.pop() ?? ""
      for (const line of lines) {
        if (!line.startsWith("data: ")) continue
        try {
          const ev = JSON.parse(line.slice(6))
          if (ev.type === "queue-update") {
            if (sseDispatchDebounce) clearTimeout(sseDispatchDebounce)
            sseDispatchDebounce = setTimeout(() => dispatchSessionAgents().catch(() => {}), 300)
          } else if (ev.type === "command-update") {
            void checkAndExecutePendingCommands().catch(() => {})
          } else if (ev.type === "poll-phase" && ev.sessionKey && ev.phase) {
            handlePollPhaseEvent(ev.sessionKey, ev.phase, ev)
            handleLlmPollPhaseEvent(ev.sessionKey, ev.phase, ev)
          }
        } catch { /* ignore */ }
      }
    })
    res.on("end", () => {
      buf += finishUtf8Decoder(sseDec)
      scheduleSseReconnect(req)
    })
  })
  sseReq = req
  req.on("error", () => scheduleSseReconnect(req))
}

function disconnectSseQueueEvents(): void {
  if (sseDispatchDebounce) { clearTimeout(sseDispatchDebounce); sseDispatchDebounce = null }
  if (sseReq) {
    try { sseReq.removeAllListeners(); sseReq.destroy() } catch { /* */ }
    sseReq = null
  }
}


async function consumePackNotify(): Promise<void> {
  try {
    const notifyPath = path.join(app.getPath("userData"), "pack-notify.json")
    if (!fs.existsSync(notifyPath)) return
    const fileText = fs.readFileSync(notifyPath, "utf8").replace(/^\uFEFF/, "")
    const raw = JSON.parse(fileText) as { version?: string; packedAt?: number }
    fs.unlinkSync(notifyPath)
    const lock = readLockFile()
    if (!lock?.port) return
    // 等 daemon HTTP 就绪
    for (let i = 0; i < 20; i++) {
      try {
        await httpGet(`http://127.0.0.1:${lock.port}/health`, 1000)
        break
      } catch {
        await new Promise((r) => setTimeout(r, 500))
      }
    }
    const chatId = await resolveMainChatId(lock.port)
    if (!chatId) {
      broadcastLog("[Pack] 新版已启动，但未找到主用户会话，跳过通知", "WARN")
      return
    }
    const ver = raw.version || "unknown"
    // 清掉 pack 前残留的 .claimed，防重投的旧「打包」指令被再次执行；队列为空时不入队、不主动唤醒
    const mainSk = await resolveMainSessionKey(lock.port, chatId)
    if (mainSk) {
      try {
        await httpPost(`http://127.0.0.1:${lock.port}/api/confirm-claimed`, { session_key: mainSk }, 5000)
      } catch (e: unknown) {
        broadcastLog(`[Pack] 确认 claimed 失败: ${e instanceof Error ? e.message : e}`, "WARN")
      }
    }
    broadcastLog(`[Pack] 新版已启动 v${ver}（已确认 claimed，队列为空不唤醒）`, "INFO")
  } catch (e: unknown) {
    broadcastLog(`[Pack] 启动通知失败: ${e instanceof Error ? e.message : e}`, "WARN")
  }
}

function startStatusPolling(): void {
  stopStatusPolling()
  startDaemonPowerSaveBlock()
  connectSseQueueEvents()
  void consumePackNotify()
  statusInterval = setInterval(async () => {
    try {
      const status = await getDaemonStatus()
      broadcastStatus(status)

      if (status.running && status.queueLength && status.queueLength > 0) {
        await dispatchSessionAgents()
      }

      const sessions = getSessionAgentList()
      if (getEnabledChannels().some((c) => c.type === "feishu")) {
        const uncachedGroups = sessions
          .filter((s) => {
            if (s.chatType !== "group") return false
            const chatId = s.sessionKey.includes("::") ? s.sessionKey.split("::")[0] : s.sessionKey
            return !chatNameCache.has(chatId)
          })
          .map((s) => s.sessionKey.includes("::") ? s.sessionKey.split("::")[0] : s.sessionKey)
        if (uncachedGroups.length > 0) await fetchChatNames(uncachedGroups)

        // open_id 按签发应用分组查询（open_id 是应用维度的，跨应用查询必然失败）
        const uncachedP2p = sessions
          .filter((s) => {
            const openId = "senderOpenId" in s ? s.senderOpenId : undefined
            return s.chatType === "p2p" && openId?.startsWith("ou_") && !chatNameCache.has(openId)
          })
        const byChannel = new Map<string | undefined, string[]>()
        for (const s of uncachedP2p) {
          const openId = "senderOpenId" in s ? s.senderOpenId : undefined
          if (!openId) continue
          const cid = channelIdFromSessionKey(s.sessionKey)
          const list = byChannel.get(cid) ?? []
          list.push(openId)
          byChannel.set(cid, list)
        }
        for (const [cid, ids] of byChannel) await fetchUserNames(ids, cid)
      }

      if (status.running) {
        await checkAndExecutePendingCommands()
      }
    } catch (e: unknown) {
      broadcastLog(`[StatusPoll] 异常: ${e instanceof Error ? e.message : e}`, "ERROR")
    }
  }, 5_000)
}

function stopStatusPolling(): void {
  disconnectSseQueueEvents()
  if (statusInterval) {
    clearInterval(statusInterval)
    statusInterval = null
  }
  stopDaemonPowerSaveBlock()
}

async function resolveCommandSessionKey(chatId?: string, chatType?: string): Promise<string | undefined> {
  if (!chatId) return undefined
  const lock = readLockFile()
  if (lock?.port) {
    const active = await getCurrentActiveSession(lock.port, chatId)
    if (active) return active
  }
  if (chatType === "p2p" && isMainUser(chatId, chatType)) {
    const channel = getChannel(parseChatKey(chatId).channelId)
    const wsDir = effectiveWorkspaceDir(channel)
    if (wsDir) return `${chatId}::${wsDir}`
  }
  return chatId
}

/** daemon routing 里该 chat 绑定的 project_ 会话（store 未命中时的兜底） */
async function resolveRoutingProjectSession(port: number, chatId?: string): Promise<string | undefined> {
  if (!chatId) return undefined
  try {
    const res = (await httpGet(`http://127.0.0.1:${port}/api/active-sessions`)) as { sessions?: Record<string, string> }
    const map = res?.sessions ?? {}
    const direct = map[chatId]
    if (direct && projectIdFromSessionKey(direct)) return direct
    const raw = parseChatKey(chatId).chatId
    for (const [k, v] of Object.entries(map)) {
      if (projectIdFromSessionKey(v) && (k === chatId || parseChatKey(k).chatId === raw)) return v
    }
  } catch { /* daemon 未就绪 */ }
  return undefined
}

function resolveResetWorkspaceDir(sessionKey?: string, chatId?: string, chatType?: string): string | undefined {
  if (!sessionKey) return undefined
  if (chatType === "p2p" && isMainUser(chatId, chatType)) {
    const channel = getChannel(parseChatKey(chatId!).channelId)
    return effectiveWorkspaceDir(channel)
  }
  return path.join(app.getPath("userData"), "workspaces", sessionKey.replace(/[^a-zA-Z0-9_-]/g, "_"))
}

async function checkAndExecutePendingCommands(): Promise<void> {
  const lock = readLockFile()
  if (!lock?.port) return

  let commandsRes: { commands?: FileCommand[] }
  try {
    commandsRes = await httpGet(`http://127.0.0.1:${lock.port}/commands`) as { commands?: FileCommand[] }
  } catch { return }

  const cmds = commandsRes.commands
  if (!cmds || cmds.length === 0) return

  for (const cmd of cmds) {
    let claimed: { command: string; messageId: string; chatId?: string; chatType?: string; fromCard?: boolean } | null
    try {
      const claimRes = await httpPost(`http://127.0.0.1:${lock.port}/commands/claim`, { id: cmd.id }) as
        { ok: boolean; command?: string; messageId?: string; chatId?: string; chatType?: string; fromCard?: boolean }
      if (!claimRes.ok) continue
      claimed = { command: claimRes.command!, messageId: claimRes.messageId!, chatId: claimRes.chatId, chatType: claimRes.chatType, fromCard: claimRes.fromCard }
    } catch { continue }

    const rawCmd = claimed.command.trim()
    const cmdTokens = rawCmd.split(/\s+/).filter((t) => t.length > 0)
    const head = (cmdTokens[0] ?? "").toLowerCase()
    initProjectStore(app.getPath("userData"))
    const isAdmin = isMainUser(claimed.chatId, claimed.chatType)
    const cmdSessionKey = await resolveCommandSessionKey(claimed.chatId, claimed.chatType)
    const findProj = findProjectByGroupChat(claimed.chatId)
    const routingSession = await resolveRoutingProjectSession(lock.port, claimed.chatId)
    // 独立群：群内 /p、/m 不应要求主用户私聊管理员；store / cmdSession / routing 任一命中即放行
    const isProjectGroup = !!findProj
      || !!(cmdSessionKey && projectIdFromSessionKey(cmdSessionKey))
      || !!(routingSession && projectIdFromSessionKey(routingSession))
    const reply = (ok: boolean, msg: string, buttons?: { label: string; cmd: string; section?: string }[]) =>
      reportCommandResult(lock.port, claimed!.messageId, ok, msg, claimed!.chatId, buttons, patchTarget ? { patchMessageId: patchTarget } : undefined)
    const denyNonAdmin = () => {
      pushUiLog("Electron", "WARN",
        `[指令] DENY admin cmd=${rawCmd} chatId=${claimed!.chatId ?? "?"} chatType=${claimed!.chatType ?? "?"} findProject=${findProj?.id ?? "none"} cmdSession=${cmdSessionKey ?? "none"} routingSession=${routingSession ?? "none"}`)
      return reply(false, "🔒 该指令仅管理员可用")
    }
    // 原卡更新目标：仅按钮点击来源才 patch（手输指令的 messageId 是用户消息，不可 patch）
    const patchTarget = claimed.fromCard ? claimed.messageId : undefined

    broadcastLog(`[指令] 执行 ${rawCmd} (msgId=${claimed.messageId} admin=${isAdmin})`)
    try {
      switch (head) {
        case "/x":
        case "/stop": {
          const sessionKey = cmdSessionKey
            ?? (routingSession && projectIdFromSessionKey(routingSession) ? routingSession : undefined)
          const sessions = getSessionAgentList()
          const matchedKey = (sessionKey && isSessionAgentRunning(sessionKey) ? sessionKey : undefined)
            ?? sessions.find((s) => isSessionAgentRunning(s.sessionKey)
              && claimed.chatId
              && (s.sessionKey === claimed.chatId || s.sessionKey.startsWith(`${claimed.chatId}::`))
            )?.sessionKey
          if (matchedKey) {
            await stopSessionAgent(matchedKey)
            await reply(true, "✅ 已停止当前对话")
          } else if (isAdmin) {
            const wasRunning = isAgentRunning()
            await stopAgent()
            await reply(true, wasRunning ? "✅ 已停止" : "❌ 当前没有进行中的对话")
          } else {
            await reply(false, "❌ 当前没有进行中的对话")
          }
          break
        }

        case "/s":
        case "/status": {
          const sessionKey = await resolveCommandSessionKey(claimed.chatId, claimed.chatType)
          const sessions = getSessionAgentList()
          const matched = (sessionKey
            ? sessions.find((s) => s.sessionKey === sessionKey)
            : undefined)
            ?? (claimed.chatId
              ? sessions.find((s) => s.sessionKey === claimed.chatId || s.sessionKey.startsWith(`${claimed.chatId}::`))
              : undefined)
          const status = await getDaemonStatus()
          const qMsgs = await getQueueMessages()

          const pid = sessionKey ? projectIdFromSessionKey(sessionKey) : undefined
          const project = pid ? getProject(pid) : undefined
          const wsDir = project?.worktreePath
            || resolveWorkspaceFromSessionKey(sessionKey)
            || (claimed.chatId
              ? effectiveWorkspaceDir(getChannel(parseChatKey(claimed.chatId).channelId) ?? undefined)
              : undefined)
            || getConfig().workspaceDir
            || undefined

          const channel = claimed.chatId
            ? (getChannel(parseChatKey(claimed.chatId).channelId) ?? resolveChannelForSession(sessionKey ?? claimed.chatId))
            : undefined
          const channelModel = channel
            ? resolveChannelModel(channel, isAdmin ? "primary" : "others")
            : { model: "", modelParams: "" }
          // 未运行会话优先取持久化的会话级模型覆盖，仅通道默认作兜底（否则 /m set 后未启动时显示错）
          const override = sessionKey ? getSessionOverride(sessionKey) : undefined
          const effModel = matched?.model || override?.model || channelModel.model
          const effParams = matched?.modelParams ?? override?.modelParams ?? channelModel.modelParams
          if (channel) {
            const resource = getAgentResource(channel.agentResourceId)
            if (resource?.type === "sdk") {
              const { getAgentEngine } = await import("./agent-engine/factory.js")
              await getAgentEngine(resource).listModels?.(resource, channel, effModel, effParams).catch(() => undefined)
            }
          }

          const sessionBlock = formatSessionStatusBlock({
            sessionKey: sessionKey || claimed.chatId || "unknown",
            chatType: claimed.chatType || matched?.chatType,
            workspaceDir: matched?.workspaceDir || wsDir,
            chatName: matched?.chatName,
            pid: matched?.pid,
            model: effModel,
            modelParams: effParams,
            startedAt: matched?.startedAt,
          }, {
            current: true,
            queueMessages: sessionKey
              ? qMsgs.filter((m) => m.sessionKey === sessionKey)
              : qMsgs,
            agentRunning: !!matched,
            showType: false,
            hideWorkspace: !isAdmin,
          })

          if (!isAdmin) {
            await reply(true, sessionBlock)
            break
          }

          const schedTasks = readTasksFromFile()
          const schedTotal = schedTasks.length
          const schedEnabled = schedTasks.filter((t) => t.enabled).length
          if (!channel && claimed.chatId) {
            await reply(false, "❌ 未找到当前对话所属通道")
            break
          }

          const appBlock = [
            "**🏗 应用**",
            `🛡️ 后台服务: ${status.running ? "✅ 运行中" : "❌ 未运行"}`,
            status.version ? `🔄 版本: ${status.version}` : "",
            status.uptime !== undefined ? `⌛️ 运行时间: ${Math.floor(status.uptime / 60)}分钟` : "",
            `⏰ 定时任务: 开启 ${schedEnabled} / 共 ${schedTotal} 条`,
          ].filter(Boolean).join("\n")

          // 会话块首行加粗（formatSessionStatusBlock 返回的首行是 📍 当前对话）
          const sessionLines = sessionBlock.split("\n")
          if (sessionLines[0]) sessionLines[0] = `**${sessionLines[0]}**`
          const sessionMd = sessionLines.join("\n")

          await reportCommandResult(lock.port, claimed!.messageId, true, "状态", claimed!.chatId, undefined, {
            patchMessageId: patchTarget,
            cardTitle: { title: "状态", subtitle: "当前对话" },
            sections: [
              {
                text: appBlock,
                buttons: [{ label: "🔁 重启", cmd: "/restart" }],
              },
              {
                text: `${sessionMd}\n\n💡 直接发消息继续当前对话；引用某条回复可切到对应项目`,
                buttons: [
                  { label: "🔄 刷新", cmd: "/s" },
                  { label: "♻ 重置", cmd: "/r" },
                ],
              },
            ],
          })
          break
        }

        case "/ls":
        case "/list": {
          const msgs = await getQueueMessages()
          const filtered = isAdmin ? msgs : msgs.filter((m) =>
            m.sessionKey === claimed!.chatId || m.sessionKey?.startsWith(claimed!.chatId + "::"))
          if (filtered.length === 0) {
            await reply(true, "📭 暂无排队消息")
          } else {
            const lines = filtered.map((m) => `  [${m.index}] ${m.preview}`)
            await reply(true, `📬 排队中 ${filtered.length} 条：\n${lines.join("\n")}`)
          }
          break
        }

        case "/t":
        case "/task": {
          if (!isAdmin) { await denyNonAdmin(); break }
          await handleFeishuTaskCommand(
            lock.port, claimed.messageId, rawCmd,
            (task, content) => launchIndependentAgent(task.id, task.name, content, "task", undefined, task.channelId, task.model, task.modelParams),
            claimed.chatId,
            async (content, preferredChatId) => enqueueToMainSession(lock.port, content, preferredChatId ?? claimed.chatId),
            patchTarget,
          )
          break
        }

        case "/m":
        case "/model": {
          // 项目专属群内放行（与 /p 一致）：独立群项目的模型切换入口只在群里
          if (!isAdmin && !isProjectGroup) { await denyNonAdmin(); break }
          await handleFeishuModelCommand(lock.port, claimed.messageId, rawCmd, claimed.chatId, patchTarget)
          break
        }

        case "/mc":
        case "/mcp": {
          if (!isAdmin) { await denyNonAdmin(); break }
          await handleFeishuMcpCommand(lock.port, claimed.messageId, rawCmd, claimed.chatId, patchTarget)
          break
        }

        case "/project":
        case "/p": {
          if (!isAdmin && !isProjectGroup) { await denyNonAdmin(); break }
          await handleFeishuProjectCommand(lock.port, claimed.messageId, rawCmd, claimed.chatId, patchTarget)
          break
        }

        case "/rr":
        case "/restart": {
          if (!isAdmin) { await denyNonAdmin(); break }
          await stopAgent()
          const cleared = await clearMessageQueue()
          await reply(true, `✅ 已停止当前对话，清空 ${cleared} 条排队，正在重启…`)
          await stopDaemon()
          await new Promise((r) => setTimeout(r, 1500))
          const result = await startDaemon()
          if (!result.ok) broadcastLog(`[指令] Daemon 重启失败: ${result.error}`, "ERROR")
          break
        }

        case "/cl":
        case "/clean": {
          if (!isAdmin) { await denyNonAdmin(); break }
          const cleared = await clearMessageQueue()
          broadcastLog(`[指令 /clean] 已清空队列 ${cleared} 条`, "INFO")
          await reply(true, `✅ 已清空排队，共移除 ${cleared} 条`)
          break
        }

        case "/r":
        case "/reset": {
          const sessionKey = await resolveCommandSessionKey(claimed.chatId, claimed.chatType)
          if (sessionKey && isSessionAgentRunning(sessionKey)) {
            await stopSessionAgent(sessionKey)
          }
          // SDK / LLM 上下文重置：丢弃 resume 映射，下条消息全新会话
          if (sessionKey) resetSdkSessionContext(sessionKey)
          if (sessionKey) resetLlmSessionContext(sessionKey)
          const wsDir = resolveResetWorkspaceDir(sessionKey, claimed.chatId, claimed.chatType)
          const cmdChannelId = claimed.chatId ? parseChatKey(claimed.chatId).channelId : undefined
          if (wsDir && cmdChannelId) setMainChatIdForScope(mainChatScopeKey(cmdChannelId, wsDir), "")
          broadcastLog(`[指令 /reset] 已重置会话 ${sessionKey ?? claimed.chatId ?? "unknown"}`, "INFO")
          await reply(true, "✅ 当前会话已重置, 请重新发消息开启新会话")
          break
        }

        case "/w":
        case "/workspace": {
          if (!isAdmin) { await denyNonAdmin(); break }
          const wsChannelId = claimed.chatId ? parseChatKey(claimed.chatId).channelId : undefined
          const wsChannel = wsChannelId ? getChannel(wsChannelId) : undefined
          const wsArgs = cmdTokens.slice(1)
          if (wsArgs.length === 0 || wsArgs[0] === "info") {
            const d = effectiveWorkspaceDir(wsChannel) || "(未配置)"
            const b = d !== "(未配置)" ? readGitBranch(d) : undefined
            const info = b ? `📁 当前工作目录: ${d}\n🌿 分支: ${b}` : `📁 当前工作目录: ${d}`
            const favDirs = getChannelFavoriteWorkspaces(wsChannel)
            const lastSeg = (p: string) => p.split(/[\\/]/).filter(Boolean).pop() ?? p
            const wsBtns = favDirs.map((dir) => {
              const parts = dir.split(/[\\/]/).filter(Boolean)
              const name = parts.pop() ?? dir
              const dup = favDirs.some((o) => o !== dir && lastSeg(o) === name)
              const parent = parts.pop()
              const branch = readGitBranch(dir)
              // 有分支优先显示分支；同名目录才用父级消歧
              const short = branch
                ? `${name} · ${branch}`
                : (dup && parent ? `${name}·${parent}` : name)
              return { label: `📂 ${short}`.slice(0, 40), cmd: `/w set ${dir}` }
            })
            const body = wsBtns.length
              ? `${info}\n\n💡 /w set <路径> 可切换目录；也可点下方常用目录`
              : `${info}\n\n💡 /w — 查看当前 · /w set <路径> — 切换`
            await reply(true, body, wsBtns.length ? wsBtns : undefined)
          } else if (wsArgs[0] === "set" && wsArgs.length >= 2) {
            const newDir = wsArgs.slice(1).join(" ").trim()
            if (!wsChannelId) {
              await reply(false, "❌ 无法识别当前通道")
              break
            }
            const curDir = effectiveWorkspaceDir(wsChannel)
            // 项目会话中切目录 = 退出项目、切到目标目录的普通会话（项目 worktree 不受影响）
            const curSk = await resolveCommandSessionKey(claimed!.chatId, claimed!.chatType)
            const inProject = !!(curSk && projectIdFromSessionKey(curSk))
            if (newDir === curDir && !inProject) {
              await reply(true, `📂 工作目录未变化: ${newDir}`)
            } else {
              const wsResult = newDir === curDir
                ? { ok: true as const }
                : await applyChannelWorkspaceSwitch(wsChannelId, newDir, false)
              if (wsResult.ok) {
                if (inProject && claimed!.chatId) {
                  await syncActiveSession(lock.port, claimed!.chatId, `${claimed!.chatId}::${newDir}`)
                }
                broadcastLog(`[指令 /workspace] 已切换到 ${newDir}${inProject ? "（已退出项目会话）" : ""}`, "INFO")
                await reply(true, formatWorkspaceSwitchText(newDir) + (inProject ? "\n\n已退出项目会话，回到该目录的普通会话" : ""))
              } else {
                broadcastLog(`[指令 /workspace] 切换失败: ${(wsResult as { error?: string }).error}`, "ERROR")
                await reply(false, `❌ 切换失败: ${(wsResult as { error?: string }).error}`)
              }
            }
          } else {
            await reply(false, "💡 /w 工作目录（全称 /workspace）\n🔹 /w — 查看当前目录\n🔹 /w set <路径> — 切换工作目录")
          }
          break
        }

        case "/c":
        case "/chat": {
          if (!isAdmin) { await denyNonAdmin(); break }
          await handleChatCommand(cmdTokens, lock.port, claimed!.messageId, claimed!.chatId, patchTarget)
          break
        }

        case "/h":
        case "/help": {
          // 帮助分组：当前对话 / 排队 / 协作 / 系统
          const ctx = [
            { label: "📊 状态", cmd: "/s", section: "▶ 当前对话" },
            { label: "⏹ 停止", cmd: "/x", section: "▶ 当前对话" },
            { label: "🔄 清空上下文", cmd: "/r", section: "▶ 当前对话" },
            { label: "🧠 切换模型", cmd: "/m", section: "▶ 当前对话" },
            { label: "📁 工作目录", cmd: "/w", section: "▶ 当前对话" },
          ]
          const queue = [
            { label: "📋 查看排队", cmd: "/ls", section: "▶ 排队中" },
            { label: "🧹 清空排队", cmd: "/cl", section: "▶ 排队中" },
          ]
          const orch = [
            { label: "💬 会话", cmd: "/c", section: "▶ 协作" },
            { label: "⏰ 任务", cmd: "/t", section: "▶ 协作" },
            { label: "📦 项目", cmd: "/p", section: "▶ 协作" },
          ]
          const infra = [
            { label: "🧩 MCP", cmd: "/mc", section: "▶ 系统" },
            { label: "♻️ 重启应用", cmd: "/rr", section: "▶ 系统" },
          ]
          const helpBtns = isAdmin
            ? [...ctx, ...queue, ...orch, ...infra]
            : ctx.filter((b) => ["/s", "/x", "/r"].includes(b.cmd))
          const body = "💡 点下面按钮或直接发送指令；有下级选项的会先说明用法"
          await reportCommandResult(lock.port, claimed!.messageId, true, body, claimed!.chatId, helpBtns, {
            cardTitle: { title: "帮助", subtitle: "指令" },
            patchMessageId: patchTarget,
          })
          break
        }

        default:
          await reply(false, `😅 未知指令: ${head}`)
      }
    } catch (e: unknown) {
      broadcastLog(`[指令] ${rawCmd} 执行异常: ${e instanceof Error ? e.message : e}`, "ERROR")
      try { await reply(false, `❌ 执行异常: ${e instanceof Error ? e.message : e}`) } catch { /* ignore */ }
    }
  }
}


export interface WorkspaceSessionInfo {
  sessionKey: string
  chatName?: string
}

export interface ConfigSaveResult {
  ok: boolean
  /** 工作目录变更：旧目录下存在活跃会话，需用户选择保留或结束 */
  needWorkspaceConfirm?: boolean
  oldWorkspaceDir?: string
  newWorkspaceDir?: string
  existingSessions?: WorkspaceSessionInfo[]
  /** 因目录冲突未写入 store，完成向导需在切换成功后补写 */
  deferredSetupComplete?: boolean
  /** 本次已将工作目录写入配置；渲染进程应刷新依赖工作区的数据（如 MCP 列表与启用状态） */
  workspaceDirChanged?: boolean
}

/**
 * 切换工作目录：可选地停止旧会话，然后热更新到新目录。
 */
/** 切换指定通道的主用户工作目录（不写全局 config.workspaceDir） */
export async function applyChannelWorkspaceSwitch(
  channelId: string,
  workspaceDir: string,
  stopOldSessions = false,
): Promise<{ ok: boolean; error?: string }> {
  const w = path.normalize(workspaceDir.trim()).replace(/[\\/]+$/, "")
  if (!w) return { ok: false, error: "工作目录为空" }
  if (!/[\\/]/.test(w) || !fs.existsSync(w) || !fs.statSync(w).isDirectory()) {
    return { ok: false, error: `目录不存在或不是有效路径: ${w}` }
  }
  const channel = getChannel(channelId)
  if (!channel) return { ok: false, error: "通道不存在" }
  if (channel.workspaceDir?.trim() === w) return { ok: true }

  if (stopOldSessions) await stopAllSessionAgents()

  updateChannel(channelId, { workspaceDir: w })
  invalidateMcpEnabledCache()
  clearInjectionCache()
  await injectWorkspaceMcpAndRules()
  broadcastStatus(await getDaemonStatus())
  return { ok: true }
}

export async function applyWorkspaceSwitch(workspaceDir: string, stopOldSessions: boolean, skipDaemonSync = false, notifyMain = false): Promise<{ ok: boolean; error?: string }> {
  // path.normalize 压平 D:\\foo（Windows existsSync 对双重反斜杠仍为 true，写入 config/sessionKey 会分裂队列）
  const w = path.normalize(workspaceDir.trim()).replace(/[\\/]+$/, "")
  if (!w) return { ok: false, error: "工作目录为空" }
  if (!/[\\/]/.test(w) || !fs.existsSync(w) || !fs.statSync(w).isDirectory()) {
    return { ok: false, error: `目录不存在或不是有效路径: ${w}` }
  }

  if (stopOldSessions) {
    await stopAllSessionAgents()
  }

  const mainChannel = getChannels().find((c) => c.enabled && c.mainUserEnabled)
  if (mainChannel) {
    return applyChannelWorkspaceSwitch(mainChannel.id, w, false)
  }

  invalidateMcpEnabledCache()
  clearInjectionCache()

  if (!skipDaemonSync) {
    const lock = readLockFile()
    if (lock?.port) {
      try {
        // UI/Electron 路径 = 用户亲手操作，带 confirmed 直接生效；MCP 程序化调用不带则走主用户确认卡
        await httpPost(`http://127.0.0.1:${lock.port}/api/workspace`, { dir: w, confirmed: true })
      } catch (e: unknown) {
        broadcastLog(`[Workspace] Daemon WORKSPACE_DIR 同步失败: ${e instanceof Error ? e.message : e}`, "WARN")
      }
    }
  }

  // Daemon 侧目录已随切换更新，同步内存记录，否则状态检查会误报"目录与设置不一致"
  if (activeDaemonWorkspaceDir !== null) activeDaemonWorkspaceDir = w

  await injectWorkspaceMcpAndRules()
  broadcastStatus(await getDaemonStatus())
  if (notifyMain) void notifyMainUsersWorkspaceSwitched(w)
  return { ok: true }
}

function formatWorkspaceSwitchText(dir: string): string {
  const label = dirBaseName(dir)
  const branch = readGitBranch(dir)
  return [
    `✅ 工作目录已切换`,
    `📁 \`${dir}\``,
    branch ? `🌿 分支: ${branch}` : undefined,
    `📂 ${label} · 会话上下文已切换`,
  ].filter(Boolean).join("\n")
}

async function notifyMainUsersWorkspaceSwitched(dir: string): Promise<void> {
  const lock = readLockFile()
  if (!lock?.port) return
  const text = formatWorkspaceSwitchText(dir)
  for (const c of getConfig().channels ?? []) {
    if (!c.enabled || !c.mainUserEnabled) continue
    const chatId = c.mainUserChatId?.trim()
    if (!chatId) continue
    const sessionKey = `${c.id}|${chatId}`
    try {
      await httpPost(`http://127.0.0.1:${lock.port}/api/send-text`, { text, session_key: sessionKey }, 5000)
    } catch (e: unknown) {
      broadcastLog(`[Workspace] 切换通知发送失败(${c.name || c.id}): ${e instanceof Error ? e.message : e}`, "WARN")
    }
  }
}

function channelConnectionFields(c: MessageChannel): Record<string, string> {
  return {
    type: c.type,
    appId: c.larkAppId ?? "",
    appSecret: c.larkAppSecret ?? "",
    token: c.wechatToken ?? "",
    account: c.wechatAccountId ?? "",
    ws: c.workspaceDir ?? "",
  }
}

/** 已有通道的凭据/工作目录变更才需重启；启停与增删走 lifecycle 热更新 */
function connectionConfigChanged(prev: MessageChannel[], next: MessageChannel[]): boolean {
  const prevById = new Map(prev.map((c) => [c.id, c]))
  for (const nc of next) {
    const oc = prevById.get(nc.id)
    if (!oc) continue
    if (JSON.stringify(channelConnectionFields(oc)) !== JSON.stringify(channelConnectionFields(nc))) return true
  }
  return false
}

/** 运行时可热更新的通道配置（保存后直推 daemon 内存，不重启、不打断会话） */
function channelRuntimeFlags(channels: MessageChannel[]) {
  return channels.filter(channelReady).map((c) => ({
    id: c.id,
    keepAlive: (c.keepSession ?? true) && (c.persistentPoll ?? true),
    showThinking: c.showThinking ?? true,
    streamKeepPerKind: c.streamKeepPerKind,
    hideThinkingOnFinish: c.hideThinkingOnFinish ?? true,
    name: c.name,
    mainUserEnabled: !!c.mainUserEnabled,
    mainUserChatId: c.mainUserEnabled ? (c.mainUserChatId?.trim() ?? "") : "",
  }))
}

async function pushChannelFlagsToDaemon(channels: MessageChannel[]): Promise<void> {
  const port = cachedPort ?? readLockFile()?.port
  if (!port) return
  try {
    await httpPost(`http://127.0.0.1:${port}/api/channel-flags`, { channels: channelRuntimeFlags(channels) }, 5000)
    broadcastLog("[Channels] 保活开关已热更新至 Daemon（无需重启）")
  } catch (e: unknown) {
    broadcastLog(`[Channels] 保活开关热更新失败: ${e instanceof Error ? e.message : String(e)}`, "WARN")
  }
}

export async function saveAppConfigFromRenderer(partial: Partial<AppConfig>): Promise<ConfigSaveResult> {
  const current = getConfig()
  const oldW = (current.workspaceDir || "").trim()
  const nextW = partial.workspaceDir !== undefined ? partial.workspaceDir.trim() : oldW
  const workspaceChanging = partial.workspaceDir !== undefined && nextW !== oldW && oldW !== ""
  const channelsChanging = partial.channels !== undefined
    && connectionConfigChanged(current.channels ?? [], partial.channels)

  if (workspaceChanging) {
    const st = await getDaemonStatus()
    const sessions = st.running ? getSessionAgentList() : []
    // 仅当存在活跃会话时才需要用户确认；无会话直接静默切换
    if (st.running && sessions.length > 0) {
      const deferredSc = partial.setupComplete === true
      const rest: Partial<AppConfig> = { ...partial }
      delete (rest as Record<string, unknown>).workspaceDir
      if (deferredSc) delete (rest as Record<string, unknown>).setupComplete
      saveConfig({ ...rest, workspaceDir: oldW })
      broadcastStatus(await getDaemonStatus())
      return {
        ok: true,
        needWorkspaceConfirm: true,
        oldWorkspaceDir: oldW,
        newWorkspaceDir: nextW,
        existingSessions: sessions.map((s) => ({ sessionKey: s.sessionKey, chatName: s.chatName })),
        deferredSetupComplete: deferredSc,
      }
    }
    if (st.running) {
      const rest: Partial<AppConfig> = { ...partial }
      delete (rest as Record<string, unknown>).workspaceDir
      saveConfig(rest)
      const r = await applyWorkspaceSwitch(nextW, false)
      if (!r.ok) {
        broadcastLog(`[Workspace] 切换失败: ${r.error}`, "ERROR")
        return { ok: false }
      }
      return { ok: true, workspaceDirChanged: true }
    }
  }

  const workspaceDirChanged = partial.workspaceDir !== undefined && nextW !== oldW
  if (workspaceDirChanged) {
    invalidateMcpEnabledCache()
  }

  saveConfig(partial)
  if (partial.httpProxy !== undefined || partial.httpsProxy !== undefined || partial.noProxy !== undefined) {
    syncMainProcessProxyEnv(getConfig())
    void import("./updater").then((m) => m.applyAppNetworkProxy()).catch(() => {})
  }

  if (channelsChanging) {
    // 连接类字段（凭据/启停/工作目录）变化：必须重启 Daemon 重建连接
    const st = await getDaemonStatus()
    if (st.running) {
      broadcastLog("[Channels] 通道连接配置已变更，正在重启 Daemon...")
      void (async () => {
        await stopDaemon()
        await new Promise((r) => setTimeout(r, 800))
        const result = await startDaemon()
        if (!result.ok) broadcastLog(`[Channels] Daemon 重启失败: ${result.error}`, "ERROR")
        broadcastStatus(await getDaemonStatus())
      })()
    }
  } else if (partial.channels !== undefined) {
    const prevChannels = current.channels ?? []
    void applyChannelLifecycleChanges(prevChannels, partial.channels)
    // 仅运行时配置（保活开关等）变化：热推送到 Daemon，不重启、不打断会话
    void pushChannelFlagsToDaemon(partial.channels)
  }

  return { ok: true, ...(workspaceDirChanged ? { workspaceDirChanged: true } : {}) }
}

// ── 初始化 ───────────────────────────────────────────────

/** 旧单通道配置 → channels 模型一次性迁移（应用启动时执行） */
export function runLegacyConfigMigration(): void {
  retireGlobalWorkspaceDir()
  if (getConfig().channelsMigrated) return
  const wechatBase = path.join(app.getPath("userData"), "wechat-data")
  migrateLegacyConfig({
    readWechatLastChatId: () => {
      try {
        return JSON.parse(fs.readFileSync(path.join(wechatBase, "state.json"), "utf-8"))?.lastChatId ?? ""
      } catch { return "" }
    },
    moveWechatDataDir: (channelId: string) => {
      try {
        if (!fs.existsSync(wechatBase)) return
        const dest = path.join(wechatBase, channelId)
        if (fs.existsSync(dest)) return
        fs.mkdirSync(dest, { recursive: true })
        for (const f of fs.readdirSync(wechatBase, { withFileTypes: true })) {
          if (f.isFile()) fs.renameSync(path.join(wechatBase, f.name), path.join(dest, f.name))
        }
        broadcastLog(`[Migrate] 微信数据目录已迁移到 wechat-data/${channelId}`)
      } catch { /* ignore */ }
    },
    patchScheduledTasks: (patch) => {
      const tasks = readTasksFromFile()
      if (tasks.length > 0) writeTasksToFile(tasks.map(patch))
    },
  })
}

/** 应用启动后自动拉起 Daemon（配置就绪时免手动点击）；已在运行则仅接管状态轮询与自愈 */
async function autoStartDaemonOnLaunch(): Promise<void> {
  const status = await getDaemonStatus()
  if (status.running) {
    daemonShouldRun = true
    lastDaemonStartAt = Date.now()
    startStatusPolling()
    return
  }
  const config = getConfig()
  if (!config.setupComplete || buildDaemonChannelConfigs().length === 0) {
    return
  }
  broadcastLog("[Daemon] 应用启动，自动拉起 Daemon…")
  const r = await startDaemon()
  if (!r.ok) broadcastLog(`[Daemon] 自动启动失败: ${r.error}`, "WARN")
  broadcastStatus(await getDaemonStatus())
}

export function initDaemonManager(): void {
  process.env.APP_DATA_DIR = app.getPath("userData")
  initHarnessMcpStore(app.getPath("userData"))
  initHarnessRuleStore(app.getPath("userData"))
  // SDK 跑在主进程：启动时就把代理灌进 process.env（仅 spawn CLI 不够）
  syncMainProcessProxyEnv(getConfig())
  initSessionModelStore(app.getPath("userData"))
  initProjectStore(app.getPath("userData"))
  runLegacyConfigMigration()
  // 必须在 legacy 迁移之后：首次运行时通道由上一步创建
  migrateFavoriteWorkspacesToChannels()
  initSessionDispatcher()
  ipcMain.handle("config:apply-workspace-switch", (_, workspaceDir: string, stopOldSessions: boolean, notifyMain?: boolean) => applyWorkspaceSwitch(workspaceDir, stopOldSessions, false, !!notifyMain))
  ipcMain.handle("daemon:get-log-buffer", () => getLogBuffer())
  ipcMain.handle("agent:stop", async () => { await stopAgent(); return { ok: true } })
  ipcMain.handle("agent:sessions", () => getSessionAgentList())
  ipcMain.handle("diagnostics:session", async (_e, sessionKey: string) => {
    const diag = getSdkSessionDiagnostics(sessionKey)
    let lastReplyAt: number | null = null
    const lock = readLockFile()
    if (lock?.port) {
      try {
        const r = (await httpGet(`http://127.0.0.1:${lock.port}/api/session-last-reply?sessionKey=${encodeURIComponent(sessionKey)}`)) as { lastReplyAt?: number | null }
        lastReplyAt = r?.lastReplyAt ?? null
      } catch { /* daemon 未运行 */ }
    }
    return { ...diag, lastReplyAt }
  })
  ipcMain.handle("diagnostics:export", () => exportDiagnostics())
  ipcMain.handle("bind:test", async (_e, channelId?: string) => {
    // Setup 向导（通道尚未创建）：用旧字段直接测试飞书
    if (!channelId) {
      const cfg = getConfig()
      const chatId = cfg.larkReceiveId?.trim()
      if (!chatId) return { ok: false, error: "未绑定主用户" }
      try {
        await larkSendTestMessage({ larkAppId: cfg.larkAppId, larkAppSecret: cfg.larkAppSecret } as MessageChannel, chatId)
        return { ok: true }
      } catch (e: any) {
        return { ok: false, error: e?.message ?? "发送失败" }
      }
    }
    const channel = getChannel(channelId)
    if (!channel) return { ok: false, error: "通道不存在" }
    try {
      // 优先走运行中的 Daemon（统一处理飞书/微信，含 lastP2pChatId 兜底）
      const lock = readLockFile()
      if (lock?.port) {
        const st = await getDaemonStatus()
        if (st.running && st.channels?.some((c) => c.id === channelId)) {
          const res = await httpPost(`http://127.0.0.1:${lock.port}/channel-test`, { channelId }, 10_000) as { ok?: boolean; error?: string }
          return res?.ok ? { ok: true } : { ok: false, error: res?.error ?? "发送失败" }
        }
      }
      if (channel.type === "feishu") {
        const chatId = channel.mainUserChatId?.trim()
        if (!chatId) return { ok: false, error: "未绑定主用户" }
        await larkSendTestMessage(channel, chatId)
        return { ok: true }
      }
      await wechatSendTestMessage(channel)
      return { ok: true }
    } catch (e: any) {
      return { ok: false, error: e?.message ?? "发送失败" }
    }
  })

  ipcMain.handle("bind:test-wechat", async () => {
    // Setup 向导（通道尚未创建）：旧字段 + 旧数据目录测试微信
    const cfg = getConfig()
    const wechatChannel = getChannels().find((c) => c.type === "wechat")
    try {
      if (wechatChannel?.wechatToken?.trim()) {
        await wechatSendTestMessage(wechatChannel)
      } else {
        await wechatSendTestMessageRaw(cfg.wechatToken, path.join(app.getPath("userData"), "wechat-data"))
      }
      return { ok: true }
    } catch (e: any) {
      return { ok: false, error: e?.message ?? "发送失败" }
    }
  })

  // ── 通道主用户绑定（Daemon armed-bind 优先，临时连接兜底）──
  ipcMain.handle("channel:bind-start", async (_e, channelId: string) => {
    const channel = getChannel(channelId)
    if (!channel) return { ok: false, error: "通道不存在" }

    const st = await getDaemonStatus()
    const lock = readLockFile()
    const viaDaemon = st.running && lock?.port && st.channels?.some((c) => c.id === channelId && c.connected)

    if (viaDaemon) {
      try {
        await httpPost(`http://127.0.0.1:${lock!.port}/channel-bind`, { channelId, arm: true })
      } catch (e: any) {
        return { ok: false, error: e?.message ?? "绑定请求失败" }
      }
      return await new Promise<{ ok: boolean; chatId?: string; error?: string }>((resolve) => {
        const timeout = setTimeout(() => {
          bindWaiter = null
          httpPost(`http://127.0.0.1:${lock!.port}/channel-bind`, { channelId, arm: false }).catch(() => {})
          resolve({ ok: false, error: "绑定超时（90秒内未收到私聊消息）" })
        }, 90_000)
        bindWaiter = { channelId, resolve: (chatId) => { clearTimeout(timeout); resolve({ ok: true, chatId }) } }
      })
    }

    // Daemon 未运行该通道：临时连接兜底
    if (channel.type === "feishu") {
      if (!channel.larkAppId?.trim() || !channel.larkAppSecret?.trim()) {
        return { ok: false, error: "请先填写飞书 App ID 和 App Secret" }
      }
      try {
        const result = await startTempConnection(channel.larkAppId.trim(), channel.larkAppSecret.trim())
        if (result.chatId) {
          updateChannel(channelId, { mainUserEnabled: true, mainUserChatId: result.chatId })
          return { ok: true, chatId: result.chatId }
        }
        return { ok: false, error: "未收到绑定结果" }
      } catch (err: any) {
        return { ok: false, error: err?.message ?? String(err) }
      }
    }

    // wechat：临时管理器等待首条消息（使用通道专属数据目录）
    if (!channel.wechatToken?.trim()) return { ok: false, error: "请先扫码获取微信 Token" }
    const r = await wechatWaitFirstMessageImpl(channel.wechatToken.trim(), channel.wechatAccountId?.trim() ?? "", channelId)
    if (r.ok && r.chatId) {
      updateChannel(channelId, { mainUserEnabled: true, mainUserChatId: r.chatId })
    }
    return r
  })

  ipcMain.handle("channel:bind-cancel", async (_e, channelId: string) => {
    bindWaiter = null
    stopTempConnection()
    if (wechatTempMgr) { try { await wechatTempMgr.stop() } catch { /* ignore */ } wechatTempMgr = null }
    const lock = readLockFile()
    if (lock?.port) {
      httpPost(`http://127.0.0.1:${lock.port}/channel-bind`, { channelId, arm: false }).catch(() => {})
    }
    return { ok: true }
  })

  ipcMain.handle("channel:unbind", (_e, channelId: string) => {
    updateChannel(channelId, { mainUserEnabled: false, mainUserChatId: "" })
    void pushChannelFlagsToDaemon(getChannels())
    return { ok: true }
  })

  ipcMain.handle("feishu:app-info", (_e, appId: string, appSecret: string) =>
    fetchLarkBotInfo(appId?.trim() ?? "", appSecret?.trim() ?? ""))
  ipcMain.handle("agent:stop-session", async (_e, sessionKey: string) => {
    await stopSessionAgent(sessionKey)
    return { ok: true }
  })
  ipcMain.handle("session:set-model", async (_e, sessionKey: string, model: string, modelParams?: string) => {
    const channel = resolveChannelForSession(sessionKey)
    const resource = channel ? getAgentResource(channel.agentResourceId) : undefined
    if (resource && usesLlmRuntime(resource)) {
      return switchLlmSessionModel(sessionKey, model, modelParams)
    }
    return switchSdkSessionModel(sessionKey, model, modelParams)
  })
  ipcMain.handle("session:list-tabs", () => listMainSessionTabs())
  ipcMain.handle("session:dashboard-tree", () => listDashboardTree())
  ipcMain.handle("channel:add-favorite-workspace", (_e, channelId: string, dir: string) => {
    const ch = getChannel(channelId)
    if (!ch) return { ok: false as const, error: "通道不存在" }
    const dirs = [...getChannelFavoriteWorkspaces(ch), dir]
    return { ok: true as const, favoriteWorkspaces: setChannelFavoriteWorkspaces(channelId, dirs) }
  })
  ipcMain.handle("session:switch", (_e, sessionKey: string) => switchMainSession(sessionKey))
  ipcMain.handle("session:delete", async (_e, sessionKey: string) => deleteUserSession(sessionKey))
  ipcMain.handle("project:list", () => {
    initProjectStore(app.getPath("userData"))
    return listProjects().map((p) => ({
      id: p.id,
      name: p.name,
      goal: p.goal,
      storyUrl: p.storyUrl,
      productDocUrl: p.productDocUrl,
      techDocUrl: p.techDocUrl,
      featureBranch: p.featureBranch,
      status: p.status,
      groupId: p.groupId,
      groupIds: p.groupIds,
      worktreePath: p.worktreePath,
      repoPath: p.repoPath,
      workspaceType: p.workspaceType,
      metadata: p.metadata,
      groupChatId: p.groupChatId,
    }))
  })
  ipcMain.handle("project:delete", async (_e, projectId: string) => {
    initProjectStore(app.getPath("userData"))
    const id = String(projectId || "").trim()
    const target = getProject(id)
    if (!target) return { ok: false, error: "项目不存在" }
    const lock = readLockFile()
    const wasCurrent = getCurrentProject()?.id === id
    const sk = target.sessionKey || (lock?.port
      ? projectSessionKey(await resolveMainChatId(lock.port) || "", id)
      : "")
    if (sk) await stopSessionAgent(sk)
    await executeProjectDelete(id)
    if (lock?.port) await archiveProjectGroup(lock.port, target)
    if (wasCurrent && lock?.port) {
      const chatId = await resolveMainChatId(lock.port)
      if (chatId) await leaveProjectSession(lock.port, chatId)
    }
    return { ok: true, name: target.name }
  })
  ipcMain.handle("project:update", (_e, patch: {
    id: string
    name?: string
    goal?: string
    storyUrl?: string
    productDocUrl?: string
    techDocUrl?: string
    status?: string
    groupId?: string
    groupIds?: string[]
    metadata?: Record<string, string>
  }) => {
    initProjectStore(app.getPath("userData"))
    const p = getProject(String(patch?.id || "").trim())
    if (!p) return { ok: false, error: "项目不存在" }
    if (typeof patch.name === "string") {
      const name = patch.name.trim()
      if (!name) return { ok: false, error: "名称不能为空" }
      p.name = name
    }
    if (typeof patch.goal === "string") p.goal = patch.goal.trim()
    if (typeof patch.storyUrl === "string") p.storyUrl = patch.storyUrl.trim() || undefined
    if (typeof patch.productDocUrl === "string") p.productDocUrl = patch.productDocUrl.trim() || undefined
    if (typeof patch.techDocUrl === "string") p.techDocUrl = patch.techDocUrl.trim() || undefined
    if (patch.metadata !== undefined) {
      if (patch.metadata && typeof patch.metadata === "object") {
        const meta: Record<string, string> = {}
        for (const [k, v] of Object.entries(patch.metadata)) {
          if (!k.trim()) continue
          meta[k] = String(v ?? "")
        }
        if (Object.keys(meta).length) p.metadata = meta
        else delete p.metadata
      } else {
        delete p.metadata
      }
    }
    if (typeof patch.status === "string") {
      const st = patch.status.trim()
      if (st === "active" || st === "paused" || st === "done") p.status = st
      else return { ok: false, error: "状态无效" }
    }
    if (Array.isArray(patch.groupIds)) {
      const groups = getNodeGroups()
      const ids = [...new Set(patch.groupIds.map((id) => String(id).trim()).filter(Boolean))]
      for (const gid of ids) {
        if (!groups.some((g) => g.id === gid)) return { ok: false, error: `流程组不存在：${gid}` }
      }
      const resolved = projectGroupIds({ groupIds: ids })
      p.groupIds = resolved
      p.groupId = resolved[0]
    } else if (typeof patch.groupId === "string") {
      const gid = patch.groupId.trim()
      const groups = getNodeGroups()
      if (gid && !groups.some((g) => g.id === gid)) return { ok: false, error: "流程组不存在" }
      if (gid) {
        const resolved = projectGroupIds({ groupId: gid })
        p.groupIds = resolved
        p.groupId = resolved[0]
      } else {
        p.groupId = undefined
        p.groupIds = undefined
      }
    }
    saveProject(p)
    return { ok: true }
  })
  ipcMain.handle("project:switch", async (_e, projectId: string) => {
    initProjectStore(app.getPath("userData"))
    const id = String(projectId || "").trim()
    const p = getProject(id)
    if (!p) return { ok: false, error: "项目不存在" }
    if (p.groupChatId) {
      return { ok: false, error: "该项目为独立群协作，请到飞书专属群内操作（设置页不可切入）" }
    }
    const lock = readLockFile()
    if (!lock?.port) return { ok: false, error: "服务未运行" }
    const chatId = await resolveMainChatId(lock.port)
    if (!chatId) return { ok: false, error: "未绑定主用户" }
    if (!canEnterProjectFromChat(p, chatId)) {
      return { ok: false, error: "该项目为独立群协作，请到专属群内操作" }
    }
    return switchMainSession(projectSessionKey(chatId, id))
  })
  ipcMain.handle("session:list-quick-models", () => {
    initSessionModelStore(app.getPath("userData"))
  initProjectStore(app.getPath("userData"))
    return { ok: true as const, models: listQuickModels(getConfig().favoriteModels ?? [], 8) }
  })
  ipcMain.handle("session:forget-quick-model", (_e, model: string, modelParams?: string) => {
    initSessionModelStore(app.getPath("userData"))
    removeRecentModel({ model, modelParams })
    return { ok: true as const }
  })
  ipcMain.handle("agent:stop-all-sessions", async () => {
    await stopAllSessionAgents()
    return { ok: true }
  })

  ipcMain.handle("temp-conn:start", async (_e, appId: string, appSecret: string) => {
    try {
      const result = await startTempConnection(appId, appSecret)
      return { ok: true, ...result }
    } catch (err: any) {
      return { ok: false, error: err?.message ?? String(err) }
    }
  })
  ipcMain.handle("temp-conn:stop", () => { stopTempConnection(); return { ok: true } })

  // ── WeChat QR code login (runs in main process, not daemon) ──
  let wechatQrAbort: AbortController | null = null

  ipcMain.handle("wechat:qr-login", async () => {
    if (wechatQrAbort) wechatQrAbort.abort()
    wechatQrAbort = new AbortController()
    const signal = wechatQrAbort.signal
    try {
      const { WeChatClient } = await import("../src/wechat/index.js")
      const QRCode = await import("qrcode")
      const tmpClient = new WeChatClient()
      const result = await tmpClient.login({
        signal,
        async onQRCode(url) {
          const dataUrl = await QRCode.toDataURL(url, { width: 280, margin: 2 })
          BrowserWindow.getAllWindows().forEach((w) => w.webContents.send("wechat:setup-qrcode", dataUrl))
        },
        onStatus(status) {
          BrowserWindow.getAllWindows().forEach((w) => w.webContents.send("wechat:setup-status", status))
        },
      })
      wechatQrAbort = null
      if (result.connected) {
        return { ok: true, botToken: result.botToken, accountId: result.accountId, baseUrl: result.baseUrl }
      }
      if (signal.aborted) return { ok: false, error: "cancelled" }
      return { ok: false, error: result.message }
    } catch (err: any) {
      wechatQrAbort = null
      if (err?.name === "AbortError" || signal.aborted) return { ok: false, error: "cancelled" }
      return { ok: false, error: err?.message ?? String(err) }
    }
  })

  ipcMain.handle("wechat:qr-login-cancel", () => {
    if (wechatQrAbort) { wechatQrAbort.abort(); wechatQrAbort = null }
    return { ok: true }
  })

  // ── Feishu one-click app registration (OAuth Device Flow) ──
  let feishuRegisterAbort: AbortController | null = null

  ipcMain.handle("feishu:register-app", async (_e, preset?: { name?: string; desc?: string }) => {
    if (feishuRegisterAbort) feishuRegisterAbort.abort()
    feishuRegisterAbort = new AbortController()
    const signal = feishuRegisterAbort.signal
    try {
      const QRCode = await import("qrcode")
      const result = await registerFeishuApp({
        name: preset?.name?.trim() || "LK Harness",
        desc: preset?.desc?.trim() || "IM Agent 协作助手",
        signal,
        onQrCodeUrl(url) {
          QRCode.toDataURL(url, { width: 280, margin: 2 })
            .then((dataUrl) => {
              BrowserWindow.getAllWindows().forEach((w) =>
                w.webContents.send("feishu:setup-qrcode", dataUrl),
              )
            })
            .catch(() => {})
        },
        onStatus(status) {
          BrowserWindow.getAllWindows().forEach((w) =>
            w.webContents.send("feishu:setup-status", status),
          )
        },
      })
      feishuRegisterAbort = null
      return { ok: true, appId: result.appId, appSecret: result.appSecret }
    } catch (err: unknown) {
      feishuRegisterAbort = null
      if (signal.aborted) return { ok: false, error: "cancelled" }
      const e = err as { message?: string }
      return { ok: false, error: e?.message ?? String(err) }
    }
  })

  ipcMain.handle("feishu:register-app-cancel", () => {
    if (feishuRegisterAbort) {
      feishuRegisterAbort.abort()
      feishuRegisterAbort = null
    }
    return { ok: true }
  })

  // ── Wait for first WeChat message (runs in main process, no daemon) ──

  ipcMain.handle("wechat:wait-first-message", (_e, token: string, accountId: string, channelId?: string) =>
    wechatWaitFirstMessageImpl(token, accountId, channelId))

  ipcMain.handle("wechat:cancel-wait-message", async () => {
    if (wechatTempMgr) { try { await wechatTempMgr.stop() } catch {} wechatTempMgr = null }
    return { ok: true }
  })

  ipcMain.handle("scheduled-tasks:get", () => readTasksFromFile())
  ipcMain.handle("scheduled-tasks:save", (_, tasks) => {
    writeTasksToFile(tasks)
    return { ok: true }
  })
  ipcMain.handle("scheduled-tasks:validate-cron", (_, expression: string) => {
    return validateCron(expression)
  })
  ipcMain.handle("scheduled-tasks:preview-cron", (_, expression: string) => {
    return previewCronNextRuns(expression)
  })

  ipcMain.handle("scheduled-tasks:trigger", async (_, taskId: string) => {
    const tasks = readTasksFromFile()
    const task = tasks.find((t) => t.id === taskId)
    if (!task) return { ok: false, error: "任务不存在" }
    const nowStr = new Date().toLocaleString("zh-CN")
    const content = `[定时任务: ${task.name}] (手动触发: ${nowStr})\n\n${task.content}`
    const lock = readLockFile()
    if (!lock?.port) return { ok: false, error: "守护进程未运行" }
    if (task.independent !== false) {
      clearSdkFailStreak(task.id)
      clearLlmFailStreak(task.id)
      // 与 cron 触发同一套入队逻辑，失败由调度器按队列重拉
      return enqueueToSession(lock.port, task.id, content, "task", {
        channelId: task.channelId,
        model: task.model,
        modelParams: task.modelParams,
      })
    }
    const result = await enqueueToMainSession(lock.port, content, undefined, task.channelId)
    return result
  })

  ipcMain.handle("scheduled-tasks:get-status", () => getIndependentTaskStatuses())

  // ── 项目流程组 ──────────────────────────────────────
  ipcMain.handle("project-node-groups:get", () => {
    initProjectStore(app.getPath("userData"))
    return getNodeGroups().map((g) => ({
      ...g,
      nodes: g.nodes.map((n) => ({ ...n, defaultPrompt: getDefaultNodeGuide(n.id) })),
    }))
  })
  ipcMain.handle("project-node-groups:save", (_e, groups: { id: string; name: string; workspace?: "worktree" | "plain"; nodes: { id: string; label: string; prompt?: string }[] }[]) => {
    initProjectStore(app.getPath("userData"))
    saveNodeGroups(groups)
    return { ok: true }
  })
  ipcMain.handle("project-node-groups:usage", () => {
    initProjectStore(app.getPath("userData"))
    const usage: Record<string, number> = {}
    for (const p of listProjects()) {
      const gid = p.groupId || DEFAULT_NODE_GROUP_ID
      usage[gid] = (usage[gid] ?? 0) + 1
    }
    return usage
  })
  ipcMain.handle("project-node-groups:export", async (_e, groupId: string) => {
    initProjectStore(app.getPath("userData"))
    const group = getNodeGroups().find((g) => g.id === groupId)
    if (!group) return { ok: false, error: "流程组不存在" }
    const win = BrowserWindow.getAllWindows()[0]
    if (!win) return { ok: false, error: "窗口不可用" }
    const result = await dialog.showSaveDialog(win, {
      title: "导出流程组",
      defaultPath: `${group.id}.json`,
      filters: [{ name: "JSON", extensions: ["json"] }],
    })
    if (result.canceled || !result.filePath) return { ok: false, error: "已取消" }
    const envelope = { kind: "lk-harness-node-group", version: 1, group }
    fs.writeFileSync(result.filePath, JSON.stringify(envelope, null, 2), "utf-8")
    return { ok: true, path: result.filePath }
  })
  ipcMain.handle("project-node-groups:import", async () => {
    initProjectStore(app.getPath("userData"))
    const win = BrowserWindow.getAllWindows()[0]
    if (!win) return { ok: false, error: "窗口不可用" }
    const result = await dialog.showOpenDialog(win, {
      title: "导入流程组",
      properties: ["openFile"],
      filters: [{ name: "JSON", extensions: ["json"] }],
    })
    if (result.canceled || !result.filePaths[0]) return { ok: false, error: "已取消" }
    let raw: unknown
    try {
      raw = JSON.parse(fs.readFileSync(result.filePaths[0], "utf-8"))
    } catch {
      return { ok: false, error: "JSON 解析失败" }
    }
    const parsed = parseNodeGroupExport(raw)
    if (!parsed) return { ok: false, error: "不是有效的流程组文件" }
    const groups = getNodeGroups()
    const newId = resolveUniqueNodeGroupId(parsed.id, parsed.name, groups.map((g) => g.id))
    const imported = { ...parsed, id: newId }
    saveNodeGroups([...groups, imported])
    return { ok: true, group: imported }
  })

  ipcMain.handle("config:export", async (_e, sections?: ConfigSection[]) => {
    const win = BrowserWindow.getAllWindows()[0]
    if (!win) return { ok: false, error: "窗口不可用" }
    const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, "")
    const result = await dialog.showSaveDialog(win, {
      title: "导出 LK Harness 配置",
      defaultPath: `lk-harness-config-${stamp}.zip`,
      filters: [{ name: "ZIP", extensions: ["zip"] }],
    })
    if (result.canceled || !result.filePath) return { ok: false, error: "已取消" }
    const r = exportConfigBundle(result.filePath, sections)
    if (!r.ok) return r
    return { ok: true, path: result.filePath }
  })

  ipcMain.handle("config:import", async (_e, sectionsOrPath?: ConfigSection[] | string, sections?: ConfigSection[]) => {
    const win = BrowserWindow.getAllWindows()[0]
    if (!win) return { ok: false, error: "窗口不可用" }

    let filePath: string
    let selected: ConfigSection[] | undefined
    if (typeof sectionsOrPath === "string") {
      filePath = sectionsOrPath
      selected = sections
    } else {
      selected = sectionsOrPath
      const result = await dialog.showOpenDialog(win, {
        title: "导入 LK Harness 配置",
        properties: ["openFile"],
        filters: [{ name: "ZIP", extensions: ["zip"] }],
      })
      if (result.canceled || !result.filePaths[0]) return { ok: false, error: "已取消" }
      filePath = result.filePaths[0]
    }

    const r = importConfigBundle(filePath, selected)
    if (!r.ok) return r
    broadcastLog("[Config] 配置已导入，正在重启 Daemon...")
    await stopDaemon()
    await new Promise((resolve) => setTimeout(resolve, 800))
    const started = await startDaemon()
    if (!started.ok) broadcastLog(`[Config] Daemon 重启失败: ${started.error}`, "ERROR")
    broadcastStatus(await getDaemonStatus())
    return r
  })

  ipcMain.handle("config:pick-import-file", async () => {
    const win = BrowserWindow.getAllWindows()[0]
    if (!win) return { ok: false, error: "窗口不可用" }
    const result = await dialog.showOpenDialog(win, {
      title: "选择要导入的配置包",
      properties: ["openFile"],
      filters: [{ name: "ZIP", extensions: ["zip"] }],
    })
    if (result.canceled || !result.filePaths[0]) return { ok: false, error: "已取消" }
    const inspected = inspectConfigBundle(result.filePaths[0])
    if (!inspected.ok) return inspected
    return { ok: true, filePath: result.filePaths[0], sections: inspected.sections, items: inspected.items }
  })

  ipcMain.handle("config:local-section-stats", () => getLocalConfigSectionStats())

  ipcMain.handle("config:inspect-cursor-claw", (_e, userDataPath?: string) => {
    const pathArg = userDataPath?.trim() || discoverCursorClawInstalls()[0]?.userDataPath
    if (!pathArg) return { ok: false, error: "未检测到本机 Cursor Claw 数据目录" }
    return inspectCursorClawSections(pathArg)
  })

  ipcMain.handle("config:discover-cursor-claw", () => discoverCursorClawInstalls())

  ipcMain.handle("config:migrate-from-cursor-claw", async (_e, userDataPath: string, sections: ConfigSection[]) => {
    const pathArg = String(userDataPath ?? "").trim() || discoverCursorClawInstalls()[0]?.userDataPath
    if (!pathArg) return { ok: false, error: "未检测到本机 Cursor Claw 数据目录" }
    const r = migrateFromCursorClaw(pathArg, sections)
    if (!r.ok) return r
    broadcastLog("[Config] 已从 Cursor Claw 迁移配置，正在重启 Daemon...")
    await stopDaemon()
    await new Promise((resolve) => setTimeout(resolve, 800))
    const started = await startDaemon()
    if (!started.ok) broadcastLog(`[Config] Daemon 重启失败: ${started.error}`, "ERROR")
    broadcastStatus(await getDaemonStatus())
    return r
  })

  ipcMain.handle("flow-hub:get-catalog", async (_e, force?: boolean) => fetchCatalog(!!force))
  ipcMain.handle("flow-hub:list-nodes", async () => listHubNodes())
  ipcMain.handle("flow-hub:get-sync-status", (_e, payload: { kind: "group" | "node"; hubId: string; contentHash: string; hubRevision?: number }) => {
    initProjectStore(app.getPath("userData"))
    return getSyncStatusForCatalogEntry(payload.kind, payload.hubId, payload.contentHash, payload.hubRevision)
  })
  ipcMain.handle("flow-hub:import-group", async (_e, hubId: string) => {
    initProjectStore(app.getPath("userData"))
    return importGroupFromHub(hubId)
  })
  ipcMain.handle("flow-hub:import-node", async (_e, payload: { hubId: string; targetGroupId: string; groupHubId?: string; nodeLocalId?: string }) => {
    initProjectStore(app.getPath("userData"))
    return importNodeFromHub(payload.hubId, payload.targetGroupId, undefined, {
      groupHubId: payload.groupHubId,
      nodeLocalId: payload.nodeLocalId,
    })
  })
  ipcMain.handle("flow-hub:upload-group", async (_e, groupId: string) => {
    initProjectStore(app.getPath("userData"))
    return uploadGroup(groupId)
  })
  ipcMain.handle("flow-hub:upload-node", async (_e, payload: { groupId: string; nodeId: string }) => {
    initProjectStore(app.getPath("userData"))
    return uploadNode(payload.groupId, payload.nodeId)
  })
  ipcMain.handle("flow-hub:sync-group", async (_e, payload: { hubId: string; mode: "overwrite" | "keep" }) => {
    initProjectStore(app.getPath("userData"))
    return syncGroupFromHub(payload.hubId, payload.mode)
  })
  ipcMain.handle("flow-hub:sync-node", async (_e, payload: { hubId: string; targetGroupId: string; mode: "overwrite" | "keep"; groupHubId?: string; nodeLocalId?: string }) => {
    initProjectStore(app.getPath("userData"))
    return syncNodeFromHub(payload.hubId, payload.targetGroupId, payload.mode, undefined, {
      groupHubId: payload.groupHubId,
      nodeLocalId: payload.nodeLocalId,
    })
  })
  ipcMain.handle("flow-hub:preview", async (_e, payload: { kind: "group" | "node"; hubId: string; nodeLocalId?: string }) =>
    previewHubItem(payload.kind, payload.hubId, payload.nodeLocalId))

  void autoStartDaemonOnLaunch()
}

// ── 诊断包导出 ───────────────────────────────────────────

function maskSecret(v?: string): string {
  return v ? `${v.slice(0, 4)}***(len=${v.length})` : ""
}

function tailOfFile(p: string, lines = 400): string {
  try {
    return fs.readFileSync(p, "utf-8").split(/\r?\n/).slice(-lines).join("\n")
  } catch {
    return "(不存在或读取失败)"
  }
}

/** 汇总日志、脱敏配置、会话/队列快照到单个文本文件，供远程排障（凭据不落盘） */
async function exportDiagnostics(): Promise<{ ok: boolean; path?: string; error?: string }> {
  try {
    const dir = path.join(app.getPath("userData"), "diagnostics")
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
    const now = new Date()
    const pad = (n: number) => String(n).padStart(2, "0")
    const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
    const file = path.join(dir, `diagnostics-${stamp}.txt`)

    const config = getConfig()
    const sanitized = {
      ...config,
      larkAppSecret: maskSecret(config.larkAppSecret),
      wechatToken: maskSecret(config.wechatToken),
      cursorApiKey: maskSecret(config.cursorApiKey),
      agentResources: (config.agentResources ?? []).map((r) => ({ ...r, apiKey: maskSecret(r.apiKey) })),
      channels: (config.channels ?? []).map((c) => ({ ...c, larkAppSecret: maskSecret(c.larkAppSecret), wechatToken: maskSecret(c.wechatToken) })),
    }

    const lock = readLockFile()
    let daemonHealth: unknown = null
    let queueSnapshot: unknown = null
    if (lock?.port) {
      daemonHealth = await httpGet(`http://127.0.0.1:${lock.port}/health`).catch(() => null)
      queueSnapshot = await httpGet(`http://127.0.0.1:${lock.port}/queue`).catch(() => null)
    }

    const logsDir = path.join(app.getPath("userData"), "logs")
    const sections = [
      "# LK Harness 诊断包",
      `生成时间: ${now.toISOString()}`,
      `应用版本: ${app.getVersion()}  平台: ${process.platform} ${os.release()}  Electron: ${process.versions.electron}`,
      "",
      "## 配置（凭据已脱敏）",
      JSON.stringify(sanitized, null, 2),
      "",
      "## Daemon 状态",
      JSON.stringify(daemonHealth, null, 2),
      "",
      "## 活跃会话",
      JSON.stringify(getSessionAgentList(), null, 2),
      "",
      "## Resume 映射",
      JSON.stringify(getResumableSummary(), null, 2),
      "",
      "## 消息队列快照",
      JSON.stringify(queueSnapshot, null, 2),
      "",
      "## app.log（尾部 400 行）",
      tailOfFile(path.join(logsDir, "app.log")),
      "",
      "## daemon.log（尾部 400 行）",
      tailOfFile(path.join(logsDir, "daemon.log")),
      "",
    ]
    fs.writeFileSync(file, sections.join("\n"), "utf-8")
    shell.showItemInFolder(file)
    return { ok: true, path: file }
  } catch (e: unknown) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

/**
 * 应用退出前的收尾：等 SDK run 取消落库后再放行退出。
 * fire-and-forget 的 kill 会让活跃 run 永远停在 active 状态（wedged），下次启动只能靠 force 自愈。
 */
export async function shutdownDaemonManager(): Promise<void> {
  daemonShouldRun = false
  if (daemonRestartTimer) { clearTimeout(daemonRestartTimer); daemonRestartTimer = null }
  stopStatusPolling()
  _stopCliAgent()
  await stopAllSdkSessions()
  if (daemonProcess) {
    try { daemonProcess.kill() } catch { /* ignore */ }
    daemonProcess = null
  }
  cachedPort = null
  setDaemonPort(null)
  activeDaemonWorkspaceDir = null
}
