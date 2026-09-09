import { readLockFile, getCurrentActiveSession } from "./daemon-client"
import { getChannel, resolveChannelModel, effectiveWorkspaceDir, type MessageChannel, type ModelScenario } from "./config-store"
import { parseChatKey } from "../src/shared/channel-types"
import { findLiveSessionKey } from "./agent-engine"
import { getSessionOverride } from "../src/shared/session-model-store.js"

/** 指令与模型切换共用的 sessionKey：active → live → 主用户目录会话 → 裸 chatId */
export async function resolveEffectiveSessionKey(
  chatId?: string,
  chatType?: string,
  port?: number,
): Promise<string | undefined> {
  if (!chatId) return undefined
  const daemonPort = port ?? readLockFile()?.port
  if (daemonPort) {
    const active = await getCurrentActiveSession(daemonPort, chatId)
    if (active?.trim()) return active
  }
  const live = findLiveSessionKey(chatId)
  if (live) return live
  if (chatType === "p2p") {
    const channel = getChannel(parseChatKey(chatId).channelId)
    if (channel?.mainUserEnabled && channel.mainUserChatId?.trim()) {
      const raw = parseChatKey(chatId).chatId
      if (raw === channel.mainUserChatId.trim()) {
        const wsDir = effectiveWorkspaceDir(channel)
        if (wsDir) return `${chatId}::${wsDir}`
      }
    }
  }
  return chatId
}

/** /m、/status、/c 共用的有效模型解析 */
export function resolveEffectiveModel(
  sessionKey: string | undefined,
  channel: MessageChannel | undefined,
  scenario: ModelScenario = "primary",
  matched?: { model?: string; modelParams?: string },
): { model: string; modelParams: string } {
  const channelModel = resolveChannelModel(channel, scenario)
  const override = sessionKey ? getSessionOverride(sessionKey) : undefined
  return {
    model: matched?.model || override?.model || channelModel.model,
    modelParams: matched?.modelParams ?? override?.modelParams ?? channelModel.modelParams,
  }
}
