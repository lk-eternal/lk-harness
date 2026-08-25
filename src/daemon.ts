import * as http from "node:http";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import {
  startDaemonScheduledTasks,
  stopDaemonScheduledTasks,
  setDaemonSchedulerLogger,
} from "./daemon-scheduled-tasks.js";
import { stripProxyEnv, localTimestamp, createLarkClient, LarkSender, LarkMessageEvent, LarkCardActionEvent, CardButton, CardInput, CardTitle, cleanupMediaCache } from "./shared/lark-core.js";
import { WeChatManager } from "./wechat-manager.js";
import {
  initFileQueue,
  getQueueDir,
  pushToFileQueue,
  getEarliestMessageTime,
  claimNextMessage,
  claimSessionMessages,
  waitForSessionMessages,
  confirmClaimedMessages,
  getQueueLength as getFileQueueLength,
  getQueueCounts,
  getQueueMessages as getFileQueueMessages,
  deleteQueueMessage as deleteFileQueueMessage,
  deleteQueueMessagesByMessageId,
  getDistinctSessions,
  hasSessionQueueDir,
  cleanupStaleMessages,
  type QueueMessage,
  type QueueMessageMeta,
} from "./file-queue.js";
import { LOCK_FILE_NAME } from "./shared/constants.js";
import {
  makeChatKey,
  parseChatKey,
  chatIdFromSessionKey,
  channelIdFromSessionKey,
  normalizeSessionKey,
  type DaemonChannelConfig,
  type ChannelStatusInfo,
} from "./shared/channel-types.js";
import { disambiguatePathLabel } from "./shared/path-label.js";
import { readScheduledTasksFile, writeScheduledTasksFile, buildNotifySessionKey, isIndependentTaskSessionKey, type ScheduledTask } from "./shared/scheduled-task.js";
import { initSessionModelStore, setSessionOverride } from "./shared/session-model-store.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import { registerAdminTools } from "./server-admin.js";
import { registerProjectAgentTools } from "./server-project.js";
import { initProjectStore, hasProjectNewDraft, getProject, getNodeGroups, listProjects, findProjectByGroupChat, getProjectNewDraft, saveProjectNewDraft, clearProjectNewDraft } from "./shared/project-store.js";
import {
  initClawMcpStore,
  listClawMcpServers,
  saveClawMcpServer,
  deleteClawMcpServer,
  CLAW_MCP_KEY,
  ADMIN_MCP_KEY,
} from "./shared/claw-mcp-store.js";
import {
  initClawRuleStore,
  listClawRules,
  saveClawRule,
  deleteClawRule,
} from "./shared/claw-rule-store.js";
import { projectIdFromSessionKey, decodeRepoPairOption, splitRepoPairValues, isRemoteRepoRef, DEFAULT_NODE_GROUP_ID, formFieldStr, coerceFormMultiSelect } from "./shared/project-types.js";
import { buildSessionCardTitle, isSpecialSessionSuffix, resolveWorkspaceFromSessionKey, sessionHeaderTemplate } from "./shared/session-label.js";

const _require = createRequire(import.meta.url);
const PKG_VERSION: string = (_require("../package.json") as { version: string }).version;

// ── 环境变量 ──────────────────────────────────────────────

const ENCRYPT_KEY = process.env.LARK_ENCRYPT_KEY ?? "";
const CONFIGURED_PORT = process.env.LARK_DAEMON_PORT ? Number(process.env.LARK_DAEMON_PORT) : 0;
let WORKSPACE_DIR = (() => {
  const raw = process.env.LARK_WORKSPACE_DIR ?? process.cwd();
  return /^[A-Za-z]:/.test(raw) ? raw.replace(/\\+/g, "\\") : raw;
})();
const MESSAGE_PREFIX = process.env.LARK_MESSAGE_PREFIX ?? "";
const APP_DATA_DIR = process.env.APP_DATA_DIR || "";

/** 主仓引用规范化：本地路径 normalize，远程地址原样保留 */
function normalizeRepoRef(v: string): string {
  const t = (v || "").trim();
  return isRemoteRepoRef(t) ? t : path.normalize(t);
}

type RepoProfile = { path: string; baseBranch: string; testBranch?: string; developBranch?: string };

function extractProjectFormCache(f: Record<string, unknown>): Record<string, string> {
  return {
    name: formFieldStr(f.name),
    featureBranch: formFieldStr(f.featureBranch),
    worktreeRoot: formFieldStr(f.worktreeRoot),
    storyUrl: formFieldStr(f.storyUrl),
    relatedDocs: formFieldStr(f.relatedDocs),
    chatMode: formFieldStr(f.chatMode),
    existingGroupChatId: formFieldStr(f.existingGroupChatId),
  };
}

function mergeRepoProfiles(base: RepoProfile[], extra: RepoProfile[]): RepoProfile[] {
  const seen = new Set<string>();
  const out: RepoProfile[] = [];
  for (const p of [...base, ...extra]) {
    const key = p.path.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(p);
  }
  return out;
}

function combinedFormRepoProfiles(draft: ReturnType<typeof getProjectNewDraft>): RepoProfile[] {
  if (!draft) return [];
  return mergeRepoProfiles(draft.formRepoProfiles || [], draft.formExtraRepos || []);
}

function parseChannelConfigs(): DaemonChannelConfig[] {
  try {
    const raw = process.env.CLAW_CHANNELS_JSON ?? "";
    if (!raw) return [];
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? (arr as DaemonChannelConfig[]) : [];
  } catch {
    return [];
  }
}

const CHANNEL_CONFIGS = parseChannelConfigs();

// ── 通道运行时开关（支持热更新，不重启 daemon）────────────
const channelKeepAlive = new Map<string, boolean>(
  CHANNEL_CONFIGS.map((c) => [c.id, c.keepAlive ?? true]),
);

interface ChannelRuntimeFlags {
  id: string;
  keepAlive?: boolean;
  showThinking?: boolean;
  streamKeepPerKind?: number;
  hideThinkingOnFinish?: boolean;
  name?: string;
  mainUserEnabled?: boolean;
  mainUserChatId?: string;
}

function updateChannelFlags(flags: ChannelRuntimeFlags[]): void {
  for (const f of flags) {
    if (typeof f.keepAlive === "boolean") channelKeepAlive.set(f.id, f.keepAlive);
    const rt = channels.get(f.id);
    if (!rt) continue;
    if (typeof f.name === "string" && f.name) rt.cfg.name = f.name;
    if (typeof f.showThinking === "boolean") rt.cfg.showThinking = f.showThinking;
    if (typeof f.streamKeepPerKind === "number" && Number.isFinite(f.streamKeepPerKind)) {
      rt.cfg.streamKeepPerKind = f.streamKeepPerKind;
    }
    if (typeof f.hideThinkingOnFinish === "boolean") rt.cfg.hideThinkingOnFinish = f.hideThinkingOnFinish;
    if (typeof f.mainUserEnabled === "boolean") rt.cfg.mainUserEnabled = f.mainUserEnabled;
    if (typeof f.mainUserChatId === "string") rt.cfg.mainUserChatId = f.mainUserChatId;
  }
}

/** 会话收尾模式：poll 响应随路下发（模型以最近一次响应为准，免疫长上下文衰减） */
function resolveKeepAlive(sessionKey: string): boolean {
  if (isIndependentTaskSessionKey(sessionKey, readTasks())) return false;
  let channelId = channelIdFromSessionKey(sessionKey);
  if (!channelId) {
    const chatKey = sessionToChatMap.get(sessionKey);
    if (chatKey) channelId = parseChatKey(chatKey).channelId;
    if (!channelId) {
      const task = readTasks().find((t) => t.id === sessionKey);
      if (task?.channelId) channelId = task.channelId;
    }
  }
  if (channelId) return channelKeepAlive.get(channelId) ?? true;
  return channelKeepAlive.size === 1 ? [...channelKeepAlive.values()][0] : true;
}

stripProxyEnv();

// ── 活跃 MCP 连接追踪 ──
let activeMcpConnections = 0;
let lastMcpRequestTime = 0;

// ── 日志 ─────────────────────────────────────────────────
// 统一日志目录：{APP_DATA_DIR}/logs/（daemon.log = Daemon 进程；app.log = Electron 主进程）

const LOG_FILE_PATH = path.join(APP_DATA_DIR, "logs", "daemon.log");
const MAX_LOG_SIZE = 2 * 1024 * 1024;
const LOG_ROTATE_CHECK_INTERVAL = 100;
let logWriteCount = 0;
let logDirEnsured = false;

/** 旧版本日志在 APP_DATA_DIR 根下，迁移到 logs/ 子目录（一次性，失败忽略） */
function migrateLegacyLogFile(): void {
  try {
    const legacy = path.join(APP_DATA_DIR, "daemon.log");
    if (fs.existsSync(legacy) && !fs.existsSync(LOG_FILE_PATH)) {
      fs.mkdirSync(path.dirname(LOG_FILE_PATH), { recursive: true });
      fs.renameSync(legacy, LOG_FILE_PATH);
    }
  } catch { /* ignore */ }
}

/** 换行用 ⏎ 标记（展示层还原），避免与 Windows 路径中 \n、\r 字面量冲突 */
function escapeLogContentSingleLine(s: string): string {
  return s.replace(/\r?\n/g, "⏎");
}

function ensureLogDir(): void {
  if (logDirEnsured) return;
  const dir = path.dirname(LOG_FILE_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  logDirEnsured = true;
}

function rotateLogIfNeeded(): void {
  if (++logWriteCount % LOG_ROTATE_CHECK_INTERVAL !== 0) return;
  try {
    if (fs.existsSync(LOG_FILE_PATH) && fs.statSync(LOG_FILE_PATH).size > MAX_LOG_SIZE) {
      const backup = LOG_FILE_PATH + ".old";
      if (fs.existsSync(backup)) fs.unlinkSync(backup);
      fs.renameSync(LOG_FILE_PATH, backup);
    }
  } catch { /* ignore */ }
}

function log(level: string, ...args: unknown[]): void {
  const ts = localTimestamp();
  const msg = args.map(a => typeof a === "string" ? a : JSON.stringify(a)).join(" ");
  const line = `${ts} [Daemon] ${level} ${escapeLogContentSingleLine(msg)}\n`;
  process.stderr.write(line);
  try {
    ensureLogDir();
    rotateLogIfNeeded();
    fs.appendFileSync(LOG_FILE_PATH, line);
  } catch { /* ignore */ }
}

// ── 通道运行时（多飞书 + 多微信）──────────────────────────

interface ChannelRuntime {
  cfg: DaemonChannelConfig;
  // feishu
  client?: ReturnType<typeof createLarkClient>;
  sender?: LarkSender;
  botOpenId?: string;
  /** 机器人应用名（bot/v3/info 的 app_name），用于协作名册 */
  botName?: string;
  feishuConnected?: boolean;
  // wechat
  wechat?: WeChatManager;
  /** 该通道最近一次私聊的原始 chatId */
  lastP2pChatId: string | null;
  /** 主用户绑定模式：下一条私聊消息绑定为主用户 */
  bindArmed: boolean;
}

const channels = new Map<string, ChannelRuntime>();

function channelWorkspaceDir(rt: ChannelRuntime): string {
  return rt.cfg.workspaceDir?.trim() || WORKSPACE_DIR;
}

function isChannelConnected(rt: ChannelRuntime): boolean {
  if (rt.cfg.type === "feishu") return !!rt.feishuConnected && !!rt.sender;
  return rt.wechat?.isConnected() ?? false;
}

function getChannelStatusList(): ChannelStatusInfo[] {
  return [...channels.values()].map((rt) => ({
    id: rt.cfg.id,
    name: rt.cfg.name,
    type: rt.cfg.type,
    connected: isChannelConnected(rt),
    status: rt.cfg.type === "wechat"
      ? (rt.wechat?.getStatus() ?? "disconnected")
      : (rt.sender?.getWsConnectionStatus()?.state ?? (rt.feishuConnected ? "connected" : "connecting")),
    mainUserBound: !!(rt.cfg.mainUserEnabled && rt.cfg.mainUserChatId),
    botName: rt.botName,
  }));
}

/** 通道的默认私聊目标（主用户优先，其次最近私聊） */
function channelDefaultChatId(rt: ChannelRuntime): string | null {
  if (rt.cfg.mainUserEnabled && rt.cfg.mainUserChatId) return rt.cfg.mainUserChatId;
  return rt.lastP2pChatId;
}

function pickChannel(channelId?: string): ChannelRuntime | null {
  if (channelId) {
    const rt = channels.get(channelId);
    if (rt) return rt;
  }
  for (const rt of channels.values()) {
    if (isChannelConnected(rt)) return rt;
  }
  return channels.values().next().value ?? null;
}

/** 主用户绑定（armed bind）命中：写回 Electron 并回执 */
function completeBind(rt: ChannelRuntime, chatId: string, messageId?: string): void {
  rt.bindArmed = false;
  rt.cfg.mainUserEnabled = true;
  rt.cfg.mainUserChatId = chatId;
  if (rt.sender) rt.sender.chatId = chatId;
  process.stdout.write(`__BIND_RESULT__:${JSON.stringify({ channelId: rt.cfg.id, chatId })}\n`);
  log("INFO", `[Bind] 通道「${rt.cfg.name}」主用户绑定成功: ${chatId}`);
  if (messageId) {
    replyToMessage(messageId, "✅ 主用户绑定成功！", makeChatKey(rt.cfg.id, chatId)).catch(() => {});
  }
}

function isWechatChatId(rawChatId?: string): rawChatId is string {
  if (!rawChatId) return false;
  return rawChatId.startsWith("wxid_") || rawChatId.startsWith("wx_") || rawChatId.includes("@chatroom") || rawChatId.includes("@im.wechat");
}

function isFeishuChatId(rawChatId?: string): rawChatId is string {
  if (!rawChatId) return false;
  return rawChatId.startsWith("oc_");
}

// ── WeChat 通道 ──────────────────────────────────────────

function wechatDataDir(channelId: string): string {
  return path.join(APP_DATA_DIR, "wechat-data", channelId);
}

function wechatStateFile(channelId: string): string {
  return path.join(wechatDataDir(channelId), "state.json");
}

function loadWechatState(rt: ChannelRuntime): void {
  try {
    const file = wechatStateFile(rt.cfg.id);
    if (fs.existsSync(file)) {
      const data = JSON.parse(fs.readFileSync(file, "utf-8"));
      if (data.lastChatId) {
        rt.lastP2pChatId = data.lastChatId;
        log("INFO", `[WeChat:${rt.cfg.name}] 已恢复 context 绑定: chatId=${rt.lastP2pChatId}`);
      }
    }
  } catch { /* ignore */ }
}

function saveWechatState(rt: ChannelRuntime): void {
  try {
    const file = wechatStateFile(rt.cfg.id);
    const dir = path.dirname(file);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ lastChatId: rt.lastP2pChatId }));
  } catch { /* ignore */ }
}

function initWeChatChannel(rt: ChannelRuntime): WeChatManager {
  const channelId = rt.cfg.id;
  return new WeChatManager({
    dataDir: wechatDataDir(channelId),
    log: (level: string, ...args: unknown[]) => log(level, `[${rt.cfg.name}]`, ...args),
    onMessage: (msg) => {
      const chatKey = makeChatKey(channelId, msg.chatId);
      const firstMessage = !rt.lastP2pChatId;
      if (msg.chatType === "p2p" && msg.chatId) {
        rt.lastP2pChatId = msg.chatId;
        saveWechatState(rt);
      }
      if (rt.bindArmed && msg.chatType === "p2p" && msg.chatId) {
        completeBind(rt, msg.chatId, msg.messageId);
        return;
      }
      if (firstMessage) {
        log("INFO", `[WeChat:${rt.cfg.name}] 首条消息已收到，context_token 已绑定（chatId=${msg.chatId}），不入队`);
        return;
      }
      rememberChatType(chatKey, msg.chatType);
      if (isCommand(msg.text)) {
        handleCommand(msg.text, msg.messageId, chatKey, msg.chatType).catch((e: any) =>
          log("ERROR", `[WeChat:${rt.cfg.name}] 指令处理失败: ${e?.message ?? e}`),
        );
        return;
      }
      if (hasProjectNewDraft(chatKey)) {
        process.stdout.write(`__PROJECT_NEW_FILL__:${JSON.stringify({ chatId: chatKey, messageId: msg.messageId, text: msg.text })}\n`);
        return;
      }
      pushMessage(msg.text, msg.messageId, chatKey, msg.chatType, msg.senderOpenId);
    },
    onQrCode: (dataUrl) => {
      process.stdout.write(`__WECHAT_QR__:${channelId}:${dataUrl}\n`);
    },
    onStatusChange: (status) => {
      process.stdout.write(`__WECHAT_STATUS__:${channelId}:${status}\n`);
    },
  });
}

// ── SSE 客户端管理 ───────────────────────────────────────

const sseClients = new Set<http.ServerResponse>();

function broadcastQueueEvent(chatId?: string): void {
  const data = JSON.stringify({ type: "queue-update", chatId: chatId ?? null, ts: Date.now() });
  for (const res of sseClients) {
    try { res.write(`data: ${data}\n\n`); } catch { sseClients.delete(res); }
  }
}

/** 指令入队即时通知 electron，避免等 5s 状态轮询 */
function broadcastCommandEvent(): void {
  const data = JSON.stringify({ type: "command-update", ts: Date.now() });
  for (const res of sseClients) {
    try { res.write(`data: ${data}\n\n`); } catch { sseClients.delete(res); }
  }
}

/** Agent poll HTTP 生命周期 → SDK 流式卡状态（不解析 command） */
function broadcastPollPhaseEvent(
  sessionKey: string,
  phase: "start" | "end",
  opts: { blocking: boolean; reason?: string; messageIds?: string[]; directive?: string },
): void {
  const data = JSON.stringify({
    type: "poll-phase",
    sessionKey,
    phase,
    blocking: opts.blocking,
    reason: opts.reason,
    messageIds: opts.messageIds,
    directive: opts.directive,
    ts: Date.now(),
  });
  for (const res of sseClients) {
    try { res.write(`data: ${data}\n\n`); } catch { sseClients.delete(res); }
  }
}

// ── 会话路由映射 ─────────────────────────────────────────

const activeSessionMap = new Map<string, string>();
/** active 指针由用户显式切换而来的 chat：投递时不再被主工作目录纠正覆写（区分于 daemon 重启等遗留的残留指针） */
const explicitActiveChats = new Set<string>();
const messageSessionMap = new Map<string, string>();
const sessionToChatMap = new Map<string, string>();
const MSG_SESSION_MAP_MAX = 5000;
const sessionLastReplyAt = new Map<string, number>();

/** 记录出站回复时刻（zombie 假死判定 + 黑洞投递嫌疑判定） */
function touchSessionLastReply(sessionKey: string): void {
  sessionLastReplyAt.set(sessionKey, Date.now());
}

/** 最后一次向 Agent 投递消息的时刻（poll 响应写出即记，无论对端是否真收到） */
const sessionLastDeliveryAt = new Map<string, number>();
/** 已因黑洞嫌疑重投过一次的消息 id：第二次进 poll 不再重投，防 Agent 拒不回复导致死循环 */
const redeliveredMsgIds = new Map<string, Set<string>>();

function touchSessionDelivery(sessionKey: string): void {
  sessionLastDeliveryAt.set(sessionKey, Date.now());
}
/** chatKey / 裸 chatId → p2p|group，供发送时决定是否 reply */
const chatTypeByChatKey = new Map<string, string>();

function rememberChatType(chatRef?: string, chatType?: string): void {
  if (!chatRef || !chatType) return;
  if (chatType !== "p2p" && chatType !== "group") return;
  const prev = chatTypeByChatKey.get(chatRef);
  chatTypeByChatKey.set(chatRef, chatType);
  const { chatId: raw } = parseChatKey(chatRef);
  if (raw && raw !== chatRef) chatTypeByChatKey.set(raw, chatType);
  if (prev !== chatType) scheduleRoutingSave();
}

/**
 * 群聊保留 reply（引用对齐多话题）；p2p 直发砍掉引用条（header 仍保留）。
 * internal_ 不可 reply；无 chatId 只能 reply。
 */
function shouldReplyToMessage(ch: { type: "feishu"; rt: ChannelRuntime; chatId?: string }, messageId?: string): boolean {
  if (!messageId || messageId.startsWith("internal_")) return false;
  if (!ch.chatId) return true;
  const chatKey = makeChatKey(ch.rt.cfg.id, ch.chatId);
  const ct = chatTypeByChatKey.get(chatKey) || chatTypeByChatKey.get(ch.chatId);
  if (ct === "p2p") return false;
  if (ct === "group") return true;
  if (ch.rt.cfg.mainUserEnabled && ch.rt.cfg.mainUserChatId?.trim() === ch.chatId) return false;
  return true;
}

// ── 路由映射持久化：daemon 重启后回复历史消息仍能路由到原会话 ──
const ROUTING_FILE = path.join(APP_DATA_DIR, "session-routing.json");
let routingSaveTimer: NodeJS.Timeout | null = null;


/** 清掉误写入的展示标签后缀（无路径分隔符且非 wf_/project_），回写为真实 WORKSPACE_DIR；并压平双重反斜杠 */

/** 删除 activeSession / sessionToChat 中 chat 与 session 通道不一致的脏数据 */
function scrubCrossChannelRouting(): void {
  let n = 0;
  for (const [sessionKey, chatKey] of [...sessionToChatMap.entries()]) {
    const chatChannel = parseChatKey(chatKey).channelId;
    const sessionChannel = parseChatKey(chatIdFromSessionKey(sessionKey)).channelId;
    if (chatChannel && sessionChannel && chatChannel !== sessionChannel) {
      sessionToChatMap.delete(sessionKey);
      n++;
    }
  }
  for (const [chatKey, sessionKey] of [...activeSessionMap.entries()]) {
    const chatChannel = parseChatKey(chatKey).channelId;
    const sessionChannel = parseChatKey(chatIdFromSessionKey(sessionKey)).channelId;
    if (chatChannel && sessionChannel && chatChannel !== sessionChannel) {
      activeSessionMap.delete(chatKey);
      explicitActiveChats.delete(chatKey);
      n++;
    }
  }
  if (n > 0) scheduleRoutingSave();
}

function scrubInvalidActiveSessions(): void {
  if (!WORKSPACE_DIR || !/[\\/]/.test(WORKSPACE_DIR)) return;
  let n = 0;
  for (const [chatId, sk] of [...activeSessionMap.entries()]) {
    const idx = sk.indexOf("::");
    if (idx < 0) continue;
    const suffix = sk.slice(idx + 2);
    const normalized = normalizeSessionKey(sk);
    if (normalized !== sk) {
      activeSessionMap.set(chatId, normalized);
      sessionToChatMap.delete(sk);
      sessionToChatMap.set(normalized, chatId);
      n++;
      log("INFO", `[Routing] 纠正双重转义会话: ${sk} → ${normalized}`);
      continue;
    }
    if (!suffix || isSpecialSessionSuffix(suffix) || /[\\/]/.test(suffix)) continue;
    const next = `${chatId}::${WORKSPACE_DIR}`;
    activeSessionMap.set(chatId, next);
    sessionToChatMap.delete(sk);
    sessionToChatMap.set(next, chatId);
    explicitActiveChats.delete(chatId);
    n++;
    log("INFO", `[Routing] 纠正非法会话后缀: ${sk} → ${next}`);
  }
  if (n > 0) scheduleRoutingSave();
}

function loadRoutingMaps(): void {
  try {
    if (!APP_DATA_DIR || !fs.existsSync(ROUTING_FILE)) return;
    const raw = JSON.parse(fs.readFileSync(ROUTING_FILE, "utf-8")) as {
      messageSession?: Record<string, string>; activeSession?: Record<string, string>; sessionToChat?: Record<string, string>; chatType?: Record<string, string>; explicitActive?: string[];
    };
    for (const [k, v] of Object.entries(raw.messageSession ?? {})) messageSessionMap.set(k, v);
    for (const [k, v] of Object.entries(raw.activeSession ?? {})) activeSessionMap.set(k, v);
    for (const [k, v] of Object.entries(raw.sessionToChat ?? {})) sessionToChatMap.set(k, v);
    for (const k of raw.explicitActive ?? []) explicitActiveChats.add(k);
    for (const [k, v] of Object.entries(raw.chatType ?? {})) {
      if (v === "p2p" || v === "group") chatTypeByChatKey.set(k, v);
    }
    scrubInvalidActiveSessions();
    scrubCrossChannelRouting();
    log("INFO", `[Routing] 路由映射已恢复: msg=${messageSessionMap.size}, active=${activeSessionMap.size}, chat=${sessionToChatMap.size}, chatType=${chatTypeByChatKey.size}, explicit=${explicitActiveChats.size}`);
  } catch (e: any) { log("WARN", `[Routing] 路由映射恢复失败: ${e?.message ?? e}`); }
}

function scheduleRoutingSave(): void {
  if (!APP_DATA_DIR || routingSaveTimer) return;
  routingSaveTimer = setTimeout(() => {
    routingSaveTimer = null;
    try {
      const data = {
        messageSession: Object.fromEntries(messageSessionMap),
        activeSession: Object.fromEntries(activeSessionMap),
        sessionToChat: Object.fromEntries(sessionToChatMap),
        chatType: Object.fromEntries(chatTypeByChatKey),
        explicitActive: [...explicitActiveChats],
      };
      fs.writeFileSync(ROUTING_FILE + ".tmp", JSON.stringify(data));
      fs.renameSync(ROUTING_FILE + ".tmp", ROUTING_FILE);
    } catch { /* ignore */ }
  }, 1000);
  routingSaveTimer.unref?.();
}

// ── 完成确认 ────────────────────────────────────────────
// Agent 挂阻塞 poll = 声明手头活全部干完：确认删除全部 .claimed 并打 DONE。文件即状态，daemon 重启不丢。
// （模型违规「没回复就挂 poll」时会误确认一次——代价是漏答可追问，远优于守卫机制带来的复杂度与吞消息风险）
function confirmSessionDone(sessionKey: string): number {
  const done = confirmClaimedMessages(undefined, sessionKey);
  const ids = done.filter((mid) => mid && !mid.startsWith("internal_"));
  if (done.length > 0) broadcastQueueEvent(sessionKey);
  if (ids.length > 0) {
    addReactionToMessages(ids, sessionKey, "DONE");
    log("INFO", `完成确认: 删除 ${done.length} 条队列消息, DONE 表情 ${ids.length} 条, session=${sessionKey}`);
  }
  return done.length;
}

// ── Agent-Poll 生命周期追踪 ─────────────────────────────────
const activePollConnections = new Map<string, Set<http.ServerResponse>>();

function registerPollConn(sessionKey: string, res: http.ServerResponse): void {
  let set = activePollConnections.get(sessionKey);
  if (!set) { set = new Set(); activePollConnections.set(sessionKey, set); }
  set.add(res);
}

function unregisterPollConn(sessionKey: string, res: http.ServerResponse): void {
  const set = activePollConnections.get(sessionKey);
  if (set) { set.delete(res); if (set.size === 0) activePollConnections.delete(sessionKey); }
}

/** 销毁会话残留的旧 Poll 长连接。消息领取即消费，无 hold 状态需要回滚 */
function terminateSession(sessionKey: string): void {
  const conns = activePollConnections.get(sessionKey);
  if (conns?.size) {
    log("INFO", `终止会话Poll连接: session=${sessionKey} count=${conns.size}`);
    for (const r of conns) { try { r.destroy(); } catch {} }
    activePollConnections.delete(sessionKey);
  }
}

