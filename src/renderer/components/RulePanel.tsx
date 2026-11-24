import { useState, useEffect, useCallback, useRef } from "react"
import { createPortal } from "react-dom"
import { Plus, Trash2, ChevronDown, Search, Check, X } from "lucide-react"
import useInlineModal from "./useInlineModal"
import { usePanelSave } from "./usePanelSave"
import { PANEL_ROOT, PANEL_ASIDE, PANEL_LIST, PANEL_ADD_BAR, PANEL_ADD_BTN, PANEL_MAIN, PANEL_SCROLL, PANEL_FOOTER } from "./panel-layout"
import { useScrollActiveIntoView } from "./panel-scroll"
import { useOpenFirstOnce } from "./panel-default"
import { channelScenes } from "../../shared/channel-access"
import type { ChannelType } from "../../shared/channel-types"
import {
  RULE_SCENES,
  RULE_SCENE_LABELS,
  audiencesToScenes,
  describeRuleScope,
  normalizeRuleScope as normalizeScope,
  scenesToScope,
  scopeToUniformScenes,
  scopeUnionScenes,
  type RuleScene,
  type RuleScope,
  type RuleTarget,
} from "../../shared/rule-scope"

const inputCls = "w-full rounded-lg border border-line bg-surface px-3 py-2 text-sm outline-none transition focus:border-focus"

interface HarnessRule { id: string; name: string; content: string; enabled: boolean; scope?: RuleScope }
interface ChannelLite { id: string; name: string; type?: ChannelType }
interface Draft { id: string | null; name: string; content: string; enabled: boolean; scope: RuleScope }

