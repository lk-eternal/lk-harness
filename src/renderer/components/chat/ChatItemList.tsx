import { useRef } from "react"
import { ArrowDown, Loader2 } from "lucide-react"
import type { AppChatItem } from "../../../shared/app-chat-types"
import { useStickToBottom } from "../../hooks/useStickToBottom"
import AssistantTurn from "./AssistantTurn"
import { FileCard, LocalImage, NoticePill, QuestionCard, UserBubble } from "./ItemViews"
import Markdown from "./Markdown"

interface Props {
  items: AppChatItem[]
  loading: boolean
  /** AI 正在工作；最后一条是用户消息时补一个"正在处理"占位，覆盖流式卡出现前的空窗 */
  busy: boolean
  onAnswer: (questionId: string, option: string) => void
  onCommand: (cmd: string) => void
}

export default function ChatItemList({ items, loading, busy, onAnswer, onCommand }: Props) {
  const scrollRef = useRef<HTMLDivElement>(null)
  const { sentinelRef, atBottom, scrollToBottom } = useStickToBottom(scrollRef, [items])
  const waiting = busy && items.length > 0 && items[items.length - 1].kind === "user"

  return (
    <div className="relative min-h-0 flex-1">
      <div ref={scrollRef} className="h-full overflow-y-auto px-6 py-4">
        <div className="mx-auto flex max-w-3xl flex-col gap-4">
          {loading && items.length === 0 && <p className="text-center text-xs text-fg-faint">加载中…</p>}
          {!loading && items.length === 0 && <p className="py-20 text-center text-sm text-fg-faint">发一条消息开始对话</p>}
          {items.map((it) => {
            switch (it.kind) {
              case "user": return <UserBubble key={it.id} item={it} />
              case "assistant": return <AssistantTurn key={it.id} item={it} />
              case "text": return <Markdown key={it.id} text={it.text} />
              case "question": return <QuestionCard key={it.id} item={it} onAnswer={onAnswer} />
              case "image": return <LocalImage key={it.id} path={it.path} className="max-h-72 max-w-sm self-start" />
              case "file": return <FileCard key={it.id} item={it} />
              case "notice": return <NoticePill key={it.id} item={it} onCommand={onCommand} />
            }
          })}
          {waiting && <div className="flex items-center gap-2 text-xs text-fg-muted"><Loader2 size={12} className="animate-spin" />Agent 正在处理…</div>}
          <div ref={sentinelRef} />
        </div>
      </div>
      {!atBottom && (
        <button
          type="button"
          onClick={scrollToBottom}
          title="回到底部"
          className="absolute bottom-3 right-6 rounded-full border border-line bg-surface p-2 text-fg-2 shadow-lg transition hover:bg-raised"
        ><ArrowDown size={14} /></button>
      )}
    </div>
  )
}