function terminateSessionsByChat(chatId: string): void {
  for (const key of [...activePollConnections.keys()]) {
    if (key.startsWith(chatId + "::") || key === chatId) terminateSession(key);
  }
}

function setActiveSession(chatId: string, sessionKey: string, explicit = false): boolean {
  const normalized = normalizeSessionKey(sessionKey) || sessionKey;
  const chatNorm = normalizeSessionKey(chatId) || chatId;
  const chatChannel = parseChatKey(chatId).channelId;
  const sessionChannel = parseChatKey(chatIdFromSessionKey(normalized)).channelId;
  if (chatChannel && sessionChannel && chatChannel !== sessionChannel) {
    log("WARN", `[Routing] 拒绝跨通道 active 绑定: chat=${chatId} session=${normalized}`);
    return false;
  }
  // 带 chat 前缀的会话（chatKey::…）必须属于该 chat，禁止 A 群绑到 B 群项目会话
  if (normalized.includes("::")) {
    const sessionChat = chatIdFromSessionKey(normalized);
    const sameKey = normalized === chatNorm || normalized.startsWith(`${chatNorm}::`);
    const sameRaw = !!sessionChat && parseChatKey(sessionChat).chatId === parseChatKey(chatId).chatId;
    if (!sameKey && !sameRaw) {
      log("WARN", `[Routing] 拒绝跨会话 active 绑定: chat=${chatId} session=${normalized}`);
      return false;
    }
  }
  activeSessionMap.set(chatId, normalized);
  sessionToChatMap.set(normalized, chatId);
  if (explicit) explicitActiveChats.add(chatId); else explicitActiveChats.delete(chatId);
  scheduleRoutingSave();
  log("INFO", `会话路由更新: ${chatId} → ${normalized}${explicit ? " (显式)" : ""}`);
  return true;
}

function resolveRawChatId(sessionKey?: string): string | undefined {
  if (!sessionKey) return undefined;
  const mapped = sessionToChatMap.get(sessionKey);
  if (mapped) {
    const mapChannel = parseChatKey(mapped).channelId;
    const selfChannel = parseChatKey(chatIdFromSessionKey(sessionKey)).channelId;
    if (mapChannel && selfChannel && mapChannel !== selfChannel) {
      return chatIdFromSessionKey(sessionKey);
    }
    return mapped;
  }
  return chatIdFromSessionKey(sessionKey);
}

function extractWorkspaceDir(sessionKey?: string): string | undefined {
  if (!sessionKey) return undefined;
  const idx = sessionKey.indexOf("::");
  if (idx < 0) return undefined;
  const wsDir = sessionKey.slice(idx + 2);
  // 仅路径形态的后缀才是工作目录（排除 wf_xxx 等非路径会话后缀）
  if (!wsDir || !/[\\/]/.test(wsDir)) return undefined;
  return wsDir;
}

/** 工作目录去重键：规范化 + 去尾部分隔符 + 小写，避免同目录被计成两个 */
function workspaceDirKey(ws: string): string {
  return path.normalize(ws.trim()).replace(/[\\/]+$/, "").toLowerCase();
}

/** 该聊天下已知工作目录（poll 连接 + 近 30 分钟有回复的会话） */
function listChatWorkspaceDirs(chatKey: string): string[] {
  const prefix = chatKey + "::";
  const dirs = new Map<string, string>(); // norm -> original
  const consider = (sk: string) => {
    if (!(sk === chatKey || sk.startsWith(prefix))) return;
    const ws = extractWorkspaceDir(sk);
    if (!ws) return;
    const norm = workspaceDirKey(ws);
    if (!dirs.has(norm)) dirs.set(norm, ws);
  };
  for (const k of activePollConnections.keys()) consider(k);
  const now = Date.now();
  for (const [k, t] of sessionLastReplyAt) {
    if (now - t < 30 * 60_000) consider(k);
  }
  return [...dirs.values()];
}

function extractWorkspaceTitle(sessionKey?: string, peers?: string[]): string | undefined {
  const wsDir = extractWorkspaceDir(sessionKey);
  if (!wsDir) return undefined;
  return disambiguatePathLabel(wsDir, peers ?? [wsDir]);
}

/** 该聊天下活跃「工作目录」数（挂起 poll + 近 30 分钟有回复；按规范化路径去重，同目录多会话不计多） */
function chatActiveSessionCount(chatKey: string): number {
  const prefix = chatKey + "::";
  const dirs = new Set<string>();
  const add = (sk: string) => {
    if (!sk.startsWith(prefix)) return;
    const ws = extractWorkspaceDir(sk);
    if (!ws) return;
    dirs.add(workspaceDirKey(ws));
  };
  for (const k of activePollConnections.keys()) add(k);
  const now = Date.now();
  for (const [k, t] of sessionLastReplyAt) {
    if (now - t < 30 * 60_000) add(k);
  }
  return dirs.size;
}


/** 按 chatKey / 裸 chatId 查当前活跃会话（带工作区的完整 sessionKey） */
function lookupActiveSessionKey(chatRef?: string): string | undefined {
  if (!chatRef) return undefined;
  const direct = activeSessionMap.get(chatRef);
  if (direct) return direct;
  const { chatId: raw } = parseChatKey(chatRef);
  if (raw && raw !== chatRef) {
    const byRaw = activeSessionMap.get(raw);
    if (byRaw) return byRaw;
  }
  for (const [k, v] of activeSessionMap) {
    if (k === chatRef || k.endsWith("|" + chatRef)) return v;
    if (raw && (k === raw || k.endsWith("|" + raw))) return v;
  }
  return undefined;
}

/** 优先带 ::工作区 的 key，保证 title/配色稳定同一会话 */
function preferWorkspaceSessionKey(...keys: (string | undefined)[]): string | undefined {
  const hit = keys.find((k) => {
    if (!k) return false;
    const idx = k.indexOf("::");
    if (idx < 0) return false;
    const suffix = k.slice(idx + 2);
    if (!suffix) return false;
    // 项目/工作流会话身份同样明确，不能被"当前活跃会话"抢走标题与配色
    return isSpecialSessionSuffix(suffix) || /[\\/]/.test(suffix);
  });
  return hit || keys.find((k) => !!k);
}

/** 仅主用户私聊显示会话标题（目录/项目 + 分支）；群聊/非主用户/缺 chatId 一律不露。
 * 主用户私聊只要认定身份，就尽量给出标题——否则飞书卡片无 header，看起来就像「没颜色」。 */
function resolveReplyTitle(ch: ResolvedChannel, sessionKey?: string): CardTitle | undefined {
  if (ch.type !== "feishu") return undefined;
  const { mainUserEnabled, mainUserChatId } = ch.rt.cfg;
  if (!mainUserEnabled || !mainUserChatId?.trim()) return undefined;
  if (!ch.chatId || ch.chatId !== mainUserChatId.trim()) return undefined;

  const chatKey = makeChatKey(ch.rt.cfg.id, ch.chatId);
  const sk = sessionKey
    || activeSessionMap.get(chatKey)
    || activeSessionMap.get(ch.chatId)
    || undefined;

  const pid = sk ? projectIdFromSessionKey(sk) : undefined;
  if (pid) {
    const p = getProject(pid);
    const card = buildSessionCardTitle({ sessionKey: sk, project: p });
    if (card) return card;
  }

  const fromSk = resolveWorkspaceFromSessionKey(sk);
  const wsDir = (fromSk && fs.existsSync(fromSk) ? fromSk : undefined)
    || (WORKSPACE_DIR && /[\\/]/.test(WORKSPACE_DIR) && fs.existsSync(WORKSPACE_DIR) ? WORKSPACE_DIR : undefined);
  if (wsDir) {
    const peers = listChatWorkspaceDirs(chatKey);
    return buildSessionCardTitle({
      sessionKey: sk,
      workspaceDir: wsDir,
      peers: peers.length ? peers : [wsDir],
    }) || { title: `📂 ${wsDir.split(/[\\/]/).filter(Boolean).pop() || wsDir}` };
  }
  // 工作目录暂不可解析时仍给最小标题，保证 header 配色条出现
  return { title: "💬 会话" };
}

type ResolvedChannel =
  | { type: "wechat"; rt: ChannelRuntime; chatId: string }
  | { type: "feishu"; rt: ChannelRuntime; chatId?: string }
  | { type: "error"; message: string };

function resolveChannel(sessionKey?: string, opts?: { allowDefault?: boolean }): ResolvedChannel {
  const allowDefault = opts?.allowDefault !== false;
  const rawKey = resolveRawChatId(sessionKey);

  if (rawKey) {
    const { channelId, chatId } = parseChatKey(rawKey);
    if (channelId) {
      const rt = channels.get(channelId);
      if (rt) {
        if (rt.cfg.type === "wechat") {
          return rt.wechat?.isConnected()
            ? { type: "wechat", rt, chatId }
            : { type: "error", message: `微信通道「${rt.cfg.name}」未连接` };
        }
        if (rt.sender) return { type: "feishu", rt, chatId };
        return { type: "error", message: `飞书通道「${rt.cfg.name}」未连接` };
      }
    }
    // 旧格式（无通道前缀）：按 chatId 形态启发式匹配
    for (const rt of channels.values()) {
      if (rt.cfg.type === "wechat" && isWechatChatId(rawKey) && rt.wechat?.isConnected()) {
        return { type: "wechat", rt, chatId: rawKey };
      }
      if (rt.cfg.type === "feishu" && isFeishuChatId(rawKey) && rt.sender) {
        return { type: "feishu", rt, chatId: rawKey };
      }
    }
  }

  // 发送 API 禁止兜底到主用户（防 IDE 捏造 session_key 误发）
  if (!allowDefault) {
    return { type: "error", message: "无法解析 session_key 对应的通道，已拒绝兜底发送" };
  }

  // 兜底：第一个有默认私聊目标的已连接通道（仅内部非发送路径）
  for (const rt of channels.values()) {
    const target = channelDefaultChatId(rt);
    if (!target || !isChannelConnected(rt)) continue;
    if (rt.cfg.type === "wechat") return { type: "wechat", rt, chatId: target };
    return { type: "feishu", rt, chatId: target };
  }
  for (const rt of channels.values()) {
    if (rt.cfg.type === "feishu" && rt.sender) return { type: "feishu", rt };
  }
  return { type: "error", message: "无可用消息通道" };
}

/** 将 sessionKey 记入路由表（poll / 启动时调用），供 send 白名单校验 */
function rememberSessionKey(sessionKey: string): void {
  if (!sessionKey) return;
  const chatKey = chatIdFromSessionKey(sessionKey);
  if (!chatKey) return;
  if (sessionToChatMap.get(sessionKey) === chatKey) return;
  sessionToChatMap.set(sessionKey, chatKey);
  scheduleRoutingSave();
}

/** session_key 是否已被 daemon 登记（启动/入队/poll/路由时写入） */
function isKnownSessionKey(sessionKey: string): boolean {
  if (!sessionKey) return false;
  if (sessionToChatMap.has(sessionKey)) return true;
  for (const v of activeSessionMap.values()) { if (v === sessionKey) return true; }
  for (const v of messageSessionMap.values()) { if (v === sessionKey) return true; }
  if (activePollConnections.has(sessionKey)) return true;
  if (hasSessionQueueDir(sessionKey)) return true;
  // 合法 chatKey（通道已注册）：工作流通知用裸 chatKey；工作流节点会话用 chatKey::wf_*
  const chatKey = chatIdFromSessionKey(sessionKey);
  const { channelId } = parseChatKey(chatKey);
  if (channelId && channels.has(channelId)) {
    if (sessionKey === chatKey) return true;
    const suffix = sessionKey.slice(chatKey.length + 2); // after "::"
    if (suffix.startsWith("wf_") || suffix.startsWith("project_")) return true;
  }
  return false;
}

const SEND_REJECT_HINT =
  "session_key 必须从 poll-message 返回值或会话元数据 [session_key=...] 原样复制，禁止凭空捏造；" +
  "若你在 Cursor IDE 人工会话中（Prompt 无 [session_key=...]），严禁调用 lk-harness 发送工具——本规则对 IDE 会话整篇失效。";

/**
 * 发送前校验：拒绝 IDE 误调 / 捏造 session_key。
 * - 两者皆空 → 拒
 * - 有 session_key → 必须在 daemon 已知记录中（或为已注册通道的 chatKey）
 * - 仅有 message_id → 必须能映射到已知会话（messageSessionMap / internalMsgChatMap）
 * 通过后不会再落入 resolveChannel 的「发给主用户」兜底。
 */
function rejectUnroutedSend(res: http.ServerResponse, api: string, sessionKey?: string, messageId?: string): boolean {
  const sk = sessionKey?.trim() || "";
  const mid = messageId?.trim() || "";

  if (!sk && !mid) {
    log("WARN", `[${api}] 已拒绝无 session_key/message_id 的发送请求（疑似 IDE 人工会话误调用）`);
    json(res, { ok: false, error: `缺少 session_key 与 message_id。${SEND_REJECT_HINT}` });
    return true;
  }

  if (sk) {
    // 旧版路由格式 / 明显捏造
    if (sk.startsWith("agent:") || /^agent:main:/.test(sk)) {
      log("WARN", `[${api}] 已拒绝旧版/捏造 session_key: ${sk.slice(0, 80)}`);
      json(res, { ok: false, error: `session_key 格式非法（疑似凭空捏造的旧版路由键）。${SEND_REJECT_HINT}` });
      return true;
    }
    if (!isKnownSessionKey(sk)) {
      log("WARN", `[${api}] 已拒绝未知 session_key: ${sk.slice(0, 120)}`);
      json(res, { ok: false, error: `session_key 不在系统记录中（未由 lk-harness 调度启动）。${SEND_REJECT_HINT}` });
      return true;
    }
    return false;
  }

  // 仅 message_id：必须能反查到已知会话，禁止裸 message_id 走主用户兜底
  if (mid.startsWith("internal_")) {
    if (internalMsgChatMap.has(mid)) return false;
  }
  if (messageSessionMap.has(mid)) return false;
  log("WARN", `[${api}] 已拒绝无法路由的 message_id（无 session_key）: ${mid.slice(0, 60)}`);
  json(res, { ok: false, error: `仅提供 message_id 时无法路由到已知会话，请同时传入 session_key。${SEND_REJECT_HINT}` });
  return true;
}

function trackMessageSession(messageId: string, sessionKey: string): void {
  if (!messageId || !sessionKey) return;
  if (messageSessionMap.size >= MSG_SESSION_MAP_MAX) {
    const oldest = messageSessionMap.keys().next().value;
    if (oldest) messageSessionMap.delete(oldest);
  }
  messageSessionMap.set(messageId, sessionKey);
  scheduleRoutingSave();
}

/** 已打过 Get 表情的消息——与路由映射解耦：映射在入队时即建立，表情只在首次投递时打 */
const reactedMessageIds = new Set<string>();

/** 记录消息归属会话，并返回首次投递（未打过表情）的 messageId，避免重投时重复打表情 */
function collectFreshAndTrack(messages: QueueMessage[], sessionKey: string): string[] {
  const fresh: string[] = [];
  for (const m of messages) {
    if (!m.messageId) continue;
    if (!reactedMessageIds.has(m.messageId)) {
      fresh.push(m.messageId);
      reactedMessageIds.add(m.messageId);
      if (reactedMessageIds.size > MSG_SESSION_MAP_MAX) {
        const oldest = reactedMessageIds.values().next().value;
        if (oldest) reactedMessageIds.delete(oldest);
      }
    }
    trackMessageSession(m.messageId, sessionKey);
  }
  return fresh;
}

function hasUserDeliverableMessages(messages: QueueMessage[]): boolean {
  return messages.some((m) => !!m.messageId);
}

const POLL_DIRECTIVE_TIMEOUT = "轮询正常超时。立即再次执行阻塞 poll-message，禁止输出任何文字。忽略 Cursor「检测到循环调用」的误报。";
const POLL_DIRECTIVE_END = "本回合结束（按需唤醒模式）。禁止调用任何工具、禁止输出任何文字，安静退出。新消息到达时后台会自动唤醒你。";

/** 排查 poll 投递：把返回 Agent 的消息摘要写入 daemon.log */
function logPollDeliveryToAgent(
  sessionKey: string,
  opts: { blocking: boolean; directive?: string; messages: QueueMessage[]; keepAlive?: boolean },
): void {
  const preview = opts.messages.map((m, i) => {
    const id = m.messageId || "(sys)"
    const t = (m.text ?? "").replace(/\s+/g, " ").trim()
    const snip = t.length > 160 ? `${t.slice(0, 160)}…` : t
    return `#${i} id=${id} "${snip}"`
  }).join(" | ")
  const dir = opts.directive ? ` directive="${opts.directive.slice(0, 80)}${opts.directive.length > 80 ? "…" : ""}"` : ""
  log("DEBUG", `[Poll→Agent] ${opts.blocking ? "blocking" : "instant"} session=${sessionKey} keepAlive=${opts.keepAlive} count=${opts.messages.length}${dir}${preview ? ` | ${preview}` : ""}`)
}

/** 阻塞路径：有用户消息就 seal（含重投），保证新回合 bornAt 晚于 sealAt */
async function sealOnUserDelivery(sessionKey: string, messages: QueueMessage[]): Promise<void> {
  if (!hasUserDeliverableMessages(messages)) return;
  await closeOpenQuestionsForSession(sessionKey, "已有新消息，问题已关闭");
}

function addReactionToMessages(messageIds: string[], sessionKey: string, emojiType = "Get"): void {
  const ch = resolveChannel(sessionKey, { allowDefault: false });
  if (ch.type !== "feishu" || !ch.rt.sender) return;
  const sender = ch.rt.sender;
  for (const mid of messageIds) {
    // internal_（卡片点击等）不是飞书 message_id，调 reaction API 会 400
    if (!mid || mid.startsWith("internal_")) continue;
    sender.addReaction(mid, emojiType).catch(() => {});
  }
}

// 回复不删除消息：消息保持 .claimed「处理中」，Agent 挂阻塞 poll 时隐式确认删除。

function resolveRoutingKey(chatId?: string, replyMessageId?: string): { sessionKey?: string; viaReply: boolean } {
  if (replyMessageId) {
    const sk = messageSessionMap.get(replyMessageId);
    if (sk) {
      // 同一条消息（message_id 全局唯一）可能被多个通道分别接收（bot 协作 reply 链）。
      // messageId 映射仅在通道一致时生效，否则会把 A 通道的消息错投进 B 通道的会话。
      const skChannel = channelIdFromSessionKey(sk);
      const msgChannel = chatId ? parseChatKey(chatId).channelId : undefined;
      if (!skChannel || !msgChannel || skChannel === msgChannel) {
        log("INFO", `路由命中 messageId 映射: ${replyMessageId} → ${sk}`);
        return { sessionKey: sk, viaReply: true };
      }
      log("INFO", `messageId 映射跨通道(${skChannel}→${msgChannel})，忽略: ${replyMessageId}`);
    }
  }
  if (!chatId) return { sessionKey: undefined, viaReply: false };
  return { sessionKey: activeSessionMap.get(chatId) ?? chatId, viaReply: false };
}

// ── 文件队列 ─────────────────────────────────────────────

function initQueue(): void {
  const dir = initFileQueue();
  log("INFO", `共享文件队列: ${dir}`);
  cleanupStaleMessages();
  // 周期清理：.tmp 孤儿 + 超 72h 未确认的 .claimed（死会话兜底）
  setInterval(() => cleanupStaleMessages(), 6 * 60 * 60 * 1000).unref();
}

/** 媒体缓存清理：启动清一次 + 每 6 小时清一次，删除 24 小时前的旧文件 */
function startMediaCacheCleanup(): void {
  const MAX_AGE_MS = 24 * 60 * 60 * 1000;
  const sweep = () => {
    const n = cleanupMediaCache(MAX_AGE_MS);
    if (n > 0) log("INFO", `媒体缓存已清理 ${n} 个过期文件`);
  };
  sweep();
  setInterval(sweep, 6 * 60 * 60 * 1000).unref();
}

function pushMessage(content: string, messageId?: string, chatId?: string, chatType?: string, senderOpenId?: string, replyMessageId?: string, meta?: QueueMessageMeta): void {
  if (!content?.trim()) {
    // 群里引用旧消息补 @（正文剥掉 @ 后为空）：实质内容在引用里，不能丢
    if (meta?.quotedContent?.trim()) {
      content = "（用户仅 @ 了你，正文为空；请处理 meta.quotedContent 引用消息中的内容）";
    } else {
      log("WARN", `丢弃空消息 (messageId=${messageId})`);
      return;
    }
  }
  const resolved = resolveRoutingKey(chatId, replyMessageId);
  let routedId = resolved.sessionKey;
  // 非回复消息的 p2p 路由规则:一律投递到当前主工作目录会话(引用回复才跟随原会话)。
  // 显式切换(/c 等)或特殊会话(裸 temp_/task_，或 ::wf_ / ::project_)时尊重 active 指针。
  // 注意：展示标签误写入的非路径后缀(如 cp-scheduling·workspace)必须纠正，不能当特殊会话。
  if (!resolved.viaReply && chatId && chatType === "p2p") {
    const idx = routedId ? routedId.indexOf("::") : -1;
    const suffix = routedId && idx >= 0 ? routedId.slice(idx + 2) : "";
    const isExplicitSession = !!routedId && routedId !== chatId && (
      explicitActiveChats.has(chatId) || idx < 0 || isSpecialSessionSuffix(suffix)
    );
    if (!isExplicitSession) {
      const { channelId } = parseChatKey(chatId);
      const rt = channelId ? channels.get(channelId) : undefined;
      const wsDir = rt ? channelWorkspaceDir(rt) : WORKSPACE_DIR;
      if (wsDir && /[\\/]/.test(wsDir)) {
        const mainSessionKey = normalizeSessionKey(`${chatId}::${wsDir}`) || `${chatId}::${wsDir}`;
        if (routedId !== mainSessionKey) {
          setActiveSession(chatId, mainSessionKey);
          routedId = mainSessionKey;
        }
      }
    }
  }
  // 项目专属群：命中 groupChatId 的消息强制路由到该项目会话（无视 active 指针，永不串台）
  if (!resolved.viaReply && chatId && chatType === "group") {
    const grp = findProjectByGroupChat(chatId);
    if (grp?.sessionKey && routedId !== grp.sessionKey) {
      setActiveSession(chatId, grp.sessionKey, true);
      routedId = grp.sessionKey;
    }
  }
  // 群聊无活跃会话映射（如 daemon 重启后路由丢失）：唯一活跃项目兜底，防消息落入裸 chatKey 幽灵会话
  if (!resolved.viaReply && chatId && chatType === "group" && routedId === chatId) {
    const rawChat = parseChatKey(chatId).chatId;
    const owned = listProjects().filter((p) => {
      if (p.status !== "active" || !p.sessionKey) return false;
      const n = p.notifyChatId || "";
      return n === chatId || parseChatKey(n).chatId === rawChat;
    });
    if (owned.length === 1) {
      setActiveSession(chatId, owned[0].sessionKey!, true);
      routedId = owned[0].sessionKey!;
      log("INFO", `[Routing] 群会话映射缺失，兜底路由到项目「${owned[0].name}」: ${routedId}`);
    }
  }
  if (chatId && chatType) rememberChatType(chatId, chatType);
  const fullMeta: QueueMessageMeta = { ...(meta || {}) };
  if (chatId) fullMeta.chatId = chatId;
  if (chatType) fullMeta.chatType = chatType;
  if (senderOpenId) fullMeta.senderOpenId = senderOpenId;
  const written = pushToFileQueue(content, messageId, `daemon-${process.pid}`, routedId, false, Object.keys(fullMeta).length > 0 ? fullMeta : undefined);
  if (written) {
    // 入队即建立 messageId→会话映射：回复一条尚未被 Agent 领取的消息也能正确路由
    if (messageId && routedId) trackMessageSession(messageId, routedId);
    // 用户直接发消息（非卡片点击）时仅关闭未决问题卡；不 seal 活流式卡（干活中插话不拆卡，换回合由 blocking poll 投递负责）
    if (messageId && !messageId.startsWith("internal_") && routedId) {
      void expireOpenCardQuestionsForSession(routedId, "问题已关闭");
    }
    const preview = content.length > 200 ? `${content.slice(0, 200)} …(+${content.length - 200} chars)` : content;
    log("INFO", `消息已写入共享队列: ${JSON.stringify(preview)} (id=${messageId ?? "none"}, chat=${chatId ?? "none"}${routedId !== chatId ? ` → routed=${routedId}` : ""}${replyMessageId ? `, reply=${replyMessageId}` : ""})`);
    broadcastQueueEvent(routedId);
  } else {
    log("INFO", `消息已跳过（重复或写入失败）: id=${messageId ?? "none"}`);
  }
}

function clearFileQueue(): number {
  const queueDir = getQueueDir();
  if (!queueDir) return 0;
  let count = 0;
  const exts = [".qmsg", ".claimed", ".done", ".tmp"];
  const clearDir = (dir: string) => {
    try {
      for (const f of fs.readdirSync(dir)) {
        const full = path.join(dir, f);
        if (fs.statSync(full).isDirectory()) {
          clearDir(full);
        } else if (exts.some((ext) => f.endsWith(ext))) {
          try { fs.unlinkSync(full); count++; } catch { /* ignore */ }
        }
      }
    } catch { /* ignore */ }
  };
  clearDir(queueDir);
  log("INFO", `队列已清空: ${count} 条消息`);
  return count;
}

// ── 飞书 WebSocket 长连接（每通道一条）───────────────────

const FEISHU_WS_WATCHDOG_MS = 60_000;

function startFeishuWsWatchdog(): void {
  setInterval(() => {
    for (const rt of channels.values()) {
      if (rt.cfg.type !== "feishu" || !rt.sender) continue;
      const st = rt.sender.getWsConnectionStatus();
      if (!st) continue;
      if (st.state === "connected") {
        if (!rt.feishuConnected) {
          rt.feishuConnected = true;
          log("INFO", `[${rt.cfg.name}] WebSocket 状态恢复: connected`);
        }
      } else if (st.state === "reconnecting" || st.state === "failed") {
        if (rt.feishuConnected) {
          rt.feishuConnected = false;
          log("WARN", `[${rt.cfg.name}] WebSocket 状态异常: ${st.state} (attempts=${st.reconnectAttempts})`);
        }
      }
    }
  }, FEISHU_WS_WATCHDOG_MS).unref();
}

function isBotMentioned(rt: ChannelRuntime, ev: LarkMessageEvent): boolean {
  if (!rt.botOpenId) return ev.mentions.length > 0;
  return ev.mentions.some((m) => m.id === rt.botOpenId || m.key === "@_all");
}

/**
 * 将 `@_user_N` 占位符还原为可读形式：
 * - @自己 → 删除（与旧行为一致）
 * - @其他人/机器人 → `@名字(open_id=ou_xxx)`，Agent 可直接取 open_id 回 @
 */
function resolveMentionTags(text: string, mentions: LarkMessageEvent["mentions"], selfOpenId?: string): string {
  let out = text;
  for (const m of mentions) {
    if (!m.key) continue;
    const replacement = (selfOpenId && m.id === selfOpenId) || m.key === "@_all"
      ? ""
      : (m.id ? `@${m.name}(open_id=${m.id})` : `@${m.name}`);
    out = out.split(m.key).join(replacement);
  }
  return out.replace(/@_user_\d+/g, "").replace(/\s{2,}/g, " ").trim();
}

