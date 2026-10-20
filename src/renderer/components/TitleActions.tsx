import { useState } from "react"
import { Download, Loader2, Settings } from "lucide-react"
import useInlineModal from "./useInlineModal"

interface Props {
  /** 打开设置页，可指定初始 Tab */
  onSettings: (tab?: string) => void
}

/** 标题栏右侧：检查更新 + 设置（工作台和对话页共用） */
export default function TitleActions({ onSettings }: Props) {
  const [checkingUpdate, setCheckingUpdate] = useState(false)
  const { showAlert, showConfirm, ModalPortal } = useInlineModal()

  const handleCheckUpdate = async () => {
    if (checkingUpdate) return
    setCheckingUpdate(true)
    try {
      const r = await window.electronAPI.checkAppUpdate()
      if (r.status === "available" || r.status === "ready") {
        const go = await showConfirm("发现新版本", `新版本 v${r.latestVersion}，当前 v${r.currentVersion}。去设置页更新？`, "去设置", "稍后")
        if (go) onSettings("about")
      } else if (r.status === "latest") {
        await showAlert("已是最新", `当前已是最新版本（v${r.currentVersion}）。`)
      } else {
        await showAlert("检查更新", r.message || "检查失败，请稍后重试。")
      }
    } catch (e: unknown) {
      await showAlert("检查更新", e instanceof Error ? e.message : "检查失败，请稍后重试。")
    } finally {
      setCheckingUpdate(false)
    }
  }

  return (
    <>
      <button
        onClick={() => void handleCheckUpdate()}
        disabled={checkingUpdate}
        className="rounded-lg p-2 text-fg-3 transition hover:bg-raised hover:text-fg disabled:opacity-50"
        title="检查更新"
      >
        {checkingUpdate ? <Loader2 size={16} className="animate-spin" /> : <Download size={16} />}
      </button>
      <button
        onClick={() => onSettings()}
        className="rounded-lg p-2 text-fg-3 transition hover:bg-raised hover:text-fg"
        title="设置"
      >
        <Settings size={16} />
      </button>
      {ModalPortal}
    </>
  )
}
