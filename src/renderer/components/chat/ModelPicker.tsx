import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from "react"
import { createPortal } from "react-dom"
import { Check, ChevronDown, ChevronRight, Loader2, Search, Star, Zap } from "lucide-react"
import type { AgentResource } from "../../../shared/channel-types"
import type { FavoriteModel } from "../../../shared/favorite-models"
import {
  buildProviderEntries,
  buildRows,
  choiceForRow,
  computePanelPosition,
  favoriteChoiceForRow,
  followModelAllowed,
  isCurrentRow,
  listedResourceId,
  triggerText,
  type ModelChoice,
  type PanelPosition,
  type PickerRow,
  type ProviderModel,
  type QuickModel,
} from "./model-picker-logic"

export type { ModelChoice, QuickModel } from "./model-picker-logic"

/** 同一页面里挂多个选择器（列表的每一行）时，共用的那份数据和回调：供应商列表、常用 / 收藏、★ 回调 */
export interface ModelPickerSource {
  resources: AgentResource[]
  quickModels: QuickModel[]
  favorites: FavoriteModel[]
  onToggleFavorite: (choice: ModelChoice & { label: string }, starred: boolean) => Promise<string | void> | void
  onOpen: () => void
}

type ProviderModels =
  | { status: "loading" }
  | { status: "ok"; models: ProviderModel[] }
  | { status: "error"; error: string }

/** 面板尺寸：高度固定，悬停切换供应商时布局不随右列内容变化 */
const PANEL_HEIGHT = 320
const LEFT_WIDTH = 176
const RIGHT_WIDTH = 288

interface Props {
  resources: AgentResource[]
  /** 当前生效的供应商 id；空串 = 跟随（需配合 followProvider） */
  currentResourceId?: string
  currentModel?: string
  currentParams?: string
  /** 触发按钮上的模型名；不给就按当前模型自己算 */
  currentLabel?: string
  /** 最近用过 + 常用，用于「常用」一组 */
  quickModels?: QuickModel[]
  /** 已收藏的模型，决定每行 ★ 的亮灭 */
  favorites?: FavoriteModel[]
  /** 点到模型才触发；和当前值一样时不触发 */
  onSelect: (choice: ModelChoice) => void
  /** 点 ★。starred = 点之前是不是已收藏；返回字符串表示失败原因，会显示在面板底部 */
  onToggleFavorite?: (choice: ModelChoice & { label: string }, starred: boolean) => Promise<string | void> | void
  /** 面板打开时调用，用来刷新常用 / 最近 */
  onOpen?: () => void
  /** 正在切换：按钮显示转圈并禁用 */
  switching?: boolean
  disabled?: boolean
  /** 禁用时悬停显示的说明（为什么不能改、去哪里改）；没给就还是平时的提示 */
  disabledReason?: string
  /** chip = 输入框旁的小按钮；field = 表单里整行的选择框；compact = 列表行里的紧凑小标签（只显示模型名） */
  variant?: "chip" | "field" | "compact"
  /** 面板相对按钮向上还是向下展开（放不下会自动翻面，仅 portal 模式） */
  placement?: "up" | "down"
  /** 面板挂到 body 上，不被带滚动 / overflow 的祖先裁掉 */
  portal?: boolean
  /** 只能选 currentResourceId 这一家的模型：不显示左列，按钮上也不显示供应商 */
  lockProvider?: boolean
  /** 左列顶部加一个「跟随」项（例如「跟随主用户」），选它时 resourceId 为空串 */
  followProvider?: string
  /** 「跟随」项的右列列出哪一家的模型（被跟随的那一家） */
  followResourceId?: string
  /** 顶部加一个「跟随」模型项（模型为空串）；只在模型和被跟随的供应商同源时出现 */
  followModel?: string
  /** 顶部加一个「自动」项（模型为 auto） */
  autoLabel?: string
  /** 搜索框里输入列表里没有的名字，可以直接当模型名用 */
  allowManual?: boolean
  /** 什么都没选时按钮上的文字 */
  placeholder?: string
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

/** 供应商的哪些字段变了，已拉过的模型列表就作废（api key、网关地址都会影响列表） */
const resourceSignature = (resources: AgentResource[]) =>
  resources.map((r) => [r.id, r.type, r.apiKey ?? "", r.baseUrl ?? "", (r.modelIds ?? []).join(",")].join("\u0001")).join("\u0002")

/** 「供应商 / 模型」选择：左列供应商，右列该供应商的模型（常用在前，顶部可搜索），点到模型才生效 */
export default function ModelPicker({
  resources,
  currentResourceId,
  currentModel,
  currentParams,
  currentLabel,
  quickModels = [],
  favorites = [],
  onSelect,
  onToggleFavorite,
  onOpen,
  switching = false,
  disabled = false,
  disabledReason,
  variant = "chip",
  placement = "up",
  portal = false,
  lockProvider = false,
  followProvider,
  followResourceId,
  followModel,
  autoLabel,
  allowManual = false,
  placeholder = "选择供应商 / 模型",
}: Props) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState("")
  /** 右列正在展示的供应商项；打开时默认当前的 */
  const [shownId, setShownId] = useState<string | undefined>()
  const [cache, setCache] = useState<Record<string, ProviderModels>>({})
  const [pos, setPos] = useState<PanelPosition | null>(null)
  const [favError, setFavError] = useState("")
  const rootRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  const generationRef = useRef(0)

