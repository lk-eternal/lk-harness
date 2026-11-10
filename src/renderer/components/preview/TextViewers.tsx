import { useEffect, useMemo, useState } from "react"
import ReactMarkdown, { type Components } from "react-markdown"
import { Loader2 } from "lucide-react"
import { fileExt } from "../../../shared/preview-kinds"
import { detectDelimiter, formatBytes, parseCsv } from "../../../shared/preview-text"
import { PREVIEW_MAX_TEXT_BYTES, type PreviewFileInfo, type PreviewTextResult } from "../../../shared/preview-types"
import { CodeBlock, SafeLink, remarkPlugins, rehypePlugins } from "../chat/Markdown"
import { toCodeLines } from "./code-highlight"
import { CenterMessage, Segmented, ViewerBar, ViewerNotice } from "./preview-ui"

type TextState =
  | { status: "loading" }
  | { status: "error"; error: string }
  | Extract<PreviewTextResult, { ok: true }> & { status: "ready" }

/** 经主进程读文本内容；enabled 为假时不读（比如 HTML 只在看源码时才需要文本） */
function useFileText(token: string, enabled: boolean): TextState {
  const [state, setState] = useState<TextState>({ status: "loading" })
  useEffect(() => {
    if (!enabled) return
    let cancelled = false
    setState({ status: "loading" })
    window.electronAPI.previewFileText(token).then((r) => {
      if (cancelled) return
      setState(r.ok ? { ...r, status: "ready" } : { status: "error", error: r.error })
    }).catch((e: unknown) => {
      if (!cancelled) setState({ status: "error", error: e instanceof Error ? e.message : String(e) })
    })
    return () => { cancelled = true }
  }, [token, enabled])
  return state
}

function TextStatus({ state }: { state: TextState }) {
  if (state.status === "loading") {
    return <CenterMessage><Loader2 size={18} className="animate-spin" /></CenterMessage>
  }
  if (state.status === "error") return <CenterMessage>{state.error}</CenterMessage>
  return null
}

function TruncatedNotice({ state }: { state: Extract<TextState, { status: "ready" }> }) {
  if (!state.truncated) return null
  return <ViewerNotice>文件有 {formatBytes(state.size)}，只显示了开头的 {formatBytes(PREVIEW_MAX_TEXT_BYTES)}。要看全部请在所在位置用其他程序打开。</ViewerNotice>
}

/** 带行号的文本；认识的语言做语法高亮 */
function CodeText({ text, lang, wrap }: { text: string; lang?: string; wrap: boolean }) {
  const code = useMemo(() => toCodeLines(text, lang), [text, lang])
  return (
    <>
      {code.cutOff && <ViewerNotice>内容太长，只显示前 {code.lines.length.toLocaleString()} 行。</ViewerNotice>}
      <pre className={`preview-code hljs ${wrap ? "wrap" : ""}`}>
        <code>
          {code.lines.map((html, i) => <span key={i} className="pl" dangerouslySetInnerHTML={{ __html: html }} />)}
        </code>
      </pre>
    </>
  )
}

function WrapToggle({ wrap, onChange }: { wrap: boolean; onChange: (wrap: boolean) => void }) {
  return (
    <label className="flex cursor-pointer items-center gap-1.5 select-none">
      <input type="checkbox" checked={wrap} onChange={(e) => onChange(e.target.checked)} className="accent-blue-500" />自动换行
    </label>
  )
}

function sourceSummary(state: Extract<TextState, { status: "ready" }>, lang?: string): string {
  return [lang, state.encoding.toUpperCase(), formatBytes(state.size)].filter(Boolean).join(" · ")
}

/** 纯文本、代码、日志、配置 */
export function CodeView({ info }: { info: PreviewFileInfo }) {
  const state = useFileText(info.token, true)
  const [wrap, setWrap] = useState(info.kind === "text")
  if (state.status !== "ready") return <TextStatus state={state} />
  return (
    <div className="flex h-full flex-col">
      <ViewerBar>
        <WrapToggle wrap={wrap} onChange={setWrap} />
        <span className="ml-auto">{sourceSummary(state, info.lang)}</span>
      </ViewerBar>
      <TruncatedNotice state={state} />
      <div className="min-h-0 flex-1 overflow-auto"><CodeText text={state.text} lang={info.lang} wrap={wrap} /></div>
    </div>
  )
}

/** 只放行相对路径的本地图片：解到令牌覆盖的目录里；网络图片和绝对路径不加载（追踪、越权读取风险） */
export function resolveMarkdownImage(src: string | undefined, baseUrl: string): string | undefined {
  if (!src || /^[a-z][a-z0-9+.-]*:/i.test(src) || src.startsWith("/") || src.startsWith("\\") || src.startsWith("#")) return undefined
  try {
    return new URL(src, baseUrl).href
  } catch {
    return undefined
  }
}

function MarkdownRender({ text, baseUrl }: { text: string; baseUrl: string }) {
  const components = useMemo<Components>(() => ({
    pre: ({ children }) => <CodeBlock>{children}</CodeBlock>,
    a: ({ href, children }) => <SafeLink href={href}>{children}</SafeLink>,
    img: ({ src, alt }) => {
      const resolved = resolveMarkdownImage(typeof src === "string" ? src : undefined, baseUrl)
      return resolved
        ? <img src={resolved} alt={alt ?? ""} className="max-w-full" />
        : <span className="text-fg-muted">[图片{alt ? `：${alt}` : ""}]</span>
    },
    table: ({ children }) => <div className="my-3 overflow-x-auto"><table>{children}</table></div>,
  }), [baseUrl])
  return (
    <div className="chat-md mx-auto max-w-3xl px-6 py-5">
      <ReactMarkdown remarkPlugins={remarkPlugins} rehypePlugins={rehypePlugins} components={components}>{text}</ReactMarkdown>
    </div>
  )
}

