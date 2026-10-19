import { useCallback, useEffect, useMemo, useState } from "react"
import { Plus, RefreshCw, X } from "lucide-react"
import type { FlowHubBrowsableNode, FlowHubCatalog, FlowHubCatalogGroup, FlowHubSyncStatus } from "../../shared/flow-hub-types"

type BrowserKind = "group" | "node"

interface FlowHubBrowserProps {
  kind: BrowserKind
  targetGroupId?: string
  onClose: () => void
  onImported: () => void
  showAlert: (title: string, msg: string) => void | Promise<void>
  showConfirm: (title: string, msg: string, ok?: string, cancel?: string) => Promise<boolean>
}

const PAGE = 20

export function FlowHubBrowser({ kind, targetGroupId, onClose, onImported, showAlert, showConfirm }: FlowHubBrowserProps) {
  const [catalog, setCatalog] = useState<FlowHubCatalog | null>(null)
  const [hubNodes, setHubNodes] = useState<FlowHubBrowsableNode[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState("")
  const [query, setQuery] = useState("")
  const [visible, setVisible] = useState(PAGE)
  const [statusMap, setStatusMap] = useState<Record<string, FlowHubSyncStatus>>({})
  const [busyId, setBusyId] = useState("")
  const [tooltip, setTooltip] = useState<{ text: string; x: number; y: number } | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    setError("")
    if (kind === "node") {
      const r = await window.electronAPI.flowHub.listNodes()
      if (!r.ok) {
        setError(r.error ?? "加载失败")
        setHubNodes([])
      } else {
        setHubNodes(r.nodes)
      }
      setCatalog(null)
    } else {
      const r = await window.electronAPI.flowHub.getCatalog(true)
      if (!r.ok) {
        setError(r.error ?? "加载失败")
        setCatalog(null)
      } else {
        setCatalog(r.catalog)
      }
      setHubNodes([])
    }
    setLoading(false)
  }, [kind])

  useEffect(() => { void load() }, [load])

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    const match = (s: string) => !q || s.toLowerCase().includes(q)
    if (kind === "node") {
      return {
        groups: [] as FlowHubCatalogGroup[],
        nodes: hubNodes.filter((n) =>
          match(n.label) || match(n.localId) || match(n.author) || (n.sourceGroupName ? match(n.sourceGroupName) : false),
        ),
      }
    }
    if (!catalog) return { groups: [], nodes: [] as FlowHubBrowsableNode[] }
    return {
      groups: catalog.groups.filter((g) => match(g.name) || match(g.author) || g.nodeLabels.some(match)),
      nodes: [],
    }
  }, [catalog, hubNodes, kind, query])

  const groupSlice = useMemo(
    () => (kind === "group" ? filtered.groups.slice(0, visible) : []),
    [filtered.groups, kind, visible],
  )
  const nodeSlice = useMemo(
    () => (kind === "node" ? filtered.nodes.slice(0, visible) : []),
    [filtered.nodes, kind, visible],
  )
  const totalItems = kind === "group" ? filtered.groups.length : filtered.nodes.length

  useEffect(() => {
    if (loading) return
    void (async () => {
      const map: Record<string, FlowHubSyncStatus> = {}
      if (kind === "group" && catalog) {
        for (const g of catalog.groups) {
          map[g.hubId] = await window.electronAPI.flowHub.getSyncStatus("group", g.hubId, g.contentHash)
        }
      } else if (kind === "node") {
        for (const n of hubNodes) {
          map[n.hubId] = await window.electronAPI.flowHub.getSyncStatus("node", n.hubId, n.contentHash)
        }
      }
      setStatusMap(map)
    })()
  }, [catalog, hubNodes, kind, loading])

  const nodeRef = (n: FlowHubBrowsableNode) => (
    n.groupHubId && n.localId ? { groupHubId: n.groupHubId, nodeLocalId: n.localId } : undefined
  )

  const handleImport = async (item: FlowHubCatalogGroup | FlowHubBrowsableNode) => {
    const hubId = item.hubId
    setBusyId(hubId)
    const r = kind === "group"
      ? await window.electronAPI.flowHub.importGroup(hubId)
      : await window.electronAPI.flowHub.importNode(hubId, targetGroupId ?? "", nodeRef(item as FlowHubBrowsableNode))
    setBusyId("")
    if (!r.ok) void showAlert("导入失败", r.error ?? "未知错误")
    else { onImported(); void load() }
  }

  const handleSync = async (item: FlowHubCatalogGroup | FlowHubBrowsableNode) => {
    const hubId = item.hubId
    const st = statusMap[hubId]
    if (st === "local_modified") {
      if (!(await showConfirm("同步确认", "本地已修改，用 Hub 覆盖本地内容？"))) return
    }
    setBusyId(hubId)
    const r = kind === "group"
      ? await window.electronAPI.flowHub.syncGroup(hubId, "overwrite")
      : await window.electronAPI.flowHub.syncNode(hubId, targetGroupId ?? "", "overwrite", nodeRef(item as FlowHubBrowsableNode))
    setBusyId("")
    if (!r.ok) void showAlert("同步失败", r.error ?? "未知错误")
    else { onImported(); void load() }
  }

  const moveTooltip = (e: React.MouseEvent) => {
    setTooltip((t) => t ? { ...t, x: e.clientX + 12, y: e.clientY + 12 } : null)
  }

  const hideTooltip = () => setTooltip(null)

  const previewNode = async (e: React.MouseEvent, hubId: string, nodeLocalId?: string, groupHubId?: string) => {
    const pos = { x: e.clientX + 12, y: e.clientY + 12 }
    const r = groupHubId && nodeLocalId
      ? await window.electronAPI.flowHub.preview("group", groupHubId, nodeLocalId)
      : await window.electronAPI.flowHub.preview(kind, hubId, nodeLocalId)
    const text = r.ok ? (r.prompt?.slice(0, 400) ?? "") : ""
    if (text) setTooltip({ text, ...pos })
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
      <div className="flex max-h-[85vh] w-full max-w-2xl flex-col rounded-xl border border-line bg-page shadow-xl">
        <div className="flex items-center justify-between border-b border-line-subtle px-4 py-3">
          <h3 className="text-sm font-semibold text-fg">
            {kind === "group" ? "从共享空间获取流程组" : "从共享空间获取节点"}
          </h3>
          <button type="button" onClick={onClose} className="text-fg-muted hover:text-fg"><X className="h-4 w-4" /></button>
        </div>
        <div className="border-b border-line-subtle px-4 py-2">
          <input
            value={query}
            onChange={(e) => { setQuery(e.target.value); setVisible(PAGE) }}
            placeholder="搜索名称 / 作者 / 节点…"
            className="w-full rounded-md border border-line bg-surface px-3 py-2 text-sm text-fg-soft"
          />
        </div>
        <div className="flex-1 overflow-y-auto p-4 space-y-3" onScroll={(e) => {
          const el = e.currentTarget
          if (el.scrollTop + el.clientHeight >= el.scrollHeight - 40 && visible < totalItems) {
            setVisible((v) => v + PAGE)
          }
        }}>
          {loading && <p className="text-xs text-fg-muted">加载中…</p>}
          {error && <p className="text-xs text-danger">{error}</p>}
          {!loading && !error && groupSlice.length === 0 && nodeSlice.length === 0 && <p className="text-xs text-fg-muted">无匹配项</p>}
          {kind === "group" && groupSlice.map((g: FlowHubCatalogGroup) => {
            const st = statusMap[g.hubId] ?? "missing"
            return (
              <div key={g.hubId} className="rounded-lg border border-line-subtle p-3">
                <div className="flex items-start justify-between gap-2">
                  <div>
                    <div className="text-sm font-medium text-fg">{g.name}</div>
                    <div className="text-[10px] text-fg-muted">by {g.author || "未知"} · {g.updatedAt.slice(0, 10)}</div>
                  </div>
                  <ActionBtn st={st} busy={busyId === g.hubId} onAdd={() => void handleImport(g)} onSync={() => void handleSync(g)} />
                </div>
                <div className="mt-2 flex flex-wrap gap-1">
                  {g.nodeLabels.map((label, i) => (
                    <span
                      key={`${g.hubId}-${g.nodeIds[i] ?? i}`}
                      className="cursor-default rounded bg-raised px-1.5 py-0.5 text-[10px] text-fg-3"
                      onMouseEnter={(e) => void previewNode(e, g.hubId, g.nodeIds[i])}
                      onMouseMove={moveTooltip}
                      onMouseLeave={hideTooltip}
                    >{label}</span>
                  ))}
                </div>
              </div>
            )
          })}
          {kind === "node" && nodeSlice.map((n: FlowHubBrowsableNode) => {
            const st = statusMap[n.hubId] ?? "missing"
            return (
              <div
                key={n.hubId}
                className="flex items-center justify-between rounded-lg border border-line-subtle p-3"
                onMouseEnter={(e) => void previewNode(e, n.hubId, n.localId, n.groupHubId)}
                onMouseMove={moveTooltip}
                onMouseLeave={hideTooltip}
              >
                <div>
                  <div className="text-sm text-fg">{n.label} <span className="font-mono text-xs text-fg-muted">/p {n.localId}</span></div>
                  <div className="text-[10px] text-fg-muted">by {n.author}{n.sourceGroupName ? ` · 来自 ${n.sourceGroupName}` : ""}</div>
                </div>
                <ActionBtn st={st} busy={busyId === n.hubId} onAdd={() => void handleImport(n)} onSync={() => void handleSync(n)} />
              </div>
            )
          })}
        </div>
      </div>
      {tooltip && (
        <div
          className="pointer-events-none fixed z-[60] max-w-xs rounded-md border border-line-strong bg-surface/95 px-3 py-2 text-[10px] leading-relaxed text-fg-2 shadow-xl whitespace-pre-wrap"
          style={{
            left: Math.min(tooltip.x, window.innerWidth - 280),
            top: Math.min(tooltip.y, window.innerHeight - 120),
          }}
        >
          {tooltip.text}
        </div>
      )}
    </div>
  )
}

function ActionBtn({ st, busy, onAdd, onSync }: {
  st: FlowHubSyncStatus
  busy: boolean
  onAdd: () => void
  onSync: () => void
}) {
  if (busy) return <span className="text-xs text-fg-muted">…</span>
  if (st === "synced") return <span className="text-xs text-emerald-500">✓ 已添加</span>
  if (st === "outdated" || st === "local_modified") {
    return (
      <button type="button" onClick={onSync} className="inline-flex items-center gap-1 text-xs text-warning hover:text-warning-soft">
        <RefreshCw className="h-3 w-3" />同步
      </button>
    )
  }
  return (
    <button type="button" onClick={onAdd} className="inline-flex items-center gap-1 text-xs text-accent hover:text-accent-soft">
      <Plus className="h-3 w-3" />添加
    </button>
  )
}
