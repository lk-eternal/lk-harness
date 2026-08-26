import { useEffect, useState } from "react"
import { Download, Upload, ArrowRightLeft } from "lucide-react"

const SECTIONS = [
  { id: "general", label: "通用设置" },
  { id: "proxy", label: "网络代理" },
  { id: "agent", label: "Agent 资源" },
  { id: "channels", label: "消息通道" },
  { id: "projects", label: "项目设置" },
  { id: "mcp", label: "MCP 服务器" },
  { id: "rules", label: "Harness 规则" },
  { id: "tasks", label: "定时任务" },
  { id: "skills", label: "Skills 脚本" },
] as const

type SectionId = (typeof SECTIONS)[number]["id"]

interface Props {
  showAlert: (title: string, message: string) => void | Promise<void>
  showConfirm: (title: string, message: string, okLabel?: string, cancelLabel?: string) => Promise<boolean>
  onMigrateSuccess?: () => void
  compact?: boolean
}

export default function ConfigMigratePanel({ showAlert, showConfirm, onMigrateSuccess, compact }: Props) {
  const [selected, setSelected] = useState<Set<SectionId>>(() => new Set(SECTIONS.map((s) => s.id)))
  const [busy, setBusy] = useState("")
  const [installs, setInstalls] = useState<{ label: string; userDataPath: string }[]>([])
  const [pickPath, setPickPath] = useState("")

  useEffect(() => {
    void window.electronAPI.discoverCursorClawInstalls().then((list) => {
      setInstalls(list)
      if (list[0]) setPickPath(list[0].userDataPath)
    }).catch(() => {})
  }, [])

  const sections = () => [...selected]

  const toggle = (id: SectionId) => {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const ensureSections = (): string[] | null => {
    const s = sections()
    if (!s.length) {
      void showAlert("请选择模块", "至少勾选一个要导出/导入/迁移的模块。")
      return null
    }
    return s
  }

  return (
    <div className="space-y-3">
      {!compact && (
        <p className="text-xs text-gray-600">
          勾选要处理的模块。导出文件含明文密钥，请妥善保管。
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        {SECTIONS.map((s) => (
          <label
            key={s.id}
            className={`flex cursor-pointer items-center gap-1.5 rounded-md border px-2.5 py-1.5 text-xs transition ${selected.has(s.id) ? "border-blue-500 bg-blue-500/10" : "border-gray-700 hover:border-gray-600"}`}
          >
            <input
              type="checkbox"
              checked={selected.has(s.id)}
              onChange={() => toggle(s.id)}
              className="rounded border-gray-600"
            />
            {s.label}
          </label>
        ))}
      </div>
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          disabled={!!busy}
          onClick={async () => {
            const s = ensureSections()
            if (!s) return
            setBusy("export")
            try {
              const r = await window.electronAPI.exportConfig(s)
              if (r.ok && r.path) await showAlert("导出成功", r.path)
              else if (!r.ok && r.error !== "已取消") await showAlert("导出失败", r.error ?? "未知错误")
            } finally {
              setBusy("")
            }
          }}
          className="flex items-center gap-2 rounded-lg border border-gray-700 px-4 py-2 text-sm transition hover:border-blue-500 disabled:opacity-50"
        >
          <Download size={16} /> 导出配置
        </button>
        <button
          type="button"
          disabled={!!busy}
          onClick={async () => {
            const s = ensureSections()
            if (!s) return
            if (!(await showConfirm(
              "导入配置",
              `将覆盖已勾选模块（${s.length} 项）。确定继续？`,
              "导入",
              "取消",
            ))) return
            setBusy("import")
            try {
              const r = await window.electronAPI.importConfig(s)
              if (!r.ok) {
                if (r.error !== "已取消") await showAlert("导入失败", r.error ?? "未知错误")
                return
              }
              const warn = r.warnings?.length ? `\n\n警告：\n${r.warnings.join("\n")}` : ""
              await showAlert("导入成功", `已应用所选模块。${warn}`)
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
          disabled={!!busy || !pickPath}
          onClick={async () => {
            const s = ensureSections()
            if (!s || !pickPath) return
            if (!(await showConfirm(
              "从 Cursor Claw 迁移",
              `将从本机 Cursor Claw 读取并写入已勾选模块（${s.length} 项）。确定继续？`,
              "迁移",
              "取消",
            ))) return
            setBusy("migrate")
            try {
              const r = await window.electronAPI.migrateFromCursorClaw(pickPath, s)
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
          }}
          className="flex items-center gap-2 rounded-lg border border-amber-700/60 bg-amber-500/10 px-4 py-2 text-sm transition hover:border-amber-500 disabled:opacity-50"
        >
          <ArrowRightLeft size={16} /> 从 Cursor Claw 迁移
        </button>
      </div>
      {installs.length > 1 && (
        <label className="flex flex-col gap-1 text-xs text-gray-500">
          Cursor Claw 安装
          <select
            value={pickPath}
            onChange={(e) => setPickPath(e.target.value)}
            className="rounded border border-gray-700 bg-gray-900 px-2 py-1.5 text-sm text-gray-200"
          >
            {installs.map((i) => (
              <option key={i.userDataPath} value={i.userDataPath}>{i.label}</option>
            ))}
          </select>
        </label>
      )}
      {!installs.length && (
        <p className="text-xs text-gray-600">未检测到本机 Cursor Claw 数据目录；一键迁移不可用。</p>
      )}
    </div>
  )
}
