import { useState, useEffect, useCallback } from "react"
import { Plus, Trash2 } from "lucide-react"
import useInlineModal from "./useInlineModal"
import { usePanelSave } from "./usePanelSave"
import { PANEL_ROOT, PANEL_ASIDE, PANEL_LIST, PANEL_MAIN, PANEL_SCROLL, PANEL_FOOTER } from "./panel-layout"

const inputCls = "w-full rounded-lg border border-gray-700 bg-gray-900 px-3 py-2 text-sm outline-none transition focus:border-blue-500"

interface RuleFile { rootId: string; name: string; content: string }

export default function RulePanel() {
  const { showConfirm, ModalPortal } = useInlineModal()
  const { justSaved, markSaved } = usePanelSave()
  const [ruleRoots, setRuleRoots] = useState<{ id: string; label: string; path: string; ruleCount: number }[]>([])
  const [ruleRootId, setRuleRootId] = useState("cursor")
  const [rules, setRules] = useState<RuleFile[]>([])
  const [selectedKey, setSelectedKey] = useState<string | null>(null)
  const [draft, setDraft] = useState<RuleFile | null>(null)
  const [originalName, setOriginalName] = useState<string | null>(null)
  const [savedSnapshot, setSavedSnapshot] = useState("")
  const [isNew, setIsNew] = useState(false)

  const entryKey = (r: RuleFile) => `${r.rootId}:${r.name}`

  const reloadRoots = useCallback(() => {
    void window.electronAPI.getRuleRoots().then((roots) => {
      setRuleRoots(roots)
      if (!roots.some((r) => r.id === ruleRootId) && roots[0]) setRuleRootId(roots[0].id)
    })
  }, [ruleRootId])

  const reload = useCallback(() => {
    void window.electronAPI.getRules(ruleRootId).then(setRules)
  }, [ruleRootId])

  useEffect(() => { reloadRoots() }, [reloadRoots])
  useEffect(() => { reload() }, [reload])

  const isDirty = draft ? JSON.stringify(draft) !== savedSnapshot : false

  const openDraft = (r: RuleFile, asNew: boolean, orig: string | null) => {
    setSelectedKey(entryKey(r))
    setDraft({ ...r })
    setOriginalName(orig)
    setSavedSnapshot(JSON.stringify(r))
    setIsNew(asNew)
  }

  const selectRule = async (r: RuleFile) => {
    if (isDirty && !(await showConfirm("未保存", "当前 Rule 有未保存修改，切换将丢弃。继续？", "丢弃", "取消"))) return
    openDraft(r, false, r.name)
  }

  const handleSave = async () => {
    if (!draft || !draft.name.trim()) return
    if (originalName && originalName !== draft.name) {
      await window.electronAPI.deleteRule(draft.rootId, originalName)
    }
    let name = draft.name.trim()
    if (!name.endsWith(".mdc") && !name.endsWith(".md")) name += ".mdc"
    const r = await window.electronAPI.saveRule(draft.rootId, name, draft.content)
    if (!r.ok) return
    markSaved()
    reload()
    reloadRoots()
    openDraft({ rootId: draft.rootId, name, content: draft.content }, false, name)
  }

  const handleDelete = async () => {
    if (!draft || isNew) return
    if (!(await showConfirm("删除 Rule", `确定删除「${draft.name}」？`))) return
    await window.electronAPI.deleteRule(draft.rootId, draft.name)
    reload()
    reloadRoots()
    setSelectedKey(null)
    setDraft(null)
  }

  const handleCancel = async () => {
    if (isDirty && !(await showConfirm("未保存", "放弃未保存的修改？", "放弃", "取消"))) return
    if (isNew) { setSelectedKey(null); setDraft(null) }
    else setDraft(JSON.parse(savedSnapshot) as RuleFile)
  }

  const openAdd = async () => {
    if (isDirty && !(await showConfirm("未保存", "有未保存修改，继续新增？", "继续", "取消"))) return
    openDraft({ rootId: ruleRootId, name: "", content: "" }, true, null)
  }

  return (
    <>
      <div className={PANEL_ROOT}>
        <aside className={PANEL_ASIDE}>
          <div className="mb-2 flex flex-wrap gap-1">
            {ruleRoots.map((root) => (
              <button key={root.id} type="button" onClick={() => setRuleRootId(root.id)}
                className={`rounded-md border px-2 py-0.5 text-[10px] transition ${ruleRootId === root.id ? "border-blue-500 bg-blue-500/10 text-white" : "border-gray-700 text-gray-500 hover:bg-gray-800"}`}>
                {root.label.replace(/^~\//, "~/")}
              </button>
            ))}
          </div>
          <div className={PANEL_LIST}>
            {rules.map((r) => {
              const key = entryKey(r)
              return (
                <button key={key} type="button" onClick={() => void selectRule(r)}
                  className={`flex w-full rounded-md px-2.5 py-2 text-left text-xs transition ${selectedKey === key ? "bg-gray-800/70 font-medium text-white" : "text-gray-400 hover:bg-gray-800/40 hover:text-gray-200"}`}>
                  <span className="truncate">{r.name}</span>
                </button>
              )
            })}
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
                <div><label className="mb-1 block text-xs text-gray-500">文件名</label>
                  <input type="text" value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} className={inputCls} placeholder="my-rule.mdc" /></div>
                <div><label className="mb-1 block text-xs text-gray-500">内容</label>
                  <textarea value={draft.content} onChange={(e) => setDraft({ ...draft, content: e.target.value })} rows={20} className={inputCls + " font-mono text-xs leading-relaxed"} /></div>
              </div>
              <div className={PANEL_FOOTER}>
                {!isNew && <button type="button" onClick={() => void handleDelete()} className="flex items-center gap-1 rounded-md px-2.5 py-1.5 text-xs text-red-400 hover:bg-red-950/30"><Trash2 size={13} />删除</button>}
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
            <div className="flex flex-1 items-center justify-center text-sm text-gray-600">← 选择 Rule</div>
          )}
        </div>
      </div>
      {ModalPortal}
    </>
  )
}
