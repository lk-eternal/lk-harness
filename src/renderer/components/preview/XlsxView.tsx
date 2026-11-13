import { useMemo, useState, type ReactNode } from "react"
import { formatBytes } from "../../../shared/preview-text"
import { columnLabel, openXlsx, type XlsxMerge, type XlsxSheetData, type XlsxWorkbook } from "../../../shared/preview-xlsx"
import type { PreviewFileInfo } from "../../../shared/preview-types"
import FindScope from "./FindScope"
import { CenterMessage, FileNotice, Loading, ViewerBar, ViewerNotice } from "./preview-ui"
import { useLoaded, usePreviewHost } from "./preview-host"

/** 先画多少行，点「再显示」每次加多少行：一个工作表最多 5000 行 × 100 列，一次全画会卡住 */
const FIRST_ROWS = 500
const MORE_ROWS = 1000
/** 合并区域的格子坐标压成一个数用的乘数（列数不会超过它） */
const KEY = 1000

function SheetGrid({ sheet }: { sheet: XlsxSheetData }) {
  const [limit, setLimit] = useState(FIRST_ROWS)

  const { anchors, covered } = useMemo(() => {
    const anchors = new Map<number, XlsxMerge>()
    const covered = new Set<number>()
    for (const m of sheet.merges) {
      anchors.set(m.row * KEY + m.col, m)
      for (let r = m.row; r < m.row + m.rows; r++) {
        for (let c = m.col; c < m.col + m.cols; c++) if (r !== m.row || c !== m.col) covered.add(r * KEY + c)
      }
    }
    return { anchors, covered }
  }, [sheet])

  if (sheet.rowCount === 0) return <CenterMessage>这个工作表是空的</CenterMessage>
  const rows = sheet.rows.slice(0, limit)
  const th = "sticky top-0 z-[2] border border-line bg-raised px-2 py-1 text-center font-normal text-fg-faint"

  return (
    <>
      <table className="border-collapse text-xs">
        {/* 列字母和行号是表格自己的刻度，不是单元格内容：不参与查找 */}
        <thead data-find-skip>
          <tr>
            <th className={`${th} left-0 z-[3]`} />
            {Array.from({ length: sheet.columns }, (_, c) => <th key={c} className={th}>{columnLabel(c)}</th>)}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, r) => (
            <tr key={r}>
              <td data-find-skip className="sticky left-0 z-[1] border border-line bg-raised px-2 py-0.5 text-right tabular-nums text-fg-faint">{r + 1}</td>
              {Array.from({ length: sheet.columns }, (_, c) => {
                if (covered.has(r * KEY + c)) return null
                const merge = anchors.get(r * KEY + c)
                const cell = row[c]
                const width = sheet.colWidths[c]
                return (
                  <td
                    key={c}
                    rowSpan={merge?.rows}
                    colSpan={merge?.cols}
                    title={cell?.formula ? `${cell.text}（文件里没有保存计算结果）` : cell?.text}
                    style={width ? { minWidth: width, maxWidth: width } : undefined}
                    className={`truncate border border-line-subtle px-2 py-0.5 ${cell?.formula ? "italic text-fg-faint" : "text-fg-2"} ${width ? "" : "max-w-[320px]"} ${cell?.right ? "text-right tabular-nums" : ""}`}
                  >{cell?.text}</td>
                )
              })}
            </tr>
          ))}
        </tbody>
      </table>
      {limit < sheet.rowCount && (
        <div className="flex items-center justify-center gap-3 border-t border-line-subtle py-3 text-xs text-fg-muted">
          <span>已显示 {limit.toLocaleString()} / {sheet.rowCount.toLocaleString()} 行</span>
          <button type="button" onClick={() => setLimit((n) => n + MORE_ROWS)} className="rounded border border-line px-2.5 py-1 text-fg-2 transition hover:border-blue-500 hover:text-accent-soft">再显示 {Math.min(MORE_ROWS, sheet.rowCount - limit).toLocaleString()} 行</button>
        </div>
      )}
    </>
  )
}