function sanitizePollMessages(messages: QueueMessage[]): QueueMessage[] {
  return messages.map((m) => {
    if (!m.meta) return m;
    const meta = { ...m.meta } as Record<string, unknown>;
    delete meta.botOpenId;
    delete meta.botName;
    delete meta.botRoster;
    const cleaned = Object.fromEntries(Object.entries(meta).filter(([, v]) => v !== undefined));
    return { ...m, meta: Object.keys(cleaned).length ? cleaned as QueueMessage["meta"] : undefined };
  });
}

async function stopChannelRuntime(channelId: string): Promise<boolean> {
  const rt = channels.get(channelId);
  if (!rt) return false;
  const name = rt.cfg.name;
  if (rt.cfg.type === "feishu") {
    rt.sender?.closeConnection(true);
    rt.feishuConnected = false;
  } else if (rt.wechat) {
    await rt.wechat.stop();
  }
  channels.delete(channelId);
  channelKeepAlive.delete(channelId);
  log("INFO", `[${name}] 通道已停用`);
  return true;
}

async function startChannelRuntime(cfg: DaemonChannelConfig): Promise<void> {
  if (channels.has(cfg.id)) await stopChannelRuntime(cfg.id);
  const rt: ChannelRuntime = { cfg, lastP2pChatId: null, bindArmed: false };
  channels.set(cfg.id, rt);
  channelKeepAlive.set(cfg.id, cfg.keepAlive ?? true);
  if (cfg.type === "feishu") {
    await startFeishuChannel(rt);
  } else {
    loadWechatState(rt);
    rt.wechat = initWeChatChannel(rt);
    await rt.wechat.start(cfg.wechatToken ?? "", cfg.wechatAccountId);
  }
  log("INFO", `[${cfg.name}] 通道已启用`);
}

async function startFeishuChannel(rt: ChannelRuntime): Promise<void> {
  const { appId, appSecret } = rt.cfg;
  if (!appId || !appSecret) { log("ERROR", `[${rt.cfg.name}] 飞书凭据未配置`); return; }

  rt.client = createLarkClient(appId, appSecret);
  rt.sender = new LarkSender({
    client: rt.client,
    chatId: rt.cfg.mainUserEnabled ? rt.cfg.mainUserChatId : "",
    messagePrefix: MESSAGE_PREFIX,
    log: (level: string, ...args: unknown[]) => log(level, `[${rt.cfg.name}]`, ...args),
  });

  try {
    const botInfo = await rt.client.request({ method: "GET", url: "/open-apis/bot/v3/info" }) as any;
    rt.botOpenId = botInfo?.bot?.open_id;
    rt.botName = botInfo?.bot?.app_name || rt.cfg.name;
    if (rt.botOpenId) log("INFO", `[${rt.cfg.name}] 机器人 open_id: ${rt.botOpenId} (${rt.botName})`);
    else log("WARN", `[${rt.cfg.name}] 未能获取机器人 open_id，群消息过滤将使用宽松模式`);
  } catch (e: any) {
    log("WARN", `[${rt.cfg.name}] 获取机器人信息失败: ${e?.message ?? e}`);
  }

  const sender = rt.sender;
  const wsLifecycle = {
    onReady: () => { rt.feishuConnected = true; },
    onReconnecting: () => { rt.feishuConnected = false; },
    onReconnected: () => { rt.feishuConnected = true; },
    onDisconnected: () => { rt.feishuConnected = false; },
    onError: () => { rt.feishuConnected = false; },
  };
  sender.startConnection(appId, appSecret, ENCRYPT_KEY, (ev) => {
    rt.feishuConnected = true;
    const { text, messageId, chatId, chatType, messageType, rawContent, senderOpenId, parentId } = ev;
    const chatKey = makeChatKey(rt.cfg.id, chatId);

    if (chatType === "p2p" && chatId) {
      rt.lastP2pChatId = chatId;
      if (rt.bindArmed) {
        completeBind(rt, chatId, messageId);
        return;
      }
      if (!sender.chatId) {
        sender.chatId = chatId;
        log("INFO", `[${rt.cfg.name}] 自动绑定默认 chat_id: ${chatId}`);
      }
    }

    if (chatType === "group" && !isBotMentioned(rt, ev)) {
      return;
    }

    const cleanText = chatType === "group" ? resolveMentionTags(text, ev.mentions, rt.botOpenId) : text;
    log("INFO", `[${rt.cfg.name}] 收到消息 [${chatType}] chat=${chatId} sender=${senderOpenId ?? "?"}${ev.senderType === "app" ? "(bot)" : ""}${parentId ? ` reply=${parentId}` : ""}: ${cleanText.slice(0, 100)}`);
    rememberChatType(chatKey, chatType);

    if (messageType === "text" && isCommand(cleanText)) {
      handleCommand(cleanText, messageId, chatKey, chatType).catch((e: any) =>
        log("ERROR", `指令处理失败: ${e?.message ?? e}`),
      );
      return;
    }

    if (messageType === "text" && hasProjectNewDraft(chatKey)) {
      process.stdout.write(`__PROJECT_NEW_FILL__:${JSON.stringify({ chatId: chatKey, messageId, text: cleanText })}\n`);
      return;
    }

    const enqueue = async (content: string) => {
      const meta: QueueMessageMeta = {
        senderType: ev.senderType === "app" ? "bot" : "user",
      };
      if (parentId) {
        let original = await sender.fetchMessageContent(parentId);
        if (!original) {
          for (const peer of channels.values()) {
            if (peer === rt || peer.cfg.type !== "feishu" || !peer.sender) continue;
            original = await peer.sender.fetchMessageContent(parentId);
            if (original) break;
          }
        }
        if (original) meta.quotedContent = original;
      }
      pushMessage(content, messageId, chatKey, chatType, senderOpenId, parentId, meta);
    };

    if (messageType === "text") {
      enqueue(cleanText);
    } else {
      sender.processIncomingMessage(messageId, messageType, rawContent)
        .then((result) => enqueue(result || cleanText))
        .catch(() => enqueue(cleanText));
    }
  }, (cardEvt) => handleCardAction(rt, cardEvt), wsLifecycle, (recall) => {
    handleMessageRecalled(rt, recall.messageId, recall.chatId, recall.recallType);
  }).then(
    () => { rt.feishuConnected = true; },
    () => { rt.feishuConnected = false; },
  );
}

// ── 指令系统 ─────────────────────────────────────────────

const COMMANDS: Record<string, string> = {
  "/stop": "停止当前运行中的 Agent",
  "/x": "同 /stop",
  "/status": "查看 Agent / Daemon 状态",
  "/s": "同 /status",
  "/list": "查看消息队列列表（不消费）",
  "/ls": "同 /list",
  "/task": "定时任务（/task 查看子命令说明；如 /task ls）",
  "/t": "同 /task",
  "/project": "项目工作区（/project 查看；/p new|ls|use|plan|build|review|ship|sync）",
  "/p": "同 /project",
  "/model": "Cursor CLI 模型（/model ls | info | set <序号>）",
  "/m": "同 /model",
  "/mcp": "MCP 服务器管理（/mcp ls | info | enable | disable | delete | add）",
  "/mc": "同 /mcp",
  "/workspace": "切换工作目录（/workspace 查看当前 | /workspace set <路径>）",
  "/w": "同 /workspace",
  "/chat": "会话管理（/chat ls | /chat <序号> | /chat stop <序号> | /chat new <描述>）",
  "/c": "同 /chat",
  "/clean": "清空消息队列",
  "/cl": "同 /clean",
  "/reset": "下次拉起 Agent 时不使用 --continue（新 CLI 会话），不删除本地文件",
  "/r": "同 /reset",
  "/restart": "停止 Agent + 清空队列 + 重启 Daemon",
  "/rr": "同 /restart",
  "/help": "显示可用指令列表",
  "/h": "同 /help",
};

function isCommand(text: string): boolean {
  const trimmed = text.trim().toLowerCase();
  return Object.keys(COMMANDS).some((cmd) => trimmed === cmd || trimmed.startsWith(cmd + " "));
}

/** Agent SDK → 飞书 CardKit：按执行时间线交错 think/tool/reply；finish 后下一轮新建 */
interface AgentStreamToolItem {
  name: string;
  status: string;
  summary?: string;
  ms?: number;
}

type AgentStreamSegment =
  | { type: "thinking"; text: string; ms?: number; panelId?: string }
  | { type: "tools"; tools: AgentStreamToolItem[]; panelId?: string }
  | { type: "reply"; text: string }
  | { type: "todos"; items: AgentStreamTodoItem[] };

interface StreamPanelState {
  panelSeq: number;
  knownPanelIds: Set<string>;
  /** 应保持展开的面板（尾部 2 + 曾处于尾部 2 的块） */
  expandedPanelIds: Set<string>;
}

interface AgentStreamTodoItem {
  content: string;
  status: string;
}

interface AgentStreamCardPayload {
  segments: AgentStreamSegment[];
  /** 兼容旧字段 */
  thinking?: string;
  thinkingMs?: number;
  tools?: AgentStreamToolItem[];
  reply?: string;
}

interface AgentStreamCardState {
  cardId: string;
  messageId?: string;
  sequence: number;
  channelId: string;
  showThinking: boolean;
  sessionTitle?: CardTitle;
  sessionTemplate?: string;
  lastHash: string;
  lastSegments: AgentStreamSegment[];
  mcpReplies: Array<{ text: string; insertAt: number }>;
  pendingQuestion?: {
    text: string;
    options: string[];
    footer?: string;
  };
  /** 问题收口后的状态行（✅ 已选择 / ⌛ 已关闭）：走 footer 渲染保留分隔线 */
  closedFooter?: string;
  /** 建卡时刻：无 cardId 的延迟 finish 用，避免误杀刚建的新卡 */
  createdAt: number;
  /** 发卡后待补发的 @ 标签（正文已并入流式卡，finish 时单独 reply 触发通知） */
  pendingAtMentions?: string[];
  /** 串行 CardKit 写操作，避免与 SDK update / MCP merge 撞 sequence */
  inflight: Promise<unknown>;
  /** 思考/工具块稳定 id 与展开态追踪（splice 后 element_id 不复用） */
  panelSeq: number;
  knownPanelIds: Set<string>;
  expandedPanelIds: Set<string>;
}

const agentStreamCards = new Map<string, AgentStreamCardState>();
// ── 卡片操作全序链 ──────────────────────────────────────
// 同一张卡有四个并发写入方：SDK 思考/工具流、MCP send_*、消息投递收口、飞书按钮回调。
// 全部排进 per-session 单链按到达顺序执行——判定与动作同一临界区，渲染状态机等效单输入流。
const cardOpChains = new Map<string, Promise<void>>();

function enqueueCardOp<T>(sessionKey: string, fn: () => Promise<T> | T): Promise<T> {
  const prev = cardOpChains.get(sessionKey) ?? Promise.resolve();
  const next = prev.then(fn, fn);
  const tail = next.then(() => undefined, () => undefined);
  cardOpChains.set(sessionKey, tail);
  // 链跑完且没人接在后面就摘掉，否则每个历史会话都永久占一条 Promise 链
  void tail.then(() => {
    if (cardOpChains.get(sessionKey) === tail) cardOpChains.delete(sessionKey);
  });
  return next;
}

/**
 * 每会话最近一次收口时刻。SDK 队列自带诞生时刻（bornAt，同机时钟可比）：
 * 诞生早于收口 = 旧回合的时间线，ensure/update 一律拒绝（gone）——幂等判定，
 * 连续多个旧请求都会被正确拒绝（此前的一次性消费标记会放过第二个）。
 * 收口后诞生的新回合队列正常放行，新思考不再被误丢。
 */
const sessionCardSealAt = new Map<string, number>();
const CARD_SEAL_STALE_TTL_MS = 60_000;
const CARD_SEAL_MAP_MAX = 500;

function markCardSealed(sessionKey: string): void {
  // 按插入序淘汰最早的：每次 set 前先 delete，保证活跃会话排到队尾不被误删
  sessionCardSealAt.delete(sessionKey);
  if (sessionCardSealAt.size >= CARD_SEAL_MAP_MAX) {
    const oldest = sessionCardSealAt.keys().next().value;
    if (oldest) sessionCardSealAt.delete(oldest);
  }
  sessionCardSealAt.set(sessionKey, Date.now());
}

function isStaleQueue(sessionKey: string, queueBornAt?: number): boolean {
  const sealAt = sessionCardSealAt.get(sessionKey);
  if (sealAt === undefined) return false;
  if (queueBornAt && queueBornAt > sealAt) return false;
  // 无 bornAt（异常/旧版）只在收口后短窗内视为旧队列，避免永久拒绝
  if (!queueBornAt && Date.now() - sealAt >= CARD_SEAL_STALE_TTL_MS) return false;
  return true;
}

function resolveStreamCardChrome(ch: Extract<ResolvedChannel, { type: "feishu" }>, sessionKey: string): {
  sessionTitle?: CardTitle; sessionTemplate?: string;
} {
  const sessionTitle = resolveReplyTitle(ch, sessionKey);
  const sessionTemplate = sessionHeaderTemplate(sessionKey) || (sessionTitle ? "turquoise" : undefined);
  return { sessionTitle, sessionTemplate };
}

function hashStreamPart(s: string): string {
  return createHash("sha1").update(s).digest("hex").slice(0, 16);
}

function formatThinkingDuration(ms?: number, finished?: boolean): string {
  if (ms == null || ms < 0) return finished ? "💭 思考完成" : "💭 思考中…";
  const sec = (ms / 1000).toFixed(1);
  return `💭 思考了 ${sec}s`;
}

function resolveToolIcon(name: string): string {
  const n = name.trim().toLowerCase().replace(/-/g, "_");
  const table: Array<{ aliases: string[]; icon: string }> = [
    { aliases: ["skill"], icon: "app-default_outlined" },
    { aliases: ["read", "open"], icon: "file-link-text_outlined" },
    { aliases: ["write", "edit", "strreplace", "search_replace"], icon: "edit_outlined" },
    { aliases: ["web_search", "websearch", "search"], icon: "search_outlined" },
    { aliases: ["web_fetch", "webfetch", "fetch"], icon: "language_outlined" },
    { aliases: ["grep"], icon: "doc-search_outlined" },
    { aliases: ["glob"], icon: "folder_outlined" },
    { aliases: ["shell", "bash", "exec", "command", "run", "terminal"], icon: "setting_outlined" },
    { aliases: ["browser", "playwright", "navigate"], icon: "browser-mac_outlined" },
    { aliases: ["agent", "task", "spawn"], icon: "robot_outlined" },
    { aliases: ["check", "determine", "verify"], icon: "list-check_outlined" },
  ];
  for (const row of table) {
    if (row.aliases.some((a) => n === a || n.includes(a))) return row.icon;
  }
  return "setting-inter_outlined";
}

function mapToolStepStatus(status: string, finish: boolean): "running" | "success" | "error" {
  if (status === "error") return "error";
  // 收口后不残留 running：终态事件丢失（换卡竞态/run中断）时按成功渲染
  if (status === "running") return finish ? "success" : "running";
  return "success";
}

function isSubagentToolName(name: string): boolean {
  const n = name.trim().toLowerCase();
  return n === "task" || n.startsWith("task ") || n.startsWith("🤖") || n.includes("subagent");
}

function buildToolSteps(tools: AgentStreamToolItem[], finish: boolean): Array<{
  title: string; status: string; detail?: string; icon?: string;
}> {
  return tools.map((t) => {
    const sub = isSubagentToolName(t.name);
    const title = sub && !t.name.includes("Subagent") && !t.name.startsWith("🤖")
      ? `🤖 Subagent · ${t.name}`
      : t.name;
    return {
      title,
      status: mapToolStepStatus(t.status, finish),
      detail: t.summary?.trim() || undefined,
      icon: resolveToolIcon(t.name),
    };
  });
}

function buildToolsPanelTitle(tools: AgentStreamToolItem[]): string {
  const hasSub = tools.some((t) => isSubagentToolName(t.name));
  const runningSub = tools.some((t) => isSubagentToolName(t.name) && t.status === "running");
  if (runningSub) return `🤖 Subagent 执行中 · 工具 ${tools.length} 步`;
  if (hasSub) return `🛠️ 工具执行 · ${tools.length} 步（含 Subagent）`;
  return `🛠️ 工具执行 · ${tools.length} 步`;
}

function normalizeAgentStreamPayload(body: {
  segments?: AgentStreamSegment[];
  thinking?: string;
  thinkingMs?: number;
  tools?: AgentStreamToolItem[];
  reply?: string;
  markdown?: string;
}): AgentStreamCardPayload {
  if (Array.isArray(body.segments) && body.segments.length) {
    return { segments: body.segments };
  }
  // 旧客户端：扁平字段 → 单段时间线
  const thinking = typeof body.thinking === "string" ? body.thinking : "";
  const tools = Array.isArray(body.tools) ? body.tools : [];
  const reply = typeof body.reply === "string" ? body.reply
    : (typeof body.markdown === "string" ? body.markdown : "");
  const segments: AgentStreamSegment[] = [];
  if (thinking.trim()) segments.push({ type: "thinking", text: thinking, ms: body.thinkingMs });
  if (tools.length) segments.push({ type: "tools", tools });
  if (reply.trim()) segments.push({ type: "reply", text: reply });
  return { segments, thinking, thinkingMs: body.thinkingMs, tools, reply };
}

function ensureSegmentPanelIds(
  panelState: StreamPanelState,
  segments: AgentStreamSegment[],
  prevSegments?: AgentStreamSegment[],
): void {
  const prevFold = prevSegments?.filter((s) => s.type === "thinking" || s.type === "tools") ?? [];
  let fi = 0;
  for (const seg of segments) {
    if (seg.type !== "thinking" && seg.type !== "tools") continue;
    if (seg.panelId) {
      fi++;
      continue;
    }
    const old = prevFold[fi];
    if (old?.panelId && old.type === seg.type) {
      seg.panelId = old.panelId;
    } else {
      const prefix = seg.type === "thinking" ? "t" : "o";
      seg.panelId = `${prefix}${++panelState.panelSeq}`;
    }
    fi++;
  }
}

type CardBodySegment =
  | { type: "thinking"; text: string; title?: string; panelId?: string; expanded?: boolean }
  | { type: "tools"; title?: string; panelId?: string; expanded?: boolean; steps: Array<{ title: string; status: string; detail?: string; icon?: string }> }
  | { type: "reply"; text: string }
  | { type: "todos"; items: Array<{ content: string; status: string }> };

function hideThinkingOnFinishEnabled(cfg: { hideThinkingOnFinish?: boolean }): boolean {
  return cfg.hideThinkingOnFinish !== false;
}

function buildCardSegmentsFromPayload(
  payload: AgentStreamCardPayload,
  opts: { finish: boolean; showThinking: boolean; hideThinkingOnFinish?: boolean },
  panelState?: StreamPanelState,
) {
  const stripFoldables = opts.finish && opts.hideThinkingOnFinish !== false;
  const out: CardBodySegment[] = [];
  for (const seg of payload.segments) {
    if (seg.type === "thinking") {
      if (!opts.showThinking || stripFoldables) continue;
      if (!seg.text?.trim()) continue;
      out.push({
        type: "thinking",
        text: seg.text,
        title: formatThinkingDuration(seg.ms, opts.finish || seg.ms != null),
        panelId: seg.panelId,
        expanded: false,
      });
    } else if (seg.type === "tools") {
      if (stripFoldables) continue;
      if (!seg.tools?.length) continue;
      const steps = buildToolSteps(seg.tools, opts.finish);
      out.push({
        type: "tools",
        title: buildToolsPanelTitle(seg.tools),
        panelId: seg.panelId,
        expanded: false,
        steps,
      });
    } else if (seg.type === "todos") {
      if (stripFoldables) continue;
      if (!seg.items?.length) continue;
      out.push({ type: "todos", items: seg.items.map((t) => ({ content: t.content, status: t.status })) });
    } else if (seg.text.trim()) {
      out.push({ type: "reply", text: seg.text });
    }
  }
  if (stripFoldables && !out.some((s) => s.type === "reply" && s.text.trim())) {
    out.push({ type: "reply", text: LarkSender.THINKING_ONLY_PLACEHOLDER });
  }
  // 展开最近 2 个折叠块（思考/工具并排可见）；收口后也保持
  let n = 0;
  for (let i = out.length - 1; i >= 0 && n < 2; i--) {
    const s = out[i];
    if (s.type === "thinking" || s.type === "tools") {
      s.expanded = true;
      n++;
    }
  }
  return out;
}

function payloadFingerprint(payload: AgentStreamCardPayload, finish: boolean): string {
  return hashStreamPart(JSON.stringify({ segments: payload.segments, finish }));
}

/** SDK 侧 reply → 思考；空段丢弃；工具相邻合并（思考保持独立块，不吞旧块）；todos 原样保留 */
function foldSdkRepliesIntoThinking(segments: AgentStreamSegment[]): AgentStreamSegment[] {
  const out: AgentStreamSegment[] = [];
  for (const seg of segments) {
    if (seg.type === "reply") {
      const text = seg.text?.trim();
      if (!text) continue;
      out.push({ type: "thinking", text });
      continue;
    }
    if (seg.type === "thinking") {
      const text = seg.text?.trim();
      if (!text) continue;
      out.push({ ...seg, text });
      continue;
    }
    if (seg.type === "todos") {
      if (seg.items?.length) out.push(seg);
      continue;
    }
    if (!seg.tools?.length) continue;
    const last = out[out.length - 1];
    if (last?.type === "tools") last.tools.push(...seg.tools);
    else out.push({ type: "tools", tools: [...seg.tools], panelId: seg.panelId });
  }
  return out;
}

/** 最终时间线：空丢弃；工具/正文相邻合并；思考保持独立块（不吞旧块）；todos 原样保留 */
function coalesceTimeline(segments: AgentStreamSegment[]): AgentStreamSegment[] {
  const out: AgentStreamSegment[] = [];
  for (const seg of segments) {
    if (seg.type === "thinking") {
      const text = seg.text?.trim();
      if (!text) continue;
      out.push({ ...seg, text });
      continue;
    }
    if (seg.type === "reply") {
      const text = seg.text?.trim();
      if (!text) continue;
      const last = out[out.length - 1];
      if (last?.type === "reply") {
        last.text = last.text.trim() ? `${last.text}\n\n${text}` : text;
      } else out.push({ type: "reply", text });
      continue;
    }
    if (seg.type === "todos") {
      if (seg.items?.length) out.push(seg);
      continue;
    }
    if (!seg.tools?.length) continue;
    const last = out[out.length - 1];
    if (last?.type === "tools") last.tools.push(...seg.tools);
    else out.push({ type: "tools", tools: [...seg.tools], panelId: seg.panelId });
  }
  return out;
}

/** send_* 入队正文：插到当前时间线末尾（避免 SDK 未 flush 时 insertAt=0 导致正文跑到思考前） */
function enqueueMcpBody(state: AgentStreamCardState, text: string): void {
  const t = text.trim();
  if (!t) return;
  const insertAt = foldSdkRepliesIntoThinking(state.lastSegments).length;
  const last = state.mcpReplies[state.mcpReplies.length - 1];
  // 连续 send：合并到同一插入点
  if (last && last.insertAt >= insertAt) {
    last.text = last.text.trim() ? `${last.text}\n\n${t}` : t;
    last.insertAt = Math.max(last.insertAt, insertAt);
    return;
  }
  state.mcpReplies.push({ text: t, insertAt });
}

function overlayMcpOnPayload(state: AgentStreamCardState, sdkSegments: AgentStreamSegment[]): AgentStreamSegment[] {
  const segs = foldSdkRepliesIntoThinking(sdkSegments);
  const injections = [...state.mcpReplies].sort((a, b) => a.insertAt - b.insertAt);
  let offset = 0;
  for (const item of injections) {
    if (!item.text.trim()) continue;
    // 下限为记录点，上限为当前末尾——SDK 后续追加的思考/工具仍排在 MCP 正文之后
    const idx = Math.min(Math.max(item.insertAt, 0) + offset, segs.length);
    segs.splice(idx, 0, { type: "reply", text: item.text });
    offset++;
  }
  return coalesceTimeline(segs);
}

async function refreshAgentStreamCard(
  sessionKey: string,
  state: AgentStreamCardState,
  ch: Extract<ResolvedChannel, { type: "feishu" }>,
  opts: { finish: boolean },
): Promise<boolean> {
  const run = async (): Promise<boolean> => {
    // 每次刷新读 live 开关，避免创建卡后改设置不生效
    state.showThinking = ch.rt.cfg.showThinking !== false;
    if (!state.knownPanelIds) state.knownPanelIds = new Set();
    if (!state.expandedPanelIds) state.expandedPanelIds = new Set();
    if (state.panelSeq == null) state.panelSeq = 0;
    ensureSegmentPanelIds(state, state.lastSegments);
    const merged: AgentStreamCardPayload = { segments: overlayMcpOnPayload(state, state.lastSegments) };
    ensureSegmentPanelIds(state, merged.segments, state.lastSegments);
    const q = state.pendingQuestion;
    let closedReply: string | undefined;
    if (state.closedFooter) {
      for (let i = merged.segments.length - 1; i >= 0; i--) {
        const s = merged.segments[i];
        if (s.type === "reply" && s.text.trim()) { closedReply = s.text.trim(); break; }
      }
    }
    const questionTextRaw = q?.text.trim() || closedReply;
    if (questionTextRaw) {
      merged.segments = merged.segments.filter((s) => !(s.type === "reply" && s.text.trim() === questionTextRaw));
    }
    const questionText = q?.options?.length
      ? questionBodyWithOptions(questionTextRaw || "", q.options)
      : questionTextRaw;
    const cardSegs = buildCardSegmentsFromPayload(merged, {
      finish: opts.finish,
      showThinking: state.showThinking,
      hideThinkingOnFinish: hideThinkingOnFinishEnabled(ch.rt.cfg),
    }, state);
    const buttons = q ? questionOptionButtons(q.options, sessionKey) : undefined;
    const status = (opts.finish || q) ? "completed" as const : "streaming" as const;
    const qFoot = q ? QUESTION_CARD_HINT : state.closedFooter;
    const cardJson = LarkSender.buildStreamingCardJson({
      status,
      showThinking: state.showThinking,
      keepPerKind: LarkSender.normalizeStreamKeepPerKind(ch.rt.cfg.streamKeepPerKind),
      sessionTitle: state.sessionTitle,
      sessionTemplate: state.sessionTemplate,
      segments: cardSegs,
      questionText,
      buttons,
      footer: qFoot,
      panelState: state,
    });
    const sender = ch.rt.sender!;
    if (status !== "streaming") {
      state.sequence += 1;
      const closed = await sender.closeStreamingCard(state.cardId, state.sequence);
      if (!closed) {
        // cardJson 已带 streaming_mode:false；close 失败仍继续全量 update，避免卡死
        log("WARN", `[StreamCard] close 失败仍继续 update session=${sessionKey} seq=${state.sequence}`);
      }
    }
    state.sequence += 1;
    const ok = await sender.updateStreamingCard(state.cardId, cardJson, state.sequence);
    if (ok) state.lastHash = payloadFingerprint(merged, opts.finish);
    return ok;
  };
  const next = state.inflight.then(run, run);
  state.inflight = next.then(() => undefined, () => undefined);
  return next;
}


