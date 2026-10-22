import { useRef } from "react"
import { ArrowDown, Loader2, MessageCircle } from "lucide-react"
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
  /** 会话的目录名；临时会话没有指定目录，为空 */
  workspaceName?: string
  onAnswer: (questionId: string, option: string) => void
  onCommand: (cmd: string) => void
}

function EmptyChat({ workspaceName }: { workspaceName?: string }) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-2.5 pb-10 text-center">
      <div className="mb-1 flex h-12 w-12 items-center justify-center rounded-[14px] bg-raised text-fg-3"><MessageCircle size={24} /></div>
      <p className="text-[17px] font-semibold text-fg">开始一段新对话</p>
      <p className="max-w-[380px] text-[13px] leading-[1.75] text-fg-muted">
        {workspaceName
          ? `在「${workspaceName}」目录里运行，可以直接让 Agent 处理这个目录的内容。`
          : <>没有指定目录，会在临时目录里运行，适合日常问答。<br />要处理某个项目，用输入框下方的目录选择切过去。</>}
      </p>
    </div>
  )
}

export default function ChatItemList({ items, loading, busy, workspaceName, onAnswer, onCommand }: Props) {
  const scrollRef = useRef<HTMLDivElement>(null)
  const { sentinelRef, atBottom, scrollToBottom } = useStickToBottom(scrollRef, [items])
  const waiting = busy && items.length > 0 && items[items.length - 1].kind === "user"

  return (
    <div className="relative min-h-0 flex-1">
      <div ref={scrollRef} className="h-full overflow-y-auto px-6 py-4">
        <div className="mx-auto flex min-h-full max-w-3xl flex-col gap-4">
          {loading && items.length === 0 && <p className="text-center text-xs text-fg-faint">加载中…</p>}
          {!loading && items.length === 0 && <EmptyChat workspaceName={workspaceName} />}
          {items.map((it) => {
            switch (it.kind) {
              case "user": return <UserBubble key={it.id} item={it} />
              case "assistant": return <AssistantTurn key={it.id} item={it} />
              case "text": return <Markdown key={it.id} text={it.text} />
              case "question": return <QuestionCard key={it.id} item={it} onAnswer={onAnswer} />
              case "image": return <LocalImage key={it.id} path={it.path} className="max-h-72 max-w-sm self-start" />
              case "file": return <FileCard key={it.id} item={it} />
              case "notice": return <NoticePill key={it.id} item={it} onCommand={onCommand} />
              default: {
                // 新增消息类型漏渲染时在这里编译报错，而不是悄悄丢消息
                const unhandled: never = it
                return unhandled
              }
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
