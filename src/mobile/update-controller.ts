import type { MobileUpdateInfo } from "../shared/app-update"
import type { OpenResult } from "./native-browser"
import { pendingUpdate, type PendingUpdate } from "./update-check"

/**
 * App 的更新检查流程（不依赖 React，便于测试；界面见 useAppUpdate.ts）。
 *
 * 之前只在 App 冷启动后查一次、失败也不重试，而安卓 App 常驻后台，可能几天才冷启动一次，所以落后很多版本也看不到提示。
 * 现在：连上电脑端查一次；之后每次回到前台再查（有间隔限制，间隔内不重复问电脑）；
 * 失败后按退避自己重试几次；菜单里还能手动检查，手动检查不受「忽略」影响。
 */

/** 两次自动检查的最短间隔。电脑端内置 APK 时更新信息是本地读出来的，问一次几乎没成本；
 *  间隔不能太长：电脑刚升完级、用户马上切回手机，应该很快就看到提示 */
export const UPDATE_RECHECK_INTERVAL_MS = 10 * 60_000

/** 自动重试的次数上限；用完之后只在下次连上电脑端、回到前台时再试 */
export const MAX_AUTO_RETRIES = 3

/** 第 n 次连续失败后多久才允许再自动查：30 秒、2 分钟、8 分钟，最多半小时 */
export function failBackoffMs(failures: number): number {
  return Math.min(30_000 * 4 ** Math.max(0, failures - 1), 30 * 60_000)
}

export type UpdateStatus =
  | { phase: "idle" }
  | { phase: "checking" }
  | { phase: "latest" }
  | { phase: "update"; version: string }
  | { phase: "failed"; error: string }

export interface UpdateState {
  /** 要显示在顶部提示条里的新版本；没有、或用户忽略了就是 null */
  update: PendingUpdate | null
  /** 最近一次检查的结果（自动、手动都算），菜单里的「检查更新」据此显示 */
  status: UpdateStatus
}

export type CheckResult = "update" | "latest" | "failed"

export interface UpdateControllerDeps {
  /** 向电脑端问最新版本，要有超时 */
  fetchInfo: () => Promise<MobileUpdateInfo>
  /** 手机当前连着的电脑地址（拼内置 APK 的下载地址） */
  getBaseUrl: () => string
  currentVersion: string
  loadDismissed: () => string
  saveDismissed: (version: string) => void
  openUrl: (url: string) => Promise<OpenResult>
  onError: (message: string) => void
  now?: () => number
  setTimer?: (fn: () => void, ms: number) => unknown
  clearTimer?: (handle: unknown) => void
  recheckIntervalMs?: number
}

export interface UpdateController {
  getState: () => UpdateState
  subscribe: (listener: () => void) => () => void
  /** 自动检查：间隔内、或失败退避期内什么都不做 */
  autoCheck: () => void
  /** 手动检查：不受间隔和「忽略」影响 */
  checkNow: () => Promise<CheckResult>
  startUpdate: () => Promise<void>
  dismiss: () => void
  /** 取消还没触发的自动重试（界面卸载时调）；之后控制器仍可继续使用 */
  stop: () => void
}

/** 菜单里「检查更新」下面那行小字 */
export function describeUpdateStatus(status: UpdateStatus, currentVersion: string): string {
  const head = `当前 v${currentVersion}`
  switch (status.phase) {
    case "checking":
      return `${head} · 检查中…`
    case "latest":
      return `${head} · 已是最新`
    case "update":
      return `${head} · 有新版本 v${status.version}`
    case "failed":
      return `${head} · 检查失败：${status.error}`
    default:
      return head
  }
}

export function createUpdateController(deps: UpdateControllerDeps): UpdateController {
  const now = deps.now ?? Date.now
  const setTimer = deps.setTimer ?? ((fn: () => void, ms: number) => setTimeout(fn, ms))
  const clearTimer = deps.clearTimer ?? ((handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>))
  const interval = deps.recheckIntervalMs ?? UPDATE_RECHECK_INTERVAL_MS

  let state: UpdateState = { update: null, status: { phase: "idle" } }
  const listeners = new Set<() => void>()
  let lastOkAt: number | null = null
  let lastFailAt = 0
  let failures = 0
  let inflight: Promise<CheckResult> | null = null
  let retryTimer: unknown = null

  function set(patch: Partial<UpdateState>): void {
    state = { ...state, ...patch }
    for (const listener of [...listeners]) listener()
  }

  function cancelRetry(): void {
    if (retryTimer !== null) clearTimer(retryTimer)
    retryTimer = null
  }

  function scheduleRetry(): void {
    if (retryTimer !== null || failures > MAX_AUTO_RETRIES) return
    retryTimer = setTimer(() => {
      retryTimer = null
      // 不走 autoCheck 的间隔判断：定时器偶尔会早触发 1 毫秒，被它拦下来这次重试就丢了
      if (!inflight) void check(false)
    }, failBackoffMs(failures))
  }

  async function run(ignoreDismissed: boolean): Promise<CheckResult> {
    set({ status: { phase: "checking" } })
    let info: MobileUpdateInfo
    try {
      info = await deps.fetchInfo()
    } catch {
      info = { ok: false, error: "无法连接到电脑端，请检查网络" }
    }
    if (!info.ok) {
      failures += 1
      lastFailAt = now()
      set({ status: { phase: "failed", error: info.error || "电脑端没有返回版本信息" } })
      scheduleRetry()
      return "failed"
    }
    failures = 0
    lastOkAt = now()
    cancelRetry()

    const base = deps.getBaseUrl()
    const newer = pendingUpdate(info, deps.currentVersion, "", base)
    const visible = ignoreDismissed ? newer : pendingUpdate(info, deps.currentVersion, deps.loadDismissed(), base)
    // 用户手动查出来的、正显示着的提示条，不能被随后一次自动检查（会按「忽略」过滤）悄悄收掉
    const keepShowing = !!state.update && newer?.version === state.update.version
    set({
      update: keepShowing ? newer : visible,
      status: newer ? { phase: "update", version: newer.version } : { phase: "latest" },
    })
    return newer ? "update" : "latest"
  }

  function check(ignoreDismissed: boolean): Promise<CheckResult> {
    if (inflight) {
      // 手动检查要的是「不看忽略」的结果，不能直接拿在途自动检查的；等它完成后再查一次
      if (!ignoreDismissed) return inflight
      return inflight.then(() => track(run(true)))
    }
    return track(run(ignoreDismissed))
  }

  function track(p: Promise<CheckResult>): Promise<CheckResult> {
    const tracked = p.finally(() => {
      if (inflight === tracked) inflight = null
    })
    inflight = tracked
    return tracked
  }

  function autoCheck(): void {
    if (inflight) return
    const t = now()
    if (lastOkAt !== null && t - lastOkAt < interval) return
    if (failures > 0 && t - lastFailAt < failBackoffMs(failures)) return
    void check(false)
  }

  return {
    getState: () => state,
    subscribe(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    autoCheck,
    checkNow: () => check(true),
    async startUpdate() {
      const u = state.update
      if (!u) return
      // 交给系统浏览器下载 APK，下完点开即由系统安装器接手；签名一致才能覆盖安装
      const opened = await deps.openUrl(u.apkUrl)
      if (!opened.ok) deps.onError(`无法调起系统浏览器（${opened.reason}），请手动打开下载：${u.releaseUrl}`)
    },
    dismiss() {
      if (state.update) deps.saveDismissed(state.update.version)
      set({ update: null })
    },
    stop: cancelRetry,
  }
}
