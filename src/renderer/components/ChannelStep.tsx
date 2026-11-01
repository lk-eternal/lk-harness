import { useState, useEffect, useRef } from "react"
import {
  Bird, MessageSquare, MonitorSmartphone, CheckCircle2, Loader2, LogIn,
  ShieldCheck, UserCheck, ArrowRight, type LucideIcon,
} from "lucide-react"
import { CHANNEL_TYPE_LABELS, type ChannelType } from "../../shared/channel-types"
import { holdBackModelEdits, type ChannelModelImpact } from "../../shared/channel-model-impact"
import { saveChannelWithImpact, type ImpactChoice } from "../../shared/channel-save-flow"
import { emptyChannel } from "../channel-defaults"
import ChannelModelImpactDialog from "./ChannelModelImpactDialog"

const inputCls = "w-full rounded-lg border border-line bg-surface px-3 py-2 text-sm outline-none transition focus:border-blue-500"

const CHANNEL_OPTIONS: { type: ChannelType; icon: LucideIcon; iconCls: string; desc: string }[] = [
  { type: "app", icon: MonitorSmartphone, iconCls: "text-purple", desc: "在本应用的对话页直接聊，无需配置" },
  { type: "feishu", icon: Bird, iconCls: "text-accent", desc: "在飞书里给机器人发消息" },
  { type: "wechat", icon: MessageSquare, iconCls: "text-success", desc: "扫码接入微信，在微信里聊" },
]

const EXTERNAL_TYPES = ["feishu", "wechat"] as const

type QrStatus = "idle" | "loading" | "wait" | "scaned" | "error"
interface QrState { status: QrStatus; url: string; msg: string }
const IDLE_QR: QrState = { status: "idle", url: "", msg: "" }

const isBound = (c: ChannelConfig) => c.mainUserEnabled && !!c.mainUserChatId
const isConnected = (c: ChannelConfig | undefined) =>
  !!c && (c.type === "feishu" ? !!(c.larkAppId?.trim() && c.larkAppSecret?.trim()) : !!c.wechatToken?.trim())

function pickAgentResourceId(resources: AgentResource[], preferredId: string): string {
  return resources.find((r) => r.id === preferredId)?.id
    ?? resources.find((r) => !!r.apiKey?.trim())?.id
    ?? preferredId
}

function BindBlock({ channel, platform, binding, error, onStart, onCancel }: {
  channel: ChannelConfig
  platform: string
  binding: boolean
  error?: string
  onStart: () => void
  onCancel: () => void
}) {
  return (
    <div className="space-y-2 rounded-lg border border-line-subtle p-3">
      <p className="text-xs font-medium text-fg-2">绑定你自己（推荐）</p>
      <p className="text-xs leading-relaxed text-fg-muted">
        点「开始绑定」，然后<span className="text-fg-soft">打开{platform}，私聊给机器人随便发一句话</span>（比如你好）。
        绑定后，你私聊它就是在指挥你电脑上的 AI，聊天记忆一直保留，工作文件夹可以之后在首页添加；
        不绑定，所有人的消息都只在临时文件夹里处理，碰不到你的项目。
      </p>
      <div className="flex items-center gap-3">
        {isBound(channel) && <span className="flex items-center gap-1 text-xs text-success"><CheckCircle2 size={13} />已绑定</span>}
        {!isBound(channel) && !binding && (
          <button type="button" onClick={onStart}
            className="flex items-center gap-1.5 rounded-lg border border-line-strong px-3 py-1.5 text-xs text-fg-2 transition hover:border-blue-500 hover:text-accent">
            <UserCheck size={12} />开始绑定
          </button>
        )}
        {binding && (
          <span className="flex items-center gap-2 text-xs text-accent-soft">
            <Loader2 size={13} className="animate-spin" />
            等待中——现在去{platform}私聊机器人发一句话...
            <button type="button" onClick={onCancel} className="text-fg-muted hover:text-danger">取消</button>
          </span>
        )}
      </div>
      {error && <p className="text-xs text-danger">{error}</p>}
    </div>
  )
}

interface Props {
  /** 第 1 步接入的 Agent 资源，新建/更新通道时绑定 */
  agentResourceId: string
  onNext: () => void
}

