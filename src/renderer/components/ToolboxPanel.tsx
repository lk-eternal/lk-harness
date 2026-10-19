import { useState, useEffect, useCallback } from "react"
import { Loader2, Download, CheckCircle2, LogIn, RefreshCw } from "lucide-react"

interface ToolStatus { installed: boolean; version?: string; loggedIn?: boolean; userName?: string }

export default function ToolboxPanel() {
  const [status, setStatus] = useState<{ larkCli: ToolStatus; meegle: ToolStatus; nodeOk?: boolean; nodeVersion?: string } | null>(null)
  const [busy, setBusy] = useState("")
  const [error, setError] = useState("")

  const refresh = useCallback(async () => {
    try { setStatus(await window.electronAPI.getToolboxStatus()) } catch { /* ignore */ }
  }, [])

  useEffect(() => { void refresh() }, [refresh])

  const run = async (key: string, fn: () => Promise<{ ok: boolean; error?: string }>) => {
    setBusy(key)
    setError("")
    try {
      const r = await fn()
      if (!r.ok) setError(r.error ?? "操作失败")
      await refresh()
    } finally {
      setBusy("")
    }
  }

  const install = (key: "larkCli" | "meegle") => run(key, () => window.electronAPI.installToolboxTool(key))
  const login = () => run("login", () => window.electronAPI.loginLarkCli())
  const updateAll = () => run("update", async () => {
    const r1 = status?.larkCli.installed ? await window.electronAPI.installToolboxTool("larkCli") : { ok: true }
    const r2 = status?.meegle.installed ? await window.electronAPI.installToolboxTool("meegle") : { ok: true }
    return r1.ok ? r2 : r1
  })

  const anyInstalled = status?.larkCli.installed || status?.meegle.installed

  const toolRow = (label: string, st: ToolStatus | undefined, key: "larkCli" | "meegle") => (
    <div className="flex items-center gap-3">
      <span className="w-40 shrink-0 text-sm text-fg-soft">{label}</span>
      {!status ? (
        <Loader2 size={13} className="animate-spin text-fg-muted" />
      ) : st?.installed ? (
        <>
          <span className="rounded-full border border-line px-2 py-0.5 text-xs text-fg-2">v{st.version ?? "?"}</span>
          {key === "larkCli" && (st.loggedIn
            ? <span className="flex items-center gap-1 text-xs text-success"><CheckCircle2 size={13} />已登录{st.userName ? `：${st.userName}` : ""}</span>
            : <button onClick={() => void login()} disabled={!!busy}
                className="flex items-center gap-1 rounded-md border border-blue-600/50 bg-blue-600/10 px-2 py-0.5 text-xs text-accent-soft hover:bg-blue-600/20 disabled:opacity-50">
                {busy === "login" ? <Loader2 size={11} className="animate-spin" /> : <LogIn size={11} />}
                {busy === "login" ? "请在浏览器完成授权..." : "登录"}
              </button>)}
        </>
      ) : (
        <>
          <span className="rounded-full border border-line px-2 py-0.5 text-xs text-fg-muted">未安装</span>
          <button onClick={() => void install(key)} disabled={!!busy}
            className="flex items-center gap-1 rounded-md border border-blue-600/50 bg-blue-600/10 px-2 py-0.5 text-xs text-accent-soft hover:bg-blue-600/20 disabled:opacity-50">
            {busy === key ? <Loader2 size={11} className="animate-spin" /> : <Download size={11} />}
            {busy === key ? "安装中..." : "一键安装"}
          </button>
        </>
      )}
    </div>
  )

  return (
    <section className="space-y-4">
      <div className="rounded-xl border border-line-subtle bg-surface/60 p-5">
        <h3 className="text-sm font-semibold text-fg">飞书集成</h3>
        <p className="mt-1 text-xs text-fg-muted">内置官方 CLI、装完登录即可——AI 自动获得飞书 / 飞书项目全部能力</p>
        <p className="mt-2 text-xs text-fg-muted">
          依赖 Node.js
          {status?.nodeOk
            ? <span className="text-success">（已检测到{status.nodeVersion ? ` v${status.nodeVersion}` : ""}）</span>
            : <span className="text-warning">（未检测到——请先装 <a href="https://nodejs.org" target="_blank" rel="noreferrer" className="text-accent hover:underline">nodejs.org</a> 并勾选 Add to PATH，然后重启本应用）</span>}
        </p>
        {anyInstalled && (
          <button onClick={() => void updateAll()} disabled={!!busy}
            className="mt-3 flex items-center gap-1 rounded-md border border-line px-2.5 py-1 text-xs text-fg-2 transition hover:border-blue-500 hover:text-accent-soft disabled:opacity-50">
            {busy === "update" ? <Loader2 size={11} className="animate-spin" /> : <RefreshCw size={11} />}
            {busy === "update" ? "更新中..." : "更新"}
          </button>
        )}
        <div className="mt-4 space-y-3">
          {toolRow("飞书（lark-cli）", status?.larkCli, "larkCli")}
          {toolRow("飞书项目（meegle）", status?.meegle, "meegle")}
        </div>
        {error && <p className="mt-3 text-xs leading-relaxed text-danger">{error}</p>}
      </div>
    </section>
  )
}