function isStreamCardEnabled(ch: Extract<ResolvedChannel, { type: "feishu" }>): boolean {
  return ch.rt.cfg.showThinking !== false;
}

function isGroupFeishuChat(ch: Extract<ResolvedChannel, { type: "feishu" }>): boolean {
  if (!ch.chatId) return false;
  const chatKey = makeChatKey(ch.rt.cfg.id, ch.chatId);
  const ct = chatTypeByChatKey.get(chatKey) || chatTypeByChatKey.get(ch.chatId);
  return ct === "group";
}

function mergePendingAtMentions(state: AgentStreamCardState, tags: string[]): void {
  if (!tags.length) return;
  const existing = state.pendingAtMentions ?? [];
  const seen = new Set(existing.map((t) => t.match(/user_id="([^"]+)"/)?.[1] ?? t));
  for (const tag of tags) {
    const id = tag.match(/user_id="([^"]+)"/)?.[1] ?? tag;
    if (seen.has(id)) continue;
    seen.add(id);
    existing.push(tag);
  }
  state.pendingAtMentions = existing;
}

async function dispatchPendingAtMentions(
  state: AgentStreamCardState,
  ch: Extract<ResolvedChannel, { type: "feishu" }>,
): Promise<void> {
  const tags = state.pendingAtMentions;
  if (!tags?.length || !state.messageId || !isGroupFeishuChat(ch)) return;
  state.pendingAtMentions = undefined;
  const sentId = await ch.rt.sender!.sendMessage(tags.join(" "), state.messageId);
  if (sentId) log("INFO", `[AtMention] 已发卡后 @ 通知 reply=${state.messageId} msg=${sentId}`);
  else log("WARN", `[AtMention] 发卡后 @ 通知失败 reply=${state.messageId}`);
}

/** 无活跃流式卡时先建卡，供 send_text/send_question 抢先合并（ACK 早于思考/工具）。整体入全序链。 */
async function ensureStreamCardForMcpMerge(
  sessionKey: string,
  ch: Extract<ResolvedChannel, { type: "feishu" }>,
  firstBody?: string,
): Promise<{ state?: AgentStreamCardState; bodyMerged: boolean }> {
  if (!isStreamCardEnabled(ch)) return { bodyMerged: false };
  // 应用无 cardkit 权限：直接走普通消息，不白撞建卡 API
  if (ch.rt.sender?.isCardkitDenied()) return { bodyMerged: false };
  return enqueueCardOp(sessionKey, async () => {
    // firstBody 语义 = 「确保正文落卡」：链内执行，无论新建还是并入已有卡都不丢正文
    const ensured = await ensureAgentStreamCard(sessionKey, { segments: [] }, ch, firstBody);
    if (!ensured.ok) {
      log("WARN", `[StreamCard] MCP 合并建卡失败: ${ensured.error ?? "unknown"}`);
      return { bodyMerged: false };
    }
    return { state: agentStreamCards.get(sessionKey), bodyMerged: ensured.bodyMerged === true };
  });
}

/** 仅允许在 enqueueCardOp 链内调用（全序保证判定与动作原子） */
async function ensureAgentStreamCard(
  sessionKey: string,
  payload: AgentStreamCardPayload,
  ch: Extract<ResolvedChannel, { type: "feishu" }>,
  mcpBody?: string,
): Promise<{ ok: boolean; cardId?: string; messageId?: string; error?: string; bodyMerged?: boolean; skipped?: boolean }> {
  if (ch.rt.sender?.isCardkitDenied()) {
    return { ok: false, error: "应用未开通 cardkit:card:write，流式卡已降级普通消息", skipped: true };
  }
  const body = mcpBody?.trim();
  const existing = agentStreamCards.get(sessionKey);
  if (existing) {
    // MCP 已建空卡时，SDK ensure 须把当前队列写入，否则会一直只有 send_* 正文
    if (payload.segments.length) {
      const prev = [...existing.lastSegments];
      existing.lastSegments = payload.segments;
      ensureSegmentPanelIds(existing, existing.lastSegments, prev);
      // 未决问题等待用户：只记 segments，禁止刷卡（否则清空飞书输入框）
      if (!existing.pendingQuestion) {
        await refreshAgentStreamCard(sessionKey, existing, ch, { finish: false });
      }
    }
    // mcpBody 语义 = 「确保这段正文落卡」：SDK 竞态先建卡时正文必须并入已有卡，
    // 绝不能静默丢弃（曾导致回复被吞：Agent 报成功但用户看不到正文）
    if (body && !existing.pendingQuestion) {
      enqueueMcpBody(existing, body);
      const merged = await refreshAgentStreamCard(sessionKey, existing, ch, { finish: false });
      return { ok: true, cardId: existing.cardId, messageId: existing.messageId, bodyMerged: merged };
    }
    return { ok: true, cardId: existing.cardId, messageId: existing.messageId, bodyMerged: false };
  }
  const sender = ch.rt.sender!;
  const showThinking = ch.rt.cfg.showThinking !== false;
  const keepPerKind = LarkSender.normalizeStreamKeepPerKind(ch.rt.cfg.streamKeepPerKind);
  const chrome = resolveStreamCardChrome(ch, sessionKey);
  if (!ch.chatId) return { ok: false, error: "无法解析发送目标 chatId" };
  // MCP 首段正文随建卡一次渲染到位（reply 通道，绕过 fold 防降级为思考），避免空白卡闪现
  const mcpReplies: Array<{ text: string; insertAt: number }> = mcpBody?.trim()
    ? [{ text: mcpBody.trim(), insertAt: 0 }]
    : [];
  const folded: AgentStreamCardPayload = { segments: foldSdkRepliesIntoThinking(payload.segments) };
  if (mcpReplies.length) folded.segments = [...folded.segments, { type: "reply", text: mcpReplies[0].text }];
  const panelBoot: StreamPanelState = { panelSeq: 0, knownPanelIds: new Set(), expandedPanelIds: new Set() };
  ensureSegmentPanelIds(panelBoot, folded.segments);
  let segments = buildCardSegmentsFromPayload(folded, { finish: false, showThinking }, panelBoot);
  // 空卡也能创建（仅会话条）；无 chrome 时放极短占位，避免飞书拒空 body
  if (!segments.length && !chrome.sessionTitle) {
    segments = [{ type: "reply", text: "…" }];
  }
  const cardId = await sender.createStreamingCardEntity({
    showThinking,
    keepPerKind,
    segments,
    sessionTitle: chrome.sessionTitle,
    sessionTemplate: chrome.sessionTemplate,
  });
  if (!cardId) return { ok: false, error: "创建流式卡片失败（检查 cardkit:card:write 权限）" };
  const sentMsgId = await sender.sendCardEntity(cardId, undefined, ch.chatId);
  if (sentMsgId === undefined) {
    return { ok: false, error: "发送流式卡片失败" };
  }
  const messageId = typeof sentMsgId === "string" ? sentMsgId : undefined;
  agentStreamCards.set(sessionKey, {
    cardId,
    messageId,
    sequence: 0,
    channelId: ch.rt.cfg.id,
    showThinking,
    sessionTitle: chrome.sessionTitle,
    sessionTemplate: chrome.sessionTemplate,
    lastHash: payloadFingerprint(payload, false),
    lastSegments: [...folded.segments],
    mcpReplies,
    createdAt: Date.now(),
    inflight: Promise.resolve(),
    panelSeq: panelBoot.panelSeq,
    knownPanelIds: panelBoot.knownPanelIds,
    expandedPanelIds: panelBoot.expandedPanelIds,
  });
  if (messageId) trackMessageSession(messageId, sessionKey);
  rememberSessionKey(sessionKey);
  log("INFO", `[StreamCard] 已创建 session=${sessionKey} card=${cardId} msg=${messageId ?? "(none)"} segs=${payload.segments.length}${mcpReplies.length ? " +body" : ""}`);
  return { ok: true, cardId, messageId, bodyMerged: mcpReplies.length > 0 };
}


async function updateAgentStreamCard(
  sessionKey: string,
  payload: AgentStreamCardPayload,
  ch: Extract<ResolvedChannel, { type: "feishu" }>,
  expectCardId?: string,
): Promise<{ ok: boolean; cardId?: string; messageId?: string; error?: string; gone?: boolean }> {
  let state = agentStreamCards.get(sessionKey);
  if (!state) {
    const ensured = await ensureAgentStreamCard(sessionKey, payload, ch);
    if (!ensured.ok) return ensured;
    return { ok: true, cardId: ensured.cardId, messageId: ensured.messageId };
  }
  // 代际校验：SDK 带的是旧卡队列（卡已被收口、当前是新卡）——丢弃，防旧时间线污染新卡
  if (expectCardId && state.cardId !== expectCardId) {
    log("INFO", `[StreamCard] update 旧卡队列已过期 expect=${expectCardId} live=${state.cardId} session=${sessionKey}`);
    return { ok: true, gone: true, cardId: state.cardId };
  }
  // 空时间线不覆盖已有内容（队列语义：空的丢弃）
  if (payload.segments.length) {
    const prev = [...state.lastSegments];
    state.lastSegments = payload.segments;
    ensureSegmentPanelIds(state, state.lastSegments, prev);
  }
  // 未决问题等待用户：禁止刷卡，避免清空飞书自定义输入
  if (state.pendingQuestion) {
    return { ok: true, cardId: state.cardId, messageId: state.messageId };
  }
  if (!state.mcpReplies.length) {
    const merged: AgentStreamCardPayload = { segments: overlayMcpOnPayload(state, state.lastSegments) };
    const fp = payloadFingerprint(merged, false);
    if (fp === state.lastHash) {
      return { ok: true, cardId: state.cardId, messageId: state.messageId };
    }
  }
  const ok = await refreshAgentStreamCard(sessionKey, state, ch, { finish: false });
  if (!ok) return { ok: false, cardId: state.cardId, messageId: state.messageId, error: "更新流式卡片失败" };
  return { ok: true, cardId: state.cardId, messageId: state.messageId };
}

/**
 * daemon 内存无卡时按 cardId 收口飞书孤儿流式卡（pack/进程重启后常见）。
 * sequence 必须大于卡已用值（严格递增），用秒级时间戳恒大于计数器；
 * 只关 streaming_mode 不全量 update——daemon 不知道卡内容，空 segments 会把正文冲掉。
 */
async function finishOrphanStreamCardById(
  cardId: string,
  ch: Extract<ResolvedChannel, { type: "feishu" }>,
): Promise<boolean> {
  const sender = ch.rt.sender!;
  try {
    return await sender.closeStreamingCard(cardId, Math.floor(Date.now() / 1000));
  } catch (e: any) {
    log("WARN", `[StreamCard] 孤儿卡收口失败 card=${cardId}: ${e?.message ?? e}`);
    return false;
  }
}

async function finishAgentStreamCard(
  sessionKey: string,
  payload: AgentStreamCardPayload,
  ch: Extract<ResolvedChannel, { type: "feishu" }>,
  expectCardId?: string,
): Promise<{ ok: boolean; cardId?: string; messageId?: string; error?: string; skipped?: boolean }> {
  const state = agentStreamCards.get(sessionKey);
  if (!state) {
    if (expectCardId) {
      const ok = await finishOrphanStreamCardById(expectCardId, ch);
      if (ok) log("INFO", `[StreamCard] 已收口孤儿卡 card=${expectCardId} session=${sessionKey}`);
      return { ok, cardId: expectCardId };
    }
    return { ok: true };
  }
  // 延迟 finish 常晚于下一轮建卡：必须按 cardId 对齐，否则会误杀新卡导致「一切多条」
  if (expectCardId && state.cardId !== expectCardId) {
    log("INFO", `[StreamCard] finish 忽略过期卡 expect=${expectCardId} live=${state.cardId} session=${sessionKey}`);
    return { ok: true, skipped: true, cardId: expectCardId };
  }
  if (!expectCardId) {
    const age = Date.now() - (state.createdAt || 0);
    if (age < 3000) {
      log("WARN", `[StreamCard] finish 无 cardId 且卡过新(${age}ms)，跳过防误杀 session=${sessionKey} card=${state.cardId}`);
      return { ok: true, skipped: true, cardId: state.cardId };
    }
  }
  // 空时间线不覆盖（队列语义：空的丢弃），避免收口把卡冲短
  if (payload.segments.length) {
    const prev = [...state.lastSegments];
    state.lastSegments = payload.segments;
    ensureSegmentPanelIds(state, state.lastSegments, prev);
  }
  // 未决问题：send_question 已 finish+展示输入框，再刷会清空用户正在输入的内容
  if (state.pendingQuestion) {
    log("INFO", `[StreamCard] finish 跳过未决问题卡 session=${sessionKey} card=${state.cardId}`);
    return { ok: true, skipped: true, cardId: state.cardId, messageId: state.messageId };
  }
  // 摘卡收口；此后到达链上的 send_* 走新卡，旧队列 ensure/update 按 sealAt 拒绝
  agentStreamCards.delete(sessionKey);
  markCardSealed(sessionKey);
  const ok = await refreshAgentStreamCard(sessionKey, state, ch, { finish: true });
  if (!ok) {
    // 状态已摘，再失败就没人能关这张卡了：至少把 streaming 灭掉，不留转圈的孤儿卡
    await finishOrphanStreamCardById(state.cardId, ch);
    return { ok: false, cardId: state.cardId, messageId: state.messageId, error: "结束流式卡片失败" };
  }
  await dispatchPendingAtMentions(state, ch);
  const result = { ok: true, cardId: state.cardId, messageId: state.messageId };
  log("INFO", `[StreamCard] 已结束 session=${sessionKey} card=${result.cardId}`);
  return result;
}

/**
 * 消息送达（含重投）：收口当前卡，后续回复走新卡；未决问题转存正文防内容丢失。入全序链执行。
 * 投递路径必须 await 完成后再响应 poll——顺序保证「收口时刻早于 Agent 收到消息」，
 * 新回合队列的诞生时间恒晚于收口时间，建卡放行不再依赖毫秒时序。
 */
async function closeOpenQuestionsForSession(sessionKey: string, note: string): Promise<void> {
  await sealActiveStreamCardOnDelivery(sessionKey);
  await expireOpenCardQuestionsForSession(sessionKey, note);
}

function sealActiveStreamCardOnDelivery(sessionKey: string): Promise<void> {
  return enqueueCardOp(sessionKey, async () => {
    const state = agentStreamCards.get(sessionKey);
    if (!state) return;
    agentStreamCards.delete(sessionKey);
    markCardSealed(sessionKey);
    const q = state.pendingQuestion;
    if (q) {
      state.pendingQuestion = undefined;
      if (q.text.trim()) {
        enqueueMcpBody(state, q.text.trim());
        state.closedFooter = closedQuestionFooter(q.text, "已有新消息，问题已关闭");
      } else {
        state.closedFooter = "⌛ _已有新消息，问题已关闭_";
      }
      if (state.messageId) {
        cardQuestionMap.delete(state.messageId);
        scheduleCardQuestionSave();
      }
    }
    const ch = resolveChannel(sessionKey, { allowDefault: false });
    if (ch.type !== "feishu") return;
    const ok = await refreshAgentStreamCard(sessionKey, state, ch, { finish: true });
    if (!ok) {
      log("WARN", `[StreamCard] 消息送达收口失败 session=${sessionKey} card=${state.cardId}`);
      await finishOrphanStreamCardById(state.cardId, ch);
    } else {
      await dispatchPendingAtMentions(state, ch);
    }
  });
}


// ── 卡片按钮回调 ─────────────────────────────────────────

interface CardQuestionEntry { text: string; displayBody?: string; options: string[]; sessionKey?: string; chatKey?: string; createdAt: number; title?: CardTitle; template?: string; isStreamCard?: boolean }
const cardQuestionMap = new Map<string, CardQuestionEntry>();
const CARD_QUESTION_MAX = 500;
const QUESTION_CARD_HINT = "<font color='grey'>请选择上方选项或直接输入</font>";
const CARD_QUESTION_FILE = path.join(APP_DATA_DIR, "card-questions.json");
let cardQuestionSaveTimer: NodeJS.Timeout | null = null;

function loadCardQuestions(): void {
  try {
    if (!APP_DATA_DIR || !fs.existsSync(CARD_QUESTION_FILE)) return;
    const raw = JSON.parse(fs.readFileSync(CARD_QUESTION_FILE, "utf-8")) as Record<string, CardQuestionEntry>;
    const now = Date.now();
    let n = 0;
    for (const [id, entry] of Object.entries(raw)) {
      if (!entry?.text || !id) continue;
      // 丢弃超过 24h 的未决卡，避免永久堆积
      if (entry.createdAt && now - entry.createdAt > 24 * 3600_000) continue;
      cardQuestionMap.set(id, entry);
      n++;
    }
    log("INFO", `[CardQ] 未决问题卡已恢复: ${n}`);
  } catch (e: any) {
    log("WARN", `[CardQ] 恢复失败: ${e?.message ?? e}`);
  }
}

function scheduleCardQuestionSave(): void {
  if (!APP_DATA_DIR || cardQuestionSaveTimer) return;
  cardQuestionSaveTimer = setTimeout(() => {
    cardQuestionSaveTimer = null;
    try {
      const data = Object.fromEntries(cardQuestionMap);
      fs.writeFileSync(CARD_QUESTION_FILE + ".tmp", JSON.stringify(data));
      fs.renameSync(CARD_QUESTION_FILE + ".tmp", CARD_QUESTION_FILE);
    } catch { /* ignore */ }
  }, 500);
  cardQuestionSaveTimer.unref?.();
}

function handleMessageRecalled(rt: ChannelRuntime, messageId: string, chatId: string, recallType?: string): void {
  try {
    const { removed, sessionKeys } = deleteQueueMessagesByMessageId(messageId);
    if (cardQuestionMap.has(messageId)) {
      cardQuestionMap.delete(messageId);
      scheduleCardQuestionSave();
    }
    if (removed > 0) {
      log("INFO", `[${rt.cfg.name}] 消息已撤回，移出队列 ${removed} 条 messageId=${messageId} chat=${chatId} recall=${recallType ?? "?"}`);
      for (const sk of sessionKeys) broadcastQueueEvent(sk);
    } else {
      log("DEBUG", `[${rt.cfg.name}] 消息撤回（队列无匹配）messageId=${messageId} chat=${chatId} recall=${recallType ?? "?"}`);
    }
  } catch (e: any) {
    log("WARN", `[${rt.cfg.name}] 撤回处理失败: ${e?.message ?? e}`);
  }
}

function rememberCardQuestion(messageId: string, entry: CardQuestionEntry): void {
  if (cardQuestionMap.size >= CARD_QUESTION_MAX) {
    const oldest = cardQuestionMap.keys().next().value;
    if (oldest) cardQuestionMap.delete(oldest);
  }
  cardQuestionMap.set(messageId, entry);
  scheduleCardQuestionSave();
}

function expireOpenCardQuestions(chatKey: string, note: string): void {
  if (!chatKey) return;
  const targets: { messageId: string; entry: CardQuestionEntry }[] = [];
  for (const [messageId, entry] of cardQuestionMap) {
    const ck = entry.chatKey || (entry.sessionKey ? chatIdFromSessionKey(entry.sessionKey) : undefined);
    if (ck === chatKey) targets.push({ messageId, entry });
  }
  if (targets.length === 0) {
    if (cardQuestionMap.size > 0) {
      log("INFO", `关闭问题卡片: 本聊天无登记 (chat=${chatKey}, map=${cardQuestionMap.size})`);
    }
    return;
  }
  const ch = resolveChannel(chatKey, { allowDefault: false });
  if (ch.type !== "feishu" || !ch.rt.sender) {
    log("WARN", `关闭问题卡片: 通道不可用，保留登记以便重试 (chat=${chatKey}, n=${targets.length})`);
    return;
  }
  const sender = ch.rt.sender;
  let closed = 0;
  for (const { messageId, entry } of targets) {
    void (async () => {
      const ok = await sealQuestionCardByMessageId(messageId, entry, note)
        || await sender.patchCard(messageId, entry.displayBody ?? questionDisplayBody(entry.text, 120), entry.title, entry.template, `⌛ _${note}_`);
      if (ok) {
        cardQuestionMap.delete(messageId);
        scheduleCardQuestionSave();
      } else {
        log("WARN", `关闭问题卡片未成功，保留登记: ${messageId}`);
      }
    })().catch((e: any) => log("WARN", `关闭问题卡片失败: ${e?.message ?? e}`));
    closed++;
  }
  log("INFO", `已请求关闭 ${closed} 张未决问题卡片 (chat=${chatKey})`);
}

/** 按 messageId 定位活跃流式卡并在全序链内收口（题干进正文 + 状态行 footer）；无匹配卡返回 false */
async function sealQuestionCardByMessageId(messageId: string, entry: CardQuestionEntry, note: string): Promise<boolean> {
  let hitSk: string | undefined;
  for (const [sk, state] of agentStreamCards) {
    if (state.messageId === messageId) { hitSk = sk; break; }
  }
  if (!hitSk) return false;
  const sk = hitSk;
  return enqueueCardOp(sk, async () => {
    const state = agentStreamCards.get(sk);
    if (!state || state.messageId !== messageId) return false;
    // 问题已关/已答但 map 残留：不 seal 活卡，让 expire 路径只清 map
    if (!state.pendingQuestion) return false;
    agentStreamCards.delete(sk);
    markCardSealed(sk);
    const qText = (state.pendingQuestion?.text ?? entry.displayBody ?? entry.text ?? "").trim();
    state.pendingQuestion = undefined;
    if (qText) enqueueMcpBody(state, qText);
    state.closedFooter = closedQuestionFooter(qText, note);
    const sch = resolveChannel(sk, { allowDefault: false });
    if (sch.type !== "feishu") return false;
    return refreshAgentStreamCard(sk, state, sch, { finish: true });
  });
}

/** 问题卡正文（发题/终态共用）；Agent text 原样上卡，仅 trim / 可选截断 */
function questionDisplayBody(raw: string, maxLen?: number): string {
  let t = raw.trim();
  if (maxLen && maxLen > 0 && t.length > maxLen) t = `${t.slice(0, maxLen)}…`;
  return t;
}

function questionOptionLetter(i: number): string {
  return i < 26 ? String.fromCharCode(65 + i) : String(i + 1);
}

/** 题干 markdown + 选项全文列表（按钮只显示字母，点击仍入队完整 opt） */
function questionBodyWithOptions(raw: string, options: string[], maxLen?: number): string {
  const body = questionDisplayBody(raw, maxLen);
  if (!options.length) return body;
  const list = options.map((o, i) => `**${questionOptionLetter(i)}.** ${o}`).join("\n");
  return body ? `${body}\n\n${list}` : list;
}

function questionOptionButtons(options: string[], sessionKey?: string): CardButton[] {
  return options.map((o, i) => ({
    label: questionOptionLetter(i),
    value: { kind: "question", opt: o, sk: sessionKey },
    type: "default" as const,
  }));
}

/** @deprecated 用 questionDisplayBody；保留别名防漏改 */
function questionBrief(questionText: string, maxLen?: number): string {
  return questionDisplayBody(questionText, maxLen);
}

function closedQuestionFooter(_questionText: string, note: string): string {
  return `⌛ _${note}_`;
}

/** 按 session 关闭未决问题（禁止按 chat 扩散，避免同私聊多会话误伤） */
async function expireOpenCardQuestionsForSession(sessionKey: string | undefined, note: string): Promise<void> {
  if (!sessionKey) return;
  const targets: { messageId: string; entry: CardQuestionEntry }[] = [];
  for (const [messageId, entry] of cardQuestionMap) {
    if (entry.sessionKey === sessionKey) targets.push({ messageId, entry });
  }
  if (!targets.length) return;
  const ch = resolveChannel(sessionKey, { allowDefault: false });
  if (ch.type !== "feishu" || !ch.rt.sender) return;
  const sender = ch.rt.sender;
  for (const { messageId, entry } of targets) {
    try {
      const ok = await sealQuestionCardByMessageId(messageId, entry, note);
      if (ok) {
        cardQuestionMap.delete(messageId);
        scheduleCardQuestionSave();
        continue;
      }
      if (entry.isStreamCard) {
        cardQuestionMap.delete(messageId);
        scheduleCardQuestionSave();
        log("INFO", `流式问题卡已收口或不存在，跳过 patchCard: ${messageId}`);
        continue;
      }
      const patched = await sender.patchCard(
        messageId, entry.displayBody ?? questionDisplayBody(entry.text), entry.title, entry.template, closedQuestionFooter(entry.text, note),
      );
      if (patched) {
        cardQuestionMap.delete(messageId);
        scheduleCardQuestionSave();
      } else {
        log("WARN", `关闭问题卡片未成功，保留登记: ${messageId}`);
      }
    } catch (e: any) {
      log("WARN", `关闭问题卡片失败: ${e?.message ?? e}`);
    }
  }
  log("INFO", `已关闭 ${targets.length} 张未决问题卡片 (session=${sessionKey})`);
}

/** 已应答过的问题卡 messageId：防连点/重复提交把同一个选项入队多次 */
const answeredCardQuestions = new Set<string>();
const ANSWERED_CARD_MAX = 500;

function markCardQuestionAnswered(messageId: string): boolean {
  if (!messageId) return true;
  if (answeredCardQuestions.has(messageId)) return false;
  answeredCardQuestions.add(messageId);
  if (answeredCardQuestions.size > ANSWERED_CARD_MAX) {
    const oldest = answeredCardQuestions.values().next().value;
    if (oldest) answeredCardQuestions.delete(oldest);
  }
  return true;
}

/** internal 消息（卡片点击/输入框提交）→ 来源聊天 chatKey；回复 internal 消息时按此路由回原聊天，防止 chat 直发窜台 */
const internalMsgChatMap = new Map<string, string>();

function trackInternalMsgChat(messageId: string, chatKey: string): void {
  if (internalMsgChatMap.size >= CARD_QUESTION_MAX) {
    const oldest = internalMsgChatMap.keys().next().value;
    if (oldest) internalMsgChatMap.delete(oldest);
  }
  internalMsgChatMap.set(messageId, chatKey);
}

/** 发送目标解析：回复 internal 消息时优先路由回其来源聊天（session_key 解析的默认目标可能是别的聊天） */
function routeTargetKey(sessionKey?: string, messageId?: string): string | undefined {
  if (messageId?.startsWith("internal_")) {
    const chatKey = internalMsgChatMap.get(messageId);
    if (chatKey) return chatKey;
  }
  if (sessionKey) return sessionKey;
  if (messageId) {
    const sk = messageSessionMap.get(messageId);
    if (sk) return sk;
  }
  return undefined;
}


function findStreamCardByMessageId(messageId: string): { sessionKey: string; state: AgentStreamCardState } | undefined {
  if (!messageId) return undefined;
  for (const [sessionKey, state] of agentStreamCards) {
    if (state.messageId === messageId) return { sessionKey, state };
  }
  return undefined;
}

/**
 * 卡片回调事件不带 chat_type，而飞书 p2p 的 chat_id 同样是 oc_ 开头——只按前缀猜会把
 * 「别人的私聊」判成群，进而污染 chatTypeByChatKey 与群专属路由。优先查收消息时记下的真实类型。
 */
function resolveCardActionChatType(rt: ChannelRuntime, chatKey: string, rawChatId?: string): string {
  const known = chatTypeByChatKey.get(chatKey) || (rawChatId ? chatTypeByChatKey.get(rawChatId) : undefined);
  if (known === "p2p" || known === "group") return known;
  if (rt.cfg.mainUserEnabled && rt.cfg.mainUserChatId === rawChatId) return "p2p";
  return rawChatId?.startsWith("on_") ? "group" : "p2p";
}