/** Excel 工作簿：只读，按工作表切换；显示的是单元格的值（按格式换算好），公式、图表、图片不显示 */
export default function XlsxView({ info, actions }: { info: PreviewFileInfo; actions?: ReactNode }) {
  const host = usePreviewHost()
  const book = useLoaded<XlsxWorkbook>(async () => {
    const r = await host.fileBytes(info.token)
    if (!r.ok) return r
    try {
      return { ok: true as const, value: await openXlsx(r.bytes) }
    } catch (e) {
      return { ok: false as const, error: e instanceof Error ? e.message : String(e) }
    }
  }, [info.token])

  const workbook = book.status === "ready" ? book.value : undefined
  const visible = useMemo(() => {
    const all = (workbook?.sheets ?? []).map((s, index) => ({ ...s, index }))
    // 隐藏的工作表不列出来（和 Excel 一致）；全是隐藏的就都列出来，免得什么也看不到
    return all.some((s) => !s.hidden) ? all.filter((s) => !s.hidden) : all
  }, [workbook])
  const [picked, setPicked] = useState<number | undefined>(undefined)
  const current = picked ?? visible[0]?.index ?? 0

  // 工作表解析过一次就记着，来回切换标签不用重新解析
  const cache = useMemo(() => new Map<number, Promise<XlsxSheetData>>(), [workbook])
  const sheet = useLoaded<XlsxSheetData>(async () => {
    if (!workbook) return { ok: false as const, error: "" }
    try {
      let p = cache.get(current)
      if (!p) { p = workbook.readSheet(current); cache.set(current, p) }
      return { ok: true as const, value: await p }
    } catch (e) {
      cache.delete(current)
      return { ok: false as const, error: e instanceof Error ? e.message : String(e) }
    }
  }, [workbook, current])

  if (book.status === "loading") return <Loading />
  if (book.status === "error") return <FileNotice file={info} reason={book.error}>{actions}</FileNotice>

  return (
    <div className="flex h-full flex-col">
      <ViewerBar>
        <span title="只显示单元格的值；公式只看计算结果，图表和图片不显示">只读 · 只显示单元格的值</span>
        <span className="ml-auto">
          {sheet.status === "ready" ? `${sheet.value.rowCount.toLocaleString()} 行 × ${sheet.value.columns} 列 · ` : ""}{formatBytes(info.size)}
        </span>
      </ViewerBar>
      {sheet.status === "ready" && sheet.value.truncatedRows && <ViewerNotice>这个工作表的行数很多，只读取了前 {sheet.value.rowCount.toLocaleString()} 行。</ViewerNotice>}
      {sheet.status === "ready" && sheet.value.truncatedCols && <ViewerNotice>这个工作表的列数很多，只读取了前 {sheet.value.columns} 列。</ViewerNotice>}
      <FindScope>
        {sheet.status === "loading" ? <Loading />
          : sheet.status === "error" ? <CenterMessage>{sheet.error || "读取工作表失败"}</CenterMessage>
          : <SheetGrid key={`${current}`} sheet={sheet.value} />}
      </FindScope>
      {visible.length > 1 && (
        <div className="flex shrink-0 items-stretch overflow-x-auto border-t border-line-subtle bg-surface/60 text-xs [scrollbar-width:thin]">
          {visible.map((s) => (
            <button
              key={s.index}
              type="button"
              onClick={() => setPicked(s.index)}
              title={s.name}
              className={`max-w-[200px] shrink-0 truncate border-r border-line-subtle px-3 py-1.5 transition ${s.index === current ? "bg-page font-medium text-fg" : "text-fg-muted hover:bg-raised/50 hover:text-fg-2"} ${s.hidden ? "italic opacity-60" : ""}`}
            >{s.name}</button>
          ))}
        </div>
      )}
    </div>
  )
}
