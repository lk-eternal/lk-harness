import { useCallback, useEffect, useRef, useState } from "react"
import { Check, ChevronDown, ChevronRight, Loader2, Zap } from "lucide-react"
import useOutsideClose from "../../hooks/useOutsideClose"
import { modelSlug } from "../../model-utils"
import type { AgentResource } from "../../../shared/channel-types"

export interface QuickModel { model: string; modelParams?: string; label?: string; resourceId?: string }

export interface ModelChoice { model: string; modelParams?: string; resourceId: string }

interface ProviderModel { id: string; label: string; params: string }

type ProviderModels =
  | { status: "loading" }
  | { status: "ok"; models: ProviderModel[] }
  | { status: "error"; error: string }

interface Props {
  resources: AgentResource[]
  /** 会话当前生效的供应商 id */
  currentResourceId?: string
  currentModel?: string
  currentParams?: string
  /** 输入框里显示的当前模型名 */
  currentLabel: string
  quickModels: QuickModel[]
  /** 正在切换：芯片显示转圈并禁用 */
  switching: boolean
  onSelect: (choice: ModelChoice) => void
}

async function fetchProviderModels(resource: AgentResource): Promise<ProviderModels> {
  try {
    if (resource.type === "sdk") {
      const apiKey = resource.apiKey?.trim()
      if (!apiKey) return { status: "error", error: "该供应商未填 API Key" }
      const r = await window.electronAPI.listSdkModels(apiKey)
      if (!r.ok) return { status: "error", error: r.error || "获取模型列表失败" }
      return { status: "ok", models: r.models.map((m) => ({ id: m.id, label: m.label, params: m.params })) }
    }
    const r = await window.electronAPI.listLlmModels(resource)
    if (!r.ok) return { status: "error", error: r.error || "获取模型列表失败" }
    return { status: "ok", models: r.models.map((m) => ({ id: m.id, label: m.label, params: "" })) }
  } catch (e: unknown) {
    return { status: "error", error: e instanceof Error ? e.message : String(e) }
  }
}

const modelKey = (id: string, params: string | undefined) => `${id}\0${params ?? ""}`

