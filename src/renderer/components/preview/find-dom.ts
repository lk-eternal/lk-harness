// ── 预览里的文档内查找（Ctrl+F）：DOM 这一层 ───────────────────────────────────────
//
// 逻辑（拼接、匹配、偏移换算）在 shared/preview-find.ts；这里只管：从查看器里取出所有文字节点、
// 把命中变成 Range、用 CSS Custom Highlight API 画高亮、滚到命中的地方。
// 高亮不往 DOM 里插任何东西：不会打断 React 的渲染，也不影响复制和代码折叠。

import { findAll, joinPieces, locateMatch, type FindPiece } from "../../../shared/preview-find"

const HIGHLIGHT_ALL = "preview-find"
const HIGHLIGHT_ACTIVE = "preview-find-active"

/** 当前环境能不能画高亮（Electron 和较新的手机 WebView 都行）；不能就整个功能不启用，不留半截界面 */
export function findSupported(): boolean {
  return typeof CSS !== "undefined" && "highlights" in CSS && typeof Highlight !== "undefined"
}

/** 这些元素之间是「换块」：命中不能横跨它们 */
const BLOCK_TAGS = new Set([
  "address", "article", "aside", "blockquote", "dd", "details", "div", "dl", "dt", "fieldset", "figcaption", "figure",
  "footer", "form", "h1", "h2", "h3", "h4", "h5", "h6", "header", "hr", "li", "main", "nav", "ol", "p", "pre",
  "section", "summary", "table", "tbody", "td", "tfoot", "th", "thead", "tr", "ul",
])
/** 里面的文字不算文档内容：脚本样式、控件（按钮上的字、折叠后的「⋯ N 行」）、图标 */
const SKIP_TAGS = new Set(["script", "style", "noscript", "template", "svg", "button", "input", "textarea", "select"])
/** 代码视图每一行是个 display:block 的 span，带 data-ln（行号） */
const LINE_ATTR = "data-ln"
/** 带这个属性的元素整棵不参与查找（比如 Markdown 代码块头上的语言标签） */
const SKIP_ATTR = "data-find-skip"

function isBlock(el: Element): boolean {
  return BLOCK_TAGS.has(el.localName) || el.hasAttribute(LINE_ATTR)
}

/** 文字节点所在的最近的块；一路找到 root 都没有就是 root 自己 */
function blockOf(node: Node, root: Element): Element {
  for (let el = node.parentElement; el && el !== root; el = el.parentElement) {
    if (isBlock(el)) return el
  }
  return root
}

/** 取出 root 里所有可查找的文字节点，按文档顺序，和拼接文本的段一一对应 */
export function collectText(root: HTMLElement): { nodes: Text[]; pieces: FindPiece[] } {
  const nodes: Text[] = []
  const pieces: FindPiece[] = []
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
    acceptNode(n) {
      if (n.nodeType === Node.TEXT_NODE) return NodeFilter.FILTER_ACCEPT
      const el = n as Element
      if (SKIP_TAGS.has(el.localName) || el.hasAttribute(SKIP_ATTR)) return NodeFilter.FILTER_REJECT
      // <br> 本身没有文字，但它前后是两行：交给下面的循环记一次换块
      return el.localName === "br" ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP
    },
  })
  let pendingBreak = false
  let prevBlock: Element | undefined
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    if (n.nodeType === Node.ELEMENT_NODE) {
      pendingBreak = true
      continue
    }
    const text = n as Text
    if (text.data === "") continue
    const block = blockOf(text, root)
    // 只有含换行 / 制表符的文字才需要分「在不在 <pre> 里」：别处的换行在界面上是个空格
    const pre = /[\r\n\t]/.test(text.data) && text.parentElement?.closest("pre") != null
    pieces.push({ text: text.data, breakBefore: pendingBreak || block !== prevBlock, pre })
    nodes.push(text)
    prevBlock = block
    pendingBreak = false
  }
  return { nodes, pieces }
}

export interface FindResult {
  ranges: Range[]
  /** 命中太多，只标了前面一部分 */
  capped: boolean
}

/** 在 root 里找 query：每处命中一个 Range（可以横跨好几个文字节点，比如 `foo**bar**` 里的 foobar） */
export function findRanges(root: HTMLElement, query: string): FindResult {
  const { nodes, pieces } = collectText(root)
  const joined = joinPieces(pieces)
  const { matches, capped } = findAll(joined.text, query)
  const ranges: Range[] = []
  for (const match of matches) {
    const at = locateMatch(joined.segments, match)
    if (!at) continue
    const range = document.createRange()
    range.setStart(nodes[at.start.piece], at.start.offset)
    range.setEnd(nodes[at.end.piece], at.end.offset)
    ranges.push(range)
  }
  return { ranges, capped }
}

/** 画出所有命中（浅色底） */
export function paintAll(ranges: readonly Range[]): void {
  if (!findSupported()) return
  if (ranges.length === 0) {
    CSS.highlights.delete(HIGHLIGHT_ALL)
    return
  }
  CSS.highlights.set(HIGHLIGHT_ALL, new Highlight(...ranges))
}

/** 画出当前这一处（深色底，盖在浅色底上面）；没有就清掉 */
export function paintActive(range: Range | undefined): void {
  if (!findSupported()) return
  if (!range) {
    CSS.highlights.delete(HIGHLIGHT_ACTIVE)
    return
  }
  const highlight = new Highlight(range)
  highlight.priority = 1
  CSS.highlights.set(HIGHLIGHT_ACTIVE, highlight)
}

export function clearHighlights(): void {
  if (!findSupported()) return
  CSS.highlights.delete(HIGHLIGHT_ALL)
  CSS.highlights.delete(HIGHLIGHT_ACTIVE)
}

/**
 * 把命中滚进 container 的可视区：已经看得见就不动（连续按回车时画面不乱晃），看不见就滚到中间。
 * 上下各留一段边距，顶上那条是查找条的位置；横向只在真的有横向滚动条时才动（不换行的长行、宽表格）。
 */
export function revealRange(container: HTMLElement, range: Range): void {
  const rect = range.getBoundingClientRect()
  if (rect.width === 0 && rect.height === 0) return
  const box = container.getBoundingClientRect()
  if (rect.top < box.top + 48 || rect.bottom > box.bottom - 24) {
    container.scrollTop += (rect.top + rect.bottom) / 2 - (box.top + box.bottom) / 2
  }
  // 左边留得多一些：表格的行号列是粘在左边的，不能让命中被它盖住
  if (container.scrollWidth > container.clientWidth && (rect.left < box.left + 72 || rect.right > box.right - 24)) {
    container.scrollLeft += (rect.left + rect.right) / 2 - (box.left + box.right) / 2
  }
}

/** 选中的文字是否在 root 里；在的话返回它（给查找条当初始关键词） */
export function selectedTextIn(root: HTMLElement): string {
  const selection = window.getSelection()
  if (!selection || selection.rangeCount === 0 || selection.isCollapsed) return ""
  return root.contains(selection.getRangeAt(0).commonAncestorContainer) ? selection.toString() : ""
}
