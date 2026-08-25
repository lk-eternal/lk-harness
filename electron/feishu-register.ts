// ── 飞书一键创建应用（OAuth 设备授权流，RFC 8628）────────
// 不用 SDK 的 registerApp：其轮询实现遇到任意一次网络错误就终止整个流程，
// 造成"扫码侧应用已创建、本地却没拿到凭据回填"。这里自实现同一协议：
// 网络错误按间隔持续重试直到二维码过期，单次请求带超时防挂死。

const FEISHU_BASE = "https://accounts.feishu.cn"
const LARK_BASE = "https://accounts.larksuite.com"
const ENDPOINT = "/oauth/v1/app/registration"
const REQUEST_TIMEOUT_MS = 15_000

export interface FeishuRegisterResult { appId: string; appSecret: string }

interface RegistrationResponse {
  device_code?: string
  verification_uri_complete?: string
  expires_in?: number
  interval?: number
  client_id?: string
  client_secret?: string
  user_info?: { tenant_brand?: string }
  error?: string
  error_description?: string
}

async function postRegistration(baseUrl: string, params: Record<string, string>, signal: AbortSignal): Promise<RegistrationResponse> {
  const res = await fetch(`${baseUrl}${ENDPOINT}`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(params).toString(),
    signal: AbortSignal.any([signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]),
  })
  // RFC 8628：authorization_pending / slow_down 等以 HTTP 400 返回，body 仍是 JSON
  return (await res.json()) as RegistrationResponse
}

export async function registerFeishuApp(opts: {
  name: string
  desc: string
  signal: AbortSignal
  onQrCodeUrl: (url: string) => void
  onStatus?: (status: string) => void
}): Promise<FeishuRegisterResult> {
  const { signal } = opts
  const begin = await postRegistration(FEISHU_BASE, {
    action: "begin",
    archetype: "PersonalAgent",
    auth_method: "client_secret",
    request_user_info: "open_id",
  }, signal)
  if (!begin.device_code || !begin.verification_uri_complete) {
    throw new Error(begin.error_description ?? begin.error ?? "注册初始化失败")
  }

  const qrUrl = new URL(begin.verification_uri_complete)
  qrUrl.searchParams.set("from", "sdk")
  qrUrl.searchParams.set("source", "node-sdk/lk-harness")
  qrUrl.searchParams.set("tp", "sdk")
  qrUrl.searchParams.set("name", opts.name)
  qrUrl.searchParams.set("desc", opts.desc)
  opts.onQrCodeUrl(qrUrl.toString())

  const expireAt = Date.now() + (begin.expires_in ?? 600) * 1000
  let interval = (begin.interval ?? 5) * 1000
  let baseUrl = FEISHU_BASE
  let domainSwitched = false

  while (Date.now() < expireAt) {
    await sleep(interval, signal)

    let poll: RegistrationResponse
    try {
      poll = await postRegistration(baseUrl, { action: "poll", device_code: begin.device_code }, signal)
    } catch (e) {
      if (signal.aborted) throw e
      // 网络错误不终止：飞书侧可能已创建成功，继续轮询直到过期才能拿到凭据回填
      opts.onStatus?.("network_retry")
      continue
    }

    // 海外租户切换到 Lark 域名（仅一次）
    if (poll.user_info?.tenant_brand === "lark" && !domainSwitched) {
      baseUrl = LARK_BASE
      domainSwitched = true
      opts.onStatus?.("domain_switched")
      continue
    }

    if (poll.client_id && poll.client_secret) {
      return { appId: poll.client_id, appSecret: poll.client_secret }
    }

    switch (poll.error) {
      case undefined:
      case "authorization_pending":
        opts.onStatus?.("polling")
        break
      case "slow_down":
        interval += 5000
        opts.onStatus?.("slow_down")
        break
      default:
        throw new Error(poll.error_description ?? poll.error)
    }
  }
  throw new Error("二维码已过期，请重新发起创建")
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const onAbort = () => { clearTimeout(t); reject(new DOMException("Aborted", "AbortError")) }
    const t = setTimeout(() => { signal.removeEventListener("abort", onAbort); resolve() }, ms)
    if (signal.aborted) return onAbort()
    signal.addEventListener("abort", onAbort, { once: true })
  })
}
