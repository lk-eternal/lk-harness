import { memo, useState, type ReactNode } from "react"
import ReactMarkdown, { type Components, type Options } from "react-markdown"
import remarkGfm from "remark-gfm"
import rehypeHighlight from "rehype-highlight"
import { Check, Copy } from "lucide-react"
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

function CodeBlock({ children }: { children?: ReactNode }) {
  const code = Array.isArray(children) ? children[0] : children
  const className = typeof code === "object" && code && "props" in code ? String((code.props as { className?: string }).className ?? "") : ""
  const lang = /language-([\w+#-]+)/.exec(className)?.[1] ?? ""
  return (
    <div className="my-3 overflow-hidden rounded-lg border border-line-subtle bg-code">
      <div className="flex items-center justify-between bg-code-head px-3 py-1 text-xs text-fg-muted">
        <span>{lang || "text"}</span>
        <CopyButton text={textOf(children).replace(/\n$/, "")} />
      </div>
      <pre className="overflow-x-auto px-4 py-3 text-[13px] leading-6">{children}</pre>
    </div>
  )
}

/** 只放行 http(s)：Agent 输出不可信，file:/自定义协议链接一律不可点（外链由主进程交给系统浏览器） */
function SafeLink({ href, children }: { href?: string; children?: ReactNode }) {
  if (href && /^https?:\/\//i.test(href)) {
    return <a href={href} target="_blank" rel="noreferrer noopener">{children}</a>
  }
  return <span className="text-fg-3">{children}</span>
}

const components: Components = {
  pre: ({ children }) => <CodeBlock>{children}</CodeBlock>,
  a: ({ href, children }) => <SafeLink href={href}>{children}</SafeLink>,
  // 不加载 Agent 输出里的远程/本地图片（追踪与越权读取风险），保留 alt 文本
  img: ({ alt }) => <span className="text-fg-muted">[图片{alt ? `：${alt}` : ""}]</span>,
  table: ({ children }) => (
    <div className="my-3 overflow-x-auto"><table>{children}</table></div>
  ),
}

const remarkPlugins: NonNullable<Options["remarkPlugins"]> = [remarkGfm]
// detect:false 只高亮显式标注语言的代码块，不做昂贵且常猜错的自动识别
const rehypePlugins: NonNullable<Options["rehypePlugins"]> = [
  [rehypeHighlight, { detect: false, ignoreMissing: true }],
]

/** 不渲染原始 HTML（未启用 rehype-raw）；memo 避免历史回合在其他条目更新时重复解析 */
const Markdown = memo(function Markdown({ text }: { text: string }) {
  return (
    <div className="chat-md">
      <ReactMarkdown remarkPlugins={remarkPlugins} rehypePlugins={rehypePlugins} components={components}>
        {text}
      </ReactMarkdown>
    </div>
  )
})

export default Markdown
