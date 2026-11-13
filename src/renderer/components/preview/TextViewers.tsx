import { useEffect, useMemo, useRef, useState } from "react"
import ReactMarkdown, { type Components } from "react-markdown"
import { Loader2 } from "lucide-react"
import { fileExt } from "../../../shared/preview-kinds"
import {
  clipFolds, collapseAll, computeFolds, foldLanguageOf, hiddenLineCount, revealLine, toggleFold, visibleLines, type FoldRegion,
} from "../../../shared/preview-fold"
import { formatJsonFor, jsonFormatKind, shouldDefaultToFormatted, type JsonFormatResult } from "../../../shared/preview-json"
import { detectDelimiter, formatBytes, parseCsv } from "../../../shared/preview-text"
import { PREVIEW_MAX_TEXT_BYTES, type PreviewFileInfo, type PreviewTextResult } from "../../../shared/preview-types"
import { CodeBlock, SafeLink, remarkPlugins, rehypePlugins } from "../chat/Markdown"
import { HIGHLIGHT_MAX_CHARS, MAX_RENDER_LINES, toCodeLines } from "./code-highlight"
import FindScope from "./FindScope"
import { usePreviewHost } from "./preview-host"
import { BarTextButton, CenterMessage, Segmented, ViewerBar, ViewerNotice } from "./preview-ui"

type TextState =
  | { status: "loading" }
  | { status: "error"; error: string }
  | Extract<PreviewTextResult, { ok: true }> & { status: "ready" }