export default function ChannelStep({ agentResourceId, onNext }: Props) {
  const [saved, setSaved] = useState<ChannelConfig[]>([])
  const [selected, setSelected] = useState<Record<ChannelType, boolean>>({ app: true, feishu: false, wechat: false })
  const [appId, setAppId] = useState("")
  const [appSecret, setAppSecret] = useState("")
  const [feishuErr, setFeishuErr] = useState("")
  const [feishuChecking, setFeishuChecking] = useState(false)
  const [feishuQr, setFeishuQr] = useState<QrState>(IDLE_QR)
  const [wechatQr, setWechatQr] = useState<QrState>(IDLE_QR)
  const [bindingId, setBindingId] = useState<string | null>(null)
  const [bindErr, setBindErr] = useState<{ id: string; message: string } | null>(null)
  const [committing, setCommitting] = useState(false)
  /** 保存「其他人的默认模型要变了」的确认框；resolve 之前保存流程一直停在这里 */
  const [impactAsk, setImpactAsk] = useState<{ channelName: string; impact: ChannelModelImpact; resolve: (c: ImpactChoice | null) => void } | null>(null)
  /** 保存之后要告诉用户的话（取消了模型改动、或清除 / 停止的结果） */
  const [notice, setNotice] = useState("")
  const wechatBusy = useRef(false)

  const byType = (t: ChannelType) => saved.find((c) => c.type === t)
  const feishu = byType("feishu")
  const wechat = byType("wechat")

  useEffect(() => {
    void window.electronAPI.getConfig().then((cfg) => {
      const channels = cfg.channels ?? []
      setSaved(channels)
      if (channels.length > 0) {
        setSelected({
          app: channels.some((c) => c.type === "app"),
          feishu: channels.some((c) => c.type === "feishu"),
          wechat: channels.some((c) => c.type === "wechat"),
        })
      }
      const existingFeishu = channels.find((c) => c.type === "feishu")
      setAppId(existingFeishu?.larkAppId ?? "")
      setAppSecret(existingFeishu?.larkAppSecret ?? "")
    })
  }, [])

  useEffect(() => {
    const unsubFeishuQr = window.electronAPI.onFeishuSetupQrCode((url) => setFeishuQr({ status: "wait", url, msg: "" }))
    const unsubWechatQr = window.electronAPI.onWechatSetupQrCode((url) => setWechatQr((q) => ({ ...q, status: "wait", url })))
    const unsubWechatStatus = window.electronAPI.onWechatSetupStatus((status) => {
      if (status === "scaned") setWechatQr((q) => ({ ...q, status: "scaned" }))
    })
    return () => { unsubFeishuQr(); unsubWechatQr(); unsubWechatStatus() }
  }, [])

  const upsertChannel = async (type: ChannelType, patch: Partial<ChannelConfig>, newChannelName: string) => {
    const cfg = await window.electronAPI.getConfig()
    const channels = cfg.channels ?? []
    const existing = channels.find((c) => c.type === type)
    const channel: ChannelConfig = {
      ...(existing ?? emptyChannel(type, newChannelName)),
      ...patch,
      enabled: true,
      agentResourceId: pickAgentResourceId(cfg.agentResources ?? [], agentResourceId),
    }
    // 落库时重新读一遍：问用户期间配置可能被别处改过，不能拿开头那份旧快照覆盖回去
    const write = async (toSave: ChannelConfig) => {
      const latest = (await window.electronAPI.getConfig()).channels ?? []
      const next = latest.some((c) => c.id === toSave.id)
        ? latest.map((c) => (c.id === toSave.id ? toSave : c))
        : [...latest, toSave]
      await window.electronAPI.saveConfig({ channels: next })
      setSaved(next)
    }
    // 新通道还没有别人的会话，直接存
    if (!existing) {
      await write(channel)
      return
    }
    // 已有的通道：这一步会把它的供应商改成第 1 步选的。其他人留空跟随主用户时，他们的默认也跟着变，
    // 要和设置页一样先说清楚影响哪些会话。取消 = 保留原来的模型设置，其余（刚扫出来的凭据等）照存，不能丢
    const r = await saveChannelWithImpact(
      channel.id,
      channel,
      {
        preview: (id, draft) => window.electronAPI.previewChannelModelImpact(id, draft),
        ask: (impact) => new Promise<ImpactChoice | null>((resolve) => setImpactAsk({ channelName: channel.name, impact, resolve })),
        clear: (id) => window.electronAPI.clearOthersModelOverrides(id),
        stop: (id) => window.electronAPI.stopOthersFollowingDefault(id),
      },
      () => write(channel),
      () => write(holdBackModelEdits(channel, existing)),
    )
    if (r.cancelled) setNotice(`已保留「${channel.name}」原来的默认模型，这一步的其余设置照常保存了。`)
    else if (r.lines.length > 0) setNotice(r.lines.join("\n"))
  }

  const connectFeishu = async (id: string, secret: string, quickCreated: boolean) => {
    setFeishuChecking(true)
    setFeishuErr("")
    try {
      const info = await window.electronAPI.fetchFeishuAppInfo(id.trim(), secret.trim())
      if (!info.ok) { setFeishuErr(info.error ?? "凭据无效，请检查 App ID / Secret"); return }
      await upsertChannel(
        "feishu",
        { larkAppId: id.trim(), larkAppSecret: secret.trim(), larkBotName: info.name, larkAppQuickCreated: quickCreated },
        info.name || "飞书机器人",
      )
    } finally {
      setFeishuChecking(false)
    }
  }

  const quickCreateFeishu = async () => {
    setFeishuQr({ status: "loading", url: "", msg: "" })
    setFeishuErr("")
    const r = await window.electronAPI.feishuRegisterApp({ name: "LK Harness", desc: "IM Agent 协作助手" })
    setFeishuQr(IDLE_QR)
    if (r.ok && r.appId && r.appSecret) {
      setAppId(r.appId)
      setAppSecret(r.appSecret)
      await connectFeishu(r.appId, r.appSecret, true)
    } else if (r.error && r.error !== "cancelled") {
      setFeishuErr(r.error)
    }
  }

  const cancelFeishuQr = async () => {
    await window.electronAPI.feishuRegisterAppCancel()
    setFeishuQr(IDLE_QR)
  }

  const loginWechat = async () => {
    if (wechatBusy.current) return
    wechatBusy.current = true
    setWechatQr({ status: "loading", url: "", msg: "" })
    try {
      const r = await window.electronAPI.wechatQrLogin()
      if (r.ok && r.botToken) {
        await upsertChannel("wechat", { wechatToken: r.botToken, wechatAccountId: r.accountId ?? "" }, CHANNEL_TYPE_LABELS.wechat)
        setWechatQr(IDLE_QR)
      } else if (r.error === "cancelled") {
        setWechatQr(IDLE_QR)
      } else {
        setWechatQr({ status: "error", url: "", msg: r.error ?? "登录失败" })
      }
    } catch (e: unknown) {
      setWechatQr({ status: "error", url: "", msg: e instanceof Error ? e.message : String(e) })
    } finally {
      wechatBusy.current = false
    }
  }

  const cancelWechatQr = async () => {
    await window.electronAPI.wechatQrLoginCancel()
    wechatBusy.current = false
    setWechatQr(IDLE_QR)
  }

  const startBind = async (channel: ChannelConfig) => {
    setBindingId(channel.id)
    setBindErr(null)
    try {
      const r = await window.electronAPI.startChannelBind(channel.id)
      if (r.ok && r.chatId) {
        const cfg = await window.electronAPI.getConfig()
        setSaved(cfg.channels ?? [])
      } else if (r.error && r.error !== "cancelled") {
        setBindErr({ id: channel.id, message: r.error })
      }
    } finally {
      setBindingId(null)
    }
  }

  const cancelBind = async (channel: ChannelConfig) => {
    await window.electronAPI.cancelChannelBind(channel.id)
    setBindingId(null)
  }

  const toggle = (type: ChannelType) => setSelected((s) => ({ ...s, [type]: !s[type] }))

  const selectedExternal = EXTERNAL_TYPES.filter((t) => selected[t])
  const pendingTypes = selectedExternal.filter((t) => !isConnected(byType(t)))
  const unboundCount = selectedExternal.filter((t) => {
    const c = byType(t)
    return !!c && isConnected(c) && !isBound(c)
  }).length
  const noneSelected = !selected.app && selectedExternal.length === 0
  const canNext = pendingTypes.length === 0 && bindingId === null && !committing

  const next = async () => {
    setCommitting(true)
    try {
      if (selected.app && !byType("app")) await upsertChannel("app", {}, CHANNEL_TYPE_LABELS.app)
      onNext()
    } finally {
      setCommitting(false)
    }
  }

  return (
    <>
      <h2 className="text-lg font-semibold text-fg">第 2 步：消息通道</h2>
      <p className="mt-2 text-sm leading-relaxed text-fg-3">
        选你想用哪种方式指挥 AI，可以多选。之后随时能在 设置 → 消息通道 里增减。
      </p>

      <div className="mt-4 grid grid-cols-3 gap-2">
        {CHANNEL_OPTIONS.map((opt) => (
          <button key={opt.type} type="button" onClick={() => toggle(opt.type)}
            className={`relative rounded-lg border px-3 py-2.5 text-left transition ${selected[opt.type] ? "border-blue-500 bg-blue-600/10" : "border-line-subtle hover:border-line-strong"}`}>
            <div className="flex items-center gap-2 text-sm text-fg-soft"><opt.icon size={14} className={opt.iconCls} />{CHANNEL_TYPE_LABELS[opt.type]}</div>
            <p className="mt-0.5 text-[11px] text-fg-muted">{opt.desc}</p>
            {selected[opt.type] && <CheckCircle2 size={13} className="absolute right-2 top-2 text-accent" />}
          </button>
        ))}
      </div>

      {selected.app && (
        <p className="mt-4 text-xs leading-relaxed text-fg-muted">
          应用内对话无需配置：完成引导后，在「对话」页就能直接和 AI 聊。
        </p>
      )}

      {selected.feishu && (
        <div className="mt-4 space-y-3 rounded-xl border border-line-subtle p-4">
          <p className="flex items-center gap-1.5 text-sm font-medium text-fg-2"><Bird size={14} className="text-accent" />飞书</p>
          <p className="text-xs leading-relaxed text-fg-muted">
            创建一个飞书机器人并接进来。推荐用「一键创建」：扫个码，应用自动建好、凭据自动填回来。
          </p>
          {feishuQr.status === "idle" && (
            <button type="button" onClick={() => void quickCreateFeishu()} disabled={feishuChecking}
              className="flex items-center gap-2 rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white transition hover:bg-blue-500 disabled:opacity-50">
              <LogIn size={15} />一键创建飞书应用
            </button>
          )}
          {feishuQr.status !== "idle" && (
            <div className="flex flex-col items-center gap-2 py-2">
              {feishuQr.status === "loading" && !feishuQr.url
                ? <Loader2 size={22} className="animate-spin text-accent" />
                : <img src={feishuQr.url} alt="Feishu QR" className="h-40 w-40 rounded bg-white p-1" />}
              <p className="text-xs text-fg-3">用飞书 App 扫码创建，完成后凭据自动回填</p>
              <button type="button" onClick={() => void cancelFeishuQr()} className="text-xs text-fg-muted hover:text-danger">取消</button>
            </div>
          )}
          <div className="space-y-2 rounded-lg border border-line-subtle p-3">
            <p className="text-xs text-fg-muted">已有飞书应用？直接填凭据（<a href="https://open.feishu.cn/app" target="_blank" rel="noreferrer" className="text-accent hover:underline">开发者后台</a>可查）：</p>
            <div className="grid grid-cols-2 gap-2">
              <input type="text" value={appId} onChange={(e) => setAppId(e.target.value)} placeholder="App ID (cli_...)" className={inputCls} />
              <input type="password" value={appSecret} onChange={(e) => setAppSecret(e.target.value)} placeholder="App Secret" className={inputCls} />
            </div>
            <button type="button" onClick={() => void connectFeishu(appId, appSecret, false)} disabled={feishuChecking || !appId.trim() || !appSecret.trim()}
              className="flex items-center gap-1.5 rounded-lg border border-line-strong px-3 py-1.5 text-xs text-fg-2 transition hover:border-blue-500 hover:text-accent disabled:opacity-50">
              {feishuChecking ? <Loader2 size={12} className="animate-spin" /> : <ShieldCheck size={12} />}
              {feishuChecking ? "校验中..." : "校验并连接"}
            </button>
          </div>
          {feishu && isConnected(feishu) && (
            <p className="flex items-center gap-1 text-xs text-success"><CheckCircle2 size={13} />已连接机器人「{feishu.larkBotName || feishu.name}」</p>
          )}
          {feishuErr && <p className="text-xs text-danger">{feishuErr}</p>}
          {feishu && isConnected(feishu) && (
            <BindBlock channel={feishu} platform="飞书" binding={bindingId === feishu.id}
              error={bindErr?.id === feishu.id ? bindErr.message : undefined}
              onStart={() => void startBind(feishu)} onCancel={() => void cancelBind(feishu)} />
          )}
        </div>
      )}

      {selected.wechat && (
        <div className="mt-4 space-y-3 rounded-xl border border-line-subtle p-4">
          <p className="flex items-center gap-1.5 text-sm font-medium text-fg-2"><MessageSquare size={14} className="text-success" />微信</p>
          <p className="text-xs leading-relaxed text-fg-muted">
            用手机微信扫码接入 ClawBot，之后在微信里给它发消息，就是在指挥你电脑上的 AI。
          </p>
          {wechatQr.status === "loading" && (
            <div className="flex items-center gap-2 py-2 text-xs text-fg-3">
              <Loader2 size={13} className="animate-spin" />正在获取二维码...
              <button type="button" onClick={() => void cancelWechatQr()} className="text-fg-muted hover:text-danger">取消</button>
            </div>
          )}
          {(wechatQr.status === "wait" || wechatQr.status === "scaned") && wechatQr.url && (
            <div className="flex flex-col items-center gap-2 py-2">
              <div className="rounded-lg bg-white p-2"><img src={wechatQr.url} alt="WeChat QR" className="h-40 w-40" /></div>
              <p className="text-xs text-fg-3">{wechatQr.status === "scaned" ? "已扫描，请在手机上确认" : "请使用手机微信扫码"}</p>
              <button type="button" onClick={() => void cancelWechatQr()} className="text-xs text-fg-muted hover:text-danger">取消</button>
            </div>
          )}
          {wechatQr.status === "error" && (
            <p className="text-xs text-danger">{wechatQr.msg} <button type="button" onClick={() => void loginWechat()} className="text-accent hover:underline">重试</button></p>
          )}
          {wechatQr.status === "idle" && (isConnected(wechat)
            ? (
              <div className="flex items-center gap-3 rounded-lg border border-line px-3 py-2">
                <CheckCircle2 size={14} className="text-success" />
                <span className="flex-1 text-xs text-fg-2">已接入微信{wechat?.wechatAccountId && <span className="ml-1 font-mono text-fg-muted">{wechat.wechatAccountId}</span>}</span>
                <button type="button" onClick={() => void loginWechat()} className="text-xs text-fg-muted hover:text-accent">重新扫码</button>
              </div>
            )
            : (
              <button type="button" onClick={() => void loginWechat()}
                className="flex items-center gap-2 rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white transition hover:bg-blue-500">
                <LogIn size={15} />扫码接入微信
              </button>
            ))}
          {wechat && isConnected(wechat) && (
            <BindBlock channel={wechat} platform="微信" binding={bindingId === wechat.id}
              error={bindErr?.id === wechat.id ? bindErr.message : undefined}
              onStart={() => void startBind(wechat)} onCancel={() => void cancelBind(wechat)} />
          )}
        </div>
      )}

      <div className="mt-6">
        <button type="button" onClick={() => void next()} disabled={!canNext}
          className="flex items-center gap-1 text-sm text-accent transition hover:text-accent-soft disabled:cursor-not-allowed disabled:opacity-40">
          {unboundCount > 0 ? "暂不绑定，下一步" : "下一步"} <ArrowRight size={14} />
        </button>
        {pendingTypes.length > 0 && (
          <p className="mt-2 text-xs text-fg-muted">{pendingTypes.map((t) => CHANNEL_TYPE_LABELS[t]).join("、")}还没连上：完成连接，或取消勾选该通道。</p>
        )}
        {noneSelected && (
          <p className="mt-2 text-xs text-fg-muted">没有选择任何通道也可以继续，之后在 设置 → 消息通道 里添加。</p>
        )}
        {notice && <p className="mt-2 whitespace-pre-line text-xs leading-relaxed text-warning">{notice}</p>}
      </div>

      {impactAsk && (
        <ChannelModelImpactDialog
          channelName={impactAsk.channelName}
          impact={impactAsk.impact}
          cancelLabel="保留原来的模型"
          cancelHint="选「保留原来的模型」：这一步的其余设置照常保存，只是不改该通道的默认模型。"
          onDone={(choice) => {
            impactAsk.resolve(choice)
            setImpactAsk(null)
          }}
        />
      )}
    </>
  )
}
