import * as path from "node:path"
import * as fs from "node:fs"
import {
  getChannel, getChannels, updateChannel,
  getChannelFavoriteWorkspaces, type MessageChannel,
} from "./config-store"

function channelReady(c: MessageChannel): boolean {
  if (!c.enabled) return false
  if (c.type === "feishu") return !!(c.larkAppId?.trim() && c.larkAppSecret?.trim())
  return !!c.wechatToken?.trim()
}
import { readGitBranch, dirBaseName } from "../src/shared/session-label.js"
import { resolveChannelSessionFlags } from "../src/shared/channel-types.js"
import { invalidateMcpEnabledCache } from "./mcp-manager"
import { cleanupChannelWorkspaces, clearInjectionCache } from "./workspace-injector"
import { broadcastLog } from "./ui-logger"
import { readLockFile, httpPost, syncActiveSession } from "./daemon-client"
import type { DaemonChannelConfig } from "../src/shared/channel-types"

export function formatWorkspaceSwitchText(dir: string): string {
  const label = dirBaseName(dir)
  const branch = readGitBranch(dir)
  return [
    "✅ 工作目录已切换",
    `📁 \`${dir}\``,
    branch ? `🌿 分支: ${branch}` : undefined,
    `📂 ${label} · 会话上下文已切换`,
  ].filter(Boolean).join("\n")
}

function channelRuntimePayload(channels: MessageChannel[]) {
  return channels.filter(channelReady).map((c) => {
    const main = resolveChannelSessionFlags(c, "main")
    const others = resolveChannelSessionFlags(c, "others")
    return {
      id: c.id,
      keepAlive: main.keepSession && main.persistentPoll,
      showThinking: main.showThinking,
      streamKeepPerKind: main.streamKeepPerKind,
      hideThinkingOnFinish: main.hideThinkingOnFinish,
      keepAliveMain: main.keepSession && main.persistentPoll,
      showThinkingMain: main.showThinking,
      streamKeepPerKindMain: main.streamKeepPerKind,
      hideThinkingOnFinishMain: main.hideThinkingOnFinish,
      keepAliveOthers: others.keepSession && others.persistentPoll,
      showThinkingOthers: others.showThinking,
      streamKeepPerKindOthers: others.streamKeepPerKind,
      hideThinkingOnFinishOthers: others.hideThinkingOnFinish,
    name: c.name,
    mainUserEnabled: !!c.mainUserEnabled,
    mainUserChatId: c.mainUserEnabled ? (c.mainUserChatId?.trim() ?? "") : "",
    mainUserOpenId: c.mainUserOpenId?.trim() || undefined,
    workspaceDir: c.workspaceDir?.trim() ?? "",
    favoriteWorkspaces: getChannelFavoriteWorkspaces(c),
    }
  })
}

export async function pushChannelRuntimeToDaemon(channels?: MessageChannel[]): Promise<void> {
  const port = readLockFile()?.port
  if (!port) return
  const payload = channelRuntimePayload(channels ?? getChannels())
  try {
    await httpPost(`http://127.0.0.1:${port}/api/channel-flags`, { channels: payload }, 5000)
  } catch (e: unknown) {
    broadcastLog(`[Channels] 运行时配置热更新失败: ${e instanceof Error ? e.message : String(e)}`, "WARN")
  }
}

/** 切换指定通道的主用户工作目录，并热推 daemon 与 active 路由 */
export async function applyChannelWorkspaceSwitch(
  channelId: string,
  workspaceDir: string,
  chatId?: string,
): Promise<{ ok: boolean; error?: string }> {
  const w = path.normalize(workspaceDir.trim()).replace(/[\\/]+$/, "")
  if (!w) return { ok: false, error: "工作目录为空" }
  if (!/[\\/]/.test(w) || !fs.existsSync(w) || !fs.statSync(w).isDirectory()) {
    return { ok: false, error: `目录不存在或不是有效路径: ${w}` }
  }
  const channel = getChannel(channelId)
  if (!channel) return { ok: false, error: "通道不存在" }
  const unchanged = channel.workspaceDir?.trim() === w

  if (!unchanged) {
    updateChannel(channelId, { workspaceDir: w })
    invalidateMcpEnabledCache()
    clearInjectionCache()
    cleanupChannelWorkspaces()
  }

  await pushChannelRuntimeToDaemon()

  if (chatId) {
    const sessionKey = `${chatId}::${w}`
    const port = readLockFile()?.port
    if (port) {
      const synced = await syncActiveSession(port, chatId, sessionKey)
      if (!synced) {
        return { ok: false, error: "目录已更新，但会话路由绑定失败（请重试 /c w）" }
      }
    }
  }

  return { ok: true }
}

export function buildDaemonChannelConfig(c: MessageChannel): DaemonChannelConfig | null {
  if (!channelReady(c)) return null
  const main = resolveChannelSessionFlags(c, "main")
  const others = resolveChannelSessionFlags(c, "others")
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
    mainUserOpenId: c.mainUserOpenId?.trim() || undefined,
    workspaceDir: c.workspaceDir?.trim() ?? "",
    favoriteWorkspaces: getChannelFavoriteWorkspaces(c),
    keepAlive: main.keepSession && main.persistentPoll,
    showThinking: main.showThinking,
    streamKeepPerKind: main.streamKeepPerKind,
    hideThinkingOnFinish: main.hideThinkingOnFinish,
    keepAliveMain: main.keepSession && main.persistentPoll,
    showThinkingMain: main.showThinking,
    streamKeepPerKindMain: main.streamKeepPerKind,
    hideThinkingOnFinishMain: main.hideThinkingOnFinish,
    keepAliveOthers: others.keepSession && others.persistentPoll,
    showThinkingOthers: others.showThinking,
    streamKeepPerKindOthers: others.streamKeepPerKind,
    hideThinkingOnFinishOthers: others.hideThinkingOnFinish,
  }
}
