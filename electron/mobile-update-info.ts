import { MOBILE_APK_URL, MOBILE_RELEASES_URL, type MobileUpdateInfo } from "../src/shared/app-update.js"

/**
 * 给手机端的「最新版本」查询。
 *
 * 版本信息由电脑端去查（updater 里已有 GitHub API / 镜像 / 探测等多条兜底，是为国内网络做的），
 * 手机自己不需要能访问 GitHub 才知道有没有新版；只有点「更新」下载 APK 时才会走 GitHub。
 *
 * 带缓存：多台手机、反复打开 App 不应该每次都去打外网，而外网查询可能要十几秒才超时。
 */

export interface LatestReleaseLike {
  version: string
}

export interface UpdateInfoProviderDeps {
  fetchLatest: () => Promise<LatestReleaseLike | null>
  now?: () => number
  /** 查到结果后多久内直接用缓存 */
  okTtlMs?: number
  /** 查询失败后多久内不再重试 */
  failTtlMs?: number
}

const DEFAULT_OK_TTL_MS = 30 * 60_000
const DEFAULT_FAIL_TTL_MS = 2 * 60_000

export function createMobileUpdateInfoProvider(deps: UpdateInfoProviderDeps): () => Promise<MobileUpdateInfo> {
  const now = deps.now ?? Date.now
  const okTtl = deps.okTtlMs ?? DEFAULT_OK_TTL_MS
  const failTtl = deps.failTtlMs ?? DEFAULT_FAIL_TTL_MS

  let lastGood: { info: MobileUpdateInfo; at: number } | null = null
  let lastFailAt = 0
  let inflight: Promise<MobileUpdateInfo> | null = null

  const unavailable = (): MobileUpdateInfo => ({ ok: false, error: "暂时无法获取最新版本" })

  /** 失败时宁可给出上次查到的结果，也不要让手机端以为「查不到」 */
  const fallback = (): MobileUpdateInfo => lastGood?.info ?? unavailable()

  async function refresh(): Promise<MobileUpdateInfo> {
    try {
      const latest = await deps.fetchLatest()
      const version = latest?.version?.trim()
      if (!version) {
        lastFailAt = now()
        return fallback()
      }
      const info: MobileUpdateInfo = {
        ok: true,
        latestVersion: version,
        apkUrl: MOBILE_APK_URL,
        releaseUrl: MOBILE_RELEASES_URL,
      }
      lastGood = { info, at: now() }
      lastFailAt = 0
      return info
    } catch {
      lastFailAt = now()
      return fallback()
    }
  }

  return async () => {
    const t = now()
    if (lastGood && t - lastGood.at < okTtl) return lastGood.info
    if (lastFailAt && t - lastFailAt < failTtl) return fallback()
    // 并发请求合并成一次外网查询
    inflight ??= refresh().finally(() => {
      inflight = null
    })
    return await inflight
  }
}
