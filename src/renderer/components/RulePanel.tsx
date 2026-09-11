import { useState, useEffect, useCallback, useRef } from "react"
import { createPortal } from "react-dom"
import { Plus, Trash2, ChevronDown, Search, Check, X } from "lucide-react"
import useInlineModal from "./useInlineModal"
import { usePanelSave } from "./usePanelSave"
import { PANEL_ROOT, PANEL_ASIDE, PANEL_LIST, PANEL_MAIN, PANEL_SCROLL, PANEL_FOOTER } from "./panel-layout"

const inputCls = "w-full rounded-lg border border-gray-700 bg-gray-900 px-3 py-2 text-sm outline-none transition focus:border-blue-500"

function normalizeScope(scope?: RuleScope): RuleScope {
  if (!scope || scope.mode !== "custom") return { mode: "main" }
  const targets = (scope.targets ?? [])
    .filter((t) => t?.channelId)
    .map((t) => ({ channelId: t.channelId, audiences: [...new Set(t.audiences.filter((a) => a === "main" || a === "others"))] as ("main" | "others")[] }))
    .filter((t) => t.audiences.length > 0)
  return { mode: "custom", targets }
}

interface HarnessRule { id: string; name: string; content: string; enabled: boolean; scope?: RuleScope }
interface RuleTarget { channelId: string; audiences: ("main" | "others")[] }
interface RuleScope { mode: "main" | "custom"; targets?: RuleTarget[] }
interface ChannelLite { id: string; name: string }
interface Draft { id: string | null; name: string; content: string; enabled: boolean; scope: RuleScope }

