import { useCallback, useEffect, useState } from "react"
import { Check, Copy, Eye, EyeOff, RefreshCw, Smartphone } from "lucide-react"

export default function MobilePairPanel() {
  const [status, setStatus] = useState<MobileServerStatus | null>(null)
  const [portInput, setPortInput] = useState("19529")
  const [publicUrlInput, setPublicUrlInput] = useState("")
  const [busy, setBusy] = useState(false)
  const [showToken, setShowToken] = useState(false)
  const [copiedKey, setCopiedKey] = useState("")
  const [showFrpGuide, setShowFrpGuide] = useState(false)

  const load = useCallback(async () => {
    const s = await window.electronAPI.mobileStatus()
    setStatus(s)
    setPortInput(String(s.port))
    setPublicUrlInput(s.publicUrl)
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const copyText = async (key: string, text: string) => {
    await navigator.clipboard.writeText(text)
    setCopiedKey(key)
    window.setTimeout(() => setCopiedKey((cur) => (cur === key ? "" : cur)), 1500)
  }

  const toggleEnabled = async () => {
    if (!status || busy) return
    setBusy(true)
    try {
      const next = await window.electronAPI.mobileUpdate({
        enabled: !status.enabled,
        port: Number(portInput) || 19529,
        publicUrl: publicUrlInput.trim(),
      })
      setStatus(next)
    } finally {
      setBusy(false)
    }
  }

  const saveEndpoints = async () => {
    if (busy) return
    setBusy(true)
    try {
      const next = await window.electronAPI.mobileUpdate({
        port: Number(portInput) || 19529,
        publicUrl: publicUrlInput.trim(),
      })
      setStatus(next)
      setPortInput(String(next.port))
      setPublicUrlInput(next.publicUrl)
    } finally {
      setBusy(false)
    }
  }

  const resetToken = async () => {
    if (busy) return
    setBusy(true)
    try {
      const next = await window.electronAPI.mobileResetToken()
      setStatus(next)
    } finally {
      setBusy(false)
    }
  }

  if (!status) {
    return <p className="text-xs text-fg-muted">正在读取手机网关状态…</p>
  }

  const inputCls = "w-full rounded-lg border border-line bg-surface px-3 py-2 text-sm outline-none transition focus:border-blue-500"
  const frpcSample = [
    "# 本机 frpc.toml",
    'serverAddr = "你的公网服务器地址"',
    "serverPort = 7000",
    'auth.method = "token"',
    'auth.token = "填写你的frp连接密钥"',
    "",
    "[[proxies]]",
    'name = "lk-harness-mobile"',
    'type = "tcp"',
    'localIP = "127.0.0.1"',
    `localPort = ${status.port}`,
    `remotePort = ${status.port}`,
  ].join("\n")

  const frpsSample = [
    "# 公网服务器 frps.toml",
    "bindPort = 7000",
    'auth.method = "token"',
    'auth.token = "填写你的frp连接密钥"',
  ].join("\n")

  return (
    <div className="space-y-6">
      <section className="space-y-3">
        <div className="flex items-center justify-between rounded-lg border border-line px-4 py-3">
          <div className="min-w-0 pr-3">
            <div className="flex items-center gap-2">
              <Smartphone size={16} className="text-accent" />
              <p className="text-sm font-medium">启用手机端远程对话网关</p>
              {status.running ? (
                <span className="rounded-full bg-emerald-500/15 px-2 py-0.5 text-[11px] text-success">运行中 · :{status.port}</span>
              ) : (
                <span className="rounded-full bg-raised px-2 py-0.5 text-[11px] text-fg-muted">未启动</span>
              )}
            </div>
            <p className="mt-1 text-xs text-fg-muted">
              开启后，手机 APP 可通过局域网或公网穿透地址（如 frp）继续桌面端的「应用内对话」，实时同步流式输出与会话状态。
            </p>
          </div>
          <button
            type="button"
            role="switch"
            aria-checked={status.enabled}
            disabled={busy}
            onClick={() => void toggleEnabled()}
            className={`relative inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full transition-colors duration-200 ${status.enabled ? "bg-green-500" : "bg-stronger"}`}
          >
            <span className={`inline-block h-3.5 w-3.5 rounded-full bg-white shadow transition-transform duration-200 ${status.enabled ? "translate-x-[18px]" : "translate-x-[3px]"}`} />
          </button>
        </div>
        {status.error && <p className="text-xs text-danger">{status.error}</p>}
      </section>

      <section className="space-y-3">
        <h3 className="text-sm font-medium text-fg-2">网络与穿透地址</h3>
        <div className="grid grid-cols-3 gap-3">
          <div>
            <label className="mb-1 block text-xs text-fg-muted">本机监听端口</label>
            <input
              type="number"
              min={1024}
              max={65535}
              value={portInput}
              onChange={(e) => setPortInput(e.target.value)}
              onBlur={() => void saveEndpoints()}
              className={inputCls}
            />
          </div>
          <div className="col-span-2">
            <label className="mb-1 block text-xs text-fg-muted">公网穿透地址（frp / 反向代理等，选填）</label>
            <input
              type="text"
              value={publicUrlInput}
              onChange={(e) => setPublicUrlInput(e.target.value)}
              onBlur={() => void saveEndpoints()}
              placeholder={`例如 http://你的公网IP:${status.port} 或 https://lk.example.com`}
              className={inputCls}
            />
          </div>
        </div>

        <div className="rounded-lg border border-line-subtle bg-surface/50 p-3 text-xs space-y-1.5">
          <div className="flex items-center justify-between text-fg-3">
            <span>本机局域网地址（同 Wi-Fi 自动直连）：</span>
            <button type="button" onClick={() => void load()} className="inline-flex items-center gap-1 text-accent hover:text-accent-soft">
              <RefreshCw size={11} />刷新
            </button>
          </div>
          {status.lanUrls.length > 0 ? (
            <div className="flex flex-wrap gap-2">
              {status.lanUrls.map((u) => (
                <code key={u} className="rounded bg-raised px-2 py-0.5 font-mono text-[11px] text-fg-2">{u}</code>
              ))}
            </div>
          ) : (
            <p className="text-fg-faint">未检测到局域网 IPv4 地址</p>
          )}
        </div>
      </section>

      <section className="space-y-3">
        <h3 className="text-sm font-medium text-fg-2">扫码配对</h3>
        <div className="flex flex-col sm:flex-row items-center gap-5 rounded-lg border border-line bg-surface/40 p-4">
          {status.qrDataUrl && (
            <div className="shrink-0 rounded-xl bg-white p-2 shadow">
              <img src={status.qrDataUrl} alt="手机配对二维码" className="h-56 w-56" />
            </div>
          )}
          <div className="min-w-0 flex-1 space-y-2.5 text-xs">
            <p className="text-fg-2 leading-relaxed">
              用 <strong>LK Harness 手机端 APP</strong> 扫码即可保存连接（同时写入公网地址、局域网地址与鉴权密钥，在局域网内自动直连，离开后自动切换到公网地址）。
            </p>
            <div>
              <label className="mb-1 block text-fg-muted">配对链接（也可直接发到手机浏览器打开）</label>
              <div className="flex items-center gap-2">
                <input type="text" readOnly value={status.pairUrl} className="w-full rounded border border-line bg-page px-2.5 py-1.5 font-mono text-[11px] text-fg-3 outline-none" />
                <button
                  type="button"
                  onClick={() => void copyText("pairUrl", status.pairUrl)}
                  className="shrink-0 rounded border border-line px-2.5 py-1.5 text-fg-2 hover:bg-raised"
                >
                  {copiedKey === "pairUrl" ? <Check size={13} className="text-success" /> : <Copy size={13} />}
                </button>
              </div>
            </div>
            <div>
              <label className="mb-1 block text-fg-muted">Bearer Token（重置后旧手机连接立即失效）</label>
              <div className="flex items-center gap-2">
                <input
                  type={showToken ? "text" : "password"}
                  readOnly
                  value={status.token}
                  className="w-full rounded border border-line bg-page px-2.5 py-1.5 font-mono text-[11px] text-fg-3 outline-none"
                />
                <button type="button" onClick={() => setShowToken((v) => !v)} className="shrink-0 rounded border border-line p-1.5 text-fg-3 hover:bg-raised" title={showToken ? "隐藏" : "显示"}>
                  {showToken ? <EyeOff size={13} /> : <Eye size={13} />}
                </button>
                <button type="button" onClick={() => void copyText("token", status.token)} className="shrink-0 rounded border border-line p-1.5 text-fg-3 hover:bg-raised" title="复制 Token">
                  {copiedKey === "token" ? <Check size={13} className="text-success" /> : <Copy size={13} />}
                </button>
                <button type="button" onClick={() => void resetToken()} className="shrink-0 rounded border border-line px-2.5 py-1 text-danger hover:bg-raised">
                  重置
                </button>
              </div>
            </div>
          </div>
        </div>
      </section>

      <section className="space-y-2">
        <button
          type="button"
          onClick={() => setShowFrpGuide((v) => !v)}
          className="text-xs text-accent hover:text-accent-soft"
        >
          {showFrpGuide ? "▾ 收起 frp 穿透配置模板" : "▸ 查看 frp 穿透配置模板（frps.toml / frpc.toml）"}
        </button>
        {showFrpGuide && (
          <div className="grid grid-cols-1 gap-3 rounded-lg border border-line-subtle bg-surface/40 p-3 text-xs">
            <div>
              <div className="mb-1 flex items-center justify-between text-fg-3">
                <span>1. 公网服务器配置（<code>frps.toml</code>）</span>
                <button type="button" onClick={() => void copyText("frps", frpsSample)} className="text-accent hover:text-accent-soft">
                  {copiedKey === "frps" ? "已复制" : "复制"}
                </button>
              </div>
              <pre className="overflow-x-auto rounded bg-code p-2.5 font-mono text-[11px] text-fg-2">{frpsSample}</pre>
            </div>
            <div>
              <div className="mb-1 flex items-center justify-between text-fg-3">
                <span>2. 本机配置（<code>frpc.toml</code>）</span>
                <button type="button" onClick={() => void copyText("frpc", frpcSample)} className="text-accent hover:text-accent-soft">
                  {copiedKey === "frpc" ? "已复制" : "复制"}
                </button>
              </div>
              <pre className="overflow-x-auto rounded bg-code p-2.5 font-mono text-[11px] text-fg-2">{frpcSample}</pre>
            </div>
          </div>
        )}
      </section>
    </div>
  )
}