/** 卡片按钮点击回调；返回值作为 card.action.trigger 响应（toast + 更新卡片） */
async function handleCardAction(rt: ChannelRuntime, evt: LarkCardActionEvent): Promise<unknown> {
  const value = evt.value as { kind?: string; opt?: string; cmd?: string; sk?: string; approve?: string; dir?: string } | undefined;
  const chatKey = makeChatKey(rt.cfg.id, evt.chatId);

  const panelMatch = evt.elementId?.match(/^(?:think|tool)_(.+)$/);
  if (panelMatch && !value?.kind) {
    const panelId = panelMatch[1];
    const hit = findStreamCardByMessageId(evt.messageId);
    if (hit?.state) {
      if (!hit.state.expandedPanelIds) hit.state.expandedPanelIds = new Set();
      if (evt.expanded === true) hit.state.expandedPanelIds.add(panelId);
      else if (evt.expanded === false) hit.state.expandedPanelIds.delete(panelId);
      else if (hit.state.expandedPanelIds.has(panelId)) hit.state.expandedPanelIds.delete(panelId);
      else hit.state.expandedPanelIds.add(panelId);
      log("INFO", `[StreamCard] 面板展开态 panel=${panelId} open=${hit.state.expandedPanelIds.has(panelId)} msg=${evt.messageId}`);
    }
    return {};
  }

  if (value?.kind === "question") {
    // 按钮点击取 opt；输入框提交取 input_value（自由输入）
    const opt = String(value.opt ?? "").trim() || (evt.inputValue ?? "").trim();
    const entry = cardQuestionMap.get(evt.messageId);
    // 优先 map；map 缺失时用按钮内嵌的 session_key（防 reply 未回 message_id 导致未登记）
    const sessionKey = entry?.sessionKey || value.sk || undefined;
    // 只回 toast：返回 raw card 会把整张流式卡（思考/工具/正文）冲成一行提示
    if (!opt || (!entry && !sessionKey)) {
      return { toast: { type: "warning", content: "该问题已过期，请直接发消息告知选择" } };
    }
    // 连点/重复提交：只回 toast，不重复入队也不动卡片
    if (!markCardQuestionAnswered(evt.messageId)) {
      log("INFO", `[${rt.cfg.name}] 问题卡片重复点击已忽略 (msg=${evt.messageId})`);
      return { toast: { type: "info", content: "已提交，请稍候" } };
    }
    log("INFO", `[${rt.cfg.name}] 问题卡片选择: ${opt} (msg=${evt.messageId}, session=${sessionKey ?? "-"})`);
    if (sessionKey) trackMessageSession(evt.messageId, sessionKey);
    const internalId = `internal_card_${Date.now()}`;
    // 记录来源聊天：Agent 回复这条 internal 消息时按此路由回原聊天（点击发生在哪个聊天就回哪个）
    trackInternalMsgChat(internalId, chatKey);
    // chatType 用点击所在聊天推断，保证 pushMessage 路由稳定
    const chatType = resolveCardActionChatType(rt, chatKey, evt.chatId);
    pushMessage(opt, internalId, chatKey, chatType, evt.operatorOpenId, evt.messageId, { senderType: "user" });
    if (entry) {
      cardQuestionMap.delete(evt.messageId);
      scheduleCardQuestionSave();
    }

    // 流式卡：messageId 对不上时用 sessionKey 兜底；回调里带回 card JSON（去按钮），并 CardKit 刷新
    const streamHit = findStreamCardByMessageId(evt.messageId)
      ?? (sessionKey && agentStreamCards.get(sessionKey)
        ? { sessionKey, state: agentStreamCards.get(sessionKey)! }
        : undefined);
    if (streamHit) {
      const sk = streamHit.sessionKey;
      // 摘卡+收口入全序链：不能同步 delete——链内可能正有 ensure 在建卡，交错会让摘卡丢失
      const cardJson = await enqueueCardOp(sk, (): unknown => {
        const state = agentStreamCards.get(sk);
        if (!state) return undefined;
        agentStreamCards.delete(sk);
        markCardSealed(sk);
        // 短收口：题干走 questionText 区块（已回答布局），footer 显示选择结果；回调一次刷齐，避免二次刷新闪烁
        const qText = (state.pendingQuestion?.text ?? entry?.displayBody ?? entry?.text ?? "").trim();
        state.pendingQuestion = undefined;
        state.closedFooter = `✅ 已选择: **${opt}**`;
        const merged: AgentStreamCardPayload = { segments: overlayMcpOnPayload(state, state.lastSegments) };
        ensureSegmentPanelIds(state, merged.segments, state.lastSegments);
        const chCfg = channels.get(state.channelId)?.cfg;
        const cardSegs = buildCardSegmentsFromPayload(merged, {
          finish: true,
          showThinking: state.showThinking,
          hideThinkingOnFinish: chCfg ? hideThinkingOnFinishEnabled(chCfg) : true,
        }, state);
        return LarkSender.buildStreamingCardJson({
          status: "completed",
          showThinking: state.showThinking,
          keepPerKind: LarkSender.normalizeStreamKeepPerKind(channels.get(state.channelId)?.cfg.streamKeepPerKind),
          sessionTitle: state.sessionTitle,
          sessionTemplate: state.sessionTemplate,
          segments: cardSegs,
          questionText: qText || undefined,
          footer: state.closedFooter,
          panelState: state,
        });
      });
      if (cardJson) {
        return {
          toast: { type: "success", content: `已选择: ${opt.slice(0, 30)}` },
          card: { type: "raw", data: cardJson },
        };
      }
      // 卡已被链上先行收口（如新消息投递抢先 seal）：降级为普通确认卡
    }

    const body = entry?.displayBody ?? questionDisplayBody(entry?.text ?? "问题");
    const title = entry?.title;
    const template = entry?.template;
    return {
      toast: { type: "success", content: `已选择: ${opt.slice(0, 30)}` },
      card: { type: "raw", data: LarkSender.buildCard(body, title, undefined, undefined, template, `✅ 已选择: **${opt}**`) },
    };
  }

  if (value?.kind === "ws_confirm") {
    const approve = String(value.approve ?? "") === "1";
    const dir = String(value.dir ?? "").trim();
    // 只认主用户本人点击（卡片只发主用户私聊，双保险）
    if (!rt.cfg.mainUserEnabled || rt.cfg.mainUserChatId !== evt.chatId) {
      return { toast: { type: "warning", content: "仅主用户可操作" } };
    }
    if (!pendingWorkspaceSwitch || pendingWorkspaceSwitch.dir !== dir) {
      return {
        toast: { type: "warning", content: "该请求已过期" },
        card: { type: "raw", data: LarkSender.buildCard(`⌛ 切换请求已过期\n📁 \`${dir}\``) },
      };
    }
    pendingWorkspaceSwitch = null;
    if (!approve) {
      log("INFO", `[Workspace] 主用户拒绝切换: ${dir}`);
      return {
        toast: { type: "info", content: "已取消" },
        card: { type: "raw", data: LarkSender.buildCard(`❌ 已拒绝切换全局工作目录\n📁 \`${dir}\``) },
      };
    }
    if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
      return {
        toast: { type: "error", content: "目录已不存在" },
        card: { type: "raw", data: LarkSender.buildCard(`❌ 目录已不存在，切换取消\n📁 \`${dir}\``) },
      };
    }
    applyWorkspaceHotSwitch(dir);
    log("INFO", `[Workspace] 主用户批准切换: ${dir}`);
    return {
      toast: { type: "success", content: "已切换" },
      card: { type: "raw", data: LarkSender.buildCard(`✅ 全局工作目录已切换\n📁 \`${dir}\``) },
    };
  }

  if (value?.kind === "dismiss") {
    return { card: { type: "raw", data: LarkSender.buildDismissedCard() } };
  }

  if (value?.kind === "cmd") {
    const cmd = String(value.cmd ?? "").trim();
    if (!cmd || !isCommand(cmd)) return { toast: { type: "error", content: "无效指令" } };
    log("INFO", `[${rt.cfg.name}] 卡片指令点击: ${cmd}`);
    // 主用户私聊点按钮 → p2p（供 isMainUser）；群内点按钮 → group（供独立群放行 /p）
    const chatType = resolveCardActionChatType(rt, chatKey, evt.chatId);
    handleCommand(cmd, evt.messageId, chatKey, chatType, true).catch((e: any) => log("ERROR", `卡片指令失败: ${e?.message ?? e}`));
    return { toast: { type: "info", content: `已执行 ${cmd}` } };
  }

  if (value?.kind === "project_new_open_add_repo") {
    const cbv = value as { worktreeRoot?: string };
    const f = evt.formValue || {};
    const draft = getProjectNewDraft(chatKey) || {
      chatKey,
      step: "form" as const,
      formMode: "main" as const,
      formRepoProfiles: [],
      formExtraRepos: [],
      updatedAt: Date.now(),
    };
    draft.step = "form";
    draft.formMode = "add_repo";
    draft.formCache = extractProjectFormCache(f);
    draft.updatedAt = Date.now();
    saveProjectNewDraft(draft);
    const wt = formFieldStr(f.worktreeRoot) || cbv.worktreeRoot || "";
    return {
      toast: { type: "info", content: "填写主仓信息" },
      card: { type: "raw", data: LarkSender.buildProjectNewAddRepoCard({ worktreeRoot: wt }) },
    };
  }

  if (value?.kind === "project_new_back_main") {
    const cbv = value as { worktreeRoot?: string };
    const draft = getProjectNewDraft(chatKey);
    if (draft) {
      draft.formMode = "main";
      draft.updatedAt = Date.now();
      saveProjectNewDraft(draft);
    }
    const profiles = combinedFormRepoProfiles(draft);
    const wt = draft?.formCache?.worktreeRoot || cbv.worktreeRoot || "";
    return {
      card: {
        type: "raw",
        data: LarkSender.buildProjectNewFormCard({
          repoProfiles: profiles,
          worktreeRoot: wt,
          nodeGroups: getNodeGroups().map((g) => ({ id: g.id, name: g.name })),
          defaults: draft?.formCache,
        }),
      },
    };
  }

  if (value?.kind === "project_new_add_repo_confirm") {
    const cbv = value as { worktreeRoot?: string };
    const f = evt.formValue || {};
    const repoPathRaw = formFieldStr(f.repoPathCustom);
    const baseBranch = formFieldStr(f.baseBranchCustom);
    const testBranch = formFieldStr(f.testBranchCustom) || undefined;
    const developBranch = formFieldStr(f.developBranchCustom) || undefined;
    if (!repoPathRaw) return { toast: { type: "error", content: "请填写主仓路径" } };
    if (!baseBranch) return { toast: { type: "error", content: "请填写生产基线分支" } };
    const rp = normalizeRepoRef(repoPathRaw);
    const draft = getProjectNewDraft(chatKey) || {
      chatKey,
      step: "form" as const,
      formMode: "main" as const,
      formRepoProfiles: [],
      formExtraRepos: [],
      updatedAt: Date.now(),
    };
    draft.step = "form";
    draft.formMode = "main";
    const extras = draft.formExtraRepos || [];
    if (!extras.some((e) => e.path.toLowerCase() === rp.toLowerCase())) {
      extras.push({ path: rp, baseBranch, testBranch, developBranch });
    }
    draft.formExtraRepos = extras;
    draft.updatedAt = Date.now();
    saveProjectNewDraft(draft);
    const profiles = combinedFormRepoProfiles(draft);
    const wt = draft.formCache?.worktreeRoot || cbv.worktreeRoot || "";
    return {
      toast: { type: "success", content: "主仓已添加" },
      card: {
        type: "raw",
        data: LarkSender.buildProjectNewFormCard({
          repoProfiles: profiles,
          worktreeRoot: wt,
          nodeGroups: getNodeGroups().map((g) => ({ id: g.id, name: g.name })),
          defaults: draft.formCache,
        }),
      },
    };
  }

  if (value?.kind === "project_new_form") {
    const f = evt.formValue || {};
    const cbv = value as { worktreeRoot?: string; groupId?: string; groupIds?: string[]; workspaceType?: string } | undefined;
    const name = formFieldStr(f.name);
    const goal = "";
    const worktreeRaw = formFieldStr(f.worktreeRoot) || formFieldStr(cbv?.worktreeRoot);
    const worktreeRoot = worktreeRaw ? path.normalize(worktreeRaw) : "";
    const featureBranch = formFieldStr(f.featureBranch);
    const storyUrl = formFieldStr(f.storyUrl);
    const relatedDocs = formFieldStr(f.relatedDocs);
    const chatModeRaw = formFieldStr(f.chatMode);
    const chatMode = chatModeRaw === "inline" ? "inline" : chatModeRaw === "bind" ? "bind" : "group";
    const existingGroupChatId = formFieldStr(f.existingGroupChatId);
    if (chatMode === "bind" && !existingGroupChatId) {
      return { toast: { type: "error", content: "绑定已有群时请填写群 chat_id（oc_…）" } };
    }
    const workspaceType = cbv?.workspaceType === "plain" ? "plain" : "worktree";

    const groupIdsList = coerceFormMultiSelect(f.group_ids);
    const groupIds = groupIdsList.length
      ? groupIdsList
      : (formFieldStr(f.group_id) || formFieldStr(cbv?.groupId)
        ? [formFieldStr(f.group_id) || formFieldStr(cbv?.groupId)]
        : [DEFAULT_NODE_GROUP_ID]);
    const groupId = groupIds[0] || DEFAULT_NODE_GROUP_ID;

    if (!name) return { toast: { type: "error", content: "请填写项目名称" } };

    // 纯会话型（存量/显式 workspaceType）：无 git 字段；storyUrl 与新表单一致可空
    if (workspaceType === "plain") {
      process.stdout.write(`__PROJECT_NEW_SUBMIT__:${JSON.stringify({
        chatId: chatKey,
        messageId: evt.messageId,
        name, goal, worktreeRoot, featureBranch: "",
        storyUrl, relatedDocs,
        groupId, groupIds,
        workspaceType,
        chatMode,
        existingGroupChatId,
        operatorOpenId: evt.operatorOpenId || "",
        repos: [],
        repoPath: "",
        baseBranch: "",
      })}\n`);
      clearProjectNewDraft(chatKey);
      return {
        toast: { type: "info", content: "正在创建项目…" },
        card: { type: "raw", data: LarkSender.buildCard(`📦 正在创建项目 **${name}**…`, "创建项目", undefined, undefined, "orange") },
      };
    }

    const decodePair = (raw: string) => {
      const r = decodeRepoPairOption(String(raw || ""));
      return { ...r, path: normalizeRepoRef(r.path || "") };
    };
    const selectedList = splitRepoPairValues(f.repoPairs);
    type RepoIn = { repoPath: string; baseBranch: string; testBranch?: string; developBranch?: string };
    const repos: RepoIn[] = [];
    const seen = new Set<string>();
    for (const item of selectedList) {
      const { path: rp, baseBranch, testBranch, developBranch } = decodePair(item);
      if (!rp) continue;
      const key = rp.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      repos.push({ repoPath: rp, baseBranch, testBranch, developBranch });
    }

    const primary = repos[0];
    process.stdout.write(`__PROJECT_NEW_SUBMIT__:${JSON.stringify({
      chatId: chatKey,
      messageId: evt.messageId,
      name, goal, worktreeRoot, featureBranch,
      storyUrl, relatedDocs,
      groupId, groupIds,
      workspaceType,
      chatMode,
      existingGroupChatId,
      operatorOpenId: evt.operatorOpenId || "",
      repos,
      repoPath: primary?.repoPath || "",
      baseBranch: primary?.baseBranch || "",
    })}\n`);
    clearProjectNewDraft(chatKey);
    return {
      toast: { type: "info", content: "正在创建项目…" },
      card: { type: "raw", data: LarkSender.buildCard(`📦 正在创建项目 **${name}**…`, "创建项目", undefined, undefined, "orange") },
    };
  }

  if (value?.kind === "repo_setup_form") {
    const f = evt.formValue || {};
    const repoPathRaw = formFieldStr(f.repoPath);
    const baseBranch = formFieldStr(f.baseBranch);
    const testBranch = formFieldStr(f.testBranch) || undefined;
    const developBranch = formFieldStr(f.developBranch) || undefined;
    if (!repoPathRaw) return { toast: { type: "error", content: "请填写主仓本地路径或远程地址" } };
    if (!baseBranch) return { toast: { type: "error", content: "请填写生产基线分支" } };
    const repoPath = normalizeRepoRef(repoPathRaw);
    // 卡片保持可改：路径无效只 toast，不落库不更新卡片（远程地址不做本地存在性校验）
    if (!isRemoteRepoRef(repoPath) && (!fs.existsSync(repoPath) || !fs.existsSync(path.join(repoPath, ".git")))) {
      return { toast: { type: "error", content: `不是有效 git 根目录: ${repoPath}` } };
    }
    process.stdout.write(`__PROJECT_PROFILE_UPSERT__:${JSON.stringify({
      path: repoPath, baseBranch, testBranch, developBranch,
      chatId: chatKey, messageId: evt.messageId,
    })}\n`);
    // 宿主保存后会把本卡 patch 回 setup 总览（单卡多视图）
    return {
      toast: { type: "success", content: "已提交" },
      card: { type: "raw", data: LarkSender.buildCard("⏳ 正在保存主仓…", "添加主仓", undefined, undefined, "orange") },
    };
  }

  if (value?.kind === "setup_worktree_form") {
    const f = evt.formValue || {};
    const raw = formFieldStr(f.worktreeRoot);
    if (!raw) return { toast: { type: "error", content: "请填写目录" } };
    if (!path.isAbsolute(raw)) return { toast: { type: "error", content: "请填写绝对路径" } };
    process.stdout.write(`__PROJECT_SETUP_FIELD__:${JSON.stringify({
      kind: "worktree", worktreeRoot: path.normalize(raw), chatId: chatKey, messageId: evt.messageId,
    })}\n`);
    return {
      toast: { type: "success", content: "已提交" },
      card: { type: "raw", data: LarkSender.buildCard("⏳ 正在保存工作区目录…", "设置工作区目录", undefined, undefined, "orange") },
    };
  }

  if (value?.kind === "setup_gitlab_form") {
    const f = evt.formValue || {};
    const token = formFieldStr(f.gitlabToken);
    const host = formFieldStr(f.gitlabHost);
    if (!token && !host) return { toast: { type: "info", content: "未填写任何变更" } };
    process.stdout.write(`__PROJECT_SETUP_FIELD__:${JSON.stringify({
      kind: "gitlab", gitlabToken: token || undefined, gitlabHost: host || undefined, chatId: chatKey, messageId: evt.messageId,
    })}\n`);
    return {
      toast: { type: "success", content: "已提交" },
      card: { type: "raw", data: LarkSender.buildCard("⏳ 正在保存 GitLab 配置…", "设置 GitLab", undefined, undefined, "orange") },
    };
  }

  return {};
}

async function replyToMessage(
  messageId: string,
  text: string,
  chatId?: string,
  buttons?: { label: string; cmd: string; section?: string }[],
  template?: string,
  opts?: {
    cardTitle?: { title: string; subtitle?: string };
    sections?: { text: string; buttons?: { label: string; cmd: string; section?: string }[] }[];
    /** 出站消息登记到此会话：用户引用该卡片回复可路由回原会话（如项目通知） */
    sessionKey?: string;
    /** 原卡更新：patch 该卡片替代新发消息（仅飞书；失败自动回退新发） */
    patchMessageId?: string;
    /** 指令菜单卡：追加 ✕ 关闭按钮（普通 Agent 回复不应开启） */
    offerDismiss?: boolean;
  },
): Promise<void> {
  // 优先显式 chatId；缺省时从消息路由表找回，禁止 allowDefault 兜底到别的通道（防微信指令回飞书）
  const routeKey = chatId
    || (messageId ? messageSessionMap.get(messageId) : undefined)
    || (messageId?.startsWith("internal_") ? internalMsgChatMap.get(messageId) : undefined);
  const ch = resolveChannel(routeKey, { allowDefault: false });
  if (ch.type === "error") {
    log("WARN", `回复失败: ${ch.message} (messageId=${messageId}, chatId=${chatId ?? "-"})`);
    return;
  }
  if (ch.type === "wechat") {
    // 微信无交互卡片：降级为「标签 + 可复制指令」（飞书仍走按钮卡，此处不动飞书）
    const fmtBtn = (b: { label: string; cmd: string }, n: number) => {
      const label = (b.label || b.cmd).trim();
      const cmd = (b.cmd || "").trim();
      if (!cmd) return `${n}. ${label}`;
      if (label === cmd) return `${n}. ${cmd}`;
      return `${n}. ${label}\n   发送：${cmd}`;
    };
    let body = text;
    const secs = opts?.sections;
    if (secs?.length) {
      const chunks: string[] = [];
      for (const sec of secs) {
        let part = sec.text;
        if (sec.buttons?.length) {
          const lines: string[] = ["（微信无按钮，复制下方「发送：」后的指令发出即可）"];
          let n = 1;
          for (const b of sec.buttons.slice(0, 20)) lines.push(fmtBtn(b, n++));
          part = `${part}\n${lines.join("\n")}`;
        }
        chunks.push(part);
      }
      body = chunks.join("\n\n");
    } else if (buttons && buttons.length > 0) {
      const lines: string[] = ["（微信无按钮，复制下方「发送：」后的指令发出即可）"];
      let n = 1;
      let lastSec: string | undefined;
      for (const b of buttons.slice(0, 20)) {
        if (b.section && b.section !== lastSec) {
          lines.push(`【${b.section}】`);
          lastSec = b.section;
        }
        lines.push(fmtBtn(b, n++));
      }
      body = `${text}\n\n${lines.join("\n")}`;
    }
    try { await ch.rt.wechat!.sendText(ch.chatId, body); } catch (e: any) { log("WARN", `微信回复失败: ${e?.message}`); }
    return;
  }
  const sender = ch.rt.sender!;
  // 显式登记的出站会话（如项目通知）最优先——用户活跃在别的会话时，项目卡不能被染成活跃会话样式；
  // 其次当前活跃会话（含工作区），避免 messageSession 只记了裸 chatKey 导致配色/标题抖动
  const mappedSk = messageId ? messageSessionMap.get(messageId) : undefined;
  const activeSk = lookupActiveSessionKey(chatId) || lookupActiveSessionKey(routeKey);
  const titleSessionKey = preferWorkspaceSessionKey(opts?.sessionKey, activeSk, mappedSk, routeKey);
  const colorSessionKey = preferWorkspaceSessionKey(opts?.sessionKey, activeSk, titleSessionKey, mappedSk);
  const title = opts?.cardTitle || resolveReplyTitle(ch, titleSessionKey);
  const headerTemplate = template || sessionHeaderTemplate(colorSessionKey) || sessionHeaderTemplate(titleSessionKey) || (title ? "turquoise" : undefined);
  // 群聊指令卡保留 reply（多人并发指令要对得上号）；p2p 直发去引用条
  const replyId = shouldReplyToMessage(ch, messageId) ? messageId : undefined;
  const mapBtns = (list?: { label: string; cmd: string; section?: string }[]): CardButton[] =>
    (list ?? []).map((b) => ({
      label: b.label, value: { kind: "cmd", cmd: b.cmd }, type: "default" as const, section: b.section,
    }));
  const cardSections = opts?.sections?.map((s) => ({ text: s.text, buttons: mapBtns(s.buttons) }));
  // 原卡更新：patch 点击来源卡片，成功即结束；失败回退新发
  const offerDismiss = opts?.offerDismiss ?? false;
  if (opts?.patchMessageId && !opts.patchMessageId.startsWith("internal_")) {
    const patched = await sender.patchCard(opts.patchMessageId, text, title, headerTemplate, undefined, mapBtns(buttons), cardSections, offerDismiss);
    if (patched) return;
    log("WARN", `原卡更新失败，回退新发消息 (${opts.patchMessageId})`);
  }
  if ((buttons && buttons.length > 0) || (cardSections && cardSections.length > 0)) {
    const btns = mapBtns(buttons);
    let sent = await sender.sendCardWithButtons(text, btns, replyId, ch.chatId, title, undefined, headerTemplate, undefined, cardSections, offerDismiss);
    if (sent === undefined && replyId && ch.chatId) {
      sent = await sender.sendCardWithButtons(text, btns, undefined, ch.chatId, title, undefined, headerTemplate, undefined, cardSections, offerDismiss);
    }
    if (typeof sent === "string" && opts?.sessionKey) trackMessageSession(sent, opts.sessionKey);
    return;
  }
  let sentTextId: string | undefined | null;
  if (replyId) {
    sentTextId = await sender.replyMessage(replyId, text, title, headerTemplate, offerDismiss);
    if (!sentTextId && ch.chatId) sentTextId = await sender.sendMessage(text, undefined, ch.chatId, title, headerTemplate, offerDismiss);
  } else if (ch.chatId) {
    sentTextId = await sender.sendMessage(text, undefined, ch.chatId, title, headerTemplate, offerDismiss);
  } else if (messageId && !messageId.startsWith("internal_")) {
    sentTextId = await sender.replyMessage(messageId, text, title, headerTemplate, offerDismiss);
  }
  if (typeof sentTextId === "string" && opts?.sessionKey) trackMessageSession(sentTextId, opts.sessionKey);
}

// ── 共享指令文件队列（.fcmd）──────────────────────────────

function pushCommandToQueue(command: string, messageId: string, source: string, chatId?: string, chatType?: string, fromCard?: boolean): boolean {
  const queueDir = getQueueDir();
  if (!queueDir) return false;
  const ts = Date.now();
  const safeId = messageId.replace(/[^a-zA-Z0-9_-]/g, "_");

  try {
    const existing = fs.readdirSync(queueDir);
    if (existing.some((f) => f.includes(`_${safeId}.fcmd`))) return false;
  } catch { /* ignore */ }

  try {
    const data = JSON.stringify({ command, messageId, timestamp: ts, source, chatId, chatType, fromCard });
    const filename = `${ts}_${safeId}.fcmd`;
    const tmpPath = path.join(queueDir, filename + ".tmp");
    const finalPath = path.join(queueDir, filename);
    fs.writeFileSync(tmpPath, data, "utf-8");
    fs.renameSync(tmpPath, finalPath);
    if (messageId && chatId) trackMessageSession(messageId, lookupActiveSessionKey(chatId) || chatId);
    log("INFO", `指令已入队: ${command} (msgId=${messageId}, source=${source})`);
    broadcastCommandEvent();
    return true;
  } catch { return false; }
}

interface CmdEntry { id: string; command: string; messageId: string; chatId?: string; chatType?: string; fromCard?: boolean }

function getPendingCommands(): CmdEntry[] {
  const queueDir = getQueueDir();
  if (!queueDir) return [];
  try {
    const files = fs.readdirSync(queueDir).filter((f) => f.endsWith(".fcmd")).sort();
    return files.map((f) => {
      try {
        const raw = fs.readFileSync(path.join(queueDir, f), "utf-8");
        const p = JSON.parse(raw);
        return { id: f, command: p.command, messageId: p.messageId, chatId: p.chatId, chatType: p.chatType, fromCard: p.fromCard };
      } catch { return null; }
    }).filter(Boolean) as CmdEntry[];
  } catch { return []; }
}

