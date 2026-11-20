import { useCallback, useLayoutEffect, useRef, type ReactNode } from "react"
import { ArrowDown, Loader2, MessageCircle } from "lucide-react"
import type { AppChatItem } from "../../../shared/app-chat-types"
import { useKeepScrollOnPrepend } from "../../hooks/useKeepScrollOnPrepend"
import { useStickToBottom } from "../../hooks/useStickToBottom"
import AssistantTurn from "./AssistantTurn"
import ChatSearch from "./ChatSearch"
import { FileCard, LocalImage, NoticePill, QuestionCard, UserBubble } from "./ItemViews"
import { scrollToItem } from "./item-jump"
import Markdown from "./Markdown"
import StickyUserMessage from "./StickyUserMessage"

interface Props {
  items: AppChatItem[]
  loading: boolean
  /** 已加载的最早一条之前还有更早的记录：列表顶部给「加载更早的消息」 */
  hasMore: boolean
  loadingEarlier: boolean
  onLoadEarlier: () => void
  /** AI 正在工作；最后一条是用户消息时补一个"正在处理"占位，覆盖流式卡出现前的空窗 */
  busy: boolean
  /** 会话的目录名；临时会话没有指定目录，为空 */
  workspaceName?: string
  /** 项目会话的项目名；有值时空白页讲项目，不讲目录 */
  projectName?: string
  onAnswer: (questionId: string, option: string) => void
  onCommand: (cmd: string) => void
  /** 搜索：open 时在顶部显示搜索条；点命中时，还没加载的旧记录由 onLoadUntil 先加载进来 */
  search?: {
    open: boolean
    focusTick: number
    sessionKey: string
    onClose: () => void
    onLoadUntil: (itemId: string) => Promise<boolean>
  }
}

function renderItem(it: AppChatItem, onAnswer: Props["onAnswer"], onCommand: Props["onCommand"]): ReactNode {
  switch (it.kind) {
    case "user": return <UserBubble item={it} />
    case "assistant": return <AssistantTurn item={it} />
    case "text": return <Markdown text={it.text} />
    case "question": return <QuestionCard item={it} onAnswer={onAnswer} />
    case "image": return <LocalImage path={it.path} className="max-h-72 max-w-sm self-start" />
    case "file": return <FileCard item={it} />
    case "notice": return <NoticePill item={it} onCommand={onCommand} />
    default: {
      // 新增消息类型漏渲染时在这里编译报错，而不是悄悄丢消息
      const unhandled: never = it
      return unhandled
    }
  }
}

function EmptyChat({ workspaceName, projectName }: { workspaceName?: string; projectName?: string }) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-2.5 pb-10 text-center">
      <div className="mb-1 flex h-12 w-12 items-center justify-center rounded-[14px] bg-raised text-fg-3"><MessageCircle size={24} /></div>
      {projectName ? (
        <>
          <p className="text-[17px] font-semibold text-fg">开始这个项目</p>
          <p className="max-w-[380px] text-[13px] leading-[1.75] text-fg-muted">
            这个项目的步骤和信息在输入框上方的项目栏里；也可以直接在下面说说你的想法。
          </p>
        </>
      ) : (
        <>
          <p className="text-[17px] font-semibold text-fg">开始一段新对话</p>
          <p className="max-w-[380px] text-[13px] leading-[1.75] text-fg-muted">
            {workspaceName
              ? `在「${workspaceName}」目录里运行，可以直接让 Agent 处理这个目录的内容。`
              : <>没有指定目录，会在临时目录里运行，适合日常问答。<br />要处理某个项目，用输入框下方的目录选择切过去。</>}
          </p>
        </>
      )}
    </div>
  )
}

export default function ChatItemList({ items, loading, hasMore, loadingEarlier, onLoadEarlier, busy, workspaceName, projectName, onAnswer, onCommand, search }: Props) {
  const scrollRef = useRef<HTMLDivElement>(null)
  const { sentinelRef, atBottom, stickRef, scrollToBottom } = useStickToBottom(scrollRef, [items])
  const waiting = busy && items.length > 0 && items[items.length - 1].kind === "user"

  // 往前加载一页是把记录插在顶部，要保住用户正在看的位置
  const keepScroll = useKeepScrollOnPrepend(scrollRef, items)
  const loadEarlier = () => {
    keepScroll()
    onLoadEarlier()
  }

  /** 搜索定位到一条旧记录、它还没加载时：加载进来之后，等它渲染出来再滚过去 */
  const pendingLocateRef = useRef<string | null>(null)
  /** 把记录滚到视野里并闪一下；它还没渲染出来（没加载）返回 false */
  const jumpTo = useCallback((id: string): boolean => {
    const scroll = scrollRef.current
    const el = scroll?.querySelector<HTMLElement>(`[data-item-id="${CSS.escape(id)}"]`)
    if (!scroll || !el) return false
    scrollToItem(scroll, el)
    return true
  }, [])
  // 声明在 useKeepScrollOnPrepend 之后：同一次提交里先保住原来的位置，再滚到目标
  useLayoutEffect(() => {
    const id = pendingLocateRef.current
    if (id && jumpTo(id)) pendingLocateRef.current = null
  }, [items, jumpTo])

  const locate = async (id: string): Promise<boolean> => {
    // 贴底跟随先松手，否则流式输出会把滚动拽回底部
    stickRef.current = false
    pendingLocateRef.current = null
    if (jumpTo(id)) return true
    if (!search) return false
    pendingLocateRef.current = id
    keepScroll()
    const loaded = await search.onLoadUntil(id)
    if (!loaded) pendingLocateRef.current = null
    return loaded
  }

  return (
    <div className="relative min-h-0 flex-1">
      <div ref={scrollRef} className="h-full overflow-y-auto px-6 py-4">
        <div className="mx-auto flex min-h-full max-w-3xl flex-col gap-4">
          {loading && items.length === 0 && <p className="text-center text-xs text-fg-faint">加载中…</p>}
          {!loading && items.length === 0 && <EmptyChat workspaceName={workspaceName} projectName={projectName} />}
          {hasMore && items.length > 0 && (
            <button
              type="button"
              onClick={loadEarlier}
              disabled={loadingEarlier}
              className="flex items-center gap-1.5 self-center rounded-full border border-line-subtle px-3 py-1 text-xs text-fg-muted transition hover:border-line hover:text-fg-2 disabled:opacity-60"
            >
              {loadingEarlier && <Loader2 size={12} className="animate-spin" />}
              {loadingEarlier ? "加载中…" : "加载更早的消息"}
            </button>
          )}
          {/* 每条记录套一个定位锚点（搜索定位靠它找）；flex-col 让里面的 self-end / max-w 百分比和直接放在列里时一致 */}
          {items.map((it) => (
            <div key={it.id} data-item-id={it.id} className="flex flex-col">{renderItem(it, onAnswer, onCommand)}</div>
          ))}
          {waiting && <div className="flex items-center gap-2 text-xs text-fg-muted"><Loader2 size={12} className="animate-spin" />Agent 正在处理…</div>}
          <div ref={sentinelRef} />
        </div>
      </div>
      <StickyUserMessage scrollRef={scrollRef} items={items} onBeforeJump={() => { stickRef.current = false }} suppressed={search?.open} />
      {search?.open && <ChatSearch sessionKey={search.sessionKey} focusTick={search.focusTick} onLocate={locate} onClose={search.onClose} />}
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
