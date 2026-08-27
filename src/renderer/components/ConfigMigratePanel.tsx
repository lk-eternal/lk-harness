import { useEffect, useState } from "react"
import { Download, Upload, ArrowRightLeft, X } from "lucide-react"

type SectionId = string
type ModalMode = "export" | "import" | "migrate" | null

interface SectionItem {
  id: SectionId
  label: string
  count: number
}

interface Props {
  showAlert: (title: string, message: string) => void | Promise<void>
  showConfirm: (title: string, message: string, okLabel?: string, cancelLabel?: string) => Promise<boolean>
  onMigrateSuccess?: () => void
  /** settings=三按钮；wizard=仅导入+迁移 */
  variant?: "settings" | "wizard"
}

function countLabel(item: SectionItem): string | null {
  if (item.count <= 0) return null
  return `${item.count} 个${item.label}`
}

export default function ConfigMigratePanel({ showAlert, onMigrateSuccess, variant = "settings" }: Props) {
  const [busy, setBusy] = useState("")
  const [hasClaw, setHasClaw] = useState(false)
  const [modal, setModal] = useState<ModalMode>(null)
  const [modalItems, setModalItems] = useState<SectionItem[]>([])
  const [selected, setSelected] = useState<Set<SectionId>>(() => new Set())
  const [importPath, setImportPath] = useState("")

  useEffect(() => {
    void window.electronAPI.discoverCursorClawInstalls()
      .then((list) => setHasClaw(list.length > 0))
      .catch(() => setHasClaw(false))
  }, [])

  const openModal = (mode: ModalMode, items: SectionItem[], extra?: { importPath?: string }) => {
    setModal(mode)
    setModalItems(items)
    setSelected(new Set(items.map((i) => i.id)))
    setImportPath(extra?.importPath ?? "")
  }

  const closeModal = () => {
    setModal(null)
    setModalItems([])
    setSelected(new Set())
    setImportPath("")
  }

  const toggle = (id: SectionId) => {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const pickedSections = (): SectionId[] => modalItems.filter((i) => selected.has(i.id)).map((i) => i.id)

  const modalTitle = modal === "export" ? "导出配置"
    : modal === "import" ? "导入配置"
      : modal === "migrate" ? "从 Cursor Claw 迁移"
        : ""

  const modalHint = modal === "export"
    ? "勾选要导出的模块。导出文件含明文密钥，请妥善保管。"
    : modal === "import"
      ? "已识别配置包内的模块，勾选要导入的项（**仅新增**，本地已存在的 skill/规则/MCP/通道等会跳过）。"
      : "已识别 Cursor Claw 中可迁移的模块，勾选要写入的项（**仅新增**，本地已存在项会跳过）。"

  const confirmModal = async () => {
    const s = pickedSections()
    if (!s.length) {
      await showAlert("请选择模块", "至少勾选一个模块。")
      return
    }
    if (modal === "export") {
      closeModal()
      setBusy("export")
      try {
        const r = await window.electronAPI.exportConfig(s)
        if (r.ok && r.path) await showAlert("导出成功", r.path)
        else if (!r.ok && r.error !== "已取消") await showAlert("导出失败", r.error ?? "未知错误")
      } finally {
        setBusy("")
      }
      return
    }
    if (modal === "import") {
      if (!importPath) return
      closeModal()
      setBusy("import")
      try {
        const r = await window.electronAPI.importConfig(importPath, s)
        if (!r.ok) {
          if (r.error !== "已取消") await showAlert("导入失败", r.error ?? "未知错误")
          return
        }
        const skips = r.warnings?.filter((w) => w.includes("已跳过")) ?? []
        const errs = r.warnings?.filter((w) => !w.includes("已跳过")) ?? []
        const skipNote = skips.length ? `\n\n提示：\n${skips.join("\n")}` : ""
        const errNote = errs.length ? `\n\n警告：\n${errs.join("\n")}` : ""
        await showAlert("导入成功", `已应用所选模块。${skipNote}${errNote}`)
        if (variant === "wizard") onMigrateSuccess?.()
      } finally {
        setBusy("")
      }
      return
    }
    if (modal === "migrate") {
      closeModal()
      setBusy("migrate")
      try {
        const r = await window.electronAPI.migrateFromCursorClaw(undefined, s)
        if (!r.ok) {
          await showAlert("迁移失败", r.error ?? "未知错误")
          return
        }
        const warn = r.warnings?.length ? `\n\n提示：\n${r.warnings.join("\n")}` : ""
        await showAlert("迁移成功", `已从 Cursor Claw 写入所选模块。${warn}`)
        onMigrateSuccess?.()
      } finally {
        setBusy("")
      }
    }
  }

  return (
    <>
      <div className="space-y-3">
        {variant === "settings" && (
          <p className="text-xs text-gray-600">导出/导入 LK Harness 配置包；或从 Cursor Claw 一键迁移。</p>
        )}
        <div className={`flex flex-wrap gap-2 ${variant === "wizard" ? "justify-center" : ""}`}>
          {variant === "settings" && (
            <button
              type="button"
              disabled={!!busy}
              onClick={async () => {
                setBusy("export-prep")
                try {
                  const items = await window.electronAPI.getLocalConfigSectionStats()
                  openModal("export", items)
                } finally {
                  setBusy("")
                }
              }}
              className="flex items-center gap-2 rounded-lg border border-gray-700 px-4 py-2 text-sm transition hover:border-blue-500 disabled:opacity-50"
            >
              <Download size={16} /> 导出配置
            </button>
          )}
          <button
            type="button"
            disabled={!!busy}
            onClick={async () => {
              setBusy("pick-import")
              try {
                const r = await window.electronAPI.pickImportConfigFile()
                if (!r.ok) {
                  if (r.error !== "已取消") await showAlert("无法读取配置包", r.error ?? "未知错误")
                  return
                }
                if (!r.filePath || !r.items?.length) {
                  await showAlert("无法读取配置包", "未识别到可导入模块。")
                  return
                }
                openModal("import", r.items, { importPath: r.filePath })
              } finally {
                setBusy("")
              }
            }}
            className="flex items-center gap-2 rounded-lg border border-gray-700 px-4 py-2 text-sm transition hover:border-blue-500 disabled:opacity-50"
          >
            <Upload size={16} /> 导入配置
          </button>
          <button
            type="button"
            disabled={!!busy || !hasClaw}
            onClick={async () => {
              setBusy("inspect-migrate")
              try {
                const r = await window.electronAPI.inspectCursorClawSections()
                if (!r.ok) {
                  await showAlert("无法迁移", r.error ?? "未知错误")
                  return
                }
                if (!r.items?.length) {
                  await showAlert("无法迁移", "未识别到可迁移模块。")
                  return
                }
                openModal("migrate", r.items)
              } finally {
                setBusy("")
              }
            }}
            className="flex items-center gap-2 rounded-lg border border-amber-700/60 bg-amber-500/10 px-4 py-2 text-sm transition hover:border-amber-500 disabled:opacity-50"
          >
            <ArrowRightLeft size={16} /> 从 Cursor Claw 迁移
          </button>
        </div>
        {!hasClaw && variant === "settings" && (
          <p className="text-xs text-gray-600">未检测到 Cursor Claw 数据目录。</p>
        )}
      </div>

      {modal && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/60 p-4">
          <div className="flex max-h-[85vh] w-full max-w-md flex-col rounded-xl border border-gray-700 bg-gray-900 shadow-2xl">
            <div className="flex items-center justify-between border-b border-gray-800 px-5 py-4">
              <h3 className="text-sm font-semibold text-gray-100">{modalTitle}</h3>
              <button type="button" onClick={closeModal} className="text-gray-500 hover:text-white"><X size={16} /></button>
            </div>
            <div className="flex-1 overflow-y-auto px-5 py-4">
              <p className="mb-3 text-xs text-gray-500">{modalHint}</p>
              <div className="space-y-2">
                {modalItems.map((item) => {
                  const badge = countLabel(item)
                  return (
                    <label
                      key={item.id}
                      className={`flex cursor-pointer items-center gap-2 rounded-lg border px-3 py-2 text-sm transition ${selected.has(item.id) ? "border-blue-500 bg-blue-500/10" : "border-gray-700 hover:border-gray-600"}`}
                    >
                      <input
                        type="checkbox"
                        checked={selected.has(item.id)}
                        onChange={() => toggle(item.id)}
                        className="rounded border-gray-600"
                      />
                      <span className="flex-1">{item.label}</span>
                      {badge && <span className="shrink-0 text-xs text-gray-500">{badge}</span>}
                    </label>
                  )
                })}
              </div>
            </div>
            <div className="flex justify-end gap-2 border-t border-gray-800 px-5 py-4">
              <button type="button" onClick={closeModal} className="rounded-md px-4 py-1.5 text-xs text-gray-400 hover:bg-gray-800">取消</button>
              <button
                type="button"
                onClick={() => void confirmModal()}
                disabled={!pickedSections().length}
                className="rounded-md bg-blue-600 px-4 py-1.5 text-xs font-medium text-white hover:bg-blue-500 disabled:opacity-40"
              >
                确定
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  )
}