function claimCommand(fileId: string): Omit<CmdEntry, "id"> | null {
  const queueDir = getQueueDir();
  if (!queueDir) return null;
  const srcPath = path.join(queueDir, fileId);
  const claimedPath = srcPath + ".claimed";
  try {
    fs.renameSync(srcPath, claimedPath);
    const raw = fs.readFileSync(claimedPath, "utf-8");
    fs.unlinkSync(claimedPath);
    const p = JSON.parse(raw);
    return { command: p.command, messageId: p.messageId, chatId: p.chatId, chatType: p.chatType, fromCard: p.fromCard };
  } catch { return null; }
}

function cleanExpiredCommands(): void {
  const queueDir = getQueueDir();
  if (!queueDir) return;
  const now = Date.now();
  try {
    const files = fs.readdirSync(queueDir).filter((f) => f.endsWith(".fcmd"));
    for (const f of files) {
      try {
        const raw = fs.readFileSync(path.join(queueDir, f), "utf-8");
        const parsed = JSON.parse(raw);
        if (now - (parsed.timestamp ?? 0) > 60_000) {
          fs.unlinkSync(path.join(queueDir, f));
          log("WARN", `指令超时已清除: ${parsed.command} (msgId=${parsed.messageId})`);
          if (parsed.messageId) {
            replyToMessage(parsed.messageId, `⚠️ 指令 ${parsed.command} 执行超时`, parsed.chatId).catch(() => {});
          }
        }
      } catch { /* ignore */ }
    }
  } catch { /* ignore */ }
}

async function handleCommand(text: string, messageId: string, chatId?: string, chatType?: string, fromCard?: boolean): Promise<void> {
  const trimmed = text.trim();
  if (chatId && ["/stop", "/restart"].includes(trimmed.toLowerCase())) {
    terminateSessionsByChat(chatId);
  }
  pushCommandToQueue(trimmed, messageId, `daemon-${process.pid}`, chatId, chatType, fromCard);
}

// ── HTTP Server ──────────────────────────────────────────

let daemonPort = 0;

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: string[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk.toString()));
    req.on("end", () => resolve(chunks.join("")));
    req.on("error", reject);
  });
}

function json(res: http.ServerResponse, data: unknown, status = 200): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data));
}

// ── MCP over StreamableHTTP ─────────────────────────────


function httpJson<T = any>(url: string, body?: unknown, timeoutMs = 30_000): Promise<T> {
  return new Promise((resolve, reject) => {
    const isPost = body !== undefined;
    const payload = isPost ? JSON.stringify(body) : undefined;
    const parsed = new URL(url);
    const req = http.request({
      hostname: parsed.hostname,
      port: parsed.port,
      path: parsed.pathname + parsed.search,
      method: isPost ? "POST" : "GET",
      headers: isPost ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload!) } : undefined,
      timeout: timeoutMs,
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => {
        try { resolve(JSON.parse(Buffer.concat(chunks).toString())); }
        catch { reject(new Error(`daemon JSON parse: ${Buffer.concat(chunks).toString().slice(0, 200)}`)); }
      });
    });
    req.on("error", (e) => reject(new Error(`daemon request failed: ${e.message}`)));
    req.on("timeout", () => { req.destroy(); reject(new Error("daemon request timeout")); });
    if (payload) req.write(payload);
    req.end();
  });
}

function localDaemonUrl(p: string): string {
  return `http://127.0.0.1:${daemonPort}${p}`;
}

function createMcpServer(): McpServer {
  const s = new McpServer({ name: "lk-harness", version: PKG_VERSION, description: "消息桥接 – 通过飞书/微信与用户沟通" });

  s.tool(
    "send_text",
    "发送文本消息到飞书/微信。飞书群聊中 @ 其他成员或机器人：在 text 中使用 `<at user_id=\"ou_xxx\">名字</at>`（open_id 从收到消息的 @名字(open_id=ou_xxx) 内联标注获取）。",
    {
      text: z.string().describe("要发送的消息内容"),
      message_id: z.string().optional().describe("要回复的消息ID，传入后以回复模式发送"),
      session_key: z.string().optional().describe("目标会话的 sessionKey，用于精确投递"),
    },
    async ({ text, message_id, session_key }) => {
      try {
        const r = await httpJson<{ ok: boolean; error?: string }>(localDaemonUrl("/api/send-text"), { text, message_id, session_key });
        if (!r?.ok) {
          const detail = r?.error?.trim() || "消息发送失败";
          log("WARN", `send_text 发送失败: message_id=${message_id} error=${detail.slice(0, 160)}`);
          return { content: [{ type: "text" as const, text: `[send_failed] ${detail}` }] };
        }
        return { content: [{ type: "text" as const, text: "消息已发送" }] };
      } catch (e: any) {
        log("ERROR", `send_text 异常: ${e?.message ?? e}`);
        return { content: [{ type: "text" as const, text: `[error] ${e?.message ?? "unknown error"}` }] };
      }
    },
  );

  s.tool(
    "send_image",
    "发送本地图片到飞书/微信。image_path 为本地文件绝对路径。",
    {
      image_path: z.string().describe("图片绝对路径"),
      message_id: z.string().optional().describe("要回复的消息ID，传入后以回复模式发送"),
      session_key: z.string().optional().describe("目标会话的 sessionKey，用于精确投递"),
    },
    async ({ image_path, message_id, session_key }) => {
      try {
        const r = await httpJson<{ ok: boolean; error?: string }>(localDaemonUrl("/api/send-image"), { image_path, message_id, session_key });
        if (!r?.ok) return { content: [{ type: "text" as const, text: `[send_failed] ${r?.error?.trim() || "图片发送失败"}` }] };
        return { content: [{ type: "text" as const, text: "图片已发送" }] };
      } catch (e: any) {
        log("ERROR", `send_image 异常: ${e?.message ?? e}`);
        return { content: [{ type: "text" as const, text: `[error] ${e?.message ?? "unknown error"}` }] };
      }
    },
  );

  s.tool(
    "send_file",
    "发送本地文件到飞书/微信。file_path 为本地文件绝对路径。",
    {
      file_path: z.string().describe("文件绝对路径"),
      message_id: z.string().optional().describe("要回复的消息ID，传入后以回复模式发送"),
      session_key: z.string().optional().describe("目标会话的 sessionKey，用于精确投递"),
    },
    async ({ file_path, message_id, session_key }) => {
      try {
        const r = await httpJson<{ ok: boolean; error?: string }>(localDaemonUrl("/api/send-file"), { file_path, message_id, session_key });
        if (!r?.ok) return { content: [{ type: "text" as const, text: `[send_failed] ${r?.error?.trim() || "文件发送失败"}` }] };
        return { content: [{ type: "text" as const, text: "文件已发送" }] };
      } catch (e: any) {
        log("ERROR", `send_file 异常: ${e?.message ?? e}`);
        return { content: [{ type: "text" as const, text: `[error] ${e?.message ?? "unknown error"}` }] };
      }
    },
  );

  s.tool(
    "send_question",
    "向用户提问并给出选项按钮。飞书发交互卡片；微信降级为文本选项列表。",
    {
      text: z.string().describe("问题内容（支持 markdown）"),
      options: z.array(z.string()).min(1).max(10).describe("选项文本列表（1-10 个）"),
      message_id: z.string().optional().describe("要回复的消息ID，传入后以回复模式发送"),
      session_key: z.string().describe("目标会话 sessionKey，不可省略"),
    },
    async ({ text, options, message_id, session_key }) => {
      try {
        const r = await httpJson<{ ok: boolean; degraded?: boolean }>(localDaemonUrl("/api/send-question"), { text, options, message_id, session_key });
        if (!r?.ok) return { content: [{ type: "text" as const, text: `[send_failed] ${(r as any)?.error?.trim() || "问题发送失败"}` }] };
        return { content: [{ type: "text" as const, text: r.degraded ? "问题已发送（微信文本降级）" : "问题已发送" }] };
      } catch (e: any) {
        log("ERROR", `send_question 异常: ${e?.message ?? e}`);
        return { content: [{ type: "text" as const, text: `[error] ${e?.message ?? "unknown error"}` }] };
      }
    },
  );
  registerProjectAgentTools(s);
  return s;
}

function createAdminMcpServer(): McpServer {
  const s = new McpServer({ name: "lk-harness-admin", version: PKG_VERSION, description: "lk-harness 管理工具" });
  registerAdminTools(s);
  return s;
}

function startHttpServer(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = http.createServer(async (req, res) => {
      const reqUrl = new URL(req.url ?? "", `http://${req.headers.host ?? "localhost"}`);
      const pathname = reqUrl.pathname;
      const method = req.method;

      try {
        if (pathname === "/mcp" || pathname === "/mcp-admin") {
          const isAgent = pathname === "/mcp";
          const srv = isAgent ? createMcpServer() : createAdminMcpServer();
          const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
          if (isAgent) { activeMcpConnections++; lastMcpRequestTime = Date.now(); }
          res.on("close", () => {
            transport.close(); srv.close();
            if (isAgent) activeMcpConnections = Math.max(0, activeMcpConnections - 1);
          });
          await srv.connect(transport);
          await transport.handleRequest(req, res);
          return;
        }

        if (await handleAdminApi(pathname, method!, req, res)) return;

        if (method === "GET" && (pathname === "/health" || pathname === "/status")) {
          cleanExpiredCommands();
          const channelList = getChannelStatusList();
          const feishuList = channelList.filter((c) => c.type === "feishu");
          const wechatList = channelList.filter((c) => c.type === "wechat");
          json(res, {
            status: "ok",
            version: PKG_VERSION,
            uptime: Math.floor(process.uptime()),
            queueLength: getFileQueueLength(),
            queueCounts: getQueueCounts(),
            channels: channelList,
            // 兼容字段（聚合视图）
            hasChatId: channelList.some((c) => c.connected),
            feishuEnabled: feishuList.length > 0,
            feishuConnected: feishuList.some((c) => c.connected),
            wechatEnabled: wechatList.length > 0,
            wechatStatus: wechatList.some((c) => c.status === "connected") ? "connected" : (wechatList[0]?.status ?? "disconnected"),
            wechatReady: wechatList.some((c) => c.connected),
          });
          return;
        }

        if (method === "GET" && pathname === "/queue") {
          json(res, { length: getFileQueueLength(), messages: getFileQueueMessages() });
          return;
        }

        if (method === "POST" && pathname === "/queue-delete") {
          const body = JSON.parse(await readBody(req));
          const { fileId } = body as { fileId?: string };
          if (!fileId) { json(res, { ok: false, error: "fileId required" }, 400); return; }
          const ok = deleteFileQueueMessage(fileId);
          json(res, { ok, queueLength: getFileQueueLength() });
          return;
        }

        if (method === "POST" && pathname === "/shutdown") {
          log("INFO", ">>> 收到 shutdown 请求，准备退出");
          json(res, { ok: true });
          setTimeout(() => {
            stopDaemonScheduledTasks();
            removeLockFile();
            process.exit(0);
          }, 200);
          return;
        }

        if (method === "POST" && pathname === "/channel-test") {
          const body = JSON.parse(await readBody(req));
          const channelId = typeof body.channelId === "string" ? body.channelId : "";
          const rt = channels.get(channelId);
          if (!rt) { json(res, { ok: false, error: "通道不存在或未启用" }, 400); return; }
          if (!isChannelConnected(rt)) { json(res, { ok: false, error: "通道未连接" }, 400); return; }
          const chatId = channelDefaultChatId(rt);
          if (!chatId) { json(res, { ok: false, error: "暂无私聊记录，请先绑定主用户或给机器人发一条消息" }, 400); return; }
          try {
            if (rt.cfg.type === "wechat") {
              json(res, { ok: await rt.wechat!.sendText(chatId, "🔗 微信测试成功！连接正常。") });
            } else {
              const msgId = await rt.sender!.sendMessage("🔗 绑定测试成功！连接正常。", undefined, chatId);
              json(res, { ok: !!msgId });
            }
          } catch (e: any) {
            json(res, { ok: false, error: e?.message ?? "发送失败" }, 500);
          }
          return;
        }

        if (method === "POST" && pathname === "/channel-bind") {
          const body = JSON.parse(await readBody(req));
          const channelId = typeof body.channelId === "string" ? body.channelId : "";
          const arm = body.arm !== false;
          const rt = channels.get(channelId);
          if (!rt) { json(res, { ok: false, error: "通道不存在或未启用" }, 400); return; }
          rt.bindArmed = arm;
          log("INFO", `[Bind] 通道「${rt.cfg.name}」绑定模式: ${arm ? "开启（等待私聊消息）" : "取消"}`);
          json(res, { ok: true });
          return;
        }

        // 通道运行时开关热更新（保活模式/名称/主用户绑定），不重启 daemon、不打断会话
        if (method === "POST" && pathname === "/api/channel-flags") {
          const body = JSON.parse(await readBody(req)) as { channels?: ChannelRuntimeFlags[] };
          const flags = Array.isArray(body.channels) ? body.channels : [];
          updateChannelFlags(flags);
          log("INFO", `通道开关已热更新: ${flags.map((f) => `${f.id}:keepAlive=${f.keepAlive}`).join(", ") || "(空)"}`);
          json(res, { ok: true });
          return;
        }

        if (method === "POST" && pathname === "/api/channel-lifecycle") {
          const body = JSON.parse(await readBody(req)) as { action?: string; id?: string; channel?: DaemonChannelConfig };
          if (body.action === "stop") {
            const id = typeof body.id === "string" ? body.id.trim() : "";
            if (!id) { json(res, { ok: false, error: "id required" }, 400); return; }
            json(res, { ok: await stopChannelRuntime(id) });
            return;
          }
          if (body.action === "start") {
            const cfg = body.channel;
            if (!cfg?.id || !cfg.type) { json(res, { ok: false, error: "channel required" }, 400); return; }
            try {
              await startChannelRuntime(cfg);
              json(res, { ok: true });
            } catch (e: unknown) {
              json(res, { ok: false, error: e instanceof Error ? e.message : String(e) }, 500);
            }
            return;
          }
          json(res, { ok: false, error: "unknown action" }, 400);
          return;
        }

        if (method === "POST" && pathname === "/enqueue") {
          const body = JSON.parse(await readBody(req));
          const content = typeof body.content === "string" ? body.content : "";
          if (!content) { json(res, { error: "content is required" }, 400); return; }
          const chatId = typeof body.chatId === "string" ? body.chatId.trim() : "";
          const chatType = typeof body.chatType === "string" ? body.chatType : "p2p";
          const sessionKey = typeof body.sessionKey === "string" ? body.sessionKey.trim() : "";
          const channelId = typeof body.channelId === "string" ? body.channelId.trim() : "";
          const model = typeof body.model === "string" ? body.model.trim() : "";
          const modelParams = typeof body.modelParams === "string" ? body.modelParams : "";
          const internalMsgId = `internal_enqueue_${Date.now()}`;
          if (sessionKey) {
            // 直投指定会话（独立定时任务 / 项目节点等）：绕过 p2p 主目录强制路由，队列保障崩溃重投
            const normalized = normalizeSessionKey(sessionKey) || sessionKey;
            const rt = pickChannel(channelId || undefined);
            const target = rt ? channelDefaultChatId(rt) : null;
            if (rt && target) sessionToChatMap.set(normalized, makeChatKey(rt.cfg.id, target));
            if (model) {
              try { setSessionOverride(normalized, { model, modelParams }); }
              catch (e: unknown) { log("WARN", `enqueue 模型 override 失败: ${e instanceof Error ? e.message : String(e)}`); }
            }
            pushToFileQueue(content, internalMsgId, `daemon-${process.pid}`, normalized, false, { chatType });
            trackMessageSession(internalMsgId, normalized);
            rememberSessionKey(normalized);
            broadcastQueueEvent(chatIdFromSessionKey(normalized) || (rt && target ? makeChatKey(rt.cfg.id, target) : undefined));
            log("INFO", `任务已直投会话队列: session=${normalized} len=${content.length}`);
          } else if (chatId) {
            pushMessage(content, internalMsgId, chatId, chatType);
          } else {
            pushMessage(content, internalMsgId);
          }
          json(res, { ok: true, queueLength: getFileQueueLength() });
          return;
        }

        if (method === "POST" && pathname === "/clear-queue") {
          json(res, { ok: true, cleared: clearFileQueue() });
          return;
        }

        if (method === "POST" && pathname === "/dequeue-all") {
          const body = await readBody(req).catch(() => "{}");
          const parsed = JSON.parse(body || "{}") as { sessionKey?: string; chatId?: string };
          const filterSession = parsed.sessionKey || parsed.chatId;
          if (!filterSession) {
            json(res, { ok: false, error: "sessionKey is required" }, 400);
            return;
          }
          const messages: QueueMessage[] = [];
          let m: ReturnType<typeof claimNextMessage>;
          while ((m = claimNextMessage(filterSession)) !== null) {
            if (m.messageId) trackMessageSession(m.messageId, filterSession);
            messages.push(m);
          }
          if (messages.length > 0) log("INFO", `dequeue-all 已领取 ${messages.length} 条: session=${filterSession}`);
          json(res, { ok: true, messages, queueLength: getFileQueueLength() });
          return;
        }

        if (method === "GET" && pathname === "/queue-chat-ids") {
          json(res, { chats: getDistinctSessions() });
          return;
        }

        if (method === "GET" && pathname === "/commands") {
          json(res, { commands: getPendingCommands() });
          return;
        }

        if (method === "POST" && pathname === "/commands/claim") {
          const body = JSON.parse(await readBody(req));
          const result = claimCommand(body.id);
          json(res, result ? { ok: true, ...result } : { ok: false, error: "not found" });
          return;
        }

        if (method === "POST" && pathname === "/create-project-group") {
          const body = JSON.parse(await readBody(req)) as {
            name?: string; description?: string; channelId?: string; ownerOpenId?: string;
          };
          const name = (body.name || "").trim();
          if (!name) { json(res, { ok: false, error: "name is required" }, 400); return; }
          const rt = pickChannel(body.channelId);
          if (!rt || rt.cfg.type !== "feishu" || !rt.client) {
            log("WARN", "[Project] 独立群创建失败: 无可用飞书通道");
            json(res, { ok: false, error: "无可用飞书通道" });
            return;
          }
          const owner = (body.ownerOpenId || "").trim();
          try {
            const r: any = await rt.client.im.chat.create({
              params: { user_id_type: "open_id", set_bot_manager: true } as any,
              data: {
                name: name.slice(0, 60),
                description: (body.description || "").slice(0, 100),
                chat_mode: "group",
                chat_type: "private",
                ...(owner ? { owner_id: owner, user_id_list: [owner] } : {}),
              } as any,
            });
            const chatId: string | undefined = r?.data?.chat_id;
            if (!chatId) {
              const err = `建群失败: ${r?.msg || "响应无 chat_id"}`;
              log("WARN", `[Project] 独立群创建失败: ${err}`);
              json(res, { ok: false, error: err });
              return;
            }
            const chatKey = makeChatKey(rt.cfg.id, chatId);
            rememberChatType(chatKey, "group");
            log("INFO", `[Project] 项目群已创建: ${name} → ${chatKey}`);
            json(res, { ok: true, chatId, chatKey });
          } catch (e: any) {
            const err = e?.response?.data?.msg || e?.message || String(e);
            log("WARN", `[Project] 独立群创建失败: ${err}`);
            json(res, { ok: false, error: err });
          }
          return;
        }

        if (method === "POST" && pathname === "/archive-project-group") {
          const body = JSON.parse(await readBody(req)) as { chatKey?: string; name?: string };
          const chatKey = (body.chatKey || "").trim();
          const newName = (body.name || "").trim();
          if (!chatKey || !newName) { json(res, { ok: false, error: "chatKey/name is required" }, 400); return; }
          const { channelId, chatId } = parseChatKey(chatKey);
          const rt = channelId ? channels.get(channelId) : pickChannel();
          if (!rt || rt.cfg.type !== "feishu" || !rt.client) { json(res, { ok: false, error: "无可用飞书通道" }); return; }
          try {
            await rt.client.im.chat.update({ path: { chat_id: chatId }, data: { name: newName.slice(0, 60) } as any });
            log("INFO", `[Project] 项目群已归档改名: ${chatKey} → ${newName}`);
            json(res, { ok: true });
          } catch (e: any) {
            json(res, { ok: false, error: e?.response?.data?.msg || e?.message || String(e) });
          }
          return;
        }

        if (method === "POST" && pathname === "/cmd/result") {
          const body = JSON.parse(await readBody(req)) as {
            messageId: string; ok: boolean; message: string; chatId?: string;
            buttons?: { label: string; cmd: string; section?: string }[];
            cardTitle?: { title: string; subtitle?: string };
            sections?: { text: string; buttons?: { label: string; cmd: string; section?: string }[] }[];
            sessionKey?: string;
            patchMessageId?: string;
          };
          log("INFO", `指令执行完成: ok=${body.ok}, msgId=${body.messageId}, chatId=${body.chatId ?? "N/A"}`);
          // 空 messageId 但有 chatId 时仍需投递（如项目节点完成通知）：replyToMessage 会走 chat 直发
          if (body.messageId || body.chatId) {
            await replyToMessage(body.messageId || "", body.message, body.chatId, body.buttons, undefined, {
              cardTitle: body.cardTitle,
              sections: body.sections,
              sessionKey: body.sessionKey,
              patchMessageId: body.patchMessageId,
              offerDismiss: true,
            });
          }
          json(res, { ok: true });
          return;
        }

        json(res, { error: "not found" }, 404);
      } catch (e: any) {
        log("ERROR", `HTTP 错误: ${pathname} ${e?.message ?? e}`);
        json(res, { error: e?.message ?? "internal error" }, 500);
      }
    });

    server.requestTimeout = 300_000;

    const tryListen = (port: number) => {
      server.once("error", (err: NodeJS.ErrnoException) => {
        if (port > 0 && err.code === "EADDRINUSE") {
          log("WARN", `端口 ${port} 被占用，回退到随机端口`);
          server.removeAllListeners("error");
          tryListen(0);
          return;
        }
        log("ERROR", `HTTP Server 错误: ${err.message}`);
        reject(err);
      });
      server.listen(port, "127.0.0.1", () => {
        const addr = server.address() as { port: number };
        log("INFO", `HTTP Server 监听: http://127.0.0.1:${addr.port}`);
        resolve(addr.port);
      });
    };
    tryListen(CONFIGURED_PORT);
  });
}

// ── 管理 API 辅助函数 ────────────────────────────────────

const HOME_DIR = os.homedir();
const SKILLS_DIR = path.join(HOME_DIR, ".cursor", "skills");
const TASKS_FILE = path.join(APP_DATA_DIR, "scheduled-tasks.json");

function getProjectMcpPath(): string {
  return path.join(WORKSPACE_DIR, ".cursor", "mcp.json");
}

function readJsonSafe(filePath: string): any {
  try {
    if (fs.existsSync(filePath)) return JSON.parse(fs.readFileSync(filePath, "utf-8"));
  } catch { /* ignore */ }
  return null;
}

function writeJsonSafe(filePath: string, data: unknown): void {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), "utf-8");
}

function readTasks(): ScheduledTask[] {
  return readScheduledTasksFile(TASKS_FILE);
}

function writeTasks(tasks: ScheduledTask[]): void {
  writeScheduledTasksFile(TASKS_FILE, tasks);
}

// ── CRUD 子路由 ──────────────────────────────────────────

async function handleMcpAdmin(method: string, req: http.IncomingMessage, res: http.ServerResponse): Promise<boolean> {
  if (method === "GET") {
    const servers: Record<string, { config: unknown; scope: string }> = {};
    for (const s of listClawMcpServers()) {
      servers[s.name] = { config: s.config, scope: "claw" };
    }
    json(res, { ok: true, servers });
    return true;
  }
  if (method === "POST") {
    const body = JSON.parse(await readBody(req));
    const { action, name, config } = body as { action: string; name?: string; config?: string; scope?: string };

    if (action === "add") {
      if (!name || !config) { json(res, { ok: false, error: "name and config required" }, 400); return true; }
      if ([CLAW_MCP_KEY, ADMIN_MCP_KEY].includes(name)) {
        json(res, { ok: false, error: "reserved name" }, 400); return true;
      }
      let parsed: unknown;
      try { parsed = JSON.parse(config); } catch { json(res, { ok: false, error: "invalid config JSON" }, 400); return true; }
      saveClawMcpServer(name, parsed as Record<string, unknown>);
      json(res, { ok: true, message: `${name} saved` });
      return true;
    }
    if (action === "delete") {
      if (!name) { json(res, { ok: false, error: "name required" }, 400); return true; }
      if (deleteClawMcpServer(name)) {
        json(res, { ok: true, message: `${name} deleted` });
        return true;
      }
      json(res, { ok: false, error: "not found" }, 404);
      return true;
    }
    json(res, { ok: false, error: "unknown action" }, 400);
    return true;
  }
  return false;
}

async function handleRulesAdmin(method: string, req: http.IncomingMessage, res: http.ServerResponse): Promise<boolean> {
  if (method === "GET") {
    json(res, { ok: true, rules: listClawRules().map((r) => r.name) });
    return true;
  }
  if (method === "POST") {
    const body = JSON.parse(await readBody(req));
    const { action, name, content } = body as { action: string; name?: string; content?: string };

    if (action === "read") {
      if (!name) { json(res, { ok: false, error: "name required" }, 400); return true; }
      const id = name.replace(/\.mdc$|\.md$/i, "");
      const rule = listClawRules().find((r) => r.id === id || r.name === name);
      if (!rule) { json(res, { ok: false, error: "not found" }, 404); return true; }
      json(res, { ok: true, content: rule.content });
      return true;
    }
    if (action === "save") {
      if (!name || content === undefined) { json(res, { ok: false, error: "name and content required" }, 400); return true; }
      const id = name.replace(/\.mdc$|\.md$/i, "");
      const saved = saveClawRule(id, id, content, true);
      if (!saved) { json(res, { ok: false, error: "save failed" }, 400); return true; }
      json(res, { ok: true, message: `${saved.name} saved` });
      return true;
    }
    if (action === "delete") {
      if (!name) { json(res, { ok: false, error: "name required" }, 400); return true; }
      const id = name.replace(/\.mdc$|\.md$/i, "");
      if (!deleteClawRule(id)) { json(res, { ok: false, error: "not found" }, 404); return true; }
      json(res, { ok: true, message: `${name} deleted` });
      return true;
    }
    json(res, { ok: false, error: "unknown action" }, 400);
    return true;
  }
  return false;
}