/** 经主进程读文本内容；enabled 为假时不读（比如 HTML 只在看源码时才需要文本） */
function useFileText(token: string, enabled: boolean): TextState {
  const host = usePreviewHost()
  const [state, setState] = useState<TextState>({ status: "loading" })
  useEffect(() => {
    if (!enabled) return
    let cancelled = false
    setState({ status: "loading" })
    host.fileText(token).then((r) => {
      if (cancelled) return
      setState(r.ok ? { ...r, status: "ready" } : { status: "error", error: r.error })
    }).catch((e: unknown) => {
      if (!cancelled) setState({ status: "error", error: e instanceof Error ? e.message : String(e) })
    })
    return () => { cancelled = true }
  }, [host, token, enabled])
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

/** 折叠：哪些行能折、现在折了哪些（状态在调用方，工具栏上的「折叠全部 / 展开全部」要用） */
interface FoldControl {
  regions: readonly FoldRegion[]
  collapsed: ReadonlySet<number>
  onToggle: (start: number) => void
}

/** 带行号的文本；认识的语言做语法高亮；传了 fold 就带折叠箭头 */
export function CodeText({ text, lang, wrap, line, fold }: { text: string; lang?: string; wrap: boolean; line?: number; fold?: FoldControl }) {
  const code = useMemo(() => toCodeLines(text, lang), [text, lang])
  // 要定位的行（从对话里的 file.ts:42 点进来）：高亮并滚到视野中间；超出文件行数就当没带
  const hit = line !== undefined && line >= 1 && line <= code.lines.length ? line : undefined
  const hitRef = useRef<HTMLSpanElement>(null)
  useEffect(() => {
    hitRef.current?.scrollIntoView({ block: "center" })
  }, [hit, code])
  const regions = fold?.regions
  const collapsed = fold?.collapsed
  const byStart = useMemo(() => new Map((regions ?? []).map((r) => [r.start, r])), [regions])
  const rows = useMemo(
    () => visibleLines(code.lines.length, regions ?? [], collapsed ?? NO_COLLAPSED),
    [code.lines.length, regions, collapsed],
  )
  const tooBigToHighlight = !!lang && !code.highlighted && text.length > HIGHLIGHT_MAX_CHARS
  return (
    <>
      {code.cutOff && <ViewerNotice>内容太长，只显示前 {code.lines.length.toLocaleString()} 行。</ViewerNotice>}
      {tooBigToHighlight && <ViewerNotice>内容较大（{text.length.toLocaleString()} 个字符），没有做语法高亮。</ViewerNotice>}
      <pre className={`preview-code hljs ${wrap ? "wrap" : ""} ${byStart.size > 0 ? "foldable" : ""}`}>
        <code>
          {rows.map((i) => {
            const html = code.lines[i]
            const ref = i + 1 === hit ? hitRef : undefined
            const className = i + 1 === hit ? "pl hit" : "pl"
            const region = byStart.get(i)
            if (!region || !fold) {
              return <span key={i} ref={ref} className={className} data-ln={i + 1} dangerouslySetInnerHTML={{ __html: html }} />
            }
            const isCollapsed = fold.collapsed.has(i)
            return (
              <span key={i} ref={ref} className={className} data-ln={i + 1}>
                <button
                  type="button"
                  className="fold-btn"
                  aria-expanded={!isCollapsed}
                  aria-label={isCollapsed ? "展开" : "折叠"}
                  title={isCollapsed ? "展开" : "折叠"}
                  onClick={() => fold.onToggle(i)}
                />
                <span dangerouslySetInnerHTML={{ __html: html }} />
                {isCollapsed && (
                  <button type="button" className="fold-pill" title="展开" onClick={() => fold.onToggle(i)}>⋯ {hiddenLineCount(region)} 行</button>
                )}
              </span>
            )
          })}
        </code>
      </pre>
    </>
  )
}

const NO_COLLAPSED: ReadonlySet<number> = new Set()
const NO_REGIONS: readonly FoldRegion[] = []

function WrapToggle({ wrap, onChange }: { wrap: boolean; onChange: (wrap: boolean) => void }) {
  return (
    <label className="flex cursor-pointer items-center gap-1.5 select-none">
      <input type="checkbox" checked={wrap} onChange={(e) => onChange(e.target.checked)} className="accent-blue-500" />自动换行
    </label>
  )
}

function sourceSummary(state: Extract<TextState, { status: "ready" }>, lang?: string, extra?: string): string {
  return [lang, extra, state.encoding.toUpperCase(), formatBytes(state.size)].filter(Boolean).join(" · ")
}

/** 「第 3 行第 8 列：」，定位不到就是空串 */
function errorWhere(e: { line?: number; column?: number }): string {
  if (e.line === undefined) return ""
  return e.column === undefined ? `第 ${e.line} 行：` : `第 ${e.line} 行第 ${e.column} 列：`
}

/** 格式化没有做到的原因（只在用户选了格式化、而且没成功时显示） */
function FormatNotice({ result }: { result: JsonFormatResult }) {
  if (!result.ok) return <ViewerNotice>无法格式化，显示的是原文。{errorWhere(result)}{result.message}</ViewerNotice>
  if (result.skippedLines.length === 0) return null
  const shown = result.skippedLines.slice(0, 5).join("、")
  const more = result.skippedLines.length > 5 ? ` 等 ${result.skippedLines.length} 行` : " 行"
  return <ViewerNotice>原文第 {shown}{more}不是合法的 JSON，已原样保留。</ViewerNotice>
}

/** 文本读好之后的代码视图：JSON 可以在原文和格式化之间切换，JSON / YAML 可以折叠 */
export function CodeViewReady({ info, state, line }: { info: PreviewFileInfo; state: Extract<TextState, { status: "ready" }>; line?: number }) {
  const jsonKind = jsonFormatKind(info.name)
  // 文件被截断时内容不完整，不是合法 JSON，不提供格式化
  const canFormat = jsonKind !== undefined && !state.truncated
  const [wrap, setWrap] = useState(info.kind === "text")
  const [mode, setMode] = useState<"raw" | "format">(() => (canFormat && shouldDefaultToFormatted(jsonKind, state.text, line !== undefined) ? "format" : "raw"))
  const formatted = useMemo<JsonFormatResult | undefined>(
    () => (jsonKind && canFormat && mode === "format" ? formatJsonFor(jsonKind, state.text) : undefined),
    [canFormat, jsonKind, mode, state.text],
  )
  const showFormatted = formatted?.ok === true
  const text = formatted?.ok ? formatted.text : state.text

  const foldLang = foldLanguageOf(info.lang)
  const regions = useMemo(
    () => (foldLang ? clipFolds(computeFolds(foldLang, text, { records: jsonKind === "jsonl" }), MAX_RENDER_LINES) : NO_REGIONS),
    [foldLang, text, jsonKind],
  )
  const [collapsed, setCollapsed] = useState<ReadonlySet<number>>(NO_COLLAPSED)
  // 换了要定位的行（对话里又点了同一个文件的另一处）：把藏住它的折叠展开，不然滚不到。
  // 渲染期间直接改状态：这样同一次提交里那一行就已经在了，滚动用的 ref 才拿得到
  const [revealedFor, setRevealedFor] = useState(line)
  if (revealedFor !== line) {
    setRevealedFor(line)
    if (line !== undefined && !showFormatted) setCollapsed(revealLine(collapsed, regions, line - 1))
  }
  const changeMode = (next: "raw" | "format"): void => {
    setMode(next)
    setCollapsed(NO_COLLAPSED) // 两种排版的行对不上，折叠状态作废
  }

  return (
    <div className="flex h-full flex-col">
      <ViewerBar>
        {canFormat && (
          <Segmented
            value={showFormatted ? "format" : "raw"}
            onChange={changeMode}
            options={[{ value: "raw", label: "原文" }, { value: "format", label: "格式化" }]}
          />
        )}
        <WrapToggle wrap={wrap} onChange={setWrap} />
        {regions.length > 0 && (
          <>
            <BarTextButton onClick={() => setCollapsed(collapseAll(regions))} title="把所有层级都收起来，再逐层点开">折叠全部</BarTextButton>
            <BarTextButton onClick={() => setCollapsed(NO_COLLAPSED)}>展开全部</BarTextButton>
          </>
        )}
        <span className="ml-auto">{sourceSummary(state, info.lang, showFormatted ? "已格式化" : undefined)}</span>
      </ViewerBar>
      <TruncatedNotice state={state} />
      {formatted && <FormatNotice result={formatted} />}
      {/* 折叠起来的行不在界面上，查找找不到：打开查找时先全部展开 */}
      <FindScope onOpen={() => setCollapsed(NO_COLLAPSED)}>
        <CodeText
          text={text}
          lang={info.lang}
          wrap={wrap}
          // 格式化后行号变了，对话里那个行号不再对应，不高亮
          line={showFormatted ? undefined : line}
          fold={regions.length > 0 ? { regions, collapsed, onToggle: (start) => setCollapsed((c) => toggleFold(c, start)) } : undefined}
        />
      </FindScope>
    </div>
  )
}

/** 纯文本、代码、日志、配置 */
export function CodeView({ info, line }: { info: PreviewFileInfo; line?: number }) {
  const state = useFileText(info.token, true)
  if (state.status !== "ready") return <TextStatus state={state} />
  return <CodeViewReady info={info} state={state} line={line} />
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
      <FindScope>
        {mode === "render" ? <MarkdownRender text={state.text} baseUrl={info.url} /> : <CodeText text={state.text} wrap={wrap} />}
      </FindScope>
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
          <FindScope><CodeText text={state.text} lang="xml" wrap={wrap} /></FindScope>
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
      <FindScope>
        {mode === "text" ? <CodeText text={state.text} wrap={wrap} /> : (
          <table className="border-collapse text-xs">
            {header && (
              <thead className="sticky top-0 z-[1]">
                <tr>
                  <th data-find-skip className="border border-line bg-raised px-2 py-1 text-right font-normal text-fg-faint">#</th>
                  {Array.from({ length: table.columns }, (_, c) => (
                    <th key={c} className="max-w-[320px] truncate border border-line bg-raised px-2.5 py-1 text-left font-semibold text-fg" title={header[c]}>{header[c] ?? ""}</th>
                  ))}
                </tr>
              </thead>
            )}
            <tbody>
              {body.map((row, r) => (
                <tr key={r} className="odd:bg-surface/40">
                  <td data-find-skip className="border border-line-subtle px-2 py-0.5 text-right tabular-nums text-fg-faint">{r + 1}</td>
                  {Array.from({ length: table.columns }, (_, c) => (
                    <td key={c} className="max-w-[320px] truncate border border-line-subtle px-2.5 py-0.5 text-fg-2" title={row[c]}>{row[c] ?? ""}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </FindScope>
    </div>
  )
}
