import { useMemo, useState, type ReactNode } from "react"
import { File, Folder, Lock } from "lucide-react"
import { formatBytes } from "../../../shared/preview-text"
import type { PreviewFileInfo } from "../../../shared/preview-types"
import { FileNotice, Loading, ViewerBar, ViewerNotice } from "./preview-ui"
import { useLoaded, usePreviewHost } from "./preview-host"

/** 一次最多画多少行：压缩包里可能有几万个文件，全画出来既卡又没人看，可以用搜索框缩小范围 */
const MAX_ROWS = 2000

function formatTime(ms: number | undefined): string {
  if (ms === undefined) return ""
  const d = new Date(ms)
  const p = (n: number) => String(n).padStart(2, "0")
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

/** 压缩包的文件清单（只读中央目录，不解压） */
export default function ArchiveView({ info, actions }: { info: PreviewFileInfo; actions?: ReactNode }) {
  const host = usePreviewHost()
  const state = useLoaded(async () => {
    const r = await host.fileZip(info.token)
    return r.ok ? { ok: true as const, value: r } : r
  }, [info.token])
  const [query, setQuery] = useState("")

  const listing = state.status === "ready" ? state.value : undefined
  const { shown, matched, unpacked } = useMemo(() => {
    if (!listing) return { shown: [], matched: 0, unpacked: 0 }
    const q = query.trim().toLowerCase()
    const matches = q ? listing.entries.filter((e) => e.name.toLowerCase().includes(q)) : listing.entries
    return {
      shown: matches.slice(0, MAX_ROWS),
      matched: matches.length,
      unpacked: listing.entries.reduce((n, e) => n + e.size, 0),
    }
  }, [listing, query])

  if (state.status === "loading") return <Loading />
  if (state.status === "error") return <FileNotice file={info} reason={state.error}>{actions}</FileNotice>
  const { value } = state

  return (
    <div className="flex h-full flex-col">
      <ViewerBar>
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="搜索文件名"
          spellCheck={false}
          className="h-6 w-40 rounded border border-line-subtle bg-surface px-2 text-xs text-fg-soft outline-none placeholder:text-fg-faint focus:border-blue-500"
        />
        <span className="ml-auto">{value.total.toLocaleString()} 项 · 解压后 {formatBytes(unpacked)} · 压缩包 {formatBytes(value.size)}</span>
      </ViewerBar>
      {value.truncated && <ViewerNotice>压缩包里有 {value.total.toLocaleString()} 项，只列出了前 {value.entries.length.toLocaleString()} 项。</ViewerNotice>}
      {matched > MAX_ROWS && <ViewerNotice>共 {matched.toLocaleString()} 项，只显示前 {MAX_ROWS.toLocaleString()} 项；输入文件名可以缩小范围。</ViewerNotice>}
      <div className="min-h-0 flex-1 overflow-auto">
        {shown.length === 0 ? (
          <p className="px-4 py-6 text-center text-xs text-fg-faint">{value.total === 0 ? "压缩包是空的" : "没有匹配的文件"}</p>
        ) : (
          <table className="w-full border-collapse text-xs">
            <thead className="sticky top-0 z-[1] bg-raised text-left text-fg-faint">
              <tr>
                <th className="px-3 py-1 font-normal">名称</th>
                <th className="w-20 px-2 py-1 text-right font-normal">大小</th>
                <th className="w-32 px-3 py-1 font-normal">修改时间</th>
              </tr>
            </thead>
            <tbody>
              {shown.map((e, i) => {
                const trimmed = e.isDir ? e.name.slice(0, -1) : e.name
                const slash = trimmed.lastIndexOf("/")
                return (
                  <tr key={i} className="border-b border-line-subtle/60 hover:bg-raised/50">
                    <td className="max-w-0 px-3 py-1" title={e.name}>
                      <div className="flex items-center gap-1.5">
                        {e.isDir ? <Folder size={13} className="shrink-0 text-accent" /> : <File size={13} className="shrink-0 text-fg-faint" />}
                        <span className="truncate">
                          <span className="text-fg-faint">{trimmed.slice(0, slash + 1)}</span>
                          <span className={e.isDir ? "text-fg" : "text-fg-2"}>{trimmed.slice(slash + 1)}{e.isDir ? "/" : ""}</span>
                        </span>
                        {e.encrypted && <Lock size={11} className="shrink-0 text-warning-soft" aria-label="已加密" />}
                      </div>
                    </td>
                    <td className="px-2 py-1 text-right tabular-nums text-fg-muted">{e.isDir ? "" : formatBytes(e.size)}</td>
                    <td className="whitespace-nowrap px-3 py-1 tabular-nums text-fg-muted">{formatTime(e.mtimeMs)}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        )}
      </div>
    </div>
  )
}