async function handleSkillsAdmin(method: string, req: http.IncomingMessage, res: http.ServerResponse): Promise<boolean> {
  if (method === "GET") {
    if (!fs.existsSync(SKILLS_DIR)) { json(res, { ok: true, skills: [] }); return true; }
    const dirs = fs.readdirSync(SKILLS_DIR, { withFileTypes: true }).filter((d) => d.isDirectory());
    const skills = dirs.map((d) => {
      const skillFile = path.join(SKILLS_DIR, d.name, "SKILL.md");
      const preview = fs.existsSync(skillFile) ? fs.readFileSync(skillFile, "utf-8").split("\n")[0].slice(0, 80) : "";
      return { name: d.name, preview };
    });
    json(res, { ok: true, skills });
    return true;
  }
  if (method === "POST") {
    const body = JSON.parse(await readBody(req));
    const { action, name, content } = body as { action: string; name?: string; content?: string };

    if (action === "read") {
      if (!name) { json(res, { ok: false, error: "name required" }, 400); return true; }
      const fp = path.join(SKILLS_DIR, name, "SKILL.md");
      if (!fs.existsSync(fp)) { json(res, { ok: false, error: "not found" }, 404); return true; }
      json(res, { ok: true, content: fs.readFileSync(fp, "utf-8") });
      return true;
    }
    if (action === "save") {
      if (!name || content === undefined) { json(res, { ok: false, error: "name and content required" }, 400); return true; }
      const dir = path.join(SKILLS_DIR, name.trim());
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, "SKILL.md"), content, "utf-8");
      json(res, { ok: true, message: `${name} saved` });
      return true;
    }
    if (action === "delete") {
      if (!name) { json(res, { ok: false, error: "name required" }, 400); return true; }
      const dir = path.join(SKILLS_DIR, name);
      if (!fs.existsSync(dir)) { json(res, { ok: false, error: "not found" }, 404); return true; }
      fs.rmSync(dir, { recursive: true, force: true });
      json(res, { ok: true, message: `${name} deleted` });
      return true;
    }
    json(res, { ok: false, error: "unknown action" }, 400);
    return true;
  }
  return false;
}

async function handleTasksAdmin(method: string, req: http.IncomingMessage, res: http.ServerResponse): Promise<boolean> {
  if (method === "GET") {
    json(res, { ok: true, tasks: readTasks() });
    return true;
  }
  if (method === "POST") {
    const body = JSON.parse(await readBody(req));
    const { action, id, name, cron, content, enabled, independent, channelId, model, modelParams } = body as {
      action: string; id?: string; name?: string; cron?: string; content?: string; enabled?: boolean; independent?: boolean
      channelId?: string; model?: string; modelParams?: string
    };
    const tasks = readTasks();

    if (action === "add") {
      if (!name || !cron || !content) { json(res, { ok: false, error: "name, cron, content required" }, 400); return true; }
      const newTask: ScheduledTask = {
        id: crypto.randomUUID(), name: name.trim(), cron: cron.trim(), content,
        enabled: enabled ?? true, independent: independent ?? true,
        channelId: channelId || channels.keys().next().value, model, modelParams,
      };
      tasks.push(newTask);
      writeTasks(tasks);
      json(res, { ok: true, task: newTask });
      return true;
    }
    if (!id) { json(res, { ok: false, error: "id required" }, 400); return true; }
    const idx = tasks.findIndex((t) => t.id === id);
    if (idx === -1) { json(res, { ok: false, error: "task not found" }, 404); return true; }

    if (action === "update") {
      if (name !== undefined) tasks[idx].name = name.trim();
      if (cron !== undefined) tasks[idx].cron = cron.trim();
      if (content !== undefined) tasks[idx].content = content;
      if (enabled !== undefined) tasks[idx].enabled = enabled;
      if (independent !== undefined) tasks[idx].independent = independent;
      if (channelId !== undefined) tasks[idx].channelId = channelId;
      if (model !== undefined) tasks[idx].model = model;
      if (modelParams !== undefined) tasks[idx].modelParams = modelParams;
      writeTasks(tasks);
      json(res, { ok: true, task: tasks[idx] });
      return true;
    }
    if (action === "delete") {
      const removed = tasks.splice(idx, 1)[0];
      writeTasks(tasks);
      json(res, { ok: true, removed });
      return true;
    }
    if (action === "toggle") {
      tasks[idx].enabled = !tasks[idx].enabled;
      writeTasks(tasks);
      json(res, { ok: true, task: tasks[idx] });
      return true;
    }
    json(res, { ok: false, error: "unknown action" }, 400);
    return true;
  }
  return false;
}

// ── 管理 API 路由分发 ────────────────────────────────────

type RouteHandler = (method: string, req: http.IncomingMessage, res: http.ServerResponse) => Promise<boolean>;

const ADMIN_CRUD_ROUTES: Record<string, RouteHandler> = {
  "/api/mcp": handleMcpAdmin,
  "/api/rules": handleRulesAdmin,
  "/api/skills": handleSkillsAdmin,
  "/api/tasks": handleTasksAdmin,
};

/** chatKey 是否某启用通道的主用户私聊 */
function isMainUserChatKey(chatKey: string): boolean {
  const { channelId, chatId } = parseChatKey(chatKey);
  const rt = channelId ? channels.get(channelId) : undefined;
  return !!rt && rt.cfg.mainUserEnabled === true && (rt.cfg.mainUserChatId || "").trim() === chatId;
}

/** 全局工作目录热切换主体：只迁移主用户私聊的会话指针——群聊/微信/其它会话不被全局切换拽走 */
function applyWorkspaceHotSwitch(newDir: string): { oldDir: string } {
  const oldDir = WORKSPACE_DIR;
  WORKSPACE_DIR = newDir;
  if (oldDir !== newDir) {
    for (const [chatId, oldSessionKey] of activeSessionMap) {
      if (!isMainUserChatKey(chatId)) continue;
      const idx = oldSessionKey.indexOf("::");
      const suffix = idx >= 0 ? oldSessionKey.slice(idx + 2) : "";
      if (idx >= 0 && isSpecialSessionSuffix(suffix)) continue;
      if (suffix === newDir) continue;
      const newSessionKey = normalizeSessionKey(`${chatId}::${newDir}`) || `${chatId}::${newDir}`;
      activeSessionMap.set(chatId, newSessionKey);
      if (idx >= 0) sessionToChatMap.delete(oldSessionKey);
      sessionToChatMap.set(newSessionKey, chatId);
      log("INFO", `[Workspace] 会话路由迁移: ${oldSessionKey} → ${newSessionKey}`);
    }
    scheduleRoutingSave();
  }
  log("INFO", `[Workspace] hot-updated: ${oldDir} -> ${newDir}`);
  process.stdout.write(`__WORKSPACE_SWITCH__:${JSON.stringify({ dir: newDir })}\n`);
  return { oldDir };
}

/** MCP 发起的切目录待确认请求（单槽，新请求顶旧）；曾有项目子代理误调 set 把全局目录偷走造成全面窜台 */
let pendingWorkspaceSwitch: { dir: string; requestedAt: number } | null = null;

async function sendWorkspaceConfirmCard(dir: string): Promise<boolean> {
  let sent = false;
  for (const rt of channels.values()) {
    if (rt.cfg.type !== "feishu" || !rt.sender) continue;
    if (!rt.cfg.mainUserEnabled || !rt.cfg.mainUserChatId?.trim()) continue;
    const buttons: CardButton[] = [
      { label: "✅ 确认切换", value: { kind: "ws_confirm", approve: "1", dir } },
      { label: "❌ 取消", value: { kind: "ws_confirm", approve: "0", dir } },
    ];
    const text = [
      "**⚠️ 有会话请求切换全局工作目录**",
      `📁 目标: \`${dir}\``,
      "",
      "切换会影响主会话的消息路由，请确认是否放行。",
    ].join("\n");
    const msgId = await rt.sender.sendCardWithButtons(text, buttons, undefined, rt.cfg.mainUserChatId.trim());
    if (msgId) sent = true;
  }
  return sent;
}

async function handleWorkspaceAdmin(method: string, req: http.IncomingMessage, res: http.ServerResponse): Promise<boolean> {
  if (method === "GET") {
    json(res, { ok: true, workspaceDir: WORKSPACE_DIR });
    return true;
  }
  if (method === "PUT" || method === "POST") {
    const body = JSON.parse(await readBody(req));
    const { dir, confirmed } = body as { dir?: string; confirmed?: boolean };
    if (!dir?.trim()) { json(res, { ok: false, error: "dir is required" }, 400); return true; }
    // path.normalize 压平 D:\\foo（Windows existsSync 对双重反斜杠仍返回 true，但 sessionKey 哈希会分裂）
    const newDir = path.normalize(dir.trim()).replace(/[\\/]+$/, "");
    if (!/[\\/]/.test(newDir) || !fs.existsSync(newDir) || !fs.statSync(newDir).isDirectory()) {
      json(res, { ok: false, error: "directory does not exist" }, 400);
      return true;
    }
    if (WORKSPACE_DIR === newDir) {
      json(res, { ok: true, message: "已是当前工作目录", dir: newDir });
      return true;
    }
    // 未经确认的切换（MCP manage_workspace 等程序化调用）必须主用户批准——
    // 项目会话/子代理误调 set 会把全局目录偷走，所有主会话消息随之窜台
    if (!confirmed) {
      pendingWorkspaceSwitch = { dir: newDir, requestedAt: Date.now() };
      const sent = await sendWorkspaceConfirmCard(newDir);
      if (sent) {
        json(res, { ok: true, pending: true, message: "切换全局工作目录需主用户批准，确认卡片已发送，批准后自动生效" });
      } else {
        pendingWorkspaceSwitch = null;
        json(res, { ok: false, error: "无法发送确认卡片（无可用主用户通道），请在应用设置中手动切换工作目录" }, 400);
      }
      return true;
    }
    const { oldDir } = applyWorkspaceHotSwitch(newDir);
    json(res, { ok: true, message: `工作目录已切换`, dir: newDir, oldDir });
    return true;
  }
  return false;
}

async function handleAgentAdmin(_method: string, req: http.IncomingMessage, res: http.ServerResponse): Promise<boolean> {
  if (_method !== "POST") return false;
  const body = JSON.parse(await readBody(req));
  const { action } = body as { action: string };
  const supportedActions = ["stop", "restart", "reset", "clean", "launch"];

  if (action === "launch") {
    const { message, chatId, channelId: bodyChannelId } = body as {
      message?: string; chatId?: string; channelId?: string;
    };
    if (!message?.trim()) { json(res, { ok: false, error: "message is required" }, 400); return true; }
    const taskId = `temp-${Date.now()}`;
    const channelId = bodyChannelId || (chatId ? parseChatKey(chatId).channelId : undefined);
    const rt = pickChannel(channelId || undefined);
    const target = rt ? channelDefaultChatId(rt) : null;
    const notifyChatKey = rt && target ? makeChatKey(rt.cfg.id, target) : undefined;
    const internalMsgId = `internal_${taskId}_${Date.now()}`;
    if (notifyChatKey) sessionToChatMap.set(taskId, notifyChatKey);
    pushToFileQueue(message.trim(), internalMsgId, `daemon-${process.pid}`, taskId, false, { chatType: "temp" });
    trackMessageSession(internalMsgId, taskId);
    rememberSessionKey(taskId);
    broadcastQueueEvent(notifyChatKey);
    log("INFO", `临时任务已入队: session=${taskId} len=${message.trim().length}`);
    json(res, { ok: true, taskId, message: "临时任务已入队" });
    return true;
  }
  if (action === "clean") {
    const cleared = clearFileQueue();
    json(res, { ok: true, cleared });
    return true;
  }
  if (supportedActions.includes(action)) {
    if (action === "stop" || action === "restart") {
      for (const key of [...activePollConnections.keys()]) {
        terminateSession(key);
      }
    }
    const msgId = `api-${Date.now()}`;
    // 带上任一已绑定主用户的 chatKey，否则 electron 侧 isMainUser 会判非管理员拒绝 /restart 等
    let adminChatId: string | undefined;
    let adminChatType: string | undefined = "p2p";
    for (const rt of channels.values()) {
      if (rt.cfg.mainUserEnabled && rt.cfg.mainUserChatId?.trim()) {
        adminChatId = makeChatKey(rt.cfg.id, rt.cfg.mainUserChatId.trim());
        break;
      }
    }
    pushCommandToQueue(`/${action}`, msgId, `mcp-api`, adminChatId, adminChatType);
    json(res, { ok: true, message: `/${action} command queued` });
    return true;
  }
  json(res, { ok: false, error: `unknown action, supported: ${supportedActions.join(", ")}` }, 400);
  return true;
}

const ADMIN_ENTITY_ROUTES: Record<string, RouteHandler> = {
  "/api/workspace": handleWorkspaceAdmin,
  "/api/agent": handleAgentAdmin,
};

