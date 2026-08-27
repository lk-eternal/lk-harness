import { useState, useEffect, useCallback } from "react"
import { Plus, Trash2 } from "lucide-react"
import useInlineModal from "./useInlineModal"
import { usePanelSave } from "./usePanelSave"
import { PANEL_ROOT, PANEL_ASIDE, PANEL_LIST, PANEL_MAIN, PANEL_SCROLL, PANEL_FOOTER } from "./panel-layout"

const inputCls = "w-full rounded-lg border border-gray-700 bg-gray-900 px-3 py-2 text-sm outline-none transition focus:border-blue-500"

interface HarnessRule { id: string; name: string; content: string; enabled: boolean }
interface Draft { id: string | null; name: string; content: string; enabled: boolean }

export default function RulePanel() {
  const { showConfirm, ModalPortal } = useInlineModal()
  const { justSaved, markSaved } = usePanelSave()
  const [rules, setRules] = useState<HarnessRule[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [draft, setDraft] = useState<Draft | null>(null)
  const [savedSnapshot, setSavedSnapshot] = useState("")
  const [isNew, setIsNew] = useState(false)

  const reload = useCallback(() => {
    void window.electronAPI.getHarnessRules().then(setRules)
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
    if (isDirty && !(await showConfirm("未保存", "当前规则有未保存修改，切换将丢弃。继续？", "丢弃", "取消"))) return
    openDraft({ id: r.id, name: r.id, content: r.content, enabled: r.enabled }, false)
  }

  const handleSave = async () => {
    if (!draft || !draft.name.trim()) return
    const r = await window.electronAPI.saveHarnessRule(draft.id, draft.name.trim(), draft.content, draft.enabled)
    if (!r.ok || !r.rule) {
      void showConfirm("保存失败", "规则 ID 已存在或无效，请换一个名称。", "知道了")
      return
    }
    markSaved()
    reload()
    setSelectedId(r.rule.id)
    openDraft({ id: r.rule.id, name: r.rule.id, content: r.rule.content, enabled: r.rule.enabled }, false)
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
    if (isDirty && !(await showConfirm("未保存", "放弃未保存的修改？", "放弃", "取消"))) return
    if (isNew) { setSelectedId(null); setDraft(null) }
    else setDraft(JSON.parse(savedSnapshot) as Draft)
  }

  const openAdd = async () => {
    if (isDirty && !(await showConfirm("未保存", "有未保存修改，继续新增？", "继续", "取消"))) return
    openDraft({ id: null, name: "", content: "", enabled: true }, true)
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
                <span className="truncate">{r.id}</span>
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
