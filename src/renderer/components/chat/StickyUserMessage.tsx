import { useCallback, useLayoutEffect, useRef, useState, type RefObject } from "react"
import { ArrowUp } from "lucide-react"
import type { AppChatItem, AppChatUserItem } from "../../../shared/app-chat-types"
import { DOCK_HEIGHT, prefersReducedMotion, scrollToItem } from "./item-jump"

/** 浮条里最多放多少字：一行本来就放不下，整段粘贴的日志不必整段塞进 DOM */
const PREVIEW_MAX_CHARS = 200
const SWAP_MS = 200

/**
 * 在自上而下排列的一组元素里，找最后一个底边落在 limit 及以上的下标；没有返回 -1。
 * 底边随下标单调递增，所以二分：每次滚动只读 log₂n 个元素的位置。
 */
export function lastIndexAbove(count: number, bottomAt: (index: number) => number, limit: number): number {
  let lo = 0
  let hi = count - 1
  let found = -1
  while (lo <= hi) {
    const mid = Math.floor((lo + hi) / 2)
    if (bottomAt(mid) <= limit) {
      found = mid
      lo = mid + 1
    } else {
      hi = mid - 1
    }
  }
  return found
}

/** 浮条里的一行预览：折成单行；纯图片消息显示「[图片]」 */
export function userMessagePreview(item: Pick<AppChatUserItem, "text">): string {
  const line = item.text.trim().replace(/\s+/g, " ").slice(0, PREVIEW_MAX_CHARS)
  return line || "[图片]"
}

/** 浮条对齐列表里气泡所在的那一列：gutter 是竖向滚动条占的宽度，left / right 是那一列离滚动区内容区两侧的距离 */
export interface ChipLayout {
  gutter: number
  left: number
  right: number
}

/** 从实际布局量出 ChipLayout，不依赖列表自己的留白和最大宽度；手机和桌面的列表样式不同，都对得上 */
export function alignToColumn(
  scrollBox: { left: number; right: number },
  scroll: { offsetWidth: number; clientWidth: number },
  columnBox: { left: number; right: number },
): ChipLayout {
  const gutter = scroll.offsetWidth - scroll.clientWidth
  return { gutter, left: columnBox.left - scrollBox.left, right: scrollBox.right - gutter - columnBox.right }
}

interface Props {
  /** 对话列表的滚动容器；里面的用户消息带 data-user-item 标记 */
  scrollRef: RefObject<HTMLElement | null>
  items: AppChatItem[]
  /** 点浮条、列表要离开底部之前：让「贴底跟随」先松手，否则流式输出会把平滑滚动拽回去 */
  onBeforeJump: () => void
  /** 顶部这块地方被别的东西占了（搜索条）：浮条先让出来，不画 */
  suppressed?: boolean
}

interface Shown {
  id: string
  text: string
  /** 隐藏时保留最后一条的文字，淡出过程中不会先变空 */
  visible: boolean
}

/**
 * 对话顶部浮出「你现在看的这段内容，是在回答哪条提问」：屏幕上沿之上、离得最近的那条我发的消息。
 * 往上翻时一条接一条地换，翻到最开头（上方没有我发的消息了）就淡出。
 * 状态放在这个组件里而不是列表里：换条不应该让整个对话列表重渲染。
 */
