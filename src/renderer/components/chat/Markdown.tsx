import { memo, useEffect, useState, type ReactNode } from "react"
import ReactMarkdown, { type Components, type Options } from "react-markdown"
import remarkGfm from "remark-gfm"
import rehypeHighlight from "rehype-highlight"
import { Check, Copy } from "lucide-react"
import { parsePathRef } from "../../../shared/preview-paths"
import { opensInApp } from "../preview/link-mode"
import { usePreview } from "../preview/PreviewContext"
import { rehypePathMentions } from "./path-mentions"
import { isShortCell } from "./table-cell"
import "./chat-markdown.css"

/** 取 React 子树的纯文本（高亮后代码被拆成 span，复制要还原原文） */
function textOf(node: ReactNode): string {
  if (node == null || typeof node === "boolean") return ""
  if (typeof node === "string" || typeof node === "number") return String(node)
  if (Array.isArray(node)) return node.map(textOf).join("")
  if (typeof node === "object" && "props" in node) return textOf((node.props as { children?: ReactNode }).children)
  return ""
}

export function CopyButton({ text, className = "" }: { text: string; className?: string }) {
  const [done, setDone] = useState(false)
  return (
    <button
      type="button"
      title="复制"
      onClick={() => {
        void navigator.clipboard.writeText(text).then(() => {
          setDone(true)
          window.setTimeout(() => setDone(false), 1500)
        })
      }}
      className={`flex items-center gap-1 text-fg-muted transition hover:text-fg-soft ${className}`}
    >
      {done ? <Check size={13} className="text-success" /> : <Copy size={13} />}
      {done && <span className="text-[11px] text-success">已复制</span>}
    </button>
  )
}