  const entries = useMemo(() => buildProviderEntries(resources, followProvider), [resources, followProvider])
  const currentEntry = entries.find((e) => e.id === (currentResourceId ?? ""))
  const visibleEntries = lockProvider ? (currentEntry ? [currentEntry] : []) : entries
  const shownEntry = visibleEntries.find((e) => e.id === shownId) ?? currentEntry ?? visibleEntries[0]
  const listedId = listedResourceId(shownEntry, followResourceId)
  const listedResource = listedId ? resources.find((r) => r.id === listedId) : undefined
  const shownModels = listedId ? cache[listedId] : undefined
  const shownIsCurrent = !!shownEntry && shownEntry.id === currentEntry?.id
  const current = { resourceId: currentResourceId, model: currentModel, params: currentParams }
  const panelWidth = lockProvider ? RIGHT_WIDTH : LEFT_WIDTH + RIGHT_WIDTH

  const close = useCallback(() => setOpen(false), [])

  // 供应商配置变了就丢掉旧的模型列表；在途请求的结果也作废
  const signature = resourceSignature(resources)
  const signatureRef = useRef(signature)
  useEffect(() => {
    if (signatureRef.current === signature) return
    signatureRef.current = signature
    generationRef.current += 1
    setCache({})
  }, [signature])

  // 展示某个供应商且还没拉过时才拉取；失败的结果在下次打开面板时清掉重试
  useEffect(() => {
    if (!open || !listedResource || shownModels) return
    const id = listedResource.id
    const generation = generationRef.current
    setCache((c) => ({ ...c, [id]: { status: "loading" } }))
    void fetchProviderModels(listedResource).then((result) => {
      if (generation !== generationRef.current) return
      setCache((c) => ({ ...c, [id]: result }))
    })
  }, [open, listedResource, shownModels])

