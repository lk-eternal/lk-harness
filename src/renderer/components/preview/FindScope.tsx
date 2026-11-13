import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode, type RefObject } from "react"
import { ChevronDown, ChevronUp, X } from "lucide-react"
import { formatFindCount, seedFromSelection, stepMatch } from "../../../shared/preview-find"
import { clearHighlights, findRanges, findSupported, paintActive, paintAll, revealRange, selectedTextIn, type FindResult } from "./find-dom"
import { BarButton } from "./preview-ui"

const NO_RESULT: FindResult = { ranges: [], capped: false }
/** 内容变了（折叠展开、切换视图、懒加载出更多行）之后，隔多久重新找一遍：连续变化只找一次 */
const RESCAN_DELAY_MS = 150

/** 查找条：关键词输入框、第几处 / 共几处、上一个 / 下一个、关闭。只管显示，状态在 FindScope */
export function FindBar({ inputRef, query, onQuery, active, total, capped, onStep, onClose }: {
  inputRef: RefObject<HTMLInputElement | null>
  query: string
  onQuery: (query: string) => void
  active: number
  total: number
  capped: boolean
  onStep: (direction: 1 | -1) => void
  onClose: () => void
}) {
  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    // 中文输入法选字时的回车是「确认拼音」，不是「找下一个」
    if (e.nativeEvent.isComposing || e.keyCode === 229) return
    if (e.key === "Enter") {
      e.preventDefault()
      onStep(e.shiftKey ? -1 : 1)
    }
  }
  const none = query !== "" && total === 0
  return (
    <div role="search" className="absolute right-4 top-2 z-10 flex items-center gap-1 rounded-lg border border-line bg-page/95 py-1 pl-1.5 pr-1 shadow-lg">
      <input
        ref={inputRef}
        value={query}
        onChange={(e) => onQuery(e.target.value)}
        onKeyDown={onKeyDown}
        spellCheck={false}
        aria-label="在文档中查找"
        placeholder="在文档中查找"
        className={`h-6 w-44 rounded border bg-surface px-2 text-xs text-fg-soft outline-none placeholder:text-fg-faint focus:border-blue-500 ${none ? "border-danger-line" : "border-line-subtle"}`}
      />
      <span aria-live="polite" className={`min-w-[3.75rem] text-center text-[11px] tabular-nums ${none ? "text-danger" : "text-fg-muted"}`}>
        {query === "" ? "" : formatFindCount(active, total, capped)}
      </span>
      <BarButton title="上一个（Shift+Enter）" disabled={total === 0} onClick={() => onStep(-1)}><ChevronUp size={15} /></BarButton>
      <BarButton title="下一个（Enter）" disabled={total === 0} onClick={() => onStep(1)}><ChevronDown size={15} /></BarButton>
      <BarButton title="关闭（Esc）" onClick={onClose}><X size={14} /></BarButton>
    </div>
  )
}

/**
 * 查看器里「可滚动的内容区」：套上它，内容就支持 Ctrl+F（Mac 是 ⌘F）查找并在命中之间跳转。
 * 光标在这个查看器上，或焦点在它里面时按 Ctrl+F 才响应，不会抢走对话输入框等别处的快捷键。
 * 找的是界面上已经显示出来的文字（文字节点）：折叠起来的行、没渲染出来的内容不在其中。
 * 沙箱 iframe 里的内容（HTML 预览、Word）读不到，用不了这个；网页版本的 PDF 有自己的查找。
 * onOpen：查找条打开时调用，查看器借此把折叠的内容先展开，免得折叠里的命中找不到。
 */