export function MarkdownView({ info }: { info: PreviewFileInfo }) {
  const state = useFileText(info.token, true)
  const [mode, setMode] = useState<"render" | "source">("render")
  const [wrap, setWrap] = useState(true)
  if (state.status !== "ready") return <TextStatus state={state} />
  return (
    <div className="flex h-full flex-col">
      <ViewerBar>
        <Segmented value={mode} onChange={setMode} options={[{ value: "render", label: "预览" }, { value: "source", label: "源码" }]} />
        {mode === "source" && <WrapToggle wrap={wrap} onChange={setWrap} />}
        <span className="ml-auto">{sourceSummary(state)}</span>
      </ViewerBar>
      <TruncatedNotice state={state} />
      <div className="min-h-0 flex-1 overflow-auto">
        {mode === "render" ? <MarkdownRender text={state.text} baseUrl={info.url} /> : <CodeText text={state.text} wrap={wrap} />}
      </div>
    </div>
  )
}

/**
 * HTML 在沙箱 iframe 里渲染：默认不运行脚本，也没有 allow-same-origin，页面碰不到应用本身。
 * 「运行脚本」是用户明确打开的开关（很多报告页靠脚本画图表），打开后仍然是隔离的。
 */
export function HtmlView({ info }: { info: PreviewFileInfo }) {
  const [mode, setMode] = useState<"render" | "source">("render")
  const [scripts, setScripts] = useState(false)
  const [wrap, setWrap] = useState(false)
  const state = useFileText(info.token, mode === "source")
  return (
    <div className="flex h-full flex-col">
      <ViewerBar>
        <Segmented value={mode} onChange={setMode} options={[{ value: "render", label: "预览" }, { value: "source", label: "源码" }]} />
        {mode === "render" ? (
          <label className="flex cursor-pointer items-center gap-1.5 select-none" title="页面里的脚本默认不运行；打开后仍在隔离环境里，访问不到本应用">
            <input type="checkbox" checked={scripts} onChange={(e) => setScripts(e.target.checked)} className="accent-blue-500" />运行脚本
          </label>
        ) : (
          <WrapToggle wrap={wrap} onChange={setWrap} />
        )}
        <span className="ml-auto">{formatBytes(info.size)}</span>
      </ViewerBar>
      {mode === "render" ? (
        <iframe
          key={String(scripts)}
          title={info.name}
          src={info.url}
          sandbox={scripts ? "allow-scripts" : ""}
          className="min-h-0 flex-1 border-0 bg-white"
        />
      ) : state.status === "ready" ? (
        <>
          <TruncatedNotice state={state} />
          <div className="min-h-0 flex-1 overflow-auto"><CodeText text={state.text} lang="xml" wrap={wrap} /></div>
        </>
      ) : <TextStatus state={state} />}
    </div>
  )
}

/** 表格最多显示的行数 */
const MAX_CSV_ROWS = 5000

export function CsvView({ info }: { info: PreviewFileInfo }) {
  const state = useFileText(info.token, true)
  const [mode, setMode] = useState<"table" | "text">("table")
  const [wrap, setWrap] = useState(false)
  const table = useMemo(() => {
    if (state.status !== "ready") return undefined
    const parsed = parseCsv(state.text, detectDelimiter(state.text, fileExt(info.name)), MAX_CSV_ROWS + 1)
    const rows = parsed.rows.slice(0, MAX_CSV_ROWS)
    return { rows, cut: parsed.truncated || parsed.rows.length > MAX_CSV_ROWS, columns: rows.reduce((m, r) => Math.max(m, r.length), 0) }
  }, [state, info.name])
  if (state.status !== "ready" || !table) return <TextStatus state={state} />
  const [header, ...body] = table.rows
  return (
    <div className="flex h-full flex-col">
      <ViewerBar>
        <Segmented value={mode} onChange={setMode} options={[{ value: "table", label: "表格" }, { value: "text", label: "文本" }]} />
        {mode === "text" && <WrapToggle wrap={wrap} onChange={setWrap} />}
        <span className="ml-auto">{table.rows.length.toLocaleString()} 行 · {table.columns} 列 · {state.encoding.toUpperCase()}</span>
      </ViewerBar>
      <TruncatedNotice state={state} />
      {table.cut && <ViewerNotice>数据较多，表格只显示前 {MAX_CSV_ROWS.toLocaleString()} 行。</ViewerNotice>}
      <div className="min-h-0 flex-1 overflow-auto">
        {mode === "text" ? <CodeText text={state.text} wrap={wrap} /> : (
          <table className="border-collapse text-xs">
            {header && (
              <thead className="sticky top-0 z-[1]">
                <tr>
                  <th className="border border-line bg-raised px-2 py-1 text-right font-normal text-fg-faint">#</th>
                  {Array.from({ length: table.columns }, (_, c) => (
                    <th key={c} className="max-w-[320px] truncate border border-line bg-raised px-2.5 py-1 text-left font-semibold text-fg" title={header[c]}>{header[c] ?? ""}</th>
                  ))}
                </tr>
              </thead>
            )}
            <tbody>
              {body.map((row, r) => (
                <tr key={r} className="odd:bg-surface/40">
                  <td className="border border-line-subtle px-2 py-0.5 text-right tabular-nums text-fg-faint">{r + 1}</td>
                  {Array.from({ length: table.columns }, (_, c) => (
                    <td key={c} className="max-w-[320px] truncate border border-line-subtle px-2.5 py-0.5 text-fg-2" title={row[c]}>{row[c] ?? ""}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  )
}
