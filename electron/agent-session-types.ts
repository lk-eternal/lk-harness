export type ChatType = "p2p" | "group" | "task" | "temp" | "project"

export interface LaunchMeta {
  messageIds?: string[]
  chatId?: string
  chatType?: string
}
