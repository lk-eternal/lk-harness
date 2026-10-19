import { useState, useEffect } from "react"
import Dashboard from "./pages/Dashboard"
import Settings from "./pages/Settings"
import ChatPage from "./pages/ChatPage"
import CloseWindowModal from "./components/CloseWindowModal"
import AppModalHost from "./components/AppModalHost"
import UpdateDownloadBanner from "./components/UpdateDownloadBanner"
import SetupWizard from "./components/SetupWizard"

type Page = "dashboard" | "settings" | "chat"

export default function App() {
  const [page, setPage] = useState<Page>("dashboard")
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState("")
  const [closeConfirmOpen, setCloseConfirmOpen] = useState(false)
  const [settingsInitTab, setSettingsInitTab] = useState<string | undefined>()
  const [showWizard, setShowWizard] = useState(false)

  useEffect(() => {
    if (!window.electronAPI) {
      setError("electronAPI 未加载（preload 脚本可能未正确注入）")
      setLoading(false)
      return
    }
    window.electronAPI
      .getConfig()
      .then((cfg) => { setLoading(false); if (!cfg.setupComplete) setShowWizard(true) })
      .catch((e: unknown) => {
        setError(String(e))
        setLoading(false)
      })
  }, [])

  useEffect(() => {
    if (loading || error || !window.electronAPI) {
      return
    }
    return window.electronAPI.onWindowCloseConfirm(() => {
      setCloseConfirmOpen(true)
    })
  }, [loading, error])

  if (loading) {
    return (
      <div className="flex h-screen items-center justify-center">
        <div className="h-8 w-8 animate-spin rounded-full border-2 border-blue-500 border-t-transparent" />
      </div>
    )
  }

  if (error) {
    return (
      <div className="flex h-screen items-center justify-center p-8">
        <div className="max-w-md rounded-lg border border-red-800 bg-red-950/50 p-6 text-center">
          <h2 className="mb-2 text-lg font-semibold text-red-400">启动错误</h2>
          <p className="text-sm text-red-300">{error}</p>
        </div>
      </div>
    )
  }

  return (
    <>
      <div className={page === "dashboard" ? undefined : "hidden"}>
        <Dashboard
          active={page === "dashboard"}
          onSettings={(tab) => { setSettingsInitTab(tab); setPage("settings") }}
          onChat={() => setPage("chat")}
        />
      </div>
      <div className={page === "chat" ? undefined : "hidden"}>
        <ChatPage
          active={page === "chat"}
          onBack={() => setPage("dashboard")}
          onOpenChannelSettings={() => { setSettingsInitTab("channel"); setPage("settings") }}
        />
      </div>
      <div className={page === "settings" ? undefined : "hidden"}>
        <Settings
          onBack={() => setPage("dashboard")}
          initialTab={settingsInitTab}
          onTabConsumed={() => setSettingsInitTab(undefined)}
          onReenterWizard={() => setShowWizard(true)}
        />
      </div>
      <SetupWizard open={showWizard} onClose={() => setShowWizard(false)} />
      <CloseWindowModal open={closeConfirmOpen} onClose={() => setCloseConfirmOpen(false)} />
      <AppModalHost />
      <UpdateDownloadBanner />
    </>
  )
}