export default function RulePanel() {
  const { showConfirm, showUnsavedChoice, ModalPortal } = useInlineModal()
  const { justSaved, markSaved } = usePanelSave()
  const [rules, setRules] = useState<HarnessRule[]>([])
  const [channels, setChannels] = useState<ChannelLite[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [draft, setDraft] = useState<Draft | null>(null)
  const [savedSnapshot, setSavedSnapshot] = useState("")
  const [isNew, setIsNew] = useState(false)

  const reload = useCallback(() => {
    void window.electronAPI.getHarnessRules().then(setRules)
    void window.electronAPI.getConfig().then((cfg) =>
      setChannels((cfg.channels ?? []).map((c) => ({ id: c.id, name: c.name || c.id })))
    )
  }, [])

  useEffect(() => { reload() }, [reload])

  const isDirty = draft ? JSON.stringify(draft) !== savedSnapshot : false

  const openDraft = (d: Draft, asNew: boolean) => {
    setSelectedId(d.id)
    setDraft(d)
    setSavedSnapshot(JSON.stringify(d))
    setIsNew(asNew)
  }

  const selectRule = async (r: HarnessRule) => {
    if (!(await guardUnsaved("保存并切换"))) return
    openDraft({ id: r.id, name: r.id, content: r.content, enabled: r.enabled, scope: normalizeScope(r.scope) }, false)
  }

  const handleSave = async () => {
    if (!draft || !draft.name.trim()) return false
    const scope = normalizeScope(draft.scope)
    const r = await window.electronAPI.saveHarnessRule(draft.id, draft.name.trim(), draft.content, draft.enabled, scope)
    if (!r.ok || !r.rule) {
      void showConfirm("保存失败", "规则 ID 已存在或无效，请换一个名称。", "知道了")
      return false
    }
    markSaved()
    reload()
    setSelectedId(r.rule.id)
    openDraft({ id: r.rule.id, name: r.rule.id, content: r.rule.content, enabled: r.rule.enabled, scope: normalizeScope(r.rule.scope) }, false)
    return true
  }

  /** 未保存守卫：保存并继续 / 丢弃 / 取消 */
  const guardUnsaved = async (saveLabel: string, discardLabel = "丢弃") => {
    if (!isDirty) return true
    const choice = await showUnsavedChoice("未保存", "当前规则有未保存的修改，怎么办？", { save: saveLabel, discard: discardLabel })
    if (choice === "cancel") return false
    if (choice === "save") return handleSave()
    return true
  }

  const handleDelete = async () => {
    if (!draft?.id || isNew) return
    if (!(await showConfirm("删除规则", `确定删除「${draft.id}」？`))) return
    await window.electronAPI.deleteHarnessRule(draft.id)
    reload()
    setSelectedId(null)
    setDraft(null)
  }

  const handleCancel = async () => {
    if (!(await guardUnsaved("保存", "放弃"))) return
    if (isNew) { setSelectedId(null); setDraft(null) }
    else setDraft(JSON.parse(savedSnapshot) as Draft)
  }

  const openAdd = async () => {
    if (!(await guardUnsaved("保存并继续"))) return
    openDraft({ id: null, name: "", content: "", enabled: true, scope: { mode: "custom", targets: [] } }, true)
  }

  const scopeHint = (r: HarnessRule) => {
    const s = normalizeScope(r.scope)
    if (s.mode !== "custom") return "仅主用户"
    const n = (s.targets ?? []).reduce((k, t) => k + t.audiences.length, 0)
    if (!n) return "不生效"
    return `${n} 项`
  }

  return (
    <>
      <div className={PANEL_ROOT}>
        <aside className={PANEL_ASIDE}>
          <div className={PANEL_LIST}>
            {rules.map((r) => (
              <button key={r.id} type="button" onClick={() => void selectRule(r)}
                className={`flex w-full items-center gap-2 rounded-md px-2.5 py-2 text-left text-xs transition ${selectedId === r.id ? "bg-gray-800/70 font-medium text-white" : "text-gray-400 hover:bg-gray-800/40 hover:text-gray-200"}`}>
                <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${r.enabled ? "bg-green-500" : "bg-gray-600"}`} />
                <div className="min-w-0 flex-1">
                  <p className="truncate font-medium">{r.id}</p>
                  <p className="truncate text-[10px] text-gray-600">{r.enabled ? "已启用" : "已停用"} · {scopeHint(r)}</p>
                </div>
              </button>
            ))}
            <button type="button" onClick={() => void openAdd()}
              className="flex w-full items-center justify-center gap-1 rounded-lg border border-dashed border-gray-700 py-2 text-xs text-gray-500 hover:border-gray-600 hover:bg-gray-800/40 hover:text-gray-300">
              <Plus size={14} />添加
            </button>
          </div>
        </aside>
        <div className={PANEL_MAIN}>
          {draft ? (
            <>
              <div className={PANEL_SCROLL}>
                <div className="mb-3 flex items-center gap-2">
                  <label className="flex items-center gap-1.5 text-xs text-gray-400">
                    <input type="checkbox" checked={draft.enabled} onChange={(e) => setDraft({ ...draft, enabled: e.target.checked })}
                      className="rounded border-gray-600 bg-gray-900" />
                    启用
                  </label>
                </div>
                <ScopeEditor scope={draft.scope} channels={channels} onChange={(scope) => setDraft({ ...draft, scope })} />
                <div><label className="mb-1 block text-xs text-gray-500">规则名</label>
                  <input type="text" value={draft.name}
                    onChange={(e) => setDraft({ ...draft, name: e.target.value })} className={inputCls} placeholder="my-rule" /></div>
                <div><label className="mb-1 block text-xs text-gray-500">内容</label>
                  <textarea value={draft.content} onChange={(e) => setDraft({ ...draft, content: e.target.value })} rows={20} className={inputCls + " font-mono text-xs leading-relaxed"} /></div>
              </div>
              <div className={PANEL_FOOTER}>
                {!isNew && draft.id && <button type="button" onClick={() => void handleDelete()} className="flex items-center gap-1 rounded-md px-2.5 py-1.5 text-xs text-red-400 hover:bg-red-950/30"><Trash2 size={13} />删除</button>}
                <div className="ml-auto flex items-center gap-2">
                  <button onClick={() => void handleCancel()} className="rounded-md px-4 py-1.5 text-xs text-gray-400 hover:bg-gray-800 hover:text-white">取消</button>
                  <button onClick={() => void handleSave()} disabled={!draft.name.trim()}
                    className={`rounded-md px-4 py-1.5 text-xs font-medium transition disabled:opacity-40 ${justSaved ? "bg-green-600 text-white" : "bg-blue-600 text-white hover:bg-blue-500"}`}>
                    {justSaved ? "已保存" : "保存"}
                  </button>
                </div>
              </div>
            </>
          ) : (
            <div className="flex flex-1 items-center justify-center text-sm text-gray-600">← 选择 Claw 规则</div>
          )}
        </div>
      </div>
      {ModalPortal}
    </>
  )
}

// ── 生效范围编辑器：仅主用户（默认） / 自定义（按通道×主·其他多选）───

function ScopeEditor({ scope, channels, onChange }: {
  scope: RuleScope
  channels: { id: string; name: string }[]
  onChange: (s: RuleScope) => void
}) {
  const s = normalizeScope(scope)
  // 无单选：框即范围。遗留 main 模式展开为当前各通道主用户 chip，一经改动即落为显式 custom；
  // 通道未加载完时不展开为空框，避免误存（空 custom = 不生效）
  if (s.mode !== "custom" && channels.length === 0) {
    return (
      <div className="mb-3 space-y-2 rounded-lg border border-gray-800 p-3">
        <p className="text-xs font-medium text-gray-400">生效范围</p>
        <div className="rounded-md border border-gray-700 bg-gray-800 px-3 py-2 text-xs text-gray-500">正在加载通道…</div>
      </div>
    )
  }
  const targets: RuleTarget[] = s.mode === "custom"
    ? (s.targets ?? [])
    : channels.map((c) => ({ channelId: c.id, audiences: ["main" as const] }))
  return (
    <div className="mb-3 space-y-2 rounded-lg border border-gray-800 p-3">
      <p className="text-xs font-medium text-gray-400">生效范围</p>
      <AudienceMultiSelect channels={channels} value={targets} onChange={(t) => onChange({ mode: "custom", targets: t })} />
    </div>
  )
}

// ── 生效范围多选下拉：选项=通道×人群，选中逐个填充为 chip───

const AUDIENCE_LABEL: Record<"main" | "others", string> = { main: "主用户", others: "其他人" }
const DROP_MAX_H = 280

function AudienceMultiSelect({ channels, value, onChange }: {
  channels: { id: string; name: string }[]
  value: RuleTarget[]
  onChange: (targets: RuleTarget[]) => void
}) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState("")
  const [style, setStyle] = useState<React.CSSProperties>({})
  const btnRef = useRef<HTMLButtonElement>(null)
  const dropRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  const nameOf = (id: string) => channels.find((c) => c.id === id)?.name ?? id
  const picked = new Set(value.flatMap((t) => t.audiences.map((a) => `${t.channelId}|${a}`)))
  const options = channels.flatMap((c) => (["main", "others"] as const).map((a) => ({
    id: `${c.id}|${a}`,
    label: `${c.name} · ${AUDIENCE_LABEL[a]}`,
  })))
  const chips = value.flatMap((t) => t.audiences.map((a) => ({
    id: `${t.channelId}|${a}`,
    label: `${nameOf(t.channelId)} · ${AUDIENCE_LABEL[a]}`,
  })))
  const filtered = query
    ? options.filter((o) => o.label.toLowerCase().includes(query.toLowerCase()))
    : options

  const toggle = (id: string) => {
    const [channelId, audience] = id.split("|") as [string, "main" | "others"]
    const targets = value.map((t) => ({ channelId: t.channelId, audiences: [...t.audiences] }))
    const hit = targets.find((t) => t.channelId === channelId)
    if (!hit) targets.push({ channelId, audiences: [audience] })
    else if (hit.audiences.includes(audience)) {
      hit.audiences = hit.audiences.filter((a) => a !== audience)
      if (!hit.audiences.length) targets.splice(targets.indexOf(hit), 1)
    } else hit.audiences.push(audience)
    onChange(targets)
  }

  const reposition = useCallback(() => {
    if (!btnRef.current) return
    const r = btnRef.current.getBoundingClientRect()
    const spaceBelow = window.innerHeight - r.bottom - 8
    const spaceAbove = r.top - 8
    if (spaceBelow < DROP_MAX_H && spaceAbove > spaceBelow) {
      setStyle({ bottom: window.innerHeight - r.top + 4, left: r.left, width: r.width, maxHeight: Math.min(spaceAbove, DROP_MAX_H) })
    } else {
      setStyle({ top: r.bottom + 4, left: r.left, width: r.width, maxHeight: Math.min(spaceBelow, DROP_MAX_H) })
    }
  }, [])

  useEffect(() => {
    if (!open) return
    reposition()
    inputRef.current?.focus({ preventScroll: true })
    const onLayout = () => reposition()
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false) }
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node
      if (btnRef.current?.contains(t) || dropRef.current?.contains(t)) return
      setOpen(false)
    }
    window.addEventListener("scroll", onLayout, true)
    window.addEventListener("resize", onLayout)
    document.addEventListener("keydown", onKey)
    document.addEventListener("mousedown", onDown)
    return () => {
      window.removeEventListener("scroll", onLayout, true)
      window.removeEventListener("resize", onLayout)
      document.removeEventListener("keydown", onKey)
      document.removeEventListener("mousedown", onDown)
    }
  }, [open, reposition])

  return (
    <>
      <button
        ref={btnRef}
        type="button"
        onClick={() => { setOpen(!open); setQuery("") }}
        className="flex min-h-[34px] w-full items-center gap-1.5 rounded-md border border-gray-700 bg-gray-800 px-2 py-1 text-left text-sm outline-none transition hover:border-gray-600 focus:border-blue-500"
      >
        <span className="flex min-w-0 flex-1 flex-wrap gap-1">
          {chips.length === 0
            ? <span className="px-1 text-gray-500">选择生效范围…（不选=不生效）</span>
            : chips.map((c) => (
              <span key={c.id} className="flex max-w-full items-center gap-1 rounded bg-blue-600/25 px-1.5 py-0.5 text-xs text-blue-200">
                <span className="truncate" title={c.label}>{c.label}</span>
                <span
                  role="button"
                  tabIndex={-1}
                  onClick={(e) => { e.stopPropagation(); toggle(c.id) }}
                  className="cursor-pointer rounded hover:text-white"
                  title="移除"
                ><X size={12} /></span>
              </span>
            ))}
        </span>
        <ChevronDown size={14} className={`shrink-0 text-gray-500 transition ${open ? "rotate-180" : ""}`} />
      </button>

      {open && createPortal(
        <div
          ref={dropRef}
          className="fixed z-[9999] flex flex-col rounded-lg border border-gray-700 bg-gray-900 shadow-xl"
          style={style}
          onMouseDown={(e) => e.stopPropagation()}
        >
          <div className="flex shrink-0 items-center gap-2 border-b border-gray-800 px-3 py-2">
            <Search size={14} className="text-gray-500" />
            <input
              ref={inputRef}
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="搜索通道..."
              className="flex-1 bg-transparent text-sm outline-none placeholder:text-gray-600"
            />
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain py-1" onWheel={(e) => e.stopPropagation()}>
            {channels.length === 0
              ? <div className="px-3 py-2 text-xs text-gray-500">暂无通道，先去「消息通道」添加。</div>
              : filtered.length === 0
                ? <div className="px-3 py-2 text-xs text-gray-500">无匹配结果</div>
                : filtered.map((o) => {
                  const checked = picked.has(o.id)
                  return (
                    <button
                      key={o.id}
                      type="button"
                      onClick={() => toggle(o.id)}
                      className={`flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm transition hover:bg-gray-800 ${checked ? "text-blue-300" : "text-gray-300"}`}
                    >
                      <span className={`flex h-4 w-4 shrink-0 items-center justify-center rounded border ${checked ? "border-blue-500 bg-blue-600" : "border-gray-600"}`}>
                        {checked && <Check size={12} />}
                      </span>
                      <span className="truncate" title={o.label}>{o.label}</span>
                    </button>
                  )
                })}
          </div>
        </div>,
        document.body
      )}
    </>
  )
}