export default function RulePanel() {
  const { showConfirm, showUnsavedChoice, ModalPortal } = useInlineModal()
  const { justSaved, markSaved } = usePanelSave()
  const [rules, setRules] = useState<HarnessRule[]>([])
  const [rulesReady, setRulesReady] = useState(false)
  const [channels, setChannels] = useState<ChannelLite[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [draft, setDraft] = useState<Draft | null>(null)
  const [savedSnapshot, setSavedSnapshot] = useState("")
  const [isNew, setIsNew] = useState(false)

  const reload = useCallback(() => {
    void window.electronAPI.getHarnessRules().then((list) => { setRules(list); setRulesReady(true) })
    void window.electronAPI.getConfig().then((cfg) =>
      setChannels((cfg.channels ?? []).map((c) => ({ id: c.id, name: c.name || c.id, type: c.type })))
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
    // 新规则默认只对「我」生效（含以后新建的通道）；要给别人用，自己勾「其他人私聊 / 群聊」
    openDraft({ id: null, name: "", content: "", enabled: true, scope: { mode: "main" } }, true)
  }

  const scopeHint = (r: HarnessRule) => (channels.length ? describeRuleScope(r.scope, channels) : "")

  const listRef = useRef<HTMLDivElement>(null)
  useScrollActiveIntoView(listRef, selectedId, rules.length)
  useOpenFirstOnce(rulesReady, rules, selectedId !== null || draft !== null, (r) => openDraft({ id: r.id, name: r.id, content: r.content, enabled: r.enabled, scope: normalizeScope(r.scope) }, false))

  return (
    <>
      <div className={PANEL_ROOT}>
        <aside className={PANEL_ASIDE}>
          <div className={PANEL_ADD_BAR}>
            <button type="button" onClick={() => void openAdd()} className={PANEL_ADD_BTN}>
              <Plus size={14} />添加
            </button>
          </div>
          <div ref={listRef} className={PANEL_LIST}>
            {rules.map((r) => (
              <button key={r.id} type="button" onClick={() => void selectRule(r)} aria-current={selectedId === r.id ? "true" : undefined}
                className={`flex w-full items-center gap-2 rounded-md px-2.5 py-2 text-left text-xs transition ${selectedId === r.id ? "bg-raised/70 font-medium text-fg" : "text-fg-3 hover:bg-raised/40 hover:text-fg-soft"}`}>
                <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${r.enabled ? "bg-success" : "bg-stronger"}`} />
                <div className="min-w-0 flex-1">
                  <p className="truncate font-medium">{r.id}</p>
                  <p className="truncate text-[10px] text-fg-faint">{r.enabled ? "已启用" : "已停用"} · {scopeHint(r)}</p>
                </div>
              </button>
            ))}
          </div>
        </aside>
        <div className={PANEL_MAIN}>
          {draft ? (
            <>
              <div className={PANEL_SCROLL}>
                <div className="mb-3 flex items-center gap-2">
                  <label className="flex items-center gap-1.5 text-xs text-fg-3">
                    <input type="checkbox" checked={draft.enabled} onChange={(e) => setDraft({ ...draft, enabled: e.target.checked })}
                      className="rounded border-line-strong bg-surface" />
                    启用
                  </label>
                </div>
                <ScopeEditor scope={draft.scope} channels={channels} onChange={(scope) => setDraft({ ...draft, scope })} />
                <div><label className="mb-1 block text-xs text-fg-muted">规则名</label>
                  <input type="text" value={draft.name}
                    onChange={(e) => setDraft({ ...draft, name: e.target.value })} className={inputCls} placeholder="my-rule" /></div>
                <div><label className="mb-1 block text-xs text-fg-muted">内容</label>
                  <textarea value={draft.content} onChange={(e) => setDraft({ ...draft, content: e.target.value })} rows={20} className={inputCls + " font-mono text-xs leading-relaxed"} /></div>
              </div>
              <div className={PANEL_FOOTER}>
                {!isNew && draft.id && <button type="button" onClick={() => void handleDelete()} className="flex items-center gap-1 rounded-md px-2.5 py-1.5 text-xs text-danger hover:bg-danger-tint/30"><Trash2 size={13} />删除</button>}
                <div className="ml-auto flex items-center gap-2">
                  <button onClick={() => void handleCancel()} className="rounded-md px-4 py-1.5 text-xs text-fg-3 hover:bg-raised hover:text-fg">取消</button>
                  <button onClick={() => void handleSave()} disabled={!draft.name.trim()}
                    className={`rounded-md px-4 py-1.5 text-xs font-medium transition disabled:opacity-40 ${justSaved ? "bg-success-solid text-white" : "bg-primary text-on-primary hover:bg-primary-hover"}`}>
                    {justSaved ? "已保存" : "保存"}
                  </button>
                </div>
              </div>
            </>
          ) : (
            <div className="flex flex-1 items-center justify-center text-sm text-fg-faint">← 选择规则</div>
          )}
        </div>
      </div>
      {ModalPortal}
    </>
  )
}

// ── 生效范围编辑器：勾场景（我 / 其他人私聊 / 群聊），对所有有这个场景的通道生效；
//    需要按通道区别对待时，展开「只限某些通道」逐个选 ───

function ScopeEditor({ scope, channels, onChange }: {
  scope: RuleScope
  channels: ChannelLite[]
  onChange: (s: RuleScope) => void
}) {
  const [advancedOpen, setAdvancedOpen] = useState(false)
  const s = normalizeScope(scope)
  // 通道未加载完时不渲染选项，避免误存（空 custom = 不生效）
  if (channels.length === 0) {
    return (
      <div className="mb-3 space-y-2 rounded-lg border border-line-subtle p-3">
        <p className="text-xs font-medium text-fg-3">生效范围</p>
        <div className="rounded-md border border-line bg-raised px-3 py-2 text-xs text-fg-muted">正在加载通道…</div>
      </div>
    )
  }

  const uniform = scopeToUniformScenes(s, channels)
  const customized = uniform === null
  // 只显示至少有一个通道存在的场景（没有飞书通道时没有「其他人私聊 / 群聊」可选）
  const available = RULE_SCENES.filter((sc) => channels.some((c) => channelScenes(c.type).includes(sc)))
  const channelsWith = (sc: RuleScene) => channels.filter((c) => channelScenes(c.type).includes(sc)).map((c) => c.name)

  const toggleScene = (sc: RuleScene) => {
    const cur = uniform ?? []
    const next = cur.includes(sc) ? cur.filter((x) => x !== sc) : [...cur, sc]
    onChange(scenesToScope(next, channels))
  }

  // 展开前（或已经按通道区别对待过）：targets 来自当前范围；仅主用户模式展开为各通道的「我」
  const targets: RuleTarget[] = s.mode === "custom"
    ? (s.targets ?? [])
    : channels.map((c) => ({ channelId: c.id, audiences: ["main" as const] }))
  const advancedShown = advancedOpen || customized

  return (
    <div className="mb-3 space-y-2 rounded-lg border border-line-subtle p-3">
      <p className="text-xs font-medium text-fg-3">生效范围</p>
      {!customized && (
        <div className="space-y-1.5">
          {available.map((sc) => {
            const where = sc === "main" ? "所有通道" : channelsWith(sc).join("、")
            return (
              <label key={sc} className="flex cursor-pointer items-center gap-2 text-sm text-fg-2">
                <input type="checkbox" checked={uniform.includes(sc)} onChange={() => toggleScene(sc)}
                  className="rounded border-line-strong bg-surface" />
                <span>{RULE_SCENE_LABELS[sc]}</span>
                <span className="truncate text-xs text-fg-faint" title={where}>{where}</span>
              </label>
            )
          })}
          {uniform.length === 0 && <p className="text-xs text-warning">一个都没勾：这条规则不会对任何人生效（只存放）。</p>}
        </div>
      )}
      {customized && (
        <p className="text-xs text-fg-faint">
          这条规则按通道单独设置了生效范围。
          <button type="button" className="ml-1 text-link hover:underline"
            onClick={() => onChange(scenesToScope(scopeUnionScenes(s, channels), channels))}>
            改回统一设置
          </button>
          （按当前各通道选过的场景合并）
        </p>
      )}
      <div>
        {!customized && (
          <button type="button" onClick={() => setAdvancedOpen(!advancedOpen)}
            className="flex items-center gap-1 text-xs text-fg-muted transition hover:text-fg-2">
            <ChevronDown size={12} className={`transition ${advancedShown ? "" : "-rotate-90"}`} />只限某些通道
          </button>
        )}
        {advancedShown && (
          <div className="mt-1.5">
            <AudienceMultiSelect channels={channels} value={targets} onChange={(t) => onChange({ mode: "custom", targets: t })} />
          </div>
        )}
      </div>
    </div>
  )
}

// ── 通道×场景多选下拉：选项=通道里有的场景，选中逐个填充为 chip───

const DROP_MAX_H = 280

function AudienceMultiSelect({ channels, value, onChange }: {
  channels: ChannelLite[]
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
  // 老数据里的「其他人」（others）展开成私聊 + 群聊两个场景显示；微信 / 应用内没有这两个场景，不出现在选项里
  const sceneEntries = (t: RuleTarget) => audiencesToScenes(t.audiences).map((a) => `${t.channelId}|${a}`)
  const picked = new Set(value.flatMap(sceneEntries))
  const options = channels.flatMap((c) => channelScenes(c.type).map((a) => ({
    id: `${c.id}|${a}`,
    label: `${c.name} · ${RULE_SCENE_LABELS[a]}`,
  })))
  const chips = value.flatMap((t) => audiencesToScenes(t.audiences).map((a) => ({
    id: `${t.channelId}|${a}`,
    label: `${nameOf(t.channelId)} · ${RULE_SCENE_LABELS[a]}`,
  })))
  const filtered = query
    ? options.filter((o) => o.label.toLowerCase().includes(query.toLowerCase()))
    : options

  const toggle = (id: string) => {
    const [channelId, audience] = id.split("|") as [string, RuleScene]
    // 先展开成场景再增删（老的 others 变成 dm + group），保存时再由 normalizeRuleScope 归并回 others
    const targets: RuleTarget[] = value.map((t) => ({ channelId: t.channelId, audiences: audiencesToScenes(t.audiences) }))
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
        className="flex min-h-[34px] w-full items-center gap-1.5 rounded-md border border-line bg-raised px-2 py-1 text-left text-sm outline-none transition hover:border-line-strong focus:border-focus"
      >
        <span className="flex min-w-0 flex-1 flex-wrap gap-1">
          {chips.length === 0
            ? <span className="px-1 text-fg-muted">选择生效范围…（不选=不生效）</span>
            : chips.map((c) => (
              <span key={c.id} className="flex max-w-full items-center gap-1 rounded bg-primary/20 px-1.5 py-0.5 text-xs text-accent-bright">
                <span className="truncate" title={c.label}>{c.label}</span>
                <span
                  role="button"
                  tabIndex={-1}
                  onClick={(e) => { e.stopPropagation(); toggle(c.id) }}
                  className="cursor-pointer rounded hover:text-fg"
                  title="移除"
                ><X size={12} /></span>
              </span>
            ))}
        </span>
        <ChevronDown size={14} className={`shrink-0 text-fg-muted transition ${open ? "rotate-180" : ""}`} />
      </button>

      {open && createPortal(
        <div
          ref={dropRef}
          className="fixed z-[9999] flex flex-col rounded-lg border border-line bg-surface shadow-xl"
          style={style}
          onMouseDown={(e) => e.stopPropagation()}
        >
          <div className="flex shrink-0 items-center gap-2 border-b border-line-subtle px-3 py-2">
            <Search size={14} className="text-fg-muted" />
            <input
              ref={inputRef}
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="搜索通道..."
              className="flex-1 bg-transparent text-sm outline-none placeholder:text-fg-faint"
            />
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain py-1" onWheel={(e) => e.stopPropagation()}>
            {channels.length === 0
              ? <div className="px-3 py-2 text-xs text-fg-muted">暂无通道，先去「消息通道」添加。</div>
              : filtered.length === 0
                ? <div className="px-3 py-2 text-xs text-fg-muted">无匹配结果</div>
                : filtered.map((o) => {
                  const checked = picked.has(o.id)
                  return (
                    <button
                      key={o.id}
                      type="button"
                      onClick={() => toggle(o.id)}
                      className={`flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm transition hover:bg-raised ${checked ? "text-accent-soft" : "text-fg-2"}`}
                    >
                      <span className={`flex h-4 w-4 shrink-0 items-center justify-center rounded border ${checked ? "border-primary bg-primary text-on-primary" : "border-line-strong"}`}>
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