export function CodeBlock({ children }: { children?: ReactNode }) {
  const code = Array.isArray(children) ? children[0] : children
  const className = typeof code === "object" && code && "props" in code ? String((code.props as { className?: string }).className ?? "") : ""
  const lang = /language-([\w+#-]+)/.exec(className)?.[1] ?? ""
  return (
    <div className="my-3 overflow-hidden rounded-lg border border-line-subtle bg-code">
      {/* data-find-skip：语言标签和复制按钮不是正文，预览里 Ctrl+F 查找时不算（不然搜 text 会命中每个代码块的标签） */}
      <div data-find-skip className="flex items-center justify-between bg-code-head px-3 py-1 text-xs text-fg-muted">
        <span>{lang || "text"}</span>
        <CopyButton text={textOf(children).replace(/\n$/, "")} />
      </div>
      <pre className="overflow-x-auto px-4 py-3 text-[13px] leading-6">{children}</pre>
    </div>
  )
}

/**
 * 只放行 http(s)：Agent 输出不可信，file:/自定义协议链接一律不可点。
 * 在应用内的预览面板里打开，还是交给系统浏览器（由主进程处理 target=_blank），按预览设置决定，按住 Ctrl/⌘ 点则反过来。
 */
export function SafeLink({ href, children }: { href?: string; children?: ReactNode }) {
  const preview = usePreview()
  if (href && /^https?:\/\//i.test(href)) {
    return (
      <a
        href={href}
        target="_blank"
        rel="noreferrer noopener"
        onClick={(e) => {
          if (!opensInApp({ available: preview.available, mode: preview.linkMode, modifierHeld: e.ctrlKey || e.metaKey })) return
          e.preventDefault()
          preview.openUrl(href)
        }}
      >{children}</a>
    )
  }
  return <span className="text-fg-3">{children}</span>
}

/**
 * 对话文字里的文件路径：向主进程确认「存在且有权限预览」之后才变成可点的，点了在预览面板里打开（带行号就定位到那一行）。
 * 确认不了（没有预览面板、文件不存在、不在这个会话的范围内）就原样显示，不能让每个像路径的文字都像个按钮。
 */
function PathLink({ raw, line, children }: { raw: string; line?: number; children: ReactNode }) {
  const { available, resolvePath, openFile } = usePreview()
  const [resolved, setResolved] = useState<string | null>(null)
  useEffect(() => {
    setResolved(null)
    if (!available) return
    let cancelled = false
    void resolvePath(raw).then((p) => { if (!cancelled) setResolved(p) })
    return () => { cancelled = true }
  }, [available, resolvePath, raw])
  if (!resolved) return <>{children}</>
  const open = () => {
    // 正在拖选路径文字（想复制）时不要跳走
    if (window.getSelection()?.toString()) return
    openFile({ path: resolved, line })
  }
  return (
    <span
      role="link"
      tabIndex={0}
      className="lk-path"
      title={line ? `在预览面板打开（第 ${line} 行）：${resolved}` : `在预览面板打开：${resolved}`}
      onClick={open}
      onKeyDown={(e) => { if (e.key === "Enter") open() }}
    >{children}</span>
  )
}

/** 内容很短的单元格加上 lk-nowrap（规则和原因见 table-cell.ts），其余原样 */
function cellClass(className: string | undefined, children: ReactNode): string | undefined {
  if (!isShortCell(textOf(children))) return className
  return className ? `${className} lk-nowrap` : "lk-nowrap"
}

const components: Components = {
  pre: ({ children }) => <CodeBlock>{children}</CodeBlock>,
  a: ({ href, children }) => <SafeLink href={href}>{children}</SafeLink>,
  // 行内代码整体是个路径（`src/app.ts:42`）；代码块有换行或语言标注，不会进来
  code: ({ className, children }) => {
    const text = textOf(children)
    const ref = !className && !text.includes("\n") ? parsePathRef(text) : undefined
    const code = <code className={className}>{children}</code>
    return ref ? <PathLink raw={ref.path} line={ref.line}>{code}</PathLink> : code
  },
  // 普通文字里的路径：rehypePathMentions 包出来的 span
  span: ({ children, ...rest }) => {
    const raw = (rest as Record<string, unknown>)["data-lk-path"]
    if (typeof raw !== "string") return <span>{children}</span>
    const line = Number((rest as Record<string, unknown>)["data-lk-line"])
    return <PathLink raw={raw} line={Number.isInteger(line) && line > 0 ? line : undefined}>{children}</PathLink>
  },
  // 不加载 Agent 输出里的远程/本地图片（追踪与越权读取风险），保留 alt 文本
  img: ({ alt }) => <span className="text-fg-muted">[图片{alt ? `：${alt}` : ""}]</span>,
  table: ({ children }) => (
    <div className="my-3 overflow-x-auto"><table>{children}</table></div>
  ),
  // node 是 react-markdown 传进来的语法树节点，不能落到 DOM 上
  th: ({ node, className, children, ...rest }) => {
    void node
    return <th {...rest} className={cellClass(className, children)}>{children}</th>
  },
  td: ({ node, className, children, ...rest }) => {
    void node
    return <td {...rest} className={cellClass(className, children)}>{children}</td>
  },
}

export const remarkPlugins: NonNullable<Options["remarkPlugins"]> = [remarkGfm]
// detect:false 只高亮显式标注语言的代码块，不做昂贵且常猜错的自动识别
export const rehypePlugins: NonNullable<Options["rehypePlugins"]> = [
  [rehypeHighlight, { detect: false, ignoreMissing: true }],
]
// 只有对话里的文字要把路径变成可点的；预览面板里看 .md 文件用上面不带它的那组
const chatRehypePlugins: NonNullable<Options["rehypePlugins"]> = [rehypePathMentions, ...rehypePlugins]

/** 不渲染原始 HTML（未启用 rehype-raw）；memo 避免历史回合在其他条目更新时重复解析 */
const Markdown = memo(function Markdown({ text }: { text: string }) {
  return (
    <div className="chat-md">
      <ReactMarkdown remarkPlugins={remarkPlugins} rehypePlugins={chatRehypePlugins} components={components}>
        {text}
      </ReactMarkdown>
    </div>
  )
})

export default Markdown
