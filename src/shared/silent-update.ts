/**
 * 静默更新（仅 Windows）的纯决策逻辑：什么时候该在后台下载新版本，以及界面上的提示文案。
 * 副作用（查版本、下载、安装）在 electron/updater.ts，这里不碰 electron，方便单测。
 *
 * 静默更新开着时：不弹「发现新版本 / 更新已就绪」的窗口，后台自动下载；下载好之后在应用退出时
 * 由 electron-updater 以 /S 静默安装（不出现安装向导，也不自动重启）。想马上更新就点设置页的「立即安装」，
 * 静默安装并自动重启。常驻托盘不退出的用户，还可以开「空闲时自动重启安装」：电脑没人用、AI 没在干活时自己重启装上
 * （文件后半部分：decideIdleRestart）。
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

/** 静默模式下下载好之后，设置页里给用户看的那句话；开着「空闲时自动重启安装」时多交代一句 */
export function silentReadyMessage(version: string, idleRestart = false): string {
  const base = `新版本 v${version} 已在后台下载好：退出应用时会自动安装，不会出现安装向导；想现在更新可以点「立即安装」，会自动重启。`
  return idleRestart ? `${base}电脑空闲时也会自动重启并安装。` : base
}

// ── 空闲时自动重启安装 ─────────────────────────────────────────────
// 应用常驻托盘、从不退出的用户，「退出时安装」永远等不到。新版本下好之后，趁人不在、AI 没在干活的时候自己重启装上。
// 这里只做决策：各项条件的取值（电脑空闲多久、Agent 在不在忙…）由 electron/idle-probes.ts 提供，重启动作在 electron/updater.ts。

/** 多久检查一次「现在能不能重启」。只在已经下好新版本、且开关开着时才真正去查 */
export const IDLE_RESTART_CHECK_INTERVAL_MS = 60 * 1000
/** 用户多久没碰过电脑（键盘、鼠标，含睡眠唤醒、解锁）才算人不在 */
export const IDLE_RESTART_USER_IDLE_SEC = 15 * 60
/** Agent 多久没有开始或结束过一个回合才算安静。手机或飞书上的对话回合之间也会有空档，不能只看「此刻有没有在跑」 */
export const IDLE_RESTART_AGENT_QUIET_MS = 10 * 60 * 1000
/** 同一个版本最多自动重启几次：装不上（安装器没接手、被安全软件拦下）时，别每隔几分钟把应用关一次 */
export const IDLE_RESTART_MAX_ATTEMPTS = 2
/** 发起重启后应用还活着（安装器没接手）：隔多久才允许再试一次 */
export const IDLE_RESTART_RETRY_AFTER_MS = 10 * 60 * 1000

export interface IdleRestartInput {
  /** 静默更新开着，且「空闲时自动重启安装」没被关 */
  enabled: boolean
  /** 本进程已经下好、等着安装的版本 */
  readyVersion: string | null
  /** 当前运行的版本 */
  current: string
  /** 又有一路下载在进行：别急着装旧的那一版 */
  downloading: boolean
  /** 这个版本已经自动重启过几次 */
  attempts: number
  /** 确认是「仅当前用户」安装：这种安装静默更新不需要管理员权限。装在所有用户下会弹 UAC，没人在场时应用关了就起不来 */
  perUserInstall: boolean
  /** 距离用户最后一次操作电脑过了多少秒；取不到为 null */
  userIdleSec: number | null
  /** 此刻有 Agent 在跑回合或正在拉起 */
  agentBusy: boolean
  /** 距离 Agent 最后一次开始或结束回合过了多少毫秒 */
  agentQuietMs: number
  /** daemon 队列里排队和处理中的消息数；取不到为 null */
  queued: number | null
}

export type IdleRestartWaitReason =
  | "disabled"
  | "nothing-ready"
  | "downloading"
  | "gave-up"
  | "unsupported-install"
  | "agent-busy"
  | "recent-agent-activity"
  | "queue-busy"
  | "user-active"
  | "unknown-state"