export default function FindScope({ children, onOpen }: { children: ReactNode; onOpen?: () => void }) {
  const [supported] = useState(findSupported)
  const outerRef = useRef<HTMLDivElement>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState("")
  const [found, setFound] = useState<FindResult>(NO_RESULT)
  const [active, setActive] = useState(0)
  /** 加一就重新找一遍（内容变了） */
  const [rescan, setRescan] = useState(0)
  /** 再按一次 Ctrl+F：已经开着就只是重新聚焦、全选 */
  const [focusTick, setFocusTick] = useState(0)
  /** 关键词变了：下次画好之后把第一处滚进视野（内容变了引起的重找不滚，不然正在看的地方会被拽走） */
  const jumpRef = useRef(false)
  const lastQueryRef = useRef("")
  const onOpenRef = useRef(onOpen)
  useEffect(() => { onOpenRef.current = onOpen })

  // Ctrl+F / ⌘F
  useEffect(() => {
    if (!supported) return
    const onKeyDown = (e: globalThis.KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || e.altKey || e.shiftKey) return
      // 输入法开着时 key 可能是 "Process"，这时看物理键位
      const isF = e.key.toLowerCase() === "f" || ((e.key === "Process" || e.key === "Unidentified") && e.code === "KeyF")
      if (!isF) return
      // 查看器 = 滚动区的上一层（工具栏和内容区的共同外框）
      const viewer = outerRef.current?.parentElement
      if (!viewer) return
      const inside = e.target instanceof Node && viewer.contains(e.target)
      if (!inside && !viewer.matches(":hover")) return
      e.preventDefault()
      const seed = scrollRef.current ? seedFromSelection(selectedTextIn(scrollRef.current)) : undefined
      if (seed) setQuery(seed)
      setOpen(true)
      setFocusTick((n) => n + 1)
    }
    window.addEventListener("keydown", onKeyDown, true)
    return () => window.removeEventListener("keydown", onKeyDown, true)
  }, [supported])

  // 打开 / 再按 Ctrl+F：输入框聚焦并全选，直接输入就是换关键词
  useEffect(() => {
    if (!open) return
    inputRef.current?.focus()
    inputRef.current?.select()
  }, [open, focusTick])

  useEffect(() => {
    if (open) onOpenRef.current?.()
  }, [open])

  // 找：关键词变了、打开 / 关闭、内容变了都重新找一遍
  useEffect(() => {
    const root = scrollRef.current
    const queryChanged = lastQueryRef.current !== query
    lastQueryRef.current = query
    if (!open || !root || query === "") {
      setFound(NO_RESULT)
      return
    }
    const result = findRanges(root, query)
    setFound(result)
    setActive((a) => (queryChanged ? 0 : Math.min(a, Math.max(result.ranges.length - 1, 0))))
    if (queryChanged) jumpRef.current = true
  }, [open, query, rescan])

  // 查找条开着时盯着内容：折叠展开、切换视图、「再显示 N 行」之后高亮要跟着更新
  useEffect(() => {
    const root = scrollRef.current
    if (!open || query === "" || !root) return
    let timer: number | undefined
    const observer = new MutationObserver(() => {
      window.clearTimeout(timer)
      timer = window.setTimeout(() => setRescan((n) => n + 1), RESCAN_DELAY_MS)
    })
    observer.observe(root, { childList: true, subtree: true, characterData: true })
    return () => {
      observer.disconnect()
      window.clearTimeout(timer)
    }
  }, [open, query])

  // 画高亮：所有命中浅色底，当前这一处深色底
  useEffect(() => { paintAll(found.ranges) }, [found])
  useEffect(() => {
    const range = found.ranges[active]
    paintActive(range)
    if (jumpRef.current) {
      jumpRef.current = false
      if (range && scrollRef.current) revealRange(scrollRef.current, range)
    }
  }, [found, active])
  useEffect(() => clearHighlights, [])

  const total = found.ranges.length
  const step = (direction: 1 | -1) => {
    if (total === 0) return
    const next = stepMatch(active, total, direction)
    setActive(next)
    // 只有一处命中时 next 和 active 相同，状态不变、不会走上面的 effect，所以这里直接滚
    const range = found.ranges[next]
    if (range && scrollRef.current) revealRange(scrollRef.current, range)
  }
  const close = () => {
    setOpen(false)
    // 焦点还给内容区：之后在它上面按 Ctrl+F 仍然有效，方向键、翻页键也继续管用
    scrollRef.current?.focus({ preventScroll: true })
  }

  return (
    <div
      ref={outerRef}
      className="relative flex min-h-0 flex-1 flex-col"
      onKeyDown={(e) => {
        if (e.key === "Escape" && open) {
          e.preventDefault()
          e.stopPropagation()
          close()
        }
      }}
    >
      {open && (
        <FindBar inputRef={inputRef} query={query} onQuery={setQuery} active={active} total={total} capped={found.capped} onStep={step} onClose={close} />
      )}
      <div ref={scrollRef} tabIndex={-1} className="min-h-0 flex-1 overflow-auto outline-none">{children}</div>
    </div>
  )
}