  // 点面板外面 / 按 Esc 关闭（面板可能挂在 body 上，所以按钮容器和面板都算「里面」）
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node
      if (rootRef.current?.contains(t) || panelRef.current?.contains(t)) return
      close()
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return
      e.stopPropagation()
      close()
    }
    document.addEventListener("mousedown", onDown)
    document.addEventListener("keydown", onKey, true)
    return () => {
      document.removeEventListener("mousedown", onDown)
      document.removeEventListener("keydown", onKey, true)
    }
  }, [open, close])

  // portal 模式：面板按按钮位置 fixed 定位，滚动 / 缩放时跟着走
  const reposition = useCallback(() => {
    const el = triggerRef.current
    if (!portal || !el) return
    const r = el.getBoundingClientRect()
    setPos(computePanelPosition({
      trigger: r,
      viewport: { width: window.innerWidth, height: window.innerHeight },
      panel: { width: panelWidth, height: PANEL_HEIGHT },
      placement,
    }))
  }, [portal, panelWidth, placement])
  useLayoutEffect(() => {
    if (!open || !portal) return
    reposition()
    window.addEventListener("scroll", reposition, true)
    window.addEventListener("resize", reposition)
    return () => {
      window.removeEventListener("scroll", reposition, true)
      window.removeEventListener("resize", reposition)
    }
  }, [open, portal, reposition])

  const toggle = () => {
    if (open) { close(); return }
    setShownId(undefined)
    setQuery("")
    setFavError("")
    setCache((c) => Object.fromEntries(Object.entries(c).filter(([, v]) => v.status !== "error")))
    setOpen(true)
    onOpen?.()
  }

  const rows = buildRows({
    listed: shownModels?.status === "ok" ? shownModels.models : undefined,
    listedResourceId: listedId,
    quickModels,
    favorites,
    fallbackResourceId: listedResourceId(currentEntry, followResourceId),
    query,
    followModelLabel: followModel && followModelAllowed(shownEntry, followResourceId) ? followModel : undefined,
    autoLabel,
    allowManual,
  })
  const hasRows = rows.head.length + rows.favorites.length + rows.others.length > 0 || !!rows.manual

  const choose = (row: PickerRow) => {
    if (!shownEntry) return
    close()
    if (shownIsCurrent && isCurrentRow(row, current)) return
    onSelect(choiceForRow(row, shownEntry))
  }

  const toggleStar = async (row: PickerRow) => {
    if (!onToggleFavorite || !listedId) return
    setFavError("")
    const err = await onToggleFavorite(favoriteChoiceForRow(row, listedId), row.starred)
    if (typeof err === "string" && err) setFavError(err)
  }

  // 回车：有手输项用它；搜索后只剩一个模型就直接选它
  const onSearchEnter = () => {
    if (rows.manual) { choose(rows.manual); return }
    const candidates = [...rows.favorites, ...rows.others]
    if (query.trim() && candidates.length === 1) choose(candidates[0])
  }

  const text = triggerText({
    entries,
    current,
    currentLabel,
    followResourceId,
    followModelLabel: followModel,
    autoLabel,
    hideProvider: lockProvider || variant === "compact",
    placeholder,
  })
  /** 紧凑标签上不显示供应商，悬停时补在提示里 */
  const providerName = entries.find((e) => e.id === (currentResourceId ?? ""))?.name
  const currentName = providerName && !text.empty ? `${providerName} / ${text.model}` : ""
  const triggerTitle = disabled && disabledReason
    ? (currentName && variant === "compact" ? `${currentName}（${disabledReason}）` : disabledReason)
    : variant === "compact"
      ? (currentName ? `${currentName}（点击切换）` : "切换本会话模型")
      : "切换供应商 / 模型"

  const renderRow = (row: PickerRow) => {
    const cur = shownIsCurrent && isCurrentRow(row, current)
    const starrable = row.starrable && !!onToggleFavorite
    return (
      <div
        key={row.key}
        className={`group flex items-center rounded-lg transition hover:bg-strong/40 ${cur ? "font-medium text-accent" : "text-fg-2"}`}
      >
        <button
          type="button"
          onClick={() => choose(row)}
          className="flex min-w-0 flex-1 items-center gap-2 px-2.5 py-1.5 text-left text-[13px]"
        >
          <span className="min-w-0 flex-1 truncate">{row.label}</span>
          {cur && <Check size={14} className="shrink-0" />}
        </button>
        {starrable && (
          <button
            type="button"
            onClick={() => void toggleStar(row)}
            title={row.starred ? "取消常用" : "加入常用"}
            className={`mr-1 shrink-0 rounded p-1 transition hover:bg-strong/60 ${row.starred ? "text-yellow-500" : "text-fg-faint opacity-0 hover:text-yellow-500 focus:opacity-100 group-hover:opacity-100"}`}
          >
            <Star size={13} className={row.starred ? "fill-current" : ""} />
          </button>
        )}
      </div>
    )
  }

  const panelStyle: CSSProperties | undefined = portal && pos
    ? { left: pos.left, top: pos.top, bottom: pos.bottom, height: pos.height }
    : undefined
  const panelPlace = portal
    ? "fixed z-[9999]"
    : `absolute left-0 z-20 h-80 ${placement === "up" ? "bottom-full mb-2" : "top-full mt-2"}`

  const panel = open && (!portal || pos) && (
    <div ref={panelRef} style={panelStyle} className={`${panelPlace} flex overflow-hidden rounded-xl border border-line bg-page shadow-lg`}>
      {!lockProvider && (
        <div style={{ width: LEFT_WIDTH }} className="shrink-0 space-y-0.5 overflow-y-auto border-r border-line-subtle bg-surface p-1.5">
          {visibleEntries.length === 0 && <p className="px-2.5 py-2 text-xs text-fg-faint">还没有配置供应商</p>}
          {visibleEntries.map((e) => (
            <button
              key={e.id || "follow"}
              type="button"
              onMouseEnter={() => setShownId(e.id)}
              onClick={() => setShownId(e.id)}
              className={`flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-[13px] transition ${e.id === shownEntry?.id ? "bg-strong/50 text-fg" : "text-fg-2"}`}
            >
              <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${e.id === currentEntry?.id ? "bg-accent" : "bg-transparent"}`} />
              <span className="min-w-0 flex-1 truncate">{e.name}</span>
              <ChevronRight size={13} className="shrink-0 text-fg-faint" />
            </button>
          ))}
        </div>
      )}
      <div style={{ width: RIGHT_WIDTH }} className="flex flex-col">
        <div className="shrink-0 border-b border-line-subtle p-1.5">
          <label className="flex items-center gap-2 rounded-lg bg-surface px-2.5 py-1.5">
            <Search size={13} className="shrink-0 text-fg-faint" />
            <input
              autoFocus
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); onSearchEnter() } }}
              placeholder={allowManual ? "搜索或输入模型名" : "搜索模型"}
              className="min-w-0 flex-1 bg-transparent text-[13px] text-fg outline-none placeholder:text-fg-faint"
            />
          </label>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto p-1.5">
          {rows.head.map(renderRow)}
          {rows.favorites.length > 0 && (
            <>
              <p className="flex items-center gap-1 px-2.5 pb-1 pt-1.5 text-[11px] text-fg-faint"><Zap size={11} />常用</p>
              {rows.favorites.map(renderRow)}
            </>
          )}
          {shownEntry?.follow && !listedId && (
            <p className="px-2.5 py-3 text-xs text-fg-faint">主用户还没有选择供应商，选好之后这里会列出它的模型</p>
          )}
          {shownModels?.status === "loading" && (
            <p className="flex items-center gap-2 px-2.5 py-3 text-xs text-fg-muted"><Loader2 size={12} className="animate-spin" />加载模型列表…</p>
          )}
          {shownModels?.status === "error" && (
            <p className="px-2.5 py-3 text-xs text-danger">{shownModels.error}{allowManual ? "；也可以在上面直接输入模型名" : ""}</p>
          )}
          {rows.others.length > 0 && (
            <>
              <p className={`px-2.5 pb-1 pt-1.5 text-[11px] text-fg-faint ${rows.favorites.length > 0 || rows.head.length > 0 ? "mt-1 border-t border-line-subtle pt-2.5" : ""}`}>全部模型</p>
              {rows.others.map(renderRow)}
            </>
          )}
          {rows.manual && (
            <div className={rows.others.length > 0 || rows.favorites.length > 0 ? "mt-1 border-t border-line-subtle pt-1" : ""}>
              {renderRow(rows.manual)}
            </div>
          )}
          {rows.noMatch && <p className="px-2.5 py-3 text-xs text-fg-faint">没有匹配的模型</p>}
          {shownModels?.status === "ok" && !query.trim() && !hasRows && (
            <p className="px-2.5 py-3 text-xs text-fg-faint">该供应商没有可选的模型</p>
          )}
        </div>
        {favError && <p className="shrink-0 border-t border-line-subtle px-2.5 py-1.5 text-xs text-danger">{favError}</p>}
      </div>
    </div>
  )

  const triggerCls = variant === "field"
    ? `flex h-[34px] w-full items-center gap-1.5 rounded-md border bg-raised px-3 text-left text-sm outline-none transition disabled:cursor-not-allowed disabled:opacity-60 ${open ? "border-blue-500" : "border-line hover:border-line-strong"}`
    : variant === "compact"
      ? `inline-flex max-w-[10rem] items-center gap-1 rounded border px-1.5 py-0.5 text-[11px] text-violet transition disabled:cursor-not-allowed disabled:opacity-60 ${open ? "border-violet-500" : "border-line hover:border-violet-500"}`
      : `inline-flex max-w-[22rem] items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-[12.5px] text-fg-2 transition ${open ? "border-accent bg-raised" : "border-line hover:border-line-strong"}`

  return (
    <div className={variant === "field" ? "relative w-full" : "relative"} ref={rootRef}>
      <button
        ref={triggerRef}
        type="button"
        disabled={disabled || switching}
        onClick={toggle}
        title={triggerTitle}
        className={triggerCls}
      >
        {switching && <Loader2 size={variant === "compact" ? 10 : 12} className="shrink-0 animate-spin" />}
        {text.provider && (
          <>
            <span className="shrink-0 text-fg-muted">{text.provider}</span>
            <span className="text-fg-ghost">/</span>
          </>
        )}
        <span className={`min-w-0 truncate ${variant === "field" ? (text.empty ? "flex-1 text-fg-muted" : "flex-1 text-fg") : ""}`}>{text.model}</span>
        <ChevronDown size={variant === "field" ? 14 : variant === "compact" ? 10 : 12} className={`shrink-0 text-fg-faint ${variant === "field" ? "text-fg-muted" : ""}`} />
      </button>
      {portal ? (panel ? createPortal(panel, document.body) : null) : panel}
    </div>
  )
}
