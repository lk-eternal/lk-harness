import { sameChatSession } from "../renderer/components/chat/useAppChatItems"
import type { MobileChannelView, MobileChatTab } from "./api"

/** 刚建好、还没发过消息的临时会话：会话在首条消息发出时才建立，在此之前只存在于手机界面里 */
export interface DraftSession {
  channelId: string
  sessionKey: string
}

export type TabModel = Pick<MobileChatTab, "model" | "modelParams" | "resourceId">

/** 把草稿会话补进对应通道的会话列表（服务端已经有同一会话时不重复）；草稿的模型由服务端按会话键提供 */
export function withDrafts(
  views: MobileChannelView[],
  drafts: DraftSession[],
  draftModels: Record<string, TabModel>,
): MobileChannelView[] {
  if (drafts.length === 0) return views
  return views.map((v) => {
    const extra = drafts
      .filter(
        (d) =>
          d.channelId === v.channelId &&
          !v.tabs.some((t) => sameChatSession(t.sessionKey, d.sessionKey)),
      )
      .map(
        (d): MobileChatTab => ({
          sessionKey: d.sessionKey,
          label: "新会话",
          kind: "dir",
          running: false,
          current: false,
          removable: true,
          ...draftModels[d.sessionKey],
        }),
      )
    return extra.length > 0 ? { ...v, tabs: [...extra, ...v.tabs] } : v
  })
}