/** 输入框里的「供应商 / 模型」选择：左列供应商，右列该供应商的模型（常用在前），点到模型才生效 */
export default function ModelPicker({ resources, currentResourceId, currentModel, currentParams, currentLabel, quickModels, switching, onSelect }: Props) {
  const [open, setOpen] = useState(false)
  /** 右列正在展示的供应商；打开时默认当前供应商 */
  const [shownId, setShownId] = useState<string | undefined>()
  const [cache, setCache] = useState<Record<string, ProviderModels>>({})
  const rootRef = useRef<HTMLDivElement>(null)
  const close = useCallback(() => setOpen(false), [])
  useOutsideClose(open, rootRef, close)

  const currentProvider = resources.find((r) => r.id === currentResourceId)
  const shown = resources.find((r) => r.id === shownId) ?? currentProvider ?? resources[0]
  const shownModels = shown ? cache[shown.id] : undefined

  // 展示某个供应商且还没拉过时才拉取；失败的结果在下次打开菜单时清掉重试
  useEffect(() => {
    if (!open || !shown || shownModels) return
    const id = shown.id
    setCache((c) => ({ ...c, [id]: { status: "loading" } }))
    void fetchProviderModels(shown).then((result) => setCache((c) => ({ ...c, [id]: result })))
  }, [open, shown, shownModels])

  const toggle = () => {
    if (open) { setOpen(false); return }
    setShownId(undefined)
    setCache((c) => Object.fromEntries(Object.entries(c).filter(([, v]) => v.status !== "error")))
    setOpen(true)
  }

  const isCurrent = (id: string, params: string | undefined) =>
    shown?.id === currentProvider?.id && id === currentModel && (params ?? "") === (currentParams ?? "")

  const choose = (id: string, params: string | undefined) => {
    setOpen(false)
    if (!shown || isCurrent(id, params)) return
    onSelect({ model: id, ...(params ? { modelParams: params } : {}), resourceId: shown.id })
  }

  const favorites = quickModels.filter((m) => (m.resourceId ?? currentProvider?.id) === shown?.id)
  const favoriteKeys = new Set(favorites.map((m) => modelKey(m.model, m.modelParams)))
  const others = shownModels?.status === "ok" ? shownModels.models.filter((m) => !favoriteKeys.has(modelKey(m.id, m.params))) : []

  const row = (key: string, id: string, params: string | undefined, label: string) => {
    const cur = isCurrent(id, params)
    return (
      <button
        key={key}
        type="button"
        onClick={() => choose(id, params)}
        className={`flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-[13px] transition hover:bg-strong/40 ${cur ? "font-medium text-accent" : "text-fg-2"}`}
      >
        <span className="min-w-0 flex-1 truncate">{label}</span>
        {cur && <Check size={14} className="shrink-0" />}
      </button>
    )
  }

  return (
    <div className="relative" ref={rootRef}>
      <button
        type="button"
        disabled={switching}
        onClick={toggle}
        title="切换供应商 / 模型"
        className={`inline-flex max-w-[22rem] items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-[12.5px] text-fg-2 transition ${open ? "border-accent bg-raised" : "border-line hover:border-line-strong"}`}
      >
        {switching && <Loader2 size={12} className="shrink-0 animate-spin" />}
        {currentProvider && (
          <>
            <span className="shrink-0 text-fg-muted">{currentProvider.name || currentProvider.id}</span>
            <span className="text-fg-ghost">/</span>
          </>
        )}
        <span className="truncate">{currentLabel}</span>
        <ChevronDown size={12} className="shrink-0 text-fg-faint" />
      </button>
      {open && (
        <div className="absolute bottom-full left-0 z-20 mb-2 flex overflow-hidden rounded-xl border border-line bg-page shadow-lg">
          <div className="w-44 shrink-0 space-y-0.5 border-r border-line-subtle bg-surface p-1.5">
            {resources.length === 0 && <p className="px-2.5 py-2 text-xs text-fg-faint">还没有配置供应商</p>}
            {resources.map((r) => (
              <button
                key={r.id}
                type="button"
                onMouseEnter={() => setShownId(r.id)}
                onClick={() => setShownId(r.id)}
                className={`flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-[13px] transition ${r.id === shown?.id ? "bg-strong/50 text-fg" : "text-fg-2"}`}
              >
                <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${r.id === currentProvider?.id ? "bg-accent" : "bg-transparent"}`} />
                <span className="min-w-0 flex-1 truncate">{r.name || r.id}</span>
                <ChevronRight size={13} className="shrink-0 text-fg-faint" />
              </button>
            ))}
          </div>
          <div className="max-h-80 w-72 overflow-y-auto p-1.5">
            {favorites.length > 0 && (
              <>
                <p className="flex items-center gap-1 px-2.5 pb-1 pt-1.5 text-[11px] text-fg-faint"><Zap size={11} />常用</p>
                {favorites.map((m) => row(`fav:${modelKey(m.model, m.modelParams)}`, m.model, m.modelParams, m.label || modelSlug(m.model, m.modelParams)))}
              </>
            )}
            {shownModels?.status === "loading" && (
              <p className="flex items-center gap-2 px-2.5 py-3 text-xs text-fg-muted"><Loader2 size={12} className="animate-spin" />加载模型列表…</p>
            )}
            {shownModels?.status === "error" && <p className="px-2.5 py-3 text-xs text-danger">{shownModels.error}</p>}
            {others.length > 0 && (
              <>
                <p className={`px-2.5 pb-1 pt-1.5 text-[11px] text-fg-faint ${favorites.length > 0 ? "mt-1 border-t border-line-subtle pt-2.5" : ""}`}>全部模型</p>
                {others.map((m) => row(`all:${modelKey(m.id, m.params)}`, m.id, m.params, m.label))}
              </>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
