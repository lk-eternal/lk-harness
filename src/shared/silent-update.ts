/**
 * 静默更新（仅 Windows）的纯决策逻辑：什么时候该在后台下载新版本，以及界面上的提示文案。
 * 副作用（查版本、下载、安装）在 electron/updater.ts，这里不碰 electron，方便单测。
 *
 * 静默更新开着时：不弹「发现新版本 / 更新已就绪」的窗口，后台自动下载；下载好之后在应用退出时
 * 由 electron-updater 以 /S 静默安装（不出现安装向导，也不自动重启）。想马上更新就点设置页的「立即安装」，
 * 静默安装并自动重启。
 */

import { isNewerVersion } from "./app-update.js"

/**
 * 静默模式下隔多久再查一次。应用常驻托盘、几天不重启很常见，只在启动时查一次的话会一直不更新。
 * 查询本身只是几次很小的 HTTP 请求，6 小时一次不构成负担。
 */
export const SILENT_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000

export interface SilentUpdateInput {
  /** 静默更新是否生效（Windows、已打包、设置里开着） */
  enabled: boolean
  /** 已经有一轮在查询或下载：不要再起一路，否则两路会写同一个安装包 */
  busy: boolean
  /** 当前运行的版本 */
  current: string
  /** 远端最新版本；查不到为 null */
  remote: string | null
  /** 本进程已经下载好、正等着安装的版本 */
  readyVersion: string | null
}

export type SilentUpdateSkipReason = "disabled" | "busy" | "no-remote" | "up-to-date" | "already-downloaded"

export type SilentUpdateDecision =
  | { action: "download"; version: string }
  | { action: "skip"; reason: SilentUpdateSkipReason }

/**
 * 要不要开始后台下载。顺序有意义：没开 → 忙着 → 查不到 → 没有更新 → 这一版已经下好了。
 * 已经下好了一个旧一点的版本、远端又出了更新的版本时，要重新下载，安装包以最新的为准。
 */
export function decideSilentUpdate(input: SilentUpdateInput): SilentUpdateDecision {
  if (!input.enabled) return { action: "skip", reason: "disabled" }
  if (input.busy) return { action: "skip", reason: "busy" }
  if (!input.remote) return { action: "skip", reason: "no-remote" }
  if (!isNewerVersion(input.remote, input.current)) return { action: "skip", reason: "up-to-date" }
  if (input.readyVersion && !isNewerVersion(input.remote, input.readyVersion)) return { action: "skip", reason: "already-downloaded" }
  return { action: "download", version: input.remote }
}

/** 静默模式下下载好之后，设置页里给用户看的那句话 */
export function silentReadyMessage(version: string): string {
  return `新版本 v${version} 已在后台下载好：退出应用时会自动安装，不会出现安装向导；想现在更新可以点「立即安装」，会自动重启。`
}
