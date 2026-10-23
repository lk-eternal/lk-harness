import { appChatSessionId } from "../../../shared/app-chat-types"
import { createDraftStore } from "../../../shared/composer-drafts"

export interface PendingImage {
  /** 主进程落盘后的绝对路径（随消息发给 Agent） */
  path: string
  /** 仅用于输入框内预览的 blob URL */
  preview: string
}

/** 桌面端输入框草稿，键是 appChatSessionId；图片离开草稿时释放它的 blob URL */
export const composerDrafts = createDraftStore<PendingImage>({
  onRemoveImage: (image) => URL.revokeObjectURL(image.preview),
})

/** 当前会话对应的草稿键；还没选中会话时为 null（输入框是禁用的） */
export function composerDraftKey(sessionKey: string | null | undefined): string | null {
  return sessionKey ? appChatSessionId(sessionKey) : null
}

/** 会话被删除时丢掉它没发出去的草稿 */
export function discardComposerDraft(sessionKey: string): void {
  composerDrafts.discard(composerDraftKey(sessionKey))
}
