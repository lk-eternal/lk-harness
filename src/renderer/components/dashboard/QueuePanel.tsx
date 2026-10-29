import { Trash2 } from "lucide-react"
import PanelShell from "./PanelShell"

export interface QueueMessageView {
  index: number
  fileId: string
  preview: string
  status?: "pending" | "processing"
  sessionKey?: string
  chatType?: string
  timestamp?: number
  senderOpenId?: string
  sessionLabel?: string
}

export function formatQueueTimestamp(ts?: number): string {
  if (!ts) return ""
  const d = new Date(ts)
  return d.toLocaleString("zh-CN", { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false })
}

/** 工作台「消息队列」功能区：全局队列的每一条（所属通道 / 会话 / 状态 / 时间 / 预览），可以逐条删除 */
export default function QueuePanel({
  messages,
  metaByKey,
  labelOf,
  onDelete,
}: {
  messages: readonly QueueMessageView[]
  /** 会话键（小写）→ 所属通道名和会话标签，和会话清单里的口径一致 */
  metaByKey: ReadonlyMap<string, { channelName: string; label: string }>
  /** 会话树里找不到时，用队列消息自己带的信息拼一个标签 */
  labelOf: (msg: QueueMessageView) => string
  onDelete: (fileId: string) => void
}) {
  return (
    <PanelShell title="全局消息队列" meta={`${messages.length} 条`}>
      {messages.length === 0 ? (
        <p className="px-3 py-6 text-center text-xs text-fg-faint">队列为空</p>
      ) : (
        <div className="space-y-1.5 p-3">
          {messages.map((msg) => {
            const meta = msg.sessionKey ? metaByKey.get(msg.sessionKey.toLowerCase()) : undefined
            return (
              <div key={msg.fileId || msg.index} data-queue-item={msg.fileId} className="flex items-start justify-between gap-2 rounded-lg bg-raised/60 px-3 py-2">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-1.5">
                    {meta && (
                      <span className="shrink-0 rounded bg-raised px-1 text-[10px] text-fg-3" title="所属通道">
                        {meta.channelName}
                      </span>
                    )}
                    <span className="min-w-0 truncate text-[10px] font-medium text-accent" title={msg.sessionKey}>
                      {meta?.label ?? labelOf(msg)}
                    </span>
                    <span className={`shrink-0 rounded px-1 text-[9px] ${msg.status === "processing" ? "bg-blue-600/25 text-accent-soft" : "bg-yellow-600/20 text-warning-soft"}`}>
                      {msg.status === "processing" ? "处理中" : "排队"}
                    </span>
                    <span className="shrink-0 text-[10px] text-fg-muted">{formatQueueTimestamp(msg.timestamp)}</span>
                  </div>
                  <p className="mt-0.5 truncate text-xs text-fg-2">{msg.preview}</p>
                </div>
                <button
                  type="button"
                  onClick={() => onDelete(msg.fileId)}
                  className="shrink-0 rounded p-0.5 text-fg-muted transition hover:bg-red-600/20 hover:text-danger"
                  title="删除此消息"
                >
                  <Trash2 size={12} />
                </button>
              </div>
            )
          })}
        </div>
      )}
    </PanelShell>
  )
}