async function handleAdminApi(pathname: string, method: string, req: http.IncomingMessage, res: http.ServerResponse): Promise<boolean> {
  if (!pathname.startsWith("/api/")) return false;

  if (method === "GET" && pathname === "/api/status") {
    const tasks = readTasks();
    const recentlyActive = lastMcpRequestTime > 0 && (Date.now() - lastMcpRequestTime) < 120_000;
    const channelList = getChannelStatusList();
    json(res, {
      daemon: {
        running: true, version: PKG_VERSION, uptime: Math.floor(process.uptime()), port: daemonPort,
        agentRunning: activeMcpConnections > 0 || recentlyActive,
        sessionAgentCount: activeMcpConnections,
      },
      queue: { length: getFileQueueLength() },
      tasks: { total: tasks.length, enabled: tasks.filter((t) => t.enabled).length },
      channels: channelList,
      feishu: { connected: channelList.some((c) => c.type === "feishu" && c.connected), hasChatId: channelList.some((c) => c.type === "feishu" && c.mainUserBound) },
      wechat: { enabled: channelList.some((c) => c.type === "wechat"), status: channelList.some((c) => c.type === "wechat" && c.status === "connected") ? "connected" : "disconnected" },
    });
    return true;
  }

  const crudHandler = ADMIN_CRUD_ROUTES[pathname];
  if (crudHandler) return crudHandler(method, req, res);

  // ── 消息发送 API ──
  if (method === "POST" && pathname === "/api/send-text") {
    const body = JSON.parse(await readBody(req));
    const { text, message_id, session_key } = body as { text: string; message_id?: string; session_key?: string };
    if (!text) { json(res, { ok: false, error: "text is required" }, 400); return true; }
    if (rejectUnroutedSend(res, "send-text", session_key, message_id)) return true;

    const ch = resolveChannel(routeTargetKey(session_key, message_id), { allowDefault: false });
    if (ch.type === "error") { json(res, { ok: false, error: ch.message }, 400); return true; }
    if (ch.type === "wechat") {
      json(res, { ok: await ch.rt.wechat!.sendText(ch.chatId, text) });
    } else {
      const sender = ch.rt.sender!;
      const atTags = LarkSender.containsAtTag(text) ? LarkSender.extractAtTags(text) : [];
      const cardBody = atTags.length ? LarkSender.stripAtTagsForCardDisplay(text) : text;
      // 有活跃卡则正文并入；无卡则建卡即带正文（防空白卡闪现）。
      // 含 @ 时正文仍落卡，@ 标签暂存 pendingAtMentions，finish 后单独 reply 触发通知。
      // bodyMerged 由串行链内保证（SDK 竞态建卡时并入已有卡）——为 false 必须回退独立消息，严禁静默吞正文
      if (session_key) {
        const r = await ensureStreamCardForMcpMerge(session_key, ch, cardBody);
        if (atTags.length && r.state) mergePendingAtMentions(r.state, atTags);
        if (r.state && r.bodyMerged) {
          touchSessionLastReply(session_key);
          json(res, { ok: true, message_id: r.state.messageId, merged: true });
          return true;
        }
        // fall through：无卡（降级/建卡失败）、pendingQuestion、刷卡失败 → 独立消息兜底
      }
      const colorKey = preferWorkspaceSessionKey(
        session_key,
        message_id ? messageSessionMap.get(message_id) : undefined,
        ch.chatId ? lookupActiveSessionKey(makeChatKey(ch.rt.cfg.id, ch.chatId)) : undefined,
      );
      const title = resolveReplyTitle(ch, colorKey || session_key);
      const headerTemplate = sessionHeaderTemplate(colorKey || session_key) || (title ? "turquoise" : undefined);
      let sentMsgId: string | undefined;
      // p2p 直发砍引用条；群聊保留 reply；internal_ 不可 reply
      if (shouldReplyToMessage(ch, message_id)) {
        sentMsgId = await sender.sendMessage(text, message_id, undefined, title, headerTemplate);
        if (!sentMsgId) {
          log("INFO", `回复退避: message_id=${message_id} → ${ch.chatId ? `chat_id=${ch.chatId}` : "无目标"}`);
          if (ch.chatId) sentMsgId = await sender.sendMessage(text, undefined, ch.chatId, title, headerTemplate);
        }
      } else {
        if (!ch.chatId) { json(res, { ok: false, error: "无法解析发送目标 chatId" }, 400); return true; }
        sentMsgId = await sender.sendMessage(text, undefined, ch.chatId, title, headerTemplate);
      }
      if (sentMsgId && session_key) trackMessageSession(sentMsgId, session_key);
      json(res, { ok: !!sentMsgId, message_id: sentMsgId });
    }
    if (session_key) touchSessionLastReply(session_key);
    return true;
  }

  if (method === "POST" && pathname === "/api/project-new-form") {
    const body = JSON.parse(await readBody(req));
    const { message_id, session_key, repo_roots, repo_profiles, worktree_root } = body as {
      message_id?: string; session_key?: string; repo_roots?: string[];
      repo_profiles?: { path: string; baseBranch: string }[]; worktree_root?: string
    };
    if (rejectUnroutedSend(res, "project-new-form", session_key, message_id)) return true;
    const ch = resolveChannel(routeTargetKey(session_key, message_id), { allowDefault: false });
    if (ch.type === "error") { json(res, { ok: false, error: ch.message }, 400); return true; }
    if (ch.type === "wechat") {
      const roots = (repo_roots || []).map((r, i) => `#${i + 1} ${r}`).join("\n") || "(无预置主仓，请在路径里手填)";
      const tip = [
        "微信暂不支持表单卡片，请用一行命令：",
        "/p new <名> <主仓序号或路径> <基线分支> <feature分支> <目标…>",
        "",
        `worktree 根: ${worktree_root || "(未设)"}`,
        `主仓:\n${roots}`,
      ].join("\n");
      json(res, { ok: await ch.rt.wechat!.sendText(ch.chatId, tip), degraded: true });
      return true;
    }
    const sender = ch.rt.sender!;
    const chatKey = ch.chatId ? makeChatKey(ch.rt.cfg.id, ch.chatId) : (session_key || "");
    if (chatKey) {
      saveProjectNewDraft({
        chatKey,
        step: "form",
        formMode: "main",
        formRepoProfiles: repo_profiles || [],
        formExtraRepos: [],
        updatedAt: Date.now(),
      });
    }
    const card = LarkSender.buildProjectNewFormCard({
      repoProfiles: repo_profiles || [],
      repoRoots: repo_roots || [],
      worktreeRoot: worktree_root,
      nodeGroups: getNodeGroups().map((g) => ({ id: g.id, name: g.name })),
    });
    let sent = message_id && !message_id.startsWith("internal_")
      ? await sender.sendInteractiveCard(card, message_id, undefined)
      : undefined;
    if (sent === undefined && ch.chatId) {
      sent = await sender.sendInteractiveCard(card, undefined, ch.chatId);
    }
    if (sent === undefined) {
      const roots = (repo_roots || []).map((r, i) => `#${i + 1} ${r}`).join("\n") || "(无预置主仓)";
      const tip = [
        "❌ 创建项目表单卡片被飞书拒绝（请检查路径/卡片格式）。临时可用一行命令：",
        "/p new <名> <主仓序号或路径> <基线分支> <feature分支> <目标…>",
        "",
        `worktree 根: ${worktree_root || "(未设)"}`,
        `主仓:\n${roots}`,
      ].join("\n");
      if (message_id && !message_id.startsWith("internal_")) await sender.sendMessage(tip, message_id, undefined);
      else if (ch.chatId) await sender.sendMessage(tip, undefined, ch.chatId);
      json(res, { ok: false, error: "feishu card rejected" });
      return true;
    }
    json(res, { ok: true, message_id: typeof sent === "string" ? sent : undefined });
    return true;
  }

  if (method === "POST" && pathname === "/api/project-setup-form") {
    const body = JSON.parse(await readBody(req));
    const { message_id, session_key, form, patch_message_id, worktree_root, gitlab_host, token_masked } = body as {
      message_id?: string; session_key?: string;
      form?: "repo" | "worktree" | "gitlab"; patch_message_id?: string;
      worktree_root?: string; gitlab_host?: string; token_masked?: string;
    };
    if (rejectUnroutedSend(res, "project-setup-form", session_key, message_id)) return true;
    const ch = resolveChannel(routeTargetKey(session_key, message_id), { allowDefault: false });
    if (ch.type === "error") { json(res, { ok: false, error: ch.message }, 400); return true; }
    if (ch.type === "wechat") {
      // 微信无表单卡：调用方降级走分步问答
      json(res, { ok: false, degraded: true, error: "wechat form unsupported" });
      return true;
    }
    const sender = ch.rt.sender!;
    const card = (form === "worktree" || form === "gitlab")
      ? LarkSender.buildSetupFieldFormCard({ form, worktreeRoot: worktree_root, gitlabHost: gitlab_host, tokenMasked: token_masked })
      : LarkSender.buildRepoSetupFormCard();
    // 单卡多视图：按钮点击来源时原卡直接切到表单视图
    if (patch_message_id && !patch_message_id.startsWith("internal_")) {
      const patched = await sender.patchRawCard(patch_message_id, card);
      if (patched) { json(res, { ok: true, message_id: patch_message_id }); return true; }
    }
    let sent = message_id && !message_id.startsWith("internal_")
      ? await sender.sendInteractiveCard(card, message_id, undefined)
      : undefined;
    if (sent === undefined && ch.chatId) {
      sent = await sender.sendInteractiveCard(card, undefined, ch.chatId);
    }
    json(res, { ok: sent !== undefined, message_id: typeof sent === "string" ? sent : undefined });
    return true;
  }

  if (method === "POST" && pathname === "/api/send-question") {
    const body = JSON.parse(await readBody(req));
    const { text, options, message_id, session_key } = body as { text: string; options: unknown; message_id?: string; session_key?: string };
    const opts = (Array.isArray(options) ? options : []).map((o) => String(o).trim()).filter(Boolean).slice(0, 10);
    if (!text?.trim() || opts.length === 0) { json(res, { ok: false, error: "text 与 options 必填" }, 400); return true; }
    if (rejectUnroutedSend(res, "send-question", session_key, message_id)) return true;

    const ch = resolveChannel(routeTargetKey(session_key, message_id), { allowDefault: false });
    if (ch.type === "error") { json(res, { ok: false, error: ch.message }, 400); return true; }

    if (ch.type === "wechat") {
      // 微信无交互卡片：降级为文本选项列表，用户直接回复字母或内容
      const fallback = `${text}\n\n请回复字母或选项内容:\n${opts.map((o, i) => `${questionOptionLetter(i)}. ${o}`).join("\n")}`;
      json(res, { ok: await ch.rt.wechat!.sendText(ch.chatId, fallback), degraded: true });
    } else {
      const sender = ch.rt.sender!;
      if (session_key && isStreamCardEnabled(ch)) {
        // 建卡/并卡 + 设未决问题 + finish 刷卡整段入全序链，防与 SDK flush / 收口交错
        const qResult = await enqueueCardOp(session_key, async (): Promise<{ messageId?: string } | undefined> => {
          const ensured = await ensureAgentStreamCard(session_key, { segments: [] }, ch);
          if (!ensured.ok) return undefined;
          const stream = agentStreamCards.get(session_key);
          if (!stream) return undefined;
          const displayBody = questionDisplayBody(text);
          stream.pendingQuestion = { text: displayBody, options: opts };
          const mergedOk = await refreshAgentStreamCard(session_key, stream, ch, { finish: true });
          if (!mergedOk) { stream.pendingQuestion = undefined; return undefined; }
          if (stream.messageId) {
            rememberCardQuestion(stream.messageId, {
              text, displayBody, options: opts, sessionKey: session_key,
              chatKey: session_key ? chatIdFromSessionKey(session_key) : (ch.chatId ? makeChatKey(ch.rt.cfg.id, ch.chatId) : undefined),
              createdAt: Date.now(),
              title: stream.sessionTitle,
              template: stream.sessionTemplate,
              isStreamCard: true,
            });
            trackMessageSession(stream.messageId, session_key);
          }
          return { messageId: stream.messageId };
        });
        if (qResult) {
          touchSessionLastReply(session_key);
          json(res, { ok: true, message_id: qResult.messageId, merged: true });
          return true;
        }
      }
      const colorKey = preferWorkspaceSessionKey(
        session_key,
        message_id ? messageSessionMap.get(message_id) : undefined,
        ch.chatId ? lookupActiveSessionKey(makeChatKey(ch.rt.cfg.id, ch.chatId)) : undefined,
      );
      const title = resolveReplyTitle(ch, colorKey || session_key);
      // 问题卡与普通回复同色：用会话稳定色，关闭/点选时不变色
      const displayBody = questionBodyWithOptions(text, opts);
      const pendingText = displayBody;
      const pendingFooter = QUESTION_CARD_HINT;
      const pendingTemplate = sessionHeaderTemplate(colorKey || session_key) || (title ? "turquoise" : undefined);
      const buttons = questionOptionButtons(opts, session_key);
      // p2p 直发；群聊先 reply，失败再直发（null=已回复成功勿再发）
      let sentMsgId: string | null | undefined;
      if (shouldReplyToMessage(ch, message_id)) {
        sentMsgId = await sender.sendCardWithButtons(pendingText, buttons, message_id, undefined, title, undefined, pendingTemplate, pendingFooter);
        if (sentMsgId === undefined) {
          log("INFO", `问题卡片回复退避: message_id=${message_id} → ${ch.chatId ? `chat_id=${ch.chatId}` : "无目标"}`);
          if (ch.chatId) sentMsgId = await sender.sendCardWithButtons(pendingText, buttons, undefined, ch.chatId, title, undefined, pendingTemplate, pendingFooter);
        }
      } else {
        if (!ch.chatId) { json(res, { ok: false, error: "无法解析发送目标 chatId" }, 400); return true; }
        sentMsgId = await sender.sendCardWithButtons(pendingText, buttons, undefined, ch.chatId, title, undefined, pendingTemplate, pendingFooter);
      }
      const ok = sentMsgId !== undefined; // null 也算成功（已回复到原聊天）
      if (typeof sentMsgId === "string" && sentMsgId) {
        rememberCardQuestion(sentMsgId, {
          text, displayBody, options: opts, sessionKey: session_key,
          chatKey: session_key ? chatIdFromSessionKey(session_key) : (ch.chatId ? makeChatKey(ch.rt.cfg.id, ch.chatId) : undefined),
          createdAt: Date.now(), title, template: pendingTemplate,
        });
        if (session_key) trackMessageSession(sentMsgId, session_key);
      }
      json(res, { ok, message_id: typeof sentMsgId === "string" ? sentMsgId : undefined });
    }
    if (session_key) touchSessionLastReply(session_key);
    return true;
  }

  if (method === "POST" && pathname === "/api/send-image") {
    const body = JSON.parse(await readBody(req));
    const { image_path, message_id, session_key } = body as { image_path: string; message_id?: string; session_key?: string };
    if (!image_path) { json(res, { ok: false, error: "image_path is required" }, 400); return true; }
    if (rejectUnroutedSend(res, "send-image", session_key, message_id)) return true;
    const ch = resolveChannel(routeTargetKey(session_key, message_id), { allowDefault: false });
    if (ch.type === "error") { json(res, { ok: false, error: ch.message }, 400); return true; }
    let sentOk: boolean;
    if (ch.type === "wechat") {
      sentOk = await ch.rt.wechat!.sendMedia(ch.chatId, image_path);
    } else {
      const replyId = shouldReplyToMessage(ch, message_id) ? message_id : undefined;
      if (!replyId && !ch.chatId) { json(res, { ok: false, error: "无法解析发送目标 chatId" }, 400); return true; }
      const sentId = await ch.rt.sender!.sendImage(image_path, replyId, ch.chatId);
      // 登记出站消息路由：用户引用这张图片回复时能路由回原会话
      if (sentId && session_key) trackMessageSession(sentId, session_key);
      sentOk = !!sentId;
    }
    json(res, sentOk ? { ok: true } : { ok: false, error: "图片发送失败（文件不存在或上传/发送被拒，详见 daemon 日志）" });
    if (sentOk && session_key) {
      // 媒体是独立消息：封口当前流式卡，避免后续 send_text/question 合并进旧卡
      void sealActiveStreamCardOnDelivery(session_key);
      touchSessionLastReply(session_key);
    }
    return true;
  }

  if (method === "POST" && pathname === "/api/send-file") {
    const body = JSON.parse(await readBody(req));
    const { file_path, message_id, session_key } = body as { file_path: string; message_id?: string; session_key?: string };
    if (!file_path) { json(res, { ok: false, error: "file_path is required" }, 400); return true; }
    if (rejectUnroutedSend(res, "send-file", session_key, message_id)) return true;
    const ch = resolveChannel(routeTargetKey(session_key, message_id), { allowDefault: false });
    if (ch.type === "error") { json(res, { ok: false, error: ch.message }, 400); return true; }
    let sentOk: boolean;
    if (ch.type === "wechat") {
      sentOk = await ch.rt.wechat!.sendMedia(ch.chatId, file_path);
    } else {
      const replyId = shouldReplyToMessage(ch, message_id) ? message_id : undefined;
      if (!replyId && !ch.chatId) { json(res, { ok: false, error: "无法解析发送目标 chatId" }, 400); return true; }
      const sentId = await ch.rt.sender!.sendFile(file_path, replyId, ch.chatId);
      // 登记出站消息路由：用户引用这份文件回复时能路由回原会话
      if (sentId && session_key) trackMessageSession(sentId, session_key);
      sentOk = !!sentId;
    }
    json(res, sentOk ? { ok: true } : { ok: false, error: "文件发送失败（文件不存在或上传/发送被拒，详见 daemon 日志）" });
    if (sentOk && session_key) {
      // 媒体是独立消息：封口当前流式卡，避免后续 send_text/question 合并进旧卡
      void sealActiveStreamCardOnDelivery(session_key);
      touchSessionLastReply(session_key);
    }
    return true;
  }


  if (method === "POST" && pathname === "/api/agent-stream-card") {
    const body = JSON.parse(await readBody(req));
    const { session_key, action, segments, card_id, queue_born_at } = body as {
      session_key?: string;
      action?: string;
      segments?: AgentStreamSegment[];
      card_id?: string;
      queue_born_at?: number;
    };
    if (!session_key || !action) {
      json(res, { ok: false, error: "session_key and action required" }, 400);
      return true;
    }
    const ch = resolveChannel(session_key, { allowDefault: false });
    if (ch.type === "error") {
      json(res, { ok: false, error: ch.message }, 400);
      return true;
    }
    if (ch.type === "wechat") {
      json(res, { ok: true, skipped: true });
      return true;
    }
    if (!isStreamCardEnabled(ch)) {
      json(res, { ok: true, skipped: true });
      return true;
    }
    const payload = normalizeAgentStreamPayload({ segments });
    try {
      // 整段入全序链：gone 判定与 ensure/update/finish 动作同一临界区
      const result = await enqueueCardOp(session_key, async () => {
        // 旧回合队列（诞生早于最近收口）拒绝重建副本卡；收口后诞生的新队列正常放行
        if ((action === "ensure" || action === "update")
          && !agentStreamCards.has(session_key)
          && isStaleQueue(session_key, queue_born_at)) {
          const sealAt = sessionCardSealAt.get(session_key);
          log("INFO", `[StreamCard] ${action} 旧回合队列已随收口作废 session=${session_key} bornAt=${queue_born_at ?? "none"} sealAt=${sealAt ?? "none"} deltaMs=${queue_born_at != null && sealAt != null ? queue_born_at - sealAt : "?"}`);
          return { ok: true, gone: true };
        }
        return action === "ensure"
          ? ensureAgentStreamCard(session_key, payload, ch)
          : action === "update"
            ? updateAgentStreamCard(session_key, payload, ch, card_id)
            : action === "finish"
              ? finishAgentStreamCard(session_key, payload, ch, card_id)
              : { ok: false, error: `unknown action: ${action}` };
      });
      json(res, result, result.ok || (result as { skipped?: boolean }).skipped ? 200 : 500);
    } catch (e: any) {
      log("WARN", `[StreamCard] ${action} 异常: ${e?.message ?? e}`);
      json(res, { ok: false, error: e?.message ?? String(e) }, 500);
    }
    return true;
  }

  if (method === "POST" && pathname === "/api/session-launched") {
    const body = JSON.parse(await readBody(req));
    const { session_key, resumed } = body as { session_key?: string; resumed?: boolean };
    if (!session_key) { json(res, { ok: false, error: "session_key required" }, 400); return true; }
    const sk = normalizeSessionKey(session_key) || session_key;
    if (!resumed) {
      // 全新会话（上下文丢失）：收口上一个 run 的残留流式卡，防新回复追加旧卡
      void sealActiveStreamCardOnDelivery(sk);
    }
    json(res, { ok: true });
    return true;
  }

  // pack 重启后：确认主会话残留 .claimed，避免重投的旧「打包」指令被再次执行
  if (method === "POST" && pathname === "/api/confirm-claimed") {
    const body = JSON.parse(await readBody(req));
    const { session_key } = body as { session_key?: string };
    if (!session_key) { json(res, { ok: false, error: "session_key required" }, 400); return true; }
    const sk = normalizeSessionKey(session_key) || session_key;
    const done = confirmClaimedMessages(undefined, sk);
    if (done.length > 0) {
      broadcastQueueEvent(sk);
      const ids = done.filter((mid) => mid && !mid.startsWith("internal_"));
      if (ids.length > 0) addReactionToMessages(ids, sk, "DONE");
      log("INFO", `强制确认 claimed: ${done.length} 条, DONE ${ids.length} 条, session=${sk}`);
    }
    json(res, { ok: true, confirmed: done.length });
    return true;
  }

  if (method === "GET" && pathname === "/api/session-last-reply") {
    const sk = new URL(req.url ?? "", "http://localhost").searchParams.get("sessionKey") || "";
    json(res, { lastReplyAt: sk ? (sessionLastReplyAt.get(sk) ?? null) : null });
    return true;
  }

  // E2E 注入用：直接入队消息（不广播 → 不触发 Electron 拉起真实 Agent，由测试脚本自己 poll）
  if (method === "POST" && pathname === "/api/debug/push-message") {
    const body = JSON.parse(await readBody(req));
    const { text, session_key, message_id } = body as { text?: string; session_key?: string; message_id?: string };
    if (!text || !session_key) { json(res, { ok: false, error: "text and session_key required" }, 400); return true; }
    const sk = normalizeSessionKey(session_key) || session_key;
    const mid = message_id || `internal_e2e_${Date.now()}`;
    const written = pushToFileQueue(text, mid, `e2e-${process.pid}`, sk, false, { senderType: "user" });
    if (written && mid) trackMessageSession(mid, sk);
    rememberSessionKey(sk);
    json(res, { ok: written, message_id: mid });
    return true;
  }

  // E2E 断言用：导出会话当前流式卡状态（仅本机回环可达，无鉴权风险）
  if (method === "GET" && pathname === "/api/debug/stream-card") {
    const sk = new URL(req.url ?? "", "http://localhost").searchParams.get("sessionKey") || "";
    const state = sk ? agentStreamCards.get(sk) : undefined;
    // 读也入链：等在途写操作落定后再快照，断言不吃中间态
    const snapshot = sk ? await enqueueCardOp(sk, () => {
      const s = agentStreamCards.get(sk);
      if (!s) return undefined;
      return {
        cardId: s.cardId,
        messageId: s.messageId,
        sequence: s.sequence,
        lastSegments: s.lastSegments,
        mcpReplies: s.mcpReplies,
        pendingQuestion: s.pendingQuestion ?? null,
        closedFooter: s.closedFooter ?? null,
        createdAt: s.createdAt,
      };
    }) : undefined;
    json(res, {
      exists: !!state,
      card: snapshot ?? null,
      sealAt: sk ? (sessionCardSealAt.get(sk) ?? null) : null,
    });
    return true;
  }

  if (method === "GET" && pathname === "/api/session-earliest-msg") {
    const sk = new URL(req.url ?? "", "http://localhost").searchParams.get("sessionKey") || "";
    json(res, { earliestMsgTime: sk ? getEarliestMessageTime(sk) : null });
    return true;
  }

  if (method === "POST" && pathname === "/api/active-session") {
    const body = await readBody(req);
    const { chatId, sessionKey } = JSON.parse(body);
    if (chatId && sessionKey) {
      const ok = setActiveSession(chatId, sessionKey, true);
      json(res, ok ? { ok: true } : { ok: false, error: "cross-channel active binding rejected" }, ok ? 200 : 409);
    } else {
      json(res, { ok: false, error: "chatId and sessionKey required" }, 400);
    }
    return true;
  }

  if (method === "GET" && pathname === "/api/active-sessions") {
    const entries: Record<string, string> = {};
    for (const [k, v] of activeSessionMap) entries[k] = v;
    json(res, { sessions: entries });
    return true;
  }

  if (method === "DELETE" && pathname === "/api/active-session") {
    const qs = new URL(req.url ?? "", "http://localhost").searchParams;
    const chatId = qs.get("chatId");
    if (chatId) { activeSessionMap.delete(chatId); explicitActiveChats.delete(chatId); scheduleRoutingSave(); }
    json(res, { ok: true });
    return true;
  }

  if (method === "GET" && pathname === "/api/poll-message") {
    const qs = new URL(req.url ?? "", "http://localhost").searchParams;
    const rawSessionKey = qs.get("sessionKey") || qs.get("chatId") || undefined;
    const sessionKeyFilter = rawSessionKey ? (normalizeSessionKey(rawSessionKey) || rawSessionKey) : undefined;
    const waitParam = qs.get("wait");
    const blocking = waitParam !== "false" && waitParam !== "0";

    if (!sessionKeyFilter) {
      log("WARN", "poll-message 缺少 sessionKey，已拒绝（防止跨会话误领消息）");
      json(res, { error: "sessionKey is required" }, 400);
      return true;
    }

    // 登记会话：Agent 按协议先 poll 再 send，白名单据此放行
    rememberSessionKey(sessionKeyFilter);

    const keepAlive = resolveKeepAlive(sessionKeyFilter);

    // 非阻塞（冷启动/唤醒检查）：顶掉旧连接后领取不删——.qmsg→.claimed，
    // 返回全部排队+处理中消息（含幽灵连接领走的重投）。任何时候下一次 poll 必须能看到未完成的消息。
    if (!blocking) {
      broadcastPollPhaseEvent(sessionKeyFilter, "start", { blocking: false });
      terminateSession(sessionKeyFilter);
      const messages = claimSessionMessages(sessionKeyFilter);
      let freshIds: string[] = [];
      if (messages.length > 0) {
        freshIds = collectFreshAndTrack(messages, sessionKeyFilter);
        log("INFO", `消息已投递(instant): count=${messages.length} session=${sessionKeyFilter}`);
        touchSessionDelivery(sessionKeyFilter);
        addReactionToMessages(freshIds, sessionKeyFilter, "Get");
        // instant 投递不关问题卡：expire 会走 sealQuestionCardByMessageId 误 seal 活流式卡（Agent 干活中 poll 拉到新消息）
      }
      logPollDeliveryToAgent(sessionKeyFilter, { blocking: false, messages, keepAlive });
      broadcastPollPhaseEvent(sessionKeyFilter, "end", {
        blocking: false,
        reason: "instant",
        messageIds: messages.map((m) => m.messageId).filter((id): id is string => !!id),
      });
      json(res, { messages: sanitizePollMessages(messages) });
      return true;
    }

    // 阻塞：新 poll 永远顶掉旧连接（幽灵 curl 不占坑，被它领走的消息已是 .claimed，本次确认或下次重投）
    terminateSession(sessionKeyFilter);

    let disconnected = false;
    registerPollConn(sessionKeyFilter, res);
    broadcastPollPhaseEvent(sessionKeyFilter, "start", { blocking: true });
    req.on("close", () => { disconnected = true; unregisterPollConn(sessionKeyFilter, res); });
    req.socket.setTimeout(0);

    // 黑洞投递嫌疑：上次投递后 Agent 没有任何出站（send_* 均未发生）就直接来挂 poll——
    // 大概率上次响应写进了已死连接（curl 被工具桥杀掉但 TCP 未断，daemon 无感知），Agent 从未见过那批消息。
    // 此时不确认，把全部未确认消息立即重投给本次 poll；每条只重投一次，防 Agent 拒不回复时死循环。
    {
      const deliveredAt = sessionLastDeliveryAt.get(sessionKeyFilter) ?? 0;
      const repliedAt = sessionLastReplyAt.get(sessionKeyFilter) ?? 0;
      if (deliveredAt > repliedAt) {
        const pending = claimSessionMessages(sessionKeyFilter);
        let seen = redeliveredMsgIds.get(sessionKeyFilter);
        const firstTime = pending.filter((m) => m.messageId && !seen?.has(m.messageId));
        if (firstTime.length > 0) {
          if (!seen) { seen = new Set(); redeliveredMsgIds.set(sessionKeyFilter, seen); }
          for (const m of firstTime) seen.add(m.messageId);
          unregisterPollConn(sessionKeyFilter, res);
          const freshIds = collectFreshAndTrack(pending, sessionKeyFilter);
          touchSessionDelivery(sessionKeyFilter);
          log("INFO", `疑似黑洞投递（投递后无出站回复），重投 ${pending.length} 条未确认消息: session=${sessionKeyFilter}`);
          // 阻塞重投 = 新回合：有用户消息就 seal（不依赖 freshIds，避免重投丢思考）
          await sealOnUserDelivery(sessionKeyFilter, pending);
          logPollDeliveryToAgent(sessionKeyFilter, { blocking: true, messages: pending, keepAlive });
          broadcastPollPhaseEvent(sessionKeyFilter, "end", {
            blocking: true,
            reason: "redeliver",
            messageIds: pending.map((m) => m.messageId).filter((id): id is string => !!id),
          });
          json(res, { messages: sanitizePollMessages(pending) });
          addReactionToMessages(freshIds, sessionKeyFilter, "Get");
          return true;
        }
      }
    }

    // 阻塞 poll = Agent 声明手头事项全部处理完：确认全部 .claimed 并打 DONE
    confirmSessionDone(sessionKeyFilter);
    redeliveredMsgIds.delete(sessionKeyFilter);

    // 空等挂起 = 回合结束：兜底收口无未决问题的活卡（SDK 侧 ensure 失败无 cardId 时不会自己 finish）
    const liveCard = agentStreamCards.get(sessionKeyFilter);
    if (liveCard && !liveCard.pendingQuestion) {
      void sealActiveStreamCardOnDelivery(sessionKeyFilter);
    }

    // keep_alive=false 不真挂起：入队前再扫一次，防挂 poll 竞态丢消息
    if (!keepAlive) {
      unregisterPollConn(sessionKeyFilter, res);
      const pending = claimSessionMessages(sessionKeyFilter);
      if (pending.length > 0 && hasUserDeliverableMessages(pending)) {
        const freshIds = collectFreshAndTrack(pending, sessionKeyFilter);
        touchSessionDelivery(sessionKeyFilter);
        log("INFO", `消息已投递(poll/竞态): count=${pending.length} session=${sessionKeyFilter}`);
        await sealOnUserDelivery(sessionKeyFilter, pending);
        logPollDeliveryToAgent(sessionKeyFilter, { blocking: true, messages: pending, keepAlive });
        broadcastPollPhaseEvent(sessionKeyFilter, "end", {
          blocking: true,
          reason: "messages",
          messageIds: pending.map((m) => m.messageId).filter((id): id is string => !!id),
        });
        json(res, { messages: sanitizePollMessages(pending) });
        addReactionToMessages(freshIds, sessionKeyFilter, "Get");
        return true;
      }
      logPollDeliveryToAgent(sessionKeyFilter, { blocking: true, directive: POLL_DIRECTIVE_END, messages: [], keepAlive });
      broadcastPollPhaseEvent(sessionKeyFilter, "end", {
        blocking: true,
        reason: "end",
        directive: POLL_DIRECTIVE_END,
      });
      json(res, { messages: [], directive: POLL_DIRECTIVE_END });
      return true;
    }

    const POLL_TIMEOUT_MS = 25 * 60 * 1000;
    const messages = await waitForSessionMessages(POLL_TIMEOUT_MS, undefined, sessionKeyFilter, () => disconnected);
    unregisterPollConn(sessionKeyFilter, res);

    // 客户端已断开：消息仍是 .claimed（未确认），下次 poll 会重新投递，不会丢
    if (disconnected) {
      if (messages.length > 0) {
        log("INFO", `Poll 连接已断开，${messages.length} 条消息保持未确认待重投: session=${sessionKeyFilter}`);
      }
      broadcastPollPhaseEvent(sessionKeyFilter, "end", { blocking: true, reason: "abort" });
      return true;
    }

    if (messages.length === 0) {
      logPollDeliveryToAgent(sessionKeyFilter, { blocking: true, directive: POLL_DIRECTIVE_TIMEOUT, messages: [], keepAlive });
      broadcastPollPhaseEvent(sessionKeyFilter, "end", {
        blocking: true,
        reason: "timeout",
        directive: POLL_DIRECTIVE_TIMEOUT,
      });
      json(res, { messages: [], directive: POLL_DIRECTIVE_TIMEOUT });
      return true;
    }

    const freshIds = collectFreshAndTrack(messages, sessionKeyFilter);
    log("INFO", `消息已投递(poll): count=${messages.length} session=${sessionKeyFilter}`);
    touchSessionDelivery(sessionKeyFilter);
    // 阻塞投递用户消息：有 messageId 就 seal（含重投），不依赖 freshIds
    await sealOnUserDelivery(sessionKeyFilter, messages);
    logPollDeliveryToAgent(sessionKeyFilter, { blocking: true, messages, keepAlive });
    broadcastPollPhaseEvent(sessionKeyFilter, "end", {
      blocking: true,
      reason: "messages",
      messageIds: messages.map((m) => m.messageId).filter((id): id is string => !!id),
    });
    json(res, { messages: sanitizePollMessages(messages) });
    addReactionToMessages(freshIds, sessionKeyFilter, "Get");
    return true;
  }

  // ── SSE 队列事件流 ──
  if (pathname === "/api/queue-events" && method === "GET") {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });
    res.write(`data: ${JSON.stringify({ type: "connected", ts: Date.now() })}\n\n`);
    sseClients.add(res);
    req.on("close", () => { sseClients.delete(res); });
    return true;
  }

  // ── Chat 名称查询（按 chatKey 路由到对应通道）──
  if (pathname === "/api/chat-names" && method === "POST") {
    const body = JSON.parse(await readBody(req));
    const chatIds = Array.isArray(body.chatIds) ? body.chatIds as string[] : [];
    const names: Record<string, string> = {};
    for (const cid of chatIds) {
      const { channelId, chatId } = parseChatKey(cid);
      const rt = channelId ? channels.get(channelId) : [...channels.values()].find((c) => c.cfg.type === "feishu" && c.client);
      const client = rt?.client;
      if (!client) continue;
      try {
        const r: any = await client.im.chat.get({ path: { chat_id: chatId } });
        const name = r?.data?.name || r?.data?.chat?.name;
        if (name) names[cid] = name;
      } catch { /* ignore */ }
    }
    json(res, { ok: true, names });
    return true;
  }

  // ── 用户名查询（通过 open_id 获取用户名）──
  // open_id 是应用维度的：只有签发它的应用（所属通道）能解析，跨通道查询必然报 "open_id cross app"
  if (pathname === "/api/user-names" && method === "POST") {
    const body = JSON.parse(await readBody(req));
    const openIds = Array.isArray(body.openIds) ? body.openIds as string[] : [];
    const owner = typeof body.channelId === "string" ? channels.get(body.channelId) : undefined;
    const names: Record<string, string> = {};
    if (!owner?.client) {
      if (openIds.length > 0) {
        log("WARN", `用户名解析跳过 ${openIds.join(",")}: 所属通道 ${body.channelId ?? "未知"} 未连接或非飞书通道`);
      }
      json(res, { ok: true, names });
      return true;
    }
    for (const oid of openIds) {
      try {
        const r: any = await owner.client.contact.user.get({
          path: { user_id: oid },
          params: { user_id_type: "open_id" },
        });
        const user = r?.data?.user ?? r?.user;
        const name = user?.name || user?.nickname || user?.en_name;
        if (name) { names[oid] = name; continue; }
        // code=0 仅表示接口通了，不等于拿到姓名（可见范围外常返回空 user）
        const code = r?.code ?? "?";
        const msg = r?.msg ?? "返回为空";
        const detail = user
          ? `code=${code} ${msg}，user 无 name/nickname/en_name`
          : `code=${code} ${msg}，data.user 为空（多半不在通讯录可见范围）`;
        log("WARN", `用户名解析失败 ${oid}@${owner.cfg.name}: ${detail}`
          + "（需 contact:contact.base:readonly 且用户在应用通讯录可见范围内；外部用户无法解析，将以“通道名·访客”展示）");
      } catch (e: any) {
        const msg = e?.response?.data?.msg ?? e?.message ?? String(e);
        log("WARN", `用户名解析失败 ${oid}@${owner.cfg.name}: ${msg}`
          + "（需 contact:contact.base:readonly 且用户在应用通讯录可见范围内；外部用户无法解析，将以“通道名·访客”展示）");
      }
    }
    json(res, { ok: true, names });
    return true;
  }

  const crudHandler2 = ADMIN_ENTITY_ROUTES[pathname];
  if (crudHandler2) return crudHandler2(method, req, res);

  return false;
}

// ── Lock 文件 ────────────────────────────────────────────

function getLockFilePath(): string {
  return path.join(APP_DATA_DIR, LOCK_FILE_NAME);
}

function writeLockFile(port: number): void {
  const lockPath = getLockFilePath();
  const lockDir = path.dirname(lockPath);
  if (!fs.existsSync(lockDir)) fs.mkdirSync(lockDir, { recursive: true });
  fs.writeFileSync(lockPath, JSON.stringify({
    pid: process.pid, port, version: PKG_VERSION,
    startedAt: localTimestamp(), workspaceDir: WORKSPACE_DIR,
  }));
}

function removeLockFile(): void {
  try {
    const lockPath = getLockFilePath();
    if (fs.existsSync(lockPath)) { fs.unlinkSync(lockPath); }
  } catch { /* ignore */ }
}

// ── 主函数 ───────────────────────────────────────────────

/** 定时任务入队：独立 → taskId 会话队列；非独立 → 主会话。失败重试共用调度器。 */
function enqueueScheduledTaskMessage(task: ScheduledTask, content: string): void {
  const rt = pickChannel(task.channelId);
  const target = rt ? channelDefaultChatId(rt) : null;
  const notifyChatKey = rt && target ? makeChatKey(rt.cfg.id, target) : undefined;
  const notifySessionKey = buildNotifySessionKey(task);
  const internalMsgId = `internal_${task.id}_${Date.now()}`;

  if (notifySessionKey) {
    rememberSessionKey(notifySessionKey);
    log("INFO", `定时任务「${task.name}」投递目标: ${notifySessionKey}`);
  }

  if (task.independent !== false) {
    if (notifyChatKey) sessionToChatMap.set(task.id, notifyChatKey);
    if (task.model?.trim()) {
      try {
        setSessionOverride(task.id, { model: task.model.trim(), modelParams: task.modelParams ?? "" });
      } catch (e: unknown) {
        log("WARN", `定时任务模型 override 写入失败: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    pushToFileQueue(content, internalMsgId, `daemon-${process.pid}`, task.id, false, { chatType: "task" });
    trackMessageSession(internalMsgId, task.id);
    rememberSessionKey(task.id);
    broadcastQueueEvent(notifyChatKey);
    log("INFO", `定时任务已直投独立会话队列: ${task.name} → ${task.id}`);
    return;
  }

  if (rt && target && notifyChatKey) {
    const wsDir = channelWorkspaceDir(rt);
    const mainSessionKey = normalizeSessionKey(`${notifyChatKey}::${wsDir}`) || `${notifyChatKey}::${wsDir}`;
    pushToFileQueue(content, internalMsgId, `daemon-${process.pid}`, mainSessionKey, false, { chatType: "p2p" });
    trackMessageSession(internalMsgId, mainSessionKey);
    rememberSessionKey(mainSessionKey);
    broadcastQueueEvent(notifyChatKey);
    log("INFO", `定时任务已直投主会话: ${task.name} → ${mainSessionKey}`);
  } else {
    log("WARN", `定时任务「${task.name}」消息无法入队: 通道无主用户且无私聊记录`);
  }
}

export async function daemonMain(): Promise<void> {
  if (CHANNEL_CONFIGS.length === 0) {
    log("ERROR", "未配置任何消息通道，至少需要启用一个（CLAW_CHANNELS_JSON 为空）");
    process.exit(1);
  }

  migrateLegacyLogFile();
  log("INFO", `Daemon v${PKG_VERSION} 启动`);
  log("INFO", `workspace: ${WORKSPACE_DIR}`);
  log("INFO", `通道(${CHANNEL_CONFIGS.length}): ${CHANNEL_CONFIGS.map((c) => `${c.name}[${c.type}]`).join(" + ")}`);
  log("INFO", `日志文件: ${LOG_FILE_PATH}`);

  const cleanup = () => {
    stopDaemonScheduledTasks();
    removeLockFile();
    process.exit(0);
  };
  process.on("SIGINT", cleanup);
  process.on("SIGTERM", cleanup);
  process.on("exit", removeLockFile);

  // 全局兜底：消息桥接守护进程，掉线比带病更糟——漏网异步异常只记录不退出，避免飞书/微信整体掉线
  process.on("uncaughtException", (e) => {
    log("ERROR", `未捕获异常: ${e?.stack ?? e}`);
  });
  process.on("unhandledRejection", (reason) => {
    log("ERROR", `未处理的 Promise 拒绝: ${reason instanceof Error ? (reason.stack ?? reason.message) : String(reason)}`);
  });

  initQueue();
  loadRoutingMaps();
  loadCardQuestions();
  if (APP_DATA_DIR) {
    initProjectStore(APP_DATA_DIR);
    initSessionModelStore(APP_DATA_DIR);
    initClawMcpStore(APP_DATA_DIR);
    initClawRuleStore(APP_DATA_DIR);
  }
  startMediaCacheCleanup();

  for (const cfg of CHANNEL_CONFIGS) {
    startChannelRuntime(cfg).catch((e: unknown) => {
      log("ERROR", `[${cfg.name}] 通道启动失败: ${e instanceof Error ? e.message : e}`);
    });
  }
  startFeishuWsWatchdog();

  daemonPort = await startHttpServer();
  process.env.LARK_DAEMON_PORT = String(daemonPort);
  writeLockFile(daemonPort);
  log("INFO", "MCP 服务已就绪 (/mcp + /mcp-admin)");

  setDaemonSchedulerLogger((msg) => { log("INFO", msg); });
  startDaemonScheduledTasks((task, content) => {
    enqueueScheduledTaskMessage(task, content);
  });

  log("INFO", `Daemon 就绪 ✓ port=${daemonPort}`);
}