export default function StickyUserMessage({ scrollRef, items, onBeforeJump, suppressed }: Props) {
  const [shown, setShown] = useState<Shown | null>(null)
  const [layout, setLayout] = useState<ChipLayout>({ gutter: 0, left: 0, right: 0 })
  const chipRef = useRef<HTMLButtonElement>(null)
  /** 容器里所有用户消息，按文档顺序，也就是时间顺序 */
  const bubblesRef = useRef<HTMLElement[]>([])
  const itemsRef = useRef(items)
  /** 浮条当前对应的那条消息；浮条隐藏时为 null */
  const shownElRef = useRef<HTMLElement | null>(null)
  /** 刚换了一条：-1 换成更早的，1 换成更晚的，0 不是换条（首次出现 / 没变） */
  const swapRef = useRef<-1 | 0 | 1>(0)

  // 每次都按当前布局找，不记「上次在上方还是下方」：一帧内从底部跳到顶部（拖滚动条、Home / End）也不会过期
  const sync = useCallback(() => {
    const scroll = scrollRef.current
    if (!scroll) return
    const box = scroll.getBoundingClientRect()
    const column = scroll.firstElementChild
    if (column) {
      const next = alignToColumn(box, scroll, column.getBoundingClientRect())
      setLayout((prev) => (prev.gutter === next.gutter && prev.left === next.left && prev.right === next.right ? prev : next))
    }
    const bubbles = bubblesRef.current
    const limit = box.top + DOCK_HEIGHT
    const index = lastIndexAbove(bubbles.length, (i) => bubbles[i].getBoundingClientRect().bottom, limit)
    if (index < 0) {
      shownElRef.current = null
      setShown((s) => (s?.visible ? { ...s, visible: false } : s))
      return
    }
    const el = bubbles[index]
    const prev = shownElRef.current
    if (el === prev) return
    const item = itemsRef.current.find((it): it is AppChatUserItem => it.kind === "user" && it.id === el.dataset.userItem)
    if (!item) return
    shownElRef.current = el
    swapRef.current = prev?.isConnected ? (el.compareDocumentPosition(prev) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1) : 0
    setShown({ id: item.id, text: userMessagePreview(item), visible: true })
  }, [scrollRef])

  useLayoutEffect(() => {
    itemsRef.current = items
    bubblesRef.current = Array.from(scrollRef.current?.querySelectorAll<HTMLElement>("[data-user-item]") ?? [])
    sync()
  }, [items, scrollRef, sync])

  useLayoutEffect(() => {
    const scroll = scrollRef.current
    if (!scroll) return
    scroll.addEventListener("scroll", sync, { passive: true })
    // 内容尺寸变了（流式输出、图片加载完、窗口缩放导致换行），上方消息的位置可能跟着变，但不一定有 scroll 事件。
    // 滚动容器也要看：列宽封顶居中时，窗口变宽只挪列的位置、列本身尺寸不变，浮条要跟着重新对齐
    const observer = new ResizeObserver(sync)
    observer.observe(scroll)
    if (scroll.firstElementChild) observer.observe(scroll.firstElementChild)
    return () => {
      scroll.removeEventListener("scroll", sync)
      observer.disconnect()
    }
  }, [scrollRef, sync])

  // 换条时小条按翻动方向滑入；从隐藏变显示由整条浮条自己淡入，这里不动
  useLayoutEffect(() => {
    const direction = swapRef.current
    swapRef.current = 0
    if (direction === 0 || prefersReducedMotion()) return
    chipRef.current?.animate(
      [{ opacity: 0, transform: `translateY(${direction * 8}px)` }, { opacity: 1, transform: "none" }],
      { duration: SWAP_MS, easing: "ease-out" },
    )
  }, [shown?.id])

  const jump = () => {
    const scroll = scrollRef.current
    const el = shownElRef.current
    if (!scroll || !el) return
    onBeforeJump()
    scrollToItem(scroll, el)
  }

  const visible = shown?.visible === true && !suppressed

  // 气泡那一行用页面底色垫着，下沿 22px 渐变到透明：滚上去的内容是被淡出的，不是被一块实色边挡住。
  // 整块不拦截鼠标，只有气泡本身可点；右边让开竖向滚动条，左右留白对齐气泡所在的那一列（都是量出来的，见 alignToColumn）。
  return (
    <div
      aria-hidden={!visible}
      style={{
        background: "linear-gradient(to bottom, var(--color-page) 0, var(--color-page) calc(100% - 22px), transparent 100%)",
        right: layout.gutter,
        paddingLeft: layout.left,
        paddingRight: layout.right,
      }}
      className={`pointer-events-none absolute left-0 top-0 pb-7 pt-2.5 transition-[opacity,transform,visibility] duration-200 ease-out motion-reduce:transition-none ${visible ? "" : "invisible -translate-y-1.5 opacity-0"}`}
    >
      <div className="flex justify-end">
        <button
          ref={chipRef}
          type="button"
          tabIndex={visible ? 0 : -1}
          onClick={jump}
          title="回到这条消息"
          className="pointer-events-auto inline-flex max-w-[85%] cursor-pointer items-center gap-1.5 rounded-[14px] rounded-tr-[3px] bg-raised px-3 py-1.5 text-left text-[13px] leading-snug text-fg transition hover:brightness-110 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
        >
          <ArrowUp size={12} className="shrink-0 opacity-85" />
          <span className="min-w-0 truncate">{shown?.text}</span>
        </button>
      </div>
    </div>
  )
}