export type IdleRestartDecision =
  | { action: "install"; version: string }
  | { action: "wait"; reason: IdleRestartWaitReason }

/** 这个版本不会因为再等一会儿就变成可以重启：不用再每分钟评估，写一次日志就够了 */
export function isPermanentIdleWait(reason: IdleRestartWaitReason): boolean {
  return reason === "gave-up" || reason === "unsupported-install"
}

/**
 * 现在能不能自动重启安装。顺序有意义：先排除开关和没有可装的版本，再排除装不了的安装方式，
 * 最后才是「人和 AI 是否真的闲着」。任何一项取不到都当作还不能装：宁可晚装，也不在不确定时把应用关掉。
 */
export function decideIdleRestart(input: IdleRestartInput): IdleRestartDecision {
  if (!input.enabled) return { action: "wait", reason: "disabled" }
  if (!input.readyVersion || !isNewerVersion(input.readyVersion, input.current)) return { action: "wait", reason: "nothing-ready" }
  if (input.downloading) return { action: "wait", reason: "downloading" }
  if (input.attempts >= IDLE_RESTART_MAX_ATTEMPTS) return { action: "wait", reason: "gave-up" }
  if (!input.perUserInstall) return { action: "wait", reason: "unsupported-install" }
  if (input.agentBusy) return { action: "wait", reason: "agent-busy" }
  if (input.agentQuietMs < IDLE_RESTART_AGENT_QUIET_MS) return { action: "wait", reason: "recent-agent-activity" }
  if (input.queued === null) return { action: "wait", reason: "unknown-state" }
  if (input.queued > 0) return { action: "wait", reason: "queue-busy" }
  if (input.userIdleSec === null) return { action: "wait", reason: "unknown-state" }
  if (input.userIdleSec < IDLE_RESTART_USER_IDLE_SEC) return { action: "wait", reason: "user-active" }
  return { action: "install", version: input.readyVersion }
}

/** 设置页里对各种等待原因的说明（日志也用） */
export function idleRestartWaitText(reason: IdleRestartWaitReason): string {
  switch (reason) {
    case "disabled": return "没有开启「空闲时自动重启安装」"
    case "nothing-ready": return "还没有下载好的新版本"
    case "downloading": return "还有一路下载在进行"
    case "gave-up": return "这个版本已经自动重启过几次都没装上，不再自动重启，退出应用时仍会安装"
    case "unsupported-install": return "这份安装不是「仅当前用户」方式（或没能确认），安装时可能需要管理员确认，不自动重启，退出应用时仍会安装"
    case "agent-busy": return "有 Agent 正在工作"
    case "recent-agent-activity": return "Agent 刚刚还在工作"
    case "queue-busy": return "还有排队中的消息"
    case "user-active": return "电脑最近有人在操作"
    case "unknown-state": return "没能确认当前是否空闲"
  }
}

// ── 重启后窗口要不要弹出来 ───────────────────────────────────────────

/** 自动重启前写的记号：过了这么久还没被读走就作废，免得一次失败的重启影响后面手动打开 */
export const RESTART_MARKER_TTL_MS = 3 * 60 * 1000

export interface RestartMarker {
  /** 写记号的时间（毫秒时间戳） */
  at: number
  /** 重启前窗口就收在托盘里（隐藏或最小化） */
  keepHidden: boolean
}

/** 安装完重新启动时，主窗口该不该继续留在托盘：记号有效且重启前窗口就是收着的才留 */
export function shouldStartHiddenAfterRestart(marker: RestartMarker | null, now: number): boolean {
  if (!marker || marker.keepHidden !== true) return false
  if (typeof marker.at !== "number" || !Number.isFinite(marker.at)) return false
  const age = now - marker.at
  return age >= 0 && age <= RESTART_MARKER_TTL_MS
}
